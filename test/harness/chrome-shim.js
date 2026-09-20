// Minimal in-page stand-in for the extension APIs the sources use.
(() => {
  // Settings can be overridden from the URL: /watch?v=x&settings={"lookaheadMin":0.5}
  const overrides = JSON.parse(new URLSearchParams(location.search).get('settings') || '{}');
  const store = { settings: { apiBase: location.origin + '/llm/v1', ...overrides } };
  const storageListeners = [];
  const messageListeners = [];
  window.__store = store;
  window.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return { ...store };
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          storageListeners.forEach((fn) => fn(changes, 'local'));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete store[k];
        }
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) }
    },
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage(msg, cb) {
        let answered = false;
        const reply = (r) => {
          if (!answered) {
            answered = true;
            setTimeout(() => cb && cb(r), 0);
          }
        };
        for (const fn of messageListeners) if (fn(msg, {}, reply) === true) return;
        if (!answered) reply(undefined);
      }
    }
  };
  window.importScripts = () => {}; // background.js dependencies are loaded by <script> tags instead
})();
