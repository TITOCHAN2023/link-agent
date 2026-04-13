# claw-link signaling server

WebSocket signaling server for [claw-link](https://github.com/TITOCHAN2023/ClawLink) WebRTC peer coordination.

Only handles the initial handshake (offer/answer/ICE exchange). All data flows P2P after connection is established.

---

## Files

| File | Description |
|------|-------------|
| `server.py` | Standard signaling server |
| `server_hardened.py` | Production server with rate limiting, payload validation, IP cooldown |
| `requirements.txt` | Python dependencies |
| `claw-link-signal.service` | systemd service file for deployment |

---

## Quick Start

```bash
pip install -r requirements.txt

# Standard
python server.py

# Production (hardened)
python server_hardened.py
```

Default: `ws://0.0.0.0:8765`

---

## Configuration (env vars)

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNAL_HOST` | `0.0.0.0` | Bind address |
| `SIGNAL_PORT` | `8765` | Listen port |

Hardened server additional limits:
- Rate limit: 30 msg/s per connection
- IP cooldown: 3s between reconnects
- Strict type whitelist: only `offer`, `answer`, `ice`
- Max message size: 64 KB

---

## Deploy with systemd

```bash
cp server_hardened.py /opt/claw-link-signal/server.py
cp claw-link-signal.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now claw-link-signal
```

---

## Nginx reverse proxy (WSS)

```nginx
location /signal/ {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400;
}
```

---

## Protocol

| Message | Direction | Payload |
|---------|-----------|---------|
| `ready` | server -> client | `{role, message}` |
| `peer-joined` | server -> client | _(none)_ |
| `offer` | client -> client | raw SDP string |
| `answer` | client -> client | raw SDP string |
| `ice` | client -> client | `{candidate, sdpMid, sdpMLineIndex}` |
| `peer-left` | server -> client | _(none)_ |
| `error` | server -> client | error string |

---

## License

MIT
