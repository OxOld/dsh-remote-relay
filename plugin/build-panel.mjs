// 组装 panel.mjs：QR 生成器（qr-runtime.txt）+ 面板主体（panel-body.js）
// 修改面板请编辑 panel-body.js 后运行：node build-panel.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const qrBody = fs.readFileSync(path.join(dir, "qr-runtime.txt"), 'utf8').replace(/\n?`;\s*$/, '');
const panelBody = fs.readFileSync(path.join(dir, 'panel-body.js'), 'utf8');

const prelude = [
  '(function () {',
  "'use strict';",
  'if (window.__rrBooted) return;   // 双通道注入可能同时到位，只跑一次',
  'window.__rrBooted = true;',
].join('\n');

const out = `// ─────────────────────────────────────────────────────────────────────────────
// dsh 面板注入脚本（自动组装，勿手改）：QR 生成器移植自 dsh-web-remote-frp（Nayuki 算法）
// 源文件：qr-runtime.txt + panel-body.js；组装：node build-panel.mjs
// ─────────────────────────────────────────────────────────────────────────────
export const INJECT_SCRIPT = ${JSON.stringify(prelude + '\n' + qrBody + '\n' + panelBody + '\n})();')};
`;

fs.writeFileSync(path.join(dir, 'lib', 'panel.mjs'), out);
console.log('[build-panel] panel.mjs written,', out.length, 'bytes');
