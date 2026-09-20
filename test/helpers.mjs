// Fixtures mirror the structure of YouTube's json3 captions (cue lengths, mid-sentence splits,
// word offsets), with text written for this repo. Stored compactly:
//   startMs|durationMs|text              (human-made track)
//   startMs|durationMs|word@offsetMs ... (auto-generated track)
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').trim().split('\n');

export function manualJson3() {
  return {
    events: read('manual.txt').map((line) => {
      const [s, d, ...rest] = line.split('|');
      return { tStartMs: +s, dDurationMs: +d, segs: [{ utf8: rest.join('|') }] };
    })
  };
}

export function asrJson3() {
  const events = [];
  for (const line of read('asr.txt')) {
    const [s, d, rest] = line.split('|');
    const segs = rest.split(' ').map((tok, k) => {
      const at = tok.lastIndexOf('@');
      const seg = { utf8: (k ? ' ' : '') + tok.slice(0, at), acAsrConf: 0 };
      if (+tok.slice(at + 1)) seg.tOffsetMs = +tok.slice(at + 1);
      return seg;
    });
    events.push({ tStartMs: +s, dDurationMs: +d, wWinId: 1, segs });
    events.push({ tStartMs: +s + +d - 10, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] }); // the player's line breaks
  }
  return { events };
}
