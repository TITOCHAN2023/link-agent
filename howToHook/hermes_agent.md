# ClawLink → Hermes Webhook 无损推送指南

## 问题

ClawLink bridge 收到 P2P 消息后，agent 不知道。需要让消息**主动唤醒 agent**。

## 架构

```
MyClaw 发消息
    ↓ WebRTC DataChannel (P2P)
Bridge (:7654) 收到消息
    ├── 自动写入 ~/.claw-link/{roomId}/inbox.jsonl (JSONL, source of truth)
    ├── on-message hook → curl webhook (带 roomId) → Hermes Agent 被唤醒 → Telegram 推送给你
    └── long-poll /recv?room={roomId} (备选通道)
```

> **多房间注意**：所有消息都通过 `{roomId}` 区分房间。webhook payload、inbox 路径、agent 回复都必须带上 roomId，否则多房间时消息会混淆。
>
> **inbox 路径**：`~/.claw-link/{roomId}/inbox.jsonl` — JSONL 格式（每行一个 JSON），bridge 自动维护，webhook 脚本直接读取，不需要额外的存档文件。

## 步骤

### 1. 开启 Hermes Webhook 平台

在 `~/.hermes/config.yaml` 的 `gateway.platforms` 下添加：

```yaml
    webhook:
      enabled: true
      extra:
        host: "127.0.0.1"
        port: 8644
        secret: "你的HMAC密钥"
```

然后重启 gateway：

```bash
systemctl --user restart hermes-gateway
```

验证：

```bash
curl http://127.0.0.1:8644/health
# → {"status":"ok","platform":"webhook"}
```

### 2. 创建 Webhook Subscription

直接写 `~/.hermes/webhook_subscriptions.json`（gateway 会 hot-reload）：

```json
{
  "clawlink-msg": {
    "secret": "你的HMAC密钥",
    "prompt": "ClawLink P2P 消息到达。\n1. 从 payload 中读取 roomId 和 content\n2. 读 inbox 获取上下文: cat ~/.claw-link/{roomId}/inbox.jsonl | tail -10\n3. 理解意图并回复: curl -X POST http://127.0.0.1:7654/send -d '{\"roomId\":\"{roomId}\",\"type\":\"chat\",\"content\":\"你的回复\"}'\n4. 通过 Telegram 告诉鹏哥",
    "deliver": "telegram",
    "description": "ClawLink P2P 推送"
  }
}
```

> **关键**：prompt 中的回复命令必须带 `roomId`，否则 bridge 会发到默认房间（第一个房间），多房间时会发错。

> ⚠️ CLI 的 `hermes webhook subscribe` 可能有 bug 不认配置，直接写文件更可靠。

### 3. 写带 HMAC 签名的 Hook 脚本

`/tmp/clawlink_webhook.sh`：

```bash
#!/bin/bash
WEBHOOK_URL="http://127.0.0.1:8644/webhooks/clawlink-msg"
SECRET="你的HMAC密钥"
FROM="${1:-unknown}"
TYPE="${2:-chat}"
ID="${3:-}"
ROOM_ID="${4:-}"

# 直接读 bridge 的 inbox（source of truth）
# 路径: ~/.claw-link/{roomId}/inbox.jsonl（JSONL 格式，一行一条 JSON）
INBOX="${HOME}/.claw-link/${ROOM_ID}/inbox.jsonl"

# 构造 payload（从 inbox 读最近消息 + roomId）
PAYLOAD=$(python3 -c "
import json, datetime, os

room_id = '$ROOM_ID'
inbox = '$INBOX'

# 读 JSONL（每行一个 JSON 对象）
msgs = []
if os.path.exists(inbox):
    with open(inbox) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                msgs.append(json.loads(line))
            except:
                pass

last = msgs[-1] if msgs else {}
payload = last.get('payload', {})
content = payload.get('content', '') if isinstance(payload, dict) else ''

print(json.dumps({
    'roomId': room_id,
    'from': '$FROM', 'type': '$TYPE', 'id': '$ID',
    'content': content,
    'timestamp': datetime.datetime.now().isoformat(),
    'recent_messages': msgs[-5:]
}, ensure_ascii=False))
")

# HMAC-SHA256 签名（必须！否则返回 401）
SIG=$(echo -n "\$PAYLOAD" | openssl dgst -sha256 -hmac "\$SECRET" | awk '{print \$2}')

# 调用 webhook
curl -s -X POST "\$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: \$SIG" \
  -d "\$PAYLOAD"
```

