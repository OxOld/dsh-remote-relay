// 演示：攻击者知道中继地址，但没有二维码里的凭据
import { connectJson } from '../../plugin/lib/ws.mjs';
const url = 'ws://127.0.0.1:8787/remote/ws';
const waitClose = (c) => new Promise((r) => { const t = setTimeout(() => r(null), 3000); c.ws.onclose = (x) => { clearTimeout(t); r(x); }; });

// 场景1：知道地址，直接连上发 hello（sid 真实，但 proof 瞎编）
let c = await connectJson(url);
await c.send({ type: 'hello', proto: 1, role: 'terminal', sid: 'demo-device-0001' });
const ch = await c.recv();
console.log('① 服务器要求挑战证明:', JSON.stringify(ch).slice(0, 60));
let code = await waitClose(c);
await c.send({ type: 'proof', proof: '我瞎猜的proof' });
code = await waitClose(c);
console.log('① 结果: 连接被关闭, code =', code, '(4002 = 认证失败)');

// 场景2：连 sid 都瞎猜
c = await connectJson(url);
await c.send({ type: 'hello', proto: 1, role: 'terminal', sid: 'guessed-sid-999' });
console.log('② 瞎猜 sid: code =', await waitClose(c), '(4004 = sid 不存在)');

// 场景3：暴力穷举 10 次后，同 IP 直接进冷却
for (let i = 0; i < 10; i++) {
  const cc = await connectJson(url);
  const cd = waitClose(cc);
  await cc.send({ type: 'hello', proto: 1, role: 'terminal', sid: 'demo-device-0001' });
  await cc.recv().catch(() => {});
  await cc.send({ type: 'proof', proof: 'brute-' + i });
  await cd;
}
const blocked = await connectJson(url);
await blocked.send({ type: 'hello', proto: 1, role: 'terminal', sid: 'demo-device-0001' });
console.log('③ 暴力 10 次后再连: code =', await waitClose(blocked), '(4003 = IP 冷却 60 秒)');
process.exit(0);
