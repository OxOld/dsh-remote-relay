// ─────────────────────────────────────────────────────────────────────────────
// dsh-remote-relay 全链路集成测试：真实 relay + 假 dsh ctx + 插件 + 终端客户端
// 运行：node test/test-dist.mjs
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRelay, PROTO } from '../../relay/relay.mjs';
import { connectJson } from '../lib/ws.mjs';
import { apply } from '../lib/index.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rr-e2e-'));
const toolsDir = path.join(tmp, 'tools');
fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });

const relay = await startRelay({ port: 0, publicDir: path.join(tmp, 'public'), dataDir: path.join(tmp, 'data'), regToken: 'e2e-reg-token' });
const RELAY_WS = `ws://127.0.0.1:${relay.port}/remote/ws`;
const STEP = (n, msg) => console.log(`  [${n}] ${msg}`);

// ── 假 dsh 环境 ──────────────────────────────────────────────────────────────
const journal = [
  { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '帮我看看 a.ts' }] } },
  { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' } },
  { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }] } } },
  { seq: 4, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '分析如下：**OK**' }] } } },
  { seq: 5, type: 'user/message', data: { content: [{ type: 'text', text: '看截图' }, { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 8, width: 10, height: 10, name: 'shot.png' } }] } },
];
const sentMessages = [];
let cancelled = null;
const fakeAgent = {
  session: { id: 's1', events: journal },
  send: (msg) => sentMessages.push(msg),
};
const services = new Map([
  ['sessionQuery', {
    listSessions: async () => [{ header: { id: 's1', origin: 'user', delegationDepth: 0, updatedAt: Date.now() - 60000 } }],
    readTitle: async () => ({ title: '测试会话' }),
    readSession: async (id) => ({ events: journal }),
  }],
  ['agents', {
    get: (id) => (id === 's1' ? fakeAgent : null),
    resume: async ({ resumeSessionId }) => fakeAgent,
  }],
  ['workspaceRegistry', { archivedSessionIds: [], list: () => [{ sessionIds: ['s1'] }] }],
  ['attachments', { readImage: async (ref) => ({ data: Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]) }) }],
  ['connection', {}],   // 无 authenticatedUrl：callRpc 直接裸调（测试服务器不校验 cookie）
]);

const listeners = new Map();
const cleanups = [];
const registeredRoutes = [];
const taps = [];
const apiBodies = [];

const ctx = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => listeners.get(event)?.splice(listeners.get(event).indexOf(fn), 1);
  },
  get: (name) => services.get(name) ?? null,
  inject(_deps, fn) { fn(hostCtx); },
  effect(fn) { cleanups.push(fn()); },
  emit(event, ...args) { for (const fn of listeners.get(event) || []) void fn(...args); },
};

