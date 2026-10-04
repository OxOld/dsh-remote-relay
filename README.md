# dsh-tools · dsh-remote-relay

对标 ZCode 远程控制的 **dsh（DeepSeek Harness）远程控制方案**：

> 轻量手机 UI 托管在你自己的公网服务器（中继）上，dsh 插件出站连接中继，
> 隧道里只有配对信令和会话消息增量 —— **静态资源、首屏、大流量全部不经过家里带宽**。

与旧的 frp 全量反代方案（dsh-web-remote-frp）的本质区别见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md)。

```
手机浏览器 ──HTTPS──▶ 公网服务器 relay.mjs（单文件零依赖）
   二维码配对            ├─ 静态托管轻量 UI（/remote/）
                         └─ WS 中继（/remote/ws）桥接 device ↔ terminal
                              ▲
dsh 插件（cordis）──出站 WSS──┘   进程内直读 sessionQuery/agents/approval/attachments
```

## 目录结构

```
docs/PROTOCOL.md        三方协议契约（relay/UI 只按它实现，永不 import dsh）
docs/DESIGN.zh.md       架构决策记录（为什么弃用全量代理）
relay/relay.mjs         中继服务（单文件，零依赖，Node ≥ 20）
relay/public/           轻量移动端 UI（无构建，原生 ES modules）
relay/deploy/           部署文档 + systemd + Dockerfile
plugin/                 dsh 插件（npm 包 dsh-remote-relay）
plugin/lib/index.mjs    cordis 插件主体
plugin/lib/projector.mjs 会话事件 → 远程消息投影器（纯函数）
plugin/lib/panel.mjs    dsh 内注入的二维码/设置面板（自动组装）
plugin/lib/ws.mjs       零依赖 WebSocket 客户端
```

## 功能（一期 MVP）

- 会话列表 + 历史查看（Markdown 渲染，工具调用折叠块）
- 远程发消息 + 打字机流式输出 + 中断运行
- **手机批准工具调用**（`approval/request` 瀑布接入；手机离线/超时自动回退桌面，绝不阻塞本地）
- 附件按需分帧拉取（≤256KB/块 + sha256 校验）
- 二维码扫码配对（HMAC-SHA256 挑战应答，凭据不进服务器日志）
- dsh 内置设置面板：中继地址/设备名/自动连接/批准开关/超时/重置配对

## 快速开始

1. **部署中继**（你的公网服务器）：见 [relay/deploy/DEPLOY.zh.md](relay/deploy/DEPLOY.zh.md)；
2. **安装插件**：把 `plugin/` 放进 dsh profile 的 node_modules（或发布 npm 后 `dsh plugin add`），
   并在 profile 的 `cordis.patch.yml` 引入 patch（见 plugin/cordis.patch.yml）；
3. dsh 内打开"远程"面板 → 填 `wss://你的域名/remote/ws` → 保存；
4. 手机扫二维码 → 远程控制。

## 测试

```bash
# 中继（WS 编解码/鉴权/桥接/限速/分片/心跳，14 项）
node --test relay/test/relay.test.mjs
# 投影器单测
node --test plugin/test/projector.test.mjs
# 全链路集成（真实 relay + 假 dsh ctx + 终端客户端，12 组用例）
node plugin/test/test-dist.mjs
```

## 状态

- ✅ 一期（轻量模式）：全部完成并有测试覆盖
- 🔜 二期（完整模式）：官方 UI 资产推送到中继托管 + API/WS 桥接（协议已在 PROTOCOL.md §3 预留）

## License

MIT
