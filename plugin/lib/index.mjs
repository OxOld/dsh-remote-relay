// ─────────────────────────────────────────────────────────────────────────────
// dsh-remote-relay · cordis 插件主体
//
// 职责：出站 WSS 连接中继（device 角色）；进程内直读 dsh 服务
// （sessionQuery / agents / approval 瀑布 / attachments），把会话数据以紧凑
// 协议推给手机终端（协议见 docs/PROTOCOL.md）。
//
// 对接的 dsh 内部 API（均已在 deepseek-harness 源码验证）：
//   ctx.on('session/event') / ('agent/assistant-stream') / ('agent/status')
//   ctx.on('approval/request')（waterfall：返回值即批准结果，next() 委托桌面）
//   ctx.get('sessionQuery'/'agents'/'workspaceRegistry')
//   ctx.get('attachments').readImage()/readFileStream()
//   ctx.inject(['webServer']) → register/tapIndex/port
//   ctx.inject(['connection']) → authenticatedUrl/authorizeIndex（cookie 铸造）
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WsClient } from './ws.mjs';
import { INJECT_SCRIPT } from './panel.mjs';
import { projectEvent, projectHistory, findAttachmentRef, toSess, truncate } from './projector.mjs';
import { createFullBridge } from './fullbridge.mjs';

export const name = 'remote-relay';
export const inject = ['timer'];

const PROTO = 1;
const VERSION = '0.1.0';
const CALLID_ARGS_CAP = 512;
const CHUNK_B64 = 256 * 1024;   // att-chunk 二进制分块（base64 前）

const log = (...a) => console.log(new Date().toISOString(), '[remote-relay]', ...a);

