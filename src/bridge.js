'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { ClawTransport } = require('./transport');
const proto = require('./protocol');
const { generateInvite, writeInvite } = require('./invite');
const { TelegramNotifier } = require('./tg');
const { Notifier } = require('./notify');

/**
 * Per-room state. Each room has its own transport, inbox, message queue.
 */
class RoomState {
  constructor(roomId, dataDir) {
    this.roomId = roomId;
    this.transport = null;
    this.peerName = null;
    this.negotiatedPerm = null;
    this.stopped = false;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;

    // Per-room persistence
    this.dataDir = path.join(dataDir, roomId);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.inboxPath = path.join(this.dataDir, 'inbox.jsonl');
    this.eventsPath = path.join(this.dataDir, 'events.jsonl');
    this.pendingPath = path.join(this.dataDir, 'pending.jsonl');

    // Message queue
    this.unread = [];
    this.waiters = [];
    this.msgCount = 0;

    // ACK tracking: pending outbound messages awaiting ACK
    this.pending = this._loadPending();
    // Dedup: set of recently seen inbound message IDs
    this.seenIds = new Set();
  }

  appendInbox(msg) {
    fs.appendFileSync(this.inboxPath, JSON.stringify(msg) + '\n');
  }

  appendEvent(data) {
    fs.appendFileSync(this.eventsPath, JSON.stringify({ ts: Date.now(), ...data }) + '\n');
  }

  readAllInbox() {
    try {
      const c = fs.readFileSync(this.inboxPath, 'utf8').trim();
      if (!c) return [];
      return c.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  // -- pending queue (ACK tracking) ------------------------------------

  addPending(msg) {
    this.pending.set(msg.id, msg);
    this._savePending();
  }

  ackReceived(msgId) {
    if (this.pending.delete(msgId)) {
      this._savePending();
      return true;
    }
    return false;
  }

  getPending() {
    return [...this.pending.values()];
  }

  _loadPending() {
    try {
      const c = fs.readFileSync(this.pendingPath, 'utf8').trim();
      if (!c) return new Map();
      const map = new Map();
      for (const line of c.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg && msg.id) map.set(msg.id, msg);
        } catch { /* skip corrupt lines */ }
      }
      return map;
    } catch { return new Map(); }
  }

  _savePending() {
    const lines = [...this.pending.values()].map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(this.pendingPath, lines ? lines + '\n' : '');
  }
}

/**
 * ClawBridge — multi-room HTTP bridge for serial agents.
 *
 * HTTP API (all endpoints accept roomId to target a specific room):
 *   POST /create  {roomId?}             → create room
 *   POST /join    {roomId}              → join room
 *   POST /send    {roomId, type, ...}   → send message
 *   GET  /recv?room=X&wait=N           → poll messages
 *   GET  /status?room=X                → room status (omit room for all)
 *   POST /close   {roomId}             → close room
 *   GET  /rooms                         → list all rooms
 *   GET  /health                        → liveness
 */
class ClawBridge {
  constructor({
    port = 7654,
    signalingUrl = 'wss://ginfo.cc/signal/',
    name = 'Claw',
    permission = 'helper',
    dataDir,
    onConnect,
    onMessage,
    onDisconnect,
    tgToken,
    tgChatId,
    aliases,
    notify,
    intro,
  } = {}) {
    this.port = port;
    this.signalingUrl = signalingUrl;
    this.name = name;
    this.permission = permission;
    this.intro = intro || '';
    this._aliases = aliases || {};

    this.hooks = { connect: onConnect, message: onMessage, disconnect: onDisconnect };
    this._baseDir = dataDir || path.join(process.env.HOME || '/tmp', '.claw-link');
    this._notifier = new Notifier(notify || null);

    // Multi-room state
    this.rooms = new Map();

    // Telegram
    const finalToken = tgToken || process.env.CLAWLINK_TG_TOKEN;
    const finalChat = tgChatId || process.env.CLAWLINK_TG_CHAT;
    this._tg = null;
    if (finalToken && finalChat) {
      this._tg = new TelegramNotifier({
        token: finalToken,
        chatId: finalChat,
        onKill: (roomId) => this._closeRoom(roomId),
        onSetPerm: (roomId, level) => this._setRoomPerm(roomId, level),
      });
    }

    this.server = null;
  }

  // -- lifecycle -----------------------------------------------------------

