# dsh-remote-relay

dsh（DeepSeek Harness）远程控制插件 —— 中继版。对标 ZCode 远程控制：
轻量手机 UI 由你自己的公网服务器（中继）直接提供，本插件以 **device 角色**
出站连接中继，把会话数据以紧凑协议推给手机。

- 为什么不是全量代理：见仓库根目录 [docs/DESIGN.zh.md](../docs/DESIGN.zh.md)
- 协议：[docs/PROTOCOL.md](../docs/PROTOCOL.md)
- 中继部署：[relay/deploy/DEPLOY.zh.md](../relay/deploy/DEPLOY.zh.md)

## 安装

方式 A（本地目录安装）：

```bash
# 在 dsh 的 profile 目录（如 ~/.dsh/profiles/desktop）
pnpm add file:/path/to/dsh-tools/plugin
```

方式 B（发布 npm 后）：

```bash
pnpm add dsh-remote-relay
```

然后把包名加入 profile `package.json` 的 `dsh.profile.bundles`
（或在本包 cordis.patch.yml 已被引用时直接重启 dsh）。

## 使用

1. 重启 dsh 后，主界面右下角出现"远程"悬浮按钮；
2. 面板中填写中继地址（`wss://你的域名/remote/ws`）→ 保存并重连；
3. 面板展示二维码，手机扫码进入轻量 UI；
4. 手机端可：查看会话/历史、发消息（流式回复）、批准工具调用、按需查看附件。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `relayUrl` | — | 中继 WebSocket 地址（wss://…/remote/ws） |
| `password` | 自动生成 | 配对凭据（重置配对时更换） |
| `deviceName` | 我的 dsh | 二维码备注名 |
| `autoConnect` | true | 启动时自动连接中继 |
| `approveFromPhone` | true | 允许手机批准工具调用（超时/离线自动回退桌面） |
| `approvalTimeoutMs` | 120000 | 手机批准等待时长 |
| `regToken` | 空 | 设备注册口令：中继设置了 `RELAY_REG_TOKEN` 时必填，防止他人蹭用你的服务器转发 |

面板保存值持久化在 `~/.dsh/tools/remote-relay.json`，优先于 YAML config。

## 开发

```bash
node build-panel.mjs        # 修改 panel-body.js 后重新组装 lib/panel.mjs
node --check lib/index.mjs
node --test test/projector.test.mjs
node test/test-dist.mjs     # 全链路集成测试
```