// 面板/配置路由挂到真实 HTTP 服务器上，顺带承载 /api/session.cancel
// 以及"官方 UI"风格端点（完整模式 E2E 用）：served index 带 __DSH_BOOT__ 注入
// fakeIndexRev / assetBody 可在用例中改动，模拟"dsh 每次启动 rev 都变"与"资产内容真变"。
let fakeIndexRev = 'e2e1';
let assetBody = 'console.log("e2e asset")';
const buildFakeIndex = () => [
  '<!doctype html><html><head>',
  '<meta name="viewport" content="width=device-width, initial-scale=1" />',
  '<title>DSH E2E Build</title>',
  '<link href="/manifest.webmanifest" rel="manifest">',
  '<script>globalThis["__DSH_BOOT__"] = {"e2e":true}</script>',
  '<script src="./assets/app-1.js"></script>',
  // dsh 真实 index 里的插件 combo 行：rev 由 bundle 文件 mtime 派生，每次启动都会变
  '<link rel="preload" as="script" href="/plugins/??fake/client.js&rev=' + fakeIndexRev + '">',
  '</head><body><div id="root"></div></body></html>',
].join('');
const apiEchoBodies = [];
const httpServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/api/session.cancel') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { apiBodies.push(body); res.writeHead(200, { 'content-type': 'application/json' }).end('{"result":{"accepted":true}}'); });
    return;
  }
  if (pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(buildFakeIndex()); return; }
  if (pathname === '/manifest.webmanifest') { res.writeHead(200, { 'content-type': 'application/manifest+json' }).end('{"name":"dsh-e2e"}'); return; }
  if (pathname === '/assets/app-1.js') { res.writeHead(200, { 'content-type': 'text/javascript' }).end(assetBody); return; }
  // 懒加载 chunk：官方 UI 运行时才请求（如终端面板），不在 index 引用里
  if (pathname === '/plugins/@deepseek-ai/dsh-client-ui-sidebar-terminal/client.terminal.js') { res.writeHead(200, { 'content-type': 'text/javascript' }).end('console.log("e2e terminal chunk")'); return; }
  if (pathname === '/api/echo') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      apiEchoBodies.push(body);
      // set-cookie 故意带上：验证桥接过滤，不把 dsh 会话 cookie 泄露给手机
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dsh-auth-e2e=secret; Path=/' }).end(JSON.stringify({ echo: body, method: req.method }));
    });
    return;
  }
  for (const route of registeredRoutes) {
    if (route.path === pathname) { void route.handler(req, res); return; }
  }
  res.writeHead(404).end();
});
// 官方 UI 的 mux WS（完整模式 WS 桥的本地对端）：文本帧回显
httpServer.on('upgrade', (req, socket) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname !== '/api/remote.mux') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  let buf = Buffer.alloc(0);
  socket.on('error', () => { try { socket.destroy(); } catch { /* ignore */ } });   // 对端 RST 时避免未处理 error 事件
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) break;
      const b0 = buf[0], b1 = buf[1], op = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let maskKey = null;
      if (b1 & 0x80) { if (buf.length < off + 4) break; maskKey = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) break;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      buf = buf.subarray(off + len);
      if (op === 0x9) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));   // ping → pong（未掩码）
      else if (op === 0x8) { try { socket.end(); } catch { /* ignore */ } }
      else if (op === 0x1) socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));   // 文本回显
    }
  });
});
await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
const httpPort = httpServer.address().port;

const hostCtx = {
  webServer: {
    port: httpPort,
    register: (route) => registeredRoutes.push(route),
    tapIndex: (fn) => taps.push(fn),
  },
};

// ── 启动插件 ─────────────────────────────────────────────────────────────────
apply(ctx, {
  relayUrl: RELAY_WS,
  regToken: 'e2e-reg-token',   // 与 relay 侧一致：验证设备注册口令链路
  toolsDir,
  autoConnect: true,
  deviceName: '测试机 E2E',
});

// 等 device 上线（轮询 info.connected）
async function waitDevice() {
  for (let i = 0; i < 100; i++) {
    const info = await infoReq();
    if (info.connected) return info;
    await sleep(100);
  }
  throw new Error('device 未在 10s 内连接中继');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function infoReq() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: httpPort, path: '/remote-relay/info' }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
}

console.log('dsh-remote-relay E2E');
STEP(1, '插件出站连接中继…');
const info1 = await waitDevice();
assert.equal(info1.configured, true);
assert.equal(info1.deviceName, '测试机 E2E');
assert.ok(info1.sid.startsWith('dsh-'));
assert.ok(info1.qrUrl.includes('#/pair?sid=' + encodeURIComponent(info1.sid)));

