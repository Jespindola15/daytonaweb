// mplocal.js — MULTIJUGADOR LOCAL: dos pestañas (o ventanas) del mismo navegador, cada una con su propia
// instancia de DAYTONA.EXE, conectadas por BroadcastChannel.
//
// Flujo: J1 crea la sesión → J2 se une desde otra pestaña → J1 pulsa «Largar carrera» → las dos pestañas
// reinician el juego, recorren el menú solas (Enter) y se DETIENEN en el primer cuadro de la carrera
// (barrera) → cuando las dos llegaron, J1 da la largada con una hora común y las dos siguen a la vez.
// Durante la carrera cada pestaña manda la pose de su auto 20 veces por segundo (CarSync) y muestra el
// auto del otro en el rival 38, cuya IA queda interceptada (RemoteCars).
import { CarSync, PUPPET_SLOT, swapStartWithPuppet } from '../src/net/multiplayer.js';

const CHANNEL = 'daytona-local-v1';
const HB_MS = 500, PEER_STALE_MS = 1500, PEER_GONE_MS = 5000;
// Arranque automático hasta la carrera (Arcade → Beginner → Automática). Tiempos desde el primer cuadro.
const MENU_ENTER_MS = [2500, 5500, 8500, 11500, 14500, 17500];
const ARM_BARRIER_AFTER = 17500;            // la barrera se arma después del último Enter (la vista previa de Mission Select no cuenta)
const RACE_LOOP = 0x447c40;                 // bucle de actualización de autos: corre desde el primer cuadro de la carrera

const rid = () => Math.random().toString(36).slice(2, 8);
// Identidad estable por pestaña: se conserva al recargar (F5). Las pestañas/ventanas nuevas abiertas desde otra
// (window.open, «duplicar pestaña») heredan una COPIA del sessionStorage, así que sólo se reutiliza si es una recarga.
function stableId() {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0]?.type;
    let id = nav === 'reload' ? sessionStorage.getItem('daytona.mp.id') : null;
    if (!id) { id = `p-${rid()}`; sessionStorage.setItem('daytona.mp.id', id); } return id; }
  catch { return `p-${rid()}`; }
}

// J2 con teclado compartido: W/S/A/D se traducen a las teclas del juego
const SHARED_P2 = { KeyW: 0x58, KeyS: 0x5a, KeyA: 0x25, KeyD: 0x27 };
const SHARED_P1 = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyX', 'KeyZ']);

