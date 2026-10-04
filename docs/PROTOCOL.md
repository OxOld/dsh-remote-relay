# dsh-remote-relay 协议契约 v1（proto = 1）

本文件是 **插件（device）↔ 中继（relay）↔ Web UI（terminal）** 三方的唯一契约。
relay 与 Web UI **只按本文档实现**，永不 import dsh 的任何东西。

角色定义：

| 角色 | 是谁 | 连接方向 |
|---|---|---|
| `device` | dsh 里的 cordis 插件 | 出站 WSS 连 relay |
| `terminal` | 手机/浏览器上的轻量 UI | 直接 HTTPS/WSS 连 relay |

约定：所有控制/数据消息都是 **JSON 文本帧**；`sid` 只含 `[A-Za-z0-9_-]`（8~32 字符）；
`base64url` 指 RFC 4648 §5 无填充；时间戳均为 epoch 毫秒。

---

## 1. 配对与认证（ZCode 同款算法）

凭据：

- 设备密码 `password`：24 字节随机数的 base64url（插件生成并持久化）。
- 口令哈希 `hash = base64url( sha256( utf8(password) ) )`——二维码里携带的就是它（base64url 免转码，URL/URLSearchParams 双向无损）。

二维码 URL（凭据放 fragment，不进服务器日志）：

```
https://<域名>/remote/#/pair?sid=<sid>&hash=<hash>&name=<设备名>
```

挑战应答（双向）：

```
proof = base64url( HMAC-SHA256( key = utf8(hash), msg = utf8(`${nonce}|${role}|${sid}`) ) )
```

其中 `nonce` 为服务器下发的 16 字节 base64url；`role` ∈ `device | terminal`。

### 1.1 握手时序（两个角色相同）

```
C→S  {"type":"hello","proto":1,"role":"device","sid":"...","name":"...","hash":"...","regToken":"..."}
S→C  {"type":"challenge","nonce":"..."}
C→S  {"type":"proof","proof":"..."}
S→C  {"type":"ready","role":"device","sid":"...","peer":0}        # 0=对端未在线
     （或 terminal：{"type":"ready","role":"terminal","sid":"...","peer":1,"device":{"name":"..."}}）
S→C  {"type":"pair","status":"matched"}                            # 对端上线时补发
```

- `hello.hash` 仅 device 携带。sid 未注册 → 用该 hash 注册；sid 已注册 → 先按**存量 hash**
  验 proof，通过后才允许用新 hash 覆盖（改密码无需换 sid）。
- hello.regToken 仅 device 携带（可选）：中继配置了注册口令（RELAY_REG_TOKEN / --reg-token）时，**新 sid 注册必须携带匹配口令**，否则 4001 `reg-token-required` 并计入限速——防止知道域名的陌生人在中继上注册设备白嫖转发；已注册 sid 的重连不校验口令。
- terminal 端凭 QR URL fragment 里的 hash 本地计算 proof，hash 不回传服务器。

### 1.2 关闭码

| code | 含义 |
|---|---|
| 4000 | keepalive 超时（30s 无 pong） |
| 4001 | 握手非法 / proto 不匹配 / hello 超时（错误细节见先行的 `{"type":"error"}`） |
| 4002 | proof 校验失败 |
| 4003 | 认证失败次数过多（IP 冷却 60s） |
| 4004 | sid 未注册（terminal 用了过期/错误的 sid） |
| 4009 | 连接被同角色新连接顶替（终端刷新页面/设备重连时旧连接收到此码，新连接生效） |
| 4010 | **device 掉线**（发给 terminal） |
| 4013 | 非法终端连接 |

### 1.3 保活与桥接状态

- 服务器每 10s 发 WS ping，30s 无 pong 判死；客户端 ping 服务器自动回 pong。
- 对端掉线通知：terminal 掉线 → device 收 `{"type":"pair","status":"waiting"}`；
  device 掉线 → terminal 收 close 4010。
- 桥接仅在双方 `ready` 后生效：此后一切 `{"type":"data","payload":{...}}` 原样转发给对端，
  服务器只补充 `ts` 字段，不解析 payload 内容。

---

## 2. 桥接载荷（payload.c 命令目录）

### 2.1 device → terminal

