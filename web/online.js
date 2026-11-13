// online.js — salas online (2 a 6 jugadores) sobre Cloudflare: Worker + Durable Object por sala + WebSocket.
//
// Cada jugador corre su propia copia de DAYTONA.EXE. La sala (servidor) sólo coordina y reenvía:
//   lista de salas → entrar (lugar 0..5) → el anfitrión larga → todos reinician el juego y recorren el menú →
//   cada uno avisa al llegar a la grilla → la sala da una hora de largada común → durante la carrera cada uno
//   manda su auto 20 veces por segundo y ve a los demás en los autos 38, 37, 36, 35 y 34 (ver multiplayer.js).
import { SALAS_URL } from './config.js';
import { createRaceDriver } from './race.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
function stableId() {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0]?.type;
    let id = nav === 'reload' ? sessionStorage.getItem('daytona.online.id') : null;
    if (!id) { id = `o-${Math.random().toString(36).slice(2, 10)}`; sessionStorage.setItem('daytona.online.id', id); }
    return id;
  } catch { return `o-${Math.random().toString(36).slice(2, 10)}`; }
}

export function initOnline({ root, toast, getEmu, reboot, log = () => {} }) {
  const me = stableId();
  const race = createRaceDriver({ getEmu, reboot, log });
  const O = {
    base: (ls.get('daytona.salasUrl', '') || SALAS_URL || location.origin).replace(/\/+$/, ''),
    salas: [], sala: null, jugadores: [], yo: null, codigo: null, ws: null, estadoWs: 'desconectado', chat: [],
    offset: 0, bestRtt: Infinity, error: '', carrera: 0, intent: false, listT: 0, pingT: 0, retry: 0, open: false,
  };
  const serverNow = () => Date.now() + O.offset;
  const nombre = () => ls.get('daytona.name', '') || 'Piloto';

  async function api(path, opt) {
    const r = await fetch(`${O.base}/api/salas${path}`, { cache: 'no-store', ...opt });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body?.error || `Error ${r.status}`);
    return body;
  }
  async function refresh() {
    try { const r = await api(''); O.salas = r.salas; O.error = ''; } catch (e) { O.error = `No se pudo contactar el servidor de salas (${O.base}): ${e.message}`; }
    render();
  }
  async function crear(nombreSala, max) {
    try { const r = await api('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nombre: nombreSala, max }) }); entrar(r.codigo); }
    catch (e) { O.error = e.message; render(); }
  }
  function entrar(codigo) {
    salir(true);
    O.codigo = codigo; O.intent = true; O.chat = []; O.retry = 0;
    conectar();
  }
  function conectar() {
    const url = `${O.base.replace(/^http/, 'ws')}/api/salas/${O.codigo}/ws`;
    O.estadoWs = 'conectando'; render();
    const ws = new WebSocket(url); O.ws = ws;
    ws.onopen = () => { O.estadoWs = 'conectado'; O.retry = 0; ws.send(JSON.stringify({ t: 'hola', id: me, nombre: nombre() })); ping(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
    ws.onclose = (e) => {
      if (O.ws !== ws) return;
      O.ws = null; O.estadoWs = 'desconectado';
      if (e.code === 4001 || e.code === 4002) { O.intent = false; O.codigo = null; O.error = e.code === 4001 ? 'La sala está llena.' : 'La carrera ya empezó; esperá a que termine.'; render(); return; }
      if (O.intent && O.retry < 8) { const ms = Math.min(8000, 500 * 2 ** O.retry++); log(`[SALA] conexión perdida; reintento en ${ms} ms`); setTimeout(() => { if (O.intent && !O.ws) conectar(); }, ms); }
      render();
    };
  }
  const send = (m) => { if (O.ws?.readyState === 1) O.ws.send(JSON.stringify(m)); };
  function ping() { send({ t: 'ping', c: Date.now() }); }
  function salir(silent) {
    O.intent = false;
    if (O.ws) { const w = O.ws; O.ws = null; try { w.close(1000, 'salió'); } catch {} }
    if (race.state.phase !== 'idle') race.stop();
    Object.assign(O, { sala: null, jugadores: [], yo: null, codigo: null, estadoWs: 'desconectado', carrera: 0 });
    if (!silent) render();
  }

  function onMsg(m) {
    switch (m.t) {
      case 'pong': {
        const now = Date.now(), rtt = now - m.c;
        if (rtt <= O.bestRtt * 1.5 || rtt < 50) { O.bestRtt = Math.min(O.bestRtt, rtt); O.offset = m.s - (m.c + rtt / 2); }  // reloj del servidor
        O.rtt = rtt; return;
      }
      case 'auto': race.state.sync?.onMessage(m.m); return;
      case 'bienvenida': O.yo = m.yo; O.error = ''; log(`[SALA] en la sala ${O.codigo} como jugador ${m.yo.idx + 1}`); break;
      case 'estado': {
        O.sala = m.sala; O.jugadores = m.jugadores;
        const yo = m.jugadores.find((j) => j.id === me); if (yo) O.yo = yo;
        // si me reconecté en medio de una largada, retomo
        if (m.sala.estado === 'carrera' && m.sala.goAt && race.state.phase === 'grid' && !race.state.goAt) race.go(m.sala.goAt - O.offset);
        break;
      }
      case 'largar': {
        O.carrera = m.carrera;
        const yo = m.jugadores.find((j) => j.id === me);
        if (!yo) break;
        toast(`¡Largada! ${m.jugadores.length} jugadores. Reiniciando el juego…`, 3500);
        race.start(yo.idx, { onGrid: () => { send({ t: 'fase', fase: 'grilla', carrera: m.carrera }); render(); } });
        send({ t: 'fase', fase: 'menu', carrera: m.carrera });
        break;
      }
      case 'go': race.go(m.at - O.offset); log(`[SALA] largada a las ${new Date(m.at).toISOString().slice(11, 23)} (hora del servidor)`); break;
      case 'salio': race.state.sync?.drop(m.id); break;
      case 'volver': race.stop(); break;
      case 'chat': O.chat.push(m); if (O.chat.length > 60) O.chat.shift(); break;
      case 'error': O.error = m.error; toast(m.error); break;
    }
    render();
  }

  // ---- cuadro del navegador ----
  function frame() {
    const now = performance.now();
    if (O.ws && now - O.pingT > (O.bestRtt === Infinity ? 500 : 3000)) { O.pingT = now; ping(); }
    if (O.open && !O.codigo && now - O.listT > 4000) { O.listT = now; refresh(); }
    if (!O.codigo) return false;
    const before = race.state.phase;
    const hold = race.frame(() => race.makeCarSync({ playerId: me, transport: { send: (msg) => send({ t: 'auto', m: msg }) } }));
    if (race.state.phase !== before) render();
    if (race.state.phase === 'race' && now - (O.lastR || 0) > 500) { O.lastR = now; render(); }
    return hold;
  }

  // ---- interfaz ----
  const FASE = { sala: 'en la sala', menu: 'cargando…', grilla: 'en la grilla', carrera: 'corriendo' };
  let last = '';
  function render() {
    if (!O.open && !O.codigo) return;
    let h = '';
    if (!O.codigo) {
      h += `<section><label class="field">Tu nombre de piloto<input class="input" data-k="nombre" maxlength="24" value="${esc(nombre())}"></label></section>
        <section><h3>Salas abiertas</h3>${O.salas.length ? O.salas.map((s) => `<div class="room"><div><b>${esc(s.nombre)}</b> <span class="dim">${s.codigo}</span><br><span class="dim">${s.jugadores}/${s.max} jugadores · ${s.estado === 'sala' ? 'esperando' : 'en carrera'}</span></div>
          <button class="btn" data-a="entrar" data-c="${s.codigo}" ${s.estado !== 'sala' || s.jugadores >= s.max ? 'disabled' : ''}>Entrar</button></div>`).join('') : '<p class="hint">No hay salas abiertas. ¡Creá la primera!</p>'}
          <div class="row"><input class="input" data-k="codigo" maxlength="6" placeholder="Código" style="width:110px"> <button class="btn" data-a="codigo">Entrar con código</button></div></section>
        <section><h3>Crear sala</h3><label class="field">Nombre<input class="input" data-k="nsala" maxlength="32" placeholder="Sala de ${esc(nombre())}"></label>
          <label class="field">Jugadores<select data-k="max">${[2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === 4 ? 'selected' : ''}>hasta ${n}</option>`).join('')}</select></label>
          <div class="row"><button class="btn primary" data-a="crear">Crear sala</button></div></section>`;
    } else {
      const s = O.sala, soyHost = s && s.anfitrion === me, sync = race.state.sync;
      const peers = sync ? [...sync.peers.values()] : [];
      h += `<section><div class="mp-who">Sala <b>${esc(s?.nombre || O.codigo)}</b> <span class="dim">${O.codigo}</span></div>
        <div class="mp-row"><span>Conexión</span><b class="st-${O.estadoWs === 'conectado' ? 'conectado' : 'desconectado'}">${O.estadoWs}${O.rtt ? ` · ${O.rtt} ms` : ''}</b></div>
        <div class="mp-row"><span>Sos</span><b>${O.yo ? `J${O.yo.idx + 1}` : '—'}${soyHost ? ' · anfitrión' : ''}</b></div>
        <div class="mp-row"><span>Carrera</span><b>${{ idle: s?.estado === 'sala' ? 'esperando al anfitrión' : '—', menu: 'reiniciando el juego…', grid: 'en la grilla, esperando a todos', race: 'en curso' }[race.state.phase]}</b></div></section>
        <section><h3>Jugadores (${O.jugadores.length}/${s?.max || '?'})</h3>${O.jugadores.slice().sort((a, b) => a.idx - b.idx).map((j) => {
          const p = peers.find((q) => q.id === j.id);
          const extra = j.id === me ? 'vos' : p ? `${p.status}${p.race ? ` · v${p.race.lap} · ${p.race.kmh} km/h` : ''}` : (FASE[j.fase] || j.fase);
          return `<div class="mp-row"><span>J${j.idx + 1} ${esc(j.nombre)}${s?.anfitrion === j.id ? ' ★' : ''}${j.listo ? ' ✓' : ''}</span><b>${esc(extra)}</b></div>`; }).join('')}</section>`;
      if (s?.estado === 'sala') h += `<section><div class="row"><button class="btn" data-a="listo">${O.yo?.listo ? 'No estoy listo' : 'Estoy listo'}</button>
          ${soyHost ? `<button class="btn primary" data-a="largar" ${O.jugadores.length >= 2 ? '' : 'disabled'}>Largar carrera</button>` : '<span class="hint">El anfitrión (★) larga la carrera.</span>'}</div></section>`;
      else if (soyHost) h += `<section><div class="row"><button class="btn" data-a="volver">Terminar carrera (volver a la sala)</button></div></section>`;
      h += `<section><h3>Chat</h3><div class="chat">${O.chat.slice(-12).map((c) => `<div>${c.de ? `<b>${esc(c.de)}:</b> ` : '<i>'}${esc(c.texto)}${c.de ? '' : '</i>'}</div>`).join('')}</div>
        <div class="row"><input class="input" data-k="msg" maxlength="200" placeholder="Mensaje"> <button class="btn" data-a="chat">Enviar</button></div>
        <div class="row"><button class="btn" data-a="salir">Salir de la sala</button></div></section>`;
    }
    h += `<section><details><summary class="dim">Servidor de salas</summary><label class="field">URL<input class="input" data-k="base" value="${esc(O.base)}"></label><div class="row"><button class="btn" data-a="base">Guardar</button></div></details>${O.error ? `<p class="notice">${esc(O.error)}</p>` : ''}</section>`;
    if (h === last) return;
    // no pisar lo que el usuario está escribiendo
    const typing = root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    if (typing && O.lastView === (O.codigo ? 'sala' : 'lista')) return;
    last = h; O.lastView = O.codigo ? 'sala' : 'lista';
    root.innerHTML = h;
  }
  const val = (k) => root.querySelector(`[data-k="${k}"]`)?.value ?? '';
  root.addEventListener('change', (e) => { if (e.target.dataset.k === 'nombre') ls.set('daytona.name', e.target.value.trim().slice(0, 24)); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.k === 'msg') root.querySelector('[data-a="chat"]')?.click(); e.stopPropagation(); });
  root.addEventListener('focusout', () => setTimeout(render, 0));
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (val('nombre')) ls.set('daytona.name', val('nombre').trim().slice(0, 24));
    if (a === 'crear') crear(val('nsala') || `Sala de ${nombre()}`, Number(val('max')));
    else if (a === 'entrar') entrar(b.dataset.c);
    else if (a === 'codigo') { const c = val('codigo').trim().toUpperCase(); if (c) entrar(c); }
    else if (a === 'listo') send({ t: 'listo', v: !O.yo?.listo });
    else if (a === 'largar') send({ t: 'largar' });
    else if (a === 'volver') send({ t: 'volver' });
    else if (a === 'chat') { const t = val('msg').trim(); if (t) { send({ t: 'chat', texto: t }); root.querySelector('[data-k="msg"]').value = ''; } }
    else if (a === 'salir') salir();
    else if (a === 'base') { O.base = val('base').trim().replace(/\/+$/, '') || location.origin; ls.set('daytona.salasUrl', O.base); refresh(); }
    last = ''; render();
  });

  const api_ = {
    frame, state: O, race, entrar, crear, salir,
    open() { O.open = true; last = ''; if (!O.codigo) refresh(); else render(); },
    close() { O.open = false; },
    get active() { return !!O.codigo; },
  };
  window.__online = api_;   // para las pruebas automáticas
  return api_;
}
