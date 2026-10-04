// ─────────────────────────────────────────────────────────────────────────────
// 极简 RFC6455 WebSocket 客户端（零依赖，ws:// 与 wss://，Node ≥ 18）
// 与 relay/relay.mjs 的服务端实现配套：协议见 docs/PROTOCOL.md。
// 客户端帧必须带掩码（RFC 要求），服务端帧不带。
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WsClient {
  /**
   * @param {string} url ws://host:port/path 或 wss://...
   * @param {{maxPayload?: number, headers?: object}} opts
   */
  constructor(url, { maxPayload = 8 * 1024 * 1024, headers = {} } = {}) {
    this.url = String(url);
    this.maxPayload = maxPayload;
    this.extraHeaders = headers;
    this.onmessage = null;   // (data: string|Buffer, isText: boolean)
    this.onclose = null;     // (code, reason)
    this.onerror = null;     // (error)
    this.onopen = null;
    this.socket = null;
    this._buf = Buffer.alloc(0);
    this._frag = null;
    this._closed = false;
    this.alive = true;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const isTls = u.protocol === 'wss:';
      if (u.protocol !== 'ws:' && !isTls) { reject(new Error('bad protocol: ' + u.protocol)); return; }
      const port = Number(u.port) || (isTls ? 443 : 80);
      const key = crypto.randomBytes(16).toString('base64');
      const mod = isTls ? https : http;
      const req = mod.request({
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        headers: {
          host: u.host,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': key,
          'sec-websocket-version': '13',
          ...this.extraHeaders,
        },
        setHost: true,
        servername: isTls ? u.hostname : undefined,
        timeout: 15000,
      });
      req.on('timeout', () => { req.destroy(new Error('connect timeout')); });
      req.on('error', (e) => { if (!this._closed) reject(e); else this._teardown(1006, ''); });
      req.on('upgrade', (res, socket, head) => {
        const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== expect) {
          socket.destroy(); reject(new Error('bad ws accept header')); return;
        }
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on('data', (c) => this._feed(c));
        socket.on('close', () => this._teardown(1006, ''));
        socket.on('error', (e) => { if (this.onerror) this.onerror(e); this._teardown(1006, ''); });
        socket.on('end', () => { try { socket.end(); } catch { /* ignore */ } });
        if (head && head.length) this._feed(head);
        if (this.onopen) { try { this.onopen(); } catch { /* ignore */ } }
        resolve(this);
      });
      req.on('response', (res) => {
        // 非 101：读到错误内容后拒绝
        let body = '';
        res.on('data', (c) => { body += c; if (body.length > 4096) res.destroy(); });
        res.on('end', () => reject(new Error(`handshake failed: HTTP ${res.statusCode} ${body.slice(0, 200)}`)));
        res.on('error', () => reject(new Error(`handshake failed: HTTP ${res.statusCode}`)));
      });
      req.end();
    });
  }

  // ── 帧解析（与服务端同构，客户端不要求对端掩码）────────────────────────────
  _feed(chunk) { if (process.env.WSD) console.log(Date.now() % 100000, "[feed]", chunk.length + "B", chunk.subarray(0, 32).toString("hex"));
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try { while (this._parseFrame()) { /* keep */ } } catch { this.close(1009, 'frame-error'); }
  }
  _need(n) { return this._buf.length >= n; }
  _take(n) { const b = this._buf.subarray(0, n); this._buf = this._buf.subarray(n); return b; }

  _parseFrame() {
    if (!this._need(2)) return false;
    const b0 = this._buf[0], b1 = this._buf[1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (!this._need(4)) return false; len = this._buf.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (!this._need(10)) return false;
      const hi = this._buf.readUInt32BE(2), lo = this._buf.readUInt32BE(6);
      if (hi > 0x1fffff) { this.close(1009, 'too-large'); return false; }
      len = hi * 0x100000000 + lo; off = 10;
    }
    if (len > this.maxPayload) { this.close(1009, 'too-large'); return false; }
    if (!this._need(off + len)) return false;
    this._take(off);
    const payload = Buffer.from(this._take(len));

    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) { this.close(1002, 'bad-control'); return false; }
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this._teardown(code, payload.subarray(2).toString('utf8'));
        return false;
      }
      if (opcode === 0x9) { this._sendFrame(0xA, payload); return true; }
      if (opcode === 0xA) { this.alive = true; return true; }
      this.close(1002, 'bad-opcode'); return false;
    }
    if (opcode === 0x0) {
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
    if (!this.socket || this._closed || this.socket.destroyed) return false;
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    try { this.socket.write(Buffer.concat([head, mask, masked])); return true; } catch { return false; }
  }

  sendText(str) { return this._sendFrame(0x1, Buffer.from(String(str), 'utf8')); }
  sendBinary(buf) { return this._sendFrame(0x2, Buffer.from(buf)); }
  ping() { return this._sendFrame(0x9, Buffer.alloc(0)); }
  close(code = 1000, reason = '') {
    if (this._closed && !this.socket) return;
    const r = Buffer.from(String(reason), 'utf8').subarray(0, 120);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    if (r.length) r.copy(p, 2);
    this._sendFrame(0x8, p);
    this._closed = true;
    setTimeout(() => { try { this.socket?.destroy(); } catch { /* ignore */ } }, 2000).unref?.();
  }

  _teardown(code, reason) { if (process.env.WSD) console.log(Date.now() % 100000, "[teardown]", code, reason);
    if (this._oncloseFired) return;      // onclose 只触发一次（本地 close 与对端 close 竞争时也保证触发）
    this._oncloseFired = true;
    this._closed = true;
    this.alive = false;
    if (this.onclose) { try { this.onclose(code, reason); } catch { /* ignore */ } }
  }
}

