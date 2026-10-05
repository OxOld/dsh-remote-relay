# dsh-tools · dsh-remote-relay

对标 ZCode 远程控制的 **dsh（DeepSeek Harness）远程控制方案**：

> **手机上跑的就是 dsh 官方 Web 界面**，静态资源托管在你自己的公网服务器（中继）上，
> dsh 插件出站连接中继，隧道里只有 API 调用与消息增量 —— **静态资源、首屏、大流量全部不经过家里带宽**。

与旧的 frp 全量反代方案（dsh-web-remote-frp）的本质区别见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md)。

```
手机浏览器 ──HTTPS──▶ 公网服务器 relay.mjs（单文件零依赖）
   二维码配对            ├─ 配对网关页（/remote/，四步过渡动画 → 跳官方界面）
   官方 UI 界面          ├─ 官方 UI 托管（/remote/full/，插件推送落盘）
                         └─ WS 中继（/remote/ws）桥接 device ↔ terminal
                              ▲
dsh 插件（cordis）──出站 WSS──┘   官方 UI 的 API/WS 经桥接回到本机 dsh，与桌面端完全一致
```

## 目录结构

```
docs/PROTOCOL.md        三方协议契约（relay/UI 只按它实现，永不 import dsh）
docs/DESIGN.zh.md       架构决策记录（为什么弃用全量代理；为何移除轻量 UI）
relay/relay.mjs         中继服务（单文件，零依赖，Node ≥ 20）
relay/public/           配对网关页（/remote/，配对 → 换 cookie → 跳官方界面）
relay/full.mjs          官方 UI 托管：资产落盘 + cookie 门禁 + HTTP/WS 桥接（由 relay.mjs 挂载）
relay/Dockerfile 等     Dockerfile + docker-compose.yml
relay/deploy/           部署文档 + systemd 样例
plugin/                 dsh 插件（npm 包 dsh-remote-relay）
plugin/lib/index.mjs    cordis 插件主体
plugin/lib/projector.mjs 会话事件 → 远程消息投影器（遗留协议层，保留兼容）
plugin/lib/fullbridge.mjs 官方 UI 资产推送 + HTTP/WS 桥接
plugin/lib/panel.mjs    dsh 内注入的二维码/设置面板（自动组装）
plugin/lib/ws.mjs       零依赖 WebSocket 客户端
```

## 功能

- **官方 UI 远程化**：dsh 官方 Web 界面原样搬到中继（`/remote/full/`），手机体验与桌面端一致——
  会话、对话、终端、插件设置、工具调用批准，全部原生支持
- 资产推送：插件检测 dsh 版本变化后把静态资源增量推到服务器落盘（首次 ~25MB，之后极少重推）
- HTTP/WS 桥接：手机对官方 UI 的所有 API 调用与 `/api/remote.mux` WebSocket 经出站隧道桥回家里
- **精简官方界面**（可选）：隐藏设置/插件/工作区创建，只留会话与对话
- **手机批准工具调用**（可选）：`approval/request` 瀑布接入；手机超时自动回退桌面，绝不阻塞本地
- 二维码扫码配对（HMAC-SHA256 挑战应答，凭据不进服务器日志），配对网关页自动换票进入官方界面
- dsh 内置设置面板：中继地址/设备名/注册口令/自动连接/批准开关/超时/重置配对

## 快速开始

1. **部署中继**（你的公网服务器）：见 [relay/deploy/DEPLOY.zh.md](relay/deploy/DEPLOY.zh.md)；
2. **安装插件**：`dsh plugin --profile desktop add "github:OxOld/dsh-remote-relay#path:plugin"`；
3. dsh 内打开"远程"面板 → 填中继地址（如 `http://你的域名:8787`）与注册口令 → 保存并重连；
4. 手机扫二维码 → 四步配对 → 自动进入官方界面。

## 测试

```bash
# 中继（WS 编解码/鉴权/桥接/限速/分片/心跳，22 项）
node --test relay/test/relay.test.mjs relay/test/full.test.mjs
# 投影器单测（遗留协议层）
node --test plugin/test/projector.test.mjs
# 全链路集成（真实 relay + 假 dsh ctx + 终端客户端，15 组用例）
node plugin/test/test-dist.mjs
```

## 状态

- ✅ 官方 UI 远程化：托管 + 桥接 + 网关配对，全部完成并有测试覆盖
- 🗑️ 一期轻量聊天 UI：已移除（2026-10，官方 UI 功能完整，不再维护两套界面；协议帧保留作兼容）

## License

MIT
