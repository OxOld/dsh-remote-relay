# 远程端白板：排查结论与加固方案

> 事故：2026-11-06 18:33 前后，手机通过中继打开官方界面显示白板；桌面端面板点
> 「重置配对（生成新二维码）」并重新扫码后恢复。
>
> 本文记录已证实的事实、根因判断（含证据强度）、代码级修复方案，以及下次复现时
> 5 分钟内可完成的取证清单。**结论部分不含猜测性断言**，推断均标注了置信度。

## 1. 结论摘要

| # | 结论 | 置信度 |
|---|---|---|
| 1 | 与 approval policy（`ask` → `never`）改动**无关**：白板发生在远程端渲染层，不涉及批准流程 | 高 |
| 2 | 与资产**内容**不一致**无关**：重置配对后重推的版本号与白板前完全相同（`idx4-ad4e902d-k`，113 文件 / 23.8MB） | 已证实 |
| 3 | relay 上该设备的托管资产**落后于本机当前 rev**：手机端实际请求的 combo 带 `rev=df46ae3ba3b1` / `a5e8b44c07f3`，本机当前 index 是 `da695bd15e8d` / `2bd5968318ec` / `8ea1d25d72c9` | 已证实 |
| 4 | 白板的直接表现是官方 UI 的 React 树在 `slot` 装配阶段抛错并整体卸载：`SlotAssemblyError: scope 'session-maybe' rendered without an installed adapter` | 已证实（浏览器控制台） |
| 5 | 最可能的机制：**旧 rev 的 index/boot 与新 rev 的回源模块混用**——relay 上停留在旧一批资产，运行时未命中的请求回源到本机、由本机按当前 rev 返回，两套模块同时进入页面 | 中高 |
| 6 | 「重置配对」之所以修复：换新 sid 后 relay 侧没有任何资产，插件整包重推一份 **rev 自洽**的当前资产，手机端不再混用 | 高 |
| 7 | 推送清单里确实带了第三方插件前端（`workbuddy-to-dsh` 586KB、`qwen-connect` 37KB、`dsh-whale` 1.1MB）；它们用**根绝对路径**请求 API/资源，在 relay 上必然 404 | 已证实 |

**一句话**：`f43f373` 的「按内容指纹判断、rev 变化不重推」解决了每次启动重传 25MB，但把
relay 上的 index 永久钉在了**旧 rev**；只要运行时有请求回源本机（懒加载 chunk、未推送的
`plugins/??` 组合），就会拿到**新 rev** 的模块，与旧 index/boot 混用，slot 装配崩溃 → 白板。

**修复（2026-11-06）**：版本号改为 `内容指纹 + index 原文 sha8`（`idx5-…`），rev 变化也重推
index+combo；relay 按内容复用没变的 `assets/`（`asset-ok.reused`），上行 ~11MB。同时 relay
支持 `RELAY_ROOT_PROXY` 白名单回源，解决 `workbuddy` 等绝对路径插件在手机端 404 的问题。

## 2. 现场证据

### 2.1 插件侧日志（`~/.dsh/tools/remote-relay.log`，UTC，本地 +8）

```
10:20:19Z fingerprint changed idx4-9c07df74-k → idx4-19f03303-k (+0 -0 ~79)
10:20:19Z full-mode push: 113 files, 23.8MB → relay
10:20:42Z fingerprint changed idx4-19f03303-k → idx4-8ff8fb8b-k (+0 -0 ~79)
10:20:42Z full-mode push: 113 files, 23.8MB → relay
10:21:44Z fingerprint changed idx4-8ff8fb8b-k → idx4-ad4e902d-k (+0 -0 ~81)
10:21:44Z full-mode push: 113 files, 23.8MB → relay      ← relay 最终停留在这里
10:23:00Z full-mode assets up-to-date (v=idx4-ad4e902d-k, 113 files)
10:34:00Z full-mode assets up-to-date (v=idx4-ad4e902d-k, 113 files)
10:35:47Z terminal connected / disconnected               ← 手机反复打开、立刻断开
10:37:47Z pairing reset: new sid generated
10:37:48Z full-mode push: 113 files, 23.8MB → relay (local idx4-ad4e902d-k / relay 无)
10:37:50Z full-mode assets committed: v=idx4-ad4e902d-k
```

