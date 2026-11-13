// node tests/mp_local_test.mjs <carpeta_del_juego> [salida]
// Fase 2: dos instancias INDEPENDIENTES de DAYTONA.EXE (dos emuladores), cada una con su jugador, conectadas
// por un canal en memoria con latencia, desorden y pérdida. Usa la misma lógica (CarSync) que el navegador.
// Los "jugadores" son pilotos de prueba que sólo aprietan teclas; la física es la del juego.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createSession } from '../tools/race-session.mjs';
import { png } from '../tools/png.mjs';
import { readCar } from '../src/game/daytona.js';
import { Autopilot } from '../src/game/autopilot.js';
import { CarSync, PUPPET_SLOT, swapStartWithPuppet } from '../src/net/multiplayer.js';

const GAME = process.argv[2] || 'game', OUT = process.argv[3] || 'tests/logs/fase2';
fs.mkdirSync(OUT, { recursive: true });
const log = (s) => { console.log(s); logLines.push(s); }; const logLines = [];
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : bad++; log(`${cond ? 'OK ' : 'ERR'} ${name}${extra ? '  ' + extra : ''}`); };

// ---- transporte simulado: 40 ms ± 25 ms, 5 % de pérdida (los desordenados aparecen solos por el jitter) ----
let clock = 0; const queue = []; let rng = 12345; const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
let lost = 0, sentTotal = 0;
const link = (dest) => ({ send(msg) { sentTotal++; if (rand() < 0.05) { lost++; return; } queue.push({ at: clock + 40 + (rand() - 0.5) * 120, dest, msg: JSON.parse(JSON.stringify(msg)) }); } });
function deliver() { for (let i = 0; i < queue.length; i++) if (queue[i].at <= clock) { queue[i].dest.onMessage(queue[i].msg); queue.splice(i--, 1); } }

// ---- dos instancias ----
log('Arrancando dos instancias independientes de DAYTONA.EXE…');
const P = [createSession(GAME), createSession(GAME)];
for (const S of P) { S.untilMs(22500); S.key(0x58, true); }
for (const S of P) S.untilMs(30000);
clock = 30000;
swapStartWithPuppet(P[1].emu.mem); // J2 larga desde el lugar del auto 38
const sync = [], ap = [];
for (let i = 0; i < 2; i++) {
  P[i].key(0x58, false);
  ap[i] = new Autopilot(P[i].emu, { skipSlots: [PUPPET_SLOT] });
  sync[i] = new CarSync({ emu: P[i].emu, transport: null, playerId: `jugador-${i + 1}-test`, slotRole: i + 1, now: () => P[i].gameMs(), log });
}
sync[0].transport = link(sync[1]); sync[1].transport = link(sync[0]);
// lo que ve cada jugador cuadro a cuadro: pose de la marioneta en cada cuadro presentado por SU juego
const seen = [[], []]; let recordFrames = true;
for (let i = 0; i < 2; i++) { const prev = P[i].emu.onPresent; P[i].emu.onPresent = () => { prev?.(); if (!recordFrames) return; const c = readCar(P[i].emu.mem, PUPPET_SLOT), o = readCar(P[1 - i].emu.mem, 0); seen[i].push({ t: P[i].gameMs(), x: c.x, z: c.z, otherKmh: o.speedKmh }); }; }

