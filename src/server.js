'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');

/**
 * Multi-room signaling server.
 *
 * Room flow:
 *   Peer A → ws://host:port/       → server generates roomId, sends in ready
 *   Peer B → ws://host:port/<id>   → server matches, sends ready + peer-joined
 */
class SignalingServer {
  constructor({ port = 8765, onLog = console.log } = {}) {
    this.port = port;
    this.log = onLog;
    this.rooms = new Map();
    this.wss = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port }, () => {
        this.log(`Signaling server listening on ws://0.0.0.0:${this.port}`);
        resolve(this.wss);
      });
      this.wss.on('error', reject);
      this.wss.on('connection', (ws, req) => this._handleConnection(ws, req));
    });
  }

  _handleConnection(ws, req) {
    const addr = req.socket.remoteAddress;
    const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    const pathParts = pathname.split('/').filter(Boolean);

    let roomId;
    if (pathParts.length > 0) {
      roomId = pathParts[pathParts.length - 1];
    } else {
      roomId = crypto.randomBytes(4).toString('hex');
    }

    // Create room if it doesn't exist (first peer = creator, custom or auto ID)
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, { peers: [] });
      this.log(`[${roomId}] Room created`);
    }

    const room = this.rooms.get(roomId);
    if (room.peers.length >= 2) {
      this._send(ws, { type: 'error', payload: 'Room is full' });
      ws.close();
      return;
    }

    room.peers.push(ws);
    const idx = room.peers.length;
    this.log(`[${roomId}] Peer #${idx} joined from ${addr}`);

    if (idx === 1) {
      this._send(ws, { type: 'ready', payload: { role: 'offerer', roomId, message: 'Waiting for peer...' } });
    } else {
      this._send(ws, { type: 'ready', payload: { role: 'answerer', roomId, message: 'Peer found!' } });
      const offerer = room.peers[0];
      if (offerer && offerer.readyState === 1) this._send(offerer, { type: 'peer-joined' });
    }

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (['offer', 'answer', 'ice'].includes(msg.type)) {
        const other = room.peers.find((p) => p !== ws);
        if (other && other.readyState === 1) other.send(JSON.stringify(msg));
      }
    });

    ws.on('close', () => {
      this.log(`[${roomId}] Peer #${idx} disconnected`);
      room.peers = room.peers.filter((p) => p !== ws);
      for (const p of room.peers) {
        if (p.readyState === 1) this._send(p, { type: 'peer-left' });
      }
      if (room.peers.length === 0) {
        this.rooms.delete(roomId);
        this.log(`[${roomId}] Room removed`);
      }
    });

    ws.on('error', (err) => this.log(`[${roomId}] Error: ${err.message}`));
  }

  _send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  close() {
    if (this.wss) {
      for (const [, room] of this.rooms) for (const p of room.peers) p.close();
      this.rooms.clear();
      this.wss.close();
      this.log('Signaling server stopped.');
    }
  }
}

module.exports = { SignalingServer };
