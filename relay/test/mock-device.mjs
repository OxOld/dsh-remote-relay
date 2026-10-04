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
  if (msg.type === 'ready') console.log('device ready, peer:', msg.peer);
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

await ws.connect();
const origin = RELAY.replace(/^ws/, 'http').replace(/\/remote\/ws$/, '');
console.log('配对 URL:', `${origin}/remote/#/pair?sid=${SID}&hash=${encodeURIComponent(hash)}&name=${encodeURIComponent('演示机')}`);
setInterval(() => ws.ping(), 5000);
