# Multijugador — Fase 1: autos identificados en la memoria de DAYTONA.EXE (12/11/2026)

## Resultado

1. **Carrera jugable en Chrome**: Enter ×6 desde la demo (título → Mode Select → ARCADE → BEGINNER → caja) y X para
   acelerar. El auto responde al volante (girar 1,5 s cambia el rumbo 90°). Evidencia: `tests/logs/fase1/chrome_*`.
2. **Estructura de los autos** (ingeniería inversa sobre el EXE original, sin modificarlo):
   arreglo de **40 autos** en `.data`, dirección **`0x11B7AD4`**, **616 bytes (`0x268`) por auto**. **Auto 0 = jugador.**

| Offset | Campo | Cómo se verificó |
|---|---|---|
| `+0x000` | número de auto 0..39 | vale 0,1,2…39 en los 40 elementos |
| `+0x004` | velocidad en km/h | 294/77/36 km/h ↔ 183/48/22 mph del HUD en tres situaciones distintas |
| `+0x008` | velocidad interna (~922 por km/h) | proporcional al HUD en las mismas tres situaciones |
| `+0x00C/+0x010/+0x014` | posición X/Y/Z, punto fijo 16.16 | trayectoria continua; paso por cuadro ∝ velocidad; Y ≠ 0 sólo en peraltes |
| `+0x01C` | rumbo (16 bits, 65536 = 360°) | error mediano 1,7° contra la dirección real del movimiento (40 autos × 2 min) |
| `+0x024` | dirección de la velocidad | error mediano 0,5° |
| `+0x018/+0x020` | cabeceo / rolido (**candidatos**) | ≠ 0 en peraltes; falta verificación en un circuito con desniveles |
| `+0x034/+0x038` | punto objetivo de la IA | constante mientras el auto se acerca |
| `+0x0A8` | volante del jugador (−127..127) | −127 / +127 girando izquierda / derecha |
| `+0x180` | segmento de pista (0..480 en Beginner) | vuelve a 0 en los 113 cruces de meta observados |
| `+0x218` | vuelta (0 hasta cruzar la línea en la largada lanzada) | sube en cada cruce de meta |
| `+0x220` | posición en carrera (0 = primero) | permutación exacta 0..39 en todas las muestras; jugador 39 = "40/40" del HUD |

   Método: instantáneas de `.data` cuadro a cuadro → búsqueda de valores que cambian suavemente → autocorrelación
   de direcciones (paso 616 con exactamente 40 repeticiones). Para separar al jugador de la IA se aprovechó que la
   emulación es **determinista**: la misma carrera corrida dos veces, una girando a la izquierda y otra a la derecha
   (estado inicial idéntico byte a byte); sólo el auto 0 diverge.
3. **Funciones JS** (`src/game/daytona.js`): `readCar`, `readAllCars`, `readPoseRaw`, `writeCarPose`, `writePoseRaw`,
   `aheadOf`. En el navegador: `window.daytona.cars()`, `.car(i)`, `.move(i, {x,z,yaw})`, `.putAhead(i, dist)`.
   Ajustes → Video → «Telemetría del auto» muestra los datos en pantalla.
4. **Modificar un rival sin romper la carrera** (`node tests/cars_test.mjs <juego>` → **9/9**): el juego respeta la
   posición escrita (el segmento de pista se recalcula solo), el rival 10 se ve delante del jugador
   (`tests/logs/fase1/zoom_rival.png`) y, al soltarlo, sigue corriendo (265 km/h), la carrera continúa y las
   posiciones siguen siendo válidas. Repetido en Chrome con el mismo resultado.

## Límites y siguiente paso (Fase 2)

- Sólo se estudió Beginner. Las direcciones del arreglo no dependen del circuito, pero falta confirmar cabeceo y
  rolido en Advanced/Expert.
- Para "ver al otro jugador" el plan es usar un rival de la IA como **marioneta**: cada cuadro se escribe la pose
  recibida del otro jugador (posición, rumbo, velocidad) en un auto rival, por ejemplo el 39. Falta verificar qué
  campos hay que fijar para que la IA no lo mueva entre cuadros (velocidad y punto objetivo), y cómo afectan las
  colisiones.
