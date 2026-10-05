// ── 完整模式：资产推送 + HTTP/WS 桥接（协议 docs/PROTOCOL.md §3）─────────────
// relay 把手机的 /remote/full/api/* 请求翻译成 http-req/ws-open 帧发过来；
// 本模块在本机 127.0.0.1:<dsh 端口> 上完成真实请求（自动铸会话 cookie），
// 并把官方 UI 的 served 资产推送到 relay 托管。本文件不 import dsh。
import http from 'node:http';
import crypto from 'node:crypto';
import { WsClient } from './ws.mjs';

const CHUNK = 256 * 1024;            // asset-put / http-res-chunk 单帧原始字节
const WINDOW = 2 * 1024 * 1024;      // 未 ack 字节上限（超过暂停读本地响应）
const LOCAL_TIMEOUT = 60 * 1000;
const MAX_WS_BRIDGES = 16;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_FILES = 800;

const sha8 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
/** 精简模式壳：隐藏"管理入口类"UI（aria-label 跨构建稳定），只留会话树 + 对话 + 输入 */
const KIOSK_SHIM = '<style id="rrm-kiosk">'
  + 'button[aria-label="设置"],button[aria-label="添加工作区"],'
  + 'nav[aria-label="全局面板"]{display:none !important}'
  + '</style>';
/** 剔除 dsh 的启动注入脚本（按整块 <script> 精确匹配，避免跨标签误吞注入行） */
const stripBoot = (html) => String(html)
  .split(/(<script[\s\S]*?<\/script>)/gi)
  .filter((seg) => !(/^<script/i.test(seg) && /__DSH_BOOT__|__DSH_BOOT_READY__/.test(seg)))
  .join('');

/**
 * @param {object} io 宿主注入的运行环境
 *   log(msg...), sendData(payload), getPort(), refreshSessionCookie(): Promise<cookie|null>,
 *   invalidateCookie(): void, fullUiEnabled(): bool, fullUiMinimal(): bool
 */
