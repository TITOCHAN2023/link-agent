'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Unified notification adapter.
 *
 * Config (from .clawlinkrc → "notify"):
 *   { type: "webhook", url: "http://...", headers?: {} }
 *   { type: "file",    dir: "/tmp/clawlink-notify" }
 *   { type: "shell",   command: "echo {from}:{content}" }
 *   { type: "stdout" }
 *
 * All adapters receive the same payload:
 *   { event, roomId, from, type, id, content, description, question, ... }
 */

class Notifier {
  constructor(config) {
    if (!config || !config.type) {
      this._adapter = null;
      return;
    }
    switch (config.type) {
      case 'webhook': this._adapter = new WebhookAdapter(config); break;
      case 'file':    this._adapter = new FileAdapter(config); break;
      case 'shell':   this._adapter = new ShellAdapter(config); break;
      case 'stdout':  this._adapter = new StdoutAdapter(config); break;
      default:        this._adapter = null;
    }
  }

  /** Fire a notification. Never throws. */
  notify(event, data) {
    if (!this._adapter) return;
    try { this._adapter.send({ event, ts: Date.now(), ...data }); }
    catch { /* swallow */ }
  }
}

// -- Adapters ----------------------------------------------------------------

class WebhookAdapter {
  constructor({ url, headers = {} }) {
    this._url = new URL(url);
    this._headers = { 'Content-Type': 'application/json', ...headers };
  }

  send(payload) {
    const body = JSON.stringify(payload);
    const mod = this._url.protocol === 'https:' ? https : http;
    const req = mod.request(this._url, {
      method: 'POST',
      headers: { ...this._headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  }
}

class FileAdapter {
  constructor({ dir }) {
    this._dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  send(payload) {
    const name = `${payload.ts || Date.now()}_${payload.event || 'msg'}.json`;
    fs.writeFileSync(path.join(this._dir, name), JSON.stringify(payload, null, 2) + '\n');
  }
}

/** Escape a value for safe interpolation into a shell command. */
function shellEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

class ShellAdapter {
  constructor({ command }) {
    this._cmd = command;
  }

  send(payload) {
    let expanded = this._cmd;
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' || typeof v === 'number') {
        expanded = expanded.replace(new RegExp(`\\{${k}\\}`, 'g'), shellEscape(v));
      }
    }
    execFile('/bin/sh', ['-c', expanded], { timeout: 10000 }, () => {});
  }
}

class StdoutAdapter {
  send(payload) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  }
}

module.exports = { Notifier };
