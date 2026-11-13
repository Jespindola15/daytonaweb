// Prueba en Chrome de los mandos (Gamepad API). Chrome sin pantalla no tiene mandos físicos, así que se reemplaza
// navigator.getGamepads por un mando estándar simulado que la prueba controla; todo lo demás es el camino real:
// gamepad.js → teclas del juego (modo «como teclado») o joystick de Windows joyGetPosEx (modo analógico).
//   node tools/dev-server.mjs 8140 ; URL=http://localhost:8140/web/ node tests/chrome_gamepad.mjs
import fs from 'node:fs';
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const URL_ = process.env.URL || 'http://localhost:8140/web/';
const OUT = process.env.OUT || 'tests/logs/fase3';
fs.mkdirSync(OUT, { recursive: true });
let ok = 0, bad = 0; const lines = [];
const log = (s) => { console.log(s); lines.push(s); };
const check = (n, c, x = '') => { c ? ok++ : bad++; log(`${c ? 'OK ' : 'ERR'} ${n}${x ? '  ' + x : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });

async function session(mode) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
  await ctx.addInitScript((mode) => {
    localStorage.setItem('daytona.opts', JSON.stringify({ v: 2, pad: mode }));
    const pad = { id: 'Mando de prueba (STANDARD GAMEPAD)', index: 0, mapping: 'standard', connected: true, timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad, null, null, null];
  }, mode);
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(URL_);
  await p.waitForFunction(() => (window.__stats?.frames || 0) > 2, null, { timeout: 120000 });
  // menú: Enter con el botón Start del mando (Arcade → Beginner → Automática)
  const t0 = Date.now();
  for (const ms of [2500, 5500, 8500, 11500, 14500, 17500]) {
    await p.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
    await p.evaluate(() => { window.__pad.buttons[9].pressed = true; }); await p.waitForTimeout(250); await p.evaluate(() => { window.__pad.buttons[9].pressed = false; });
  }
  // largada lanzada (~10 s) y carrera
  await p.waitForFunction(() => { const m = window.__emu().mem; return (m.r32(0x11b7ad4 + 0x268 * 5 + 4) | 0) > 0; }, null, { timeout: 60000 });
  await p.waitForTimeout(16000);
  const inp = () => p.evaluate(() => { const m = window.__emu().mem, a = 0x11b7ad4; return { acc: m.r32(a + 0x68) | 0, brk: m.r32(a + 0x80) | 0, steer: m.r32(a + 0xa8) | 0, kmh: m.r32(a + 4) | 0 }; });
  const set = (fn) => p.evaluate(fn);
  const hold = async (on, off, ms = 600) => { await set(on); await p.waitForTimeout(ms); const v = await inp(); await set(off); await p.waitForTimeout(300); return v; };
  const res = { errs, ini: await p.evaluate(() => new TextDecoder().decode(window.__emu().vfs.find('DAYTONA.INI').data).match(/Device=\w+/)[0]) };
  res.rt = await hold(() => { window.__pad.buttons[7] = { pressed: true, value: 1 }; }, () => { window.__pad.buttons[7] = { pressed: false, value: 0 }; }, 1200);
  res.lt = await hold(() => { window.__pad.buttons[6] = { pressed: true, value: 1 }; }, () => { window.__pad.buttons[6] = { pressed: false, value: 0 }; }, 900);
  res.steer = {};
  for (const x of [-1, -0.5, 0.5, 1]) { await p.evaluate((x) => { window.__pad.axes[0] = x; }, x); await p.waitForTimeout(700); res.steer[x] = (await inp()).steer; await p.evaluate(() => { window.__pad.axes[0] = 0; }); await p.waitForTimeout(300); }
  res.center = (await inp()).steer;
  await p.screenshot({ path: `${OUT}/mando_${mode}.png` });
  await ctx.close();
  return res;
}

const K = await session('keys');
log(`modo «como teclado» (${K.ini}): RT → acelerador ${K.rt.acc} (${K.rt.kmh} km/h) · LT → freno ${K.lt.brk} · stick -1/-0,5/+0,5/+1 → volante ${[-1, -0.5, 0.5, 1].map((x) => K.steer[x]).join(' / ')} · centro ${K.center}`);
check('1. modo como teclado: el juego sigue en Device=KEYBOARD', K.ini === 'Device=KEYBOARD');
check('2. RT acelera y LT frena (el juego registra acelerador y freno)', K.rt.acc === 1 && K.lt.brk > 200);
check('3. el stick gira a los dos lados (dirección digital: medio stick ya gira como la tecla)', K.steer[-1] < -20 && K.steer[1] > 20 && K.steer[-0.5] < -20 && K.steer[0.5] > 20);
const A = await session('analog');
log(`modo analógico (${A.ini}): RT → acelerador ${A.rt.acc} (${A.rt.kmh} km/h) · LT → freno ${A.lt.brk} · stick -1/-0,5/+0,5/+1 → volante ${[-1, -0.5, 0.5, 1].map((x) => A.steer[x]).join(' / ')} · centro ${A.center}`);
check('4. modo analógico: el juego arranca como volante (Device=PC_HANDLE)', A.ini === 'Device=PC_HANDLE');
check('5. analógico: RT acelera y LT frena (botones 3 y 6 del joystick de Windows)', A.rt.acc === 1 && A.lt.brk > 200);
const prop = Math.abs(A.steer[-0.5]) > 25 && Math.abs(A.steer[-0.5]) < Math.abs(A.steer[-1]) * 0.8 && Math.abs(A.steer[0.5]) < Math.abs(A.steer[1]) * 0.8 && A.steer[-1] < -100 && A.steer[1] > 100;
check('6. analógico: dirección proporcional (medio stick gira menos que el stick a fondo)', prop, `(-1→${A.steer[-1]}, -0,5→${A.steer[-0.5]}, +0,5→${A.steer[0.5]}, +1→${A.steer[1]})`);
check('7. sin errores de JavaScript', !K.errs.length && !A.errs.length, [...K.errs, ...A.errs].slice(0, 2).join(' | '));
log(`RESULTADO ${ok}/${ok + bad}`);
fs.writeFileSync(`${OUT}/mando_resultado.txt`, lines.join('\n') + '\n');
await browser.close();
process.exit(bad ? 1 : 0);
