// ─────────────────────────────────────────────────────────────────────────────
// dsh-remote-relay · 轻量终端 UI（原生 ES modules，无构建）
// 协议见 docs/PROTOCOL.md。只依赖同源 /remote/ws 与 relay 静态资源。
// ─────────────────────────────────────────────────────────────────────────────
/* global marked, DOMPurify */

const $app = document.getElementById('app');
const $lb = document.getElementById('lightbox');
const PROTO = 1;

// ── 小工具 ───────────────────────────────────────────────────────────────────
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const fmtBytes = (n) => {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
};
const fmtTime = (ms) => {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 7 * 86400000) return Math.floor(d / 86400000) + ' 天前';
  const dt = new Date(ms);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
};
const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64 = (bytes) => {
  let s = '';
  const CH = 32768;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
};
// ── 纯 JS SHA-256 / HMAC 回退（非 HTTPS 局域网场景无 crypto.subtle 时使用）──
const _rotr = (x, n) => (x >>> n) | (x << (32 - n));
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function jsSha256(bytes) {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = bytes.length;
  const padded = new Uint8Array((((len + 8) >> 6) << 6) + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len * 8 / 0x100000000));
  dv.setUint32(padded.length - 4, (len * 8) >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = _rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = _rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}
function jsHmacSha256(keyBytes, msgBytes) {
  let k = keyBytes;
  if (k.length > 64) k = jsSha256(k);
  const ipad = new Uint8Array(64 + msgBytes.length);
  const opad = new Uint8Array(64 + 32);
  ipad.fill(0x36); opad.fill(0x5c);
  for (let i = 0; i < k.length; i++) { ipad[i] ^= k[i]; opad[i] ^= k[i]; }
  ipad.set(msgBytes, 64);
  opad.set(jsSha256(ipad), 64);
  return jsSha256(opad);
}
const _concatBytes = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
async function hmacProof(hash, nonce, role, sid) {
  const msg = new TextEncoder().encode(`${nonce}|${role}|${sid}`);
  let sig;
  if (crypto.subtle) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(hash), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  } else {
    sig = jsHmacSha256(new TextEncoder().encode(hash), msg);   // HTTP 局域网回退
  }
  let s = '';
  for (const x of sig) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha8hex(bytes) {
  let d;
  if (crypto.subtle) {
    d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  } else {
    d = jsSha256(bytes);
  }
  return [...d].slice(0, 4).map((x) => x.toString(16).padStart(2, '0')).join('');
}
let mdRender = (t) => {
  const p = el('p', null, t);
  return p;
};
if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true });
  mdRender = (t) => {
    const html = marked.parse(String(t || ''));
    const div = el('div');
    div.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] });
    return div;
  };
}
const prettyArgs = (s) => {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return String(s || ''); }
};
const toast = (() => {
  let t = null;
  return (msg, ms = 2600) => {
    if (t) t.remove();
    t = el('div', 'toast', msg);
    document.body.appendChild(t);
    setTimeout(() => { t?.remove(); t = null; }, ms);
  };
})();

// ── 凭据 ─────────────────────────────────────────────────────────────────────
const CREDS_KEY = 'rr-creds-v1';
const loadCreds = () => { try { return JSON.parse(localStorage.getItem(CREDS_KEY)); } catch { return null; } };
const saveCreds = (c) => localStorage.setItem(CREDS_KEY, JSON.stringify(c));
const clearCreds = () => localStorage.removeItem(CREDS_KEY);

// ── 全局状态 ─────────────────────────────────────────────────────────────────
const state = {
  creds: loadCreds(),
  ws: null,
  conn: 'idle',          // idle|authing|ready|matched|lost
  deviceName: '',
  sessions: new Map(),   // id -> Sess
  focus: null,
  chats: new Map(),      // id -> {messages:[], status, streamTurn, streamRaw, streamEl, streamTimer, els:Map(seq→el)}
  approvals: new Map(),  // requestId -> {requestId, sessionId, tool, args, reason, el, done}
  fetches: new Map(),    // fetchId -> {parts:[], resolve, reject, meta}
  seq: 0,
  reconnectTimer: null,
  reconnectDelay: 1000,
  wantConnected: false,
  route: null,
};

