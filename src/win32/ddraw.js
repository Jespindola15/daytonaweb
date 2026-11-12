// ddraw.js — DirectDraw (DX3-DX5) como objetos COM en memoria del guest.
// Cada interfaz tiene una vtable real (array de punteros a thunks) para que el código
// del juego haga `call [eax+N]` exactamente como en Windows. La presentación final
// convierte la superficie primaria (8/16/32 bpp) a RGBA y la entrega al host (Canvas).
import { api, HaltSignal } from './common.js';
import { newDC, gdiObj, G as gdiState } from './gdi_core.js';

const DD_OK = 0, DDERR_GENERIC = 0x80004005, DDERR_UNSUPPORTED = 0x80004001, DDERR_NOTFOUND = 0x887600ff;
const DDSD = { CAPS: 1, HEIGHT: 2, WIDTH: 4, PITCH: 8, BACKBUFFERCOUNT: 0x20, LPSURFACE: 0x800, PIXELFORMAT: 0x1000, CKSRCBLT: 0x10000 };
const DDSCAPS = { BACKBUFFER: 4, COMPLEX: 8, FLIP: 0x10, FRONTBUFFER: 0x20, OFFSCREENPLAIN: 0x40, PALETTE: 0x100, PRIMARYSURFACE: 0x200, SYSTEMMEMORY: 0x800, VIDEOMEMORY: 0x4000 };
const DDBLT = { COLORFILL: 0x400, KEYSRC: 0x8000, KEYSRCOVERRIDE: 0x10000, WAIT: 0x1000000 };

const IDD = ['QueryInterface', 'AddRef', 'Release', 'Compact', 'CreateClipper', 'CreatePalette', 'CreateSurface', 'DuplicateSurface', 'EnumDisplayModes', 'EnumSurfaces', 'FlipToGDISurface', 'GetCaps', 'GetDisplayMode', 'GetFourCCCodes', 'GetGDISurface', 'GetMonitorFrequency', 'GetScanLine', 'GetVerticalBlankStatus', 'Initialize', 'RestoreDisplayMode', 'SetCooperativeLevel', 'SetDisplayMode', 'WaitForVerticalBlank'];
const IDDS = ['QueryInterface', 'AddRef', 'Release', 'AddAttachedSurface', 'AddOverlayDirtyRect', 'Blt', 'BltBatch', 'BltFast', 'DeleteAttachedSurface', 'EnumAttachedSurfaces', 'EnumOverlayZOrders', 'Flip', 'GetAttachedSurface', 'GetBltStatus', 'GetCaps', 'GetClipper', 'GetColorKey', 'GetDC', 'GetFlipStatus', 'GetOverlayPosition', 'GetPalette', 'GetPixelFormat', 'GetSurfaceDesc', 'Initialize', 'IsLost', 'Lock', 'ReleaseDC', 'Restore', 'SetClipper', 'SetColorKey', 'SetOverlayPosition', 'SetPalette', 'Unlock', 'UpdateOverlay', 'UpdateOverlayDisplay', 'UpdateOverlayZOrder'];
const IDDP = ['QueryInterface', 'AddRef', 'Release', 'GetCaps', 'GetEntries', 'Initialize', 'SetEntries'];
const IDDC = ['QueryInterface', 'AddRef', 'Release', 'GetClipList', 'GetHWnd', 'Initialize', 'IsClipListChanged', 'SetClipList', 'SetHWnd'];
// IDirectDraw2 agrega GetAvailableVidMem al final; IDirectDraw2::SetDisplayMode tiene 2 args extra
const IDD2 = [...IDD, 'GetAvailableVidMem'];

function S(emu) { return emu.state.dd; }

