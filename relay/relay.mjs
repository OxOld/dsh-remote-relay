#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// dsh-remote-relay · 中继服务器（单文件，零依赖，Node ≥ 20）
//
// 职责：托管轻量 UI 静态资源 + WS 中继（device↔terminal 桥接 + 配对鉴权）。
// 协议见 ../docs/PROTOCOL.md；本文件永不 import dsh 的任何东西。
//
// 运行：  node relay.mjs [--port 8787] [--tls-cert full.pem] [--tls-key key.pem]
// 环境变量：RELAY_PORT / RELAY_TLS_CERT / RELAY_TLS_KEY / RELAY_PUBLIC_DIR / RELAY_DATA_DIR
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROTO = 1;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_PATH = '/remote/ws';

// ── 小工具 ───────────────────────────────────────────────────────────────────
const log = (...a) => console.log(new Date().toISOString(), '[relay]', ...a);
const b64url = (buf) => Buffer.from(buf).toString('base64url');
/** proof = base64url(HMAC-SHA256(key=utf8(hash), msg=`${nonce}|${role}|${sid}`)) */
const calcProof = (hash, nonce, role, sid) =>
  crypto.createHmac('sha256', Buffer.from(String(hash), 'utf8'))
    .update(`${nonce}|${role}|${sid}`).digest('base64url');
const sha256b64 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('base64url');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
const validSid = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(s);
const validHash = (s) => { try { return typeof s === 'string' && Buffer.from(s, 'base64').length === 32; } catch { return false; } };

// ── RFC6455 服务端子集（text/binary/ping/pong/close + 分片，帧长上限保护）──────
class WsConn {
  constructor(socket, { maxPayload = 8 * 1024 * 1024 } = {}) {
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.onmessage = null;   // (data: Buffer|string, isText: boolean)
    this.onclose = null;     // (code, reason)
    this.onerror = null;
    this.alive = true;
    this._buf = Buffer.alloc(0);
    this._frag = null;       // {opcode, chunks:[]}
    this._closed = false;
    socket.setNoDelay(true);
    socket.on('data', (c) => this._feed(c));
    socket.on('close', () => { if (process.env.RELAY_DEBUG) log('ws socket close'); this._teardown(1006, ''); });
    socket.on('error', (e) => { if (this.onerror) this.onerror(e); this._teardown(1006, ''); });
    socket.on('end', () => { try { socket.end(); } catch { /* ignore */ } });
  }

  _feed(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try { while (this._parseFrame()) { /* keep parsing */ } } catch (e) {
      this.close(1009, 'frame-error');
    }
  }

  _need(n) { return this._buf.length >= n; }
  _take(n) { const b = this._buf.subarray(0, n); this._buf = this._buf.subarray(n); return b; }

  _parseFrame() {
    if (!this._need(2)) return false;
    const b0 = this._buf[0], b1 = this._buf[1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (!this._need(4)) return false; len = this._buf.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (!this._need(10)) return false;
      const hi = this._buf.readUInt32BE(2), lo = this._buf.readUInt32BE(6);
      if (hi > 0x1fffff) { this.close(1009, 'too-large'); return false; }
      len = hi * 0x100000000 + lo; off = 10;
    }
    if (len > this.maxPayload) { this.close(1009, 'too-large'); return false; }
    if (!masked) { this.close(1002, 'unmasked-client-frame'); return false; }
    if (!this._need(off + 4 + len)) return false;
    this._take(off);                          // b0/b1 + 扩展长度
    const maskKey = this._take(4);
    const payload = Buffer.from(this._take(len));   // 拷贝，避开 subarray 引用未消费缓冲
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];

