'use strict';

const readline = require('readline');
const chalk = require('chalk');
const { ClawTransport } = require('./transport');
const { canPerform, isPrivate, describe } = require('./permissions');
const { SessionManager } = require('./session');
const proto = require('./protocol');

// ============================================================
// ClawClient — CLI wrapper over ClawTransport
//
// This is the human-facing terminal UI.
// Agents should use ClawTransport directly.
// ============================================================

class ClawClient {
  constructor({ signalingUrl, name = 'Claw', permission = 'helper' }) {
    this.name = name;

    this.transport = new ClawTransport({ signalingUrl, name, permission });
    this.rl = null;
    this.sessionMgr = null;
  }

  async start() {
    const t = this.transport;

    t.on('log', (text) => console.log(chalk.gray(`[${text}]`)));

    t.on('connecting', () => {
      console.log(chalk.gray('[Signaling] Connected. Waiting for role assignment...'));
    });

    t.on('role', (role) => {
      console.log(chalk.gray(`[Signaling] Assigned role: ${role.toUpperCase()}`));
      if (role === 'offerer') {
        console.log(chalk.gray('[Signaling] Waiting for peer before creating offer...'));
      }
    });

    t.on('connected', (peerName, permission) => {
      console.log(chalk.green('\n✅ P2P DataChannel established!'));
      console.log(chalk.cyan(`\n🔗 Connected to ${chalk.bold(peerName)}`));
      console.log(chalk.cyan(`🔐 Permission level: ${chalk.bold(permission.toUpperCase())} — ${describe(permission)}`));
      console.log(chalk.gray('Type a message and press Enter. Commands: /help\n'));
      this._initInteractive();
    });

    t.on('message', (msg) => this._handleMessage(msg));

    t.on('disconnected', (reason) => {
      if (reason === 'peer-left') {
        console.log(chalk.yellow('\n[P2P] Peer disconnected.'));
      } else if (reason === 'datachannel-closed') {
        console.log(chalk.red('\n[P2P] DataChannel closed.'));
      } else {
        console.log(chalk.red(`\n[Connection] Lost: ${reason}`));
      }
      process.exit(0);
    });

    t.on('error', (err) => {
      console.error(chalk.red(`[Error] ${err.message}`));
    });

    t.connect();
  }

  // -- interactive shell ----------------------------------------------------

