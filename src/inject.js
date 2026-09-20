// Runs in the page's MAIN world at document_start.
//
// YouTube's caption URLs only return data when they carry a proof-of-origin token ("pot") that the
// player generates itself. So instead of fetching captions ourselves we watch the player's own
// /api/timedtext request, hand its URL + body to the content script, and let it reuse the token
// for whichever track it actually wants.
(() => {
  if (window.__ydsInjected) return;
  window.__ydsInjected = true;

  const captures = new Map(); // videoId -> { videoId, url, body }

  const post = (msg) => window.postMessage({ source: 'yds-inject', ...msg }, location.origin);

  function record(rawUrl, body) {
    try {
      const u = new URL(rawUrl, location.origin);
      if (!u.pathname.endsWith('/api/timedtext')) return;
      const videoId = u.searchParams.get('v');
      if (!videoId || !u.searchParams.get('pot')) return;
      const usable = body && u.searchParams.get('fmt') === 'json3' && !u.searchParams.get('tlang');
      const rec = { videoId, url: u.toString(), body: usable ? body : null };
      captures.delete(videoId);
      captures.set(videoId, rec);
      if (captures.size > 4) captures.delete(captures.keys().next().value);
      post({ type: 'timedtext', capture: rec });
    } catch (_) {}
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (String(url).includes('/api/timedtext')) {
        this.addEventListener('load', () => {
          let body = null;
          try {
            if (this.responseType === '' || this.responseType === 'text') body = this.responseText;
            else if (this.responseType === 'json') body = JSON.stringify(this.response);
          } catch (_) {}
          record(String(url), body);
        });
      }
    } catch (_) {}
    return xhrOpen.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && String(url).includes('/api/timedtext')) {
        p.then((res) => res.clone().text().then((body) => record(String(url), body))).catch(() => {});
      }
    } catch (_) {}
    return p;
  };

  // ---- commands from the content script ----

  const player = () => document.getElementById('movie_player');

  function getInfo() {
    const p = player();
    if (!p || !p.getPlayerResponse) return { ready: false };
    const pr = p.getPlayerResponse() || {};
    const videoId = (pr.videoDetails && pr.videoDetails.videoId) || null;
    const list =
      (pr.captions &&
        pr.captions.playerCaptionsTracklistRenderer &&
        pr.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];
    return {
      ready: true,
      videoId,
      title: (pr.videoDetails && pr.videoDetails.title) || document.title,
      isLive: !!(pr.videoDetails && pr.videoDetails.isLiveContent && pr.videoDetails.isLive),
      tracks: list.map((t) => ({
        languageCode: t.languageCode,
        kind: t.kind || '',
        vssId: t.vssId || '',
        name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || '',
        baseUrl: t.baseUrl
      })),
      capture: captures.get(videoId) || null
    };
  }

  // Make the player request the given track (which is what gets us a capture).
  function enableTrack({ languageCode, kind, vssId, force }) {
    const p = player();
    if (!p || !p.setOption) return { ok: false };
    try {
      if (p.loadModule) p.loadModule('captions');
    } catch (_) {}
    const apply = () => {
      let target = { languageCode };
      try {
        const list = p.getOption('captions', 'tracklist', { includeAsr: true }) || [];
        target =
          list.find((t) => vssId && t.vss_id === vssId) ||
          list.find((t) => t.languageCode === languageCode && (t.kind || '') === (kind || '')) ||
          target;
      } catch (_) {}
      try {
        p.setOption('captions', 'track', target);
      } catch (_) {}
    };
    if (force) {
      try {
        p.setOption('captions', 'track', {});
      } catch (_) {}
      setTimeout(apply, 400);
    } else {
      // The tracklist is only populated once the captions module has finished loading.
      setTimeout(apply, 50);
      setTimeout(() => {
        const cur = (() => {
          try {
            return p.getOption('captions', 'track');
          } catch (_) {
            return null;
          }
        })();
        if (!cur || !cur.languageCode) apply();
      }, 1200);
    }
    return { ok: true };
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.source !== 'yds-content') return;
    let result;
    if (d.cmd === 'getInfo') result = getInfo();
    else if (d.cmd === 'enableTrack') result = enableTrack(d.args || {});
    else return;
    post({ type: 'reply', id: d.id, result });
  });
})();
