// rooms-core.mjs — lógica del gestor de salas (independiente del almacenamiento).
// Se usa desde la Netlify Function (Netlify Blobs) y desde tools/dev-server.mjs (memoria).
//
// Todo el estado del lobby vive en un único documento JSON. Cada cambio es lectura + escritura
// condicional (etag): si otro cliente escribió en el medio, se reintenta. Así dos "unirse" simultáneos
// no se pisan.
//
// Adaptador de almacenamiento: { read(): Promise<{data, etag}|null>, write(data, etag): Promise<boolean> }

const LIMITS = { rooms: 40, players: 8, name: 24, room: 32, chat: 200, chatKeep: 60, idleMs: 25000, roomMaxAgeMs: 6 * 3600e3 };
const now = () => Date.now();

function rid(n = 6) { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
function secret() { const b = new Uint8Array(16); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function clean(s, max) { return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max); }

function prune(state) {
  const t = now();
  for (const [id, room] of Object.entries(state.rooms)) {
    for (const [pid, p] of Object.entries(room.players)) if (t - p.lastSeen > LIMITS.idleMs) { delete room.players[pid]; sys(room, `${p.name} se desconectó`); }
    const left = Object.values(room.players);
    if (!left.length || t - room.createdAt > LIMITS.roomMaxAgeMs) { delete state.rooms[id]; continue; }
    if (!room.players[room.hostSecret]) { // el anfitrión se fue: pasa al más antiguo
      const next = left.sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.hostSecret = next.secret; sys(room, `${next.name} es el nuevo anfitrión`);
    }
    if (room.status === 'starting' && t > room.startAt + 60000) room.status = 'racing';
  }
  return state;
}
function sys(room, text) { room.chat.push({ t: now(), from: null, text }); if (room.chat.length > LIMITS.chatKeep) room.chat.splice(0, room.chat.length - LIMITS.chatKeep); }

// Vista pública: nunca expone los secretos de los jugadores
function publicRoom(room, mySecret) {
  return {
    id: room.id, name: room.name, max: room.max, status: room.status, startAt: room.startAt || null, createdAt: room.createdAt,
    players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt).map((p) => ({ id: p.pub, name: p.name, ready: p.ready, host: p.secret === room.hostSecret, me: p.secret === mySecret })),
    chat: room.chat.slice(-40).map((m) => ({ t: m.t, from: m.from, text: m.text })),
    youAreHost: mySecret ? room.hostSecret === mySecret : false,
  };
}
function summary(room) {
  const host = room.players[room.hostSecret];
  return { id: room.id, name: room.name, players: Object.keys(room.players).length, max: room.max, status: room.status, host: host ? host.name : '' };
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// Ejecuta `fn(state)` con reintentos optimistas. fn devuelve el resultado; si muta el estado, se guarda.
async function transact(store, fn, { write = true } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = (await store.read()) || { data: null, etag: null };
    const state = prune(cur.data && cur.data.rooms ? cur.data : { rooms: {} });
    const result = fn(state);
    if (!write) return result;
    if (await store.write(state, cur.etag)) return result;
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * (attempt + 1)));
  }
  throw new HttpError(503, 'El servidor de salas está ocupado, probá de nuevo');
}

function getRoomAndPlayer(state, roomId, secretKey) {
  const room = state.rooms[roomId];
  if (!room) throw new HttpError(404, 'La sala no existe (o se cerró por inactividad)');
  const p = secretKey ? room.players[secretKey] : null;
  if (secretKey && !p) throw new HttpError(403, 'No estás en esta sala');
  return { room, p };
}