// ── WS 客户端 ────────────────────────────────────────────────────────────────
function wsUrl() { return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/remote/ws'; }

async function connect() {
  if (state.ws) return;
  if (!state.creds?.sid || !state.creds?.hash) { renderPair(); return; }
  state.wantConnected = true;
  state.conn = 'authing';
  paintConn();
  let ws;
  try { ws = new WebSocket(wsUrl()); } catch { scheduleReconnect(); return; }
  state.ws = ws;
  let nonce = null;
  ws.onopen = () => {
    // 握手第一步：终端自报身份（协议见 docs/PROTOCOL.md §1.1）
    ws.send(JSON.stringify({
      type: 'hello', proto: PROTO, role: 'terminal', sid: state.creds.sid, name: state.creds.name || '手机',
    }));
  };
  const fail = (err) => {
    try { ws.close(); } catch { /* ignore */ }
    if (state.ws === ws) state.ws = null;
    state.conn = 'lost';
    paintConn();
    toast('连接失败：' + (err?.message || err || '未知错误'), 4000);
    scheduleReconnect();
  };
  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    state.ws = null;
    const wasReady = state.conn === 'matched' || state.conn === 'ready';
    state.conn = 'lost';
    paintConn();
    if (wasReady) toast('与中继的连接已断开', 3000);
    if (state.wantConnected) scheduleReconnect();
    else if (!ev.wasClean && state.route === 'pair') showPairError('配对连接被关闭（' + ev.code + '）');
  };
  ws.onerror = () => { /* onclose 跟进 */ };
  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'error') {
      if (msg.code === 'proto-mismatch') { state.wantConnected = false; fatalBanner('协议版本不匹配：请更新中继或 UI 后重试'); return; }
      if (msg.code === 'sid-not-found') {
        state.wantConnected = false;
        clearCreds(); state.creds = null;
        if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } }
        toast('设备已重置配对，请重新扫码', 4000);
        location.hash = '#/pair';
        return;
      }
      return;
    }
    if (msg.type === 'challenge') { nonce = msg.nonce; try { ws.send(JSON.stringify({ type: 'proof', proof: await hmacProof(state.creds.hash, nonce, 'terminal', state.creds.sid) })); } catch (e) { fail(e); } return; }
    if (msg.type === 'ready') {
      state.conn = 'ready';
      state.deviceName = msg.device?.name || state.creds.name || '设备';
      paintConn();
      if (msg.peer === 1) { state.conn = 'matched'; paintConn(); onMatched(true); }
      return;
    }
    if (msg.type === 'pair') {
      state.conn = msg.status === 'matched' ? 'matched' : 'ready';
      paintConn();
      if (msg.status === 'matched') onMatched(true);
      if (msg.status === 'waiting') { toast('设备未连接，等待 dsh 插件上线…', 3000); }
      return;
    }
    if (msg.type === 'data' && msg.payload) { handleData(msg.payload); return; }
  };
}

function disconnect() {
  state.wantConnected = false;
  clearTimeout(state.reconnectTimer);
  if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } state.ws = null; }
  state.conn = 'idle';
}

function scheduleReconnect() {
  if (!state.wantConnected || state.reconnectTimer) return;
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delay);
}

function send(payload) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: 'data', payload }));
}

/** matched（或重连恢复）后拉取数据并恢复当前视图 */
function onMatched(recover) {
  state.reconnectDelay = 1000;
  send({ c: 'bootstrap-request' });
  if (recover && state.focus) {
    const chat = state.chats.get(state.focus);
    send({ c: 'open', sessionId: state.focus, tail: chat ? Math.max(chat.messages.length, 50) : 200 });
  }
  paintConn();
}

