"""Board localisation helpers: X-corner detection + lattice ICP + GT-based orientation."""
import json, math, subprocess
import numpy as np
from scipy import ndimage as ndi

W, H = 720, 480

def order_quad(p):
    cx = sum(x for x, _ in p) / 4; cy = sum(y for _, y in p) / 4
    s = sorted(p, key=lambda q: math.atan2(q[1] - cy, q[0] - cx))
    start = min(range(4), key=lambda i: s[i][0] + s[i][1])
    return [s[(start + i) % 4] for i in range(4)]

def dlt(src, dst):
    src = np.asarray(src, float); dst = np.asarray(dst, float)
    A = []
    for (x, y), (X, Y) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -x * X, -y * X, -X])
        A.append([0, 0, 0, x, y, 1, -x * Y, -y * Y, -Y])
    _, _, vt = np.linalg.svd(np.asarray(A))
    h = vt[-1].reshape(3, 3)
    return h / h[2, 2]

def quad_h(quad):
    return dlt([(0, 0), (1, 0), (1, 1), (0, 1)], quad)

def proj(Hm, u, v):
    u = np.asarray(u, float); v = np.asarray(v, float)
    w = Hm[2, 0] * u + Hm[2, 1] * v + Hm[2, 2]
    return (Hm[0, 0] * u + Hm[0, 1] * v + Hm[0, 2]) / w, (Hm[1, 0] * u + Hm[1, 1] * v + Hm[1, 2]) / w

def corners_of(Hm):
    x, y = proj(Hm, [0, 1, 1, 0], [0, 0, 1, 1])
    return [(float(a), float(b)) for a, b in zip(x, y)]

def xcorners(gray, sigma=2.5, rel=0.08):
    g = ndi.gaussian_filter(gray.astype(np.float32), sigma)
    ixx = ndi.sobel(ndi.sobel(g, 1), 1); iyy = ndi.sobel(ndi.sobel(g, 0), 0); ixy = ndi.sobel(ndi.sobel(g, 0), 1)
    r = np.maximum(0, ixy * ixy - ixx * iyy)
    mx = ndi.maximum_filter(r, 7)
    pk = (r == mx) & (r > rel * np.percentile(r, 99.9))
    ys, xs = np.nonzero(pk)
    # subpixel: weighted centroid in 3x3
    pts = []
    for y, x in zip(ys, xs):
        if 2 <= y < r.shape[0] - 2 and 2 <= x < r.shape[1] - 2:
            w = r[y - 1:y + 2, x - 1:x + 2]
            s = w.sum()
            dy = (w.sum(1) * np.arange(-1, 2)).sum() / s; dx = (w.sum(0) * np.arange(-1, 2)).sum() / s
            pts.append((x + dx, y + dy, r[y, x]))
    return np.array(pts) if pts else np.zeros((0, 3))

INNER = np.array([(i / 8, j / 8) for i in range(1, 8) for j in range(1, 8)])

def match(Hm, pts, rad):
    x, y = proj(Hm, INNER[:, 0], INNER[:, 1])
    if len(pts) == 0:
        return np.zeros(0, int), np.zeros(0, int), np.zeros(0)
    d = np.hypot(x[:, None] - pts[None, :, 0], y[:, None] - pts[None, :, 1])
    j = d.argmin(1); dm = d[np.arange(len(x)), j]
    ok = dm < rad
    return np.nonzero(ok)[0], j[ok], dm[ok]

def icp(Hm, pts, rads=(14, 10, 7, 5, 3)):
    for rad in rads:
        for _ in range(4):
            li, pj, _ = match(Hm, pts, rad)
            if len(li) < 8:
                return Hm, len(li), 99.0
            Hn = dlt(INNER[li], pts[pj, :2])
            Hm = Hn
    li, pj, dm = match(Hm, pts, 3)
    return Hm, len(li), float(np.sqrt(np.mean(dm ** 2))) if len(dm) else 99.0

