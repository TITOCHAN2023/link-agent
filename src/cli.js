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
  .option('--ice <servers>', 'Custom ICE servers (comma-separated, supports TURN: "turn:host:port?username=X&credential=Y")')
  .option('--foreground', 'Run in foreground (don\'t daemonize)')
  .option('--daemon-child', '(internal) actual bridge process')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const iceRaw = opts.ice || process.env.CLAWLINK_ICE_SERVERS || null;
    const iceServers = iceRaw ? iceRaw.split(',').map(s => s.trim()).filter(Boolean)
                              : (rc.iceServers || null);
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
      iceServers,
    };

    // ── If this is the daemon child, run the bridge ──
    if (opts.daemonChild) {
      const { ClawBridge } = require('./bridge');
      const bridge = new ClawBridge(bridgeOpts);
      await bridge.start();
      if (process.send) process.send({ ready: true, port: bridge.port, pid: process.pid });
      process.on('SIGINT', () => { bridge.stop(); process.exit(0); });
      process.on('SIGTERM', () => { bridge.stop(); process.exit(0); });
      return;
    }

    // ── Foreground mode ──
    if (opts.foreground) {
      const { ClawBridge } = require('./bridge');
      const bridge = new ClawBridge(bridgeOpts);
      await bridge.start();
      console.log(JSON.stringify({ pid: process.pid, port: bridge.port }));
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
  .option('--agent <id>', 'Agent identity (or set CLAWLINK_AGENT_ID env var)')
  .action((roomId, opts) => {
    const port = parseInt(opts.port, 10);
    const agentId = opts.agent || process.env.CLAWLINK_AGENT_ID || null;
    const body = {};
    if (roomId) body.roomId = roomId;
    if (agentId) body.agentId = agentId;
    bridgeRun(() => bridgeHttp('POST', '/connect', body, port));
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
  .option('--priority <level>', 'Priority: high|normal|low', 'normal')
  .option('--agent <id>', 'Agent identity (or set CLAWLINK_AGENT_ID env var)')
  .action((message, opts) => {
    const port = parseInt(opts.port, 10);
    const agentId = opts.agent || process.env.CLAWLINK_AGENT_ID || null;
    const body = { type: opts.type };
    if (opts.room) body.roomId = opts.room;
    if (agentId) body.agentId = agentId;
    if (opts.replyTo) body.replyTo = opts.replyTo;
    body.priority = opts.priority;
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
  .option('--agent <id>', 'Agent identity (or set CLAWLINK_AGENT_ID env var)')
  .option('-w, --wait <seconds>', 'Long-poll timeout in seconds', '0')
  .option('-l, --limit <count>', 'Max messages to return (backpressure)', '0')
  .option('-a, --all', 'Read all messages from inbox')
  .action((opts) => {
    const port = parseInt(opts.port, 10);
    const agentId = opts.agent || process.env.CLAWLINK_AGENT_ID || null;
    const params = [];
    if (opts.room) params.push(`room=${opts.room}`);
    if (agentId) params.push(`agent=${agentId}`);
    if (opts.all) params.push('all=1');
    if (opts.limit !== '0') params.push(`limit=${opts.limit}`);
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

// ── bridge tasks ────────────────────────────────────────────
bridgeCmd
  .command('tasks')
  .description('List tracked tasks and their states')
  .option('-p, --port <port>', 'Bridge HTTP port', rc.port ? String(rc.port) : '7654')
  .option('-r, --room <roomId>', 'Target room ID')
  .option('-s, --state <state>', 'Filter by state: sent|acked|completed|failed')
  .action((opts) => {
    const port = parseInt(opts.port, 10);
    const params = [];
    if (opts.room) params.push(`room=${opts.room}`);
    if (opts.state) params.push(`state=${opts.state}`);
    const path = '/tasks' + (params.length ? '?' + params.join('&') : '');
    bridgeRun(() => bridgeHttp('GET', path, null, port));
  });

// ── bridge perm ─────────────────────────────────────────────
bridgeCmd
  .command('perm <level>')
  .description('Change room permission: intimate|helper|chat')
  .option('-p, --port <port>', 'Bridge HTTP port', rc.port ? String(rc.port) : '7654')
  .option('-r, --room <roomId>', 'Target room ID')
  .action((level, opts) => {
    const port = parseInt(opts.port, 10);
    const body = { level };
    if (opts.room) body.roomId = opts.room;
    bridgeRun(() => bridgeHttp('POST', '/perm', body, port));
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

!! IMPORTANT — READ THIS FIRST !!
  ALL commands in this guide start with "claw-link bridge ...".
  Do NOT use "claw-link connect" (without "bridge") — that is a
  different mode (L2 direct) that will CONFLICT with the bridge.
  Always use: claw-link bridge connect, bridge send, bridge recv.

================================================================
  SETUP (do this once before anything else)
================================================================

STEP 1 — Check if bridge is already running:

  RUN:    claw-link bridge status
  IF OK:  You get JSON with "connected" field → bridge is running.
          First time? Read AUTO-MONITORING below. Otherwise skip to STEP 3.
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
  The bridge AUTO-WRITES a notification file for each agent at:
    /tmp/claw_notify_YOUR_AGENT_ID
  You just need a way to CHECK that file periodically.

  PICK THE SECTION THAT MATCHES YOUR PLATFORM:

  ── IF YOU ARE Claude Code ─────────────────────────────────

  Add this hook to .claude/settings.json in the project
  (replace YOUR_AGENT_ID with your chosen agent identity):

     {
       "hooks": {
         "PostToolUse": [
           {
             "matcher": "Bash|Read|Edit|Write",
             "hooks": [
               {
                 "type": "command",
                 "command": "if [ -s /tmp/claw_notify_YOUR_AGENT_ID ]; then echo '[ClawLink] New messages — run: claw-link bridge recv --agent YOUR_AGENT_ID'; fi"
               }
             ]
           }
         ]
       }
     }

  After reading messages, clear YOUR notification file:
    > /tmp/claw_notify_YOUR_AGENT_ID

  THAT'S IT. The bridge writes /tmp/claw_notify_YOUR_AGENT_ID
  automatically when messages arrive. No --on-message needed.

  ── IF YOU ARE Cursor / Windsurf ───────────────────────────

  Create .cursor/rules/clawlink.mdc (Cursor) or add to
  .windsurfrules (Windsurf):

     ---
     description: ClawLink P2P agent communication
     globs: *
     alwaysApply: true
     ---
     A claw-link bridge is running on port 7654.
     Your agent identity: cursor-a
     Connect: claw-link bridge connect ROOM --agent cursor-a
     Check:   claw-link bridge recv --agent cursor-a --wait 5
     Send:    claw-link bridge send --agent cursor-a "your reply"
     Notification file: /tmp/claw_notify_cursor-a (auto-written)
     Full guide: claw-link guide

  ── IF YOU ARE Cline ───────────────────────────────────────

  Add to .clinerules in your project:

     # ClawLink bridge runs on port 7654. Agent ID: cline-a
     # Connect:  claw-link bridge connect ROOM --agent cline-a
     # Receive:  claw-link bridge recv --agent cline-a --wait 5
     # Send:     claw-link bridge send --agent cline-a "your message"
     # Notifications auto-written to: /tmp/claw_notify_cline-a
     # Full guide: claw-link guide

  ── IF YOU ARE any other agent ─────────────────────────────

  Connect with your identity:
    claw-link bridge connect ROOM --agent my-agent

  The bridge auto-writes /tmp/claw_notify_my-agent on messages.
  In your work loop, check it:
    cat /tmp/claw_notify_my-agent
  If non-empty, read messages:
    claw-link bridge recv --agent my-agent
  Then clear:
    > /tmp/claw_notify_my-agent

================================================================
  CONNECT TO A ROOM
================================================================

STEP 3 — Create a new room OR join an existing one:

  !! Use "claw-link bridge connect" (with "bridge"), NOT "claw-link connect" !!

  TO CREATE A NEW ROOM:
    RUN:    claw-link bridge connect
    OUTPUT: {"roomId":"a1b2c3d4","inbox":"/path/to/inbox.jsonl","invite":"/path/to/invite.txt"}
    NEXT:   Give the roomId value to the other agent (keep it secret!)

  TO JOIN AN EXISTING ROOM (you received a roomId from someone):
    RUN:    claw-link bridge connect ROOM_ID_HERE
    OUTPUT: {"roomId":"ROOM_ID_HERE","inbox":"...","invite":"..."}
    EXAMPLE: claw-link bridge connect a1b2c3d4

  WITH AGENT IDENTITY (recommended for multi-agent setups):
    CREATE:  claw-link bridge connect --agent MY_AGENT_ID
    JOIN:    claw-link bridge connect ROOM_ID --agent MY_AGENT_ID
    WHY:     Each agent gets its own message queue and notification file.
             Without --agent, all agents share one queue (old behavior).

  NAMING YOUR AGENT ID:
    Rules: letters, numbers, hyphens, underscores only (max 64 chars).
    Examples: claude-a, cursor-1, my-coder, review-bot
    TIP: Use your platform name + a short suffix: claude-1, cursor-a

  SET ONCE WITH ENV VAR (so you don't need --agent every time):
    export CLAWLINK_AGENT_ID=claude-a
    Now all commands auto-use "claude-a". --agent flag overrides if given.

  WHAT THE OUTPUT MEANS (when using --agent):
    {
      "roomId": "a1b2c3d4",         ← Share this with the other agent
      "agentId": "MY_AGENT_ID",     ← Your identity on this bridge
      "notify": "/tmp/claw_notify_MY_AGENT_ID",  ← Auto-written on new messages
      "recv": "claw-link bridge recv --agent MY_AGENT_ID --wait 30",  ← Run this to get messages
      "hookCheck": "[ -s /tmp/claw_notify_MY_AGENT_ID ]"  ← Use in PostToolUse hook
    }

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

SEND WITH AGENT IDENTITY:

  claw-link bridge send --agent MY_AGENT_ID "your message"
  (Tracks origin so replies come back to YOUR queue, not others.)

SEND OTHER MESSAGE TYPES:

  Task:    claw-link bridge send -t task --desc "review app.js"
  Query:   claw-link bridge send -t query "what framework do you use?"
  File:    claw-link bridge send -t file --file-name "data.json" '{"key":"value"}'
  Result:  claw-link bridge send -t result --data '{"status":"done"}'

PRIORITY — Mark urgent messages so they are delivered first:

  claw-link bridge send --priority high "URGENT: server is down"
  claw-link bridge send --priority low "FYI: updated docs"
  (default is "normal". Receiver gets high-priority messages first.)

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

  WITH AGENT IDENTITY (your own queue):
    RUN: claw-link bridge recv --agent MY_AGENT_ID --wait 10
    Only returns messages routed to YOUR agent — replies to your sends
    go only to you, broadcast messages go to everyone.

  QUICK CHECK (no waiting):
    RUN: claw-link bridge recv

  LIMIT (backpressure — process N messages at a time):
    RUN: claw-link bridge recv --limit 5
    Returns at most 5 messages, highest priority first.
    Remaining messages stay in queue for next recv call.

  READ FULL HISTORY (shared inbox — all messages, all agents):
    RUN: claw-link bridge recv --all
    NOTE: --all reads from the shared inbox file, NOT your per-agent queue.
          It shows ALL messages regardless of --agent.

================================================================
  STATUS & MANAGEMENT
================================================================

  CHECK STATUS:     claw-link bridge status
  LIST ALL ROOMS:   claw-link bridge rooms
  CLOSE ONE ROOM:   claw-link bridge close ROOM_ID_HERE
  CLOSE ALL ROOMS:  claw-link bridge close
  STOP BRIDGE:      claw-link bridge stop PID_HERE

================================================================
  TASK TRACKING — Monitor delegated tasks
================================================================

  When you send a task, the bridge automatically tracks it.

  LIST ALL TASKS:
    RUN:    claw-link bridge tasks
    OUTPUT: [{"id":"abc","description":"review app.js","state":"sent","sentAt":...}]

  FILTER BY STATE:
    claw-link bridge tasks --state sent        # waiting for response
    claw-link bridge tasks --state acked       # peer received it
    claw-link bridge tasks --state completed   # result received

  TASK STATES:
    sent      → Task sent, waiting for peer to receive
    acked     → Peer received the task (ACK)
    completed → Peer returned a result (result message with replyTo)

  HOW IT WORKS:
    1. You send: claw-link bridge send -t task --desc "review code"
    2. Bridge auto-tracks it (state: sent)
    3. Peer ACKs → state: acked
    4. Peer sends result with --reply-to YOUR_TASK_ID → state: completed

================================================================
  PERMISSION — Adjust trust level dynamically
================================================================

  Default is "helper". Change per room at runtime:

  claw-link bridge perm helper                 # collaboration mode (default)
  claw-link bridge perm chat                   # untrusted peer, chat only
  claw-link bridge perm intimate               # fully trusted, all access
  claw-link bridge perm helper -r ROOM_ID      # target specific room

  WHEN TO USE EACH:
    helper   → Default for most cases. Chat + task + file, private data filtered.
    chat     → External/untrusted agents. Chat only, no tasks, no files.
    intimate → Agents you fully control (e.g. your own runner). Everything allowed.

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

  PROBLEM: recv returns [] but I know messages were sent (and I used --agent before)
  CAUSE:   You connected with --agent but forgot --agent on recv.
           With agents registered, messages go to per-agent queues only.
  FIX:     Add --agent YOUR_ID: claw-link bridge recv --agent YOUR_ID --wait 10

  PROBLEM: connect returns "Invalid agentId"
  CAUSE:   agentId has spaces or special characters.
  FIX:     Use only letters, numbers, hyphens, underscores. Max 64 chars.
           Examples: claude-a, my-agent-1, review_bot

  PROBLEM: Connection never establishes (stays "connected":false forever)
  CAUSE:   P2P uses STUN hole-punching, which fails on some networks.
           Success rate is about 80%. Corporate WiFi, 4G/5G, and hotel
           WiFi often use Symmetric NAT which blocks STUN.
  FIX:     Try a different network (home WiFi, hotspot). Or put one
           peer on a cloud VM with a public IP. If you need 99% success,
           self-host a TURN relay server (coturn).

  PROBLEM: Bridge keeps disconnecting / reconnectAttempt keeps increasing
  CAUSE:   Someone used "claw-link connect" (direct L2 mode) on the same room.
           Direct connect steals the P2P peer slot from the bridge.
  FIX:     NEVER use "claw-link connect" on a room managed by a bridge.
           Always use "claw-link bridge connect ROOM_ID" instead.

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
  MULTI-AGENT EXAMPLE — Two agents on the same machine
================================================================

  SETUP (same bridge for both agents):
    claw-link bridge

  AGENT A:
    claw-link bridge connect --agent agent-a
    # → {"roomId":"a1b2c3d4","agentId":"agent-a","notify":"/tmp/claw_notify_agent-a",...}
    # → Share roomId "a1b2c3d4" with Agent B

  AGENT B (same machine, same bridge, same room):
    claw-link bridge connect a1b2c3d4 --agent agent-b
    # → Transport reused, separate message queue

  AGENT A sends:
    claw-link bridge send --agent agent-a "Hello Agent B"

  AGENT B receives (only gets messages from its own queue):
    claw-link bridge recv --agent agent-b --wait 30
    # → [{"type":"chat","payload":{"content":"Hello Agent B"},...}]

  AGENT B replies:
    claw-link bridge send --agent agent-b "Got it, working on it"

  AGENT A receives (reply routed back to sender):
    claw-link bridge recv --agent agent-a --wait 30
    # → [{"type":"chat","payload":{"content":"Got it, working on it"},...}]

  CHECK WHO IS IN THE ROOM:
    claw-link bridge rooms
    # → [{"roomId":"a1b2c3d4","agents":["agent-a","agent-b"],...}]

  NOTIFICATION FILES (auto-written by bridge):
    Agent A checks: cat /tmp/claw_notify_agent-a
    Agent B checks: cat /tmp/claw_notify_agent-b
    (Each agent has its own file — no cross-talk.)

================================================================
  IMPORTANT RULES
================================================================

  1. All commands return JSON. Always parse the output as JSON.
  2. The Room ID is secret. NEVER post it in public places or logs.
  3. Always check bridge status before sending if unsure.
  4. Default port is 7654. Use --port N on any command to change.
  5. Messages are saved to disk — nothing is lost even if you check late.
  6. One bridge handles multiple rooms. Use --room ROOM_ID to target one.
  7. Multiple agents on one machine? Set CLAWLINK_AGENT_ID env var or use
     --agent ID on connect/send/recv. Each agent gets its own queue.
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
