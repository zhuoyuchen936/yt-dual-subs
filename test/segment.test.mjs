import test from 'node:test';
import assert from 'node:assert/strict';
import { manualJson3, asrJson3 } from './helpers.mjs';
await import('../src/segment.js');
await import('../src/translate-core.js');
const { parseJson3, indexAt, parseNumbered, buildTranslatePrompt, isMtModel, buildMtPrompt, buildMtLookupPrompt, cleanMtOutput } = globalThis.YDS;

const checkTimeline = (cues) => {
  cues.forEach((c, k) => {
    assert.equal(c.i, k);
    assert.ok(c.e > c.s, `cue ${k} has positive duration`);
    if (k) assert.ok(c.s >= cues[k - 1].e - 1e-9, `cue ${k} does not overlap the previous one`);
  });
};

test('auto-generated track: words are regrouped into sentences', () => {
  const { cues, wordLevel } = parseJson3(asrJson3());
  assert.equal(wordLevel, true);
  checkTimeline(cues);
  assert.deepEqual(cues[0], { s: 0, e: 2, en: '[Music]', words: [{ t: '[Music]', s: 0 }], noSpeech: true, i: 0, g: 0 });
  assert.equal(cues[1].en, 'This is a bicycle.');
  assert.equal(cues[1].s, 4.4);
  assert.equal(cues[2].en, "It's surprisingly simple and built from only a few parts like wheels and pedals.");
  assert.equal(cues[3].en, 'But your body has no trouble keeping it up and rolling.');
  assert.ok(cues.every((c) => c.en.length <= 130), 'no cue is too long to read');
  assert.ok(!cues.some((c) => c.en.includes('\n')));
  // word timings survive, for the karaoke highlight
  assert.deepEqual(cues[1].words.map((w) => w.s), [4.4, 4.799, 4.96, 5.2]);
});

test('auto-generated track without punctuation falls back to pauses and length', () => {
  const json = asrJson3();
  for (const ev of json.events) for (const seg of ev.segs) seg.utf8 = seg.utf8.replace(/[.,]/g, '');
  const { cues } = parseJson3(json);
  checkTimeline(cues);
  const speech = cues.filter((c) => !c.noSpeech);
  assert.ok(speech.length >= 8, `split into readable chunks (got ${speech.length})`);
  assert.ok(speech.every((c) => c.en.length <= 110));
});

test('human-made track: fragments are merged up to the end of the sentence', () => {
  const { cues, wordLevel } = parseJson3(manualJson3());
  assert.equal(wordLevel, false);
  checkTimeline(cues);
  assert.equal(cues[0].en, 'This is a bicycle.');
  assert.equal(cues[3].en, 'And I want you to pause for a second and notice how strange it is that staying balanced feels so effortless.');
  assert.equal(cues[3].s, 14.34);
  assert.equal(cues[3].e, 18.96);
  // a short sentence tail is attached rather than left alone on screen
  assert.match(cues[4].en, /^I mean, a child, .* from one rider to the next\.$/);
  assert.ok(cues.every((c) => c.en.length <= 160));
});

test('human-made track: merging can be turned off', () => {
  const { cues } = parseJson3(manualJson3(), { mergeSentences: false });
  assert.equal(cues.length, 24);
});

test('cues of one sentence share a translation group', () => {
  for (const json of [manualJson3(), asrJson3()]) {
    const { cues, groups } = parseJson3(json);
    // every cue belongs to exactly one group, groups are contiguous and cover everything
    groups.forEach((g, k) => {
      assert.equal(g.i, k);
      assert.equal(g.from, k ? groups[k - 1].to + 1 : 0);
      assert.equal(g.en, cues.slice(g.from, g.to + 1).map((c) => c.en).join(' '));
      assert.equal(g.s, cues[g.from].s);
      assert.equal(g.e, cues[g.to].e);
      for (let j = g.from; j <= g.to; j++) assert.equal(cues[j].g, k);
      assert.ok(g.en.length <= 340);
    });
    assert.equal(groups[groups.length - 1].to, cues.length - 1);
  }

  const { groups } = parseJson3(manualJson3());
  const split = groups.find((g) => g.en.startsWith('The tiny steering corrections'));
  assert.equal(split.to - split.from, 1, 'a sentence spread over two cues is translated as one');
  assert.match(split.en, /when you ride fast\.$/);

  const asr = parseJson3(asrJson3()).groups;
  assert.deepEqual([asr[0].noSpeech, asr[0].zh], [true, '[音乐]']);
  assert.equal(asr[1].zh, undefined);
});

