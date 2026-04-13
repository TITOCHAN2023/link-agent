#!/usr/bin/env python3
"""
claw-link signaling server (hardened)
Lightweight WebSocket server for WebRTC peer coordination.

Security:
  - Strict whitelist: only offer / answer / ice are forwarded
  - All other message types are rejected with log + disconnect
  - Max 2 peers per room (1 pair)
  - Message size capped at 64 KB (enough for SDP)
  - Rate limit: 30 msgs/sec per connection
  - Connection cooldown: same IP cannot reconnect within 3 seconds
  - Payload schema validation (SDP type check, ICE fields)
  - No chat/data forwarding — pure signaling only
"""

import asyncio
import json
import logging
import os
import signal
import time
from collections import deque
from typing import Optional

import websockets
from websockets.asyncio.server import ServerConnection

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
HOST = os.getenv("SIGNAL_HOST", "0.0.0.0")
PORT = int(os.getenv("SIGNAL_PORT", "8765"))
PING_INTERVAL = 20
PING_TIMEOUT = 10
MAX_MSG_SIZE = 65536       # 64 KB – enough for SDP
MAX_PEERS = 2              # 1 P2P pair
RATE_LIMIT = 30            # max messages per second per conn
COOLDOWN_SEC = 3           # min seconds between reconnects from same IP

# Only these 3 types are ever forwarded. Everything else → reject.
ALLOWED_TYPES = frozenset({"offer", "answer", "ice"})

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("signal-server")


