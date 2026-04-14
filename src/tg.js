'use strict';

const https = require('https');

const API = 'https://api.telegram.org/bot';

/**
 * TelegramNotifier — push notifications + /kill command via TG bot.
 *
 * User configures bot token + chat ID. The bridge calls notify() on events.
 * A polling loop listens for /kill <roomId> commands.
 */
class TelegramNotifier {
  constructor({ token, chatId, onKill }) {
    this.token = token;
    this.chatId = chatId;
    this.onKill = onKill;   // (roomId) => void — called when user sends /kill
    this._offset = 0;
    this._polling = false;
    this._timer = null;
  }

  /** Start polling for commands */
  start() {
    this._polling = true;
    this._poll();
  }

  stop() {
    this._polling = false;
    if (this._timer) clearTimeout(this._timer);
  }

  /** Send a formatted notification to TG */
  async notify(event, data = {}) {
    const text = this._format(event, data);
    if (!text) return;
    await this._sendMessage(text);
  }

  // -- formatting ----------------------------------------------------------

  _format(event, d) {
    const room = d.roomId ? `[${d.roomId}]` : '';

    switch (event) {
      case 'connected':
        return `🔗 ${room} <b>${esc(d.peer)}</b> joined (${d.permission})`;

      case 'disconnected':
        return `❌ ${room} Peer left: ${esc(d.reason)}`;

      case 'reconnecting':
        return `🔄 ${room} Reconnecting (attempt ${d.attempt})...`;

      case 'message': {
        const from = esc(d.from || '?');
        switch (d.type) {
          case 'text':
            return `💬 ${room} <b>${from}</b>: ${esc(d.text || d.content || '')}`;
          case 'chat':
            return `💬 ${room} <b>${from}</b>: ${esc(d.content || '')}`;
          case 'task':
            return `📋 ${room} <b>${from}</b> task: ${esc(d.description || '')}`;
          case 'query':
            return `❓ ${room} <b>${from}</b>: ${esc(d.question || '')}`;
          case 'result':
            return `✅ ${room} <b>${from}</b> result: ${esc(truncate(JSON.stringify(d.data || {}), 200))}`;
          case 'file':
            return `📎 ${room} <b>${from}</b> sent file: ${esc(d.name || '?')}`;
          default:
            return `📨 ${room} <b>${from}</b> [${d.type}]`;
        }
      }

      case 'room':
        return `🏠 Room created: <code>${esc(d.roomId)}</code>`;

      case 'killed':
        return `🛑 Room <code>${esc(d.roomId)}</code> killed by user`;

      default:
        return null;
    }
  }

  // -- TG API --------------------------------------------------------------

  _sendMessage(text) {
    return this._api('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_notification: false,
    });
  }

  async _poll() {
    if (!this._polling) return;
    try {
      const updates = await this._api('getUpdates', {
        offset: this._offset,
        timeout: 30,
      });
      if (updates && updates.result) {
        for (const u of updates.result) {
          this._offset = u.update_id + 1;
          this._handleUpdate(u);
        }
      }
    } catch {}
    if (this._polling) {
      this._timer = setTimeout(() => this._poll(), 1000);
    }
  }

  _handleUpdate(update) {
    const msg = update.message;
    if (!msg || !msg.text) return;
    // Only accept commands from the configured chat
    if (String(msg.chat.id) !== String(this.chatId)) return;

    const text = msg.text.trim();

    if (text.startsWith('/kill')) {
      const parts = text.split(/\s+/);
      const roomId = parts[1];
      if (!roomId) {
        this._sendMessage('Usage: /kill &lt;roomId&gt;');
        return;
      }
      if (this.onKill) this.onKill(roomId);
      this._sendMessage(`🛑 Killing room <code>${esc(roomId)}</code>...`);
    }

    if (text.startsWith('/set')) {
      const parts = text.split(/\s+/);
      const roomId = parts[1];
      const level = parts[2];
      if (!roomId || !level || !['intimate', 'helper', 'chat'].includes(level)) {
        this._sendMessage('Usage: /set &lt;roomId&gt; &lt;intimate|helper|chat&gt;');
        return;
      }
      if (this.onSetPerm) this.onSetPerm(roomId, level);
      this._sendMessage(`🔐 Room <code>${esc(roomId)}</code> permission → <b>${esc(level)}</b>`);
    }

    if (text === '/status') {
      if (this.onStatus) this.onStatus();
    }

    if (text === '/rooms') {
      if (this.onRooms) this.onRooms();
    }
  }

  _api(method, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request(`${API}${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        let b = '';
        res.on('data', (c) => b += c);
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch { resolve(null); }
        });
      });
      req.on('error', reject);
      req.end(data);
    });
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

module.exports = { TelegramNotifier };
