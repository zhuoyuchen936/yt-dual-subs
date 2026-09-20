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

  globalThis.YDS = Object.assign(globalThis.YDS || {}, { buildTranslatePrompt, parseNumbered });
})();
