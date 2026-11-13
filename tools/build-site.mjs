#!/usr/bin/env node
// Arma dist/ con sólo lo que se publica (Netlify: command = "node tools/build-site.mjs", publish = "dist").
// Así node_modules, tests y herramientas no quedan expuestos en el sitio.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --compartir: versión para compartir → dist-compartir/, con las salas online desactivadas («Próximamente»)
//   · desde la consola: `npm run build:compartir` → carpeta dist-compartir/ (para subirla a Netlify a mano)
//   · en Netlify: un segundo sitio conectado al mismo repositorio, con la variable de entorno COMPARTIR=1
//     → arma dist/ ya en modo compartir (así los dos sitios se actualizan solos con cada push)
const COMPARTIR = process.argv.includes('--compartir') || process.env.COMPARTIR === '1';
const dist = path.join(root, process.argv.includes('--compartir') ? 'dist-compartir' : 'dist');
fs.rmSync(dist, { recursive: true, force: true }); fs.mkdirSync(dist);
const copy = (rel) => { const s = path.join(root, rel); if (fs.existsSync(s)) { fs.cpSync(s, path.join(dist, rel), { recursive: true }); console.log('copiado', rel); } };
for (const rel of ['index.html', 'web', 'src', 'game']) copy(rel);
if (!fs.existsSync(path.join(dist, 'game', 'manifest.json')) && fs.existsSync(path.join(dist, 'game'))) {
  const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(path.join(dist, 'game'), p).split(path.sep).join('/')); } })(path.join(dist, 'game'));
  fs.writeFileSync(path.join(dist, 'game', 'manifest.json'), JSON.stringify({ files }, null, 1)); console.log('manifest.json generado');
}
if (COMPARTIR) {
  const cfg = path.join(dist, 'web', 'config.js');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/^export const SALAS_URL = .*;$/m, "export const SALAS_URL = '';").replace(/^export const ONLINE = .*;$/m, 'export const ONLINE = false;'));
  fs.rmSync(path.join(dist, 'web', 'lobby.js'), { force: true });   // gestor de salas viejo (Netlify): no se usa
  // Netlify (subir la carpeta tal cual o «Netlify Drop»): la raíz redirige al juego
  console.log('versión para compartir: online «Próximamente»');
}
console.log(`${path.basename(dist)}/ listo`);
