// gdi32.js — GDI con píxeles reales (ver gdi_core.js). Lo que no está aquí detiene la ejecución.
import { api } from './common.js';
import {
  G, STOCK, newGdi, gdiObj, newDC, dcView, readRaw, writeRaw, rawToRef, refToRaw, blitViews, fillView,
  bitmapFromBMI, readBMI, readColorTable, bitmapView, drawText, brushRef, ROP,
} from './gdi_core.js';

const dc = (emu, h) => { const o = gdiObj(emu, h); return o && o.type === 'dc' ? o : null; };
const CLR_INVALID = 0xffffffff;

function selectInto(emu, d, h) {
  if (!d) return 0;
  if (h >= STOCK && h < STOCK + 32) {
    const i = h - STOCK;
    if (i <= 5) { const o = d.brush; d.brush = h; return o; }
    if (i >= 6 && i <= 8) { const o = d.pen; d.pen = h; return o; }
    if (i >= 10 && i <= 17 && i !== 15) { const o = d.font; d.font = h; return o; }
    return STOCK;
  }
  const o = gdiObj(emu, h);
  if (!o) return 0;
  switch (o.type) {
    case 'bitmap': { const old = d.bitmap || (STOCK + 21); d.bitmap = h; return old; }
    case 'brush': { const old = d.brush; d.brush = h; return old; }
    case 'pen': { const old = d.pen; d.pen = h; return old; }
    case 'font': { const old = d.font; d.font = h; return old; }
  }
  return 0;
}

