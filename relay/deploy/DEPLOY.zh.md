# 中继服务部署指南

中继（`relay/relay.mjs`）部署在任何有公网 IP 的服务器上（Linux 均可），单文件零依赖，
只需要 Node.js ≥ 20。它与 dsh 版本完全解耦，dsh 升级无需动它。

## 0. 上传文件

把以下内容传到服务器（如 `/opt/dsh-remote-relay/`）：

```
relay.mjs
public/            # 整个目录（配对网关页）
```

```bash
scp -r relay/relay.mjs relay/public user@your-server:/opt/dsh-remote-relay/
```

## 1. 方式一：HTTPS 由 relay 直接提供（推荐，最简单）

前提：域名已解析到服务器，持有证书（Let's Encrypt 的 `fullchain.pem` + `privkey.pem`）。

```bash
node relay.mjs --port 443 \
  --tls-cert /etc/letsencrypt/live/你的域名/fullchain.pem \
  --tls-key  /etc/letsencrypt/live/你的域名/privkey.pem
```

验证：浏览器打开 `https://你的域名/remote/` 能看到加载页；`https://你的域名/healthz` 返回 ok。

## 2. 方式二：挂在你已有的 nginx / caddy 后面（反代）

relay 只跑 HTTP：

```bash
node relay.mjs --port 8787
```

nginx 参考配置（含 WebSocket 升级透传）：

```nginx
server {
    listen 443 ssl;
    server_name 你的域名;
    # ssl_certificate / ssl_certificate_key 略

    location /remote/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }
    location = /healthz { proxy_pass http://127.0.0.1:8787; }
}
```

caddy 更简单：

```
你的域名 {
    handle /remote/* {
        reverse_proxy 127.0.0.1:8787
    }
    handle /healthz { reverse_proxy 127.0.0.1:8787 }
}
```

## 3. systemd 常驻

```ini
# /etc/systemd/system/dsh-remote-relay.service
[Unit]
Description=dsh-remote-relay
After=network-online.target

[Service]
WorkingDirectory=/opt/dsh-remote-relay
ExecStart=/usr/bin/node relay.mjs --port 8787
Restart=always
RestartSec=3
User=www-data
# 直接 HTTPS 时改为：ExecStart=/usr/bin/node relay.mjs --port 443 --tls-cert ... --tls-key ...

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now dsh-remote-relay
```

## 4. Docker Compose（在 relay/ 目录下）

```bash
cp .env.example .env       # 编辑 .env，设置设备注册口令（防蹭用，必填）
docker compose up -d --build
```

- 镜像零依赖极小；`./data` 挂载持久化设备注册表（删除 = 全部设备重新配对）；
- 默认监听 8787（HTTP，挂 nginx/caddy 后面）；直接 HTTPS（免 nginx）的改法见 docker-compose.yml 底部注释；
- 更新版本：拉取新代码后 `docker compose up -d --build`。

**镜像仓库版（免构建）**：不想在服务器上 build 的话，直接用现成镜像，所有值写死在文件里（免 .env）：

```yaml
services:
  relay:
    image: ghcr.io/oxold/dsh-remote-relay:latest   # 或固定日期标签，如 :20261007
    container_name: dsh-remote-relay
    restart: unless-stopped
    ports: ["8787:8787"]
    environment:
      - RELAY_REG_TOKEN=你的注册口令    # 与 dsh 面板保持一致；不需要防蹭用就删掉这行
    volumes:
      - ./data:/app/data
```

升级 = 改 image tag → `docker compose pull && docker compose up -d`（data 卷不动，设备无需重新配对）。

**镜像自动构建（GitHub Actions）**：仓库公开，改 `relay/` 下代码推到 main 会自动构建并推送到
`ghcr.io/oxold/dsh-remote-relay`（标签 `YYYYMMDD`、`YYYYMMDD-sha8`、`latest`，amd64 + arm64，
无需任何 secrets 配置）。首次运行后到 GitHub → Packages 把镜像可见性设为 Public；
构建状态见仓库 Actions 页，也可手动触发（Run workflow）。

