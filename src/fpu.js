// fpu.js — x87 aproximado con doubles de JS (80 bits -> 64 bits).
// Limitación conocida: la precisión extendida no se reproduce bit a bit.
export class FPU {
  constructor(cpu) {
    this.cpu = cpu;
    this.st = new Float64Array(8);
    this.tagEmpty = new Uint8Array(8).fill(1);
    this.top = 0;
    this.cw = 0x037f;
    this.sw = 0;
    this.c0 = 0; this.c1 = 0; this.c2 = 0; this.c3 = 0;
  }
  reset() { this.top = 0; this.cw = 0x37f; this.c0 = this.c1 = this.c2 = this.c3 = 0; this.tagEmpty.fill(1); }
  get(i) { return this.st[(this.top + i) & 7]; }
  set(i, v) { const k = (this.top + i) & 7; this.st[k] = v; this.tagEmpty[k] = 0; }
  push(v) { this.top = (this.top - 1) & 7; this.st[this.top] = v; this.tagEmpty[this.top] = 0; }
  pop() { const v = this.st[this.top]; this.tagEmpty[this.top] = 1; this.top = (this.top + 1) & 7; return v; }
  status() {
    return ((this.sw & 0x3fff & ~0x4700) | (this.c0 << 8) | (this.c1 << 9) | (this.c2 << 10) | (this.top << 11) | (this.c3 << 14)) & 0xffff;
  }
  tagWord() { let t = 0; for (let i = 0; i < 8; i++) t |= (this.tagEmpty[i] ? 3 : 0) << (i * 2); return t; }
  round(v) {
    switch ((this.cw >> 10) & 3) {
      case 0: { const f = Math.floor(v), d = v - f; if (d > 0.5) return f + 1; if (d < 0.5) return f; return f % 2 === 0 ? f : f + 1; }
      case 1: return Math.floor(v);
      case 2: return Math.ceil(v);
      default: return Math.trunc(v);
    }
  }
  cmp(a, b) {
    if (Number.isNaN(a) || Number.isNaN(b)) { this.c0 = this.c2 = this.c3 = 1; return; }
    this.c2 = 0; this.c0 = a < b ? 1 : 0; this.c3 = a === b ? 1 : 0;
  }
  arith(op, a, b) { // op: 0 add 1 mul 4 sub 5 subr 6 div 7 divr
    switch (op) {
      case 0: return a + b; case 1: return a * b;
      case 4: return a - b; case 5: return b - a;
      case 6: return a / b; case 7: return b / a;
    }
  }
  toInt(v, bits) {
    if (!Number.isFinite(v)) return bits === 64 ? -(2 ** 63) : -(2 ** (bits - 1));
    const rc = (this.cw >> 10) & 3;
    let r;
    if (rc === 3) r = Math.trunc(v);
    else if (rc === 0) { r = Math.round(v); if (r - v === 0.5 && r % 2 !== 0) r -= 1; } // al par más cercano
    else r = rc === 1 ? Math.floor(v) : Math.ceil(v);
    const lim = 2 ** (bits - 1);
    if (r >= lim || r < -lim) return -lim; // valor indefinido de enteros
    return r;
  }
  ld80(a) {
    const m = this.cpu.mem;
    const lo = m.r32(a), hi = m.r32(a + 4), se = m.r16(a + 8);
    const sign = se & 0x8000 ? -1 : 1, exp = se & 0x7fff;
    if (exp === 0 && lo === 0 && hi === 0) return sign * 0;
    if (exp === 0x7fff) return (hi & 0x7fffffff) || lo ? NaN : sign * Infinity;
    const mant = hi * 4294967296 + lo;
    return sign * mant * Math.pow(2, exp - 16383 - 63);
  }
  st80(a, v) {
    const m = this.cpu.mem;
    let sign = 0;
    if (v < 0 || Object.is(v, -0)) { sign = 0x8000; v = -v; }
    if (v === 0) { m.w32(a, 0); m.w32(a + 4, 0); m.w16(a + 8, sign); return; }
    if (!Number.isFinite(v)) { m.w32(a, 0); m.w32(a + 4, Number.isNaN(v) ? 0xc0000000 : 0x80000000); m.w16(a + 8, sign | 0x7fff); return; }
    let e = Math.floor(Math.log2(v));
    let mant = v / Math.pow(2, e - 63);
    if (mant >= 2 ** 64) { e++; mant /= 2; }
    if (mant < 2 ** 63) { e--; mant *= 2; }
    const hi = Math.floor(mant / 4294967296), lo = mant - hi * 4294967296;
    m.w32(a, lo >>> 0); m.w32(a + 4, hi >>> 0); m.w16(a + 8, sign | (e + 16383));
  }
  unimpl(op, mod, reg, rm) {
    const s = mod === 3 ? `${op.toString(16)} ${(0xc0 | (reg << 3) | rm).toString(16)}` : `${op.toString(16)} /${reg} (memoria)`;
    this.cpu.unimpl(`x87 ${s}`);
  }

