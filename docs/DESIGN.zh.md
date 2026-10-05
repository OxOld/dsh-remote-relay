# 设计决策记录

## 为什么弃用"全量反向代理"（dsh-web-remote-frp 的路线）

旧插件（v1.10.5）把 DSH 整个 Web UI（首屏约 10MB 的 SPA bundle + 全部 API + WebSocket）
原样穿过 frp 隧道。实测在单连接 2.6Mbps 的线路上，frp 默认 tcpMux 把所有流复用进一条 TCP，
吞吐恒为 0.9Mbps 不叠加；首屏 bundle 占满链路时 DSH 的 2s 心跳被排队饿死 → 5s 超时掐连接 →
"加载成功一下又开始加载"。压缩/缓存/tcpMux=false 都是治标：**架构上所有资源必须过隧道**。

## ZCode 远程控制的参考架构

对 ZCode（`wss://zcode.z.ai/ws`）的逆向观察：

1. 桌面端**出站** WebSocket 连云端中继，无需端口映射/NAT 穿透；
2. 轻量专用 UI **托管在中继服务器上**，手机直接从公网加载——静态资源根本不经过桌面端网络；
3. 隧道里只有配对信令 + 会话数据增量（JSON，KB 级），大件（如附件）用 rpc-frame
   （≤1MB/帧 + sha256 校验 + 分片重组）按需拉取；
4. 配对：二维码携带 `sid + passHash`，双向 HMAC-SHA256 挑战应答。

本方案（dsh-remote-relay）逐条对应：frps 服务器升级为 relay（单文件 Node 服务），
轻量 UI 托管其上，插件进程内直读 dsh 服务后经紧凑协议推送。

## 关键取舍

| 决策 | 理由 |
|---|---|
| relay 与 UI 不依赖 dsh | dsh 升级只需适配插件本体（peerDependencies + 内部 API）；协议握手带 `proto` 版本号，不匹配明确报错 |
| 插件进程内直读（`sessionQuery`/`agents`/`approval` 瀑布/`attachments`） | 数据零拷贝出 dsh，无需 HTTP 自代理；这是官方 web UI 同款的消费方式 |
| 权限批准走 `approval/request` 瀑布，超时/无终端时 `next()` 委托 | 手机离线绝不阻塞本地操作；先到先得，与桌面 web UI 并存 |
| 流式用 `agent/assistant-stream`（live）+ `session/event`（持久）双通道 | live 帧驱动打字机，持久事件兜底防丢帧 |
| 附件按需分帧拉取（≤256KB/块 + sha8 校验） | 借鉴 ZCode rpc-frame；避免会话里的截图自动推爆流量 |
| v1 单文件零依赖（relay 与插件都是） | scp 一个文件即可部署；无 npm install、无供应链面 |
| v1 单终端 | 移动场景一台手机足够，状态机最简；多终端留给 v2 |
| 自实现 RFC6455 子集而非引 `ws` | relay/插件零依赖的前提；只实现服务端需要的东西（text/binary/ping/pong/close/分片），测试覆盖 |
| ~~二期"完整模式"（官方 UI 资产推送 + API 桥）~~ → **2026-10 起成为唯一形态** | 官方 UI 功能完整（会话/对话/终端/设置/批准全原生支持），两套 UI 并行维护成本高；轻量聊天 UI 移除，`/remote/` 退化为配对网关页（配对 → 换 cookie → 跳官方界面），协议帧保留兼容 |

## 与旧插件的关系

- `dsh-web-remote-frp` 保持安装可用，新插件稳定后再手动切换；
- 移植资产：canvas 二维码生成器（QR_RUNTIME）、index-inject/tapIndex 双通道注入、
  `agents.get/resume` 会话激活模式、`connection.authenticatedUrl/authorizeIndex` cookie 铸造（二期用）；
- 机器人通道（微信/QQ/TG…）与本架构无关，暂不移植。

## 2026-10：移除轻量聊天 UI，官方界面成为唯一入口

一期交付了 ~100KB 的专用手机 UI（会话列表/聊天/批准卡片），二期把官方 UI 原样搬上了中继。
两者并行运行后发现：官方 UI 经桥接后的功能与体验已是超集（终端、插件设置、原生批准流程都是轻量
UI 没有的），维护两套界面意味着每个新功能做两遍。决策：

- `relay/public/` 从聊天 UI 缩减为**配对网关页**：ZCode 风格的四步过渡（连接中继服务 → 设备鉴权 →
  等待桌面端配对 → 打开官方界面），配对成功自动换取 `rrm_full` cookie 并跳转 `/remote/full/`；
- 插件资产推送恒开（原 `syncFullUi` 开关退役，配置键保留兼容但不再生效）；
- 一期的会话投影/推送协议帧（bootstrap/snapshot/delta…）**保留在协议与插件里**，当前无 UI 消费，
  作为日后轻量客户端（如小程序、机器人）的预留通道。
