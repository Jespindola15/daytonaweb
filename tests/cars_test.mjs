// node tests/cars_test.mjs <carpeta_del_juego> [salida]
// Fase 1, pasos 4 y 5: lectura de los 40 autos y modificación en vivo de un rival sin romper la carrera.
// Corre la MISMA carrera dos veces (emulación determinista): una sin tocar nada y otra moviendo un rival
// delante del jugador. Compara números y capturas de pantalla.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createSession } from '../tools/race-session.mjs';
import { readAllCars, readCar, writeCarPose, aheadOf } from '../src/game/daytona.js';

const GAME = process.argv[2] || 'game', OUT = process.argv[3] || 'tests/logs/fase1';
fs.mkdirSync(OUT, { recursive: true });
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'OK ' : 'ERR'} ${name}${extra ? '  ' + extra : ''}`); };
const RIVAL = 10, T_MOVE = 40000, PUPPET_FRAMES = 18;

function run(withPuppet) {
  const S = createSession(GAME);
  S.untilMs(22500); S.key(0x58, true);      // acelerador apretado desde la largada
  S.untilMs(T_MOVE);
  const info = { before: readAllCars(S.emu.mem) };
  if (withPuppet) {
    // durante PUPPET_FRAMES cuadros, el rival 10 se ubica 16 unidades delante del jugador, con su rumbo
    S.frames(PUPPET_FRAMES, () => {
      const p = readCar(S.emu.mem, 0); const a = aheadOf(p, 16);
      writeCarPose(S.emu.mem, RIVAL, { x: a.x, z: a.z, yaw: p.yaw });
    });
  } else S.frames(PUPPET_FRAMES);
  info.atShot = readAllCars(S.emu.mem);
  info.shot = S.screen();
  info.frameAtShot = S.emu.state.dd.frames;
  // después se suelta el rival y la carrera sigue 15 s de juego
  S.untilMs(S.gameMs() + 15000);
  info.after = readAllCars(S.emu.mem);
  info.framesEnd = S.emu.state.dd.frames;
  return info;
}

const A = run(false), B = run(true);

// ---- paso 4: lectura ----
const cars = A.before;
check('se leen 40 autos con índices 0..39', cars.every((c, i) => c.index === i));
check('posiciones en carrera = permutación de 1..40', [...cars.map((c) => c.position)].sort((a, b) => a - b).join() === Array.from({ length: 40 }, (_, i) => i + 1).join());
check('vueltas (0 antes de cruzar la largada) y velocidades plausibles', cars.every((c) => c.lap >= 0 && c.lap <= 8 && c.speedKmh >= 0 && c.speedKmh < 400));
console.log('    jugador:', JSON.stringify(cars[0]));
console.log('    rival 10:', JSON.stringify(cars[RIVAL]));

// ---- paso 5: el rival aparece donde lo pusimos ----
const p = B.atShot[0], r = B.atShot[RIVAL];
const d = Math.hypot(p.x - r.x, p.z - r.z);
check('el rival quedó delante del jugador', d > 8 && d < 26, `(distancia ${d.toFixed(1)} unidades)`);
check('mismo instante en las dos corridas', A.frameAtShot === B.frameAtShot, `(cuadro ${A.frameAtShot})`);
// diferencia de imagen entre la corrida normal y la del rival movido
const W = A.shot.w, H = A.shot.h; let diff = 0, cx = 0, cy = 0;
for (let y = 40; y < H - 40; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; if (Math.abs(A.shot.rgba[o] - B.shot.rgba[o]) + Math.abs(A.shot.rgba[o + 1] - B.shot.rgba[o + 1]) + Math.abs(A.shot.rgba[o + 2] - B.shot.rgba[o + 2]) > 60) { diff++; cx += x; cy += y; } }
check('el auto movido se ve en pantalla (la imagen cambia en la zona central)', diff > 1500 && Math.abs(cx / diff - W / 2) < W * 0.25, `(${diff} píxeles distintos, centro en ${Math.round(cx / diff)},${Math.round(cy / diff)})`);

// ---- la carrera no se rompe ----
const ra = B.after[RIVAL];
check('la carrera sigue: se presentaron cuadros después', B.framesEnd > B.frameAtShot + 100, `(${B.framesEnd - B.frameAtShot} cuadros en 15 s)`);
check('el rival sigue corriendo solo después de soltarlo', ra.speedKmh > 80 && Math.hypot(ra.x - r.x, ra.z - r.z) > 100, `(${ra.speedKmh} km/h, segmento ${ra.segment}, vuelta ${ra.lap})`);
check('las posiciones siguen siendo una permutación válida', [...B.after.map((c) => c.position)].sort((a, b) => a - b).join() === Array.from({ length: 40 }, (_, i) => i + 1).join());

// ---- capturas ----
const png = (s, f) => {
  const raw = Buffer.alloc((s.w * 4 + 1) * s.h);
  for (let y = 0; y < s.h; y++) Buffer.from(s.rgba.buffer, s.rgba.byteOffset + y * s.w * 4, s.w * 4).copy(raw, y * (s.w * 4 + 1) + 1);
  const T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(s.w, 0); ih.writeUInt32BE(s.h, 4); ih[8] = 8; ih[9] = 6;
  fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]));
};
png(A.shot, path.join(OUT, 'sin_tocar.png')); png(B.shot, path.join(OUT, 'rival10_delante_del_jugador.png'));
fs.writeFileSync(path.join(OUT, 'autos.json'), JSON.stringify({ antes: A.before, conRivalMovido: B.atShot, despues: B.after }, null, 1));
console.log(`RESULTADO ${ok}/${ok + bad}`);
process.exit(bad ? 1 : 0);
