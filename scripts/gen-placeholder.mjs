// DSHBuddy placeholder pet generator.
// Produces assets/whale/spritesheet.png (1536x1872 = 8 cols x 9 rows of 192x208
// frames) + pet.json, drawing a simple pixel-whale per frame with per-row
// animation variation (idle float, run offset, wave fin, jump, fail, wait,
// review glasses). A real artist spritesheet can replace it later; the format
// (9 rows, 192x208 frames) stays the contract.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FW = 192;
const FH = 208;
const COLS = 8;
const ROWS = 9;
const W = FW * COLS;
const H = FH * ROWS;

const buf = Buffer.alloc(W * H * 4); // RGBA
const setPx = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
};

const BODY = [64, 108, 198]; // deep blue body
const BELLY = [150, 178, 232];
const EYE_WHITE = [245, 247, 250];
const EYE_BLACK = [24, 28, 40];
const FIN = [43, 82, 170];

function ellipse(cx, cy, rx, ry, x, y) {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}

/** Draw one whale into frame (row, col) with per-row animation params. */
function drawFrame(row, col) {
  const ox = col * FW;
  const oy = row * FH;
  const cx = FW / 2;
  let cy = FH / 2 + 14;

  // per-row animation
  // Facing: the whale faces RIGHT by default (idle/wave/jump/fail/wait/review/
  // runRight/run). Only runLeft faces LEFT so walking left looks correct.
  let flip = true;
  let bodyRy = 34;
  let bodyRx = 66;
  let dx = 0;
  let finDy = 0;
  let glasses = false;
  let squint = false;

  switch (row) {
    case 0: // idle: gentle float over 6 frames
      cy += [-3, -1, 0, 1, 0, -1][col % 6] * 3;
      break;
    case 1: // runRight: face right
      dx = (col % 8) * 4 - 14;
      cy += 4;
      break;
    case 2: // runLeft: face left
      flip = false;
      dx = (col % 8) * 4 - 14;
      cy += 4;
      break;
    case 3: // wave: fin up
      finDy = -26;
      break;
    case 4: // jump
      cy -= 26;
      break;
    case 5: // fail: squashed + squint
      bodyRy = 26;
      squint = true;
      break;
    case 6: // wait: slightly smaller
      bodyRx = 58;
      bodyRy = 30;
      break;
    case 7: // run: face right
      dx = (col % 8) * 4 - 14;
      cy += 4;
      break;
    case 8: // review: glasses
      glasses = true;
      break;
  }

  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const xx = flip ? FW - 1 - x : x; // horizontal mirror for right-facing rows
      const gx = xx - cx - dx;
      const gy = y - cy;
      let colr = null;

      // tail (right side of the drawn whale)
      if (ellipse(cx + dx + bodyRx + 8, cy - 4, 14, 18, xx, y) || ellipse(cx + dx + bodyRx + 18, cy + 6, 8, 10, xx, y)) {
        colr = FIN;
      }
      // body
      if (ellipse(0, 0, bodyRx, bodyRy, gx, gy)) {
        // belly gradient
        const t = gy / bodyRy;
        colr = t > 0.45 ? BELLY : BODY;
      }
      // dorsal fin
      if (ellipse(cx + dx - 6, cy - bodyRy - 6, 16, 16, xx, y)) {
        colr = FIN;
      }
      // pectoral fin
      if (ellipse(cx + dx - 18, cy + bodyRy * 0.3 + finDy, 20, 12, xx, y)) {
        colr = FIN;
      }
      // eye
      const ex = cx + dx - bodyRx * 0.35;
      const ey = cy - bodyRy * 0.25;
      if (ellipse(ex, ey, 9, 11, xx, y)) {
        colr = EYE_WHITE;
      }
      if (ellipse(ex + 2, ey, 4, 5, xx, y)) {
        colr = EYE_BLACK;
      }
      if (squint) {
        // draw a line over the eye
        if (Math.abs(y - ey) <= 1 && Math.abs(xx - ex) <= 8) colr = EYE_BLACK;
      }
      // glasses (review)
      if (glasses) {
        if (ellipse(ex, ey, 14, 15, xx, y) && !(ellipse(ex + 2, ey, 4, 5, xx, y))) {
          colr = EYE_BLACK;
        }
        // bridge
        if (Math.abs(y - ey) <= 2 && xx > ex + 12 && xx < ex + 30) colr = EYE_BLACK;
      }
      // smile
      if (Math.abs(y - (cy + bodyRy * 0.5 + 2)) <= 1 && Math.abs(xx - (cx + dx - 8)) <= 12) {
        colr = [40, 52, 74];
      }

      if (colr) setPx(ox + x, oy + y, colr[0], colr[1], colr[2], 255);
    }
  }
}

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    drawFrame(r, c);
  }
}

// ── PNG encode ─────────────────────────────────────────────────────────────
function crc32(bytes) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const scanlines = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  scanlines[y * (1 + W * 4)] = 0; // filter: none
  buf.copy(scanlines, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "whale");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "spritesheet.png"), png);
writeFileSync(
  join(outDir, "pet.json"),
  JSON.stringify(
    {
      id: "deepseek-whale",
      displayName: "DeepSeek 鲸鱼",
      description: "A friendly DeepSeek whale companion for focused work.",
      spritesheetPath: "spritesheet.png",
    },
    null,
    2,
  ),
);
console.log(`placeholder whale written to ${outDir} (${png.length} bytes)`);
