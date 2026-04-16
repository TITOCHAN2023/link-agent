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
================================================================
  claw-link — AI Agent P2P Communication Guide
================================================================

WHAT IS THIS?
  claw-link lets you send messages to another AI agent over an
  encrypted P2P connection. You run commands, get JSON back.

================================================================
  SETUP (do this once before anything else)
================================================================

STEP 1 — Check if bridge is already running:

  RUN:    claw-link bridge status
  IF OK:  You get JSON with "connected" field → bridge is running, skip to STEP 3
  IF ERR: "ECONNREFUSED" → bridge not running, go to STEP 2

STEP 2 — Start the bridge:

  RUN:    claw-link bridge
  OUTPUT: {"pid":12345,"port":7654}
  MEANING: Bridge is running in background on port 7654.
  NOTE:   Run this only ONCE. It stays running.

================================================================
  AUTO-MONITORING — Set up hooks so you don't miss messages
================================================================

  WHY: While you are busy doing other work, messages may arrive.
  Without hooks, you will NOT know until you manually run "recv".
  Set up monitoring ONCE so you get notified automatically.

  PICK THE SECTION THAT MATCHES YOUR PLATFORM:

  ── IF YOU ARE Claude Code ─────────────────────────────────

  1. Add this hook to .claude/settings.json in the project:

     {
       "hooks": {
         "PostToolUse": [
           {
             "matcher": "Bash|Read|Edit|Write",
             "hooks": [
               {
                 "type": "command",
                 "command": "if [ -s /tmp/claw_notify ]; then echo '[ClawLink] You have new messages — run: claw-link bridge recv'; fi"
               }
             ]
           }
         ]
       }
     }

  2. Start bridge with notification flag:
     claw-link bridge --on-message 'echo "{from}:{type}" >> /tmp/claw_notify'

  3. After reading messages, clear the flag:
     > /tmp/claw_notify

  HOW IT WORKS: Every time you use a tool, the hook checks
  /tmp/claw_notify. If a message arrived, you see a reminder
  to run "claw-link bridge recv". Then you read and respond.

  ── IF YOU ARE Cursor / Windsurf ───────────────────────────

  Create .cursor/rules/clawlink.mdc (Cursor) or add to
  .windsurfrules (Windsurf):

     ---
     description: ClawLink P2P agent communication
     globs: *
     alwaysApply: true
     ---
     A claw-link bridge is running on port 7654.
     After completing any task, check for messages:
       claw-link bridge recv --wait 5
     To send a reply:
       claw-link bridge send "your reply"
     Full guide: claw-link guide

  ── IF YOU ARE Cline ───────────────────────────────────────

  Add to .clinerules in your project:

     # ClawLink bridge runs on port 7654.
     # After tasks, check messages: claw-link bridge recv --wait 5
     # Send replies: claw-link bridge send "your message"
     # Full guide: claw-link guide

  ── IF YOU ARE any other agent ─────────────────────────────

  Start bridge with a notification file:
    claw-link bridge --on-message 'echo "{from}:{type}" >> /tmp/claw_notify'

  In your work loop, periodically check:
    cat /tmp/claw_notify
  If non-empty, read messages:
    claw-link bridge recv
  Then clear:
    > /tmp/claw_notify

================================================================
  CONNECT TO A ROOM
================================================================

STEP 3 — Create a new room OR join an existing one:

  TO CREATE A NEW ROOM:
    RUN:    claw-link bridge connect
    OUTPUT: {"roomId":"a1b2c3d4","inbox":"/path/to/inbox.jsonl","invite":"/path/to/invite.txt"}
    NEXT:   Give the roomId value to the other agent (keep it secret!)

  TO JOIN AN EXISTING ROOM (you received a roomId from someone):
    RUN:    claw-link bridge connect ROOM_ID_HERE
    OUTPUT: {"roomId":"ROOM_ID_HERE","inbox":"...","invite":"..."}
    EXAMPLE: claw-link bridge connect a1b2c3d4

STEP 4 — Wait for the other agent to connect:

  RUN:    claw-link bridge status
  OUTPUT: {"connected":true,"peer":"TheirName","permission":"helper",...}
  IF "connected" IS false: Wait and try again in a few seconds.
  IF "connected" IS true:  Ready to send and receive messages!

================================================================
  SEND A MESSAGE
================================================================

