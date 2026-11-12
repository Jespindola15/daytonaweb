// common.js — helpers para declarar APIs stdcall/cdecl
export const api = (n, fn, extra = {}) => ({ n, fn, ...extra });
export const cdecl = (fn) => ({ n: 0, cdecl: true, fn });
export const stub = (n, ret = 0, note = 'stub') => ({ n, fn: (emu) => { emu.note(`(${note})`); return ret; }, stub: true });

// Formateador estilo printf/wsprintf sobre memoria del guest
export function formatPrintf(emu, fmt, argPtr, wide = false) {
  const m = emu.mem;
  let out = '', ap = argPtr;
  const next = () => { const v = m.r32(ap); ap += 4; return v; };
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch !== '%') { out += ch; continue; }
    let j = i + 1, flags = '', width = '', prec = '', len = '';
    while ('-+ #0'.includes(fmt[j]) && j < fmt.length) flags += fmt[j++];
    if (fmt[j] === '*') { width = String(next() | 0); j++; } else while (/[0-9]/.test(fmt[j])) width += fmt[j++];
    if (fmt[j] === '.') { j++; if (fmt[j] === '*') { prec = String(next() | 0); j++; } else while (/[0-9]/.test(fmt[j])) prec += fmt[j++]; }
    while ('lhLI'.includes(fmt[j]) && j < fmt.length) len += fmt[j++];
    const t = fmt[j];
    let s;
    switch (t) {
      case '%': s = '%'; break;
      case 'd': case 'i': s = String(next() | 0); break;
      case 'u': s = String(next() >>> 0); break;
      case 'x': s = (next() >>> 0).toString(16); break;
      case 'X': s = (next() >>> 0).toString(16).toUpperCase(); break;
      case 'p': s = (next() >>> 0).toString(16).toUpperCase().padStart(8, '0'); break;
      case 'c': s = String.fromCharCode(next() & 0xff); break;
      case 's': { const p = next(); s = p ? (wide ? m.wstr(p) : m.cstr(p)) : '(null)'; if (prec) s = s.slice(0, +prec); break; }
      case 'S': { const p = next(); s = p ? m.wstr(p) : '(null)'; break; }
      case 'f': case 'g': case 'e': { const lo = next(), hi = next(); const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, lo, true); dv.setUint32(4, hi, true); const v = dv.getFloat64(0, true); s = t === 'f' ? v.toFixed(prec ? +prec : 6) : String(v); break; }
      default: s = '%' + (t || '');
    }
    if (prec && 'diuxX'.includes(t)) s = s.replace('-', '').padStart(+prec, '0').replace(/^/, s.startsWith('-') ? '-' : '');
    if (width && s.length < +width) s = flags.includes('-') ? s.padEnd(+width) : s.padStart(+width, flags.includes('0') && !flags.includes('-') ? '0' : ' ');
    out += s;
    i = j;
  }
  return out;
}

export class ExitSignal extends Error { constructor(code) { super(`ExitProcess(${code})`); this.code = code; } }
export class HaltSignal extends Error { constructor(msg, info) { super(msg); this.info = info; } }
