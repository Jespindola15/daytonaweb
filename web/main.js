// main.js — frontend: sólo el juego en pantalla; ajustes y salas en paneles laterales.
import { Emulator } from '../src/emulator.js';
import { initLobby } from './lobby.js';
import { initLocalMP } from './mplocal.js';
import { readAllCars, readCar, writeCarPose, aheadOf, CARS, FIELD } from '../src/game/daytona.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen'), ctx2d = canvas.getContext('2d');
const qs = new URLSearchParams(location.search);

// ---------- ajustes persistentes ----------
const DEFAULTS = { v: 2, telemetry: false, scale: 'fit', smooth: false, fps: false, budget: '14', clock: 'real', log: false, trace: false, volume: 70, mute: false };
let opts = { ...DEFAULTS };
try { opts = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('daytona.opts') || '{}') }; } catch {}
// v2: el reloj real pasa a ser el predeterminado (con el JIT, el virtual aceleraba el juego)
if (opts.v !== 2) { opts.clock = 'real'; opts.v = 2; }
const saveOpts = () => { try { localStorage.setItem('daytona.opts', JSON.stringify(opts)); } catch {} };

// ---------- registro (en memoria; visible sólo en Ajustes > Diagnóstico) ----------
const allLog = []; let logDirty = false;
function log(line) { allLog.push(line); if (allLog.length > 20000) allLog.splice(0, 5000); if (opts.log) logDirty = true; }
function renderLog() {
  if (!logDirty) return; logDirty = false;
  const el = $('log'); const frag = document.createDocumentFragment();
  for (const l of allLog.slice(-600)) { const d = document.createElement('div'); const m = /^\[(\w+)\]/.exec(l); if (m) d.className = m[1]; d.textContent = l; frag.appendChild(d); }
  el.replaceChildren(frag); el.scrollTop = el.scrollHeight;
}
function saveLog() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([allLog.join('\n')], { type: 'text/plain' }));
  a.download = `daytona-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`; a.click();
}
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms); }

// ---------- video ----------
let img = null;
const host = {
  deferPresent: true,
  present(rgba, w, h) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; img = null; layout(); }
    if (!img) img = new ImageData(w, h);
    img.data.set(rgba); ctx2d.putImageData(img, 0, 0);
  },
  setMode(w, h) { if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; img = null; layout(); } },
  setTitle() {},
  messageBox(c, t) { log(`[MSGBOX] ${c}: ${t}`); toast(`${c}: ${t}`, 5000); },
  audio: null,
};
function layout() {
  const W = innerWidth, H = innerHeight, w = canvas.width, h = canvas.height;
  let s = Math.min(W / w, H / h);
  if (opts.scale === 'int') s = Math.max(1, Math.floor(s));
  if (opts.scale === 'native') s = 1;
  canvas.style.width = `${Math.floor(w * s)}px`; canvas.style.height = `${Math.floor(h * s)}px`;
  canvas.classList.toggle('smooth', !!opts.smooth);
}
addEventListener('resize', layout);

