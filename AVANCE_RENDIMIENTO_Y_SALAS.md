# Rendimiento (JIT), front nuevo y gestor de salas — 12/11/2026

## 1. Rendimiento: de ~4 fps a 12–50 fps

Nuevo **recompilador dinámico** (`src/jit.js`): cada bloque básico x86 se decodifica una sola vez y se traduce a
una función JavaScript que V8 compila a código máquina.

- Sin decodificación repetida (ModRM, prefijos e inmediatos ya resueltos como constantes).
- **Flags por flag individual**: un `cmp` seguido de `jz` sólo calcula ZF; los flags que nadie lee no se calculan.
- Operaciones de 16 bits (el juego pinta en 5-6-5 con registros de 16 bits) y x87 frecuentes en línea.
- Bucles cerrados que saltan a su propio inicio se iteran dentro de la misma función.
- Tabla directa de bloques para el rango del EXE; invalidación automática si el juego escribe sobre código.
- Lo que no se traduce se ejecuta con el intérprete dentro del mismo bloque (misma semántica ya probada).

| Medición (Chrome 153) | Antes (intérprete) | Ahora (JIT) |
|---|---|---|
| Demo 3D | ~4 fps | **12,5 fps** (95 MIPS) |
| Título | ~4 fps | **38 fps** |
| Menú Mode Select | ~6 fps | **47–51 fps** (220–290 MIPS) |

**Equivalencia verificada:** con el JIT el juego ejecuta exactamente el mismo recorrido que con el intérprete
(`PC_ADV.BIN` en la instrucción 393.047.980, `PC_TITLE.BIN` en 603.271.250) y el frame resultante es idéntico byte a byte.
Los hashes de `CPUTEST` siguen idénticos al código nativo; `GDITEST` 17/17; prueba del menú 10/10.

Pendiente para la carrera: la demo 3D sigue limitada por el render por software del juego (~7,5 M instrucciones por
cuadro). Próximas mejoras: llevar la emulación a un Web Worker y encadenar bloques sin volver al despachador.

## 2. Front nuevo

En pantalla sólo el juego, escalado a la ventana. Barra flotante (se oculta sola): pausa, pantalla completa, salas y
ajustes. Teclado global (no hace falta hacer clic en el juego). Ajustes guardados en el navegador: escalado
(ajustar / múltiplo entero / original), suavizado, FPS, presupuesto de CPU, reloj, registro técnico y traza.
Pantalla de carga con progreso; si los archivos del juego no están en el sitio, permite elegir la carpeta local.
Si el emulador se detiene, muestra el motivo y permite guardar el registro.

## 3. Gestor de salas online

- Backend: `netlify/functions/rooms.mjs` (Netlify Functions) con estado en **Netlify Blobs**; lógica en
  `server/rooms-core.mjs`. Cada cambio es una escritura condicional por etag con reintentos, así que dos jugadores
  que se unen al mismo tiempo no se pisan.
- Funciones: crear sala (nombre, 2–8 pilotos, código de 6 letras), listar, unirse por lista o código, "listo", chat,
  el anfitrión larga con cuenta regresiva sincronizada con el reloj del servidor (al llegar a cero, cada navegador
  reinicia su juego), reabrir la sala, salir. Si el anfitrión se va, el más antiguo pasa a serlo. Un jugador sin señal
  por 25 s sale solo; las salas vacías se borran. Los identificadores secretos de los jugadores nunca se exponen.
- Local: `node tools/dev-server.mjs` sirve el sitio + la misma API en memoria.
- Pruebas: `node tests/rooms_test.mjs` (9/9: cupo con 5 uniones simultáneas, permisos, saneo de texto, cambio de
  anfitrión) y prueba con dos navegadores reales (crear, unirse, chat, listo, largada → ambos reinician en ~0,1 s).

**Límite honesto:** `DAYTONA.EXE` (1996) no importa DirectPlay ni Winsock: el juego original no tiene modo en red.
Las salas reúnen a los jugadores y sincronizan la largada, pero cada uno corre su propia carrera. Para carreras
compartidas haría falta, por ejemplo, ejecución en "lockstep" (la emulación ya es determinista) combinada con algún
modo del juego que admita más de un auto controlado, cosa que la versión PC no tiene.

## Despliegue en Netlify

`netlify.toml` ya está configurado: build `node tools/build-site.mjs`, publica `dist/`, funciones en
`netlify/functions`. Netlify instala `@netlify/blobs` desde `package.json`. No hace falta configurar nada más.
