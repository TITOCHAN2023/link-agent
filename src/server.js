'use strict';

const { WebSocketServer } = require('ws');

// ============================================================
// 信令服务器 (Signaling Server)
//
// 职责：
//   1. 管理"房间"，每个房间最多两个 peer（offerer + answerer）
//   2. 转发 SDP offer/answer 和 ICE candidates
//   3. P2P DataChannel 建立后，信令使命完成
//
// 消息协议：
//   { type: "offer" | "answer" | "ice" | "ready" | "peer-joined" | "peer-left" | "error", payload: ... }
// ============================================================

class SignalingServer {
  /**
   * @param {object}   opts
   * @param {number}   opts.port     监听端口
   * @param {Function} opts.onLog    日志回调 (msg: string) => void
   */
  constructor({ port = 8765, onLog = console.log } = {}) {
    this.port = port;
    this.log = onLog;

    // 房间只有一个（简单场景），存两个 ws 连接
    this.peers = [];     // [ws, ws]  —— 最多两个
    this.wss = null;
  }

  /** 启动信令服务器 */
  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port }, () => {
        this.log(`Signaling server listening on ws://0.0.0.0:${this.port}`);
        resolve(this.wss);
      });

      this.wss.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.log(`Error: Port ${this.port} is already in use.`);
        } else {
          this.log(`Server error: ${err.message}`);
        }
        reject(err);
      });

      this.wss.on('connection', (ws, req) => {
        this._handleConnection(ws, req);
      });
    });
  }

  /** 处理新的 WebSocket 连接 */
  _handleConnection(ws, req) {
    const addr = req.socket.remoteAddress;

    // 房间已满
    if (this.peers.length >= 2) {
      this._send(ws, { type: 'error', payload: 'Room is full. Only 2 peers allowed.' });
      ws.close();
      this.log(`Rejected connection from ${addr}: room full`);
      return;
    }

    this.peers.push(ws);
    const peerIndex = this.peers.length; // 1 或 2
    this.log(`Peer #${peerIndex} connected from ${addr}`);

    if (peerIndex === 1) {
      // 第一个 peer → offerer，等待第二个
      this._send(ws, { type: 'ready', payload: { role: 'offerer', message: 'Waiting for peer to join...' } });
    } else {
      // 第二个 peer → answerer
      this._send(ws, { type: 'ready', payload: { role: 'answerer', message: 'Peer found! Starting handshake...' } });
      // 通知 offerer 对方已到
      const offerer = this.peers[0];
      if (offerer && offerer.readyState === 1) {
        this._send(offerer, { type: 'peer-joined', payload: {} });
      }
    }

    // ---- 消息转发 ----
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        this._send(ws, { type: 'error', payload: 'Invalid JSON' });
        return;
      }

      // 只转发 offer / answer / ice 消息给对方
      if (['offer', 'answer', 'ice'].includes(msg.type)) {
        const other = this.peers.find((p) => p !== ws);
        if (other && other.readyState === 1) {
          other.send(JSON.stringify(msg));
        }
      }
    });

    // ---- 断开处理 ----
    ws.on('close', () => {
      this.log(`Peer #${peerIndex} disconnected`);
      this.peers = this.peers.filter((p) => p !== ws);

      // 通知剩余 peer
      for (const p of this.peers) {
        if (p.readyState === 1) {
          this._send(p, { type: 'peer-left', payload: {} });
        }
      }
    });

    ws.on('error', (err) => {
      this.log(`Peer #${peerIndex} error: ${err.message}`);
    });
  }

  /** 安全发送 JSON */
  _send(ws, obj) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    }
  }

  /** 关闭服务器 */
  close() {
    if (this.wss) {
      for (const p of this.peers) {
        p.close();
      }
      this.wss.close();
      this.log('Signaling server stopped.');
    }
  }
}

module.exports = { SignalingServer };
