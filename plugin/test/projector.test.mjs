// projector.mjs 单元测试：node --test test/projector.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectEvent, projectHistory, findAttachmentRef, textOf, attsOf, truncate, toSess } from '../lib/projector.mjs';

const journal = [
  { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '帮我看看 a.ts' }] } },
  { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' } },
  { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }] } } },
  { seq: 4, type: 'request/header', data: { model: 'x' } },
  { seq: 5, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '分析如下：**OK**' }] } } },
  { seq: 6, type: 'user/message', data: { content: [{ type: 'text', text: '带图' }, { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 1234, width: 100, height: 50, name: 'shot.png' } }] } },
];

test('projectHistory：过滤噪声事件、合并 tool-result、投影附件', () => {
  const msgs = projectHistory(journal, 0);
  assert.equal(msgs.length, 4);   // user / tool(合并 tool-result) / assistant / user(带图)
  assert.equal(msgs[0].k, 'user');
  assert.equal(msgs[0].text, '帮我看看 a.ts');
  assert.equal(msgs[1].k, 'tool');
  assert.equal(msgs[1].tool, 'read_file');
  assert.equal(msgs[1].ok, true);
  assert.equal(msgs[1].out, '文件内容');
  assert.equal(msgs[2].k, 'assistant');
  assert.equal(msgs[2].text, '分析如下：**OK**');
  assert.equal(msgs[3].k, 'user');
  assert.match(msgs[3].text, /\[图片 ×1\]/);
  assert.equal(msgs[3].atts?.[0]?.id, 'sha256:abc');
  assert.equal(msgs[3].atts?.[0]?.w, 100);
});

test('projectHistory：tail 截取末尾 N 条', () => {
  const msgs = projectHistory(journal, 2);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].k, 'assistant');
});

test('projectEvent：live 单事件投影', () => {
  assert.equal(projectEvent({ seq: 9, type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }, 9).length, 1);
  const tr = projectEvent({ seq: 10, type: 'tool/result', data: { turn: 2, step: 1, message: { toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'boom' }] }, error: { name: 'E', code: 'X' } } }, 10);
  assert.equal(tr[0].k, 'tool-result');
  assert.equal(tr[0].ok, false);
  assert.equal(tr[0].out, 'boom');
  assert.equal(projectEvent({ seq: 11, type: 'request/header', data: {} }, 11).length, 0);
});

test('textOf / attsOf / truncate / toSess', () => {
  const content = [
    { type: 'text', text: 'a' },
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'b' },
    { type: 'file', attachment: { attachmentId: 'sha256:f1', name: 'x.pdf', bytes: 9 } },
  ];
  assert.equal(textOf(content), 'a\nb');
  assert.equal(attsOf(content)[0].name, 'x.pdf');
  assert.equal(truncate('x'.repeat(5000), 100).endsWith('…[截断]'), true);
  assert.equal(toSess({ header: { id: 's9', updatedAt: 42 } }, '标题').id, 's9');
  assert.equal(toSess({ header: { id: 's9', updatedAt: 42 } }, '标题').title, '标题');
});

test('findAttachmentRef：从日志定位图片/文件引用', () => {
  const hit = findAttachmentRef(journal, 'sha256:abc');
  assert.equal(hit.kind, 'image');
  assert.equal(hit.ref.width, 100);
  assert.equal(findAttachmentRef(journal, 'sha256:none'), null);
});
