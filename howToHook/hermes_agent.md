# ClawLink → Hermes Webhook 无损推送指南

## 问题

ClawLink bridge 收到 P2P 消息后，agent 不知道。需要让消息**主动唤醒 agent**。

## 架构

```
MyClaw 发消息
    ↓ WebRTC DataChannel (P2P)
Bridge (:7654) 收到消息
    ├── on-message hook → curl webhook → Hermes Agent 被唤醒 → Telegram 推送给你
    └── long-poll 循环  → /tmp/clawlink_msgs.json (备份/调试用)
```

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
    "prompt": "MyClaw 通过 ClawLink P2P 发来消息。\n1. 读 /tmp/clawlink_msgs.json\n2. 理解意图\n3. 用 curl -X POST http://127.0.0.1:7654/send 回复\n4. 告诉鹏哥",
    "deliver": "telegram",
    "description": "ClawLink P2P 推送"
  }
}
```

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

# 构造 payload（含最新消息）
PAYLOAD=$(python3 -c "
import json, datetime, os
msgs = []
if os.path.exists('/tmp/clawlink_msgs.json'):
    try: msgs = json.load(open('/tmp/clawlink_msgs.json'))
    except: pass
last = msgs[-1] if msgs else {}
content = last.get('payload',{}).get('content','') if isinstance(last.get('payload'), dict) else ''
print(json.dumps({
    'from': '$FROM', 'type': '$TYPE', 'id': '$ID',
    'content': content,
    'timestamp': datetime.datetime.now().isoformat(),
    'all_messages': msgs[-5:]
}, ensure_ascii=False))
")

# HMAC-SHA256 签名（必须！否则返回 401）
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

# 调用 webhook
curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $SIG" \
  -d "$PAYLOAD"
```

```bash
chmod +x /tmp/clawlink_webhook.sh
```

### 4. 启动 Bridge（接上 hook）

```bash
cd /tmp/ClawLink && node bin/claw-link.js bridge --port 7654 \
  --name TitoClaw --perm helper \
  --on-message 'bash /tmp/clawlink_webhook.sh {from} {type} {id}' \
  --on-connect 'echo "$(date) 🔗 {peer} connected" >> /tmp/clawlink_live.log' \
  --foreground &
```

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

`/tmp/clawlink_receiver.sh`：

```bash
while true; do
  RESULT=$(curl -s 'http://127.0.0.1:7654/recv?wait=25')
  if [ -n "$RESULT" ] && [ "$RESULT" != "[]" ]; then
    # 追加到文件
    echo "$RESULT" | python3 -c "
import json, sys, datetime
for m in json.load(sys.stdin):
    print(f'{datetime.datetime.now().strftime(\"%H:%M:%S\")} [{m[\"from\"]}] {m.get(\"payload\",{}).get(\"content\",\"\")}')
" >> /tmp/clawlink_live.log
    touch /tmp/clawlink_new_msg   # 标记文件
  fi
done
```

然后随时 `cat /tmp/clawlink_live.log` 查看消息。但这还是 pull 模式，不是真推送。

---

## 完整文件清单

| 文件 | 作用 |
|------|------|
| `~/.hermes/config.yaml` | 开启 webhook 平台 |
| `~/.hermes/webhook_subscriptions.json` | 定义路由 + prompt + 投递目标 |
| `/tmp/clawlink_webhook.sh` | bridge hook → 签名 webhook 调用 |
| `/tmp/clawlink_receiver.sh` | （可选）long-poll 备份通道 |
| `/tmp/clawlink_live.log` | 人类可读的消息日志 |
| `/tmp/clawlink_msgs.json` | 完整 JSON 消息存档 |

---

## 当前状态（2026-04-13）

- ✅ 信令服务器已更新为 `python-signal-server` 分支最新版（多房间、速率限制、IP冷却）
- ✅ Hermes webhook 平台已开启（`:8644`）
- ✅ Subscription 已创建（`clawlink-msg` → telegram）
- ✅ Bridge 运行中，hook 已接上
- ⚠️ delivery 到 Telegram 偶尔丢失（agent 回复了但没发 Telegram），待排查去重/session 冲突
