// ── 完整模式：官方 UI 托管 + HTTP/WS 桥接（协议见 docs/PROTOCOL.md §3）───────
// 独立于轻量 UI 的 data 桥：手机侧凭 rrm_full cookie 访问 /remote/full/*，
// relay 把 API 请求/WS 升级翻译成帧，经 device 连接转发到插件，由插件在本机
// 127.0.0.1:<dsh 端口> 完成真实请求。资产由插件推送落盘，重启不丢。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FULL_BASE = '/remote/full';
const BODY_MAX = 5 * 1024 * 1024;        // 手机上传请求体上限（b64 后 ~6.7MB，帧上限 8MB 内）
const CHUNK = 256 * 1024;                // http-res-chunk / asset-put 单帧原始字节
const RES_CAP = 256 * 1024 * 1024;       // 单响应累计上限
const WINDOW = 2 * 1024 * 1024;          // http 流控窗口（未 ack 字节数）
const FILE_MAX = 20 * 1024 * 1024, PUSH_TOTAL_MAX = 128 * 1024 * 1024, PUSH_FILES_MAX = 800;
const REQ_TIMEOUT = 120 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

const sha8 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const safePath = (p) => typeof p === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(p) && !p.split('/').includes('..');
const safePushId = (p) => typeof p === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p);
const pickReqHeaders = (h) => {
  const out = {};
  for (const k of ['content-type', 'accept', 'accept-language', 'range', 'user-agent']) if (h[k]) out[k] = String(h[k]).slice(0, 512);
  return out;
};
const RES_HEADER_BLOCK = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'upgrade', 'alt-svc']);
const filterResHeaders = (h) => {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (!RES_HEADER_BLOCK.has(k.toLowerCase())) out[k] = Array.isArray(v) ? v.join(', ') : String(v).slice(0, 2048);
  return out;
};
const fromB64 = (v) => (typeof v === 'string' && v.length < 8 * 1024 * 1024 ? Buffer.from(v, 'base64') : null);

/** index.html 绝对路径改写：仅处理非 <script> 段（保住注入的 __DSH_BOOT__ 行） */
export function rewriteIndex(html) {
  return html.split(/(<script[\s\S]*?<\/script>)/gi).map((seg) =>
    /^<script/i.test(seg) ? seg : seg.replace(/(\s(?:href|src|poster)=")\/([^/"])/g, '$1$2')
  ).join('');
}

/**
 * @param {object} opts
 *  dataDir       数据目录（资产落盘 dataDir/assets/full）
 *  getDevice     (sid) => device WsConn | null
 *  WsConn        relay.mjs 的 WS 连接类（桥接手机侧 socket）
 *  liveConns     Set —— 所有活 WS 连接（close 时要能销毁）
 *  tlsReady      bool —— cookie 是否加 Secure
 *  log           日志函数
 */
