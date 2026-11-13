// video.js — presentación de la imagen del juego con la placa de video (WebGL2), a la resolución elegida.
//
// Daytona USA (PC, 1996) dibuja siempre a 640×480 con su propio rasterizador. Esto NO agrega detalle: escala
// esa imagen a la resolución de salida elegida (hasta 4K) con filtros que se calculan en la GPU:
//   · nitido : «sharp bilinear» — píxeles nítidos y parejos a cualquier tamaño (sin el serrucho del vecino más cercano)
//   · suave  : bilineal
//   · hq     : bicúbico Catmull-Rom + nitidez adaptativa al contraste (estilo AMD CAS) — el más «HD»
//   · crt    : líneas de barrido + máscara de fósforo, como un monitor de tubo
// Si el navegador no tiene WebGL2, se usa el dibujo 2D de siempre (640×480).

export const RESOLUTIONS = {
  auto: null,                      // tamaño real de la ventana (× densidad de píxeles), hasta 4K
  '480': [640, 480], '720': [960, 720], '1080': [1440, 1080], '1440': [1920, 1440], '2160': [2880, 2160],
};

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FS_HEAD = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D tex; uniform vec2 srcSize; uniform vec2 outSize; uniform float sharp;
`;
const FS = {
  // vecino más cercano «inteligente»: cada píxel del juego ocupa un bloque parejo; sólo se interpola el borde
  nitido: FS_HEAD + `
void main() {
  vec2 texel = uv * srcSize;
  vec2 scale = max(floor(outSize / srcSize), vec2(1.0));
  vec2 region = 0.5 - 0.5 / scale;
  vec2 d = fract(texel) - 0.5;
  vec2 f = (d - clamp(d, -region, region)) * scale + 0.5;
  o = vec4(texture(tex, (floor(texel) + f) / srcSize).rgb, 1.0);
}`,
  suave: FS_HEAD + `void main() { o = vec4(texture(tex, uv).rgb, 1.0); }`,
  // Catmull-Rom con 9 lecturas bilineales (aprovecha el filtrado del hardware)
  hq: FS_HEAD + `
void main() {
  vec2 pos = uv * srcSize;
  vec2 tc = floor(pos - 0.5) + 0.5;
  vec2 f = pos - tc;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 off12 = w2 / w12;
  vec2 t0 = (tc - 1.0) / srcSize, t3 = (tc + 2.0) / srcSize, t12 = (tc + off12) / srcSize;
  vec3 c = vec3(0.0);
  c += texture(tex, vec2(t0.x, t0.y)).rgb * w0.x * w0.y;
  c += texture(tex, vec2(t12.x, t0.y)).rgb * w12.x * w0.y;
  c += texture(tex, vec2(t3.x, t0.y)).rgb * w3.x * w0.y;
  c += texture(tex, vec2(t0.x, t12.y)).rgb * w0.x * w12.y;
  c += texture(tex, vec2(t12.x, t12.y)).rgb * w12.x * w12.y;
  c += texture(tex, vec2(t3.x, t12.y)).rgb * w3.x * w12.y;
  c += texture(tex, vec2(t0.x, t3.y)).rgb * w0.x * w3.y;
  c += texture(tex, vec2(t12.x, t3.y)).rgb * w12.x * w3.y;
  c += texture(tex, vec2(t3.x, t3.y)).rgb * w3.x * w3.y;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  // monitor de tubo: cada línea del juego es un haz con caída gaussiana + máscara de apertura RGB
  crt: FS_HEAD + `
void main() {
  vec2 pos = uv * srcSize;
  float y = fract(pos.y) - 0.5;
  vec3 c = texture(tex, vec2(uv.x, (floor(pos.y) + 0.5) / srcSize.y)).rgb;
  float lum = dot(c, vec3(0.3, 0.59, 0.11));
  float width = mix(0.18, 0.30, lum);                 // las líneas brillantes se ensanchan, como en un tubo
  float beam = exp(-y * y / (2.0 * width * width));
  float px = mod(floor(gl_FragCoord.x), 3.0);
  vec3 mask = mix(vec3(0.82), vec3(1.12), vec3(px == 0.0, px == 1.0, px == 2.0));
  float strength = clamp((outSize.y / srcSize.y - 1.0) / 2.0, 0.0, 1.0);   // a 640×480 no hay lugar para líneas
  vec3 outc = mix(c, c * beam * 1.45 * mask, strength);
  o = vec4(pow(clamp(outc, 0.0, 1.0), vec3(0.95)), 1.0);
}`,
};
// segunda pasada del modo hq: nitidez adaptativa al contraste (CAS simplificado), a la resolución de salida
const FS_CAS = FS_HEAD + `
void main() {
  vec2 px = 1.0 / outSize;
  vec2 uv = vec2(uv.x, 1.0 - uv.y);   // la imagen intermedia (framebuffer) tiene el origen abajo
  vec3 c = texture(tex, uv).rgb;
  vec3 n = texture(tex, uv + vec2(0.0, -px.y)).rgb, s = texture(tex, uv + vec2(0.0, px.y)).rgb;
  vec3 e = texture(tex, uv + vec2(px.x, 0.0)).rgb, w = texture(tex, uv + vec2(-px.x, 0.0)).rgb;
  vec3 mn = min(c, min(min(n, s), min(e, w))), mx = max(c, max(max(n, s), max(e, w)));
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
  vec3 wt = -amp / mix(8.0, 5.0, sharp);
  o = vec4(clamp((c + wt * (n + s + e + w)) / (1.0 + 4.0 * wt), 0.0, 1.0), 1.0);
}`;

