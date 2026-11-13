// emulator.js — orquesta: carga PE, mapea memoria, resuelve importaciones con thunks,
// ejecuta el intérprete x86 y despacha llamadas Win32 a implementaciones en JS.
import { parsePE, readImports, readExports, readRelocs, readResources, rvaToOffset, SUBSYSTEMS } from './pe.js';
import {
  Memory, MemFault, TEB_ADDR, PEB_ADDR, SYS_ADDR, THUNK_BASE, THUNK_END, HOST_RETURN,
  DLL_BASE, STACK_TOP, STACK_SIZE,
} from './memory.js';
import { CPU, CPUError } from './cpu.js';
import { BlockCache } from './jit.js';
import { VFS } from './vfs.js';
import kernel32 from './win32/kernel32.js';
import user32 from './win32/user32.js';
import gdi32 from './win32/gdi32.js';
import winmm from './win32/winmm.js';
import ddraw from './win32/ddraw.js';
import dsound from './win32/dsound.js';
import msacm32 from './win32/msacm32.js';
import advapi32 from './win32/advapi32.js';

const hex = (v, n = 8) => '0x' + (v >>> 0).toString(16).padStart(n, '0');
export { hex };

import { ExitSignal, HaltSignal } from './win32/common.js';
export { ExitSignal, HaltSignal };

export const MODULES = {
  'KERNEL32.DLL': kernel32, 'USER32.DLL': user32, 'GDI32.DLL': gdi32, 'WINMM.DLL': winmm,
  'DDRAW.DLL': ddraw, 'DSOUND.DLL': dsound, 'MSACM32.DLL': msacm32, 'ADVAPI32.DLL': advapi32,
};

export class Emulator {
  constructor({ log = console.log, host = null } = {}) {
    this.logFn = log;
    this.host = host || {};
    this.mem = new Memory();
    this.cpu = new CPU(this.mem);
    this.vfs = new VFS();
    this.thunks = [];           // índice -> {dll, name, impl}
    this.thunkByName = new Map();
    this.apiTrace = [];          // últimas llamadas
    this.apiCounts = new Map();
    this.traceApis = true;
    this.maxApiLog = 400;
    this.apiLogged = 0;
    this.handles = new Map(); this.nextHandle = 0x100;
    this.modules = new Map();    // base -> {name, pe, base}
    this.dllNext = DLL_BASE;
    this.yieldRequested = false;
    this.exited = null;
    this.state = {};             // estado compartido de los módulos Win32
    this.lastError = 0;
    this.startTime = Date.now();
    this.callDepth = 0;
    this.sysPtr = SYS_ADDR;
    // Reloj: 'virtual' = derivado de instrucciones ejecutadas (determinista; 90k instr/ms ~ Pentium 90),
    // 'real' = reloj de pared. Con un intérprete más lento que el hardware original, el virtual mantiene
    // las proporciones que el juego espera entre trabajo y tiempo (títulos, demos, timeouts).
    this.hooks = new Map(); // eip -> fn(cpu) (ver addHook)
    this.jit = new BlockCache(this);
    this.useJit = true; // false = intérprete puro (para comparar)
    this.clockMode = 'virtual';
    this.instrPerMs = 90000;
    this.timeOffset = 0;
    this.vsyncHz = 60; // 0 = sin límite
    this.waitUntil = 0;
    for (const m of Object.values(MODULES)) if (m.__init) m.__init(this);
  }

  // Emula el vblank de 60 Hz (como cnc-ddraw con maxgameticks=0 o DirectDraw con DDFLIP_WAIT):
  // Flip espera el próximo tick de 1/60 s. Reloj virtual: el reloj salta; reloj real: el host deja de
  // ejecutar el juego hasta ese instante (waitUntil).
  // Hook de ejecución en `eip` (debe ser inicio de bloque, p.ej. la entrada de una función).
  // fn(cpu) se ejecuta antes de la instrucción; si devuelve false, no se ejecuta el bloque (fn fija cpu.eip).
  addHook(eip, fn) { this.hooks.set(eip >>> 0, fn); this.jit.forget(eip >>> 0); }
  removeHook(eip) { this.hooks.delete(eip >>> 0); this.jit.forget(eip >>> 0); }
  stepInterp() { const h = this.hooks.size && this.hooks.get(this.cpu.eip); if (h && h(this.cpu) === false) return; this.cpu.step(); }