export function setupFullMode({ dataDir, getDevice, WsConn, liveConns, tlsReady, log }) {
  const assetsDir = path.join(dataDir, 'assets');
  /** 资产按设备 sid 隔离：assets/<sid>/full —— 多设备/多用户互不覆盖（cookie 里自带 sid） */
  const liveDirOf = (sid) => path.join(assetsDir, sid, 'full');
  const metaFileOf = (sid) => path.join(assetsDir, sid, 'full.json');

  // ── 托管状态（每设备一份）──
  const liveMetas = new Map();   // sid → {version, files, bytes}
  const loadMeta = (sid) => {
    if (liveMetas.has(sid)) return liveMetas.get(sid);
    let m = { version: null, files: 0, bytes: 0 };
    try {
      const raw = JSON.parse(fs.readFileSync(metaFileOf(sid), 'utf8'));
      if (raw && typeof raw.version === 'string') m = raw;
    } catch { /* 首次无 */ }
    liveMetas.set(sid, m);
    return m;
  };

  /** pushId → { sid, dir, files:Map(path→{size,sha8}), got:Map(path→{fd,bytes}), total, version } */
  const pushes = new Map();
  /** token → { sid, exp } */
  const termTokens = new Map();
  /** reqId → { sid, res, bytesOut, last, done, timer } */
  const httpPending = new Map();
  /** wsId → { sid, phone } */
  const wsBridges = new Map();
  let reqSeq = 0, wsSeq = 0;

  const send = (conn, payload) => { try { conn.sendText(JSON.stringify({ type: 'data', payload, ts: Date.now() })); } catch { /* ignore */ } };
  const err = (conn, code, message) => send(conn, { type: 'error', fatal: false, code, message: String(message).slice(0, 300) });

  // ── term-token / cookie ──
  function issueTermToken(sid) {
    const now = Date.now();
    for (const [t, r] of termTokens) if (r.exp < now) termTokens.delete(t);
    while (termTokens.size >= 2000) termTokens.delete(termTokens.keys().next().value);
    const token = b64url(crypto.randomBytes(32));
    termTokens.set(token, { sid, exp: now + 7 * 86400 * 1000 });
    return token;
  }
  function sidOfRequest(req) {
    const m = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('rrm_full='));
    if (!m) return null;
    const rec = termTokens.get(m.slice(9));
    if (!rec || rec.exp < Date.now()) return null;
    return rec.sid;
  }
  const cookieHeader = (token) => `rrm_full=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${tlsReady ? '; Secure' : ''}`;

  function handleFullAuth(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ''));
    const rec = m && termTokens.get(m[1]);
    if (!rec || rec.exp < Date.now()) { res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"bad-token"}'); return; }
    res.writeHead(204, { 'set-cookie': cookieHeader(m[1]) }).end();
  }

  // ── 资产托管：静态服务 ──
  function serveAsset(req, res, url) {
    const sid = sidOfRequest(req);
    if (!sid) {
      const wantsHtml = req.headers['sec-fetch-mode'] === 'navigate' || String(req.headers.accept || '').includes('text/html');
      if (wantsHtml) { res.writeHead(302, { location: '/remote/' }).end(); return; }
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unpaired"}'); return;
    }
    let rel = url.pathname.slice(FULL_BASE.length);            // '/xxx' or '/'
    if (rel === '' || rel === '/') rel = '/index.html';
    if (url.search) rel += url.search;                          // combo URL（plugins/??a,b）的文件列表在 search 里
    const isCombo = /[?&@]/.test(rel);
    const clean = isCombo
      ? 'enc-' + crypto.createHash('sha256').update(rel).digest('hex').slice(0, 12)
      : path.normalize(rel).replace(/^([/\\])+/, '');
    if (!isCombo && clean.split(/[\\/]/).includes('..')) { res.writeHead(400).end(); return; }
    const liveDir = liveDirOf(sid);
    if (!fs.existsSync(liveDir)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 asset missing (等待设备推送，或开启插件 syncFullUi)'); return; }
    const file = path.join(liveDir, clean);
    if (!isCombo && !file.startsWith(liveDir + path.sep)) { res.writeHead(400).end(); return; }
    let buf;
    try { buf = fs.readFileSync(file); } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 asset missing (等待设备推送，或开启插件 syncFullUi)'); return; }
    const ext = path.extname(file).toLowerCase();
    const immutable = !isCombo && (clean.startsWith('assets' + path.sep) || clean.startsWith('assets/'));
    const cache = clean === 'index.html' ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
    let body = buf;
    if (ext === '.html' && req.method !== 'HEAD') body = Buffer.from(rewriteIndex(buf.toString('utf8')), 'utf8');
    const mime = isCombo ? 'text/javascript; charset=utf-8' : (MIME[ext] || 'application/octet-stream');
    res.writeHead(200, { 'content-type': mime, 'cache-control': cache, 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ── 资产推送：device 帧 ──
  function beginPush(conn, sid, p) {
    if (!safePushId(p.pushId)) { err(conn, 'asset-push-id', 'bad pushId'); return; }
    const id = p.pushId;
    const list = Array.isArray(p.files) ? p.files : [];
    if (!list.length || list.length > PUSH_FILES_MAX) { err(conn, 'asset-manifest', 'files 数量非法'); return; }
    const files = new Map(); let total = 0;
    for (const f of list) {
      if (!f || !safePath(f.path) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > FILE_MAX) { err(conn, 'asset-path', `非法条目 ${f && f.path}`); return; }
      if (files.has(f.path)) { err(conn, 'asset-path', `重复 ${f.path}`); return; }
      files.set(f.path, { size: f.size, sha8: String(f.sha8 || '') });
      total += f.size;
    }
    if (total > PUSH_TOTAL_MAX) { err(conn, 'asset-total', '总量超限'); return; }
    if (pushes.has(id)) abortPush(id);
    const dir = path.join(assetsDir, '.staging-' + id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const p2 of files.keys()) fs.mkdirSync(path.join(dir, ...p2.split('/').slice(0, -1)), { recursive: true });   // 嵌套路径预建目录
    pushes.set(id, { sid, dir, files, got: new Map(), total, version: String(p.version || '') });
    send(conn, { type: 'asset-ok', pushId: id });
  }
  function putChunk(conn, p) {
    const push = pushes.get(String(p.pushId || ''));
    if (!push || push.sid !== conn._fullSid) { err(conn, 'asset-push', '无此推送'); return; }
    const meta = push.files.get(String(p.path || ''));
    if (!meta) { err(conn, 'asset-path', `未申报 ${p.path}`); abortPush(String(p.pushId)); return; }
    const seq = p.seq | 0;
    const chunk = fromB64(p.data);
    if (!Number.isSafeInteger(p.seq) || !chunk || chunk.length > CHUNK) { err(conn, 'asset-chunk', '帧字段非法'); return; }
    const rec = push.got.get(p.path) || { fd: null, bytes: 0 };
    if (rec.bytes !== seq * CHUNK) { err(conn, 'asset-seq', `乱序 ${p.path}@${seq}`); return; }
    try {
      if (!rec.fd) rec.fd = fs.openSync(path.join(push.dir, ...p.path.split('/')), 'a');
      fs.writeFileSync(rec.fd, chunk);   // 单设备独占目录，同步写足够
    } catch (e) { err(conn, 'asset-io', String(e.message || e)); abortPush(String(p.pushId)); return; }
    rec.bytes += chunk.length;
    push.got.set(p.path, rec);
    if (rec.bytes > meta.size) { err(conn, 'asset-size', `超申报 ${p.path}`); abortPush(String(p.pushId)); }
  }
  function endFile(conn, p) {
    const push = pushes.get(String(p.pushId || ''));
    if (!push || push.sid !== conn._fullSid) { err(conn, 'asset-push', '无此推送'); return; }
    const meta = push.files.get(String(p.path || '')); const rec = push.got.get(p.path);
    if (!meta || !rec || !rec.fd) { err(conn, 'asset-file', `缺数据 ${p.path}`); return; }
    try { fs.closeSync(rec.fd); } catch { /* ignore */ }
    rec.fd = null;
    const buf = fs.readFileSync(path.join(push.dir, ...String(p.path).split('/')));
    if (buf.length !== meta.size || (meta.sha8 && sha8(buf) !== meta.sha8)) {
      err(conn, 'asset-sha', `校验失败 ${p.path}`);
      abortPush(String(p.pushId)); return;
    }
    rec.bytes = -1;   // -1 = 该文件已完成
  }
  function commitPush(conn, p) {
    const id = String(p.pushId || ''), push = pushes.get(id);
    if (!push || push.sid !== conn._fullSid) { err(conn, 'asset-push', '无此推送'); return; }
    for (const [p2, rec] of push.got) if (rec.bytes !== -1) { err(conn, 'asset-incomplete', `未完成 ${p2}`); return; }
    if (push.got.size !== push.files.size) { err(conn, 'asset-incomplete', `缺 ${push.files.size - push.got.size} 个文件`); return; }
    const liveDir = liveDirOf(push.sid);
    fs.mkdirSync(path.dirname(liveDir), { recursive: true });
    const trash = path.join(assetsDir, '.trash-' + id);
    fs.rmSync(trash, { recursive: true, force: true });
    let moved = false;
    try {
      if (fs.existsSync(liveDir)) fs.renameSync(liveDir, trash);
      moved = true;
      fs.renameSync(push.dir, liveDir);
    } catch (e) {
      if (moved) { try { fs.renameSync(trash, liveDir); } catch { /* ignore */ } }
      err(conn, 'asset-io', String(e.message || e)); return;
    }
    fs.rmSync(trash, { recursive: true, force: true });
    const bytes = [...push.files.values()].reduce((a, f) => a + f.size, 0);
    const liveMeta = { version: String(p.version || push.version), files: push.files.size, bytes };
    try { fs.writeFileSync(metaFileOf(push.sid), JSON.stringify(liveMeta)); } catch { /* ignore */ }
    liveMetas.set(push.sid, liveMeta);
    pushes.delete(id);
    log(`full-mode assets committed for ${push.sid}: v=${liveMeta.version} files=${liveMeta.files} bytes=${liveMeta.bytes}`);
    send(conn, { type: 'asset-committed', pushId: id, version: liveMeta.version, files: liveMeta.files, bytes: liveMeta.bytes });
  }
  function abortPush(id) {
    const push = pushes.get(id);
    if (!push) return;
    for (const rec of push.got.values()) { if (rec.fd) { try { fs.closeSync(rec.fd); } catch { /* ignore */ } } }
    try { fs.rmSync(push.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    pushes.delete(id);
  }

  // ── HTTP 桥（手机 ↔ relay ↔ device）──
  function bridgeHttp(req, res, url) {
    const sid = sidOfRequest(req);
    if (!sid) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unpaired"}'); return; }
    const device = getDevice(sid);
    if (!device) { res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"device-offline"}'); return; }
    const chunks = [];
    let size = 0, gotEnd = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) { if (!res.headersSent) res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"body-too-large"}'); req.destroy(); gotEnd = true; return; }
      chunks.push(c);
    });
    req.on('error', () => { /* 手机中途断开 */ });
    req.on('end', () => {
      if (gotEnd) return; gotEnd = true;
      if (!getDevice(sid)) { res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"device-offline"}'); return; }
      const reqId = 'h' + (++reqSeq);
      const pending = { sid, res, bytesOut: 0, done: false, timer: null };
      pending.timer = setTimeout(() => {
        const d = getDevice(sid); if (d) send(d, { type: 'http-cancel', reqId });
        log(`http bridge timeout: ${reqId}`);
        finishHttp(reqId);
      }, REQ_TIMEOUT);
      pending.timer.unref?.();
      httpPending.set(reqId, pending);
      res.on('close', () => {   // 手机提前断开 → 通知 device 中止
        if (httpPending.has(reqId)) {
          const d = getDevice(sid); if (d) send(d, { type: 'http-cancel', reqId });
          finishHttp(reqId);
        }
      });
      const payload = {
        type: 'http-req', reqId, method: req.method,
        path: url.pathname.slice(FULL_BASE.length + 1),
        query: url.search ? url.search.slice(1) : '',
        headers: pickReqHeaders(req.headers),
      };
      if (chunks.length) payload.body = Buffer.concat(chunks).toString('base64');
      send(device, payload);
    });
  }
  function finishHttp(reqId) {
    const p = httpPending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    httpPending.delete(reqId);
    // 仅在响应未正常结束时才断 socket；正常 end 后销毁会把 keep-alive 连接 RST 掉，
    // 毒化客户端连接池（下一个复用连接的请求直接 ECONNRESET）
    if (!p.res.writableEnded) { try { p.res.destroy(); } catch { /* ignore */ } }
  }
  const alive = (sid) => { const d = getDevice(sid); return d || null; };

  function onHttpResHead(sid, p) {
    const pend = httpPending.get(p.reqId);
    if (!pend || pend.sid !== sid) return;
    const status = p.status | 0;
    if (status < 100 || status > 599) { try { pend.res.writeHead(502).end(); } catch { /* ignore */ } finishHttp(p.reqId); return; }
    try { pend.res.writeHead(status, filterResHeaders(p.headers)); } catch { finishHttp(p.reqId); return; }
    if (pend.res.req?.method === 'HEAD' || status === 204 || status === 304) {
      try { pend.res.end(); } catch { /* ignore */ }
      finishHttp(p.reqId);
    }
  }
  function onHttpResChunk(sid, p) {
    const pend = httpPending.get(p.reqId);
    if (!pend || pend.sid !== sid) return;
    const buf = fromB64(p.data);
    if (!buf) return;
    pend.bytesOut += buf.length;
    if (pend.bytesOut > RES_CAP) { const d = alive(sid); if (d) send(d, { type: 'http-cancel', reqId: p.reqId }); finishHttp(p.reqId); return; }
    try { pend.res.write(buf); } catch { finishHttp(p.reqId); return; }
    const d = alive(sid);
    if (d) send(d, { type: 'http-ack', reqId: p.reqId, bytes: buf.length });   // 简化信用：按解码字节计
  }
  function onHttpResEnd(sid, p) {
    const pend = httpPending.get(p.reqId);
    if (!pend || pend.sid !== sid) return;
    try { pend.res.end(); } catch { /* ignore */ }
    finishHttp(p.reqId);
  }
  function onHttpResAbort(sid, p) {
    if (httpPending.has(p.reqId)) finishHttp(p.reqId);
  }

  // ── WS 桥 ──
  function bridgeWs(req, socket, head, url) {
    const sid = sidOfRequest(req);
    if (!sid) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const device = getDevice(sid);
    if (!device) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
    if (wsBridges.size >= 64) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = new WsConn(socket);
    liveConns.add(conn);
    if (head && head.length) conn._feed(head);
    const wsId = 'w' + (++wsSeq);
    wsBridges.set(wsId, { sid, phone: conn });
    conn.onmessage = (data, isText) => {
      const d = getDevice(sid);
      if (!d) { conn.close(4010, 'device-disconnected'); return; }
      if (isText) send(d, { type: 'ws-text', wsId, text: String(data).slice(0, 4 * 1024 * 1024) });
      else send(d, { type: 'ws-bin', wsId, data: Buffer.from(data).toString('base64') });
    };
    conn.onclose = () => {
      liveConns.delete(conn);
      if (!wsBridges.has(wsId)) return;
      wsBridges.delete(wsId);
      const d = getDevice(sid); if (d) send(d, { type: 'ws-close', wsId, code: 1006, reason: '' });
    };
    send(device, { type: 'ws-open', wsId, path: url.pathname.slice(FULL_BASE.length + 1), query: url.search ? url.search.slice(1) : '', headers: {} });
  }
  function onDeviceWsFrame(sid, p, isText) {
    const b = wsBridges.get(p.wsId);
    if (!b || b.sid !== sid) return;
    try {
      if (isText) b.phone.sendText(String(p.text ?? ''));
      else { const buf = fromB64(p.data); if (buf) b.phone.sendBinary(buf); }
    } catch { /* ignore */ }
  }
  function onDeviceWsClosed(sid, p) {
    const b = wsBridges.get(p.wsId);
    if (!b || b.sid !== sid) return;
    wsBridges.delete(p.wsId);
    try { b.phone.close((p.code | 0) || 1006, String(p.reason || '').slice(0, 100)); } catch { /* ignore */ }
  }
  function deviceOffline(sid) {
    for (const [id, push] of pushes) if (push.sid === sid) abortPush(id);
    for (const reqId of [...httpPending.keys()]) {
      const p = httpPending.get(reqId);
      if (p && p.sid === sid) finishHttp(reqId);
    }
    for (const [wsId, b] of wsBridges) if (b.sid === sid) {
      try { b.phone.close(4010, 'device-disconnected'); } catch { /* ignore */ }
      wsBridges.delete(wsId);
    }
  }

  // ── device 帧（relay.mjs 分发）──
  function deviceAsset(conn, sid, p) {
    conn._fullSid = sid;   // 后续帧以此校验归属
    switch (p.type) {
      case 'full-info': { const m = loadMeta(sid); send(conn, { type: 'full-info-state', version: m.version, files: m.files, bytes: m.bytes }); return; }
      case 'asset-begin': beginPush(conn, sid, p); return;
      case 'asset-put': putChunk(conn, p); return;
      case 'asset-end': endFile(conn, p); return;
      case 'asset-commit': commitPush(conn, p); return;
      case 'asset-abort': abortPush(String(p.pushId || '')); return;
      default: err(conn, 'asset-type', `未知 ${p.type}`);
    }
  }
  function deviceBridge(conn, sid, p) {
    conn._fullSid = sid;
    switch (p.type) {
      case 'http-res-head': onHttpResHead(sid, p); return;
      case 'http-res-chunk': onHttpResChunk(sid, p); return;
      case 'http-res-end': onHttpResEnd(sid, p); return;
      case 'http-res-abort': onHttpResAbort(sid, p); return;
      case 'ws-opened': return;
      case 'ws-text': onDeviceWsFrame(sid, p, true); return;
      case 'ws-bin': onDeviceWsFrame(sid, p, false); return;
      case 'ws-closed': onDeviceWsClosed(sid, p); return;
      default: err(conn, 'bridge-type', `未知 ${p.type}`);
    }
  }

  // 手机 mux WS 保活（30s ping）
  const hb = setInterval(() => {
    for (const b of wsBridges.values()) {
      if (!b.phone.alive) { try { b.phone.close(4000, 'keepalive-timeout'); } catch { /* ignore */ } continue; }
      b.phone.alive = false;
      b.phone.ping();
    }
  }, 30000);
  hb.unref?.();

  // ── HTTP 入口（relay.mjs 分发）──
  function handleHttp(req, res, url) {
    const pathname = url.pathname;
    if (pathname === '/remote/full-auth') { handleFullAuth(req, res); return; }
    if (pathname === FULL_BASE) { res.writeHead(301, { location: FULL_BASE + '/' }).end(); return; }
    if (pathname.startsWith(FULL_BASE + '/api/')) { bridgeHttp(req, res, url); return; }
    serveAsset(req, res, url);
  }
  const isFullApiUpgrade = (pathname) => pathname.startsWith(FULL_BASE + '/api/');
  const info = () => ({
    devicesWithAssets: [...liveMetas.values()].filter((m) => m.version).length,
    assetVersions: [...new Set([...liveMetas.values()].map((m) => m.version).filter(Boolean))].length,
    pushes: pushes.size, termTokens: termTokens.size, httpPending: httpPending.size, wsBridges: wsBridges.size,
  });

  return { handleHttp, isFullApiUpgrade, deviceAsset, deviceBridge, deviceOffline, issueTermToken, bridgeWs, info };
}