    if (opcode >= 0x8) {                             // 控制帧：不分片
      if (!fin || payload.length > 125) { this.close(1002, 'bad-control'); return false; }
      if (opcode === 0x8) {                          // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.close(code, '', true);
        return false;
      }
      if (opcode === 0x9) { this._sendFrame(0xA, payload); return true; }   // ping → pong
      if (opcode === 0xA) { this.alive = true; return true; }               // pong
      this.close(1002, 'bad-opcode'); return false;
    }
    if (opcode === 0x0) {                            // continuation
      if (!this._frag) { this.close(1002, 'unexpected-cont'); return false; }
      this._frag.chunks.push(payload);
      if (fin) { this._deliver(this._frag.opcode, Buffer.concat(this._frag.chunks)); this._frag = null; }
      return true;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (this._frag) { this.close(1002, 'nested-frag'); return false; }
      if (fin) { this._deliver(opcode, payload); return true; }
      this._frag = { opcode, chunks: [payload] };
      return true;
    }
    this.close(1002, 'bad-opcode'); return false;
  }

  _deliver(opcode, payload) {
    if (this._closed) return;
    if (opcode === 0x1) {
      let text; try { text = payload.toString('utf8'); } catch { this.close(1007, 'bad-utf8'); return; }
      if (this.onmessage) this.onmessage(text, true);
    } else if (this.onmessage) this.onmessage(payload, false);
  }

  _sendFrame(opcode, payload) {
    if (this._closed || this.socket.destroyed) return false;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    try { this.socket.write(Buffer.concat([head, payload])); return true; } catch { return false; }
  }

  sendText(str) { return this._sendFrame(0x1, Buffer.from(String(str), 'utf8')); }
  sendBinary(buf) { return this._sendFrame(0x2, Buffer.from(buf)); }
  ping() { return this._sendFrame(0x9, Buffer.alloc(0)); }
  /** echo=true 表示这是对端 close 的回显，直接等 socket 自关 */
  close(code = 1000, reason = '', echo = false) {
    if (this._closeSent) return;
    this._closeSent = true;
    const r = Buffer.from(String(reason), 'utf8').subarray(0, 120);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    if (r.length) r.copy(p, 2);
    this._sendFrame(0x8, p);        // 先发帧（_closed 置位会拦截 _sendFrame）
    this._closed = true;
    if (!echo) { try { this.socket.end(); } catch { /* ignore */ } }
    setTimeout(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, 3000).unref?.();
  }

  _teardown(code, reason) {
    if (this._oncloseFired) return;      // onclose 只触发一次（先收 close 帧或先本地 close 都要触发）
    this._oncloseFired = true;
    this._closed = true;
    this.alive = false;
    if (this.onclose) { try { this.onclose(code, reason); } catch { /* ignore */ } }
  }
}

// ── 静态资源 ─────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
  '.map': 'application/json', '.wasm': 'application/wasm',
};

function makeStaticHandler(publicDir) {
  return function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400).end(); return; }
    if (rel === '/remote' || rel === '/remote/') rel = '/remote/index.html';
    rel = rel.replace(/^\/remote\/?/, '/');
    const abs = path.normalize(path.join(publicDir, rel));
    if (!abs.startsWith(path.normalize(publicDir + path.sep)) && abs !== path.normalize(publicDir)) {
      res.writeHead(403).end(); return;
    }
    let st;
    try { st = fs.statSync(abs); } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 not found'); return; }
    if (st.isDirectory()) { serveStatic(req, res, pathname.replace(/\/?$/, '/') + 'index.html'); return; }
    const ext = path.extname(abs).toLowerCase();
    const immutable = abs.includes(`${path.sep}vendor${path.sep}`) || abs.includes(`${path.sep}full${path.sep}`);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': immutable ? 'public, max-age=2592000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(abs).pipe(res);
  };
}

