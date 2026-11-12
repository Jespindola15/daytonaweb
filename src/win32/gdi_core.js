// gdi_core.js — modelo GDI real sobre memoria emulada.
// Un DC apunta a un "target" con píxeles reales: una superficie DirectDraw (GetDC de la superficie
// o GetDC de la ventana en pantalla completa) o un bitmap (DIB/DDB seleccionado en un memory DC).
// SetPixel/GetPixel/BitBlt/StretchBlt/StretchDIBits/GetDIBits leen y escriben esos píxeles con la
// conversión de color que haría Windows (match a la paleta en 8 bpp, 5-6-5 en 16 bpp, etc.).

export const STOCK = 0x8000; // GetStockObject(i) = STOCK + i

export function G(emu) {
  if (!emu.state.gdi) emu.state.gdi = { objs: new Map(), next: 0x20000, stats: { setPixel: 0, getPixel: 0, bitblt: 0, stretch: 0, dib: 0, text: 0 } };
  return emu.state.gdi;
}
export function newGdi(emu, obj) { const g = G(emu); const h = g.next; g.next += 4; g.objs.set(h, obj); return h; }
export function gdiObj(emu, h) { return G(emu).objs.get(h); }

// ---------- paletas ----------
const nearestCache = new WeakMap();
export function nearestIndex(pal, r, g, b) {
  let cache = nearestCache.get(pal);
  if (!cache) { cache = new Map(); nearestCache.set(pal, cache); }
  const key = (r << 16) | (g << 8) | b;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let best = 0, bd = Infinity;
  for (let i = 0; i < 256; i++) {
    const dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; best = i; if (!d) break; }
  }
  if (cache.size > 65536) cache.clear();
  cache.set(key, best);
  return best;
}
export function palEqual(a, b, n = 256) { if (a === b) return true; if (!a || !b) return false; for (let i = 0; i < n * 3; i++) if (a[i] !== b[i]) return false; return true; }

// ---------- vistas de píxeles ----------
// view: { w, h, bpp, pitch, base(addr fila 0), stepY (+pitch o -pitch), pal (Uint8Array 768 o null), masks }
export function surfaceView(emu, surf) {
  return { w: surf.w, h: surf.h, bpp: surf.bpp, pitch: surf.pitch, base: surf.mem, stepY: surf.pitch, pal: surf.bpp <= 8 ? emu.ddPaletteOf(surf) : null, fmt16: 565, surf };
}
export function bitmapView(emu, bmp) {
  const bottomUp = bmp.height > 0;
  const h = Math.abs(bmp.height);
  return { w: bmp.w, h, bpp: bmp.bpp, pitch: bmp.pitch, base: bottomUp ? bmp.bits + (h - 1) * bmp.pitch : bmp.bits, stepY: bottomUp ? -bmp.pitch : bmp.pitch, pal: bmp.pal, fmt16: bmp.fmt16 || 555, bmp };
}
export function dcView(emu, dc) {
  if (!dc) return null;
  if (dc.kind === 'surface') return dc.surf ? surfaceView(emu, dc.surf) : null;
  if (dc.kind === 'screen' || dc.kind === 'window') { const p = emu.state.dd?.primary; return p ? surfaceView(emu, p) : null; }
  if (dc.kind === 'mem') { const b = gdiObj(emu, dc.bitmap); return b && b.type === 'bitmap' && b.bits ? bitmapView(emu, b) : null; }
  return null;
}