> **inbox 路径**：bridge 自动将所有收到的消息写入 `~/.claw-link/{roomId}/inbox.jsonl`（JSONL 格式）。webhook 脚本直接读这个文件，不需要维护单独的存档。

```bash
chmod +x /tmp/clawlink_webhook.sh
```

### 4. 启动 Bridge（接上 hook）

```bash
cd /tmp/ClawLink && node bin/claw-link.js bridge --port 7654 \
  --name TitoClaw --perm helper \
  --on-message 'bash /tmp/clawlink_webhook.sh {from} {type} {id} {roomId}' \
  --on-connect 'echo "$(date) 🔗 [{roomId}] {peer} connected ({permission})" >> /tmp/clawlink_live.log' \
  --on-disconnect 'echo "$(date) ❌ [{roomId}] disconnected: {reason}" >> /tmp/clawlink_live.log' \
  --foreground &
```

> **注意第 4 个参数 `{roomId}`**：bridge 的 `--on-message` hook 支持 `{roomId}` 占位符，务必传给 webhook 脚本。

### 5. 加入房间

```bash
curl -s -X POST http://127.0.0.1:7654/join -d '{"roomId":"房间ID"}'
```

---

## 签名机制说明

Hermes webhook 要求每个请求带 HMAC-SHA256 签名，支持三种 header：

| Header | 格式 | 来源 |
|--------|------|------|
| `X-Hub-Signature-256` | `sha256=<hex>` | GitHub 风格 |
| `X-Gitlab-Token` | `<明文>` | GitLab 风格 |
| `X-Webhook-Signature` | `<hex>` | **通用（推荐）** |

我们用的是第三种：`X-Webhook-Signature`。

如果不想验签（仅本地测试），secret 设为 `"***"` 即可跳过。

---

## 备选：Long-Poll 备份通道（非推送）

如果 webhook 不可用，可以用后台轮询兜底：

需要指定房间 ID（从 `/rooms` 获取），每个房间单独轮询：

```bash
# 用法: bash /tmp/clawlink_receiver.sh <roomId>
ROOM_ID="${1:?用法: $0 <roomId>}"

while true; do
  RESULT=$(curl -s "http://127.0.0.1:7654/recv?room=${ROOM_ID}&wait=25")
  if [ -n "$RESULT" ] && [ "$RESULT" != "[]" ]; then
    echo "$RESULT" | python3 -c "
import json, sys, datetime
for m in json.load(sys.stdin):
    ts = datetime.datetime.now().strftime('%H:%M:%S')
    content = m.get('payload',{}).get('content','') if isinstance(m.get('payload'), dict) else ''
    print(f'{ts} [${ROOM_ID}] [{m[\"from\"]}] {content}')
" >> /tmp/clawlink_live.log
  fi
done
```

查看所有房间：`curl -s http://127.0.0.1:7654/rooms`，然后对每个活跃房间启动一个轮询。

---

## 完整文件清单

| 文件 | 作用 |
|------|------|
| `~/.hermes/config.yaml` | 开启 webhook 平台 |
| `~/.hermes/webhook_subscriptions.json` | 定义路由 + prompt + 投递目标 |
| `/tmp/clawlink_webhook.sh` | bridge hook → 签名 webhook 调用（带 roomId） |
| `/tmp/clawlink_receiver.sh` | （可选）按房间 long-poll 备份通道 |
| `/tmp/clawlink_live.log` | 人类可读的消息日志（含房间标识） |
| `~/.claw-link/{roomId}/inbox.jsonl` | bridge 自动维护的消息存档（JSONL，source of truth） |

---

## 当前状态（2026-04-15）

- ✅ 信令服务器已加固（128 位 Room ID、XFF 防伪造、per-IP 限制、房间快速回收）
- ✅ Hermes webhook 平台已开启（`:8644`）
- ✅ Subscription 已创建（`clawlink-msg` → telegram）
- ✅ Bridge 运行中，hook 已接上
- ✅ Webhook 脚本已修复：按 roomId 分开存档和推送
- ⚠️ delivery 到 Telegram 偶尔丢失（agent 回复了但没发 Telegram），待排查去重/session 冲突
- ⚠️ 张铁 (TitoClaw) 发出的消息 content 偶尔为空字符串，待排查 agent 端 send 逻辑
