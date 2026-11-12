// lobby.js — gestor de salas online (cliente). API: /api/rooms (Netlify Function o tools/dev-server.mjs).
//
// Qué hace: crear/listar/unirse a salas, lista de pilotos con "listo", chat, anfitrión que larga y
// cuenta regresiva sincronizada con el reloj del servidor (al llegar a cero, cada navegador reinicia
// su juego a la vez).
// Qué NO hace (todavía): carreras con varios autos. DAYTONA.EXE (1996) no tiene código de red
// (no importa DirectPlay ni Winsock), así que no hay un modo multijugador original que conectar.

const API = '/api/rooms';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  sget(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  sset(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

async function call(action, data = {}, method = 'POST') {
  let r;
  try {
    r = method === 'GET'
      ? await fetch(`${API}?${new URLSearchParams({ action, ...data })}`, { cache: 'no-store' })
      : await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
  } catch { throw Object.assign(new Error('Sin conexión con el servidor de salas'), { offline: true }); }
  let body = null; try { body = await r.json(); } catch {}
  if (r.status === 404 && !body) throw Object.assign(new Error('Este sitio no tiene el servidor de salas'), { noApi: true });
  if (!r.ok) throw Object.assign(new Error(body?.error || `Error ${r.status}`), { status: r.status });
  return body;
}

export function initLobby({ root, toast, onStart }) {
  let session = store.sget('daytona.session'); // { roomId, secret }
  let room = null, rooms = [], clockOffset = 0, panelOpen = false, apiState = 'unknown', lastError = '';
  let pollT = 0, beatT = 0, listT = 0, countdownT = 0, startedFor = null, chatScroll = true;

  const name = () => store.get('daytona.name', '') || '';
  const serverNow = () => Date.now() + clockOffset;
  const syncClock = (sn) => { if (sn) clockOffset = sn - Date.now(); };

  function render() {
    if (apiState === 'missing') {
      root.dataset.view = 'none';
      root.innerHTML = `<section><p class="notice">Este hosting no tiene el servidor de salas.<br>En Netlify se activa solo con <code>netlify/functions/rooms.mjs</code>. En tu PC: <code>node tools/dev-server.mjs</code>.</p></section>`;
      return;
    }
    if (!session || !room) return renderList();
    renderRoom();
  }

  function renderList() {
    // si la vista ya está armada, sólo se actualiza la lista (no se pisan los campos que el usuario está escribiendo)
    if (root.querySelector('#lbName') && root.dataset.view === 'list') { fillRooms(); const er = root.querySelector('#lbErr'); if (er) er.textContent = lastError; return; }
    root.dataset.view = 'list';
    root.innerHTML = `
      <section>
        <label class="field">Tu nombre de piloto<input class="input" id="lbName" maxlength="24" placeholder="Piloto" value="${esc(name())}"></label>
      </section>
      <section>
        <h3>Salas abiertas</h3>
        <div class="room-list" id="lbRooms">${rooms.length ? '' : `<div class="empty">${apiState === 'unknown' ? 'Cargando…' : 'No hay salas. ¡Creá la primera!'}</div>`}</div>
        <div class="row"><input class="input" id="lbCode" maxlength="6" placeholder="Código de sala" style="flex:1;text-transform:uppercase"><button class="btn" id="lbJoinCode">Unirme</button></div>
      </section>
      <section>
        <h3>Crear sala</h3>
        <label class="field">Nombre de la sala<input class="input" id="lbRoomName" maxlength="32" placeholder="Sala de ${esc(name() || 'Piloto')}"></label>
        <label class="field">Pilotos<select id="lbMax"><option>2</option><option>3</option><option selected>4</option><option>6</option><option>8</option></select></label>
        <button class="btn primary" id="lbCreate">Crear sala</button>
        <p class="hint" id="lbErr" style="color:var(--bad)">${esc(lastError)}</p>
      </section>
      <section><p class="notice">Las salas sirven para reunirse, chatear y largar todos a la vez. Daytona USA (1996) no trae código de red, así que todavía no hay carreras con varios autos en la misma pista.</p></section>`;
    fillRooms();
    const nm = root.querySelector('#lbName');
    nm.oninput = () => store.set('daytona.name', nm.value.trim().slice(0, 24));
    root.querySelector('#lbCreate').onclick = create;
    root.querySelector('#lbJoinCode').onclick = () => join(root.querySelector('#lbCode').value.trim().toUpperCase());
  }
  function fillRooms() {
    const list = root.querySelector('#lbRooms');
    list.innerHTML = rooms.length ? '' : `<div class="empty">${apiState === 'unknown' ? 'Cargando…' : 'No hay salas. ¡Creá la primera!'}</div>`;
    for (const r of rooms) {
      const div = document.createElement('div'); div.className = 'room';
      div.innerHTML = `<div><b>${esc(r.name)}</b><small>${r.players}/${r.max} pilotos · anfitrión ${esc(r.host)} · ${r.status === 'waiting' ? 'esperando' : 'en carrera'}</small></div>`;
      const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'Entrar';
      b.disabled = r.players >= r.max || r.status !== 'waiting'; b.onclick = () => join(r.id);
      div.appendChild(b); list.appendChild(div);
    }
  }

  function renderRoom() {
    const me = room.players.find((p) => p.me);
    const all = room.players.length >= 2 && room.players.every((p) => p.ready || p.host);
    const chatEl = root.querySelector('#lbChat');
    if (chatEl) chatScroll = chatEl.scrollTop + chatEl.clientHeight >= chatEl.scrollHeight - 10;
    const draft = root.querySelector('#lbMsg')?.value || '';
    root.dataset.view = 'room';
    const hadFocus = document.activeElement?.id === 'lbMsg';
    let state = '';
    if (room.status === 'starting') { const s = Math.max(0, Math.ceil((room.startAt - serverNow()) / 1000)); state = `<div class="countdown" id="lbCount">${s}</div>`; }
    else if (room.status === 'racing') state = `<p class="hint">Carrera en curso.</p>${room.youAreHost ? '<button class="btn" id="lbReset">Reabrir la sala</button>' : ''}`;
    root.innerHTML = `
      <section>
        <div class="row" style="justify-content:space-between"><div><small class="hint">Sala</small><div><b>${esc(room.name)}</b></div></div>
        <div style="text-align:right"><small class="hint">Código</small><div class="code">${esc(room.id)}</div></div></div>
        ${state}
      </section>
      <section>
        <h3>Pilotos ${room.players.length}/${room.max}</h3>
        <ul class="players">${room.players.map((p) => `<li><span>${esc(p.name)}${p.me ? ' (vos)' : ''}</span><span>${p.host ? '<span class="tag host">anfitrión</span> ' : ''}${p.ready || p.host ? '<span class="tag ok">listo</span>' : '<span class="tag">esperando</span>'}</span></li>`).join('')}</ul>
        <div class="row">
          ${room.status === 'waiting' && !room.youAreHost ? `<button class="btn ${me?.ready ? '' : 'primary'}" id="lbReady">${me?.ready ? 'No estoy listo' : 'Estoy listo'}</button>` : ''}
          ${room.status === 'waiting' && room.youAreHost ? `<button class="btn primary" id="lbStart" ${all ? '' : 'disabled'}>Largar</button><span class="hint">${room.players.length < 2 ? 'Esperando a otro piloto…' : all ? '' : 'Esperando que todos estén listos'}</span>` : ''}
          <button class="btn" id="lbLeave">Salir</button>
        </div>
      </section>
      <section>
        <h3>Chat</h3>
        <div class="chat" id="lbChat">${room.chat.map((m) => (m.from ? `<div><b>${esc(m.from)}:</b> ${esc(m.text)}</div>` : `<div class="sys">${esc(m.text)}</div>`)).join('')}</div>
        <form class="row" id="lbChatForm" style="margin-top:8px"><input class="input" id="lbMsg" maxlength="200" placeholder="Escribí un mensaje…" style="flex:1" autocomplete="off"><button class="btn">Enviar</button></form>
      </section>`;
    const c = root.querySelector('#lbChat'); if (chatScroll) c.scrollTop = c.scrollHeight;
    const msg = root.querySelector('#lbMsg'); msg.value = draft; if (hadFocus) msg.focus();
    root.querySelector('#lbLeave').onclick = leave;
    root.querySelector('#lbReady')?.addEventListener('click', () => act('ready', { ready: !me?.ready }));
    root.querySelector('#lbStart')?.addEventListener('click', () => act('start'));
    root.querySelector('#lbReset')?.addEventListener('click', () => { startedFor = null; act('reset'); });
    root.querySelector('#lbChatForm').onsubmit = (e) => { e.preventDefault(); const t = msg.value.trim(); if (t) { msg.value = ''; act('chat', { text: t }); } };
  }

  // ---------- acciones ----------
  async function create() {
    const pn = (root.querySelector('#lbName')?.value || name()).trim(); store.set('daytona.name', pn);
    try {
      const r = await call('create', { playerName: pn, roomName: root.querySelector('#lbRoomName').value, max: root.querySelector('#lbMax').value });
      enter(r);
    } catch (e) { handleError(e); }
  }
  async function join(id) {
    if (!id) return;
    const pn = (root.querySelector('#lbName')?.value || name()).trim(); store.set('daytona.name', pn);
    try { enter(await call('join', { roomId: id, playerName: pn })); } catch (e) { handleError(e); }
  }
  function enter(r) { session = { roomId: r.roomId, secret: r.secret }; store.sset('daytona.session', session); syncClock(r.serverNow); room = r.room; lastError = ''; render(); schedule(); }
  async function leave() {
    const s = session; session = null; room = null; startedFor = null; store.sset('daytona.session', null); render(); refreshList();
    if (s) call('leave', s).catch(() => {});
  }
  async function act(action, extra = {}) {
    if (!session) return;
    try { const r = await call(action, { ...session, ...extra }); syncClock(r.serverNow); room = r.room; render(); check(); } catch (e) { handleError(e); }
  }
  function handleError(e) {
    if (e.noApi) { apiState = 'missing'; render(); return; }
    if (e.status === 404 || e.status === 403) { // la sala ya no existe o nos sacaron por inactividad
      if (session) { session = null; room = null; store.sset('daytona.session', null); toast(e.message, 4000); render(); refreshList(); return; }
    }
    lastError = e.message; toast(e.message, 4000); if (!room) render();
  }

  // ---------- sondeo ----------
  async function poll() {
    if (!session) return;
    try { const r = await call('state', session, 'GET'); apiState = 'ok'; syncClock(r.serverNow); room = r.room; if (panelOpen) render(); check(); }
    catch (e) { handleError(e); }
  }
  async function beat() { if (session) { try { await call('heartbeat', session); } catch (e) { handleError(e); } } }
  async function refreshList() {
    if (session || !panelOpen) return;
    try { const r = await call('list', {}, 'GET'); apiState = 'ok'; rooms = r.rooms; syncClock(r.serverNow); render(); }
    catch (e) { if (e.noApi) { apiState = 'missing'; render(); } else { lastError = e.message; render(); } }
  }
  function check() {
    if (!room || room.status !== 'starting' || startedFor === room.startAt) return;
    clearInterval(countdownT);
    if (!panelOpen) toast(`Largada en ${Math.ceil((room.startAt - serverNow()) / 1000)} s`, 2000);
    countdownT = setInterval(() => {
      const left = room.startAt - serverNow();
      const el = root.querySelector('#lbCount'); if (el) el.textContent = Math.max(0, Math.ceil(left / 1000));
      if (left <= 0 && startedFor !== room.startAt) { startedFor = room.startAt; clearInterval(countdownT); onStart?.(); }
    }, 100);
  }
  function schedule() {
    clearInterval(pollT); clearInterval(beatT); clearInterval(listT);
    pollT = setInterval(poll, 1500); beatT = setInterval(beat, 8000); listT = setInterval(refreshList, 4000);
    beat();
  }

  // al recargar la página con una sesión abierta, se reconecta
  if (session) { poll(); schedule(); } else schedule();
  // (al recargar no se sale de la sala: si no vuelve, el servidor lo quita tras 25 s sin señal)

  render();
  return {
    open() { panelOpen = true; render(); refreshList(); poll(); },
    close() { panelOpen = false; },
    get room() { return room; },
  };
}
