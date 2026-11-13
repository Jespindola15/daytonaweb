// autopilot.js — "piloto de prueba": sólo aprieta teclas (←, →, X acelerar, Z frenar) como lo haría una persona.
// No toca la física: el auto lo mueve el motor original. Sirve para pruebas reproducibles (dar vueltas, adelantar).
// La línea de carrera se aprende en vivo promediando, por segmento de pista, la posición de los autos de la IA.
import { readCar, CARS } from './daytona.js';

const VK = { LEFT: 0x25, RIGHT: 0x27, ACCEL: 0x58, BRAKE: 0x5a };

export class Autopilot {
  constructor(emu, { maxKmh = 230, lookahead = 7, skipSlots = [] } = {}) {
    Object.assign(this, { emu, maxKmh, lookahead, skipSlots: new Set(skipSlots) });
    this.line = new Map(); // segmento -> {x, z, n}
    this.keys = {}; this.mode = 'drive'; // drive | brake | idle | steer (sólo dirección: acelerar/frenar quedan para el teclado)
  }
  learn() {
    for (let i = 1; i < CARS.count; i++) {
      if (this.skipSlots.has(i)) continue;
      const c = readCar(this.emu.mem, i);
      if (c.speedKmh < 60) continue;
      const p = this.line.get(c.segment) || { x: 0, z: 0, n: 0 };
      if (p.n < 50) { p.x += c.x; p.z += c.z; p.n++; this.line.set(c.segment, p); }
    }
  }
  target(seg) {
    for (let d = this.lookahead; d < this.lookahead + 30; d++) {
      const p = this.line.get((seg + d) % 481); if (p) return { x: p.x / p.n, z: p.z / p.n };
    }
    return null;
  }
  key(name, down) { if (!!this.keys[name] !== down) { this.keys[name] = down; this.emu.keyEvent(VK[name], down); } }
  step() {
    this.learn();
    const me = readCar(this.emu.mem, 0);
    if (this.mode === 'idle') { for (const k of Object.keys(VK)) this.key(k, false); return; }
    const tgt = this.target(me.segment);
    let steer = 0;
    if (tgt) {
      const want = Math.atan2(-(tgt.x - me.x), tgt.z - me.z) * 180 / Math.PI; // misma convención que el rumbo del juego
      let err = want - me.yaw; err = ((err + 540) % 360) - 180;
      steer = err > 2.5 ? 1 : err < -2.5 ? -1 : 0; // el rumbo aumenta al girar a la izquierda
    }
    this.key('LEFT', steer > 0); this.key('RIGHT', steer < 0);
    if (this.mode === 'steer') return;
    if (this.mode === 'brake') { this.key('ACCEL', false); this.key('BRAKE', true); return; }
    const over = me.speedKmh > this.maxKmh + 15; // en Daytona soltar el acelerador casi no frena
    this.key('BRAKE', over);
    this.key('ACCEL', !over && me.speedKmh < this.maxKmh);
  }
}
