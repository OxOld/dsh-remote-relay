// 本地演示/联调用的 mock 设备：模拟 dsh 插件的数据面。
// 用法：node mock-device.mjs  →  浏览器打开打印出的配对 URL。
import crypto from 'node:crypto';
import { connectJson, WsClient } from '../../plugin/lib/ws.mjs';

const RELAY = process.argv[2] || 'ws://127.0.0.1:8787/remote/ws';
const SID = 'demo-device-0001';
const PASSWORD = 'demo-password-demo-password-x';
const hash = crypto.createHash('sha256').update(PASSWORD, 'utf8').digest('base64url');

const ws = new WsClient(RELAY);
ws.onopen = () => ws.sendText(JSON.stringify({ type: 'hello', proto: 1, role: 'device', sid: SID, name: '演示机', hash }));
ws.onmessage = (data) => {
  let msg; try { msg = JSON.parse(data); } catch { return; }
  if (msg.type === 'challenge') {
    const proof = crypto.createHmac('sha256', Buffer.from(hash, 'utf8')).update(`${msg.nonce}|device|${SID}`).digest('base64url');
    ws.sendText(JSON.stringify({ type: 'proof', proof }));
    return;
  }
  if (msg.type === 'ready') { console.log('device ready, peer:', msg.peer); ws.sendText(JSON.stringify({ type: 'data', payload: { type: 'full-info' } })); }
  if (msg.type === 'pair') console.log('pair:', msg.status);
  if (msg.type === 'data') void handle(msg.payload);
};

const journal = [
  { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '帮我写一个防抖函数' }] } },
  { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'write_file', arguments: '{"path":"debounce.ts"}' } },
  { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: '文件已写入 (12 行)' }] } } },
  { seq: 4, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '已创建 `debounce.ts`：\n\n```ts\nexport function debounce<T extends (...a: any[]) => void>(fn: T, ms = 300) {\n  let t: any;\n  return (...args: Parameters<T>) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...args), ms);\n  };\n}\n```\n\n需要立即执行版吗？' }] } } },
];
const sessions = [
  { id: 'demo-1', title: '防抖函数与节流对比', updatedAt: Date.now() - 60000, status: 'idle', cwd: 'C:\\Projects\\demo' },
  { id: 'demo-2', title: '修复登录页白屏', updatedAt: Date.now() - 3600000, status: 'idle', cwd: 'C:\\Projects\\web' },
];

async function handle(p) {
  if (p.type && handleFull(p)) return;   // 完整模式帧优先
  if (p.c === 'bootstrap-request') {
    ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'bootstrap', sessions, device: { name: '演示机', version: 'mock' } } }));
  } else if (p.c === 'open') {
    const out = [];
    for (const e of journal) {
      const seq = e.seq;
      if (e.type === 'user/message') out.push({ seq, k: 'user', text: e.data.content[0].text });
      if (e.type === 'tool/call') out.push({ seq, k: 'tool', tool: e.data.name, args: e.data.arguments, callId: e.data.callId });
      if (e.type === 'tool/result') { const m = out.findLast((x) => x.callId === e.data.message.toolCallId); if (m) { m.ok = true; m.out = e.data.message.content[0].text; } }
      if (e.type === 'assistant/message') out.push({ seq, k: 'assistant', text: e.data.message.content[0].text, turn: e.data.turn });
    }
    ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'snapshot', sessionId: p.sessionId, title: sessions[0].title, status: 'idle', messages: out } }));
  } else if (p.c === 'send') {
    const reply = '收到：" ' + p.text + '"。这是 mock 设备的流式演示回复，支持 **Markdown** 渲染。';
    ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'status', sessionId: p.sessionId, status: 'running' } }));
    ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'delta', sessionId: p.sessionId, turn: 2, kind: 'start' } }));
    const chunks = reply.match(/.{1,6}/g) || [];
    for (let i = 0; i < chunks.length; i++) {
      await new Promise((r) => setTimeout(r, 60));
      ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'delta', sessionId: p.sessionId, turn: 2, kind: 'chunk', text: chunks[i] } }));
    }
    ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'delta', sessionId: p.sessionId, turn: 2, kind: 'end' } }));
    ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'message', sessionId: p.sessionId, msg: { seq: 100, k: 'assistant', text: reply, turn: 2 } } }));
    ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'status', sessionId: p.sessionId, status: 'idle' } }));
  } else if (p.c === 'approve') {
    console.log('approval response:', p.outcome);
  } else if (p.c === 'cancel') {
    console.log('cancel requested');
  } else if (p.c === 'fetch-att') {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
    ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'att-meta', fetchId: p.fetchId, kind: 'image', name: 'demo.png', mime: 'image/png', bytes: bytes.length, width: 4, height: 4 } }));
    ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'att-chunk', fetchId: p.fetchId, seq: 0, b64: bytes.toString('base64') } }));
    ws.sendText(JSON.stringify({ type: 'data', payload: { c: 'att-end', fetchId: p.fetchId, sha8: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8) } }));
  }
}