// ---------- audio: DirectSound -> Web Audio ----------
function makeAudio() {
  const ac = new AudioContext();
  const voices = new Map();
  // volumen general (ajustes): todas las voces pasan por este nodo
  const master = ac.createGain(); master.connect(ac.destination);
  const toBuffer = (data, fmt) => {
    const ch = fmt.channels || 1, bps = (fmt.bits || 16) / 8, frames = Math.floor(data.length / (bps * ch));
    const buf = ac.createBuffer(ch, Math.max(1, frames), fmt.rate || 22050);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let c = 0; c < ch; c++) { const out = buf.getChannelData(c); for (let i = 0; i < frames; i++) { const o = (i * ch + c) * bps; out[i] = bps === 1 ? (dv.getUint8(o) - 128) / 128 : dv.getInt16(o, true) / 32768; } }
    return buf;
  };
  const dbToGain = (v) => Math.pow(10, (v | 0) / 2000);
  // v.rate = velocidad de reproducción (SetFrequency / frecuencia del formato). off y pos en segundos del búfer.
  const start = (v, off) => {
    const src = ac.createBufferSource(); src.buffer = v.buffer; src.loop = v.loop; src.playbackRate.value = v.rate; src.connect(v.gain);
    off = v.loop ? off % v.buffer.duration : off;
    if (!v.loop && off >= v.buffer.duration) { v.src = null; return; }
    src.start(0, off); v.src = src; v.t0 = ac.currentTime; v.off0 = off;
  };
  const posOf = (v) => v.off0 + (ac.currentTime - v.t0) * v.rate;
  return {
    ctx: ac, master, _voices: voices,
    setMaster(vol01) { master.gain.setTargetAtTime(vol01, ac.currentTime, 0.02); },
    play(id, data, fmt, loop, vol, pan, startPos, hz) {
      this.stop(id); const v = voices.get(id) || {};
      v.fmt = fmt; v.loop = loop; v.buffer = toBuffer(data, fmt);
      v.rate = hz && fmt.rate ? hz / fmt.rate : 1;   // el juego fija la frecuencia ANTES de Play
      if (!v.gain) { v.gain = ac.createGain(); v.pan = ac.createStereoPanner(); v.gain.connect(v.pan).connect(master); }
      v.gain.gain.value = dbToGain(vol); v.pan.pan.value = Math.max(-1, Math.min(1, (pan | 0) / 10000));
      voices.set(id, v); start(v, (startPos || 0) / ((fmt.rate || 22050) * (fmt.align || 2)));
    },
    update(id, data) { const v = voices.get(id); if (!v || !v.src) return; const pos = posOf(v); try { v.src.stop(); } catch {} v.buffer = toBuffer(data, v.fmt); start(v, pos); },
    stop(id) { const v = voices.get(id); if (v?.src) { try { v.src.stop(); } catch {} v.src = null; } },
    setVolume(id, vol) { const v = voices.get(id); if (v?.gain) v.gain.gain.value = dbToGain(vol); },
    setPan(id, p) { const v = voices.get(id); if (v?.pan) v.pan.pan.value = Math.max(-1, Math.min(1, p / 10000)); },
    setRate(id, hz) {
      let v = voices.get(id); if (!v) { v = {}; voices.set(id, v); }
      const r = v.fmt?.rate ? hz / v.fmt.rate : null;
      if (v.src && r) { v.off0 = posOf(v); v.t0 = ac.currentTime; v.rate = r; v.src.playbackRate.value = r; }
      else if (r) v.rate = r;
    },
  };
}
const applyVolume = () => { const g = opts.mute ? 0 : Math.pow((Number(opts.volume) || 0) / 100, 2); host.audio?.setMaster(g); const el = $('volVal'); if (el) el.textContent = opts.mute ? '(silenciado)' : `${opts.volume}%`; const b = $('btnMute'); if (b) { b.textContent = opts.mute || !Number(opts.volume) ? '🔇' : '🔊'; b.setAttribute('aria-pressed', String(!!opts.mute)); } };
function ensureAudio() { try { if (!host.audio) { host.audio = makeAudio(); applyVolume(); } if (host.audio.ctx.state === 'suspended') host.audio.ctx.resume(); } catch {} }

// ---------- teclado global (no hace falta hacer clic en el canvas) ----------
const VK = { ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Enter: 0x0d, NumpadEnter: 0x0d, Escape: 0x1b, Space: 0x20, ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11, AltLeft: 0x12, Tab: 0x09, Backspace: 0x08 };
function vkOf(e) {
  if (VK[e.code]) return VK[e.code];
  if (/^Key[A-Z]$/.test(e.code)) return e.code.charCodeAt(3);
  if (/^Digit\d$/.test(e.code)) return e.code.charCodeAt(5);
  if (/^F([1-9]|1[0-2])$/.test(e.code) && e.code !== 'F11' && e.code !== 'F12') return 0x6f + Number(e.code.slice(1));
  return 0;
}
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (e.code === 'KeyP' && !e.repeat) { togglePause(); e.preventDefault(); return; }
  if (e.code === 'KeyM' && !e.repeat) { toggleMute(); e.preventDefault(); return; }
  ensureAudio();
  const vk = vkOf(e); if (!vk || !emu?.keyEvent || !running) return;
  if (mpl.routeKey(e.code, vk, true)) { e.preventDefault(); return; }   // teclado compartido (multijugador local)
  if (!e.repeat) emu.keyEvent(vk, true);
  e.preventDefault();
});
addEventListener('keyup', (e) => { if (typing(e)) return; const vk = vkOf(e); if (vk && mpl.routeKey(e.code, vk, false)) { e.preventDefault(); return; } if (vk && emu?.keyEvent) { emu.keyEvent(vk, false); e.preventDefault(); } });
addEventListener('blur', () => { if (emu?.state?.user) for (let vk = 0; vk < 256; vk++) if (emu.state.user.keys[vk]) emu.keyEvent(vk, false); });

