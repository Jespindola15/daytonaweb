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

// ---------------------------------------------------------------------------------------------
// Ciclo de actualización y render (identificado en el EXE; ver FASE_2_MULTIJUGADOR.md)
//   0x43A780  función de cuadro → etapas vía 0x406530
//   0x4479D0  actualiza autos: jugador (0x448020) y luego rivales (0x447C40)
//   0x447C40  bucle de rivales: para k=1..N, [0x11B70A0] = struct del auto k, llama 0x4481B0
//   0x4481B0  actualización de UN rival: IA + física (0x43F450, 0x43F750, 0x437DB0, 0x436F20, 0x436FF0)
//             y luego, desde 0x4481D0, ubicación en pista (0x4379B0) y progreso para el ranking (+0x1F4)
//   0x447CE0  (en el bucle de rivales) push 1; call 0x42D1AD → corrección contra terreno/bordes del auto actual
//   0x44AB43  tick de lógica: call 0x448A30 = colisiones entre autos (empuja a ambos); vuelve en 0x44AB48
//   0x455650  render de los autos (lee la pose para transformar los modelos)
export const CODE = {
  CUR_CAR: 0x11b70a0, RIVAL_UPDATE: 0x4481b0, RIVAL_UPDATE_TAIL: 0x4481d0,
  TERRAIN_FIX: 0x42d1ad, TERRAIN_FIX_RET_FROM_LOOP: 0x447ce5, TERRAIN_FIX_RESULT: 0x484a58,
  AFTER_COLLISIONS: 0x44ab48, RENDER_CARS: 0x455650,
};
const STRUCT_DELTA = 4; // el puntero que usa el juego apunta 4 bytes antes de carAddr(i)

export function slotFromGamePtr(ptr) {
  const d = ptr + STRUCT_DELTA - CARS.base;
  return d >= 0 && d % CARS.stride === 0 && d / CARS.stride < CARS.count ? d / CARS.stride : -1;
}

// Escribe una pose cruda (como la de readPoseRaw) en el auto `slot`
export function applyPoseRaw(mem, slot, p) {
  const a = carAddr(slot);
  mem.w32(a + FIELD.x, p.x >>> 0); mem.w32(a + FIELD.y, p.y >>> 0); mem.w32(a + FIELD.z, p.z >>> 0);
  const ang = (f, v) => mem.w32(a + f, ((mem.r32(a + f) & 0xffff0000) | (v & 0xffff)) >>> 0);
  ang(FIELD.yaw, p.yaw); ang(FIELD.pitch, p.pitch); ang(FIELD.roll, p.roll); ang(FIELD.travelDir, p.travel);
  mem.w32(a + FIELD.speedRaw, p.speed >>> 0); mem.w32(a + FIELD.speedKmh, p.kmh >>> 0);
  if (p.seg !== undefined) mem.w32(a + FIELD.segment, p.seg >>> 0);
  if (p.lap !== undefined) mem.w32(a + FIELD.lap, p.lap >>> 0);
}

// Autos controlados desde afuera (otro jugador). Puntos de intercepción (los mínimos necesarios):
//  1. 0x4481B0 (actualización del rival): para el auto remoto no corren la IA ni la física; se escribe la pose
//     remota y se sigue en 0x4481D0 (ubicación en pista y ranking los sigue calculando el juego).
//  2. 0x42D1AD llamada desde el bucle de rivales: la corrección contra el terreno no se aplica al remoto
//     (su pose ya viene corregida desde la instancia del otro jugador).
//  3. 0x44AB48 (después de las colisiones): las colisiones se calculan normalmente (el jugador local choca y es
//     empujado), pero la pose del remoto se restaura: la manda el otro jugador.
//  4. 0x455650 (antes del render): se vuelve a aplicar la pose, por si algo la movió en el mismo cuadro.
export class RemoteCars {
  constructor(emu) {
    this.emu = emu; this.poses = new Map();
    this.stats = { skipped: 0, aiRuns: 0, terrainSkipped: 0, collisionRestores: 0, renderPasses: 0 };
    emu.addHook(CODE.RIVAL_UPDATE, (c) => this.onRivalUpdate(c));
    emu.addHook(CODE.TERRAIN_FIX, (c) => this.onTerrainFix(c));
    emu.addHook(CODE.AFTER_COLLISIONS, () => { if (this.poses.size) { this.stats.collisionRestores++; this.applyAll(); } return true; });
    emu.addHook(CODE.RENDER_CARS, () => { this.stats.renderPasses++; this.applyAll(); return true; });
  }
  // slot remoto cuya actualización se acaba de saltear (sólo ése omite también el ajuste de terreno)
  currentRemote() { const slot = slotFromGamePtr(this.emu.mem.r32(CODE.CUR_CAR)); return slot >= 0 && slot === this.taken ? slot : -1; }
  onTerrainFix(c) {
    const m = this.emu.mem;
    if (m.r32(c.r[4]) !== CODE.TERRAIN_FIX_RET_FROM_LOOP || this.currentRemote() < 0) return true;
    c.r[0] = m.r32(CODE.TERRAIN_FIX_RESULT);                 // mismo valor de retorno que la función
    c.eip = m.r32(c.r[4]); c.r[4] = (c.r[4] + 4) >>> 0;      // ret (cdecl: el llamador limpia su argumento)
    this.stats.terrainSkipped++;
    return false;
  }
  onRivalUpdate(c) {
    const m = this.emu.mem, ptr = m.r32(CODE.CUR_CAR), slot = slotFromGamePtr(ptr);
    const pose = slot >= 0 ? this.poses.get(slot) : undefined;
    const v = typeof pose === 'function' ? pose() : pose;
    this.taken = v ? slot : -1;
    if (!v) { this.stats.aiRuns++; return true; }          // auto normal (o remoto sin datos todavía): IA original
    c.r[4] = (c.r[4] - 4) >>> 0; m.w32(c.r[4], c.r[6]);   // prólogo original: push esi
    c.r[6] = ptr;                                            //                    mov esi,[0x11B70A0]
    applyPoseRaw(m, slot, v);
    this.stats.skipped++;
    c.eip = CODE.RIVAL_UPDATE_TAIL;                          // continúa en el tramo final de 0x4481B0
    return false;
  }
  // pose: objeto de pose cruda, o función que la devuelve (se evalúa en el instante en que el juego la usa)
  set(slot, pose) { if (slot <= 0 || slot >= CARS.count) throw new RangeError('slot de auto remoto inválido'); this.poses.set(slot, pose); }
  release(slot) { this.poses.delete(slot); }
  applyAll() { for (const [slot, p] of this.poses) { const v = typeof p === 'function' ? p() : p; if (v) applyPoseRaw(this.emu.mem, slot, v); } }
  dispose() { this.poses.clear(); for (const h of [CODE.RIVAL_UPDATE, CODE.TERRAIN_FIX, CODE.AFTER_COLLISIONS, CODE.RENDER_CARS]) this.emu.removeHook(h); }
}