// ── 数据分发 ─────────────────────────────────────────────────────────────────
function handleData(p) {
  switch (p.c) {
    case 'hello': break;
    case 'bootstrap': {
      state.deviceName = p.device?.name || state.deviceName;
      for (const s of p.sessions || []) state.sessions.set(s.id, s);
      if (state.route === 'sessions') renderSessionsList();
      break;
    }
    case 'sessions': {
      for (const s of p.upserts || []) state.sessions.set(s.id, s);
      for (const id of p.removed || []) state.sessions.delete(id);
      if (state.route === 'sessions') renderSessionsList();
      if (state.route?.startsWith('chat')) paintChatStatus();
      break;
    }
    case 'snapshot': {
      const chat = ensureChat(p.sessionId);
      // 保留快照请求之后新到的乐观消息（本地回显/流式中），其余以快照为准
      const maxSeq = (p.messages && p.messages.length) ? p.messages[p.messages.length - 1].seq : 0;
      const keepNewer = chat.messages.filter((m) => m.seq > maxSeq);
      const pending = chat.messages.filter((m) => m.seq < 0);
      chat.messages = [...(p.messages || []), ...keepNewer, ...pending];
      chat.status = p.status || chat.status;
      chat.title = p.title || chat.title;
      chat.streamTurn = null; chat.streamRaw = ''; chat.streamEl = null;
      if (state.focus === p.sessionId && state.route === 'chat/' + p.sessionId) {
        const t = $app.querySelector('[data-role=chattitle]');
        if (t && chat.title) t.textContent = chat.title;
        renderChatMessages(true);
      }
      break;
    }
    case 'message': {
      const chat = ensureChat(p.sessionId);
      const res = mergeMessage(chat, p.msg);
      if (state.focus === p.sessionId && state.route === 'chat/' + p.sessionId) {
        const list = $app.querySelector('[data-role=chatlist]');
        if (res.removedEcho != null && list) {
          const old = chat.els.get(res.removedEcho);
          if (old) old.remove();
          chat.els.delete(res.removedEcho);
        }
        if (res.replaced) {
          const old = chat.els.get(res.replacedSeq);
          const node = renderMsg(chat, chat.messages[res.index]);
          if (old && old.isConnected) old.replaceWith(node);
          chat.els.set(chat.messages[res.index].seq, node);
        } else {
          appendMessageEl(chat, p.msg);
        }
        scrollToBottom();
      }
      break;
    }
    case 'delta': {
      const chat = ensureChat(p.sessionId);
      if (p.kind === 'start') { chat.streamTurn = p.turn; chat.streamRaw = ''; }
      else if (p.kind === 'chunk' && chat.streamTurn === p.turn) {
        chat.streamRaw += p.text || '';
        if (state.focus === p.sessionId && state.route === 'chat/' + p.sessionId) paintStream(chat);
      } else if (p.kind === 'end' && chat.streamTurn === p.turn) {
        // 保留 streamTurn：终稿 message 到达时按 turn 替换流式气泡
        chat.streamEnded = true;
      }
      break;
    }
    case 'status': {
      const chat = ensureChat(p.sessionId);
      chat.status = p.status;
      const sess = state.sessions.get(p.sessionId);
      if (sess) { sess.status = p.status; }
      if (state.focus === p.sessionId) paintChatStatus();
      if (state.route === 'sessions') renderSessionsList();
      break;
    }
    case 'approval': {
      state.approvals.set(p.requestId, { ...p, done: false });
      if (state.route?.startsWith('chat')) renderApprovals();
      toast('新的权限请求：' + (p.tool || ''), 3500);
      break;
    }
    case 'approval-done': {
      const a = state.approvals.get(p.requestId);
      state.approvals.delete(p.requestId);
      if (a?.el) a.el.remove();
      if (state.route?.startsWith('chat')) renderApprovals();
      if (p.by && p.by !== 'phone') toast('该请求已在' + (p.by === 'desktop' ? '桌面' : '其他端') + '被处置');
      break;
    }
    case 'att-meta': {
      const f = state.fetches.get(p.fetchId);
      if (f) f.meta = p;
      break;
    }
    case 'att-chunk': {
      const f = state.fetches.get(p.fetchId);
      if (f) f.parts.push(b64ToBytes(p.b64));
      break;
    }
    case 'att-end': {
      const f = state.fetches.get(p.fetchId);
      if (!f) break;
      state.fetches.delete(p.fetchId);
      const bytes = concatBytes(f.parts);
      if (p.error) { f.reject(new Error(p.error)); break; }
      sha8hex(bytes).then((sha8) => {
        if (p.sha8 && sha8 !== p.sha8) f.reject(new Error('校验不一致（sha8）'));
        else f.resolve({ bytes, meta: f.meta });
      });
      break;
    }
    case 'error': {
      toast('错误：' + (p.message || p.code || '未知'), 3200);
      break;
    }
  }
}
const concatBytes = (parts) => {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};
const ensureChat = (id) => {
  let c = state.chats.get(id);
  if (!c) { c = { messages: [], status: 'idle', title: '', streamTurn: null, streamRaw: '', streamEl: null, els: new Map(), pending: [] }; state.chats.set(id, c); }
  return c;
};

