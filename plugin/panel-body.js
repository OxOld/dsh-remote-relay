// ── 面板主体（在 dsh 页面内执行；避免模板字符串以兼容拼接注入）───────────────
var RRM_CSS =
  '#rrm-fab{position:fixed;right:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:99998;' +
  'display:flex;align-items:center;gap:7px;padding:10px 15px;border-radius:24px;cursor:pointer;' +
  'background:linear-gradient(135deg,#4c6ef5,#15aabf);color:#fff;font-size:13px;font-weight:600;' +
  'box-shadow:0 4px 16px rgba(0,0,0,.28);user-select:none;font-family:inherit}' +
  '#rrm-fab:active{transform:scale(.96)}' +
  '#rrm-fab-dot{width:8px;height:8px;border-radius:50%;background:#adb5bd}' +
  '#rrm-fab-dot.on{background:#51ff9b;box-shadow:0 0 6px #51ff9b}' +
  '#rrm-panel{position:fixed;right:16px;bottom:calc(74px + env(safe-area-inset-bottom,0px));z-index:99999;' +
  'width:min(342px,calc(100vw - 32px));max-height:78vh;overflow-y:auto;border-radius:16px;' +
  'background:#fff;color:#1a1d24;box-shadow:0 10px 40px rgba(0,0,0,.3);font-size:13px;' +
  "font-family:-apple-system,'PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;display:none}" +
  '@media(prefers-color-scheme:dark){#rrm-panel{background:#1d222c;color:#e8eaf0}}' +
  '#rrm-panel .rrm-h{display:flex;align-items:center;padding:13px 16px;border-bottom:1px solid rgba(128,128,128,.18);font-weight:700;font-size:14px}' +
  '#rrm-panel .rrm-h .rrm-x{margin-left:auto;cursor:pointer;opacity:.6;font-size:17px;padding:0 4px}' +
  '#rrm-panel .rrm-sec{padding:11px 16px;border-bottom:1px solid rgba(128,128,128,.12)}' +
  '#rrm-panel .rrm-sec:last-child{border-bottom:none}' +
  '#rrm-panel label{display:block;font-size:11px;opacity:.65;margin:9px 0 4px}' +
  '#rrm-panel input[type=text],#rrm-panel input[type=url],#rrm-panel input[type=number]{width:100%;box-sizing:border-box;' +
  'border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;border-radius:8px;padding:7px 9px;font-size:12.5px;outline:none}' +
  '#rrm-panel input:focus{border-color:#4c6ef5}' +
  '#rrm-panel .rrm-row{display:flex;align-items:center;gap:7px;margin:7px 0;font-size:12.5px}' +
  '#rrm-panel button.rrm-btn{width:100%;border:none;border-radius:9px;padding:9px 0;margin-top:8px;font-size:13px;' +
  'font-weight:600;cursor:pointer;background:#4c6ef5;color:#fff;font-family:inherit}' +
  '#rrm-panel button.rrm-btn.warn{background:transparent;color:#e03131;border:1px solid rgba(224,49,49,.5)}' +
  '#rrm-panel button.rrm-btn:active{opacity:.75}' +
  '#rrm-panel .rrm-dots{width:9px;height:9px;border-radius:50%;background:#adb5bd;display:inline-block;margin-right:6px}' +
  '#rrm-panel .rrm-dots.on{background:#2f9e44}' +
  '#rrm-panel canvas{display:block;margin:10px auto 6px;background:#fff;border-radius:8px;padding:6px}' +
  '#rrm-panel .rrm-url{word-break:break-all;font-size:10.5px;opacity:.6;text-align:center}' +
  '#rrm-panel .rrm-note{font-size:11px;opacity:.6;margin-top:6px;line-height:1.5}';

function rrmEl(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

var rrmPanel = null, rrmFab = null, rrmTimer = null, rrmInfo = null, rrmOpen = false;

function rrmApi(path, opts) {
  return fetch('/remote-relay/' + path, opts).then(function (r) { return r.json(); });
}

function rrmDrawQr(canvas, url) {
  try {
    var qr = frprmQr(url);
    var size = qr.size;
    var scale = Math.max(2, Math.floor(canvas.width / size));
    canvas.width = canvas.height = size * scale + 8;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111';
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (qr.modules[y][x]) ctx.fillRect(4 + x * scale, 4 + y * scale, scale, scale);
      }
    }
  } catch (e) { /* QR 失败不阻塞面板 */ }
}