// Construye una vtable compartida por interfaz; métodos = {nombre: [nArgsSinThis, fn(emu, self, ...args)]}
function vtable(emu, iface, names, impls) {
  const s = S(emu);
  if (s.vtables.has(iface)) return s.vtables.get(iface);
  const vt = emu.mem.alloc(names.length * 4);
  names.forEach((nm, i) => {
    const impl = impls[nm];
    const addr = impl
      ? emu.hostFunction(`${iface}::${nm}`, impl[0] + 1, (e, self, ...a) => impl[1](e, s.objs.get(self), self, ...a))
      : emu.hostFunction(`${iface}::${nm}`, 1, () => { throw new HaltSignal(`Método COM no implementado: ${iface}::${nm}`, { api: `${iface}::${nm}`, caller: emu.mem.r32(emu.cpu.r[4]), stackArgs: [] }); });
    emu.mem.w32(vt + i * 4, addr);
  });
  s.vtables.set(iface, vt);
  return vt;
}
function newObj(emu, iface, names, impls, state) {
  const p = emu.mem.alloc(16);
  emu.mem.w32(p, vtable(emu, iface, names, impls));
  state.iface = iface; state.ptr = p; state.refs = 1;
  S(emu).objs.set(p, state);
  return p;
}
const common = {
  QueryInterface: [2, (emu, o, self, riid, ppv) => {
    const g = []; for (let i = 0; i < 16; i++) g.push(emu.mem.r8(riid + i).toString(16).padStart(2, '0'));
    emu.note(`IID=${g.join('')} -> mismo objeto`);
    emu.mem.w32(ppv, self); o.refs++; return DD_OK;
  }],
  AddRef: [0, (emu, o) => ++o.refs],
  Release: [0, (emu, o) => Math.max(0, --o.refs)],
};

function writePixelFormat(emu, p, bpp) {
  const m = emu.mem; m.fill(p, 0, 32); m.w32(p, 32);
  if (bpp === 8) { m.w32(p + 4, 0x40 | 0x20); m.w32(p + 12, 8); } // DDPF_RGB | PALETTEINDEXED8
  else if (bpp === 16) { m.w32(p + 4, 0x40); m.w32(p + 12, 16); m.w32(p + 16, 0xf800); m.w32(p + 20, 0x07e0); m.w32(p + 24, 0x001f); }
  else { m.w32(p + 4, 0x40); m.w32(p + 12, 32); m.w32(p + 16, 0xff0000); m.w32(p + 20, 0xff00); m.w32(p + 24, 0xff); }
}
function writeDesc(emu, p, surf, lpSurface) {
  const m = emu.mem; m.fill(p + 4, 0, 104); m.w32(p, 108);
  m.w32(p + 4, DDSD.CAPS | DDSD.HEIGHT | DDSD.WIDTH | DDSD.PITCH | DDSD.PIXELFORMAT | (lpSurface ? DDSD.LPSURFACE : 0) | (surf.backCount ? DDSD.BACKBUFFERCOUNT : 0));
  m.w32(p + 8, surf.h); m.w32(p + 12, surf.w); m.w32(p + 16, surf.pitch); m.w32(p + 20, surf.backCount || 0);
  m.w32(p + 36, lpSurface || 0);
  writePixelFormat(emu, p + 72, surf.bpp); m.w32(p + 104, surf.caps);
}

function makeSurface(emu, w, h, bpp, caps) {
  const pitch = ((w * bpp / 8) + 3) & ~3;
  const mem = emu.mem.alloc(pitch * h, true);
  const s = S(emu); const id = ++s.surfSeq;
  return { id, w, h, bpp, pitch, mem, caps, palette: null, ck: null, attached: null, chain: null, locks: 0, stats: { locks: 0, bltIn: 0, bltOut: 0, getdc: 0, flips: 0 } };
}