| c | 载荷字段 | 说明 |
|---|---|---|
| `hello` | `device:{name, version, dsh}` | 桥建立后设备自报家门 |
| `bootstrap` | `sessions:[Sess], device:{...}` | 响应 `bootstrap-request`；sessions 按 updatedAt 降序 |
| `sessions` | `upserts:[Sess], removed:[id]` | 列表增量推送 |
| `snapshot` | `sessionId, title, status, messages:[Msg]` | 响应 `open`；messages 为末尾 N 条投影 |
| `message` | `sessionId, msg:Msg` | 新的持久化消息（打字机结束后也会有一条终稿） |
| `delta` | `sessionId, turn, kind:'start'\|'chunk'\|'end', text?` | 打字机帧；chunk.text 为增量文本 |
| `status` | `sessionId, status:'running'\|'idle'` | 会话运行状态 |
| `approval` | `requestId, sessionId, tool, callId?, args?, reason?` | 待批准的工具调用 |
| `approval-done` | `requestId, outcome, by:'phone'\|'desktop'\|'timeout'` | 该请求已被处置（by!=phone 时手机端撤卡） |
| `att-meta` | `fetchId, kind:'image'\|'file', name, mime, bytes, width?, height?` | 附件拉取元信息 |
| `att-chunk` | `fetchId, seq, b64` | 附件数据块，b64 ≤ 349525 字符（=256KiB 二进制） |
| `att-end` | `fetchId, sha8, error?` | 拉取结束；sha8 = sha256 前 8 hex（校验用） |
| `error` | `code, message, ref?` | 请求级错误 |

### 2.2 terminal → device

| c | 载荷字段 | 说明 |
|---|---|---|
| `bootstrap-request` | — | 拉会话列表 |
| `open` | `sessionId, tail?` | 订阅该会话并取快照（tail = 末尾条数，默认 200） |
| `close` | `sessionId` | 取消订阅 |
| `send` | `sessionId, msgId, text` | 发送 user 消息（msgId 由终端生成，用于本地回显去重） |
| `cancel` | `sessionId` | 中断当前运行 |
| `approve` | `requestId, outcome:'allowed-once'\|'rejected'` | 批准/拒绝 |
| `fetch-att` | `fetchId, sessionId, attachmentId` | 按需拉取附件（fetchId 由终端生成） |

### 2.3 共同数据结构

```ts
Sess = { id: string, title: string, updatedAt: number,
         status: 'running'|'idle', cwd?: string }

Msg  = { seq: number,                    // 会话事件序号（幂等/去重）
         k: 'user'|'assistant'|'tool'|'note',
         text?: string,                  // user/assistant 正文（markdown）
         tool?: string, args?: string,   // tool 调用名与参数 JSON 串
         callId?: string, ok?: boolean, out?: string,   // tool 结果
         atts?: { id, name, mime, bytes, w?, h? }[],    // 附件引用
         t?: number }                    // 事件时间（可缺省）
```

约束：`out`（工具输出投影）单条 ≤ 4KB，超出截断加 `…[截断]`；
`text` 单条 ≤ 256KB（超过由 device 侧截断）；`fetchId`/`msgId`/`requestId` 由发起方生成，
格式不限，仅要求连接内唯一。

---

## 3. 二期保留（v1 不实现，字段已预留）

- **官方 UI 资产推送**（device → relay 控制消息，不走 data 桥）：
  `{type:'asset-put', path, seq, final, b64, sha8}` → relay 落盘到 `public/full/<path>`。
- **HTTP 桥**：relay↔device `{type:'http-req', id, method, path, headers, bodyB64?}` /
  `{type:'http-res', id, status, headers, bodyB64?, more?}`。
- **WS 桥**：`{type:'ws-open'|'ws-data'|'ws-close', id, ...}`。

---

## 4. HTTP 端点

| 端点 | 说明 |
|---|---|
| `GET /remote/` | 轻量 UI（index.html，no-cache） |
| `GET /remote/app.js` `/remote/style.css` | UI 资源（no-cache，小文件） |
| `GET /remote/vendor/*` | 第三方库（immutable 30d，文件名带版本） |
| `GET /remote/full/*` | 二期：官方 UI 托管资产 |
| `GET /remote/ws` → Upgrade | 中继 WebSocket |
| `GET /healthz` | `ok` |
