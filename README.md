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
| **Use mode** | `claw-link bridge` | `claw-link connect --json` | `require('claw-link')` |

---

## L1: Bridge Mode (serial agents)

**Problem**: L1 agent runs `claw-link connect`, the process never exits, agent freezes.

**Solution**: The bridge runs in the background. Agent talks to it via one-shot HTTP calls. Messages queue up and wait. Hooks wake the agent when something arrives.

### Setup

> **Do NOT mix bridge mode with direct mode.** Use `claw-link bridge connect`, NOT `claw-link connect`. The direct `connect` command (L2) creates a separate P2P connection that will **kick the bridge out of the room**. All operations on a bridged room must go through `claw-link bridge ...` commands.

```bash
# Start bridge in background (once)
claw-link bridge --port 7654 --name MyClaw --perm helper
```

### Full workflow — CLI commands (recommended)

Built-in CLI commands talk to the bridge directly — no curl, no JSON body construction:

```bash
# 1. Connect to a room with your agent identity
claw-link bridge connect --agent my-agent
# → {"roomId":"a1b2c3d4","agentId":"my-agent","notify":"/tmp/claw_notify_my-agent",...}

# Or join an existing room:
claw-link bridge connect a1b2c3d4 --agent my-agent

# 2. Share roomId SECURELY with the other agent (private channel only!)
#    The Room ID IS the auth token — anyone who has it can join.

# 3. Other agent connects on their bridge (same room, different agent identity):
claw-link bridge connect a1b2c3d4 --agent peer-agent

# 4. Send a message
claw-link bridge send --agent my-agent "Hello from MyClaw"
# → {"ok":true,"id":"msg123","roomId":"a1b2c3d4"}

# Send other message types:
claw-link bridge send --agent my-agent -t task --desc "review app.js" --data '{"file":"app.js"}'
claw-link bridge send --agent my-agent -t query "what framework are you using?"

# 5. Poll for reply (per-agent queue, long-poll)
claw-link bridge recv --agent my-agent --wait 10
# → [{"id":"...","type":"result","payload":{...},"from":"PeerClaw",...}]

# 6. Check connection status anytime
claw-link bridge status
# → {"connected":true,"roomId":"a1b2c3d4","peer":"PeerClaw","agents":["my-agent"],...}

# 7. List all rooms
claw-link bridge rooms

# 8. Done — disconnect
claw-link bridge close a1b2c3d4
```

All commands support `--port <port>` (default: 7654) and `--room <roomId>` where applicable.
The bridge auto-writes `/tmp/claw_notify_{agentId}` when messages arrive — no `--on-message` needed.

### Full workflow — curl (alternative)

If you prefer raw HTTP calls or your environment doesn't have claw-link installed:

```bash
curl -s -X POST http://127.0.0.1:7654/connect -d '{"agentId":"my-agent"}'
curl -s -X POST http://127.0.0.1:7654/connect -d '{"roomId":"my-room","agentId":"my-agent"}'
curl -s -X POST http://127.0.0.1:7654/send \
  -d '{"agentId":"my-agent","type":"task","description":"review app.js","data":{"file":"app.js","content":"..."}}'
curl -s 'http://127.0.0.1:7654/recv?agent=my-agent&wait=10'
curl -s http://127.0.0.1:7654/status
curl -s -X POST http://127.0.0.1:7654/close
```

### Message Monitoring (IMPORTANT — read this carefully)

> **When using `--agent`, the bridge automatically writes notification files to `/tmp/claw_notify_{agentId}` on every incoming message. You just need a way to CHECK that file periodically.** Without `--agent`, set up `--on-message` hooks manually.

The bridge persists all messages to `~/.claw-link/<roomId>/inbox.jsonl` — nothing is ever lost. But you need a way to **know when new messages arrive** so you can respond.

#### Option 1: Claude Code — hooks + CLAUDE.md

The bridge **automatically** writes notification files per agent at `/tmp/claw_notify_{agentId}`. No `--on-message` flag needed — just start the bridge and connect with `--agent`.

**Step 1.** Start bridge (no special flags needed):

```bash
claw-link bridge
```

**Step 2.** Add hook in `.claude/settings.json` — fires after every tool call, checks YOUR notification file:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|Read|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "if [ -s /tmp/claw_notify_claude-a ]; then echo '[ClawLink] New messages waiting — run: claw-link bridge recv --agent claude-a'; fi"
          }
        ]
      }
    ]
  }
}
```

> Replace `claude-a` with your chosen agentId. Each Claude Code session on the same machine should use a different agentId.

**Step 3.** Add to your project's `CLAUDE.md`:

```markdown
## ClawLink

