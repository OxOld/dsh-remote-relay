// ─────────────────────────────────────────────────────────────────────────────
// 会话事件 → 远程紧凑消息（Msg）投影器。纯函数、零依赖，独立测试。
// 事件类型依据 deepseek-harness packages/core/session/src/types.ts 的 SessionEventMap。
// Msg 结构见 docs/PROTOCOL.md §2.3。
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_OUT_CAP = 4096;    // 工具输出投影上限
const TEXT_CAP = 256 * 1024;  // 消息文本上限

export function truncate(s, cap) {
  if (s == null) return '';
  s = String(s);
  return s.length > cap ? s.slice(0, cap) + '…[截断]' : s;
}

/** TextBlock 拼接（跳过 reasoning/tool-call/image/file 块） */
export function textOf(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') {
      out += (out && !out.endsWith('\n') ? '\n' : '') + b.text;
    }
  }
  return out;
}

/** image/file 块 → 附件引用（供手机端按需拉取） */
export function attsOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || !b.attachment) continue;
    if (b.type === 'image') {
      const a = b.attachment;
      out.push({ id: a.attachmentId, name: a.name || 'image', mime: a.mediaType || 'image/png', bytes: a.bytes, w: a.width, h: a.height });
    } else if (b.type === 'file') {
      const a = b.attachment;
      out.push({ id: a.attachmentId, name: a.name || 'file', mime: 'application/octet-stream', bytes: a.bytes });
    }
  }
  return out;
}

function userText(content) {
  let text = textOf(content);
  if (!Array.isArray(content)) return text;
  const imgs = content.filter((b) => b && b.type === 'image').length;
  const files = content.filter((b) => b && b.type === 'file').length;
  if (imgs) text += (text ? '\n' : '') + `[图片 ×${imgs}]`;
  if (files) text += (text ? '\n' : '') + `[文件 ×${files}]`;
  return truncate(text, TEXT_CAP);
}

/**
 * 单条会话事件 → 0..n 条 Msg。
 * 返回数组（tool/result 通常不产出新消息，而是由消费方按 callId 合并）。
 */
export function projectEvent(e, seq) {
  const t = e?.type;
  const d = e?.data || {};
  const out = [];
  if (t === 'user/message') {
    out.push({ seq, k: 'user', text: userText(d.content), atts: attsOf(d.content), t: e.ts });
  } else if (t === 'assistant/message') {
    const text = truncate(textOf(d.message?.content), TEXT_CAP);
    if (text) out.push({ seq, k: 'assistant', text, turn: d.turn, interrupted: d.interrupted === true || undefined });
  } else if (t === 'tool/call') {
    out.push({ seq, k: 'tool', tool: d.name, args: truncate(d.arguments, 64 * 1024), callId: d.callId, turn: d.turn });
  } else if (t === 'tool/result') {
    out.push({ seq, k: 'tool-result', callId: d.message?.toolCallId, ok: !(d.message?.isError || d.error), out: truncate(textOf(d.message?.content), TEXT_OUT_CAP), turn: d.turn });
  }
  return out;
}

/**
 * 全量事件日志 → Msg[]（tool-result 就地合并进对应 tool 调用）。
 * @param {Array<{type,data,seq?,ts?}>} events 会话事件（agent.session.events 或 sessionQuery.readSession）
 * @param {number} tail 只保留末尾 N 条
 */
export function projectHistory(events, tail = 200) {
  const msgs = [];
  let auto = 0;
  for (const e of events || []) {
    const seq = Number.isInteger(e?.seq) ? e.seq : ++auto;
    for (const m of projectEvent(e, seq)) {
      if (m.k === 'tool-result') {
        let merged = false;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].k === 'tool' && msgs[i].callId === m.callId) {
            msgs[i].ok = m.ok;
            msgs[i].out = m.out;
            merged = true;
            break;
          }
        }
        if (!merged) msgs.push({ seq: m.seq, k: 'tool', tool: 'tool', callId: m.callId, ok: m.ok, out: m.out });
      } else {
        msgs.push(m);
      }
    }
  }
  return tail > 0 && msgs.length > tail ? msgs.slice(-tail) : msgs;
}

/** 从事件日志中找某附件 id 的引用（用于 fetch-att 鉴权与取 ref） */
export function findAttachmentRef(events, attachmentId) {
  for (const e of events || []) {
    const content = e?.data?.content ?? e?.data?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const a = b?.attachment;
      if (a && a.attachmentId === attachmentId) {
        if (b.type === 'image') return { kind: 'image', ref: a };
        if (b.type === 'file') return { kind: 'file', ref: a };
      }
    }
  }
  return null;
}

/** 会话列表记录 → Sess（防御式取字段，兼容不同版本） */
export function toSess(r, title) {
  const h = r?.header || r || {};
  return {
    id: h.id,
    title: title || h.title || '',
    updatedAt: h.updatedAt ?? h.lastEventAt ?? h.modifiedAt ?? 0,
    status: 'idle',
    cwd: h.cwd || undefined,
  };
}
