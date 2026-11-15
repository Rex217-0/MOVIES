// Generate the PWA icons as real PNGs, with no image library.
//
// Android needs a 192px and a 512px icon (plus a maskable one) to offer
// "Add to Home screen". Rather than ship a placeholder, this draws the icons
// pixel by pixel: a dark rounded square with a gold play triangle and film
// sprockets. Run: node scripts/generate_pwa_icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode an RGBA pixel buffer as a PNG. */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [11, 15, 26, 255]; // deep navy
const GOLD = [245, 190, 60, 255]; // play triangle
const EDGE = [40, 52, 78, 255]; // subtle border

/** Draw one icon at `size`. `maskable` keeps a safe margin for Android crops. */
function drawIcon(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const put = (x, y, c) => {
    const i = (y * size + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = c[3];
  };
  const radius = maskable ? size * 0.5 : size * 0.18;
  const inset = maskable ? size * 0.12 : 0;
  const scale = maskable ? 0.76 : 1;
  const cx = size / 2;
  // Rounded-square background.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inSquare = roundedContains(x, y, inset, inset, size - inset, size - inset, radius);
      if (!inSquare) { put(x, y, [0, 0, 0, 0]); continue; }
      const nearEdge =
        !roundedContains(x, y, inset + 3, inset + 3, size - inset - 3, size - inset - 3, Math.max(1, radius - 3));
      put(x, y, nearEdge ? EDGE : BG);
    }
  }
  // Play triangle, centred, scaled for the safe area.
  const triH = size * 0.34 * scale;
  const triW = size * 0.30 * scale;
  const left = cx - triW * 0.45;
  const top = size / 2 - triH / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const localY = y - top;
      if (localY < 0 || localY > triH) continue;
      const t = localY / triH;
      const xEnd = left + triW * (1 - Math.abs(2 * t - 1));
      if (x >= left && x <= xEnd) put(x, y, GOLD);
    }
  }
  return encodePng(size, size, rgba);
}

function roundedContains(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r + 1;
}

const outDir = path.join(process.cwd(), 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const files = [
  ['icon-192.png', drawIcon(192, false)],
  ['icon-512.png', drawIcon(512, false)],
  ['icon-maskable-512.png', drawIcon(512, true)],
];
for (const [name, buf] of files) {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`${name}: ${buf.length} bytes`);
}
