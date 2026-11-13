#!/usr/bin/env node
// Uso: node tools/run-node.mjs <ruta/DAYTONA.EXE> [--max 50000000] [--frame salida.png] [--log salida.log] [--quiet-api]
// Carga TODOS los archivos de la carpeta del EXE en el VFS (como hace la página con el selector de carpeta).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Emulator } from '../src/emulator.js';
import { surfaceToRGBA } from '../src/win32/ddraw.js';

const args = process.argv.slice(2);
const exe = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
if (!exe) { console.error('Uso: node tools/run-node.mjs <EXE> [--max N] [--frame out.png] [--log out.log]'); process.exit(1); }
const maxInstr = Number(opt('--max', 200_000_000));
const framePath = opt('--frame', null);
const logPath = opt('--log', null);
const logLines = [];
const log = (s) => { logLines.push(s); console.log(s); };

let lastFrame = null;
const host = {
  deferPresent: true,
  present(rgba, w, h) { lastFrame = { rgba: rgba.slice(), w, h }; },
  setMode(w, h, bpp) {}, setTitle(t) {},
  audio: { // en Node sólo registramos (Web Audio existe en el navegador)
    play(id, data, fmt, loop) { host.audioPlays = (host.audioPlays || 0) + 1; host.lastAudio = { id, bytes: data.length, fmt, loop, peak: Math.max(...data.slice(0, 4096)) }; },
    stop() {}, update() {}, setVolume() {}, setPan() {}, setRate() {},
  },
};

const emu = new Emulator({ log, host });
if (args.includes('--quiet-api')) emu.traceApis = false;
if (opt('--trace-from')) { emu.traceApis = false; emu.traceFrom = Number(opt('--trace-from')); emu.maxApiLog = Number(opt('--trace-lines', 3000)); }
if (args.includes('--no-jit')) emu.useJit = false;
if (opt('--clock')) emu.clockMode = opt('--clock');
if (opt('--mhz')) emu.instrPerMs = Number(opt('--mhz')) * 1000;
if (args.includes('--profile')) emu.profile = new Map();
const dir = path.dirname(path.resolve(exe));
let nFiles = 0, nBytes = 0;
for (const f of walk(dir)) {
  const rel = path.relative(dir, f).split(path.sep).join('\\');
  const data = new Uint8Array(fs.readFileSync(f));
  emu.vfs.add(rel, data); nFiles++; nBytes += data.length;
}
log(`[VFS] ${nFiles} archivos (${(nBytes / 1048576).toFixed(1)} MiB) de ${dir}`);
emu.vfs.cwd = '';

const t0 = Date.now();
try { emu.loadMain(new Uint8Array(fs.readFileSync(exe)), path.basename(exe).toUpperCase()); }
catch (e) { log(`[FATAL] carga: ${e.message}`); finish(); process.exit(2); }

