'use strict';

const readline = require('readline');
const chalk = require('chalk');
const { AgentTransport } = require('./transport');
const { canPerform, isPrivate, describe } = require('./permissions');
const { SessionManager } = require('./session');
const proto = require('./protocol');

/** Strip ANSI escapes and control chars to prevent terminal injection. */
function sanitize(str) {
  if (typeof str !== 'string') return String(str);
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\x1b\[[0-9;]*[A-Za-z]/g, '');
}

class AgentClient {
  constructor({ signalingUrl, name = 'Claw', permission = 'helper', room }) {
    this.name = name;
    this.transport = new AgentTransport({ signalingUrl, name, permission, room });
    this.rl = null;
    this.sessionMgr = null;
  }

  async start() {
    const t = this.transport;

    t.on('log', (text) => console.log(chalk.gray(`[${text}]`)));
    t.on('connecting', () => console.log(chalk.gray('[Signaling] Connected.')));
    t.on('role', (role) => {
      console.log(chalk.gray(`[Signaling] Role: ${role.toUpperCase()}`));
    });

    t.on('connected', (peerName, permission) => {
      console.log(chalk.green('\n✅ P2P DataChannel established!'));
      console.log(chalk.cyan(`🔗 Connected to ${chalk.bold(sanitize(peerName))}`));
      console.log(chalk.cyan(`🔐 Permission: ${chalk.bold(permission.toUpperCase())} — ${describe(permission)}`));
      console.log(chalk.gray('Type a message and press Enter. Commands: /help\n'));
      this._initInteractive();
    });

    t.on('message', (msg) => this._handleMessage(msg));

    t.on('disconnected', (reason) => {
      console.log(chalk.red(`\n[Disconnected] ${reason}`));
      process.exit(0);
    });

    t.on('error', (err) => console.error(chalk.red(`[Error] ${err.message}`)));

    t.connect();
  }

  _initInteractive() {
    if (this.rl) return;
    this.sessionMgr = new SessionManager(
      this.name,
      (msg) => this.transport.send(msg),
      (text) => { console.log(chalk.yellow(`\n${text}`)); this.rl && this.rl.prompt(); },
    );
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.setPrompt(chalk.blue(`[${this.name}] > `));
    this.rl.prompt();

    this.rl.on('line', (line) => {
      const input = line.trim();
      if (!input) { this.rl.prompt(); return; }
      input.startsWith('/') ? this._handleCommand(input) : this._sendChat(input);
      this.rl.prompt();
    });

    this.rl.on('close', () => { this.transport.close(); process.exit(0); });
  }

  _handleMessage(msg) {
    const perm = this.transport.negotiatedPermission;

    // New protocol (has .id)
    if (msg.id && msg.type) {
      switch (msg.type) {
        case 'chat': {
          if (!canPerform(perm, 'chat')) return;
          if (perm === 'helper' && msg.payload && isPrivate(msg.payload.content)) {
            console.log(chalk.red(`\n[PRIVACY] Message from ${sanitize(msg.from)} redacted.`));
            break;
          }
          const t = new Date(msg.ts).toLocaleTimeString();
          console.log(`\n${chalk.green(`[${sanitize(msg.from)}]`)} ${chalk.gray(t)}: ${sanitize(msg.payload.content)}`);
          break;
        }
        case 'task':
          console.log(`\n${chalk.magenta(`[TASK from ${sanitize(msg.from)}]`)} ${sanitize(msg.payload.description)}`);
          break;
        case 'result':
          console.log(`\n${chalk.cyan(`[RESULT from ${sanitize(msg.from)}]`)} ${sanitize(typeof msg.payload.data === 'string' ? msg.payload.data : JSON.stringify(msg.payload.data))}`);
          break;
        case 'file':
          if (!canPerform(perm, 'file')) { console.log(chalk.red('\n[PERMISSION DENIED] Cannot receive files.')); break; }
          console.log(`\n${chalk.yellow(`[FILE from ${sanitize(msg.from)}]`)} ${sanitize(msg.payload.name)} (${msg.payload.content.length} chars)`);
          break;
        case 'query':
          console.log(`\n${chalk.blue(`[QUERY from ${sanitize(msg.from)}]`)} ${sanitize(msg.payload.question)}`);
          break;
        case 'session':
          if (!canPerform(perm, 'session')) { console.log(chalk.red('\n[PERMISSION DENIED]')); break; }
          this.sessionMgr && this.sessionMgr.handle({ from: msg.from, ts: msg.ts, content: msg.payload });
          break;
        case 'ack': break;
      }
      this.rl && this.rl.prompt();
      return;
    }

    // Legacy format
    if (msg.type === 'chat' && canPerform(perm, 'chat')) {
      console.log(`\n${chalk.green(`[${sanitize(msg.from)}]`)} ${sanitize(msg.content)}`);
    } else if (msg.type === 'session' && canPerform(perm, 'session')) {
      this.sessionMgr && this.sessionMgr.handle(msg);
    }
    this.rl && this.rl.prompt();
  }

  _handleCommand(input) {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0];
    const perm = this.transport.negotiatedPermission;

    switch (cmd) {
      case 'help':
        console.log(chalk.gray([
          '/session start <desc>  Start collaboration session',
          '/session accept        Accept session',
          '/session reject        Reject session',
          '/session end           End session',
          '/perm                  Show permission level',
          '/quit                  Exit',
        ].join('\n')));
        break;
      case 'session': {
        const sub = parts[1];
        if (!canPerform(perm, 'session')) { console.log(chalk.red('[PERMISSION DENIED]')); break; }
        try {
          if (sub === 'start') this.sessionMgr.create(parts.slice(2).join(' ') || 'Collaboration');
          else if (sub === 'accept') this.sessionMgr.accept();
          else if (sub === 'reject') this.sessionMgr.reject(parts.slice(2).join(' ') || 'Declined');
          else if (sub === 'end') this.sessionMgr.end();
          else console.log(chalk.red(`Unknown: /session ${sub}`));
        } catch (e) { console.log(chalk.red(e.message)); }
        break;
      }
      case 'perm':
        console.log(chalk.cyan(`Permission: ${perm.toUpperCase()} — ${describe(perm)}`));
        break;
      case 'quit':
        this.transport.close();
        process.exit(0);
        break;
      default:
        console.log(chalk.red(`Unknown: /${cmd}. Type /help`));
    }
  }

  _sendChat(text) {
    if (!canPerform(this.transport.negotiatedPermission, 'chat')) {
      console.log(chalk.red('[PERMISSION DENIED]'));
      return;
    }
    this.transport.send(proto.chat(text, this.name));
  }
}

module.exports = { AgentClient };
