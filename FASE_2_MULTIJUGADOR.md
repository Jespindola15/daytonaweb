# Fase 2 — Multijugador local (dos pestañas / ventanas)

Estado: **funciona y está demostrado en Chrome real**: dos páginas, cada una con su propia copia de
`DAYTONA.EXE` emulada, cada jugador maneja su auto con el teclado, y cada uno ve el auto original del
otro moviéndose dentro de su carrera. Detalles, pruebas y limitaciones abajo.

## Cómo se usa

1. `node tools/dev-server.mjs 8140` (o el sitio de Netlify) y abrir `http://localhost:8140/web/`.
2. Abrir la misma dirección en **otra ventana** del navegador (no otra pestaña de la misma ventana) y
   poner las dos lado a lado. Las dos tienen que estar visibles: Chrome deja de darle cuadros a una pestaña
   oculta y su juego se detiene.
3. Ventana 1: botón **2P** → **Crear sesión (J1)**.
4. Ventana 2: botón **2P** → **Unirse a la sesión XXXX como J2**.
5. J1: **Largar carrera**. Las dos ventanas reinician el juego, recorren solas el menú
   (Arcade → Beginner → Automática), se detienen en el primer cuadro de la carrera y largan a la vez.
6. Cada uno maneja con su teclado: X acelera, Z frena, ←/→ giran. Con una sola persona y un solo teclado se
   puede activar **Teclado compartido** (J1: flechas + X/Z, J2: A/D + W/S) — la ventana con foco reenvía
   las teclas del otro jugador por el canal.

El indicador de arriba a la izquierda muestra «J1 · conectado» / «sin señal» / «desconectado».

## Qué se identificó en el EXE (y dónde se intercepta)

Ciclo de un tick de lógica (encontrado desensamblando y con trazas de escritura en memoria):

| Dirección | Qué hace |
|---|---|
| `0x43A780` | función de cuadro → etapas vía `0x406530` |
| `0x44AB3E` → `0x4479D0` | actualiza autos: jugador (`0x448020`) y después rivales (`0x447C40`) |
| `0x447C40` | bucle de rivales: deja el auto actual en `[0x11B70A0]` y llama a `0x4481B0` |
| `0x4481B0` | **IA + física de UN rival** (`0x43F450`, `0x43F750`, `0x437DB0`, `0x436F20`, integración en `0x436FF0`, escribe X en `0x437198`); su tramo final `0x4481D0` calcula la ubicación en pista (`0x4379B0`) y el progreso para la clasificación |
| `0x42D1AD` (llamada desde el bucle, retorno `0x447CE5`) | ajuste al terreno/bordes (escribe en `0x451A1E`/`0x451A76`) |
| `0x44AB43` → `0x448A30` | colisiones auto-auto (escribe posiciones en `0x4596D5`/`0x45972D`) |
| `0x455650` → … → `0x43CF98` | dibujo de los autos (lee X/Y/Z/ángulos) |

Hooks (`src/game/daytona.js`, clase `RemoteCars`), elegidos para tocar lo mínimo:

1. **`0x4481B0`** — si el rival es un auto remoto, se ejecuta el prólogo original (`push esi; mov esi,[0x11B70A0]`),
   se escribe la pose remota y se salta a `0x4481D0`: no corre la IA ni la física de ese auto, pero el juego
   sigue calculando su ubicación en pista y su progreso (vueltas). Los demás 38 rivales no se tocan.
2. **`0x42D1AD`** — sólo cuando lo llama el bucle de rivales para el auto remoto: devuelve el mismo valor que la
   función (`[0x484A58]`) sin ajustar el auto al terreno (la altura ya viene del otro juego).
3. **`0x44AB48`** (después de las colisiones) — se reaplica la pose remota: el jugador local sí choca contra el
   auto remoto, pero la física local no puede empujar a un auto que maneja otra persona.
4. **`0x455650`** (antes de dibujar) — se aplica la pose remota interpolada para el instante del render.

La pose se pasa como función: se evalúa en el momento en que el juego la usa (cada tick y cada render).

Prueba `tests/hook_test.mjs` (reloj virtual, determinista) — **9/9**: el auto remoto mantiene su pose 40 cuadros
seguidos con 0 escrituras del juego; la física del jugador es idéntica bit a bit tick por tick; 26/27 rivales
lejanos idénticos bit a bit (el restante diverge sólo después de un cambio de clasificación, que es la IA
reaccionando a la carrera); el jugador choca contra el auto remoto (103 km/h contra 130 km/h sin él) y el remoto
no es empujado; sin hooks, el modo individual es idéntico bit a bit. Log: `tests/logs/fase2/hook_resultado.txt`.

Dato encontrado en el camino: durante la largada lanzada («ROLLING START», ~10 s) el juego **no** llama a
`0x4481B0` (los autos van guionados). Ahí el auto remoto se muestra gracias a los hooks 3 y 4.

## Sincronización (`src/net/multiplayer.js`)

- Auto local: lo calcula el motor original. Se transmite su pose cruda (X/Y/Z 16.16, rumbo/cabeceo/rolido/
  dirección de marcha, velocidad, segmento, vuelta, puesto) **tomada en el instante en que el juego presenta el
  cuadro** (`emu.onPresent`), con esa marca de tiempo y número de secuencia; 20 Hz + latido cada 500 ms.
- Auto remoto: rival 38 en las dos instancias. El J2 larga desde el lugar del 38 (se intercambian posiciones en
  la grilla), así cada uno ve al otro donde realmente está.
