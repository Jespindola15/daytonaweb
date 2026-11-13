// Prueba en Chrome real: DOS páginas independientes con DAYTONA.EXE, conectadas por BroadcastChannel.
//   node tools/dev-server.mjs 8140      (sirve web/ y game/manifest.json)
//   URL=http://localhost:8140/web/ OUT=tests/logs/fase2/chrome node tests/chrome_mp_local.mjs
// Verifica: instancias independientes · cada una acelera/frena/gira con eventos de teclado reales ·
// J1 visible y en movimiento en la pantalla de J2 y viceversa · vueltas/puestos coherentes ·
// la desconexión de una no bloquea a la otra.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';

const URL_ = process.env.URL || 'http://localhost:8140/web/';
const OUT = process.env.OUT || 'tests/logs/fase2/chrome';
fs.mkdirSync(OUT, { recursive: true });
const lines = []; const log = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)} s] ${s}`; console.log(l); lines.push(l); };
let ok = 0, bad = 0; const results = [];
const check = (name, cond, extra = '') => { cond ? ok++ : bad++; const l = `${cond ? 'OK ' : 'ERR'} ${name}${extra ? '  ' + extra : ''}`; results.push(l); log(l); };
const T0 = Date.now();

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  // en uso real las dos ventanas deben estar visibles; acá se evita que Chrome frene la página que no tiene foco
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
// J2 en una VENTANA aparte (como se usa de verdad: dos ventanas visibles lado a lado). Dos pestañas de la misma
// ventana no sirven: la que queda detrás está oculta y Chrome deja de darle cuadros (requestAnimationFrame).
const A = await ctx.newPage();
await A.goto(URL_);
const [B] = await Promise.all([ctx.waitForEvent('page'), A.evaluate((u) => { window.open(u, 'jugador2', 'popup,width=900,height=640'); }, URL_)]);
await B.setViewportSize({ width: 900, height: 640 });
const errs = { A: [], B: [] };
A.on('pageerror', (e) => errs.A.push(e.message)); B.on('pageerror', (e) => errs.B.push(e.message));
const pageLog = { A: [], B: [] };
for (const [n, p] of [['A', A], ['B', B]]) p.on('console', (m) => pageLog[n].push(m.text()));
await B.waitForLoadState();
log(`visibilidad: A ${await A.evaluate(() => document.visibilityState)}, B ${await B.evaluate(() => document.visibilityState)}`);

const stats = (p) => p.evaluate(() => window.__stats || {});
const waitFor = async (p, fn, arg, ms, what) => { const t = Date.now(); for (;;) { if (await p.evaluate(fn, arg)) return; if (Date.now() - t > ms) throw new Error(`timeout esperando ${what}`); await p.waitForTimeout(250); } };
await waitFor(A, () => (window.__stats?.frames || 0) > 5, null, 120000, 'arranque A');
await waitFor(B, () => (window.__stats?.frames || 0) > 5, null, 120000, 'arranque B');
log(`las dos páginas ejecutan el juego (A ${(await stats(A)).frames} cuadros, B ${(await stats(B)).frames})`);

// ---- sesión ----
await A.click('#btnLocal'); await A.click('text=Crear sesión (J1)');
await B.click('#btnLocal');
await B.waitForSelector('text=/Unirse a la sesión .* como J2/', { timeout: 10000 });
await B.click('text=/Unirse a la sesión .* como J2/');
await waitFor(A, () => window.__mplocal.state.peer && document.querySelector('#localBody .st-conectado'), null, 10000, 'J2 conectado en A');
const ids = { A: await A.evaluate(() => [window.__mplocal.state.role, window.__mplocal.state.session]), B: await B.evaluate(() => [window.__mplocal.state.role, window.__mplocal.state.session]) };
log(`sesión ${ids.A[1]}: página A = J${ids.A[0]}, página B = J${ids.B[0]} (sesión ${ids.B[1]})`);
await A.screenshot({ path: path.join(OUT, '0_sesion_J1.png') }); await B.screenshot({ path: path.join(OUT, '0_sesion_J2.png') });
check('0. sesión: una página es J1, la otra J2, en la misma sesión', ids.A[0] === 1 && ids.B[0] === 2 && ids.A[1] === ids.B[1]);

// ---- largada ----
await A.click('text=Largar carrera');
log('J1 pidió la largada: las dos páginas reinician el juego y recorren el menú');
let gridSeen = { A: false, B: false };
for (const t = Date.now(); ;) {
  const ph = { A: await A.evaluate(() => window.__mplocal.state.phase), B: await B.evaluate(() => window.__mplocal.state.phase) };
  if (ph.A === 'grid') gridSeen.A = true; if (ph.B === 'grid') gridSeen.B = true;
  if (ph.A === 'race' && ph.B === 'race') break;
  if (Date.now() - t > 150000) throw new Error(`no llegaron a la carrera: ${JSON.stringify(ph)}`);
  await A.waitForTimeout(200);
}
log(`las dos páginas en carrera (barrera vista: A ${gridSeen.A}, B ${gridSeen.B})`);
await A.click('#screen'); await B.click('#screen');

const car = (p, i = 0) => p.evaluate((i) => window.daytona.car(i), i);
const sync = (p) => p.evaluate(() => { const s = window.__mplocal.state.sync; return s && { status: s.status, sent: s.sent, received: s.track.received, active: s.active, remote: s.remoteRace, stats: s.remote.stats }; });

// ---- 1. independientes ----
{
  const a = await car(A), b = await car(B), ia = (await stats(A)).icount, ib = (await stats(B)).icount;
  const sameEmu = await A.evaluate(() => typeof window.__emu === 'function') && await B.evaluate(() => typeof window.__emu === 'function');
  check('1. dos instancias independientes (cada página su propio emulador, su propio juego y su propio auto)', sameEmu && Math.hypot(a.x - b.x, a.z - b.z) > 1 && ia !== ib, `(J1 en ${a.x.toFixed(1)},${a.z.toFixed(1)} · J2 en ${b.x.toFixed(1)},${b.z.toFixed(1)}; instrucciones x86 ejecutadas: ${(ia / 1e9).toFixed(2)} / ${(ib / 1e9).toFixed(2)} mil millones)`);
}

// ---- 2. controles con teclado real (eventos de teclado de Chrome en cada página) ----
// Acelerar y frenar: teclas X/Z reales de Chrome; mientras tanto el piloto automático sólo mantiene la dirección
// (si no, el auto se va contra el muro y la prueba de aceleración no mide nada). Girar: ←/→ reales con el piloto en pausa.
// Controles: con teclas reales de Chrome en UNA página, se leen las entradas que registra el juego del auto 0 en las
// DOS páginas (+0x68 acelerador, +0x80 freno 0..255, +0xA8 volante): la que recibe la tecla la registra, la otra no.
// También se informa la velocidad (orientativa: un auto de la IA que choca de atrás modifica la medición).
const inputs = (p) => p.evaluate(() => { const m = window.__emu().mem, a = 0x11b7ad4; return { acc: m.r32(a + 0x68) | 0, brk: m.r32(a + 0x80) | 0, steer: m.r32(a + 0xa8) | 0, kmh: m.r32(a + 4) | 0 }; });
async function drive(p, other, name) {
  const r = {};
  const hold = async (key, ms) => { await p.keyboard.down(key); await p.waitForTimeout(ms); const mine = await inputs(p), theirs = await inputs(other); await p.keyboard.up(key); await p.waitForTimeout(250); return { mine, theirs, after: await inputs(p) }; };
  const s0 = await inputs(p);
  r.X = await hold('x', 1200); r.Z = await hold('z', 1200); r.L = await hold('ArrowLeft', 500); r.R = await hold('ArrowRight', 500);
  log(`${name}: X → acelerador ${r.X.mine.acc} (otra página ${r.X.theirs.acc}), ${s0.kmh}→${r.X.mine.kmh} km/h · Z → freno ${r.Z.mine.brk} (otra ${r.Z.theirs.brk}), →${r.Z.mine.kmh} km/h · ← volante ${r.L.mine.steer} (otra ${r.L.theirs.steer}) · → volante ${r.R.mine.steer} (otra ${r.R.theirs.steer}) · al soltar: ${r.R.after.acc}/${r.R.after.brk}/${r.R.after.steer}`);
  r.ok = r.X.mine.acc === 1 && r.Z.mine.brk > 200 && r.L.mine.steer < -20 && r.R.mine.steer > 20 && r.R.after.acc === 0 && r.R.after.brk === 0;
  r.alone = r.X.theirs.acc === 0 && r.Z.theirs.brk === 0 && Math.abs(r.L.theirs.steer) < 20 && Math.abs(r.R.theirs.steer) < 20;
  return r;
}
// la largada es lanzada («rolling start»): ~10 s en los que el juego conduce los autos. Se espera a que empiece
// la carrera propiamente dicha (la IA de los rivales empieza a correr: 0x4481B0)
for (const p of [A, B]) await waitFor(p, () => window.__mplocal.state.sync?.remote.stats.aiRuns > 0, null, 30000, 'fin de la largada lanzada');
log('terminó la largada lanzada en las dos páginas: control manual');
// la otra página queda sin tocar teclas mientras se prueba una
for (const p of [A, B]) await p.evaluate(() => { clearInterval(window.__apT); });
const dA = await drive(A, B, 'J1 (página A)');
const dB = await drive(B, A, 'J2 (página B)');
check('2a. J1: el juego de J1 registra acelerador, freno y volante (←/→) de su teclado', dA.ok);
check('2b. J2: el juego de J2 registra acelerador, freno y volante (←/→) de su teclado', dB.ok);
check('2c. las teclas de una página no llegan al juego de la otra', dA.alone && dB.alone);

// ---- 3/4. verse mutuamente: piloto automático (mismas teclas del juego) + persecución regulada ----
for (const p of [A, B]) await p.evaluate(async () => {
  const { Autopilot } = await import('/src/game/autopilot.js');
  const ap = new Autopilot(window.__emu(), { skipSlots: [38] }); ap.maxKmh = 230;
  window.__ap = ap; window.__apT = setInterval(() => ap.step(), 50);
});
const rel = (v, o) => { const h = v.yaw * Math.PI / 180, fx = -Math.sin(h), fz = Math.cos(h); const dx = o.x - v.x, dz = o.z - v.z; return { ahead: dx * fx + dz * fz, side: dx * fz - dz * fx }; };
const setMax = (p, k) => p.evaluate((k) => { window.__ap.maxKmh = k; }, k);
const shots = {}; const errsPos = []; const rankSamples = [];
async function chase(viewer, other, vName, oName, ms) {
  const t = Date.now(); const taken = []; let lastShot = 0;
  while (Date.now() - t < ms) {
    const v = await car(viewer), pup = await car(viewer, 38), real = await car(other);
    // muestra de clasificación: puestos que muestra cada juego y avance real de cada auto (contadores de sección)
    const prog = (p) => p.evaluate(() => { const m = window.__emu().mem; return (m.r32(0x11b7ad4 + 0x218) | 0) * 1000 + (m.r32(0x11b7ad4 + 0x1f0) | 0); });  // vuelta y sección
    rankSamples.push({ vMe: v.position, vOther: pup.position, oMe: real.position, oOther: (await car(other, 38)).position, pv: await prog(viewer), po: await prog(other) });
    errsPos.push(Math.hypot(pup.x - real.x, pup.z - real.z));
    const q = rel(v, pup);
    // el que mira acelera si el otro está lejos adelante; frena si lo pasó
    // (velocidades altas: el juego tiene tiempo límite por tramo; si alguien anda muy lento, termina la partida)
    if (q.ahead > 18) { await setMax(viewer, 320); await setMax(other, 240); }
    else if (q.ahead < 8) { await setMax(viewer, 230); await setMax(other, 320); }
    else { await setMax(viewer, 270); await setMax(other, 265); }
    // la cámara va detrás del auto: a ~10 unidades el otro auto se ve justo por encima del propio; a 25 ya es chico
    if (q.ahead > 7 && q.ahead < 16 && Math.abs(q.side) < q.ahead * 0.4 && pup.speedKmh > 60 && Date.now() - lastShot > 2500) {
      const k = taken.length + 1;
      const f = path.join(OUT, `${vName}_ve_a_${oName}_${k}.png`);
      await viewer.locator('#screen').screenshot({ path: f });
      await other.locator('#screen').screenshot({ path: path.join(OUT, `${oName}_mismo_instante_${k}.png`) });
      lastShot = Date.now(); taken.push({ q, v, pup, real, f });
      log(`  captura ${path.basename(f)}: el otro a ${q.ahead.toFixed(1)} unidades adelante, ${q.side.toFixed(1)} al costado, ${pup.speedKmh} km/h`);
      if (taken.length >= 3) break;
    }
    await viewer.waitForTimeout(150);
  }
  return taken.length ? taken[0] : null;
}
// el puppet tiene que moverse en la pantalla del que mira
async function puppetMoves(viewer) { const a = await car(viewer, 38); await viewer.waitForTimeout(1000); const b = await car(viewer, 38); return Math.hypot(b.x - a.x, b.z - a.z); }
const s1 = await chase(A, B, 'J1', 'J2', 70000);
check('4. J2 aparece delante en la pantalla de J1', !!s1, s1 ? `(${s1.q.ahead.toFixed(0)} unidades adelante, ${s1.pup.speedKmh} km/h; captura ${path.basename(s1.f)})` : '');
const m1 = await puppetMoves(A);
const s2 = await chase(B, A, 'J2', 'J1', 70000);
check('3. J1 aparece delante en la pantalla de J2', !!s2, s2 ? `(${s2.q.ahead.toFixed(0)} unidades adelante, ${s2.pup.speedKmh} km/h; captura ${path.basename(s2.f)})` : '');
const m2 = await puppetMoves(B);
check('3/4b. el auto del otro se mueve en cada pantalla', m1 > 20 && m2 > 20, `(en 1 s: J2 visto por J1 avanzó ${m1.toFixed(0)} unidades; J1 visto por J2 ${m2.toFixed(0)})`);
const sorted = errsPos.slice().sort((a, b) => a - b), p50 = sorted[Math.floor(sorted.length / 2)], p95 = sorted[Math.floor(sorted.length * 0.95)];
log(`distancia entre el auto remoto mostrado y el auto real del otro (lecturas no simultáneas, ~150 ms de retardo de interpolación): mediana ${p50.toFixed(1)}, p95 ${p95.toFixed(1)} unidades`);

// ---- 5. vueltas y puestos ----
{
  const a = await car(A), b = await car(B), pa = await car(A, 38), pb = await car(B, 38), sa = await sync(A), sb = await sync(B);
  log(`J1: vuelta ${a.lap}, puesto ${a.position} · J2: vuelta ${b.lap}, puesto ${b.position}`);
  log(`J1 ve a J2 (rival 38): vuelta ${pa.lap}, puesto ${pa.position}; datos recibidos ${JSON.stringify(sa.remote)}`);
  log(`J2 ve a J1 (rival 38): vuelta ${pb.lap}, puesto ${pb.position}; datos recibidos ${JSON.stringify(sb.remote)}`);
  check('5a. cada página recibe la vuelta y el puesto del otro', sa.remote?.lap === b.lap && sb.remote?.lap === a.lap && Math.abs(sa.remote.rank - b.position) <= 1 && Math.abs(sb.remote.rank - a.position) <= 1);
  // En cada muestra: si uno lleva ventaja real clara, los dos juegos tienen que mostrarlo adelante. «Clara» = 5+ secciones
  // (≈ 23 unidades): cada pantalla muestra al otro como estaba hace ~0,2 s (150 ms de interpolación + red), que a
  // 270 km/h son ≈ 4 secciones; con menos ventaja, el orden que muestra cada pantalla puede diferir legítimamente.
  const agreeOf = (min) => { const j = rankSamples.filter((r) => Math.abs(r.pv - r.po) >= min); return [j.filter((r) => (r.pv > r.po) === (r.vMe < r.vOther) && (r.po > r.pv) === (r.oMe < r.oOther)).length, j.length]; };
  const [agree, judged] = agreeOf(5), [a2, j2] = agreeOf(2);
  check('5c. clasificación: con ventaja real clara (5+ secciones), las dos pantallas muestran el mismo orden', judged >= 10 && agree / judged >= 0.95, `(${agree}/${judged} muestras; con 2+ secciones: ${a2}/${j2}; ${rankSamples.length} muestras en total)`);
  check('5b. el juego cuenta la vuelta del auto remoto igual que la del auto real', pa.lap === b.lap && pb.lap === a.lap, `(J1 ve vuelta ${pa.lap} / real ${b.lap}; J2 ve ${pb.lap} / real ${a.lap})`);
  log(`hooks J1: ${JSON.stringify(sa.stats)} · J2: ${JSON.stringify(sb.stats)}`);
  log(`mensajes J1: enviados ${sa.sent}, recibidos ${sa.received} · J2: enviados ${sb.sent}, recibidos ${sb.received}`);
}
await A.screenshot({ path: path.join(OUT, 'J1_pagina_completa.png') }); await B.screenshot({ path: path.join(OUT, 'J2_pagina_completa.png') });

// ---- audio: frecuencias efectivas (SetFrequency antes de Play) ----
const audio = await B.evaluate(() => { const v = window.__emu().host.audio?._voices; if (!v) return null; return [...v.values()].filter((x) => x.fmt).map((x) => ({ fmt: x.fmt.rate, eff: Math.round(x.rate * x.fmt.rate) })); });
if (audio) log(`audio J2: ${audio.length} voces; frecuencia efectiva distinta de la del formato en ${audio.filter((x) => x.eff !== x.fmt).length} (ej.: ${audio.slice(0, 6).map((x) => `${x.fmt}→${x.eff} Hz`).join(', ')})`);

// ---- 6. desconexión ----
for (const p of [A, B]) await p.evaluate(() => clearInterval(window.__apT));
await A.evaluate(() => { window.__ap.maxKmh = 200; window.__apT = setInterval(() => window.__ap.step(), 50); });
const fBefore = (await stats(A)).frames;
await B.close();
log('página B (J2) cerrada');
await A.waitForTimeout(7000);
const fAfter = (await stats(A)).frames, sa = await sync(A);
const badge = await A.textContent('#mpBadge');
await A.screenshot({ path: path.join(OUT, 'J1_tras_desconexion.png') });
check('6. J2 se desconecta y J1 sigue corriendo', fAfter - fBefore > 60 && sa.status === 'desconectado' && !sa.active, `(J1 presentó ${fAfter - fBefore} cuadros en 7 s; estado "${sa.status}"; auto 38 devuelto a la IA: ${!sa.active}; insignia "${badge}")`);
const st = await stats(A); log(`rendimiento J1 al final: ${st.fps?.toFixed(1)} fps del juego, ${st.mips?.toFixed(0)} MIPS`);
check('7. sin errores de JavaScript', !errs.A.length && !errs.B.length, errs.A.concat(errs.B).slice(0, 3).join(' | '));

log(`RESULTADO ${ok}/${ok + bad}`);
fs.writeFileSync(path.join(OUT, 'resultado.txt'), results.join('\n') + `\nRESULTADO ${ok}/${ok + bad}\n`);
fs.writeFileSync(path.join(OUT, 'log.txt'), lines.join('\n') + '\n\n--- consola J1 ---\n' + pageLog.A.join('\n') + '\n\n--- consola J2 ---\n' + pageLog.B.join('\n'));
await browser.close();
process.exit(bad ? 1 : 0);
