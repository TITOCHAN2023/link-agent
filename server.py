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
  - Rate limit: 30 msgs/sec per connection
  - IP cooldown: 3s between reconnects
  - Payload validation (SDP format, ICE fields)
  - Stale room auto-cleanup (1 hour TTL)
  - /health HTTP endpoint
"""

import asyncio
import json
import logging
import os
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
# Room
# ---------------------------------------------------------------------------
class Room:
    __slots__ = ("room_id", "peers", "lock", "last_active")

    def __init__(self, room_id: str):
        self.room_id = room_id
        self.peers: list[ServerConnection] = []
        self.lock = asyncio.Lock()
        self.last_active = time.monotonic()

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
        self._rate_tracks: dict[int, deque] = {}

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

    def _check_rate(self, ws: ServerConnection) -> bool:
        now = time.monotonic()
        cid = id(ws)
        if cid not in self._rate_tracks:
            self._rate_tracks[cid] = deque()
        bucket = self._rate_tracks[cid]
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

    def _parse_room_id(self, path: str) -> tuple[str | None, bool]:
        """Parse URL path → (room_id, is_creator).

        /             → (None, True)    create new room
        /signal/      → (None, True)    create new room (behind nginx)
        /abc123       → ("abc123", False)
        /signal/abc   → ("abc", False)  (behind nginx)
        """
        parts = [p for p in path.strip("/").split("/") if p]
        # Strip "signal" prefix (nginx proxy)
        if parts and parts[0] == "signal":
            parts = parts[1:]
        if not parts:
            return None, True
        return parts[0], False

    async def _get_or_create_room(self, room_id: str | None) -> tuple[Room | None, str]:
        """Returns (room, room_id). room is None if at capacity or not found."""
        async with self.global_lock:
            if room_id is not None:
                # Joining existing room
                room = self.rooms.get(room_id)
                if room is None:
                    return None, room_id
                return room, room_id
            # Creating new room
            if len(self.rooms) >= MAX_ROOMS:
                return None, ""
            new_id = secrets.token_hex(4)
            room = Room(new_id)
            self.rooms[new_id] = room
            log.info("Room '%s' created (%d total)", new_id, len(self.rooms))
            return room, new_id

    async def _cleanup_stale_rooms(self):
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            stale = []
            async with self.global_lock:
                for rid, room in self.rooms.items():
                    if room.empty and (now - room.last_active) > ROOM_TTL_SEC:
                        stale.append(rid)
                for rid in stale:
                    del self.rooms[rid]
            if stale:
                log.info("Cleaned %d stale room(s)", len(stale))
            # Clean old cooldown entries
            cutoff = now - COOLDOWN_SEC * 10
            expired = [ip for ip, t in self._recent_ips.items() if t < cutoff]
            for ip in expired:
                del self._recent_ips[ip]

    # -- connection handler -------------------------------------------------

    async def handler(self, ws: ServerConnection) -> None:
        ip, port = ws.remote_address[0], ws.remote_address[1]
        path = ws.request.path if ws.request else "/"

        parsed_id, is_creator = self._parse_room_id(path)
        log.info("Connection from %s:%s path='%s' creator=%s", ip, port, path, is_creator)

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
            if parsed_id is not None:
                msg = f"Room '{parsed_id}' not found"
            else:
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
            log.info("[%s] Peer #1 (offerer) from %s:%s", room_id, ip, port)
        else:
            await self._send(ws, {
                "type": "ready",
                "payload": {"role": "answerer", "roomId": room_id, "message": "Peer found!"},
            })
            offerer = room.other(ws)
            if offerer:
                await self._send(offerer, {"type": "peer-joined"})
            log.info("[%s] Peer #2 (answerer) from %s:%s", room_id, ip, port)

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
                    log.warning("[%s] REJECT type '%s' from %s", room_id, msg_type, ip)
                    await self._send(ws, {"type": "error", "payload": f"Type '{msg_type}' not allowed"})
                    continue
                if not self._check_rate(ws):
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
                    log.info("[%s] FWD %s %s → %s", room_id, msg_type, ip, other.remote_address[0])

        except websockets.exceptions.ConnectionClosed as exc:
            log.info("[%s] Closed (%s) %s:%s", room_id, exc, ip, port)
        finally:
            async with room.lock:
                if ws in room.peers:
                    room.peers.remove(ws)
                other = room.other(ws) if room.peers else None
                if other:
                    await self._send(other, {"type": "peer-left"})
                    room.peers.clear()
                    log.info("[%s] Peer left, notified other, room reset", room_id)

            self._recent_ips[ip] = time.monotonic()
            self._rate_tracks.pop(id(ws), None)

            if room.empty:
                room.touch()

            log.info("[%s] %s:%s removed – %d in room", room_id, ip, port, len(room.peers))

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
            log.info("Max rooms: %d | Rate: %d msg/s | Cooldown: %ds | TTL: %ds",
                     MAX_ROOMS, RATE_LIMIT, COOLDOWN_SEC, ROOM_TTL_SEC)
            await stop_event.wait()

        cleanup_task.cancel()
        log.info("Server stopped.")


def main() -> None:
    server = SignalingServer()
    asyncio.run(server.start())


if __name__ == "__main__":
    main()