const shots = {}; const trace = [];
let puppetErr = [0, 0];
const steerYaw = [[], []];
function step(t) {
  clock = t;
  for (let i = 0; i < 2; i++) { P[i].untilMs(t); ap[i].step(); sync[i].tick(); }
  deliver();
  // error entre la marioneta y el auto real del otro, 100 ms antes (retardo de interpolación)
  const r = [readCar(P[0].emu.mem, 0), readCar(P[1].emu.mem, 0)];
  const pup = [readCar(P[0].emu.mem, PUPPET_SLOT), readCar(P[1].emu.mem, PUPPET_SLOT)];
  const dbg = sync.map((s) => { const b = s.track.buf; return b.length ? `last t=${b[b.length - 1].t} seq=${b[b.length - 1].seq} n=${b.length} arr=${s.track.lastArrival}` : ''; });
  trace.push({ t, dbg, r, pup, ap: [ap[0].keys, ap[1].keys].map((k) => ({ ...k })), status: sync.map((s) => s.status) });
}
const rel = (viewer, other) => { // posición del otro respecto de la cámara del que mira
  const h = viewer.yaw * Math.PI / 180, fx = -Math.sin(h), fz = Math.cos(h);
  const dx = other.x - viewer.x, dz = other.z - viewer.z;
  return { ahead: dx * fx + dz * fz, side: dx * fz - dz * fx };
};
function tryShot(name, viewerIdx) {
  const tr = trace[trace.length - 1];
  const v = tr.r[viewerIdx], o = tr.pup[viewerIdx];
  const q = rel(v, o);
  if (q.ahead > 7 && q.ahead < 30 && Math.abs(q.side) < q.ahead * 0.4 && (!shots[name] || Math.abs(q.ahead - 11) < Math.abs(shots[name].q.ahead - 11))) {
    const s = P[viewerIdx].screen(); shots[name] = { s, q, t: tr.t, me: v, other: tr.r[1 - viewerIdx], pup: o };
  }
}
const phase = (from, to, cfg, shot) => { for (let t = from; t < to; t += 50) { cfg(t); step(t); if (shot) tryShot(...shot); } };

// Fase A: los dos corren a 230 km/h
phase(30000, 40000, () => { ap[0].maxKmh = 230; ap[1].maxKmh = 230; });
// Persecución: `chaser` regula la velocidad (de ambos) según dónde VE al otro en su propio juego,
// hasta tenerlo entre 4 y 9 segmentos adelante (≈15-40 unidades), y lo sigue.
const prog = (c) => c.lap * 481 + c.segment;
function chase(chaser, leader, from, to, shot) {
  let t = from;
  for (; t < to && !(shots[shot] && t > shots[shot].t + 3000); t += 50) {
    const me = readCar(P[chaser].emu.mem, 0), seen = readCar(P[chaser].emu.mem, PUPPET_SLOT);
    let d = prog(seen) - prog(me); d = ((d % 481) + 481 + 240) % 481 - 240; // distancia en segmentos dentro de la vuelta
    // el «líder» está detrás (o demasiado cerca): el perseguidor afloja y lo deja pasar (antes, con el puesto mal
    // calculado, el J2 siempre largaba atrás; ahora larga desde su lugar real de la grilla, adelante)
    if (d < 4) { ap[leader].maxKmh = 300; ap[chaser].maxKmh = 140; ap[chaser].mode = d > -6 ? 'brake' : 'drive'; }
    else if (d > 9) { ap[chaser].mode = 'drive'; ap[chaser].maxKmh = 290; ap[leader].maxKmh = 190; }
    else { ap[chaser].mode = 'drive'; ap[chaser].maxKmh = Math.max(120, seen.speedKmh); ap[leader].maxKmh = 220; }
    step(t); tryShot(shot, chaser);
  }
  ap[0].mode = ap[1].mode = 'drive';
  return t;
}
// Fase C: J2 persigue a J1 -> J1 debe verse en la pantalla de J2
let t1 = chase(1, 0, 40000, 90000, 'j1_en_pantalla_de_j2');
// Fase D: J1 persigue a J2 -> J2 debe verse en la pantalla de J1
let t2 = chase(0, 1, t1, t1 + 50000, 'j2_en_pantalla_de_j1');
t2 = Math.ceil(t2 / 50) * 50;
// Fase E: los dos normales para completar vueltas; a mitad, J2 frena 2 s (verificación de freno en plena carrera)
phase(t2, t2 + 12000, () => { ap[0].maxKmh = 230; ap[1].maxKmh = 230; });
ap[1].maxKmh = 400; phase(t2 + 12000, t2 + 14000, () => {});
const speedBeforeBrake = readCar(P[1].emu.mem, 0).speedKmh;
phase(t2 + 14000, t2 + 16000, () => { ap[1].mode = 'brake'; });
const speedAfterBrake = readCar(P[1].emu.mem, 0).speedKmh;
ap[1].mode = 'drive';
phase(t2 + 16000, t2 + 32000, () => { ap[0].maxKmh = 230; ap[1].maxKmh = 230; });
const tEnd = t2 + 32000;
const lapsEnd = [readCar(P[0].emu.mem, 0).lap, readCar(P[1].emu.mem, 0).lap];
const remoteLapSeen = [readCar(P[0].emu.mem, PUPPET_SLOT).lap, readCar(P[1].emu.mem, PUPPET_SLOT).lap];
recordFrames = false;
// Fase E: J2 se desconecta (deja de enviar y de ejecutarse); J1 sigue
const framesJ1 = P[0].emu.state.dd.frames;
for (let t = tEnd; t < tEnd + 8000; t += 50) { clock = t; P[0].untilMs(t); ap[0].step(); sync[0].tick(); deliver(); }
const framesJ1after = P[0].emu.state.dd.frames;

