#!/usr/bin/env node
// Arma dist/ con sólo lo que se publica (Netlify: command = "node tools/build-site.mjs", publish = "dist").
// Así node_modules, tests y herramientas no quedan expuestos en el sitio.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true }); fs.mkdirSync(dist);
const copy = (rel) => { const s = path.join(root, rel); if (fs.existsSync(s)) { fs.cpSync(s, path.join(dist, rel), { recursive: true }); console.log('copiado', rel); } };
for (const rel of ['index.html', 'web', 'src', 'game']) copy(rel);
if (!fs.existsSync(path.join(dist, 'game', 'manifest.json')) && fs.existsSync(path.join(dist, 'game'))) {
  const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(path.join(dist, 'game'), p).split(path.sep).join('/')); } })(path.join(dist, 'game'));
  fs.writeFileSync(path.join(dist, 'game', 'manifest.json'), JSON.stringify({ files }, null, 1)); console.log('manifest.json generado');
}
console.log('dist/ listo');
