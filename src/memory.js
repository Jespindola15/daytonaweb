// memory.js — memoria plana de 32 bits respaldada por un ArrayBuffer.
// Mapa de direcciones del prototipo:
//   0x00010000  TEB / PEB / bloques del "sistema"
//   0x00100000  zona de thunks de API (EIP aquí => llamada a JS)
//   0x00400000  imagen principal (ImageBase de DAYTONA.EXE)
//   0x02000000+ DLLs cargadas por LoadLibrary (con relocación)
//   0x03000000  heap (HeapAlloc/VirtualAlloc/GlobalAlloc/superficies DirectDraw)
//   0x0F000000-0x0FFF0000 pila del hilo principal
export const MEM_SIZE = 0x10000000; // 256 MiB
export const TEB_ADDR = 0x00010000;
export const PEB_ADDR = 0x00011000;
export const SYS_ADDR = 0x00012000; // strings del sistema (cmdline, env, etc.)
export const THUNK_BASE = 0x00100000;
export const THUNK_END = 0x00110000;
export const HOST_RETURN = THUNK_END - 4; // dirección mágica: vuelta de callback a JS
export const DLL_BASE = 0x02000000;
export const HEAP_BASE = 0x03000000;
export const HEAP_END = 0x0e000000;
export const STACK_TOP = 0x0fff0000;
export const STACK_SIZE = 0x00800000;

export class MemFault extends Error {
  constructor(addr, kind) { super(`Acceso inválido a memoria (${kind}) en 0x${(addr >>> 0).toString(16)}`); this.addr = addr; }
}

