// Side-by-side comparison of local models on subtitle-style text.
//   node test/bench-models.mjs hy-mt2-1.8b milmmt-46-1b-v1.0 qwen/qwen3.6-35b-a3b
// Each model is driven the way the extension would drive it (chosen by name):
//   Hy-MT family  -> one sentence per request, vendor "background + source" template, 4 in flight
//   MiLMMT family -> one sentence per request, raw completion prompt (the model has no chat format)
//   anything else -> one numbered batch per clip with a system prompt
// The clips are written for this repo. They lean on what makes subtitles hard: spoken idioms,
// references that only make sense with the previous line, and unpunctuated speech recognition.
// With GPU=1 (macOS) each model also runs the clips in a loop for ~10 s while GPU utilisation is sampled,
// giving "GPU-seconds per 100 sentences": how much of the GPU a model really costs, not just how long it takes.
import { execFile } from 'node:child_process';
await import('../src/translate-core.js');
const { buildTranslatePrompt, parseNumbered, isMtModel, MT_SAMPLING, buildMtPrompt, cleanMtOutput } = globalThis.YDS;

const API = process.env.API_BASE || 'http://localhost:1234/v1';
const models = process.argv.slice(2);
if (!models.length) {
  console.error('usage: node test/bench-models.mjs <model> [<model> ...]');
  process.exit(1);
}
const settings = { targetLang: '简体中文', extraPrompt: '' };

const CLIPS = [
  {
    title: 'Git rebase explained',
    lines: [
      'Alright, so last time we left off with a pretty messy branch.',
      "Today I'm going to show you how to clean it up before you push.",
      "It's not as scary as people make it sound.",
      'You just run rebase with the interactive flag, and it opens up your editor.',
      'From there you can squash these two into one.',
      "If anything blows up, don't panic, you can always bail out with abort."
    ]
  },
  {
    title: 'Weeknight fried rice',
    lines: [
      'Day-old rice is the secret here, fresh rice just turns to mush.',
      'Get your pan ripping hot before anything goes in.',
      'Push the rice to the side and grab your eggs.',
      "I'm going to crack two of these right into the middle.",
      "Give it a quick toss, and we're pretty much good to go."
    ]
  },
  {
    title: 'Why is the sky blue',
    lines: [
      'so why does the sky look blue in the first place',
      'it turns out shorter wavelengths get scattered way more than longer ones',
      'which is also why sunsets end up looking red',
      'that one kind of blew my mind when i first learned it'
    ]
  }
];

async function post(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 300));
  return j;
}

async function pool(n, jobs) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (next < jobs.length) { const k = next++; out[k] = await jobs[k](); } }));
  return out;
}

const STRATEGIES = {
  async mt(model, clip) {
    return pool(4, clip.lines.map((text, k) => async () => {
      const messages = buildMtPrompt(settings, { title: clip.title, context: clip.lines.slice(Math.max(0, k - 2), k), text });
      const j = await post('/chat/completions', { model, messages, max_tokens: 300, ...MT_SAMPLING });
      return cleanMtOutput(j.choices[0].message.content);
    }));
  },
  async completion(model, clip) {
    return pool(4, clip.lines.map((text) => async () => {
      const prompt = `Translate this from English to Chinese (Simplified):\nEnglish: ${text}\nChinese (Simplified):`;
      const j = await post('/completions', { model, prompt, max_tokens: 300, temperature: 0, stop: ['\n'] });
      return cleanMtOutput(j.choices[0].text);
    }));
  },
  async chat(model, clip) {
    const messages = buildTranslatePrompt(settings, { title: clip.title, lines: clip.lines, before: [], after: [] });
    const j = await post('/chat/completions', { model, messages, max_tokens: 1500, temperature: 0.2, reasoning_effort: 'none' });
    return parseNumbered(j.choices[0].message.content, clip.lines.length);
  }
};
const strategyFor = (model) => (isMtModel(model) ? 'mt' : /milmmt|gemmax/i.test(model) ? 'completion' : 'chat');

const results = {};
for (const model of models) {
  const strategy = process.env.STRATEGY || strategyFor(model);
  await STRATEGIES[strategy](model, { title: 'warm-up', lines: ['Hello there.'] }); // load the model before timing
  const t0 = Date.now();
  const zh = [];
  for (const clip of CLIPS) zh.push(...(await STRATEGIES[strategy](model, clip)));
  results[model] = { strategy, ms: Date.now() - t0, zh };
}

// ---- optional: sustained GPU load (macOS, no sudo needed) ----

const gpuUtil = () =>
  new Promise((resolve) =>
    execFile('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { maxBuffer: 1 << 22 }, (err, out) => {
      const m = !err && /"Device Utilization %"=(\d+)/.exec(out);
      resolve(m ? Number(m[1]) : null);
    })
  );

async function sustained(model, strategy, seconds) {
  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const u = await gpuUtil();
      if (u != null) samples.push(u);
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  const t0 = Date.now();
  let sentences = 0;
  while (Date.now() - t0 < seconds * 1000) {
    for (const clip of CLIPS) {
      await STRATEGIES[strategy](model, clip);
      sentences += clip.lines.length;
    }
  }
  const elapsed = (Date.now() - t0) / 1000;
  sampling = false;
  await sampler;
  const avg = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  return { sentences, elapsed, avg, peak: Math.max(0, ...samples), gpuSecPer100: ((avg / 100) * elapsed * 100) / sentences };
}

if (process.env.GPU) {
  const idle = [];
  for (let k = 0; k < 8; k++) { idle.push(await gpuUtil()); await new Promise((r) => setTimeout(r, 200)); }
  console.log(`GPU idle baseline: ${(idle.reduce((a, b) => a + b, 0) / idle.length).toFixed(0)} %`);
  for (const model of models) {
    const strategy = results[model].strategy;
    await STRATEGIES[strategy](model, { title: 'warm-up', lines: ['Hello there.'] });
    const r = await sustained(model, strategy, Number(process.env.GPU) > 1 ? Number(process.env.GPU) : 10);
    console.log(
      `${model}: ${(r.sentences / r.elapsed).toFixed(1)} sentences/s, GPU avg ${r.avg.toFixed(0)} % (peak ${r.peak} %), ` +
        `${r.gpuSecPer100.toFixed(1)} GPU-seconds per 100 sentences`
    );
  }
  console.log('');
}

const total = CLIPS.reduce((a, c) => a + c.lines.length, 0);
console.log(models.map((m) => `${m}: ${results[m].strategy}, ${results[m].ms} ms for ${total} sentences`).join('\n'));
let k = 0;
for (const clip of CLIPS) {
  console.log(`\n### ${clip.title}`);
  for (const line of clip.lines) {
    console.log(`\n${k + 1}. ${line}`);
    for (const m of models) console.log(`   [${m.split('/').pop().slice(0, 14).padEnd(14)}] ${results[m].zh[k] ?? '∅'}`);
    k++;
  }
}
