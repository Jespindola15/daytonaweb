// worker.js — salas online de Daytona USA web en Cloudflare.
//
//   GET  /api/salas                 lista de salas abiertas
//   POST /api/salas {nombre, max}    crea una sala (2 a 6 jugadores) → {codigo}
//   GET  /api/salas/:codigo          datos de una sala
//   GET  /api/salas/:codigo/ws       WebSocket de la sala (Durable Object «Sala»)
//
// Cada sala es un Durable Object: guarda quién está (lugar 0..5, anfitrión, listo, fase), reenvía a todos los
// estados de los autos (20 por segundo por jugador), coordina la largada (todos reinician el juego, cada uno avisa
// cuando llegó a la grilla y la sala da una hora de largada común) y avisa cuando alguien se va.
// El resto de las rutas sirve el sitio (carpeta ../dist) si se publica todo junto en Cloudflare.
import { DurableObject } from 'cloudflare:workers';

const MIN_JUG = 2, MAX_JUG = 6;
const GO_DELAY_MS = 1500;            // de «todos en la grilla» a la largada (da tiempo a que llegue el aviso)
const GRID_TIMEOUT_MS = 120000;      // si alguien no llega a la grilla, se larga igual
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const CODE_RE = /^[A-Z2-9]{4,6}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Daytona USA web — salas', { status: 200 });
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
    const parts = url.pathname.split('/').filter(Boolean); // api, salas, codigo, ws
    if (parts[1] !== 'salas') return json({ error: 'ruta desconocida' }, 404);
    if (parts.length === 2) {
      if (req.method === 'GET') return json(await lobby.listar());
      if (req.method === 'POST') {
        let body = {}; try { body = await req.json(); } catch {}
        const nombre = clean(body.nombre, 32) || 'Sala';
        const max = Math.max(MIN_JUG, Math.min(MAX_JUG, Number(body.max) || 4));
        const codigo = await lobby.reservar();
        const sala = env.SALA.get(env.SALA.idFromName(codigo));
        await sala.iniciar({ codigo, nombre, max });
        await lobby.actualizar({ codigo, nombre, max, jugadores: 0, estado: 'sala' });
        return json({ codigo, nombre, max });
      }
      return json({ error: 'método no permitido' }, 405);
    }
    const codigo = String(parts[2] || '').toUpperCase();
    if (!CODE_RE.test(codigo)) return json({ error: 'código de sala inválido' }, 400);
    const sala = env.SALA.get(env.SALA.idFromName(codigo));
    if (parts[3] === 'ws') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'se esperaba WebSocket' }, 426);
      return sala.fetch(req);
    }
    const info = await sala.info();
    return info ? json(info) : json({ error: 'la sala no existe' }, 404);
  },
};