  // Limitador (no grilla): sólo espera si el cuadro llegó antes de 1/60 s desde el anterior.
  waitVBlank() {
    if (!this.vsyncHz) return;
    const period = 1000 / this.vsyncHz, now = this.nowMs();
    const target = Math.max(now, (this.lastVBlank || 0) + period);
    this.lastVBlank = target;
    if (target - now < 0.01) return;
    if (this.clockMode === 'virtual') this.timeOffset += target - now;
    else { this.waitUntil = target; this.yieldRequested = true; }
  }

  nowMs() {
    if (this.clockMode === 'real') return (typeof performance !== 'undefined' ? performance.now() : Date.now() - this.startTime) + this.timeOffset;
    return 10000 + this.cpu.icount / this.instrPerMs + this.timeOffset;
  }

  log(stage, msg) { this.logFn(`[${stage}] ${msg}`); }

  // ----- handles genéricos -----
  newHandle(obj) { const h = this.nextHandle; this.nextHandle += 4; this.handles.set(h, obj); return h; }
  sysString(s) { const a = this.sysPtr; this.mem.writeCStr(a, s); this.sysPtr += s.length + 1; this.sysPtr = (this.sysPtr + 3) & ~3; return a; }

  // ----- thunks -----
  thunkFor(dll, name) {
    dll = dll.toUpperCase();
    if (!dll.endsWith('.DLL')) dll += '.DLL';
    const key = dll + '!' + name;
    if (this.thunkByName.has(key)) return this.thunkByName.get(key);
    const mod = MODULES[dll];
    const impl = mod ? mod[name] : undefined;
    const idx = this.thunks.length;
    const addr = THUNK_BASE + idx * 4;
    if (addr >= HOST_RETURN) throw new Error('Zona de thunks agotada');
    this.thunks.push({ dll, name, impl, addr });
    this.thunkByName.set(key, addr);
    this.mem.fill(addr, 0xcc, 4);
    return addr;
  }
  // función JS anónima expuesta al guest (métodos COM, callbacks)
  hostFunction(label, n, fn) {
    const idx = this.thunks.length;
    const addr = THUNK_BASE + idx * 4;
    this.thunks.push({ dll: 'COM', name: label, impl: { n, fn }, addr });
    return addr;
  }

  // ----- carga de la imagen principal -----
  loadMain(bytes, name) {
    this.log('PE', `Archivo ${name}: ${bytes.length} bytes`);
    const pe = parsePE(bytes, name);
    this.mainPE = pe;
    this.log('PE', `Machine=0x${pe.machine.toString(16)} (i386) Secciones=${pe.nSections} TimeDateStamp=${hex(pe.timeDateStamp)} (${new Date(pe.timeDateStamp * 1000).toISOString().slice(0, 10)}) Linker=${pe.linkerVersion}`);
    this.log('PE', `ImageBase=${hex(pe.imageBase)} EntryPoint RVA=${hex(pe.entryRVA)} (offset en archivo ${pe.entryFileOffset}) SizeOfImage=${hex(pe.sizeOfImage)} Subsystem=${SUBSYSTEMS[pe.subsystem] || pe.subsystem} ${pe.subsystemVersion}`);
    for (const s of pe.sections) this.log('PE', `  sección ${s.name.padEnd(8)} RVA=${hex(s.rva)} VSize=${hex(s.vsize)} Raw=${hex(s.rawPtr)}+${hex(s.rawSize)} flags=${hex(s.characteristics)}`);
    const base = this.mapImage(pe, pe.imageBase);
    this.mainBase = base;
    this.modules.set(base, { name: name.toUpperCase(), pe, base });
    this.resolveImports(pe, base);
    this.setupProcess(pe);
    return pe;
  }

