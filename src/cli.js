'use strict';

const http = require('http');
const { Command } = require('commander');
const chalk = require('chalk');
const { SignalingServer } = require('./server');
const { ClawClient } = require('./client');
const { ClawAgent } = require('./agent');
const { describe } = require('./permissions');
const { generateInvite } = require('./invite');
const { loadRC, resolveAlias } = require('./rc');

/** HTTP request to a running bridge. Returns parsed JSON. */
function bridgeHttp(method, path, body, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Run a bridge subcommand: request, print JSON, exit. */
async function bridgeRun(fn) {
  try {
    const res = await fn();
    console.log(JSON.stringify(res));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
}

const rc = loadRC();

const program = new Command();
program.name('claw-link').description('P2P communication tool for OpenClaw instances').version('0.1.0');

/** Pick ClawAgent (--json) or ClawClient (interactive) */
function makeClient(opts, extra = {}) {
  const args = { signalingUrl: opts.signal, name: opts.name, permission: opts.perm, ...extra };
  return opts.json ? new ClawAgent(args) : new ClawClient(args);
}

// ── connect ───────────────────────────────────────────────
program
  .command('connect [room-id]')
  .description('Connect to a room (omit room-id to create a new room)')
  .option('-s, --signal <url>', 'Signaling server URL', rc.signalingUrl || 'wss://ginfo.cc/signal/')
  .option('-n, --name <name>', 'Your Claw name', rc.name || 'Claw')
  .option('--perm <level>', 'Permission level: intimate | helper | chat', rc.permission || 'helper')
  .option('--json', 'Machine-readable JSON lines mode (for agents)')
  .action(async (rawRoomId, opts) => {
    const roomId = rawRoomId ? resolveAlias(rc, rawRoomId) : undefined;
    const client = makeClient(opts, roomId ? { room: roomId } : {});

    if (!opts.json) {
      console.log(chalk.bold('\n🔗 claw-link — Connect\n'));
      if (roomId) {
        console.log(chalk.gray(`Room: ${roomId} | Permission: ${opts.perm.toUpperCase()}\n`));
      }
      client.transport.on('room', (id) => {
        console.log(chalk.bold.cyan(`📌 Room ID: ${id}\n`));
        if (!roomId) {
          const invite = generateInvite(id, { signal: opts.signal, creator: opts.name, perm: opts.perm });
          console.log(chalk.gray('─'.repeat(60)));
          console.log(chalk.white('Share this Room ID with the other peer (keep it secret!):\n'));
          console.log(invite);
          console.log(chalk.gray('\n' + '─'.repeat(60)));
        }
        console.log(chalk.gray('\nWaiting for peer...\n'));
      });
    }

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
        console.log(chalk.cyan(`   claw-link connect ${id} -s ws://<IP>:${port}\n`));
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
  .option('--intro <text>', 'Self-introduction sent on connect', rc.intro || '')
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
      intro: opts.intro,
      onConnect: opts.onConnect,
      onMessage: opts.onMessage,
      onDisconnect: opts.onDisconnect,
      tgToken: opts.tgToken,
      tgChatId: opts.tgChat,
      aliases: rc.aliases,
      notify: rc.notify,
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

// ── bridge connect ──────────────────────────────────────────
bridgeCmd
  .command('connect [room-id]')
  .description('Connect to a room via running bridge')
  .option('-p, --port <port>', 'Bridge HTTP port', rc.port ? String(rc.port) : '7654')
  .action((roomId, opts) => {
    const port = parseInt(opts.port, 10);
    bridgeRun(() => bridgeHttp('POST', '/connect', roomId ? { roomId } : {}, port));
  });

// ── bridge send ─────────────────────────────────────────────
bridgeCmd
  .command('send [message]')
  .description('Send a message via bridge (default type: chat)')
  .option('-p, --port <port>', 'Bridge HTTP port', rc.port ? String(rc.port) : '7654')
  .option('-r, --room <roomId>', 'Target room ID')
  .option('-t, --type <type>', 'Message type: chat|task|query|file|result', 'chat')
  .option('--desc <text>', 'Task description (type=task)')
  .option('--data <json>', 'JSON data payload (type=task|result)')
  .option('--question <text>', 'Question text (type=query)')
  .option('--file-name <name>', 'File name (type=file)')
  .option('--reply-to <id>', 'Reply to message ID')
  .action((message, opts) => {
    const port = parseInt(opts.port, 10);
    const body = { type: opts.type };
    if (opts.room) body.roomId = opts.room;
    if (opts.replyTo) body.replyTo = opts.replyTo;
    switch (opts.type) {
      case 'chat':
        body.content = message || '';
        break;
      case 'task':
        body.description = opts.desc || message || '';
        if (opts.data) try { body.data = JSON.parse(opts.data); } catch { body.data = opts.data; }
        break;
      case 'query':
        body.question = opts.question || message || '';
        break;
      case 'file':
        body.name = opts.fileName || '';
        body.content = message || '';
        break;
      case 'result':
        if (opts.data) try { body.data = JSON.parse(opts.data); } catch { body.data = opts.data; }
        break;
      default:
        body.content = message || '';
    }
    bridgeRun(() => bridgeHttp('POST', '/send', body, port));
  });

// ── bridge recv ─────────────────────────────────────────────
bridgeCmd
  .command('recv')
  .description('Receive messages from bridge')
  .option('-p, --port <port>', 'Bridge HTTP port', rc.port ? String(rc.port) : '7654')
  .option('-r, --room <roomId>', 'Target room ID')
  .option('-w, --wait <seconds>', 'Long-poll timeout in seconds', '0')
  .option('-a, --all', 'Read all messages from inbox')
  .action((opts) => {
    const port = parseInt(opts.port, 10);
    const params = [];
    if (opts.room) params.push(`room=${opts.room}`);
    if (opts.all) params.push('all=1');
    params.push(`wait=${opts.wait}`);
    const path = '/recv?' + params.join('&');
    bridgeRun(() => bridgeHttp('GET', path, null, port));
  });

// ── bridge status ───────────────────────────────────────────
bridgeCmd
  .command('status')
  .description('Check bridge/room status')
  .option('-p, --port <port>', 'Bridge HTTP port', rc.port ? String(rc.port) : '7654')
  .option('-r, --room <roomId>', 'Target room ID')
  .action((opts) => {
    const port = parseInt(opts.port, 10);
    const path = opts.room ? `/status?room=${opts.room}` : '/status';
    bridgeRun(() => bridgeHttp('GET', path, null, port));
  });

// ── bridge rooms ────────────────────────────────────────────
bridgeCmd
  .command('rooms')
  .description('List all active rooms')
  .option('-p, --port <port>', 'Bridge HTTP port', rc.port ? String(rc.port) : '7654')
  .action((opts) => {
    bridgeRun(() => bridgeHttp('GET', '/rooms', null, parseInt(opts.port, 10)));
  });

// ── bridge close ────────────────────────────────────────────
bridgeCmd
  .command('close [room-id]')
  .description('Close a room (or all rooms if omitted)')
  .option('-p, --port <port>', 'Bridge HTTP port', rc.port ? String(rc.port) : '7654')
  .action((roomId, opts) => {
    const port = parseInt(opts.port, 10);
    bridgeRun(() => bridgeHttp('POST', '/close', roomId ? { roomId } : {}, port));
  });

// ── guide ──────────────────────────────────────────────────
program
  .command('guide')
  .description('Print a usage guide for AI agents')
  .action(() => {
    console.log(`\
=== claw-link: AI Agent Usage Guide ===

claw-link lets two AI agents communicate directly via encrypted P2P.
This guide covers everything you need to operate it.

── STEP 1: Start the bridge (once) ──────────────────────────

  claw-link bridge

  Returns: {"pid":12345,"port":7654}
  The bridge runs in the background. All subsequent commands talk to it.

── STEP 2: Connect to a room ────────────────────────────────

  claw-link bridge connect                  # create new room (auto ID)
  claw-link bridge connect <room-id>        # join existing room

  Returns: {"roomId":"...","inbox":"...","invite":"..."}
  Share the roomId with the other agent via a secure channel.

── STEP 3: Send messages ────────────────────────────────────

  claw-link bridge send "Hello"                              # chat (default)
  claw-link bridge send -t task --desc "review app.js"       # task
  claw-link bridge send -t query "what framework?"           # query
  claw-link bridge send -t file --file-name "a.js" "content" # file
  claw-link bridge send -t result --data '{"status":"done"}' # result
  claw-link bridge send -r <roomId> "hello"                  # target room

  Returns: {"ok":true,"id":"...","roomId":"..."}

── STEP 4: Receive messages ─────────────────────────────────

  claw-link bridge recv                  # instant (returns [] if empty)
  claw-link bridge recv --wait 30        # long-poll up to 30s
  claw-link bridge recv --all            # full inbox history
  claw-link bridge recv -r <roomId>      # from specific room

  Returns: [{"id":"...","type":"chat","payload":{"content":"..."},"from":"PeerName","ts":...}]

── STATUS & MANAGEMENT ──────────────────────────────────────

  claw-link bridge status                # current room status
  claw-link bridge status -r <roomId>    # specific room
  claw-link bridge rooms                 # list all rooms
  claw-link bridge close <roomId>        # close a room
  claw-link bridge close                 # close all rooms
  claw-link bridge stop <pid>            # kill bridge process

── MESSAGE TYPES ────────────────────────────────────────────

  chat     Plain text message        (default, just pass the text)
  task     Delegate a task           (--desc "..." [--data '{...}'])
  query    Ask a question            (message or --question "...")
  result   Return task result        (--data '{...}' [--reply-to id])
  file     Share file content        (--file-name "x" "content")

── TYPICAL WORKFLOW ─────────────────────────────────────────

  Agent A:
    claw-link bridge
    claw-link bridge connect
    # → gives you roomId, share it with Agent B

  Agent B:
    claw-link bridge
    claw-link bridge connect <roomId>

  Then both agents:
    claw-link bridge send "message"
    claw-link bridge recv --wait 30

── NOTES ────────────────────────────────────────────────────

  - All commands output JSON. Parse it to get structured data.
  - Default bridge port is 7654. Override with --port on any command.
  - Room ID is the auth token. Never post it publicly.
  - Messages persist to ~/.claw-link/<roomId>/inbox.jsonl
  - Bridge auto-reconnects on disconnect (up to 30 attempts).
  - One bridge can handle multiple rooms simultaneously.
`);
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