export function initLocalMP({ root, toast, getEmu, reboot, log = () => {} }) {
  const me = stableId();
  const ch = new BroadcastChannel(CHANNEL);
  const S = {
    session: null, role: 0, peer: null, peerSeen: 0, peerPhase: '',
    phase: 'idle',           // idle | lobby | menu | grid | race
    offers: new Map(),       // sesiones anunciadas por otras pestañas
    sync: null, go: 0, sharedKeys: false, firstFrameAt: 0, sent: new Set(), armed: false, atGrid: false,
    msgs: { in: 0, out: 0 },
  };
  const post = (m) => { S.msgs.out++; ch.postMessage({ ...m, from: me, session: m.session ?? S.session }); };
  const peerStatus = () => {
    if (!S.peer) return 'esperando';
    const age = Date.now() - S.peerSeen;
    return age < PEER_STALE_MS ? 'conectado' : age < PEER_GONE_MS ? 'sin señal' : 'desconectado';
  };

  ch.onmessage = ({ data: m }) => {
    if (!m || m.from === me) return;
    S.msgs.in++;
    if (m.t === 'announce') { if (m.session !== S.session) S.offers.set(m.session, { host: m.from, at: Date.now(), full: m.full && m.guest !== me }); render(); return; }
    if (m.session !== S.session || !S.session) return;
    // a partir de acá, sólo mensajes de mi sesión
    if (m.t === 'join' && S.role === 1) {
      if (S.peer && S.peer !== m.from && peerStatus() !== 'desconectado') return post({ t: 'full', to: m.from });
      S.peer = m.from; S.peerSeen = Date.now(); post({ t: 'welcome', to: m.from }); log(`[MPL] J2 (${m.from}) se unió`); toast('J2 se unió a la sesión'); render(); return;
    }
    if (m.to && m.to !== me) return;
    if (m.t === 'welcome' && S.role === 2) { S.peer = m.from; S.peerSeen = Date.now(); S.phase = 'lobby'; toast('Unido a la sesión como J2'); render(); return; }
    if (m.t === 'full') { leave(); toast('Esa sesión ya tiene dos jugadores'); return; }
    if (m.from !== S.peer) return;               // identidad estable: sólo el compañero de la sesión
    S.peerSeen = Date.now();
    if (m.t === 'hb') { S.peerPhase = m.phase; if (S.role === 1) maybeGo(); return; }
    if (m.t === 'start' && S.role === 2) { startRace(); return; }
    if (m.t === 'go') { S.go = m.at; return; }
    if (m.t === 'car') { S.sync?.onMessage(m.msg); return; }
    if (m.t === 'key') { const emu = getEmu(); if (emu && S.sharedKeys) emu.keyEvent(m.vk, m.down); return; }
    if (m.t === 'bye') { log('[MPL] el otro jugador salió de la sesión'); S.peerSeen = 0; render(); return; }
  };

  // latido + anuncio
  const hb = setInterval(() => {
    if (S.session) post({ t: 'hb', phase: S.phase, role: S.role });
    if (S.role === 1) post({ t: 'announce', full: !!S.peer && peerStatus() !== 'desconectado', guest: S.peer });
    for (const [k, o] of S.offers) if (Date.now() - o.at > 3000) S.offers.delete(k);
    render();
  }, HB_MS);
  addEventListener('pagehide', () => { if (S.session) post({ t: 'bye' }); });
  // una pestaña oculta deja de recibir cuadros (requestAnimationFrame): su juego y su auto se detienen
  document.addEventListener('visibilitychange', () => { if (S.session && document.hidden) log('[MPL] esta pestaña quedó oculta: su juego se detiene hasta que vuelva a verse'); render(); });

  function create() { leave(true); S.session = rid().toUpperCase().slice(0, 4); S.role = 1; S.phase = 'lobby'; log(`[MPL] sesión ${S.session} creada (J1 = ${me})`); render(); }
  function join(session) { leave(true); S.session = session; S.role = 2; S.phase = 'idle'; post({ t: 'join' }); render(); }
  function leave(silent) {
    if (S.session && !silent) post({ t: 'bye' });
    S.sync?.stop(); S.sync = null; disarm();
    Object.assign(S, { session: null, role: 0, peer: null, peerSeen: 0, peerPhase: '', phase: 'idle', go: 0, atGrid: false });
    render();
  }

  // ---- carrera: reinicio sincronizado, menú automático, barrera, largada común ----
  let hookEmu = null;
  function disarm() { if (hookEmu) { hookEmu.removeHook(RACE_LOOP); hookEmu = null; } S.armed = false; }
  function startRace() {
    if (S.role === 1) post({ t: 'start' });
    S.sync?.stop(); S.sync = null; disarm();
    Object.assign(S, { phase: 'menu', go: 0, firstFrameAt: 0, atGrid: false, sent: new Set() });
    reboot();
    const emu = getEmu();
    hookEmu = emu;
    emu.addHook(RACE_LOOP, () => { if (S.armed && !S.atGrid) { S.atGrid = true; onGrid(); } return true; });
    log(`[MPL] largada pedida: reinicio del juego (J${S.role})`);
    render();
  }
  function onGrid() {
    const emu = getEmu();
    if (S.role === 2) swapStartWithPuppet(emu.mem);      // J2 larga desde el lugar del auto 38; el 38 pasa a ser J1
    S.phase = 'grid';
    log(`[MPL] J${S.role} llegó a la grilla: esperando al otro jugador`);
    post({ t: 'hb', phase: 'grid', role: S.role });
    if (S.role === 1) maybeGo();
    render();
  }
  function maybeGo() {
    if (S.phase === 'grid' && S.peerPhase === 'grid' && !S.go) { S.go = Date.now() + 400; post({ t: 'go', at: S.go }); log('[MPL] los dos en la grilla: largada'); }
  }
  // llamado por el bucle principal en cada cuadro del navegador. Devuelve true si el juego debe quedar detenido.
  function frame() {
    const emu = getEmu(); if (!emu || !S.session) return false;
    if (S.phase === 'menu') {
      if (!S.firstFrameAt && emu.state.dd.frames > 2) S.firstFrameAt = performance.now();
      if (S.firstFrameAt) {
        const since = performance.now() - S.firstFrameAt;
        MENU_ENTER_MS.forEach((ms, i) => {
          if (since >= ms && !S.sent.has(`d${i}`)) { S.sent.add(`d${i}`); emu.keyEvent(0x0d, true); }
          if (since >= ms + 250 && !S.sent.has(`u${i}`)) { S.sent.add(`u${i}`); emu.keyEvent(0x0d, false); }
        });
        if (since >= ARM_BARRIER_AFTER + 400) S.armed = true;
      }
      return false;
    }
    if (S.phase === 'grid') {
      if (S.go && Date.now() >= S.go) { S.phase = 'race'; beginSync(); render(); return false; }
      return true;                                          // detenido en la grilla
    }
    if (S.phase === 'race' && S.sync) S.sync.tick();
    return false;
  }
  function beginSync() {
    const emu = getEmu();
    S.sync = new CarSync({
      emu, playerId: me, slotRole: S.role, now: () => Date.now(), log,
      transport: { send: (msg) => post({ t: 'car', msg }) },
    });
    disarm();
    log(`[MPL] carrera en curso: sincronizando autos (el rival ${PUPPET_SLOT} muestra al otro jugador)`);
  }

  // ---- teclado compartido (opcional): una sola ventana con foco maneja a los dos autos ----
  function routeKey(code, vk, down) {
    if (!S.sharedKeys || !S.session || !S.peer) return false;
    const mine = S.role === 1 ? SHARED_P1.has(code) : code in SHARED_P2;
    const theirs = S.role === 1 ? code in SHARED_P2 : SHARED_P1.has(code);
    if (theirs) { post({ t: 'key', vk: S.role === 1 ? SHARED_P2[code] : vk, down }); return true; }
    if (mine && S.role === 2) { getEmu()?.keyEvent(SHARED_P2[code], down); return true; }
    return false;
  }

  // ---- interfaz mínima ----
  const H = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let lastHtml = '';
  function render() {
    const st = peerStatus();
    const r = S.sync ? S.sync.track : null;
    const phaseTxt = { idle: '—', lobby: 'en la sala', menu: 'reiniciando el juego y recorriendo el menú…', grid: 'en la grilla, esperando al otro jugador', race: 'carrera en curso' }[S.phase];
    let html = '';
    if (!S.session) {
      const offers = [...S.offers].filter(([, o]) => !o.full);
      html += `<p class="hint">Abrí esta misma página en otra ventana del navegador (lado a lado, las dos visibles). Una crea la sesión y la otra se une.</p>
        <div class="row"><button class="btn primary" data-a="create">Crear sesión (J1)</button></div>`;
      html += offers.length
        ? offers.map(([k]) => `<div class="row"><button class="btn" data-a="join" data-s="${H(k)}">Unirse a la sesión ${H(k)} como J2</button></div>`).join('')
        : `<p class="hint">No hay sesiones abiertas en otras pestañas.</p>`;
    } else {
      html += `<div class="mp-who">Sos <b>J${S.role}</b> · sesión <b>${H(S.session)}</b></div>
        <div class="mp-row"><span>Otro jugador</span><b class="st-${st.replace(' ', '-')}">${S.peer ? `J${3 - S.role} · ${st}` : 'esperando que alguien se una…'}</b></div>
        <div class="mp-row"><span>Estado</span><b>${H(phaseTxt)}</b></div>`;
      if (S.sync) {
        const rr = S.sync.remoteRace;
        html += `<div class="mp-row"><span>Auto del otro</span><b>${rr ? `vuelta ${rr.lap} · puesto ${rr.rank} · ${rr.kmh} km/h` : 'sin datos'}</b></div>
          <div class="mp-row"><span>Sincronización</span><b>${S.sync.status} · ${S.sync.sent} enviados · ${r.received} recibidos</b></div>`;
      }
      if (S.role === 1 && (S.phase === 'lobby' || S.phase === 'race' || S.phase === 'grid'))
        html += `<div class="row"><button class="btn primary" data-a="start" ${st === 'conectado' ? '' : 'disabled'}>${S.phase === 'lobby' ? 'Largar carrera' : 'Reiniciar carrera'}</button></div>`;
      if (S.role === 2 && S.phase === 'lobby') html += `<p class="hint">Esperando que J1 largue la carrera…</p>`;
      if (S.phase !== 'idle' && S.peer) html += `<p class="hint">Las dos ventanas tienen que estar visibles: una pestaña en segundo plano deja de ejecutar su juego.</p>`;
      html += `<label class="check"><input type="checkbox" data-a="shared" ${S.sharedKeys ? 'checked' : ''}> Teclado compartido (J1: flechas + X/Z · J2: A/D + W/S)</label>
        <div class="row"><button class="btn" data-a="leave">Salir de la sesión</button></div>`;
    }
    if (html !== lastHtml) { root.innerHTML = html; lastHtml = html; }
    const badge = document.getElementById('mpBadge');
    if (badge) { badge.hidden = !S.session; badge.textContent = S.session ? `J${S.role} · ${S.peer ? st : 'esperando'}` : ''; badge.className = `badge st-${st.replace(' ', '-')}`; }
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (a === 'create') create();
    else if (a === 'join') join(b.dataset.s);
    else if (a === 'start') startRace();
    else if (a === 'leave') leave();
  });
  root.addEventListener('change', (e) => { if (e.target.dataset.a === 'shared') { S.sharedKeys = e.target.checked; post({ t: 'hb', phase: S.phase }); } });
  render();

  const api = { frame, routeKey, state: S, create, join, leave, startRace, render, get active() { return !!S.session; } };
  window.__mplocal = api;   // para las pruebas automáticas
  return api;
}
