# Daytona USA — menú original visible y funcionando (12/11/2026)

## Resultado verificado

Con el `DAYTONA.EXE` original, sin Windows, sin streaming y sin recrear nada:

| Etapa | Instrucción x86 | Evidencia |
|---|---|---|
| Carga (TABLE.BIN, DD_OVL*.BMP ×N, POLYGON.BIN, TEX_*.BIN, COURSE0.BIN…) | 0 – 393 M | `tests/logs/daytona/menu_run.log` |
| Demo de atracción (`PC_ADV.BIN`), render 3D por software del juego | 393 M → | `1_demo_atraccion_*.png` |
| Enter → pantalla de título (`PC_TITLE.BIN`) con "PRESS START BUTTON" parpadeando | 603 M | `2_titulo_*.png`, `2b/2c_*` |
| Enter → **Mode Select** (`PC_MODE.BIN`): ARCADE MODE / P C MODE / RANKING / OPTIONS | 803 M | `3_mode_select_*.png` |
| ↓ → el cursor pasa a P C MODE | 1 003 M | `4_mode_select_tras_flecha_abajo_*.png` |

Lo mismo en **Chrome 153** con teclado real sobre el canvas, sin errores JS (`chrome_*.png`, `chrome_prueba.txt`):
menú a los ~49 s de abrir la página, ~30 MIPS, ~6 fps del juego.

Prueba automática: `sh tests/daytona_menu_test.sh <carpeta_del_juego>` → **10/10** (`menu_test_resultado.txt`).

## Qué estaba mal y qué se corrigió

1. **Cadena de flip incompleta.** El juego pide primaria + **2** backbuffers (triple buffer); el prototipo creaba 1.
   Ahora `CreateSurface` arma la cadena real y `Flip` rota la memoria de los 3 buffers. (`GDITEST`: "flip3 back".)
2. **GDI sin píxeles.** `DAYTONA.EXE` (en `0x455740`) detecta el formato de color así: `GetDC` de la superficie,
   `SetPixel(RGB(255,255,0))`, `ReleaseDC`, `Lock` y lee el valor crudo. Con el `SetPixel` vacío anterior leía basura y
   convertía mal todos los gráficos. Experimento causal: misma versión, sólo con los stubs viejos de
   `SetPixel/GetPixel` → colores corruptos (`5_experimento_SetPixel_stub_colores_corruptos.png`).
   Nuevo `gdi_core.js`: DCs reales sobre superficies, ventana y bitmaps; `SetPixel/GetPixel/BitBlt/StretchBlt/PatBlt/
   StretchDIBits/SetDIBitsToDevice/GetDIBits/CreateDIBSection/LoadBitmapA/LoadImageA/FillRect`, paletas y conversiones
   8/16(555/565)/24/32 bpp.
3. **Ceder el control en cada `PeekMessage` vacío.** Tras pulsar una tecla el juego espera en un bucle de ~408
   instrucciones; el navegador cedía un frame (16 ms) por vuelta → congelamiento práctico en Chrome. Ahora sólo se cede
   al presentar o al agotar el tiempo del slice.
4. **Reloj real con un CPU 4–5× más lento que un Pentium 90.** Las pantallas temporizadas duraban muchos menos frames y
   cada corrida era distinta. Nuevo reloj **virtual** (90 000 instrucciones = 1 ms, seleccionable en la UI):
   determinista y con las proporciones originales.
5. **Presentación sólo en ciertos eventos.** Ahora hay un "barrido" de la primaria por frame del navegador, como un monitor.
6. Modo de pantalla por defecto 16 bpp (el README del juego lo exige), `DDBLT_KEYSRCOVERRIDE`, `EnumAttachedSurfaces`,
   `Release` que libera memoria, y Blt entre profundidades distintas que ahora avisa en lugar de corromper.

**Sobre el "frame negro" anterior:** la carga dura ~393 M instrucciones y la primera presentación con imagen llega
cerca de la instrucción 395 M; la prueba anterior de 400 M terminaba justo ahí, después de un Blt de borrado a negro.
Con los stubs viejos de GDI, igual se habría visto con colores corruptos (punto 2).

## Herramientas nuevas de diagnóstico (`tools/run-node.mjs`)

`--profile` (hotspots del código del juego) · `--trace-from N` (traza de APIs desde la instrucción N) ·
`--every K` (progreso + frame PNG cada K slices) · `--keys "instr:VK:1/0,..."` (teclado programado) ·
`--dump-surfaces DIR` (PNG + estadísticas de cada superficie) · `--clock virtual|real`, `--mhz 90`.
El log registra cada archivo abierto con su instrucción (`[FS]`).

## Lo que NO está probado / limitaciones

- No se entró a una carrera ni se probaron OPTIONS/RANKING/P C MODE. Puede haber APIs pendientes ahí
  (`DialogBoxParamA`, `WinHelpA`, `RaiseException` siguen sin implementar y detendrían la ejecución).
- **Velocidad:** ~30 MIPS en Chrome = ~6 fps del juego (un Pentium 90 hace ~90 MIPS). Jugable requiere recompilación
  dinámica de bloques (x86 → JS/Wasm) o un Web Worker + optimización del intérprete.
- **Audio:** la música es CD-Audio (`MCI PLAY` llega, no suena). Los efectos DirectSound no se verificaron todavía.
- El texto GDI (`TextOut`) sólo se dibuja si el host ofrece `renderText`; Daytona no lo usó en este recorrido.
- Las expectativas de `GDITEST` se calcularon según la documentación de GDI/DirectDraw; no se contrastaron en un
  Windows real.

## Próximo paso concreto

Recorrer ARCADE MODE → selección de circuito → transmisión → inicio de carrera con `--keys`, anotando cada `[HALT]`.
En paralelo, medir con `--profile` las funciones calientes del render (`0x45f000–0x460600`) para orientar el JIT de bloques.
