// main.js — frontend de Chrome: VFS desde carpeta local, canvas (DirectDraw), Web Audio (DirectSound)
import { Emulator } from '../src/emulator.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log'), statusEl = $('status');
const canvas = $('screen'), ctx2d = canvas.getContext('2d');
let files = new Map();   // ruta relativa -> File
let emu = null, running = false, rafId = 0, allLog = [];

// ---------- log ----------
let pending = [];
function log(line) {
  allLog.push(line);
  pending.push(line);
  if (pending.length === 1) queueMicrotask(flushLog);
}
function flushLog() {
  const frag = document.createDocumentFragment();
  for (const l of pending) {
    const span = document.createElement('div');
    const m = /^\[(\w+)\]/.exec(l); if (m) span.className = m[1];
    span.textContent = l; frag.appendChild(span);
  }
  pending = [];
  logEl.appendChild(frag);
  while (logEl.childNodes.length > 4000) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}
$('save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([allLog.join('\n')], { type: 'text/plain' }));
  a.download = `daytona-web-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`; a.click();
};

// ---------- selección de archivos ----------
function onFiles(list) {
  files = new Map();
  for (const f of list) {
    const rel = (f.webkitRelativePath || f.name).split('/').slice(f.webkitRelativePath ? 1 : 0).join('\\');
    files.set(rel, f);
  }
  const exes = [...files.keys()].filter((k) => /\.exe$/i.test(k));
  const sel = $('exe'); sel.innerHTML = '';
  exes.sort((a, b) => (/daytona\.exe$/i.test(b) ? 1 : 0) - (/daytona\.exe$/i.test(a) ? 1 : 0));
  for (const e of exes) { const o = document.createElement('option'); o.value = o.textContent = e; sel.appendChild(o); }
  const total = [...files.values()].reduce((a, f) => a + f.size, 0);
  statusEl.textContent = `${files.size} archivos (${(total / 1048576).toFixed(1)} MiB), ${exes.length} EXE`;
  $('start').disabled = !exes.length;
}
$('dir').onchange = (e) => onFiles(e.target.files);
$('files').onchange = (e) => onFiles(e.target.files);

// ---------- host: video ----------
let img = null;
const host = {
  deferPresent: true, // el canvas se actualiza una vez por frame del navegador (barrido de la primaria)
  present(rgba, w, h) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; img = null; }
    if (!img) img = new ImageData(w, h);
    img.data.set(rgba); ctx2d.putImageData(img, 0, 0);
    host.frames = (host.frames || 0) + 1;
  },
  setMode(w, h) { canvas.width = w; canvas.height = h; img = null; },
  setTitle(t) { document.title = `${t} — Daytona web`; },
  messageBox(c, t) { log(`[MSGBOX] ${c}: ${t}`); },
  audio: null,
};

// ---------- host: audio (DirectSound -> Web Audio) ----------
function makeAudio() {
  const ac = new AudioContext();
  const voices = new Map();
  const toBuffer = (data, fmt) => {
    const ch = fmt.channels || 1, bps = (fmt.bits || 16) / 8, frames = Math.floor(data.length / (bps * ch));
    const buf = ac.createBuffer(ch, Math.max(1, frames), fmt.rate || 22050);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let c = 0; c < ch; c++) {
      const out = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) {
        const o = (i * ch + c) * bps;
        out[i] = bps === 1 ? (dv.getUint8(o) - 128) / 128 : dv.getInt16(o, true) / 32768;
      }
    }
    return buf;
  };
  const dbToGain = (v) => Math.pow(10, (v | 0) / 2000);
  const start = (id, v, offsetSec) => {
    const src = ac.createBufferSource(); src.buffer = v.buffer; src.loop = v.loop;
    src.connect(v.gain); src.start(0, offsetSec % v.buffer.duration);
    v.src = src; v.t0 = ac.currentTime - offsetSec;
  };
  return {
    ctx: ac,
    play(id, data, fmt, loop, vol, pan, startPos) {
      this.stop(id);
      const v = voices.get(id) || {};
      v.fmt = fmt; v.loop = loop; v.buffer = toBuffer(data, fmt);
      if (!v.gain) { v.gain = ac.createGain(); v.pan = ac.createStereoPanner(); v.gain.connect(v.pan).connect(ac.destination); }
      v.gain.gain.value = dbToGain(vol); v.pan.pan.value = Math.max(-1, Math.min(1, (pan | 0) / 10000));
      voices.set(id, v);
      start(id, v, (startPos || 0) / ((fmt.rate || 22050) * (fmt.align || 2)));
    },
    // buffers de streaming: se reconstruye y se reanuda en la misma posición (aproximación; ver README)
    update(id, data) {
      const v = voices.get(id); if (!v || !v.src) return;
      const pos = ac.currentTime - v.t0; try { v.src.stop(); } catch {}
      v.buffer = toBuffer(data, v.fmt); start(id, v, pos);
    },
    stop(id) { const v = voices.get(id); if (v?.src) { try { v.src.stop(); } catch {} v.src = null; } },
    setVolume(id, vol) { const v = voices.get(id); if (v?.gain) v.gain.gain.value = dbToGain(vol); },
    setPan(id, p) { const v = voices.get(id); if (v?.pan) v.pan.pan.value = Math.max(-1, Math.min(1, p / 10000)); },
    setRate(id, hz) { const v = voices.get(id); if (v?.src && v.fmt.rate) v.src.playbackRate.value = hz / v.fmt.rate; },
  };
}