function rrmPaint() {
  if (!rrmPanel || !rrmInfo) return;
  var info = rrmInfo;
  var dot = document.getElementById('rrm-fab-dot');
  if (dot) dot.className = info.connected ? 'on' : '';
  var st = rrmPanel.querySelector('#rrm-status');
  if (st) {
    if (!info.configured) st.innerHTML = '<span class="rrm-dots"></span>未配置中继，请在下方填写';
    else if (info.connected && info.terminal) st.innerHTML = '<span class="rrm-dots on"></span>手机已连接';
    else if (info.connected) st.innerHTML = '<span class="rrm-dots on"></span>已连接中继，等待手机扫码';
    else st.innerHTML = '<span class="rrm-dots"></span>未连接：' + (info.error || '请检查中继地址');
  }
  var qrWrap = rrmPanel.querySelector('#rrm-qr');
  if (qrWrap) {
    qrWrap.style.display = info.qrUrl ? '' : 'none';
    if (info.qrUrl) {
      var canvas = qrWrap.querySelector('canvas');
      rrmDrawQr(canvas, info.qrUrl);
      qrWrap.querySelector('.rrm-url').textContent = info.qrUrl;
    }
  }
  var f = rrmPanel.querySelector('#rrm-form');
  if (f && document.activeElement && f.contains(document.activeElement)) { /* 输入中不回填 */ }
  else if (f) {
    f.relayUrl.value = info.relayUrl || '';
    f.deviceName.value = info.deviceName || '';
    f.autoConnect.checked = !!info.autoConnect;
    f.approveFromPhone.checked = !!info.approveFromPhone;
    if (f.syncFullUi) f.syncFullUi.checked = !!info.syncFullUi;
    if (f.fullUiMinimal) f.fullUiMinimal.checked = !!info.fullUiMinimal;
    f.approvalTimeoutMs.value = info.approvalTimeoutMs || 120000;
    f.regToken.value = info.regToken || '';
  }
}

function rrmSave(patch, btn) {
  return rrmApi('config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(function (r) {
    if (btn) { btn.disabled = false; }
    if (!r.ok) alert('保存失败：' + (r.error || '未知错误'));
    else rrmRefresh();
    return r;
  }).catch(function (e) {
    if (btn) btn.disabled = false;
    alert('保存失败：' + e.message);
  });
}

