// Renders the README charts from docs/charts/data.json as static SVG, one light and one dark variant each
// (GitHub picks between them with <picture media="(prefers-color-scheme: dark)">). No dependencies.
import fs from 'node:fs';

const dir = new URL('../docs/charts/', import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL('data.json', dir), 'utf8'));

const THEMES = {
  light: { surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', bar: '#2a78d6', border: 'rgba(11,11,11,0.10)' },
  dark: { surface: '#1a1a19', ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', bar: '#3987e5', border: 'rgba(255,255,255,0.10)' }
};
// Status colours are fixed across modes; the glyph ink is picked by the fill's luminance.
const STATUS = {
  ok: { fill: '#0ca30c', ink: '#ffffff', glyph: '✓', label: '正确、自然' },
  flawed: { fill: '#fab219', ink: '#0b0b0b', glyph: '△', label: '看得懂，但直译 / 用词不当' },
  wrong: { fill: '#d03b3b', ink: '#ffffff', glyph: '✗', label: '意思错了' }
};
const FONT = `system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function frame(w, h, t, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" font-family="${FONT}">
<title>${esc(title)}</title><desc>${esc(desc)}</desc>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${t.surface}" stroke="${t.border}"/>
${body}
</svg>
`;
}

// A bar that is square at the baseline and rounded (4px) at the data end.
function bar(x, y, len, thick, fill) {
  const r = Math.min(4, len);
  return `<path d="M${x},${y} h${len - r} a${r},${r} 0 0 1 ${r},${r} v${thick - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${len - r} z" fill="${fill}"/>`;
}

// ---- chart 1: resources, one column of bars per measure (each with its own scale) ----

function resources(t) {
  const measures = [
    { key: 'memoryGB', title: '常驻内存', unit: 'GB', fmt: (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1)) },
    { key: 'secondsPer15', title: '翻译 15 句耗时', unit: '秒', fmt: (v) => v.toFixed(1) },
    { key: 'gpuSecPer100', title: '每 100 句占用 GPU', unit: 'GPU·秒', fmt: (v) => v.toFixed(1) }
  ];
  const W = 960, labelW = 190, colW = 250, barMax = 170, rowH = 44, top = 96, thick = 14;
  const H = top + data.models.length * rowH + 40;
  let g = `<text x="24" y="34" font-size="17" font-weight="600" fill="${t.ink}">三项硬件开销：条越短越省</text>
<text x="24" y="56" font-size="13" fill="${t.ink2}">Apple M5 Pro · 同一组 15 句口语化字幕 · 每列各自的刻度</text>`;
  measures.forEach((m, c) => {
    const x0 = labelW + c * colW;
    const max = Math.max(...data.models.map((d) => d[m.key] || 0));
    g += `<text x="${x0}" y="${top - 14}" font-size="13" font-weight="600" fill="${t.ink}">${m.title}<tspan font-weight="400" fill="${t.muted}">  ${m.unit}</tspan></text>`;
    g += `<line x1="${x0}" y1="${top - 4}" x2="${x0}" y2="${top + data.models.length * rowH - 8}" stroke="${t.axis}"/>`;
    data.models.forEach((d, r) => {
      const y = top + r * rowH + (rowH - 8 - thick) / 2;
      const v = d[m.key];
      if (v == null) {
        g += `<text x="${x0 + 8}" y="${y + thick - 2}" font-size="12" fill="${t.muted}">未测</text>`;
        return;
      }
      const len = Math.max(3, (v / max) * barMax);
      g += bar(x0, y, len, thick, t.bar);
      g += `<text x="${x0 + len + 8}" y="${y + thick - 2}" font-size="13" fill="${t.ink}" font-variant-numeric="tabular-nums">${m.fmt(v)}</text>`;
    });
  });
  data.models.forEach((d, r) => {
    const y = top + r * rowH;
    if (r) g += `<line x1="24" y1="${y - 4}" x2="${W - 24}" y2="${y - 4}" stroke="${t.grid}"/>`;
    g += `<text x="24" y="${y + 14}" font-size="13" font-weight="600" fill="${t.ink}">${esc(d.id)}</text>`;
    g += `<text x="24" y="${y + 30}" font-size="11.5" fill="${t.muted}">${esc(d.kind)}</text>`;
  });
  g += `<text x="24" y="${H - 16}" font-size="11.5" fill="${t.muted}">「每 100 句占用 GPU」= 连续翻译约 10 秒期间的平均 GPU 利用率 × 耗时 ÷ 句数。milmmt 测完即移除，没有采样 GPU。</text>`;
  const desc = data.models.map((d) => `${d.id}: ${d.memoryGB} GB, ${d.secondsPer15} s, ${d.gpuSecPer100 ?? 'n/a'} GPU-s`).join('; ');
  return frame(W, H, t, '各模型的内存、耗时与 GPU 开销', desc, g);
}

