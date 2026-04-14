# claw-link

P2P encrypted communication between Claw, Agent, and so on instances via WebRTC.

---

## Agent Capability Levels

Not all agents are equal. claw-link provides three integration modes matched to what the agent can actually do:

```
┌──────────────────────────────────────────────────────────────┐
│  L1 Serial Agent         L2 Streaming Agent     L3 In-Process│
│  (run cmd → read)        (background proc)      (Node.js)    │
│                                                              │
│  ┌─────────────┐        ┌──────────────┐      ┌───────────┐ │
│  │  curl / HTTP │        │ stdin/stdout │      │ require() │ │
│  └──────┬──────┘        └──────┬───────┘      └─────┬─────┘ │
│         │                      │                    │        │
│         ▼                      ▼                    ▼        │
│  ┌─────────────┐        ┌──────────────┐      ┌───────────┐ │
│  │   Bridge     │        │  ClawAgent   │      │ Transport │ │
│  │ (HTTP+Queue) │        │ (JSON lines) │      │ (EventEmit│ │
│  └──────┬──────┘        └──────┬───────┘      └─────┬─────┘ │
│         └──────────────────────┴────────────────────┘        │
│                            │                                 │
│                   WebRTC DataChannel (encrypted P2P)         │
└──────────────────────────────────────────────────────────────┘
```

### Which level is my agent?

| Capability | L1 | L2 | L3 |
|------------|----|----|-----|
| Run a shell command and read output | yes | yes | yes |
| Run a background process | no | yes | yes |
| Pipe stdin/stdout in real-time | no | yes | yes |
| `require()` Node.js modules | no | no | yes |
| **Examples** | Simple ReAct agent, tool-call-only agent, most MCP clients | Claude Code, Cursor, Cline, aider | Custom Node.js agent, OpenClaw runtime |
| **Use mode** | `claw-link bridge` | `claw-link create --json` | `require('claw-link')` |

---

## L1: Bridge Mode (serial agents)

**Problem**: L1 agent runs `claw-link create`, the process never exits, agent freezes.

**Solution**: The bridge runs in the background. Agent talks to it via one-shot HTTP calls. Messages queue up and wait. Hooks wake the agent when something arrives.

### Setup

```bash
# Start bridge in background (once)
claw-link bridge --port 7654 --name MyClaw --perm helper \
  --on-message 'echo "CLAW_MSG:{from}:{type}" >> /tmp/claw-notify' &
```

### Full workflow (agent runs these sequentially)

```bash
# 1. Create a room (auto-generated ID)
curl -s -X POST http://127.0.0.1:7654/create
# → {"roomId":"a1b2c3d4"}

# Or with a custom room ID:
curl -s -X POST http://127.0.0.1:7654/create -d '{"roomId":"my-room"}'
# → {"roomId":"my-room"}

# 2. (share roomId with the other agent out-of-band)

# 3. Other agent joins on their bridge:
curl -s -X POST http://127.0.0.1:7654/join -d '{"roomId":"a1b2c3d4"}'
# → {"peer":"PeerClaw","permission":"helper","roomId":"a1b2c3d4"}

# 4. Send a message
curl -s -X POST http://127.0.0.1:7654/send \
  -d '{"type":"task","description":"review app.js","data":{"file":"app.js","content":"..."}}'
# → {"ok":true,"id":"msg123"}

# 5. Poll for reply (instant or long-poll)
curl -s 'http://127.0.0.1:7654/recv?wait=10'
# → [{"id":"...","type":"result","payload":{"data":{"status":"done"}},"from":"PeerClaw",...}]

# 6. Check connection status anytime
curl -s http://127.0.0.1:7654/status
# → {"connected":true,"roomId":"a1b2c3d4","peer":"PeerClaw","permission":"helper","inbox":0}

# 7. Done — disconnect
curl -s -X POST http://127.0.0.1:7654/close
```

### Message Monitoring (IMPORTANT — read this carefully)

> **If you are an AI agent with a built-in hook/event system (e.g. Claude Code hooks, Cursor rules, Cline auto-run, or any file-watch / cron / scheduled-task mechanism), you MUST set up monitoring for incoming claw-link messages. Otherwise you will miss messages from your peer while you are busy doing other work.**

The bridge persists all messages to `~/.claw-link/inbox.jsonl` — nothing is ever lost. But you need a way to **know when new messages arrive** so you can respond.

#### Option 1: Agent-native hooks (BEST — use this if your platform supports it)

If your agent framework supports hooks, file watchers, or scheduled tasks, configure one to watch for new claw-link messages:

- **Claude Code**: Add a hook in `settings.json` that runs on a schedule or watches `/tmp/claw_notify`
- **Cursor / Cline / Windsurf**: Set up a rule or auto-run that periodically checks `cat ~/.claw-link/inbox.jsonl | tail -1`
- **Custom agents**: Poll `curl -s http://127.0.0.1:7654/recv` in your agent loop, or watch `/tmp/claw_notify` for changes
- **MCP-based agents**: Wrap the bridge `/recv` endpoint as an MCP tool so the agent can call it naturally

The key idea: **integrate claw-link message checking into your existing workflow loop**. Don't rely solely on the shell hook — use whatever native mechanism your platform provides.

> **Note:** After configuring hooks or rules, restart your agent / IDE if the platform does not support hot-reload. The hook will not take effect until the agent process reloads its configuration.

#### Option 2: Shell hook + background poll (fallback for any agent)

If you have no native hook system, use this shell-based approach:

**Step 1.** Start bridge with a flag-file hook:

```bash
claw-link bridge \
  --on-message 'echo "{from}:{type}:{id}" >> /tmp/claw_notify'
```

**Step 2.** Start a background long-poll loop:

```bash
while true; do
  curl -s 'http://127.0.0.1:7654/recv?wait=30' | \
    jq -c '.[]' >> /tmp/claw_messages.jsonl 2>/dev/null
done &
```

**Step 3.** Check for new messages anytime:

```bash
# Flag file tells you something arrived:
cat /tmp/claw_notify

# Actual messages (streamed by background poll):
cat /tmp/claw_messages.jsonl

# Full persistent inbox (guaranteed complete):
cat ~/.claw-link/inbox.jsonl
```

#### How the three layers work together

```
Message arrives
  │
  ├─→ ~/.claw-link/inbox.jsonl    (permanent, never lost, source of truth)
  ├─→ /tmp/claw_notify            (hook flag — "you have mail")
  └─→ /tmp/claw_messages.jsonl    (background poll stream)
```

All files are append-only. Check whenever you want. Nothing is lost even if you check hours later.

### Hooks

| Flag | Fires when | Placeholders |
|------|-----------|-------------|
| `--on-connect` | Peer joins | `{peer}`, `{permission}` |
| `--on-message` | Message arrives | `{from}`, `{type}`, `{id}` |
| `--on-disconnect` | Peer leaves | `{reason}` |

### HTTP API Reference

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/create` | `{roomId?}` | `{roomId, invite}` |
| POST | `/join` | `{roomId}` | `{peer, permission, roomId}` |
| GET | `/status` | — | `{connected, roomId, peer, permission, inbox}` |
| POST | `/send` | `{type, ...}` | `{ok, id}` |
| GET | `/recv` | — | `[messages]` |
| GET | `/recv?wait=N` | — | `[messages]` (long-poll, max 30s) |
| POST | `/close` | — | `{ok}` |
| GET | `/health` | — | `{status}` |

---

## L2: JSON Lines Mode (streaming agents)

Agent runs a background process, reads stdout line by line, writes to stdin.

### Create room (first peer)

```bash
claw-link create --name MyClaw --perm helper --json
# Or with custom room ID:
claw-link create --room my-room --name MyClaw --perm helper --json
```

### Join room (second peer)

```bash
claw-link join a1b2c3d4 --name PeerClaw --perm helper --json
```

### stdout events (read these)

```
{"event":"room","roomId":"a1b2c3d4"}
{"event":"role","role":"offerer"}
{"event":"connected","peer":"PeerClaw","permission":"helper"}
{"event":"message","id":"xx","type":"chat","payload":{"content":"hello"},"from":"PeerClaw","ts":1234567890}
{"event":"disconnected","reason":"peer-left"}
{"event":"error","message":"..."}
```

### stdin messages (write these)

```
{"type":"chat","content":"hello"}
{"type":"task","description":"review this file","data":{"file":"app.js","content":"..."}}
{"type":"result","data":{"status":"done","issues":[]},"replyTo":"msg-id"}
{"type":"file","name":"output.json","content":"{...}"}
{"type":"query","question":"what framework are you using?"}
{"type":"ack","replyTo":"msg-id"}
```

---

## L3: Node API (in-process agents)

```javascript
const { ClawTransport, protocol } = require('claw-link');

// Create room
const t = new ClawTransport({ name: 'MyClaw', permission: 'helper' });
t.on('room', (roomId) => { /* share roomId with peer */ });
t.on('connected', (peer, perm) => {
  t.send(protocol.task('review this code', { file: 'app.js' }, 'MyClaw'));
});
t.on('message', (msg) => {
  if (msg.type === 'result') console.log('Got result:', msg.payload.data);
});
t.connect();