/** 持久消息入库：user 回显去重、tool-result 按 callId 就地合并。
 *  返回 {removedEcho?, replaced?, replacedSeq?, index} */
function mergeMessage(chat, msg) {
  if (msg.k === 'user') {
    const idx = chat.pending.indexOf(msg.text);
    if (idx >= 0) {
      chat.pending.splice(idx, 1);
      const pIdx = chat.messages.findIndex((m) => m.seq < 0 && m.k === 'user' && m.text === msg.text);
      if (pIdx >= 0) {
        const pSeq = chat.messages[pIdx].seq;
        chat.messages.splice(pIdx, 1);
        // 回显被移除，新消息随后追加
        chat.messages.push(msg);
        return { removedEcho: pSeq, index: chat.messages.length - 1 };
      }
    }
  }
  if (msg.k === 'tool-result') {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m.k === 'tool' && m.callId === msg.callId && m.ok === undefined) {
        chat.messages[i] = { ...m, ok: msg.ok, out: msg.out };
        return { replaced: true, replacedSeq: m.seq, index: i };
      }
    }
    const m = { seq: msg.seq, k: 'tool', tool: 'tool', callId: msg.callId, ok: msg.ok, out: msg.out };
    chat.messages.push(m);
    return { index: chat.messages.length - 1 };
  }
  const last = chat.messages[chat.messages.length - 1];
  if (last && msg.seq && last.seq === msg.seq) {
    chat.messages[chat.messages.length - 1] = msg;
    return { replaced: true, replacedSeq: msg.seq, index: chat.messages.length - 1 };
  }
  chat.messages.push(msg);
  return { index: chat.messages.length - 1 };
}

// ── 渲染：连接状态 ───────────────────────────────────────────────────────────
let $banner = null;
function paintConn() {
  if ($banner) { $banner.remove(); $banner = null; }
  if (state.conn === 'lost' || state.conn === 'authing') {
    $banner = el('div', 'banner', state.conn === 'authing' ? '正在连接中继…' : '连接已断开，正在重连…');
    document.body.prepend($banner);
  }
}
function warnBanner(msg) {
  if ($banner) $banner.remove();
  $banner = el('div', 'banner', msg);
  document.body.prepend($banner);
}
function fatalBanner(msg) {
  if ($banner) $banner.remove();
  $banner = el('div', 'banner err', msg);
  document.body.prepend($banner);
}