  mapImage(pe, preferred) {
    let base = preferred;
    const relocs = readRelocs(pe);
    if (base + pe.sizeOfImage > this.mem.size || base < 0x10000 || (this.modules.size && preferred !== this.dllNext)) {
      base = this.dllNext;
    }
    if (base + pe.sizeOfImage > this.mem.size) throw new Error('La imagen no entra en la memoria emulada');
    this.mem.writeBytes(base, pe.bytes.subarray(0, Math.min(pe.sizeOfHeaders, pe.bytes.length)));
    for (const s of pe.sections) {
      const n = Math.min(s.rawSize, s.vsize || s.rawSize);
      if (n && s.rawPtr) this.mem.writeBytes(base + s.rva, pe.bytes.subarray(s.rawPtr, s.rawPtr + n));
    }
    this.log('MEM', `${pe.name} mapeado en ${hex(base)}-${hex(base + pe.sizeOfImage)} (${pe.sections.length} secciones copiadas)`);
    if (base !== pe.imageBase) {
      const delta = (base - pe.imageBase) | 0;
      let n = 0, bad = 0;
      for (const r of relocs) {
        if (typeof r === 'number') { this.mem.w32(base + r, (this.mem.r32(base + r) + delta) >>> 0); n++; }
        else bad++;
      }
      this.log('RELOC', `${pe.name}: base ${hex(pe.imageBase)} -> ${hex(base)}, ${n} relocaciones HIGHLOW aplicadas${bad ? `, ${bad} de tipo no soportado` : ''}`);
      if (!relocs.length && pe.dirs[5]?.rva === 0) this.log('RELOC', `ADVERTENCIA: ${pe.name} no tiene .reloc; si tiene código, fallará al reubicarse`);
    } else {
      this.log('RELOC', `${pe.name}: cargado en su ImageBase preferido, ${relocs.length} relocaciones no necesarias`);
    }
    this.dllNext = Math.max(this.dllNext, (base + pe.sizeOfImage + 0xffff) & ~0xffff);
    return base;
  }

  resolveImports(pe, base) {
    const imports = readImports(pe);
    const report = { implemented: [], missing: [] };
    let total = 0;
    for (const { dll, funcs } of imports) {
      const D = dll.toUpperCase();
      const mod = MODULES[D];
      let imp = 0;
      for (const f of funcs) {
        total++;
        const nm = f.name ?? `#${f.ordinal}`;
        const addr = this.thunkFor(D, nm);
        this.mem.w32(base + f.slotRVA, addr);
        if (mod && mod[nm]) { imp++; report.implemented.push(`${D}!${nm}`); }
        else report.missing.push(`${D}!${nm}`);
      }
      this.log('IMPORT', `${dll}: ${funcs.length} funciones, ${imp} implementadas, ${funcs.length - imp} pendientes${mod ? '' : ' (DLL sin módulo HLE)'}`);
    }
    this.log('IMPORT', `Total ${total} importaciones resueltas a thunks en ${hex(THUNK_BASE)}..; implementadas ${report.implemented.length}/${total}`);
    if (report.missing.length) this.log('IMPORT', `Pendientes: ${report.missing.join(', ')}`);
    this.importReport = report;
    return report;
  }