// ---------- teclado -> VK ----------
const VK = { ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Enter: 0x0d, Escape: 0x1b, Space: 0x20, ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11, AltLeft: 0x12, Tab: 0x09, Backspace: 0x08 };
function vkOf(e) {
  if (VK[e.code]) return VK[e.code];
  if (/^Key[A-Z]$/.test(e.code)) return e.code.charCodeAt(3);
  if (/^Digit\d$/.test(e.code)) return e.code.charCodeAt(5);
  if (/^F\d+$/.test(e.code)) return 0x6f + Number(e.code.slice(1));
  return 0;
}
canvas.addEventListener('keydown', (e) => { const vk = vkOf(e); if (vk && emu?.keyEvent) { emu.keyEvent(vk, true); e.preventDefault(); } });
canvas.addEventListener('keyup', (e) => { const vk = vkOf(e); if (vk && emu?.keyEvent) { emu.keyEvent(vk, false); e.preventDefault(); } });

// ---------- ejecución ----------
async function boot() {
  logEl.textContent = ''; allLog = [];
  const exeName = $('exe').value;
  if (!host.audio) { try { host.audio = makeAudio(); } catch (e) { log(`[AUDIO] Web Audio no disponible: ${e.message}`); } }
  emu = new Emulator({ log, host });
  emu.traceApis = $('trace').checked;
  emu.clockMode = $('clock').value;
  const t0 = performance.now();
  let bytes = 0;
  for (const [rel, f] of files) { const d = new Uint8Array(await f.arrayBuffer()); emu.vfs.add(rel, d); bytes += d.length; }
  log(`[VFS] ${files.size} archivos (${(bytes / 1048576).toFixed(1)} MiB) cargados en memoria en ${(performance.now() - t0).toFixed(0)} ms`);
  const exeDir = exeName.includes('\\') ? exeName.slice(0, exeName.lastIndexOf('\\')) : '';
  emu.vfs.cwd = exeDir.toUpperCase();
  try { emu.loadMain(emu.vfs.find(exeName).data, exeName.split('\\').pop().toUpperCase()); }
  catch (e) { log(`[FATAL] ${e.message}`); setStatus('halted', e.message); return; }
  $('pause').disabled = false; $('step').disabled = false;
  running = true; loop();
}
function setStatus(cls, text) { statusEl.className = cls; statusEl.textContent = text; }
let mipsAvg = 0, lastFrames = 0, fpsT = performance.now(), fps = 0;
function loop() {
  if (!running) return;
  const sliceMs = Number($('budget').value);
  const t = performance.now(), i0 = emu.cpu.icount;
  let res;
  // ejecuta en trozos de 500k instrucciones hasta gastar el presupuesto de tiempo del frame del navegador
  do { res = emu.run(500_000); } while (res.status !== 'halted' && res.status !== 'exited' && performance.now() - t < sliceMs);
  const ms = performance.now() - t;
  if (emu.state.dd.dirty) { emu.state.dd.dirty = false; emu.scanout(); }
  const mips = (emu.cpu.icount - i0) / ms / 1000; mipsAvg = mipsAvg ? mipsAvg * 0.9 + mips * 0.1 : mips;
  if (performance.now() - fpsT > 1000) { fps = (emu.state.dd.frames - lastFrames) * 1000 / (performance.now() - fpsT); lastFrames = emu.state.dd.frames; fpsT = performance.now(); }
  window.__stats = { icount: emu.cpu.icount, frames: emu.state.dd.frames, mips: mipsAvg, fps };
  $('stats').textContent = `instr: ${emu.cpu.icount.toLocaleString()} | ${mipsAvg.toFixed(1)} MIPS | frames del juego: ${emu.state.dd.frames} (${fps.toFixed(1)} fps) | reloj del juego: ${(emu.nowMs() / 1000).toFixed(1)} s | EIP ${emu.cpu.eip.toString(16)}`;
  if (res.status === 'halted') { running = false; setStatus('halted', `DETENIDO: ${res.report.message}`); flushLog(); return; }
  if (res.status === 'exited') { running = false; setStatus('exited', `Terminó con código ${res.code}`); return; }
  setStatus('', `Ejecutando… ${res.status}`);
  rafId = requestAnimationFrame(loop);
}
$('start').onclick = () => { cancelAnimationFrame(rafId); running = false; boot(); canvas.focus(); };
$('pause').onclick = () => { running = !running; $('pause').textContent = running ? '⏸ Pausa' : '▶ Seguir'; if (running) loop(); };
$('step').onclick = () => { running = false; $('pause').textContent = '▶ Seguir'; const r = emu.run(1000); log(`[STEP] ${r.status} ${emu.cpu.dumpRegs()}`); };
$('trace').onchange = (e) => { if (emu) emu.traceApis = e.target.checked; };

