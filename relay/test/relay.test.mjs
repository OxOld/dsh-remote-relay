// relay.mjs 测试：node --test test/relay.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { startRelay, computeQrFields, PROTO } from '../relay.mjs';
import { connectJson } from '../../plugin/lib/ws.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rr-test-'));
const publicDir = path.join(tmp, 'public');
fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>t</title>ok');
fs.mkdirSync(path.join(publicDir, 'vendor'), { recursive: true });
fs.writeFileSync(path.join(publicDir, 'vendor', 'lib-1.0.0.min.js'), '// vendored');

let relay;
const portOf = () => relay.port;
const wsUrl = () => `ws://127.0.0.1:${portOf()}/remote/ws`;
const SID = 'test-device-01';
const PASSWORD = 'a'.repeat(32);
const hashOf = (pw) => crypto.createHash('sha256').update(String(pw), 'utf8').digest('base64url');
const proofOf = (hash, nonce, role, sid) =>
  crypto.createHmac('sha256', Buffer.from(hash, 'utf8')).update(`${nonce}|${role}|${sid}`).digest('base64url');

/** 走完 hello→challenge→proof→ready，返回 connectJson 句柄 */
async function authed(role, { sid = SID, password = PASSWORD, hash, name = '测试机' } = {}) {
  const c = await connectJson(wsUrl());
  await c.send({ type: 'hello', proto: PROTO, role, sid, name, hash: hash ?? hashOf(password) });
  const challenge = await c.recv();
  assert.equal(challenge.type, 'challenge');
  assert.ok(challenge.nonce);
  await c.send({ type: 'proof', proof: proofOf(hash ?? hashOf(password), challenge.nonce, role, sid) });
  const ready = await c.recv();
  assert.equal(ready.type, 'ready');
  if (role === 'terminal') {
    const tok = await c.nextData();          // ready 后紧跟 term-token（完整模式凭据），排空
    assert.equal(tok.payload.type, 'term-token');
  }
  return { c, ready };
}

before(async () => {
  relay = await startRelay({ port: 0, publicDir, dataDir: path.join(tmp, 'data') });
});