// ---- chart 2: per-sentence quality scorecard ----

function quality(t) {
  const W = 960, labelW = 330, cellW = 140, cellH = 24, gap = 2, top = 128;
  const x0 = labelW + 24;
  const rows = data.clips.reduce((a, c) => a + c.rows.length, 0);
  const H = top + rows * (cellH + gap) + data.clips.length * 26 + 78;
  let g = `<text x="24" y="34" font-size="17" font-weight="600" fill="${t.ink}">逐句质量：每个模型在哪一句出错</text>
<text x="24" y="56" font-size="13" fill="${t.ink2}">15 句刻意挑难的口语字幕（习语、依赖上一句的指代、无标点）· 单次运行 · 对照原文逐句评判，非自动指标</text>`;
  // legend: the glyph and label carry the meaning, colour only reinforces it
  let lx = 24;
  for (const s of Object.values(STATUS)) {
    g += `<rect x="${lx}" y="72" width="22" height="18" rx="3" fill="${s.fill}"/><text x="${lx + 11}" y="85.5" font-size="12" font-weight="700" text-anchor="middle" fill="${s.ink}">${s.glyph}</text>`;
    g += `<text x="${lx + 30}" y="85.5" font-size="12.5" fill="${t.ink2}">${s.label}</text>`;
    lx += 30 + s.label.length * 12.5 + 28;
  }
  data.models.forEach((d, c) => {
    g += `<text x="${x0 + c * (cellW + gap) + cellW / 2}" y="${top - 12}" font-size="12.5" font-weight="600" text-anchor="middle" fill="${t.ink}">${esc(d.id)}</text>`;
  });
  const totals = data.models.map(() => ({ ok: 0, flawed: 0, wrong: 0 }));
  let y = top;
  for (const clip of data.clips) {
    g += `<text x="24" y="${y + 16}" font-size="12" font-weight="600" fill="${t.muted}">${esc(clip.title)}</text>`;
    y += 26;
    for (const row of clip.rows) {
      g += `<text x="40" y="${y + 16.5}" font-size="12.5" text-anchor="end" fill="${t.muted}" font-variant-numeric="tabular-nums">${row.n}</text>`;
      g += `<text x="50" y="${y + 16.5}" font-size="12.5" fill="${t.ink2}">${esc(row.probe)}</text>`;
      row.ratings.split(' ').forEach((r, c) => {
        const s = STATUS[r];
        totals[c][r]++;
        const x = x0 + c * (cellW + gap);
        g += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" fill="${s.fill}"><title>${esc(data.models[c].id)} · ${row.n}: ${s.label}</title></rect>`;
        g += `<text x="${x + cellW / 2}" y="${y + 17}" font-size="13" font-weight="700" text-anchor="middle" fill="${s.ink}">${s.glyph}</text>`;
      });
      y += cellH + gap;
    }
  }
  y += 14;
  g += `<line x1="24" y1="${y - 8}" x2="${W - 24}" y2="${y - 8}" stroke="${t.axis}"/>`;
  g += `<text x="24" y="${y + 14}" font-size="13" font-weight="600" fill="${t.ink}">合计（✓ / △ / ✗）</text>`;
  totals.forEach((n, c) => {
    g += `<text x="${x0 + c * (cellW + gap) + cellW / 2}" y="${y + 14}" font-size="14" font-weight="600" text-anchor="middle" fill="${t.ink}" font-variant-numeric="tabular-nums">${n.ok} / ${n.flawed} / ${n.wrong}</text>`;
  });
  const desc = data.models.map((d, c) => `${d.id}: ${totals[c].ok} correct, ${totals[c].flawed} flawed, ${totals[c].wrong} wrong`).join('; ');
  return { svg: frame(W, y + 40, t, '逐句翻译质量评分', desc, g), totals };
}

let totals;
for (const [name, t] of Object.entries(THEMES)) {
  fs.writeFileSync(new URL(`resources-${name}.svg`, dir), resources(t));
  const q = quality(t);
  totals = q.totals;
  fs.writeFileSync(new URL(`quality-${name}.svg`, dir), q.svg);
}
console.log(data.models.map((d, c) => `${d.id}: ✓${totals[c].ok} △${totals[c].flawed} ✗${totals[c].wrong}`).join('\n'));
