/* 生成迅雷版插件图标（橙色渐变 + 白色闪电箭头），纯 Node 标准库，无依赖。
 * 运行：node make_icons.mjs（在本目录执行，输出 icons/icon16|48|128.png）
 * 注：PNG 为本地图标资产生成工具，路径全部为固定字面量。 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function render(size, ss = 4) {
  const n = size * ss;
  const buf = new Uint8Array(n * n * 4);
  const c1 = [0xff, 0x8a, 0x3d], c2 = [0xe8, 0x59, 0x0c]; // #ff8a3d → #e8590c
  const rBg = 0.24;
  for (let y = 0; y < n; y++) {
    const fy = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const fx = (x + 0.5) / n;
      // 圆角方块覆盖
      const cx = clamp(fx, rBg, 1 - rBg), cy = clamp(fy, rBg, 1 - rBg);
      const cov = clamp((rBg - Math.hypot(fx - cx, fy - cy)) * n / 1.2, 0, 1);
      if (cov <= 0) continue;
      // 白色闪电箭头（简单折线多边形）：三条粗线段拼成 ⚡
      // 锚点：(0.58,0.24)→(0.36,0.55)→(0.50,0.55)→(0.42,0.80)→(0.66,0.47)→(0.52,0.47)→(0.58,0.24)
      const seg = (ax, ay, bx, by, w) => {
        const abx = bx - ax, aby = by - ay;
        const t = clamp(((fx - ax) * abx + (fy - ay) * aby) / (abx * abx + aby * aby), 0, 1);
        return Math.hypot(fx - (ax + abx * t), fy - (ay + aby * t)) - w / 2;
      };
      const bolt = Math.min(
        seg(0.58, 0.24, 0.36, 0.55, 0.09),
        seg(0.36, 0.55, 0.50, 0.55, 0.09),
        seg(0.50, 0.55, 0.42, 0.80, 0.09),
        seg(0.42, 0.80, 0.66, 0.47, 0.09),
        seg(0.66, 0.47, 0.52, 0.47, 0.09),
        seg(0.52, 0.47, 0.58, 0.24, 0.09)
      );
      const aWhite = clamp(-bolt * n / 1.2, 0, 1);
      const i = (y * n + x) * 4;
      const t = (fx + fy) / 2;
      buf[i] = Math.round((c1[0] + (c2[0] - c1[0]) * t) * (1 - aWhite) + 255 * aWhite);
      buf[i + 1] = Math.round((c1[1] + (c2[1] - c1[1]) * t) * (1 - aWhite) + 255 * aWhite);
      buf[i + 2] = Math.round((c1[2] + (c2[2] - c1[2]) * t) * (1 - aWhite) + 255 * aWhite);
      buf[i + 3] = Math.round(255 * cov);
    }
  }
  // 超采样降采样
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const j = ((y * ss + dy) * n + x * ss + dx) * 4;
          for (let k = 0; k < 4; k++) acc[k] += buf[j + k];
        }
      }
      const o = (y * size + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = acc[k] / (ss * ss);
    }
  }
  return out;
}

function pngBytes(size, rgba) {
  const raw = Buffer.alloc((size + 1) * size * 4 + 1 - 1); // 每行前缀 1 字节 filter=0
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]), Buffer.from(rgba.slice(y * size * 4, (y + 1) * size * 4)));
  }
  const rawAll = Buffer.concat(rows);
  const crcTable = [];
  for (let n2 = 0; n2 < 256; n2++) {
    let c = n2;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n2] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rawAll, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync('icons', { recursive: true });
writeFileSync('icons/icon16.png', pngBytes(16, render(16)));
writeFileSync('icons/icon48.png', pngBytes(48, render(48)));
writeFileSync('icons/icon128.png', pngBytes(128, render(128)));
console.log('icons: icon16/48/128.png done (orange bolt)');
