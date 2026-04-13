'use strict';

const http = require('http');
const { execFile } = require('child_process');
const { ClawTransport } = require('./transport');
const proto = require('./protocol');

/**
 * ClawBridge — local HTTP bridge for serial / low-capability agents.
 *
 * Runs a background HTTP server + WebRTC transport.
 * Agents interact via simple HTTP calls (curl-compatible).
 * Messages are queued until polled. Hooks fire on events.
 *
 * Endpoints:
 *   POST /create                → create room, return roomId
 *   POST /join    {roomId}      → join existing room
 *   GET  /status                → connection state
 *   POST /send    {type, ...}   → send message to peer
 *   GET  /recv                  → pull queued messages
 *   GET  /recv?wait=N           → long-poll up to N seconds
 *   POST /close                 → disconnect
 */
class ClawBridge {
  constructor({
    port = 7654,
    signalingUrl = 'wss://ginfo.cc/signal/',
    name = 'Claw',
    permission = 'helper',
    onConnect,       // shell command to run when peer connects
    onMessage,       // shell command to run when message arrives
    onDisconnect,    // shell command to run when peer disconnects
  } = {}) {
    this.port = port;
    this.signalingUrl = signalingUrl;
    this.name = name;
    this.permission = permission;

    this.hooks = { connect: onConnect, message: onMessage, disconnect: onDisconnect };

    this.transport = null;
    this.server = null;
    this.roomId = null;
    this.peerName = null;
    this.negotiatedPerm = null;

    this._inbox = [];         // queued incoming messages
    this._waiters = [];       // pending long-poll resolvers
    this._errors = [];        // recent errors
  }

  // -- lifecycle -----------------------------------------------------------

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._handleHTTP(req, res));
      this.server.listen(this.port, '127.0.0.1', () => {
        this._log(`Bridge HTTP on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.transport) this.transport.close();
    if (this.server) this.server.close();
  }

  // -- transport management ------------------------------------------------

  _createTransport(room) {
    if (this.transport) {
      this.transport.close();
    }
    this._inbox = [];
    this.peerName = null;
    this.negotiatedPerm = null;
    this.roomId = null;

    this.transport = new ClawTransport({
      signalingUrl: this.signalingUrl,
      name: this.name,
      permission: this.permission,
      room,
    });

    this.transport.on('room', (id) => { this.roomId = id; });

    this.transport.on('connected', (peer, perm) => {
      this.peerName = peer;
      this.negotiatedPerm = perm;
      this._log(`Connected to ${peer} (${perm})`);
      this._runHook('connect', { peer, permission: perm });
    });

    this.transport.on('message', (msg) => {
      this._inbox.push(msg);
      this._flushWaiters();
      this._runHook('message', { from: msg.from, type: msg.type, id: msg.id });
    });

    this.transport.on('disconnected', (reason) => {
      this._log(`Disconnected: ${reason}`);
      this.peerName = null;
      this._runHook('disconnect', { reason });
    });

    this.transport.on('error', (err) => {
      this._errors.push({ ts: Date.now(), message: err.message });
      if (this._errors.length > 20) this._errors.shift();
    });

    this.transport.connect();
  }

  // -- HTTP handler --------------------------------------------------------

  async _handleHTTP(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;

    res.setHeader('Content-Type', 'application/json');

    try {
      // POST /create
      if (method === 'POST' && path === '/create') {
        this._createTransport(null);
        // Wait for room ID
        await this._waitFor(() => this.roomId, 10000);
        return this._json(res, 200, { roomId: this.roomId });
      }

      // POST /join
      if (method === 'POST' && path === '/join') {
        const body = await this._readBody(req);
        const roomId = body.roomId;
        if (!roomId) return this._json(res, 400, { error: 'roomId required' });
        this._createTransport(roomId);
        // Wait for connection
        await this._waitFor(() => this.peerName, 15000);
        return this._json(res, 200, { peer: this.peerName, permission: this.negotiatedPerm, roomId });
      }

      // GET /status
      if (method === 'GET' && path === '/status') {
        return this._json(res, 200, {
          connected: !!(this.transport && this.transport.connected),
          roomId: this.roomId,
          peer: this.peerName,
          permission: this.negotiatedPerm,
          inbox: this._inbox.length,
        });
      }

      // POST /send
      if (method === 'POST' && path === '/send') {
        if (!this.transport || !this.transport.connected) {
          return this._json(res, 409, { error: 'Not connected' });
        }
        const body = await this._readBody(req);
        const envelope = this._buildEnvelope(body);
        this.transport.send(envelope);
        return this._json(res, 200, { ok: true, id: envelope.id });
      }

      // GET /recv
      if (method === 'GET' && path === '/recv') {
        const waitSec = parseInt(url.searchParams.get('wait') || '0', 10);
        if (this._inbox.length > 0 || waitSec <= 0) {
          const msgs = this._inbox.splice(0);
          return this._json(res, 200, msgs);
        }
        // Long-poll
        const clampedWait = Math.min(Math.max(waitSec, 1), 30);
        const msgs = await this._longPoll(clampedWait);
        return this._json(res, 200, msgs);
      }

      // POST /close
      if (method === 'POST' && path === '/close') {
        if (this.transport) this.transport.close();
        this.transport = null;
        this.peerName = null;
        this.roomId = null;
        return this._json(res, 200, { ok: true });
      }

      // GET /health
      if (method === 'GET' && path === '/health') {
        return this._json(res, 200, { status: 'ok' });
      }

      return this._json(res, 404, { error: 'Not found' });
    } catch (err) {
      return this._json(res, 500, { error: err.message });
    }
  }

  // -- message building ----------------------------------------------------

  _buildEnvelope(body) {
    if (body.id) return body; // already a full envelope

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
        resolve(this._inbox.splice(0));
      }, seconds * 1000);

      const entry = { resolve, timer };
      this._waiters.push(entry);
    });
  }

  _flushWaiters() {
    if (this._waiters.length === 0) return;
    const msgs = this._inbox.splice(0);
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

    // Replace placeholders: {peer}, {type}, {reason}, etc.
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
      req.on('data', (chunk) => { body += chunk; if (body.length > 65536) reject(new Error('Body too large')); });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
  }

  _waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (predicate()) return resolve();
      const interval = setInterval(() => {
        if (predicate()) { clearInterval(interval); clearTimeout(timer); resolve(); }
      }, 100);
      const timer = setTimeout(() => {
        clearInterval(interval);
        reject(new Error('Timeout waiting for condition'));
      }, timeoutMs);
    });
  }

  _log(msg) {
    process.stderr.write(`[bridge] ${msg}\n`);
  }
}

module.exports = { ClawBridge };