// ── 设备注册表（sid → passHash），落盘持久化 ─────────────────────────────────
class Registry {
  constructor(file) {
    this.file = file;
    this.map = new Map();      // sid -> {hash, name, ts}
    this._saveTimer = null;
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [sid, v] of Object.entries(raw.devices || {})) {
          if (validSid(sid) && validHash(v.hash)) this.map.set(sid, { hash: v.hash, name: String(v.name || ''), ts: Number(v.ts) || 0 });
        }
      }
    } catch (e) { log('registry load failed:', e.message); }
  }
  get(sid) { return this.map.get(sid) || null; }
  set(sid, rec) { this.map.set(sid, rec); this._save(); }
  delete(sid) { if (this.map.delete(sid)) this._save(); }
  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        const devices = {};
        for (const [sid, v] of this.map) devices[sid] = v;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify({ devices }, null, 2));
      } catch (e) { log('registry save failed:', e.message); }
    }, 500);
    this._saveTimer.unref?.();
  }
}

// ── 认证限速：60s 窗口内 ≥10 次失败 → 冷却 60s ────────────────────────────────
class FailGuard {
  constructor() { this.map = new Map(); }   // ip -> number[] (fail timestamps)
  blocked(ip) {
    const rec = this.map.get(ip);
    return !!(rec && rec.until > Date.now());
  }
  fail(ip) {
    const now = Date.now();
    const rec = this.map.get(ip) || { fails: [], until: 0 };
    rec.fails = rec.fails.filter((t) => now - t < 60000);
    rec.fails.push(now);
    if (rec.fails.length >= 10) rec.until = now + 60000;
    this.map.set(ip, rec);
  }
  pass(ip) { this.map.delete(ip); }
  reset() { this.map.clear(); }
}

