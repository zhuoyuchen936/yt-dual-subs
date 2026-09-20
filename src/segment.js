// YouTube json3 captions -> display cues. Pure functions (also run under node for tests).
//
// A cue is what is shown in English: { i, g, s, e, en, words?, noSpeech? }
//   (s/e in seconds, words = [{t, s}] when word timing exists, g = index of its group)
// A group is what gets translated: { i, from, to, s, e, en, zh?, noSpeech? }
//   One sentence is often spread over several cues. Translating cue by cue makes the model shuffle
//   clauses between lines (Chinese word order differs), so lines drift out of sync with the English.
//   Instead the whole sentence is translated once and shown for as long as any of its cues is up.
(() => {
  const SENT_END = /[.!?…]["'”’)\]]*$/;
  const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;
  const ABBREV = /^(mr|mrs|ms|dr|prof|st|vs|etc|inc|ltd|jr|sr|e\.g|i\.e|u\.s|a\.m|p\.m|no)\.$/i;
  const NON_SPEECH = /^[\[(（【].*[\])）】]$/;

  const NON_SPEECH_ZH = {
    music: '[音乐]',
    applause: '[掌声]',
    laughter: '[笑声]',
    laughs: '[笑声]',
    cheering: '[欢呼]',
    silence: '[静音]'
  };

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function isSentenceEnd(word) {
    return SENT_END.test(word) && !ABBREV.test(word);
  }

  function hasWordTiming(events) {
    let timed = 0;
    for (const ev of events) {
      if (!ev.segs) continue;
      for (const seg of ev.segs) if (seg.tOffsetMs != null || seg.acAsrConf != null) timed++;
      if (timed > 5) return true;
    }
    return false;
  }

  // ---- auto-generated (word-timed) tracks ----

  function collectWords(events) {
    const words = [];
    for (const ev of events) {
      if (!ev.segs || ev.aAppend) continue;
      const base = ev.tStartMs || 0;
      for (const seg of ev.segs) {
        const t = clean(seg.utf8);
        if (!t) continue;
        words.push({ t, s: base + (seg.tOffsetMs || 0) });
      }
    }
    words.sort((a, b) => a.s - b.s);
    return words;
  }

  function chunkLen(chunk) {
    let n = 0;
    for (const w of chunk) n += w.t.length + 1;
    return n;
  }

  // On overflow, split where the speaker paused the longest (searching the back 60% of the chunk).
  function bestSplit(chunk) {
    const from = Math.max(1, Math.floor(chunk.length * 0.4));
    let best = chunk.length - 1;
    let bestGap = -1;
    for (let k = from; k < chunk.length; k++) {
      const gap = chunk[k].s - chunk[k - 1].s;
      const bonus = CLAUSE_END.test(chunk[k - 1].t) ? 400 : 0;
      if (gap + bonus >= bestGap) {
        bestGap = gap + bonus;
        best = k;
      }
    }
    return best;
  }

  function wordsToCues(words) {
    if (!words.length) return [];
    const ends = words.filter((w) => isSentenceEnd(w.t)).length;
    const punctuated = ends / words.length > 1 / 60;
    const PAUSE_MS = punctuated ? 1500 : 650;
    const PAUSE_MIN_CHARS = punctuated ? 0 : 28;
    const SOFT_MAX = punctuated ? 84 : 64;
    const HARD_MAX = punctuated ? 120 : 96;

    const groups = [];
    let cur = [];
    const flush = () => {
      if (cur.length) groups.push(cur);
      cur = [];
    };

    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      const next = words[k + 1];

      if (NON_SPEECH.test(w.t)) {
        flush();
        groups.push([w]);
        continue;
      }
      cur.push(w);
      if (!next) break;

      const len = chunkLen(cur);
      const gap = next.s - w.s;
      if (isSentenceEnd(w.t) && cur.length >= 2) flush();
      else if (gap > PAUSE_MS && len >= PAUSE_MIN_CHARS) flush();
      else if (len >= SOFT_MAX && CLAUSE_END.test(w.t)) flush();
      else if (len >= HARD_MAX) {
        const at = bestSplit(cur);
        const rest = cur.slice(at);
        cur = cur.slice(0, at);
        flush();
        cur = rest;
      }
    }
    flush();

    return groups.map((g) => {
      const en = g.map((w) => w.t).join(' ');
      const cue = { s: g[0].s / 1000, e: 0, en, words: g.map((w) => ({ t: w.t, s: w.s / 1000 })) };
      if (g.length === 1 && NON_SPEECH.test(en)) cue.noSpeech = true;
      return cue;
    });
  }

  // ---- human-made tracks ----

  function eventsToCues(events) {
    const cues = [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const en = clean(ev.segs.map((s) => s.utf8 || '').join('')).replace(/^(>>+|-)\s*/, '');
      if (!en) continue;
      const s = (ev.tStartMs || 0) / 1000;
      const e = s + (ev.dDurationMs || 2000) / 1000;
      const last = cues[cues.length - 1];
      if (last && last.en === en && s - last.e < 0.1) {
        last.e = e; // rolling duplicates
        continue;
      }
      const cue = { s, e, en };
      if (NON_SPEECH.test(en)) cue.noSpeech = true;
      cues.push(cue);
    }
    return cues;
  }

  function mergeIntoSentences(cues) {
    const MAX_CHARS = 130;
    const MAX_DUR = 10;
    const MAX_GAP = 0.6;
    // A few closing words ("image to the next.") read better attached than alone on screen.
    const TAIL_CHARS = 28;
    const isTail = (c) => c.en.length <= TAIL_CHARS && isSentenceEnd(c.en);
    const out = [];
    for (const c of cues) {
      const last = out[out.length - 1];
      const canMerge =
        last &&
        !last.noSpeech &&
        !c.noSpeech &&
        !isSentenceEnd(last.en) &&
        c.s - last.e <= MAX_GAP &&
        last.en.length + 1 + c.en.length <= (isTail(c) ? MAX_CHARS + TAIL_CHARS : MAX_CHARS) &&
        c.e - last.s <= MAX_DUR;
      if (canMerge) {
        last.en = last.en + ' ' + c.en;
        last.e = c.e;
      } else {
        out.push({ ...c });
      }
    }
    return out;
  }

  // ---- sentence groups (the unit of translation) ----

  function groupCues(cues) {
    const MAX_CUES = 4;
    const MAX_CHARS = 340;
    const MAX_GAP = 0.9;
    const groups = [];
    let g = null;
    for (const c of cues) {
      const prev = g ? cues[g.to] : null;
      const joins =
        g &&
        !g.noSpeech &&
        !c.noSpeech &&
        !isSentenceEnd(prev.en) &&
        c.s - prev.e <= MAX_GAP &&
        g.to - g.from + 1 < MAX_CUES &&
        g.en.length + 1 + c.en.length <= MAX_CHARS;
      if (joins) {
        g.to = c.i;
        g.e = c.e;
        g.en += ' ' + c.en;
      } else {
        g = { i: groups.length, from: c.i, to: c.i, s: c.s, e: c.e, en: c.en };
        if (c.noSpeech) {
          g.noSpeech = true;
          g.zh = NON_SPEECH_ZH[c.en.replace(/[^a-z]/gi, '').toLowerCase()] || '';
        }
        groups.push(g);
      }
      c.g = g.i;
    }
    return groups;
  }

  // ---- entry point ----

  function parseJson3(json, opts = {}) {
    const events = (json && json.events) || [];
    const wordLevel = hasWordTiming(events);
    let cues;
    if (wordLevel) {
      cues = wordsToCues(collectWords(events));
    } else {
      cues = eventsToCues(events);
      if (opts.mergeSentences !== false) cues = mergeIntoSentences(cues);
    }

    cues.sort((a, b) => a.s - b.s);
    for (let k = 0; k < cues.length; k++) {
      const c = cues[k];
      const next = cues[k + 1];
      if (wordLevel) {
        const lastWord = c.words[c.words.length - 1];
        c.e = lastWord.s + 2.0;
      }
      if (next && next.s > c.s && c.e > next.s) c.e = next.s;
      if (c.e < c.s + 0.4) c.e = c.s + 0.4;
      c.i = k;
    }
    return { cues, groups: groupCues(cues), wordLevel };
  }

  // Last cue whose start <= t, or -1.
  function indexAt(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  globalThis.YDS = Object.assign(globalThis.YDS || {}, { parseJson3, indexAt });
})();
