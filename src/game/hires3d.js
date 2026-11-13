// hires3d.js — captura del 3D de DAYTONA.EXE para redibujarlo a más resolución (ver INVESTIGACION_REESCALADO.md).
//
// Por cada cuadro que el juego dibuja se guarda:
//  · la lista de polígonos en orden de dibujo (pintor): 4 vértices con coordenadas de pantalla en punto flotante
//    (antes de que el juego las redondee a píxeles), la textura y su orientación, y si es transparente;
//  · las texturas que usó (RGB565, ≤128×128), copiadas en el momento del dibujo;
//  · una máscara de capas de 640×480: quién escribió por última vez cada píxel de la pantalla
//      0 = nadie / copia de fondo (cielo) / polígonos (no se vigilan: los redibuja la GPU)
//      2 = otro código antes del primer polígono   3 = otro código después (HUD, reflejos, efectos)
// El juego sigue dibujando su imagen 640×480 como siempre (de ahí salen el cielo, el HUD y los efectos).
//
// Puntos del EXE: 0x454C10 dibuja un cuadrilátero (registro con los vértices flotantes); 0x45DA10 (A, opaco) y
// 0x45E1E0 (B, transparente: no pinta el color 0x0020) rasterizan; vuelven a 0x454F77 y 0x454F9E.
const SCALE_X = 0xbd9df8, SCALE_Y = 0xc464a8, OFF_X = 0x47e2d0, OFF_Y = 0x47e2d8, CLIP_W = 0x4d4f24, CLIP_H = 0x4d4f28;
const POLY = 0x454c10, RAST_A = 0x45da10, RAST_B = 0x45e1e0, RET_A = 0x454f77, RET_B = 0x454f9e;
export const COLOR_KEY = 0x0020;

