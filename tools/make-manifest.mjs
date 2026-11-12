// node tools/make-manifest.mjs <carpeta_del_juego>  -> escribe manifest.json (para ?manifest=)
import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[2]; const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name !== 'manifest.json') files.push(path.relative(dir, p).split(path.sep).join('/')); } })(dir);
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ files }, null, 1));
console.log(`${files.length} archivos -> ${path.join(dir, 'manifest.json')}`);