// ── 路由 ─────────────────────────────────────────────────────────────────────
function route() {
  const h = location.hash || '#/sessions';
  const m = h.match(/^#\/pair\?(.*)$/);
  if (m) { renderPair(new URLSearchParams(m[1])); return; }
  if (h.startsWith('#/chat/')) { const id = decodeURIComponent(h.slice(7)); renderChat(id); return; }
  renderSessions();
}
window.addEventListener('hashchange', route);

// ── 配对页 ───────────────────────────────────────────────────────────────────
let $pairError = null;
function showPairError(msg) {
  if ($pairError) $pairError.textContent = msg;
}
function renderPair(params) {
  state.route = 'pair';
  $app.innerHTML = '';
  const box = el('div', 'pair');
  const h = el('h2', null, '配对设备');
  box.appendChild(h);
  $pairError = el('p', null, '');
  $pairError.style.color = 'var(--err)';
  box.appendChild($pairError);
  const note = el('p', null, '凭据来自 dsh 桌面端面板展示的二维码。');
  box.appendChild(note);

  const iSid = el('input'); iSid.placeholder = '设备 ID (sid)';
  const iHash = el('input'); iHash.placeholder = '配对 hash（base64）';
  const iName = el('input'); iName.placeholder = '备注名（可选）';
  const go = el('button', null, '配对并进入');
  go.onclick = () => {
    const sid = iSid.value.trim(), hash = iHash.value.trim(), name = iName.value.trim() || '手机';
    if (!sid || !hash) { showPairError('请填写 sid 与 hash'); return; }
    state.creds = { sid, hash, name };
    doPair();
  };
  box.appendChild(iSid); box.appendChild(iHash); box.appendChild(iName); box.appendChild(go);
  $app.appendChild(box);

  if (params && params.get('sid') && params.get('hash')) {
    state.creds = { sid: params.get('sid'), hash: params.get('hash'), name: params.get('name') || '手机' };
    doPair();
  } else if (state.creds?.sid) {
    // 已有凭据直接进
    location.hash = '#/sessions';
  }

  function doPair() {
    $pairError.textContent = '';
    note.textContent = '正在配对 ' + state.creds.sid + ' …';
    saveCreds(state.creds);
    connect().then(() => {
      // ready/matched 之后由 route 切走；若 3s 无果提示
      setTimeout(() => {
        if (state.route === 'pair' && state.conn !== 'matched') {
          showPairError(state.conn === 'ready' ? '设备尚未连接（dsh 插件未在线？）' : '配对超时，请检查凭据');
        }
      }, 3000);
    });
  }
}

// 轮询把配对成功后的跳转做掉（connect 回调里无法直接感知）
setInterval(() => {
  if (state.route === 'pair' && state.conn === 'matched' && state.creds) {
    location.hash = '#/sessions';
  }
}, 300);

// ── 会话列表 ─────────────────────────────────────────────────────────────────
function renderSessions() {
  state.route = 'sessions';
  $app.innerHTML = '';
  const bar = el('div', 'topbar');
  const dot = el('span', 'dot');
  dot.dataset.role = 'conn';
  const title = el('div', 'title', '会话');
  title.dataset.role = 'devname';
  const reset = el('button', 'back', '换设备');
  reset.onclick = () => {
    if (!confirm('清除本机配对信息？需要重新扫码。')) return;
    disconnect(); clearCreds(); state.creds = null; state.sessions.clear(); state.chats.clear();
    location.hash = '#/pair';
  };
  bar.appendChild(dot); bar.appendChild(title); bar.appendChild(reset);
  const list = el('div', 'list');
  list.dataset.role = 'sesslist';
  $app.appendChild(bar); $app.appendChild(list);
  paintConn();
  connect().then(() => { if (state.conn === 'matched') send({ c: 'bootstrap-request' }); });
  renderSessionsList();
}

function renderSessionsList() {
  const list = $app.querySelector('[data-role=sesslist]');
  const devEl = $app.querySelector('[data-role=devname]');
  if (!list) return;
  if (devEl) devEl.textContent = (state.deviceName || '会话') + (state.sessions.size ? `（${state.sessions.size}）` : '');
  list.innerHTML = '';
  const arr = [...state.sessions.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!arr.length) {
    const empty = el('div', 'boot', '暂无会话（等待设备数据）');
    list.appendChild(empty);
    return;
  }
  for (const s of arr) {
    const item = el('div', 'sess');
    const dot = el('span', 'dot' + (s.status === 'running' ? ' run' : ''));
    const t = el('div', 't');
    t.appendChild(el('div', 'name', s.title || '(无标题)'));
    t.appendChild(el('div', 'sub', fmtTime(s.updatedAt) + (s.cwd ? ' · ' + s.cwd : '')));
    item.appendChild(dot); item.appendChild(t);
    item.onclick = () => { location.hash = '#/chat/' + encodeURIComponent(s.id); };
    list.appendChild(item);
  }
}

// ── 聊天视图 ─────────────────────────────────────────────────────────────────
function renderChat(id) {
  state.route = 'chat/' + id;
  state.focus = id;
  const chat = ensureChat(id);
  const sess = state.sessions.get(id);
  chat.title = chat.title || sess?.title || '(加载中)';
  $app.innerHTML = '';

  const bar = el('div', 'topbar');
  const back = el('button', 'back', '‹ 返回');
  back.onclick = () => { history.back(); };
  const dot = el('span', 'dot' + (state.conn === 'matched' ? ' on' : ''));
  dot.dataset.role = 'conn';
  const title = el('div', 'title', chat.title);
  title.dataset.role = 'chattitle';
  bar.appendChild(back); bar.appendChild(dot); bar.appendChild(title);

  const list = el('div', 'chat');
  list.dataset.role = 'chatlist';
  const appr = el('div', 'approvals');
  appr.dataset.role = 'approvals';
  const composer = el('div', 'composer');
  const ta = el('textarea');
  ta.rows = 1;
  ta.placeholder = '发送到该会话…';
  const sendBtn = el('button', 'send', '➤');
  sendBtn.dataset.role = 'send';
  composer.appendChild(ta); composer.appendChild(sendBtn);

  $app.appendChild(bar); $app.appendChild(list); $app.appendChild(appr); $app.appendChild(composer);

  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
  });
  sendBtn.onclick = doSend;

  function doSend() {
    const sessNow = state.sessions.get(id);
    if ((chat.status || sessNow?.status) === 'running') {
      send({ c: 'cancel', sessionId: id });
      return;
    }
    const text = ta.value.trim();
    if (!text) return;
    if (state.conn !== 'matched') { toast('未连接到设备'); return; }
    ta.value = ''; ta.style.height = 'auto';
    const msg = { k: 'user', text, seq: -1 };
    chat.pending.push(text);
    chat.messages.push(msg);
    list.appendChild(renderMsg(chat, msg));
    scrollToBottom();
    send({ c: 'send', sessionId: id, msgId: 'm' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), text });
    paintChatStatus();
  }

  paintConn();
  renderChatMessages(true);
  renderApprovals();
  paintChatStatus();
  connect().then(() => {
    if (state.conn === 'matched') send({ c: 'open', sessionId: id, tail: 200 });
    else setTimeout(() => { if (state.conn === 'matched') send({ c: 'open', sessionId: id, tail: 200 }); }, 800);
  });
}