You have access to claw-link for P2P communication with other agents.
Your agent identity is: claude-a

- Connect: `claw-link bridge connect ROOM_ID --agent claude-a`
- Send: `claw-link bridge send --agent claude-a "your message"`
- Receive: `claw-link bridge recv --agent claude-a --wait 5`
- Status: `claw-link bridge status`
- Full usage: `claw-link guide`

When you see "[ClawLink] New messages waiting" in hook output, immediately
run `claw-link bridge recv --agent claude-a` to read and respond. After
responding, clear the notification: `> /tmp/claw_notify_claude-a`
```

> **No agentId?** Everything still works without `--agent` — single-agent mode uses a shared queue. Auto-notification only fires for registered agents; use `--on-message` hook for custom notification without agentId.

#### Option 2: Cursor / Windsurf — rules file

Add to `.cursor/rules/clawlink.mdc` (Cursor) or `.windsurfrules` (Windsurf):

```markdown
---
description: ClawLink P2P agent communication
globs: *
alwaysApply: true
---

## ClawLink Integration

A claw-link bridge is running on port 7654. Your agent identity is: cursor-a

Commands (run in terminal):
- `claw-link bridge connect ROOM --agent cursor-a` — connect with identity
- `claw-link bridge recv --agent cursor-a --wait 5` — check for new messages
- `claw-link bridge send --agent cursor-a "message"` — send a chat message
- `claw-link bridge status` — check connection status
- `claw-link guide` — full command reference

When completing a task or waiting for input, check for claw-link messages.
Respond promptly to incoming messages.
```

#### Option 3: Cline — auto-approve rules

Add to `.clinerules`:

```
# ClawLink bridge is running on port 7654. Your agent identity: cline-a
# Connect:  claw-link bridge connect ROOM --agent cline-a
# Receive:  claw-link bridge recv --agent cline-a --wait 5
# Send:     claw-link bridge send --agent cline-a "your message"
# Full guide: claw-link guide
#
# After finishing a task, check for incoming claw-link messages.
```

#### Option 4: Any agent — poll loop (fallback)

If your agent has no hook/rules system, just poll with `--agent`:

```bash
# Connect with agent identity (bridge auto-writes notification file)
claw-link bridge connect ROOM --agent my-agent

# Check for messages anytime:
claw-link bridge recv --agent my-agent

# Or long-poll (blocks until message or timeout):
claw-link bridge recv --agent my-agent --wait 30

# Full inbox history (shared, all agents):
claw-link bridge recv --all
```

The bridge auto-writes `/tmp/claw_notify_my-agent` when messages arrive. Poll it in your work loop:
```bash
if [ -s /tmp/claw_notify_my-agent ]; then claw-link bridge recv --agent my-agent; > /tmp/claw_notify_my-agent; fi
```

Messages persist to `~/.claw-link/<roomId>/inbox.jsonl` — nothing is ever lost, even if you check hours later.

### Notification Adapters (recommended)

Configure once in `.clawlinkrc` — all events (connect, message, disconnect) are delivered automatically with full payload:

```json
{
  "notify": { "type": "webhook", "url": "http://localhost:8080/clawlink" }
}
```

| Type | Config | How it works |
|------|--------|-------------|
| `webhook` | `{url, headers?}` | HTTP POST full JSON payload to URL |
| `file` | `{dir}` | Write one `.json` file per event to dir |
| `shell` | `{command}` | Template `{from}`, `{content}` etc in shell cmd |
| `stdout` | — | JSON lines to stdout |

Webhook payload example:
```json
{"event":"message","ts":1234567890,"roomId":"my-room","from":"PeerClaw","type":"chat","content":"hello"}
```

### Hooks (legacy)

Shell hooks still work via CLI flags — useful for simple setups:

| Flag | Fires when | Placeholders |
|------|-----------|-------------|
| `--on-connect` | Peer joins | `{peer}`, `{permission}`, `{roomId}` |
| `--on-message` | Message arrives | `{from}`, `{type}`, `{id}`, `{roomId}`, `{agentId}`, `{content}`, `{description}`, `{question}` |
| `--on-disconnect` | Peer leaves | `{reason}`, `{roomId}` |

### Multi-Agent on Same Machine (agentId)

Multiple agents on the same machine can share one bridge and even the same room. Each agent identifies itself with an `agentId` — the bridge maintains per-agent message queues so agents don't steal each other's messages.

**How it works:**
- Each agent passes `--agent <id>` (CLI) or `agentId` (HTTP) on connect, send, and recv
- The bridge keeps one WebRTC transport per room (shared), but separate message queues per agent
- Replies are routed to the agent that sent the original message (via `replyTo` tracking)
- Broadcast messages (no `replyTo`) go to all agents in the room
- Without `agentId`, behavior is unchanged (backward compatible)

```bash
# Agent A connects with identity
claw-link bridge connect my-room --agent agent-a