export function paletteOf(emu, surf) {
  const s = S(emu);
  const pp = surf.palette || s.primary?.palette;
  if (pp && s.objs.get(pp)) return s.objs.get(pp).rgb;
  return s.gdiPal || s.defaultPal;
}
// convierte una superficie a RGBA (sin efectos secundarios)
export function surfaceToRGBA(emu, surf, out) {
  const { w, h, bpp, pitch } = surf;
  out = out && out.length === w * h * 4 ? out : new Uint8ClampedArray(w * h * 4);
  const u8 = emu.mem.u8;
  if (bpp === 8) {
    const pal = paletteOf(emu, surf);
    for (let y = 0; y < h; y++) { let src = surf.mem + y * pitch, d = y * w * 4; for (let x = 0; x < w; x++, d += 4) { const c = u8[src + x] * 3; out[d] = pal[c]; out[d + 1] = pal[c + 1]; out[d + 2] = pal[c + 2]; out[d + 3] = 255; } }
  } else if (bpp === 16) {
    const lut = S(emu).lut565 || (S(emu).lut565 = (() => { const t = new Uint8Array(65536 * 3); for (let v = 0; v < 65536; v++) { t[v * 3] = Math.round(((v >> 11) & 31) * 255 / 31); t[v * 3 + 1] = Math.round(((v >> 5) & 63) * 255 / 63); t[v * 3 + 2] = Math.round((v & 31) * 255 / 31); } return t; })());
    for (let y = 0; y < h; y++) { const src = surf.mem + y * pitch; let d = y * w * 4; for (let x = 0; x < w; x++, d += 4) { const v = (u8[src + x * 2] | (u8[src + x * 2 + 1] << 8)) * 3; out[d] = lut[v]; out[d + 1] = lut[v + 1]; out[d + 2] = lut[v + 2]; out[d + 3] = 255; } }
  } else {
    for (let y = 0; y < h; y++) { const src = surf.mem + y * pitch; let d = y * w * 4; for (let x = 0; x < w; x++, d += 4) { out[d] = u8[src + x * 4 + 2]; out[d + 1] = u8[src + x * 4 + 1]; out[d + 2] = u8[src + x * 4]; out[d + 3] = 255; } }
  }
  return out;
}
// "Barrido" del monitor: muestra la primaria actual aunque el juego no haya llamado a Flip/Unlock.
export function scanout(emu) {
  const s = S(emu); if (!s.primary || s.primary.released) return false;
  s.scanouts++;
  s.rgba = surfaceToRGBA(emu, s.primary, s.rgba);
  emu.host.present?.(s.rgba, s.primary.w, s.primary.h);
  return true;
}
export function present(emu, surf) {
  const s = S(emu);
  s.frames++;
  s.dirty = true;
  if (s.frames <= 5 || s.frames % 300 === 0) emu.log('DDRAW', `present #${s.frames} (${s.lastPresentCause || '?'}): ${surf.w}x${surf.h}x${surf.bpp}`);
  if (!emu.host.deferPresent) scanout(emu);
  emu.yieldRequested = true;
}
function presentOld(emu, surf) {
  const s = S(emu);
  const { w, h, bpp, pitch } = surf;
  const out = s.rgba && s.rgba.length === w * h * 4 ? s.rgba : (s.rgba = new Uint8ClampedArray(w * h * 4));
  const u8 = emu.mem.u8;
  if (bpp === 8) {
    const pal = surf.palette ? s.objs.get(surf.palette).rgb : s.defaultPal;
    for (let y = 0; y < h; y++) { let src = surf.mem + y * pitch, d = y * w * 4; for (let x = 0; x < w; x++, d += 4) { const c = u8[src + x] * 3; out[d] = pal[c]; out[d + 1] = pal[c + 1]; out[d + 2] = pal[c + 2]; out[d + 3] = 255; } }
  } else if (bpp === 16) {
    for (let y = 0; y < h; y++) { const src = surf.mem + y * pitch; let d = y * w * 4; for (let x = 0; x < w; x++, d += 4) { const v = u8[src + x * 2] | (u8[src + x * 2 + 1] << 8); out[d] = ((v >> 11) & 31) * 255 / 31; out[d + 1] = ((v >> 5) & 63) * 255 / 63; out[d + 2] = (v & 31) * 255 / 31; out[d + 3] = 255; } }
  } else {
    for (let y = 0; y < h; y++) { const src = surf.mem + y * pitch; let d = y * w * 4; for (let x = 0; x < w; x++, d += 4) { out[d] = u8[src + x * 4 + 2]; out[d + 1] = u8[src + x * 4 + 1]; out[d + 2] = u8[src + x * 4]; out[d + 3] = 255; } }
  }
  emu.host.present?.(out, w, h);
}
function isScreen(o) { return o && (o.caps & DDSCAPS.PRIMARYSURFACE); }
function readRect(emu, p, surf) { if (!p) return [0, 0, surf.w, surf.h]; const m = emu.mem; return [m.r32(p) | 0, m.r32(p + 4) | 0, m.r32(p + 8) | 0, m.r32(p + 12) | 0]; }

