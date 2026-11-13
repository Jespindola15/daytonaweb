// multiplayer.js — sincronización de autos entre instancias de DAYTONA.EXE (independiente del transporte).
//
// Cada instancia ejecuta su propia copia del juego original. La física del auto local la calcula el motor
// original; sólo se transmite su estado (pose, velocidad, vuelta). El auto del otro jugador se muestra en un
// rival de la IA cuya actualización se intercepta (RemoteCars, en game/daytona.js): la IA original no lo mueve
// y la pose remota interpolada se aplica en la actualización, después de las colisiones y antes del render.
import { carAddr, FIELD, readPoseRaw, RemoteCars } from '../game/daytona.js';

export const PUPPET_SLOT = 38;          // auto de la IA que representa al otro jugador (en ambas instancias)
export const SEND_HZ = 20;
export const INTERP_DELAY_MS = 150;     // se muestra el estado remoto de hace 150 ms, interpolado (tolera 1-2 paquetes perdidos)
export const STALE_MS = 1500, DISCONNECT_MS = 5000;

const FX = 65536;
const wrapAng = (a) => ((a % 65536) + 65536) % 65536;
function lerpAng(a, b, t) { let d = ((b - a + 32768) % 65536 + 65536) % 65536 - 32768; return wrapAng(Math.round(a + d * t)); }
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// Lo que se transmite (enteros crudos del juego: exacto y compacto)
export function captureLocal(mem) {
  const p = readPoseRaw(mem, 0);
  const a = carAddr(0);
  return { ...p, rank: (mem.r32(a + FIELD.rank) | 0) + 1 };
}

// Búfer de estados remotos: orden por secuencia, descarte de viejos/duplicados, interpolación por tiempo
export class RemoteTrack {
  constructor() { this.buf = []; this.lastSeq = -1; this.dropped = 0; this.received = 0; this.lastArrival = 0; }
  push(msg, arrival) {
    this.received++;
    this.lastArrival = arrival;
    const b = this.buf;
    if (msg.seq > this.lastSeq) { this.lastSeq = msg.seq; b.push(msg); }
    else {
      // llegó desordenado: si todavía cae dentro del búfer se inserta en su lugar; si es duplicado o muy viejo, se descarta
      if (!b.length || msg.seq < b[0].seq || b.some((m) => m.seq === msg.seq)) { this.dropped++; return false; }
      let i = b.length; while (i > 0 && b[i - 1].seq > msg.seq) i--;
      b.splice(i, 0, msg); this.reordered = (this.reordered || 0) + 1;
    }
    if (b.length > 64) b.splice(0, b.length - 64);
    return true;
  }
  // estado en el instante `t` (tiempo del emisor): interpolación entre las dos muestras que lo rodean
  sample(t) {
    const b = this.buf;
    if (!b.length) return null;
    if (t <= b[0].t) return b[0].pose;
    for (let i = b.length - 1; i > 0; i--) {
      if (b[i - 1].t <= t && t <= b[i].t) {
        const A = b[i - 1].pose, B = b[i].pose, k = (t - b[i - 1].t) / Math.max(1, b[i].t - b[i - 1].t);
        // si entre dos muestras hubo un salto enorme (reubicación), no se interpola: se toma la nueva
        if (Math.hypot(B.x - A.x, B.z - A.z) / FX > 60) return B;
        return {
          ...B, x: lerp(A.x, B.x, k), y: lerp(A.y, B.y, k), z: lerp(A.z, B.z, k),
          yaw: lerpAng(A.yaw, B.yaw, k), pitch: lerpAng(A.pitch, B.pitch, k), roll: lerpAng(A.roll, B.roll, k), travel: lerpAng(A.travel, B.travel, k),
          speed: lerp(A.speed, B.speed, k), kmh: lerp(A.kmh, B.kmh, k),
        };
      }
    }
    // sin muestra más nueva (paquete tarde o perdido): extrapolación lineal corta (≤ 120 ms) y después se mantiene
    const L = b[b.length - 1];
    if (b.length >= 2) {
      const P = b[b.length - 2], dt = L.t - P.t, ahead = Math.min(t - L.t, 120);
      if (dt > 0 && ahead > 0 && Math.hypot(L.pose.x - P.pose.x, L.pose.z - P.pose.z) / FX < 60) {
        const k = ahead / dt;
        return { ...L.pose, x: Math.round(L.pose.x + (L.pose.x - P.pose.x) * k), y: Math.round(L.pose.y + (L.pose.y - P.pose.y) * k), z: Math.round(L.pose.z + (L.pose.z - P.pose.z) * k) };
      }
    }
    return L.pose;
  }
}