  _initInteractive() {
    if (this.rl) return;

    this.sessionMgr = new SessionManager(
      this.name,
      (msg) => this.transport.send(msg),
      (text) => {
        console.log(chalk.yellow(`\n${text}`));
        this.rl && this.rl.prompt();
      },
    );

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
      this.transport.close();
      process.exit(0);
    });
  }

  // -- inbound messages -----------------------------------------------------

  _handleMessage(msg) {
    const perm = this.transport.negotiatedPermission;

    // New protocol (has .id field)
    if (msg.id && msg.type) {
      this._handleProtoMessage(msg, perm);
      return;
    }

    // Legacy format (v0.1.0 compat)
    switch (msg.type) {
      case 'chat': {
        if (!canPerform(perm, 'chat')) return;
        if (perm === 'helper' && isPrivate(msg.content)) {
          console.log(chalk.red(`\n[PRIVACY] Message from ${msg.from} contains private data and was redacted.`));
          this.rl && this.rl.prompt();
          return;
        }
        const time = new Date(msg.ts).toLocaleTimeString();
        console.log(`\n${chalk.green(`[${msg.from}]`)} ${chalk.gray(time)}: ${msg.content}`);
        this.rl && this.rl.prompt();
        break;
      }
      case 'session': {
        if (!canPerform(perm, 'session')) {
          console.log(chalk.red(`\n[PERMISSION DENIED] Permission '${perm}' does not allow session operations.`));
          this.rl && this.rl.prompt();
          return;
        }
        this.sessionMgr && this.sessionMgr.handle(msg);
        this.rl && this.rl.prompt();
        break;
      }
    }
  }

  _handleProtoMessage(msg, perm) {
    switch (msg.type) {
      case proto.MSG.CHAT: {
        if (!canPerform(perm, 'chat')) return;
        if (perm === 'helper' && msg.payload && isPrivate(msg.payload.content)) {
          console.log(chalk.red(`\n[PRIVACY] Message from ${msg.from} redacted.`));
          this.rl && this.rl.prompt();
          return;
        }
        const time = new Date(msg.ts).toLocaleTimeString();
        const content = msg.payload ? msg.payload.content : '';
        console.log(`\n${chalk.green(`[${msg.from}]`)} ${chalk.gray(time)}: ${content}`);
        this.rl && this.rl.prompt();
        break;
      }
      case proto.MSG.TASK: {
        const time = new Date(msg.ts).toLocaleTimeString();
        console.log(`\n${chalk.magenta(`[TASK from ${msg.from}]`)} ${chalk.gray(time)}: ${msg.payload.description}`);
        if (msg.payload.data) {
          console.log(chalk.gray(JSON.stringify(msg.payload.data, null, 2)));
        }
        this.rl && this.rl.prompt();
        break;
      }
      case proto.MSG.RESULT: {
        const time = new Date(msg.ts).toLocaleTimeString();
        console.log(`\n${chalk.cyan(`[RESULT from ${msg.from}]`)} ${chalk.gray(time)}:`);
        console.log(typeof msg.payload.data === 'string' ? msg.payload.data : JSON.stringify(msg.payload.data, null, 2));
        this.rl && this.rl.prompt();
        break;
      }
      case proto.MSG.FILE: {
        if (!canPerform(perm, 'file')) {
          console.log(chalk.red(`\n[PERMISSION DENIED] Cannot receive files at permission '${perm}'.`));
          this.rl && this.rl.prompt();
          return;
        }
        console.log(`\n${chalk.yellow(`[FILE from ${msg.from}]`)} ${msg.payload.name} (${msg.payload.content.length} chars)`);
        this.rl && this.rl.prompt();
        break;
      }
      case proto.MSG.QUERY: {
        console.log(`\n${chalk.blue(`[QUERY from ${msg.from}]`)} ${msg.payload.question}`);
        this.rl && this.rl.prompt();
        break;
      }
      case proto.MSG.SESSION: {
        if (!canPerform(perm, 'session')) {
          console.log(chalk.red(`\n[PERMISSION DENIED] Permission '${perm}' does not allow session operations.`));
          this.rl && this.rl.prompt();
          return;
        }
        // Wrap in legacy format for SessionManager compat
        this.sessionMgr && this.sessionMgr.handle({
          from: msg.from,
          ts: msg.ts,
          content: msg.payload,
        });
        this.rl && this.rl.prompt();
        break;
      }
      case proto.MSG.ACK:
        // Silent in CLI mode
        break;
    }
  }

  // -- commands -------------------------------------------------------------

  _handleCommand(input) {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case 'help':
        console.log(chalk.gray(`
Commands:
  /session start <description>  Start a collaboration session
  /session accept               Accept a pending session invitation
  /session reject [reason]      Reject a pending session invitation
  /session end                  End the current session
  /perm                         Show current permission level
  /quit                         Exit claw-link
        `.trim()));
        break;

      case 'session': {
        const perm = this.transport.negotiatedPermission;
        const sub = parts[1];
        if (!sub) { console.log(chalk.red('Usage: /session <start|accept|reject|end>')); break; }
        if (!canPerform(perm, 'session')) {
          console.log(chalk.red(`[PERMISSION DENIED] Permission '${perm}' does not allow session operations.`));
          break;
        }
        try {
          if (sub === 'start') {
            this.sessionMgr.create(parts.slice(2).join(' ') || 'Collaboration');
          } else if (sub === 'accept') {
            this.sessionMgr.accept();
          } else if (sub === 'reject') {
            this.sessionMgr.reject(parts.slice(2).join(' ') || 'Declined');
          } else if (sub === 'end') {
            this.sessionMgr.end();
          } else {
            console.log(chalk.red(`Unknown: /session ${sub}`));
          }
        } catch (e) {
          console.log(chalk.red(`[Session Error] ${e.message}`));
        }
        break;
      }

      case 'perm': {
        const perm = this.transport.negotiatedPermission;
        console.log(chalk.cyan(`Permission: ${perm.toUpperCase()} — ${describe(perm)}`));
        break;
      }

      case 'quit':
        console.log(chalk.gray('Closing connection...'));
        this.transport.close();
        process.exit(0);
        break;

      default:
        console.log(chalk.red(`Unknown command: /${cmd}. Type /help for help.`));
    }
  }

  _sendChat(text) {
    const perm = this.transport.negotiatedPermission;
    if (!canPerform(perm, 'chat')) {
      console.log(chalk.red('[PERMISSION DENIED] Cannot send chat messages.'));
      return;
    }
    // Send in new protocol format
    this.transport.send(proto.chat(text, this.name));
  }
}

module.exports = { ClawClient };
