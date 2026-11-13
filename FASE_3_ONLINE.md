# Fase 3 — Online en Cloudflare (2 a 6 jugadores), puesto corregido y joystick

Estado: **funciona y está demostrado**:

- **Salas online en Cloudflare** (Worker + un Durable Object por sala + WebSocket). Probadas con el runtime real de
  Cloudflare (`workerd`, vía `wrangler dev`) y dos ventanas de Chrome con el juego: 13/13.
- **2 a 6 jugadores**: la sincronización se probó con 2, 3 y 6 instancias reales de `DAYTONA.EXE` y red simulada:
  6/6 en cada caso.
- **Puesto del auto remoto**: corregido (antes un jugador podía verse «1.º» siendo 37.º).
- **Joystick / mando**: dos modos. En «analógico» se usa el modo volante del propio juego, con dirección
  proporcional: 7/7 en Chrome.

Todavía no está publicado en tu cuenta de Cloudflare: eso requiere tu login (`npx wrangler login`). Instrucciones
en `cloudflare/README.md`.

## 1. Puesto (clasificación) del auto remoto

**Causa encontrada:** el juego ordena la carrera con unos contadores de avance por sección que tiene cada auto
(`+0x1E0`, `+0x1E8`, `+0x1EC`, `+0x1F0`). Hay tres hallazgos:

- Estos campos ordenan la clasificación (`+0x220`) en el 97–99 % de los pares de autos.
- No se sincronizaban, así que el auto remoto conservaba el avance del rival de la IA que reemplazaba.
- Al intercambiar los lugares de la grilla, el auto del J2 heredaba el avance del lugar del J1.

**Corrección:**

- Esos cuatro campos viajan con la pose y se aplican al auto remoto.
- También se intercambian al tomar el lugar en la grilla (`swapStartForPlayer`).

**Prueba de control (2 jugadores, 30 s de carrera, misma red simulada):**

| | Comparaciones con el orden correcto | Peor diferencia de puesto |
|---|---|---|
| Sin la corrección (`SIN_AVANCE=1`) | 520/1040 (la mitad, al azar) | 39 puestos: el «1.º» que viste |
| Con la corrección | 1040/1040 | 14 |

Logs: `tests/logs/fase3/control_sin_avance_n2.txt` y `mp_n2_resultado.txt`.

Una diferencia entre el puesto que ve cada pantalla es normal y queda: cada instancia tiene **sus propios** rivales
de la IA. Ya terminada la largada, la mediana es de 4 a 7 puestos y el p95 11, con 2, 3 y 6 jugadores. Lo que tiene que coincidir, y coincide, es el
orden entre los jugadores humanos.

## 2. De 2 a 6 jugadores

- **Lugares en la grilla:** cada jugador tiene un lugar 0..5 en la sala (J1..J6). El jugador `i` larga desde el
  lugar del auto `GRID_SLOTS[i]` = 0, 38, 37, 36, 35, 34 de la grilla original.
- **Qué auto representa a quién:** en la instancia del jugador `me`, el jugador `q` se ve en el auto
  `slotFor(me, q)`. Los demás ocupan su propio lugar, y el J1 ocupa el lugar que dejó libre `me`. Así todos ven a
  todos en el mismo lugar de la grilla.
- **`CarSync` por jugador:** cada otro jugador tiene su propio búfer, interpolación, suavizado, auto en el juego y
  estado (conectado / sin señal / desconectado). Al salir de la sala (`salio`), su auto vuelve a la IA al instante.
- **Relojes de computadoras distintas:** el desfase se estima por jugador con el mínimo de (llegada − hora de envío)
  de los últimos ~5 s.
  - Ese desfase cambia de a poco, como mucho un 5 % del tiempo transcurrido: si cambiara de golpe, el auto del otro
    «saltaría» hacia adelante. La prueba de 2 jugadores lo detectó (salto de 5,5 unidades) y quedó corregido: 0
    saltos visibles.
  - La prueba usa relojes desfasados hasta 8,1 s y la precisión no cambia.

**Prueba `tests/mp_n_test.mjs`:** N instancias reales de `DAYTONA.EXE`, red con 40 ± 60 ms y 5 % de pérdida.