// ---------------------------------------------------------------------------------------------------------
// Lobby: índice de salas (un único Durable Object). Las salas le informan cada cambio.
export class Lobby extends DurableObject {
  async reservar() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let n = 0; n < 50; n++) {
      let c = ''; for (let i = 0; i < 4; i++) c += abc[Math.floor(Math.random() * abc.length)];
      if (!(await this.ctx.storage.get(`s:${c}`))) { await this.ctx.storage.put(`s:${c}`, { codigo: c, reservada: Date.now(), jugadores: 0, actualizada: Date.now() }); return c; }
    }
    throw new Error('no hay códigos libres');
  }
  async actualizar(r) {
    const prev = (await this.ctx.storage.get(`s:${r.codigo}`)) || {};
    if (r.borrar) { await this.ctx.storage.delete(`s:${r.codigo}`); return; }
    await this.ctx.storage.put(`s:${r.codigo}`, { ...prev, ...r, actualizada: Date.now() });
  }
  async listar() {
    const all = await this.ctx.storage.list({ prefix: 's:' });
    const now = Date.now(), salas = [];
    for (const [k, s] of all) {
      // salas vacías: se borran del índice al minuto
      if (!s.jugadores && now - (s.actualizada || 0) > 60000) { await this.ctx.storage.delete(k); continue; }
      if (s.nombre) salas.push({ codigo: s.codigo, nombre: s.nombre, jugadores: s.jugadores || 0, max: s.max, estado: s.estado });
    }
    salas.sort((a, b) => (a.estado === 'sala' ? 0 : 1) - (b.estado === 'sala' ? 0 : 1) || b.jugadores - a.jugadores);
    return { salas, ahora: now };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Sala: un Durable Object por sala. Usa la API de WebSocket con hibernación: los datos de cada jugador viajan
// adjuntos a su socket (serializeAttachment), y los de la sala en el almacenamiento del objeto.
export class Sala extends DurableObject {
  async iniciar({ codigo, nombre, max }) {
    await this.ctx.storage.put('meta', { codigo, nombre, max, estado: 'sala', carrera: 0, anfitrion: null, creada: Date.now(), goAt: 0, participantes: [] });
  }
  async meta() { return (await this.ctx.storage.get('meta')) || null; }
  async info() { const m = await this.meta(); return m && { codigo: m.codigo, nombre: m.nombre, max: m.max, estado: m.estado, jugadores: this.jugadores().map(publico) }; }
  sockets() { return this.ctx.getWebSockets(); }
  jugadores() { return this.sockets().map((ws) => ws.deserializeAttachment()).filter((a) => a && a.id); }

  async fetch(req) {
    const m = await this.meta();
    if (!m) return new Response('la sala no existe', { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({});            // todavía sin presentarse
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, msg) { try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch {} }
  broadcast(msg, except) { const s = JSON.stringify(msg); for (const ws of this.sockets()) if (ws !== except && ws.deserializeAttachment()?.id) this.send(ws, s); }
  async estado(m) {
    m ||= await this.meta();
    const jug = this.jugadores();
    this.broadcast({ t: 'estado', sala: { codigo: m.codigo, nombre: m.nombre, max: m.max, estado: m.estado, carrera: m.carrera, anfitrion: m.anfitrion, goAt: m.goAt, participantes: m.participantes }, jugadores: jug.map(publico), ahora: Date.now() });
    await this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby')).actualizar({ codigo: m.codigo, nombre: m.nombre, max: m.max, jugadores: jug.length, estado: m.estado });
  }

  async webSocketMessage(ws, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment() || {};
    // lo más frecuente primero: estados de los autos (se reenvían tal cual, sin tocar el almacenamiento)
    if (msg.t === 'auto') { if (me.id) { const s = JSON.stringify({ t: 'auto', de: me.id, m: msg.m }); for (const o of this.sockets()) if (o !== ws && o.deserializeAttachment()?.id) this.send(o, s); } return; }
    if (msg.t === 'ping') { this.send(ws, { t: 'pong', c: msg.c, s: Date.now() }); return; }
    const m = await this.meta(); if (!m) return;

    if (msg.t === 'hola') {
      const id = clean(msg.id, 40), nombre = clean(msg.nombre, 24) || 'Piloto';
      if (!id) return this.send(ws, { t: 'error', error: 'falta el id del jugador' });
      // reconexión del mismo jugador: conserva su lugar
      let prev = null;
      for (const o of this.sockets()) { const a = o.deserializeAttachment(); if (o !== ws && a?.id === id) { prev = a; o.serializeAttachment({}); try { o.close(4000, 'reemplazado por una conexión nueva'); } catch {} } }
      const ocupados = new Set(this.jugadores().filter((a) => a.id !== id).map((a) => a.idx));
      if (!prev) {
        if (ocupados.size >= m.max) { this.send(ws, { t: 'error', error: 'la sala está llena' }); ws.close(4001, 'llena'); return; }
        if (m.estado !== 'sala' && !m.participantes.includes(id)) { this.send(ws, { t: 'error', error: 'la carrera ya empezó; esperá a que termine' }); ws.close(4002, 'en carrera'); return; }
      }
      let idx = prev?.idx; if (idx === undefined || ocupados.has(idx)) { idx = 0; while (ocupados.has(idx)) idx++; }
      const a = { id, nombre, idx, listo: prev?.listo || false, fase: prev?.fase || 'sala', desde: prev?.desde || Date.now() };
      ws.serializeAttachment(a);
      if (!m.anfitrion || !this.jugadores().some((j) => j.id === m.anfitrion)) m.anfitrion = id;
      await this.ctx.storage.put('meta', m);
      this.send(ws, { t: 'bienvenida', yo: publico(a), ahora: Date.now() });
      this.broadcast({ t: 'chat', de: null, texto: prev ? `${nombre} volvió a conectarse` : `${nombre} entró a la sala` }, ws);
      await this.estado(m);
      return;
    }
    if (!me.id) return;                                   // hay que presentarse primero
    if (msg.t === 'listo') { me.listo = !!msg.v; ws.serializeAttachment(me); await this.estado(m); return; }
    if (msg.t === 'chat') { const texto = clean(msg.texto, 200); if (texto) this.broadcast({ t: 'chat', de: me.nombre, texto }); return; }
    if (msg.t === 'largar') {
      if (m.anfitrion !== me.id) return this.send(ws, { t: 'error', error: 'sólo el anfitrión larga la carrera' });
      const jug = this.jugadores();
      if (jug.length < MIN_JUG) return this.send(ws, { t: 'error', error: `hacen falta al menos ${MIN_JUG} jugadores` });
      m.estado = 'largando'; m.carrera++; m.goAt = 0; m.participantes = jug.map((j) => j.id);
      for (const o of this.sockets()) { const a = o.deserializeAttachment(); if (a?.id) { a.fase = 'menu'; o.serializeAttachment(a); } }
      await this.ctx.storage.put('meta', m);
      await this.ctx.storage.setAlarm(Date.now() + GRID_TIMEOUT_MS);
      this.broadcast({ t: 'largar', carrera: m.carrera, jugadores: jug.map(publico) });
      await this.estado(m);
      return;
    }
    if (msg.t === 'fase') {
      if (msg.carrera !== m.carrera) return;
      me.fase = clean(msg.fase, 12); ws.serializeAttachment(me);
      if (m.estado === 'largando' && !m.goAt) {
        const part = this.jugadores().filter((j) => m.participantes.includes(j.id));
        if (part.length && part.every((j) => j.fase === 'grilla')) await this.largada(m);
        else await this.estado(m);
      }
      return;
    }
    if (msg.t === 'volver' && m.anfitrion === me.id) { m.estado = 'sala'; m.goAt = 0; m.participantes = []; await this.ctx.storage.put('meta', m); this.broadcast({ t: 'volver' }); await this.estado(m); return; }
  }
  async largada(m) {
    m.goAt = Date.now() + GO_DELAY_MS; m.estado = 'carrera';
    await this.ctx.storage.put('meta', m);
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ t: 'go', at: m.goAt, carrera: m.carrera, ahora: Date.now() });
    await this.estado(m);
  }
  async alarm() { const m = await this.meta(); if (m && m.estado === 'largando' && !m.goAt) await this.largada(m); }

  async webSocketClose(ws) { await this.salio(ws); }
  async webSocketError(ws) { await this.salio(ws); }
  async salio(ws) {
    const a = ws.deserializeAttachment(); ws.serializeAttachment({});
    if (!a?.id) return;
    // ¿sigue conectado con otro socket (reconexión)?
    if (this.jugadores().some((j) => j.id === a.id)) return;
    const m = await this.meta(); if (!m) return;
    this.broadcast({ t: 'salio', id: a.id, idx: a.idx });
    this.broadcast({ t: 'chat', de: null, texto: `${a.nombre} salió de la sala` });
    const quedan = this.jugadores();
    if (m.anfitrion === a.id) { m.anfitrion = quedan.sort((x, y) => x.desde - y.desde)[0]?.id || null; if (m.anfitrion) this.broadcast({ t: 'chat', de: null, texto: `${quedan[0].nombre} es el nuevo anfitrión` }); }
    if (!quedan.length) { m.estado = 'sala'; m.participantes = []; m.goAt = 0; }
    else if (m.estado === 'largando' && !m.goAt) {
      const part = quedan.filter((j) => m.participantes.includes(j.id));
      if (part.length && part.every((j) => j.fase === 'grilla')) { await this.largada(m); return; }
    }
    await this.ctx.storage.put('meta', m);
    await this.estado(m);
  }
}
const publico = (a) => ({ id: a.id, nombre: a.nombre, idx: a.idx, listo: !!a.listo, fase: a.fase });
