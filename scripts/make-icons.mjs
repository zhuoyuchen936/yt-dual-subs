// Draws the toolbar icons (two subtitle bars on a dark rounded square) with no dependencies.
import zlib from 'node:zlib';
import fs from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// Signed distance to a rounded rect, used for cheap anti-aliasing.
const sdf = (x, y, cx, cy, hw, hh, r) => {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const shapes = [
    { cx: 0.5, cy: 0.5, hw: 0.5, hh: 0.5, r: 0.22, color: [24, 24, 27] },
    { cx: 0.5, cy: 0.4, hw: 0.32, hh: 0.075, r: 0.075, color: [255, 255, 255] },
    { cx: 0.5, cy: 0.66, hw: 0.24, hh: 0.075, r: 0.075, color: [255, 214, 120] }
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rgb = [0, 0, 0];
      let alpha = 0;
      for (const s of shapes) {
        const d = sdf((x + 0.5) / size, (y + 0.5) / size, s.cx, s.cy, s.hw, s.hh, s.r) * size;
        const a = Math.max(0, Math.min(1, 0.5 - d));
        rgb = rgb.map((c, k) => c * (1 - a) + s.color[k] * a);
        alpha = alpha + (1 - alpha) * a;
      }
      const o = (y * size + x) * 4;
      px[o] = rgb[0];
      px[o + 1] = rgb[1];
      px[o + 2] = rgb[2];
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 48, 128]) fs.writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), draw(size));
console.log('icons written');
