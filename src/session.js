'use strict';

const crypto = require('crypto');

// ============================================================
// Session — 表示一次协作会话
// ============================================================

const SessionState = {
  PENDING: 'pending',     // 等待对方接受
  ACTIVE: 'active',       // 进行中
  ENDED: 'ended',         // 已结束
  REJECTED: 'rejected',   // 被拒绝
};

class Session {
  /**
   * @param {string} id          唯一标识
   * @param {string} initiator   发起方名称
   * @param {string} description 协作描述
   */
  constructor(id, initiator, description) {
    this.id = id;
    this.initiator = initiator;
    this.description = description;
    this.state = SessionState.PENDING;
    this.createdAt = Date.now();
    this.acceptedAt = null;
    this.endedAt = null;
    this.rejectReason = null;
  }

  /** 接受 session */
  accept() {
    if (this.state !== SessionState.PENDING) {
      throw new Error(`Cannot accept session in state: ${this.state}`);
    }
    this.state = SessionState.ACTIVE;
    this.acceptedAt = Date.now();
  }

  /** 拒绝 session */
  reject(reason = 'No reason provided') {
    if (this.state !== SessionState.PENDING) {
      throw new Error(`Cannot reject session in state: ${this.state}`);
    }
    this.state = SessionState.REJECTED;
    this.rejectReason = reason;
    this.endedAt = Date.now();
  }

  /** 结束 session */
  end() {
    if (this.state !== SessionState.ACTIVE && this.state !== SessionState.PENDING) {
      throw new Error(`Cannot end session in state: ${this.state}`);
    }
    this.state = SessionState.ENDED;
    this.endedAt = Date.now();
  }

  /** 序列化 */
  toJSON() {
    return {
      id: this.id,
      initiator: this.initiator,
      description: this.description,
      state: this.state,
      createdAt: this.createdAt,
      acceptedAt: this.acceptedAt,
      endedAt: this.endedAt,
      rejectReason: this.rejectReason,
    };
  }
}

// ============================================================
// SessionManager — 管理当前 session 生命周期
// ============================================================

class SessionManager {
  /**
   * @param {string}   localName  本端名称（如 "ClawA"）
   * @param {Function} sendFn     发送消息的回调 (msg: object) => void
   * @param {Function} printFn    打印到终端的回调 (text: string) => void
   */
  constructor(localName, sendFn, printFn) {
    this.localName = localName;
    this.sendFn = sendFn;
    this.printFn = printFn;
    this.current = null;   // 当前 Session 实例
  }

  /**
   * 本地发起一个新 session
   * @param {string} description 协作描述
   * @returns {Session}
   */
  create(description) {
    if (this.current && (this.current.state === SessionState.PENDING || this.current.state === SessionState.ACTIVE)) {
      throw new Error('A session is already active or pending. End it first with /session end');
    }

    const id = crypto.randomBytes(4).toString('hex');
    this.current = new Session(id, this.localName, description);

    // 通知对端
    this.sendFn({
      type: 'session',
      from: this.localName,
      ts: Date.now(),
      content: {
        action: 'start',
        sessionId: id,
        description,
      },
    });

    this.printFn(`[Session] You started session "${description}" (${id}). Waiting for peer to accept...`);
    return this.current;
  }

  /**
   * 处理从对端收到的 session 消息
   * @param {object} msg  完整消息对象
   */
  handle(msg) {
    const { action, sessionId, description, reason } = msg.content;

    switch (action) {
      // ---- 对端发起 session ----
      case 'start': {
        if (this.current && (this.current.state === SessionState.PENDING || this.current.state === SessionState.ACTIVE)) {
          // 已有活跃 session，自动拒绝
          this.sendFn({
            type: 'session',
            from: this.localName,
            ts: Date.now(),
            content: { action: 'reject', sessionId, reason: 'Already in a session' },
          });
          this.printFn(`[Session] Auto-rejected session "${description}" from ${msg.from} (already in a session).`);
          return;
        }
        this.current = new Session(sessionId, msg.from, description);
        this.printFn(`[Session] ${msg.from} wants to start session: "${description}" (${sessionId})`);
        this.printFn(`[Session] Use /session accept or /session reject to respond.`);
        break;
      }

      // ---- 对端接受 ----
      case 'accept': {
        if (!this.current || this.current.id !== sessionId) return;
        this.current.accept();
        this.printFn(`[Session] ${msg.from} accepted the session! Collaboration is now active.`);
        break;
      }

      // ---- 对端拒绝 ----
      case 'reject': {
        if (!this.current || this.current.id !== sessionId) return;
        this.current.reject(reason || 'Peer rejected');
        this.printFn(`[Session] ${msg.from} rejected the session. Reason: ${reason || 'none'}`);
        this.current = null;
        break;
      }

      // ---- 对端结束 ----
      case 'end': {
        if (!this.current || this.current.id !== sessionId) return;
        this.current.end();
        this.printFn(`[Session] ${msg.from} ended the session.`);
        this.current = null;
        break;
      }

      default:
        this.printFn(`[Session] Unknown session action: ${action}`);
    }
  }

  /** 本地接受当前 pending session */
  accept() {
    if (!this.current || this.current.state !== SessionState.PENDING) {
      throw new Error('No pending session to accept.');
    }
    this.current.accept();
    this.sendFn({
      type: 'session',
      from: this.localName,
      ts: Date.now(),
      content: { action: 'accept', sessionId: this.current.id },
    });
    this.printFn(`[Session] You accepted the session. Collaboration is now active!`);
  }

  /** 本地拒绝当前 pending session */
  reject(reason = 'Declined') {
    if (!this.current || this.current.state !== SessionState.PENDING) {
      throw new Error('No pending session to reject.');
    }
    const id = this.current.id;
    this.current.reject(reason);
    this.sendFn({
      type: 'session',
      from: this.localName,
      ts: Date.now(),
      content: { action: 'reject', sessionId: id, reason },
    });
    this.printFn(`[Session] You rejected the session.`);
    this.current = null;
  }

  /** 本地结束当前 session */
  end() {
    if (!this.current || (this.current.state !== SessionState.ACTIVE && this.current.state !== SessionState.PENDING)) {
      throw new Error('No active session to end.');
    }
    const id = this.current.id;
    this.current.end();
    this.sendFn({
      type: 'session',
      from: this.localName,
      ts: Date.now(),
      content: { action: 'end', sessionId: id },
    });
    this.printFn(`[Session] You ended the session.`);
    this.current = null;
  }
}

module.exports = { Session, SessionManager, SessionState };
