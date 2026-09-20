// Prompt construction and reply parsing for subtitle translation. Pure functions (also run under node for tests).
(() => {
  function buildTranslatePrompt(settings, req) {
    const system = [
      `你是专业的视频字幕翻译员。用户会给出带编号的字幕行（可能来自语音识别，偶有识别错误，句子可能跨行）。`,
      `要求：`,
      `1. 把每一行翻译成自然、口语化的${settings.targetLang}，结合上下文保证连贯、术语前后一致。`,
      `2. 严格逐行对应：输出行数与输入相同、编号一致，不合并、不拆分、不遗漏。`,
      `3. 人名、产品名、代码、公式等专有名词可以保留原文。`,
      `4. 只输出译文，每行格式为「编号. 译文」，不要任何解释或额外内容。`,
      settings.extraPrompt ? `补充要求：${settings.extraPrompt}` : ''
    ]
      .filter(Boolean)
      .join('\n');

    const parts = [];
    if (req.title) parts.push(`视频标题：${req.title}`);
    if (req.before && req.before.length) parts.push(`【前文，仅供理解，不要翻译】\n${req.before.join('\n')}`);
    if (req.after && req.after.length) parts.push(`【后文，仅供理解，不要翻译】\n${req.after.join('\n')}`);
    parts.push(`【待翻译】\n${req.lines.map((l, k) => `${k + 1}. ${l}`).join('\n')}`);
    return [
      { role: 'system', content: system },
      { role: 'user', content: parts.join('\n\n') }
    ];
  }

  function parseNumbered(text, n) {
    const out = new Array(n).fill(null);
    const cleaned = text.replace(/```[a-z]*\n?/gi, '');
    for (const raw of cleaned.split('\n')) {
      const m = raw.match(/^\s*[「\[(（]?(\d{1,3})\s*[\])）」.、:：-]+\s*(.*)$/);
      if (!m) continue;
      const idx = parseInt(m[1], 10) - 1;
      if (idx < 0 || idx >= n || out[idx] != null) continue;
      out[idx] = m[2].trim().replace(/^「(.*)」$/, '$1');
    }
    // A single line is sometimes answered without its number.
    if (n === 1 && out[0] == null && cleaned.trim()) out[0] = cleaned.trim().split('\n')[0];
    return out;
  }

  // ---- dedicated translation models (Tencent Hy-MT / Hunyuan-MT family) ----
  //
  // These are tiny (1.8B) and fast, but only trained on a handful of prompt shapes and with no system
  // prompt, so they get one sentence per request in the vendor's own templates. That also makes
  // misalignment impossible by construction: one request, one sentence, one translation.

  const isMtModel = (id) => /hy-?mt|hunyuan-?mt/i.test(String(id || ''));

  // The vendor's recommended sampling (llama.cpp / LM Studio parameter names).
  const MT_SAMPLING = { temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05 };

  // "Structured Data 2" template from the model card: background information + source text.
  function buildMtPrompt(settings, { title, context, text }) {
    const background = [];
    if (title) background.push(`视频标题：${title}`);
    for (const line of context || []) background.push(`上文：${line}`);
    if (settings.extraPrompt) background.push(`翻译要求：${settings.extraPrompt}`);
    const content = background.length
      ? `【背景信息】\n${background.join('\n')}\n\n请结合背景信息将以下文本翻译为${settings.targetLang}。\n\n【待翻译文本】\n${text}`
      : `将以下文本翻译为${settings.targetLang}，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`;
    return [{ role: 'user', content }];
  }

  // A translation model cannot explain a word, but it can translate it in the context of its sentence.
  function buildMtLookupPrompt(settings, { text, sentence }) {
    const content = `【背景信息】\n${sentence}\n\n请结合背景信息将以下文本翻译为${settings.targetLang}。\n\n【待翻译文本】\n${text}`;
    return [{ role: 'user', content }];
  }

  function cleanMtOutput(text) {
    return String(text || '')
      .replace(/^【?(译文|翻译结果|翻译)】?[:：]\s*/, '')
      .replace(/\s*\n+\s*/g, ' ')
      .trim();
  }

  globalThis.YDS = Object.assign(globalThis.YDS || {}, {
    buildTranslatePrompt,
    parseNumbered,
    isMtModel,
    MT_SAMPLING,
    buildMtPrompt,
    buildMtLookupPrompt,
    cleanMtOutput
  });
})();
