// Content script (isolated world): gets the caption track, schedules translation ahead of the
// playhead, and draws the bilingual overlay inside the player.
(() => {
  const { DEFAULTS, getSettings, saveSettings, parseJson3, indexAt } = globalThis.YDS;

  let settings = { ...DEFAULTS };
  let session = null;
  let ui = null;
  let dead = false; // extension was reloaded/removed under us

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const playerEl = () => document.getElementById('movie_player');
  const videoEl = () => document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video');
  const safeParse = (t) => {
    try {
      return JSON.parse(t);
    } catch (_) {
      return null;
    }
  };

  // ---------------------------------------------------------------- messaging

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(r || { ok: false, error: '后台没有响应' });
        });
      } catch (e) {
        dead = true;
        endSession();
        resolve({ ok: false, error: '扩展已更新，请刷新页面' });
      }
    });
  }

  const pageCalls = new Map();
  let pageSeq = 0;
  function callPage(cmd, args) {
    return new Promise((resolve) => {
      const id = ++pageSeq;
      pageCalls.set(id, resolve);
      window.postMessage({ source: 'yds-content', id, cmd, args }, location.origin);
      setTimeout(() => {
        if (pageCalls.delete(id)) resolve(null);
      }, 2000);
    });
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.source !== 'yds-inject') return;
    if (d.type === 'reply') {
      const fn = pageCalls.get(d.id);
      if (fn) {
        pageCalls.delete(d.id);
        fn(d.result);
      }
    } else if (d.type === 'timedtext') {
      const s = session;
      if (s && s.track && !s.cues && d.capture && d.capture.videoId === s.videoId) {
        s.capture = d.capture;
        tryLoadCues(s);
      }
    }
  });

  // ---------------------------------------------------------------- session lifecycle

  function currentVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  function checkNav() {
    if (dead) return;
    const id = settings.enabled ? currentVideoId() : null;
    if (id === (session ? session.videoId : null)) return;
    if (id) startSession(id);
    else endSession();
  }

  function endSession() {
    const s = session;
    session = null;
    if (s) {
      s.alive = false;
      clearTimeout(s.captureTimer);
      clearTimeout(s.retryTimer);
      clearTimeout(s.saveTimer);
    }
    closePopup();
    document.documentElement.classList.remove('yds-active');
    if (ui) {
      ui.box.hidden = true;
      ui.status.hidden = true;
    }
    shown = { idx: -2, zh: undefined, word: -1 };
    lastFrame = { t: 0, cue: null };
    lastAutoPaused = -1;
  }

  async function waitForInfo(s) {
    for (let k = 0; k < 60 && s.alive; k++) {
      const info = await callPage('getInfo');
      if (info && info.ready && info.videoId === s.videoId) return info;
      await new Promise((r) => setTimeout(r, 350));
    }
    return null;
  }

  function pickTrack(tracks) {
    const lang = (settings.sourceLang || 'en').toLowerCase();
    const inLang = tracks.filter((t) => t.languageCode.toLowerCase().split('-')[0] === lang);
    const manual = inLang.filter((t) => t.kind !== 'asr');
    const asr = inLang.filter((t) => t.kind === 'asr');
    const exact = (list) => list.find((t) => t.languageCode.toLowerCase() === lang) || list[0];
    if (settings.preferManual) return exact(manual) || exact(asr) || null;
    return exact(asr) || exact(manual) || null;
  }

  async function startSession(videoId) {
    endSession();
    const s = (session = {
      videoId,
      alive: true,
      title: '',
      track: null,
      capture: null,
      cues: null, // what is displayed (English)
      groups: null, // what is translated (whole sentences), see segment.js
      wordLevel: false,
      phase: 'loading', // loading | translating | ahead (caught up with the lookahead window) | done | nocaps | error
      error: '',
      inflight: false,
      failStreak: 0,
      cacheKey: ''
    });
    ensureUI();
    setStatus('正在获取字幕…');

    const info = await waitForInfo(s);
    if (!s.alive) return;
    if (!info) return setPhase(s, 'error', '播放器没有就绪，刷新页面试试');
    s.title = info.title || '';
    if (info.isLive) return setPhase(s, 'nocaps', '暂不支持直播');
    s.track = pickTrack(info.tracks);
    if (!s.track) {
      const why = info.tracks.length ? `此视频没有 ${settings.sourceLang} 字幕轨` : '此视频没有字幕轨，无法翻译';
      return setPhase(s, 'nocaps', why);
    }
    s.capture = info.capture;
    if (await tryLoadCues(s)) return;
    if (!s.alive) return;

    // No token yet: make the player request the track so inject.js can capture it.
    await callPage('enableTrack', s.track);
    s.captureTimer = setTimeout(async () => {
      if (!s.alive || s.cues) return;
      await callPage('enableTrack', { ...s.track, force: true });
      s.captureTimer = setTimeout(() => {
        if (s.alive && !s.cues) setPhase(s, 'error', '没拿到字幕：点一下播放器的 CC 按钮试试');
      }, 7000);
    }, 6000);
  }

  async function tryLoadCues(s) {
    if (!s.capture || s.loadingCues || s.cues) return false;
    s.loadingCues = true;
    try {
      const cu = new URL(s.capture.url);
      const tu = new URL(s.track.baseUrl, location.origin);
      const TRACK_KEYS = ['lang', 'kind', 'name'];
      const sameTrack = TRACK_KEYS.every((k) => (cu.searchParams.get(k) || '') === (tu.searchParams.get(k) || ''));

      let json = sameTrack && s.capture.body ? safeParse(s.capture.body) : null;
      if (!json) {
        // Borrow the player's token (and client params) for the track we want.
        for (const [k, v] of cu.searchParams) {
          if (TRACK_KEYS.includes(k) || k === 'tlang' || k === 'fmt') continue;
          if (!tu.searchParams.has(k)) tu.searchParams.set(k, v);
        }
        tu.searchParams.delete('tlang');
        tu.searchParams.set('fmt', 'json3');
        const r = await fetch(tu.toString(), { credentials: 'include' });
        json = safeParse(await r.text());
      }
      if (!s.alive) return false;
      if (!json || !json.events) return false;

      const { cues, groups, wordLevel } = parseJson3(json, { mergeSentences: settings.mergeSentences });
      if (!cues.length) {
        setPhase(s, 'nocaps', '字幕轨是空的');
        return true;
      }
      s.cacheKey = `yds:c2:${s.videoId}:${s.track.vssId || s.track.languageCode + '.' + s.track.kind}:${settings.mergeSentences ? 1 : 0}`;
      const cached = (await chrome.storage.local.get(s.cacheKey))[s.cacheKey];
      if (cached && cached.n === groups.length && Array.isArray(cached.zh)) {
        cached.zh.forEach((z, k) => {
          if (z != null && groups[k].zh == null) groups[k].zh = z;
        });
      }
      if (!s.alive) return false;
      clearTimeout(s.captureTimer);
      s.cues = cues;
      s.groups = groups;
      s.wordLevel = wordLevel;
      setPhase(s, 'translating');
      pump();
      return true;
    } catch (e) {
      return false;
    } finally {
      s.loadingCues = false;
    }
  }

  // ---------------------------------------------------------------- translation scheduler

  const needs = (g) => g.zh == null;

  // Untranslated sentences starting at the playhead (so seeking re-prioritises). With a lookahead
  // window only the next few minutes are translated, which keeps the GPU idle most of the time and
  // wastes nothing on videos that are not watched to the end; without one, the whole video is done.
  function nextBatch(s) {
    const v = videoEl();
    const t = v ? v.currentTime : 0;
    const cueIdx = indexAt(s.cues, t);
    const from = cueIdx < 0 ? 0 : s.cues[cueIdx].g;
    const horizon = settings.lookaheadMin > 0 ? t + settings.lookaheadMin * 60 : Infinity;
    let k = s.groups.findIndex((g, idx) => idx >= from && needs(g));
    if (k < 0 && horizon === Infinity) k = s.groups.findIndex(needs);
    if (k < 0 || s.groups[k].s > horizon) return [];
    // A small first batch gets something on screen quickly.
    const started = s.groups.some((g) => g.zh != null && !g.noSpeech);
    const size = started ? settings.batchSize : Math.min(5, settings.batchSize);
    const maxChars = started ? 1600 : 600;
    const batch = [];
    let chars = 0;
    for (let j = k; j < s.groups.length && batch.length < size; j++) {
      const g = s.groups[j];
      if (!needs(g) || g.s > horizon) break;
      if (batch.length && chars + g.en.length > maxChars) break;
      batch.push(g);
      chars += g.en.length;
    }
    return batch;
  }

  async function pump() {
    const s = session;
    if (dead || !s || !s.alive || !s.cues || s.inflight || !settings.enabled) return;
    clearTimeout(s.retryTimer);
    const batch = nextBatch(s);
    if (!batch.length) {
      // Nothing to do right now: either everything is translated, or we are far enough ahead.
      const phase = s.groups.some(needs) ? 'ahead' : 'done';
      if (s.phase !== phase) setPhase(s, phase);
      return;
    }
    s.inflight = true;
    const first = batch[0].i;
    const last = batch[batch.length - 1].i;
    const resp = await send({
      type: 'translate',
      title: s.title,
      lines: batch.map((g) => g.en),
      before: s.groups.slice(Math.max(0, first - 3), first).map((g) => g.en),
      after: s.groups.slice(last + 1, last + 3).map((g) => g.en)
    });
    s.inflight = false;
    if (!s.alive) return;

    if (!resp.ok) {
      s.failStreak++;
      setPhase(s, 'error', resp.error || '翻译失败');
      s.retryTimer = setTimeout(pump, Math.min(15000, 2000 * s.failStreak));
      return;
    }
    s.failStreak = 0;
    batch.forEach((g, k) => {
      const z = resp.zh[k];
      if (z) g.zh = z;
      else if ((g.tries = (g.tries || 0) + 1) >= 3) g.zh = ''; // give up on this line
    });
    s.model = resp.model;
    setPhase(s, 'translating');
    saveCacheSoon(s);
    pump();
  }

  function saveCacheSoon(s) {
    clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(async () => {
      if (dead || !s.cues) return;
      try {
        const now = Date.now();
        const zh = s.groups.map((g) => (g.zh == null || g.noSpeech ? null : g.zh));
        const { 'yds:index': index = {} } = await chrome.storage.local.get('yds:index');
        index[s.cacheKey] = now;
        const keys = Object.keys(index).sort((a, b) => index[b] - index[a]);
        const stale = keys.slice(300);
        stale.forEach((k) => delete index[k]);
        if (stale.length) await chrome.storage.local.remove(stale);
        await chrome.storage.local.set({ [s.cacheKey]: { n: s.groups.length, zh, title: s.title, ts: now }, 'yds:index': index });
      } catch (_) {}
    }, 1500);
  }

  async function retranslate() {
    const s = session;
    if (!s || !s.cues) return;
    try {
      await chrome.storage.local.remove(s.cacheKey);
    } catch (_) {}
    for (const g of s.groups) {
      if (!g.noSpeech) {
        g.zh = undefined;
        g.tries = 0;
      }
    }
    setPhase(s, 'translating');
    pump();
  }

  // ---------------------------------------------------------------- status pill

  let statusTimer = null;

  function progress(s) {
    const total = s.groups ? s.groups.length : 0;
    const done = s.groups ? s.groups.filter((g) => g.zh != null).length : 0;
    return { done, total };
  }

  function setStatus(text, kind, ttl) {
    const u = ensureUI();
    if (!u) return;
    clearTimeout(statusTimer);
    const show = text && (settings.showStatus || kind === 'error' || kind === 'warn' || kind === 'toast');
    u.status.hidden = !show;
    u.status.textContent = text || '';
    u.status.dataset.kind = kind || '';
    if (show && ttl) statusTimer = setTimeout(() => (u.status.hidden = true), ttl);
  }

  function setPhase(s, phase, message) {
    if (s !== session) return;
    s.phase = phase;
    s.error = phase === 'error' || phase === 'nocaps' ? message || '' : '';
    if (phase === 'translating') {
      const { done, total } = progress(s);
      setStatus(`翻译中 ${done}/${total}`);
    } else if (phase === 'done') setStatus('翻译完成 ✓', '', 2500);
    else if (phase === 'ahead') setStatus('');
    else if (phase === 'nocaps') setStatus(message, 'warn', 6000);
    else if (phase === 'error') setStatus(message, 'error');
  }

  // ---------------------------------------------------------------- overlay UI

  let shown = { idx: -2, zh: undefined, word: -1 };
  let hovering = false;
  let pausedByUs = false;
  let lastAutoPaused = -1;
  let lastFrame = { t: 0, cue: null };
  let selfSeek = false; // the next 'seeking' event is our own auto-pause rewind
  let popup = null; // { node }
  const lookupCache = new Map();

  function ensureUI() {
    const player = playerEl();
    if (!player) return null;
    if (ui && ui.root.isConnected && ui.root.parentElement === player) return ui;
    if (ui) ui.root.remove();

    const root = el('div');
    root.id = 'yds-root';
    const status = el('div', 'yds-status');
    status.hidden = true;
    const box = el('div', 'yds-box');
    box.hidden = true;
    const en = el('div', 'yds-en');
    const zh = el('div', 'yds-zh');
    box.append(en, zh);
    root.append(status, box);
    player.appendChild(root);

    // Keep clicks on the subtitles from toggling play / fullscreen.
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'contextmenu']) {
      box.addEventListener(type, (e) => e.stopPropagation());
    }
    box.addEventListener('mouseenter', () => {
      hovering = true;
      if (settings.hoverPause) pauseByUs();
    });
    box.addEventListener('mouseleave', () => {
      hovering = false;
      maybeResume();
    });
    en.addEventListener('click', onEnglishClick);

    const ro = new ResizeObserver(() => root.style.setProperty('--yds-h', player.clientHeight + 'px'));
    ro.observe(player);
    root.style.setProperty('--yds-h', player.clientHeight + 'px');

    ui = { root, status, box, en, zh };
    applySettings();
    shown = { idx: -2, zh: undefined, word: -1 };
    return ui;
  }

  function applySettings() {
    if (!ui) return;
    const r = ui.root;
    r.style.setProperty('--yds-scale', String(settings.fontScale));
    r.style.setProperty('--yds-bottom', settings.bottomPct + '%');
    r.classList.toggle('yds-hide-en', !settings.showEn);
    r.classList.toggle('yds-hide-zh', !settings.showZh);
    r.classList.toggle('yds-blur-zh', !!settings.zhBlur);
  }

  function pauseByUs() {
    const v = videoEl();
    if (v && !v.paused) {
      v.pause();
      pausedByUs = true;
    }
  }

  function maybeResume() {
    if (!pausedByUs || hovering || popup) return;
    pausedByUs = false;
    const v = videoEl();
    if (v) v.play().catch(() => {});
  }

  function buildEnglish(cue) {
    ui.en.textContent = '';
    const tokens = cue.words ? cue.words.map((w) => w.t) : cue.en.split(' ');
    tokens.forEach((t, k) => {
      if (k) ui.en.append(' ');
      const span = el('span', 'yds-w', t);
      span.dataset.k = String(k);
      ui.en.append(span);
    });
  }

  function render() {
    const s = session;
    const u = ui;
    if (!u || !u.root.isConnected) return;
    const player = playerEl();
    const v = videoEl();
    const active = !!(settings.enabled && s && s.cues && v && player && !player.classList.contains('ad-showing'));
    document.documentElement.classList.toggle('yds-active', active);
    if (!active) {
      u.box.hidden = true;
      return;
    }

    const t = v.currentTime;
    const idx = indexAt(s.cues, t);
    let cue = idx >= 0 ? s.cues[idx] : null;
    if (cue && t >= cue.e) cue = null;

    // Pause at the end of each cue. Frames can be far apart (throttled tab), so besides "about to
    // end" also catch "the previous frame's cue ended since" and step back inside it.
    if (settings.autoPause && !v.paused) {
      const prev = lastFrame.cue;
      const continuous = t >= lastFrame.t && t - lastFrame.t < 1.5;
      let target = null;
      if (cue && !cue.noSpeech && t >= cue.e - 0.15) target = cue;
      else if (prev && prev !== cue && continuous && !prev.noSpeech && t >= prev.e - 0.15) target = prev;
      if (target && lastAutoPaused !== target.i) {
        lastAutoPaused = target.i;
        v.pause();
        if (t >= target.e - 0.03) {
          selfSeek = true;
          v.currentTime = target.e - 0.03;
        }
        cue = target;
      }
    }
    lastFrame = { t, cue };

    const key = cue ? cue.i : -1;
    if (key !== shown.idx) {
      shown.idx = key;
      shown.zh = undefined;
      shown.word = -1;
      u.box.hidden = !cue;
      if (cue) buildEnglish(cue);
    }
    if (!cue) return;

    const zh = s.groups[cue.g].zh;
    if (zh !== shown.zh) {
      shown.zh = zh;
      u.zh.textContent = zh == null ? '…' : zh;
      u.zh.classList.toggle('yds-wait', zh == null);
    }

    if (cue.words && settings.karaoke) {
      let w = -1;
      for (let k = 0; k < cue.words.length && cue.words[k].s <= t; k++) w = k;
      if (w !== shown.word) {
        const spans = u.en.children;
        if (shown.word >= 0 && spans[shown.word]) spans[shown.word].classList.remove('yds-cur');
        if (w >= 0 && spans[w]) spans[w].classList.add('yds-cur');
        shown.word = w;
      }
    }
  }

  function loop() {
    if (dead) return;
    if (session) {
      ensureUI();
      render();
    }
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- word lookup

  const stripPunct = (w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

  function onEnglishClick(e) {
    const s = session;
    if (!s || !s.cues || shown.idx < 0) return;
    const cue = s.cues[shown.idx];
    const sel = window.getSelection();
    const selected = sel && !sel.isCollapsed && ui.en.contains(sel.anchorNode) ? sel.toString().replace(/\s+/g, ' ').trim() : '';
    const span = e.target.closest ? e.target.closest('.yds-w') : null;
    const text = selected.includes(' ') ? selected : span ? stripPunct(span.textContent) : '';
    if (!text) return;
    pauseByUs();
    openPopup(text, s.groups[cue.g].en, span || ui.en);
  }

  function closePopup() {
    if (!popup) return;
    popup.node.remove();
    popup = null;
    maybeResume();
  }

  async function openPopup(text, sentence, anchor) {
    if (popup) {
      popup.node.remove();
      popup = null;
    }
    const player = playerEl();
    if (!ui || !player) return;
    const node = el('div', 'yds-pop');
    const head = el('div', 'yds-pop-head', text);
    const body = el('div', 'yds-pop-body', '查询中…');
    node.append(head, body);
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      node.addEventListener(type, (e) => e.stopPropagation());
    }
    ui.root.appendChild(node);
    const mine = (popup = { node });

    const pr = player.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const width = node.offsetWidth;
    const center = ar.left + ar.width / 2 - pr.left;
    const left = Math.max(8, Math.min(pr.width - width - 8, center - width / 2));
    node.style.left = left + 'px';
    node.style.bottom = pr.bottom - ar.top + 10 + 'px';

    const key = text.toLowerCase() + '|' + sentence;
    let answer = lookupCache.get(key);
    if (!answer) {
      const resp = await send({ type: 'lookup', text, sentence });
      answer = resp.ok ? resp.text : '查询失败：' + (resp.error || '');
      if (resp.ok) lookupCache.set(key, answer);
    }
    if (popup === mine) body.textContent = answer;
  }

  document.addEventListener(
    'mousedown',
    (e) => {
      if (popup && !popup.node.contains(e.target) && !(ui && ui.box.contains(e.target))) closePopup();
    },
    true
  );

  // ---------------------------------------------------------------- hotkeys

  function jump(delta) {
    const s = session;
    const v = videoEl();
    if (!s || !s.cues || !v) return;
    const idx = indexAt(s.cues, v.currentTime);
    const target = Math.max(0, Math.min(s.cues.length - 1, (idx < 0 ? 0 : idx) + delta));
    lastAutoPaused = -1;
    closePopup();
    v.currentTime = s.cues[target].s + 0.01;
    v.play().catch(() => {});
  }

  async function toggleSetting(key, label) {
    settings = await saveSettings({ [key]: !settings[key] });
    applySettings();
    setStatus(`${label}：${settings[key] ? '开' : '关'}`, 'toast', 1500);
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && popup) return closePopup();
      if (!settings.enabled || !settings.hotkeys || !session || !session.cues) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'a') jump(-1);
      else if (k === 'd') jump(1);
      else if (k === 's') jump(0);
      else if (k === 'z') toggleSetting('zhBlur', '遮住中文');
      else if (k === 'p') toggleSetting('autoPause', '句末自动暂停');
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  document.addEventListener(
    'play',
    () => {
      pausedByUs = false;
      if (popup) closePopup();
    },
    true
  );
  document.addEventListener(
    'seeking',
    () => {
      if (selfSeek) selfSeek = false;
      else lastAutoPaused = -1;
      pump();
    },
    true
  );

  // ---------------------------------------------------------------- popup <-> content

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'getStatus') {
      const s = session;
      if (!s) sendResponse({ active: false });
      else {
        const t = s.track;
        sendResponse({
          active: true,
          title: s.title,
          phase: s.phase,
          error: s.error,
          model: s.model || '',
          track: t ? { languageCode: t.languageCode, kind: t.kind, name: t.name } : null,
          ...progress(s)
        });
      }
    } else if (msg.type === 'retranslate') {
      retranslate();
      sendResponse({ ok: true });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const prev = settings;
    settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
    applySettings();
    const trackChanged = ['sourceLang', 'preferManual', 'mergeSentences'].some((k) => prev[k] !== settings[k]);
    if (trackChanged && session) endSession();
    checkNav();
    if (session && (session.phase === 'error' || session.phase === 'ahead' || session.phase === 'done')) pump();
  });

  // ---------------------------------------------------------------- boot

  (async () => {
    settings = await getSettings();
    document.addEventListener('yt-navigate-finish', checkNav);
    setInterval(() => {
      checkNav();
      // The lookahead window moves with the playhead: top it up as playback advances.
      if (session && session.phase === 'ahead') pump();
    }, 1000);
    checkNav();
    requestAnimationFrame(loop);
  })();
})();
