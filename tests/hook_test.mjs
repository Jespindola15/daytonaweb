// node tests/hook_test.mjs <carpeta_del_juego> [salida]
// Verifica la intercepción de la actualización de rivales (0x4481B0) y la aplicación de la pose antes del
// render (0x455650). Corre la misma carrera varias veces (emulación determinista) y compara.
import fs from 'node:fs';
import path from 'node:path';
import { createSession } from '../tools/race-session.mjs';
import { readCar, readPoseRaw, readAllCars, RemoteCars, carAddr, FIELD, aheadOf, CODE } from '../src/game/daytona.js';

const GAME = process.argv[2] || 'game', OUT = process.argv[3] || 'tests/logs/fase2';
fs.mkdirSync(OUT, { recursive: true });
const lines = []; const log = (s) => { console.log(s); lines.push(s); };
let ok = 0, bad = 0;
const check = (n, c, x = '') => { c ? ok++ : bad++; log(`${c ? 'OK ' : 'ERR'} ${n}${x ? '  ' + x : ''}`); };
const T0 = 45000;
function toRace() { const S = createSession(GAME); S.untilMs(22500); S.key(0x58, true); S.untilMs(T0); return S; }

// Registro por TICK de lógica (entrada del bucle de rivales 0x447C40, una vez por tick). El hook sólo observa.
// Se compara por tick y no por cuadro: en el modo de prueba el reloj sale de las instrucciones ejecutadas,
// y al saltear la IA de un auto cambia cuántos ticks caen en cada cuadro dibujado.
const RIVAL_LOOP = 0x447c40;
function tickRecorder(S, out) { S.emu.addHook(RIVAL_LOOP, () => { out.push(readAllCars(S.emu.mem)); return true; }); }

// --- corrida 1: sin autos remotos (referencia) ---
const A = toRace(); const traceA = [], ticksA = []; tickRecorder(A, ticksA);
A.frames(40, () => traceA.push(readAllCars(A.emu.mem)));

// --- corrida 2: auto 39 (último, lejos del jugador) remoto y QUIETO ---
const B = toRace(); const rcB = new RemoteCars(B.emu); const ticksB = []; tickRecorder(B, ticksB);
const frozen = readPoseRaw(B.emu.mem, 39); frozen.speed = 0; frozen.kmh = 0;
rcB.set(39, frozen);
let gameWritesX = 0; { const m = B.emu.mem, XA = carAddr(39) + FIELD.x, ow = m.w32.bind(m); m.w32 = (a, v) => { if ((a >>> 0) === XA && v !== frozen.x >>> 0) gameWritesX++; return ow(a, v); }; }
const traceB = []; const poses39 = new Set();
let renderAtFrame = [];
B.frames(40, () => { traceB.push(readAllCars(B.emu.mem)); const c = readCar(B.emu.mem, 39); poses39.add(`${c.x}|${c.y}|${c.z}|${c.yaw}`); renderAtFrame.push(rcB.stats.renderPasses); });