// ---------------- verificaciones ----------------
const last = trace[trace.length - 1];
check('1. dos instancias independientes (estados distintos de cada juego)', Math.hypot(last.r[0].x - last.r[1].x, last.r[0].z - last.r[1].z) > 1 && readCar(P[0].emu.mem, 5).x !== readCar(P[1].emu.mem, 5).x);
check('2a. J2 frena (velocidad baja con Z)', speedAfterBrake < speedBeforeBrake - 40, `(${speedBeforeBrake} -> ${speedAfterBrake} km/h)`);
const yawSpan = (i) => { let mn = 1e9, mx = -1e9; for (const tr of trace) if (tr.ap[i].LEFT || tr.ap[i].RIGHT) { mn = Math.min(mn, tr.r[i].yaw); mx = Math.max(mx, tr.r[i].yaw); } return mx - mn; };
const steerCount = (i) => trace.filter((tr) => tr.ap[i].LEFT || tr.ap[i].RIGHT).length;
check('2b. ambos giran (teclas ←/→ y cambio de rumbo)', steerCount(0) > 50 && steerCount(1) > 50 && yawSpan(0) > 90 && yawSpan(1) > 90, `(J1 ${steerCount(0)} pasos girando, J2 ${steerCount(1)})`);
const maxSp = (i) => Math.max(...trace.map((tr) => tr.r[i].speedKmh));
check('2c. ambos aceleran (X)', maxSp(0) > 200 && maxSp(1) > 200, `(máx J1 ${maxSp(0)} km/h, J2 ${maxSp(1)} km/h)`);
// precisión de la marioneta: comparar con la pose real del otro ~100-150 ms antes
let errs = [[], []];
for (let k = 4; k < trace.length; k++) for (let i = 0; i < 2; i++) {
  const pup = trace[k].pup[i]; let best = 1e9;
  for (let j = Math.max(0, k - 6); j <= k; j++) best = Math.min(best, Math.hypot(pup.x - trace[j].r[1 - i].x, pup.z - trace[j].r[1 - i].z));
  errs[i].push(best);
}
const p95 = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
// umbral: menos de lo que avanza un auto en un cuadro del juego a ~280 km/h (≈ 5 unidades)
check('3/4. la marioneta sigue al auto real del otro (interpolado)', p95(errs[0]) < 5 && p95(errs[1]) < 5, `(error p95 ${p95(errs[0]).toFixed(2)} / ${p95(errs[1]).toFixed(2)} unidades ≈ m; ${lost} paquetes perdidos de ${sentTotal}, ${sync[0].track.dropped + sync[1].track.dropped} desordenados descartados, ${(sync[0].track.reordered||0) + (sync[1].track.reordered||0)} reinsertados en orden)`);
// suavidad: saltos por paso de 50 ms de la marioneta vs del auto real
const jumps = (i) => { let m = 0; for (let k = 8; k < trace.length; k++) { const a = trace[k - 1].pup[i], b = trace[k].pup[i]; let realMax = 0; for (let j = k - 7; j <= k; j++) { const ra = trace[j - 1].r[1 - i], rb = trace[j].r[1 - i]; realMax = Math.max(realMax, Math.hypot(rb.x - ra.x, rb.z - ra.z)); } m = Math.max(m, Math.hypot(b.x - a.x, b.z - a.z) - realMax); } return m; };
{ // detalle del peor salto
  let w = { e: -1 };
  for (let k = 8; k < trace.length; k++) for (let i = 0; i < 2; i++) { const a = trace[k - 1].pup[i], b = trace[k].pup[i]; let realMax = 0; for (let j = k - 7; j <= k; j++) { const ra = trace[j - 1].r[1 - i], rb = trace[j].r[1 - i]; realMax = Math.max(realMax, Math.hypot(rb.x - ra.x, rb.z - ra.z)); } const e = Math.hypot(b.x - a.x, b.z - a.z) - realMax; if (e > w.e) w = { e, k, i, step: Math.hypot(b.x - a.x, b.z - a.z), realMax }; }
  if (process.env.MP_DEBUG) for (let k = w.k - 12; k <= w.k + 4; k++) { const t2 = trace[k]; console.log(t2.t, 'real', t2.r[1 - w.i].x.toFixed(2), t2.r[1 - w.i].z.toFixed(2), t2.r[1-w.i].speedKmh, 'pup', t2.pup[w.i].x.toFixed(2), t2.pup[w.i].z.toFixed(2), t2.dbg?.[w.i]); }
  const tr = trace[w.k]; log(`    peor salto: t=${tr.t} ${w.i === 0 ? 'J2 visto por J1' : 'J1 visto por J2'} paso ${w.step.toFixed(1)} vs real máx ${w.realMax.toFixed(1)}; real ${JSON.stringify(pick(tr.r[1 - w.i]))} marioneta ${JSON.stringify(pick(tr.pup[w.i]))} anterior ${JSON.stringify(pick(trace[w.k - 1].pup[w.i]))}`);
}
// 5a. teletransportes, medidos como los ve el jugador: entre dos cuadros presentados por su juego, la marioneta no
// puede avanzar más de lo que permite la velocidad real del otro (km/h → unidades: 1 unidad ≈ 0,84 m) con 25 % de margen + 1,5 unidades.
const frameJumps = (i) => { let worst = { e: -1e9 }, n = 0, over = 0;
  for (let k = 1; k < seen[i].length; k++) { const a = seen[i][k - 1], b = seen[i][k], dt = (b.t - a.t) / 1000; if (dt <= 0) continue; n++;
    const d = Math.hypot(b.x - a.x, b.z - a.z), allow = Math.max(a.otherKmh, b.otherKmh) / 3.6 / 0.84 * dt * 1.25 + 1.5, e = d - allow;
    if (e > 0) over++; if (e > worst.e) worst = { e, d, allow, dt, t: b.t }; }
  return { n, over, worst }; };
