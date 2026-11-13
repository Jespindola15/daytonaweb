// Prueba del servidor de salas de Cloudflare (Worker + Durable Objects) con clientes WebSocket reales.
//   cd cloudflare && npx wrangler dev --port 8787        (runtime local de Cloudflare: workerd)
//   URL=http://127.0.0.1:8787 node tests/salas_cf_test.mjs
const BASE = process.env.URL || 'http://127.0.0.1:8787';
const WS = BASE.replace(/^http/, 'ws');
let ok = 0, bad = 0; const lines = [];
const check = (n, c, x = '') => { c ? ok++ : bad++; const l = `${c ? 'OK ' : 'ERR'} ${n}${x ? '  ' + x : ''}`; console.log(l); lines.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cliente(codigo, id, nombre) {
  const c = { id, nombre, msgs: [], autos: 0, ws: new WebSocket(`${WS}/api/salas/${codigo}/ws`) };
  c.abierto = new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = rej; });
  c.cerrado = new Promise((res) => { c.ws.onclose = (e) => res(e.code); });
  c.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'auto') c.autos++; else c.msgs.push(m); };
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.ultimo = (t) => [...c.msgs].reverse().find((m) => m.t === t);
  c.espera = async (t, pred = () => true, ms = 4000) => { const t0 = Date.now(); for (;;) { const m = c.msgs.find((x) => x.t === t && pred(x)); if (m) return m; if (Date.now() - t0 > ms) throw new Error(`${id}: no llegó ${t}`); await sleep(20); } };
  return c;
}

const r = await (await fetch(`${BASE}/api/salas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nombre: 'Prueba 6', max: 6 }) })).json();
check('1. crear sala (2 a 6 jugadores)', /^[A-Z2-9]{4}$/.test(r.codigo) && r.max === 6, JSON.stringify(r));
const lista = await (await fetch(`${BASE}/api/salas`)).json();
check('2. la sala aparece en la lista', lista.salas.some((s) => s.codigo === r.codigo));

const C = [];
for (let i = 0; i < 6; i++) { const c = cliente(r.codigo, `id-${i}`, `Piloto ${i + 1}`); await c.abierto; c.send({ t: 'hola', id: c.id, nombre: c.nombre }); await c.espera('bienvenida'); C.push(c); }
const idxs = C.map((c) => c.ultimo('bienvenida').yo.idx);
check('3. seis jugadores con lugares 0..5 distintos', new Set(idxs).size === 6 && Math.max(...idxs) === 5, `(lugares ${idxs.join(',')})`);
const extra = cliente(r.codigo, 'id-extra', 'Séptimo'); await extra.abierto; extra.send({ t: 'hola', id: extra.id, nombre: extra.nombre });
const codeExtra = await extra.cerrado;
check('4. el séptimo es rechazado (sala llena)', codeExtra === 4001 && extra.msgs.some((m) => m.t === 'error'), `(cierre ${codeExtra}: ${extra.msgs.find((m) => m.t === 'error')?.error})`);
await sleep(300);
const est = C[3].ultimo('estado');
check('5. todos ven la lista completa y quién es el anfitrión', est.jugadores.length === 6 && est.sala.anfitrion === 'id-0');

// sólo el anfitrión larga
C[2].send({ t: 'largar' }); const err = await C[2].espera('error');
check('6. un jugador que no es anfitrión no puede largar', /anfitrión/.test(err.error));
C[0].send({ t: 'largar' });
const larg = await Promise.all(C.map((c) => c.espera('largar')));
check('7. «largar» llega a los seis con la lista de participantes', larg.every((m) => m.jugadores.length === 6 && m.carrera === 1));
// cinco llegan a la grilla: todavía no hay largada; con el sexto, sí
for (const c of C.slice(0, 5)) c.send({ t: 'fase', fase: 'grilla', carrera: 1 });
await sleep(400);
const goAntes = C.some((c) => c.msgs.some((m) => m.t === 'go'));
const t0 = Date.now(); C[5].send({ t: 'fase', fase: 'grilla', carrera: 1 });
const gos = await Promise.all(C.map((c) => c.espera('go')));
check('8. la largada se da cuando los seis están en la grilla, con la misma hora para todos', !goAntes && gos.every((g) => g.at === gos[0].at) && gos[0].at - t0 > 1000 && gos[0].at - t0 < 2500, `(go en +${gos[0].at - t0} ms)`);

// estados de los autos: 6 jugadores × 20 por segundo durante 1 s
for (let k = 0; k < 20; k++) { for (const c of C) c.send({ t: 'auto', m: { type: 'state', id: c.id, idx: 0, seq: k, t: Date.now(), pose: { x: k } } }); await sleep(50); }
await sleep(500);
const recib = C.map((c) => c.autos);
check('9. reenvío de autos: cada jugador recibe los de los otros cinco (y no los propios)', recib.every((n) => n === 100), `(recibidos ${recib.join(',')}; esperado 100 = 5 × 20)`);
// latencia del reenvío
const lat = []; for (let k = 0; k < 10; k++) { const ts = Date.now(); C[0].send({ t: 'ping', c: ts }); const p = await C[0].espera('pong', (m) => m.c === ts); lat.push(Date.now() - ts); }
console.log(`   ida y vuelta al Durable Object local: ${Math.min(...lat)}–${Math.max(...lat)} ms`);

// se va el anfitrión: pasa a otro; los demás reciben «salio»
C[0].ws.close(); await C[1].espera('salio', (m) => m.id === 'id-0');
await sleep(300);
check('10. si se va el anfitrión, la sala sigue y pasa a otro jugador', C[1].ultimo('estado').sala.anfitrion !== 'id-0' && C[1].ultimo('estado').jugadores.length === 5);
// reconexión del jugador 3 con el mismo id: conserva su lugar
const lugar3 = C[3].ultimo('bienvenida').yo.idx;
const re3 = cliente(r.codigo, 'id-3', 'Piloto 4'); await re3.abierto; re3.send({ t: 'hola', id: 'id-3', nombre: 'Piloto 4' }); const b = await re3.espera('bienvenida');
const codeOld = await C[3].cerrado;
check('11. reconexión con el mismo id: conserva el lugar y reemplaza la conexión vieja', b.yo.idx === lugar3 && codeOld === 4000, `(lugar ${b.yo.idx}; conexión vieja cerrada con ${codeOld})`);
// un jugador nuevo no puede entrar con la carrera en curso
const late = cliente(r.codigo, 'id-tarde', 'Tarde'); await late.abierto; late.send({ t: 'hola', id: late.id, nombre: late.nombre });
check('12. no se puede entrar con la carrera en curso', (await late.cerrado) === 4002);
for (const c of [...C.slice(1), re3]) try { c.ws.close(); } catch {}
await sleep(500);
const info = await (await fetch(`${BASE}/api/salas/${r.codigo}`)).json();
check('13. al irse todos, la sala queda vacía y vuelve a «sala»', info.jugadores.length === 0 && info.estado === 'sala', JSON.stringify({ j: info.jugadores.length, e: info.estado }));
console.log(`RESULTADO ${ok}/${ok + bad}`);
lines.push(`RESULTADO ${ok}/${ok + bad}`);
if (process.env.OUT) (await import('node:fs')).writeFileSync(process.env.OUT, lines.join('\n') + '\n');
process.exit(bad ? 1 : 0);