// ---------- barra flotante, paneles ----------
let idleT;
const wake = () => { document.body.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => { if (running && !openPanel()) document.body.classList.add('idle'); }, 2500); };
addEventListener('mousemove', wake); addEventListener('mousedown', wake); wake();
const openPanel = () => !$('settings').hidden || !$('rooms').hidden || !$('local').hidden;
function showPanel(id) { for (const p of ['settings', 'rooms', 'local']) $(p).hidden = p !== id || !$(p).hidden; $('btnSettings').setAttribute('aria-pressed', String(!$('settings').hidden)); $('btnRooms').setAttribute('aria-pressed', String(!$('rooms').hidden)); $('btnLocal').setAttribute('aria-pressed', String(!$('local').hidden)); if (!$('rooms').hidden) lobby.open(); else lobby.close(); }
$('btnSettings').onclick = () => showPanel('settings');
$('btnRooms').onclick = () => showPanel('rooms');
$('btnLocal').onclick = () => showPanel('local');
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => { $(b.dataset.close).hidden = true; showPanel(null); canvas.focus(); };
function toggleMute() { opts.mute = !opts.mute; $('optMute').checked = opts.mute; saveOpts(); ensureAudio(); applyVolume(); toast(opts.mute ? 'Sonido silenciado (M)' : `Sonido: ${opts.volume}%`); }
$('btnMute').onclick = toggleMute;
$('btnFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}));
$('btnPause').onclick = () => togglePause();
$('btnResume').onclick = () => togglePause(false);
$('btnSaveLog').onclick = saveLog; $('btnSaveLog2').onclick = saveLog;

// controles de ajustes
const bind = (id, key, fn) => { const el = $(id); if (el.type === 'checkbox') el.checked = !!opts[key]; else el.value = opts[key]; el.onchange = () => { opts[key] = el.type === 'checkbox' ? el.checked : el.value; saveOpts(); fn?.(); }; };
bind('optScale', 'scale', layout); bind('optSmooth', 'smooth', layout);
bind('optFps', 'fps', () => { $('fps').hidden = !opts.fps; });
bind('optTelemetry', 'telemetry', () => { $('telemetry').hidden = !opts.telemetry; });
bind('optVolume', 'volume', applyVolume); $('optVolume').oninput = () => { opts.volume = Number($('optVolume').value); applyVolume(); saveOpts(); };
bind('optMute', 'mute', applyVolume); applyVolume();
bind('optBudget', 'budget'); bind('optClock', 'clock', () => toast('El reloj nuevo se aplica al reiniciar el juego'));
bind('optLog', 'log', () => { $('log').hidden = !opts.log; logDirty = true; renderLog(); });
bind('optTrace', 'trace', () => { if (emu) emu.traceApis = opts.trace; });
$('fps').hidden = !opts.fps; $('telemetry').hidden = !opts.telemetry; $('log').hidden = !opts.log; layout();

// ---------- carga de archivos ----------
let files = new Map();
function setLoader(text, frac, error) {
  $('loader').hidden = false; $('loader').classList.toggle('error', !!error);
  $('loadText').textContent = text; $('loadBar').style.width = `${Math.round((frac || 0) * 100)}%`;
  $('loadActions').hidden = !error; $('status').textContent = text;
}
async function loadFromManifest(url) {
  const murl = new URL(url, location.href);
  setLoader('Buscando los archivos del juego…', 0);
  const mr = await fetch(murl);
  if (!mr.ok) throw new Error(`no se encontró ${murl.pathname} (HTTP ${mr.status})`);
  const man = await mr.json();
  let done = 0; const out = new Map();
  const queue = [...man.files];
  const worker = async () => {
    while (queue.length) {
      const rel = queue.shift();
      const r = await fetch(new URL(rel.split('/').map(encodeURIComponent).join('/'), murl));
      if (!r.ok) throw new Error(`falta ${rel} (HTTP ${r.status})`);
      out.set(rel.split('/').join('\\'), new Uint8Array(await r.arrayBuffer()));
      done++; setLoader(`Descargando el juego… ${done}/${man.files.length}`, done / man.files.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}
async function loadFromPicker(list) {
  const out = new Map(); let n = 0;
  for (const f of list) {
    const rel = (f.webkitRelativePath || f.name).split('/').slice(f.webkitRelativePath ? 1 : 0).join('\\');
    out.set(rel, new Uint8Array(await f.arrayBuffer()));
    setLoader(`Leyendo archivos… ${++n}/${list.length}`, n / list.length);
  }
  return out;
}
for (const id of ['dirPick', 'dirPick2']) $(id).onchange = async (e) => {
  if (!e.target.files.length) return;
  showPanel(null);
  try { files = await loadFromPicker(e.target.files); boot(); } catch (err) { fail(err.message); }
};

// ---------- emulación ----------
let emu = null, running = false, rafId = 0, haltShown = false;
let mipsAvg = 0, lastFrames = 0, fpsT = performance.now(), fps = 0;
function exeKey() { return [...files.keys()].find((k) => /(^|\\)daytona\.exe$/i.test(k)) || [...files.keys()].find((k) => /\.exe$/i.test(k) && !/config/i.test(k)); }
function fail(msg) { running = false; setLoader(msg, 0, true); log(`[FATAL] ${msg}`); }

function boot() {
  cancelAnimationFrame(rafId); running = false; haltShown = false;
  $('paused').hidden = true;
  const key = exeKey();
  if (!key) return fail('No encontré DAYTONA.EXE en los archivos cargados.');
  allLog.length = 0;
  emu = new Emulator({ log, host });
  emu.traceApis = !!opts.trace;
  emu.clockMode = opts.clock;
  let bytes = 0; for (const [rel, data] of files) { emu.vfs.add(rel, data); bytes += data.length; }
  log(`[VFS] ${files.size} archivos (${(bytes / 1048576).toFixed(1)} MiB)`);
  const dir = key.includes('\\') ? key.slice(0, key.lastIndexOf('\\')) : '';
  emu.vfs.cwd = dir.toUpperCase();
  try { emu.loadMain(emu.vfs.find(key).data, key.split('\\').pop().toUpperCase()); }
  catch (e) { return fail(`No se pudo cargar ${key}: ${e.message}`); }
  setLoader('Arrancando Daytona USA…', 1);
  running = true; fpsT = performance.now(); lastFrames = 0; lastLoopT = 0;
  window.__emu = () => emu;
  rafId = requestAnimationFrame(loop);
}
let lastLoopT = 0;
function loop() {
  if (!running) return;
  // si pasó mucho desde el cuadro anterior (pestaña oculta, pausa), el reloj del juego no avanza ese hueco
  const tNow = performance.now();
  if (lastLoopT && emu.clockMode === 'real' && tNow - lastLoopT > 250) emu.timeOffset -= tNow - lastLoopT - 16.7;
  // multijugador local: en la grilla el juego queda detenido (y su reloj también) hasta la largada común
  if (mpl.frame()) { if (lastLoopT && emu.clockMode === 'real') emu.timeOffset -= Math.min(tNow - lastLoopT, 250); lastLoopT = tNow; if (opts.telemetry) showTelemetry(); rafId = requestAnimationFrame(loop); return; }
  lastLoopT = tNow;
  const sliceMs = Number(opts.budget) || 14;
  const t = performance.now(), i0 = emu.cpu.icount;
  let res;
  res = { status: 'waiting' };
  // vblank: si el juego está esperando el próximo tick de 60 Hz, no se ejecuta hasta entonces
  while (performance.now() - t < sliceMs) {
    if (emu.clockMode === 'real' && emu.waitUntil > emu.nowMs()) {
      // espera de vblank: si entra en lo que queda del cuadro del navegador, se espera acá mismo
      const target = performance.now() + (emu.waitUntil - emu.nowMs());
      if (target - t > sliceMs) break;
      while (performance.now() < target) { /* espera activa corta (< 16 ms) */ }
    }
    res = emu.run(500_000);
    if (res.status === 'halted' || res.status === 'exited') break;
    if (mpl.state.phase === 'grid') break;
  }
  const ms = performance.now() - t;
  if (emu.state.dd.dirty) { emu.state.dd.dirty = false; emu.scanout(); if (!$('loader').hidden && emu.state.dd.frames > 2) { $('loader').hidden = true; $('status').textContent = 'running'; } }
  const mips = (emu.cpu.icount - i0) / Math.max(ms, 0.01) / 1000; mipsAvg = mipsAvg ? mipsAvg * 0.9 + mips * 0.1 : mips;
  const now = performance.now();
  if (opts.telemetry) showTelemetry();
  if (now - fpsT > 1000) { fps = (emu.state.dd.frames - lastFrames) * 1000 / (now - fpsT); lastFrames = emu.state.dd.frames; fpsT = now; if (opts.fps) $('fps').textContent = `${fps.toFixed(0)} fps · ${mipsAvg.toFixed(0)} MIPS`; $('perfInfo').textContent = `Ahora: ${fps.toFixed(1)} fps del juego, ${mipsAvg.toFixed(0)} millones de instrucciones x86/s (JIT).`; }
  window.__stats = { icount: emu.cpu.icount, frames: emu.state.dd.frames, mips: mipsAvg, fps };
  if (opts.log) renderLog();
  if (res.status === 'halted') { running = false; showHalt(res.report); return; }
  if (res.status === 'exited') { running = false; $('pauseTitle').textContent = 'El juego se cerró'; $('pauseText').textContent = `Código de salida ${res.code}.`; $('btnResume').textContent = 'Volver a iniciar'; $('btnResume').onclick = () => { $('btnResume').onclick = () => togglePause(false); $('btnResume').textContent = 'Seguir'; boot(); }; $('paused').hidden = false; return; }
  rafId = requestAnimationFrame(loop);
}
// Telemetría del auto del jugador (lectura directa de la memoria del juego)
function showTelemetry() {
  const el = $('telemetry'); el.hidden = false;
  try {
    const c = readCar(emu.mem, 0);
    el.textContent = `auto 0 · ${c.speedKmh} km/h (${c.speedMph} mph) · vuelta ${c.lap} · puesto ${c.position}/40 · seg ${c.segment}\nX ${c.x.toFixed(1)}  Y ${c.y.toFixed(1)}  Z ${c.z.toFixed(1)}  rumbo ${c.yaw.toFixed(1)}°`;
  } catch { el.textContent = 'telemetría no disponible'; }
}
// Acceso a los autos desde la consola del navegador (Fase 1 del multijugador)
window.daytona = {
  CARS, FIELD,
  cars: () => readAllCars(emu.mem),
  car: (i = 0) => readCar(emu.mem, i),
  move: (i, pose) => writeCarPose(emu.mem, i, pose),
  putAhead: (i, dist = 16) => { const p = readCar(emu.mem, 0); const a = aheadOf(p, dist); writeCarPose(emu.mem, i, { x: a.x, z: a.z, yaw: p.yaw }); },
};

function showHalt(report) {
  haltShown = true; $('loader').hidden = true;
  $('pauseTitle').textContent = 'El emulador se detuvo';
  $('pauseText').textContent = `${report.message}\n\nGuardá el registro y compartilo para poder corregirlo.`;
  $('btnSaveLog2').hidden = false; $('btnResume').textContent = 'Reiniciar';
  $('btnResume').onclick = () => { $('btnResume').onclick = () => togglePause(false); $('btnResume').textContent = 'Seguir'; $('btnSaveLog2').hidden = true; boot(); };
  $('paused').hidden = false; $('status').textContent = `DETENIDO: ${report.message}`;
}
function togglePause(force) {
  if (!emu || haltShown) return;
  const pause = force === undefined ? running : force;
  if (pause && running) { running = false; cancelAnimationFrame(rafId); $('pauseTitle').textContent = 'Pausa'; $('pauseText').textContent = 'Pulsá P o «Seguir» para continuar.'; $('paused').hidden = false; $('btnPause').textContent = '▶'; }
  else if (!pause && !running) { $('paused').hidden = true; running = true; $('btnPause').textContent = '❚❚'; canvas.focus(); rafId = requestAnimationFrame(loop); }
}
$('btnRestart').onclick = () => { showPanel(null); boot(); };

// ---------- salas online ----------
const lobby = initLobby({
  root: $('roomsBody'), toast,
  onStart: () => { showPanel(null); toast('¡Largada! Reiniciando el juego para todos…', 3500); boot(); },
});

// ---------- multijugador local (dos pestañas, BroadcastChannel) ----------
const mpl = initLocalMP({ root: $('localBody'), toast, log, getEmu: () => emu, reboot: () => { showPanel(null); boot(); } });

// ---------- inicio ----------
(async () => {
  canvas.focus();
  try {
    files = await loadFromManifest(qs.get('manifest') || '../game/manifest.json');
    boot();
  } catch (e) {
    fail(`No se pudieron descargar los archivos del juego: ${e.message}.\nPodés cargarlos desde tu equipo.`);
  }
})();