export class Hires3D {
  constructor(emu) {
    this.emu = emu; this.enabled = false;
    this.polys = []; this.cur = null; this.raster = false; this.firstPoly = false;
    this.texCache = new Map();      // clave → { data: Uint16Array, w, h, ver }
    this.masks = new Map();         // memoria de la superficie → Uint8Array(640*480)
    this.last = null;               // último cuadro completo (el que se está mostrando)
    this.stats = { frames: 0, polys: 0, texUpdates: 0 };
    const dv = new DataView(new ArrayBuffer(8));
    this.f32 = (a) => { dv.setUint32(0, emu.mem.r32(a), true); return dv.getFloat32(0, true); };
    this.f64 = (a) => { dv.setUint32(0, emu.mem.r32(a), true); dv.setUint32(4, emu.mem.r32(a + 4), true); return dv.getFloat64(0, true); };
  }
  enable(on = true) {
    const emu = this.emu;
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      emu.addHook(POLY, (c) => this.onPoly(c));
      emu.addHook(RAST_A, (c) => this.onRaster(c, 0));
      emu.addHook(RAST_B, (c) => this.onRaster(c, 1));
      emu.addHook(RET_A, () => this.rasterEnd());
      emu.addHook(RET_B, () => this.rasterEnd());
      (emu.presentHooks ||= []).push(this.presentHook = (surf) => this.onPresent(surf));
      this.surfaces();
    } else {
      for (const a of [POLY, RAST_A, RAST_B, RET_A, RET_B]) emu.removeHook(a);
      emu.presentHooks = (emu.presentHooks || []).filter((f) => f !== this.presentHook);
      emu.mem.watchLo = emu.mem.watchHi = 0; emu.mem.onWatch = null;
      this.last = null; this.polys = [];
    }
  }
  // superficies de 640×480×16 del juego (cadena de intercambio): rango de memoria vigilado
  surfaces() {
    const dd = this.emu.state.dd; if (!dd) return;
    const list = [...new Map([...dd.objs.values()].filter((o) => o && o.mem && o.w === 640 && o.h === 480 && o.bpp === 16).map((o) => [o.mem, o])).values()];
    if (!list.length) return;
    this.surfList = list.map((o) => ({ base: o.mem, end: o.mem + o.pitch * o.h, pitch: o.pitch }));
    for (const s of this.surfList) if (!this.masks.has(s.base)) this.masks.set(s.base, new Uint8Array(640 * 480));
    const m = this.emu.mem;
    m.watchLo = Math.min(...this.surfList.map((s) => s.base)); m.watchHi = Math.max(...this.surfList.map((s) => s.end));
    m.onWatch = (a, n) => this.onWrite(a, n);
  }
  onWrite(a, n) {
    for (const s of this.surfList) {
      if (a + n <= s.base || a >= s.end) continue;
      const mask = this.masks.get(s.base);
      const kind = this.raster ? 1 : this.firstPoly ? 3 : 2;
      let lo = Math.max(a, s.base) - s.base, hi = Math.min(a + n, s.end) - s.base;
      if (s.pitch === 1280) { mask.fill(kind, lo >> 1, (hi + 1) >> 1); return; }
      for (let o = lo; o < hi; o += 2) { const y = (o / s.pitch) | 0, x = ((o % s.pitch) >> 1); if (x < 640) mask[y * 640 + x] = kind; }
      return;
    }
  }
  onPoly(c) {
    const m = this.emu.mem, p = m.r32(c.r[4] + 4);
    const sx = this.f32(SCALE_X), sy = this.f32(SCALE_Y), ox = this.f64(OFF_X), oy = this.f64(OFF_Y);
    const v = new Float32Array(8);
    for (let k = 0; k < 4; k++) { v[k * 2] = (this.f32(p + 8 + k * 8) + ox) * sx; v[k * 2 + 1] = (this.f32(p + 12 + k * 8) + oy) * sy; }
    this.cur = { v };
    return true;
  }
  // Mientras rasteriza un polígono no hace falta vigilar (sus píxeles los redibuja la GPU): se apaga la vigilancia
  // y se vuelve a prender al terminar. Así sólo se registran HUD, reflejos y efectos (muchas menos escrituras).
  rasterEnd() { this.raster = false; const m = this.emu.mem; if (this.watchSaved) { m.watchLo = this.watchSaved[0]; m.watchHi = this.watchSaved[1]; this.watchSaved = null; } return true; }
  onRaster(c, transparent) {
    const cur = this.cur; this.cur = null;
    this.raster = true; this.firstPoly = true;
    if (!cur) { const mm = this.emu.mem; if (!this.watchSaved && mm.watchHi) { this.watchSaved = [mm.watchLo, mm.watchHi]; mm.watchLo = mm.watchHi = 0; } return true; }
    const m = this.emu.mem, sp = c.r[4];
    const dest = m.r32(sp + 4), st = m.r32(sp + 16);
    const mode = m.r8(st), uv = m.r32(st + 8), tp = m.r32(st + 12), w = uv & 0xffff, h = uv >>> 16;
    if (!w || !h || w > 256 || h > 256) { if (!this.watchSaved && m.watchHi) { this.watchSaved = [m.watchLo, m.watchHi]; m.watchLo = m.watchHi = 0; } return true; }
    if (!this.surfList || !this.surfList.some((s) => dest >= s.base && dest < s.end)) this.surfaces();
    const s = this.surfList?.find((q) => dest >= q.base && dest < q.end);
    const off = s ? dest - s.base : 0, pitch = s?.pitch || 1280;
    const ox = (off % pitch) >> 1, oy = Math.floor(off / pitch);
    for (let k = 0; k < 4; k++) { cur.v[k * 2] += ox; cur.v[k * 2 + 1] += oy; }
    if (!this.watchSaved && m.watchHi) { this.watchSaved = [m.watchLo, m.watchHi]; m.watchLo = m.watchHi = 0; }
    // textura: se guarda la versión que el juego usa en este momento (se descomprimen a una caché que cambia)
    const key = `${tp}_${w}_${h}`;
    let t = this.texCache.get(key);
    const n = w * h, u8 = m.u8;
    if (!t) { t = { key, w, h, data: new Uint16Array(n), ver: 0 }; this.texCache.set(key, t); t.ver = -1; }
    const d = t.data; let changed = t.ver < 0;
    // una comparación completa por cuadro y por textura; si ya se usó en este cuadro, una muestra rápida
    let full = t.seen !== this.stats.frames;
    if (!full) for (let i = 0; i < n; i += 37) { const a = tp + i * 2; if (d[i] !== (u8[a] | (u8[a + 1] << 8))) { full = true; break; } }
    if (full) { t.seen = this.stats.frames; for (let i = 0, a = tp; i < n; i++, a += 2) { const val = u8[a] | (u8[a + 1] << 8); if (d[i] !== val) { d[i] = val; changed = true; } } }
    if (changed) { t.ver++; this.stats.texUpdates++; }
    cur.tex = t; cur.mode = mode; cur.transparent = transparent;
    cur.clip = [ox, oy, m.r32(CLIP_W) | 0, m.r32(CLIP_H) | 0];
    this.polys.push(cur);
    return true;
  }
  onPresent(surf) {
    const mask = this.masks.get(surf.mem);
    this.last = { polys: this.polys, mask: mask ? mask.slice() : null, seq: ++this.stats.frames };
    this.stats.polys = this.polys.length;
    this.polys = []; this.firstPoly = false; this.raster = false;
    for (const mk of this.masks.values()) mk.fill(0);
  }
}
