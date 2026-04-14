#!/usr/bin/env python3
"""
claw-link signaling server

Multi-room WebSocket server for WebRTC peer coordination.

Room flow:
  1. Peer A connects to /           → server generates roomId, returns in ready
  2. Peer A shares roomId out-of-band
  3. Peer B connects to /<roomId>   → server matches, P2P handshake begins

Behind nginx at /signal/:
  Peer A → wss://ginfo.cc/signal/          → path "/" → new room
  Peer B → wss://ginfo.cc/signal/<roomId>  → path "/<roomId>" → join room

Security:
  - Type whitelist: only offer / answer / ice forwarded
  - Rate limit: 30 msgs/sec per real client IP (X-Forwarded-For aware)
  - IP cooldown: 3s between reconnects
  - Room ID validation: alphanumeric + hyphen/underscore, max 32 chars
  - Payload validation (SDP format, ICE fields)
  - Stale room auto-cleanup (1 hour TTL, 2 hour hard limit)
  - /health HTTP endpoint

Nginx or other reverse proxy NEED TO CONFIGURE:                                                                                                                                                                   
  proxy_set_header X-Real-IP $remote_addr;                                                                                                                              
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;    
"""

import asyncio
import json
import logging
import os
import re
import secrets
import signal
import time
from collections import deque
from http import HTTPStatus

import websockets
from websockets.asyncio.server import ServerConnection

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
HOST = os.getenv("SIGNAL_HOST", "0.0.0.0")
PORT = int(os.getenv("SIGNAL_PORT", "8765"))
PING_INTERVAL = 20
PING_TIMEOUT = 10
MAX_MSG_SIZE = 65536
MAX_PEERS_PER_ROOM = 2
MAX_ROOMS = 100
RATE_LIMIT = 30
COOLDOWN_SEC = 3
ROOM_TTL_SEC = 3600
ROOM_HARD_TTL_SEC = 7200  # Absolute max age, even if room has peers

ALLOWED_TYPES = frozenset({"offer", "answer", "ice"})
ROOM_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,32}$")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("signal-server")


def _sanitize_log(s: str) -> str:
    """Strip control characters to prevent log injection."""
    return re.sub(r"[\x00-\x1f\x7f]", "", s)[:200]


# ---------------------------------------------------------------------------
# Real IP extraction (nginx proxy aware)
# ---------------------------------------------------------------------------
def _get_real_ip(ws: ServerConnection) -> str:
    """Extract the real client IP, respecting X-Forwarded-For / X-Real-IP
    headers set by a trusted reverse proxy (nginx).

    Falls back to ws.remote_address for direct connections.
    """
    headers = ws.request.headers if ws.request else {}

    # X-Real-IP is set by nginx, single IP, most reliable
    real_ip = headers.get("X-Real-IP")
    if real_ip:
        return real_ip.strip()

    # X-Forwarded-For: client, proxy1, proxy2 — take the first (leftmost)
    xff = headers.get("X-Forwarded-For")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first

    return ws.remote_address[0]


