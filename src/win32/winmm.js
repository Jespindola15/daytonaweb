// winmm.js — temporizadores, joystick, MCI (audio CD de Daytona)
import { api } from './common.js';
const nowMs = (emu) => emu.nowMs();
const MCI = { OPEN: 0x803, CLOSE: 0x804, PLAY: 0x806, STOP: 0x808, PAUSE: 0x809, STATUS: 0x814, SET: 0x80d, SEEK: 0x807 };
const W = {
  timeGetTime: api(0, (emu) => Math.floor(nowMs(emu)) >>> 0, { quiet: true }),
  timeBeginPeriod: api(1, () => 0), timeEndPeriod: api(1, () => 0),
  timeGetDevCaps: api(2, (emu, p) => { emu.mem.w32(p, 1); emu.mem.w32(p + 4, 1000000); return 0; }),
  timeSetEvent: api(5, (emu, delay, res, proc, user, flags) => {
    emu.log('WINMM', `timeSetEvent(${delay}ms, proc=${proc.toString(16)}) — callbacks de timer multimedia: PENDIENTE (requiere hilo); no se dispararán`);
    return 1;
  }),
  timeKillEvent: api(1, () => 0),
  // Joystick: el host (Gamepad API en el navegador) deja el estado en emu.joy = { connected, x,y,z,r,u,v (0..65535),
  // buttons (bits), pov (centésimas de grado o 0xFFFF) }. Sin joystick: JOYERR_UNPLUGGED, como en Windows.
  joyGetNumDevs: api(0, () => 16),
  joyGetDevCapsA: api(3, (emu, id, p, size) => {
    const j = emu.joy;
    if (id !== 0 || !j?.connected) return 165;                 // MMSYSERR_NODRIVER / no conectado
    const m = emu.mem; m.fill(p, 0, Math.min(size || 0x194, 0x194));
    m.w16(p, 0x45e); m.w16(p + 2, 0x28e);                      // fabricante/producto (genéricos)
    const name = 'Gamepad del navegador'; for (let i = 0; i < name.length; i++) m.w8(p + 4 + i, name.charCodeAt(i));
    const o = 4 + 32;                                          // szPname[32]
    for (let k = 0; k < 3; k++) { m.w32(p + o + k * 8, 0); m.w32(p + o + k * 8 + 4, 65535); } // X,Y,Z min/max (wXmin..wZmax)
    m.w32(p + o + 24, 12);                                     // wNumButtons
    m.w32(p + o + 28, 10); m.w32(p + o + 32, 1000);            // wPeriodMin/Max
    m.w32(p + o + 36, 0); m.w32(p + o + 40, 65535); m.w32(p + o + 44, 0); m.w32(p + o + 48, 65535); m.w32(p + o + 52, 0); m.w32(p + o + 56, 65535); // R,U,V
    m.w32(p + o + 60, 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40); // wCaps: Z,R,U,V,POV,POV4DIR,POVCTS
    m.w32(p + o + 64, 6); m.w32(p + o + 68, 6); m.w32(p + o + 72, 32);   // wMaxAxes, wNumAxes, wMaxButtons
    return 0;
  }),
  joyGetPosEx: api(2, (emu, id, p) => {
    const j = emu.joy;
    if (id !== 0 || !j?.connected) return 167;                 // JOYERR_UNPLUGGED
    const m = emu.mem;
    m.w32(p + 8, j.x >>> 0); m.w32(p + 12, j.y >>> 0); m.w32(p + 16, j.z >>> 0);
    m.w32(p + 20, j.r >>> 0); m.w32(p + 24, j.u >>> 0); m.w32(p + 28, j.v >>> 0);
    m.w32(p + 32, j.buttons >>> 0);
    let n = 0; for (let b = j.buttons >>> 0; b; b &= b - 1) n++;
    m.w32(p + 36, n);                                          // dwButtonNumber (cantidad apretada)
    m.w32(p + 40, j.pov ?? 0xffff);
    emu.state.joyReads = (emu.state.joyReads || 0) + 1;
    return 0;
  }, { quiet: true }),
  joyGetPos: api(2, (emu, id, p) => {
    const j = emu.joy; if (id !== 0 || !j?.connected) return 167;
    const m = emu.mem; m.w32(p, j.x >>> 0); m.w32(p + 4, j.y >>> 0); m.w32(p + 8, j.z >>> 0); m.w32(p + 12, j.buttons & 0xf); return 0;
  }, { quiet: true }),
  waveOutGetNumDevs: api(0, () => 1),
  auxGetNumDevs: api(0, () => 1),
  auxGetVolume: api(2, (emu, d, p) => { emu.mem.w32(p, 0xffffffff); return 0; }),
  auxSetVolume: api(2, () => 0),
  mciSendCommandA: api(4, (emu, dev, msg, flags, params) => {
    const names = Object.fromEntries(Object.entries(MCI).map(([k, v]) => [v, k]));
    const m = emu.mem;
    if (msg === MCI.OPEN && params) {
      const typeP = m.r32(params + 8);
      const type = typeP < 0x10000 ? `#${typeP}` : m.cstr(typeP);
      m.w32(params + 4, 1); // wDeviceID
      emu.log('MCI', `OPEN tipo=${type} -> dispositivo 1 (CD-Audio virtual)`);
      return 0;
    }
    if (msg === MCI.PLAY && params) emu.log('MCI', `PLAY desde=${m.r32(params + 4)} hasta=${m.r32(params + 8)} (pista de CD: reproducción pendiente — mapear a OGG)`);
    if (msg === MCI.STATUS && params) {
      const item = m.r32(params + 8);
      const val = item === 3 ? 10 : item === 4 ? 0 : item === 1 ? 600000 : 0; // NUMBER_OF_TRACKS=3, MODE=4, LENGTH=1
      m.w32(params + 4, val);
    }
    emu.note(`(${names[msg] || msg.toString(16)})`);
    return 0;
  }),
  mciSendStringA: api(4, (emu, p) => { emu.log('MCI', `mciSendString("${emu.mem.cstr(p)}")`); return 0; }),
  mciGetErrorStringA: api(3, (emu, e, buf, n) => { emu.mem.writeCStr(buf, 'MCI error', n); return 1; }),
  PlaySoundA: api(3, () => 1), sndPlaySoundA: api(2, () => 1),
};
export default W;