const qs = new URLSearchParams(location.search);
// Modo pruebas/local: ?manifest=URL de un JSON {"files":["DAYTONA.EXE","RES_USA.DLL",...]} relativo al JSON
if (qs.get('manifest') || !qs.get('manual')) {
  const murl = new URL(qs.get('manifest') || '../game/manifest.json', location.href);
  statusEl.textContent = 'Descargando archivos del juego…'; const mr = await fetch(murl); if (!mr.ok) throw new Error('No se pudo obtener el manifiesto'); const man = await mr.json();
  const list = await Promise.all(man.files.map(async (rel) => { const r = await fetch(new URL(rel, murl)); if (!r.ok) throw new Error('Falta archivo: ' + rel + ' (' + r.status + ')'); return Object.assign(new File([await r.blob()], rel.split('/').pop()), { relPath: rel }); }));
  files = new Map(list.map((f) => [f.relPath.split('/').join('\\'), f]));
  const sel = $('exe'); sel.innerHTML = '';
  for (const k of [...files.keys()].sort((a, b) => /daytona\.exe$/i.test(b) - /daytona\.exe$/i.test(a))) if (/\.exe$/i.test(k)) { const o = document.createElement('option'); o.value = o.textContent = k; sel.appendChild(o); }
  $('start').disabled = false; statusEl.textContent = `${files.size} archivos cargados desde ${murl.pathname}`;
  if (qs.get('autostart') || !qs.get('manual')) $('start').click();
}
// Modo pruebas: ?load=ruta/A.EXE,ruta/DATA/B.BIN&base=ruta/&autostart=1 (archivos servidos por el mismo servidor local)
if (qs.get('load')) {
  const base = qs.get('base') || '';
  const list = await Promise.all(qs.get('load').split(',').map(async (p) => {
    const r = await fetch('../' + p); const b = await r.blob();
    const rel = p.startsWith(base) ? p.slice(base.length) : p.split('/').pop();
    return Object.assign(new File([b], rel.split('/').pop()), { relPath: rel });
  }));
  files = new Map(list.map((f) => [f.relPath.split('/').join('\\'), f]));
  const sel = $('exe'); sel.innerHTML = '';
  for (const k of files.keys()) if (/\.exe$/i.test(k)) { const o = document.createElement('option'); o.value = o.textContent = k; sel.appendChild(o); }
  $('start').disabled = false; statusEl.textContent = `${files.size} archivos cargados por URL`;
  if (qs.get('autostart')) $('start').click();
}
window.__emu = () => emu;