export async function handleAction(store, body) {
  const a = body.action;
  switch (a) {
    case 'list': {
      // lectura con limpieza persistida (para que las salas abandonadas desaparezcan)
      return transact(store, (s) => ({ rooms: Object.values(s.rooms).map(summary).sort((x, y) => y.players - x.players), serverNow: now() }), { write: false });
    }
    case 'create': {
      const name = clean(body.playerName, LIMITS.name) || 'Piloto';
      const roomName = clean(body.roomName, LIMITS.room) || `Sala de ${name}`;
      const max = Math.max(2, Math.min(LIMITS.players, Number(body.max) || 4));
      return transact(store, (s) => {
        if (Object.keys(s.rooms).length >= LIMITS.rooms) throw new HttpError(429, 'Hay demasiadas salas abiertas; probá más tarde');
        let id; do id = rid(); while (s.rooms[id]);
        const sec = secret();
        s.rooms[id] = { id, name: roomName, max, status: 'waiting', createdAt: now(), hostSecret: sec, players: {}, chat: [] };
        s.rooms[id].players[sec] = { secret: sec, pub: rid(8), name, ready: false, joinedAt: now(), lastSeen: now() };
        sys(s.rooms[id], `${name} creó la sala`);
        return { roomId: id, secret: sec, room: publicRoom(s.rooms[id], sec), serverNow: now() };
      });
    }
    case 'join': {
      const name = clean(body.playerName, LIMITS.name) || 'Piloto';
      return transact(store, (s) => {
        const { room } = getRoomAndPlayer(s, clean(body.roomId, 8).toUpperCase());
        if (Object.keys(room.players).length >= room.max) throw new HttpError(409, 'La sala está llena');
        if (room.status !== 'waiting') throw new HttpError(409, 'La carrera de esta sala ya empezó');
        const sec = secret();
        room.players[sec] = { secret: sec, pub: rid(8), name, ready: false, joinedAt: now(), lastSeen: now() };
        sys(room, `${name} entró a la sala`);
        return { roomId: room.id, secret: sec, room: publicRoom(room, sec), serverNow: now() };
      });
    }
    case 'state': { // sólo lectura (se consulta seguido)
      return transact(store, (s) => {
        const { room } = getRoomAndPlayer(s, body.roomId, body.secret);
        return { room: publicRoom(room, body.secret), serverNow: now() };
      }, { write: false });
    }
    case 'heartbeat': { // presencia: cada ~8 s
      return transact(store, (s) => {
        const { room, p } = getRoomAndPlayer(s, body.roomId, body.secret);
        p.lastSeen = now();
        return { room: publicRoom(room, body.secret), serverNow: now() };
      });
    }
    case 'leave': {
      return transact(store, (s) => {
        const room = s.rooms[body.roomId]; if (!room) return { ok: true };
        const p = room.players[body.secret]; if (!p) return { ok: true };
        delete room.players[body.secret]; sys(room, `${p.name} salió de la sala`);
        prune(s);
        return { ok: true };
      });
    }
    case 'ready': {
      return transact(store, (s) => {
        const { room, p } = getRoomAndPlayer(s, body.roomId, body.secret);
        p.ready = !!body.ready; p.lastSeen = now();
        return { room: publicRoom(room, body.secret), serverNow: now() };
      });
    }
    case 'chat': {
      const text = clean(body.text, LIMITS.chat);
      if (!text) throw new HttpError(400, 'Mensaje vacío');
      return transact(store, (s) => {
        const { room, p } = getRoomAndPlayer(s, body.roomId, body.secret);
        p.lastSeen = now();
        room.chat.push({ t: now(), from: p.name, text }); if (room.chat.length > LIMITS.chatKeep) room.chat.shift();
        return { room: publicRoom(room, body.secret), serverNow: now() };
      });
    }
    case 'start': {
      return transact(store, (s) => {
        const { room, p } = getRoomAndPlayer(s, body.roomId, body.secret);
        if (room.hostSecret !== body.secret) throw new HttpError(403, 'Sólo el anfitrión puede largar');
        const ps = Object.values(room.players);
        if (ps.length < 2) throw new HttpError(409, 'Hacen falta al menos 2 pilotos');
        if (!ps.every((x) => x.ready || x.secret === room.hostSecret)) throw new HttpError(409, 'No todos están listos');
        room.status = 'starting'; room.startAt = now() + 5000; p.lastSeen = now();
        sys(room, 'Largada en 5 segundos');
        return { room: publicRoom(room, body.secret), serverNow: now() };
      });
    }
    case 'reset': {
      return transact(store, (s) => {
        const { room } = getRoomAndPlayer(s, body.roomId, body.secret);
        if (room.hostSecret !== body.secret) throw new HttpError(403, 'Sólo el anfitrión puede reabrir la sala');
        room.status = 'waiting'; room.startAt = 0; for (const x of Object.values(room.players)) x.ready = false;
        sys(room, 'La sala vuelve a estar abierta');
        return { room: publicRoom(room, body.secret), serverNow: now() };
      });
    }
  }
  throw new HttpError(400, `Acción desconocida: ${a}`);
}

// Adaptador HTTP (Request/Response estándar: sirve en Netlify Functions v2 y en Node 18+)
export async function handleRequest(req, store) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  try {
    let body;
    if (req.method === 'GET') body = Object.fromEntries(new URL(req.url).searchParams);
    else if (req.method === 'POST') { const txt = await req.text(); if (txt.length > 4000) throw new HttpError(413, 'Pedido demasiado grande'); body = JSON.parse(txt || '{}'); }
    else throw new HttpError(405, 'Método no permitido');
    if (!body.action) body.action = 'list';
    const out = await handleAction(store, body);
    return new Response(JSON.stringify(out), { status: 200, headers });
  } catch (e) {
    const status = e.status || 500;
    return new Response(JSON.stringify({ error: e.message || 'Error interno' }), { status, headers });
  }
}

// Almacenamiento en memoria con etags (para desarrollo local y pruebas)
export function memoryStore() {
  let data = null, etag = null, n = 0;
  return {
    async read() { return data ? { data: JSON.parse(JSON.stringify(data)), etag } : null; },
    async write(d, expected) { if ((expected || null) !== etag) return false; data = JSON.parse(JSON.stringify(d)); etag = `"m${++n}"`; return true; },
  };
}
