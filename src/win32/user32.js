// user32.js — ventanas, cola de mensajes, entrada. La "ventana" es el <canvas>.
import { api, cdecl, formatPrintf } from './common.js';
import { newDC, G as gdiState, gdiObj, dcView, fillView, refToRaw, brushRef, loadPackedDIB, newGdi } from './gdi_core.js';

const WM = { NULL: 0, CREATE: 1, DESTROY: 2, SIZE: 5, ACTIVATE: 6, SETFOCUS: 7, PAINT: 0xf, CLOSE: 0x10, QUIT: 0x12, ACTIVATEAPP: 0x1c, NCCREATE: 0x81, KEYDOWN: 0x100, KEYUP: 0x101, CHAR: 0x102, TIMER: 0x113, MOUSEMOVE: 0x200, LBUTTONDOWN: 0x201, LBUTTONUP: 0x202 };
export { WM };

function st(emu) { return emu.state.user; }
const nowMs = (emu) => emu.nowMs();

function writeMsg(emu, p, m) {
  const M = emu.mem;
  M.w32(p, m.hwnd); M.w32(p + 4, m.msg); M.w32(p + 8, m.wParam); M.w32(p + 12, m.lParam);
  M.w32(p + 16, Math.floor(nowMs(emu)) >>> 0); M.w32(p + 20, 0); M.w32(p + 24, 0);
}
function pumpTimers(emu) {
  const s = st(emu), t = nowMs(emu);
  for (const tm of s.timers.values()) if (t - tm.last >= tm.ms) { tm.last = t; s.queue.push({ hwnd: tm.hwnd, msg: WM.TIMER, wParam: tm.id, lParam: tm.proc }); }
}
function sendToWnd(emu, hwnd, msg, wParam, lParam) {
  const w = st(emu).windows.get(hwnd);
  if (!w || !w.wndproc) return 0;
  return emu.callGuest(w.wndproc, [hwnd, msg, wParam, lParam]);
}

// Parser de plantillas RT_DIALOG Win32 (DLGTEMPLATE y DLGTEMPLATEEX).
// Valida límites y extrae IDs reales; no inventa controles.
function parseDialog(emu, addr, size) {
  const m = emu.mem, end = addr + size;
  const check = (p, n) => { if (p < addr || p + n > end) throw new Error(`RT_DIALOG truncado en ${p.toString(16)}`); };
  const u16 = p => { check(p, 2); return m.r16(p); };
  const u32 = p => { check(p, 4); return m.r32(p); };
  const align4 = p => (p + 3) & ~3;
  const wordOrString = p => {
    const x = u16(p);
    if (x === 0) return { value: '', next: p + 2 };
    if (x === 0xffff) return { value: `#${u16(p + 2)}`, next: p + 4 };
    let out = '';
    while (true) { const c = u16(p); p += 2; if (!c) break; out += String.fromCharCode(c); }
    return { value: out, next: p };
  };
  const extended = u16(addr) === 1 && u16(addr + 2) === 0xffff;
  let p, style, count;
  if (extended) { style = u32(addr + 12); count = u16(addr + 16); p = addr + 26; }
  else { style = u32(addr); count = u16(addr + 8); p = addr + 18; }
  let menu = wordOrString(p); p = menu.next;
  let cls = wordOrString(p); p = cls.next;
  let title = wordOrString(p); p = title.next;
  if (style & 0x40) { // DS_SETFONT
    p += extended ? 6 : 2;
    if (extended) { // weight, italic, charset already covered in 6 bytes
    }
    p = wordOrString(p).next;
  }
  const controls = [];
  for (let i = 0; i < count; i++) {
    p = align4(p);
    const id = extended ? u32(p + 20) : u16(p + 16);
    p += extended ? 24 : 18;
    const klass = wordOrString(p); p = klass.next;
    const caption = wordOrString(p); p = caption.next;
    const extra = u16(p); p += 2 + extra;
    check(p - 1, 1);
    controls.push({ id, klass: klass.value, caption: caption.value });
  }
  return { title: title.value, controls, extended };
}

