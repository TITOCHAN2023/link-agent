'use strict';

const nodeDataChannel = require('node-datachannel');
const WebSocket = require('ws');
const readline = require('readline');
const chalk = require('chalk');
const { negotiate, isPrivate, canPerform, describe } = require('./permissions');
const { SessionManager } = require('./session');

// ============================================================
// STUN 服务器列表（带自动 fallback）
// 优先 Google，不通自动转 Alibaba / Tencent
// ============================================================
const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.miwifi.com:3478',      // Xiaomi (国内可达)
  'stun:stun.qq.com:3478',          // Tencent
  'stun:stun.alidns.com:3478',      // Alibaba
];

/**
 * 测试 STUN 服务器是否可达（简单 TCP 连通测试）
 * @param {string} stunUri  格式: stun:host:port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function testStun(stunUri, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const match = stunUri.match(/^stun:(.+):(\d+)$/);
    if (!match) return resolve(false);
    const [, host, portStr] = match;
    const port = parseInt(portStr, 10);
    const net = require('net');
    const sock = new net.Socket();
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.connect(port, host, () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

/**
 * 选出可用的 STUN 服务器列表（按优先级尝试，至少返回两个）
 * @returns {Promise<string[]>}
 */
async function selectStunServers() {
  const results = await Promise.all(STUN_SERVERS.map(async (s) => ({ s, ok: await testStun(s) })));
  const reachable = results.filter((r) => r.ok).map((r) => r.s);
  if (reachable.length === 0) {
    // 全不通，降级返回全部（让 WebRTC 自己处理）
    console.log(chalk.yellow('[STUN] Warning: no STUN server reachable, using all as fallback'));
    return STUN_SERVERS;
  }
  console.log(chalk.gray(`[STUN] Using: ${reachable.slice(0, 2).join(', ')}`));
  return reachable.slice(0, 3);
}

// ============================================================
// ClawClient — 主客户端
// ============================================================

class ClawClient {
  /**
   * @param {object} opts
   * @param {string} opts.signalingUrl  信令服务器地址，如 ws://1.2.3.4:8765
   * @param {string} opts.name          本端名称（如 ClawA）
   * @param {string} opts.permission    期望权限级别 intimate|helper|chat
   */
  constructor({ signalingUrl, name = 'Claw', permission = 'helper' }) {
    this.signalingUrl = signalingUrl;
    this.name = name;
    this.requestedPermission = permission;
    this.negotiatedPermission = null;

    this.ws = null;           // 信令 WebSocket
    this.pc = null;           // RTCPeerConnection
    this.dc = null;           // DataChannel
    this.role = null;         // 'offerer' | 'answerer'
    this.rl = null;           // readline interface
    this.sessionMgr = null;   // SessionManager
    this.connected = false;
  }

