// kernel32.js — implementación HLE de KERNEL32 usada por el CRT de MSVC y por juegos de 1996
import { api, stub, ExitSignal } from './common.js';
import { HEAP_BASE } from '../memory.js';

const INVALID_HANDLE = 0xffffffff;
const ERROR_FILE_NOT_FOUND = 2;

function fileHandle(emu, h) { const o = emu.handles.get(h); return o && o.type === 'file' ? o : null; }
const now = (emu) => emu.nowMs();

const K = {
  __init(emu) {
    emu.state.k32 = { tls: new Array(64).fill(0), tlsUsed: new Array(64).fill(false), heaps: 0, cmdline: 0, env: 0 };
  },
  // ---- versión / proceso ----
  GetVersion: api(0, () => 0xc0000004), // Windows 95 (4.0, build bit 31 = Win9x)
  GetVersionExA: api(1, (emu, p) => {
    const m = emu.mem; m.w32(p + 4, 4); m.w32(p + 8, 0); m.w32(p + 12, 950); m.w32(p + 16, 1); m.writeCStr(p + 20, ''); return 1;
  }),
  GetCommandLineA: api(0, (emu) => {
    const s = emu.state.k32;
    if (!s.cmdline) s.cmdline = emu.sysString(emu.commandLine || 'C:\\DAYTONA\\DAYTONA.EXE');
    return s.cmdline;
  }),
  GetStartupInfoA: api(1, (emu, p) => { emu.mem.fill(p, 0, 68); emu.mem.w32(p, 68); }),
  GetModuleHandleA: api(1, (emu, p) => {
    if (!p) return emu.mainBase;
    const n = emu.mem.cstr(p);
    emu.note(`"${n}"`);
    const up = n.toUpperCase().replace(/^.*[\\/]/, '');
    for (const [b, mo] of emu.modules) if (mo.name === up || mo.name === up + '.DLL') return b;
    const dll = up.includes('.') ? up : up + '.DLL';
    return emu.pseudoModule(dll);
  }),
  GetModuleFileNameA: api(3, (emu, h, buf, size) => {
    const nm = emu.moduleName(h) || 'DAYTONA.EXE';
    return emu.mem.writeCStr(buf, 'C:\\DAYTONA\\' + nm, size);
  }),
  LoadLibraryA: api(1, (emu, p) => { const n = emu.mem.cstr(p); emu.note(`"${n}"`); return emu.loadLibrary(n); }),
  FreeLibrary: api(1, () => 1),
  GetProcAddress: api(2, (emu, h, p) => {
    const name = p < 0x10000 ? `#${p}` : emu.mem.cstr(p);
    return emu.getProcAddress(h, name);
  }),
  ExitProcess: api(1, (emu, code) => { throw new ExitSignal(code); }),
  TerminateProcess: api(2, (emu, h, code) => { throw new ExitSignal(code); }),
  GetCurrentProcess: api(0, () => 0xffffffff),
  SetPriorityClass: api(2, () => 1),
  GetProcessAffinityMask: api(3, (emu, process, processMask, systemMask) => {
    if (!processMask || !systemMask) { emu.lastError = 87; return 0; }
    emu.mem.w32(processMask, 1); emu.mem.w32(systemMask, 1); return 1;
  }),
  GetCurrentThread: api(0, () => 0xfffffffe),
  GetCurrentProcessId: api(0, () => 0x1000),
  GetCurrentThreadId: api(0, () => 0x1004),
  GetLastError: api(0, (emu) => emu.lastError, { quiet: true }),
  SetLastError: api(1, (emu, v) => { emu.lastError = v; }, { quiet: true }),
  SetErrorMode: api(1, () => 0),
  RtlUnwind: api(4, (emu) => { emu.note('(SEH unwind ignorado)'); return 0; }),
  UnhandledExceptionFilter: api(1, () => 0),
  SetUnhandledExceptionFilter: api(1, () => 0),
  DebugBreak: api(0, (emu) => { throw new Error('DebugBreak llamado por el juego'); }),
  OutputDebugStringA: api(1, (emu, p) => { emu.log('DEBUG', emu.mem.cstr(p)); }),
  FatalAppExitA: api(2, (emu, f, p) => { throw new Error('FatalAppExit: ' + emu.mem.cstr(p)); }),
  IsBadReadPtr: api(2, (emu, p) => (p >= 0x1000 && p < emu.mem.size ? 0 : 1)),
  IsBadWritePtr: api(2, (emu, p) => (p >= 0x1000 && p < emu.mem.size ? 0 : 1)),
  IsBadCodePtr: api(1, (emu, p) => (p >= 0x1000 && p < emu.mem.size ? 0 : 1)),
  GetSystemInfo: api(1, (emu, p) => {
    const m = emu.mem; m.fill(p, 0, 36);
    m.w32(p + 4, 0x1000); m.w32(p + 8, 0x10000); m.w32(p + 12, 0x7ffeffff); m.w32(p + 16, 1);
    m.w32(p + 20, 1); m.w32(p + 24, 586); m.w32(p + 28, 0x10000); m.w16(p + 32, 5);
  }),
  GlobalMemoryStatus: api(1, (emu, p) => {
    const m = emu.mem; m.w32(p, 32); m.w32(p + 4, 10); m.w32(p + 8, 64 << 20); m.w32(p + 12, 48 << 20);
    m.w32(p + 16, 128 << 20); m.w32(p + 20, 100 << 20); m.w32(p + 24, 0x7ffe0000); m.w32(p + 28, 0x7f000000);
  }),
  // ---- entorno / cadenas ----
  GetEnvironmentStrings: api(0, (emu) => { const a = emu.mem.alloc(64); emu.mem.writeCStr(a, 'PATH=C:\\WINDOWS'); emu.mem.w8(a + 16, 0); return a; }),
  GetEnvironmentStringsA: api(0, (emu) => K.GetEnvironmentStrings.fn(emu)),
  GetEnvironmentStringsW: api(0, () => 0),
  FreeEnvironmentStringsA: api(1, () => 1),
  FreeEnvironmentStringsW: api(1, () => 1),
  GetEnvironmentVariableA: api(3, () => 0),
  GetLocaleInfoA: api(4, (emu, lcid, type, buf, count) => {
    const values = {1:"English",2:"ENU",3:"English (United States)",4:"en-US",5:"United States",6:"USA",7:"USA",0x0e:".",0x0f:","};
    const value = values[type] || "";
    if (!count) return value.length + 1;
    return emu.mem.writeCStr(buf, value, count) + 1;
  }),
  GetSystemDefaultLangID: api(0, () => 0x0409),
  GetACP: api(0, () => 1252),
  GetOEMCP: api(0, () => 437),
  GetCPInfo: api(2, (emu, cp, p) => { emu.mem.fill(p, 0, 20); emu.mem.w32(p, 1); emu.mem.w8(p + 4, 0x3f); return 1; }),
  GetStringTypeA: api(5, (emu, lcid, type, src, n, out) => { stringType(emu, src, n, out, false); return 1; }),
  GetStringTypeW: api(4, (emu, type, src, n, out) => { stringType(emu, src, n, out, true); return 1; }),
  LCMapStringA: api(6, (emu, lcid, flags, src, n, dst, dn) => lcmap(emu, flags, src, n, dst, dn, false)),
  LCMapStringW: api(6, (emu, lcid, flags, src, n, dst, dn) => lcmap(emu, flags, src, n, dst, dn, true)),
  MultiByteToWideChar: api(6, (emu, cp, fl, src, n, dst, dn) => {
    const m = emu.mem; let s = n === 0xffffffff ? emu.mem.cstr(src) + '\0' : ''; if (n !== 0xffffffff) for (let i = 0; i < n; i++) s += String.fromCharCode(m.r8(src + i));
    if (!dn) return s.length; const k = Math.min(s.length, dn); for (let i = 0; i < k; i++) m.w16(dst + i * 2, s.charCodeAt(i)); return k;
  }),
  WideCharToMultiByte: api(8, (emu, cp, fl, src, n, dst, dn) => {
    const m = emu.mem; let s = n === 0xffffffff ? emu.mem.wstr(src) + '\0' : ''; if (n !== 0xffffffff) for (let i = 0; i < n; i++) s += String.fromCharCode(m.r16(src + i * 2));
    if (!dn) return s.length; const k = Math.min(s.length, dn); for (let i = 0; i < k; i++) m.w8(dst + i, s.charCodeAt(i) & 0xff); return k;
  }),
  CompareStringA: api(6, (emu, lc, fl, a, na, b, nb) => {
    const sa = rd(emu, a, na), sb = rd(emu, b, nb); const x = fl & 1 ? sa.toUpperCase() : sa, y = fl & 1 ? sb.toUpperCase() : sb; return x < y ? 1 : x > y ? 3 : 2;
  }),
  lstrlenA: api(1, (emu, p) => (p ? emu.mem.cstr(p, 1 << 20).length : 0)),
  lstrcpyA: api(2, (emu, d, s) => { emu.mem.writeCStr(d, emu.mem.cstr(s, 1 << 20)); return d; }),
  lstrcpynA: api(3, (emu, d, s, n) => { emu.mem.writeCStr(d, emu.mem.cstr(s, 1 << 20), n); return d; }),
  lstrcatA: api(2, (emu, d, s) => { const a = emu.mem.cstr(d, 1 << 20); emu.mem.writeCStr(d, a + emu.mem.cstr(s, 1 << 20)); return d; }),
  lstrcmpA: api(2, (emu, a, b) => cmp(emu.mem.cstr(a), emu.mem.cstr(b))),
  lstrcmpiA: api(2, (emu, a, b) => cmp(emu.mem.cstr(a).toUpperCase(), emu.mem.cstr(b).toUpperCase())),
  // ---- memoria ----
  HeapCreate: api(3, (emu) => 0x00140000 + (emu.state.k32.heaps++) * 16),
  HeapDestroy: api(1, () => 1),
  GetProcessHeap: api(0, () => 0x00140000),
  HeapAlloc: api(3, (emu, h, fl, n) => emu.mem.alloc(n, true), { quiet: true }),
  HeapReAlloc: api(4, (emu, h, fl, p, n) => emu.mem.realloc(p, n), { quiet: true }),
  HeapFree: api(3, (emu, h, fl, p) => (emu.mem.free(p) ? 1 : 1), { quiet: true }),
  HeapSize: api(3, (emu, h, fl, p) => emu.mem.blockSize(p)),
  HeapValidate: api(3, () => 1),
  HeapCompact: api(2, () => 0x100000),
  VirtualAlloc: api(4, (emu, addr, n, type, prot) => {
    if (addr && emu.mem.blockSize(addr) >= 0) return addr; // commit sobre reserva previa
    if (addr && addr >= HEAP_BASE) return addr;
    const a = emu.mem.alloc((n + 0xfff) & ~0xfff, true); return a;
  }),
  VirtualFree: api(3, () => 1),
  VirtualProtect: api(4, (emu, a, n, p, old) => { if (old) emu.mem.w32(old, 4); return 1; }),
  VirtualQuery: api(3, (emu, a, p, n) => { emu.mem.fill(p, 0, 28); emu.mem.w32(p, a & ~0xfff); emu.mem.w32(p + 12, 0x1000); emu.mem.w32(p + 16, 0x1000); emu.mem.w32(p + 20, 4); emu.mem.w32(p + 24, 0x20000); return 28; }),
  GlobalAlloc: api(2, (emu, fl, n) => emu.mem.alloc(n || 1, true)),
  GlobalReAlloc: api(3, (emu, p, n) => emu.mem.realloc(p, n)),
  GlobalFree: api(1, (emu, p) => { emu.mem.free(p); return 0; }),
  GlobalLock: api(1, (emu, p) => p), GlobalUnlock: api(1, () => 1),
  GlobalHandle: api(1, (emu, p) => p), GlobalSize: api(1, (emu, p) => emu.mem.blockSize(p)),
  LocalAlloc: api(2, (emu, fl, n) => emu.mem.alloc(n || 1, true)),
  LocalFree: api(1, (emu, p) => { emu.mem.free(p); return 0; }),
  LocalLock: api(1, (emu, p) => p), LocalUnlock: api(1, () => 1),
  // ---- sincronización / hilos ----
  InitializeCriticalSection: api(1, (emu, p) => { emu.mem.fill(p, 0, 24); }, { quiet: true }),
  DeleteCriticalSection: api(1, () => 0, { quiet: true }),
  EnterCriticalSection: api(1, () => 0, { quiet: true }),
  LeaveCriticalSection: api(1, () => 0, { quiet: true }),
  InterlockedIncrement: api(1, (emu, p) => { const v = (emu.mem.r32(p) + 1) >>> 0; emu.mem.w32(p, v); return v; }, { quiet: true }),
  InterlockedDecrement: api(1, (emu, p) => { const v = (emu.mem.r32(p) - 1) >>> 0; emu.mem.w32(p, v); return v; }, { quiet: true }),
  InterlockedExchange: api(2, (emu, p, v) => { const o = emu.mem.r32(p); emu.mem.w32(p, v); return o; }, { quiet: true }),
  TlsAlloc: api(0, (emu) => { const s = emu.state.k32; const i = s.tlsUsed.indexOf(false); s.tlsUsed[i] = true; return i; }),
  TlsFree: api(1, (emu, i) => { emu.state.k32.tlsUsed[i] = false; return 1; }),
  TlsGetValue: api(1, (emu, i) => emu.state.k32.tls[i], { quiet: true }),
  TlsSetValue: api(2, (emu, i, v) => { emu.state.k32.tls[i] = v; return 1; }, { quiet: true }),
  CreateEventA: api(4, (emu, sa, manual, init) => emu.newHandle({ type: 'event', set: !!init })),
  SetEvent: api(1, (emu, h) => { const o = emu.handles.get(h); if (o) o.set = true; return 1; }),
  ResetEvent: api(1, (emu, h) => { const o = emu.handles.get(h); if (o) o.set = false; return 1; }),
  WaitForSingleObject: api(2, (emu) => { emu.note('(sin hilos reales: devuelve WAIT_OBJECT_0)'); return 0; }),
  CreateMutexA: api(3, (emu) => emu.newHandle({ type: 'mutex' })),
  ReleaseMutex: api(1, () => 1),
  Sleep: api(1, (emu, ms) => { emu.sleepMs = ms; emu.timeOffset += Math.max(ms, 1); if (ms >= 10 && emu.clockMode === 'real') emu.yieldRequested = true; }, { quiet: true }),
  // CreateThread queda pendiente a propósito: requiere planificador cooperativo
  // ---- tiempo ----
  GetTickCount: api(0, (emu) => Math.floor(now(emu)) >>> 0, { quiet: true }),
  QueryPerformanceFrequency: api(1, (emu, p) => { emu.mem.w32(p, 1000000); emu.mem.w32(p + 4, 0); return 1; }),
  QueryPerformanceCounter: api(1, (emu, p) => { const us = Math.floor(now(emu) * 1000); emu.mem.w32(p, us >>> 0); emu.mem.w32(p + 4, Math.floor(us / 4294967296)); return 1; }, { quiet: true }),
  GetSystemTime: api(1, (emu, p) => systime(emu, p, new Date(), true)),
  GetLocalTime: api(1, (emu, p) => systime(emu, p, new Date(), false)),
  GetSystemTimeAsFileTime: api(1, (emu, p) => { const ft = BigInt(Date.now()) * 10000n + 116444736000000000n; emu.mem.w32(p, Number(ft & 0xffffffffn)); emu.mem.w32(p + 4, Number(ft >> 32n)); }),
  GetTimeZoneInformation: api(1, (emu, p) => { emu.mem.fill(p, 0, 172); emu.mem.w32(p, 180); return 0; }),
  FileTimeToLocalFileTime: api(2, (emu, a, b) => { emu.mem.copy(b, a, 8); return 1; }),
  FileTimeToSystemTime: api(2, (emu, a, b) => systime(emu, b, new Date(), true) || 1),
  // ---- archivos (VFS) ----
  GetStdHandle: api(1, (emu, n) => (n >>> 0) === 0xfffffff6 ? 0x10 : (n >>> 0) === 0xfffffff5 ? 0x14 : 0x18),
  SetStdHandle: api(2, () => 1),
  GetFileType: api(1, (emu, h) => (h <= 0x18 ? 2 : 1)),
  SetHandleCount: api(1, (emu, n) => n),
  _lopen: api(2, (emu, path, mode) => {
    const name = emu.mem.cstr(path); emu.note(`"${name}"`);
    const f = emu.vfs.find(name);
    return f ? emu.newHandle({type:"file",file:f,pos:0,name}) : 0xffffffff;
  }),
  _lclose: api(1, (emu, h) => { if (!fileHandle(emu,h)) return 0xffff; emu.handles.delete(h); return 0; }),
  CreateFileA: api(7, (emu, pName, access, share, sa, disp, flags) => {
    const name = emu.mem.cstr(pName);
    emu.note(`"${name}"`);
    if (emu.logFiles !== false) emu.log('FS', `abre "${name}" en instr=${emu.cpu.icount} (t=${(emu.nowMs() / 1000).toFixed(2)}s)`);
    let f = emu.vfs.find(name);
    if (!f) {
      if (disp === 1 || disp === 2 || disp === 4) f = emu.vfs.create(name); // CREATE_NEW/ALWAYS, OPEN_ALWAYS
      else { emu.lastError = ERROR_FILE_NOT_FOUND; emu.log('FS', `CreateFileA("${name}") -> no encontrado en el VFS`); return INVALID_HANDLE; }
    } else if (disp === 2 || disp === 5) f.data = new Uint8Array(0);
    return emu.newHandle({ type: 'file', file: f, pos: 0, name });
  }),
  ReadFile: api(5, (emu, h, buf, n, pRead) => {
    const o = fileHandle(emu, h);
    if (!o) { if (pRead) emu.mem.w32(pRead, 0); return 0; }
    const k = Math.max(0, Math.min(n, o.file.data.length - o.pos));
    emu.mem.writeBytes(buf, o.file.data.subarray(o.pos, o.pos + k));
    o.pos += k;
    if (pRead) emu.mem.w32(pRead, k);
    emu.note(`(${o.name}: ${k} bytes)`);
    return 1;
  }),
  WriteFile: api(5, (emu, h, buf, n, pW) => {
    if (h === 0x14 || h === 0x18) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(emu.mem.r8(buf + i)); emu.log('STDOUT', s.replace(/\r?\n$/, '')); if (pW) emu.mem.w32(pW, n); return 1; }
    const o = fileHandle(emu, h); if (!o) return 0;
    const end = o.pos + n;
    if (end > o.file.data.length) { const d = new Uint8Array(end); d.set(o.file.data); o.file.data = d; }
    o.file.data.set(emu.mem.u8.subarray(buf, buf + n), o.pos); o.pos = end;
    if (pW) emu.mem.w32(pW, n); return 1;
  }),
  SetFilePointer: api(4, (emu, h, dist, pHigh, method) => {
    const o = fileHandle(emu, h); if (!o) return 0xffffffff;
    const d = dist | 0;
    o.pos = method === 0 ? d : method === 1 ? o.pos + d : o.file.data.length + d;
    if (pHigh) emu.mem.w32(pHigh, 0);
    return o.pos;
  }),
  GetFileSize: api(2, (emu, h, pHigh) => { const o = fileHandle(emu, h); if (pHigh) emu.mem.w32(pHigh, 0); return o ? o.file.data.length : 0xffffffff; }),
  SetEndOfFile: api(1, (emu, h) => { const o = fileHandle(emu, h); if (o) o.file.data = o.file.data.slice(0, o.pos); return 1; }),
  FlushFileBuffers: api(1, () => 1),
  CloseHandle: api(1, (emu, h) => { emu.handles.delete(h); return 1; }),
  DeleteFileA: api(1, (emu, p) => (emu.vfs.files.delete(emu.vfs.norm(emu.mem.cstr(p))) ? 1 : 0)),
  GetFileAttributesA: api(1, (emu, p) => { const n = emu.mem.cstr(p); emu.note(`"${n}"`); return emu.vfs.find(n) ? 0x20 : 0xffffffff; }),
  FindFirstFileA: api(2, (emu, p, out) => {
    const pat = emu.mem.cstr(p); const list = emu.vfs.list(pat);
    emu.note(`"${pat}" -> ${list.length}`);
    if (!list.length) { emu.lastError = ERROR_FILE_NOT_FOUND; return INVALID_HANDLE; }
    const h = emu.newHandle({ type: 'find', list, i: 0 }); findData(emu, out, list[0]); return h;
  }),
  FindNextFileA: api(2, (emu, h, out) => { const o = emu.handles.get(h); if (!o || ++o.i >= o.list.length) { emu.lastError = 18; return 0; } findData(emu, out, o.list[o.i]); return 1; }),
  FindClose: api(1, (emu, h) => { emu.handles.delete(h); return 1; }),
  GetCurrentDirectoryA: api(2, (emu, n, buf) => emu.mem.writeCStr(buf, 'C:\\DAYTONA', n)),
  SetCurrentDirectoryA: api(1, (emu, p) => { emu.note(`"${emu.mem.cstr(p)}"`); return 1; }),
  GetFullPathNameA: api(4, (emu, p, n, buf, pFile) => {
    let s = emu.mem.cstr(p); if (!/^[A-Za-z]:/.test(s)) s = 'C:\\DAYTONA\\' + s;
    const k = emu.mem.writeCStr(buf, s, n); if (pFile) emu.mem.w32(pFile, buf + s.lastIndexOf('\\') + 1); return k;
  }),
  GetWindowsDirectoryA: api(2, (emu, buf, n) => emu.mem.writeCStr(buf, 'C:\\WINDOWS', n)),
  GetSystemDirectoryA: api(2, (emu, buf, n) => emu.mem.writeCStr(buf, 'C:\\WINDOWS\\SYSTEM', n)),
  GetTempPathA: api(2, (emu, n, buf) => emu.mem.writeCStr(buf, 'C:\\TEMP\\', n)),
  // Unidades: C: = disco, D: = CD-ROM virtual con los datos del juego
  GetLogicalDrives: api(0, () => 0b1100),
  GetDriveTypeA: api(1, (emu, p) => { const s = p ? emu.mem.cstr(p).toUpperCase() : 'C:\\'; emu.note(`"${s}"`); return s.startsWith('D') ? 5 : s.startsWith('C') ? 3 : 1; }),
  GetVolumeInformationA: api(8, (emu, root, nameBuf, nameLen, serial, maxComp, fsFlags, fsName, fsLen) => {
    const r = root ? emu.mem.cstr(root).toUpperCase() : 'C:\\';
    const label = r.startsWith('D') ? (emu.cdLabel || 'DAYTONA') : 'DISK';
    emu.note(`"${r}" -> "${label}"`);
    if (nameBuf) emu.mem.writeCStr(nameBuf, label, nameLen);
    if (serial) emu.mem.w32(serial, 0x19961996);
    if (maxComp) emu.mem.w32(maxComp, 255);
    if (fsFlags) emu.mem.w32(fsFlags, 0);
    if (fsName) emu.mem.writeCStr(fsName, r.startsWith('D') ? 'CDFS' : 'FAT', fsLen);
    return 1;
  }),
  GetDiskFreeSpaceA: api(5, (emu, r, a, b, c, d) => { const m = emu.mem; if (a) m.w32(a, 8); if (b) m.w32(b, 512); if (c) m.w32(c, 100000); if (d) m.w32(d, 200000); return 1; }),
  // ---- recursos ----
  FindResourceA: api(3, (emu, h, name, type) => {
    const n = name < 0x10000 ? name : emu.mem.cstr(name), t = type < 0x10000 ? type : emu.mem.cstr(type);
    const r = emu.findResource(h, t, n); emu.note(`(tipo ${t}, id ${n}) ${r ? 'encontrado' : 'NO encontrado'}`);
    return r ? emu.newHandle({ type: 'res', ...r }) : 0;
  }),
  LoadResource: api(2, (emu, h, hr) => { const o = emu.handles.get(hr); return o ? o.addr : 0; }),
  LockResource: api(1, (emu, p) => p),
  SizeofResource: api(2, (emu, h, hr) => { const o = emu.handles.get(hr); return o ? o.size : 0; }),
  FreeResource: api(1, () => 0),
  // ---- perfiles .INI (en VFS) ----
  GetPrivateProfileStringA: api(6, (emu, sec, key, def, buf, n, file) => {
    const v = iniGet(emu, file, sec, key); const s = v ?? (def ? emu.mem.cstr(def) : '');
    emu.note(`[${sec ? emu.mem.cstr(sec) : '*'}] ${key ? emu.mem.cstr(key) : '*'} = "${s}"`); return emu.mem.writeCStr(buf, s, n);
  }),
  GetPrivateProfileIntA: api(4, (emu, sec, key, def, file) => { const v = iniGet(emu, file, sec, key); return v == null ? def : (parseInt(v, 10) | 0) >>> 0; }),
  WritePrivateProfileStringA: api(4, () => 1),
  GetProfileStringA: api(5, (emu, s, k, def, buf, n) => emu.mem.writeCStr(buf, def ? emu.mem.cstr(def) : '', n)),
  GetProfileIntA: api(3, (emu, s, k, def) => def),
};