要点：

- 18:20–18:21 连续三次重推，每次 `+0 -0 ~79`，变化的正是 index 与 79 个 combo——这就是 rev 变化导致的整包重传（尚未归一化时的行为）；
- 18:23 之后一直 `up-to-date`，**没有再推**（此时已是含 rev 归一化的逻辑）；
- 重置配对后重推的版本号与 10:21:44 那次**完全相同**——内容没变，变的是 rev 与 sid。

### 2.2 手机端控制台

```
manifest.webmanifest  401 (Unauthorized)
/manifest.webmanifest failed, code 401
/dsh-whale/widget.js  404
index-BgUyXZcc.js:59 SlotAssemblyError:
  scope 'session-maybe' rendered without an installed adapter
  at ScopeProvider (plugins/??…&rev=df46ae3ba3b1:32285)
index-BgUyXZcc.js:57 Uncaught SlotAssemblyError … （React 树整体卸载 → 白板）
```

### 2.3 本机当前 index（`~/.dsh/tools/remote-relay.index.html`，18:34 dump）

```
<script src="plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=da695bd15e8d">
<script src="./assets/index-BgUyXZcc.js">
<link rel="preload" href="plugins/??…&amp;rev=2bd5968318ec">
<link rel="preload" href="plugins/??…&amp;rev=8ea1d25d72c9">
```

本机与手机端的 **rev 三个全不同**，但 `index-BgUyXZcc.js` 文件名相同（dsh 版本一致，
`__DSH_BOOT__` 里 `release.version = 0.2.2-rc.1`）。

### 2.4 `SlotAssemblyError` 的含义（dsh 源码）

```js
const adapter = host.scope(scope);
if (adapter === void 0) throw new SlotAssemblyError(`scope '${scope}' rendered without an installed adapter`);
```

`slot` 的 scope adapter 由 renderer 侧安装注册；**同一个 UI 只装一次**。出现「adapter 缺失」
基本只有两种原因：注册代码没跑到（某插件初始化失败），或 **同一批模块被以不同身份加载了两次、
注册表被覆盖**。后者与「旧 index + 新 rev 回源」吻合。

## 3. 已排除 / 待排除

| 假设 | 判断 | 依据 |
|---|---|---|
| approval policy 改动导致 | 排除 | 白板是渲染崩溃，与批准瀑布无关；且改回 ask 也不会重建 slot 注册 |
| 资产内容版本不一致 | 排除 | 重置前后版本号同为 `idx4-ad4e902d-k` |
| relay 进程重启导致 cookie 全失效 | 待查 | 能解释 `manifest.webmanifest 401`；但用户否认重启。401 也可能是页面生命周期内 token 失效，或浏览器对 manifest 请求未带 cookie |
| relay 卷丢失 / 资产目录被清 | 排除 | 若 liveDir 缺失，插件 `up-to-date` 逻辑不会触发重推，但重置后会重推——现象一致；不过 `full.json` 与 assets 同目录，同时丢失才成立，可能性低 |
| 旧 rev index + 新 rev 回源混用 | **主嫌** | rev 三个全不同已证实；回源通道见 §4 |

## 4. 机制：rev 归一化与「回源」的冲突

### 4.1 两个 rev 是不同的东西

- **内容指纹**（`idx4-…`）：`assetFingerprint()` 对文本做 `revless()` 归一化后取 sha8。
  rev 变化 → 指纹不变 → 不重推。**这是 `f43f373` 的设计目标。**
- **落盘身份**：`diskKey(key)` 对**原始 URL**（含 `?rev=`）取哈希，`assets/` 与 combo
  的落盘名都带 rev；index 里的引用也带 rev。**rev 变了，这批文件的 URL 就全变了。**

于是：内容不变时 relay 继续服务**旧 rev** 的 index 与资产，这是自洽的——**只要所有请求
都能在 relay 上命中**。