// Suavizado de correcciones: cuando llega un paquete que corrige lo que se estaba extrapolando (o interpolando
// con datos incompletos), la diferencia no se aplica de golpe sino que se reparte en ~150 ms. La salida es
// continua: lo que cambia es la estimación del pasado, y esa diferencia se descuenta progresivamente.
const angDiff = (a, b) => ((a - b + 32768) % 65536 + 65536) % 65536 - 32768;
export class SmoothedTrack {
  constructor(track, tauMs = 150) { this.track = track; this.tau = tauMs; this.prev = null; this.off = { x: 0, y: 0, z: 0, yaw: 0, travel: 0 }; }
  reset() { this.prev = null; for (const k in this.off) this.off[k] = 0; }
  sample(t) {
    const raw = this.track.sample(t);
    if (!raw) return null;
    const o = this.off, p = this.prev;
    if (p && t !== p.t) {
      const again = this.track.sample(p.t);           // nueva estimación del instante anterior
      const k = Math.exp(-Math.abs(t - p.t) / this.tau);
      const dx = p.raw.x - again.x, dy = p.raw.y - again.y, dz = p.raw.z - again.z;
      if (Math.hypot(raw.x - p.raw.x, raw.z - p.raw.z) / FX > 60 || Math.hypot(dx, dz) / FX > 60) this.reset(); // reubicación real: sin suavizar
      else {
        o.x = o.x * k + dx; o.y = o.y * k + dy; o.z = o.z * k + dz;
        o.yaw = o.yaw * k + angDiff(p.raw.yaw, again.yaw); o.travel = o.travel * k + angDiff(p.raw.travel, again.travel);
      }
    }
    if (!p || t !== p.t) this.prev = { t, raw };
    return { ...raw, x: Math.round(raw.x + o.x), y: Math.round(raw.y + o.y), z: Math.round(raw.z + o.z),
      yaw: wrapAng(Math.round(raw.yaw + o.yaw)), travel: wrapAng(Math.round(raw.travel + o.travel)) };
  }
}

// El J2 larga desde el lugar del auto PUPPET_SLOT de la grilla (y ese auto pasa a representar al J1)
export function swapStartWithPuppet(mem) {
  const a0 = carAddr(0), aP = carAddr(PUPPET_SLOT);
  for (const f of [FIELD.x, FIELD.y, FIELD.z, FIELD.yaw, FIELD.pitch, FIELD.roll, FIELD.travelDir, FIELD.segment]) {
    const v0 = mem.r32(a0 + f), vP = mem.r32(aP + f);
    mem.w32(a0 + f, vP); mem.w32(aP + f, v0);
  }
}

// Sesión de juego en red (transporte inyectado: BroadcastChannel en el navegador, canal en memoria en las pruebas)
export class CarSync {
  constructor({ emu, transport, playerId, slotRole, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { emu, transport, playerId, role: slotRole, now, log });
    this.seq = 0; this.track = new RemoteTrack(); this.remoteId = null;
    this.lastSend = 0; this.status = 'esperando'; this.remoteRace = null; this.sent = 0;
    // cada pose se marca con el instante del cuadro del juego que la produjo (no con el del envío)
    this.frameTime = 0; this.frameSeq = 0; this.sentFrame = -1;
    // la pose se toma en el mismo instante en que el juego presenta el cuadro: así pose y marca de tiempo
    // corresponden exactamente (si se leyera más tarde podría incluir ticks del cuadro siguiente, aún no mostrado)
    this.framePose = null;
    emu.onPresent = () => { this.frameTime = this.now(); this.framePose = captureLocal(emu.mem); this.frameSeq++; };
    this.remote = new RemoteCars(emu);
    this.active = false;
    // la pose se calcula cuando el juego la necesita (cada tick de lógica y cada render)
    this.smooth = new SmoothedTrack(this.track);
    this.poseNow = () => this.smooth.sample(this.now() - INTERP_DELAY_MS);
  }
  onMessage(msg) {
    if (msg.type !== 'state' || msg.id === this.playerId) return;
    if (this.remoteId && msg.id !== this.remoteId) return; // identidad estable: sólo el compañero de sesión
    this.remoteId = msg.id;
    this.track.push(msg, this.now());
    this.remoteRace = { lap: msg.pose.lap, rank: msg.pose.rank, kmh: msg.pose.kmh, seg: msg.pose.seg };
  }
  // llamar seguido (cada cuadro del navegador o del juego)
  tick() {
    const t = this.now(), mem = this.emu.mem;
    // envía como máximo SEND_HZ por segundo, sólo si hubo un cuadro nuevo (o cada 500 ms para mantener viva la conexión)
    const fresh = this.frameSeq !== this.sentFrame;
    if ((fresh && t - this.lastSend >= 1000 / SEND_HZ - 1) || t - this.lastSend >= 500) {
      this.lastSend = t; this.sentFrame = this.frameSeq;
      this.transport.send({ type: 'state', id: this.playerId, role: this.role, seq: ++this.seq, t: this.framePose ? this.frameTime : t, pose: this.framePose || captureLocal(mem) });
      this.sent++;
    }
    const age = this.track.lastArrival ? t - this.track.lastArrival : Infinity;
    if (age > DISCONNECT_MS) {
      if (this.active) { this.remote.release(PUPPET_SLOT); this.active = false; this.smooth.reset(); this.log('[MP] el otro jugador se desconectó: su auto vuelve a la IA'); }
      this.status = this.track.received ? 'desconectado' : 'esperando';
      return;
    }
    this.status = age > STALE_MS ? 'sin señal' : 'conectado';
    if (!this.active && this.track.buf.length) { this.remote.set(PUPPET_SLOT, this.poseNow); this.active = true; }
  }
  get applied() { return this.active; }
  stop() { this.remote.dispose(); this.active = false; }
}
