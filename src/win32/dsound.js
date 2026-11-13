// dsound.js — DirectSound como COM; el audio real lo hace el host (Web Audio en Chrome).
import { api } from './common.js';
import { newObj, comCommon } from './ddraw.js';

const DS_OK = 0;
const IDS = ['QueryInterface', 'AddRef', 'Release', 'CreateSoundBuffer', 'GetCaps', 'DuplicateSoundBuffer', 'SetCooperativeLevel', 'Compact', 'GetSpeakerConfig', 'SetSpeakerConfig', 'Initialize'];
const IDSB = ['QueryInterface', 'AddRef', 'Release', 'GetCaps', 'GetCurrentPosition', 'GetFormat', 'GetVolume', 'GetPan', 'GetFrequency', 'GetStatus', 'Initialize', 'Lock', 'Play', 'SetCurrentPosition', 'SetFormat', 'SetVolume', 'SetPan', 'SetFrequency', 'Stop', 'Unlock', 'Restore'];
const nowMs = (emu) => emu.nowMs();

function readWfx(emu, p) {
  const m = emu.mem;
  return { tag: m.r16(p), channels: m.r16(p + 2), rate: m.r32(p + 4), avg: m.r32(p + 8), align: m.r16(p + 12), bits: m.r16(p + 14) };
}
function position(emu, o) {
  if (!o.playing || !o.size) return o.pos || 0;
  // la reproducción avanza a la frecuencia fijada con SetFrequency (si la hay), no a la del formato del búfer
  const bytes = Math.floor((nowMs(emu) - o.startMs) / 1000 * (o.freq || o.fmt.rate) * o.fmt.align);
  return o.loop ? (o.startPos + bytes) % o.size : Math.min(o.size, o.startPos + bytes);
}
function snapshot(emu, o) { return emu.mem.u8.slice(o.mem, o.mem + o.size); }

const bufImpl = {
  ...comCommon,
  GetCaps: [1, (emu, o, self, p) => { emu.mem.w32(p + 4, o.flags); emu.mem.w32(p + 8, o.size); return DS_OK; }],
  GetFormat: [3, (emu, o, self, p, n, pw) => { const f = o.fmt; const m = emu.mem; if (p) { m.w16(p, f.tag); m.w16(p + 2, f.channels); m.w32(p + 4, f.rate); m.w32(p + 8, f.avg); m.w16(p + 12, f.align); m.w16(p + 14, f.bits); } if (pw) m.w32(pw, 18); return DS_OK; }],
  SetFormat: [1, (emu, o, self, p) => { o.fmt = readWfx(emu, p); emu.log('DSOUND', `primario SetFormat ${o.fmt.rate}Hz ${o.fmt.bits}bit ${o.fmt.channels}ch`); return DS_OK; }],
  GetCurrentPosition: [2, (emu, o, self, pPlay, pWrite) => { const p = position(emu, o); if (pPlay) emu.mem.w32(pPlay, p); if (pWrite) emu.mem.w32(pWrite, (p + o.fmt.align * 64) % Math.max(1, o.size)); return DS_OK; }],
  SetCurrentPosition: [1, (emu, o, self, p) => { o.pos = p; return DS_OK; }],
  GetStatus: [1, (emu, o, self, p) => { const playing = o.playing && (o.loop || position(emu, o) < o.size); if (!playing) o.playing = false; emu.mem.w32(p, (playing ? 1 : 0) | (playing && o.loop ? 4 : 0)); return DS_OK; }],
  GetVolume: [1, (emu, o, self, p) => { emu.mem.w32(p, o.vol); return DS_OK; }],
  GetPan: [1, (emu, o, self, p) => { emu.mem.w32(p, o.pan); return DS_OK; }],
  GetFrequency: [1, (emu, o, self, p) => { emu.mem.w32(p, o.freq || o.fmt.rate); return DS_OK; }],
  SetVolume: [1, (emu, o, self, v) => { o.vol = v | 0; emu.host.audio?.setVolume(o.id, o.vol); return DS_OK; }],
  SetPan: [1, (emu, o, self, v) => { o.pan = v | 0; emu.host.audio?.setPan(o.id, o.pan); return DS_OK; }],
  SetFrequency: [1, (emu, o, self, v) => {
    if (o.playing && o.size) { o.startPos = position(emu, o); o.startMs = nowMs(emu); } // la posición sigue continua al cambiar la velocidad
    o.freq = v >>> 0 || 0; emu.host.audio?.setRate(o.id, o.freq || o.fmt.rate); return DS_OK; }],
  Lock: [7, (emu, o, self, off, n, p1, l1, p2, l2, flags) => {
    const m = emu.mem;
    if (!o.size) return 0x88780032; // DSERR_INVALIDCALL en primario
    if (flags & 2) { off = 0; n = o.size; }
    if (flags & 1) off = (position(emu, o) + o.fmt.align * 64) % o.size;
    const first = Math.min(n, o.size - off);
    m.w32(p1, o.mem + off); m.w32(l1, first);
    if (p2) m.w32(p2, first < n ? o.mem : 0);
    if (l2) m.w32(l2, n - first);
    return DS_OK;
  }],
  Unlock: [4, (emu, o) => { if (o.playing) emu.host.audio?.update(o.id, snapshot(emu, o)); return DS_OK; }],
  Play: [3, (emu, o, self, r1, r2, flags) => {
    if (!o.size) { o.playing = true; return DS_OK; }
    o.playing = true; o.loop = !!(flags & 1); o.startMs = nowMs(emu); o.startPos = o.pos || 0;
    emu.state.ds.plays++;
    if (emu.state.ds.plays <= 5) emu.log('DSOUND', `Play buffer#${o.id} ${o.size} bytes ${o.fmt.rate}Hz/${o.fmt.bits}bit/${o.fmt.channels}ch${o.loop ? ' LOOP' : ''}`);
    emu.host.audio?.play(o.id, snapshot(emu, o), o.fmt, o.loop, o.vol, o.pan, o.startPos, o.freq || o.fmt.rate);
    return DS_OK;
  }],
  Stop: [0, (emu, o) => { o.pos = position(emu, o); o.playing = false; emu.host.audio?.stop(o.id); return DS_OK; }],
  Restore: [0, () => DS_OK],
};