- Búfer de 64 estados, descarte de duplicados, **los paquetes desordenados se reinsertan en su lugar**,
  interpolación con 150 ms de retardo (ángulos con vuelta de 360°), extrapolación corta (≤120 ms) y
  **suavizado de correcciones** (cuando un paquete nuevo corrige la estimación, la diferencia se reparte en ~150 ms
  en vez de aplicarse de golpe). Reubicaciones reales (>60 unidades) no se suavizan.
- Estados: esperando / conectado / sin señal (>1,5 s) / desconectado (>5 s: el auto 38 vuelve a la IA).
- Identidad estable por pestaña en `sessionStorage` (se conserva al recargar; una ventana abierta desde otra
  recibe un id nuevo, porque Chrome copia el `sessionStorage` al abrirla).

## Sesión y largada común (`web/mplocal.js`)

BroadcastChannel `daytona-local-v1`. Mensajes: `announce`, `join`, `welcome`, `full`, `hb`, `start`, `go`, `car`,
`key`, `bye`. Al largar: las dos reinician el juego; desde el primer cuadro mandan Enter a los 2,5/5,5/8,5/11,5/
14,5/17,5 s; un hook en `0x447C40` (primer tick de autos después del menú) detiene la emulación — y su reloj —
en la grilla; cuando las dos avisaron `grid`, J1 manda `go` con una hora común (+400 ms) y las dos siguen a la vez.
Si el menú automático fallara, se puede navegar a mano: la barrera igual detiene cada juego al empezar la carrera.

## Pruebas

| Prueba | Qué demuestra | Resultado |
|---|---|---|
| `tests/chrome_mp_local.mjs` (Chrome real, 2 ventanas, BroadcastChannel) | sesión J1/J2; instancias independientes; cada uno frena/acelera/gira con **eventos de teclado reales de Chrome**; J2 visible delante en la pantalla de J1 y J1 en la de J2, moviéndose; vueltas iguales; al cerrar J2, J1 sigue | **11/11** |
| `tests/mp_local_test.mjs` (Node, 2 instancias, red simulada 40±60 ms y 5 % de pérdida) | precisión (p95 3,0/3,4 unidades), saltos por cuadro presentado, vueltas, desconexión | **12/12** |
| `tests/hook_test.mjs` | intercepción de IA/física, colisiones, modo individual intacto | **9/9** |
| `tests/cars_test.mjs`, `tests/daytona_menu_test.sh`, `tests/rooms_test.mjs` | regresiones de Fase 1, menú, salas | 9/9, 10/10, 9/9 |

Capturas de las dos instancias (`tests/logs/fase2/chrome/`): `J1_ve_a_J2_N.png` con `J2_mismo_instante_N.png`, y
`J2_ve_a_J1_N.png` con `J1_mismo_instante_N.png`; también la sesión (`0_sesion_J1/J2.png`) y J1 después de la
desconexión. El auto del otro jugador es el de la decoración verde (rival 38). Log completo en `log.txt`.

En la prueba de Chrome, la fase de persecución (para que un auto quede delante del otro) la maneja un piloto
automático que aprieta las mismas teclas del juego dentro de cada página; los controles manuales se verifican
aparte con eventos de teclado reales. Las dos ventanas corrieron a ~18-21 fps del juego (el límite del propio
juego es ~20) en una máquina de 2 núcleos.

## Audio (pedido durante esta fase)

- **Sonido acelerado — corregido.** Causa medida: el juego crea los búferes declarando 44100 Hz y llama a
  `SetFrequency` (22052, 11026, 8269 Hz…) **antes** de `Play`; el puente a Web Audio descartaba esa frecuencia
  porque todavía no existía la fuente, y todo sonaba al doble (o más) de velocidad. Ahora la frecuencia se guarda y
  se aplica al reproducir, al actualizar el búfer y al cambiarla en vivo; la posición de reproducción que lee el
  juego también avanza a esa frecuencia. En la última prueba de Chrome, las 108 voces creadas sonaron a la
  frecuencia fijada por el juego y no a los 44100 Hz del formato (p. ej. 44100→22052 Hz, →11556 Hz).
- **Volumen**: control en Ajustes → Sonido (0–100 %, se guarda), botón 🔊 en la barra y tecla **M** para silenciar.

## Errores encontrados y corregidos en esta fase

- Pines de memoria (primer enfoque) → reemplazados por los hooks: la IA ya no corre sobre el auto remoto.
- Pose y marca de tiempo desfasadas (se leía la pose en el envío, que podía incluir ticks del cuadro siguiente) →
  se captura en `onPresent`. Esto bajó los saltos de 9–17 unidades a ≤0,7 por encima de lo físicamente posible.
- Paquetes desordenados descartados → reinsertados.
- Dos ventanas con el mismo id (sessionStorage copiado al abrir con `window.open`) → id nuevo salvo en recarga.
- Dos pestañas en la misma ventana: la de atrás no recibe cuadros → se usan ventanas separadas y la UI lo avisa.

## Limitaciones conocidas

- **Puesto en pantalla del auto remoto**: el juego calcula el puesto del rival 38 con sus propios datos de
  progreso; en una de las dos direcciones lo muestra mal (p. ej. «puesto 1» cuando el otro es 37.º). El dato
  correcto llega por la red y se ve en el panel 2P; falta escribir el progreso de clasificación del remoto.
  Las vueltas sí coinciden.
- Los 38 rivales de la IA son independientes en cada ventana (cada juego tiene los suyos); sólo los dos autos
  humanos son compartidos.
- El auto remoto no recibe empujes de la física local (por diseño); si los dos chocan, cada uno ve su propio
  choque contra la posición del otro.
- Si una ventana se recarga, sale de la sesión (hay que volver a unirse y largar).
- Sólo pista Beginner/Automática en la largada automática. Fase 3 (online, Cloudflare) no empezada.