export function readRaw(u8, v, x, y) {
  const row = v.base + y * v.stepY;
  switch (v.bpp) {
    case 1: return (u8[row + (x >> 3)] >> (7 - (x & 7))) & 1;
    case 4: return (u8[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15;
    case 8: return u8[row + x];
    case 16: return u8[row + x * 2] | (u8[row + x * 2 + 1] << 8);
    case 24: return u8[row + x * 3] | (u8[row + x * 3 + 1] << 8) | (u8[row + x * 3 + 2] << 16);
    default: return (u8[row + x * 4] | (u8[row + x * 4 + 1] << 8) | (u8[row + x * 4 + 2] << 16)) >>> 0;
  }
}
export function writeRaw(u8, v, x, y, val) {
  const row = v.base + y * v.stepY;
  switch (v.bpp) {
    case 1: { const o = row + (x >> 3), b = 7 - (x & 7); u8[o] = (u8[o] & ~(1 << b)) | ((val & 1) << b); return; }
    case 4: { const o = row + (x >> 1); u8[o] = x & 1 ? (u8[o] & 0xf0) | (val & 15) : (u8[o] & 0x0f) | ((val & 15) << 4); return; }
    case 8: u8[row + x] = val; return;
    case 16: u8[row + x * 2] = val; u8[row + x * 2 + 1] = val >> 8; return;
    case 24: u8[row + x * 3] = val; u8[row + x * 3 + 1] = val >> 8; u8[row + x * 3 + 2] = val >> 16; return;
    default: u8[row + x * 4] = val; u8[row + x * 4 + 1] = val >> 8; u8[row + x * 4 + 2] = val >> 16; u8[row + x * 4 + 3] = 0; return;
  }
}
// raw -> COLORREF (0x00BBGGRR)
export function rawToRef(v, raw) {
  let r, g, b;
  if (v.bpp <= 8) { const p = v.pal; const i = raw * 3; r = p ? p[i] : raw; g = p ? p[i + 1] : raw; b = p ? p[i + 2] : raw; }
  else if (v.bpp === 16) {
    if (v.fmt16 === 565) { r = ((raw >> 11) & 31) * 255 / 31; g = ((raw >> 5) & 63) * 255 / 63; b = (raw & 31) * 255 / 31; }
    else { r = ((raw >> 10) & 31) * 255 / 31; g = ((raw >> 5) & 31) * 255 / 31; b = (raw & 31) * 255 / 31; }
    r = Math.round(r); g = Math.round(g); b = Math.round(b);
  } else { r = (raw >> 16) & 255; g = (raw >> 8) & 255; b = raw & 255; }
  return (r | (g << 8) | (b << 16)) >>> 0;
}
export function refToRaw(v, ref) {
  const r = ref & 255, g = (ref >> 8) & 255, b = (ref >> 16) & 255;
  if ((ref >>> 24) === 0x01 && v.bpp <= 8) return ref & 255; // PALETTEINDEX()
  if (v.bpp <= 8) return v.pal ? nearestIndex(v.pal, r, g, b) : ((r + g + b) / 3) | 0;
  if (v.bpp === 16) return v.fmt16 === 565 ? ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3) : ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  return ((r << 16) | (g << 8) | b) >>> 0;
}

// ¿se puede copiar el valor crudo sin conversión?
export function sameEncoding(a, b) {
  if (a.bpp !== b.bpp) return false;
  if (a.bpp <= 8) return palEqual(a.pal, b.pal, 1 << a.bpp);
  if (a.bpp === 16) return a.fmt16 === b.fmt16;
  return true;
}

const ROP = { SRCCOPY: 0xcc0020, SRCPAINT: 0xee0086, SRCAND: 0x8800c6, SRCINVERT: 0x660046, NOTSRCCOPY: 0x330008, BLACKNESS: 0x42, WHITENESS: 0xff0062, PATCOPY: 0xf00021, DSTINVERT: 0x550009, SRCERASE: 0x440328, MERGECOPY: 0xc000ca };
export { ROP };

// Copia/escala con ROP. srcIsPalIndices: tabla DIB_PAL_COLORS (índices directos a la paleta destino)
export function blitViews(emu, dv, dx, dy, dw, dh, sv, sx, sy, sw, sh, rop, opts = {}) {
  const u8 = emu.mem.u8;
  rop = rop >>> 0;
  if (rop === ROP.BLACKNESS || rop === ROP.WHITENESS || rop === ROP.PATCOPY || rop === ROP.DSTINVERT) {
    const raw = rop === ROP.BLACKNESS ? refToRaw(dv, 0) : rop === ROP.WHITENESS ? refToRaw(dv, 0xffffff) : refToRaw(dv, opts.brushRef ?? 0);
    fillView(emu, dv, dx, dy, dw, dh, raw, rop === ROP.DSTINVERT);
    return true;
  }
  if (!sv) return false;
  const flipX = dw < 0, flipY = dh < 0;
  dw = Math.abs(dw); dh = Math.abs(dh); sw = Math.abs(sw); sh = Math.abs(sh);
  if (!dw || !dh || !sw || !sh) return true;
  const direct = opts.palIndices ? dv.bpp === 8 : sameEncoding(sv, dv);
  const mask = dv.bpp >= 32 ? 0xffffffff : (2 ** dv.bpp) - 1;
  for (let y = 0; y < dh; y++) {
    const ty = dy + y; if (ty < 0 || ty >= dv.h) continue;
    const syy = sy + Math.floor((flipY ? dh - 1 - y : y) * sh / dh);
    if (syy < 0 || syy >= sv.h) continue;
    for (let x = 0; x < dw; x++) {
      const tx = dx + x; if (tx < 0 || tx >= dv.w) continue;
      const sxx = sx + Math.floor((flipX ? dw - 1 - x : x) * sw / dw);
      if (sxx < 0 || sxx >= sv.w) continue;
      let s = readRaw(u8, sv, sxx, syy);
      if (!direct) s = refToRaw(dv, rawToRef(sv, s));
      let out;
      switch (rop) {
        case ROP.SRCCOPY: out = s; break;
        case ROP.SRCPAINT: out = readRaw(u8, dv, tx, ty) | s; break;
        case ROP.SRCAND: out = readRaw(u8, dv, tx, ty) & s; break;
        case ROP.SRCINVERT: out = readRaw(u8, dv, tx, ty) ^ s; break;
        case ROP.NOTSRCCOPY: out = ~s & mask; break;
        case ROP.SRCERASE: out = s & ~readRaw(u8, dv, tx, ty) & mask; break;
        default: out = s; if (!opts.warned) { opts.warned = true; emu.note(`(ROP ${rop.toString(16)} tratado como SRCCOPY)`); }
      }
      writeRaw(u8, dv, tx, ty, out >>> 0);
    }
  }
  return true;
}
export function fillView(emu, v, x0, y0, w, h, raw, invert = false) {
  const u8 = emu.mem.u8;
  const mask = v.bpp >= 32 ? 0xffffffff : (2 ** v.bpp) - 1;
  for (let y = Math.max(0, y0); y < Math.min(v.h, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(v.w, x0 + w); x++)
      writeRaw(u8, v, x, y, invert ? (~readRaw(u8, v, x, y) & mask) >>> 0 : raw);
}

// ---------- DIB: BITMAPINFO en memoria emulada ----------
export function readBMI(emu, p) {
  const m = emu.mem;
  const size = m.r32(p), w = m.r32(p + 4) | 0, h = m.r32(p + 8) | 0, bpp = m.r16(p + 14), comp = m.r32(p + 16);
  let used = m.r32(p + 32);
  if (size < 40) throw new Error(`BITMAPCOREHEADER (size=${size}) no soportado`);
  let fmt16 = 555, masks = null, tableOff = p + size;
  if (comp === 3) { masks = [m.r32(p + size), m.r32(p + size + 4), m.r32(p + size + 8)]; tableOff += 12; if (bpp === 16 && masks[1] === 0x7e0) fmt16 = 565; }
  else if (comp !== 0) throw new Error(`DIB comprimido (biCompression=${comp}) no soportado`);
  const nColors = bpp <= 8 ? (used || (1 << bpp)) : 0;
  return { size, w, h, bpp, comp, nColors, tableOff, fmt16, masks, pitch: ((w * bpp + 31) >> 5) << 2 };
}
export function readColorTable(emu, bmi, usage = 0) {
  if (!bmi.nColors) return null;
  const pal = new Uint8Array(768);
  for (let i = 0; i < bmi.nColors && i < 256; i++) {
    if (usage === 1) { const idx = emu.mem.r16(bmi.tableOff + i * 2); pal[i * 3] = pal[i * 3 + 1] = pal[i * 3 + 2] = idx; continue; }
    const o = bmi.tableOff + i * 4; // RGBQUAD = B,G,R,0
    pal[i * 3] = emu.mem.r8(o + 2); pal[i * 3 + 1] = emu.mem.r8(o + 1); pal[i * 3 + 2] = emu.mem.r8(o);
  }
  return pal;
}
// Crea un objeto bitmap GDI que referencia píxeles en memoria emulada (sin copiar)
export function bitmapFromBMI(emu, bmiPtr, bitsPtr, opts = {}) {
  const bi = readBMI(emu, bmiPtr);
  return {
    type: 'bitmap', w: bi.w, height: bi.h, bpp: bi.bpp, pitch: bi.pitch, bits: bitsPtr, pal: readColorTable(emu, bi, opts.usage || 0),
    fmt16: bi.fmt16, dib: !!opts.dib, ddbBpp: opts.ddbBpp || 0, headerPtr: bmiPtr, source: opts.source || '',
  };
}
// Copia un DIB empaquetado (BITMAPINFOHEADER+tabla+bits, p.ej. un recurso RT_BITMAP) a memoria propia
export function loadPackedDIB(emu, addr, size, source, asDDB) {
  const bi = readBMI(emu, addr);
  const tableBytes = bi.comp === 3 ? 12 : bi.nColors * 4;
  const headerBytes = bi.size + tableBytes;
  const bitsBytes = bi.pitch * Math.abs(bi.h);
  if (headerBytes + bitsBytes > size + 2) throw new Error(`DIB truncado: necesita ${headerBytes + bitsBytes} bytes, recurso tiene ${size}`);
  const copy = emu.mem.alloc(headerBytes + bitsBytes);
  emu.mem.copy(copy, addr, Math.min(size, headerBytes + bitsBytes));
  const bmp = bitmapFromBMI(emu, copy, copy + headerBytes, { dib: !asDDB, ddbBpp: asDDB ? (emu.state.ddBpp || 8) : 0, source });
  return bmp;
}

// ---------- texto (rasterizado por el host si lo ofrece) ----------
export function drawText(emu, dc, x, y, text) {
  const v = dcView(emu, dc);
  G(emu).stats.text++;
  if (!v) return false;
  const font = gdiObj(emu, dc.font) || { height: 16, face: 'Arial', weight: 400 };
  const glyphs = emu.host.renderText?.(text, Math.abs(font.height || 16), font.face, font.weight);
  if (!glyphs) { emu.note(`"${text}" (este host no rasteriza texto)`); return false; }
  const u8 = emu.mem.u8, fg = refToRaw(v, dc.textColor ?? 0), bg = refToRaw(v, dc.bkColor ?? 0xffffff);
  for (let j = 0; j < glyphs.h; j++) for (let i = 0; i < glyphs.w; i++) {
    const tx = x + i, ty = y + j; if (tx < 0 || ty < 0 || tx >= v.w || ty >= v.h) continue;
    if (glyphs.alpha[j * glyphs.w + i] > 110) writeRaw(u8, v, tx, ty, fg);
    else if ((dc.bkMode ?? 2) === 2) writeRaw(u8, v, tx, ty, bg);
  }
  return true;
}

export function newDC(emu, kind, extra = {}) {
  return newGdi(emu, { type: 'dc', kind, bitmap: 0, textColor: 0, bkColor: 0xffffff, bkMode: 2, brush: STOCK + 0, pen: STOCK + 7, font: STOCK + 13, pal: STOCK + 15, ...extra });
}
export function brushRef(emu, h) {
  const stock = { [STOCK + 0]: 0xffffff, [STOCK + 1]: 0xc0c0c0, [STOCK + 2]: 0x808080, [STOCK + 3]: 0x404040, [STOCK + 4]: 0, [STOCK + 5]: null };
  if (h in stock) return stock[h];
  const o = gdiObj(emu, h); return o && o.type === 'brush' ? o.color : 0;
}
