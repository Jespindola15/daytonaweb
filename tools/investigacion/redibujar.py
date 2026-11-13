import json, base64, sys, numpy as np
from PIL import Image
D = sys.argv[1]; SCALE = float(sys.argv[2]); HYP = sys.argv[3]; OUTP = sys.argv[4]
items = json.load(open(f'{D}/items.json')); texs = json.load(open(f'{D}/texs.json'))
def tex_rgb(key, w, h):
    a = np.frombuffer(base64.b64decode(texs[key]), dtype='<u2').reshape(h, w)
    r = ((a >> 11) & 31) * 255 // 31; g = ((a >> 5) & 63) * 255 // 63; b = (a & 31) * 255 // 31
    return np.stack([r, g, b], -1).astype(np.uint8), a
ORDER = {0: (3, 2, 1, 0), 1: (2, 3, 0, 1), 2: (0, 1, 2, 3), 3: (1, 0, 3, 2)}
W, H = int(640 * SCALE), int(480 * SCALE)
img = np.zeros((H, W, 3), np.uint8)
def cross(a, b): return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]
def invbilinear(P, A, B, C, Dd):
    # iq: inverse bilinear. bilinear p(u,v) = A + (B-A)u + (D-A)v + (A-B+C-D)uv
    e = B - A; f = Dd - A; g = A - B + C - Dd; hh = P - A
    k2 = cross(g, f); k1 = cross(e, f) + cross(hh, g); k0 = cross(hh, e)
    u = np.full(P.shape[:-1], -1.0); v = np.full(P.shape[:-1], -1.0)
    if abs(k2) < 1e-6:
        with np.errstate(divide='ignore', invalid='ignore'):
            v = -k0 / k1; u = (hh[..., 0] - f[0] * v) / (e[0] + g[0] * v)
            u2 = (hh[..., 1] - f[1] * v) / (e[1] + g[1] * v)
            u = np.where(np.isfinite(u) & (np.abs(e[0] + g[0] * v) > np.abs(e[1] + g[1] * v)), u, u2)
        return u, v
    w = k1 * k1 - 4 * k0 * k2
    ok = w >= 0; ws = np.sqrt(np.maximum(w, 0))
    with np.errstate(divide='ignore', invalid='ignore'):
        v1 = (-k1 - ws) / (2 * k2); u1 = (hh[..., 0] - f[0] * v1) / (e[0] + g[0] * v1)
        alt = np.abs(e[0] + g[0] * v1) < 1e-6
        u1 = np.where(alt, (hh[..., 1] - f[1] * v1) / (e[1] + g[1] * v1), u1)
        v2 = (-k1 + ws) / (2 * k2); u2 = (hh[..., 0] - f[0] * v2) / (e[0] + g[0] * v2)
        alt = np.abs(e[0] + g[0] * v2) < 1e-6
        u2 = np.where(alt, (hh[..., 1] - f[1] * v2) / (e[1] + g[1] * v2), u2)
    in1 = (u1 >= 0) & (u1 <= 1) & (v1 >= 0) & (v1 <= 1)
    u = np.where(in1, u1, u2); v = np.where(in1, v1, v2)
    u = np.where(ok, u, -1); v = np.where(ok, v, -1)
    return u, v
for it in items:
    if it.get('kind') not in ('A', 'B') or it['key'] not in texs: continue
    w, h = it['w'], it['h']
    trgb, traw = tex_rgb(it['key'], w, h)
    V = (np.array(it['v']) + [it.get('offX', 0), it.get('offY', 0)]) * SCALE
    o = ORDER.get(it['mode'], ORDER[3])
    a, b, c, d = (V[i] for i in o)
    if HYP == 'H2': c, d = d, c
    x0, y0 = np.floor(V.min(0)).astype(int); x1, y1 = np.ceil(V.max(0)).astype(int)
    x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W - 1), min(y1, H - 1)
    if x1 < x0 or y1 < y0: continue
    ys, xs = np.mgrid[y0:y1 + 1, x0:x1 + 1]
    P = np.stack([xs + 0.5, ys + 0.5], -1).astype(float)
    u, v = invbilinear(P, a, b, c, d)
    m = (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
    tx = np.clip((u * w).astype(int), 0, w - 1); ty = np.clip((v * h).astype(int), 0, h - 1)
    col = trgb[ty, tx]
    if it['kind'] == 'B': m &= traw[ty, tx] != 0          # hipótesis: B = transparente (color 0)
    sub = img[y0:y1 + 1, x0:x1 + 1]; sub[m] = col[m]
Image.fromarray(img).save(OUTP)
if SCALE == 1:
    orig = np.array(Image.open(f'{D}/orig.png').convert('RGB')).astype(int)
    diff = np.abs(orig - img.astype(int)).sum(-1)
    region = np.zeros_like(diff, bool); region[60:470, 0:500] = True     # zona 3D (sin el HUD de la derecha)
    print(HYP, 'error medio zona 3D:', round(diff[region].mean(), 1), '· píxeles casi iguales (<24):', round((diff[region] < 24).mean() * 100, 1), '%')