function blit(emu, dst, dr, src, sr, keyed, ckOverride = null) {
  if (src.bpp !== dst.bpp) { emu.note(`(Blt entre ${src.bpp} y ${dst.bpp} bpp no soportado)`); return; }
  src.stats.bltOut++; dst.stats.bltIn++;
  const bpp = dst.bpp / 8, u8 = emu.mem.u8;
  const [dl, dt, drr, db] = dr, [sl, st, sR, sb] = sr;
  const dw = drr - dl, dh = db - dt, sw = sR - sl, sh = sb - st;
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
  const ck = ckOverride != null ? ckOverride : keyed && src.ck != null ? src.ck : null;
  for (let y = 0; y < dh; y++) {
    const dy = dt + y; if (dy < 0 || dy >= dst.h) continue;
    const sy = st + Math.floor(y * sh / dh);
    for (let x = 0; x < dw; x++) {
      const dx = dl + x; if (dx < 0 || dx >= dst.w) continue;
      const sx = sl + Math.floor(x * sw / dw);
      const so = src.mem + sy * src.pitch + sx * bpp, d = dst.mem + dy * dst.pitch + dx * bpp;
      if (ck !== null) { let v = 0; for (let k = 0; k < bpp; k++) v |= u8[so + k] << (8 * k); if ((v >>> 0) === ck) continue; }
      for (let k = 0; k < bpp; k++) u8[d + k] = u8[so + k];
    }
  }
}