### 4.2 但运行时总有请求命中不了

`relay/full.mjs` 的未命中回源（第 491–495 行）是刻意保留的：

```js
// 资产未命中 → 回源设备：懒加载 chunk（如终端的 client.terminal.js）和
// 第三方插件文件只有运行时才会被请求，推送阶段拿不到清单
if ((req.method === 'GET' || req.method === 'HEAD') && !dec.split('/').includes('..')) {
  bridgeHttp(req, res, url); return;
}
```

而 `collectAssets()` 只收集 index 直接引用、CSS `url()` 与 `__DSH_BOOT__` 里的 `"url"`，
**懒加载 chunk 与组合脚本内部的相对 import 不在清单里**。这些请求回源本机时，本机按
**当前 rev** 生成响应（`plugins/??…&rev=新值`、注入新的 sourceMappingURL、新的 boot 引用）。

结果：页面里同时存在旧 rev 的 index/boot 与新 rev 的模块。dsh 的 client 模块按 rev 做
缓存/去重，同一插件出现两个身份 → 注册表被覆盖 → `slot` adapter 缺失 → 白板。

> 为什么之前不炸：18:23 之前旧代码每次重启都整包重推，relay 的 rev 永远与桌面端同步，
> 不存在新旧混用。`f43f373` 去掉重推的同时，没有处理「回源必须与 index 同 rev」这件事。

### 4.3 第三方插件也被一并推送到远程端（2026-11-06 追加证据）

推送清单实证（`~/.dsh/tools/remote-relay.manifest.json`，113 个 key）：

```
/plugins/??workbuddy-to-dsh/client.js&rev=*                     586,390 B
/plugins/??@xiao-hans/dsh-qwen-connect/client.js&rev=*           37,308 B
/plugins/??@deepseek-ai/dsh-api-remote-access/client.js&rev=*    28,078 B
/plugins/??@deepseek-ai/dsh-typert-registry/client.js&rev=*      26,446 B
/dsh-whale/widget.js                                          1,142,585 B
```

原因：`collectBootUrls()`（`plugin/lib/fullbridge.mjs:284`）把 `__DSH_BOOT__` 里**每个已启用
插件**的 client URL 都收进清单。这是"手机上的官方 UI 与桌面一致"的必要条件，但带来两类问题：

1. **用根绝对路径的插件在 relay 上必然 404**。`workbuddy-to-dsh` 的 client 直接用
   `/workbuddy/status`、`/workbuddy/usage`、`/workbuddy/requests` 这类根绝对路径
   （`dsh-plugin/lib/client.js`），而 relay 只托管 `/remote/full/*`；`dsh-whale` 注入的
   `<script src="/dsh-whale/widget.js">` 同理。结果是远程端持续刷 404、插件面板整体不可用
   （2026-11-06 手机 Network 面板实证）。
2. **可能加剧白板**：`/plugins/events` 是 `dsh-client-hmr` 的 SSE 通道，每次重连都会下发
   **host 当前完整插件图**，其中的 rev 是当前值；而 index/boot 里是旧 rev（§4.2）。前端按图
   重新加载 → 同一插件出现旧/新两份 → slot 注册表被覆盖。现场该请求报
   `ERR_INCOMPLETE_CHUNKED_ENCODING`（断流重连），正好放大这个过程。

处理方式：

- **E1（已实现，推荐）根路径白名单回源**：relay 环境变量 `RELAY_ROOT_PROXY`（逗号分隔前缀，
  如 `/workbuddy/,/dsh-whale/`），命中且带有效 `rrm_full` 时走既有 `bridgeHttp` 回源设备。
  插件在手机上恢复可用，无需改插件；未配置时保持 404（默认不扩大暴露面）。
- **E2 推送侧剔除**：`collectBootUrls` 跳过指定插件，并从 index 的 boot JSON 删掉对应 entries。
  注意这不彻底——`/plugins/events` 的图仍会带回这些条目，HMR 会二次加载；需要配合 relay
  对这些路径返回明确状态码。
