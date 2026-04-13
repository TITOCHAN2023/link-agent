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
# 1. Create a room
curl -s -X POST http://127.0.0.1:7654/create
# → {"roomId":"a1b2c3d4"}

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

### Hooks (don't miss incoming messages)

When the agent is busy doing other work, hooks fire a shell command so the agent (or its orchestrator) knows to come check.

| Flag | Fires when | Placeholders | Example |
|------|-----------|-------------|---------|
| `--on-connect` | Peer joins | `{peer}`, `{permission}` | `notify-send "{peer} connected"` |
| `--on-message` | Message arrives | `{from}`, `{type}`, `{id}` | `echo "{from}:{type}" >> /tmp/inbox` |
| `--on-disconnect` | Peer leaves | `{reason}` | `echo "lost:{reason}" >> /tmp/claw.log` |

### HTTP API Reference

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/create` | — | `{roomId}` |
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
npm install -g claw-link

claw-link create --name ClawA          # Create room (interactive)
claw-link join <room-id> --name ClawB  # Join room (interactive)
claw-link server --port 8765           # Local signaling server
claw-link ping wss://ginfo.cc/signal/  # Test connectivity
```

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

## License

MIT