const U = {
  __init(emu) {
    emu.state.user = { classes: new Map(), windows: new Map(), nextHwnd: 0x10010, queue: [], timers: new Map(), keys: new Uint8Array(256), quit: false, cursorShown: 0, focus: 0 };
    // API para el host (navegador): inyectar teclado
    emu.keyEvent = (vk, down) => {
      const s = st(emu); s.keys[vk & 255] = down ? 0x80 : 0;
      const hwnd = s.focus || [...s.windows.keys()][0] || 0;
      s.queue.push({ hwnd, msg: down ? WM.KEYDOWN : WM.KEYUP, wParam: vk, lParam: down ? 1 : 0xc0000001 });
    };
  },
  CreateDialogParamA: api(5, (emu, instance, name, parent, proc, param) => {
    const id = name < 0x10000 ? name : emu.mem.cstr(name);
    const res = emu.findResource(instance, 5, id); // RT_DIALOG
    if (!res) { emu.log('DIALOG', `recurso ${id} no encontrado`); return 0; }
    let dialog;
    try { dialog = parseDialog(emu, res.addr, res.size); }
    catch (e) { emu.log('DIALOG', `recurso ${id} inválido: ${e.message}`); return 0; }
    const s = st(emu), hwnd = s.nextHwnd; s.nextHwnd += 4;
    const win = { cls: '#32770', title: dialog.title, wndproc: proc, style: 0, w: 640, h: 480, longs: new Map(), parent, dialog: true, controls: new Map() };
    for (const ctl of dialog.controls) win.controls.set(ctl.id, { ...ctl, text: ctl.caption, hwnd: s.nextHwnd });
    s.nextHwnd += dialog.controls.length * 4;
    s.windows.set(hwnd, win);
    emu.log('DIALOG', `RT_DIALOG ${id}: hwnd=${hwnd.toString(16)} título="${dialog.title}" controles=${dialog.controls.length}`);
    if (proc) emu.callGuest(proc, [hwnd, 0x110, 0, param]); // WM_INITDIALOG
    return hwnd;
  }),
  SendDlgItemMessageA: api(5, (emu, hwnd, id, msg, wp, lp) => {
    const ctl = st(emu).windows.get(hwnd)?.controls?.get(id);
    if (!ctl) return 0;
    // Common Controls: barra de progreso (PBM_SETRANGE, PBM_SETPOS, PBM_DELTAPOS, PBM_SETSTEP, PBM_STEPIT)
    if (msg === 0x401) { ctl.min = lp & 0xffff; ctl.max = (lp >>> 16) & 0xffff; return 1; }
    if (msg === 0x402) { const prev = ctl.pos || 0; ctl.pos = wp; return prev; }
    if (msg === 0x403) { const prev = ctl.pos || 0; ctl.pos = prev + (wp | 0); return prev; }
    if (msg === 0x404) { const prev = ctl.step || 10; ctl.step = wp; return prev; }
    if (msg === 0x405) { const prev = ctl.pos || 0; ctl.pos = prev + (ctl.step || 10); return prev; }
    emu.note(`control ${id} mensaje no implementado ${msg.toString(16)}`);
    return 0;
  }),
  GetDlgItem: api(2, (emu, hwnd, id) => st(emu).windows.get(hwnd)?.controls?.get(id)?.hwnd || 0),
  GetDlgCtrlID: api(1, (emu, hwnd) => {
    for (const win of st(emu).windows.values()) for (const ctl of win.controls?.values() || []) if (ctl.hwnd === hwnd) return ctl.id;
    return 0;
  }),
  SetDlgItemTextA: api(3, (emu, hwnd, id, str) => {
    const ctl = st(emu).windows.get(hwnd)?.controls?.get(id);
    if (!ctl) return 0; ctl.text = emu.mem.cstr(str) || ''; return 1;
  }),
  GetDlgItemTextA: api(4, (emu, hwnd, id, buf, max) => {
    const ctl = st(emu).windows.get(hwnd)?.controls?.get(id);
    return ctl && max ? emu.mem.writeCStr(buf, ctl.text || '', max) : 0;
  }),
  EndDialog: api(2, (emu, hwnd, result) => { st(emu).windows.delete(hwnd); return 1; }),
  IsDialogMessageA: api(2, () => 0),
  GetInputState: api(0, (emu) => st(emu).queue.length ? 1 : 0),
  GetWindowThreadProcessId: api(2, (emu, hwnd, out) => { if (out) emu.mem.w32(out, 1); return 1; }),
  GetWindowTextA: api(3, (emu, hwnd, buf, max) => max ? emu.mem.writeCStr(buf, st(emu).windows.get(hwnd)?.title || '', max) : 0),
  GetSysColor: api(1, () => 0xc0c0c0),
  CloseWindow: api(1, () => 1),
  EnumWindows: api(2, () => 1), // No hay ventanas externas al proceso en el entorno aislado
  RegisterClassA: api(1, (emu, p) => {
    const m = emu.mem; const proc = m.r32(p + 4); const pn = m.r32(p + 36);
    const name = pn < 0x10000 ? `#${pn}` : m.cstr(pn).toUpperCase();
    st(emu).classes.set(name, { wndproc: proc }); emu.note(`clase "${name}" wndproc=${proc.toString(16)}`);
    return 0xc000 + st(emu).classes.size;
  }),
  RegisterClassExA: api(1, (emu, p) => {
    const m = emu.mem; const proc = m.r32(p + 8); const pn = m.r32(p + 40);
    const name = pn < 0x10000 ? `#${pn}` : m.cstr(pn).toUpperCase();
    st(emu).classes.set(name, { wndproc: proc }); emu.note(`clase "${name}" wndproc=${proc.toString(16)}`);
    return 0xc000 + st(emu).classes.size;
  }),
  UnregisterClassA: api(2, () => 1),
  CreateWindowExA: api(12, (emu, exStyle, pClass, pTitle, style, x, y, w, h, parent, menu, inst, param) => {
    const s = st(emu), m = emu.mem;
    const cls = pClass < 0x10000 ? `#${pClass}` : m.cstr(pClass).toUpperCase();
    const title = pTitle ? m.cstr(pTitle) : '';
    const c = s.classes.get(cls);
    const hwnd = s.nextHwnd; s.nextHwnd += 4;
    const win = { cls, title, wndproc: c ? c.wndproc : 0, style, w: (w | 0) > 0 ? w : 640, h: (h | 0) > 0 ? h : 480, longs: new Map() };
    s.windows.set(hwnd, win);
    if (!s.focus) s.focus = hwnd;
    emu.note(`"${cls}" "${title}" -> hwnd ${hwnd.toString(16)}`);
    emu.host.setTitle?.(title);
    if (win.wndproc) {
      const cs = m.alloc(48);
      m.w32(cs, param); m.w32(cs + 4, inst); m.w32(cs + 8, menu); m.w32(cs + 12, parent);
      m.w32(cs + 16, h); m.w32(cs + 20, w); m.w32(cs + 24, y); m.w32(cs + 28, x); m.w32(cs + 32, style); m.w32(cs + 36, pTitle); m.w32(cs + 40, pClass); m.w32(cs + 44, exStyle);
      emu.log('USER', `Enviando WM_NCCREATE/WM_CREATE a wndproc ${win.wndproc.toString(16)}`);
      sendToWnd(emu, hwnd, WM.NCCREATE, 0, cs);
      const r = sendToWnd(emu, hwnd, WM.CREATE, 0, cs);
      if ((r | 0) === -1) { s.windows.delete(hwnd); return 0; }
    }
    return hwnd;
  }),
  DestroyWindow: api(1, (emu, h) => { sendToWnd(emu, h, WM.DESTROY, 0, 0); st(emu).windows.delete(h); return 1; }),
  ShowWindow: api(2, (emu, h) => { st(emu).queue.push({ hwnd: h, msg: WM.ACTIVATEAPP, wParam: 1, lParam: 0 }); return 0; }),
  UpdateWindow: api(1, (emu, h) => { sendToWnd(emu, h, WM.PAINT, 0, 0); return 1; }),
  SetFocus: api(1, (emu, h) => { const o = st(emu).focus; st(emu).focus = h; return o; }),
  GetFocus: api(0, (emu) => st(emu).focus),
  SetForegroundWindow: api(1, () => 1),
  GetForegroundWindow: api(0, (emu) => st(emu).focus),
  GetActiveWindow: api(0, (emu) => st(emu).focus),
  SetActiveWindow: api(1, (emu, h) => st(emu).focus),
  BringWindowToTop: api(1, () => 1),
  IsIconic: api(1, () => 0), IsWindow: api(1, (emu, h) => (st(emu).windows.has(h) ? 1 : 0)),
  IsWindowVisible: api(1, () => 1), EnableWindow: api(2, () => 0),
  FindWindowA: api(2, () => 0),
  SetWindowPos: api(7, () => 1), MoveWindow: api(6, () => 1),
  SetWindowTextA: api(2, (emu, h, p) => { emu.host.setTitle?.(emu.mem.cstr(p)); return 1; }),
  GetWindowLongA: api(2, (emu, h, i) => { const w = st(emu).windows.get(h); if (!w) return 0; if ((i | 0) === -4) return w.wndproc; return w.longs.get(i | 0) || 0; }),
  SetWindowLongA: api(3, (emu, h, i, v) => { const w = st(emu).windows.get(h); if (!w) return 0; if ((i | 0) === -4) { const o = w.wndproc; w.wndproc = v; return o; } const o = w.longs.get(i | 0) || 0; w.longs.set(i | 0, v); return o; }),
  GetClientRect: api(2, (emu, h, p) => { const w = st(emu).windows.get(h) || { w: 640, h: 480 }; const m = emu.mem; m.w32(p, 0); m.w32(p + 4, 0); m.w32(p + 8, w.w); m.w32(p + 12, w.h); return 1; }),
  GetWindowRect: api(2, (emu, h, p) => { const w = st(emu).windows.get(h) || { w: 640, h: 480 }; const m = emu.mem; m.w32(p, 0); m.w32(p + 4, 0); m.w32(p + 8, w.w); m.w32(p + 12, w.h); return 1; }),
  AdjustWindowRect: api(3, () => 1), AdjustWindowRectEx: api(4, () => 1),
  ClientToScreen: api(2, () => 1), ScreenToClient: api(2, () => 1),
  GetSystemMetrics: api(1, (emu, i) => ({ 0: 640, 1: 480, 16: 640, 17: 480, 19: 1, 43: 3 }[i] ?? 0)),
  SystemParametersInfoA: api(4, () => 1),
  // ---- mensajes ----
  PeekMessageA: api(5, (emu, p, hwnd, min, max, remove) => {
    const s = st(emu); pumpTimers(emu);
    if (!s.queue.length) { emu.idlePeeks = (emu.idlePeeks || 0) + 1; return 0; } // sin yield: un bucle de espera no debe costar un frame del navegador
    const msg = s.queue[0]; if (remove & 1) s.queue.shift();
    writeMsg(emu, p, msg); return 1;
  }, { quiet: true }),
  GetMessageA: api(4, (emu, p, hwnd) => {
    const s = st(emu); pumpTimers(emu);
    if (s.quit && !s.queue.length) { writeMsg(emu, p, { hwnd: 0, msg: WM.QUIT, wParam: s.quitCode || 0, lParam: 0 }); return 0; }
    emu.yieldRequested = true;
    const msg = s.queue.shift() || { hwnd: s.focus, msg: WM.NULL, wParam: 0, lParam: 0 };
    writeMsg(emu, p, msg); return msg.msg === WM.QUIT ? 0 : 1;
  }, { quiet: true }),
  WaitMessage: api(0, (emu) => { emu.yieldRequested = true; return 1; }),
  TranslateMessage: api(1, () => 0, { quiet: true }),
  DispatchMessageA: api(1, (emu, p) => {
    const m = emu.mem; const hwnd = m.r32(p), msg = m.r32(p + 4), wp = m.r32(p + 8), lp = m.r32(p + 12);
    if (msg === WM.TIMER && lp) return emu.callGuest(lp, [hwnd, msg, wp, Math.floor(nowMs(emu)) >>> 0]);
    return sendToWnd(emu, hwnd, msg, wp, lp);
  }, { quiet: true }),
  SendMessageA: api(4, (emu, h, msg, wp, lp) => sendToWnd(emu, h, msg, wp, lp)),
  PostMessageA: api(4, (emu, h, msg, wp, lp) => { st(emu).queue.push({ hwnd: h, msg, wParam: wp, lParam: lp }); return 1; }),
  PostQuitMessage: api(1, (emu, code) => { const s = st(emu); s.quit = true; s.quitCode = code; s.queue.push({ hwnd: 0, msg: WM.QUIT, wParam: code, lParam: 0 }); }),
  DefWindowProcA: api(4, (emu, h, msg) => (msg === WM.NCCREATE ? 1 : 0), { quiet: true }),
  CallWindowProcA: api(5, (emu, proc, h, msg, wp, lp) => emu.callGuest(proc, [h, msg, wp, lp])),
  SetTimer: api(4, (emu, h, id, ms, proc) => { const s = st(emu); const tid = id || 0x1000 + s.timers.size; s.timers.set(`${h}:${tid}`, { hwnd: h, id: tid, ms: Math.max(ms, 10), proc, last: nowMs(emu) }); return tid; }),
  KillTimer: api(2, (emu, h, id) => (st(emu).timers.delete(`${h}:${id}`) ? 1 : 0)),
  // ---- entrada ----
  GetAsyncKeyState: api(1, (emu, vk) => { const q = emu.state.keyQueries || (emu.state.keyQueries = new Map()); q.set(vk & 255, (q.get(vk & 255) || 0) + 1); return st(emu).keys[vk & 255] ? 0x8000 : 0; }, { quiet: true }),
  GetKeyState: api(1, (emu, vk) => (st(emu).keys[vk & 255] ? 0xff80 : 0), { quiet: true }),
  GetKeyboardState: api(1, (emu, p) => { emu.mem.writeBytes(p, st(emu).keys); return 1; }),
  MapVirtualKeyA: api(2, (emu, c) => c),
  SetCapture: api(1, () => 0), ReleaseCapture: api(0, () => 1),
  GetCursorPos: api(1, (emu, p) => { emu.mem.w32(p, 320); emu.mem.w32(p + 4, 240); return 1; }),
  SetCursorPos: api(2, () => 1),
  ShowCursor: api(1, (emu, show) => { const s = st(emu); s.cursorShown += show ? 1 : -1; return s.cursorShown; }),
  SetCursor: api(1, () => 0), LoadCursorA: api(2, () => 0x7f00), LoadIconA: api(2, () => 0x7f01),
  ClipCursor: api(1, () => 1),
  // ---- recursos de UI ----
  LoadStringA: api(4, (emu, hInst, id, buf, n) => {
    const r = emu.findResource(hInst, 6, (id >> 4) + 1);
    let s = '';
    if (r) {
      let p = r.addr;
      for (let i = 0; i < (id & 15); i++) p += 2 + emu.mem.r16(p) * 2;
      const len = emu.mem.r16(p);
      for (let i = 0; i < len; i++) s += String.fromCharCode(emu.mem.r16(p + 2 + i * 2));
    }
    emu.note(`id=${id} -> "${s}"${r ? '' : ' (recurso no encontrado)'}`);
    if (!n) return 0;
    return emu.mem.writeCStr(buf, s, n);
  }),
  LoadAcceleratorsA: api(2, () => 0x7f10), TranslateAcceleratorA: api(3, () => 0),
  GetSubMenu: api(2, (emu, menu, index) => 0),
  EnableMenuItem: api(3, () => 0xffffffff),
  CheckMenuItem: api(3, (emu, menu, item, flags) => 0xffffffff),
  WINNLSEnableIME: api(2, () => 1), // IME no requerido para entrada de teclado latino
  GetDesktopWindow: api(0, () => 0x10000),
  GetMenu: api(1, (emu, hwnd) => st(emu).windows.get(hwnd)?.menu || 0),
  LoadMenuA: api(2, (emu, h, name) => {
    const id = name < 0x10000 ? name : emu.mem.cstr(name);
    const r = emu.findResource(h, 4, id);
    emu.note(`menu ${id}: ${r ? "encontrado" : "no encontrado"}`);
    return r ? emu.newHandle({ type: "menu", ...r }) : 0;
  }), SetMenu: api(2, () => 1), DestroyMenu: api(1, () => 1),
  MessageBoxA: api(4, (emu, h, text, cap, type) => {
    const t = emu.mem.cstr(text), c = cap ? emu.mem.cstr(cap) : '';
    emu.log('MSGBOX', `"${c}": ${t}`); emu.host.messageBox?.(c, t); return 1;
  }),
  // En pantalla completa el DC de la ventana (o del escritorio) dibuja sobre la primaria
  GetDC: api(1, (emu, h) => newDC(emu, 'window', { hwnd: h })),
  GetWindowDC: api(1, (emu, h) => newDC(emu, 'window', { hwnd: h })),
  ReleaseDC: api(2, (emu, h, hdc) => { gdiState(emu).objs.delete(hdc); return 1; }),
  BeginPaint: api(2, (emu, h, p) => { const d = newDC(emu, 'window', { hwnd: h }); emu.mem.fill(p, 0, 64); emu.mem.w32(p, d); emu.mem.w32(p + 16, 640); emu.mem.w32(p + 20, 480); return d; }),
  EndPaint: api(2, (emu, h, p) => { gdiState(emu).objs.delete(emu.mem.r32(p)); return 1; }),
  LoadBitmapA: api(2, (emu, hInst, name) => {
    const id = name < 0x10000 ? name : emu.mem.cstr(name);
    const r = emu.findResource(hInst, 2, id); // RT_BITMAP
    if (!r) { emu.note(`(RT_BITMAP ${id} no encontrado)`); return 0; }
    const b = loadPackedDIB(emu, r.addr, r.size, `RT_BITMAP ${id}`, true);
    emu.note(`RT_BITMAP ${id}: ${b.w}x${Math.abs(b.height)}x${b.bpp}`);
    return newGdi(emu, b);
  }),
  LoadImageA: api(6, (emu, hInst, name, type, cx, cy, flags) => {
    if (type !== 0) { emu.note('(icono/cursor: handle simbólico)'); return 0x7f20; }
    const fromFile = flags & 0x10;
    const id = name < 0x10000 ? name : emu.mem.cstr(name);
    let addr, size, src;
    if (fromFile) {
      const f = emu.vfs.find(id); if (!f) { emu.note(`("${id}" no está en el VFS)`); return 0; }
      if (f.data[0] !== 0x42 || f.data[1] !== 0x4d) { emu.note('(no es BMP)'); return 0; }
      size = f.data.length - 14; addr = emu.mem.alloc(size); emu.mem.writeBytes(addr, f.data.subarray(14)); src = `archivo ${id}`;
    } else {
      const r = emu.findResource(hInst, 2, id); if (!r) { emu.note(`(RT_BITMAP ${id} no encontrado)`); return 0; }
      addr = r.addr; size = r.size; src = `RT_BITMAP ${id}`;
    }
    const b = loadPackedDIB(emu, addr, size, src, !(flags & 0x2000));
    emu.note(`${src}: ${b.w}x${Math.abs(b.height)}x${b.bpp}`);
    return newGdi(emu, b);
  }),
  InvalidateRect: api(3, () => 1), ValidateRect: api(2, () => 1),
  FillRect: api(3, (emu, hdc, rc, hbr) => {
    const d = gdiObj(emu, hdc), v = dcView(emu, d); if (!v) return 1;
    const m = emu.mem, l = m.r32(rc) | 0, t = m.r32(rc + 4) | 0, r = m.r32(rc + 8) | 0, b = m.r32(rc + 12) | 0;
    const ref = hbr <= 31 ? 0xc0c0c0 : brushRef(emu, hbr); // COLOR_xxx+1 => color de sistema
    fillView(emu, v, l, t, r - l, b - t, refToRaw(v, ref ?? 0));
    if (d.kind !== 'mem') emu.state.dd.dirty = true;
    return 1;
  }),
  wsprintfA: cdecl((emu, buf, fmt) => {
    const s = formatPrintf(emu, emu.mem.cstr(fmt), emu.cpu.r[4] + 12);
    emu.note(`-> "${s.slice(0, 80)}"`); return emu.mem.writeCStr(buf, s);
  }),
  wvsprintfA: api(3, (emu, buf, fmt, va) => emu.mem.writeCStr(buf, formatPrintf(emu, emu.mem.cstr(fmt), va))),
  CharUpperBuffA: api(2, (emu, p, n) => {
    for (let i = 0; i < n; i++) { const c = emu.mem.r8(p + i); if (c >= 97 && c <= 122) emu.mem.w8(p + i, c - 32); }
    return n;
  }),
  CharUpperA: api(1, (emu, p) => { if (p < 0x10000) return String.fromCharCode(p).toUpperCase().charCodeAt(0); emu.mem.writeCStr(p, emu.mem.cstr(p).toUpperCase()); return p; }),
  CharLowerA: api(1, (emu, p) => { if (p < 0x10000) return String.fromCharCode(p).toLowerCase().charCodeAt(0); emu.mem.writeCStr(p, emu.mem.cstr(p).toLowerCase()); return p; }),
  CharNextA: api(1, (emu, p) => (emu.mem.r8(p) ? p + 1 : p)),
};
export default U;