- **E3 接受现状**：不改 relay，明确"远程端部分本机插件不可用"。

### 4.4 为什么重置配对能恢复
`plugin/lib/index.mjs:718` 的 `resetPairing` 会生成新 sid：

```js
if (patch.resetPairing === true) {
  config.sid = 'dsh-' + crypto.randomBytes(9).toString('hex');
  ...
  log('pairing reset: new sid generated');
}
```

relay 按 sid 分目录（`data/assets/<sid>/full`），新 sid 没有任何资产 → `full-info` 返回
`version: null` → 插件整包重推**当前 rev** 的一份 → 手机端 index 与所有回源内容同 rev →
不再混用。这与「内容版本号没变」完全一致。

## 5. 修复方案

> **状态（2026-11-06）**：A1 与 E1 已实现并有测试覆盖（relay 24 项、E2E 17 组）。
> B（term-token 持久化）、C（401 探针）、D（旧 sid 清理）尚未做。

按优先级排列。A 是根治，B/C 是体验兜底，D 是运维清理。

### A. 保证「回源内容」与「托管 index」同 rev（根治）

**A1（已实现，推荐）**：版本号带上 index 的 rev 段——内容不变、rev 变了也重推
index + `plugins/??` 组合脚本；`assets/` 下没变的文件由 relay **按内容复用**。

- 实现：`relay/full.mjs` 在 `commitPush` 写 `data/assets/<sid>/full-files.json`（path→sha8），
  下一次 `beginPush` 用 `sha8 + size` 比对上一批 `full/`，命中的直接复制到暂存目录，
  并在 `asset-ok.reused` 里列出；插件跳过这些 path 的 `asset-put/end`。
- 按 2026-11-06 的清单估算：113 文件 / 23.8MB，「只有 rev 变」时上行约 **11MB**（index + 3 个 combo），
  `assets/` 约 13MB 全部复用。
- 兼容：旧插件照常整包重发，relay 对已复用文件忽略重复分片，不会报乱序。

**A2（更彻底）**：**rev 在托管侧固定**。relay 落盘时把 URL 里的 `rev` 归一化成批次固定值
（如 `r1`），服务 index 时把所有 `rev=…` 重写为 `r1`，同时把回源响应中的 rev 也重写。
这样「内容不变」时 relay 的 URL 永远稳定，插件可以真正做到零重推。
- 风险：需要改写 index、combo 体尾的 `sourceMappingURL` 与 boot JSON 里的 `"url"`/`"rev"`；
  任何遗漏都会造成新的混用。建议先在测试里用真实资产做字节比对。

**A3（回退）**：撤回 rev 归一化，恢复「rev 变就重推」。正确性最高，代价是每次重启 24MB。
若不打算投入 A1/A2 的工程量，这是最稳的止损。

> 我倾向 **A1**：把「版本 = 内容指纹 + index rev」用于决定是否推 index/combo，`assets/`
> 仍按内容跳过；协议加一个 `asset-reuse` 让 relay 复用旧文件，避免 24MB。

### B. term-token 改为可跨重启验证（建议做）

现状：`relay/full.mjs:80` 的 `termTokens` 是纯内存 `Map`，relay 一重启全部失效，
所有手机 cookie 报废（只能用「重置配对」或等网关页自动重走）。但 `full.json`/`assets`
都在卷上，作者本意是「重启不影响」。

改法（无状态签名，约 30 行）：

```js
// 启动时：secret = 读 data/secret.key，不存在则随机 32B 并写盘
// 签发：token = `${exp}.${sid}.${hmac(secret, `${exp}.${sid}`)}`（base64url）
// 校验：解析 exp/sid → 验签 → exp > now；内存 Map 仅保留为兼容旧 token 的兜底
```

- 好处：relay 重启、容器更新后，手机端 cookie 继续有效，不需要重新扫码；
- 迁移：旧 token 仍走内存 Map 校验，7 天后自然淘汰。

### C. 401 兜底：白板 → 自动回配对页（体验）

