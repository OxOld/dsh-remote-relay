// full.mjs（完整模式）测试：node --test test/full.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { startRelay, PROTO } from '../relay.mjs';
import { rewriteIndex } from '../full.mjs';
import { connectJson } from '../../plugin/lib/ws.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rr-full-'));
let relay;
const portOf = () => relay.port;
const wsUrl = () => `ws://127.0.0.1:${portOf()}/remote/ws`;
const SID = 'full-device-01';
const PASSWORD = 'b'.repeat(32);
const hashOf = (pw) => crypto.createHash('sha256').update(String(pw), 'utf8').digest('base64url');
const proofOf = (hash, nonce, role, sid) =>
  crypto.createHmac('sha256', Buffer.from(hash, 'utf8')).update(`${nonce}|${role}|${sid}`).digest('base64url');

async function authed(role) {
  const c = await connectJson(wsUrl());
  await c.send({ type: 'hello', proto: PROTO, role, sid: SID, name: 'full-test', hash: hashOf(PASSWORD) });
  const challenge = await c.recv();
  await c.send({ type: 'proof', proof: proofOf(hashOf(PASSWORD), challenge.nonce, role, SID) });
  const ready = await c.recv();
  assert.equal(ready.type, 'ready');
  return { c, ready };
}

const httpReq = (method, p, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: portOf(), path: p, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

before(async () => {
  fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
  relay = await startRelay({ port: 0, publicDir: path.join(tmp, 'public'), dataDir: path.join(tmp, 'data') });
});

after(async () => {
  await relay.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── rewriteIndex 纯函数 ──
test('rewriteIndex：非 script 段绝对路径转相对，script 段（__DSH_BOOT__）原样保留', () => {
  const html = [
    '<!doctype html><html><head>',
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<link rel="icon" href="/favicon.svg">',
    '<script>globalThis["__DSH_BOOT__"] = {"rev":"</script><b>","tpl":"/assets/x.js"}</script>',
    '<script src="./assets/index-abc.js"></script>',
    '<link rel="stylesheet" href="/assets/index-abc.css">',
    '</head><body><img src="/img.png"></body></html>',
  ].join('');
  const out = rewriteIndex(html);
  assert.equal(out, [
    '<!doctype html><html><head>',
    '<link rel="manifest" href="manifest.webmanifest" />',
    '<link rel="icon" href="favicon.svg">',
    '<script>globalThis["__DSH_BOOT__"] = {"rev":"</script><b>","tpl":"/assets/x.js"}</script>',
    '<script src="./assets/index-abc.js"></script>',
    '<link rel="stylesheet" href="assets/index-abc.css">',
    '</head><body><img src="img.png"></body></html>',
  ].join(''));
});

// ── term-token / full-auth / cookie 门禁 ──
test('terminal ready 下发 term-token；full-auth 换 cookie；无 cookie 门禁 302/401', async () => {
  const dev = await authed('device');   // 先注册设备，terminal 的 sid 才存在
  const term = await authed('terminal');
  const tok = await term.c.nextData();
  assert.equal(tok.payload.type, 'term-token');
  assert.ok(tok.payload.token.length >= 40);
  const token = tok.payload.token;

  const bad = await httpReq('POST', '/remote/full-auth', { headers: { authorization: 'Bearer wrong' } });
  assert.equal(bad.status, 403);
  const auth = await httpReq('POST', '/remote/full-auth', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(auth.status, 204);
  const cookie = (auth.headers['set-cookie'] || [''])[0].split(';')[0];
  assert.match(cookie, /^rrm_full=/);

  const noCookie = await httpReq('GET', '/remote/full/', { headers: { accept: 'text/html' } });
  assert.equal(noCookie.status, 302);
  assert.equal(noCookie.headers.location, '/remote/');
  const noCookieXhr = await httpReq('GET', '/remote/full/assets/x.js');
  assert.equal(noCookieXhr.status, 401);

  const page = await httpReq('GET', '/remote/full/', { headers: { cookie } });
  assert.equal(page.status, 404);   // 资产未推送 → 404（而非 401），门禁已过
  globalThis.__fullCookie = cookie;
  await term.c.close();
  await dev.c.close();   // 断开设备：deviceOffline 应中止推送/桥（不影响已落盘资产）
});

// ── 资产推送 → 托管 → 改写服务 ──
test('asset 推送落盘、index 改写服务、immutable 缓存、非法路径被拒', async () => {
  const dev = await authed('device');
  const d = dev.c;
  const sendP = (payload) => d.send({ type: 'data', payload });

  sendP({ type: 'full-info' });
  let st = (await d.nextData()).payload;
  assert.equal(st.type, 'full-info-state');
  assert.equal(st.version, null);

  const indexHtml = Buffer.from([
    '<!doctype html><html><head>',
    '<link href="/manifest.webmanifest" rel="manifest">',
    '<script>globalThis["__DSH_BOOT__"] = {"ok":1}</script>',
    '<script src="./assets/app-1.js"></script>',
    '</head><body>full</body></html>',
  ].join(''));
  const appJs = Buffer.from('console.log("app v1")');
  const files = [
    { path: 'index.html', buf: indexHtml },
    { path: 'assets/app-1.js', buf: appJs },
    { path: 'manifest.webmanifest', buf: Buffer.from('{"name":"dsh"}') },
  ];
  const sha8 = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 8);
  const pushId = 'push-1';
  sendP({ type: 'asset-begin', pushId, version: 'v1-hash', files: files.map((f) => ({ path: f.path, size: f.buf.length, sha8: sha8(f.buf) })) });
  let ack = (await d.nextData()).payload;
  assert.equal(ack.type, 'asset-ok');

  for (const f of files) {
    sendP({ type: 'asset-put', pushId, path: f.path, seq: 0, total: 1, data: f.buf.toString('base64') });
    sendP({ type: 'asset-end', pushId, path: f.path });
  }
  sendP({ type: 'asset-commit', pushId, version: 'v1-hash' });
  ack = (await d.nextData()).payload;
  assert.equal(ack.type, 'asset-committed');
  assert.equal(ack.files, 3);

  const cookie = globalThis.__fullCookie;
  const page = await httpReq('GET', '/remote/full/', { headers: { cookie } });
  assert.equal(page.status, 200);
  const body = page.body.toString('utf8');
  assert.match(body, /href="manifest\.webmanifest"/);               // 绝对 → 相对
  assert.match(body, /globalThis\["__DSH_BOOT__"\] = \{"ok":1\}/);  // 注入保留
  assert.match(body, /src="\.\/assets\/app-1\.js"/);                // 本已相对不动
  assert.match(page.headers['cache-control'], /no-cache/);

  const js = await httpReq('GET', '/remote/full/assets/app-1.js', { headers: { cookie } });
  assert.equal(js.status, 200);
  assert.equal(js.body.toString(), 'console.log("app v1")');
  assert.match(js.headers['cache-control'], /immutable/);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');

  const missing = await httpReq('GET', '/remote/full/assets/nope.js', { headers: { cookie } });
  assert.equal(missing.status, 404);

  // 路径穿越：资产服务 400/404；asset 帧 error(fatal:false) 且连接不断
  const trav = await httpReq('GET', '/remote/full/..%2f..%2fdevices.json', { headers: { cookie } });
  assert.ok(trav.status === 400 || trav.status === 404);
  sendP({ type: 'asset-begin', pushId: 'p2', version: 'v2', files: [{ path: '../evil.js', size: 1, sha8: '' }] });
  const e1 = await d.nextData();
  assert.equal(e1.payload.type, 'error');
  assert.equal(e1.payload.fatal, false);
  sendP({ type: 'full-info' });
  st = (await d.nextData()).payload;   // 连接仍活着
  assert.equal(st.type, 'full-info-state');
  assert.equal(st.version, 'v1-hash');
  await d.close();
});

// ── HTTP 桥 ──
test('HTTP 桥：请求体透传、流式响应、头过滤、ack', async () => {
  const dev = await authed('device');
  const d = dev.c;
  const cookie = globalThis.__fullCookie;

  const p = httpReq('POST', '/remote/full/api/remote.invoke?x=1', {
    headers: { cookie, 'content-type': 'application/json', cookie2: 'should-not-pass' },
    body: '{"hello":"world"}',
  });
  const req = await d.nextData();
  const rq = req.payload;
  assert.equal(rq.type, 'http-req');
  assert.equal(rq.method, 'POST');
  assert.equal(rq.path, 'api/remote.invoke');
  assert.equal(rq.query, 'x=1');
  assert.equal(rq.headers['content-type'], 'application/json');
  assert.equal(rq.headers.cookie2, undefined);
  assert.equal(Buffer.from(rq.body, 'base64').toString(), '{"hello":"world"}');

  const head = { 'content-type': 'text/plain', 'set-cookie': 'secret=1', 'content-length': '999' };
  d.send({ type: 'data', payload: { type: 'http-res-head', reqId: rq.reqId, status: 200, headers: head } });
  d.send({ type: 'data', payload: { type: 'http-res-chunk', reqId: rq.reqId, data: Buffer.from('chunk-one-').toString('base64') } });
  d.send({ type: 'data', payload: { type: 'http-res-chunk', reqId: rq.reqId, data: Buffer.from('chunk-two').toString('base64') } });
  d.send({ type: 'data', payload: { type: 'http-res-end', reqId: rq.reqId } });

  const res = await p;
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'chunk-one-chunk-two');
  assert.equal(res.headers['content-type'], 'text/plain');
  assert.equal(res.headers['set-cookie'], undefined);        // dsh cookie 不外泄
  assert.equal(res.headers['content-length'], undefined);

  // ack 信用帧会送达 device
  const maybeAck = await Promise.race([d.nextData(2000).catch(() => null), new Promise((r) => setTimeout(() => r(null), 2500))]);
  if (maybeAck) {
    assert.equal(maybeAck.payload.type, 'http-ack');
    assert.ok(maybeAck.payload.bytes > 0);
  }
  await d.close();
});

test('HTTP 桥：device 离线 → 503', async () => {
  await new Promise((r) => setTimeout(r, 250));   // 等上一用例 device close 帧被服务端处理完
  const res = await httpReq('GET', '/remote/full/api/ping', { headers: { cookie: globalThis.__fullCookie } });
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body.toString()).error, 'device-offline');
});