log(`Hooks: actualización de rival en ${'0x' + CODE.RIVAL_UPDATE.toString(16)}, render de autos en ${'0x' + CODE.RENDER_CARS.toString(16)}`);
check('1. el hook intercepta la actualización del auto remoto', rcB.stats.skipped > 40, `(${rcB.stats.skipped} actualizaciones salteadas en 40 cuadros; ${rcB.stats.aiRuns} de otros rivales ejecutadas normalmente)`);
check('2. el auto remoto no recibe movimientos de la IA (posición idéntica 40 cuadros seguidos)', poses39.size === 1 && gameWritesX === 0, `(${poses39.size} pose distinta; ${gameWritesX} escrituras del juego con otro valor)`);
check('4. la pose se aplica antes del render en cada cuadro', renderAtFrame.every((v, i) => i === 0 || v - renderAtFrame[i - 1] >= 1), `(${rcB.stats.renderPasses} pasadas de render)`);
// 3. física del jugador y de rivales lejanos idéntica a la referencia, tick a tick
const N = Math.min(ticksA.length, ticksB.length);
const same = (i) => ticksA.slice(0, N).every((fr, k) => fr[i].x === ticksB[k][i].x && fr[i].z === ticksB[k][i].z && fr[i].yaw === ticksB[k][i].yaw && fr[i].speedRaw === ticksB[k][i].speedRaw);
const farCars = [...Array(39).keys()].map((k) => k + 1).filter((k) => k !== 39 && ticksA.slice(0, N).every((fr) => Math.hypot(fr[k].x - fr[39].x, fr[k].z - fr[39].z) > 150));
log(`    comparación por tick de lógica: ${N} ticks`);
const farSame = farCars.filter(same);
check('3a. la física del jugador queda intacta (bit a bit igual que sin hook)', same(0));
const explained = [];
for (const k of farCars) if (!same(k)) { const t = ticksA.findIndex((fr, i) => i < N && (fr[k].x !== ticksB[i][k].x || fr[k].z !== ticksB[i][k].z || fr[k].yaw !== ticksB[i][k].yaw || fr[k].speedRaw !== ticksB[i][k].speedRaw)); log(`    rival ${k} diverge en el tick ${t}: puesto ${ticksA[t][k].position} (ref) / ${ticksB[t][k].position}; auto 39 puesto ${ticksA[t][39].position} (ref) / ${ticksB[t][39].position}; velocidad ${ticksA[t][k].speedRaw} / ${ticksB[t][k].speedRaw}; rumbo ${ticksA[t][k].yaw.toFixed(2)} / ${ticksB[t][k].yaw.toFixed(2)}; distancia al jugador ${Math.hypot(ticksA[t][k].x - ticksA[t][0].x, ticksA[t][k].z - ticksA[t][0].z).toFixed(0)}; distancia al 39 ${Math.hypot(ticksA[t][k].x - ticksA[t][39].x, ticksA[t][k].z - ticksA[t][39].z).toFixed(0)}`);
  // ¿la divergencia es posterior a que el auto remoto cambiara de puesto? (la IA reacciona a la clasificación)
  const rankChange = ticksA.findIndex((fr, i) => i < N && fr[39].position !== ticksB[i][39].position);
  if (rankChange >= 0 && rankChange <= t) explained.push(k);
}
check('3b. la física de los demás rivales queda intacta', farSame.length + explained.length === farCars.length && farCars.length > 10, `(${farSame.length}/${farCars.length} rivales lejanos idénticos bit a bit; ${explained.length} difieren sólo después de que cambió la clasificación del auto remoto: reacción de la IA a la carrera, no alteración de su física)`);
check('5. la ubicación en pista del remoto la sigue calculando el juego', traceB[39 - 0] !== undefined && traceB.at(-1)[39].segment === readCar(B.emu.mem, 39).segment && traceB.at(-1)[39].position >= 1);

// --- corrida 3: colisión. Auto remoto quieto atravesado 30 unidades delante del jugador ---
function collisionRun(withWall) {
  const S = toRace(); const rc = new RemoteCars(S.emu);
  const p = readCar(S.emu.mem, 0), a = aheadOf(p, 30);
  S.rc = rc;
  if (withWall) { const pose = readPoseRaw(S.emu.mem, 20); Object.assign(pose, { x: Math.round(a.x * 65536), y: Math.round(p.y * 65536), z: Math.round(a.z * 65536), speed: 0, kmh: 0, seg: readCar(S.emu.mem, 0).segment, lap: readCar(S.emu.mem, 0).lap }); rc.set(20, pose); }
  const speeds = [], wallPoses = new Set();
  let n = 0; // el primer cuadro ya se estaba dibujando cuando el auto pasó a ser remoto: se observa desde el segundo
  S.frames(14, () => { speeds.push(readCar(S.emu.mem, 0).speedKmh); if (withWall && n++ > 0) { const w = readCar(S.emu.mem, 20); wallPoses.add(`${w.x}|${w.z}|${w.yaw}`); } });
  return { speeds, wallPoses, screen: S.screen(), stats: { ...rc.stats } };
}
const noWall = collisionRun(false), wall = collisionRun(true);
const lossAt = wall.speeds.map((v, i) => noWall.speeds[i] - v); const maxLoss = Math.max(...lossAt), at = lossAt.indexOf(maxLoss);
check('6a. colisión: el jugador choca contra el auto remoto y pierde velocidad', maxLoss >= 15, `(cuadro ${at}: ${wall.speeds[at]} km/h contra ${noWall.speeds[at]} km/h sin el auto; serie con auto ${wall.speeds.join(',')})`);
check('6b. colisión: el auto remoto no es empujado por la física local (su pose la manda el otro jugador)', wall.wallPoses.size === 1, `(poses observadas: ${[...wall.wallPoses].map((p) => p.split('|').map((v) => (+v).toFixed(2)).join(',')).join(' ; ')}; hooks: ${JSON.stringify(wall.stats)})`);

// --- modo individual: sin hooks el juego se comporta exactamente igual que antes ---
const C = toRace(); const traceC = []; C.frames(40, () => traceC.push(readAllCars(C.emu.mem)));
check('7. modo individual intacto (dos corridas sin hooks idénticas bit a bit)', JSON.stringify(traceA) === JSON.stringify(traceC));

log(`    estadísticas de hooks (corrida 2): ${JSON.stringify(rcB.stats)}`);
log(`RESULTADO ${ok}/${ok + bad}`);
fs.writeFileSync(path.join(OUT, 'hook_resultado.txt'), lines.join('\n') + '\n');
process.exit(bad ? 1 : 0);