// ── 中继主逻辑 ───────────────────────────────────────────────────────────────
export function startRelay(opts = {}) {
  const port = Number(opts.port ?? process.env.RELAY_PORT ?? 8787);
  const host = opts.host ?? '0.0.0.0';
  const publicDir = path.resolve(opts.publicDir ?? process.env.RELAY_PUBLIC_DIR ?? path.join(__dirname, 'public'));
  const tlsCert = opts.tlsCert ?? process.env.RELAY_TLS_CERT ?? '';
  const tlsKey = opts.tlsKey ?? process.env.RELAY_TLS_KEY ?? '';
  const registry = new Registry(path.resolve(opts.dataDir ?? process.env.RELAY_DATA_DIR ?? path.join(__dirname, 'data'), 'devices.json'));
  const guard = new FailGuard();
  // 注册口令：设置后，新设备（未注册的 sid）必须携带匹配的 regToken 才能注册，
  // 防止知道域名的陌生人在此中继上白嫖转发。已注册设备的重连不受影响。
  const regToken = String(opts.regToken ?? process.env.RELAY_REG_TOKEN ?? '');
  if (!regToken) log('提示：未设置注册口令（--reg-token / RELAY_REG_TOKEN），任何人都可在此中继注册新设备免费使用转发');

  /** sid -> {device:WsConn|null, deviceMeta, terminal:WsConn|null} */
  const slots = new Map();
  const liveConns = new Set();   // 所有 WS 连接（upgrade 连接不被 server.closeAllConnections 追踪）
  const slot = (sid) => { let s = slots.get(sid); if (!s) { s = { device: null, deviceMeta: null, terminal: null }; slots.set(sid, s); } return s; };

  const serveStatic = makeStaticHandler(publicDir);

  function httpHandler(req, res) {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; }
    if (pathname === '/remote' || pathname.startsWith('/remote/')) { serveStatic(req, res, pathname); return; }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 not found');
  }

  const tlsReady = tlsCert && tlsKey;
  const server = tlsReady
    ? https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, httpHandler)
    : http.createServer(httpHandler);

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* ignore */ }
    if (pathname !== WS_PATH) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ip = req.socket.remoteAddress || '?';
    const conn = new WsConn(socket);
    liveConns.add(conn);
    if (head && head.length) conn._feed(head);
    setupSession(conn, ip);
  });

  /** 单条 WS 的会话状态机：hello → challenge → proof → ready → 桥接 */
  function setupSession(conn, ip) {
    let stage = 'hello';
    let info = null;          // {role, sid, name}
    let registered = false;
    const failClose = (code, why) => {
      try { conn.sendText(JSON.stringify({ type: 'error', code: String(why) })); } catch { /* ignore */ }
      conn.close(code, why);
      cleanup();
    };
    let helloTimer = setTimeout(() => { if (stage !== 'ready') failClose(4001, 'hello-timeout'); }, 10000);
    helloTimer.unref?.();
    let proofTimer = null;

    function cleanup() {
      if (process.env.RELAY_DEBUG) log('cleanup:', info && info.role, info && info.sid, 'registered=' + registered);
      clearTimeout(helloTimer); clearTimeout(proofTimer);
      if (info && registered) {
        const s = slot(info.sid);
        if (info.role === 'device' && s.device === conn) {
          s.device = null; s.deviceMeta = null;
          log(`device ${info.sid} disconnected`);
          if (s.terminal) { s.terminal.close(4010, 'device-disconnected'); s.terminal = null; }
        } else if (info.role === 'terminal' && s.terminal === conn) {
          s.terminal = null;
          if (s.device) s.device.sendText(JSON.stringify({ type: 'pair', status: 'waiting' }));
        }
        if (!s.device && !s.terminal) slots.delete(info.sid);
      }
    }
    conn.onclose = () => { liveConns.delete(conn); cleanup(); };

    conn.onmessage = (data, isText) => {
      if (!isText) return;
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (stage === 'hello') {
        if (msg.type !== 'hello') { failClose(4001, 'expect-hello'); return; }
        if (msg.proto !== PROTO) {
          try { conn.sendText(JSON.stringify({ type: 'error', code: 'proto-mismatch', expect: PROTO, got: msg.proto ?? null })); } catch { /* ignore */ }
          conn.close(4001, 'proto-mismatch'); clearTimeout(helloTimer); stage = 'dead'; return;
        }
        const role = msg.role;
        if (role !== 'device' && role !== 'terminal') { failClose(4001, 'bad-role'); return; }
        if (!validSid(msg.sid)) { failClose(4001, 'bad-sid'); return; }
        if (guard.blocked(ip)) { conn.close(4003, 'rate-limited'); stage = 'dead'; clearTimeout(helloTimer); return; }
        const rec = registry.get(msg.sid);
        if (role === 'terminal' && !rec) { failClose(4004, 'sid-not-found'); return; }
        if (role === 'device') {
          if (!validHash(msg.hash)) { failClose(4001, 'bad-hash'); return; }
          if (!rec) {
            // 新设备注册：配置了注册口令时必须携带正确的 regToken（防蹭中继）
            if (regToken && !safeEqual(String(msg.regToken || ''), regToken)) {
              guard.fail(ip);
              failClose(4001, 'reg-token-required');
              return;
            }
            registry.set(msg.sid, { hash: msg.hash, name: String(msg.name || '').slice(0, 64), ts: Date.now() });
          }
        }
        info = { role, sid: msg.sid, name: String(msg.name || '').slice(0, 64), hash: msg.hash };
        stage = 'proof';
        clearTimeout(helloTimer);
        const nonce = b64url(crypto.randomBytes(16));
        conn._nonce = nonce;
          conn.sendText(JSON.stringify({ type: 'challenge', nonce }));
        proofTimer = setTimeout(() => { if (stage === 'proof') failClose(4001, 'proof-timeout'); }, 10000);
        proofTimer.unref?.();
        return;
      }

      if (stage === 'proof') {
          if (msg.type !== 'proof') { failClose(4001, 'expect-proof'); return; }
        const rec = registry.get(info.sid);
        const storedHash = rec ? rec.hash : null;
          const expect = storedHash ? calcProof(storedHash, conn._nonce, info.role, info.sid) : '';
            if (!storedHash || !safeEqual(String(msg.proof || ''), expect)) {
          guard.fail(ip);
          failClose(4002, 'auth-failed');
          return;
        }
        guard.pass(ip);
        clearTimeout(proofTimer);
        // proof 通过后才允许更新 hash（改密码场景）；hash 在 hello 帧里，暂存在 info.hash
        if (info.role === 'device' && info.hash !== undefined && validHash(info.hash) && info.hash !== rec.hash) {
          rec.hash = info.hash; rec.ts = Date.now(); registry.set(info.sid, rec);
          log(`device ${info.sid} hash updated (password rotated)`);
        }
        const s = slot(info.sid);
        if (info.role === 'device') {
          if (s.device && s.device !== conn) {   // 顶替旧连接
            try { s.device.close(4009, 'replaced'); } catch { /* ignore */ }
            s.device = null;
          }
                s.device = conn;
          s.deviceMeta = { name: info.name || (rec && rec.name) || '' };
          registered = true;
          conn.sendText(JSON.stringify({ type: 'ready', role: 'device', sid: info.sid, peer: s.terminal ? 1 : 0 }));
          if (s.terminal) {
            conn.sendText(JSON.stringify({ type: 'pair', status: 'matched' }));
            s.terminal.sendText(JSON.stringify({ type: 'pair', status: 'matched' }));
          }
          log(`device ${info.sid} online${s.terminal ? ' (terminal waiting)' : ''}`);
        } else {
          if (s.terminal && s.terminal !== conn) { try { s.terminal.close(4009, 'replaced'); } catch { /* ignore */ } s.terminal = null; }
          if (s.terminal) { failClose(4009, 'terminal-exists'); return; }
                s.terminal = conn;
          registered = true;
          conn.sendText(JSON.stringify({
            type: 'ready', role: 'terminal', sid: info.sid,
            peer: s.device ? 1 : 0, device: s.device ? { name: s.deviceMeta?.name || '' } : null,
          }));
          if (s.device) {
            conn.sendText(JSON.stringify({ type: 'pair', status: 'matched' }));
            s.device.sendText(JSON.stringify({ type: 'pair', status: 'matched' }));
          }
          log(`terminal ${info.sid} online${s.device ? ' (matched)' : ' (waiting for device)'}`);
        }
        stage = 'ready';
        return;
      }

      if (stage === 'ready') {
        if (msg.type !== 'data' || !msg.payload || typeof msg.payload !== 'object') return;
        const s = slot(info.sid);
        const peer = info.role === 'device' ? s.terminal : s.device;
        if (!peer) return;
        peer.sendText(JSON.stringify({ type: 'data', payload: msg.payload, ts: Date.now() }));
      }
    };
  }

  // 保活：10s ping / 30s 无活判死
  const heartbeat = setInterval(() => {
    for (const s of slots.values()) {
      for (const c of [s.device, s.terminal]) {
        if (!c) continue;
        if (!c.alive) { try { c.close(4000, 'keepalive-timeout'); } catch { /* ignore */ } continue; }
        c.alive = false;
        c.ping();
      }
    }
  }, 10000);
  heartbeat.unref?.();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address()?.port ?? port;
      log(`listening on ${tlsReady ? 'https' : 'http'}://${host}:${actualPort}  (ws: ${WS_PATH}, static: ${publicDir})`);
      resolve({
        server, port: actualPort, wsPath: WS_PATH, registry, guard,
        close: () => {
          clearInterval(heartbeat);
          for (const c of liveConns) { try { c.socket.destroy(); } catch { /* ignore */ } }
          try { server.closeAllConnections(); } catch { /* 旧 Node 无此 API */ }
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

export function computeQrFields(password, sid, name, origin) {
  const hash = sha256b64(password);
  // URL 中的 hash 必须 percent-encode（base64 的 + / = 会被 query 解析吃掉）
  return { sid, hash, name, url: `${origin}/remote/#/pair?sid=${encodeURIComponent(sid)}&hash=${encodeURIComponent(hash)}&name=${encodeURIComponent(name)}` };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  startRelay({
    port: arg('--port') ?? undefined,
    tlsCert: arg('--tls-cert') ?? undefined,
    tlsKey: arg('--tls-key') ?? undefined,
    regToken: arg('--reg-token') ?? undefined,
  }).catch((e) => { console.error('[relay] failed to start:', e.message); process.exit(1); });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
