"""Refine board corners on the camera part of an idChess video.

Usage: python3 corners.py VIDEO.mp4 GT.json x1,y1,x2,y2,x3,y3,x4,y4 OUT.json
Rough corners in pixels of the 720x480 camera region (any order).
Uses empty squares from the ground-truth position: edges between adjacent empty squares
(light|dark) must be sharp. Tries all 4 orientations k (same convention as BoardVision).
"""
import json
import math
import subprocess
import sys

import numpy as np

W, H = 720, 480
video, gt_path, rough, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
gt = json.load(open(gt_path))
pts = [float(v) for v in rough.split(',')]
pts = [(pts[i], pts[i + 1]) for i in range(0, 8, 2)]


def order_quad(p):
    cx = sum(x for x, _ in p) / 4
    cy = sum(y for _, y in p) / 4
    s = sorted(p, key=lambda q: math.atan2(q[1] - cy, q[0] - cx))
    start = min(range(4), key=lambda i: s[i][0] + s[i][1])
    return [s[(start + i) % 4] for i in range(4)]


def homography(dst):
    src = [(0, 0), (1, 0), (1, 1), (0, 1)]
    A, b = [], []
    for (x, y), (X, Y) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.append(X)
        A.append([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.append(Y)
    h = np.linalg.solve(np.array(A, float), np.array(b, float))
    return np.append(h, 1).reshape(3, 3)


def project(Hm, u, v):
    w = Hm[2, 0] * u + Hm[2, 1] * v + Hm[2, 2]
    return (Hm[0, 0] * u + Hm[0, 1] * v + Hm[0, 2]) / w, (Hm[1, 0] * u + Hm[1, 1] * v + Hm[1, 2]) / w


def sample(img, x, y):
    x = np.clip(x, 0, W - 1.001); y = np.clip(y, 0, H - 1.001)
    x0 = x.astype(int); y0 = y.astype(int); fx = x - x0; fy = y - y0
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) +
            img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)


def cell_of(sq, k):
    f, rk = 'abcdefgh'.index(sq[0]), int(sq[1]) - 1
    r, c = 7 - rk, f
    for _ in range(k):
        r, c = c, 7 - r
    return r, c


def empties(placement):
    rows = placement.split('/')
    out = set()
    for i, row in enumerate(rows):
        f = 0
        for ch in row:
            if ch.isdigit():
                for _ in range(int(ch)):
                    out.add('abcdefgh'[f] + str(8 - i)); f += 1
            else:
                f += 1
    return out


# median frame of the first stable segment
t1 = gt[1]['t'] if len(gt) > 1 else 3.0
ts = np.linspace(0.2, max(0.4, t1 - 0.3), 15)
frames = []
for t in ts:
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', video, '-frames:v', '1',
                          '-vf', f'crop={W}:{H}:0:0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                         capture_output=True).stdout
    if len(raw) == W * H:
        frames.append(np.frombuffer(raw, np.uint8).reshape(H, W).astype(np.float32))
img = np.median(np.stack(frames), axis=0)
emp = empties(gt[0]['placement'])

offs = np.linspace(0.25, 0.75, 6)
d = 0.15


def score(quad, k):
    Hm = homography(quad)
    cells = {cell_of(s, k) for s in emp}
    us, vs, us2, vs2 = [], [], [], []
    for (r, c) in cells:
        if (r, c + 1) in cells:
            for o in offs:
                us += [(c + 1 - d) / 8]; vs += [(r + o) / 8]; us2 += [(c + 1 + d) / 8]; vs2 += [(r + o) / 8]
        if (r + 1, c) in cells:
            for o in offs:
                us += [(c + o) / 8]; vs += [(r + 1 - d) / 8]; us2 += [(c + o) / 8]; vs2 += [(r + 1 + d) / 8]
    if not us:
        return 0
    x1, y1 = project(Hm, np.array(us), np.array(vs))
    x2, y2 = project(Hm, np.array(us2), np.array(vs2))
    return float(np.mean(np.abs(sample(img, x1, y1) - sample(img, x2, y2))))


def pieces(placement):
    rows = placement.split('/')
    out = {}
    for i, row in enumerate(rows):
        f = 0
        for ch in row:
            if ch.isdigit():
                f += int(ch)
            else:
                out['abcdefgh'[f] + str(8 - i)] = 'w' if ch.isupper() else 'b'; f += 1
    return out


def color_score(quad, k):
    # white pieces must look brighter than black ones (resolves k vs k+2)
    Hm = homography(quad)
    acc = {'w': [], 'b': []}
    for sq, col in pieces(gt[0]['placement']).items():
        r, c = cell_of(sq, k)
        u = np.array([(c + a) / 8 for a in (0.35, 0.5, 0.65) for _ in range(3)])
        v = np.array([(r + b) / 8 for _ in range(3) for b in (0.35, 0.5, 0.65)])
        x, y = project(Hm, u, v)
        acc[col].append(float(np.mean(sample(img, x, y))))
    return (np.mean(acc['w']) if acc['w'] else 0) - (np.mean(acc['b']) if acc['b'] else 0)


best = None
q0 = order_quad(pts)
for k in range(4):
    q = [list(p) for p in q0]
    s = score(q, k)
    for step in [8, 4, 2, 1, 0.5]:
        improved = True
        while improved:
            improved = False
            for i in range(4):
                for j in range(2):
                    for sgn in (1, -1):
                        q[i][j] += sgn * step
                        s2 = score(q, k)
                        if s2 > s + 1e-6:
                            s, improved = s2, True
                        else:
                            q[i][j] -= sgn * step
    cs = color_score(q, k)
    print('k', k, 'score', round(s, 1), 'white-black', round(cs, 1), [tuple(round(v, 1) for v in p) for p in q])
    key = (round(s, 0), cs)
    if not best or key > best[3]:
        best = (s, k, q, key)
s, k, q, _ = best
json.dump({'k': k, 'score': s, 'corners': [[x / W, y / H] for x, y in q], 'px': q}, open(out, 'w'))
print('best k', k, 'score', round(s, 1))