function paintChatStatus() {
  if (!state.focus) return;
  const chat = state.chats.get(state.focus);
  const sess = state.sessions.get(state.focus);
  const running = (chat?.status || sess?.status) === 'running';
  const btn = $app.querySelector('[data-role=send]');
  if (btn) {
    const running = (chat?.status || sess?.status) === 'running';
    btn.classList.toggle('stop', running);
    btn.textContent = running ? '■' : '➤';
    btn.title = running ? '停止运行' : '发送';
    // onclick 始终为 doSend（running 时由 doSend 内部转为 cancel），不得在此覆盖
  }
  const dot = $app.querySelector('[data-role=conn]');
  if (dot) dot.className = 'dot' + (state.conn === 'matched' ? (running ? ' run' : ' on') : '');
}

function scrollToBottom(force) {
  const list = $app.querySelector('[data-role=chatlist]');
  if (!list) return;
  const near = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
  if (near || force) list.scrollTop = list.scrollHeight;
}

function renderChatMessages(scroll) {
  const list = $app.querySelector('[data-role=chatlist]');
  if (!list) return;
  list.innerHTML = '';
  const chat = state.chats.get(state.focus);
  if (!chat) return;
  chat.els.clear();
  if (!chat.messages.length) {
    list.appendChild(el('div', 'boot', '暂无消息'));
  }
  for (const m of chat.messages) {
    const node = renderMsg(chat, m);
    chat.els.set(m.seq, node);
    list.appendChild(node);
  }
  if (chat.streamTurn != null && chat.streamRaw) {
    chat.streamEl = mkBubble(chat, 'assistant');
    list.appendChild(chat.streamEl);
    paintStream(chat, true);
  }
  if (scroll) scrollToBottom(true);
}