官方 UI 在 API/资源全 401 时不会自己回配对页，只能白屏。可在 relay 输出 index 时注入一段
探针（`rewriteIndex` 阶段，仅 `full/index.html`）：

```js
// <script> fetch('/remote/full/manifest.webmanifest', { cache: 'no-store' })
//   若 401 → location.replace('/remote/') </script>
```

网关页会用 localStorage 里的设备凭据自动完成「连中继 → 拿 term-token → 换 cookie → 跳回」，
用户只看到一次短暂的过渡，而不是白板。注意配合已有的 `loopGuard`（30s 内 >6 次即停）。

### D. 重置配对时清理旧 sid 资产（运维）

`data/assets/<旧sid>/full` 现在是**孤儿目录**（每次重置泄漏约 24MB）。建议在
`pairing reset` 或设备下次上线时，清理非当前 sid 的资产目录（保留最近 N 个）。

## 6. 下次白板的取证清单（5 分钟）

复现时按顺序抓，能一次性区分是「凭据失效」还是「资产/rev 混用」：

1. **手机浏览器控制台**：只看两条——
   - `manifest.webmanifest` 的状态码（401 → 凭据问题；200 → 资产/前端问题）；
   - 是否有 `SlotAssemblyError` / `Uncaught`（有 → 渲染层，指向混用）。
2. **Network**：过滤 `full/api/`，看是否有 401/503；过滤 `?rev=`，记下 index 与 combo 的 rev。
3. **relay 日志**（服务器）：搜 `term-token` 与进程启动行——重启过就能对上。
4. **本机**：`~/.dsh/tools/remote-relay.log` 搜 `up-to-date` / `push`；对比
   `remote-relay.manifest.json` 的 `version` 与 relay 返回的 `full-info-state.version`。
5. **对比 rev**：`remote-relay.index.html` 里的 `rev=` 与上一步 Network 里的是否一致。
   不一致说明 relay/插件仍是 `idx4` 版本（修复前）；`idx5-` 版本下应始终一致。

## 7. 相关代码

| 位置 | 作用 |
|---|---|
| `plugin/lib/fullbridge.mjs:323` | `revless()`：rev 归一化（指纹用） |
| `plugin/lib/fullbridge.mjs:370-385` | `fingerprintHash` / `assetFingerprint`：内容指纹 |
| `plugin/lib/fullbridge.mjs:431` | 版本 = `idx5-<内容指纹>-<index 原文 sha8>`（rev 变化也重推） |
| `plugin/lib/fullbridge.mjs:440` | `if (st.version === version) return`：版本一致才跳过推送 |
| `relay/full.mjs:133-171` | `serveAsset`：托管与 cookie 门禁 |
| `relay/full.mjs:450` | `full-info` 应答（只回 `full.json` 里的 version，不校验文件是否存在） |
| `relay/full.mjs:485-507` | `handleHttp`：未命中资产回源设备 |
| `relay/full.mjs:202` | `reuseUnchanged`：rev 变化时按 sha8 复用上一批文件 |
| `relay/full.mjs:508` | `handleRootProxy`：根路径白名单回源（E1） |
| `relay/full.mjs:96-121` | `termTokens`：内存态凭据（B 项待改） |
| `plugin/lib/index.mjs:718` | `resetPairing`：换新 sid |

## 8. 验证顺序

1. **relay 单测**（24 项，含新增的「根路径白名单」与「rev 变化时复用未变文件」）：
   `node --test relay/test/relay.test.mjs relay/test/full.test.mjs`
2. **全链路 E2E**（17 组）：`node plugin/test/test-dist.mjs`。其中第 14 组验证
   「rev 变 → 重推 index+combo、assets 复用、内容真变才重传」。
3. **真机**：重启一次 dsh（rev 变化），看插件日志应为
   `full-mode push: … (复用 N 个文件)`，随后 `up-to-date`；手机端刷新后 Console 不应再有
   `SlotAssemblyError`，`/workbuddy/*` 在配置了 `RELAY_ROOT_PROXY` 后应返回 200（而非 404）。
