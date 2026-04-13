'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { ClawTransport } = require('./transport');
const proto = require('./protocol');
const { generateInvite, writeInvite } = require('./invite');

/**
 * ClawBridge — local HTTP bridge for serial / low-capability agents.
 *
 * Core guarantee: **messages are persisted to disk, never lost.**
 *
 * The bridge maintains two JSONL files:
 *   inbox.jsonl   — every incoming message, append-only
 *   events.jsonl  — connection events (connect/disconnect/room)
 *
 * A serial agent does NOT need to poll /recv or listen to hooks.
 * It can simply `cat inbox.jsonl` whenever it has time.
 * New messages since last check = new lines in the file.
 *
 * Hooks are an optional optimization — they notify faster, but
 * even without them, no message is ever lost.
 *
 * HTTP API:
 *   POST /create                → create room
 *   POST /join    {roomId}      → join room
 *   GET  /status                → connection state
 *   POST /send    {type, ...}   → send message
 *   GET  /recv                  → unread messages (marks as read)
 *   GET  /recv?wait=N           → long-poll
 *   GET  /recv?all=1            → all messages (re-read inbox file)
 *   POST /close                 → disconnect
 *   GET  /health                → liveness check
 */
class ClawBridge {
  constructor({
    port = 7654,
    signalingUrl = 'wss://ginfo.cc/signal/',
    name = 'Claw',
    permission = 'helper',
    dataDir,           // directory for inbox/events files (default: ~/.claw-link/)
    onConnect,
    onMessage,
    onDisconnect,
  } = {}) {
    this.port = port;
    this.signalingUrl = signalingUrl;
    this.name = name;
    this.permission = permission;

    this.hooks = { connect: onConnect, message: onMessage, disconnect: onDisconnect };

    // Persistence
    this._dataDir = dataDir || path.join(process.env.HOME || '/tmp', '.claw-link');
    this._inboxPath = path.join(this._dataDir, 'inbox.jsonl');
    this._eventsPath = path.join(this._dataDir, 'events.jsonl');

    this.transport = null;
    this.server = null;
    this.roomId = null;
    this.peerName = null;
    this.negotiatedPerm = null;

    this._unread = [];        // messages not yet polled via /recv
    this._waiters = [];       // pending long-poll resolvers
    this._msgCount = 0;       // total messages received (for read cursor)
    this._readCursor = 0;     // messages already returned via /recv
  }

  // -- lifecycle -----------------------------------------------------------