# ---------------------------------------------------------------------------
# Room
# ---------------------------------------------------------------------------
class Room:
    __slots__ = ("room_id", "peers", "lock", "last_active", "created_at")

    def __init__(self, room_id: str):
        self.room_id = room_id
        self.peers: list[ServerConnection] = []
        self.lock = asyncio.Lock()
        self.last_active = time.monotonic()
        self.created_at = time.monotonic()

    def touch(self):
        self.last_active = time.monotonic()

    def other(self, ws: ServerConnection):
        for p in self.peers:
            if p is not ws:
                return p
        return None

    @property
    def empty(self):
        return len(self.peers) == 0


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
class SignalingServer:
    def __init__(self):
        self.rooms: dict[str, Room] = {}
        self.global_lock = asyncio.Lock()
        self._recent_ips: dict[str, float] = {}
        self._rate_tracks: dict[str, deque] = {}  # keyed by real IP

    # -- helpers ------------------------------------------------------------

    @staticmethod
    async def _send(ws: ServerConnection, msg: dict) -> None:
        try:
            await ws.send(json.dumps(msg))
        except websockets.exceptions.ConnectionClosed:
            pass

    def _check_cooldown(self, ip: str) -> float:
        now = time.monotonic()
        last = self._recent_ips.get(ip, 0)
        return max(0, COOLDOWN_SEC - (now - last))

    def _check_rate(self, ip: str) -> bool:
        """Rate-limit by real client IP, not per-connection."""
        now = time.monotonic()
        if ip not in self._rate_tracks:
            self._rate_tracks[ip] = deque()
        bucket = self._rate_tracks[ip]
        while bucket and now - bucket[0] > 1.0:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT:
            return False
        bucket.append(now)
        return True

    @staticmethod
    def _validate_payload(msg_type: str, payload) -> tuple[bool, str]:
        if msg_type in ("offer", "answer"):
            if not isinstance(payload, str):
                return False, f"{msg_type} payload must be string"
            if not payload.startswith("v="):
                return False, f"{msg_type} SDP malformed"
            return True, ""
        if msg_type == "ice":
            if not isinstance(payload, dict):
                return False, "ice payload must be dict"
            if "candidate" not in payload:
                return False, "ice missing candidate"
            if "sdpMid" not in payload:
                return False, "ice missing sdpMid"
            return True, ""
        return False, "unknown type"

    # -- room management ----------------------------------------------------

    def _parse_room_id(self, path: str) -> str | None:
        """Parse URL path → room_id or None (auto-generate).

        /             → None
        /signal/      → None       (behind nginx)
        /abc123       → "abc123"
        /signal/abc   → "abc"      (behind nginx)
        """
        parts = [p for p in path.strip("/").split("/") if p]
        if parts and parts[0] == "signal":
            parts = parts[1:]
        return parts[0] if parts else None

    async def _get_or_create_room(self, room_id: str | None) -> tuple[Room | None, str]:
        """Returns (room, room_id). room is None only if at capacity."""
        async with self.global_lock:
            if len(self.rooms) >= MAX_ROOMS and (room_id is None or room_id not in self.rooms):
                return None, room_id or ""
            # Use provided ID or generate one
            rid = room_id or secrets.token_hex(4)
            if rid not in self.rooms:
                self.rooms[rid] = Room(rid)
                log.info("Room '%s' created (%d total)", _sanitize_log(rid), len(self.rooms))
            return self.rooms[rid], rid

    async def _cleanup_stale_rooms(self):
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            stale = []
            to_close: list[ServerConnection] = []
            async with self.global_lock:
                for rid, room in self.rooms.items():
                    idle = now - room.last_active
                    age = now - room.created_at
                    # Empty + idle beyond TTL → stale
                    if room.empty and idle > ROOM_TTL_SEC:
                        stale.append(rid)
                    # Any room beyond hard TTL → force close (prevent zombie rooms)
                    elif age > ROOM_HARD_TTL_SEC:
                        stale.append(rid)
                        to_close.extend(room.peers)
                for rid in stale:
                    del self.rooms[rid]
            if stale:
                log.info("Cleaned %d stale room(s)", len(stale))
            # Close zombie connections outside the lock
            for ws in to_close:
                try:
                    await ws.close(1001, "Room expired")
                except Exception:
                    pass
            # Clean old cooldown entries
            cutoff = now - COOLDOWN_SEC * 10
            expired_ips = [ip for ip, t in self._recent_ips.items() if t < cutoff]
            for ip in expired_ips:
                del self._recent_ips[ip]
            # Clean old rate-limit buckets (no activity for 10s)
            expired_rates = [ip for ip, bkt in self._rate_tracks.items() if not bkt or now - bkt[-1] > 10]
            for ip in expired_rates:
                del self._rate_tracks[ip]

    # -- connection handler -------------------------------------------------

    async def handler(self, ws: ServerConnection) -> None:
        ip = _get_real_ip(ws)
        path = ws.request.path if ws.request else "/"
        safe_path = _sanitize_log(path)

        parsed_id = self._parse_room_id(path)
        log.info("Connection from %s path='%s' room=%s", ip, safe_path, _sanitize_log(parsed_id or "(auto)"))

        # Validate room ID format
        if parsed_id is not None and not ROOM_ID_RE.match(parsed_id):
            log.warning("REJECT invalid room ID '%s' from %s", _sanitize_log(parsed_id), ip)
            await self._send(ws, {"type": "error", "payload": "Invalid roomId: only alphanumeric, hyphen and underscore allowed (max 32 chars)"})
            await ws.close(1008, "Invalid roomId")
            return

        # Cooldown
        remaining = self._check_cooldown(ip)
        if remaining > 0:
            log.warning("COOLDOWN %s (%.1fs)", ip, remaining)
            await self._send(ws, {"type": "error", "payload": "Slow down"})
            await ws.close(1008, "Cooldown")
            return

        # Get/create room
        room, room_id = await self._get_or_create_room(parsed_id)
        if room is None:
            msg = "Server at capacity"
            log.warning("REJECT %s: %s", ip, msg)
            await self._send(ws, {"type": "error", "payload": msg})
            await ws.close(1008, msg)
            return

        # Join room
        async with room.lock:
            if len(room.peers) >= MAX_PEERS_PER_ROOM:
                log.warning("[%s] Room full, reject %s", room_id, ip)
                await self._send(ws, {"type": "error", "payload": "Room is full"})
                await ws.close(1008, "Room full")
                return
            room.peers.append(ws)
            room.touch()
            peer_index = len(room.peers)

        # Role assignment — always include roomId
        if peer_index == 1:
            await self._send(ws, {
                "type": "ready",
                "payload": {"role": "offerer", "roomId": room_id, "message": "Waiting for peer..."},
            })
            log.info("[%s] Peer #1 (offerer) from %s", room_id, ip)
        else:
            await self._send(ws, {
                "type": "ready",
                "payload": {"role": "answerer", "roomId": room_id, "message": "Peer found!"},
            })
            offerer = room.other(ws)
            if offerer:
                await self._send(offerer, {"type": "peer-joined"})
            log.info("[%s] Peer #2 (answerer) from %s", room_id, ip)

        # Message loop
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                if not isinstance(msg, dict):
                    continue

                msg_type = msg.get("type")
                if msg_type not in ALLOWED_TYPES:
                    log.warning("[%s] REJECT type '%s' from %s", room_id, _sanitize_log(str(msg_type)), ip)
                    await self._send(ws, {"type": "error", "payload": f"Type '{msg_type}' not allowed"})
                    continue
                if not self._check_rate(ip):
                    continue

                payload = msg.get("payload")
                if payload is None:
                    continue
                valid, reason = self._validate_payload(msg_type, payload)
                if not valid:
                    log.warning("[%s] REJECT %s: %s", room_id, msg_type, reason)
                    continue

                room.touch()
                other = room.other(ws)
                if other:
                    await self._send(other, msg)

        except websockets.exceptions.ConnectionClosed as exc:
            log.info("[%s] Closed (%s) %s", room_id, exc, ip)
        finally:
            async with room.lock:
                if ws in room.peers:
                    room.peers.remove(ws)
                # Notify remaining peer — but do NOT clear them from the room.
                # They stay tracked so they can be paired with a reconnecting peer.
                for p in room.peers:
                    await self._send(p, {"type": "peer-left"})

            self._recent_ips[ip] = time.monotonic()

            if room.empty:
                room.touch()

            log.info("[%s] %s removed – %d in room", room_id, ip, len(room.peers))

    # -- HTTP health --------------------------------------------------------

    async def _health_check(self, path, headers):
        if path == "/health":
            body = json.dumps({
                "status": "ok",
                "rooms": len(self.rooms),
                "rooms_active": sum(1 for r in self.rooms.values() if not r.empty),
            }).encode()
            return HTTPStatus.OK, [("Content-Type", "application/json")], body
        return None

    # -- lifecycle ----------------------------------------------------------

    async def start(self) -> None:
        stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop_event.set)

        cleanup_task = asyncio.create_task(self._cleanup_stale_rooms())

        async with websockets.serve(
            self.handler, HOST, PORT,
            ping_interval=PING_INTERVAL,
            ping_timeout=PING_TIMEOUT,
            max_size=MAX_MSG_SIZE,
            process_request=self._health_check,
        ) as server:
            log.info("Signaling server on ws://%s:%s", HOST, PORT)
            log.info("Max rooms: %d | Rate: %d msg/s | Cooldown: %ds | TTL: %ds | Hard TTL: %ds",
                     MAX_ROOMS, RATE_LIMIT, COOLDOWN_SEC, ROOM_TTL_SEC, ROOM_HARD_TTL_SEC)
            await stop_event.wait()

        cleanup_task.cancel()
        log.info("Server stopped.")


def main() -> None:
    server = SignalingServer()
    asyncio.run(server.start())


if __name__ == "__main__":
    main()
