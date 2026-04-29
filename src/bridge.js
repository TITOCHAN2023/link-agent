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

const MAX_RECONNECT = 30;  // give up after 30 attempts if peer never shows up

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

    // Agent multiplexing: per-agent message queues within this room
    this.agentQueues = new Map();
    this.msgOrigin = new Map();

    // Task tracking: outbound tasks and their lifecycle
    this.tasksPath = path.join(this.dataDir, 'tasks.jsonl');
    this.tasks = this._loadTasks();
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

  // -- task tracking -------------------------------------------

  trackTask(envelope) {
    const entry = {
      id: envelope.id,
      description: envelope.payload?.description || '',
      state: 'sent',
      priority: envelope.priority ?? 1,
      sentAt: envelope.ts,
      completedAt: null,
      resultId: null,
    };
    this.tasks.set(envelope.id, entry);
    this._saveTasks();
  }

  completeTask(resultMsg) {
    const taskId = resultMsg.replyTo;
    if (!taskId || !this.tasks.has(taskId)) return false;
    const t = this.tasks.get(taskId);
    t.state = 'completed';
    t.completedAt = Date.now();
    t.resultId = resultMsg.id;
    this._saveTasks();
    return true;
  }

  ackTask(msgId) {
    const t = this.tasks.get(msgId);
    if (!t || t.state !== 'sent') return;
    t.state = 'acked';
    this._saveTasks();
  }

  getTasks() {
    return [...this.tasks.values()];
  }

  _loadTasks() {
    try {
      const c = fs.readFileSync(this.tasksPath, 'utf8').trim();
      if (!c) return new Map();
      const map = new Map();
      for (const line of c.split('\n')) {
        try {
          const t = JSON.parse(line);
          if (t && t.id) map.set(t.id, t);
        } catch { /* skip */ }
      }
      return map;
    } catch { return new Map(); }
  }

  _saveTasks() {
    const lines = [...this.tasks.values()].map(t => JSON.stringify(t)).join('\n');
    fs.writeFileSync(this.tasksPath, lines ? lines + '\n' : '');
  }

  static validAgentId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(id);
  }

  getAgent(agentId) {
    if (!agentId) return null;
    if (!RoomState.validAgentId(agentId)) return null;
    if (!this.agentQueues.has(agentId)) {
      this.agentQueues.set(agentId, { unread: [], waiters: [] });
    }
    return this.agentQueues.get(agentId);
  }

  trackOrigin(msgId, agentId) {
    if (!msgId || !agentId) return;
    this.msgOrigin.set(msgId, agentId);
    if (this.msgOrigin.size > 2000) {
      const first = this.msgOrigin.keys().next().value;
      this.msgOrigin.delete(first);
    }
  }
}

/**
 * ClawBridge — multi-room HTTP bridge for serial agents.
 *
 * HTTP API (all endpoints accept roomId to target a specific room):
 *   POST /connect {roomId?, agentId?}   → connect to room (reuses transport if active)
 *   POST /send    {roomId, agentId?, type, ...} → send message (tracks origin per agent)
 *   GET  /recv?room=X&agent=Y&wait=N   → poll messages (per-agent queue if agent specified)
 *   GET  /status?room=X                → room status (omit room for all)
 *   POST /close   {roomId}             → close room
 *   GET  /rooms                         → list all rooms
 *   GET  /health                        → liveness
 */
