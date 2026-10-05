// ─────────────────────────────────────────────────────────────────────────────
// dsh-remote-relay · 配对网关页（原生 ES modules，无构建）
// 职责只剩一件：完成配对鉴权 → 换取 rrm_full cookie → 跳转官方 UI（/remote/full/）。
// 协议见 docs/PROTOCOL.md（只用 hello/challenge/proof/ready/pair/term-token，其余为遗留帧，忽略）。
// ─────────────────────────────────────────────────────────────────────────────

const PROTO = 1;

// ── 凭据（沿用旧键名，老手机已存的不用重新扫码）─────────────────────────────
const CREDS_KEY = 'rr-creds-v1';
const loadCreds = () => { try { return JSON.parse(localStorage.getItem(CREDS_KEY)); } catch { return null; } };
const saveCreds = (c) => localStorage.setItem(CREDS_KEY, JSON.stringify(c));
const clearCreds = () => localStorage.removeItem(CREDS_KEY);

// ── 纯 JS SHA-256 / HMAC 回退（HTTP 非 localhost 无 crypto.subtle 时使用）───
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

// ── 四步清单 UI（对照 ZCode 远程控制的过渡页）───────────────────────────────
const STEPS = ['连接中继服务', '设备鉴权', '等待桌面端配对', '打开官方界面'];
const stepState = [0, 0, 0, 0];   // 0 待命 1 进行中 2 完成 3 失败
const stepEls = [];
const $headDot = document.getElementById('head-dot');
const $headText = document.getElementById('head-text');
const $headSub = document.getElementById('head-sub');
const $steps = document.getElementById('steps');
const $form = document.getElementById('pair-form');
const $foot = document.getElementById('foot');

for (let i = 0; i < STEPS.length; i++) {
  const row = document.createElement('div');
  row.className = 'step';
  const mark = document.createElement('span');
  mark.className = 'mark';
  const label = document.createElement('span');
  label.textContent = (i + 1) + '. ' + STEPS[i];
  row.appendChild(mark); row.appendChild(label);
  $steps.appendChild(row);
  stepEls.push(row);
}
function paintSteps() {
  for (let i = 0; i < stepEls.length; i++) {
    const st = stepState[i];
    const row = stepEls[i];
    row.className = 'step' + (st === 1 ? ' active' : st === 2 ? ' done' : st === 3 ? ' err' : '');
    const mark = row.firstChild;
    if (st === 2) mark.textContent = '✓';
    else if (st === 3) mark.textContent = '✕';
    else mark.textContent = '';
  }
}
function setStep(i, st) { if (stepState[i] !== st) { stepState[i] = st; paintSteps(); } }
function head(cls, text, sub) {
  $headDot.className = 'dot' + (cls ? ' ' + cls : '');
  $headText.textContent = text;
  if (sub !== undefined) $headSub.textContent = sub;
}
function foot(html) { $foot.innerHTML = html || ''; }

// ── 全局状态 ─────────────────────────────────────────────────────────────────
const state = {
  creds: null,
  ws: null,
  matched: false,
  minted: false,
  minting: false,
  reconnectTimer: null,
  reconnectDelay: 1000,
  wantConnected: false,
  tries: 0,
  waitHintTimer: null,
};

// 30s 内反复进入超过 6 次 → 判定跳转循环（如中继刚重启、cookie 频繁失效），停下报错
function loopGuard() {
  const now = Date.now();
  let arr = [];
  try { arr = JSON.parse(sessionStorage.getItem('rr-gw-entries') || '[]'); } catch { /* ignore */ }
  arr = arr.filter((t) => now - t < 30000);
  arr.push(now);
  try { sessionStorage.setItem('rr-gw-entries', JSON.stringify(arr)); } catch { /* ignore */ }
  return arr.length <= 6;
}