/** 连接 + 结构化收发：recv() 收非 data 控制/信令消息，nextData() 收桥接 data 载荷 */
export async function connectJson(url, opts) {
  const ws = new WsClient(url, opts);
  const queue = [];        // 等待 recv() 的非 data 消息
  const dataQueue = [];    // 等待 nextData() 的 {payload, ts}
  const waiters = [];      // recv 等待者
  const dataWaiters = [];  // nextData 等待者
  ws.onmessage = (data, isText) => {
    if (!isText) return;
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg && msg.type === 'data') {
      const item = { payload: msg.payload, ts: msg.ts };
      if (dataWaiters.length) dataWaiters.shift().resolve(item);
      else dataQueue.push(item);
      return;
    }
    if (waiters.length) { if (process.env.WSD) console.log(Date.now() % 100000, "[dispatch]", msg.type, "waiters=" + waiters.length); waiters.shift().resolve(msg); }
    else { if (process.env.WSD) console.log(Date.now() % 100000, "[queue]", msg.type); queue.push(msg); }
  };
  await ws.connect();
  return {
    ws,
    send: (obj) => ws.sendText(JSON.stringify(obj)),
    recv: (timeoutMs = 10000) => new Promise((resolve, reject) => {
      if (queue.length) { resolve(queue.shift()); return; }
      const entry = { resolve: null };
      const t = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error('recv timeout'));
      }, timeoutMs);
      entry.resolve = (m) => { clearTimeout(t); resolve(m); };
      waiters.push(entry);
    }),
    nextData: (timeoutMs = 10000) => new Promise((resolve, reject) => {
      if (dataQueue.length) { resolve(dataQueue.shift()); return; }
      const entry = { resolve: null };
      const t = setTimeout(() => {
        const i = dataWaiters.indexOf(entry);
        if (i >= 0) dataWaiters.splice(i, 1);
        reject(new Error('recv data timeout'));
      }, timeoutMs);
      entry.resolve = (item) => { clearTimeout(t); resolve(item); };
      dataWaiters.push(entry);
    }),
    close: (code, reason) => ws.close(code, reason),
  };
}
