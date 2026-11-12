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
  joyGetNumDevs: api(0, () => 0),
  joyGetPos: api(2, () => 167), // JOYERR_UNPLUGGED
  joyGetPosEx: api(2, () => 167),
  joyGetDevCapsA: api(3, () => 165),
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