  exec(op, mod, reg, rm, addr) {
    const m = this.cpu.mem, cpu = this.cpu;
    if (mod !== 3) {
      switch (op) {
        case 0xd8: case 0xdc: case 0xda: case 0xde: {
          const v = op === 0xd8 ? m.f32(addr) : op === 0xdc ? m.f64(addr) : op === 0xda ? (m.r32(addr) | 0) : ((m.r16(addr) << 16) >> 16);
          if (reg === 2 || reg === 3) { this.cmp(this.get(0), v); if (reg === 3) this.pop(); return; }
          this.set(0, this.arith(reg, this.get(0), v)); return;
        }
        case 0xd9:
          switch (reg) {
            case 0: this.push(m.f32(addr)); return;
            case 2: m.wf32(addr, this.get(0)); return;
            case 3: m.wf32(addr, this.pop()); return;
            case 4: { this.cw = m.r16(addr); this.sw = m.r16(addr + 4); this.top = (this.sw >> 11) & 7; this.c0 = (this.sw >> 8) & 1; this.c2 = (this.sw >> 10) & 1; this.c3 = (this.sw >> 14) & 1; return; } // fldenv
            case 5: this.cw = m.r16(addr); return;
            case 6: { m.w32(addr, this.cw); m.w32(addr + 4, this.status()); m.w32(addr + 8, this.tagWord()); for (let i = 12; i < 28; i += 4) m.w32(addr + i, 0); return; } // fnstenv
            case 7: m.w16(addr, this.cw); return;
          }
          break;
        case 0xdb:
          switch (reg) {
            case 0: this.push(m.r32(addr) | 0); return;
            case 1: m.w32(addr, Math.trunc(this.pop()) >>> 0); return;
            case 2: m.w32(addr, this.toInt(this.get(0), 32) >>> 0); return;
            case 3: m.w32(addr, this.toInt(this.pop(), 32) >>> 0); return;
            case 5: this.push(this.ld80(addr)); return;
            case 7: this.st80(addr, this.pop()); return;
          }
          break;
        case 0xdd:
          switch (reg) {
            case 0: this.push(m.f64(addr)); return;
            case 2: m.wf64(addr, this.get(0)); return;
            case 3: m.wf64(addr, this.pop()); return;
            case 4: { // frstor (108 bytes)
              this.cw = m.r16(addr); const sw = m.r16(addr + 4); this.top = (sw >> 11) & 7; this.c0 = (sw >> 8) & 1; this.c2 = (sw >> 10) & 1; this.c3 = (sw >> 14) & 1;
              const tw = m.r16(addr + 8);
              for (let i = 0; i < 8; i++) { const k = (this.top + i) & 7; this.st[k] = this.ld80(addr + 28 + i * 10); }
              for (let i = 0; i < 8; i++) this.tagEmpty[i] = ((tw >> (i * 2)) & 3) === 3 ? 1 : 0;
              return;
            }
            case 6: { // fnsave
              m.w32(addr, this.cw); m.w32(addr + 4, this.status()); m.w32(addr + 8, this.tagWord());
              for (let i = 12; i < 28; i += 4) m.w32(addr + i, 0);
              for (let i = 0; i < 8; i++) this.st80(addr + 28 + i * 10, this.get(i));
              this.reset(); return;
            }
            case 7: m.w16(addr, this.status()); return;
          }
          break;
        case 0xdf:
          switch (reg) {
            case 0: this.push((m.r16(addr) << 16) >> 16); return;
            case 2: m.w16(addr, this.toInt(this.get(0), 16) & 0xffff); return;
            case 3: m.w16(addr, this.toInt(this.pop(), 16) & 0xffff); return;
            case 5: { const lo = m.r32(addr), hi = m.r32(addr + 4) | 0; this.push(hi * 4294967296 + lo); return; }
            case 7: {
              const v = this.toInt(this.pop(), 64);
              const big = BigInt.asUintN(64, BigInt(v));
              m.w32(addr, Number(big & 0xffffffffn)); m.w32(addr + 4, Number(big >> 32n)); return;
            }
          }
          break;
      }
      return this.unimpl(op, mod, reg, rm);
    }
    // ---- formas registro ----
    const i = rm;
    switch (op) {
      case 0xd8:
        if (reg === 2 || reg === 3) { this.cmp(this.get(0), this.get(i)); if (reg === 3) this.pop(); return; }
        this.set(0, this.arith(reg, this.get(0), this.get(i))); return;
      case 0xdc: case 0xde: {
        if (op === 0xde && reg === 3 && i === 1) { this.cmp(this.get(0), this.get(1)); this.pop(); this.pop(); return; } // fcompp
        if (reg === 2 || reg === 3) break;
        // DC/DE: destino st(i); sub/subr y div/divr invertidos respecto de D8
        const a = this.get(i), b = this.get(0);
        let v;
        switch (reg) {
          case 0: v = a + b; break; case 1: v = a * b; break;
          case 4: v = b - a; break; case 5: v = a - b; break;
          case 6: v = b / a; break; case 7: v = a / b; break;
        }
        this.set(i, v);
        if (op === 0xde) this.pop();
        return;
      }
      case 0xd9:
        if (reg === 0) { this.push(this.get(i)); return; }
        if (reg === 1) { const t = this.get(0); this.set(0, this.get(i)); this.set(i, t); return; }
        switch ((reg << 3) | i) {
          case 0x10: return; // fnop
          case 0x20: this.set(0, -this.get(0)); return;
          case 0x21: this.set(0, Math.abs(this.get(0))); return;
          case 0x24: this.cmp(this.get(0), 0); return;
          case 0x25: { const v = this.get(0); const k = this.top; this.c1 = v < 0 || Object.is(v, -0) ? 1 : 0;
            if (this.tagEmpty[k]) { this.c3 = 1; this.c2 = 0; this.c0 = 1; } else if (Number.isNaN(v)) { this.c3 = 0; this.c2 = 0; this.c0 = 1; }
            else if (!Number.isFinite(v)) { this.c3 = 0; this.c2 = 1; this.c0 = 1; } else if (v === 0) { this.c3 = 1; this.c2 = 0; this.c0 = 0; } else { this.c3 = 0; this.c2 = 1; this.c0 = 0; }
            return; }
          case 0x28: this.push(1); return;
          case 0x29: this.push(Math.log2(10)); return;
          case 0x2a: this.push(Math.LOG2E); return;
          case 0x2b: this.push(Math.PI); return;
          case 0x2c: this.push(Math.log10(2)); return;
          case 0x2d: this.push(Math.LN2); return;
          case 0x2e: this.push(0); return;
          case 0x30: this.set(0, Math.pow(2, this.get(0)) - 1); return;
          case 0x31: { const x = this.pop(); this.set(0, this.get(0) * Math.log2(x)); return; }
          case 0x32: this.set(0, Math.tan(this.get(0))); this.push(1); this.c2 = 0; return;
          case 0x33: { const x = this.pop(); this.set(0, Math.atan2(this.get(0), x)); return; }
          case 0x35: case 0x38: { const a = this.get(0), b = this.get(1); this.set(0, reg === 6 && i === 5 ? a - Math.round(a / b) * b : a % b); this.c2 = 0; return; }
          case 0x36: this.top = (this.top - 1) & 7; return;
          case 0x37: this.top = (this.top + 1) & 7; return;
          case 0x39: { const x = this.pop(); this.set(0, this.get(0) * Math.log2(x + 1)); return; }
          case 0x3a: this.set(0, Math.sqrt(this.get(0))); return;
          case 0x3b: { const v = this.get(0); this.set(0, Math.sin(v)); this.push(Math.cos(v)); this.c2 = 0; return; }
          case 0x3c: this.set(0, this.round(this.get(0))); return;
          case 0x3d: this.set(0, this.get(0) * Math.pow(2, Math.trunc(this.get(1)))); return;
          case 0x3e: this.set(0, Math.sin(this.get(0))); this.c2 = 0; return;
          case 0x3f: this.set(0, Math.cos(this.get(0))); this.c2 = 0; return;
        }
        break;
      case 0xda:
        if (reg === 5 && i === 1) { this.cmp(this.get(0), this.get(1)); this.pop(); this.pop(); return; } // fucompp
        if (reg < 4) { const c = [cpu.cf, cpu.zf, cpu.cf || cpu.zf, cpu.pf][reg]; if (c) this.set(0, this.get(i)); return; } // fcmovcc
        break;
      case 0xdb:
        if (reg === 4 && i === 2) { this.c0 = this.c1 = this.c2 = this.c3 = 0; this.sw &= ~0x80ff; return; } // fnclex
        if (reg === 4 && i === 3) { this.reset(); return; } // fninit
        if (reg === 5 || reg === 6) { this.fcomi(this.get(0), this.get(i)); return; }
        if (reg < 4) { const c = [!cpu.cf, !cpu.zf, !(cpu.cf || cpu.zf), !cpu.pf][reg]; if (c) this.set(0, this.get(i)); return; }
        break;
      case 0xdd:
        if (reg === 0) { this.tagEmpty[(this.top + i) & 7] = 1; return; } // ffree
        if (reg === 2) { this.set(i, this.get(0)); return; }
        if (reg === 3) { this.set(i, this.get(0)); this.pop(); return; }
        if (reg === 4 || reg === 5) { this.cmp(this.get(0), this.get(i)); if (reg === 5) this.pop(); return; }
        break;
      case 0xdf:
        if (reg === 4 && i === 0) { cpu.setReg(2, 0, this.status()); return; } // fnstsw ax
        if (reg === 5 || reg === 6) { this.fcomi(this.get(0), this.get(i)); this.pop(); return; }
        break;
    }
    this.unimpl(op, mod, reg, rm);
  }
  fcomi(a, b) {
    const c = this.cpu;
    if (Number.isNaN(a) || Number.isNaN(b)) { c.zf = c.pf = c.cf = 1; return; }
    c.pf = 0; c.zf = a === b ? 1 : 0; c.cf = a < b ? 1 : 0; c.of = c.sf = 0;
  }
}
