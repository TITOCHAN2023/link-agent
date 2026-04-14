# ClawLink TODO

## 当前架构状态

### 两个分支
- `main`: Node.js 客户端代码（transport + bridge + protocol + CLI）
- `python-signal-server`: Python 信令服务器（部署在 ginfo.cc）

### 核心文件（main 分支）
```
src/
  transport.js    — ClawTransport: P2P EventEmitter 核心层
  bridge.js       — ClawBridge: 多房间 HTTP bridge + 自动重连 + hooks + TG bot
  agent.js        — ClawAgent: JSON lines stdin/stdout (L2 agents)
  protocol.js     — 消息协议: chat/task/result/file/query/ack
  client.js       — CLI 交互终端 (人类用)
  cli.js          — Commander 入口: create/join/bridge/server/ping
  server.js       — 内置 JS 信令服务器 (本地开发用)
  session.js      — Session 状态机
  permissions.js  — 权限协商 + 隐私过滤
  invite.js       — 生成 invite prompt + 写文件
  tg.js           — Telegram bot 通知 + /kill /set 命令
index.js          — require('claw-link') 入口
```

### 信令服务器
- 地址: wss://ginfo.cc/signal/
- 支持多房间: 连 / 自动生成 roomId，连 /<roomId> 加入/创建指定房间
- 加固: 类型白名单、限速、IP 冷却、SDP 校验

## 已完成的功能

- [x] WebRTC P2P 通信 (node-datachannel)
- [x] 信令服务器多房间 + room ID 自动生成/自定义
- [x] 三级权限协商 (intimate/helper/chat)，两端独立计算不信对方
- [x] Transport/Protocol/CLI 分层架构
- [x] Bridge HTTP 模式（L1 serial agent 用 curl 操作）
- [x] Bridge daemon 化（启动秒回，后台运行）
- [x] Bridge 多房间支持（一个 bridge 管多个 room）
- [x] Bridge 自动重连（断连后 exponential backoff 重连同一 room）
- [x] 消息持久化到磁盘 (per-room inbox.jsonl)
- [x] Hook 系统 (--on-message/--on-connect/--on-disconnect)
- [x] TG bot 通知（双向消息 + /kill + /set 权限）
- [x] TG 环境变量 fallback (CLAWLINK_TG_TOKEN, CLAWLINK_TG_CHAT)
- [x] Invite prompt 生成（create 后输出可复制的加入指南）
- [x] 安全: 消息 256KB 限制、终端 ANSI 注入防护、SDP 校验
- [x] STUN 国内优先 (QQ/小米/阿里)
- [x] JSON lines 模式 (--json, L2 agent)
- [x] bridge stop 命令 (PID 或端口)

## 待修复 Bug

- [ ] TG bot 只在张铁端绑定时才能看到双向消息（因为 outbound 通知在 bridge /send 里，谁的 bridge 绑了 TG 谁看到自己发的）— 需要确认：如果两端都绑 TG 是否会重复
- [x] README 里 inbox 示例路径过时（旧: ~/.claw-link/inbox.jsonl → 新: ~/.claw-link/<roomId>/inbox.jsonl）✅
- [x] invite.js 里 inbox 路径描述过时 ✅

## 待开发功能

- [ ] .clawlinkrc 配置文件（name/perm/port/tg-token 等常用参数，不用每次传）
- [ ] README 补充自动重连行为说明（backoff 策略、何时重连、何时放弃）
- [ ] README 更新所有 inbox 路径为 per-room 格式
- [ ] Bridge /send 支持 result 类型的 replyTo 自动关联

## 测试验证记录

- [x] E2E: 本地信令 + 两个 peer P2P 消息双向 ✅
- [x] 自定义 room ID create/join ✅
- [x] 多房间隔离（同一 bridge 两个 room，消息不串） ✅
- [x] 自动重连（B 断开 → A 重连 → B 回来 → 恢复通信） ✅
- [x] inbox 路径重连后不漂移 ✅
- [x] Bridge daemon 秒回 ✅
- [x] 与张铁 (TitoClaw/GLM-5) 真实 A2A 通信成功 ✅
- [x] TG 双向消息可见 ✅

## 工作模式

- **稳定版**: /tmp/clawlink-stable (通信用，不改代码)
  - Bridge port 7654
  - Room: t1t0-opus-room
- **开发版**: /Users/bytedance/Project/ClawLink (改代码 + 测试)
  - Bridge port 7656
  - Room: t1t0-opus-dev
- 张铁 (TitoClaw) 也需要同样维护稳定版 + 开发版两套

## 与张铁的协作

- 张铁是 GLM-5 agent，运行在 Hermes 框架，部署在鹏哥的服务器上
- 他处理消息比较慢，wait 时间建议 120s
- 他的 bridge 绑定了 TG bot，鹏哥通过 TG 监控对话
- 给他发指令要简洁，分步骤，不要假设他知道所有细节
