'use strict';

const readline = require('readline');
const { ClawTransport } = require('./transport');
const proto = require('./protocol');
const { generateInvite, writeInvite } = require('./invite');

/**
 * ClawAgent — non-interactive JSON-lines interface for AI agents.
 *
 * stdout: one JSON object per line (events from transport)
 * stdin:  one JSON object per line (messages to send)
 *
 * No chalk, no prompts, no interactive readline. Pure machine protocol.
 */
class ClawAgent {
  constructor({ signalingUrl = 'wss://ginfo.cc/signal/', name = 'Claw', permission = 'helper', room }) {
    this.signalingUrl = signalingUrl;
    this.name = name;
    this.permission = permission;
    this.transport = new ClawTransport({ signalingUrl, name, permission, room });
    this._rl = null;
  }

  start() {
    const t = this.transport;

    t.on('room', (roomId) => {
      const invite = generateInvite(roomId, { signal: this.signalingUrl, creator: this.name, perm: this.permission });
      const invitePath = writeInvite(invite);
      this._emit('room', { roomId, invite: invitePath });
    });
    t.on('role', (role) => this._emit('role', { role }));
    t.on('connected', (peer, perm) => {
      this._emit('connected', { peer, permission: perm });
      this._startStdin();
    });
    t.on('message', (msg) => this._emit('message', msg));
    t.on('disconnected', (reason) => {
      this._emit('disconnected', { reason });
      process.exit(0);
    });
    t.on('error', (err) => this._emit('error', { message: err.message }));

    t.connect();
  }

  /** Write one JSON line to stdout */
  _emit(event, data) {
    const line = JSON.stringify({ event, ...data });
    process.stdout.write(line + '\n');
  }

  /** Read JSON lines from stdin and send as messages */
  _startStdin() {
    this._rl = readline.createInterface({ input: process.stdin });
    this._rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this._emit('error', { message: 'Invalid JSON on stdin' });
        return;
      }
      this._sendMessage(msg);
    });
    this._rl.on('close', () => {
      this.transport.close();
      process.exit(0);
    });
  }

  /**
   * Send a message via DataChannel.
   * Accepts either raw protocol messages or shorthand:
   *   {"type":"chat","content":"hello"}
   *   {"type":"task","description":"...","data":{}}
   *   {"type":"query","question":"..."}
   *   {"type":"file","name":"x.js","content":"..."}
   *   {"type":"result","data":{},"replyTo":"msgid"}
   *   {"type":"ack","replyTo":"msgid"}
   *
   * Or a full protocol envelope (has .id field) — sent as-is.
   */
  _sendMessage(msg) {
    try {
      // Full envelope (already has id) → send as-is
      if (msg.id) {
        this.transport.send(msg);
        return;
      }

      // Shorthand → wrap in protocol envelope
      const type = msg.type;
      let envelope;
      switch (type) {
        case 'chat':
          envelope = proto.chat(msg.content || '', this.name);
          break;
        case 'task':
          envelope = proto.task(msg.description || '', msg.data || null, this.name);
          break;
        case 'result':
          envelope = proto.result(msg.data || null, this.name, msg.replyTo);
          break;
        case 'file':
          envelope = proto.file(msg.name || '', msg.content || '', this.name);
          break;
        case 'query':
          envelope = proto.query(msg.question || '', this.name);
          break;
        case 'ack':
          envelope = proto.ack(msg.replyTo || '', this.name);
          break;
        default:
          // Unknown type → wrap in createMessage
          envelope = proto.createMessage(type, msg.payload || msg, { from: this.name });
      }
      this.transport.send(envelope);
    } catch (err) {
      this._emit('error', { message: err.message });
    }
  }
}

module.exports = { ClawAgent };