export function apply(ctx, rawConfig) {
  const cfg = rawConfig ?? {};

  // ── 面板注入：桌面端唯一生效通道，必须在 apply 同步注册（宿主启动时收集一次）──
  try {
    ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return;
      for (const row of table) {
        if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf('__rrBooted') !== -1) return;
      }
      table.push({ kind: 'script', placement: 'body', text: INJECT_SCRIPT });
    });
  } catch { /* 旧版 dsh 无该事件：web 形态由 tapIndex 兜底 */ }

  // ── 配置：YAML config 为初始值，tools/remote-relay.json（面板保存值）优先 ──
  const homeDir = process.env.DSH_HOME ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh');
  const toolsDir = cfg.toolsDir || path.join(homeDir, 'tools');
  try { fs.mkdirSync(toolsDir, { recursive: true }); } catch { /* ignore */ }
  const cfgFilePath = path.join(toolsDir, 'remote-relay.json');

  const config = {
    relayUrl: cfg.relayUrl ?? '',
    password: cfg.password ?? '',
    sid: cfg.sid ?? '',
    deviceName: cfg.deviceName ?? '我的 dsh',
    autoConnect: cfg.autoConnect ?? true,
    approveFromPhone: cfg.approveFromPhone ?? true,
    approvalTimeoutMs: cfg.approvalTimeoutMs ?? 120000,
    regToken: cfg.regToken ?? '',   // 中继的设备注册口令（服务器设置 RELAY_REG_TOKEN 时必填）
    syncFullUi: cfg.syncFullUi ?? true,   // 完整模式：把官方 UI 资产推送到 relay 托管
  };
  try {
    if (fs.existsSync(cfgFilePath)) {
      const saved = JSON.parse(fs.readFileSync(cfgFilePath, 'utf8'));
      if (saved && typeof saved === 'object') Object.assign(config, saved);
    }
  } catch (e) { log('config load failed:', e.message); }
  const saveFileCfg = () => {
    try { fs.writeFileSync(cfgFilePath, JSON.stringify(config, null, 2)); } catch (e) { log('config save failed:', e.message); }
  };
  if (!config.password || typeof config.password !== 'string') config.password = crypto.randomBytes(24).toString('base64url');
  if (!config.sid || typeof config.sid !== 'string') config.sid = 'dsh-' + crypto.randomBytes(9).toString('hex');
  saveFileCfg();

  const sha256b64 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('base64url');
  const calcProof = (hash, nonce, role, sid) =>
    crypto.createHmac('sha256', Buffer.from(String(hash), 'utf8')).update(`${nonce}|${role}|${sid}`).digest('base64url');

  // ── 运行态 ──────────────────────────────────────────────────────────────
  let ws = null;
  let wsOpen = false;
  let wantConnect = false;
  let terminalOnline = false;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let lastError = '';
  let focus = null;                 // 手机当前打开的会话
  let liveSeq = 0;
  const statusMap = new Map();      // sessionId -> 'running'|'idle'
  const sessionsCache = new Map();  // bootstrap 后的列表缓存（id -> Sess）
  const argsByCallId = new Map();   // callId -> arguments（权限卡显示参数用）
  const pendingApprovals = new Map(); // requestId -> {resolve}

  const sendData = (payload) => {
    if (!wsOpen || !ws) return;
    try { ws.sendText(JSON.stringify({ type: 'data', payload })); } catch (e) { log('send failed:', e.message); }
  };

  // ── dsh 服务获取（ctx 与 hostCtx 双通道，兼容不同挂载位置）────────────────
  const svcCache = new Map();
  const svc = (name) => {
    if (svcCache.has(name)) return svcCache.get(name);
    let s = null;
    try { s = ctx.get(name) ?? null; } catch { /* ignore */ }
    svcCache.set(name, s);
    return s;
  };

  // ── cookie 铸造 + 本地 RPC（session.cancel 用；移植自 dsh-web-remote-frp）──
  let connectionService = null;
  let resolvedTargetPort = 3080;
  try {
    ctx.inject(['connection'], (connCtx) => { connectionService = connCtx.connection; });
  } catch { /* 旧版无 connection 服务 */ }

  let sessionCookie = null;
  let sessionMint = null;
  const mintSessionCookie = () => {
    const connection = connectionService;
    if (!connection || typeof connection.authenticatedUrl !== 'function' || typeof connection.authorizeIndex !== 'function') return null;
    const authority = '127.0.0.1:' + resolvedTargetPort;
    let token;
    try { token = new URL(connection.authenticatedUrl('http://' + authority + '/')).searchParams.get('token'); } catch { return null; }
    if (!token) return null;
    let setCookie = null;
    const stubRes = {
      writeHead(status, headers) {
        const sc = headers && (headers['set-cookie'] || headers['Set-Cookie']);
        if (sc) setCookie = Array.isArray(sc) ? sc[0] : sc;
      },
      end() {}, destroy() {}, setHeader() {}, removeHeader() {}, getHeader() { return undefined; },
    };
    const stubReq = { method: 'GET', url: '/?token=' + encodeURIComponent(token), headers: { host: authority } };
    try { connection.authorizeIndex(stubReq, stubRes); } catch { return null; }
    if (!setCookie) return null;
    return String(setCookie).split(';')[0].trim() || null;
  };
  const refreshSessionCookie = () => {
    if (sessionMint) return sessionMint;
    sessionMint = Promise.resolve().then(() => {
      const c = mintSessionCookie();
      if (c) sessionCookie = c;
      return c;
    }).finally(() => { sessionMint = null; });
    return sessionMint;
  };
  const callRpc = (method, payload) => {
    return refreshSessionCookie().catch(() => null).then(() => new Promise((resolve, reject) => {
      const body = JSON.stringify({ type: 'client-request', rpcId: 'rr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), method, payload });
      const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
      if (sessionCookie) headers.cookie = sessionCookie;
      const req = http.request({
        host: '127.0.0.1', port: resolvedTargetPort, path: '/api/' + method, method: 'POST', headers, timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('rpc timeout')));
      req.write(body);
      req.end();
    }));
  };

  // ── 完整模式桥（资产推送 + HTTP/WS 桥接）────────────────────────────────
  const fullBridge = createFullBridge({
    log,
    sendData,
    getPort: () => resolvedTargetPort,
    refreshSessionCookie,
    invalidateCookie: () => { sessionCookie = null; },
    fullUiEnabled: () => !!config.syncFullUi,
  });

  // ── 连接管理 ────────────────────────────────────────────────────────────
  const scheduleReconnect = () => {
    if (!wantConnect || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    reconnectTimer.unref?.();
  };

  const qrUrl = () => {
    if (!config.relayUrl) return '';
    try {
      const u = new URL(config.relayUrl);
      const origin = (u.protocol === 'wss:' ? 'https://' : 'http://') + u.host;
      return `${origin}/remote/#/pair?sid=${encodeURIComponent(config.sid)}&hash=${encodeURIComponent(sha256b64(config.password))}&name=${encodeURIComponent(config.deviceName)}`;
    } catch { return ''; }
  };

  const infoPayload = () => ({
    ok: true,
    configured: !!config.relayUrl,
    connected: wsOpen,
    terminal: terminalOnline,
    relayUrl: config.relayUrl || '',
    qrUrl: qrUrl(),
    sid: config.sid,
    deviceName: config.deviceName,
    autoConnect: !!config.autoConnect,
    approveFromPhone: !!config.approveFromPhone,
    approvalTimeoutMs: config.approvalTimeoutMs,
    regToken: config.regToken || '',
    syncFullUi: !!config.syncFullUi,
    error: lastError,
  });

  function disconnect() {
    wantConnect = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (ws) { const w = ws; ws = null; wsOpen = false; try { w.close(1000, 'bye'); } catch { /* ignore */ } }
  }

  function connect() {
    if (ws || !config.relayUrl) return;
    wantConnect = true;
    let client;
    try { client = new WsClient(config.relayUrl, { headers: { 'user-agent': 'dsh-remote-relay/' + VERSION } }); } catch (e) {
      lastError = e.message; scheduleReconnect(); return;
    }
    ws = client;
    wsOpen = false;
    log('connecting to', config.relayUrl);
    client.onopen = () => {
      wsOpen = true;
      reconnectDelay = 1000;
      lastError = '';
      client.sendText(JSON.stringify({
        type: 'hello', proto: PROTO, role: 'device', sid: config.sid, name: config.deviceName, hash: sha256b64(config.password),
        ...(config.regToken ? { regToken: config.regToken } : {}),
      }));
    };
    client.onmessage = (data, isText) => {
      if (!isText) return;
      let msg; try { msg = JSON.parse(data); } catch { return; }
      handleRelay(msg);
    };
    client.onclose = () => {
      const was = wsOpen;
      wsOpen = false;
      if (ws === client) ws = null;
      if (terminalOnline) { terminalOnline = false; }
      for (const p of pendingApprovals.values()) p.resolve(null);
      pendingApprovals.clear();
      fullBridge.abortAll();   // 中止桥接的本地请求/WS 与未完成的资产推送
      if (was) log('relay connection lost');
      scheduleReconnect();
    };
    client.connect().catch((e) => {
      lastError = e.message;
      log('connect failed:', e.message);
      try { client.close(1000, 'fail'); } catch { /* ignore */ }
      if (ws === client) { ws = null; wsOpen = false; }
      scheduleReconnect();
    });
  }

  function handleRelay(msg) {
    if (msg.type === 'challenge') {
      const proof = calcProof(sha256b64(config.password), msg.nonce, 'device', config.sid);
      try { ws?.sendText(JSON.stringify({ type: 'proof', proof })); } catch { /* ignore */ }
      return;
    }
    if (msg.type === 'ready') {
      log('relay ready, peer:', msg.peer);
      if (msg.peer === 1) setTerminalOnline(true);
      void fullBridge.syncFullAssets();   // 完整模式：比对指纹，变了才推送（协议 §3.5）
      return;
    }
    if (msg.type === 'pair') {
      setTerminalOnline(msg.status === 'matched');
      return;
    }
    if (msg.type === 'error') { lastError = msg.code || 'relay-error'; log('relay error:', msg.code, msg.expect ?? ''); return; }
    if (msg.type === 'data' && msg.payload) handleData(msg.payload);
  }

  function setTerminalOnline(on) {
    if (terminalOnline === on) return;
    terminalOnline = on;
    log('terminal ' + (on ? 'connected' : 'disconnected'));
    if (on) sendData({ c: 'hello', device: { name: config.deviceName, version: VERSION } });
  }

  // ── 终端命令 ────────────────────────────────────────────────────────────
  function handleData(p) {
    try {
      // 完整模式帧（asset 应答 / http 桥 / ws 桥）先于轻量命令路由
      if (p?.type) {
        if (p.type === 'full-info-state' || p.type === 'asset-ok' || p.type === 'asset-committed' ||
            (p.type === 'error' && String(p.code || '').startsWith('asset-'))) {
          fullBridge.handleSyncReply(p);
          return;
        }
        if (p.type === 'http-req' || p.type === 'http-ack' || p.type === 'http-cancel' ||
            p.type === 'ws-open' || p.type === 'ws-close' || p.type === 'ws-text' || p.type === 'ws-bin') {
          fullBridge.handleRelayFrame(p);
          return;
        }
      }
      switch (p?.c) {
        case 'bootstrap-request': void handleBootstrap(); break;
        case 'open': void handleOpen(p); break;
        case 'close': if (!p.sessionId || p.sessionId === focus) focus = null; break;
        case 'send': void handleSend(p); break;
        case 'cancel': void handleCancel(p); break;
        case 'approve': {
          const pend = pendingApprovals.get(p.requestId);
          if (pend) pend.resolve(p.outcome === 'allowed-once' ? 'allowed-once' : 'rejected');
          break;
        }
        case 'fetch-att': void handleFetchAtt(p); break;
        default: break;
      }
    } catch (e) {
      log('handleData failed:', e.message);
      sendData({ c: 'error', code: 'internal', message: e.message, ref: p?.c });
    }
  }

  async function handleBootstrap() {
    if (process.env.RR_DEBUG) log('bootstrap-request received');
    const sessionQuery = svc('sessionQuery');
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') {
      sendData({ c: 'error', code: 'no-session-query', message: 'sessionQuery 服务不可用' });
      return;
    }
    const records = await sessionQuery.listSessions();
    if (process.env.RR_DEBUG) log('listSessions →', Array.isArray(records) ? records.length : typeof records);
    // 与旧插件一致的过滤：归档 / 子代理 / 孤儿会话
    let archived = null;
    let known = null;
    try {
      const wsr = svc('workspaceRegistry');
      if (wsr) {
        if (wsr.archivedSessionIds) archived = new Set(wsr.archivedSessionIds);
        const workspaces = typeof wsr.list === 'function' ? wsr.list() : null;
        if (workspaces) {
          known = new Set();
          for (const w of workspaces) if (w.sessionIds) for (const sid of w.sessionIds) known.add(sid);
        }
      }
    } catch { /* ignore */ }
    if (process.env.RR_DEBUG) log('filters: archived=%s known=%s', archived?.size, known?.size);
    const sessions = [];
    for (const r of records || []) {
      const h = r?.header || {};
      if (archived && archived.has(h.id)) continue;
      if (h.origin === 'subagent' || (h.delegationDepth || 0) > 0) continue;
      if (known && !known.has(h.id)) continue;
      let title = '';
      try {
        const t = await sessionQuery.readTitle(h.id);
        title = t?.title || '';
      } catch { /* ignore */ }
      if (process.env.RR_DEBUG) log('session', h.id, 'title=', title);
      const sess = toSess(r, title);
      sess.status = statusMap.get(h.id) || 'idle';
      sessions.push(sess);
    }
    if (process.env.RR_DEBUG) log('sending bootstrap with', sessions.length, 'sessions');
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    sessionsCache.clear();
    for (const s of sessions) sessionsCache.set(s.id, s);
    sendData({ c: 'bootstrap', sessions: sessions.slice(0, 100), device: { name: config.deviceName, version: VERSION } });
    if (process.env.RR_DEBUG) log('bootstrap sent');
  }

  async function sessionEvents(sessionId) {
    const agents = svc('agents');
    let events = null;
    try {
      const agent = agents?.get?.(sessionId);
      events = agent?.session?.events ?? null;
    } catch { /* ignore */ }
    if (!events) {
      try {
        const snap = await svc('sessionQuery')?.readSession?.(sessionId);
        events = snap?.events ?? null;
      } catch { /* ignore */ }
    }
    return Array.isArray(events) ? events : [];
  }

  async function handleOpen(p) {
    focus = p.sessionId;
    const events = await sessionEvents(p.sessionId);
    const messages = projectHistory(events, Math.max(10, Math.min(p.tail || 200, 1000)));
    let title = sessionsCache.get(p.sessionId)?.title || '';
    if (!title) {
      try { title = (await svc('sessionQuery')?.readTitle?.(p.sessionId))?.title || ''; } catch { /* ignore */ }
    }
    sendData({
      c: 'snapshot', sessionId: p.sessionId, title, status: statusMap.get(p.sessionId) || 'idle',
      messages,
    });
  }

  async function ensureAgent(sessionId) {
    const agents = svc('agents');
    if (!agents) return null;
    let agent = null;
    try { agent = agents.get(sessionId); } catch { /* ignore */ }
    if (!agent) {
      try {
        const handle = await agents.resume({ resumeSessionId: sessionId });
        agent = (handle && handle.agent) ? handle.agent : handle;
      } catch (e) { log('resume failed:', e.message); }
    }
    return agent && typeof agent.send === 'function' ? agent : null;
  }

  async function handleSend(p) {
    if (!p.sessionId || typeof p.text !== 'string' || !p.text.trim()) return;
    const agent = await ensureAgent(p.sessionId);
    if (!agent) {
      sendData({ c: 'error', code: 'agent-unavailable', message: '无法激活该会话', ref: p.msgId });
      return;
    }
    agent.send(
      { id: p.msgId || 'rr-' + Date.now(), role: 'user', content: [{ type: 'text', text: p.text }], source: { kind: 'user' } },
      'next-turn', true,
    );
  }

  async function handleCancel(p) {
    try {
      const r = await callRpc('session.cancel', { sessionId: p.sessionId });
      if (r.status !== 200) sendData({ c: 'error', code: 'cancel-failed', message: 'HTTP ' + r.status });
    } catch (e) {
      sendData({ c: 'error', code: 'cancel-failed', message: e.message });
    }
  }

  async function handleFetchAtt(p) {
    const { fetchId, sessionId, attachmentId } = p;
    if (!fetchId || !attachmentId) return;
    try {
      const events = await sessionEvents(sessionId);
      const found = findAttachmentRef(events, attachmentId);
      if (!found) { sendData({ c: 'att-end', fetchId, sha8: '', error: '附件不存在或不在该会话中' }); return; }
      const attachments = svc('attachments');
      if (!attachments) { sendData({ c: 'att-end', fetchId, sha8: '', error: 'attachments 服务不可用' }); return; }
      if (found.kind === 'image') {
        const img = await attachments.readImage(found.ref);
        const bytes = img?.data ?? img?.bytes;
        if (!bytes) { sendData({ c: 'att-end', fetchId, sha8: '', error: '图片读取失败' }); return; }
        await sendBytes(fetchId, {
          kind: 'image', name: found.ref.name || 'image', mime: found.ref.mediaType || 'image/png',
          bytes: bytes.length, width: found.ref.width, height: found.ref.height,
        }, bytes);
      } else {
        const meta = { kind: 'file', name: found.ref.name || 'file', mime: 'application/octet-stream', bytes: found.ref.bytes };
        sendData({ c: 'att-meta', fetchId, ...meta });
        let hash = crypto.createHash('sha256');
        let sent = 0;
        for await (const chunk of attachments.readFileStream(found.ref)) {
          hash = hash.update(chunk);
          await sendChunk(fetchId, chunk);
          sent += chunk.length;
        }
        sendData({ c: 'att-end', fetchId, sha8: hash.digest('hex').slice(0, 8) });
        void sent;
      }
    } catch (e) {
      sendData({ c: 'att-end', fetchId, sha8: '', error: e.message });
    }
  }

  async function sendBytes(fetchId, meta, bytes) {
    sendData({ c: 'att-meta', fetchId, ...meta });
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    for (let off = 0; off < buf.length; off += CHUNK_B64) {
      await sendChunk(fetchId, buf.subarray(off, Math.min(buf.length, off + CHUNK_B64)));
    }
    sendData({ c: 'att-end', fetchId, sha8: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8) });
  }

  const sendChunk = (fetchId, chunk) => new Promise((resolve) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sendData({ c: 'att-chunk', fetchId, seq: 0, b64: buf.toString('base64') });
    resolve();
  });

  // ── dsh 事件订阅 ────────────────────────────────────────────────────────
  try {
    ctx.on('session/event', (session, event) => {
      try {
        const sid = session?.id ?? session?.sessionId;
        if (!sid || !event?.type) return;
        if (event.type === 'tool/call' && event.data?.callId) {
          argsByCallId.set(event.data.callId, String(event.data.arguments || ''));
          if (argsByCallId.size > CALLID_ARGS_CAP) {
            const k = argsByCallId.keys().next().value;
            argsByCallId.delete(k);
          }
        }
        if (sid !== focus) return;
        const seq = Number.isInteger(event.seq) ? event.seq : ++liveSeq;
        for (const m of projectEvent(event, seq)) {
          sendData({ c: 'message', sessionId: sid, msg: m });
        }
      } catch { /* 单事件失败不影响整体 */ }
    });
  } catch { /* 旧版无此事件 */ }

  try {
    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const sid = payload?.agent?.session?.id;
        if (!sid || sid !== focus) return;
        const f = payload?.frame;
        if (!f) return;
        if (f.type === 'start') sendData({ c: 'delta', sessionId: sid, turn: f.turn, kind: 'start' });
        else if (f.type === 'chunk' && f.chunk?.type === 'text-delta') sendData({ c: 'delta', sessionId: sid, turn: f.turn, kind: 'chunk', text: String(f.chunk.text || '') });
        else if (f.type === 'end') sendData({ c: 'delta', sessionId: sid, turn: f.turn, kind: 'end' });
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }

  try {
    ctx.on('agent/status', (payload) => {
      try {
        const sid = payload?.agent?.session?.id;
        const st = payload?.status;
        if (!sid || (st !== 'running' && st !== 'idle')) return;
        statusMap.set(sid, st);
        const cached = sessionsCache.get(sid);
        if (cached) cached.status = st;
        sendData({ c: 'status', sessionId: sid, status: st });
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }

  // ── 权限批准瀑布：手机在线则征询手机；超时/离线一律 next() 委托桌面 ────────
  try {
    ctx.on('approval/request', async (req, next) => {
      if (!config.approveFromPhone || !terminalOnline || !wsOpen) return next();
      const requestId = 'apr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const sessionId = req?.agent?.session?.id;
      const args = req?.callId ? (argsByCallId.get(req.callId) ?? null) : null;
      sendData({
        c: 'approval', requestId, sessionId: sessionId || '', tool: req?.toolName || 'tool',
        callId: req?.callId, args, reason: req?.reason || req?.displayReason?.zh || req?.displayReason?.en || '',
      });
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingApprovals.delete(requestId);
          resolve(null);
        }, Math.max(5000, Number(config.approvalTimeoutMs) || 120000));
        timer.unref?.();
        pendingApprovals.set(requestId, { resolve: (o) => { clearTimeout(timer); pendingApprovals.delete(requestId); resolve(o); } });
      });
      if (outcome === 'allowed-once' || outcome === 'rejected') {
        sendData({ c: 'approval-done', requestId, outcome, by: 'phone' });
        return outcome;
      }
      sendData({ c: 'approval-done', requestId, outcome: null, by: 'timeout' });
      return next();
    });
  } catch { /* 旧版无 approval 事件 */ }

  // ── webServer：面板路由 + web 形态 tapIndex 兜底 ─────────────────────────
  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.webServer;
    try { resolvedTargetPort = webServer?.port ?? 3080; } catch { /* ignore */ }

    const json = (res, code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      webServer.register({
        kind: 'exact', path: '/remote-relay/info',
        handler: (req, res) => json(res, 200, infoPayload()),
      });
      webServer.register({
        kind: 'exact', path: '/remote-relay/config',
        handler: (req, res) => {
          if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
          if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return; }
          let body = '';
          let overflow = false;
          req.on('data', (c) => {
            body += c;
            if (body.length > 65536) { overflow = true; req.destroy(); }
          });
          req.on('end', () => {
            if (overflow) return;
            let patch;
            try { patch = JSON.parse(body || '{}'); } catch { json(res, 400, { ok: false, error: 'bad json' }); return; }
            const reconnectNeeded = applyConfigPatch(patch);
            saveFileCfg();
            json(res, 200, { ok: true, reconnectNeeded, ...infoPayload() });
            if (reconnectNeeded) { disconnect(); if (config.autoConnect && config.relayUrl) setTimeout(connect, 300); }
          });
        },
      });
      log('panel routes registered (/remote-relay/info|config)');
    } catch (e) { log('register routes failed:', e.message); }

    try {
      webServer.tapIndex((html) => {
        if (typeof html !== 'string' || html.indexOf('__rrBooted') !== -1) return html;
        const tag = '<' + 'script>' + INJECT_SCRIPT + '<' + '/script>';
        return html.replace(/<\/body>/i, tag + '</body>');
      });
    } catch { /* 桌面形态无 tapIndex，走 index-inject */ }

    if (config.autoConnect && config.relayUrl) setTimeout(connect, 200);
  });

  ctx.effect(() => () => {
    wantConnect = false;
    clearTimeout(reconnectTimer);
    if (ws) { try { ws.close(1000, 'dispose'); } catch { /* ignore */ } }
  });

  /** 面板保存配置：返回是否需要重连 */
  function applyConfigPatch(patch) {
    let need = false;
    if (typeof patch.relayUrl === 'string') {
      const v = patch.relayUrl.trim();
      if (v && !/^wss?:\/\//.test(v)) return false;   // 非法值整体拒绝
      if (v !== config.relayUrl) { config.relayUrl = v; need = true; }
    }
    if (typeof patch.deviceName === 'string') { config.deviceName = truncate(patch.deviceName.trim(), 64) || '我的 dsh'; }
    if (typeof patch.autoConnect === 'boolean') config.autoConnect = patch.autoConnect;
    if (typeof patch.approveFromPhone === 'boolean') config.approveFromPhone = patch.approveFromPhone;
    if (typeof patch.syncFullUi === 'boolean') config.syncFullUi = patch.syncFullUi;
    if (Number.isFinite(patch.approvalTimeoutMs)) config.approvalTimeoutMs = Math.max(5000, Math.min(patch.approvalTimeoutMs, 600000));
    if (typeof patch.regToken === 'string') {
      const v = patch.regToken.trim();
      if (v !== config.regToken) { config.regToken = truncate(v, 128); need = true; }
    }
    if (patch.resetPairing === true) {
      config.sid = 'dsh-' + crypto.randomBytes(9).toString('hex');
      config.password = crypto.randomBytes(24).toString('base64url');
      need = true;
      log('pairing reset: new sid generated');
    }
    return need;
  }

  log('plugin applied (sid: %s, relay: %s)', config.sid, config.relayUrl || '(未配置)');
}
