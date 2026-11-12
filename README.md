# daytona-web — prototipo para ejecutar el `DAYTONA.EXE` original (PC, 1996) en Chrome

Ejecuta el **binario PE32 original**: lo interpreta instrucción por instrucción (x86 de 32 bits + x87) en
JavaScript dentro de la pestaña, e implementa en JS las APIs de Windows que importa (KERNEL32, USER32, GDI32,
WINMM, DDRAW, DSOUND). No arranca Windows, no usa Wine, no hay streaming y no hay nada recreado: el código
de juego que corre es el del EXE.

> **Estado (12/11/2026):** el `DAYTONA.EXE` original carga, muestra la demo de atracción, la pantalla de título y el
> menú **Mode Select** original, que responde al teclado. Funciona en Node y en Chrome. **No se probó todavía una
> carrera** y la velocidad es de ~6 fps del juego en Chrome (intérprete puro). Detalle y evidencia en `AVANCE_MENU.md`.

### Ver el menú en Chrome (resumen)

1. Desde la carpeta que contiene `daytona-web/`: `python -m http.server 8137`
2. Abrí `http://localhost:8137/daytona-web/web/`, **📁 Elegir carpeta del juego** (la que tiene `DAYTONA.EXE`) → **▶ Iniciar**.
3. Esperá la demo (~30 s), hacé clic en el canvas y pulsá **Enter** (título) y **Enter** de nuevo (Mode Select).
   Flechas = mover el cursor. Teclas del `.INI`: X acelera, Z frena, F5–F8 cambian la vista.

## Cómo ejecutarlo (Windows, Mac o Linux)

Requisitos: Node.js 18+ (sólo para el modo consola) y cualquier servidor HTTP estático (los módulos ES no cargan desde `file://`).

**En Chrome**

```bash
cd daytona-web
python -m http.server 8137        # o: npx http-server -p 8137
```

1. Abrí `http://localhost:8137/web/`.
2. **📁 Elegir carpeta del juego** → la carpeta que contiene `DAYTONA.EXE`, los `.BIN` y `RES_USA.DLL`.
   Los archivos se leen localmente con la File API; no se suben a ningún lado.
3. Elegí `DAYTONA.EXE` en el desplegable → **▶ Iniciar**. El panel derecho muestra el log por etapas;
   **💾 Guardar log** lo descarga como .txt.

**En consola (mismo motor, ideal para comparar logs)**

```bash
node tools/run-node.mjs "C:\ruta\DAYTONA\DAYTONA.EXE" --log daytona.log --frame ultimo_frame.png
node tools/run-node.mjs "C:\ruta\DAYTONA\DAYTONA.EXE" --max 0      # sólo análisis PE + cobertura de importaciones
sh tests/daytona_menu_test.sh "C:/ruta/DAYTONA"                       # demo -> título -> menú, con 10 verificaciones
```

Código de salida: 0 = el programa terminó, 3 = se detuvo (el log dice por qué).

## Cómo funciona

```
DAYTONA.EXE ──parsePE──> secciones mapeadas en 0x400000 (ArrayBuffer de 256 MiB)
                │
                ├─ tabla de importaciones: cada función → "thunk" en 0x00100000+4·i (IAT parcheada)
                ├─ relocaciones (DLLs como RES_USA.DLL se cargan y reubican en 0x02000000+)
                └─ TEB/PEB falsos en FS: (fs:[0] para SEH del CRT de MSVC)
CPU (src/cpu.js + src/fpu.js): intérprete x86-32 + x87
   └─ cuando EIP cae en la zona de thunks → función JS (stdcall/cdecl) → vuelve con EAX
DirectDraw/DirectSound: objetos COM con vtables reales en memoria emulada (el juego hace call [eax+N])
   ├─ superficies 8/16/32 bpp en memoria emulada → RGBA → <canvas> (putImageData)
   └─ buffers PCM → AudioBuffer de Web Audio (volumen/pan/frecuencia)
Cola de mensajes: el teclado del canvas se convierte en WM_KEYDOWN/GetAsyncKeyState.
PeekMessage vacío, Flip y Sleep ceden el control a requestAnimationFrame (no se congela la pestaña).
```

Si el juego llama a una API o ejecuta una instrucción que falta, **la ejecución se detiene** y el log
imprime: API/instrucción exacta, dirección del `CALL`, argumentos en pila, registros, últimos 16 EIP y
últimas APIs. Ninguna API desconocida "devuelve 0 y sigue" en silencio.

## Pruebas reales (logs en `tests/logs/`)

| Prueba | Qué ejercita | Resultado |
|---|---|---|
| `DDTEST.EXE` (Node y Chrome 153 headless) | ventana + WndProc con `WM_CREATE`, `CreateFileA/ReadFile` de `DATA\TEST.BIN`, `DirectDrawCreate`, modo 640×480×8, primaria + backbuffer, paleta, `Blt` colorfill, `Lock/Unlock/Flip` ×3, `DirectSoundCreate`, buffer PCM 22 kHz, `Play`, x87 (`fsin`, `fsqrt`, física masa-resorte), división de 64 bits | Terminó con código 0; 29 691 925 instrucciones; 3 frames en el canvas; valores impresos = cálculo independiente en Python (`q=376276 r=183737`, física `51067`, hash `3175297334`) |
| `CPUTEST_O0/O2.EXE` | 20 000 iteraciones de ALU 32 bits, 64 bits (`__divdi3`…), switch con jump table, structs, recursión, x87 | Los 4 hashes idénticos al mismo C compilado nativo: `int32=c1dffbad int64=f770bd8a mem=12eedeab fpu=452e82b5` |
| `RESTEST.EXE` + `RES_TEST.DLL` (como `RES_USA.DLL`) | `LoadLibraryA` de una DLL con ImageBase en conflicto → reubicada a 0x02000000, `DllMain`, `GetProcAddress` sobre exports reales, `LoadStringA` de STRINGTABLE | Código 0; strings correctas (`DAYTONA USA`, `PRESS START BUTTON`, …) |
| `CRT_HELLO.EXE` (CRT de MinGW) | caso de falla controlada | Se detiene en `MSVCRT.DLL!_initterm` llamada desde `0x004013ae`, con argumentos y traza (msvcrt no se implementa: Daytona trae su CRT enlazado estáticamente) |

