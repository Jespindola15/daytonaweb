// pe.js — Parser PE32 (sin dependencias, funciona en Chrome y Node)
export class PEError extends Error {}

const dec = new TextDecoder('latin1');

export function parsePE(bytes, name = 'image') {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  if (u16(0) !== 0x5a4d) throw new PEError(`${name}: falta firma MZ`);
  const peOff = u32(0x3c);
  if (u32(peOff) !== 0x4550) throw new PEError(`${name}: falta firma PE\\0\\0 en 0x${peOff.toString(16)}`);
  const coff = peOff + 4;
  const machine = u16(coff);
  if (machine !== 0x14c) throw new PEError(`${name}: Machine=0x${machine.toString(16)} (se esperaba 0x14c i386)`);
  const nSections = u16(coff + 2);
  const timeDateStamp = u32(coff + 4);
  const sizeOptHdr = u16(coff + 16);
  const characteristics = u16(coff + 18);
  const opt = coff + 20;
  const magic = u16(opt);
  if (magic !== 0x10b) throw new PEError(`${name}: OptionalHeader magic 0x${magic.toString(16)} (no es PE32)`);
  const pe = {
    name, bytes, peOff, machine, nSections, timeDateStamp, characteristics,
    linkerVersion: `${dv.getUint8(opt + 2)}.${dv.getUint8(opt + 3)}`,
    entryRVA: u32(opt + 16),
    imageBase: u32(opt + 28),
    sectionAlign: u32(opt + 32),
    fileAlign: u32(opt + 36),
    subsystemVersion: `${u16(opt + 48)}.${u16(opt + 50)}`,
    sizeOfImage: u32(opt + 56),
    sizeOfHeaders: u32(opt + 60),
    subsystem: u16(opt + 68),
    dllCharacteristics: u16(opt + 70),
    stackReserve: u32(opt + 72), stackCommit: u32(opt + 76),
    heapReserve: u32(opt + 80), heapCommit: u32(opt + 84),
    numDirs: u32(opt + 92),
    dirs: [], sections: [],
  };
  for (let i = 0; i < Math.min(pe.numDirs, 16); i++) {
    pe.dirs.push({ rva: u32(opt + 96 + i * 8), size: u32(opt + 100 + i * 8) });
  }
  const secOff = opt + sizeOptHdr;
  for (let i = 0; i < nSections; i++) {
    const o = secOff + i * 40;
    let n = '';
    for (let j = 0; j < 8 && bytes[o + j]; j++) n += String.fromCharCode(bytes[o + j]);
    pe.sections.push({
      name: n, vsize: u32(o + 8), rva: u32(o + 12), rawSize: u32(o + 16), rawPtr: u32(o + 20),
      characteristics: u32(o + 36),
    });
  }
  pe.entryFileOffset = rvaToOffset(pe, pe.entryRVA);
  return pe;
}

export function rvaToOffset(pe, rva) {
  if (rva < pe.sizeOfHeaders) return rva;
  for (const s of pe.sections) {
    const span = Math.max(s.vsize, s.rawSize);
    if (rva >= s.rva && rva < s.rva + span) {
      if (rva - s.rva >= s.rawSize) return -1; // BSS
      return s.rawPtr + (rva - s.rva);
    }
  }
  return -1;
}

function cstrAt(bytes, off) {
  let e = off;
  while (e < bytes.length && bytes[e]) e++;
  return dec.decode(bytes.subarray(off, e));
}

// Lee la tabla de importaciones desde el archivo (antes de mapear)
export function readImports(pe) {
  const d = pe.dirs[1];
  const out = [];
  if (!d || !d.rva) return out;
  const b = pe.bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = rvaToOffset(pe, d.rva);
  for (;; o += 20) {
    const ilt = dv.getUint32(o, true), nameRVA = dv.getUint32(o + 12, true), iat = dv.getUint32(o + 16, true);
    if (!ilt && !nameRVA && !iat) break;
    const dll = cstrAt(b, rvaToOffset(pe, nameRVA));
    const funcs = [];
    let t = rvaToOffset(pe, ilt || iat);
    for (let k = 0; ; k++, t += 4) {
      const v = dv.getUint32(t, true);
      if (!v) break;
      const slotRVA = iat + k * 4;
      if (v & 0x80000000) funcs.push({ ordinal: v & 0xffff, name: null, slotRVA });
      else {
        const ho = rvaToOffset(pe, v);
        funcs.push({ hint: dv.getUint16(ho, true), name: cstrAt(b, ho + 2), slotRVA });
      }
    }
    out.push({ dll, funcs });
  }
  return out;
}

export function readExports(pe) {
  const d = pe.dirs[0];
  const res = new Map();
  if (!d || !d.rva) return res;
  const b = pe.bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const o = rvaToOffset(pe, d.rva);
  const base = dv.getUint32(o + 16, true), nFuncs = dv.getUint32(o + 20, true), nNames = dv.getUint32(o + 24, true);
  const fOff = rvaToOffset(pe, dv.getUint32(o + 28, true));
  const nOff = rvaToOffset(pe, dv.getUint32(o + 32, true));
  const ordOff = rvaToOffset(pe, dv.getUint32(o + 36, true));
  for (let i = 0; i < nFuncs; i++) res.set('#' + (base + i), dv.getUint32(fOff + i * 4, true));
  for (let i = 0; i < nNames; i++) {
    const nm = cstrAt(b, rvaToOffset(pe, dv.getUint32(nOff + i * 4, true)));
    const ord = dv.getUint16(ordOff + i * 2, true);
    res.set(nm, dv.getUint32(fOff + ord * 4, true));
  }
  return res;
}

export function readRelocs(pe) {
  const d = pe.dirs[5];
  const list = [];
  if (!d || !d.rva) return list;
  const b = pe.bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = rvaToOffset(pe, d.rva);
  const end = o + d.size;
  while (o < end) {
    const page = dv.getUint32(o, true), sz = dv.getUint32(o + 4, true);
    if (!sz) break;
    for (let i = 8; i < sz; i += 2) {
      const e = dv.getUint16(o + i, true);
      const type = e >> 12;
      if (type === 3) list.push(page + (e & 0xfff));
      else if (type !== 0) list.push({ unsupported: type, rva: page + (e & 0xfff) });
    }
    o += sz;
  }
  return list;
}

// Recursos: devuelve árbol plano [{type, name, lang, rva, size}]
export function readResources(pe) {
  const d = pe.dirs[2];
  const out = [];
  if (!d || !d.rva) return out;
  const b = pe.bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const root = rvaToOffset(pe, d.rva);
  const idOrName = (v) => {
    if (v & 0x80000000) {
      const o = root + (v & 0x7fffffff);
      const len = dv.getUint16(o, true);
      let s = '';
      for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(o + 2 + i * 2, true));
      return s.toUpperCase();
    }
    return v;
  };
  const walk = (off, path) => {
    const nNamed = dv.getUint16(off + 12, true), nId = dv.getUint16(off + 14, true);
    for (let i = 0; i < nNamed + nId; i++) {
      const e = off + 16 + i * 8;
      const nm = idOrName(dv.getUint32(e, true));
      const target = dv.getUint32(e + 4, true);
      if (target & 0x80000000) walk(root + (target & 0x7fffffff), [...path, nm]);
      else {
        const de = root + target;
        out.push({ type: path[0], name: path[1], lang: nm, rva: dv.getUint32(de, true), size: dv.getUint32(de + 4, true) });
      }
    }
  };
  walk(root, []);
  return out;
}

export const SUBSYSTEMS = { 2: 'WINDOWS_GUI', 3: 'WINDOWS_CUI' };
