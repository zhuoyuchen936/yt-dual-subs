// Service worker: talks to the local model server. Runs here (not in the page) so requests to
// http://localhost are covered by host_permissions and never hit CORS / mixed-content checks.
importScripts('defaults.js', 'translate-core.js');

const { getSettings, buildTranslatePrompt, parseNumbered, isMtModel, MT_SAMPLING, buildMtPrompt, buildMtLookupPrompt, cleanMtOutput } =
  globalThis.YDS;

// ---- model discovery ----

let modelCache = { key: '', id: '', ts: 0 };

async function listModels(apiBase) {
  const origin = new URL(apiBase).origin;
  // LM Studio's native API also says which models are currently loaded.
  try {
    const r = await fetch(`${origin}/api/v0/models`);
    if (r.ok) {
      const j = await r.json();
      const llms = (j.data || []).filter((m) => m.type === 'llm' || m.type === 'vlm');
      if (llms.length) return llms.map((m) => ({ id: m.id, loaded: m.state === 'loaded' }));
    }
  } catch (_) {}
  const r = await fetch(`${apiBase.replace(/\/$/, '')}/models`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.data || []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, loaded: false }));
}

// Whatever is already in memory costs nothing extra; otherwise a small translation model beats
// loading a general-purpose one.
const autoPick = (models) => models.find((m) => m.loaded) || models.find((m) => isMtModel(m.id)) || models[0];

async function resolveModel(settings) {
  if (settings.model) return settings.model;
  const key = settings.apiBase;
  if (modelCache.key === key && modelCache.id && Date.now() - modelCache.ts < 60000) return modelCache.id;
  const models = await listModels(settings.apiBase);
  if (!models.length) throw new Error('本地服务里没有可用的模型');
  const pick = autoPick(models);
  modelCache = { key, id: pick.id, ts: Date.now() };
  return pick.id;
}

// ---- chat completion (streamed, so slow models don't trip the worker's 30s fetch limit) ----

let reasoningParamRejected = false;

async function chat(settings, model, messages, maxTokens, sampling) {
  const url = `${settings.apiBase.replace(/\/$/, '')}/chat/completions`;
  const body = { model, messages, max_tokens: maxTokens, stream: true, ...(sampling || { temperature: 0.2 }) };
  // Hybrid "thinking" models (Qwen3 etc.) would otherwise reason for 1000+ tokens per batch.
  if (!sampling && !reasoningParamRejected) body.reasoning_effort = 'none';
  // LM Studio: unload the model once it has been idle this long, so it stops holding memory after
  // you stop watching. (It reloads on demand; other servers ignore the field.)
  if (settings.idleUnloadMin > 0) body.ttl = Math.round(settings.idleUnloadMin * 60);

  const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let res = await post();
  if (res.status === 400 && body.reasoning_effort) {
    reasoningParamRejected = true;
    delete body.reasoning_effort;
    res = await post();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型服务返回 ${res.status} ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let sawReasoning = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning_content || delta.reasoning) sawReasoning = true;
      } catch (_) {}
    }
  }
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
  if (!content && sawReasoning) {
    throw new Error('模型一直在“思考”没有输出，请在 LM Studio 里关闭该模型的 thinking，或换一个模型');
  }
  return content;
}

// ---- translation ----

const usesMtPrompts = (settings, model) => (settings.promptStyle === 'auto' ? isMtModel(model) : settings.promptStyle === 'mt');

// One sentence per request, a few in flight at once (LM Studio serves them in parallel slots).
const MT_CONCURRENCY = 4;

async function translateMt(settings, model, req) {
  const zh = new Array(req.lines.length).fill(null);
  let next = 0;
  let firstError = null;
  const worker = async () => {
    while (next < req.lines.length) {
      const k = next++;
      const context = [...(req.before || []), ...req.lines.slice(0, k)].slice(-2);
      const messages = buildMtPrompt(settings, { title: req.title, context, text: req.lines[k] });
      try {
        zh[k] = cleanMtOutput(await chat(settings, model, messages, 200 + req.lines[k].length * 2, MT_SAMPLING)) || null;
      } catch (e) {
        firstError = firstError || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MT_CONCURRENCY, req.lines.length) }, worker));
  if (firstError && zh.every((z) => z == null)) throw firstError;
  return zh;
}

async function translate(req) {
  const settings = await getSettings();
  const model = await resolveModel(settings);
  if (usesMtPrompts(settings, model)) return { zh: await translateMt(settings, model, req), model };
  const chars = req.lines.reduce((a, l) => a + l.length, 0);
  const content = await chat(settings, model, buildTranslatePrompt(settings, req), 300 + chars * 2);
  return { zh: parseNumbered(content, req.lines.length), model };
}

// ---- word / phrase lookup ----

async function lookup(req) {
  const settings = await getSettings();
  const model = settings.lookupModel || (await resolveModel(settings));
  // A lookup model picked by hand is judged by its name; promptStyle only describes the translation model.
  if (usesMtPrompts(settings.lookupModel ? { promptStyle: 'auto' } : settings, model)) {
    const zh = cleanMtOutput(await chat(settings, model, buildMtLookupPrompt(settings, req), 120, MT_SAMPLING));
    return { text: `在本句中：${zh}`, brief: true };
  }
  const system = [
    `你是英语学习助手。用户正在看英文视频学英语，会给出一个单词或短语，以及它所在的句子。`,
    `请用${settings.targetLang}简明回答，严格按下面三行的格式，不要客套话：`,
    `音标和词性（如 /ˈsɪmpl/ adj.；短语则写“短语”）`,
    `在本句中的意思`,
    `一个常见搭配或用法提示（附简短英文例子）`
  ].join('\n');
  const user = `单词/短语：${req.text}\n所在句子：${req.sentence}`;
  const content = await chat(
    settings,
    model,
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    400
  );
  return { text: content };
}

// ---- status for the popup ----

async function serverStatus() {
  const settings = await getSettings();
  try {
    const models = await listModels(settings.apiBase);
    const active = settings.model || (autoPick(models) || {}).id || '';
    return { connected: true, models, active, mt: usesMtPrompts(settings, active) };
  } catch (e) {
    return { connected: false, error: String(e.message || e), models: [], active: '' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = { translate, lookup, status: serverStatus };
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  fn(msg)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => {
      const m = String((e && e.message) || e);
      const offline = /Failed to fetch|NetworkError|ECONNREFUSED/i.test(m);
      sendResponse({ ok: false, offline, error: offline ? '连不上本地模型服务（LM Studio 的 Server 开了吗？）' : m });
    });
  return true;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) modelCache = { key: '', id: '', ts: 0 };
});