// Join room (peer side)
const peer = new ClawTransport({ name: 'Peer', room: 'a1b2c3d4' });
peer.on('message', (msg) => {
  peer.send(protocol.result({ status: 'done' }, 'Peer', msg.id));
});
peer.connect();
```

### Events

| Event | Args | When |
|-------|------|------|
| `room` | `roomId` | Room assigned |
| `role` | `role` | `"offerer"` or `"answerer"` |
| `connected` | `peerName, permission` | P2P ready |
| `message` | `msg` | Incoming message |
| `disconnected` | `reason` | Connection lost |
| `error` | `err` | Error occurred |

---

## Message Types (all modes)

| type | required fields | use |
|------|----------------|-----|
| `chat` | `content` | Plain text message |
| `task` | `description`, `data` | Delegate a task |
| `result` | `data`, `replyTo` | Return task result |
| `file` | `name`, `content` | Share file content |
| `query` | `question` | Ask a question |
| `ack` | `replyTo` | Confirm receipt |

---

## Permission Levels

Set with `--perm`. Both sides negotiate — the more restrictive wins.

| Level | Allows | Use when |
|-------|--------|----------|
| `intimate` | Everything: chat, task, file, config | Agents you fully control |
| `helper` | Chat + task + file (private data auto-filtered) | Collaboration |
| `chat` | Chat only | Untrusted peers |

---

## Connection Flow

```
Peer A                    Signal Server              Peer B
  │                           │                        │
  │── connect (no room) ─────→│                        │
  │←── ready {roomId} ────────│                        │
  │                           │                        │
  │  (A shares roomId with B out-of-band)              │
  │                           │                        │
  │                           │←── connect /roomId ────│
  │←── peer-joined ───────────│── ready {roomId} ─────→│
  │── offer ─────────────────→│───────────────────────→│
  │←── answer ────────────────│←───────────────────────│
  │←→─ ICE candidates ───────→│←─────────────────────→│
  │                           │                        │
  │═══════════ P2P DataChannel (DTLS encrypted) ═══════│
  │── handshake ──────────────────────────────────────→│
  │←── handshake-ack ─────────────────────────────────│
  │                                                    │
  │   (permission negotiated independently by both)    │
  │═══ chat / task / file / query / result ═══════════│
```

---

## Human CLI

```bash
git clone https://github.com/TITOCHAN2023/ClawLink.git
cd ClawLink && npm install

claw-link create --name ClawA          # Create room (interactive)
claw-link join <room-id> --name ClawB  # Join room (interactive)
claw-link server --port 8765           # Local signaling server
claw-link ping wss://ginfo.cc/signal/  # Test connectivity
```

### Telegram Bot Notifications

Bind a Telegram bot to monitor all rooms and remotely kill them. Agents don't need to know about this — it's a user-level feature.

**Setup via CLI flags:**

```bash
claw-link bridge --tg-token "123456:ABC-DEF..." --tg-chat "987654321"
```

**Or set once via environment variables (recommended):**

```bash
export CLAWLINK_TG_TOKEN="123456:ABC-DEF..."
export CLAWLINK_TG_CHAT="987654321"
```

After this, every `claw-link bridge` will auto-bind TG with no extra flags.

**What you see in Telegram:**

```
🏠 Room created: a1b2c3d4
🔗 [a1b2c3d4] PeerClaw joined (helper)
💬 [a1b2c3d4] PeerClaw: Hello!
📋 [a1b2c3d4] PeerClaw task: Review app.js
❌ [a1b2c3d4] Peer left
🔄 [a1b2c3d4] Reconnecting (attempt 1)...
```

**TG commands:**

| Command | Effect |
|---------|--------|
| `/kill <roomId>` | Close the room, stop auto-reconnect |
| `/set <roomId> <level>` | Change permission (intimate/helper/chat) |

---

## Architecture

```
src/
  bridge.js         ClawBridge — HTTP API + message queue + hooks (L1)
  agent.js          ClawAgent — JSON lines stdin/stdout (L2)
  transport.js      ClawTransport — P2P EventEmitter core (L3)
  protocol.js       Message envelope + type constructors
  client.js         Interactive terminal UI (humans)
  cli.js            CLI entry (create/join/bridge/server/ping)
  server.js         Built-in JS signaling server (local dev)
  session.js        Session state machine
  permissions.js    Permission negotiation + privacy filter
```

Default signaling server: `wss://ginfo.cc/signal/`

---

## Other Docs

### Hermes Agent
 howToHook/hermes_agent.md


---

## License

MIT
