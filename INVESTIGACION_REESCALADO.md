# Resolución 3D real (opción 2): investigación y primera etapa

**Conclusión: es viable.** Ya capturé todos los polígonos 3D de un cuadro del EXE original y los redibujé fuera del
juego, con sus texturas, a 640×480 y a 1920×1440. La geometría coincide con la imagen original y a 3× los bordes
salen realmente nítidos. Falta resolver cuatro piezas (fondo, reflejos, transparencias y HUD) antes de que sirva
para jugar. Detalle abajo.

## Cómo dibuja Daytona USA (PC) — lo encontrado en el EXE

1. **Un polígono = una llamada a `0x454C10`.** Recibe un registro por cuadrilátero:
   - `+0x04` banderas: bit 0 elige el rasterizador A o B; bits 2–3, la orientación de la textura.
   - `+0x05` banco; `+0x06` número de material/textura.
   - `+0x08..+0x24` **cuatro vértices con coordenadas de pantalla en punto flotante** (x, y).
   - Pantalla = (x + 176) × 1,818 ; (y + 127) × 1,923.
   - Recién adentro se redondean a píxeles enteros. Es decir: **la precisión sub-píxel existe** y se puede usar
     para dibujar a más resolución.
2. **Textura:** `0x454C10` resuelve el material con las tablas `0xC0C090` y `0xBFD660`; si hace falta, la
   descomprime a una caché (`0x453C60`). Le pasa al rasterizador un descriptor (`0xC584A0`):
   - modo (0–3, cuál vértice es la esquina 0,0);
   - ancho y alto (hasta 128);
   - puntero a la imagen: **w×h píxeles de 16 bits RGB565**, el mismo formato de la pantalla, sin paleta.
3. **Rasterizadores:** `0x45DA10` (A) y `0x45E1E0` (B). Recorren el cuadrilátero por líneas y llaman a los
   trazadores de tramos `0x45E9B0` y `0x45F670`, que hacen mapeo afín de texturas, 2 píxeles por escritura. Pintan
   sobre la franja 3D de 640×400 que empieza en la línea 40 (arriba y abajo quedan bandas para el HUD).
4. **Orden:** pintor (de atrás hacia adelante). El orden de las llamadas ya es el orden correcto: no hace falta
   buffer de profundidad.
5. **Otros dibujantes** (encontrados vigilando qué código escribe cada píxel):
   - `0x429xxx` para el HUD: velocímetro, vuelta, posición, mapa;
   - `0x42993B` llamado desde la parte 3D (`0x454C09`): **reflejos del parabrisas** y efectos sobre los autos;
   - el **cielo**, que no pasa por estos caminos (fondo copiado aparte).

## Prototipo (captura de un cuadro real y redibujado)

`tools/investigacion/captura_poligonos.mjs` corre el juego hasta la carrera e intercepta `0x454C10` y los
rasterizadores durante un cuadro. Guarda los 597 polígonos (vértices flotantes, modo, textura) y las 86 texturas
usadas.

`tools/investigacion/redibujar.py` los vuelve a dibujar fuera del juego:

- usa el mapeo bilineal inverso del cuadrilátero, igual al que hace el rasterizador;
- a 640×480, contra el cuadro original:
  - zona de pista, auto y muro: **67 % de los píxeles casi idénticos** (72 % en el auto), con la geometría
    alineada;
  - el resto de la diferencia: textura muestreada en otro punto del píxel, más el cielo, los reflejos y el HUD,
    que no están en este prototipo;
- a 1920×1440: los bordes del auto, las rayas del techo y los carteles quedan nítidos.

Imágenes en `tests/logs/reescalado/`:

- `original_vs_redibujado_640.png`
- `auto_original_vs_3x.png`
- `redibujado_1920x1440.png`

## Lo que falta para que sea jugable