function appendMessageEl(chat, msg) {
  const list = $app.querySelector('[data-role=chatlist]');
  if (!list) return;
  const empty = list.querySelector('.boot');
  if (empty) empty.remove();
  if (msg.k === 'assistant' && chat.streamTurn === msg.turn) {
    // 终稿替换流式气泡
    if (chat.streamEl) chat.streamEl.remove();
    chat.streamEl = null; chat.streamRaw = ''; chat.streamTurn = null;
  }
  const node = renderMsg(chat, msg);
  chat.els.set(msg.seq, node);
  list.appendChild(node);
}

function mkBubble(chat, who) {
  const wrap = el('div', 'msg ' + who);
  wrap.appendChild(el('div', 'who', who === 'user' ? '我' : 'dsh'));
  const bubble = el('div', 'bubble');
  bubble.appendChild(el('p', null, '…'));
  wrap.appendChild(bubble);
  return wrap;
}

function paintStream(chat, instant) {
  if (!chat.streamEl) {
    const list = $app.querySelector('[data-role=chatlist]');
    if (!list) return;
    chat.streamEl = mkBubble(chat, 'assistant');
    list.appendChild(chat.streamEl);
  }
  const apply = () => {
    if (!chat.streamEl) return;
    const bubble = chat.streamEl.querySelector('.bubble');
    bubble.innerHTML = '';
    bubble.appendChild(mdRender(chat.streamRaw));
    scrollToBottom();
  };
  if (instant) { apply(); return; }
  if (chat.streamTimer) return;
  chat.streamTimer = setTimeout(() => { chat.streamTimer = null; apply(); }, 120);
}

function renderMsg(chat, msg) {
  if (msg.k === 'tool') return renderTool(msg);
  const wrap = el('div', 'msg ' + (msg.k === 'user' ? 'user' : 'assistant') + (msg.seq < 0 ? ' pending' : ''));
  wrap.appendChild(el('div', 'who', msg.k === 'user' ? '我' : 'dsh'));
  const bubble = el('div', 'bubble');
  bubble.appendChild(mdRender(msg.text || ''));
  if (msg.atts?.length) {
    const at = el('div', 'att');
    for (const a of msg.atts) {
      const chip = el('button', 'chip', '📎 ' + (a.name || a.id.slice(0, 12)) + ' ' + fmtBytes(a.bytes));
      chip.onclick = () => fetchAttachment(state.focus, a);
      at.appendChild(chip);
    }
    bubble.appendChild(at);
  }
  wrap.appendChild(bubble);
  return wrap;
}