  /** 启动客户端 */
  async start() {
    const stunServers = await selectStunServers();

    console.log(chalk.gray(`[Signaling] Connecting to ${this.signalingUrl} ...`));
    this.ws = new WebSocket(this.signalingUrl);

    this.ws.on('open', () => {
      console.log(chalk.gray('[Signaling] Connected. Waiting for role assignment...'));
    });

    this.ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      await this._handleSignaling(msg, stunServers);
    });

    this.ws.on('close', () => {
      if (!this.connected) {
        console.log(chalk.red('[Signaling] Disconnected before P2P was established.'));
        process.exit(1);
      } else {
        console.log(chalk.yellow('[Signaling] Signaling server disconnected (P2P remains active).'));
      }
    });

    this.ws.on('error', (err) => {
      console.error(chalk.red(`[Signaling] Error: ${err.message}`));
      process.exit(1);
    });
  }

  /** 处理信令消息 */
  async _handleSignaling(msg, stunServers) {
    switch (msg.type) {
      case 'ready': {
        this.role = msg.payload.role;
        console.log(chalk.gray(`[Signaling] Assigned role: ${this.role.toUpperCase()}`));
        console.log(chalk.gray(`[Signaling] ${msg.payload.message}`));
        this._initPeerConnection(stunServers);
        if (this.role === 'offerer') {
          await this._createOffer();
        }
        break;
      }
      case 'peer-joined': {
        console.log(chalk.gray('[Signaling] Peer has joined! Creating offer...'));
        // offerer 已在 ready 时初始化，直接 create offer
        break;
      }
      case 'offer': {
        await this._handleOffer(msg.payload);
        break;
      }
      case 'answer': {
        await this._handleAnswer(msg.payload);
        break;
      }
      case 'ice': {
        if (msg.payload && this.pc) {
          try { this.pc.addRemoteCandidate(msg.payload.candidate, msg.payload.sdpMid, msg.payload.sdpMLineIndex || 0); } catch {}
        }
        break;
      }
      case 'peer-left': {
        console.log(chalk.yellow('\n[P2P] Peer disconnected.'));
        if (this.connected) process.exit(0);
        break;
      }
      case 'error': {
        console.error(chalk.red(`[Signaling] ${msg.payload}`));
        process.exit(1);
        break;
      }
    }
  }

  /** 初始化 PeerConnection */
  _initPeerConnection(stunServers) {
    const iceServers = stunServers.map((s) => ({ urls: s }));
    this.pc = new nodeDataChannel.PeerConnection(this.name, { iceServers });

    this.pc.onLocalDescription((sdp, type) => {
      this._sendSignal({ type, payload: sdp });
    });

    this.pc.onLocalCandidate((candidate, mid) => {
      this._sendSignal({ type: 'ice', payload: { candidate, sdpMid: mid, sdpMLineIndex: 0 } });
    });

    this.pc.onDataChannel((dc) => {
      console.log(chalk.gray('[P2P] DataChannel received from peer.'));
      this._setupDataChannel(dc);
    });

    if (this.role === 'offerer') {
      const dc = this.pc.createDataChannel('claw-link');
      this._setupDataChannel(dc);
    }
  }

  /** 创建 Offer */
  async _createOffer() {
    this.pc.setLocalDescription();
  }

  /** 处理远端 Offer */
  async _handleOffer(sdp) {
    this.pc.setRemoteDescription(sdp, 'offer');
    this.pc.setLocalDescription();
  }

  /** 处理远端 Answer */
  async _handleAnswer(sdp) {
    this.pc.setRemoteDescription(sdp, 'answer');
  }

  /** 配置 DataChannel 事件 */
  _setupDataChannel(dc) {
    this.dc = dc;

    dc.onOpen(() => {
      this.connected = true;
      console.log(chalk.green('\n✅ P2P DataChannel established!'));
      // 发起权限握手
      this._sendData({
        type: 'handshake',
        name: this.name,
        requestedPermission: this.requestedPermission,
        version: '0.1.0',
      });
    });

    dc.onMessage((msg) => {
      let data;
      try { data = JSON.parse(msg); } catch { return; }
      this._handleData(data);
    });

    dc.onClosed(() => {
      console.log(chalk.red('\n[P2P] DataChannel closed.'));
      process.exit(0);
    });

    dc.onError((err) => {
      console.error(chalk.red(`[P2P] DataChannel error: ${err}`));
    });
  }

  /** 处理 P2P 数据消息 */
  _handleData(data) {
    switch (data.type) {
      case 'handshake': {
        // 收到对方握手，计算协商权限并回复 ack
        const negotiated = negotiate(this.requestedPermission, data.requestedPermission);
        this.negotiatedPermission = negotiated;
        this._sendData({
          type: 'handshake-ack',
          name: this.name,
          requestedPermission: this.requestedPermission,
          negotiatedPermission: negotiated,
          version: '0.1.0',
        });
        this._onHandshakeComplete(data.name, negotiated);
        break;
      }
      case 'handshake-ack': {
        // 收到对方 ack，权限协商完成
        this.negotiatedPermission = data.negotiatedPermission;
        this._onHandshakeComplete(data.name, data.negotiatedPermission);
        break;
      }
      case 'chat': {
        if (!canPerform(this.negotiatedPermission, 'chat')) {
          // 理论上 chat 始终允许，但做防御
          return;
        }
        // 检测隐私内容（HELPER 模式）
        if (this.negotiatedPermission === 'helper' && isPrivate(data.content)) {
          console.log(chalk.red(`[PRIVACY] Message from ${data.from} contains private data and was redacted.`));
          return;
        }
        const time = new Date(data.ts).toLocaleTimeString();
        console.log(`\n${chalk.green(`[${data.from}]`)} ${chalk.gray(time)}: ${data.content}`);
        this.rl && this.rl.prompt();
        break;
      }
      case 'session': {
        if (!canPerform(this.negotiatedPermission, 'session')) {
          console.log(chalk.red(`\n[PERMISSION DENIED] Current permission '${this.negotiatedPermission}' does not allow session operations.`));
          this.rl && this.rl.prompt();
          return;
        }
        this.sessionMgr && this.sessionMgr.handle(data);
        this.rl && this.rl.prompt();
        break;
      }
      default:
        // 忽略未知消息类型
        break;
    }
  }

  /** 握手完成，进入交互模式 */
  _onHandshakeComplete(peerName, negotiatedPermission) {
    // 防止重复初始化
    if (this.rl) return;

    console.log(chalk.cyan(`\n🔗 Connected to ${chalk.bold(peerName)}`));
    console.log(chalk.cyan(`🔐 Permission level: ${chalk.bold(negotiatedPermission.toUpperCase())} — ${describe(negotiatedPermission)}`));
    console.log(chalk.gray('Type a message and press Enter. Commands: /help\n'));

    // 初始化 SessionManager
    this.sessionMgr = new SessionManager(
      this.name,
      (msg) => this._sendData(msg),
      (text) => {
        console.log(chalk.yellow(`\n${text}`));
        this.rl && this.rl.prompt();
      }
    );

    // 初始化 readline
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.setPrompt(chalk.blue(`[${this.name}] > `));
    this.rl.prompt();

    this.rl.on('line', (line) => {
      const input = line.trim();
      if (!input) { this.rl.prompt(); return; }

      if (input.startsWith('/')) {
        this._handleCommand(input);
      } else {
        this._sendChat(input);
      }
      this.rl.prompt();
    });

    this.rl.on('close', () => {
      console.log(chalk.gray('\nBye!'));
      process.exit(0);
    });
  }

  /** 处理 / 命令 */
  _handleCommand(input) {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case 'help':
        console.log(chalk.gray(`
Commands:
  /session start <description>  Start a collaboration session (requires helper or intimate)
  /session accept               Accept a pending session invitation
  /session reject [reason]      Reject a pending session invitation
  /session end                  End the current session
  /perm                         Show current permission level
  /quit                         Exit claw-link
        `.trim()));
        break;

      case 'session': {
        const sub = parts[1];
        if (!sub) { console.log(chalk.red('Usage: /session <start|accept|reject|end>')); break; }
        if (!canPerform(this.negotiatedPermission, 'session')) {
          console.log(chalk.red(`[PERMISSION DENIED] Permission '${this.negotiatedPermission}' does not allow session operations.`));
          break;
        }
        try {
          if (sub === 'start') {
            const desc = parts.slice(2).join(' ') || 'Collaboration';
            this.sessionMgr.create(desc);
          } else if (sub === 'accept') {
            this.sessionMgr.accept();
          } else if (sub === 'reject') {
            const reason = parts.slice(2).join(' ') || 'Declined';
            this.sessionMgr.reject(reason);
          } else if (sub === 'end') {
            this.sessionMgr.end();
          } else {
            console.log(chalk.red(`Unknown session sub-command: ${sub}`));
          }
        } catch (e) {
          console.log(chalk.red(`[Session Error] ${e.message}`));
        }
        break;
      }

      case 'perm':
        console.log(chalk.cyan(`Permission: ${this.negotiatedPermission.toUpperCase()} — ${describe(this.negotiatedPermission)}`));
        break;

      case 'quit':
        console.log(chalk.gray('Closing connection...'));
        if (this.dc) try { this.dc.close(); } catch {}
        if (this.pc) try { this.pc.close(); } catch {}
        process.exit(0);
        break;

      default:
        console.log(chalk.red(`Unknown command: /${cmd}. Type /help for help.`));
    }
  }

  /** 发送普通聊天消息 */
  _sendChat(text) {
    if (!canPerform(this.negotiatedPermission, 'chat')) {
      console.log(chalk.red('[PERMISSION DENIED] Cannot send chat messages.'));
      return;
    }
    this._sendData({ type: 'chat', from: this.name, ts: Date.now(), content: text });
  }

  /** 通过 DataChannel 发送 JSON */
  _sendData(obj) {
    if (this.dc && this.dc.isOpen()) {
      this.dc.sendMessage(JSON.stringify(obj));
    }
  }

  /** 通过信令服务器发送消息 */
  _sendSignal(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}

module.exports = { ClawClient };