  setupProcess(pe) {
    const m = this.mem;
    // TEB
    m.w32(TEB_ADDR + 0x00, 0xffffffff);             // cadena SEH vacía
    m.w32(TEB_ADDR + 0x04, STACK_TOP);
    m.w32(TEB_ADDR + 0x08, STACK_TOP - STACK_SIZE);
    m.w32(TEB_ADDR + 0x18, TEB_ADDR);
    m.w32(TEB_ADDR + 0x20, 0x1000);                 // PID
    m.w32(TEB_ADDR + 0x24, 0x1004);                 // TID
    m.w32(TEB_ADDR + 0x2c, TEB_ADDR + 0xe10);       // ThreadLocalStoragePointer
    m.w32(TEB_ADDR + 0x30, PEB_ADDR);
    m.w32(PEB_ADDR + 0x08, this.mainBase);
    this.cpu.fsBase = TEB_ADDR;
    // pila
    const c = this.cpu;
    c.r[4] = STACK_TOP - 16;
    c.r[5] = 0;
    c.push(0); // dirección de retorno falsa de BaseProcessStart
    m.w32(c.r[4], HOST_RETURN);
    c.eip = (this.mainBase + pe.entryRVA) >>> 0;
    c.r[0] = c.eip; c.r[3] = PEB_ADDR;
    this.log('CPU', `TEB=${hex(TEB_ADDR)} PEB=${hex(PEB_ADDR)} FS.base=${hex(TEB_ADDR)} ESP=${hex(c.r[4])} pila ${hex(STACK_TOP - STACK_SIZE)}-${hex(STACK_TOP)}`);
    const bytes = []; for (let i = 0; i < 16; i++) bytes.push(m.r8(c.eip + i).toString(16).padStart(2, '0'));
    this.log('CPU', `EIP inicial=${hex(c.eip)} bytes: ${bytes.join(' ')}`);
  }

  // ----- DLLs del juego (p.ej. RES_USA.DLL) -----
  loadLibrary(name) {
    const up = name.toUpperCase().split(/[\\/]/).pop();
    const withExt = up.includes('.') ? up : up + '.DLL';
    for (const [b, mo] of this.modules) if (mo.name === withExt) return b;
    if (MODULES[withExt]) return this.pseudoModule(withExt);
    const f = this.vfs.find(name) || this.vfs.find(withExt);
    if (!f) { this.log('DLL', `LoadLibrary("${name}"): no está en el VFS ni hay módulo HLE`); return 0; }
    const pe = parsePE(f.data, withExt);
    this.log('DLL', `LoadLibrary("${name}"): PE válido, ImageBase=${hex(pe.imageBase)} SizeOfImage=${hex(pe.sizeOfImage)} recursos=${pe.dirs[2]?.size || 0} bytes`);
    const base = this.mapImage(pe, this.dllNext);
    this.modules.set(base, { name: withExt, pe, base });
    this.resolveImports(pe, base);
    if (pe.entryRVA) {
      this.log('DLL', `${withExt}: llamando DllMain(${hex(base)}, DLL_PROCESS_ATTACH)`);
      const r = this.callGuest(base + pe.entryRVA, [base, 1, 0]);
      this.log('DLL', `${withExt}: DllMain devolvió ${r}`);
    } else this.log('DLL', `${withExt}: sin EntryPoint (DLL de recursos)`);
    return base;
  }
  pseudoModule(dll) {
    if (!this.pseudo) this.pseudo = new Map();
    if (!this.pseudo.has(dll)) this.pseudo.set(dll, 0x00120000 + this.pseudo.size * 0x1000);
    return this.pseudo.get(dll);
  }
  moduleName(h) {
    if (!h || h === this.mainBase) return this.modules.get(this.mainBase)?.name;
    if (this.modules.has(h)) return this.modules.get(h).name;
    if (this.pseudo) for (const [n, a] of this.pseudo) if (a === h) return n;
    return null;
  }
  getProcAddress(h, name) {
    const mo = this.modules.get(h);
    if (mo) {
      const ex = readExports(mo.pe);
      const rva = ex.get(name);
      return rva ? (mo.base + rva) >>> 0 : 0;
    }
    const dll = this.moduleName(h);
    if (!dll) return 0;
    const addr = this.thunkFor(dll, name);
    const t = this.thunks[(addr - THUNK_BASE) >> 2];
    this.log('API', `GetProcAddress(${dll}, ${name}) -> thunk ${hex(addr)}${t.impl ? '' : ' (NO implementada: detendrá la ejecución si se llama)'}`);
    return addr;
  }
  // recursos de un módulo cargado
  findResource(h, type, name) {
    const mo = this.modules.get(h || this.mainBase);
    if (!mo) return null;
    if (!mo.res) mo.res = readResources(mo.pe);
    const norm = (v) => (typeof v === 'string' && v.startsWith('#')) ? parseInt(v.slice(1), 10) : (typeof v === 'string' ? v.toUpperCase() : v);
    const t = norm(type), n = norm(name);
    const r = mo.res.find((e) => e.type === t && e.name === n);
    if (!r) return null;
    return { addr: (mo.base + r.rva) >>> 0, size: r.size, entry: r, base: mo.base };
  }