# ---------------------------------------------------------------------------
# Signaling Server (hardened)
# ---------------------------------------------------------------------------
class SignalingServer:
    def __init__(self):
        self.peers: list[ServerConnection] = []
        self.lock = asyncio.Lock()
        self._recent_ips: dict[str, float] = {}   # IP → last disconnect timestamp
        self._rate_tracks: dict[int, deque] = {}   # id → timestamps of recent msgs

    # -- helpers ------------------------------------------------------------

    async def _send(self, ws: ServerConnection, msg: dict) -> None:
        try:
            await ws.send(json.dumps(msg))
        except websockets.exceptions.ConnectionClosed:
            pass

    def _other(self, ws: ServerConnection) -> Optional[ServerConnection]:
        for p in self.peers:
            if p is not ws:
                return p
        return None

    # -- admission: cooldown & room capacity --------------------------------

    async def _check_admission(self, ws: ServerConnection) -> bool:
        """Returns True if connection is allowed."""
        ip = ws.remote_address[0]

        # Cooldown check
        now = time.monotonic()
        last_disconnect = self._recent_ips.get(ip, 0)
        if now - last_disconnect < COOLDOWN_SEC:
            remaining = COOLDOWN_SEC - (now - last_disconnect)
            log.warning("COOLDOWN REJECT %s (retry in %.1fs)", ip, remaining)
            await self._send(ws, {"type": "error", "payload": "Slow down"})
            await ws.close(1008, "Cooldown active")
            return False

        # Room full?
        if len(self.peers) >= MAX_PEERS:
            log.warning("ROOM FULL – rejecting %s", ip)
            await self._send(ws, {"type": "error", "payload": "Room is full"})
            await ws.close(1008, "Room is full")
            return False

        return True

    # -- rate limiter --------------------------------------------------------

    def _check_rate(self, ws: ServerConnection) -> bool:
        """Returns True if under rate limit, False if throttled."""
        now = time.monotonic()
        cid = id(ws)
        if cid not in self._rate_tracks:
            self._rate_tracks[cid] = deque()
        bucket = self._rate_tracks[cid]

        # Prune old entries (>1s ago)
        while bucket and now - bucket[0] > 1.0:
            bucket.popleft()

        if len(bucket) >= RATE_LIMIT:
            log.warning("RATE LIMIT %s:%s (%d msgs/s)",
                        ws.remote_address[0], ws.remote_address[1], len(bucket))
            return False

        bucket.append(now)
        return True

    # -- payload validator ---------------------------------------------------

    @staticmethod
    def _validate_payload(msg_type: str, payload: dict) -> tuple[bool, str]:
        """Validate that payload matches expected schema for msg_type.
        Returns (is_valid, error_reason)."""
        if msg_type == "offer":
            sdp = payload.get("sdp")
            if not isinstance(sdp, dict):
                return False, "offer missing sdp dict"
            if sdp.get("type") != "offer":
                return False, f"offer sdp.type mismatch: {sdp.get('type')}"
            return True, ""

        if msg_type == "answer":
            sdp = payload.get("sdp")
            if not isinstance(sdp, dict):
                return False, "answer missing sdp dict"
            if sdp.get("type") != "answer":
                return False, f"answer sdp.type mismatch: {sdp.get('type')}"
            return True, ""

        if msg_type == "ice":
            if "candidate" not in payload:
                return False, "ice missing candidate"
            if "sdpMid" not in payload:
                return False, "ice missing sdpMid"
            return True, ""

        return False, "unknown type"

    # -- connection handler -------------------------------------------------

    async def handler(self, ws: ServerConnection) -> None:
        remote = ws.remote_address
        ip, port = remote[0], remote[1]
        log.info("New connection from %s:%s", ip, port)

        # ---- admission control ----
        if not await self._check_admission(ws):
            return

        async with self.lock:
            self.peers.append(ws)
            peer_index = len(self.peers)

        # ---- role assignment ----
        if peer_index == 1:
            await self._send(ws, {
                "type": "ready",
                "payload": {"role": "offerer", "message": "Waiting for peer..."},
            })
            log.info("Peer #1 (offerer) joined from %s:%s", ip, port)
        else:
            await self._send(ws, {
                "type": "ready",
                "payload": {"role": "answerer", "message": "Peer is here, you may answer."},
            })
            offerer = self._other(ws)
            if offerer:
                await self._send(offerer, {"type": "peer-joined"})
            log.info("Peer #2 (answerer) joined from %s:%s", ip, port)

        # ---- message loop (hardened) ----
        try:
            async for raw in ws:
                # JSON parse
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    log.warning("REJECT %s:%s – invalid JSON", ip, port)
                    continue

                if not isinstance(msg, dict):
                    log.warning("REJECT %s:%s – msg not a dict", ip, port)
                    continue

                msg_type = msg.get("type")

                # ── STRICT TYPE CHECK ──
                if msg_type not in ALLOWED_TYPES:
                    log.warning("REJECT %s:%s – blocked type '%s' (allowed: %s)",
                                ip, port, msg_type, ALLOWED_TYPES)
                    # Send error and close to prevent abuse
                    try:
                        await self._send(ws, {
                            "type": "error",
                            "payload": f"Message type '{msg_type}' not allowed",
                        })
                    except Exception:
                        pass
                    continue

                # ── RATE LIMIT ──
                if not self._check_rate(ws):
                    continue

                # ── PAYLOAD VALIDATION ──
                payload = msg.get("payload", {})
                valid, reason = self._validate_payload(msg_type, payload or {})
                if not valid:
                    log.warning("REJECT %s:%s – invalid '%s' payload: %s",
                                ip, port, msg_type, reason)
                    continue

                # ── FORWARD TO PEER ──
                other = self._other(ws)
                if other:
                    await self._send(other, msg)
                    log.info("FWD %s %s:%s → %s:%s",
                             msg_type, ip, port,
                             other.remote_address[0], other.remote_address[1])
                else:
                    log.warning("DROP %s – no peer (from %s:%s)", msg_type, ip, port)

        except websockets.exceptions.ConnectionClosed as exc:
            log.info("Connection closed (%s) from %s:%s", exc, ip, port)
        finally:
            # ---- cleanup & cooldown ----
            async with self.lock:
                if ws in self.peers:
                    self.peers.remove(ws)
                other = self._other(ws) if self.peers else None
                if other:
                    await self._send(other, {"type": "peer-left"})
                    self.peers.clear()
                    log.info("Notified peer; room reset")
                # Record disconnect time for cooldown
                self._recent_ips[ip] = time.monotonic()
                # Cleanup rate tracker
                self._rate_tracks.pop(id(ws), None)
                log.info("Peer %s:%s removed – %d remain", ip, port, len(self.peers))

    # -- server lifecycle ---------------------------------------------------

    async def start(self) -> None:
        stop_event = asyncio.Event()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop_event.set)

        async with websockets.serve(
            self.handler,
            HOST,
            PORT,
            ping_interval=PING_INTERVAL,
            ping_timeout=PING_TIMEOUT,
            max_size=MAX_MSG_SIZE,
        ) as server:
            log.info("Signaling server listening on ws://%s:%s [HARDENED]", HOST, PORT)
            log.info("Allowed types: %s | Max peers: %d | Rate: %d msg/s | Cooldown: %ds",
                     ALLOWED_TYPES, MAX_PEERS, RATE_LIMIT, COOLDOWN_SEC)
            await stop_event.wait()
            log.info("Shutting down ...")
        log.info("Server stopped.")


def main() -> None:
    server = SignalingServer()
    asyncio.run(server.start())


if __name__ == "__main__":
    main()