| N | Grilla | Precisión p95 | Orden entre jugadores | Vueltas | Desconexión |
|---|---|---|---|---|---|
| 2 | OK | 2,96 u | 1040/1040 | OK | OK |
| 3 | OK | 2,99 u | 4571/4574 | OK | OK |
| 6 | OK | 3,20 u | 17396/17464 | OK | OK |

El caso de 6 jugadores tomó 23 910 mediciones, perdió 730 de 13 180 paquetes y tuvo relojes desfasados hasta 8,1 s.

## 3. Salas en Cloudflare (`cloudflare/`)

### API

```
GET  /api/salas                 lista de salas abiertas
POST /api/salas {nombre,max}    crea sala (2..6) → código de 4 letras
GET  /api/salas/:código         datos de la sala
GET  /api/salas/:código/ws      WebSocket (Durable Object «Sala», API con hibernación)
```

### Mensajes por el WebSocket

| Dirección | Mensajes |
|---|---|
| Cliente → sala | `hola{id,nombre}`, `listo`, `chat`, `largar` (sólo anfitrión), `fase{grilla}`, `auto{m}`, `ping`, `volver` |
| Sala → cliente | `bienvenida{yo}`, `estado{sala,jugadores}`, `largar{carrera,jugadores}`, `go{at}`, `auto{de,m}`, `salio`, `chat`, `pong{s}`, `error` |

### Reglas de la sala

- Sala llena: cierre con código 4001.
- No se entra con la carrera en curso: cierre con código 4002.
- Si se va el anfitrión, el rol pasa al jugador más antiguo.
- Al reconectarse con el mismo id, el jugador conserva su lugar.
- Si alguien no llega a la grilla en 120 s, la sala larga igual.

### Largada

La lógica de la carrera es común al modo local y al online (`web/race.js`):

1. Todos reinician el juego y recorren solos el menú.
2. Cada juego se detiene en la grilla y avisa a la sala.
3. Cuando están todos, la sala manda `go` con su hora + 1,5 s.
4. Cada cliente la convierte a su hora local con el desfase medido por `ping/pong`.

En la prueba de Chrome, las dos ventanas largaron con 1–6 ms de diferencia.

### Pruebas

`tests/salas_cf_test.mjs` (13/13), con 7 clientes WebSocket contra `workerd`:

- creación y lista de salas;
- 6 lugares distintos y el séptimo rechazado;
- sólo el anfitrión larga;
- la largada espera a los seis y llega a todos con la misma hora;
- reenvío de autos: cada uno recibe exactamente 5 × 20 mensajes y nunca los propios;
- traspaso del anfitrión, reconexión con el mismo lugar, bloqueo de entrada en carrera, sala vacía al final.

`tests/chrome_online.mjs` (13/13), con dos ventanas de Chrome y el juego:

- la sala se crea y se entra desde el panel;
- la largada coordinada por la sala;
- cada juego registra solo las teclas de su ventana;
- cada uno ve al otro delante y en movimiento;
- vueltas y orden coinciden;
- al cerrar J2, J1 sigue y el auto de J2 vuelve a la IA.

La ida y vuelta al Durable Object local fue de 68–90 ms en Chrome (Chrome y `workerd` en la misma máquina de
2 núcleos, junto con los dos emuladores).

Capturas en `tests/logs/fase3/chrome/`.

### Publicar

Ver `cloudflare/README.md`. Hay dos opciones:

- todo en Cloudflare: `npm run deploy` publica sitio y salas;
- sitio en Netlify y salas en Cloudflare: se pone la URL del Worker en `web/config.js`.

El panel «Salas online» ahora usa Cloudflare. El gestor anterior (Netlify Functions + Blobs: `web/lobby.js`,
`netlify/functions/rooms.mjs`) quedó sin uso; se puede borrar.

## 4. Joystick / mando

**Hallazgos en el EXE:**

- El juego lee joysticks con `joyGetPosEx` (WINMM).
- `DAYTONA.INI → [Input] Device=` elige el dispositivo: `KEYBOARD`, `PC_ANALOG`, `PC_HANDLE`, `SEGA_DIGITAL` o
  `SEGA_ANALOG`. La variable del juego es `0x48ABB0`.
- La calibración se lee de `PC_Analog=%d,…`; si no está, usa 0 / 32768 / 65535 en cada eje.

Medido con el EXE original:

| Modo | Dirección (eje X) | Acelerar | Frenar | Teclado |
|---|---|---|---|---|
| `PC_HANDLE` (volante) | **proporcional y lineal**, −128…127 | botón 3 | botón 6 | no maneja (sólo menús) |
| `PC_ANALOG` | en la práctica digital (umbral ~1/3 del recorrido) | botón 3 | — | no maneja |

**Implementación:**

- `src/win32/winmm.js`: `joyGetNumDevs`, `joyGetDevCapsA`, `joyGetPosEx` y `joyGetPos` reales, alimentados por la
  Gamepad API.
- `web/gamepad.js`, con dos modos (Ajustes → Mando / joystick):
  - **Como teclado** (por defecto): el mando aprieta las teclas del juego. Funciona sin reiniciar.
  - **Analógico**: la copia en memoria de `DAYTONA.INI` arranca con `Device=PC_HANDLE` y el mando se entrega como
    joystick de Windows. Requiere reiniciar el juego. El INI de tu carpeta no se toca.

**Mapeo del mando estándar (Xbox/PlayStation en Chrome):**

| Control del mando | Acción |
|---|---|
| Stick izquierdo / cruceta | Dirección |
| RT o A | Acelerar |
| LT, B o X | Frenar |
| Start | Enter |
| Back / Select | Esc |
| Y | Cámara (F5) |

En multijugador local (dos ventanas en la misma PC), J1 toma el mando 1 y J2 el mando 2. Se puede fijar en Ajustes.

**Prueba `tests/chrome_gamepad.mjs` (7/7):** Chrome sin pantalla no tiene mandos, así que se simula
`navigator.getGamepads` con un mando estándar. El resto es el camino real.

- Start recorre el menú.
- En los dos modos, RT y LT llegan al acelerador y al freno del juego.
- En modo analógico, medio stick da −56/+55 y el stick a fondo −128/+127: proporcional.

No pude probar un mando físico (el entorno de prueba no tiene). El mapeo sigue el «standard gamepad» de Chrome;
algún mando genérico puede necesitar elegir otro número de mando en Ajustes.

## Regresiones (todo vuelto a correr con el código final)

| Prueba | Resultado |
|---|---|
| Modo individual / ganchos (`hook_test`) | 9/9 |
| Autos (`cars_test`) | 9/9 |
| Menú original (`daytona_menu_test.sh`) | 10/10 |
| Multijugador local en Node (`mp_local_test`) | 12/12 |
| Multijugador local en Chrome, 2 ventanas (`chrome_mp_local`) | 13/13 |

Las pruebas en Chrome (local y online) se mejoraron en tres puntos:

- **Controles:** se verifican leyendo las entradas que registra el juego (acelerador `+0x68`, freno `+0x80`,
  volante `+0xA8`). La velocidad sola no alcanza: un auto de la IA que choca de atrás a uno que frena lo empuja
  (física original), y eso confundía la medición.
- **Teclas:** se comprueba que las teclas de una ventana no lleguen al juego de la otra.
- **Clasificación:** se juzga sólo con ventaja real clara.

## Limitaciones y cosas a saber

- **Tiempo límite del arcade:** el juego original tiene tiempo por tramo. Si a un jugador se le acaba, ve
  GAME OVER y su auto queda detenido en las pantallas de los demás. Pasó en una prueba automática con un auto muy
  lento. Desactivarlo para el online es un paso posible a futuro.
- **Choques:** el auto local es empujado por los remotos y por la IA (física original), pero un auto remoto no es
  empujado en la pantalla del otro.
- **Rivales de la IA:** cada jugador tiene los suyos. Los humanos están sincronizados; la IA no (ver la Fase 2 y
  la opción de «IA del anfitrión» propuesta).
- **Se ve con retraso:** cada jugador ve a los demás como estaban hace ~0,2 s (150 ms de interpolación + red). En
  peleas muy cerradas, el orden que muestra cada pantalla puede diferir por ese margen.
- **No hay espectadores:** no se puede entrar a una sala con la carrera en curso.
- **Rendimiento:** cada jugador necesita una PC que corra el emulador a ~20 fps, el tope del propio juego. Con
  6 jugadores la carga por PC es la misma; sólo crece el tráfico, de unos 5 × 20 mensajes por segundo de bajada.