function rd(emu, p, n) { if ((n | 0) === -1) return emu.mem.cstr(p); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(emu.mem.r8(p + i)); return s; }
function cmp(a, b) { return a < b ? -1 >>> 0 : a > b ? 1 : 0; }
function stringType(emu, src, n, out, wide) {
  const m = emu.mem; const cnt = (n | 0) === -1 ? (wide ? m.wstr(src).length + 1 : m.cstr(src).length + 1) : n;
  for (let i = 0; i < cnt; i++) {
    const c = wide ? m.r16(src + i * 2) : m.r8(src + i);
    let t = 0;
    if (c >= 65 && c <= 90) t = 0x1 | 0x100; else if (c >= 97 && c <= 122) t = 0x2 | 0x100;
    else if (c >= 48 && c <= 57) t = 0x4; else if (c === 32 || (c >= 9 && c <= 13)) t = 0x8 | (c === 32 ? 0x40 : 0);
    else if (c >= 33 && c <= 126) t = 0x10; else if (c < 32 || c === 127) t = 0x20;
    m.w16(out + i * 2, t);
  }
}
function lcmap(emu, flags, src, n, dst, dn, wide) {
  const m = emu.mem; let s = '';
  const cnt = (n | 0) === -1 ? -1 : n;
  if (cnt === -1) s = (wide ? m.wstr(src) : m.cstr(src)) + '\0'; else for (let i = 0; i < cnt; i++) s += String.fromCharCode(wide ? m.r16(src + i * 2) : m.r8(src + i));
  if (flags & 0x200) s = s.toUpperCase(); else if (flags & 0x100) s = s.toLowerCase();
  if (!dn) return s.length;
  const k = Math.min(dn, s.length);
  for (let i = 0; i < k; i++) wide ? m.w16(dst + i * 2, s.charCodeAt(i)) : m.w8(dst + i, s.charCodeAt(i));
  return k;
}
function systime(emu, p, d, utc) {
  const m = emu.mem;
  const v = utc ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDay(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
  v.forEach((x, i) => m.w16(p + i * 2, x));
}
function findData(emu, out, e) {
  const m = emu.mem; m.fill(out, 0, 320); m.w32(out, 0x20); m.w32(out + 32, e.file.data.length); m.writeCStr(out + 44, e.name, 260);
}
function iniGet(emu, file, sec, key) {
  if (!file || !sec || !key) return null;
  const f = emu.vfs.find(emu.mem.cstr(file)); if (!f) return null;
  const txt = new TextDecoder('latin1').decode(f.data);
  const S = emu.mem.cstr(sec).toUpperCase(), Kk = emu.mem.cstr(key).toUpperCase();
  let cur = null;
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[')) { cur = t.slice(1, t.indexOf(']')).toUpperCase(); continue; }
    if (cur === S) { const i = t.indexOf('='); if (i > 0 && t.slice(0, i).trim().toUpperCase() === Kk) return t.slice(i + 1).trim(); }
  }
  return null;
}

export default K;