const GDI = {
  // ---------- DCs ----------
  CreateCompatibleDC: api(1, (emu, h) => { const src = dc(emu, h); return newDC(emu, 'mem', { compatBpp: dcView(emu, src)?.bpp || emu.state.ddBpp || 16 }); }),
  CreateDCA: api(4, (emu) => newDC(emu, 'screen')),
  DeleteDC: api(1, (emu, h) => (G(emu).objs.delete(h) ? 1 : 0)),
  SaveDC: api(1, () => 1), RestoreDC: api(2, () => 1),
  GetStockObject: api(1, (emu, i) => STOCK + i),
  SelectObject: api(2, (emu, hdc, h) => selectInto(emu, dc(emu, hdc), h)),
  DeleteObject: api(1, (emu, h) => { const o = gdiObj(emu, h); if (o?.type === 'bitmap' && o.owned) emu.mem.free(o.owned); G(emu).objs.delete(h); return 1; }),
  GetCurrentObject: api(2, (emu, hdc, t) => { const d = dc(emu, hdc); return !d ? 0 : t === 7 ? d.bitmap : t === 2 ? d.brush : t === 1 ? d.pen : t === 6 ? d.font : 0; }),
  GetDeviceCaps: api(2, (emu, hdc, i) => {
    const bpp = dcView(emu, dc(emu, hdc))?.bpp || emu.state.dd?.mode?.bpp || 16; // escritorio de 16 bits (README del juego)
    const m = emu.state.dd?.mode || { w: 640, h: 480 };
    const v = { 2: 1, 4: 320, 6: 240, 8: m.w, 10: m.h, 12: bpp, 14: 1, 24: bpp <= 8 ? 256 : -1 >>> 0, 38: 0x7e99, 88: 96, 90: 96, 104: bpp <= 8 ? 256 : 0, 106: bpp <= 8 ? 20 : 0, 108: bpp <= 8 ? 18 : 0, 116: 60 }[i];
    return v ?? 0;
  }),
  // ---------- píxeles ----------
  SetPixel: api(4, (emu, hdc, x, y, color) => {
    const v = dcView(emu, dc(emu, hdc)); G(emu).stats.setPixel++;
    x |= 0; y |= 0;
    if (!v || x < 0 || y < 0 || x >= v.w || y >= v.h) return CLR_INVALID;
    const raw = refToRaw(v, color); writeRaw(emu.mem.u8, v, x, y, raw);
    const got = rawToRef(v, raw); emu.note(`-> crudo ${raw.toString(16)} (${v.bpp} bpp) = RGB ${got.toString(16)}`);
    return got;
  }),
  SetPixelV: api(4, (emu, hdc, x, y, color) => (GDI.SetPixel.fn(emu, hdc, x, y, color) !== CLR_INVALID ? 1 : 0)),
  GetPixel: api(3, (emu, hdc, x, y) => {
    const v = dcView(emu, dc(emu, hdc)); G(emu).stats.getPixel++;
    x |= 0; y |= 0;
    if (!v || x < 0 || y < 0 || x >= v.w || y >= v.h) return CLR_INVALID;
    return rawToRef(v, readRaw(emu.mem.u8, v, x, y));
  }),
  // ---------- blits ----------
  BitBlt: api(9, (emu, hd, x, y, w, h, hs, sx, sy, rop) => {
    G(emu).stats.bitblt++;
    const dv = dcView(emu, dc(emu, hd)), sv = dcView(emu, dc(emu, hs));
    if (!dv) { emu.note('(destino sin píxeles)'); return 1; }
    const d = dc(emu, hd);
    blitViews(emu, dv, x | 0, y | 0, w | 0, h | 0, sv, sx | 0, sy | 0, w | 0, h | 0, rop, { brushRef: brushRef(emu, d.brush) });
    afterDraw(emu, d);
    return 1;
  }),
  StretchBlt: api(11, (emu, hd, x, y, w, h, hs, sx, sy, sw, sh, rop) => {
    G(emu).stats.stretch++;
    const dv = dcView(emu, dc(emu, hd)), sv = dcView(emu, dc(emu, hs));
    if (!dv) return 1;
    blitViews(emu, dv, x | 0, y | 0, w | 0, h | 0, sv, sx | 0, sy | 0, sw | 0, sh | 0, rop, { brushRef: brushRef(emu, dc(emu, hd).brush) });
    afterDraw(emu, dc(emu, hd));
    return 1;
  }),
  PatBlt: api(6, (emu, hd, x, y, w, h, rop) => {
    const d = dc(emu, hd), dv = dcView(emu, d); if (!dv) return 1;
    blitViews(emu, dv, x | 0, y | 0, w | 0, h | 0, null, 0, 0, 0, 0, rop, { brushRef: brushRef(emu, d.brush) });
    afterDraw(emu, d); return 1;
  }),
  StretchDIBits: api(13, (emu, hd, x, y, w, h, sx, sy, sw, sh, bits, bmi, usage, rop) => {
    G(emu).stats.dib++;
    const d = dc(emu, hd), dv = dcView(emu, d); if (!dv) return 0;
    const b = bitmapFromBMI(emu, bmi, bits, { usage });
    const sv = bitmapView(emu, b);
    // en un DIB "bottom-up", ySrc se cuenta desde abajo
    const syTop = b.height > 0 ? sv.h - (sy | 0) - (sh | 0) : sy | 0;
    blitViews(emu, dv, x | 0, y | 0, w | 0, h | 0, sv, sx | 0, syTop, sw | 0, sh | 0, rop, { palIndices: usage === 1 });
    afterDraw(emu, d);
    return Math.abs(sh | 0);
  }),
  SetDIBitsToDevice: api(12, (emu, hd, x, y, w, h, sx, sy, start, lines, bits, bmi, usage) => {
    G(emu).stats.dib++;
    const d = dc(emu, hd), dv = dcView(emu, d); if (!dv) return 0;
    const b = bitmapFromBMI(emu, bmi, bits, { usage });
    const sv = bitmapView(emu, b);
    const syTop = b.height > 0 ? sv.h - (sy | 0) - (h | 0) : sy | 0;
    blitViews(emu, dv, x | 0, y | 0, w | 0, h | 0, sv, sx | 0, syTop, w | 0, h | 0, ROP.SRCCOPY, { palIndices: usage === 1 });
    afterDraw(emu, d);
    return lines;
  }),
  // ---------- bitmaps ----------
  CreateCompatibleBitmap: api(3, (emu, hdc, w, h) => {
    const bpp = dcView(emu, dc(emu, hdc))?.bpp || dc(emu, hdc)?.compatBpp || emu.state.dd?.mode?.bpp || 16;
    return makeBitmap(emu, w, h, bpp, false, null);
  }),
  CreateBitmap: api(5, (emu, w, h, planes, bpp, bits) => {
    const hb = makeBitmap(emu, w, h, bpp, false, null);
    if (bits) { const b = gdiObj(emu, hb); const wp = ((w * bpp + 15) >> 4) << 1; for (let y = 0; y < h; y++) emu.mem.copy(b.bits + (h - 1 - y) * b.pitch, bits + y * wp, Math.min(wp, b.pitch)); }
    return hb;
  }),
  CreateDIBSection: api(6, (emu, hdc, bmi, usage, ppBits, hSection, off) => {
    const bi = readBMI(emu, bmi);
    const size = bi.pitch * Math.abs(bi.h);
    const mem = emu.mem.alloc(size + 1024);
    const hdrSize = bi.size + (bi.comp === 3 ? 12 : bi.nColors * 4);
    const hdr = emu.mem.alloc(hdrSize); emu.mem.copy(hdr, bmi, hdrSize);
    const b = bitmapFromBMI(emu, hdr, mem, { dib: true, usage });
    b.owned = mem;
    if (usage === 1) b.pal = emu.ddPaletteOf(emu.state.dd?.primary || { palette: 0 });
    if (ppBits) emu.mem.w32(ppBits, mem);
    emu.note(`${bi.w}x${bi.h}x${bi.bpp} bits@${mem.toString(16)}`);
    return newGdi(emu, b);
  }),
  GetObjectA: api(3, (emu, h, n, p) => {
    const o = gdiObj(emu, h);
    if (!o) { if (p) emu.mem.fill(p, 0, n); return 0; }
    if (o.type === 'bitmap') {
      const m = emu.mem, bpp = o.ddbBpp || o.bpp, wb = o.ddbBpp ? ((o.w * bpp + 15) >> 4) << 1 : o.pitch;
      if (!p) return o.dib ? 84 : 24;
      m.w32(p, 0); m.w32(p + 4, o.w); m.w32(p + 8, Math.abs(o.height)); m.w32(p + 12, wb);
      m.w16(p + 16, 1); m.w16(p + 18, bpp); m.w32(p + 20, o.dib ? o.bits : 0);
      if (o.dib && n >= 84 && o.headerPtr) { m.copy(p + 24, o.headerPtr, 40); m.fill(p + 64, 0, 20); return 84; }
      return 24;
    }
    if (o.type === 'palette') { if (p) emu.mem.w16(p, o.n); return 2; }
    if (p) emu.mem.fill(p, 0, n);
    return n;
  }),
  GetDIBits: api(7, (emu, hdc, hbm, start, lines, bits, bmi, usage) => {
    const b = gdiObj(emu, hbm); if (!b || b.type !== 'bitmap') return 0;
    const m = emu.mem;
    if (m.r16(bmi + 14) === 0) { // biBitCount == 0: rellenar cabecera
      m.w32(bmi + 4, b.w); m.w32(bmi + 8, b.height); m.w16(bmi + 12, 1); m.w16(bmi + 14, b.ddbBpp || b.bpp); m.w32(bmi + 16, 0);
      m.w32(bmi + 20, b.pitch * Math.abs(b.height)); return Math.abs(b.height);
    }
    const want = readBMI(emu, bmi);
    if (want.bpp <= 8 && b.pal) for (let i = 0; i < (1 << want.bpp); i++) { const o = want.tableOff + i * 4; m.w8(o, b.pal[i * 3 + 2]); m.w8(o + 1, b.pal[i * 3 + 1]); m.w8(o + 2, b.pal[i * 3]); m.w8(o + 3, 0); }
    if (!bits) return lines;
    const dst = bitmapFromBMI(emu, bmi, bits, {});
    if (want.bpp <= 8 && b.pal) dst.pal = b.pal;
    const dv = bitmapView(emu, dst), sv = bitmapView(emu, b);
    // copia las filas [start, start+lines) contadas desde abajo
    const n = Math.min(lines, sv.h - start);
    blitViews(emu, dv, 0, dv.h - start - n, dv.w, n, sv, 0, sv.h - start - n, sv.w, n, ROP.SRCCOPY);
    return n;
  }),
  SetDIBits: api(7, (emu, hdc, hbm, start, lines, bits, bmi, usage) => {
    const b = gdiObj(emu, hbm); if (!b) return 0;
    const src = bitmapView(emu, bitmapFromBMI(emu, bmi, bits, { usage })), dv = bitmapView(emu, b);
    blitViews(emu, dv, 0, dv.h - start - lines, dv.w, lines, src, 0, src.h - start - lines, src.w, lines, ROP.SRCCOPY, { palIndices: usage === 1 });
    return lines;
  }),
  GetDIBColorTable: api(4, (emu, hdc, start, n, p) => {
    const b = gdiObj(emu, dc(emu, hdc)?.bitmap); if (!b?.pal) return 0;
    for (let i = 0; i < n; i++) { const o = p + i * 4, c = (start + i) * 3; emu.mem.w8(o, b.pal[c + 2]); emu.mem.w8(o + 1, b.pal[c + 1]); emu.mem.w8(o + 2, b.pal[c]); emu.mem.w8(o + 3, 0); }
    return n;
  }),
  SetDIBColorTable: api(4, (emu, hdc, start, n, p) => {
    const b = gdiObj(emu, dc(emu, hdc)?.bitmap); if (!b) return 0;
    if (!b.pal) b.pal = new Uint8Array(768);
    for (let i = 0; i < n; i++) { const o = p + i * 4, c = (start + i) * 3; b.pal[c] = emu.mem.r8(o + 2); b.pal[c + 1] = emu.mem.r8(o + 1); b.pal[c + 2] = emu.mem.r8(o); }
    return n;
  }),
  // ---------- paletas ----------
  CreatePalette: api(1, (emu, p) => {
    const n = emu.mem.r16(p + 2), rgb = new Uint8Array(768);
    for (let i = 0; i < n && i < 256; i++) { rgb[i * 3] = emu.mem.r8(p + 4 + i * 4); rgb[i * 3 + 1] = emu.mem.r8(p + 5 + i * 4); rgb[i * 3 + 2] = emu.mem.r8(p + 6 + i * 4); }
    return newGdi(emu, { type: 'palette', n, rgb });
  }),
  SelectPalette: api(3, (emu, hdc, hp) => { const d = dc(emu, hdc); if (!d) return 0; const o = d.pal; d.pal = hp; return o; }),
  RealizePalette: api(1, (emu, hdc) => {
    const d = dc(emu, hdc), p = gdiObj(emu, d?.pal);
    if (p?.type === 'palette' && (d.kind === 'screen' || d.kind === 'window')) { emu.state.dd.gdiPal = p.rgb; return p.n; }
    return 0;
  }),
  SetPaletteEntries: api(4, (emu, hp, start, n, p) => { const o = gdiObj(emu, hp); if (!o) return 0; for (let i = 0; i < n; i++) { const c = (start + i) * 3; o.rgb[c] = emu.mem.r8(p + i * 4); o.rgb[c + 1] = emu.mem.r8(p + i * 4 + 1); o.rgb[c + 2] = emu.mem.r8(p + i * 4 + 2); } return n; }),
  GetPaletteEntries: api(4, (emu, hp, start, n, p) => { const o = gdiObj(emu, hp); if (!o) return 0; for (let i = 0; i < n; i++) { const c = (start + i) * 3; emu.mem.w8(p + i * 4, o.rgb[c]); emu.mem.w8(p + i * 4 + 1, o.rgb[c + 1]); emu.mem.w8(p + i * 4 + 2, o.rgb[c + 2]); emu.mem.w8(p + i * 4 + 3, 0); } return n; }),
  GetSystemPaletteEntries: api(4, (emu, hdc, start, n, p) => {
    const pal = emu.ddPaletteOf(emu.state.dd?.primary || {});
    if (p) for (let i = 0; i < n; i++) { const c = (start + i) * 3; emu.mem.w8(p + i * 4, pal[c]); emu.mem.w8(p + i * 4 + 1, pal[c + 1]); emu.mem.w8(p + i * 4 + 2, pal[c + 2]); emu.mem.w8(p + i * 4 + 3, 0); }
    return n;
  }),
  SetSystemPaletteUse: api(2, () => 1), GetSystemPaletteUse: api(1, () => 1),
  GetNearestColor: api(2, (emu, hdc, c) => { const v = dcView(emu, dc(emu, hdc)); return v ? rawToRef(v, refToRaw(v, c)) : c; }),
  GetNearestPaletteIndex: api(2, (emu, hp, c) => { const o = gdiObj(emu, hp); if (!o) return 0; const v = { bpp: 8, pal: o.rgb }; return refToRaw(v, c); }),
  // ---------- pinceles, plumas, texto ----------
  CreateSolidBrush: api(1, (emu, c) => newGdi(emu, { type: 'brush', color: c })),
  CreatePen: api(3, (emu, style, w, c) => newGdi(emu, { type: 'pen', color: c })),
  CreateFontA: api(14, (emu, h, w, esc, or, weight, it, un, so, cs, op, cp, q, pf, face) => newGdi(emu, { type: 'font', height: h | 0, weight, face: face ? emu.mem.cstr(face) : 'Arial' })),
  CreateFontIndirectA: api(1, (emu, p) => newGdi(emu, { type: 'font', height: emu.mem.r32(p) | 0, weight: emu.mem.r32(p + 16), face: emu.mem.cstr(p + 28) })),
  SetTextColor: api(2, (emu, hdc, c) => { const d = dc(emu, hdc); if (!d) return CLR_INVALID; const o = d.textColor; d.textColor = c; return o; }),
  SetBkColor: api(2, (emu, hdc, c) => { const d = dc(emu, hdc); if (!d) return CLR_INVALID; const o = d.bkColor; d.bkColor = c; return o; }),
  SetBkMode: api(2, (emu, hdc, m) => { const d = dc(emu, hdc); if (!d) return 0; const o = d.bkMode; d.bkMode = m; return o; }),
  SetTextAlign: api(2, () => 0),
  TextOutA: api(5, (emu, hdc, x, y, p, n) => {
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(emu.mem.r8(p + i));
    const d = dc(emu, hdc); drawText(emu, d, x | 0, y | 0, s); afterDraw(emu, d); return 1;
  }),
  ExtTextOutA: api(8, (emu, hdc, x, y, opts, rect, p, n) => {
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(emu.mem.r8(p + i));
    const d = dc(emu, hdc); drawText(emu, d, x | 0, y | 0, s); afterDraw(emu, d); return 1;
  }),
  GetTextExtentPoint32A: api(4, (emu, hdc, p, n, sz) => {
    const f = gdiObj(emu, dc(emu, hdc)?.font) || { height: 16 }; const h = Math.abs(f.height || 16);
    emu.mem.w32(sz, Math.round(n * h * 0.55)); emu.mem.w32(sz + 4, h); return 1;
  }),
  GetTextExtentPointA: api(4, (emu, hdc, p, n, sz) => GDI.GetTextExtentPoint32A.fn(emu, hdc, p, n, sz)),
  GetTextMetricsA: api(2, (emu, hdc, p) => { const f = gdiObj(emu, dc(emu, hdc)?.font) || { height: 16 }; const h = Math.abs(f.height || 16); emu.mem.fill(p, 0, 56); emu.mem.w32(p, h); emu.mem.w32(p + 4, Math.round(h * 0.8)); emu.mem.w32(p + 8, h - Math.round(h * 0.8)); emu.mem.w32(p + 20, Math.round(h * 0.5)); emu.mem.w32(p + 24, h); return 1; }),
  Rectangle: api(5, (emu, hdc, l, t, r, b) => {
    const d = dc(emu, hdc), v = dcView(emu, d); if (!v) return 1;
    const br = brushRef(emu, d.brush); if (br !== null) fillView(emu, v, l | 0, t | 0, (r - l) | 0, (b - t) | 0, refToRaw(v, br));
    afterDraw(emu, d); return 1;
  }),
  GdiFlush: api(0, () => 1),
};

function makeBitmap(emu, w, h, bpp, dib, pal) {
  const pitch = ((w * bpp + 31) >> 5) << 2;
  const mem = emu.mem.alloc(pitch * Math.abs(h) + 16);
  return newGdi(emu, { type: 'bitmap', w, height: h, bpp, pitch, bits: mem, pal: pal || (bpp <= 8 ? emu.ddPaletteOf(emu.state.dd?.primary || {}) : null), fmt16: 565, dib, owned: mem });
}
export { makeBitmap };
// Dibujar con GDI sobre la primaria se ve en pantalla de inmediato
function afterDraw(emu, d) {
  if (!d) return;
  if ((d.kind === 'surface' && d.surf === emu.state.dd?.primary) || d.kind === 'screen' || d.kind === 'window') emu.state.dd.dirty = true;
}
export default GDI;