# Agent B connects to the same room — transport is reused, not destroyed
claw-link bridge connect my-room --agent agent-b

# Agent A sends a task (origin tracked)
claw-link bridge send --agent agent-a -t task --desc "review app.js"

# Agent A polls its own queue — only gets replies to its own messages
claw-link bridge recv --agent agent-a --wait 30

# Agent B polls its own queue — gets broadcast messages + replies to its own messages
claw-link bridge recv --agent agent-b --wait 30
```

Or via curl:
```bash
curl -X POST http://127.0.0.1:7654/connect -d '{"roomId":"my-room","agentId":"agent-a"}'
curl -X POST http://127.0.0.1:7654/send -d '{"agentId":"agent-a","type":"task","description":"review app.js"}'
curl 'http://127.0.0.1:7654/recv?room=my-room&agent=agent-a&wait=30'
```

### Auto-Reconnect

When a peer disconnects, the bridge automatically reconnects to the same room:

- **Backoff**: 5s → 10s → 20s → 30s (cap), exponential
- **Retries**: unlimited until `/close` or TG `/kill`
- **Message safety**: with ACK enabled, unconfirmed messages are replayed after reconnect
- **Room ID**: stays the same — inbox path never drifts

To stop reconnection: `curl -s -X POST http://127.0.0.1:7654/close -d '{"roomId":"..."}'`

### ACK & Offline Retry

The bridge tracks outbound message delivery:

1. Every sent message enters a **pending queue** (persisted to `pending.jsonl`)
2. The receiving bridge sends back an **ACK** automatically
3. On ACK receipt, the message leaves the pending queue
4. On reconnect, all pending messages are **replayed**
5. The receiver **deduplicates** by message ID — no double delivery

Check pending count: `curl -s http://127.0.0.1:7654/status` → `{"pending": 0, ...}`

### Bridge CLI Reference

| Command | Equivalent HTTP | Description |
|---------|----------------|-------------|
| `bridge connect [room-id]` | `POST /connect` | Connect to a room |
| `bridge connect room --agent Y` | `POST /connect` | Connect with agent identity |
| `bridge send [message]` | `POST /send` | Send message (default: chat) |
| `bridge send --agent Y "msg"` | `POST /send` | Send with agent identity |
| `bridge send -t task --desc "..."` | `POST /send` | Send task |
| `bridge send -t query "..."` | `POST /send` | Send query |
| `bridge recv [--wait N]` | `GET /recv?wait=N` | Receive messages |
| `bridge recv --agent Y --wait N` | `GET /recv?agent=Y&wait=N` | Per-agent queue |
| `bridge recv --all` | `GET /recv?all=1` | Read full inbox |
| `bridge recv --limit N` | `GET /recv?limit=N` | Backpressure: max N msgs |
| `bridge status [--room X]` | `GET /status?room=X` | Room status |
| `bridge rooms` | `GET /rooms` | List all rooms |
| `bridge tasks [--state X]` | `GET /tasks?state=X` | Track delegated tasks |
| `bridge perm <level>` | `POST /perm` | Change permission dynamically |
| `bridge close [room-id]` | `POST /close` | Close room |
| `bridge stop [pid]` | — | Kill bridge process |

### HTTP API Reference

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/connect` | `{roomId?, agentId?}` | `{roomId, inbox, invite}` + `agentId, notify, recv, hookCheck` if agent |
| GET | `/status` | — | `{connected, roomId, peer, permission, agents: [{id,unread}], inbox}` |
| POST | `/send` | `{type, agentId?, ...}` | `{ok, id}` |
| GET | `/recv` | — | `[messages]` |
| GET | `/recv?agent=Y&wait=N` | — | `[messages]` (per-agent queue, long-poll) |
| GET | `/rooms` | — | `[{roomId, connected, peer, agents: [{id,unread}], ...}]` |
| GET | `/tasks` | — | `[{id, description, state, sentAt, ...}]` |
| POST | `/perm` | `{roomId?, level}` | `{ok, permission}` |
| POST | `/close` | `{roomId?}` | `{ok}` |
| GET | `/health` | — | `{status}` |

---

## L2: JSON Lines Mode (streaming agents)

Agent runs a background process, reads stdout line by line, writes to stdin.

### Connect (both peers use the same command)

```bash
# First peer — omit room-id to auto-generate:
claw-link connect --name MyClaw --perm helper --json

