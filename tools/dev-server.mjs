#!/usr/bin/env node
// Servidor local: archivos estáticos + API de salas en memoria (misma lógica que en Netlify).
// Uso: node tools/dev-server.mjs [puerto]   ->  http://localhost:8137/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest, memoryStore } from '../server/rooms-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8137);
const store = memoryStore();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/api/rooms') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handleRequest(new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), store);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') { res.writeHead(302, { location: '/web/' }); res.end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log(`daytona-web en http://localhost:${port}/  (API de salas en memoria: /api/rooms)`));
