"""Крупные снимки фигур для сети типов: python3 crops.py ИМЯ SRC.json [S=48] -> crops/ИМЯ.npz
Берёт моменты и разметку из data13/ИМЯ_auto.npz, кадры — из видео рядом с SRC.json.
X: (n, 64, 64, 3) — вырез 2×2 клетки вокруг клетки (фигура наклонена от камеры), Y: 0 пусто, 1..6 белые PNBRQK, 7..12 чёрные,
G: номер доски (кадра), C: клетка (r*8+c) в координатах кадра."""
import sys, os, json, math, subprocess, numpy as np, cv2
from fitlib import dlt
name, src = sys.argv[1], sys.argv[2]
S = int(sys.argv[3]) if len(sys.argv) > 3 else 48
OUT = 64
import os as _os
NOEMPTY = bool(_os.environ.get('NOEMPTY'))   # для клипов с разметкой по слежению: «пусто» там ненадёжно
d = np.load(f'data13/{name}_auto.npz'); Y8, TT = d['Y'], d['T']
meta = json.load(open(src)); VIDEO = src[:-5] + '.webm'
info = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', VIDEO], capture_output=True, text=True).stdout.strip().split(',')
W, H = int(info[0]), int(info[1])
quad = [(x * W, y * H) for x, y in meta['corners']]
cx = sum(p[0] for p in quad) / 4; cy = sum(p[1] for p in quad) / 4
s = sorted(quad, key=lambda q: math.atan2(q[1] - cy, q[0] - cx)); st = min(range(4), key=lambda i: s[i][0] + s[i][1])
quad = [s[(st + i) % 4] for i in range(4)]
N = 10 * S   # доска 8 клеток + поле в 1 клетку
M = dlt([(0, 0), (1, 0), (1, 1), (0, 1)], quad) @ np.array([[1 / (8 * S), 0, -1 / 8], [0, 1 / (8 * S), -1 / 8], [0, 0, 1]])
want = {round(float(t), 3): i for i, t in enumerate(TT)}
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', VIDEO, '-vf', 'fps=8', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
rng = np.random.default_rng(1)
import canon
CANON = bool(_os.environ.get('CANON'))
DIRECT = bool(_os.environ.get('DIRECT'))   # снимки прямо из кадра, как в приложении -> dcrops/
NAD = canon.camera(quad, W, H)
if CANON: print(name, 'камера: надир (%.1f, %.1f) клеток, высота %.1f клеток' % NAD)
X, Y, G, C = [], [], [], []
i = 0
while True:
    raw = p.stdout.read(W * H * 3)
    if len(raw) < W * H * 3: break
    t = round(i / 8, 3); i += 1
    if t not in want: continue
    b = want[t]
    f = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
    w = cv2.warpPerspective(f, M, (N, N), flags=cv2.INTER_AREA if 8 * S < 400 else cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    w = cv2.warpPerspective(f, M, (N, N), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    cells = []
    for r in range(8):
        for c in range(8):
            y = int(Y8[b, r, c])
            if y < 0 or (y == 0 and (NOEMPTY or rng.random() > 0.12)): continue
            cells.append((r, c)); Y.append(y); G.append(b); C.append(r * 8 + c)
    if DIRECT: X.extend(canon.crops_direct(f, quad, cells, NAD))
    elif CANON: X.extend(canon.crops64(w, S, cells, NAD))
    else:
        for r, c in cells:
            y0 = (r + 1) * S - S // 2; x0 = (c + 1) * S - S // 2          # вырез 2S×2S с центром в центре клетки
            X.append(cv2.resize(w[y0:y0 + 2 * S, x0:x0 + 2 * S], (OUT, OUT), interpolation=cv2.INTER_AREA))
os.makedirs('dcrops' if DIRECT else 'ccrops' if CANON else 'crops', exist_ok=True)
np.savez_compressed(f"{'dcrops' if DIRECT else 'ccrops' if CANON else 'crops'}/{name}.npz", X=np.array(X, np.uint8), Y=np.array(Y, np.int8), G=np.array(G, np.int32), C=np.array(C, np.int8), k=meta['k'])
print(name, 'crops', len(X), 'boards', len(TT))