const surfImpl = {
  ...common,
  Lock: [4, (emu, o, self, rect, desc, flags) => {
    o.locks++; o.stats.locks++;
    let p = o.mem; if (rect) { const [l, t] = readRect(emu, rect, o); p += t * o.pitch + l * o.bpp / 8; }
    writeDesc(emu, desc, o, p); return DD_OK;
  }],
  Unlock: [1, (emu, o) => { o.locks = Math.max(0, o.locks - 1); if (isScreen(o)) { S(emu).lastPresentCause = 'Unlock primaria'; present(emu, o); } return DD_OK; }],
  // Flip rota la memoria de toda la cadena: frente <- back1 <- back2 <- ... <- (frente anterior)
  Flip: [2, (emu, o, self, target, flags) => {
    const s = S(emu);
    if (o.chain && o.chain.length > 1) {
      const surfs = o.chain.map((p) => s.objs.get(p));
      const first = surfs[0].mem;
      for (let i = 0; i < surfs.length - 1; i++) surfs[i].mem = surfs[i + 1].mem;
      surfs[surfs.length - 1].mem = first;
    } else if (o.attached) { const b = s.objs.get(o.attached); const t = o.mem; o.mem = b.mem; b.mem = t; }
    o.stats.flips++;
    s.lastPresentCause = 'Flip';
    present(emu, o); return DD_OK;
  }],
  GetAttachedSurface: [2, (emu, o, self, caps, pp) => {
    const want = emu.mem.r32(caps);
    if (!o.attached) { emu.note(`(sin superficie adjunta para caps ${want.toString(16)})`); return DDERR_NOTFOUND; }
    emu.mem.w32(pp, o.attached); S(emu).objs.get(o.attached).refs++; return DD_OK;
  }],
  EnumAttachedSurfaces: [2, (emu, o, self, ctx, cb) => {
    if (!o.attached) return DD_OK;
    const a = S(emu).objs.get(o.attached); const d = emu.mem.alloc(108); writeDesc(emu, d, a, 0);
    a.refs++; emu.callGuest(cb, [o.attached, d, ctx]); return DD_OK;
  }],
  Release: [0, (emu, o, self) => {
    o.refs = Math.max(0, o.refs - 1);
    if (o.refs === 0 && !o.released) {
      o.released = true;
      const s = S(emu);
      if (s.primary === o) { s.primary = null; for (const p of (o.chain || []).slice(1)) { const b = s.objs.get(p); if (b && !b.released) { b.released = true; emu.mem.free(b.mem); } } }
      if (!o.backOf) emu.mem.free(o.mem);
    }
    return o.refs;
  }],
  AddAttachedSurface: [1, (emu, o, self, other) => { o.attached = other; return DD_OK; }],
  Blt: [5, (emu, o, self, dRect, srcPtr, sRect, flags, fx) => {
    const dr = readRect(emu, dRect, o);
    S(emu).bltCount = (S(emu).bltCount || 0) + 1;
    if (flags & DDBLT.COLORFILL) {
      o.stats.bltIn++;
      const color = emu.mem.r32(fx + 80); const bpp = o.bpp / 8;
      for (let y = Math.max(0, dr[1]); y < Math.min(o.h, dr[3]); y++) for (let x = Math.max(0, dr[0]); x < Math.min(o.w, dr[2]); x++) { const d = o.mem + y * o.pitch + x * bpp; for (let k = 0; k < bpp; k++) emu.mem.u8[d + k] = color >>> (8 * k); }
    } else if (srcPtr) {
      const src = S(emu).objs.get(srcPtr);
      const ckOv = (flags & DDBLT.KEYSRCOVERRIDE) && fx ? emu.mem.r32(fx + 92) : null; // DDBLTFX.ddckSrcColorkey
      blit(emu, o, dr, src, readRect(emu, sRect, src), flags & DDBLT.KEYSRC, ckOv);
    } else { emu.note(`(flags Blt ${flags.toString(16)} no soportados)`); }
    if (isScreen(o)) { S(emu).lastPresentCause = 'Blt a primaria'; present(emu, o); }
    return DD_OK;
  }],
  BltFast: [5, (emu, o, self, x, y, srcPtr, sRect, trans) => {
    const src = S(emu).objs.get(srcPtr); const sr = readRect(emu, sRect, src);
    blit(emu, o, [x | 0, y | 0, (x | 0) + sr[2] - sr[0], (y | 0) + sr[3] - sr[1]], src, sr, trans & 1);
    if (isScreen(o)) { S(emu).lastPresentCause = 'BltFast a primaria'; present(emu, o); }
    return DD_OK;
  }],
  GetSurfaceDesc: [1, (emu, o, self, p) => { writeDesc(emu, p, o, 0); return DD_OK; }],
  GetPixelFormat: [1, (emu, o, self, p) => { writePixelFormat(emu, p, o.bpp); return DD_OK; }],
  GetCaps: [1, (emu, o, self, p) => { emu.mem.w32(p, o.caps); return DD_OK; }],
  SetPalette: [1, (emu, o, self, pal) => { o.palette = pal; if (o.attached) S(emu).objs.get(o.attached).palette = pal; return DD_OK; }],
  GetPalette: [1, (emu, o, self, pp) => { if (!o.palette) return 0x88760053; emu.mem.w32(pp, o.palette); return DD_OK; }],
  SetColorKey: [2, (emu, o, self, flags, ck) => { o.ck = ck ? emu.mem.r32(ck) : null; return DD_OK; }],
  GetColorKey: [2, (emu, o, self, flags, ck) => { emu.mem.w32(ck, o.ck ?? 0); emu.mem.w32(ck + 4, o.ck ?? 0); return DD_OK; }],
  SetClipper: [1, () => DD_OK],
  IsLost: [0, () => DD_OK], Restore: [0, () => DD_OK],
  GetBltStatus: [1, () => DD_OK], GetFlipStatus: [1, () => DD_OK],
  GetDC: [1, (emu, o, self, phdc) => {
    o.stats.getdc++;
    const h = newDC(emu, 'surface', { surf: o, ownerSurface: self });
    o.dcs = (o.dcs || 0) + 1;
    emu.note(`-> HDC ${h.toString(16)} sobre superficie #${o.id} ${o.w}x${o.h}x${o.bpp}`);
    emu.mem.w32(phdc, h); return DD_OK;
  }],
  ReleaseDC: [1, (emu, o, self, hdc) => {
    gdiState(emu).objs.delete(hdc);
    if (isScreen(o)) { S(emu).lastPresentCause = 'ReleaseDC primaria'; present(emu, o); }
    return DD_OK;
  }],
};
const palImpl = {
  ...common,
  SetEntries: [4, (emu, o, self, flags, start, count, entries) => {
    for (let i = 0; i < count; i++) { const e = entries + i * 4; o.rgb[(start + i) * 3] = emu.mem.r8(e); o.rgb[(start + i) * 3 + 1] = emu.mem.r8(e + 1); o.rgb[(start + i) * 3 + 2] = emu.mem.r8(e + 2); }
    const prim = S(emu).primary; if (prim && prim.palette === self) present(emu, prim);
    return DD_OK;
  }],
  GetEntries: [4, (emu, o, self, flags, start, count, entries) => {
    for (let i = 0; i < count; i++) { const e = entries + i * 4; emu.mem.w8(e, o.rgb[(start + i) * 3]); emu.mem.w8(e + 1, o.rgb[(start + i) * 3 + 1]); emu.mem.w8(e + 2, o.rgb[(start + i) * 3 + 2]); emu.mem.w8(e + 3, 0); }
    return DD_OK;
  }],
  GetCaps: [1, (emu, o, self, p) => { emu.mem.w32(p, 4); return DD_OK; }],
};
const clipImpl = { ...common, SetHWnd: [2, () => DD_OK], GetHWnd: [1, (emu, o, s, p) => { emu.mem.w32(p, 0); return DD_OK; }], SetClipList: [2, () => DD_OK] };

