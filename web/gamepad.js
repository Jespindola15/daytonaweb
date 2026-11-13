// gamepad.js — joysticks / mandos (Gamepad API del navegador) para Daytona USA.
//
// Dos modos (Ajustes → Mando):
//  · 'keys'   (por defecto): el mando "aprieta teclas" del juego (dirección digital, como el teclado).
//             Funciona sin reiniciar y no cambia nada del juego.
//  · 'analog' : el juego arranca con Device=PC_HANDLE en DAYTONA.INI (modo volante del juego original) y el mando
//             se le entrega como joystick de Windows (joyGetPosEx). Dirección PROPORCIONAL (eje X → -128..127,
//             medido en el EXE). En ese modo el juego usa el botón 3 para acelerar y el 6 para frenar, y deja de
//             leer el teclado para manejar (los menús siguen con teclado/Enter).
// Mapeo del mando estándar (Xbox/PlayStation en Chrome):
//   stick izq. / cruceta → dirección · RT, A → acelerar · LT, B, X → frenar · Start → Enter · Select/Back → Esc
//   Y → cambiar cámara (F5) · cruceta ↑/↓ → flechas (menús)
const VK = { LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, ACCEL: 0x58, BRAKE: 0x5a, ENTER: 0x0d, ESC: 0x1b, VIEW: 0x74 };
const DEAD = 0.12;

export function analogIni(text) { return text.replace(/Device=\w+/i, 'Device=PC_HANDLE'); }

export function createGamepadInput({ getEmu, getMode, getIndex = () => null, log = () => {} }) {
  const held = {};               // teclas que el mando tiene apretadas (para soltarlas al cambiar)
  let lastId = '', connected = false;
  const press = (emu, name, down) => { if (!!held[name] !== down) { held[name] = down; emu.keyEvent(VK[name], down); } };
  function releaseAll(emu) { for (const k of Object.keys(held)) if (held[k]) press(emu, k, false); }

  function pick() {
    const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
    const want = getIndex();
    if (want !== null && want !== undefined) return pads.find((p) => p.index === want) || null;
    return pads[0] || null;
  }
  function read(p) {
    const b = (i) => { const x = p.buttons[i]; return x ? (x.pressed || x.value > 0.3) : false; };
    let sx = p.axes[0] || 0; if (Math.abs(sx) < DEAD) sx = 0; else sx = Math.sign(sx) * (Math.abs(sx) - DEAD) / (1 - DEAD);
    const dl = b(14), dr = b(15), du = b(12), dd = b(13);
    if (dl && !dr) sx = -1; else if (dr && !dl) sx = 1;
    return { sx, accel: b(7) || b(0), brake: b(6) || b(1) || b(2), start: b(9), back: b(8), view: b(3), up: du || (p.axes[1] || 0) < -0.6, down: dd || (p.axes[1] || 0) > 0.6 };
  }
  // llamado en cada cuadro del navegador
  function poll() {
    const emu = getEmu(); if (!emu) return;
    const p = pick();
    if (!p) { if (connected) { connected = false; releaseAll(emu); if (emu.joy) emu.joy.connected = false; log('[MANDO] desconectado'); } return; }
    if (!connected || p.id !== lastId) { connected = true; lastId = p.id; log(`[MANDO] ${p.id} (índice ${p.index}, mapeo ${p.mapping || 'no estándar'})`); }
    const s = read(p);
    press(emu, 'ENTER', s.start); press(emu, 'ESC', s.back); press(emu, 'VIEW', s.view);
    press(emu, 'UP', s.up); press(emu, 'DOWN', s.down);
    if (getMode() === 'analog') {
      // joystick de Windows: eje X proporcional; botón 3 = acelerar, botón 6 = frenar (medido en el juego)
      emu.joy = { connected: true, x: Math.round(32767.5 + s.sx * 32767.5), y: 32768, z: 32768, r: 32768, u: 32768, v: 32768,
        buttons: (s.accel ? 1 << 2 : 0) | (s.brake ? 1 << 5 : 0), pov: 0xffff };
      // flechas también, para los menús (en carrera el juego no las usa en este modo)
      press(emu, 'LEFT', s.sx < -0.5); press(emu, 'RIGHT', s.sx > 0.5);
    } else {
      press(emu, 'LEFT', s.sx < -0.35); press(emu, 'RIGHT', s.sx > 0.35);
      press(emu, 'ACCEL', s.accel); press(emu, 'BRAKE', s.brake);
    }
  }
  return { poll, get connected() { return connected; }, get id() { return lastId; }, releaseAll: () => { const e = getEmu(); if (e) releaseAll(e); } };
}
