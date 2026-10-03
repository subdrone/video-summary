/** 生成扩展图标 PNG（无第三方依赖）：紫色渐变圆角方块 + 白色菱形 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../extension/icons');
mkdirSync(outDir, { recursive: true });

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r0 = size * 0.22; // 圆角半径
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size, ny = (y + 0.5) / size;
      // 圆角矩形 alpha
      const dx = Math.max(r0 / size - nx, nx - (1 - r0 / size), 0);
      const dy = Math.max(r0 / size - ny, ny - (1 - r0 / size), 0);
      const outside = Math.hypot(dx, dy) * size - r0;
      let a = outside <= 0 ? 255 : outside > 1.2 ? 0 : Math.round(255 * (1 - outside / 1.2));
      // 渐变
      const t = (nx + ny) / 2;
      let R = Math.round(99 + (139 - 99) * t);
      let G = Math.round(102 + (92 - 102) * t);
      let B = Math.round(241 + (246 - 241) * t);
      // 白色菱形（✦ 意象）
      const d = Math.abs(nx - 0.5) + Math.abs(ny - 0.5);
      if (d < 0.2) {
        const edge = 0.2 - d;
        const w = Math.min(1, edge / 0.04);
        R = Math.round(R + (255 - R) * w);
        G = Math.round(G + (255 - G) * w);
        B = Math.round(B + (255 - B) * w);
      }
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = R; raw[i + 1] = G; raw[i + 2] = B; raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(outDir, `icon${size}.png`), makePng(size));
  console.log('生成', path.join(outDir, `icon${size}.png`));
}
