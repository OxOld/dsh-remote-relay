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

## 3. 完整模式（官方 UI 远程化，v1.1 起实现）

官方 Web UI（vite `base:'./'`，全部相对路径引用）原样挂载在 relay 的 `/remote/full/`
路径下，API 与 WS 由 relay 桥接回 device。除 index.html 的绝对路径改写外，不修改官方
代码；官方 UI 的传输面为：

- 一元 RPC：浏览器 `POST api/<endpoint>`（文档相对路径）→ `/remote/full/api/<endpoint>`；
- 流与事件：浏览器 WS `api/remote.mux`（相对 `document.baseURI`）→ `/remote/full/api/remote.mux`；
- 无 Service Worker；dsh 服务端注入的 `globalThis["__DSH_BOOT__"]` 启动清单由插件在
  推送时从**本机实时 served 页面**抓取保留。

### 3.1 终端鉴权（term-token → cookie）

1. terminal proof 通过后，relay 生成 `termToken`（32B base64url，TTL 7d，内存表）并下发
   `{type:'term-token', token}`。
2. terminal 以 `POST /remote/full-auth`（请求头 `authorization: Bearer <termToken>`）换取
   Cookie：`rrm_full=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800[; Secure]`。
   轻量 UI 在每次连接 ready 后自动换取。
3. 所有 `/remote/full/*`（页面、资产、桥接）要求有效 `rrm_full` cookie，且对应 sid 的
   device 必须在线（桥接时）。cookie 失效（relay 重启）→ 页面导航 302 回 `/remote/`，
   XHR 401；重新配对后自动恢复。

### 3.2 资产推送（device → relay，data 信封内）

| 方向 | 帧 | 说明 |
|---|---|---|
| d→r | `{type:'full-info'}` | 查询已托管状态 |
| r→d | `{type:'full-info-state', version, files, bytes}` | `version` 为插件计算的指纹，null=未托管 |
| d→r | `{type:'asset-begin', pushId, version, files:[{path,size,sha8}]}` | 开启一次推送（relay 建暂存目录） |
| d→r | `{type:'asset-put', pushId, path, seq, total, data}` | 单文件分帧，`data` b64 ≤ 256KB，seq 从 0 |
| d→r | `{type:'asset-end', pushId, path}` | 校验 size+sha8 后落盘该文件 |
| d→r | `{type:'asset-commit', pushId, version}` | 暂存目录原子换正，relay 回 `asset-committed` |
| d→r | `{type:'asset-abort', pushId}` | 丢弃暂存 |
| r→d | `{type:'asset-ok', pushId}` / `{type:'asset-committed', pushId, version, files, bytes}` | 应答 |

校验：`path` 必须 `^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$` 且不含 `..` 段；单文件 ≤ 20MB，
单次推送总量 ≤ 128MB、文件数 ≤ 800；`sha8` 为内容 SHA-256 前 8 个 hex。任何校验失败
relay 回 `{type:'error', fatal:false, code:'asset-*', message}`（不断连），device 侧 abort。

### 3.3 HTTP 桥（手机 `/remote/full/api/*` → device 本机）

| 方向 | 帧 | 说明 |
|---|---|---|
| r→d | `{type:'http-req', reqId, method, path, query, headers, body?}` | `path` 如 `api/remote.invoke`；`body` b64 ≤ 5MB；`headers` 仅透传 content-type/accept/accept-language/range/user-agent（剔除 cookie） |
| d→r | `{type:'http-res-head', reqId, status, headers}` | `headers` 剔除 set-cookie/connection/transfer-encoding/content-length/content-encoding/upgrade |
| d→r | `{type:'http-res-chunk', reqId, data}` | b64 ≤ 256KB，顺序发送 |
| d→r | `{type:'http-res-end', reqId}` / `{type:'http-res-abort', reqId}` | 正常结束 / 本地异常中止 |
| r→d | `{type:'http-ack', reqId, bytes}` | 流控信用：device 未确认 > 2MB 时暂停读本地响应 |
| r→d | `{type:'http-cancel', reqId}` | 手机侧断开/超时，device 中止本地请求 |

device 侧约束：仅接受 `path` 以 `api/` 开头的请求；本地请求附带铸造的 dsh 会话 cookie
（`connection.authenticatedUrl` + `authorizeIndex`），GET/HEAD 收到 401 重铸重放一次；
phone 请求体 ≤ 5MB（超出 413），响应累计 ≤ 256MB（超出 abort）。
relay 侧约束：reqId 连接内唯一；device 离线即时 503；head 超时 120s。

### 3.4 WS 桥（`/remote/full/api/*` Upgrade → device 本机 WS，1:1）

| 方向 | 帧 | 说明 |
|---|---|---|
| r→d | `{type:'ws-open', wsId, path, query, headers}` | device 打开本机 `ws://127.0.0.1:<port>/<path>?<query>`（带 dsh cookie） |
| 双向 | `{type:'ws-text', wsId, text}` / `{type:'ws-bin', wsId, data}` | 数据帧原样透传（text/binary 分别保序） |
| r→d | `{type:'ws-close', wsId, code, reason}` | 手机侧关闭 |
| d→r | `{type:'ws-opened', wsId}` / `{type:'ws-closed', wsId, code, reason}` | 本地握手完成 / 本地关闭 |

两侧心跳各自独立（relay↔phone 与 relay↔device、device↔本机 dsh），ping/pong 不跨段转发。
device 侧仅接受 `path` 以 `api/` 开头的桥；并发桥 ≤ 16，超出回 `ws-closed 1013`。

### 3.5 版本指纹与重推

`version = sha8(去 __DSH_BOOT__ 注入段后的 served index.html)`。插件在每次连接 ready 后
比对 `full-info-state`，不一致才推送（家宽上行一次性 ~10MB 量级）；relay 重启不丢资产
（落盘 `data/assets/full/`），dsh 升级后 index 指纹变化自动重推。

---

## 4. HTTP 端点

| 端点 | 说明 |
|---|---|
| `GET /remote/` | 轻量 UI（index.html，no-cache） |
| `GET /remote/app.js` `/remote/style.css` | UI 资源（no-cache，小文件） |
| `GET /remote/vendor/*` | 第三方库（immutable 30d，文件名带版本） |
| `GET /remote/full/` | 完整模式官方 UI（cookie 门禁，index no-cache，`/remote/full/assets/*` immutable） |
| `ANY /remote/full/api/*` | HTTP 桥（cookie 门禁 → device） |
| `WS /remote/full/api/remote.mux` | WS 桥 Upgrade（cookie 门禁 → device） |
| `POST /remote/full-auth` | term-token 换 `rrm_full` cookie |
| `GET /remote/ws` → Upgrade | 中继 WebSocket（轻量 UI） |
| `GET /healthz` | `ok` |