function renderTool(msg) {
  const det = el('details', 'tool');
  const sum = el('summary');
  sum.appendChild(el('span', 'arrow', '▶'));
  sum.appendChild(el('span', 'tname', '🔧 ' + (msg.tool || 'tool')));
  const badge = el('span', 'badge' + (msg.ok === undefined ? ' run' : msg.ok ? '' : ' err'), msg.ok === undefined ? '运行中' : msg.ok ? '完成' : '失败');
  sum.appendChild(badge);
  det.appendChild(sum);
  const body = el('div', 'tbody');
  if (msg.args) {
    body.appendChild(el('div', 'lbl', '参数'));
    const pre = el('pre', null, prettyArgs(msg.args));
    body.appendChild(pre);
  }
  if (msg.out) {
    body.appendChild(el('div', 'lbl', '输出'));
    body.appendChild(el('pre', null, msg.out));
  }
  det.appendChild(body);
  return det;
}

// ── 权限批准 ─────────────────────────────────────────────────────────────────
function renderApprovals() {
  const box = $app.querySelector('[data-role=approvals]');
  if (!box) return;
  box.innerHTML = '';
  for (const a of state.approvals.values()) {
    if (a.el && a.el.isConnected) { box.appendChild(a.el); continue; }
    const card = el('div', 'appr');
    card.appendChild(el('div', 'h', '🔐 权限请求：' + (a.tool || 'tool')));
    if (a.args) card.appendChild(el('pre', null, prettyArgs(a.args)));
    if (a.reason) card.appendChild(el('p', null, a.reason));
    const btns = el('div', 'btns');
    const allow = el('button', 'allow', '批准一次');
    const deny = el('button', 'deny', '拒绝');
    allow.onclick = () => {
      allow.disabled = deny.disabled = true;
      allow.textContent = '已发送';
      send({ c: 'approve', requestId: a.requestId, outcome: 'allowed-once' });
    };
    deny.onclick = () => {
      allow.disabled = deny.disabled = true;
      deny.textContent = '已拒绝';
      send({ c: 'approve', requestId: a.requestId, outcome: 'rejected' });
    };
    btns.appendChild(allow); btns.appendChild(deny);
    card.appendChild(btns);
    a.el = card;
    box.appendChild(card);
  }
}

// ── 附件拉取 ─────────────────────────────────────────────────────────────────
async function fetchAttachment(sessionId, att) {
  if (state.conn !== 'matched') { toast('未连接到设备'); return; }
  toast('正在拉取 ' + (att.name || '附件') + '…', 8000);
  const fetchId = 'f' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const p = new Promise((resolve, reject) => state.fetches.set(fetchId, { parts: [], meta: null, resolve, reject }));
  send({ c: 'fetch-att', fetchId, sessionId, attachmentId: att.id });
  try {
    const { bytes, meta } = await p;
    const mime = meta?.mime || att.mime || 'application/octet-stream';
    const blob = new Blob([bytes], { type: mime });
    if (mime.startsWith('image/')) {
      showLightbox(URL.createObjectURL(blob), (meta?.name || att.name || '') + ' · ' + fmtBytes(bytes.length));
    } else {
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = meta?.name || att.name || 'attachment';
      a.click();
      toast('已下载 ' + (meta?.name || att.name || '附件') + '（' + fmtBytes(bytes.length) + '）');
    }
  } catch (e) {
    toast('拉取失败：' + e.message, 4000);
  }
}

function showLightbox(src, metaText) {
  $lb.hidden = false;
  const img = $lb.querySelector('img');
  img.src = src;
  $lb.querySelector('.lb-meta').textContent = metaText || '';
  $lb.onclick = () => { $lb.hidden = true; img.src = ''; };
}

// ── 启动 ─────────────────────────────────────────────────────────────────────
// 非 HTTPS（局域网 HTTP）场景用纯 JS HMAC 回退，功能可用但凭据走明文——仅建议内网使用
if (!crypto.subtle) {
  warnBanner('HTTP 明文模式：配对凭据未加密传输，仅建议局域网内使用；公网请部署 HTTPS。');
}
route();
if (state.creds?.sid) connect();