  start() {
    fs.mkdirSync(this._baseDir, { recursive: true });
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._handleHTTP(req, res));
      this.server.listen(this.port, '127.0.0.1', () => {
        this._log(`Bridge HTTP on http://127.0.0.1:${this.port}`);
        if (this._tg) this._tg.start();
        resolve();
      });
    });
  }

  stop() {
    if (this._tg) this._tg.stop();
    for (const [, room] of this.rooms) this._destroyRoom(room);
    this.rooms.clear();
    if (this.server) this.server.close();
  }

  // -- room lifecycle ------------------------------------------------------

  _initRoom(roomId) {
    if (this.rooms.has(roomId)) return this.rooms.get(roomId);
    const room = new RoomState(roomId, this._baseDir);
    this.rooms.set(roomId, room);
    return room;
  }

  _connectRoom(room, targetRoomId) {
    if (room.transport) {
      room.transport.removeAllListeners();
      room.transport.close();
    }
    room.peerName = null;
    room.negotiatedPerm = null;
    room.stopped = false;
    this._clearTimers(room);

    room.transport = new ClawTransport({
      signalingUrl: this.signalingUrl,
      name: this.name,
      permission: this.permission,
      room: targetRoomId,
    });

    // Connection timeout: if peer doesn't show up in 60s, force reconnect
    room._connectTimeout = setTimeout(() => {
      if (room.stopped || (room.transport && room.transport.connected)) return;
      this._log(`[${room.roomId}] Connection timeout (60s) — retrying`);
      room.appendEvent({ event: 'timeout' });
      if (room.transport) {
        room.transport.removeAllListeners();
        room.transport.close();
        room.transport = null;
      }
      this._autoReconnect(room);
    }, 60000);

    room.transport.on('room', (id) => {
      room.appendEvent({ event: 'room', roomId: id });
      this._tgNotify('room', { roomId: id });
    });

    room.transport.on('connected', (peer, perm) => {
      this._clearTimers(room);
      room.peerName = peer;
      room.negotiatedPerm = perm;
      room.reconnecting = false;
      const isFirstConnect = room.reconnectAttempt === 0;
      room.reconnectAttempt = 0;
      this._log(`[${room.roomId}] Connected to ${peer} (${perm})`);
      room.appendEvent({ event: 'connected', peer, permission: perm });
      this._runHook('connect', { peer, permission: perm, roomId: room.roomId });
      this._tgNotify('connected', { roomId: room.roomId, peer, permission: perm });
      // Auto-introduce on first connect only (not reconnect)
      if (this.intro && isFirstConnect) {
        try {
          room.transport.send({ type: 'intro', from: this.name, text: this.intro, id: crypto.randomBytes(4).toString('hex'), ts: Date.now() });
        } catch {}
      }
      // Replay pending (unACKed) messages after reconnect
      this._replayPending(room);
      // Start heartbeat
      this._startHeartbeat(room);
    });

    room.transport.on('message', (msg) => {
      // Internal: handle heartbeat pong silently
      if (msg.type === '_ping' || msg.type === '_pong') {
        if (msg.type === '_ping') {
          try { room.transport.send({ type: '_pong', ts: Date.now() }); } catch {}
        }
        room._lastPeerActivity = Date.now();
        return;
      }
      // Handle ACK: remove from pending, don't deliver to user
      if (msg.type === 'ack' && msg.replyTo) {
        room.ackReceived(msg.replyTo);
        room._lastPeerActivity = Date.now();
        return;
      }
      // Dedup: skip if we've already seen this message ID
      if (msg.id && room.seenIds.has(msg.id)) {
        this._sendAck(room, msg.id);
        return;
      }
      if (msg.id) {
        room.seenIds.add(msg.id);
        if (room.seenIds.size > 1000) {
          const first = room.seenIds.values().next().value;
          room.seenIds.delete(first);
        }
      }

      room._lastPeerActivity = Date.now();
      room.appendInbox(msg);
      room.msgCount++;
      room.unread.push(msg);
      this._flushWaiters(room);
      const hookData = { from: msg.from, type: msg.type, id: msg.id, roomId: room.roomId };
      if (msg.payload) {
        if (msg.payload.content) hookData.content = msg.payload.content;
        if (msg.payload.description) hookData.description = msg.payload.description;
        if (msg.payload.question) hookData.question = msg.payload.question;
      }
      this._runHook('message', hookData);
      const tgData = { roomId: room.roomId, from: msg.from, type: msg.type };
      if (msg.text) tgData.text = msg.text;
      if (msg.payload) {
        tgData.content = msg.payload.content;
        tgData.text = tgData.text || msg.payload.text;
        tgData.description = msg.payload.description;
        tgData.question = msg.payload.question;
        tgData.name = msg.payload.name;
        tgData.data = msg.payload.data;
      }
      this._tgNotify('message', tgData);
      this._sendAck(room, msg.id);
    });

    room.transport.on('disconnected', (reason) => {
      this._clearTimers(room);
      this._log(`[${room.roomId}] Disconnected: ${reason}`);
      if (room.peerName) {
        this._runHook('disconnect', { reason, roomId: room.roomId });
        this._tgNotify('disconnected', { roomId: room.roomId, reason });
      }
      room.peerName = null;
      room.appendEvent({ event: 'disconnected', reason });
      this._autoReconnect(room);
    });

    room.transport.on('error', (err) => {
      room.appendEvent({ event: 'error', message: err.message });
    });

    room.transport.connect();
  }

  _clearTimers(room) {
    if (room._connectTimeout) { clearTimeout(room._connectTimeout); room._connectTimeout = null; }
    if (room._heartbeatTimer) { clearInterval(room._heartbeatTimer); room._heartbeatTimer = null; }
  }

  _startHeartbeat(room) {
    room._lastPeerActivity = Date.now();
    room._heartbeatTimer = setInterval(() => {
      if (room.stopped || !room.transport) { this._clearTimers(room); return; }
      // Send ping
      try { room.transport.send({ type: '_ping', ts: Date.now() }); } catch {}
      // Check if peer has been silent too long (90s = 3 missed beats)
      const silence = Date.now() - (room._lastPeerActivity || 0);
      if (silence > 90000) {
        this._log(`[${room.roomId}] Peer silent for ${Math.round(silence / 1000)}s — forcing reconnect`);
        this._clearTimers(room);
        if (room.transport) {
          room.transport.removeAllListeners();
          room.transport.close();
          room.transport = null;
        }
        room.peerName = null;
        room.appendEvent({ event: 'disconnected', reason: 'heartbeat-timeout' });
        this._autoReconnect(room);
      }
    }, 30000);
  }

  _destroyRoom(room) {
    room.stopped = true;
    room.reconnecting = false;
    if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
    this._clearTimers(room);
    if (room.transport) {
      room.transport.removeAllListeners();
      room.transport.close();
      room.transport = null;
    }
    room.appendEvent({ event: 'closed' });
  }

  _closeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this._log(`Closing room '${roomId}'`);
    this._destroyRoom(room);
    this.rooms.delete(roomId);
    this._tgNotify('killed', { roomId });
  }

  _setRoomPerm(roomId, level) {
    const room = this.rooms.get(roomId);
    if (!room || !room.transport) return;
    this._log(`[${roomId}] Permission → ${level}`);
    room.transport.requestedPermission = level;
    if (room.transport.connected) {
      room.transport.send({ type: 'handshake', name: this.name, requestedPermission: level, version: '0.1.0' });
    }
    room.appendEvent({ event: 'perm-changed', roomId, level });
  }

  // -- auto-reconnect ------------------------------------------------------

  _autoReconnect(room) {
    if (room.reconnecting || room.stopped) return;
    room.reconnecting = true;
    room.reconnectAttempt++;
    const delay = Math.min(5000 * Math.pow(2, room.reconnectAttempt - 1), 30000);
    this._log(`[${room.roomId}] Reconnect in ${delay / 1000}s (attempt ${room.reconnectAttempt})`);
    room.appendEvent({ event: 'reconnecting', attempt: room.reconnectAttempt });

    room.reconnectTimer = setTimeout(() => {
      room.reconnecting = false;
      if (room.stopped) return;
      if (room.transport) {
        room.transport.removeAllListeners();
        room.transport.close();
        room.transport = null;
      }
      setTimeout(() => {
        if (room.stopped) return;
        this._connectRoom(room, room.roomId);
      }, 1000);
    }, delay);
  }

  // -- HTTP handler --------------------------------------------------------

  async _handleHTTP(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    res.setHeader('Content-Type', 'application/json');

    try {
      // POST /create {roomId?}
      if (method === 'POST' && pathname === '/create') {
        const body = await this._readBody(req);
        const resolvedRoom = this._resolveAlias(body.roomId);
        const pendingKey = resolvedRoom || '_pending_' + Date.now();
        const room = this._initRoom(pendingKey);
        this._connectRoom(room, resolvedRoom || null);
        // Wait for signaling to assign room ID
        try {
          await this._waitFor(() => room.transport && room.transport.roomId, 10000);
        } catch {
          // Timeout — clean up the dangling room
          this._destroyRoom(room);
          this.rooms.delete(pendingKey);
          return this._json(res, 504, { error: 'Signaling timeout' });
        }
        const actualId = room.transport.roomId;
        // Re-register under actual room ID if it was auto-generated
        if (!body.roomId && actualId) {
          this.rooms.delete(pendingKey);
          room.roomId = actualId;
          room.dataDir = path.join(this._baseDir, actualId);
          fs.mkdirSync(room.dataDir, { recursive: true });
          room.inboxPath = path.join(room.dataDir, 'inbox.jsonl');
          room.eventsPath = path.join(room.dataDir, 'events.jsonl');
          this.rooms.set(actualId, room);
        }
        const invite = generateInvite(actualId, { signal: this.signalingUrl, creator: this.name, perm: this.permission });
        const invitePath = writeInvite(invite, room.dataDir);
        return this._json(res, 200, { roomId: actualId, inbox: room.inboxPath, invite: invitePath });
      }

      // POST /join {roomId}
      if (method === 'POST' && pathname === '/join') {
        const body = await this._readBody(req);
        if (!body.roomId) return this._json(res, 400, { error: 'roomId required' });
        const rid = this._resolveAlias(body.roomId);
        const room = this._initRoom(rid);
        this._connectRoom(room, rid);
        await this._waitFor(() => room.transport && room.transport.roomId, 10000);
        return this._json(res, 200, { roomId: rid, inbox: room.inboxPath, status: 'waiting-for-peer' });
      }

      // GET /rooms
      if (method === 'GET' && pathname === '/rooms') {
        const list = [];
        for (const [id, room] of this.rooms) {
          list.push({
            roomId: id,
            connected: !!(room.transport && room.transport.connected),
            peer: room.peerName,
            permission: room.negotiatedPerm,
            unread: room.unread.length,
            total: room.msgCount,
          });
        }
        return this._json(res, 200, list);
      }

      // GET /status?room=X (specific room or first room, supports aliases)
      if (method === 'GET' && pathname === '/status') {
        const rid = this._resolveAlias(url.searchParams.get('room'));
        const room = rid ? this.rooms.get(rid) : this.rooms.values().next().value;
        if (!room) return this._json(res, 200, { connected: false, rooms: this.rooms.size });
        return this._json(res, 200, {
          connected: !!(room.transport && room.transport.connected),
          reconnecting: room.reconnecting,
          roomId: room.roomId,
          peer: room.peerName,
          permission: room.negotiatedPerm,
          unread: room.unread.length,
          total: room.msgCount,
          pending: room.pending.size,
          lastActivity: room._lastPeerActivity || null,
          silenceSec: room._lastPeerActivity ? Math.round((Date.now() - room._lastPeerActivity) / 1000) : null,
          reconnectAttempt: room.reconnectAttempt,
          inbox: room.inboxPath,
        });
      }

      // POST /send {roomId, type, ...}
      if (method === 'POST' && pathname === '/send') {
        const body = await this._readBody(req);
        const rid = this._resolveAlias(body.roomId);
        const room = rid ? this.rooms.get(rid) : this.rooms.values().next().value;
        if (!room) return this._json(res, 404, { error: 'No room' });
        if (!room.transport || !room.transport.connected) {
          return this._json(res, 409, { error: `Room '${room.roomId}' not connected` });
        }
        const envelope = this._buildEnvelope(body);
        room.transport.send(envelope);
        // Track in pending queue (ACK not needed for ack messages)
        if (envelope.type !== 'ack') {
          room.addPending(envelope);
        }
        // Notify TG of outbound messages too (so user sees both sides)
        const tgOut = { roomId: room.roomId, from: this.name + ' (me)', type: envelope.type };
        if (envelope.text) tgOut.text = envelope.text;
        if (envelope.payload) {
          tgOut.content = envelope.payload.content;
          tgOut.text = tgOut.text || envelope.payload.text;
          tgOut.description = envelope.payload.description;
          tgOut.question = envelope.payload.question;
          tgOut.name = envelope.payload.name;
          tgOut.data = envelope.payload.data;
        }
        this._tgNotify('message', tgOut);
        return this._json(res, 200, { ok: true, id: envelope.id, roomId: room.roomId });
      }

      // GET /recv?room=X&wait=N&all=1
      if (method === 'GET' && pathname === '/recv') {
        const rid = this._resolveAlias(url.searchParams.get('room'));
        const room = rid ? this.rooms.get(rid) : this.rooms.values().next().value;
        if (!room) return this._json(res, 200, []);

        if (url.searchParams.get('all') === '1') {
          return this._json(res, 200, room.readAllInbox());
        }
        const waitSec = parseInt(url.searchParams.get('wait') || '0', 10);
        if (room.unread.length > 0 || waitSec <= 0) {
          return this._json(res, 200, room.unread.splice(0));
        }
        const clamped = Math.min(Math.max(waitSec, 1), 120);
        const msgs = await this._longPoll(room, clamped);
        return this._json(res, 200, msgs);
      }

      // POST /close {roomId}
      if (method === 'POST' && pathname === '/close') {
        const body = await this._readBody(req);
        const rid = this._resolveAlias(body.roomId);
        if (rid) {
          this._closeRoom(rid);
        } else {
          // Close all rooms
          for (const [id] of this.rooms) this._closeRoom(id);
        }
        return this._json(res, 200, { ok: true });
      }

      // GET /health
      if (method === 'GET' && pathname === '/health') {
        return this._json(res, 200, { status: 'ok', rooms: this.rooms.size });
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
      case 'chat':   return proto.chat(body.content || body.text || '', this.name);
      case 'task':   return proto.task(body.description || '', body.data || null, this.name);
      case 'result': return proto.result(body.data || null, this.name, body.replyTo);
      case 'file':   return proto.file(body.name || '', body.content || '', this.name);
      case 'query':  return proto.query(body.question || '', this.name);
      case 'ack':    return proto.ack(body.replyTo || '', this.name);
      default:       return proto.createMessage(body.type || 'chat', body.payload || body, { from: this.name });
    }
  }

  // -- ACK helpers ---------------------------------------------------------

  _sendAck(room, msgId) {
    if (!msgId || !room.transport || !room.transport.connected) return;
    try {
      const ackMsg = proto.ack(msgId, this.name);
      room.transport.send(ackMsg);
    } catch { /* ignore if DC closed between check and send */ }
  }

  _replayPending(room) {
    const msgs = room.getPending();
    if (msgs.length === 0) return;
    this._log(`[${room.roomId}] Replaying ${msgs.length} pending messages`);
    for (const msg of msgs) {
      try { room.transport.send(msg); } catch { break; }
    }
  }

  // -- long-poll -----------------------------------------------------------

  _longPoll(room, seconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        room.waiters = room.waiters.filter((w) => w !== entry);
        resolve(room.unread.splice(0));
      }, seconds * 1000);
      const entry = { resolve, timer };
      room.waiters.push(entry);
    });
  }

  _flushWaiters(room) {
    if (room.waiters.length === 0) return;
    const msgs = room.unread.splice(0);
    for (const w of room.waiters) {
      clearTimeout(w.timer);
      w.resolve(msgs);
    }
    room.waiters = [];
  }

  // -- alias ---------------------------------------------------------------

  _resolveAlias(id) {
    if (!id) return id;
    return this._aliases[id] || id;
  }

  // -- hooks ---------------------------------------------------------------

  _runHook(event, data) {
    const cmd = this.hooks[event];
    if (!cmd) return;
    let expanded = cmd;
    for (const [k, v] of Object.entries(data)) {
      const safe = "'" + String(v).replace(/'/g, "'\\''") + "'";
      expanded = expanded.replace(new RegExp(`\\{${k}\\}`, 'g'), safe);
    }
    execFile('/bin/sh', ['-c', expanded], { timeout: 10000 }, (err) => {
      if (err) this._log(`Hook '${event}' failed: ${err.message}`);
    });
  }

  // -- telegram ------------------------------------------------------------

  _tgNotify(event, data) {
    if (this._tg) this._tg.notify(event, data).catch(() => {});
    this._notifier.notify(event, data);
  }

  // -- helpers -------------------------------------------------------------

  _json(res, status, data) { res.writeHead(status); res.end(JSON.stringify(data)); }

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