Rendimiento medido del intérprete: ~16–20 MIPS en Node 22, ~66 MIPS de pico por slice en Chrome 153.

## APIs implementadas (ver `tests/logs/apis_implementadas.txt` para la lista completa)

- **KERNEL32 (139):** arranque del CRT de MSVC (GetVersion, GetCommandLineA, GetStartupInfoA, GetEnvironmentStrings*, GetCPInfo, LCMapString*, GetStringType*, MultiByteToWideChar…), heap/Virtual/Global/Local*, archivos sobre VFS (CreateFileA, ReadFile, WriteFile, SetFilePointer, FindFirst/NextFileA…), unidades (D: = CD-ROM virtual con etiqueta configurable), tiempo (GetTickCount, QueryPerformance*), TLS, critical sections, recursos (FindResourceA/LoadResource/…), .INI, LoadLibraryA/GetProcAddress.
- **USER32 (76):** RegisterClass*, CreateWindowExA (envía WM_NCCREATE/WM_CREATE), Peek/Get/Dispatch/Post/SendMessage, timers, GetAsyncKeyState/GetKeyState, LoadStringA, MessageBoxA (al log), wsprintfA/wvsprintfA, ShowCursor…
- **GDI32 (29):** objetos y consultas (GetDeviceCaps, GetStockObject…). El dibujo GDI se registra pero **no se rasteriza**.
- **WINMM (19):** timeGetTime, timeBeginPeriod, joystick (desenchufado), `mciSendCommandA` (CD-Audio virtual que responde pero no suena).
- **DDRAW:** `DirectDrawCreate`, `DirectDrawEnumerateA`, `DirectDrawCreateClipper`; IDirectDraw/IDirectDraw2 (SetCooperativeLevel, SetDisplayMode, EnumDisplayModes, GetCaps, CreateSurface, CreatePalette, CreateClipper, GetDisplayMode, WaitForVerticalBlank, GetAvailableVidMem…), IDirectDrawSurface (Lock, Unlock, Flip, Blt con colorfill/stretch/colorkey, BltFast, GetAttachedSurface, Set/GetPalette, Set/GetColorKey, GetSurfaceDesc, GetPixelFormat, IsLost, Restore, GetDC*), IDirectDrawPalette (Set/GetEntries).
- **DSOUND:** `DirectSoundCreate`, `DirectSoundEnumerateA`; IDirectSound (CreateSoundBuffer, DuplicateSoundBuffer, SetCooperativeLevel, GetCaps…), IDirectSoundBuffer (Lock con wrap, Unlock, Play/Stop, loop, Get/SetCurrentPosition, GetStatus, volumen, pan, frecuencia, SetFormat).
- **ADVAPI32 (6):** registro vacío (el juego usa sus valores por defecto).

## Pendiente / limitaciones conocidas

- **No probado con `DAYTONA.EXE`.** Cobertura de sus 160 importaciones: desconocida hasta correr `--max 0` sobre el archivo real.
- **MSACM32:** sin implementar a propósito (se detiene y muestra el formato pedido, p.ej. IMA-ADPCM).
- **Hilos:** `CreateThread` y los callbacks de `timeSetEvent` no existen; si Daytona mezcla audio en un hilo, hace falta un planificador cooperativo.
- **SEH:** se soporta la cadena `fs:[0]` del CRT, pero no se despachan excepciones (div/0, access violation → se detiene).
- **GDI:** `TextOut`/`BitBlt` sobre HDC de superficies no dibujan nada todavía.
- **Audio CD (música):** MCI responde, pero las pistas no suenan; plan: mapear pista N → `TRACKnn.ogg` en el VFS.
- **Audio en streaming:** cuando el juego reescribe un buffer en loop, se reconstruye el AudioBuffer (puede haber clics); lo correcto es un AudioWorklet con ring buffer.
- **x87:** usa doubles de 64 bits, no 80 bits. Las pruebas coinciden, pero la física podría divergir en casos límite.
- **Velocidad:** un intérprete puro no alcanza a un Pentium 90 (~90 M instr/s). El paso siguiente de rendimiento es un caché de bloques básicos → funciones JS/Wasm generadas (recompilación dinámica).
- Instrucciones no implementadas: BCD, `enter` anidado, prefijo 0x67, MMX/SSE (Daytona 1996 no las usa).

## Próximo paso concreto hacia el menú

1. Correr `node tools/run-node.mjs DAYTONA.EXE --max 0` → lista exacta de las 160 importaciones y cuáles faltan.
2. Correr sin límite y leer el bloque `[HALT]`. Implementar esa API o instrucción, repetir. Cada iteración es chica y verificable.
3. Al llegar a `SetDisplayMode` + primer `Flip` con imagen, comparar el frame (`--frame`) con una captura de cnc-ddraw en Windows.
4. Ahí recién medir velocidad y decidir el recompilador de bloques.
