"""Build training samples from one idChess video.
Usage: python3 extract.py vNN
Writes data/vNN.npz: X (N,200,200,3) rectified boards (20 px/square, 1-square margin),
Y (N,8,8) labels 0 empty / 1 white / 2 black / -1 ignore (hand / change), T (N,) times.
"""
import sys, json, subprocess, os
import numpy as np, cv2
from PIL import Image
from fitlib import *

S, MG = 20, 1
SZ = S * (8 + 2 * MG)
FPS = 2.0
v = sys.argv[1]
gt = json.load(open(f'gt/{v}.json'))
rough = {l.split()[0]: [tuple(map(float, p.split(','))) for p in l.split()[1:]] for l in open('rough.txt')}
med = np.asarray(Image.open(f'med/{v}.png').convert('RGB')).astype(np.float32)
pts = xcorners(med.mean(2))
Hs, _ = search(quad_h(order_quad(rough[v])), pts)
H0, n0, rms0 = icp(Hs, pts)
pl0 = [g for g in gt if g['t'] <= 30]
pl0 = pl0[-1]['placement'] if pl0 else gt[0]['placement']
from shiftcheck import best_shift, shifted
_b = best_shift(H0, med.mean(2), pl0)[0]
H0 = shifted(H0, _b[1], _b[2]); K = _b[3]
print(v, 'shift', _b[1], _b[2], flush=True)
print(v, 'init fit', n0, round(rms0, 2), 'k', K, flush=True)

# canvas -> unit board coords -> image
A = np.array([[1 / (8 * S), 0, -MG / 8], [0, 1 / (8 * S), -MG / 8], [0, 0, 1]])

def labels(placement):
    occ = placement_sets(placement)
    y = np.zeros((8, 8), np.int8)
    for sq, col in occ.items():
        r, c = cell_of(sq, K)
        y[r, c] = 1 if col == 'w' else 2
    return y

segs = []
for i, g in enumerate(gt):
    t1 = gt[i + 1]['t'] if i + 1 < len(gt) else g['t'] + 30
    segs.append((g['t'], t1, g['placement']))

proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', f'{v}.mp4', '-vf', f'fps={FPS},crop=720:480:0:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
Hcur = H0
X, Y, T, Q = [], [], [], []
stats = {'segs': 0, 'used': 0, 'lost': 0, 'frames': 0, 'masked': 0}
fi = 0
si = 0
buf = []

def flush(seg, frames):
    global Hcur
    t0, t1, placement = seg
    if t1 - t0 < 2.6 or len(frames) < 3:
        return
    stats['segs'] += 1
    stack = np.stack([f for _, f in frames])
    medf = np.median(stack, 0).astype(np.float32)
    p = xcorners(medf.mean(2))
    Hn, n, rms = icp(Hcur, p, rads=(8, 5, 3))
    if n < 14 or rms > 1.5:
        Hs2, _ = search(Hcur, p, span=16, step=4)
        Hn, n, rms = icp(Hs2, p)
    if n < 14 or rms > 1.5:
        stats['lost'] += 1
        return
    Hcur = Hn
    stats['used'] += 1
    M = Hn @ A
    wmed = cv2.warpPerspective(medf, M, (SZ, SZ), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    win = [(t, f) for t, f in frames if t0 + 0.4 <= t <= t1 - 2.0]
    if not win:
        return
    pick = [win[int(round(j))] for j in np.linspace(0, len(win) - 1, min(3, len(win)))]
    y0 = labels(placement)
    for t, f in pick:
        w = cv2.warpPerspective(cv2.GaussianBlur(f, (0, 0), 0.7), M, (SZ, SZ), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
        d = np.abs(w.astype(np.float32) - wmed).mean(2)
        # per-square motion over the square and a quarter-square ring
        y = y0.copy()
        for r in range(8):
            for c in range(8):
                ya, yb = int((MG + r - 0.25) * S), int((MG + r + 1.25) * S)
                xa, xb = int((MG + c - 0.25) * S), int((MG + c + 1.25) * S)
                if np.percentile(d[ya:yb, xa:xb], 90) > 30:
                    y[r, c] = -1
        nm = int((y < 0).sum())
        stats['masked'] += nm
        if nm > 24:
            continue
        X.append(w.astype(np.uint8)); Y.append(y); T.append(t); Q.append((n, rms))
        stats['frames'] += 1

while True:
    raw = proc.stdout.read(W * H * 3)
    if len(raw) < W * H * 3:
        break
    t = fi / FPS; fi += 1
    f = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
    while si < len(segs) and t >= segs[si][1]:
        flush(segs[si], buf); buf = []; si += 1
    if si < len(segs) and t >= segs[si][0]:
        buf.append((t, f))
if si < len(segs):
    flush(segs[si], buf)
os.makedirs('data', exist_ok=True)
np.savez_compressed(f'data/{v}.npz', X=np.array(X, np.uint8).reshape(-1, SZ, SZ, 3), Y=np.array(Y, np.int8).reshape(-1, 8, 8), T=np.array(T), Q=np.array(Q).reshape(-1, 2), k=K)
print(v, stats, flush=True)