def search(H0, pts, span=24, step=4):
    """Coarse search over translation/scale/rotation around H0 maximising matched X-corners."""
    c = np.mean(corners_of(H0), axis=0)
    best = (-1, H0)
    for sc in (0.92, 0.96, 1.0, 1.04, 1.08):
        for rot in (-4, -2, 0, 2, 4):
            a = math.radians(rot)
            R = np.array([[sc * math.cos(a), -sc * math.sin(a), 0], [sc * math.sin(a), sc * math.cos(a), 0], [0, 0, 1]])
            T0 = np.array([[1, 0, -c[0]], [0, 1, -c[1]], [0, 0, 1]])
            for dx in range(-span, span + 1, step):
                for dy in range(-span, span + 1, step):
                    T1 = np.array([[1, 0, c[0] + dx], [0, 1, c[1] + dy], [0, 0, 1]])
                    Hm = T1 @ R @ T0 @ H0
                    n = len(match(Hm, pts, 5)[0])
                    if n > best[0]:
                        best = (n, Hm)
    return best[1], best[0]

def placement_sets(placement):
    occ = {}
    for i, row in enumerate(placement.split('/')):
        f = 0
        for ch in row:
            if ch.isdigit():
                f += int(ch)
            else:
                occ['abcdefgh'[f] + str(8 - i)] = 'w' if ch.isupper() else 'b'; f += 1
    return occ

def cell_of(sq, k):
    """square -> (row, col) in the board quad (row 0 = side of corner 0..1). Same convention as corners.py."""
    f, rk = 'abcdefgh'.index(sq[0]), int(sq[1]) - 1
    r, c = 7 - rk, f
    for _ in range(k):
        r, c = c, 7 - r
    return r, c

def sample(img, x, y):
    h, w = img.shape[:2]
    x = np.clip(x, 0, w - 1.001); y = np.clip(y, 0, h - 1.001)
    x0 = x.astype(int); y0 = y.astype(int); fx = x - x0; fy = y - y0
    if img.ndim == 3:
        fx = fx[..., None]; fy = fy[..., None]
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)

def orient(Hm, gray, placement):
    """Pick k: occupied squares differ from the empty-square checker colour; white pieces brighter than black."""
    occ = placement_sets(placement)
    best = None
    for k in range(4):
        # per-square mean brightness
        vals = {}
        for f in 'abcdefgh':
            for rk in range(1, 9):
                sq = f + str(rk)
                r, c = cell_of(sq, k)
                u = np.array([(c + a) / 8 for a in (0.3, 0.5, 0.7) for _ in range(3)])
                v = np.array([(r + b) / 8 for _ in range(3) for b in (0.3, 0.5, 0.7)])
                x, y = proj(Hm, u, v)
                vals[sq] = (float(np.mean(sample(gray, x, y))), float(np.std(sample(gray, x, y))), (r + c) % 2)
        # empty squares: light/dark by parity should separate cleanly
        e0 = [vals[s][0] for s in vals if s not in occ and vals[s][2] == 0]
        e1 = [vals[s][0] for s in vals if s not in occ and vals[s][2] == 1]
        w = [vals[s][0] for s in occ if occ[s] == 'w']; b = [vals[s][0] for s in occ if occ[s] == 'b']
        sep = abs(np.mean(e0) - np.mean(e1)) / (np.std(e0) + np.std(e1) + 5) if e0 and e1 else 0
        cs = (np.mean(w) - np.mean(b)) / 50 if w and b else 0
        score = sep + cs
        if best is None or score > best[0]:
            best = (score, k, sep, cs)
    return best

def grab(video, t, crop=True, gray=False):
    vf = 'crop=720:480:0:0' if crop else 'null'
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', video, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'gray' if gray else 'rgb24', '-'], capture_output=True).stdout
    n = W * H * (1 if gray else 3)
    if len(raw) != n:
        return None
    return np.frombuffer(raw, np.uint8).reshape((H, W) if gray else (H, W, 3))
