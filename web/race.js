// race.js — largada coordinada de una carrera multijugador (común al modo local y al online).
//
// 1. start(índice): reinicia el juego y recorre el menú solo (Arcade → Beginner → Automática) con Enter.
// 2. En el primer tick de autos de la carrera (0x447C40, después del menú) el juego se DETIENE en la grilla:
//    cada jugador toma su lugar (swapStartForPlayer) y se avisa con onGrid().
// 3. go(horaLocal): a esa hora todos siguen a la vez y empieza la sincronización de autos (CarSync).
// Si el menú automático fallara, se puede navegar a mano: la barrera igual detiene el juego al empezar la carrera.
import { CarSync, swapStartForPlayer } from '../src/net/multiplayer.js';

const MENU_ENTER_MS = [2500, 5500, 8500, 11500, 14500, 17500];   // desde el primer cuadro del juego
const ARM_BARRIER_AFTER = 17900;                                  // la vista previa de Mission Select no cuenta
const RACE_LOOP = 0x447c40;

export function createRaceDriver({ getEmu, reboot, log = () => {} }) {
  const R = { phase: 'idle', index: 0, goAt: 0, sync: null, firstFrameAt: 0, sent: new Set(), armed: false, atGrid: false, onGrid: null, hookEmu: null };
  function disarm() { if (R.hookEmu) { R.hookEmu.removeHook(RACE_LOOP); R.hookEmu = null; } R.armed = false; }
  function stop() { R.sync?.stop(); R.sync = null; disarm(); R.phase = 'idle'; R.goAt = 0; }
  function start(index, { onGrid } = {}) {
    stop();
    Object.assign(R, { phase: 'menu', index, goAt: 0, firstFrameAt: 0, atGrid: false, sent: new Set(), onGrid });
    reboot();
    const emu = getEmu();
    R.hookEmu = emu;
    emu.addHook(RACE_LOOP, () => { if (R.armed && !R.atGrid) { R.atGrid = true; grid(); } return true; });
    log(`[CARRERA] reinicio del juego para la largada (jugador ${index + 1})`);
  }
  function grid() {
    swapStartForPlayer(getEmu().mem, R.index);   // cada jugador larga desde su lugar de la grilla
    R.phase = 'grid';
    log(`[CARRERA] jugador ${R.index + 1} en la grilla: esperando la largada`);
    R.onGrid?.();
  }
  function go(localAt) { R.goAt = localAt; }
  // llamado en cada cuadro del navegador. Devuelve true si el juego debe quedar detenido (en la grilla).
  function frame(makeSync) {
    const emu = getEmu(); if (!emu) return false;
    if (R.phase === 'menu') {
      if (!R.firstFrameAt && emu.state.dd.frames > 2) R.firstFrameAt = performance.now();
      if (R.firstFrameAt) {
        const since = performance.now() - R.firstFrameAt;
        MENU_ENTER_MS.forEach((ms, i) => {
          if (since >= ms && !R.sent.has(`d${i}`)) { R.sent.add(`d${i}`); emu.keyEvent(0x0d, true); }
          if (since >= ms + 250 && !R.sent.has(`u${i}`)) { R.sent.add(`u${i}`); emu.keyEvent(0x0d, false); }
        });
        if (since >= ARM_BARRIER_AFTER) R.armed = true;
      }
      return false;
    }
    if (R.phase === 'grid') {
      if (R.goAt && Date.now() >= R.goAt) { R.phase = 'race'; disarm(); R.sync = makeSync(); log('[CARRERA] ¡largada! sincronizando autos'); return false; }
      return true;
    }
    if (R.phase === 'race' && R.sync) R.sync.tick();
    return false;
  }
  const makeCarSync = ({ transport, playerId, now = () => Date.now() }) => new CarSync({ emu: getEmu(), transport, playerId, playerIndex: R.index, now, log });
  return { state: R, start, stop, go, frame, makeCarSync, get holding() { return R.phase === 'grid'; } };
}
