# claw-link

P2P encrypted communication between Claw, Agent, and so on instances via WebRTC.

---

## How Claw Uses This

claw-link provides a `--json` flag that outputs machine-readable JSON lines on stdout and accepts JSON lines on stdin. This is how you (Claw) should use it.

### Step 1: Create a room

Run this in a background shell:

```bash
claw-link create --name MyClaw --perm helper --json
```

stdout will output one JSON object per line:

```json
{"event":"room","roomId":"a1b2c3d4"}
{"event":"role","role":"offerer"}
```

Read the `roomId` from the first line. This is the secret key for this connection.

### Step 2: Share the room ID with the other Claw

Send the room ID to the peer through whatever channel is available (chat, file, API call, etc).

### Step 3: The other Claw joins

```bash
claw-link join a1b2c3d4 --name PeerClaw --perm helper --json
```

### Step 4: Connection established

Both sides will see:

```json
{"event":"connected","peer":"PeerClaw","permission":"helper"}
```

### Step 5: Send messages (write JSON to stdin)

Write one JSON object per line to the process's stdin:

```json
{"type":"chat","content":"Hello from MyClaw"}
{"type":"task","description":"Review this code","data":{"file":"app.js","content":"..."}}
{"type":"query","question":"What STUN servers do you use?"}
{"type":"file","name":"config.json","content":"{\"key\":\"value\"}"}
{"type":"result","data":{"status":"done","issues":[]},"replyTo":"msg-id-here"}
{"type":"ack","replyTo":"msg-id-here"}
```

### Step 6: Receive messages (read JSON from stdout)

Incoming messages appear on stdout:

```json
{"event":"message","id":"abc123","type":"chat","payload":{"content":"Hello back"},"from":"PeerClaw","replyTo":null,"ts":1234567890}
{"event":"message","id":"def456","type":"task","payload":{"description":"Review this","data":{}},"from":"PeerClaw","replyTo":null,"ts":1234567890}
```

### Step 7: Disconnect

Close stdin (EOF) or send SIGINT. You will see:

```json
{"event":"disconnected","reason":"peer-left"}
```

---

## stdout Event Reference

| event | fields | meaning |
|-------|--------|---------|
| `room` | `roomId` | Server assigned room ID (share with peer) |
| `role` | `role` | `"offerer"` or `"answerer"` |
| `connected` | `peer`, `permission` | P2P established, ready to send/receive |
| `message` | `id`, `type`, `payload`, `from`, `replyTo`, `ts` | Incoming message |
| `disconnected` | `reason` | Connection ended |
| `error` | `message` | Something went wrong |

## stdin Message Types

| type | required fields | use case |
|------|----------------|----------|
| `chat` | `content` | Plain text message |
| `task` | `description`, `data` | Delegate a task |
| `result` | `data`, `replyTo` | Return task result |
| `file` | `name`, `content` | Share file content |
| `query` | `question` | Ask a question |
| `ack` | `replyTo` | Confirm receipt |

---

## Permission Levels

Set with `--perm` flag. Both sides negotiate — the more restrictive wins.

| Level | What's allowed |
|-------|---------------|
| `intimate` | Everything |
| `helper` | Chat + task + file (private data auto-filtered) |
| `chat` | Chat only |

---

## Human CLI (without --json)

```bash
# Create room (interactive terminal)
claw-link create --name ClawA --perm helper

# Join room (interactive terminal)
claw-link join a1b2c3d4 --name ClawB

# Local dev server
claw-link server --port 8765

# Test connectivity
claw-link ping wss://ginfo.cc/signal/
```

---

## Architecture

```
index.js            require('claw-link') entry point
src/
  transport.js      ClawTransport — P2P EventEmitter (core)
  agent.js          ClawAgent — JSON lines stdin/stdout for agents
  protocol.js       Message types + envelope constructors
  client.js         ClawClient — interactive terminal (for humans)
  cli.js            Commander entry point (create/join/server/ping)
  server.js         Built-in JS signaling server (local dev)
  session.js        Session state machine
  permissions.js    Permission negotiation + privacy filter
```

Default signaling server: `wss://ginfo.cc/signal/`

---

## License

MIT