const fj = [frameJumps(0), frameJumps(1)];
for (let i = 0; i < 2; i++) log(`    ${i === 0 ? 'J1 viendo a J2' : 'J2 viendo a J1'}: ${fj[i].n} cuadros, ${fj[i].over} con avance mayor al posible; peor: ${fj[i].worst.d.toFixed(1)} unidades en ${(fj[i].worst.dt * 1000).toFixed(0)} ms (máx. permitido ${fj[i].worst.allow.toFixed(1)}) a t=${(fj[i].worst.t / 1000).toFixed(2)} s`);
log(`    (métrica anterior por pasos fijos de 50 ms, afectada por el desfase entre los cuadros de cada juego: exceso ${jumps(0).toFixed(1)} / ${jumps(1).toFixed(1)})`);
// teletransporte visible = avanzar en un cuadro más de 3 unidades (≈ 2,5 m, media carrocería) por encima de lo posible
const tele = (i) => { let n = 0; for (let k = 1; k < seen[i].length; k++) { const a = seen[i][k - 1], b = seen[i][k], dt = (b.t - a.t) / 1000; if (dt <= 0) continue; const d = Math.hypot(b.x - a.x, b.z - a.z); if (d - (Math.max(a.otherKmh, b.otherKmh) / 3.6 / 0.84 * dt * 1.25 + 1.5) > 3) n++; } return n; };
check('5a. sin teletransportes visibles en los cuadros que ve cada jugador', tele(0) === 0 && tele(1) === 0, `(${tele(0) + tele(1)} cuadros con salto > 3 unidades de ${fj[0].n + fj[1].n}; con criterio estricto ${fj[0].over + fj[1].over}, peor exceso ${Math.max(fj[0].worst.e, fj[1].worst.e).toFixed(2)} unidades)`);
check('3. J1 aparece delante en la pantalla de J2', !!shots.j1_en_pantalla_de_j2, shots.j1_en_pantalla_de_j2 ? `(t=${(shots.j1_en_pantalla_de_j2.t / 1000).toFixed(1)}s, ${shots.j1_en_pantalla_de_j2.q.ahead.toFixed(0)} unidades adelante)` : '');
check('4. J2 aparece delante en la pantalla de J1', !!shots.j2_en_pantalla_de_j1, shots.j2_en_pantalla_de_j1 ? `(t=${(shots.j2_en_pantalla_de_j1.t / 1000).toFixed(1)}s, ${shots.j2_en_pantalla_de_j1.q.ahead.toFixed(0)} unidades adelante)` : '');
check('5b. ambos completan vueltas', lapsEnd[0] >= 2 && lapsEnd[1] >= 2, `(J1 vuelta ${lapsEnd[0]}, J2 vuelta ${lapsEnd[1]})`);
check('5c. cada instancia ve la vuelta correcta del otro', remoteLapSeen[0] === lapsEnd[1] && remoteLapSeen[1] === lapsEnd[0], `(J1 ve a J2 en vuelta ${remoteLapSeen[0]}, J2 ve a J1 en vuelta ${remoteLapSeen[1]})`);
check('6. J2 se desconecta y J1 sigue corriendo', framesJ1after - framesJ1 > 60 && sync[0].status === 'desconectado', `(J1 presentó ${framesJ1after - framesJ1} cuadros más; estado "${sync[0].status}")`);
check('6b. al desconectarse, el auto del otro vuelve a la IA', !sync[0].applied);

// ---------------- capturas ----------------
for (const [k, v] of Object.entries(shots)) png(v.s, path.join(OUT, `${k}.png`));
fs.writeFileSync(path.join(OUT, 'traza.json'), JSON.stringify(trace.filter((_, i) => i % 4 === 0).map((tr) => ({ t: tr.t, j1: pick(tr.r[0]), j2: pick(tr.r[1]), j2_en_j1: pick(tr.pup[0]), j1_en_j2: pick(tr.pup[1]), estado: tr.status }))));
function pick(c) { return { x: +c.x.toFixed(2), z: +c.z.toFixed(2), yaw: +c.yaw.toFixed(1), kmh: c.speedKmh, lap: c.lap, pos: c.position }; }
log(`RESULTADO ${ok}/${ok + bad}`);
fs.writeFileSync(path.join(OUT, 'resultado.txt'), logLines.join('\n') + '\n');
process.exit(bad ? 1 : 0);
