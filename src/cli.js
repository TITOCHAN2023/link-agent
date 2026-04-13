'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const { SignalingServer } = require('./server');
const { ClawClient } = require('./client');
const { ClawAgent } = require('./agent');
const { describe } = require('./permissions');

const program = new Command();
program.name('claw-link').description('P2P communication tool for OpenClaw instances').version('0.1.0');

/** Pick ClawAgent (--json) or ClawClient (interactive) */
function makeClient(opts, extra = {}) {
  const args = { signalingUrl: opts.signal, name: opts.name, permission: opts.perm, ...extra };
  return opts.json ? new ClawAgent(args) : new ClawClient(args);
}

// ── create ─────────────────────────────────────────────────
program
  .command('create')
  .description('Create a room and wait for a peer to join')
  .option('-s, --signal <url>', 'Signaling server URL', 'wss://ginfo.cc/signal/')
  .option('-n, --name <name>', 'Your Claw name', 'ClawA')
  .option('--perm <level>', 'Permission level: intimate | helper | chat', 'helper')
  .option('--json', 'Machine-readable JSON lines mode (for agents)')
  .action(async (opts) => {
    const client = makeClient(opts);

    if (!opts.json) {
      console.log(chalk.bold('\n🔗 claw-link — Create Room\n'));
      client.transport.on('room', (roomId) => {
        console.log(chalk.bold.cyan(`📌 Room ID: ${roomId}`));
        console.log(chalk.cyan(`   Peer command: ${chalk.white(`claw-link join ${roomId}`)}\n`));
      });
    }

    client.start();
    process.on('SIGINT', () => { client.transport.close(); process.exit(0); });
  });

// ── join ───────────────────────────────────────────────────
program
  .command('join <room-id>')
  .description('Join an existing room by room ID')
  .option('-s, --signal <url>', 'Signaling server URL', 'wss://ginfo.cc/signal/')
  .option('-n, --name <name>', 'Your Claw name', 'ClawB')
  .option('--perm <level>', 'Permission level: intimate | helper | chat', 'helper')
  .option('--json', 'Machine-readable JSON lines mode (for agents)')
  .action(async (roomId, opts) => {
    if (!opts.json) {
      console.log(chalk.bold('\n🔗 claw-link — Join Room\n'));
      console.log(chalk.gray(`Room: ${roomId} | Permission: ${opts.perm.toUpperCase()}\n`));
    }

    const client = makeClient(opts, { room: roomId });
    client.start();
    process.on('SIGINT', () => { client.transport.close(); process.exit(0); });
  });

// ── server (local dev) ─────────────────────────────────────
program
  .command('server')
  .description('Start a local signaling server (development)')
  .option('-p, --port <port>', 'Port', '8765')
  .option('-n, --name <name>', 'Your Claw name', 'ClawServer')
  .option('--perm <level>', 'Permission level', 'helper')
  .option('--json', 'Machine-readable JSON lines mode')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const srv = new SignalingServer({ port, onLog: opts.json ? () => {} : (m) => console.log(chalk.gray(`[Server] ${m}`)) });
    try { await srv.start(); } catch (e) {
      if (opts.json) { process.stdout.write(JSON.stringify({ event: 'error', message: e.message }) + '\n'); }
      else { console.error(chalk.red(e.message)); }
      process.exit(1);
    }

    if (!opts.json) console.log(chalk.cyan(`📡 Signaling on port ${port}\n`));

    const client = makeClient(opts, { signal: `ws://127.0.0.1:${port}` });
    if (!opts.json) {
      client.transport.on('room', (id) => {
        console.log(chalk.bold.cyan(`📌 Room: ${id}`));
        console.log(chalk.cyan(`   claw-link join ${id} -s ws://<IP>:${port}\n`));
      });
    }
    client.start();
    process.on('SIGINT', () => { srv.close(); process.exit(0); });
  });

// ── bridge (for serial / low-capability agents) ────────────
program
  .command('bridge')
  .description('Start HTTP bridge for serial agents (curl-compatible)')
  .option('-p, --port <port>', 'HTTP port', '7654')
  .option('-s, --signal <url>', 'Signaling server URL', 'wss://ginfo.cc/signal/')
  .option('-n, --name <name>', 'Your Claw name', 'Claw')
  .option('--perm <level>', 'Permission level', 'helper')
  .option('--on-connect <cmd>', 'Shell command on peer connect (use {peer})')
  .option('--on-message <cmd>', 'Shell command on message (use {from}, {type})')
  .option('--on-disconnect <cmd>', 'Shell command on disconnect (use {reason})')
  .action(async (opts) => {
    const { ClawBridge } = require('./bridge');
    const bridge = new ClawBridge({
      port: parseInt(opts.port, 10),
      signalingUrl: opts.signal,
      name: opts.name,
      permission: opts.perm,
      onConnect: opts.onConnect,
      onMessage: opts.onMessage,
      onDisconnect: opts.onDisconnect,
    });
    await bridge.start();
    console.log(JSON.stringify({ event: 'bridge-ready', port: parseInt(opts.port, 10) }));
    process.on('SIGINT', () => { bridge.stop(); process.exit(0); });
  });

// ── ping ───────────────────────────────────────────────────
program
  .command('ping <url>')
  .description('Test signaling server connectivity')
  .action(async (url) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { console.log(chalk.red('Timeout')); ws.close(); process.exit(1); }, 5000);
    ws.on('open', () => { console.log(chalk.green(`✅ ${url} reachable`)); clearTimeout(timer); ws.close(); process.exit(0); });
    ws.on('error', (e) => { clearTimeout(timer); console.log(chalk.red(`❌ ${e.message}`)); process.exit(1); });
  });

program.parse(process.argv);
