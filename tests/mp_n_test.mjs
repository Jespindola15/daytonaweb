// Prueba de N jugadores (2..6) con N instancias reales de DAYTONA.EXE en Node (reloj virtual) y una red simulada
// (latencia 40 ± 60 ms, 5 % de pérdida, relojes de cada "computadora" desfasados entre sí).
// Uso: node tests/mp_n_test.mjs <carpeta_del_juego> [N=3] [salida]
import fs from 'node:fs';
import path from 'node:path';
import { createSession } from '../tools/race-session.mjs';
import { Autopilot } from '../src/game/autopilot.js';
// SIN_AVANCE=1: experimento de control sin sincronizar los campos de avance (reproduce el error de puesto anterior)
const D = await import('../src/game/daytona.js');
const PROG_OFF = D.FIELD.progress[3];
if (process.env.SIN_AVANCE) D.FIELD.progress.length = 0;
const { readCar, carAddr, FIELD } = D;
const { CarSync, slotFor, swapStartForPlayer, GRID_SLOTS } = await import('../src/net/multiplayer.js');
import { png } from '../tools/png.mjs';

const GAME = process.argv[2] || 'game', N = Number(process.argv[3] || 3), OUT = process.argv[4] || 'tests/logs/fase3';
fs.mkdirSync(OUT, { recursive: true });
const lines = []; const log = (s) => { console.log(s); lines.push(s); };
let ok = 0, bad = 0; const check = (name, cond, extra = '') => { cond ? ok++ : bad++; log(`${cond ? 'OK ' : 'ERR'} ${name}${extra ? '  ' + extra : ''}`); };

// red simulada
let clock = 0; const queue = []; let rng = 777; const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
let lost = 0, sent = 0;
const skew = Array.from({ length: N }, (_, i) => [0, 3700, -2100, 950, -4400, 1800][i]);   // ms de desfase de cada reloj
const net = (from) => ({ send(msg) { for (let j = 0; j < N; j++) if (j !== from) { sent++; if (rand() < 0.05) { lost++; continue; } queue.push({ at: clock + 40 + (rand() - 0.5) * 120, to: j, msg: JSON.parse(JSON.stringify(msg)) }); } } });
const deliver = () => { for (let k = 0; k < queue.length; k++) if (queue[k].at <= clock) { sync[queue[k].to].onMessage(queue[k].msg); queue.splice(k--, 1); } };

log(`Arrancando ${N} instancias de DAYTONA.EXE…`);
const P = Array.from({ length: N }, () => createSession(GAME));
// hasta el primer tick de la carrera (misma barrera que usa el navegador: 0x447C40 después del menú)
for (const S of P) { let hit = false; S.emu.addHook(0x447c40, () => { if (S.gameMs() > 25000) hit = true; return true; }); while (!hit) S.untilMs(S.gameMs() + 20); S.emu.removeHook(0x447c40); }
// grilla: cada uno toma su lugar
const gridBefore = readCar(P[0].emu.mem, 0);
const spots = GRID_SLOTS.slice(0, N).map((s) => { const c = readCar(P[0].emu.mem, s); return { x: c.x, z: c.z }; });
for (let i = 0; i < N; i++) swapStartForPlayer(P[i].emu.mem, i);
// en cada instancia, el auto que representa al jugador j debe estar exactamente en el lugar de la grilla de j
let gridOk = true; const gridTxt = [];
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const c = readCar(P[i].emu.mem, slotFor(i, j)), w = spots[j];
  if (Math.hypot(c.x - w.x, c.z - w.z) > 0.01) gridOk = false;
  if (i === 0) gridTxt.push(`J${j + 1}→auto ${slotFor(i, j)}`);
}
check('0. grilla: en las N instancias cada jugador ocupa su lugar y los demás lo ven ahí', gridOk, `(${N} jugadores; en J1: ${gridTxt.join(', ')}; J1 en ${gridBefore.x.toFixed(1)},${gridBefore.z.toFixed(1)})`);

const sync = [], ap = [];
for (let i = 0; i < N; i++) {
  ap[i] = new Autopilot(P[i].emu, { skipSlots: GRID_SLOTS.slice(1, N) });
  ap[i].maxKmh = 200 + i * 15;
  sync[i] = new CarSync({ emu: P[i].emu, transport: net(i), playerId: `jugador-${i + 1}`, playerIndex: i, now: () => P[i].gameMs() + skew[i], log });
}
const trace = [];
const t0 = P[0].gameMs();
const DUR = Number(process.env.DUR || 45000);
for (let t = t0; t < t0 + DUR; t += 50) {
  clock = t;
  for (let i = 0; i < N; i++) { P[i].untilMs(t); ap[i].step(); sync[i].tick(); }
  deliver();
  trace.push({ t, own: P.map((S) => readCar(S.emu.mem, 0)), prog: P.map((S) => S.emu.mem.r32(carAddr(0) + PROG_OFF) | 0), seen: P.map((S, i) => Array.from({ length: N }, (_, j) => j === i ? null : readCar(S.emu.mem, slotFor(i, j)))) });
}

