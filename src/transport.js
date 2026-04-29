'use strict';

const { EventEmitter } = require('events');
const nodeDataChannel = require('node-datachannel');
const WebSocket = require('ws');
const { negotiate } = require('./permissions');

const MAX_DC_MSG = 256 * 1024; // 256 KB cap on DataChannel messages

// STUN: China-accessible first, Google as overseas fallback
const STUN_SERVERS = [
  'stun:stun.qq.com:3478',
  'stun:stun.miwifi.com:3478',
  'stun:stun.alidns.com:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

/**
 * Parse user-friendly ICE server strings into node-datachannel format.
 *   "stun:host:port"                                → as-is
 *   "turn:host:port?username=X&credential=Y"        → "turn:host:port:X:Y"
 *   "turn:host:port:username:password"               → as-is
 */
function parseIceServer(s) {
  if (!s || typeof s !== 'string') return null;
  if (s.startsWith('turn:') && s.includes('?')) {
    const [base, qs] = s.split('?');
    const params = new URLSearchParams(qs);
    const user = params.get('username') || '';
    const cred = params.get('credential') || params.get('password') || '';
    if (user && cred) return `${base}:${user}:${cred}`;
  }
  return s;
}

const DEFAULT_SIGNALING = 'wss://ginfo.cc/signal/';

/**
 * ClawTransport — P2P transport layer over WebRTC DataChannel.
 *
 * Pure EventEmitter. No readline, no chalk, no process.exit.
 * Agents and CLIs both use this as the sole communication primitive.
 *
 * Events:
 *   'room'              (roomId: string)    — room ID assigned by server
 *   'connecting'        ()                  — signaling WS opened
 *   'role'              (role: string)      — assigned 'offerer' or 'answerer'
 *   'connected'         (peerName, perm)    — P2P ready + handshake done
 *   'message'           (msg: object)       — received a P2P message
 *   'disconnected'      (reason: string)    — peer or signaling gone
 *   'error'             (err: Error)        — recoverable error
 *   'log'               (text: string)      — debug info
 */
class ClawTransport extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.signalingUrl]  Signaling server base URL
   * @param {string} [opts.name]          Local peer name
   * @param {string} [opts.permission]    Requested permission: intimate|helper|chat
   * @param {string} [opts.room]          Room ID to join (omit to create new room)
   * @param {string[]} [opts.stunServers] Override STUN server list (deprecated, use iceServers)
   * @param {string[]} [opts.iceServers]  ICE servers (STUN and/or TURN)
   */
  constructor({
    signalingUrl = DEFAULT_SIGNALING,
    name = 'Claw',
    permission = 'helper',
    room,
    stunServers,
    iceServers,
  } = {}) {
    super();
    this.signalingUrl = signalingUrl;
    this.name = name;
    this.requestedPermission = permission;
    this.negotiatedPermission = null;
    this.peerName = null;
    this.roomId = null;

    this._room = room || null;
    const raw = iceServers || stunServers || STUN_SERVERS;
    this._iceServers = raw.map(parseIceServer).filter(Boolean);
    this._ws = null;
    this._pc = null;
    this._dc = null;
    this._role = null;
    this._connected = false;
    this._closed = false;
  }

  // -- public API -----------------------------------------------------------

  connect() {
    if (this._closed) throw new Error('Transport is closed');

    // Append room ID to URL if joining an existing room
    let wsUrl = this.signalingUrl;
    if (this._room) {
      wsUrl = wsUrl.replace(/\/+$/, '') + '/' + this._room;
    }

    this._log(`Connecting to ${wsUrl}`);
    this._log(`ICE: ${this._iceServers.map(s => s.replace(/:[^:]+:[^:]+$/, ':***:***')).join(', ')}`);
    this._ws = new WebSocket(wsUrl);

    this._ws.on('open', () => {
      this._log('Signaling connected, waiting for role');
      this.emit('connecting');
    });

    this._ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this._onSignaling(msg);
    });

    this._ws.on('close', () => {
      if (!this._connected) {
        this.emit('disconnected', 'signaling-lost-before-p2p');
      } else {
        this._log('Signaling disconnected (P2P remains active)');
      }
    });

    this._ws.on('error', (err) => {
      this.emit('error', new Error(`Signaling: ${err.message}`));
    });
  }

  send(msg) {
    if (!this._dc || !this._dc.isOpen()) {
      throw new Error('DataChannel not open');
    }
    const raw = JSON.stringify(msg);
    if (raw.length > MAX_DC_MSG) {
      throw new Error(`Message too large: ${raw.length} bytes (max ${MAX_DC_MSG})`);
    }
    this._dc.sendMessage(raw);
  }

  close() {
    this._closed = true;
    if (this._dc) try { this._dc.close(); } catch {}
    if (this._pc) try { this._pc.close(); } catch {}
    if (this._ws) try { this._ws.close(); } catch {}
    this._dc = null;
    this._pc = null;
    this._ws = null;
  }

  get connected() { return this._connected; }

  // -- signaling handler ----------------------------------------------------

  _onSignaling(msg) {
    switch (msg.type) {
      case 'ready': {
        if (msg.payload.roomId) {
          this.roomId = msg.payload.roomId;
          this._log(`Room: ${this.roomId}`);
          this.emit('room', this.roomId);
        }
        this._role = msg.payload.role;
        this._log(`Role: ${this._role}`);
        this.emit('role', this._role);
        this._initPeer();
        if (this._role === 'offerer') {
          this._log('Waiting for peer before creating offer');
        }
        break;
      }
      case 'peer-joined': {
        this._log('Peer joined');
        if (this._role === 'offerer') this._createOffer();
        break;
      }
      case 'offer': {
        this._pc.setRemoteDescription(msg.payload, 'offer');
        this._pc.setLocalDescription();
        break;
      }
      case 'answer': {
        this._pc.setRemoteDescription(msg.payload, 'answer');
        break;
      }
      case 'ice': {
        if (msg.payload && this._pc) {
          try { this._pc.addRemoteCandidate(msg.payload.candidate, msg.payload.sdpMid); } catch {}
        }
        break;
      }
      case 'peer-left': {
        // Only emit disconnect if P2P was actually established
        // Otherwise it's just old session cleanup noise
        if (this._connected) {
          this._connected = false;
          this.emit('disconnected', 'peer-left');
        }
        break;
      }
      case 'error': {
        this.emit('error', new Error(`Server: ${msg.payload}`));
        break;
      }
    }
  }

  // -- WebRTC setup ---------------------------------------------------------

  _initPeer() {
    this._pc = new nodeDataChannel.PeerConnection(this.name, {
      iceServers: this._iceServers,
    });
    this._pc.onLocalDescription((sdp, type) => {
      this._log(`Local description: ${type}`);
      this._sendSignal({ type, payload: sdp });
    });
    this._pc.onLocalCandidate((candidate, mid) => {
      this._sendSignal({ type: 'ice', payload: { candidate, sdpMid: mid, sdpMLineIndex: 0 } });
    });
    this._pc.onDataChannel((dc) => {
      this._log('DataChannel received from peer');
      this._setupDC(dc);
    });
  }

  _createOffer() {
    const dc = this._pc.createDataChannel('claw-link');
    this._setupDC(dc);
    this._pc.setLocalDescription();
  }

  _setupDC(dc) {
    this._dc = dc;
    dc.onOpen(() => {
      this._log('DataChannel open, sending handshake');
      this.send({
        type: 'handshake',
        name: this.name,
        requestedPermission: this.requestedPermission,
        version: '0.1.0',
      });
    });
    dc.onMessage((raw) => {
      if (typeof raw === 'string' && raw.length > MAX_DC_MSG) {
        this.emit('error', new Error(`Received message too large: ${raw.length}`));
        return;
      }
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      this._onData(data);
    });
    dc.onClosed(() => {
      this._connected = false;
      this.emit('disconnected', 'datachannel-closed');
    });
    dc.onError((err) => {
      this.emit('error', new Error(`DataChannel: ${err}`));
    });
  }

  // -- P2P message handler --------------------------------------------------

  _onData(data) {
    switch (data.type) {
      case 'handshake': {
        const negotiated = negotiate(this.requestedPermission, data.requestedPermission);
        this.negotiatedPermission = negotiated;
        this.peerName = data.name;
        this.send({
          type: 'handshake-ack',
          name: this.name,
          requestedPermission: this.requestedPermission,
          negotiatedPermission: negotiated,
          version: '0.1.0',
        });
        this._onHandshakeDone(data.name, negotiated);
        break;
      }
      case 'handshake-ack': {
        // Never trust peer's claimed negotiatedPermission — compute locally
        const verified = negotiate(this.requestedPermission, data.requestedPermission);
        this.negotiatedPermission = verified;
        this.peerName = data.name;
        this._onHandshakeDone(data.name, verified);
        break;
      }
      default: {
        this.emit('message', data);
        break;
      }
    }
  }

  _onHandshakeDone(peerName, permission) {
    if (this._connected) return;
    this._connected = true;
    this._log(`Handshake complete: peer=${peerName} perm=${permission}`);
    this.emit('connected', peerName, permission);
  }

  _sendSignal(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  _log(text) { this.emit('log', text); }
}

module.exports = { ClawTransport, DEFAULT_SIGNALING, STUN_SERVERS, parseIceServer };
