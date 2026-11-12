// cpu.js — Intérprete x86 de 32 bits (modo protegido plano, user-mode) + x87.
// No es un JIT: decodifica y ejecuta instrucción por instrucción.
import { FPU } from './fpu.js';

export class CPUError extends Error {
  constructor(msg, eip, bytes) { super(msg); this.eip = eip; this.bytes = bytes; }
}

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;
export const REG_NAMES = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const SIGN = [0, 0x80, 0x8000, 0, 0x80000000];
const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let b = 0; for (let j = 0; j < 8; j++) b ^= (i >> j) & 1; PARITY[i] = b ? 0 : 1; }

export class CPU {
  constructor(mem) {
    this.mem = mem;
    this.r = new Uint32Array(8);
    this.eip = 0;
    this.cf = 0; this.pf = 0; this.af = 0; this.zf = 0; this.sf = 0; this.of = 0; this.df = 0;
    this.fsBase = 0;
    this.fpu = new FPU(this);
    this.icount = 0;
    this.trace = new Uint32Array(64); this.traceIdx = 0;
    // estado de decodificación
    this.mMod = 0; this.mReg = 0; this.mRm = 0; this.mAddr = 0;
    this.segBase = 0; this.opsize = 4; this.rep = 0; this.instrStart = 0;
  }

  // ---------- fetch ----------
  f8() { const v = this.mem.r8(this.eip); this.eip = (this.eip + 1) >>> 0; return v; }
  f16() { const v = this.mem.r16(this.eip); this.eip = (this.eip + 2) >>> 0; return v; }
  f32() { const v = this.mem.r32(this.eip); this.eip = (this.eip + 4) >>> 0; return v; }
  fs8() { return (this.f8() << 24) >> 24; }
  fimm(sz) { return sz === 1 ? this.f8() : sz === 2 ? this.f16() : this.f32(); }

  // ---------- registros ----------
  getReg(sz, i) {
    if (sz === 4) return this.r[i];
    if (sz === 2) return this.r[i] & 0xffff;
    return i < 4 ? this.r[i] & 0xff : (this.r[i - 4] >>> 8) & 0xff;
  }
  setReg(sz, i, v) {
    if (sz === 4) this.r[i] = v;
    else if (sz === 2) this.r[i] = (this.r[i] & 0xffff0000) | (v & 0xffff);
    else if (i < 4) this.r[i] = (this.r[i] & 0xffffff00) | (v & 0xff);
    else this.r[i - 4] = (this.r[i - 4] & 0xffff00ff) | ((v & 0xff) << 8);
  }

  // ---------- ModRM ----------
  modrm() {
    const b = this.f8();
    const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    this.mMod = mod; this.mReg = reg; this.mRm = rm;
    if (mod === 3) { this.mAddr = -1; return; }
    let a = 0;
    if (rm === 4) {
      const sib = this.f8();
      const scale = sib >> 6, idx = (sib >> 3) & 7, base = sib & 7;
      if (base === 5 && mod === 0) a = this.f32();
      else a = this.r[base];
      if (idx !== 4) a += this.r[idx] << scale;
    } else if (rm === 5 && mod === 0) {
      a = this.f32();
    } else a = this.r[rm];
    if (mod === 1) a += this.fs8();
    else if (mod === 2) a += this.f32() | 0;
    this.mAddr = (a + this.segBase) >>> 0;
  }
  rd(sz, a) { return sz === 4 ? this.mem.r32(a) : sz === 2 ? this.mem.r16(a) : this.mem.r8(a); }
  wr(sz, a, v) { if (sz === 4) this.mem.w32(a, v); else if (sz === 2) this.mem.w16(a, v); else this.mem.w8(a, v); }
  readRM(sz) { return this.mMod === 3 ? this.getReg(sz, this.mRm) : this.rd(sz, this.mAddr); }
  writeRM(sz, v) { if (this.mMod === 3) this.setReg(sz, this.mRm, v); else this.wr(sz, this.mAddr, v); }

  // ---------- pila ----------
  push(v) { this.r[ESP] -= 4; this.mem.w32(this.r[ESP], v); }
  pop() { const v = this.mem.r32(this.r[ESP]); this.r[ESP] += 4; return v; }
  push16(v) { this.r[ESP] -= 2; this.mem.w16(this.r[ESP], v); }
  pop16() { const v = this.mem.r16(this.r[ESP]); this.r[ESP] += 2; return v; }