  // ----- llamadas guest <-> host -----
  dispatchThunk(eip) {
    const c = this.cpu, m = this.mem;
    if (eip === HOST_RETURN) throw new Error('HOST_RETURN fuera de callback');
    const t = this.thunks[(eip - THUNK_BASE) >> 2];
    if (!t) throw new HaltSignal(`Salto a zona de thunks sin función: ${hex(eip)}`, {});
    const sp = c.r[4];
    const ret = m.r32(sp);
    const impl = t.impl;
    const nArgs = impl ? (impl.cdecl ? 12 : impl.n) : 8;
    const args = [];
    for (let i = 0; i < nArgs; i++) { try { args.push(m.r32(sp + 4 + i * 4)); } catch { args.push(0); } }
    const label = `${t.dll === 'COM' ? '' : t.dll.replace('.DLL', '') + '!'}${t.name}`;
    this.apiCounts.set(label, (this.apiCounts.get(label) || 0) + 1);
    const entry = { name: label, ret, args: args.slice(0, impl ? nArgs : 6), result: undefined };
    this.apiTrace.push(entry); if (this.apiTrace.length > 60) this.apiTrace.shift();
    if (!impl) {
      throw new HaltSignal(`API no implementada: ${t.dll}!${t.name}`, {
        api: `${t.dll}!${t.name}`, caller: ret,
        stackArgs: args.map((a) => hex(a)),
      });
    }
    let res;
    this.curApi = label;
    res = impl.fn(this, ...args);
    if (res === undefined) res = 0;
    if (typeof res === 'object') { c.r[0] = res.eax >>> 0; if (res.edx !== undefined) c.r[2] = res.edx >>> 0; }
    else c.r[0] = res >>> 0;
    entry.result = c.r[0];
    if (this.traceApis && this.apiLogged < this.maxApiLog && !impl.quiet) {
      this.apiLogged++;
      this.log('API', `${label}(${entry.args.map((a) => hex(a, 1)).join(', ')}) = ${hex(c.r[0], 1)}  [ret ${hex(ret)}]${entry.note ? ' ' + entry.note : ''}`);
      if (this.apiLogged === this.maxApiLog) this.log('API', `(límite de ${this.maxApiLog} líneas de traza alcanzado; se siguen contando llamadas)`);
    }
    c.r[4] = (sp + 4 + (impl.cdecl ? 0 : impl.n * 4)) >>> 0;
    c.eip = ret;
  }
  note(s) { const e = this.apiTrace[this.apiTrace.length - 1]; if (e) e.note = (e.note ? e.note + ' ' : '') + s; }

  callGuest(addr, args, limit = 200_000_000) {
    const c = this.cpu;
    const savedEip = c.eip, savedEsp = c.r[4];
    for (let i = args.length - 1; i >= 0; i--) c.push(args[i] >>> 0);
    c.push(HOST_RETURN);
    c.eip = addr >>> 0;
    this.callDepth++;
    try {
      let n = 0;
      while (c.eip !== HOST_RETURN) {
        if (c.eip >= THUNK_BASE && c.eip < THUNK_END) this.dispatchThunk(c.eip);
        else if (this.useJit) this.jit.get(c.eip)(c, c.r, this.mem);
        else this.stepInterp();
        if (++n > limit) throw new HaltSignal(`Callback ${hex(addr)} superó ${limit} instrucciones`, {});
      }
    } finally { this.callDepth--; }
    const ret = c.r[0];
    c.r[4] = savedEsp; c.eip = savedEip;
    return ret;
  }

