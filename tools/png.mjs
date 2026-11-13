// png.mjs — codificador PNG mínimo (RGBA) para las capturas de las pruebas
import fs from 'node:fs'; import zlib from 'node:zlib';
export const png = (s, f) => {
  const raw = Buffer.alloc((s.w * 4 + 1) * s.h);
  for (let y = 0; y < s.h; y++) Buffer.from(s.rgba.buffer, s.rgba.byteOffset + y * s.w * 4, s.w * 4).copy(raw, y * (s.w * 4 + 1) + 1);
  const T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(s.w, 0); ih.writeUInt32BE(s.h, 4); ih[8] = 8; ih[9] = 6;
  fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]));
};