export class Memory {
  constructor(size = MEM_SIZE) {
    this.buf = new ArrayBuffer(size);
    this.u8 = new Uint8Array(this.buf);
    this.dv = new DataView(this.buf);
    this.size = size;
    this.heapPtr = HEAP_BASE;
    this.blocks = new Map(); // addr -> size (para HeapSize/ReAlloc)
    this.freeList = new Map(); // size -> [addr]
  }
  chk(a, n, k) { if (a < 0x1000 || a + n > this.size) throw new MemFault(a, k); }
  r8(a) { a >>>= 0; if (a < 0x1000 || a >= this.size) throw new MemFault(a, 'lectura'); return this.u8[a]; }
  r16(a) { a >>>= 0; this.chk(a, 2, 'lectura'); return this.u8[a] | (this.u8[a + 1] << 8); }
  r32(a) { a >>>= 0; this.chk(a, 4, 'lectura'); return (this.u8[a] | (this.u8[a + 1] << 8) | (this.u8[a + 2] << 16) | (this.u8[a + 3] << 24)) >>> 0; }
  // Si la página contiene código ya compilado por el JIT, se invalidan sus bloques
  // ---- pines: valores de 32 bits que el juego no puede modificar (autos remotos del multijugador) ----
  pin(a, v) {
    a >>>= 0;
    if (!this.pinPages) { this.pinPages = new Uint8Array(this.size >>> 12); this.pins = new Map(); }
    this.pins.set(a, v >>> 0); this.pinPages[a >>> 12] = 1; this.pinPages[(a + 3) >>> 12] = 1;
    this.u8[a] = v; this.u8[a + 1] = v >>> 8; this.u8[a + 2] = v >>> 16; this.u8[a + 3] = v >>> 24;
  }
  unpin(a) { if (this.pins) this.pins.delete(a >>> 0); }
  unpinAll() { if (this.pins) { this.pins.clear(); this.pinPages.fill(0); } }
  repin(a, n) {
    for (let p = (a & ~3) - 4, e = a + n; p < e; p += 4) {
      const v = this.pins.get(p >>> 0);
      if (v !== undefined) { this.u8[p] = v; this.u8[p + 1] = v >>> 8; this.u8[p + 2] = v >>> 16; this.u8[p + 3] = v >>> 24; }
    }
  }
  pw(a, n) { const pp = this.pinPages; if (!pp) return; for (let p = a >>> 12, e = (a + n - 1) >>> 12; p <= e; p++) if (pp[p]) { this.repin(a, n); return; } }
  cw(a, n) { const cp = this.codePages; if (!cp) return; for (let p = a >>> 12, e = (a + n - 1) >>> 12; p <= e; p++) if (cp[p]) this.onCodeWrite(p); }
  w8(a, v) { a >>>= 0; if (a < 0x1000 || a >= this.size) throw new MemFault(a, 'escritura'); if (this.codePages && this.codePages[a >>> 12]) this.onCodeWrite(a >>> 12); this.u8[a] = v; if (this.pinPages && this.pinPages[a >>> 12]) this.repin(a, 1); }
  w16(a, v) { a >>>= 0; this.chk(a, 2, 'escritura'); if (this.codePages && this.codePages[a >>> 12]) this.onCodeWrite(a >>> 12); this.u8[a] = v; this.u8[a + 1] = v >>> 8; if (this.pinPages && this.pinPages[a >>> 12]) this.repin(a, 2); }
  w32(a, v) { a >>>= 0; this.chk(a, 4, 'escritura'); if (this.codePages && this.codePages[a >>> 12]) this.onCodeWrite(a >>> 12); this.u8[a] = v; this.u8[a + 1] = v >>> 8; this.u8[a + 2] = v >>> 16; this.u8[a + 3] = v >>> 24; if (this.pinPages && this.pinPages[a >>> 12]) this.repin(a, 4); }
  f32(a) { a >>>= 0; this.chk(a, 4, 'lectura'); return this.dv.getFloat32(a, true); }
  f64(a) { a >>>= 0; this.chk(a, 8, 'lectura'); return this.dv.getFloat64(a, true); }
  wf32(a, v) { a >>>= 0; this.chk(a, 4, 'escritura'); this.cw(a, 4); this.dv.setFloat32(a, v, true); this.pw(a, 4); }
  wf64(a, v) { a >>>= 0; this.chk(a, 8, 'escritura'); this.cw(a, 8); this.dv.setFloat64(a, v, true); this.pw(a, 8); }
  cstr(a, max = 4096) {
    if (!a) return null;
    let s = '';
    for (let i = 0; i < max; i++) { const c = this.r8(a + i); if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
  wstr(a, max = 4096) {
    if (!a) return null;
    let s = '';
    for (let i = 0; i < max; i++) { const c = this.r16(a + i * 2); if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
  writeCStr(a, s, max = Infinity) {
    const n = Math.min(s.length, max - 1);
    for (let i = 0; i < n; i++) this.u8[a + i] = s.charCodeAt(i) & 0xff;
    this.cw(a, n + 1);
    this.u8[a + n] = 0;
    return n;
  }
  writeBytes(a, bytes) { this.chk(a, bytes.length, 'escritura'); this.cw(a, bytes.length); this.u8.set(bytes, a); this.pw(a, bytes.length); }
  fill(a, v, n) { this.chk(a, n, 'escritura'); this.cw(a, n); this.u8.fill(v, a, a + n); this.pw(a, n); }
  copy(dst, src, n) { this.chk(dst, n, 'escritura'); this.cw(dst, n); this.chk(src, n, 'lectura'); this.u8.copyWithin(dst, src, src + n); this.pw(dst, n); }

  // Asignador simple: bump + listas libres por tamaño exacto (alineado a 16)
  alloc(n, zero = true) {
    n = Math.max(16, (n + 15) & ~15);
    const fl = this.freeList.get(n);
    let a;
    if (fl && fl.length) a = fl.pop();
    else {
      a = this.heapPtr;
      if (a + n > HEAP_END) throw new Error(`Heap agotado (pedido ${n} bytes)`);
      this.heapPtr += n;
    }
    this.blocks.set(a, n);
    if (zero) this.u8.fill(0, a, a + n);
    return a;
  }
  free(a) {
    const n = this.blocks.get(a);
    if (!n) return false;
    this.blocks.delete(a);
    if (!this.freeList.has(n)) this.freeList.set(n, []);
    this.freeList.get(n).push(a);
    return true;
  }
  blockSize(a) { return this.blocks.get(a) ?? -1; }
  realloc(a, n) {
    if (!a) return this.alloc(n);
    const old = this.blocks.get(a);
    if (old === undefined) return 0;
    if (n <= old) return a;
    const b = this.alloc(n);
    this.copy(b, a, old);
    this.free(a);
    return b;
  }
}