  // ----- bucle principal -----
  run(maxInstr = 1_000_000) {
    const c = this.cpu;
    this.yieldRequested = false;
    const start = c.icount;
    try {
      // ruta rápida: JIT sin perfilado ni traza diferida
      if (this.useJit && !this.profile && !(this.traceFrom && !this.traceStarted)) {
        const map = this.jit.map, fast = this.jit.fast, jit = this.jit, mem = this.mem, r = c.r, end = start + maxInstr;
        while (c.icount < end) {
          const eip = c.eip;
          if (eip >= THUNK_BASE && eip < THUNK_END) {
            if (eip === HOST_RETURN) throw new ExitSignal(c.r[0]);
            this.dispatchThunk(eip);
            if (this.yieldRequested) return { status: 'yield' };
            continue;
          }
          const fi = eip - 0x400000;
          let fn = fi >= 0 && fi < 0x200000 ? fast[fi] : map.get(eip);
          if (fn === undefined) fn = jit.get(eip);
          fn(c, r, mem);
        }
        return { status: 'running' };
      }
      while (c.icount - start < maxInstr) {
        const eip = c.eip;
        if (eip >= THUNK_BASE && eip < THUNK_END) {
          if (eip === HOST_RETURN) throw new ExitSignal(c.r[0]);
          this.dispatchThunk(eip);
          if (this.yieldRequested) return { status: 'yield' };
        } else {
          const i0 = c.icount;
          if (this.useJit) this.jit.get(eip)(c, c.r, this.mem); else this.stepInterp();
          if (this.profile) { const k = this.profile.get(eip) || 0; this.profile.set(eip, k + (c.icount - i0) / 256); }
          if (this.traceFrom && c.icount >= this.traceFrom && !this.traceStarted) { this.traceStarted = true; this.traceApis = true; this.apiLogged = 0; this.log('TRACE', `traza de APIs activada en la instrucción ${c.icount}`); }
        }
      }
      return { status: 'running' };
    } catch (e) {
      if (e instanceof ExitSignal) { this.exited = e.code; this.log('EXIT', `El programa terminó con código ${e.code} tras ${c.icount} instrucciones`); return { status: 'exited', code: e.code }; }
      return { status: 'halted', report: this.haltReport(e) };
    }
  }

  haltReport(e) {
    const c = this.cpu, m = this.mem;
    const lines = [];
    const kind = e instanceof HaltSignal ? 'API' : e instanceof CPUError ? 'CPU' : e instanceof MemFault ? 'MEMORIA' : 'INTERNO';
    lines.push(`DETENIDO (${kind}): ${e.message}`);
    if (e.info?.api) {
      lines.push(`  Llamada desde ${hex(e.info.caller)} (instrucción siguiente al CALL)`);
      lines.push(`  Primeros argumentos en pila: ${e.info.stackArgs.join(' ')}`);
    }
    if (e instanceof CPUError) lines.push(`  EIP=${hex(e.eip)} bytes: ${e.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    else if (e instanceof MemFault) lines.push(`  Instrucción en EIP=${hex(c.instrStart)}`);
    if (kind === 'INTERNO') lines.push(`  ${String(e.stack).split('\n').slice(0, 4).join('\n  ')}`);
    lines.push(`  Registros: ${c.dumpRegs()}`);
    lines.push(`  Instrucciones ejecutadas: ${c.icount}  Llamadas API: ${[...this.apiCounts.values()].reduce((a, b) => a + b, 0)}`);
    const tr = []; for (let i = 16; i >= 1; i--) tr.push(hex(c.trace[(c.traceIdx - i) & 63]));
    lines.push(`  Últimos EIP: ${tr.join(' ')}`);
    lines.push(`  Últimas APIs: ${this.apiTrace.slice(-12).map((a) => a.name).join(' → ')}`);
    const stk = []; for (let i = 0; i < 8; i++) { try { stk.push(hex(m.r32(c.r[4] + i * 4))); } catch { break; } }
    lines.push(`  Pila [esp]: ${stk.join(' ')}`);
    for (const l of lines) this.log('HALT', l);
    return { kind, message: e.message, text: lines.join('\n'), error: e };
  }
}