  // ---------- flags ----------
  szp(r, sz) { this.zf = r === 0 ? 1 : 0; this.sf = (r & SIGN[sz]) ? 1 : 0; this.pf = PARITY[r & 0xff]; }
  get eflags() {
    return (this.cf | 2 | (this.pf << 2) | (this.af << 4) | (this.zf << 6) | (this.sf << 7) | (1 << 9) | (this.df << 10) | (this.of << 11)) >>> 0;
  }
  set eflags(v) {
    this.cf = v & 1; this.pf = (v >> 2) & 1; this.af = (v >> 4) & 1; this.zf = (v >> 6) & 1;
    this.sf = (v >> 7) & 1; this.df = (v >> 10) & 1; this.of = (v >> 11) & 1;
  }
  cond(cc) {
    switch (cc) {
      case 0: return this.of; case 1: return !this.of;
      case 2: return this.cf; case 3: return !this.cf;
      case 4: return this.zf; case 5: return !this.zf;
      case 6: return this.cf || this.zf; case 7: return !this.cf && !this.zf;
      case 8: return this.sf; case 9: return !this.sf;
      case 10: return this.pf; case 11: return !this.pf;
      case 12: return this.sf !== this.of; case 13: return this.sf === this.of;
      case 14: return this.zf || this.sf !== this.of; case 15: return !this.zf && this.sf === this.of;
    }
  }

  alu(op, a, b, sz) {
    const m = MASK[sz], s = SIGN[sz];
    let r;
    switch (op) {
      case 0: // add
        r = (a + b) % (m + 1); this.cf = a + b > m ? 1 : 0; this.of = ((a ^ r) & (b ^ r) & s) ? 1 : 0; this.af = ((a ^ b ^ r) & 0x10) ? 1 : 0; break;
      case 1: r = (a | b) >>> 0; this.cf = this.of = 0; break;
      case 2: { const c = this.cf; r = (a + b + c) % (m + 1); this.cf = a + b + c > m ? 1 : 0; this.of = ((a ^ r) & (b ^ r) & s) ? 1 : 0; break; }
      case 3: { const c = this.cf; r = (a - b - c + m + 1) % (m + 1); this.cf = a < b + c ? 1 : 0; this.of = ((a ^ b) & (a ^ r) & s) ? 1 : 0; break; }
      case 4: r = (a & b) >>> 0; this.cf = this.of = 0; break;
      case 5: case 7: r = (a - b + m + 1) % (m + 1); this.cf = a < b ? 1 : 0; this.of = ((a ^ b) & (a ^ r) & s) ? 1 : 0; this.af = ((a ^ b ^ r) & 0x10) ? 1 : 0; break;
      case 6: r = (a ^ b) >>> 0; this.cf = this.of = 0; break;
    }
    r = r >>> 0;
    this.szp(r, sz);
    return r;
  }

  shift(op, v, cnt, sz) {
    cnt &= 31;
    if (!cnt) return v;
    const bits = sz * 8, m = MASK[sz], s = SIGN[sz];
    let r = v;
    switch (op) {
      case 0: { // rol
        const c = cnt % bits; r = c ? (((v << c) | (v >>> (bits - c))) & m) >>> 0 : v;
        this.cf = r & 1; this.of = ((r & s) ? 1 : 0) ^ this.cf; return r;
      }
      case 1: { // ror
        const c = cnt % bits; r = c ? (((v >>> c) | (v << (bits - c))) & m) >>> 0 : v;
        this.cf = (r & s) ? 1 : 0; this.of = ((r & s) ? 1 : 0) ^ ((r & (s >>> 1)) ? 1 : 0); return r;
      }
      case 2: { // rcl
        for (let i = 0; i < cnt % (bits + 1); i++) { const nc = (r & s) ? 1 : 0; r = (((r << 1) | this.cf) & m) >>> 0; this.cf = nc; }
        this.of = ((r & s) ? 1 : 0) ^ this.cf; return r;
      }
      case 3: { // rcr
        for (let i = 0; i < cnt % (bits + 1); i++) { const nc = r & 1; r = ((r >>> 1) | (this.cf ? s : 0)) >>> 0; this.cf = nc; }
        this.of = ((r & s) ? 1 : 0) ^ ((r & (s >>> 1)) ? 1 : 0); return r;
      }
      case 4: case 6: // shl/sal
        this.cf = cnt <= bits ? ((v >>> (bits - cnt)) & 1) : 0;
        r = cnt >= 32 ? 0 : ((v << cnt) & m) >>> 0;
        this.of = ((r & s) ? 1 : 0) ^ this.cf; break;
      case 5: // shr
        this.cf = (v >>> (cnt - 1)) & 1; r = (v >>> cnt) >>> 0; this.of = (v & s) ? 1 : 0; break;
      case 7: { // sar
        const sv = sz === 4 ? v | 0 : sz === 2 ? (v << 16) >> 16 : (v << 24) >> 24;
        this.cf = (sv >> (cnt - 1)) & 1; r = ((sv >> cnt) & m) >>> 0; this.of = 0; break;
      }
    }
    this.szp(r, sz);
    return r;
  }

