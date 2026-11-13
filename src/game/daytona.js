// daytona.js — acceso a los autos de DAYTONA.EXE (Sega PC, 1996) en la memoria emulada.
//
// Estructuras identificadas por ingeniería inversa sobre el EXE original (ver AVANCE_MULTI_FASE1.md):
//   arreglo de 40 autos en .data, 0x11B7AD4, 0x268 (616) bytes por auto; el auto 0 es el jugador.
// Coordenadas en punto fijo 16.16 (1 unidad ≈ 0,84 m); ángulos de 16 bits (65536 = 360°),
// con rumbo = atan2(-dx, dz) respecto del movimiento.
//
// Estado de cada campo:  [V] verificado con experimentos  ·  [C] candidato sin verificar
export const CARS = { base: 0x11b7ad4, stride: 0x268, count: 40, player: 0 };

export const FIELD = {
  index: 0x000,      // [V] número de auto 0..39
  speedKmh: 0x004,   // [V] velocidad en km/h (entero; el HUD muestra mph = km/h / 1,609)
  speedRaw: 0x008,   // [V] velocidad en unidades internas (~922 por km/h)
  x: 0x00c,          // [V] posición X (16.16)
  y: 0x010,          // [V] altura Y (16.16; 0 en la pista plana de Beginner)
  z: 0x014,          // [V] posición Z (16.16)
  pitch: 0x018,      // [C] cabeceo (ángulo 16 bits)
  yaw: 0x01c,        // [V] rumbo de la carrocería (ángulo 16 bits)
  roll: 0x020,       // [C] rolido (ángulo 16 bits)
  travelDir: 0x024,  // [V] dirección de la velocidad (ángulo 16 bits)
  aiTargetX: 0x034,  // [V] punto objetivo de la IA (X, 16.16)
  aiTargetZ: 0x038,  // [V] punto objetivo de la IA (Z, 16.16)
  steerInput: 0x0a8, // [V] dirección del volante (-127..127), sólo con sentido en el auto del jugador
  segment: 0x180,    // [V] segmento de pista (0..480 en Beginner); vuelve a 0 al cruzar la meta
  lap: 0x218,        // [V] vueltas: 0 hasta cruzar la línea en la largada lanzada, 1 en la primera vuelta, etc.
  rank: 0x220,       // [V] posición en carrera, 0 = primero
};

const FX = 65536, ANG = 65536 / 360;
const s32 = (v) => v | 0;
const angDeg = (raw) => { const a = raw & 0xffff; return (a >= 32768 ? a - 65536 : a) / ANG; };

export function carAddr(i) {
  if (!(i >= 0 && i < CARS.count)) throw new RangeError(`auto ${i} fuera de rango`);
  return CARS.base + i * CARS.stride;
}

export function readCar(mem, i) {
  const a = carAddr(i), r = (o) => s32(mem.r32(a + o));
  return {
    index: r(FIELD.index),
    x: r(FIELD.x) / FX, y: r(FIELD.y) / FX, z: r(FIELD.z) / FX,
    yaw: angDeg(r(FIELD.yaw)), pitch: angDeg(r(FIELD.pitch)), roll: angDeg(r(FIELD.roll)),
    travelDir: angDeg(r(FIELD.travelDir)),
    speedKmh: r(FIELD.speedKmh), speedMph: Math.round(r(FIELD.speedKmh) / 1.609344),
    speedRaw: r(FIELD.speedRaw),
    segment: r(FIELD.segment), lap: r(FIELD.lap), position: r(FIELD.rank) + 1,
  };
}

export function readAllCars(mem) { return Array.from({ length: CARS.count }, (_, i) => readCar(mem, i)); }

// Estado mínimo de un auto para transmitir por red (enteros crudos: exacto y compacto)
export function readPoseRaw(mem, i) {
  const a = carAddr(i), r = (o) => s32(mem.r32(a + o));
  return { x: r(FIELD.x), y: r(FIELD.y), z: r(FIELD.z), yaw: r(FIELD.yaw) & 0xffff, pitch: r(FIELD.pitch) & 0xffff, roll: r(FIELD.roll) & 0xffff, travel: r(FIELD.travelDir) & 0xffff, speed: r(FIELD.speedRaw), kmh: r(FIELD.speedKmh), seg: r(FIELD.segment), lap: r(FIELD.lap) };
}

// Mueve un auto. pose en unidades del juego (x,y,z) y grados (yaw). Campos omitidos no se tocan.
export function writeCarPose(mem, i, pose) {
  const a = carAddr(i);
  if (pose.x !== undefined) mem.w32(a + FIELD.x, Math.round(pose.x * FX) >>> 0);
  if (pose.y !== undefined) mem.w32(a + FIELD.y, Math.round(pose.y * FX) >>> 0);
  if (pose.z !== undefined) mem.w32(a + FIELD.z, Math.round(pose.z * FX) >>> 0);
  if (pose.yaw !== undefined) {
    const raw = Math.round(pose.yaw * ANG) & 0xffff;
    // el rumbo y la dirección de la velocidad se escriben juntos para que el auto no "derrape" al aparecer
    mem.w32(a + FIELD.yaw, (mem.r32(a + FIELD.yaw) & 0xffff0000 | raw) >>> 0);
    mem.w32(a + FIELD.travelDir, (mem.r32(a + FIELD.travelDir) & 0xffff0000 | raw) >>> 0);
  }
}
export function writePoseRaw(mem, i, p) {
  const a = carAddr(i);
  mem.w32(a + FIELD.x, p.x >>> 0); mem.w32(a + FIELD.y, p.y >>> 0); mem.w32(a + FIELD.z, p.z >>> 0);
  for (const [f, v] of [[FIELD.yaw, p.yaw], [FIELD.travelDir, p.travel ?? p.yaw]]) if (v !== undefined) mem.w32(a + f, (mem.r32(a + f) & 0xffff0000 | (v & 0xffff)) >>> 0);
}

// Punto `dist` unidades delante del auto i (según su rumbo)
export function aheadOf(car, dist) {
  const h = car.yaw * Math.PI / 180;
  return { x: car.x - Math.sin(h) * dist, z: car.z + Math.cos(h) * dist };
}
