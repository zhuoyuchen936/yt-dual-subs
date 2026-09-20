// Shared by the service worker, content script and popup (loaded as a classic script in all three).
(() => {
  const DEFAULTS = {
    enabled: true,

    // Local model server (OpenAI-compatible). LM Studio: http://localhost:1234/v1, Ollama: http://localhost:11434/v1
    apiBase: 'http://localhost:1234/v1',
    model: '', // '' = auto: whatever is loaded, else a dedicated translation model, else the first one
    promptStyle: 'auto', // 'auto' | 'chat' (numbered batch, general LLMs) | 'mt' (one sentence per request, Hy-MT templates)
    lookupModel: '', // '' = same model as translation (a translation model can only gloss the word in context)
    targetLang: '简体中文',
    batchSize: 12,
    extraPrompt: '',
    lookaheadMin: 10, // only translate this far ahead of the playhead; 0 = the whole video at once
    idleUnloadMin: 10, // ask LM Studio to unload the model after this long idle; 0 = never

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