  sx(v, sz) { return sz === 4 ? v | 0 : sz === 2 ? (v << 16) >> 16 : (v << 24) >> 24; }

  // ---------- ejecución ----------
  unimpl(what) {
    const bytes = [];
    for (let i = 0; i < 12; i++) { try { bytes.push(this.mem.r8(this.instrStart + i)); } catch { break; } }
    throw new CPUError(`Instrucción no implementada: ${what}`, this.instrStart, bytes);
  }

  step() {
    const start = this.eip;
    this.instrStart = start;
    this.trace[this.traceIdx++ & 63] = start;
    this.icount++;
    this.segBase = 0; this.opsize = 4; this.rep = 0;
    let op;
    for (;;) {
      op = this.f8();
      if (op === 0x66) this.opsize = 2;
      else if (op === 0xf3) this.rep = 0xf3;
      else if (op === 0xf2) this.rep = 0xf2;
      else if (op === 0x64) this.segBase = this.fsBase;
      else if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) { /* plano */ }
      else if (op === 0x65) this.segBase = 0;
      else if (op === 0xf0) { /* lock: un solo hilo */ }
      else if (op === 0x67) this.unimpl('prefijo 0x67 (direcciones de 16 bits)');
      else break;
    }
    const osz = this.opsize;
    const r = this.r;

    // grupo ALU 00-3F
    if (op < 0x40 && (op & 7) < 6) {
      const aop = op >> 3;
      switch (op & 7) {
        case 0: { this.modrm(); const v = this.alu(aop, this.readRM(1), this.getReg(1, this.mReg), 1); if (aop !== 7) this.writeRM(1, v); return; }
        case 1: { this.modrm(); const v = this.alu(aop, this.readRM(osz), this.getReg(osz, this.mReg), osz); if (aop !== 7) this.writeRM(osz, v); return; }
        case 2: { this.modrm(); const v = this.alu(aop, this.getReg(1, this.mReg), this.readRM(1), 1); if (aop !== 7) this.setReg(1, this.mReg, v); return; }
        case 3: { this.modrm(); const v = this.alu(aop, this.getReg(osz, this.mReg), this.readRM(osz), osz); if (aop !== 7) this.setReg(osz, this.mReg, v); return; }
        case 4: { const v = this.alu(aop, r[EAX] & 0xff, this.f8(), 1); if (aop !== 7) this.setReg(1, EAX, v); return; }
        case 5: { const v = this.alu(aop, this.getReg(osz, EAX), this.fimm(osz), osz); if (aop !== 7) this.setReg(osz, EAX, v); return; }
      }
    }