after(async () => {
  console.error('[test] after: closing relay...');
  await relay.close();
  console.error('[test] after: relay closed');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('proof 已知答案向量（防公式漂移）', () => {
  const nonce = 'AAAAAAAAAAAAAAAAAAAAAA';
  const h = hashOf('secret-password');
  assert.equal(h, crypto.createHash('sha256').update('secret-password', 'utf8').digest('base64url'));
  const p = proofOf(h, nonce, 'device', 'sid-12345678');
  assert.equal(p,
    crypto.createHmac('sha256', Buffer.from(h, 'utf8')).update(`${nonce}|device|sid-12345678`).digest('base64url'));
});

test('computeQrFields 生成的 URL 与 hash 一致', () => {
  const f = computeQrFields(PASSWORD, SID, '我的手机', 'https://example.com');
  assert.equal(f.hash, hashOf(PASSWORD));
  assert.ok(f.url.startsWith(`https://example.com/remote/#/pair?sid=${SID}&hash=${encodeURIComponent(f.hash)}`));
  assert.ok(f.url.includes('name=' + encodeURIComponent('我的手机')));
});

test('静态托管：index/healthz/vendor 缓存头/404/路径穿越', async () => {
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: portOf(), path: p }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
  const idx = await get('/remote/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers['cache-control'], /no-cache/);
  const health = await get('/healthz');
  assert.equal(health.status, 200);
  const vendor = await get('/remote/vendor/lib-1.0.0.min.js');
  assert.match(vendor.headers['cache-control'], /immutable/);
  assert.equal((await get('/remote/nope.js')).status, 404);
  // node 的 http client 会先归一化路径；服务端的穿越防护直接兜底为 403/404 都算挡住
  assert.ok([403, 404].includes((await get('/remote/../relay.mjs')).status));
  assert.equal((await get('/nope')).status, 404);
});

test('设备注册 → ready(peer:0)，终端配对 → 双端 matched', async () => {
  const d = await authed('device');
  assert.equal(d.ready.role, 'device');
  assert.equal(d.ready.peer, 0);
  const t = await authed('terminal');
  assert.equal(t.ready.role, 'terminal');
  assert.equal(t.ready.peer, 1);
  assert.deepEqual(t.ready.device, { name: '测试机' });
  const dPair = await d.c.recv();
  const tPair = await t.c.recv();
  assert.equal(dPair.type, 'pair'); assert.equal(dPair.status, 'matched');
  assert.equal(tPair.type, 'pair'); assert.equal(tPair.status, 'matched');
  await t.c.close();
  const dPair2 = await d.c.recv();
  assert.equal(dPair2.status, 'waiting');
  await d.c.close();
});

test('桥接：device↔terminal data 转发（payload 原样、带 ts）', async () => {
  const d = await authed('device');
  const t = await authed('terminal');
  await Promise.all([d.c.recv(), t.c.recv()]);   // 两边 matched
  await d.c.send({ type: 'data', payload: { c: 'bootstrap', sessions: [{ id: 's1', title: 'T', updatedAt: 1, status: 'idle' }] } });
  const got = await t.c.nextData();
  assert.equal(got.payload.c, 'bootstrap');
  assert.equal(got.payload.sessions[0].id, 's1');
  assert.ok(got.ts > 0);
  await t.c.send({ type: 'data', payload: { c: 'send', sessionId: 's1', msgId: 'm1', text: '你好' } });
  const got2 = await d.c.nextData();
  assert.equal(got2.payload.c, 'send');
  assert.equal(got2.payload.text, '你好');
  await t.c.close(); await d.c.close();
});

test('错误 proof → close 4002', async () => {
  const c = await connectJson(wsUrl());
  await c.send({ type: 'hello', proto: PROTO, role: 'terminal', sid: SID });
  const ch = await c.recv();
  let closeCode = null;
  c.ws.onclose = (code) => { closeCode = code; };
  await c.send({ type: 'proof', proof: 'wrong-proof' });
  for (let i = 0; i < 50 && closeCode === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(closeCode, 4002);
});

test('terminal 用未注册 sid → close 4004', async () => {
  const c = await connectJson(wsUrl());
  let closeCode = null;
  c.ws.onclose = (code) => { closeCode = code; };
  await c.send({ type: 'hello', proto: PROTO, role: 'terminal', sid: 'no-such-sid-x' });
  for (let i = 0; i < 50 && closeCode === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(closeCode, 4004);
  c.close(1000);
});

test('proto 不匹配 → close 4001 且带 expect', async () => {
  const c = await connectJson(wsUrl());
  let closeCode = null, errMsg = null;
  c.ws.onclose = (code) => { closeCode = code; };
  await c.send({ type: 'hello', proto: 999, role: 'device', sid: SID, hash: hashOf(PASSWORD) });
  const err = await c.recv();
  errMsg = err;
  for (let i = 0; i < 50 && closeCode === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(errMsg.type, 'error');
  assert.equal(errMsg.expect, PROTO);
  assert.equal(closeCode, 4001);
  c.close(1000);
});

test('第二个终端顶替第一个（旧连接 4009 replaced，新连接生效）', async () => {
  const d = await authed('device');
  const t1 = await authed('terminal');
  await d.c.recv();
  let t1Code = null;
  t1.c.ws.onclose = (code) => { t1Code = code; };   // 必须在 t2 连接前挂上（服务端立即顶替）
  const t2 = await authed('terminal');
  await d.c.recv();   // matched（新终端触发）
  for (let i = 0; i < 50 && t1Code === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(t1Code, 4009);
  // 新终端仍能收发
  await d.c.send({ type: 'data', payload: { c: 'ping' } });
  const got = await t2.c.nextData();
  assert.equal(got.payload.c, 'ping');
  await t2.c.close(); await d.c.close();
});

test('device 掉线 → terminal 收 close 4010 device-disconnected', async () => {
  const d = await authed('device');
  const t = await authed('terminal');
  await d.c.recv(); await t.c.recv();
  let tCode = null, tReason = '';
  t.c.ws.onclose = (code, reason) => { tCode = code; tReason = reason; };
  await d.c.close();
  for (let i = 0; i < 60 && tCode === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(tCode, 4010);
  assert.equal(tReason, 'device-disconnected');
});

test('设备密码轮换：用旧 hash 证明后可更新为新 hash', async () => {
  const oldHash = hashOf('old-password-old-password-old');
  const d1 = await authed('device', { sid: 'rotate-device-01', password: 'x', hash: oldHash });
  await d1.c.close();
  const newHash = hashOf('new-password-new-password-new');
  // 用旧 hash 计算 proof，hello 带新 hash
  const c = await connectJson(wsUrl());
  await c.send({ type: 'hello', proto: PROTO, role: 'device', sid: 'rotate-device-01', hash: newHash, name: 'r' });
  const ch = await c.recv();
  await c.send({ type: 'proof', proof: proofOf(oldHash, ch.nonce, 'device', 'rotate-device-01') });
  const ready = await c.recv();
  assert.equal(ready.type, 'ready');
  await c.close();
  // 新 hash 现在可用，旧 hash 失效
  const t = await authed('terminal', { sid: 'rotate-device-01', password: 'y', hash: newHash });
  await t.c.close();
  const bad = await connectJson(wsUrl());
  await bad.send({ type: 'hello', proto: PROTO, role: 'terminal', sid: 'rotate-device-01' });
  const ch2 = await bad.recv();
  let code = null;
  bad.ws.onclose = (cc) => { code = cc; };
  await bad.send({ type: 'proof', proof: proofOf(oldHash, ch2.nonce, 'terminal', 'rotate-device-01') });
  for (let i = 0; i < 50 && code === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(code, 4002);
});

test('服务端能处理客户端分片帧（fragmented text）', async () => {
  const d = await authed('device');
  const t = await authed('terminal');
  await d.c.recv(); await t.c.recv();
  // 手工从 device 连接发一条分片的 data 消息（两个 text 分片）
  const payload = JSON.stringify({ type: 'data', payload: { c: 'frag', text: 'hello-fragmented-world' } });
  const raw = Buffer.from(payload, 'utf8');
  const part1 = raw.subarray(0, 10), part2 = raw.subarray(10);
  const mk = (opcode, fin, data) => {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    const head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | data.length]);
    return Buffer.concat([head, mask, masked]);
  };
  d.c.ws.socket.write(Buffer.concat([mk(0x1, false, part1), mk(0x0, true, part2)]));
  const got = await t.c.nextData();
  assert.equal(got.payload.text, 'hello-fragmented-world');
  await t.c.close(); await d.c.close();
});

test('心跳：ping → 客户端自动回 pong（连接保活不判死）', async () => {
  const d = await authed('device');
  // relay 的 heartbeat 每 10s ping 一次；这里等 11s 确认连接仍活着（alive 未被判死）
  await new Promise((r) => setTimeout(r, 11000));
  assert.equal(d.c.ws.alive, true);
  await d.c.close();
});

test('限速：同 IP 连续 10 次 proof 失败后 4003 冷却（放最后，避免污染其它用例）', async () => {
  relay.guard.reset();
  await authed('device', { sid: 'rate-device-01' });
  for (let i = 0; i < 10; i++) {
    const c = await connectJson(wsUrl());
    await c.send({ type: 'hello', proto: PROTO, role: 'terminal', sid: 'rate-device-01' });
    await c.recv();
    let code = null;
    c.ws.onclose = (cc) => { code = cc; };
    await c.send({ type: 'proof', proof: 'nope-' + i });
    for (let j = 0; j < 40 && code === null; j++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(code, 4002, `第 ${i + 1} 次应为 4002`);
  }
  const blocked = await connectJson(wsUrl());
  let blockedCode = null;
  blocked.ws.onclose = (cc) => { blockedCode = cc; };
  await blocked.send({ type: 'hello', proto: PROTO, role: 'terminal', sid: 'rate-device-01' });
  for (let i = 0; i < 40 && blockedCode === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(blockedCode, 4003);
});

test('注册口令：新设备无 token 被拒（4001 reg-token-required），带 token 注册成功；已注册 sid 重连免 token', async () => {
  const { startRelay } = await import('../relay.mjs');
  const fs2 = await import('node:fs');
  const os2 = await import('node:os');
  const path2 = await import('node:path');
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'dsh-rr-token-'));
  fs2.mkdirSync(path2.join(dir, 'public'), { recursive: true });
  const r2 = await startRelay({ port: 0, publicDir: path2.join(dir, 'public'), dataDir: path2.join(dir, 'data'), regToken: 'secret-token-123' });
  const url2 = `ws://127.0.0.1:${r2.port}/remote/ws`;
  const sid2 = 'token-device-01';
  const pw = 'p'.repeat(32);
  const h = crypto.createHash('sha256').update(pw, 'utf8').digest('base64url');
  // 无 token 注册 → 4001 reg-token-required
  const c1 = await connectJson(url2);
  let cc = null; c1.ws.onclose = (x) => { cc = x; };   // error+close 同批到达，必须先挂 onclose
  await c1.send({ type: 'hello', proto: PROTO, role: 'device', sid: sid2, name: 'x', hash: h });
  const err = await c1.recv();
  assert.equal(err.type, 'error');
  assert.equal(err.code, 'reg-token-required');
  for (let i = 0; i < 40 && cc === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(cc, 4001);
  // 错 token → 同样拒绝
  const c2 = await connectJson(url2);
  await c2.send({ type: 'hello', proto: PROTO, role: 'device', sid: sid2, name: 'x', hash: h, regToken: 'wrong' });
  const err2 = await c2.recv();
  assert.equal(err2.code, 'reg-token-required');
  c2.close(1000);
  // 正确 token → 注册成功
  const c3 = await connectJson(url2);
  await c3.send({ type: 'hello', proto: PROTO, role: 'device', sid: sid2, name: 'x', hash: h, regToken: 'secret-token-123' });
  const ch3 = await c3.recv();
  assert.equal(ch3.type, 'challenge');
  await c3.send({ type: 'proof', proof: proofOf(h, ch3.nonce, 'device', sid2) });
  const ready3 = await c3.recv();
  assert.equal(ready3.type, 'ready');
  c3.close(1000);
  // 已注册 sid 重连不需要 token
  const c4 = await connectJson(url2);
  await c4.send({ type: 'hello', proto: PROTO, role: 'device', sid: sid2, name: 'x', hash: h });
  const ch4 = await c4.recv();
  assert.equal(ch4.type, 'challenge');
  c4.close(1000);
  await r2.close();
  try { fs2.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
