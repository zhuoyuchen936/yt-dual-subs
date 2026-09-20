// End-to-end check of the real service worker code against a running local model server.
//   node test/e2e-llm.mjs            (needs LM Studio's server on :1234; MODEL=<id> picks a model, else auto)
import fs from 'node:fs';
import vm from 'node:vm';
import { manualJson3, asrJson3 } from './helpers.mjs';

const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
let handler;
globalThis.chrome = {
  storage: { local: { get: async () => (process.env.MODEL ? { settings: { model: process.env.MODEL } } : {}), set: async () => {} }, onChanged: { addListener() {} } },
  runtime: { onMessage: { addListener: (fn) => (handler = fn) } }
};
globalThis.importScripts = (...files) => files.forEach((f) => vm.runInThisContext(src(f), { filename: f }));
vm.runInThisContext(src('background.js'), { filename: 'background.js' });
await import('../src/segment.js');

const call = (msg) => new Promise((resolve) => handler(msg, null, resolve));

const st = await call({ type: 'status' });
console.log('status:', st.connected ? `connected, model = ${st.active}, style = ${st.mt ? 'one sentence per request (translation model)' : 'numbered batch (general LLM)'}` : `OFFLINE (${st.error})`);
if (!st.connected) process.exit(1);

let failed = 0;
for (const [name, json] of [['human-made', manualJson3()], ['auto-generated', asrJson3()]]) {
  const { groups } = globalThis.YDS.parseJson3(json);
  const batch = groups.filter((g) => !g.noSpeech).slice(0, 10);
  const t0 = Date.now();
  const r = await call({
    type: 'translate',
    title: 'Why does a bicycle stay upright?',
    lines: batch.map((c) => c.en),
    before: [],
    after: groups.slice(11, 13).map((g) => g.en)
  });
  const ms = Date.now() - t0;
  if (!r.ok) {
    failed++;
    console.log(`\n[${name}] FAILED: ${r.error}`);
    continue;
  }
  const missing = r.zh.filter((z) => !z).length;
  if (missing) failed++;
  console.log(`\n[${name}] ${batch.length} lines in ${ms} ms, ${missing} missing`);
  batch.forEach((c, k) => console.log(`  ${c.en}\n  → ${r.zh[k]}`));
}

const t0 = Date.now();
const lk = await call({ type: 'lookup', text: 'effortless', sentence: 'Notice how strange it is that staying balanced feels so effortless.' });
console.log(`\n[lookup] ${Date.now() - t0} ms\n${lk.ok ? lk.text : 'FAILED: ' + lk.error}`);
process.exit(failed || !lk.ok ? 1 : 0);