// precisión de cada auto remoto en cada instancia (contra la pose real, con el retardo de interpolación)
const errs = [];
for (let k = 3; k < trace.length; k++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) {
  const s = trace[k].seen[i][j]; let best = 1e9;
  for (let m = Math.max(0, k - 6); m <= k; m++) best = Math.min(best, Math.hypot(s.x - trace[m].own[j].x, s.z - trace[m].own[j].z));
  errs.push(best);
}
errs.sort((a, b) => a - b);
const p95 = errs[Math.floor(errs.length * 0.95)], p50 = errs[Math.floor(errs.length / 2)];
check(`1. cada instancia ve a los otros ${N - 1} jugadores donde realmente están`, p95 < 6, `(${errs.length} mediciones; mediana ${p50.toFixed(2)}, p95 ${p95.toFixed(2)} unidades; ${lost}/${sent} paquetes perdidos; relojes desfasados hasta ${Math.max(...skew) - Math.min(...skew)} ms)`);

// clasificación: el orden entre humanos tiene que coincidir con el avance real
let agree = 0, total = 0, maxRankGap = 0;
for (const tr of trace.slice(80)) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) {
  const di = tr.prog[i] - tr.prog[j]; if (Math.abs(di) < 2) continue;  // empatados: no se cuenta
  const rankMe = tr.own[i].position, rankOther = tr.seen[i][j].position;
  total++; if ((di > 0) === (rankMe < rankOther)) agree++;
}
// diferencia de puesto mostrado vs. propio, ya terminada la largada lanzada (en la largada el juego mueve los autos solo)
const gaps = [];
for (const tr of trace.slice(260)) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) gaps.push(Math.abs(tr.seen[i][j].position - tr.own[j].position));
gaps.sort((a, b) => a - b); maxRankGap = gaps.length ? `mediana ${gaps[gaps.length >> 1]}, p95 ${gaps[Math.floor(gaps.length * 0.95)]}, máx ${gaps[gaps.length - 1]}` : 'sin datos';
check('2. clasificación: en cada pantalla el orden entre jugadores es el real', total > 50 && agree / total > 0.97, `(${agree}/${total} comparaciones; diferencia entre el puesto que muestra cada juego y el propio, después de la largada: ${maxRankGap} — los 34+ autos de la IA no son los mismos en cada instancia)`);
const last = trace[trace.length - 1];
check('3. vueltas: cada instancia ve la vuelta real de cada jugador', last.seen.every((row, i) => row.every((s, j) => j === i || s.lap === last.own[j].lap)), `(${last.own.map((c, j) => `J${j + 1} v${c.lap} p${c.position}`).join(' · ')})`);
const allConnected = sync.every((s) => [...s.peers.values()].length === N - 1 && [...s.peers.values()].every((p) => p.status === 'conectado'));
check(`4. todas las instancias conectadas con los ${N - 1} restantes`, allConnected);

// desconexión de uno: los demás siguen y su auto vuelve a la IA
const gone = N - 1;
for (let t = t0 + DUR; t < t0 + DUR + 7000; t += 50) { clock = t; for (let i = 0; i < gone; i++) { P[i].untilMs(t); ap[i].step(); sync[i].tick(); } deliver(); }
const releasedEverywhere = sync.slice(0, gone).every((s) => { const p = [...s.peers.values()].find((q) => q.index === gone); return p && !p.active && p.status === 'desconectado'; });
const othersOk = sync.slice(0, gone).every((s) => [...s.peers.values()].filter((q) => q.index !== gone).every((q) => q.status === 'conectado'));
check(`5. J${N} se va: los demás siguen conectados entre sí y su auto vuelve a la IA`, releasedEverywhere && othersOk);
for (let i = 0; i < N; i++) png(P[i].screen(), path.join(OUT, `n${N}_pantalla_J${i + 1}.png`));
log(`RESULTADO ${ok}/${ok + bad}`);
fs.writeFileSync(path.join(OUT, `mp_n${N}_resultado.txt`), lines.join('\n') + '\n');
process.exit(bad ? 1 : 0);