test('indexAt finds the last cue that has started', () => {
  const { cues } = parseJson3(manualJson3());
  assert.equal(indexAt(cues, 0), -1);
  assert.equal(indexAt(cues, 4.22), 0);
  assert.equal(indexAt(cues, 15), 3);
  assert.equal(indexAt(cues, 9999), cues.length - 1);
});

test('parseNumbered tolerates the ways models format a numbered list', () => {
  assert.deepEqual(parseNumbered('1. 你好\n2. 世界', 2), ['你好', '世界']);
  assert.deepEqual(parseNumbered('```\n1、你好\n2：世界\n```', 2), ['你好', '世界']);
  assert.deepEqual(parseNumbered('好的，译文如下：\n1. 你好\n3. 多余\n', 2), ['你好', null]);
  assert.deepEqual(parseNumbered('(1) 你好\n[2] 世界', 2), ['你好', '世界']);
  assert.deepEqual(parseNumbered('你好', 1), ['你好']);
  assert.deepEqual(parseNumbered('1. 3.14 是圆周率', 1), ['3.14 是圆周率']);
});

test('buildTranslatePrompt numbers the lines and separates context', () => {
  const [sys, user] = buildTranslatePrompt({ targetLang: '简体中文', extraPrompt: '' }, { title: 'T', lines: ['a', 'b'], before: ['x'], after: [] });
  assert.match(sys.content, /简体中文/);
  assert.match(user.content, /【前文/);
  assert.doesNotMatch(user.content, /【后文/);
  assert.match(user.content, /1\. a\n2\. b$/);
});

test('dedicated translation models are recognised by name', () => {
  for (const id of ['hy-mt2-1.8b', 'tencent/Hy-MT2-7B-GGUF', 'HY-MT1.5-1.8B', 'hunyuan-mt-7b']) assert.ok(isMtModel(id), id);
  for (const id of ['qwen/qwen3.6-35b-a3b', 'gemma-3-4b', '', undefined]) assert.ok(!isMtModel(id), String(id));
});

test('translation-model prompts: one user message in the vendor template, no system prompt', () => {
  const settings = { targetLang: '简体中文', extraPrompt: '' };
  const withContext = buildMtPrompt(settings, { title: 'T', context: ['first.', 'second.'], text: 'third.' });
  assert.equal(withContext.length, 1);
  assert.equal(withContext[0].role, 'user');
  assert.equal(
    withContext[0].content,
    '【背景信息】\n视频标题：T\n上文：first.\n上文：second.\n\n请结合背景信息将以下文本翻译为简体中文。\n\n【待翻译文本】\nthird.'
  );
  const bare = buildMtPrompt(settings, { title: '', context: [], text: 'hello' });
  assert.equal(bare[0].content, '将以下文本翻译为简体中文，注意只需要输出翻译后的结果，不要额外解释：\n\nhello');
  assert.match(buildMtPrompt({ ...settings, extraPrompt: '术语保留英文' }, { text: 'x' })[0].content, /翻译要求：术语保留英文/);
  assert.match(buildMtLookupPrompt(settings, { text: 'frame', sentence: 'A light frame.' })[0].content, /^【背景信息】\nA light frame\.\n[\s\S]*【待翻译文本】\nframe$/);
});

test('cleanMtOutput flattens the reply to one subtitle line', () => {
  assert.equal(cleanMtOutput(' 这是一辆\n自行车。 \n'), '这是一辆 自行车。');
  assert.equal(cleanMtOutput('译文：你好'), '你好');
  assert.equal(cleanMtOutput(null), '');
});
