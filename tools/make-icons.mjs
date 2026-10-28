// Draws the app icons (a light fork on ink: one line splitting into three)
// and saves them as PNGs, using only Node's built-in zlib.
//   node tools/make-icons.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "icons");
const TEAL = [25, 27, 27]; // ink
const WHITE = [246, 245, 241]; // paper

// The fork, in a 0..1 square: a stem that splits into three branches
const SEGMENTS = [
  [0.5, 0.86, 0.5, 0.56],
  [0.5, 0.56, 0.24, 0.24],
  [0.5, 0.56, 0.5, 0.2],
  [0.5, 0.56, 0.76, 0.24],
];
const DOTS = [[0.24, 0.24], [0.5, 0.2], [0.76, 0.24], [0.5, 0.86]];

function drawIcon(size, { maskable }) {
  const pixels = Buffer.alloc(size * size * 4);
  // Maskable icons get cropped to a circle or squircle, so keep the fork
  // inside the central safe zone and fill the whole square
  const scale = maskable ? 0.62 : 0.78;
  const offset = (1 - scale) / 2;
  const lineHalf = 0.045 * scale * size;
  const dotRadius = 0.075 * scale * size;
  const corner = maskable ? 0 : 0.22 * size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const background = maskable ? 1 : roundedRectCoverage(px, py, size, corner);
      if (background <= 0) continue;

      let d = Infinity;
      for (const [x1, y1, x2, y2] of SEGMENTS) {
        const a = [(offset + x1 * scale) * size, (offset + y1 * scale) * size];
        const b = [(offset + x2 * scale) * size, (offset + y2 * scale) * size];
        d = Math.min(d, segmentDistance(px, py, a, b) - lineHalf);
      }
      for (const [cx, cy] of DOTS) {
        d = Math.min(d, Math.hypot(px - (offset + cx * scale) * size, py - (offset + cy * scale) * size) - dotRadius);
      }
      const fork = clamp01(0.5 - d); // anti-aliased edge

      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) pixels[o + c] = Math.round(TEAL[c] + (WHITE[c] - TEAL[c]) * fork);
      pixels[o + 3] = Math.round(255 * background);
    }
  }
  return encodePng(size, size, pixels);
}

function roundedRectCoverage(x, y, size, r) {
  const dx = Math.max(r - x, x - (size - r), 0);
  const dy = Math.max(r - y, y - (size - r), 0);
  return clamp01(r + 0.5 - Math.hypot(dx, dy));
}

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  // Each row starts with filter type 0 (none)
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "icon-192.png"), drawIcon(192, { maskable: false }));
fs.writeFileSync(path.join(OUT, "icon-512.png"), drawIcon(512, { maskable: false }));
fs.writeFileSync(path.join(OUT, "maskable-512.png"), drawIcon(512, { maskable: true }));
console.log("Wrote icons/icon-192.png, icons/icon-512.png, icons/maskable-512.png");
