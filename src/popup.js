const { getSettings, saveSettings } = globalThis.YDS;

const $ = (sel) => document.querySelector(sel);
let settings;

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

function sendToTab(msg) {
  return new Promise(async (resolve) => {
    const id = await activeTabId();
    if (id == null) return resolve(null);
    chrome.tabs.sendMessage(id, msg, (r) => resolve(chrome.runtime.lastError ? null : r));
  });
}

// ---- settings form ----

function fillForm() {
  for (const input of document.querySelectorAll('[data-key]')) {
    const v = settings[input.dataset.key];
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = v;
  }
}

async function ensureHostPermission(apiBase) {
  let origin;
  try {
    origin = new URL(apiBase).origin + '/*';
  } catch (_) {
    return false;
  }
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(origin)) return true;
  return chrome.permissions.request({ origins: [origin] }).catch(() => false);
}

async function onChange(e) {
  const input = e.target;
  const key = input.dataset.key;
  if (!key) return;
  let value;
  if (input.type === 'checkbox') value = input.checked;
  else if (input.type === 'range' || 'num' in input.dataset) value = Number(input.value);
  else value = input.value.trim();

  if (key === 'apiBase') {
    value = value.replace(/\/+$/, '');
    if (!(await ensureHostPermission(value))) {
      input.value = settings.apiBase;
      return;
    }
  }
  settings = await saveSettings({ [key]: value });
  if (key === 'apiBase' || key === 'model' || key === 'promptStyle') refreshServer();
}

// ---- status ----

async function refreshServer() {
  const node = $('#server');
  const st = await send({ type: 'status' });
  node.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'dot ' + (st && st.connected ? 'ok' : 'bad');
  node.append(dot);
  if (!st || !st.connected) {
    node.append('连不上本地模型服务 — 在 LM Studio 的 Developer 页打开 Server，或运行 lms server start');
    return;
  }
  node.append(`已连接 · ${st.active || '没有可用模型'}${st.active ? (st.mt ? ' · 逐句翻译' : ' · 批量翻译') : ''}`);

  for (const key of ['model', 'lookupModel']) {
    const select = $(`select[data-key="${key}"]`);
    while (select.options.length > 1) select.remove(1);
    for (const m of st.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id + (m.loaded ? '（已加载）' : '');
      select.append(opt);
    }
    if (settings[key] && !st.models.some((m) => m.id === settings[key])) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = settings[key];
      select.append(opt);
    }
    select.value = settings[key];
  }
}

const PHASES = { loading: '正在获取字幕…', translating: '翻译中', ahead: '已翻译到前面，随播放继续', done: '翻译完成', nocaps: '', error: '' };

async function refreshVideo() {
  const st = await sendToTab({ type: 'getStatus' });
  const node = $('#video');
  const bar = $('#bar');
  const btn = $('#retranslate');
  if (!st || !st.active) {
    node.className = 'muted';
    node.textContent = st ? '当前页面不是视频播放页' : '打开一个 YouTube 视频即可（刚安装的话先刷新页面）';
    bar.hidden = true;
    btn.hidden = true;
    return;
  }
  const track = st.track ? `${st.track.languageCode}${st.track.kind === 'asr' ? ' 自动生成' : ' 人工'}字幕` : '';
  const isErr = st.phase === 'error' || st.phase === 'nocaps';
  node.className = isErr ? 'err' : '';
  node.textContent = isErr ? st.error : [PHASES[st.phase], st.total ? `${st.done}/${st.total} 句` : '', track].filter(Boolean).join(' · ');
  bar.hidden = !st.total;
  bar.max = st.total || 1;
  bar.value = st.done || 0;
  btn.hidden = !st.total;
}

async function refreshCacheInfo() {
  const { 'yds:index': index = {} } = await chrome.storage.local.get('yds:index');
  $('#cacheInfo').textContent = `已缓存 ${Object.keys(index).length} 个视频`;
}

// ---- boot ----

(async () => {
  settings = await getSettings();
  fillForm();
  document.body.addEventListener('change', onChange);
  document.body.addEventListener('input', (e) => {
    if (e.target.type === 'range') onChange(e);
  });

  $('#retranslate').addEventListener('click', async () => {
    await sendToTab({ type: 'retranslate' });
    refreshVideo();
  });
  $('#clearCache').addEventListener('click', async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => /^yds:c\d+:/.test(k) || k === 'yds:index');
    await chrome.storage.local.remove(keys);
    refreshCacheInfo();
  });

  refreshServer();
  refreshVideo();
  refreshCacheInfo();
  setInterval(refreshVideo, 1000);
})();
