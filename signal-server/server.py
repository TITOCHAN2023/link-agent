#!/usr/bin/env python3
"""
claw-link signaling server
Lightweight WebSocket server for WebRTC peer coordination.

Supports exactly one room with up to 2 peers.
Messages of type offer/answer/ice are forwarded to the other peer.
"""

import asyncio
import json
import logging
import os
import signal
import time
from typing import Optional

import websockets
from websockets.asyncio.server import ServerConnection

# ---------------------------------------------------------------------------
# Configuration (override via environment variables)
# ---------------------------------------------------------------------------
HOST = os.getenv("SIGNAL_HOST", "0.0.0.0")
PORT = int(os.getenv("SIGNAL_PORT", "8765"))
PING_INTERVAL = 20    # seconds – keepalive ping
PING_TIMEOUT = 10     # seconds – ping reply timeout
MAX_MSG_SIZE = 65536  # 64 KB, enough for SDP

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
# Signaling Server
# ---------------------------------------------------------------------------
class SignalingServer:
    def __init__(self):
        self.peers: list[ServerConnection] = []  # at most 2
        self.lock = asyncio.Lock()

    # -- helpers ------------------------------------------------------------

    async def _send(self, ws: ServerConnection, msg: dict) -> None:
        """Send a JSON message, silently ignoring closed connections."""
        try:
            await ws.send(json.dumps(msg))
        except websockets.exceptions.ConnectionClosed:
            pass

    def _other(self, ws: ServerConnection) -> Optional[ServerConnection]:
        """Return the other peer, or None."""
        for p in self.peers:
            if p is not ws:
                return p
        return None

    # -- connection handler -------------------------------------------------

    async def handler(self, ws: ServerConnection) -> None:
        remote = ws.remote_address
        log.info("New connection from %s:%s", remote[0], remote[1])

        # ---- admission control ----
        async with self.lock:
            if len(self.peers) >= 2:
                log.warning("Room full – rejecting %s:%s", remote[0], remote[1])
                await self._send(ws, {"type": "error", "payload": "Room is full"})
                await ws.close(1008, "Room is full")
                return
            self.peers.append(ws)
            peer_index = len(self.peers)  # 1 = offerer, 2 = answerer

        # ---- role assignment ----
        if peer_index == 1:
            # First peer → offerer, wait for the other side
            await self._send(ws, {
                "type": "ready",
                "payload": {"role": "offerer", "message": "Waiting for peer..."},
            })
            log.info("Peer #1 (offerer) joined from %s:%s", remote[0], remote[1])
        else:
            # Second peer → answerer, and notify the offerer
            await self._send(ws, {
                "type": "ready",
                "payload": {"role": "answerer", "message": "Peer is here, you may answer."},
            })
            offerer = self._other(ws)
            if offerer:
                await self._send(offerer, {"type": "peer-joined"})
            log.info("Peer #2 (answerer) joined from %s:%s", remote[0], remote[1])

        # ---- message loop ----
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("Invalid JSON from %s:%s", remote[0], remote[1])
                    continue

                msg_type = msg.get("type")
                if msg_type in ("offer", "answer", "ice"):
                    other = self._other(ws)
                    if other:
                        await self._send(other, msg)
                        log.info("Forwarded '%s' from %s:%s → %s:%s",
                                 msg_type,
                                 remote[0], remote[1],
                                 other.remote_address[0], other.remote_address[1])
                    else:
                        log.warning("No peer to forward '%s' to", msg_type)
                else:
                    log.warning("Unknown message type '%s' from %s:%s",
                                msg_type, remote[0], remote[1])

        except websockets.exceptions.ConnectionClosed as exc:
            log.info("Connection closed (%s) from %s:%s", exc, remote[0], remote[1])
        finally:
            # ---- cleanup ----
            async with self.lock:
                if ws in self.peers:
                    self.peers.remove(ws)
                other = self._other(ws) if self.peers else None
                # Notify the remaining peer and reset the room so a new pair
                # can connect.
                if other:
                    await self._send(other, {"type": "peer-left"})
                    self.peers.clear()
                    log.info("Notified remaining peer of disconnect; room reset")
                log.info("Peer from %s:%s removed – %d peer(s) remain",
                         remote[0], remote[1], len(self.peers))

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
            log.info("Signaling server listening on ws://%s:%s", HOST, PORT)
            await stop_event.wait()
            log.info("Shutting down gracefully ...")

        log.info("Server stopped.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    server = SignalingServer()
    asyncio.run(server.start())


if __name__ == "__main__":
    main()