function makeBuffer(emu, desc, dup) {
  const m = emu.mem, s = emu.state.ds;
  const flags = dup ? dup.flags : m.r32(desc + 4);
  const size = dup ? dup.size : m.r32(desc + 8);
  const pf = dup ? 0 : m.r32(desc + 16);
  const fmt = dup ? dup.fmt : pf ? readWfx(emu, pf) : { tag: 1, channels: 2, rate: 22050, avg: 88200, align: 4, bits: 16 };
  const o = { id: ++s.nextId, flags, size, fmt, mem: dup ? dup.mem : (size ? m.alloc(size) : 0), vol: 0, pan: 0, pos: 0, playing: false, freq: dup ? dup.freq || 0 : 0 };
  if (fmt.tag !== 1) emu.log('DSOUND', `ADVERTENCIA: formato WAVE tag=${fmt.tag} (no PCM) — necesitará MSACM`);
  return o;
}

const dsImpl = {
  ...comCommon,
  SetCooperativeLevel: [2, () => DS_OK],
  GetCaps: [1, (emu, o, self, p) => { const n = emu.mem.r32(p) || 96; emu.mem.fill(p + 4, 0, n - 4); emu.mem.w32(p + 4, 0x1 | 0x4 | 0x10 | 0x20 | 0x100 | 0x400); emu.mem.w32(p + 8, 100); emu.mem.w32(p + 12, 100000); return DS_OK; }],
  GetSpeakerConfig: [1, (emu, o, self, p) => { emu.mem.w32(p, 4); return DS_OK; }],
  SetSpeakerConfig: [1, () => DS_OK], Compact: [0, () => DS_OK],
  CreateSoundBuffer: [3, (emu, o, self, desc, pp) => {
    const b = makeBuffer(emu, desc);
    const p = newObj(emu, 'IDirectSoundBuffer', IDSB, bufImpl, b);
    if (emu.state.ds.nextId <= 12) emu.log('DSOUND', `CreateSoundBuffer#${b.id} flags=${b.flags.toString(16)} ${b.size ? b.size + ' bytes' : 'PRIMARIO'} ${b.fmt.rate}Hz/${b.fmt.bits}bit/${b.fmt.channels}ch`);
    emu.mem.w32(pp, p); return DS_OK;
  }],
  DuplicateSoundBuffer: [2, (emu, o, self, src, pp) => {
    const so = emu.state.dd.objs.get(src); const b = makeBuffer(emu, 0, so);
    emu.mem.w32(pp, newObj(emu, 'IDirectSoundBuffer', IDSB, bufImpl, b)); return DS_OK;
  }],
};

const DS = {
  __init(emu) { emu.state.ds = { nextId: 0, plays: 0 }; },
  DirectSoundCreate: api(3, (emu, guid, pp) => {
    const p = newObj(emu, 'IDirectSound', IDS, dsImpl, {});
    emu.mem.w32(pp, p);
    emu.log('DSOUND', `DirectSoundCreate -> IDirectSound en ${p.toString(16)} (salida: ${emu.host.audio ? 'Web Audio' : 'sin audio en este host'})`);
    return DS_OK;
  }),
  DirectSoundEnumerateA: api(2, (emu, cb, ctx) => { emu.callGuest(cb, [0, emu.sysString('Primary Sound Driver'), emu.sysString(''), ctx]); return DS_OK; }),
};
export default DS;