// ---- modo «resolución 3D real»: los polígonos del juego se redibujan en la GPU (ver src/game/hires3d.js) ----
const VS_POLY = `#version 300 es
precision highp float;
layout(location=0) in vec4 aP01; layout(location=1) in vec4 aP23; layout(location=2) in vec4 aRect;
layout(location=3) in vec4 aInfo; layout(location=4) in vec4 aClip;
uniform vec2 outSize; uniform float scale;
flat out vec2 c0; flat out vec2 c1; flat out vec2 c2; flat out vec2 c3; flat out vec4 rect; flat out vec4 info; flat out vec4 clip;
void main() {
  vec2 p[4] = vec2[4](aP01.xy, aP01.zw, aP23.xy, aP23.zw);
  int ids[6] = int[6](0, 1, 2, 0, 2, 3);
  vec2 q = p[ids[gl_VertexID]] * scale;
  // esquinas de la textura según el modo de orientación del juego (0x45DA10)
  int m = int(aInfo.x);
  ivec4 o = m == 0 ? ivec4(3, 2, 1, 0) : m == 1 ? ivec4(2, 3, 0, 1) : m == 2 ? ivec4(0, 1, 2, 3) : ivec4(1, 0, 3, 2);
  c0 = p[o.x] * scale; c1 = p[o.y] * scale; c2 = p[o.z] * scale; c3 = p[o.w] * scale;
  rect = aRect; info = aInfo; clip = aClip * scale;
  gl_Position = vec4(q.x / outSize.x * 2.0 - 1.0, 1.0 - q.y / outSize.y * 2.0, 0.0, 1.0);
}`;
const FS_POLY = `#version 300 es
precision highp float;
precision highp usampler2D;
flat in vec2 c0; flat in vec2 c1; flat in vec2 c2; flat in vec2 c3; flat in vec4 rect; flat in vec4 info; flat in vec4 clip;
uniform usampler2D atlas; uniform vec2 outSize;
out vec4 o;
float cr(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
void main() {
  vec2 P = vec2(gl_FragCoord.x, outSize.y - gl_FragCoord.y);
  if (P.x < clip.x || P.y < clip.y || P.x > clip.x + clip.z || P.y > clip.y + clip.w) discard;
  // bilineal inverso (el rasterizador del juego interpola el cuadrilátero, no dos triángulos)
  vec2 e = c1 - c0, f = c3 - c0, g = c0 - c1 + c2 - c3, h = P - c0;
  float k2 = cr(g, f), k1 = cr(e, f) + cr(h, g), k0 = cr(h, e);
  float u, v;
  if (abs(k2) < 1e-4 * max(1.0, abs(k1))) { v = -k0 / k1; }
  else {
    float w = k1 * k1 - 4.0 * k0 * k2; if (w < 0.0) discard;
    w = sqrt(w);
    v = (-k1 - w) / (2.0 * k2);
    if (v < -0.01 || v > 1.01) v = (-k1 + w) / (2.0 * k2);
  }
  float den = e.x + g.x * v;
  u = abs(den) > abs(e.y + g.y * v) ? (h.x - f.x * v) / den : (h.y - f.y * v) / (e.y + g.y * v);
  if (u < -0.01 || u > 1.01 || v < -0.01 || v > 1.01) discard;
  ivec2 t = ivec2(clamp(floor(vec2(u, v) * rect.zw), vec2(0.0), rect.zw - 1.0));
  uint c = texelFetch(atlas, ivec2(rect.xy) + t, 0).r;
  if (info.y > 0.5 && c == 32u) discard;            // transparente: color clave 0x0020 (rasterizador B)
  o = vec4(float((c >> 11) & 31u) / 31.0, float((c >> 5) & 63u) / 63.0, float(c & 31u) / 31.0, 1.0);
}`;
// capa de arriba: HUD, reflejos y efectos (píxeles que el juego pintó después del 3D), nítidos
const FS_OVER = FS_HEAD + `
uniform sampler2D mask;
void main() {
  if (texture(mask, uv).r < 0.5 / 255.0 * 5.0) discard;
  vec2 texel = uv * srcSize;
  vec2 scale = max(floor(outSize / srcSize), vec2(1.0));
  vec2 region = 0.5 - 0.5 / scale;
  vec2 d = fract(texel) - 0.5;
  vec2 f = (d - clamp(d, -region, region)) * scale + 0.5;
  o = vec4(texture(tex, (floor(texel) + f) / srcSize).rgb, 1.0);
}`;