STEP(2, '终端扫码配对（hash 来自 info.qrUrl）…');
const qrUrl = new URL(info1.qrUrl.replace(/^https?:\/\//, (m) => (m.startsWith('https') ? 'https://' : 'http://')) + '');
// 直接从 qrUrl 提取（fragment 内）
const fragQ = new URLSearchParams(info1.qrUrl.split('#')[1].split('?')[1]);
const term = await connectJson(RELAY_WS);
await term.send({ type: 'hello', proto: PROTO, role: 'terminal', sid: fragQ.get('sid'), name: '手机' });
const challenge = await term.recv();
const hash = fragQ.get('hash');
const proof = crypto.createHmac('sha256', Buffer.from(hash, 'utf8')).update(`${challenge.nonce}|terminal|${fragQ.get('sid')}`).digest('base64url');
await term.send({ type: 'proof', proof });
const ready = await term.recv();
assert.equal(ready.type, 'ready');
assert.equal(ready.peer, 1);
const pairT = await term.recv();
assert.equal(pairT.status, 'matched');
const termTok = (await term.nextData()).payload;   // ready 后紧跟完整模式凭据
assert.equal(termTok.type, 'term-token');
const helloPayload = (await term.nextData()).payload;
assert.equal(helloPayload.c, 'hello');
assert.equal(helloPayload.device.name, '测试机 E2E');

STEP(3, 'bootstrap：会话列表投影…');
await term.send({ type: 'data', payload: { c: 'bootstrap-request' } });
const boot = (await term.nextData()).payload;
assert.equal(boot.c, 'bootstrap');
assert.equal(boot.sessions.length, 1);
assert.equal(boot.sessions[0].id, 's1');
assert.equal(boot.sessions[0].title, '测试会话');

STEP(4, 'open：历史快照（事件投影 + tool 合并）…');
await term.send({ type: 'data', payload: { c: 'open', sessionId: 's1', tail: 200 } });
const snap = (await term.nextData()).payload;
assert.equal(snap.c, 'snapshot');
assert.equal(snap.title, '测试会话');
const kinds = snap.messages.map((m) => m.k);
assert.deepEqual(kinds, ['user', 'tool', 'assistant', 'user']);
const toolMsg = snap.messages[1];
assert.equal(toolMsg.tool, 'read_file');
assert.equal(toolMsg.ok, true);
assert.equal(toolMsg.out, '文件内容');
assert.equal(snap.messages[3].atts?.[0]?.id, 'sha256:abc');   // 图片附件引用已投影

STEP(5, '实时事件：session/event → message，流式 delta，status…');
ctx.emit('session/event', { id: 's1' }, { seq: 5, type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } });
const liveUser = (await term.nextData()).payload;
assert.equal(liveUser.c, 'message');
assert.equal(liveUser.msg.k, 'user');
assert.equal(liveUser.msg.text, '继续');

ctx.emit('agent/assistant-stream', { agent: { session: { id: 's1' } }, frame: { type: 'start', turn: 2, step: 1, attemptId: 'a1', revision: 1 } });
const dStart = (await term.nextData()).payload;
assert.deepEqual([dStart.c, dStart.kind], ['delta', 'start']);
ctx.emit('agent/assistant-stream', { agent: { session: { id: 's1' } }, frame: { type: 'chunk', turn: 2, step: 1, attemptId: 'a1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '回答中…' } } });
const dChunk = (await term.nextData()).payload;
assert.equal(dChunk.text, '回答中…');
ctx.emit('agent/status', { agent: { session: { id: 's1' } }, status: 'running' });
const stRun = (await term.nextData()).payload;
assert.deepEqual([stRun.c, stRun.status], ['status', 'running']);
ctx.emit('agent/status', { agent: { session: { id: 's1' } }, status: 'idle' });
await term.nextData();   // status idle

STEP(6, 'send：终端发消息 → agent.send 被调用…');
await term.send({ type: 'data', payload: { c: 'send', sessionId: 's1', msgId: 'm1', text: '手机来的消息' } });
for (let i = 0; i < 50 && sentMessages.length === 0; i++) await sleep(100);
assert.equal(sentMessages.length, 1);
assert.equal(sentMessages[0].content[0].text, '手机来的消息');
assert.equal(sentMessages[0].role, 'user');

STEP(7, 'cancel：走本地 /api/session.cancel…');
await term.send({ type: 'data', payload: { c: 'cancel', sessionId: 's1' } });
for (let i = 0; i < 50 && apiBodies.length === 0; i++) await sleep(100);
assert.ok(apiBodies[0].includes('session.cancel'));
assert.ok(apiBodies[0].includes('"s1"'));

STEP(8, 'approval：手机批准工具调用（waterfall 返回 allowed-once）…');
ctx.emit('session/event', { id: 's1' }, { seq: 6, type: 'tool/call', data: { turn: 3, step: 1, callId: 'c9', name: 'bash', arguments: '{"cmd":"npm test"}' } });
await term.nextData();   // tool/call 的 message 推送
const approvalListener = listeners.get('approval/request')[0];
assert.ok(approvalListener, 'approval/request 监听器未注册');
const nextCalls = [];
const next = async () => { nextCalls.push(1); return 'unavailable'; };
const outcomePromise = approvalListener({ agent: { session: { id: 's1' } }, toolName: 'bash', callId: 'c9' }, next);
const appr = (await term.nextData()).payload;
assert.equal(appr.c, 'approval');
assert.equal(appr.tool, 'bash');
assert.equal(appr.args, '{"cmd":"npm test"}');
await term.send({ type: 'data', payload: { c: 'approve', requestId: appr.requestId, outcome: 'allowed-once' } });
const outcome = await outcomePromise;
assert.equal(outcome, 'allowed-once');
const done = (await term.nextData()).payload;
assert.deepEqual([done.c, done.outcome, done.by], ['approval-done', 'allowed-once', 'phone']);

STEP(9, 'approval 超时路径：手机离线时委托 next()…');
// 先断开终端（用新终端连接顶替的间隙不可靠，这里直接验证 approveFromPhone=false 短路）
// 简化：通过配置关掉 approveFromPhone 再触发瀑布 → 应直接 next()
const cfgRes = await postConfig({ approveFromPhone: false });
assert.equal(cfgRes.ok, true);
const outcome2 = await approvalListener({ agent: { session: { id: 's1' } }, toolName: 'bash', callId: 'c10' }, next);
assert.equal(outcome2, 'unavailable');
assert.equal(nextCalls.length, 1);
await postConfig({ approveFromPhone: true });   // 恢复

STEP(10, '附件：readImage 分帧 + sha8 校验…');
await term.send({ type: 'data', payload: { c: 'fetch-att', fetchId: 'f1', sessionId: 's1', attachmentId: 'sha256:abc' } });
const meta = (await term.nextData()).payload;
assert.equal(meta.c, 'att-meta');
assert.equal(meta.mime, 'image/png');
const chunk = (await term.nextData()).payload;
assert.equal(chunk.c, 'att-chunk');
const end = (await term.nextData()).payload;
assert.equal(end.c, 'att-end');
const bytes = Buffer.from(chunk.b64, 'base64');
assert.deepEqual([...bytes], [137, 80, 78, 71, 1, 2, 3, 4]);
assert.equal(end.sha8, crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8));

// ── 完整模式（官方 UI 远程化，协议 §3）──────────────────────────────────────
const relayOrigin = `http://127.0.0.1:${relay.port}`;
const rawReq = (method, base, p, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const u = new URL(p, base);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

STEP('10b', '完整模式：term-token 换 cookie，插件自动推送官方 UI 资产…');
const authRes = await rawReq('POST', relayOrigin, '/remote/full-auth', { headers: { authorization: 'Bearer ' + termTok.token } });
assert.equal(authRes.status, 204, 'full-auth 应 204');
const fullCookie = (authRes.headers['set-cookie'] || [''])[0].split(';')[0];
assert.ok(fullCookie.startsWith('rrm_full='));
// 插件在 relay ready 时自动推送；轮询 /remote/full/ 直到资产可访问
let fullPage = null;
for (let i = 0; i < 100 && !fullPage; i++) {
  const r = await rawReq('GET', relayOrigin, '/remote/full/', { headers: { cookie: fullCookie } });
  if (r.status === 200) fullPage = r; else await sleep(150);
}
assert.ok(fullPage, '15s 内官方 UI 资产未推送完成');
const fullBody = fullPage.body.toString('utf8');
assert.match(fullBody, /globalThis\["__DSH_BOOT__"\] = \{"e2e":true\}/, '__DSH_BOOT__ 注入必须保留');
assert.match(fullBody, /href="manifest\.webmanifest"/, '绝对路径应改写为相对');
assert.match(fullBody, /src="\.\/assets\/app-1\.js"/, '本已相对的引用不应被改写');
const assetRes = await rawReq('GET', relayOrigin, '/remote/full/assets/app-1.js', { headers: { cookie: fullCookie } });
assert.equal(assetRes.status, 200);
assert.equal(assetRes.body.toString(), 'console.log("e2e asset")');
assert.match(assetRes.headers['cache-control'], /immutable/);

STEP('10c', '完整模式：HTTP 桥（/remote/full/api/* → 本机 dsh）…');
const echoRes = await rawReq('POST', relayOrigin, '/remote/full/api/echo?x=1', {
  headers: { cookie: fullCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ from: 'phone' }),
});
assert.equal(echoRes.status, 200);
const echoJson = JSON.parse(echoRes.body.toString());
assert.equal(echoJson.method, 'POST');
assert.equal(JSON.parse(echoJson.echo).from, 'phone');
assert.equal(echoRes.headers['set-cookie'], undefined, 'dsh 会话 cookie 不得外泄');
assert.ok(apiEchoBodies.length > 0, '本地 /api/echo 未被调用');

STEP('10c2', '完整模式：未命中资产回源（懒加载 chunk 经桥取回）…');
const chunkRes = await rawReq('GET', relayOrigin, '/remote/full/plugins/@deepseek-ai/dsh-client-ui-sidebar-terminal/client.terminal.js?rev=e2e1', { headers: { cookie: fullCookie } });
assert.equal(chunkRes.status, 200, `回源应 200，实际 ${chunkRes.status}：${chunkRes.body.toString().slice(0, 80)}`);
assert.equal(chunkRes.body.toString(), 'console.log("e2e terminal chunk")');

STEP('10d', '完整模式：WS 桥（api/remote.mux 1:1 透传）…');
const mux = await connectJson(`ws://127.0.0.1:${relay.port}/remote/full/api/remote.mux`, { headers: { cookie: fullCookie } });
mux.send({ mux: 'ping', n: 1 });
const echoed = await mux.recv(8000);
assert.deepEqual(echoed, { mux: 'ping', n: 1 });
mux.close(1000);
await new Promise((r) => setTimeout(r, 300));   // 让关闭握手完成，暴露异步错误

STEP(11, '面板注入：index-inject 与 tapIndex 双通道…');
const table = [];
ctx.emit('webserver/index-inject', table);
const row = table.find((r) => r.kind === 'script' && r.text.includes('__rrBooted'));
assert.ok(row, 'index-inject 未注入面板脚本');
const tapped = taps[0]('<html><body></body></html>');
assert.ok(tapped.includes('__rrBooted'), 'tapIndex 未注入');
assert.ok(tapped.includes('</body>'), 'tapIndex 破坏了 HTML');
// 二次注入去重：宿主可能带着已收集的表再次发射，此时不得重复 push
const table2 = [{ kind: 'script', placement: 'body', text: row.text }];
ctx.emit('webserver/index-inject', table2);
assert.equal(table2.length, 1, '去重失败');

STEP(12, '重置配对：新 sid + 重连 + 旧凭据失效…');
const cfgRes2 = await postConfig({ resetPairing: true });
assert.equal(cfgRes2.ok, true);
assert.equal(cfgRes2.reconnectNeeded, true);
for (let i = 0; i < 100; i++) { const inf = await infoReq(); if (inf.connected) break; await sleep(100); }
const info2 = await infoReq();
assert.notEqual(info2.sid, info1.sid);
// 新二维码里的 hash 重新配对成功（注意竞态：connected 只代表 TCP 建立，
// relay 侧的 sid 注册要等 device 的 hello 处理完，因此失败需重试）
const fragQ2 = new URLSearchParams(info2.qrUrl.split('#')[1].split('?')[1]);
let ready2 = null;
for (let attempt = 0; attempt < 5 && !ready2; attempt++) {
  const term2 = await connectJson(RELAY_WS);
  await term2.send({ type: 'hello', proto: PROTO, role: 'terminal', sid: fragQ2.get('sid'), name: '新手机' });
  const ch2 = await term2.recv();
  if (ch2.type === 'error') { console.log('  [t2-err]', attempt, JSON.stringify(ch2), 'hash=', fragQ2.get('hash')?.slice(0,10)); term2.close(1000); await sleep(300); continue; }
  const proof2 = crypto.createHmac('sha256', Buffer.from(fragQ2.get('hash'), 'utf8')).update(`${ch2.nonce}|terminal|${fragQ2.get('sid')}`).digest('base64url');
  await term2.send({ type: 'proof', proof: proof2 });
  const r2 = await term2.recv();
  if (r2.type === 'ready') { ready2 = r2; term2.close(1000); break; }
  term2.close(1000);
  await sleep(300);
}
assert.ok(ready2, '重置后新终端 5 次内未配对成功');

STEP(13, '总开关：停止即断开且不自动重连，启用后重新连上…');
const offRes = await postConfig({ enabled: false });
assert.equal(offRes.ok, true);
assert.equal(offRes.enabled, false, '停止后 info.enabled 应为 false');
assert.equal(offRes.connected, false, '停止后应立即断开');
await sleep(1800);   // 跨越退避重连窗口（1s 起）：关掉后绝不能自己连回来
const stillOff = await infoReq();
assert.equal(stillOff.enabled, false);
assert.equal(stillOff.connected, false, '停止后仍在自动重连');
const savedOff = JSON.parse(fs.readFileSync(path.join(toolsDir, 'remote-relay.json'), 'utf8'));
assert.equal(savedOff.enabled, false, '总开关状态未落盘（重启后无法沿用）');
const onRes = await postConfig({ enabled: true });
assert.equal(onRes.enabled, true);
for (let i = 0; i < 100; i++) { if ((await infoReq()).connected) break; await sleep(100); }
assert.equal((await infoReq()).connected, true, '启用后 10s 内未重新连上中继');
const savedOn = JSON.parse(fs.readFileSync(path.join(toolsDir, 'remote-relay.json'), 'utf8'));
assert.equal(savedOn.enabled, true, '启用状态未落盘');

STEP(14, '指纹：index 的 ?rev= 变化不重推，资产内容真变才重推…');
const metaOf = (sid) => path.join(tmp, 'data', 'assets', sid, 'full.json');
const metaVersion = () => JSON.parse(fs.readFileSync(metaOf(info2.sid), 'utf8')).version;
const waitConnected = async () => {
  for (let i = 0; i < 100; i++) { if ((await infoReq()).connected) return; await sleep(100); }
  throw new Error('重连超时');
};
const v0 = metaVersion();
const m0 = fs.statSync(metaOf(info2.sid)).mtimeMs;
fakeIndexRev = 'e2e2';   // 模拟 dsh 重启：只有 rev（mtime 派生）变了，内容一点没变
await postConfig({ enabled: false });
await postConfig({ enabled: true });
await waitConnected();
await sleep(1000);
assert.equal(metaVersion(), v0, '仅 rev 变化却触发了整包重推');
assert.equal(fs.statSync(metaOf(info2.sid)).mtimeMs, m0, '仅 rev 变化却重写了中继资产');

assetBody = 'console.log("e2e asset v2")';   // 内容真变：必须重推
await postConfig({ enabled: false });
await postConfig({ enabled: true });
await waitConnected();
let v2 = v0;
for (let i = 0; i < 100 && v2 === v0; i++) { await sleep(100); v2 = metaVersion(); }
assert.notEqual(v2, v0, '资产内容变化未触发重推');
const appFile = path.join(tmp, 'data', 'assets', info2.sid, 'full', 'assets', 'app-1.js');
assert.equal(fs.readFileSync(appFile, 'utf8'), 'console.log("e2e asset v2")', '重推后中继上的资产未更新');

// ── 收尾 ─────────────────────────────────────────────────────────────────────
for (const c of cleanups) { try { await c(); } catch { /* ignore */ } }
term.close(1000);
await relay.close();
httpServer.close();
await new Promise((r) => httpServer.closeAllConnections?.() ?? r());
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n全部通过 ✓  （17 组用例：连接/配对/列表/快照/实时/发送/取消/批准/附件/完整模式资产/HTTP桥/WS桥/注入/重置/总开关/指纹稳定）');
process.exit(0);

async function postConfig(patch) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(patch);
    const req = http.request({ host: '127.0.0.1', port: httpPort, path: '/remote-relay/config', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
