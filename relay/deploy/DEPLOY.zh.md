# 中继服务部署指南

中继（`relay/relay.mjs`）部署在任何有公网 IP 的服务器上（Linux 均可），单文件零依赖，
只需要 Node.js ≥ 20。它与 dsh 版本完全解耦，dsh 升级无需动它。

## 0. 上传文件

把以下内容传到服务器（如 `/opt/dsh-remote-relay/`）：

```
relay.mjs
public/            # 整个目录（轻量 UI）
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

## 5. dsh 插件侧配置

装好插件后，打开 dsh 客户端 → 设置弹窗里的"远程"悬浮按钮 → 填写中继地址：

```
wss://你的域名/remote/ws        # HTTPS 由 nginx 提供
# 或 wss://你的域名/remote/ws（relay 直接 HTTPS，同样是 wss://）
```

保存后面板出现二维码，手机扫码即完成配对。

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

## 6.1 完整模式：手机上用官方原版界面（默认开启）

除了轻量 UI，还支持把 **dsh 官方 Web 界面原样搬到中继上**：插件自动把本机 dsh 服务出的
served 页面（含 `__DSH_BOOT__` 启动清单）和全部静态资产推送到服务器落盘托管
（`data/assets/full/`，首次 ~10MB 走一次家宽上行，之后仅 dsh 升级导致指纹变化时增量重推），
手机的 API 请求与 WebSocket 由 relay 桥接回家里，走的是同一条已有的出站隧道。

- 手机入口：配对后的轻量 UI 右上角"**官方界面**"按钮（凭配对时换取的 HttpOnly cookie 进入，
  `https://你的域名/remote/full/`）；
- dsh 侧开关："远程"面板 →"完整模式：推送官方 UI 到服务器"（`syncFullUi`，默认开）；
- 服务器无感知：不需要任何配置，资产存在 `data/` 卷里，容器重建不丢；
- 手机上官方界面的所有调用都过桥（HTTP 一元 + `/api/remote.mux` WebSocket），与桌面端一致。

安全注意：完整模式与轻量模式同权——cookie 绑定配对会话，relay 重启后需在轻量 UI
重新连接一次自动换新 cookie；切勿把 `/remote/full/` 直接暴露给未配对访客（默认已有门禁）。

## 7. 数据与安全

- `data/devices.json`：已注册设备（sid → hash），删除文件 = 全部设备重新配对。
- 配对凭据在二维码 URL 的 `#` fragment 中，不会进服务器访问日志。
- 认证失败限速：同 IP 60 秒内 10 次失败 → 冷却 60 秒。
- 想强制全体重新配对：删除 `data/devices.json` 后重启服务，然后在 dsh 面板"重置配对"。