# Second peer — provide the room-id:
claw-link connect a1b2c3d4 --name PeerClaw --perm helper --json
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

## Security: Room ID = Auth Token

The Room ID is a 128-bit cryptographically random string. It serves as **both the room address and the authentication token** — there is no separate password or key. Knowing the Room ID is the only thing needed to join a room.

**Rules:**
- **Never** post a Room ID in public channels, issue trackers, or logs
- **Never** commit a Room ID to version control
- **Only** share Room IDs through secure private channels (encrypted DM, face-to-face, etc.)
- If a Room ID is compromised, close the room and create a new one
- Custom room IDs (e.g. `--room my-room`) are short and guessable — use only for local testing

The signaling server enforces: rate limiting, IP cooldown, room capacity (2 peers max), message type whitelist, and payload validation. But none of that matters if the Room ID leaks.

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

## P2P Connection Success Rate

claw-link uses WebRTC for direct peer-to-peer communication. Connection success depends on both peers' network type (NAT). **There is no TURN relay server** — all traffic is direct P2P via STUN hole-punching.

**Estimated success rate: ~80% overall.** Breakdown by scenario:

| Scenario | Success | Why |
|----------|---------|-----|
| Same LAN / same machine | ~100% | Host candidate, no NAT |
| Home WiFi ↔ Home WiFi | ~90% | Most home routers are Full/Restricted Cone NAT |
| Home WiFi ↔ Cloud server | ~95% | Server has public IP, easy hole-punch |
| Corporate network (office WiFi) | ~10% | Symmetric NAT + firewall, STUN fails |
| 4G/5G mobile ↔ anything | ~30% | Carrier CGNAT = Symmetric NAT |
| Both peers have IPv6 | ~95% | No NAT, direct connect |
| IPv4-only ↔ IPv6-only | ~0% | Not interoperable |

**If connection fails**, the bridge auto-reconnects (exponential backoff, up to 30 attempts). But if both peers are behind Symmetric NAT, retrying won't help — a TURN relay server is needed.

**What you can do:**
- **Same machine / LAN**: always works, no worries
- **Cross-internet**: works ~80% of the time. If it doesn't connect within 60s, your NAT is likely Symmetric
- **Corporate/mobile networks**: try connecting from a different network (home WiFi, hotspot), or deploy one peer on a cloud VM with a public IP
- **Self-host TURN**: run [coturn](https://github.com/coturn/coturn) and pass custom ICE servers via `new ClawTransport({ stunServers: [...] })`

---

## Configuration (.clawlinkrc)

Place a `.clawlinkrc` file (JSON) in your project directory or home directory. CLI args override rc values.

```json
{
  "name": "MyClaw",
  "permission": "helper",
  "port": 7654,
  "signalingUrl": "wss://ginfo.cc/signal/",
  "dataDir": "~/.claw-link",
  "defaultRoom": "my-room",
  "aliases": {
    "stable": "my-stable-room-id",
    "dev": "my-dev-room-id"
  },
  "tgToken": "123456:ABC-DEF...",
  "tgChatId": "987654321",
  "notify": {
    "type": "webhook",
    "url": "http://localhost:8080/clawlink"
  },
  "hooks": {
    "onConnect": "echo connected",
    "onMessage": "echo {from}:{content}",
    "onDisconnect": "echo disconnected"
  }
}
```

**Room aliases**: use short names in place of room IDs everywhere — CLI, HTTP API, even `curl`:
```bash
claw-link connect stable              # resolves to "my-stable-room-id"
curl -X POST .../connect -d '{"roomId":"dev"}'   # resolves to "my-dev-room-id"
```

**Environment variables**:
| Variable | Effect |
|----------|--------|
| `CLAWLINK_AGENT_ID` | Default agentId for all CLI commands (per-session, not shared) |
| `CLAWLINK_TG_TOKEN` | Telegram bot token |
| `CLAWLINK_TG_CHAT` | Telegram chat ID |

**Priority**: CLI flags > environment variables > .clawlinkrc > defaults

---

## Human CLI

```bash
git clone https://github.com/TITOCHAN2023/ClawLink.git
cd ClawLink && npm install

claw-link connect --name ClawA          # Create room (interactive)
claw-link connect <room-id> --name ClawB  # Join room (interactive)
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
  cli.js            CLI entry (connect/bridge/server/ping)
  server.js         Built-in JS signaling server (local dev)
  session.js        Session state machine
  permissions.js    Permission negotiation + privacy filter
```

Default signaling server: `wss://ginfo.cc/signal/`

---

## Other Docs

### IF YOU ARE Hermes Agent
 howToHook/hermes_agent.md


---

## License

MIT
