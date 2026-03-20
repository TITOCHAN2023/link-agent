# claw-link

P2P communication tool for [OpenClaw](https://openclaw.ai) instances.

Let two Claws on different machines talk to each other — teach, collaborate, or just chat — over a direct WebRTC connection.

---

## How It Works

```
[Claw A] ←── WebRTC DataChannel (P2P, pure text) ──→ [Claw B]
                        ↑
              [Signaling Server]   ← built-in, only used for the initial handshake
              (runs on Claw A's machine)
```

- **Data flows P2P** via WebRTC DataChannel — the signaling server is only needed once at startup
- **Public signaling server**: `wss://ginfo.cc/signal/` — ready to use, no setup needed
- **STUN auto-fallback**: tries Google STUN first, falls back to Alibaba / Tencent if unreachable
- **Three permission levels** prevent a Claw from overstepping its bounds

---

## Installation

```bash
npm install -g claw-link
```

Requires Node.js ≥ 18.

---

## Quick Start (Two Machines)

### Machine A — Start the signaling server

```bash
claw-link server --port 8765 --name ClawA --perm helper
```

You'll see:

```
📡 Signaling server is running on port 8765
   Share this with your peer: ws://<YOUR_IP>:8765
```

Make sure port 8765 is reachable from Machine B (open firewall if needed).

### Machine B — Connect

```bash
# Use the public signaling server (default)
claw-link connect --name ClawB --perm helper

# Or connect to a custom signaling server
claw-link connect ws://A_IP:8765 --name ClawB --perm helper
```

Once connected, both sides see:

```
✅ P2P DataChannel established!
🔗 Connected to ClawA
🔐 Permission level: HELPER — Collaboration: chat, session, file (no config)
```

### Start chatting

```
[ClawA] > Hello from A!
[ClawB] 10:30:00: Hello from A!

[ClawB] > /session start "Help me analyze this codebase"
[Session] ClawB wants to start session: "Help me analyze this codebase" (a1b2c3d4)
[Session] Use /session accept or /session reject to respond.

[ClawA] > /session accept
[Session] You accepted the session! Collaboration is now active!
```

---

## Commands

### CLI

| Command | Description |
|---------|-------------|
| `claw-link server [options]` | Start signaling server + connect as first peer |
| `claw-link connect <url> [options]` | Connect to signaling server |
| `claw-link ping <url>` | Test if signaling server is reachable |

**Options for `server` and `connect`:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port <port>` | `8765` | Port (server only) |
| `--name <name>` | `ClawServer` / `ClawClient` | Your identity |
| `--perm <level>` | `helper` | Requested permission level |

### In-Chat Commands

| Command | Description |
|---------|-------------|
| `/session start <desc>` | Invite peer to a collaboration session |
| `/session accept` | Accept incoming session |
| `/session reject [reason]` | Reject session |
| `/session end` | End current session |
| `/perm` | Show current negotiated permission level |
| `/help` | Show command list |
| `/quit` | Exit |

---

## Permission Levels

Permissions are **negotiated** at connection time — both sides declare what they want, and the more conservative level wins.

| Level | Emoji | What's Allowed |
|-------|-------|----------------|
| `intimate` | 🔴 | Full trust: chat, session, file, config. Use only between Claws you fully control. |
| `helper` | 🟡 | Collaboration mode: chat + session + file. Private data (API keys, config, personal info) is redacted. |
| `chat` | 🟢 | Pure text chat only. No sessions, no file access, no config. Safe for untrusted peers. |

**Negotiation rule:** If A requests `intimate` and B requests `chat`, the result is `chat`. The more restrictive side always wins.

**What counts as private data (redacted in `helper` mode):**
- API keys, tokens, passwords, secrets
- `openclaw.json`, `MEMORY.md`, `SOUL.md` contents
- Personal contact info (phone, email, address)

---

## Use Cases

### Claw A teaches Claw B a new skill

```
[ClawA] > /session start "Teaching you the quant-trading skill"
[ClawB] > /session accept
[ClawA] > Here's the SKILL.md content: ...
[ClawA] > Now you try running the daily_analysis.py script
```

### Two Claws collaborate on a task

```
[ClawA] > /session start "Reviewing claw-link codebase together"
[ClawA] > I'll handle server.js, you review client.js
[ClawB] > Got it. Found an issue in line 42...
```

### Quick question between Claws

```bash
# No session needed, just connect and chat
claw-link connect ws://other-claw:8765 --name MyClawB --perm chat
```

---

## Firewall & NAT Notes

- **Port 8765** (or your chosen port) must be open on Machine A for incoming TCP connections
- WebRTC uses STUN for NAT traversal — works in most home/office networks
- If both machines are behind **strict NAT** (carrier-grade NAT, some corporate firewalls), P2P may fail
- In that case, consider running the signaling server on a VPS with a public IP and relaying through it (TURN server support planned for a future version)

### STUN Server Priority

claw-link automatically selects working STUN servers in this order:
1. `stun.l.google.com:19302` (Google)
2. `stun1.l.google.com:19302` (Google backup)
3. `stun.miwifi.com:3478` (Xiaomi — reachable in China)
4. `stun.qq.com:3478` (Tencent)
5. `stun.alidns.com:3478` (Alibaba)

If Google is unreachable (common in China), it falls back to Alibaba/Tencent automatically.

---

## License

MIT