// ── 完整模式（模拟官方 UI）：资产推送 + HTTP/WS 桥接应答 ────────────────────────
const demoIndex = [
  '<!doctype html><html><head>',
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1" />',
  '<title>DSH 完整模式（mock 官方 UI）</title>',
  '<link href="/manifest.webmanifest" rel="manifest">',
  '<script>globalThis["__DSH_BOOT__"] = {"mock":true,"served":"完整模式桥接演示"}</script>',
  '<link rel="stylesheet" href="/assets/app-1.css">',
  '<script src="./assets/app-1.js"></script>',
  '</head><body><div id="root"></div></body></html>',
].join('');
const demoCss = 'body{font-family:system-ui;background:#0f1115;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0}main{max-width:520px;padding:24px;border:1px solid #2a2f3a;border-radius:12px;line-height:1.7}code{color:#7ab7ff}';
const demoJs = `
const $ = (h) => { document.getElementById('root').innerHTML = h; };
(async () => {
  let html = '<main><h2>完整模式 · 桥接自检</h2>';
  try {
    const boot = globalThis.__DSH_BOOT__;
    html += '<p>__DSH_BOOT__ 注入保留: <code>' + JSON.stringify(boot) + '</code></p>';
    const ping = await fetch('api/ping').then((r) => r.json());
    html += '<p>HTTP 桥 GET api/ping → <code>' + JSON.stringify(ping) + '</code></p>';
    const inv = await fetch('api/remote.invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: '来自手机的调用' }) }).then((r) => r.json());
    html += '<p>HTTP 桥 POST api/remote.invoke → <code>' + JSON.stringify(inv) + '</code></p>';
    const ws = new WebSocket('api/remote.mux');
    const wsResult = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('超时'), 5000);
      ws.onopen = () => ws.send('{"mux":"ping"}');
      ws.onmessage = (ev) => { clearTimeout(t); resolve(ev.data); };
      ws.onerror = () => { clearTimeout(t); resolve('error'); };
    });
    html += '<p>WS 桥 api/remote.mux 往返 → <code>' + String(wsResult).replace(/</g, '&lt;') + '</code></p>';
    html += '<p style="color:#4ade80">✔ 全部桥接通道工作正常</p>';
  } catch (e) {
    html += '<p style="color:#f87171">✖ ' + String(e && e.message || e).replace(/</g, '&lt;') + '</p>';
  }
  html += '</main>';
  $(html);
})();
`;
const demoFiles = [
  { path: 'index.html', buf: Buffer.from(demoIndex) },
  { path: 'manifest.webmanifest', buf: Buffer.from('{"name":"dsh-full-mock"}') },
  { path: 'assets/app-1.css', buf: Buffer.from(demoCss) },
  { path: 'assets/app-1.js', buf: Buffer.from(demoJs) },
];
const sha8 = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 8);
const sendP = (payload) => ws.sendText(JSON.stringify({ type: 'data', payload }));

function pushAssets() {
  const pushId = 'p-' + Date.now().toString(36);
  sendP({ type: 'asset-begin', pushId, version: 'mock-v1', files: demoFiles.map((f) => ({ path: f.path, size: f.buf.length, sha8: sha8(f.buf) })) });
  for (const f of demoFiles) {
    sendP({ type: 'asset-put', pushId, path: f.path, seq: 0, total: 1, data: f.buf.toString('base64') });
    sendP({ type: 'asset-end', pushId, path: f.path });
  }
  sendP({ type: 'asset-commit', pushId, version: 'mock-v1' });
  console.log('full-mode assets pushed:', demoFiles.length, 'files');
}

const wsEchoes = new Map();   // wsId → true
function handleFull(p) {
  switch (p.type) {
    case 'full-info-state': pushAssets(); return true;
    case 'asset-ok': return true;
    case 'asset-committed': console.log('full-mode committed: files=' + p.files, 'bytes=' + p.bytes); return true;
    case 'error':
      if (String(p.code || '').startsWith('asset-')) { console.error('asset error:', p.code, p.message); return true; }
      return false;
    case 'http-req': {
      const body = (() => {
        if (p.path === 'api/ping') return JSON.stringify({ pong: true, ts: Date.now() });
        if (p.path === 'api/remote.invoke') return JSON.stringify({ echoed: JSON.parse(Buffer.from(p.body || '', 'base64').toString('utf8')), via: 'mock-device' });
        return JSON.stringify({ path: p.path, method: p.method, note: 'mock-device generic echo' });
      })();
      sendP({ type: 'http-res-head', reqId: p.reqId, status: 200, headers: { 'content-type': 'application/json' } });
      sendP({ type: 'http-res-chunk', reqId: p.reqId, data: Buffer.from(body).toString('base64') });
      sendP({ type: 'http-res-end', reqId: p.reqId });
      return true;
    }
    case 'ws-open': sendP({ type: 'ws-opened', wsId: p.wsId }); return true;
    case 'ws-text': sendP({ type: 'ws-text', wsId: p.wsId, text: JSON.stringify({ mux: 'echo', got: safeJson(p.text) }) }); return true;
    case 'ws-bin': sendP({ type: 'ws-bin', wsId: p.wsId, data: p.data }); return true;
    case 'ws-close': sendP({ type: 'ws-closed', wsId: p.wsId, code: 1000, reason: 'mock' }); return true;
    default: return false;
  }
}
function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

await ws.connect();
const origin = RELAY.replace(/^ws/, 'http').replace(/\/remote\/ws$/, '');
console.log('配对 URL:', `${origin}/remote/#/pair?sid=${SID}&hash=${encodeURIComponent(hash)}&name=${encodeURIComponent('演示机')}`);
setInterval(() => ws.ping(), 5000);