    switch (op) {
      case 0x0f: return this.step0F(osz);
      case 0x27: case 0x2f: case 0x37: case 0x3f: this.unimpl(`BCD 0x${op.toString(16)}`); return;
      case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47: {
        const cf = this.cf; const v = this.alu(0, this.getReg(osz, op & 7), 1, osz); this.cf = cf; this.setReg(osz, op & 7, v); return;
      }
      case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f: {
        const cf = this.cf; const v = this.alu(5, this.getReg(osz, op & 7), 1, osz); this.cf = cf; this.setReg(osz, op & 7, v); return;
      }
      case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57:
        if (osz === 2) this.push16(r[op & 7] & 0xffff); else this.push(r[op & 7]); return;
      case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        if (osz === 2) this.setReg(2, op & 7, this.pop16()); else r[op & 7] = this.pop(); return;
      case 0x60: { const sp = r[ESP]; for (let i = 0; i < 8; i++) this.push(i === 4 ? sp : r[i]); return; }
      case 0x61: { for (let i = 7; i >= 0; i--) { const v = this.pop(); if (i !== 4) r[i] = v; } return; }
      case 0x68: this.push(this.f32()); return;
      case 0x6a: this.push(this.fs8() >>> 0); return;
      case 0x69: case 0x6b: {
        this.modrm(); const a = this.sx(this.readRM(osz), osz);
        const b = op === 0x69 ? this.sx(this.fimm(osz), osz) : this.fs8();
        this.imulSet(a, b, osz, this.mReg); return;
      }
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f: {
        const d = this.fs8(); if (this.cond(op & 15)) this.eip = (this.eip + d) >>> 0; return;
      }
      case 0x80: case 0x82: { this.modrm(); const v = this.alu(this.mReg, this.readRM(1), this.f8(), 1); if (this.mReg !== 7) this.writeRM(1, v); return; }
      case 0x81: { this.modrm(); const v = this.alu(this.mReg, this.readRM(osz), this.fimm(osz), osz); if (this.mReg !== 7) this.writeRM(osz, v); return; }
      case 0x83: { this.modrm(); const v = this.alu(this.mReg, this.readRM(osz), (this.fs8() & MASK[osz]) >>> 0, osz); if (this.mReg !== 7) this.writeRM(osz, v); return; }
      case 0x84: this.modrm(); this.alu(4, this.readRM(1), this.getReg(1, this.mReg), 1); return;
      case 0x85: this.modrm(); this.alu(4, this.readRM(osz), this.getReg(osz, this.mReg), osz); return;
      case 0x86: { this.modrm(); const a = this.readRM(1); this.writeRM(1, this.getReg(1, this.mReg)); this.setReg(1, this.mReg, a); return; }
      case 0x87: { this.modrm(); const a = this.readRM(osz); this.writeRM(osz, this.getReg(osz, this.mReg)); this.setReg(osz, this.mReg, a); return; }
      case 0x88: this.modrm(); this.writeRM(1, this.getReg(1, this.mReg)); return;
      case 0x89: this.modrm(); this.writeRM(osz, this.getReg(osz, this.mReg)); return;
      case 0x8a: this.modrm(); this.setReg(1, this.mReg, this.readRM(1)); return;
      case 0x8b: this.modrm(); this.setReg(osz, this.mReg, this.readRM(osz)); return;
      case 0x8c: this.modrm(); this.writeRM(2, this.mReg === 4 ? 0x3b : 0x23); return; // mov r/m, sreg
      case 0x8d: { const sb = this.segBase; this.segBase = 0; this.modrm(); this.segBase = sb; this.setReg(osz, this.mReg, this.mAddr); return; }
      case 0x8e: this.modrm(); return; // mov sreg, r/m: ignorado (plano)
      case 0x8f: { const v = osz === 2 ? this.pop16() : this.pop(); this.modrm(); this.writeRM(osz, v); return; }
      case 0x90: if (this.rep === 0xf3) { /* pause */ } return;
      case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: {
        const a = this.getReg(osz, EAX); this.setReg(osz, EAX, this.getReg(osz, op & 7)); this.setReg(osz, op & 7, a); return;
      }
      case 0x98: if (osz === 2) this.setReg(2, EAX, (r[EAX] << 24) >> 24); else r[EAX] = (r[EAX] << 16) >> 16; return;
      case 0x99: if (osz === 2) this.setReg(2, EDX, (r[EAX] & 0x8000) ? 0xffff : 0); else r[EDX] = (r[EAX] & 0x80000000) ? 0xffffffff : 0; return;
      case 0x9b: return; // fwait
      case 0x9c: this.push(this.eflags); return;
      case 0x9d: this.eflags = this.pop(); return;
      case 0x9e: { const ah = (r[EAX] >>> 8) & 0xff; this.eflags = (this.eflags & ~0xd5) | (ah & 0xd5); return; }
      case 0x9f: this.setReg(1, 4, this.eflags & 0xff); return;
      case 0xa0: this.setReg(1, EAX, this.mem.r8((this.f32() + this.segBase) >>> 0)); return;
      case 0xa1: this.setReg(osz, EAX, this.rd(osz, (this.f32() + this.segBase) >>> 0)); return;
      case 0xa2: this.mem.w8((this.f32() + this.segBase) >>> 0, r[EAX]); return;
      case 0xa3: this.wr(osz, (this.f32() + this.segBase) >>> 0, r[EAX]); return;
      case 0xa4: return this.strop('movs', 1); case 0xa5: return this.strop('movs', osz);
      case 0xa6: return this.strop('cmps', 1); case 0xa7: return this.strop('cmps', osz);
      case 0xa8: this.alu(4, r[EAX] & 0xff, this.f8(), 1); return;
      case 0xa9: this.alu(4, this.getReg(osz, EAX), this.fimm(osz), osz); return;
      case 0xaa: return this.strop('stos', 1); case 0xab: return this.strop('stos', osz);
      case 0xac: return this.strop('lods', 1); case 0xad: return this.strop('lods', osz);
      case 0xae: return this.strop('scas', 1); case 0xaf: return this.strop('scas', osz);
      case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7:
        this.setReg(1, op & 7, this.f8()); return;
      case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf:
        this.setReg(osz, op & 7, this.fimm(osz)); return;
      case 0xc0: { this.modrm(); const c = this.f8(); this.writeRM(1, this.shift(this.mReg, this.readRM(1), c, 1)); return; }
      case 0xc1: { this.modrm(); const c = this.f8(); this.writeRM(osz, this.shift(this.mReg, this.readRM(osz), c, osz)); return; }
      case 0xc2: { const n = this.f16(); this.eip = this.pop(); r[ESP] += n; return; }
      case 0xc3: this.eip = this.pop(); return;
      case 0xc6: this.modrm(); this.writeRM(1, this.f8()); return;
      case 0xc7: this.modrm(); this.writeRM(osz, this.fimm(osz)); return;
      case 0xc8: { const sz = this.f16(), lvl = this.f8(); if (lvl) this.unimpl('enter con nivel>0'); this.push(r[EBP]); r[EBP] = r[ESP]; r[ESP] -= sz; return; }
      case 0xc9: r[ESP] = r[EBP]; r[EBP] = this.pop(); return;
      case 0xcc: this.unimpl('int3 (breakpoint en el código del juego)'); return;
      case 0xcd: this.unimpl(`int 0x${this.f8().toString(16)}`); return;
      case 0xd0: this.modrm(); this.writeRM(1, this.shift(this.mReg, this.readRM(1), 1, 1)); return;
      case 0xd1: this.modrm(); this.writeRM(osz, this.shift(this.mReg, this.readRM(osz), 1, osz)); return;
      case 0xd2: this.modrm(); this.writeRM(1, this.shift(this.mReg, this.readRM(1), r[ECX] & 0xff, 1)); return;
      case 0xd3: this.modrm(); this.writeRM(osz, this.shift(this.mReg, this.readRM(osz), r[ECX] & 0xff, osz)); return;
      case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf:
        this.modrm(); this.fpu.exec(op, this.mMod, this.mReg, this.mRm, this.mAddr); return;
      case 0xe2: { const d = this.fs8(); r[ECX] -= 1; if (r[ECX] !== 0) this.eip = (this.eip + d) >>> 0; return; }
      case 0xe3: { const d = this.fs8(); if (r[ECX] === 0) this.eip = (this.eip + d) >>> 0; return; }
      case 0xe8: { const d = this.f32() | 0; this.push(this.eip); this.eip = (this.eip + d) >>> 0; return; }
      case 0xe9: { const d = this.f32() | 0; this.eip = (this.eip + d) >>> 0; return; }
      case 0xeb: { const d = this.fs8(); this.eip = (this.eip + d) >>> 0; return; }
      case 0xf4: this.unimpl('hlt'); return;
      case 0xf5: this.cf ^= 1; return;
      case 0xf6: return this.grp3(1);
      case 0xf7: return this.grp3(osz);
      case 0xf8: this.cf = 0; return; case 0xf9: this.cf = 1; return;
      case 0xfa: case 0xfb: return; // cli/sti: ignorados
      case 0xfc: this.df = 0; return; case 0xfd: this.df = 1; return;
      case 0xfe: {
        this.modrm(); const cf = this.cf;
        if (this.mReg === 0) this.writeRM(1, this.alu(0, this.readRM(1), 1, 1));
        else if (this.mReg === 1) this.writeRM(1, this.alu(5, this.readRM(1), 1, 1));
        else this.unimpl(`FE /${this.mReg}`);
        this.cf = cf; return;
      }
      case 0xff: {
        this.modrm();
        switch (this.mReg) {
          case 0: { const cf = this.cf; this.writeRM(osz, this.alu(0, this.readRM(osz), 1, osz)); this.cf = cf; return; }
          case 1: { const cf = this.cf; this.writeRM(osz, this.alu(5, this.readRM(osz), 1, osz)); this.cf = cf; return; }
          case 2: { const t = this.readRM(4); this.push(this.eip); this.eip = t; return; }
          case 4: this.eip = this.readRM(4); return;
          case 6: this.push(this.readRM(osz)); return;
          default: this.unimpl(`FF /${this.mReg} (call/jmp far)`);
        }
        return;
      }
    }
    this.unimpl(`opcode 0x${op.toString(16).padStart(2, '0')}`);
  }

  imulSet(a, b, sz, dst) {
    let res;
    if (sz === 4) { res = Math.imul(a, b); const full = a * b; this.cf = this.of = full !== res ? 1 : 0; res >>>= 0; }
    else { const full = a * b; res = full & 0xffff; this.cf = this.of = ((res << 16) >> 16) !== full ? 1 : 0; }
    this.setReg(sz, dst, res);
  }

  grp3(sz) {
    this.modrm();
    const r = this.r;
    const v = this.readRM(sz);
    switch (this.mReg) {
      case 0: case 1: this.alu(4, v, this.fimm(sz), sz); return;
      case 2: this.writeRM(sz, (~v & MASK[sz]) >>> 0); return;
      case 3: { const res = this.alu(5, 0, v, sz); this.cf = v !== 0 ? 1 : 0; this.writeRM(sz, res); return; }
      case 4: { // mul
        if (sz === 1) { const p = (r[EAX] & 0xff) * v; this.setReg(2, EAX, p); this.cf = this.of = p > 0xff ? 1 : 0; }
        else if (sz === 2) { const p = (r[EAX] & 0xffff) * v; this.setReg(2, EAX, p & 0xffff); this.setReg(2, EDX, p >>> 16); this.cf = this.of = p > 0xffff ? 1 : 0; }
        else { const p = BigInt(r[EAX]) * BigInt(v); r[EAX] = Number(p & 0xffffffffn); r[EDX] = Number(p >> 32n); this.cf = this.of = r[EDX] ? 1 : 0; }
        return;
      }
      case 5: { // imul 1 operando
        if (sz === 1) { const p = ((r[EAX] << 24) >> 24) * ((v << 24) >> 24); this.setReg(2, EAX, p & 0xffff); this.cf = this.of = ((p << 24) >> 24) !== p ? 1 : 0; }
        else if (sz === 2) { const p = ((r[EAX] << 16) >> 16) * ((v << 16) >> 16); this.setReg(2, EAX, p & 0xffff); this.setReg(2, EDX, (p >> 16) & 0xffff); this.cf = this.of = ((p << 16) >> 16) !== p ? 1 : 0; }
        else { const p = BigInt(r[EAX] | 0) * BigInt(v | 0); r[EAX] = Number(BigInt.asUintN(32, p)); r[EDX] = Number(BigInt.asUintN(32, p >> 32n)); this.cf = this.of = BigInt.asIntN(32, p) !== p ? 1 : 0; }
        return;
      }
      case 6: { // div
        if (v === 0) this.unimpl('div por cero (#DE; SEH no implementado)');
        if (sz === 1) { const n = r[EAX] & 0xffff; const q = Math.floor(n / v); if (q > 0xff) this.unimpl('#DE desborde div8'); this.setReg(1, EAX, q); this.setReg(1, 4, n % v); }
        else if (sz === 2) { const n = ((r[EDX] & 0xffff) * 65536) + (r[EAX] & 0xffff); const q = Math.floor(n / v); if (q > 0xffff) this.unimpl('#DE desborde div16'); this.setReg(2, EAX, q); this.setReg(2, EDX, n % v); }
        else { const n = (BigInt(r[EDX]) << 32n) | BigInt(r[EAX]); const q = n / BigInt(v); if (q > 0xffffffffn) this.unimpl('#DE desborde div32'); r[EAX] = Number(q); r[EDX] = Number(n % BigInt(v)); }
        return;
      }
      case 7: { // idiv
        if (v === 0) this.unimpl('idiv por cero (#DE; SEH no implementado)');
        if (sz === 1) { const n = (r[EAX] << 16) >> 16, d = (v << 24) >> 24; const q = Math.trunc(n / d); this.setReg(1, EAX, q & 0xff); this.setReg(1, 4, (n % d) & 0xff); }
        else if (sz === 2) { const n = ((r[EDX] & 0xffff) << 16 | (r[EAX] & 0xffff)) | 0, d = (v << 16) >> 16; const q = Math.trunc(n / d); this.setReg(2, EAX, q & 0xffff); this.setReg(2, EDX, (n % d) & 0xffff); }
        else { const n = BigInt.asIntN(64, (BigInt(r[EDX]) << 32n) | BigInt(r[EAX])); const d = BigInt(v | 0); const q = n / d; if (q > 0x7fffffffn || q < -0x80000000n) this.unimpl('#DE desborde idiv32'); r[EAX] = Number(BigInt.asUintN(32, q)); r[EDX] = Number(BigInt.asUintN(32, n % d)); }
        return;
      }
    }
  }

  strop(kind, sz) {
    const r = this.r, mem = this.mem;
    const step = this.df ? -sz : sz;
    const rep = this.rep;
    if (rep && r[ECX] === 0) return;
    // ruta rápida: rep movsb/movsd y rep stos hacia adelante
    if (rep && !this.df && (kind === 'movs' || kind === 'stos')) {
      const n = r[ECX] * sz;
      if (kind === 'movs') mem.copy(r[EDI], r[ESI] + this.segBase, n), r[ESI] += n;
      else if (sz === 1) mem.fill(r[EDI], r[EAX] & 0xff, n);
      else for (let i = 0; i < r[ECX]; i++) this.wr(sz, r[EDI] + i * sz, r[EAX]);
      r[EDI] += n; r[ECX] = 0; return;
    }
    do {
      switch (kind) {
        case 'movs': this.wr(sz, r[EDI], this.rd(sz, (r[ESI] + this.segBase) >>> 0)); r[ESI] += step; r[EDI] += step; break;
        case 'stos': this.wr(sz, r[EDI], r[EAX]); r[EDI] += step; break;
        case 'lods': this.setReg(sz, EAX, this.rd(sz, (r[ESI] + this.segBase) >>> 0)); r[ESI] += step; break;
        case 'cmps': this.alu(7, this.rd(sz, (r[ESI] + this.segBase) >>> 0), this.rd(sz, r[EDI]), sz); r[ESI] += step; r[EDI] += step; break;
        case 'scas': this.alu(7, this.getReg(sz, EAX), this.rd(sz, r[EDI]), sz); r[EDI] += step; break;
      }
      if (!rep) return;
      r[ECX] -= 1;
      if (r[ECX] === 0) return;
      if (kind === 'cmps' || kind === 'scas') {
        if (rep === 0xf3 && !this.zf) return;
        if (rep === 0xf2 && this.zf) return;
      }
    } while (true);
  }

  step0F(osz) {
    const op = this.f8();
    const r = this.r;
    if (op >= 0x80 && op <= 0x8f) { const d = this.f32() | 0; if (this.cond(op & 15)) this.eip = (this.eip + d) >>> 0; return; }
    if (op >= 0x90 && op <= 0x9f) { this.modrm(); this.writeRM(1, this.cond(op & 15) ? 1 : 0); return; }
    if (op >= 0x40 && op <= 0x4f) { this.modrm(); const v = this.readRM(osz); if (this.cond(op & 15)) this.setReg(osz, this.mReg, v); return; }
    if (op >= 0xc8 && op <= 0xcf) { const v = r[op & 7]; r[op & 7] = ((v >>> 24) | ((v >>> 8) & 0xff00) | ((v << 8) & 0xff0000) | (v << 24)) >>> 0; return; }
    switch (op) {
      case 0x0b: this.unimpl('ud2');
      case 0x1f: this.modrm(); return; // nop largo
      case 0x31: { const t = Math.floor(this.icount); r[EAX] = t >>> 0; r[EDX] = Math.floor(t / 4294967296) >>> 0; return; } // rdtsc = nº instrucciones
      case 0xa2: { // cpuid: Pentium básico con FPU, sin MMX
        const leaf = r[EAX];
        if (leaf === 0) { r[EAX] = 1; r[EBX] = 0x756e6547; r[EDX] = 0x49656e69; r[ECX] = 0x6c65746e; }
        else { r[EAX] = 0x543; r[EBX] = 0; r[ECX] = 0; r[EDX] = 0x1 | 0x10 | 0x100; }
        return;
      }
      case 0xa3: case 0xab: case 0xb3: case 0xbb: { // bt/bts/btr/btc r/m, reg
        this.modrm(); const bit = this.getReg(osz, this.mReg);
        let v, addr = -1, b;
        if (this.mMod === 3) { v = this.getReg(osz, this.mRm); b = bit & (osz * 8 - 1); }
        else { addr = (this.mAddr + ((bit | 0) >> 5) * 4) >>> 0; v = this.mem.r32(addr); b = bit & 31; }
        this.cf = (v >>> b) & 1;
        if (op !== 0xa3) {
          const nv = op === 0xab ? v | (1 << b) : op === 0xb3 ? v & ~(1 << b) : v ^ (1 << b);
          if (addr < 0) this.setReg(osz, this.mRm, nv >>> 0); else this.mem.w32(addr, nv >>> 0);
        }
        return;
      }
      case 0xba: {
        this.modrm(); const b = this.f8() & (osz * 8 - 1); const v = this.readRM(osz);
        this.cf = (v >>> b) & 1;
        if (this.mReg === 5) this.writeRM(osz, (v | (1 << b)) >>> 0);
        else if (this.mReg === 6) this.writeRM(osz, (v & ~(1 << b)) >>> 0);
        else if (this.mReg === 7) this.writeRM(osz, (v ^ (1 << b)) >>> 0);
        return;
      }
      case 0xa4: case 0xa5: case 0xac: case 0xad: { // shld/shrd
        this.modrm(); const cnt = (op & 1 ? r[ECX] : this.f8()) & 31;
        if (!cnt) return;
        const d = this.readRM(osz), s = this.getReg(osz, this.mReg);
        if (osz !== 4) this.unimpl('shld/shrd 16 bits');
        let res;
        if (op <= 0xa5) { res = ((d << cnt) | (s >>> (32 - cnt))) >>> 0; this.cf = (d >>> (32 - cnt)) & 1; }
        else { res = ((d >>> cnt) | (s << (32 - cnt))) >>> 0; this.cf = (d >>> (cnt - 1)) & 1; }
        this.szp(res, 4); this.writeRM(4, res); return;
      }
      case 0xaf: { this.modrm(); this.imulSet(this.sx(this.getReg(osz, this.mReg), osz), this.sx(this.readRM(osz), osz), osz, this.mReg); return; }
      case 0xb0: case 0xb1: { // cmpxchg
        const sz = op === 0xb0 ? 1 : osz; this.modrm(); const d = this.readRM(sz);
        this.alu(7, this.getReg(sz, 0), d, sz);
        if (this.zf) this.writeRM(sz, this.getReg(sz, this.mReg)); else this.setReg(sz, 0, d);
        return;
      }
      case 0xb6: this.modrm(); this.setReg(osz, this.mReg, this.readRM(1)); return;
      case 0xb7: this.modrm(); this.setReg(osz, this.mReg, this.readRM(2)); return;
      case 0xbe: this.modrm(); this.setReg(osz, this.mReg, this.sx(this.readRM(1), 1) >>> 0); return;
      case 0xbf: this.modrm(); this.setReg(osz, this.mReg, this.sx(this.readRM(2), 2) >>> 0); return;
      case 0xbc: case 0xbd: {
        this.modrm(); const v = this.readRM(osz);
        if (!v) { this.zf = 1; return; }
        this.zf = 0;
        this.setReg(osz, this.mReg, op === 0xbc ? 31 - Math.clz32(v & -v) : 31 - Math.clz32(v));
        return;
      }
      case 0xc0: case 0xc1: { // xadd
        const sz = op === 0xc0 ? 1 : osz; this.modrm(); const d = this.readRM(sz), s = this.getReg(sz, this.mReg);
        const sum = this.alu(0, d, s, sz); this.setReg(sz, this.mReg, d); this.writeRM(sz, sum); return;
      }
    }
    this.unimpl(`opcode 0x0F 0x${op.toString(16).padStart(2, '0')}`);
  }

  dumpRegs() {
    return REG_NAMES.map((n, i) => `${n}=${this.r[i].toString(16).padStart(8, '0')}`).join(' ') +
      ` eip=${this.eip.toString(16).padStart(8, '0')} fl=${this.eflags.toString(16)}`;
  }
}