export function createFullBridge(io) {
  const { log, sendData, getPort, refreshSessionCookie, invalidateCookie, fullUiEnabled, fullUiMinimal } = io;

  // ── HTTP 桥 ──
  /** reqId → { req?: http.ClientRequest, inflight, paused } */
  const httpBridges = new Map();
  // ── WS 桥 ──
  /** wsId → WsClient */
  const wsBridges = new Map();

  const resHeaders = (h) => {
    const out = {};
    const block = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'upgrade', 'alt-svc']);
    for (const [k, v] of Object.entries(h || {})) if (!block.has(k.toLowerCase())) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
    return out;
  };

  /** 转发一个本地请求（含 401 重铸重放一次：仅 GET/HEAD） */
  function forwardRequest(p, retried) {
    httpBridges.set(p.reqId, { req: null, lres: null, inflight: 0, paused: false });   // 先占位，cancel/ack 才有对象可寻址
    const finish = () => httpBridges.delete(p.reqId);
    refreshSessionCookie().then((cookie) => {
      const st = httpBridges.get(p.reqId);
      if (!st) return;   // 已被 cancel
      const port = getPort();
      const headers = { ...(p.headers || {}) };
      delete headers.host;
      headers['accept-encoding'] = 'identity';   // 拒绝压缩，原样流式转发
      if (cookie) headers.cookie = cookie;
      let body = null;
      if (p.body) { body = Buffer.from(p.body, 'base64'); headers['content-length'] = body.length; }
      let headSent = false;
      const req = http.request({
        host: '127.0.0.1', port, method: p.method,
        path: '/' + p.path + (p.query ? '?' + p.query : ''),
        headers, timeout: LOCAL_TIMEOUT,
      }, (lres) => {
        if (lres.statusCode === 401 && !retried && (p.method === 'GET' || p.method === 'HEAD')) {
          req.destroy();
          invalidateCookie();   // 强制重铸
          forwardRequest(p, true);
          return;
        }
        headSent = true;
        st.lres = lres;
        sendData({ type: 'http-res-head', reqId: p.reqId, status: lres.statusCode, headers: resHeaders(lres.headers) });
        lres.on('data', (chunk) => {
          const s = httpBridges.get(p.reqId);
          if (!s) { lres.destroy(); return; }
          s.inflight += chunk.length;
          sendData({ type: 'http-res-chunk', reqId: p.reqId, data: chunk.toString('base64') });
          if (s.inflight > WINDOW && !s.paused) { s.paused = true; lres.pause(); }
        });
        lres.on('end', () => { sendData({ type: 'http-res-end', reqId: p.reqId }); finish(); });
        lres.on('error', () => { if (headSent) { sendData({ type: 'http-res-abort', reqId: p.reqId }); finish(); } });
      });
      st.req = req;
      req.on('timeout', () => { req.destroy(new Error('local timeout')); });
      req.on('error', (e) => {
        if (!httpBridges.delete(p.reqId)) return;
        if (!headSent) {
          // 本地请求失败：回 502 + JSON 错误体（head → chunk → end）
          sendData({ type: 'http-res-head', reqId: p.reqId, status: 502, headers: { 'content-type': 'application/json' } });
          sendData({ type: 'http-res-chunk', reqId: p.reqId, data: Buffer.from(JSON.stringify({ error: 'local-request-failed', message: String(e.message || e).slice(0, 200) })).toString('base64') });
          sendData({ type: 'http-res-end', reqId: p.reqId });
        } else {
          sendData({ type: 'http-res-abort', reqId: p.reqId });
        }
      });
      if (body) req.write(body);
      req.end();
    }).catch((e) => {
      if (!httpBridges.delete(p.reqId)) return;
      sendData({ type: 'http-res-head', reqId: p.reqId, status: 502, headers: { 'content-type': 'application/json' } });
      sendData({ type: 'http-res-chunk', reqId: p.reqId, data: Buffer.from(JSON.stringify({ error: 'cookie-mint-failed', message: String(e.message || e) })).toString('base64') });
      sendData({ type: 'http-res-end', reqId: p.reqId });
    });
  }

  // ── relay → device 帧 ──
  function handleRelayFrame(p) {
    switch (p?.type) {
      case 'http-req': {
        const path = String(p.path || '');
        // 纵深防御：官方 UI 会请求 api/、plugins/（含懒加载 chunk）、assets/ 与根级文件，
        // 一律放行；拒绝绝对路径、.. 穿越、本插件的管理路由（/remote-relay/*）。
        // 中继侧同样只对 GET/HEAD 且无 .. 段的未命中资产回源。
        if (!path || path.startsWith('/') || path.split('/').includes('..') || path.startsWith('remote-relay/')) {
          sendData({ type: 'http-res-head', reqId: p.reqId, status: 403, headers: { 'content-type': 'application/json' } });
          sendData({ type: 'http-res-end', reqId: p.reqId });
          return;
        }
        forwardRequest(p, false);
        return;
      }
      case 'http-ack': {
        const st = httpBridges.get(p.reqId);
        if (!st) return;
        st.inflight = Math.max(0, st.inflight - (p.bytes | 0));
        if (st.paused && st.inflight < WINDOW / 2) { st.paused = false; try { st.lres?.resume?.(); } catch { /* ignore */ } }
        return;
      }
      case 'http-cancel': {
        const st = httpBridges.get(p.reqId);
        if (st) { httpBridges.delete(p.reqId); try { st.req?.destroy(); } catch { /* ignore */ } }
        return;
      }
      case 'ws-open': {
        void openLocalWs(p);
        return;
      }
      case 'ws-close': {
        const b = wsBridges.get(p.wsId);
        if (b && b.local) { wsBridges.delete(p.wsId); try { b.local.close((p.code | 0) || 1000, String(p.reason || '')); } catch { /* ignore */ } }
        else if (b) { b.closed = true; }   // 本地还没建好：标记关闭，connect 后立即关
        return;
      }
      case 'ws-text': {
        const b = wsBridges.get(p.wsId);
        if (!b) return;
        if (b.ready) try { b.local.sendText(String(p.text ?? '')); } catch { /* ignore */ }
        else b.pending.push({ t: 'text', text: String(p.text ?? '') });   // 本地 WS 未就绪：排队（手机开场帧必早于 connect 完成）
        return;
      }
      case 'ws-bin': {
        const b = wsBridges.get(p.wsId);
        if (!b) return;
        if (b.ready) try { b.local.sendBinary(Buffer.from(p.data || '', 'base64')); } catch { /* ignore */ }
        else b.pending.push({ t: 'bin', data: String(p.data || '') });
        return;
      }
      default: return;
    }
  }

  async function openLocalWs(p) {
    if (!/^api\//.test(String(p.path || ''))) {
      sendData({ type: 'ws-closed', wsId: p.wsId, code: 1008, reason: 'path-not-allowed' });
      return;
    }
    if (wsBridges.size >= MAX_WS_BRIDGES) {
      sendData({ type: 'ws-closed', wsId: p.wsId, code: 1013, reason: 'too-many-bridges' });
      return;
    }
    const bridge = { local: null, pending: [], closed: false, ready: false };
    wsBridges.set(p.wsId, bridge);
    let cookie = null;
    try { cookie = await refreshSessionCookie(); } catch { /* ignore */ }
    const local = new WsClient(`ws://127.0.0.1:${getPort()}/${p.path}${p.query ? '?' + p.query : ''}`, {
      maxPayload: 8 * 1024 * 1024,
      headers: cookie ? { cookie } : {},
    });
    bridge.local = local;
    local.onmessage = (data, isText) => {
      if (!wsBridges.has(p.wsId)) return;
      if (isText) sendData({ type: 'ws-text', wsId: p.wsId, text: String(data) });
      else sendData({ type: 'ws-bin', wsId: p.wsId, data: Buffer.from(data).toString('base64') });
    };
    local.onclose = (code, reason) => {
      if (!wsBridges.delete(p.wsId)) return;
      sendData({ type: 'ws-closed', wsId: p.wsId, code: code || 1006, reason: String(reason || '').slice(0, 100) });
    };
    try {
      await local.connect();
      if (!wsBridges.has(p.wsId)) { try { local.close(1000, 'gone'); } catch { /* ignore */ } return; }
      if (bridge.closed) { try { local.close(1000, 'peer-closed'); } catch { /* ignore */ } wsBridges.delete(p.wsId); sendData({ type: 'ws-closed', wsId: p.wsId, code: 1000, reason: '' }); return; }
      bridge.ready = true;
      sendData({ type: 'ws-opened', wsId: p.wsId });
      for (const f of bridge.pending) { try { f.t === 'text' ? local.sendText(f.text) : local.sendBinary(Buffer.from(f.data, 'base64')); } catch { /* ignore */ } }
      bridge.pending = [];
    } catch (e) {
      wsBridges.delete(p.wsId);
      sendData({ type: 'ws-closed', wsId: p.wsId, code: 1002, reason: 'local-connect-failed' });
      log('ws bridge local connect failed:', e.message);
    }
  }

  function abortAll() {
    for (const st of httpBridges.values()) { try { st.req?.destroy(); } catch { /* ignore */ } }
    httpBridges.clear();
    for (const b of wsBridges.values()) { if (b.local) try { b.local.close(1000, 'device-reconnect'); } catch { /* ignore */ } }
    wsBridges.clear();
    resetSync();
  }

  // ── 资产同步 ──
  let syncing = false;
  let syncWaiter = null;   // { want: Set<type>, resolve, timer }

  function resetSync() { if (syncWaiter) { clearTimeout(syncWaiter.timer); syncWaiter = null; } syncing = false; }

  function waitReply(want, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { syncWaiter = null; reject(new Error('relay reply timeout: ' + want)); }, timeoutMs);
      syncWaiter = { want: new Set(Array.isArray(want) ? want : [want]), resolve, timer };
    });
  }

  /** 处理 relay 对资产帧的应答；返回 true 表示已被 sync 消化 */
  function handleSyncReply(p) {
    if (!syncWaiter) return false;
    const t = p?.type;
    if (t === 'error' && String(p.code || '').startsWith('asset-')) {
      const w = syncWaiter; syncWaiter = null; clearTimeout(w.timer);
      w.reject(new Error('asset error: ' + p.code + ' ' + (p.message || '')));
      return true;
    }
    if (syncWaiter.want.has(t)) {
      const w = syncWaiter; syncWaiter = null; clearTimeout(w.timer);
      w.resolve(p);
      return true;
    }
    return false;
  }

  const httpGet = (urlPath, cookie, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: getPort(), path: urlPath, method: 'GET', headers: { ...(cookie ? { cookie } : {}), 'accept-encoding': 'identity' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`GET ${urlPath} → ${res.statusCode}`)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_FILE) { res.destroy(); reject(new Error('asset too large: ' + urlPath)); return; } chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout ' + urlPath)));
    req.end();
  });

  /** 从 index/CSS 提取同源资产 key（'/path' 或 '/path??combo&rev=x'，含去重） */
  function collectPaths(html, base, out) {
    const re = /(?:href|src)="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      addUrl(m[1].replace(/&amp;/g, '&'), base, out);
    }
    return out;
  }
  /** __DSH_BOOT__ 等注入 JSON 里的运行时模块 URL（"url":"plugins/??..."） */
  function collectBootUrls(html, base, out) {
    const re = /"url":\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) addUrl(m[1].replace(/&amp;/g, '&'), base, out);
    return out;
  }
  function addUrl(raw, base, out) {
    let u;
    try { u = new URL(raw, base); } catch { return; }
    if (u.origin !== base.origin) return;
    const key = u.pathname + u.search;   // combo URL 的文件列表在 search 里，必须整体保留
    if (key === '/' || out.has(key)) return;
    out.add(key);
  }
  function collectCssUrls(cssText, cssPath, origin, out) {
    const re = /url\(\s*['"]?([^'")\s]+)/g;
    let m;
    while ((m = re.exec(cssText))) {
      let u;
      try { u = new URL(m[1], origin + cssPath); } catch { continue; }
      if (u.origin !== origin) continue;
      const key = u.pathname + u.search;
      if (out.has(key)) continue;
      out.add(key);
    }
    return out;
  }
  /** 落盘名：普通路径原样；含 ?&@ 等特殊字符的 combo URL 用定长哈希名（relay 侧同规则寻址） */
  const diskKey = (key) => {
    const rel = key.replace(/^\/+/, '');
    return /^[A-Za-z0-9._/-]+$/.test(rel) ? rel : 'enc-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  };

  async function syncFullAssets() {
    if (!fullUiEnabled()) { log('full-mode sync skipped (syncFullUi=false)'); return; }
    if (syncing) return;
    syncing = true;
    const t0 = Date.now();
    try {
      sendData({ type: 'full-info' });
      const st = await waitReply('full-info-state', 15000);
      const cookie = await refreshSessionCookie();
      const indexBuf = await httpGet('/', cookie);
      const indexRaw = indexBuf.toString('utf8');
      const minimal = !!fullUiMinimal();
      // 精简模式：推送前把 kiosk 壳注入 index（隐藏设置/插件/添加工作区，只留会话与对话）
      const indexHtml = minimal && indexRaw.includes('</head>')
        ? indexRaw.replace('</head>', KIOSK_SHIM + '</head>')
        : indexRaw;
      const indexBufFinal = Buffer.from(indexHtml, 'utf8');
      const version = 'idx2-' + sha8(stripBoot(indexHtml)) + (minimal ? '-k' : '');
      if (st.version === version) {
        log(`full-mode assets up-to-date (v=${version}, ${st.files} files)`);
        return;
      }
      const base = { origin: `http://127.0.0.1:${getPort()}` };
      const origin = base.origin;
      const paths = collectPaths(indexHtml, new URL(origin + '/'), new Set(['/']));
      collectBootUrls(indexHtml, new URL(origin + '/'), paths);
      // CSS 内引用再扩散一层
      for (const p2 of [...paths]) {
        if (!p2.endsWith('.css')) continue;
        try {
          const css = await httpGet(p2, cookie);
          collectCssUrls(css.toString('utf8'), p2, origin, paths);
        } catch { /* css 丢失不致命 */ }
      }
      const list = [...paths].filter((p2) => p2 !== '/');
      if (list.length > MAX_FILES) throw new Error('too many assets: ' + list.length);
      const files = [{ path: 'index.html', buf: indexBufFinal }];
      let total = indexBufFinal.length;
      let skipped = 0;
      for (const p2 of list) {
        let buf;
        try {
          buf = await httpGet(p2, cookie);
        } catch (e) {
          // 其他插件注入的行（/plugins/* 等）本地可能 404：跳过即可，这些路径在手机侧同样不可达
          skipped++;
          if (skipped <= 5) log('full-mode asset skip:', p2, '—', String(e.message || e).slice(0, 80));
          continue;
        }
        files.push({ path: diskKey(p2), buf });
        total += buf.length;
        if (total > MAX_TOTAL) throw new Error('assets total too large');
      }
      if (skipped > 5) log(`full-mode asset skip ×${skipped} (其余略)`);
      log(`full-mode push: ${files.length} files${skipped ? ` (跳过 ${skipped})` : ''}, ${(total / 1048576).toFixed(1)}MB → relay`);
      const pushId = 'p-' + Date.now().toString(36);
      sendData({ type: 'asset-begin', pushId, version, files: files.map((f) => ({ path: f.path, size: f.buf.length, sha8: sha8(f.buf) })) });
      await waitReply('asset-ok', 20000);
      for (const f of files) {
        const totalChunks = Math.max(1, Math.ceil(f.buf.length / CHUNK));
        for (let seq = 0; seq < totalChunks; seq++) {
          sendData({ type: 'asset-put', pushId, path: f.path, seq, total: totalChunks, data: f.buf.subarray(seq * CHUNK, (seq + 1) * CHUNK).toString('base64') });
        }
        sendData({ type: 'asset-end', pushId, path: f.path });
      }
      sendData({ type: 'asset-commit', pushId, version });
      const done = await waitReply(['asset-committed'], 120000);
      log(`full-mode assets committed: v=${done.version} files=${done.files} bytes=${done.bytes} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      log('full-mode sync failed:', e.message);
    } finally {
      resetSync();
    }
  }

  return { handleRelayFrame, handleSyncReply, syncFullAssets, abortAll, stats: () => ({ http: httpBridges.size, ws: wsBridges.size, syncing }) };
}

export { stripBoot, sha8 };