function ddImpl(v2) {
  return {
    ...common,
    QueryInterface: [2, (emu, o, self, riid, ppv) => {
      const d1 = emu.mem.r32(riid);
      // IID_IDirectDraw2 = B3A6F3E0-2B43-11CF-...
      if (d1 === 0xb3a6f3e0) { const p = newObj(emu, 'IDirectDraw2', IDD2, ddImpl(true), { ...o, refs: 1 }); emu.mem.w32(ppv, p); emu.note('-> IDirectDraw2'); return DD_OK; }
      emu.mem.w32(ppv, self); emu.note(`IID ${d1.toString(16)} -> mismo objeto`); return DD_OK;
    }],
    SetCooperativeLevel: [2, (emu, o, self, hwnd, flags) => { emu.note(`(flags ${flags.toString(16)}: ${flags & 0x11 ? 'EXCLUSIVE|FULLSCREEN' : 'NORMAL'})`); return DD_OK; }],
    SetDisplayMode: [v2 ? 5 : 3, (emu, o, self, w, h, bpp) => {
      const s = S(emu); s.mode = { w, h, bpp }; emu.state.ddBpp = bpp;
      emu.log('DDRAW', `SetDisplayMode(${w}x${h}x${bpp}) -> canvas ${w}x${h}`);
      emu.host.setMode?.(w, h, bpp); return DD_OK;
    }],
    RestoreDisplayMode: [0, () => DD_OK],
    GetDisplayMode: [1, (emu, o, self, p) => { const md = S(emu).mode || { w: 640, h: 480, bpp: 16 }; writeDesc(emu, p, { w: md.w, h: md.h, bpp: md.bpp, pitch: md.w * md.bpp / 8, caps: 0 }, 0); return DD_OK; }],
    EnumDisplayModes: [4, (emu, o, self, flags, desc, ctx, cb) => {
      const modes = [[320, 200, 8], [320, 240, 8], [640, 480, 8], [320, 240, 16], [640, 480, 16], [800, 600, 16], [640, 480, 32]];
      const p = emu.mem.alloc(108);
      for (const [w, h, b] of modes) {
        writeDesc(emu, p, { w, h, bpp: b, pitch: w * b / 8, caps: 0 }, 0);
        const r = emu.callGuest(cb, [p, ctx]);
        if (!r) break;
      }
      return DD_OK;
    }],
    GetCaps: [2, (emu, o, self, drv, hel) => {
      for (const p of [drv, hel]) {
        if (!p) continue; const n = emu.mem.r32(p) || 316; emu.mem.fill(p + 4, 0, Math.min(n, 380) - 4);
        emu.mem.w32(p + 4, 0x40 | 0x04000000 | 0x8000 | 0x200 | 0x10000); // BLT|BLTCOLORFILL|PALETTE|BLTSTRETCH|COLORKEY
        emu.mem.w32(p + 12, 0x200); // DDCKEYCAPS_SRCBLT
        emu.mem.w32(p + 24, 0x4 | 0x40); // DDPCAPS_8BIT|PRIMARYSURFACE
        if (n >= 68) { emu.mem.w32(p + 60, 8 << 20); emu.mem.w32(p + 64, 8 << 20); }
      }
      return DD_OK;
    }],
    GetAvailableVidMem: [3, (emu, o, self, caps, total, free) => { if (total) emu.mem.w32(total, 8 << 20); if (free) emu.mem.w32(free, 8 << 20); return DD_OK; }],
    GetMonitorFrequency: [1, (emu, o, self, p) => { emu.mem.w32(p, 60); return DD_OK; }],
    WaitForVerticalBlank: [2, (emu) => { emu.yieldRequested = true; return DD_OK; }],
    GetVerticalBlankStatus: [1, (emu, o, self, p) => { emu.mem.w32(p, 1); return DD_OK; }],
    FlipToGDISurface: [0, () => DD_OK],
    CreateSurface: [3, (emu, o, self, desc, pp) => {
      const m = emu.mem, s = S(emu);
      const flags = m.r32(desc + 4), caps = m.r32(desc + 104);
      const mode = s.mode || { w: 640, h: 480, bpp: 16 };
      let bpp = mode.bpp;
      if (flags & DDSD.PIXELFORMAT) bpp = m.r32(desc + 84) || bpp;
      let w = flags & DDSD.WIDTH ? m.r32(desc + 12) : mode.w, h = flags & DDSD.HEIGHT ? m.r32(desc + 8) : mode.h;
      if (caps & DDSCAPS.PRIMARYSURFACE) { w = mode.w; h = mode.h; bpp = mode.bpp; }
      if (caps & DDSCAPS.PRIMARYSURFACE && s.primary && !s.primary.released) emu.log('DDRAW', `ADVERTENCIA: se crea otra primaria sin liberar la anterior (#${s.primary.id})`);
      const surf = makeSurface(emu, w, h, bpp, caps | (caps & DDSCAPS.PRIMARYSURFACE ? DDSCAPS.FRONTBUFFER | DDSCAPS.VIDEOMEMORY : 0));
      const p = newObj(emu, 'IDirectDrawSurface', IDDS, surfImpl, surf);
      if (caps & DDSCAPS.PRIMARYSURFACE) {
        s.primary = surf;
        const n = flags & DDSD.BACKBUFFERCOUNT ? m.r32(desc + 20) : 0;
        surf.backCount = n;
        if (n) {
          // cadena real: frente -> back1 -> back2 ... ; GetAttachedSurface(BACKBUFFER) sobre el frente da back1
          surf.chain = [p];
          let prev = surf;
          for (let i = 0; i < n; i++) {
            const back = makeSurface(emu, w, h, bpp, (i === 0 ? DDSCAPS.BACKBUFFER : 0) | DDSCAPS.FLIP | DDSCAPS.COMPLEX | DDSCAPS.VIDEOMEMORY);
            back.backOf = p; back.chain = surf.chain;
            const bp = newObj(emu, 'IDirectDrawSurface', IDDS, surfImpl, back);
            prev.attached = bp; surf.chain.push(bp); prev = back;
          }
          prev.attached = p; // el último apunta de nuevo al frente (como en DirectDraw)
        }
      }
      if (flags & DDSD.CKSRCBLT) surf.ck = m.r32(desc + 64);
      emu.log('DDRAW', `CreateSurface ${w}x${h}x${bpp} caps=${caps.toString(16)}${caps & DDSCAPS.PRIMARYSURFACE ? ' PRIMARIA' : ''}${surf.backCount ? ` +${surf.backCount} backbuffer` : ''} -> ${p.toString(16)} pixeles@${surf.mem.toString(16)}`);
      m.w32(pp, p); return DD_OK;
    }],
    CreatePalette: [4, (emu, o, self, flags, entries, pp) => {
      const rgb = new Uint8Array(768);
      for (let i = 0; i < 256; i++) { rgb[i * 3] = emu.mem.r8(entries + i * 4); rgb[i * 3 + 1] = emu.mem.r8(entries + i * 4 + 1); rgb[i * 3 + 2] = emu.mem.r8(entries + i * 4 + 2); }
      emu.mem.w32(pp, newObj(emu, 'IDirectDrawPalette', IDDP, palImpl, { rgb })); return DD_OK;
    }],
    CreateClipper: [3, (emu, o, self, flags, pp) => { emu.mem.w32(pp, newObj(emu, 'IDirectDrawClipper', IDDC, clipImpl, {})); return DD_OK; }],
  };
}