class ClawBridge {
  constructor({
    port = 7654,
    maxPortRetries = 10,
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
    this.maxPortRetries = maxPortRetries;
    this.signalingUrl = signalingUrl;
    this.name = name;
    this.permission = permission;
    this.intro = intro || '';
    this._aliases = aliases || {};

    this.hooks = { connect: onConnect, message: onMessage, disconnect: onDisconnect };
    this._customDataDir = dataDir || null;
    this._baseDir = null;
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
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleHTTP(req, res));
      let port = this.port;
      let attempts = 0;

      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && attempts < this.maxPortRetries) {
          attempts++;
          port++;
          this._log(`Port ${port - 1} in use, trying ${port}`);
          this.server.listen(port, '127.0.0.1');
        } else {
          this.server.removeListener('error', onError);
          reject(err);
        }
      };

      this.server.on('error', onError);
      this.server.once('listening', () => {
        this.server.removeListener('error', onError);
        this.port = port;
        this._baseDir = this._customDataDir || path.join(process.env.HOME || '/tmp', '.claw-link', `bridge-${this.port}`);
        fs.mkdirSync(this._baseDir, { recursive: true });
        this._log(`Bridge HTTP on http://127.0.0.1:${this.port}`);
        if (this._tg) this._tg.start();
        resolve();
      });

      this.server.listen(port, '127.0.0.1');
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
    if (room.transport && room.transport.connected && !room.stopped) return;
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
      // Handle ACK: remove from pending, update task state, don't deliver to user
      if (msg.type === 'ack' && msg.replyTo) {
        room.ackReceived(msg.replyTo);
        room.ackTask(msg.replyTo);
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
      // Auto-complete task when result arrives with matching replyTo
      if (msg.type === 'result' && msg.replyTo) {
        room.completeTask(msg);
      }
      room.appendInbox(msg);
      room.msgCount++;
      let targetAgents = [];
      if (room.agentQueues.size === 0) {
        room.unread.push(msg);
        this._flushWaiters(room);
      } else if (msg.replyTo && room.msgOrigin.has(msg.replyTo)) {
        const targetId = room.msgOrigin.get(msg.replyTo);
        const agent = room.agentQueues.get(targetId);
        if (agent) {
          agent.unread.push(msg);
          this._flushWaiters(agent);
          targetAgents = [targetId];
        } else {
          for (const [id, a] of room.agentQueues) { a.unread.push(msg); this._flushWaiters(a); }
          targetAgents = [...room.agentQueues.keys()];
        }
      } else {
        for (const [id, a] of room.agentQueues) { a.unread.push(msg); this._flushWaiters(a); }
        targetAgents = [...room.agentQueues.keys()];
      }
      const hookBase = { from: msg.from, type: msg.type, id: msg.id, roomId: room.roomId };
      if (msg.payload) {
        if (msg.payload.content) hookBase.content = msg.payload.content;
        if (msg.payload.description) hookBase.description = msg.payload.description;
        if (msg.payload.question) hookBase.question = msg.payload.question;
      }
      if (targetAgents.length > 0) {
        for (const agentId of targetAgents) {
          this._runHook('message', { ...hookBase, agentId });
          this._writeAgentNotify(agentId, hookBase);
        }
      } else {
        this._runHook('message', hookBase);
      }
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

    if (room.reconnectAttempt > MAX_RECONNECT) {
      this._log(`[${room.roomId}] Gave up after ${MAX_RECONNECT} attempts — closing room`);
      room.appendEvent({ event: 'gave-up', attempts: room.reconnectAttempt });
      this._tgNotify('gave-up', { roomId: room.roomId, attempts: room.reconnectAttempt });
      this._closeRoom(room.roomId);
      return;
    }

    const delay = Math.min(5000 * Math.pow(2, room.reconnectAttempt - 1), 30000);
    this._log(`[${room.roomId}] Reconnect in ${delay / 1000}s (attempt ${room.reconnectAttempt}/${MAX_RECONNECT})`);
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
      // POST /connect {roomId?, agentId?} — connect to room (reuses transport if active)
      if (method === 'POST' && pathname === '/connect') {
        const body = await this._readBody(req);
        const resolvedRoom = this._resolveAlias(body.roomId);
        const agentId = body.agentId || null;
        if (agentId && !RoomState.validAgentId(agentId)) {
          return this._json(res, 400, { error: 'Invalid agentId: only alphanumeric, hyphen and underscore (max 64 chars)' });
        }

        // Reuse existing room if transport is active (with or without agentId)
        const existing = resolvedRoom ? this.rooms.get(resolvedRoom) : null;
        if (existing && existing.transport && !existing.stopped) {
          if (agentId) existing.getAgent(agentId);
          this._log(`[${existing.roomId}] Reusing transport${agentId ? ' for agent ' + agentId : ''}`);
          const actualId = existing.transport.roomId || existing.roomId;
          const invite = generateInvite(actualId, { signal: this.signalingUrl, creator: this.name, perm: this.permission });
          const invitePath = writeInvite(invite, existing.dataDir);
          const resp = { roomId: actualId, inbox: existing.inboxPath, invite: invitePath };
          if (agentId) {
            resp.agentId = agentId;
            resp.notify = `/tmp/claw_notify_${agentId}`;
            resp.recv = `claw-link bridge recv --agent ${agentId} --wait 30`;
            resp.hookCheck = `[ -s /tmp/claw_notify_${agentId} ]`;
          }
          return this._json(res, 200, resp);
        }

        const pendingKey = resolvedRoom || '_pending_' + Date.now();
        const room = this._initRoom(pendingKey);
        this._connectRoom(room, resolvedRoom || null);
        // Wait for signaling to assign room ID
        try {
          await this._waitFor(() => room.transport && room.transport.roomId, 10000);
        } catch {
          this._destroyRoom(room);
          this.rooms.delete(pendingKey);
          return this._json(res, 504, { error: 'Signaling timeout' });
        }
        const actualId = room.transport.roomId;
        // Re-register under actual room ID if it was auto-generated
        if (!resolvedRoom && actualId) {
          this.rooms.delete(pendingKey);
          room.roomId = actualId;
          room.dataDir = path.join(this._baseDir, actualId);
          fs.mkdirSync(room.dataDir, { recursive: true });
          room.inboxPath = path.join(room.dataDir, 'inbox.jsonl');
          room.eventsPath = path.join(room.dataDir, 'events.jsonl');
          this.rooms.set(actualId, room);
        }
        if (agentId) room.getAgent(agentId);
        const invite = generateInvite(actualId, { signal: this.signalingUrl, creator: this.name, perm: this.permission });
        const invitePath = writeInvite(invite, room.dataDir);
        const resp = { roomId: actualId, inbox: room.inboxPath, invite: invitePath };
        if (agentId) {
          resp.agentId = agentId;
          resp.notify = `/tmp/claw_notify_${agentId}`;
          resp.recv = `claw-link bridge recv --agent ${agentId} --wait 30`;
          resp.hookCheck = `[ -s /tmp/claw_notify_${agentId} ]`;
        }
        return this._json(res, 200, resp);
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
            agents: [...room.agentQueues.entries()].map(([id, a]) => ({ id, unread: a.unread.length })),
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
          agents: [...room.agentQueues.entries()].map(([id, a]) => ({ id, unread: a.unread.length })),
        });
      }

      // POST /send {roomId, type, ...}
      if (method === 'POST' && pathname === '/send') {
        const body = await this._readBody(req);
        const rid = this._resolveAlias(body.roomId);
        const room = rid ? this.rooms.get(rid) : this.rooms.values().next().value;
        if (!room) return this._json(res, 404, { error: 'No room', hint: 'Connect first: claw-link bridge connect [room-id]' });
        if (!room.transport || !room.transport.connected) {
          return this._json(res, 409, { error: `Room '${room.roomId}' not connected`, hint: 'Peer has not joined yet. Check: claw-link bridge status' });
        }
        const envelope = this._buildEnvelope(body);
        room.transport.send(envelope);
        if (body.agentId) {
          if (!RoomState.validAgentId(body.agentId)) {
            return this._json(res, 400, { error: 'Invalid agentId: only alphanumeric, hyphen and underscore (max 64 chars)' });
          }
          room.trackOrigin(envelope.id, body.agentId);
        }
        // Track in pending queue (ACK not needed for ack messages)
        if (envelope.type !== 'ack') {
          room.addPending(envelope);
        }
        // Auto-track outbound tasks
        if (envelope.type === 'task') {
          room.trackTask(envelope);
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

      // GET /recv?room=X&agent=Y&wait=N&all=1&limit=N
      if (method === 'GET' && pathname === '/recv') {
        const rid = this._resolveAlias(url.searchParams.get('room'));
        const agentId = url.searchParams.get('agent') || null;
        if (agentId && !RoomState.validAgentId(agentId)) {
          return this._json(res, 400, { error: 'Invalid agentId: only alphanumeric, hyphen and underscore (max 64 chars)' });
        }
        const room = rid ? this.rooms.get(rid) : this.rooms.values().next().value;
        if (!room) return this._json(res, 200, []);

        if (url.searchParams.get('all') === '1') {
          return this._json(res, 200, room.readAllInbox());
        }
        const queue = agentId ? room.getAgent(agentId) : room;
        const limit = parseInt(url.searchParams.get('limit') || '0', 10);
        const waitSec = parseInt(url.searchParams.get('wait') || '0', 10);
        if (queue.unread.length > 0 || waitSec <= 0) {
          queue.unread.sort((a, b) => (b.priority || 1) - (a.priority || 1));
          const batch = limit > 0 ? queue.unread.splice(0, limit) : queue.unread.splice(0);
          return this._json(res, 200, batch);
        }
        const clamped = Math.min(Math.max(waitSec, 1), 120);
        let msgs = await this._longPoll(queue, clamped);
        msgs.sort((a, b) => (b.priority || 1) - (a.priority || 1));
        if (limit > 0) msgs = msgs.slice(0, limit);
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

      // GET /debug?room=X — WebRTC internals (ICE candidate pair, state, bytes)
      if (method === 'GET' && pathname === '/debug') {
        const rid = this._resolveAlias(url.searchParams.get('room'));
        const room = rid ? this.rooms.get(rid) : this.rooms.values().next().value;
        if (!room || !room.transport) return this._json(res, 200, { error: 'No active room' });
        const pc = room.transport._pc;
        const info = { roomId: room.roomId, peer: room.peerName };
        if (pc) {
          try { info.iceState = pc.iceState(); } catch {}
          try { info.state = pc.state(); } catch {}
          try { info.gatheringState = pc.gatheringState(); } catch {}
          try { info.signalingState = pc.signalingState(); } catch {}
          try { info.selectedCandidatePair = pc.getSelectedCandidatePair(); } catch {}
          try { info.bytesSent = pc.bytesSent(); } catch {}
          try { info.bytesReceived = pc.bytesReceived(); } catch {}
          try { info.rtt = pc.rtt(); } catch {}
        }
        return this._json(res, 200, info);
      }

      // GET /tasks?room=X&state=Y — task lifecycle tracking
      if (method === 'GET' && pathname === '/tasks') {
        const rid = this._resolveAlias(url.searchParams.get('room'));
        const stateFilter = url.searchParams.get('state');
        const room = rid ? this.rooms.get(rid) : this.rooms.values().next().value;
        if (!room) return this._json(res, 200, []);
        let tasks = room.getTasks();
        if (stateFilter) tasks = tasks.filter(t => t.state === stateFilter);
        return this._json(res, 200, tasks);
      }

      // POST /perm {roomId, level} — dynamic permission adjustment
      if (method === 'POST' && pathname === '/perm') {
        const body = await this._readBody(req);
        const rid = this._resolveAlias(body.roomId);
        const level = body.level;
        if (!level || !['intimate', 'helper', 'chat'].includes(level)) {
          return this._json(res, 400, { error: 'level must be intimate|helper|chat' });
        }
        const room = rid ? this.rooms.get(rid) : this.rooms.values().next().value;
        if (!room) return this._json(res, 404, { error: 'No room', hint: 'Connect first: claw-link bridge connect [room-id]' });
        this._setRoomPerm(room.roomId, level);
        return this._json(res, 200, { ok: true, roomId: room.roomId, permission: level });
      }

      // GET /health
      if (method === 'GET' && pathname === '/health') {
        return this._json(res, 200, { status: 'ok', port: this.port, rooms: this.rooms.size });
      }

      return this._json(res, 404, { error: 'Not found' });
    } catch (err) {
      return this._json(res, 500, { error: err.message });
    }
  }

  // -- message building ----------------------------------------------------

  _buildEnvelope(body) {
    if (body.id) return body;
    let envelope;
    switch (body.type) {
      case 'chat':   envelope = proto.chat(body.content || body.text || '', this.name); break;
      case 'task':   envelope = proto.task(body.description || '', body.data || null, this.name); break;
      case 'result': envelope = proto.result(body.data || null, this.name, body.replyTo); break;
      case 'file':   envelope = proto.file(body.name || '', body.content || '', this.name); break;
      case 'query':  envelope = proto.query(body.question || '', this.name); break;
      case 'ack':    envelope = proto.ack(body.replyTo || '', this.name); break;
      default:       envelope = proto.createMessage(body.type || 'chat', body.payload || body, { from: this.name }); break;
    }
    // Pass through priority if specified
    if (body.priority !== undefined) {
      const p = typeof body.priority === 'string'
        ? ({ high: 2, normal: 1, low: 0 }[body.priority.toLowerCase()] ?? 1)
        : Number(body.priority);
      envelope.priority = p;
    }
    return envelope;
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

  // -- per-agent auto-notify ------------------------------------------------

  _writeAgentNotify(agentId, data) {
    if (!agentId) return;
    const file = path.join('/tmp', `claw_notify_${agentId}`);
    const line = `${data.from || ''}:${data.type || ''}:${data.id || ''}\n`;
    try { fs.appendFileSync(file, line); } catch {}
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