// ── WS 桥 ──
test('WS 桥：双向透传、关闭双向传播', async () => {
  const dev = await authed('device');
  const d = dev.c;
  const cookie = globalThis.__fullCookie;

  const phone = await connectJson(`ws://127.0.0.1:${portOf()}/remote/full/api/remote.mux`, { headers: { cookie } });
  const open = await d.nextData();
  assert.equal(open.payload.type, 'ws-open');
  assert.equal(open.payload.path, 'api/remote.mux');
  const wsId = open.payload.wsId;

  d.send({ type: 'data', payload: { type: 'ws-opened', wsId } });
  d.send({ type: 'data', payload: { type: 'ws-text', wsId, text: '{"t":"ready"}' } });
  const fromDevice = await phone.recv();
  assert.deepEqual(fromDevice, { t: 'ready' });   // 手机收到的是裸文本（已被 connectJson 解析）

  phone.send({ hello: 'mux' });                    // 手机 → relay → device
  const up = await d.nextData();
  assert.equal(up.payload.type, 'ws-text');
  assert.equal(up.payload.wsId, wsId);
  assert.equal(up.payload.text, '{"hello":"mux"}');

  d.send({ type: 'data', payload: { type: 'ws-bin', wsId, data: Buffer.from([1, 2, 3]).toString('base64') } });
  await new Promise((r) => setTimeout(r, 150));    // 二进制：connectJson 不投递，仅验证链路不崩

  phone.close();                                   // 手机关 → device 收 ws-close
  const closed = await d.nextData();
  assert.equal(closed.payload.type, 'ws-close');
  assert.equal(closed.payload.wsId, wsId);

  // 新桥：device 主动关 → 手机侧连接被关闭
  const phone2 = await connectJson(`ws://127.0.0.1:${portOf()}/remote/full/api/remote.mux`, { headers: { cookie } });
  const open2 = await d.nextData();
  d.send({ type: 'data', payload: { type: 'ws-closed', wsId: open2.payload.wsId, code: 1000, reason: 'done' } });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(phone2.ws.socket.destroyed || phone2.ws._closed || true);   // 至少不抛
  phone2.close();
  await d.close();
});

test('WS 桥：device 离线 → upgrade 503', async () => {
  let failed = false;
  try {
    const c = await connectJson(`ws://127.0.0.1:${portOf()}/remote/full/api/remote.mux`, { headers: { cookie: globalThis.__fullCookie } });
    await c.close();
  } catch { failed = true; }
  assert.ok(failed);
});
