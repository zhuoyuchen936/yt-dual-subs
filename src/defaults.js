// Shared by the service worker, content script and popup (loaded as a classic script in all three).
(() => {
  const DEFAULTS = {
    enabled: true,

    // Local model server (OpenAI-compatible). LM Studio: http://localhost:1234/v1, Ollama: http://localhost:11434/v1
    apiBase: 'http://localhost:1234/v1',
    model: '', // '' = auto-detect (prefer a model that is already loaded)
    targetLang: '简体中文',
    batchSize: 12,
    extraPrompt: '',

    // Captions
    sourceLang: 'en',
    preferManual: true, // prefer human-made captions over auto-generated ones
    mergeSentences: true,

    // Display
    showEn: true,
    showZh: true,
    zhBlur: false, // hide the translation until hovered — test yourself first
    fontScale: 1.0,
    bottomPct: 4, // % of player height, on top of a fixed clearance for the control bar
    karaoke: true, // highlight the word being spoken (auto-generated tracks only)
    showStatus: true,

    // Learning
    hoverPause: true,
    autoPause: false, // pause at the end of every sentence (for shadowing)
    hotkeys: true
  };

  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DEFAULTS, ...(settings || {}) };
  }

  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  globalThis.YDS = Object.assign(globalThis.YDS || {}, { DEFAULTS, getSettings, saveSettings });
})();
