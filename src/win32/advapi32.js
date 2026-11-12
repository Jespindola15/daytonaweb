// advapi32.js — registro: todas las claves "no existen" (el juego debe usar valores por defecto)
import { api } from './common.js';
const R = {
  RegOpenKeyExA: api(5, (emu, k, p) => { emu.note(`"${p ? emu.mem.cstr(p) : ''}" (no existe)`); return 2; }),
  RegOpenKeyA: api(3, () => 2),
  RegCreateKeyExA: api(9, (emu, k, p, r, c, o, s, sa, ph) => { if (ph) emu.mem.w32(ph, 0x9000); return 0; }),
  RegQueryValueExA: api(6, () => 2), RegSetValueExA: api(6, () => 0),
  RegCloseKey: api(1, () => 0),
};
export default R;