export function createVideo(canvas, { onResize = () => {} } = {}) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  const V = { gl: !!gl, srcW: 640, srcH: 480, outW: 640, outH: 480, filter: 'hq', res: 'auto', has: false, frames: 0 };
  if (!gl) {
    // sin WebGL2: dibujo 2D a 640×480 (como antes)
    const ctx = canvas.getContext('2d'); let img = null;
    return Object.assign(V, {
      frame(rgba, w, h) { if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; img = null; onResize(); } if (!img) img = new ImageData(w, h); img.data.set(rgba); ctx.putImageData(img, 0, 0); V.frames++; },
      configure() {}, redraw() {}, size: () => [canvas.width, canvas.height],
    });
  }
  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const program = (fs) => {
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return { p, u: (n) => gl.getUniformLocation(p, n) };
  };
  const progs = Object.fromEntries(Object.entries(FS).map(([k, src]) => [k, program(src)]));
  const cas = program(FS_CAS);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const mkTex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; };
  const src = mkTex();
  let mid = null, fbo = null, midW = 0, midH = 0;
  const filterOf = (f) => (FS[f] ? f : 'hq');

  function outputSize() {
    const r = RESOLUTIONS[V.res];
    if (r) return r;
    // automática: lo que ocupa el juego en la ventana, en píxeles físicos (sin pasar de 4K)
    const dpr = Math.min(devicePixelRatio || 1, 3);
    const cssW = parseFloat(canvas.style.width) || V.srcW, cssH = parseFloat(canvas.style.height) || V.srcH;
    let w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    const k = Math.min(1, 2880 / w, 2160 / h); w = Math.round(w * k); h = Math.round(h * k);
    return [Math.max(w, V.srcW), Math.max(h, V.srcH)];
  }
  function draw() {
    if (!V.has) return;
    if (V.lastSnap) { drawHires(V.lastSnap); return; }
    const [w, h] = [V.outW, V.outH];
    const f = filterOf(V.filter), P = progs[f];
    gl.bindTexture(gl.TEXTURE_2D, src);
    const nearest = f === 'crt';
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    if (f === 'hq' && (w > V.srcW || h > V.srcH)) {
      if (!mid || midW !== w || midH !== h) {
        mid ||= mkTex(); gl.bindTexture(gl.TEXTURE_2D, mid); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        fbo ||= gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mid, 0);
        midW = w; midH = h;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h);
      gl.useProgram(P.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(P.u('tex'), 0); gl.uniform2f(P.u('srcSize'), V.srcW, V.srcH); gl.uniform2f(P.u('outSize'), w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
      gl.useProgram(cas.p); gl.bindTexture(gl.TEXTURE_2D, mid);
      gl.uniform1i(cas.u('tex'), 0); gl.uniform2f(cas.u('srcSize'), V.srcW, V.srcH); gl.uniform2f(cas.u('outSize'), w, h); gl.uniform1f(cas.u('sharp'), 0.6);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
      gl.useProgram(P.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(P.u('tex'), 0); gl.uniform2f(P.u('srcSize'), V.srcW, V.srcH); gl.uniform2f(P.u('outSize'), w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
  function resize() {
    const [w, h] = outputSize();
    if (w !== V.outW || h !== V.outH || canvas.width !== w || canvas.height !== h) { V.outW = w; V.outH = h; canvas.width = w; canvas.height = h; }
    draw();
  }
  // ---- recursos del modo 3D real ----
  let H = null;
  function hiresInit() {
    if (H) return H;
    const poly = program2(VS_POLY, FS_POLY), over = program(FS_OVER);
    const atlas = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, 2048, 2048);
    const mask = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, mask);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 640, 480);
    const inst = gl.createBuffer();
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    for (let i = 0; i < 5; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 80, i * 16); gl.vertexAttribDivisor(i, 1); }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    H = { poly, over, atlas, mask, inst, vao, slots: new Map(), shelfX: 0, shelfY: 0, shelfH: 0, data: new Float32Array(80 / 4 * 4096) };
    return H;
  }
  function program2(vsrc, fsrc) {
    const p = gl.createProgram(); gl.attachShader(p, compile(gl.VERTEX_SHADER, vsrc)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsrc)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return { p, u: (n) => gl.getUniformLocation(p, n) };
  }
  // lugar de cada textura en el atlas (estantes); si se llena, se vacía y se vuelve a llenar
  function slotFor(t) {
    let s = H.slots.get(t.key);
    if (!s) {
      if (H.shelfX + t.w > 2048) { H.shelfX = 0; H.shelfY += H.shelfH; H.shelfH = 0; }
      if (H.shelfY + t.h > 2048) { H.slots.clear(); H.shelfX = H.shelfY = H.shelfH = 0; }
      s = { x: H.shelfX, y: H.shelfY, ver: -2 }; H.slots.set(t.key, s);
      H.shelfX += t.w; H.shelfH = Math.max(H.shelfH, t.h);
    }
    if (s.ver !== t.ver) {
      gl.bindTexture(gl.TEXTURE_2D, H.atlas); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, s.x, s.y, t.w, t.h, gl.RED_INTEGER, gl.UNSIGNED_SHORT, t.data);
      s.ver = t.ver; V.texUploads = (V.texUploads || 0) + 1;
    }
    return s;
  }
  function drawHires(snap) {
    hiresInit();
    const [w, h] = [V.outW, V.outH], k = w / V.srcW;
    // 1) fondo: la imagen original (cielo, todo lo que no es 3D), escalada suave
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
    const B = progs.suave; gl.useProgram(B.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(B.u('tex'), 0); gl.uniform2f(B.u('srcSize'), V.srcW, V.srcH); gl.uniform2f(B.u('outSize'), w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // 2) los polígonos del juego, en su orden, a la resolución de salida
    const polys = snap.polys, n = Math.min(polys.length, 4096);
    if (n) {
      const d = H.data;
      for (let i = 0; i < n; i++) {
        const p = polys[i], s = slotFor(p.tex), o = i * 20, v = p.v;
        d[o] = v[0]; d[o + 1] = v[1]; d[o + 2] = v[2]; d[o + 3] = v[3]; d[o + 4] = v[4]; d[o + 5] = v[5]; d[o + 6] = v[6]; d[o + 7] = v[7];
        d[o + 8] = s.x; d[o + 9] = s.y; d[o + 10] = p.tex.w; d[o + 11] = p.tex.h;
        d[o + 12] = p.mode; d[o + 13] = p.transparent; d[o + 14] = 0; d[o + 15] = 0;
        d[o + 16] = p.clip[0]; d[o + 17] = p.clip[1]; d[o + 18] = p.clip[2]; d[o + 19] = p.clip[3];
      }
      gl.useProgram(H.poly.p); gl.bindVertexArray(H.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, H.inst); gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n * 20), gl.STREAM_DRAW);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, H.atlas);
      gl.uniform1i(H.poly.u('atlas'), 1); gl.uniform2f(H.poly.u('outSize'), w, h); gl.uniform1f(H.poly.u('scale'), k);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
      gl.bindVertexArray(null); gl.activeTexture(gl.TEXTURE0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }
    // 3) arriba: HUD, reflejos y efectos (lo que el juego pintó después del 3D), desde la imagen original
    if (snap.mask) {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, H.mask); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 640, 480, gl.RED, gl.UNSIGNED_BYTE, snap.mask);
      gl.useProgram(H.over.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(H.over.u('tex'), 0); gl.uniform1i(H.over.u('mask'), 1);
      gl.uniform2f(H.over.u('srcSize'), V.srcW, V.srcH); gl.uniform2f(H.over.u('outSize'), w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.activeTexture(gl.TEXTURE0);
    }
    V.hiresPolys = n;
  }

  return Object.assign(V, {
    // cuadro con «resolución 3D real»: imagen original + polígonos capturados del mismo cuadro
    frameHires(rgba, w, h, snap) {
      if (!snap || w !== 640 || h !== 480) return this.frame(rgba, w, h);
      gl.bindTexture(gl.TEXTURE_2D, src);
      if (w !== V.srcW || h !== V.srcH || !V.has) { V.srcW = w; V.srcH = h; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba); onResize(); resize(); }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      V.has = true; V.frames++; V.lastSnap = snap;
      drawHires(snap);
    },
    // un cuadro nuevo del juego (RGBA del tamaño original)
    frame(rgba, w, h) {
      gl.bindTexture(gl.TEXTURE_2D, src);
      if (w !== V.srcW || h !== V.srcH || !V.has) { V.srcW = w; V.srcH = h; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba); onResize(); resize(); }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      V.has = true; V.frames++; V.lastSnap = null;
      draw();
    },
    configure({ filter, res } = {}) { if (filter) V.filter = filter; if (res) V.res = res; resize(); },
    redraw: resize,
    // tamaño lógico (para ubicar el canvas en la ventana): siempre el del juego, 4:3
    size: () => [V.srcW, V.srcH],
  });
}
