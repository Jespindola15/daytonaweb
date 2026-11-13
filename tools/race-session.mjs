// race-session.mjs — lleva DAYTONA.EXE (determinista, reloj virtual) hasta una carrera y expone
// helpers para investigar la memoria. Usado por las herramientas de ingeniería inversa y las pruebas.
import fs from 'node:fs';
import path from 'node:path';
import { Emulator } from '../src/emulator.js';

export const DATA_START = 0x481000, DATA_END = 0x481000 + 0xd56190;
// Secuencia: demo -> título -> Mode Select (ARCADE) -> Circuit Select (BEGINNER) -> caja -> largada
export const TO_RACE_KEYS = [[7000, 0x0d], [10000, 0x0d], [13000, 0x0d], [16000, 0x0d], [19000, 0x0d], [22000, 0x0d]];

export function createSession(gameDir, { log = () => {}, keys = TO_RACE_KEYS } = {}) {
  const frames = [];
  const host = { deferPresent: true, present() {}, audio: null };
  const emu = new Emulator({ log, host });
  emu.traceApis = false;
  emu.logFiles = false;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(gameDir)) emu.vfs.add(path.relative(gameDir, f).split(path.sep).join('\\'), new Uint8Array(fs.readFileSync(f)));
  emu.loadMain(emu.vfs.find('DAYTONA.EXE').data, 'DAYTONA.EXE');
  const sched = keys.flatMap(([ms, vk]) => [{ ms, vk, down: true }, { ms: ms + 300, vk, down: false }]);
  const gameMs = () => emu.nowMs() - 10000;
  // ejecuta hasta que el juego presente `n` cuadros más (o hasta msLimit de juego)
  function frames_(n, onFrame) {
    const target = emu.state.dd.frames + n;
    while (emu.state.dd.frames < target) {
      for (const k of sched) if (!k.done && gameMs() >= k.ms) { k.done = true; emu.keyEvent(k.vk, k.down); }
      const before = emu.state.dd.frames;
      const r = emu.run(200_000);
      if (r.status === 'halted' || r.status === 'exited') throw new Error(`emulador: ${r.status} ${r.report?.message || ''}`);
      if (emu.state.dd.frames !== before && onFrame) onFrame(emu.state.dd.frames);
    }
  }
  function untilMs(ms) { while (gameMs() < ms) { for (const k of sched) if (!k.done && gameMs() >= k.ms) { k.done = true; emu.keyEvent(k.vk, k.down); } const r = emu.run(500_000); if (r.status === 'halted' || r.status === 'exited') throw new Error(`emulador: ${r.status} ${r.report?.message || ''}`); } }
  const key = (vk, down) => emu.keyEvent(vk, down);
  const snapshot = () => emu.mem.u8.slice(DATA_START, DATA_END);
  const screen = () => { emu.scanout(); return emu.state.dd.rgba ? { rgba: emu.state.dd.rgba.slice(), w: emu.state.dd.primary.w, h: emu.state.dd.primary.h } : null; };
  return { emu, frames: frames_, untilMs, gameMs, key, snapshot, screen };
}