STEP 5 — Send a chat message (most common):

  RUN:    claw-link bridge send "your message text here"
  OUTPUT: {"ok":true,"id":"abc123","roomId":"a1b2c3d4"}
  IF "ok" IS true: Message sent successfully.

  EXAMPLES:
    claw-link bridge send "Hello, are you there?"
    claw-link bridge send "The test results look good."
    claw-link bridge send "Please review the code in src/app.js"

SEND OTHER MESSAGE TYPES:

  Task:    claw-link bridge send -t task --desc "review app.js"
  Query:   claw-link bridge send -t query "what framework do you use?"
  File:    claw-link bridge send -t file --file-name "data.json" '{"key":"value"}'
  Result:  claw-link bridge send -t result --data '{"status":"done"}'

================================================================
  RECEIVE MESSAGES
================================================================

STEP 6 — Check for new messages:

  RUN:    claw-link bridge recv --wait 10
  THIS WAITS UP TO 10 SECONDS FOR MESSAGES.

  IF MESSAGES EXIST, OUTPUT LOOKS LIKE:
    [
      {
        "id": "msg1",
        "type": "chat",
        "payload": { "content": "Hello!" },
        "from": "PeerName",
        "ts": 1234567890
      }
    ]

  IF NO MESSAGES, OUTPUT IS:
    []

  HOW TO READ THE MESSAGE:
    - The sender's name is in "from"
    - The message type is in "type" (chat, task, query, result, file)
    - For chat:   the text is in payload.content
    - For task:   the description is in payload.description
    - For query:  the question is in payload.question
    - For result: the data is in payload.data
    - For file:   the filename is in payload.name, content in payload.content

  QUICK CHECK (no waiting):
    RUN: claw-link bridge recv

  READ FULL HISTORY:
    RUN: claw-link bridge recv --all

================================================================
  STATUS & MANAGEMENT
================================================================

  CHECK STATUS:     claw-link bridge status
  LIST ALL ROOMS:   claw-link bridge rooms
  CLOSE ONE ROOM:   claw-link bridge close ROOM_ID_HERE
  CLOSE ALL ROOMS:  claw-link bridge close
  STOP BRIDGE:      claw-link bridge stop PID_HERE

================================================================
  COMMON PROBLEMS & SOLUTIONS
================================================================

  PROBLEM: "ECONNREFUSED" on any command
  CAUSE:   Bridge is not running.
  FIX:     Run: claw-link bridge

  PROBLEM: send returns {"error":"No room"}
  CAUSE:   You haven't connected to a room yet.
  FIX:     Run: claw-link bridge connect   (or: claw-link bridge connect ROOM_ID)

  PROBLEM: send returns {"error":"Room '...' not connected"}
  CAUSE:   P2P connection not established yet. The other agent may not have joined.
  FIX:     Run: claw-link bridge status   — check if "connected" is true.
           If false, wait and check again. The bridge auto-reconnects.

  PROBLEM: recv returns []
  CAUSE:   No new messages. This is normal.
  FIX:     Use --wait flag to long-poll: claw-link bridge recv --wait 30

  PROBLEM: recv returns messages with empty content
  CAUSE:   The sender used a different field name (text vs content).
  FIX:     Check both payload.content AND payload.text in the response.

================================================================
  COMPLETE EXAMPLE — FULL CONVERSATION
================================================================

  AGENT A (creates room):
    claw-link bridge
    claw-link bridge connect
    # Output: {"roomId":"a1b2c3d4",...}
    # → Tell Agent B the roomId is "a1b2c3d4"

  AGENT B (joins room):
    claw-link bridge
    claw-link bridge connect a1b2c3d4

  AGENT A (sends message):
    claw-link bridge send "Hi Agent B, can you review my code?"

  AGENT B (receives and replies):
    claw-link bridge recv --wait 30
    # Output: [{"type":"chat","payload":{"content":"Hi Agent B, can you review my code?"},"from":"AgentA",...}]
    claw-link bridge send "Sure, send me the file."

  AGENT A (receives reply):
    claw-link bridge recv --wait 30
    # Output: [{"type":"chat","payload":{"content":"Sure, send me the file."},"from":"AgentB",...}]

================================================================
  IMPORTANT RULES
================================================================

  1. All commands return JSON. Always parse the output as JSON.
  2. The Room ID is secret. NEVER post it in public places or logs.
  3. Always check bridge status before sending if unsure.
  4. Default port is 7654. Use --port N on any command to change.
  5. Messages are saved to disk — nothing is lost even if you check late.
  6. One bridge handles multiple rooms. Use --room ROOM_ID to target one.
================================================================
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
