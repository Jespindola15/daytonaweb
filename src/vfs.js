// vfs.js — sistema de archivos virtual en memoria. Las rutas de Windows se normalizan
// a mayúsculas, sin letra de unidad: "C:\\DAYTONA\\DATA\\X.BIN" -> "DAYTONA\\DATA\\X.BIN".
export class VFS {
  constructor() { this.files = new Map(); this.cwd = ''; }
  norm(p) {
    p = String(p).replace(/\//g, '\\').toUpperCase();
    p = p.replace(/^[A-Z]:/, '');
    if (!p.startsWith('\\') && this.cwd) p = this.cwd + '\\' + p;
    const parts = [];
    for (const s of p.split('\\')) { if (!s || s === '.') continue; if (s === '..') parts.pop(); else parts.push(s); }
    return parts.join('\\');
  }
  add(path, data) { this.files.set(this.norm('\\' + path), { name: path, data }); }
  find(path) {
    const n = this.norm(path);
    if (this.files.has(n)) return this.files.get(n);
    // fallback: por nombre base (el juego puede usar rutas absolutas del CD/instalación)
    const base = n.split('\\').pop();
    for (const [k, v] of this.files) if (k.split('\\').pop() === base) return v;
    return null;
  }
  create(path) { const n = this.norm(path); const f = { name: path, data: new Uint8Array(0) }; this.files.set(n, f); return f; }
  list(pattern) {
    const n = this.norm(pattern);
    const dir = n.includes('\\') ? n.slice(0, n.lastIndexOf('\\')) : '';
    const pat = n.split('\\').pop();
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const out = [];
    for (const [k, v] of this.files) {
      const kd = k.includes('\\') ? k.slice(0, k.lastIndexOf('\\')) : '';
      const kb = k.split('\\').pop();
      if (re.test(kb) && (kd === dir || (!dir))) out.push({ name: kb, file: v });
    }
    return out;
  }
}