const D = {
  __init(emu) {
    const pal = new Uint8Array(768); for (let i = 0; i < 256; i++) pal[i * 3] = pal[i * 3 + 1] = pal[i * 3 + 2] = i;
    emu.state.dd = { vtables: new Map(), objs: new Map(), mode: null, primary: null, frames: 0, scanouts: 0, surfSeq: 0, defaultPal: pal };
    emu.ddPaletteOf = (surf) => paletteOf(emu, surf);
    emu.scanout = () => scanout(emu);
  },
  DirectDrawCreate: api(3, (emu, guid, pp, unk) => {
    const p = newObj(emu, 'IDirectDraw', IDD, ddImpl(false), {});
    emu.mem.w32(pp, p);
    emu.log('DDRAW', `DirectDrawCreate -> IDirectDraw en ${p.toString(16)} (vtable ${emu.mem.r32(p).toString(16)}, ${IDD.length} métodos)`);
    return DD_OK;
  }),
  DirectDrawEnumerateA: api(2, (emu, cb, ctx) => {
    const d = emu.sysString('Display'), n = emu.sysString('display');
    emu.callGuest(cb, [0, d, n, ctx]); return DD_OK;
  }),
  DirectDrawCreateClipper: api(3, (emu, f, pp) => { emu.mem.w32(pp, newObj(emu, 'IDirectDrawClipper', IDDC, clipImpl, {})); return DD_OK; }),
};
export default D;
export { newObj, common as comCommon };
