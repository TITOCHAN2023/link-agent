'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const { SignalingServer } = require('./server');
const { ClawClient } = require('./client');
const { ClawAgent } = require('./agent');
const { describe } = require('./permissions');
const { generateInvite } = require('./invite');
const { loadRC, resolveAlias } = require('./rc');

const rc = loadRC();

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
  .option('-r, --room <id>', 'Custom room ID (default: server-generated)')
  .option('-s, --signal <url>', 'Signaling server URL', rc.signalingUrl || 'wss://ginfo.cc/signal/')
  .option('-n, --name <name>', 'Your Claw name', rc.name || 'ClawA')
  .option('--perm <level>', 'Permission level: intimate | helper | chat', rc.permission || 'helper')
  .option('--json', 'Machine-readable JSON lines mode (for agents)')
  .action(async (opts) => {
    const roomId = resolveAlias(rc, opts.room) || opts.room;
    const client = makeClient(opts, roomId ? { room: roomId } : {});

    if (!opts.json) {
      console.log(chalk.bold('\n🔗 claw-link — Create Room\n'));
      client.transport.on('room', (roomId) => {
        console.log(chalk.bold.cyan(`📌 Room ID: ${roomId}\n`));
        const invite = generateInvite(roomId, { signal: opts.signal, creator: opts.name, perm: opts.perm });
        console.log(chalk.gray('─'.repeat(60)));
        console.log(chalk.white('Copy the following invite and send it to the other peer:\n'));
        console.log(invite);
        console.log(chalk.gray('\n' + '─'.repeat(60)));
        console.log(chalk.gray('\nWaiting for peer to join...\n'));
      });
    }

    client.start();
    process.on('SIGINT', () => { client.transport.close(); process.exit(0); });
  });

// ── join ───────────────────────────────────────────────────
program
  .command('join <room-id>')
  .description('Join an existing room by room ID')
  .option('-s, --signal <url>', 'Signaling server URL', rc.signalingUrl || 'wss://ginfo.cc/signal/')
  .option('-n, --name <name>', 'Your Claw name', rc.name || 'ClawB')
  .option('--perm <level>', 'Permission level: intimate | helper | chat', rc.permission || 'helper')
  .option('--json', 'Machine-readable JSON lines mode (for agents)')
  .action(async (rawRoomId, opts) => {
    const roomId = resolveAlias(rc, rawRoomId);
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
// Default: daemon mode — fork to background, print pid+port, exit immediately.
// Agent runs this once, gets JSON back, command finishes, agent continues with curl.
const bridgeCmd = program
  .command('bridge')
  .description('Start HTTP bridge for serial agents (auto-daemonizes)')
  .option('-p, --port <port>', 'HTTP port', rc.port ? String(rc.port) : '7654')
  .option('-s, --signal <url>', 'Signaling server URL', rc.signalingUrl || 'wss://ginfo.cc/signal/')
  .option('-n, --name <name>', 'Your Claw name', rc.name || 'Claw')
  .option('--perm <level>', 'Permission level', rc.permission || 'helper')
  .option('--data-dir <path>', 'Directory for inbox/events files', rc.dataDir || '')
  .option('--on-connect <cmd>', 'Shell command on peer connect', rc.hooks?.onConnect || '')
  .option('--on-message <cmd>', 'Shell command on message', rc.hooks?.onMessage || '')
  .option('--on-disconnect <cmd>', 'Shell command on disconnect', rc.hooks?.onDisconnect || '')
  .option('--tg-token <token>', 'Telegram bot token for notifications', rc.tgToken || '')
  .option('--tg-chat <id>', 'Telegram chat ID for notifications', rc.tgChatId || '')
  .option('--foreground', 'Run in foreground (don\'t daemonize)')
  .option('--daemon-child', '(internal) actual bridge process')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const bridgeOpts = {
      port,
      signalingUrl: opts.signal,
      name: opts.name,
      permission: opts.perm,
      dataDir: opts.dataDir || undefined,
      onConnect: opts.onConnect,
      onMessage: opts.onMessage,
      onDisconnect: opts.onDisconnect,
      tgToken: opts.tgToken,
      tgChatId: opts.tgChat,
      aliases: rc.aliases,
    };

    // ── If this is the daemon child, run the bridge ──
    if (opts.daemonChild) {
      const { ClawBridge } = require('./bridge');
      const bridge = new ClawBridge(bridgeOpts);
      await bridge.start();
      // Tell parent we're ready
      if (process.send) process.send({ ready: true, port, pid: process.pid });
      process.on('SIGINT', () => { bridge.stop(); process.exit(0); });
      process.on('SIGTERM', () => { bridge.stop(); process.exit(0); });
      return;
    }

    // ── Foreground mode ──
    if (opts.foreground) {
      const { ClawBridge } = require('./bridge');
      const bridge = new ClawBridge(bridgeOpts);
      await bridge.start();
      console.log(JSON.stringify({ pid: process.pid, port }));
      process.on('SIGINT', () => { bridge.stop(); process.exit(0); });
      return;
    }

    // ── Daemon mode: fork child, wait for ready, print result, exit ──
    const { fork } = require('child_process');
    const args = process.argv.slice(2).concat('--daemon-child');
    const child = fork(process.argv[1], args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    child.on('message', (msg) => {
      if (msg.ready) {
        console.log(JSON.stringify({ pid: child.pid, port: msg.port }));
        child.unref();
        child.disconnect();
        process.exit(0);
      }
    });

    child.on('error', (err) => {
      console.log(JSON.stringify({ error: err.message }));
      process.exit(1);
    });

    // Timeout: if child doesn't report ready in 5s, give up
    setTimeout(() => {
      console.log(JSON.stringify({ error: 'Bridge startup timeout' }));
      child.kill();
      process.exit(1);
    }, 5000);
  });

// ── bridge stop ─────────────────────────────────────────────
bridgeCmd
  .command('stop')
  .description('Stop a running bridge by PID or port')
  .argument('[pid]', 'PID of bridge process')
  .option('--kill-port <port>', 'Find by port instead of PID')
  .action(async (pid, opts) => {
    if (pid) {
      try { process.kill(parseInt(pid, 10), 'SIGTERM'); console.log(JSON.stringify({ stopped: true, pid: parseInt(pid, 10) })); }
      catch (e) { console.log(JSON.stringify({ error: e.message })); }
    } else if (opts.killPort) {
      const { execSync } = require('child_process');
      try {
        const out = execSync(`lsof -ti tcp:${opts.killPort}`, { encoding: 'utf8' }).trim();
        const pids = out.split('\n').map(Number).filter(Boolean);
        for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch {} }
        console.log(JSON.stringify({ stopped: true, pids }));
      } catch { console.log(JSON.stringify({ error: `No process on port ${opts.killPort}` })); }
    } else {
      console.log(JSON.stringify({ error: 'Provide PID or --kill-port' }));
    }
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