// --keys "800000000:0d:1,830000000:0d:0"  (instrucción:VK hex:1=pulsa/0=suelta)
// "1234ms:0d:1" = en milisegundos del reloj del juego; sin "ms" = en instrucciones
const keySchedule = (opt('--keys', '') || '').split(',').filter(Boolean).map((t) => { const [at, vk, d] = t.split(':'); return at.endsWith('ms') ? { ms: Number(at.slice(0, -2)), vk: parseInt(vk, 16), down: d === '1' } : { at: Number(at), vk: parseInt(vk, 16), down: d === '1' }; });
let res = { status: maxInstr === 0 ? 'analizado (sin ejecutar)' : 'running' }, slices = 0;
while (emu.cpu.icount < maxInstr) {
  for (const k of keySchedule) if (!k.done && (k.ms !== undefined ? emu.nowMs() - 10000 >= k.ms : emu.cpu.icount >= k.at)) { k.done = true; emu.keyEvent(k.vk, k.down); log(`[TECLA] ${k.down ? 'pulsa' : 'suelta'} VK 0x${k.vk.toString(16)} en instr=${emu.cpu.icount}`); }
  res = emu.run(Math.min(Number(opt('--slice', 5_000_000)), maxInstr - emu.cpu.icount));
  slices++;
  if (emu.state.dd.dirty) { emu.state.dd.dirty = false; emu.scanout(); }
  if (opt('--every') && slices % Number(opt('--every')) === 0) {
    const d = emu.state.dd; const nz = lastFrame ? countNonBlack(lastFrame.rgba) : 0;
    log(`[PROGRESO] t=${((Date.now() - t0) / 1000).toFixed(2)}s tj=${((emu.nowMs() - 10000) / 1000).toFixed(3)}s instr=${emu.cpu.icount} frames_juego=${d.frames} pixeles_no_negros_en_pantalla=${nz} blts=${d.bltCount || 0} gdi=${JSON.stringify(emu.state.gdi?.stats || {})}`);
    if (framePath && lastFrame && nz) fs.writeFileSync(framePath.replace(/\.png$/, `_${emu.cpu.icount}.png`), png(lastFrame.rgba, lastFrame.w, lastFrame.h));
  }
  if (res.status === 'halted' || res.status === 'exited') break;
}
const dt = (Date.now() - t0) / 1000;
if (emu.profile) {
  // agrupa por función aproximada: ventana de 256 bytes
  const byWin = new Map();
  for (const [a, n] of emu.profile) { const k = a & ~0xff; byWin.set(k, (byWin.get(k) || 0) + n); }
  const tot = [...emu.profile.values()].reduce((x, y) => x + y, 0);
  log(`[PROFILE] ${tot} muestras (1 cada 256 instr.). Zonas más calientes:`);
  for (const [k, n] of [...byWin].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    const top = [...emu.profile].filter(([a]) => (a & ~0xff) === k).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a, c]) => a.toString(16) + ':' + c).join(' ');
    log(`[PROFILE]   ${k.toString(16)}..+ff ${(100 * n / tot).toFixed(1)}%  [${top}]`);
  }
}
log(`[RESUMEN] JIT: ${emu.useJit ? JSON.stringify(emu.jit.stats) : 'desactivado'}`);
log(`[RESUMEN] estado=${res.status} instrucciones=${emu.cpu.icount} tiempo=${dt.toFixed(2)}s (${(emu.cpu.icount / dt / 1e6).toFixed(1)} MIPS) slices=${slices}`);
log(`[RESUMEN] APIs llamadas (distintas=${emu.apiCounts.size}): ${[...emu.apiCounts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ')}`);
if (emu.state.keyQueries) log(`[RESUMEN] teclas consultadas por GetAsyncKeyState: ${[...emu.state.keyQueries].map(([k, n]) => '0x' + k.toString(16) + '×' + n).join(' ')}`);
log(`[RESUMEN] frames presentados por el juego=${emu.state.dd.frames} barridos=${emu.state.dd.scanouts} GDI=${JSON.stringify(emu.state.gdi?.stats || {})}${host.audioPlays ? `, buffers de audio reproducidos=${host.audioPlays} (último: ${host.lastAudio.bytes} bytes, ${host.lastAudio.fmt.rate}Hz, pico=${host.lastAudio.peak})` : ''}`);
emu.scanout();
const dumpDir = opt('--dump-surfaces', null);
if (dumpDir) {
  fs.mkdirSync(dumpDir, { recursive: true });
  for (const [ptr, o] of emu.state.dd.objs) {
    if (o.iface !== 'IDirectDrawSurface' || !o.w || o.released) continue;
    const rgba = surfaceToRGBA(emu, o);
    const nz = countNonBlack(rgba);
    const f = path.join(dumpDir, `surf${String(o.id).padStart(3, '0')}_${o.w}x${o.h}x${o.bpp}${o.caps & 0x200 ? '_PRIMARIA' : ''}${o.caps & 4 ? '_BACK' : ''}.png`);
    fs.writeFileSync(f, png(rgba, o.w, o.h));
    log(`[SURF] #${o.id} ${ptr.toString(16)} ${o.w}x${o.h}x${o.bpp} caps=${o.caps.toString(16)} no_negros=${nz} locks=${o.stats.locks} bltIn=${o.stats.bltIn} bltOut=${o.stats.bltOut} getdc=${o.stats.getdc} flips=${o.stats.flips} -> ${path.basename(f)}`);
  }
}
if (framePath && lastFrame) { fs.writeFileSync(framePath, png(lastFrame.rgba, lastFrame.w, lastFrame.h)); log(`[RESUMEN] último frame guardado en ${framePath}`); }
finish();
process.exit(res.status === 'halted' ? 3 : 0);

function countNonBlack(r) { let n = 0; for (let i = 0; i < r.length; i += 4) if (r[i] | r[i + 1] | r[i + 2]) n++; return n; }
function finish() { if (logPath) fs.writeFileSync(logPath, logLines.join('\n') + '\n'); }
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