// ── WS 客户端 ────────────────────────────────────────────────────────────────
function wsUrl() { return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/remote/ws'; }

async function connect() {
  if (state.ws || !state.creds?.sid || !state.creds?.hash) return;
  state.wantConnected = true;
  head('', '正在连接中继服务…', '正在与中继服务器建立连接。');
  setStep(0, 1); setStep(1, 0); setStep(2, 0); setStep(3, 0);
  state.matched = false;
  state.minted = false;
  let ws;
  try { ws = new WebSocket(wsUrl()); } catch { scheduleReconnect(); return; }
  state.ws = ws;
  ws.onopen = () => {
    setStep(0, 2);
    setStep(1, 1);
    head('', '设备鉴权中…', '已连上中继，正在校验配对凭据。');
    ws.send(JSON.stringify({ type: 'hello', proto: PROTO, role: 'terminal', sid: state.creds.sid, name: state.creds.name || '手机' }));
  };
  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.wantConnected) { scheduleReconnect(); return; }
    setStep(0, 3);
    head('err', '连接已断开', '与中继的连接被关闭（' + ev.code + '）。');
  };
  ws.onerror = () => { /* onclose 跟进 */ };
  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'error') {
      if (msg.code === 'proto-mismatch') {
        state.wantConnected = false;
        setStep(1, 3);
        head('err', '协议版本不匹配', '中继与页面的协议版本不一致，请更新中继镜像后刷新重试。');
        return;
      }
      if (msg.code === 'sid-not-found') {
        state.wantConnected = false;
        try { ws.close(); } catch { /* ignore */ }
        clearCreds(); state.creds = null;
        setStep(1, 3);
        head('err', '设备不存在或已重置配对', '请在 dsh 桌面端面板重新扫码，或在下方手动填写凭据。');
        foot('');
        $form.hidden = false;
        return;
      }
      return;
    }
    if (msg.type === 'challenge') {
      try { ws.send(JSON.stringify({ type: 'proof', proof: await hmacProof(state.creds.hash, msg.nonce, 'terminal', state.creds.sid) })); }
      catch { /* onclose 跟进 */ }
      return;
    }
    if (msg.type === 'ready') {
      state.tries = 0; state.reconnectDelay = 1000;
      setStep(1, 2);
      setStep(2, 1);
      head('ok', '已配对，正在等待桌面端…', '鉴权通过，等待 dsh 桌面端插件上线并配对。');
      clearTimeout(state.waitHintTimer);
      if (msg.peer !== 1) {
        state.waitHintTimer = setTimeout(() => {
          if (!state.matched) head('ok', '已配对，正在等待桌面端…', '桌面端似乎未在线：请确认 dsh 正在运行且插件已连接中继。');
        }, 5000);
      }
      return;
    }
    if (msg.type === 'pair') {
      if (msg.status === 'matched') { state.matched = true; tryFinish(); }
      return;
    }
    if (msg.type === 'data' && msg.payload?.type === 'term-token') {
      void mint(msg.payload.token);
      return;
    }
  };
}

function disconnect() {
  state.wantConnected = false;
  clearTimeout(state.reconnectTimer);
  if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } state.ws = null; }
}

function scheduleReconnect() {
  if (!state.wantConnected || state.reconnectTimer) return;
  state.tries++;
  setStep(0, 1);
  head('', '正在连接中继服务…', '连接失败，正在重试（第 ' + state.tries + ' 次）…');
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
  state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connect(); }, delay);
}

// ── 换取完整模式 cookie ──────────────────────────────────────────────────────
async function mint(token) {
  if (state.minting || state.minted) return;
  state.minting = true;
  try {
    const r = await fetch('/remote/full-auth', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    if (r.ok) state.minted = true;
    else head('ok', '已配对，正在打开官方界面…', '换取访问凭据失败（HTTP ' + r.status + '），重连后将自动重试。');
  } catch { /* 网络抖动，重连后再换 */ }
  state.minting = false;
  tryFinish();
}

function tryFinish() {
  if (!state.matched || !state.minted) return;
  clearTimeout(state.waitHintTimer);
  setStep(2, 2);
  setStep(3, 2);
  head('ok', '已配对，正在打开官方界面…', '连接已建立，正在进入 dsh 官方界面。');
  setTimeout(() => { location.replace('/remote/full/'); }, 300);
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
function start() {
  if (!loopGuard()) {
    head('err', '页面跳转过于频繁', '中继可能刚重启，请稍等几秒后刷新重试。');
    return;
  }
  const m = (location.hash || '').match(/^#\/pair\?(.*)$/);
  if (m) {
    const p = new URLSearchParams(m[1]);
    if (p.get('sid') && p.get('hash')) {
      state.creds = { sid: p.get('sid'), hash: p.get('hash'), name: p.get('name') || '手机' };
      saveCreds(state.creds);
    }
  }
  if (!state.creds) state.creds = loadCreds();
  if (!state.creds?.sid || !state.creds?.hash) {
    head('', '等待配对', '请用 dsh 桌面端面板展示的二维码扫码进入，或在下方手动填写。');
    $form.hidden = false;
    return;
  }
  connect();
}

document.getElementById('f-go').onclick = () => {
  const sid = document.getElementById('f-sid').value.trim();
  const hash = document.getElementById('f-hash').value.trim();
  const name = document.getElementById('f-name').value.trim() || '手机';
  if (!sid || !hash) return;
  state.creds = { sid, hash, name };
  saveCreds(state.creds);
  $form.hidden = true;
  stepState.fill(0);
  paintSteps();
  state.reconnectDelay = 1000; state.tries = 0;
  connect();
};

start();