  start() {
    // Ensure data directory exists
    fs.mkdirSync(this._dataDir, { recursive: true });

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._handleHTTP(req, res));
      this.server.listen(this.port, '127.0.0.1', () => {
        this._log(`Bridge HTTP on http://127.0.0.1:${this.port}`);
        this._log(`Inbox: ${this._inboxPath}`);
        this._appendEvent({ event: 'bridge-start', port: this.port, name: this.name });
        resolve();
      });
    });
  }

  stop() {
    this._appendEvent({ event: 'bridge-stop' });
    if (this.transport) this.transport.close();
    if (this.server) this.server.close();
  }

  // -- persistence ---------------------------------------------------------

  _appendInbox(msg) {
    fs.appendFileSync(this._inboxPath, JSON.stringify(msg) + '\n');
  }

  _appendEvent(data) {
    const line = { ts: Date.now(), ...data };
    fs.appendFileSync(this._eventsPath, JSON.stringify(line) + '\n');
  }

  _readAllInbox() {
    try {
      const content = fs.readFileSync(this._inboxPath, 'utf8').trim();
      if (!content) return [];
      return content.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  // -- transport management ------------------------------------------------

  _createTransport(room) {
    if (this.transport) this.transport.close();

    this._unread = [];
    this.peerName = null;
    this.negotiatedPerm = null;
    this.roomId = null;

    // Clear inbox for new session
    fs.writeFileSync(this._inboxPath, '');
    this._msgCount = 0;
    this._readCursor = 0;

    this.transport = new ClawTransport({
      signalingUrl: this.signalingUrl,
      name: this.name,
      permission: this.permission,
      room,
    });

    this.transport.on('room', (id) => {
      this.roomId = id;
      this._appendEvent({ event: 'room', roomId: id });
    });

    this.transport.on('connected', (peer, perm) => {
      this.peerName = peer;
      this.negotiatedPerm = perm;
      this._log(`Connected to ${peer} (${perm})`);
      this._appendEvent({ event: 'connected', peer, permission: perm });
      this._runHook('connect', { peer, permission: perm });
    });

    this.transport.on('message', (msg) => {
      // Persist to disk FIRST — this is the guarantee
      this._appendInbox(msg);
      this._msgCount++;

      // Then queue in memory for /recv
      this._unread.push(msg);
      this._flushWaiters();
      this._runHook('message', { from: msg.from, type: msg.type, id: msg.id });
    });

    this.transport.on('disconnected', (reason) => {
      this._log(`Disconnected: ${reason}`);
      this.peerName = null;
      this._appendEvent({ event: 'disconnected', reason });
      this._runHook('disconnect', { reason });
    });

    this.transport.on('error', (err) => {
      this._appendEvent({ event: 'error', message: err.message });
    });

    this.transport.connect();
  }

  // -- HTTP handler --------------------------------------------------------

  async _handleHTTP(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    res.setHeader('Content-Type', 'application/json');

    try {
      if (method === 'POST' && pathname === '/create') {
        const body = await this._readBody(req);
        this._createTransport(body.roomId || null);
        await this._waitFor(() => this.roomId, 10000);
        const invite = generateInvite(this.roomId, {
          signal: this.signalingUrl,
          creator: this.name,
          perm: this.permission,
        });
        const invitePath = writeInvite(invite, this._dataDir);
        return this._json(res, 200, { roomId: this.roomId, inbox: this._inboxPath, invite: invitePath });
      }

      if (method === 'POST' && pathname === '/join') {
        const body = await this._readBody(req);
        if (!body.roomId) return this._json(res, 400, { error: 'roomId required' });
        this._createTransport(body.roomId);
        await this._waitFor(() => this.peerName, 15000);
        return this._json(res, 200, { peer: this.peerName, permission: this.negotiatedPerm, roomId: body.roomId, inbox: this._inboxPath });
      }

      if (method === 'GET' && pathname === '/status') {
        return this._json(res, 200, {
          connected: !!(this.transport && this.transport.connected),
          roomId: this.roomId,
          peer: this.peerName,
          permission: this.negotiatedPerm,
          unread: this._unread.length,
          total: this._msgCount,
          inbox: this._inboxPath,
        });
      }

      if (method === 'POST' && pathname === '/send') {
        if (!this.transport || !this.transport.connected) {
          return this._json(res, 409, { error: 'Not connected' });
        }
        const body = await this._readBody(req);
        const envelope = this._buildEnvelope(body);
        this.transport.send(envelope);
        return this._json(res, 200, { ok: true, id: envelope.id });
      }

      if (method === 'GET' && pathname === '/recv') {
        // ?all=1 → re-read entire inbox file (idempotent, safe)
        if (url.searchParams.get('all') === '1') {
          return this._json(res, 200, this._readAllInbox());
        }

        // Normal: return unread messages from memory queue
        const waitSec = parseInt(url.searchParams.get('wait') || '0', 10);
        if (this._unread.length > 0 || waitSec <= 0) {
          const msgs = this._unread.splice(0);
          this._readCursor = this._msgCount;
          return this._json(res, 200, msgs);
        }
        const clamped = Math.min(Math.max(waitSec, 1), 30);
        const msgs = await this._longPoll(clamped);
        this._readCursor = this._msgCount;
        return this._json(res, 200, msgs);
      }

      if (method === 'POST' && pathname === '/close') {
        if (this.transport) this.transport.close();
        this.transport = null;
        this.peerName = null;
        this.roomId = null;
        this._appendEvent({ event: 'closed' });
        return this._json(res, 200, { ok: true });
      }

      if (method === 'GET' && pathname === '/health') {
        return this._json(res, 200, { status: 'ok' });
      }

      return this._json(res, 404, { error: 'Not found' });
    } catch (err) {
      return this._json(res, 500, { error: err.message });
    }
  }

  // -- message building ----------------------------------------------------

  _buildEnvelope(body) {
    if (body.id) return body;
    switch (body.type) {
      case 'chat':   return proto.chat(body.content || '', this.name);
      case 'task':   return proto.task(body.description || '', body.data || null, this.name);
      case 'result': return proto.result(body.data || null, this.name, body.replyTo);
      case 'file':   return proto.file(body.name || '', body.content || '', this.name);
      case 'query':  return proto.query(body.question || '', this.name);
      case 'ack':    return proto.ack(body.replyTo || '', this.name);
      default:       return proto.createMessage(body.type || 'chat', body.payload || body, { from: this.name });
    }
  }

  // -- long-poll -----------------------------------------------------------

  _longPoll(seconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== entry);
        resolve(this._unread.splice(0));
      }, seconds * 1000);
      const entry = { resolve, timer };
      this._waiters.push(entry);
    });
  }

  _flushWaiters() {
    if (this._waiters.length === 0) return;
    const msgs = this._unread.splice(0);
    for (const w of this._waiters) {
      clearTimeout(w.timer);
      w.resolve(msgs);
    }
    this._waiters = [];
  }

  // -- hooks ---------------------------------------------------------------

  _runHook(event, data) {
    const cmd = this.hooks[event];
    if (!cmd) return;
    let expanded = cmd;
    for (const [k, v] of Object.entries(data)) {
      expanded = expanded.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    execFile('/bin/sh', ['-c', expanded], { timeout: 10000 }, (err) => {
      if (err) this._log(`Hook '${event}' failed: ${err.message}`);
    });
  }

  // -- helpers -------------------------------------------------------------

  _json(res, status, data) {
    res.writeHead(status);
    res.end(JSON.stringify(data));
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 65536) reject(new Error('Body too large')); });
      req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    });
  }

  _waitFor(fn, ms) {
    return new Promise((resolve, reject) => {
      if (fn()) return resolve();
      const iv = setInterval(() => { if (fn()) { clearInterval(iv); clearTimeout(t); resolve(); } }, 100);
      const t = setTimeout(() => { clearInterval(iv); reject(new Error('Timeout')); }, ms);
    });
  }

  _log(msg) { process.stderr.write(`[bridge] ${msg}\n`); }
}

module.exports = { ClawBridge };