function rrmBuildPanel() {
  rrmPanel = rrmEl('div');
  rrmPanel.id = 'rrm-panel';
  var h = rrmEl('div', 'rrm-h', '远程控制');
  var x = rrmEl('span', 'rrm-x', '×');
  x.onclick = function () { rrmToggle(false); };
  h.appendChild(x);
  rrmPanel.appendChild(h);

  var sec1 = rrmEl('div', 'rrm-sec');
  var st = rrmEl('div');
  st.id = 'rrm-status';
  sec1.appendChild(st);
  var qrWrap = rrmEl('div');
  qrWrap.id = 'rrm-qr';
  var canvas = document.createElement('canvas');
  canvas.width = canvas.height = 220;
  qrWrap.appendChild(canvas);
  qrWrap.appendChild(rrmEl('div', 'rrm-url', ''));
  var copy = rrmEl('button', 'rrm-btn', '复制配对链接');
  copy.onclick = function () {
    if (rrmInfo && rrmInfo.qrUrl && navigator.clipboard) {
      navigator.clipboard.writeText(rrmInfo.qrUrl).then(function () { copy.textContent = '已复制 ✓'; setTimeout(function () { copy.textContent = '复制配对链接'; }, 1500); });
    }
  };
  qrWrap.appendChild(copy);
  sec1.appendChild(qrWrap);
  rrmPanel.appendChild(sec1);

  var sec2 = rrmEl('div', 'rrm-sec');
  var f = rrmEl('form');
  f.id = 'rrm-form';
  var mk = function (labelText, input) {
    var l = rrmEl('label', null, labelText);
    f.appendChild(l); f.appendChild(input);
  };
  f.relayUrl = document.createElement('input');
  f.relayUrl.type = 'url'; f.relayUrl.placeholder = 'wss://你的域名/remote/ws';
  mk('中继地址（WebSocket）', f.relayUrl);
  f.deviceName = document.createElement('input');
  f.deviceName.type = 'text'; f.deviceName.placeholder = '例如：工作电脑';
  mk('设备名称（显示在二维码备注）', f.deviceName);
  f.regToken = document.createElement('input');
  f.regToken.type = 'text'; f.regToken.placeholder = '服务器未设置则留空';
  mk('设备注册口令（服务器 RELAY_REG_TOKEN）', f.regToken);
  f.approvalTimeoutMs = document.createElement('input');
  f.approvalTimeoutMs.type = 'number'; f.approvalTimeoutMs.min = '5000'; f.approvalTimeoutMs.step = '1000';
  mk('手机批准超时（毫秒，超时后回退桌面处理）', f.approvalTimeoutMs);
  var row1 = rrmEl('div', 'rrm-row');
  f.autoConnect = document.createElement('input');
  f.autoConnect.type = 'checkbox'; f.autoConnect.id = 'rrm-ac';
  row1.appendChild(f.autoConnect);
  row1.appendChild(rrmEl('label', null, '启动时自动连接中继'));
  row1.lastChild.htmlFor = 'rrm-ac';
  f.appendChild(row1);
  var row2 = rrmEl('div', 'rrm-row');
  f.approveFromPhone = document.createElement('input');
  f.approveFromPhone.type = 'checkbox'; f.approveFromPhone.id = 'rrm-ap';
  row2.appendChild(f.approveFromPhone);
  row2.appendChild(rrmEl('label', null, '允许在手机上批准工具调用'));
  row2.lastChild.htmlFor = 'rrm-ap';
  f.appendChild(row2);
  var row3 = rrmEl('div', 'rrm-row');
  f.syncFullUi = document.createElement('input');
  f.syncFullUi.type = 'checkbox'; f.syncFullUi.id = 'rrm-sf';
  row3.appendChild(f.syncFullUi);
  row3.appendChild(rrmEl('label', null, '完整模式：推送官方 UI 到服务器（手机用原版界面）'));
  row3.lastChild.htmlFor = 'rrm-sf';
  f.appendChild(row3);
  var row3b = rrmEl('div', 'rrm-row');
  f.fullUiMinimal = document.createElement('input');
  f.fullUiMinimal.type = 'checkbox'; f.fullUiMinimal.id = 'rrm-km';
  row3b.appendChild(f.fullUiMinimal);
  row3b.appendChild(rrmEl('label', null, '精简官方界面（隐藏设置/插件/工作区创建，只留会话与对话）'));
  row3b.lastChild.htmlFor = 'rrm-km';
  f.appendChild(row3b);
  var save = rrmEl('button', 'rrm-btn', '保存并重连');
  save.type = 'submit';
  save.onclick = function (ev) {
    ev.preventDefault();
    save.disabled = true;
    rrmSave({
      relayUrl: f.relayUrl.value.trim(),
      deviceName: f.deviceName.value.trim(),
      autoConnect: !!f.autoConnect.checked,
      approveFromPhone: !!f.approveFromPhone.checked,
      syncFullUi: !!f.syncFullUi.checked,
      fullUiMinimal: !!f.fullUiMinimal.checked,
      approvalTimeoutMs: Number(f.approvalTimeoutMs.value) || 120000,
      regToken: f.regToken.value.trim(),
    }, save);
  };
  f.appendChild(save);
  var reset = rrmEl('button', 'rrm-btn warn', '重置配对（生成新二维码）');
  reset.type = 'button';
  reset.onclick = function () {
    if (!confirm('重置后将生成新的设备 ID 与配对二维码，手机需要重新扫码。确定？')) return;
    reset.disabled = true;
    rrmSave({ resetPairing: true }, reset);
  };
  f.appendChild(reset);
  sec2.appendChild(f);
  rrmPanel.appendChild(sec2);
  rrmPanel.appendChild(rrmEl('div', 'rrm-sec rrm-note', '手机扫码后即可远程查看会话、发送消息、批准工具调用。流量只走中继的消息增量，静态 UI 由服务器直接提供。'));
  document.body.appendChild(rrmPanel);
}

function rrmToggle(open) {
  rrmOpen = open === undefined ? !rrmOpen : open;
  if (rrmOpen) {
    if (!rrmPanel) rrmBuildPanel();
    rrmPanel.style.display = 'block';
    rrmRefresh();
    clearInterval(rrmTimer);
    rrmTimer = setInterval(rrmRefresh, 2500);
  } else {
    if (rrmPanel) rrmPanel.style.display = 'none';
    clearInterval(rrmTimer);
  }
}

function rrmRefresh() {
  rrmApi('info').then(function (r) {
    if (r && r.ok) { rrmInfo = r; rrmPaint(); }
  }).catch(function () { /* dsh 未就绪时忽略 */ });
}

function rrmBoot() {
  // 完整模式（手机上的官方 UI）：面板由轻量 UI 承担，这里不再注入悬浮按钮，
  // 否则每 10s 轮询 /remote-relay/info 会在中继侧打出无意义的 404
  if (location.pathname.indexOf('/remote/full/') === 0) return;
  var style = document.createElement('style');
  style.textContent = RRM_CSS;
  document.head.appendChild(style);
  rrmFab = rrmEl('div');
  rrmFab.id = 'rrm-fab';
  var dot = rrmEl('span');
  dot.id = 'rrm-fab-dot';
  rrmFab.appendChild(dot);
  rrmFab.appendChild(rrmEl('span', null, '远程'));
  rrmFab.onclick = function () { rrmToggle(); };
  document.body.appendChild(rrmFab);
  setInterval(rrmRefresh, 10000);
  rrmRefresh();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rrmBoot);
else rrmBoot();
