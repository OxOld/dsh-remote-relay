// 真机终端联调：配对真实设备 → bootstrap → full-auth → 检查完整模式资产
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { connectJson } from '../lib/ws.mjs';

const cfg = JSON.parse(fs.readFileSync('C:/Users/Cotx/.dsh/tools/remote-relay.json', 'utf8'));
const RELAY = 'ws://10.0.0.5:8787/remote/ws';
const SID = cfg.sid, PASSWORD = cfg.password;
const hash = crypto.createHash('sha256').update(PASSWORD, 'utf8').digest('base64url');
const proofOf = (h, n, r, s) => crypto.createHmac('sha256', Buffer.from(h, 'utf8')).update(`${n}|${r}|${s}`).digest('base64url');

const c = await connectJson(RELAY);
await c.send({ type: 'hello', proto: 1, role: 'terminal', sid: SID, name: '真机联调终端' });
const ch = await c.recv();
await c.send({ type: 'proof', proof: proofOf(hash, ch.nonce, 'terminal', SID) });
const ready = await c.recv();
console.log('ready:', JSON.stringify({ role: ready.role, peer: ready.peer }));
const tok = (await c.nextData()).payload;
console.log('term-token:', tok.type === 'term-token' ? 'ok' : JSON.stringify(tok).slice(0, 100));

// full-auth 换 cookie
const cookie = await new Promise((resolve, reject) => {
  const r = http.request({ host: '10.0.0.5', port: 8787, path: '/remote/full-auth', method: 'POST', headers: { authorization: 'Bearer ' + tok.token } }, (rs) => {
    rs.resume(); rs.on('end', () => resolve({ status: rs.statusCode, cookie: (rs.headers['set-cookie'] || [''])[0].split(';')[0] }));
  });
  r.on('error', reject); r.end();
});
console.log('full-auth:', cookie.status, cookie.cookie.slice(0, 14) + '...');

// bootstrap：真实会话
await c.send({ type: 'data', payload: { c: 'bootstrap-request' } });
let boot = (await c.nextData(20000)).payload;
if (boot.c === 'hello') boot = (await c.nextData(20000)).payload;   // 排空设备 hello
if (boot.c === 'bootstrap') {
  console.log('bootstrap ok: sessions =', boot.sessions.length);
  for (const s of boot.sessions.slice(0, 5)) console.log('  -', s.id, '|', s.title, '|', s.status);
} else {
  console.log('bootstrap →', JSON.stringify(boot).slice(0, 300));
}

// 完整模式资产检查
const probe = (p) => new Promise((resolve) => {
  http.get({ host: '10.0.0.5', port: 8787, path: p, headers: { cookie: cookie.cookie } }, (rs) => {
    const chunks = [];
    rs.on('data', (x) => chunks.push(x));
    rs.on('end', () => resolve({ status: rs.statusCode, len: Buffer.concat(chunks).length, body: Buffer.concat(chunks).toString('utf8').slice(0, 200) }));
  }).on('error', (e) => resolve({ status: 'ERR', body: e.message }));
});
const idx = await probe('/remote/full/');
console.log('/remote/full/ →', idx.status, idx.len, 'bytes');
console.log('=== FULL BODY ===');
console.log(idx.body);
console.log('=== END ===');
c.close();
process.exit(0);
