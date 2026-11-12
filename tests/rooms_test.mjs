// node tests/rooms_test.mjs — pruebas del gestor de salas (concurrencia, permisos, saneo)
// prueba de la lógica: concurrencia, permisos, límites
import { handleAction, memoryStore } from '../server/rooms-core.mjs';
const st = memoryStore(); let ok = 0, bad = 0;
const check = (n, c) => { (c ? ok++ : bad++); console.log((c ? 'OK ' : 'ERR') + ' ' + n); };
const A = await handleAction(st, { action: 'create', playerName: 'Ana', roomName: 'Daytona <b>Pro</b>', max: 3 });
check('crear sala y saneo de nombre', A.room.name === 'Daytona bPro/b' && A.room.youAreHost);
// 5 joins simultáneos contra una sala de 3 -> exactamente 2 entran
const js = await Promise.allSettled(['B', 'C', 'D', 'E', 'F'].map((n) => handleAction(st, { action: 'join', roomId: A.roomId, playerName: n })));
check('joins simultáneos respetan el cupo (2 de 5)', js.filter((x) => x.status === 'fulfilled').length === 2);
const B = js.find((x) => x.status === 'fulfilled').value;
const s1 = await handleAction(st, { action: 'state', roomId: A.roomId, secret: A.secret });
check('3 jugadores, sin secretos expuestos', s1.room.players.length === 3 && !JSON.stringify(s1).includes(B.secret));
let e = await handleAction(st, { action: 'start', roomId: A.roomId, secret: B.secret }).catch((x) => x);
check('un invitado no puede largar', e.status === 403);
e = await handleAction(st, { action: 'start', roomId: A.roomId, secret: A.secret }).catch((x) => x);
check('no larga si no están todos listos', e.status === 409);
for (const p of [B, js.filter((x) => x.status === 'fulfilled')[1].value]) await handleAction(st, { action: 'ready', roomId: A.roomId, secret: p.secret, ready: true });
const s2 = await handleAction(st, { action: 'start', roomId: A.roomId, secret: A.secret });
check('largada programada', s2.room.status === 'starting' && s2.room.startAt > s2.serverNow);
await handleAction(st, { action: 'chat', roomId: A.roomId, secret: B.secret, text: 'hola <script>' });
const s3 = await handleAction(st, { action: 'state', roomId: A.roomId, secret: B.secret });
check('chat saneado', s3.room.chat.some((m) => m.text === 'hola script'));
await handleAction(st, { action: 'leave', roomId: A.roomId, secret: A.secret });
const s4 = await handleAction(st, { action: 'state', roomId: A.roomId, secret: B.secret });
check('si el anfitrión se va, otro pasa a ser anfitrión', s4.room.players.length === 2 && s4.room.players.some((p) => p.host));
const L = await handleAction(st, { action: 'list' });
check('listado', L.rooms.length === 1 && L.rooms[0].players === 2);
console.log(`RESULTADO ${ok}/${ok + bad}`);