## 5. dsh 插件侧配置

装好插件后，打开 dsh 客户端 → 设置弹窗里的"远程"悬浮按钮 → 填写中继地址：

```
http://你的域名:8787            # HTTP（或反代后的 https://）
# 也接受完整 WebSocket 地址：ws://…/remote/ws、wss://…/remote/ws
```

如果服务器设置了注册口令（见 §6），在"设备注册口令"里填同一个值。
点"**保存并重连**"后面板出现二维码，手机扫码即完成配对。
（保存后状态栏会显示"正在重连中继…"，连上后自动变绿。）

## 6. 防蹭用：设备注册口令（强烈建议设置）

不设置口令时，任何人只要知道你的域名，就能跑一份插件客户端在你的中继上注册自己的设备，
免费占用你的服务器转发。设置口令后，**新设备注册必须携带口令**，已有设备不受影响：

```bash
# 命令行
node relay.mjs --port 8787 --reg-token 换成一串随机口令
# 或环境变量
RELAY_REG_TOKEN=换成一串随机口令 node relay.mjs
```

systemd 里加一行：

```ini
[Service]
Environment=RELAY_REG_TOKEN=换成一串随机口令
```

然后在 dsh"远程"面板的"设备注册口令"里填同一个口令，保存即可。
口令错误会被计入限速（同 IP 连续失败会被冷却），口令换了随时在服务器改，已配对设备不用动。

## 6.1 手机界面：dsh 官方原版界面（唯一界面，自动启用）

手机上跑的就是 **dsh 官方 Web 界面原样搬到中继上**（2026-10 起轻量聊天 UI 已移除，官方界面是唯一入口）：
插件自动把本机 dsh 服务出的 served 页面（含 `__DSH_BOOT__` 启动清单）和全部静态资产推送到服务器落盘托管
（`data/assets/full/`，首次 ~25MB 走一次家宽上行，之后仅 dsh 升级导致指纹变化时增量重推），
手机的 API 请求与 WebSocket 由 relay 桥接回家里，走的是同一条已有的出站隧道。

> 为什么不由服务器直接内置这份 UI？因为它是本机 dsh 服务**运行时动态拼装**的（含 `__DSH_BOOT__`
> 与插件注入行），磁盘上没有可打包的静态产物，且必须与本机 dsh 版本严格配套——由插件按指纹
> 自动增量推送才能保证永远一致，服务器端零维护。完整取舍见 [docs/DESIGN.zh.md](../../docs/DESIGN.zh.md)。

- 手机入口：扫码后先看到 **配对网关页**（四步过渡：连接中继 → 设备鉴权 → 等待桌面端配对 → 打开官方界面），
  完成后自动跳转 `https://你的域名/remote/full/`，无需任何手动操作；
- 无需开关：资产推送恒开（旧版本的 `syncFullUi` 配置键仍在文件里兼容保留，但已不生效）；
- 服务器无感知：不需要任何配置，资产存在 `data/` 卷里，容器重建不丢；
- 手机上官方界面的所有调用都过桥（HTTP 一元 + `/api/remote.mux` WebSocket），与桌面端一致；
- 可选"精简官方界面"：隐藏设置/插件/工作区创建，只留会话与对话（面板勾选）。

安全注意：官方 UI 入口有 cookie 门禁——cookie 绑定配对会话（HttpOnly，7 天有效），
relay 重启后网关页会自动重新配对换新 cookie；切勿把 `/remote/full/` 直接暴露给未配对访客（默认已有门禁）。

## 7. 数据与安全

- `data/devices.json`：已注册设备（sid → hash），删除文件 = 全部设备重新配对。
- 配对凭据在二维码 URL 的 `#` fragment 中，不会进服务器访问日志。
- 认证失败限速：同 IP 60 秒内 10 次失败 → 冷却 60 秒。
- 想强制全体重新配对：删除 `data/devices.json` 后重启服务，然后在 dsh 面板"重置配对"。