| Pieza | Qué hacer | Dificultad |
|---|---|---|
| Dibujar los polígonos con WebGL (en vivo) | Hook en `0x454C10` → lista por cuadro → WebGL a la resolución elegida, con mapeo bilineal inverso en el shader | media (lo central ya está probado) |
| Texturas | Subirlas a la GPU con caché por puntero + contenido (se descomprimen dinámicamente) | media |
| Cielo / fondo | Encontrar cómo se dibuja (copia de fondo) y escalarlo como capa trasera | media |
| Reflejos y efectos (`0x429xxx` desde 3D) | Entender su formato o, como mínimo, componerlos desde la imagen 640×480 con máscara | media-alta |
| Polígonos «B» (9 por cuadro) | Confirmar si son transparencias (color clave) y replicarlo | baja |
| HUD | Componerlo encima desde la imagen original 640×480, con máscara de los píxeles que escribe el HUD | media |
| Recorte (franja 640×400) y otras pistas/cámaras | Verificar los otros dos circuitos, las vistas y las pantallas de menú (allí se usa la imagen original) | media |

Ventaja extra: el dibujo de los polígonos pasaría a la placa de video. El emulador hoy gasta buena parte del
tiempo en esos bucles de píxeles, así que también podría subir la fluidez (habría que medirlo).

**Riesgo principal:** que alguno de los efectos (reflejos, humo, sombras) tenga formatos especiales que lleven más
ingeniería inversa. Hasta resolverlo, esos efectos se verían a 640×480 encima de la imagen nítida.

**Propuesta:** hacerlo en dos etapas.

1. **Primera etapa:**
   - polígonos 3D en WebGL a la resolución elegida;
   - cielo y HUD compuestos desde la imagen original;
   - opción «Resolución 3D real (experimental)» en Ajustes, que se puede apagar.
2. **Segunda etapa:** reflejos y efectos.

## Primera etapa — implementada

Opción **Ajustes → Video → «Resolución 3D real (experimental)»** (apagada por defecto). Funciona junto con el selector
de resolución: los polígonos se dibujan a la resolución de salida elegida (por ejemplo 2880×2160).

**Cómo funciona en vivo (`src/game/hires3d.js` + `web/video.js`):**

1. **Captura por cuadro.** Ganchos en `0x454C10` (vértices flotantes), `0x45DA10` / `0x45E1E0` (textura,
   orientación, transparencia, franja de recorte) y en sus retornos `0x454F77` / `0x454F9E`. Las texturas se copian
   en el momento del dibujo, con caché y comparación (una comparación completa por textura y por cuadro).
2. **Máscara de capas.** La memoria avisa qué código escribe en la pantalla. La vigilancia se apaga mientras
   rasteriza un polígono, porque esos píxeles los redibuja la GPU. Así quedan marcados sólo el HUD, los reflejos y
   los efectos que el juego pinta después del 3D.
3. **GPU (WebGL2), en tres pasadas:**
   1. fondo: la imagen original escalada (cielo y todo lo que no es 3D);
   2. los polígonos en su orden, con instancias, un atlas de texturas de 16 bits (RGB565 tal cual) y el mapeo
      **bilineal inverso** del cuadrilátero en el shader. El rasterizador «B» descarta el color clave `0x0020`;
   3. encima, HUD, reflejos y efectos desde la imagen original, según la máscara.

**Pruebas:**

- **Composición de referencia** (Python, a 640×480): mismo resultado visual que el juego. El 75,7 % de los
  píxeles es casi idéntico al cuadro original; la diferencia está en el muestreo de texturas y en los bordes.
- **WebGL contra esa referencia:** 100 % de los píxeles casi idénticos.
- **Imágenes:** `tests/logs/reescalado/reescalado_real_auto.png` (original ampliado / 3D real a 2880×2160) y
  `reescalado_real_cuadro.png`.
- **En el navegador:** el modo funciona en la demostración y en los menús con autos 3D, sin errores de WebGL.
- **Costo en el emulador:** +13 % de tiempo por cuadro con la captura activa (medido en Node). La GPU hace el resto.

**Limitaciones de esta etapa:**

- El cielo, el HUD, los reflejos del parabrisas y los efectos siguen a 640×480 (se ven nítidos, pero sin más
  detalle).
- Las texturas son las originales (≤128×128), muestreadas sin suavizar: a 4K se ven los «cuadraditos» de cada
  textura, como en el juego, pero los bordes de los polígonos quedan limpios.
- No pude medir la fluidez con una placa de video real: acá la GPU es simulada por software. Si en tu PC baja, se
  apaga con la misma casilla.
