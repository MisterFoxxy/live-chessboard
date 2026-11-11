"""Align a known move list to the cached network reads (monotonic DP), then cut labelled training boards.
python3 align.py NAME SRC "move list" [maxdis]  -> data/NAME_auto.npz"""
import sys, os, json, math, subprocess, numpy as np, chess, cv2
from fitlib import cell_of, dlt
name, src, mlist = sys.argv[1], sys.argv[2], sys.argv[3].split()
MAXDIS = int(sys.argv[4]) if len(sys.argv) > 4 else 3
d = np.load(f'cache/{name}.npz')
T, PR, MV, K = d['t'], d['pr'].astype(np.float32), d['mov'].astype(np.float32), int(d['k'])
fen = str(d['fen'])
RC = [cell_of(chess.square_name(sq), K) for sq in chess.SQUARES]
rr = np.array([RC[s][0] for s in range(64)]); cc = np.array([RC[s][1] for s in range(64)])
b = chess.Board(fen) if fen else chess.Board()
pos = []
def cls(bd):
    a = np.zeros(64, np.int8)
    for sq, p in bd.piece_map().items(): a[sq] = 1 if p.color else 2
    return a
pos.append(cls(b))
for m in mlist: b.push_san(m); pos.append(cls(b))
pos = np.array(pos)                       # (n+1, 64)
R = len(T); N = len(pos)
cost = np.zeros((R, N), np.float32); vis_all = []
for r in range(R):
    pr = PR[r]; hand = pr[3][rr, cc] >= 0.5; mov = MV[r][rr, cc] > 6
    q = pr[:3][:, rr, cc].T; q = q / q.sum(1, keepdims=True)
    vis = ~hand & ~mov; vis_all.append(vis)
    c = np.minimum(4, -np.log(np.maximum(q, 1e-9)))       # (64,3)
    cost[r] = (c[np.arange(64)[None, :], pos] * vis[None, :]).sum(1)
# DP: k non-decreasing, at most 3 plies per read, penalty per ply
INF = 1e18; PEN = 2.0
D = np.full((R, N), INF); B = np.zeros((R, N), np.int32)
D[0, 0] = cost[0, 0]
for r in range(1, R):
    for k in range(N):
        best, arg = D[r - 1, k], k
        for j in (1, 2, 3):
            if k - j >= 0 and D[r - 1, k - j] + PEN * j < best: best, arg = D[r - 1, k - j] + PEN * j, k - j
        D[r, k] = best + cost[r, k]; B[r, k] = arg
k = N - 1 if D[-1, N - 1] < INF else int(np.argmin(D[-1]))
path = [k]
for r in range(R - 1, 0, -1): k = B[r, k]; path.append(k)
path = path[::-1]
times = {}
for r in range(1, R):
    if path[r] > path[r - 1]:
        for kk in range(path[r - 1] + 1, path[r] + 1): times[kk] = float(T[r])
print(name, 'reached ply', path[-1], 'of', N - 1, '; move times:', [(mlist[kk - 1], round(times[kk], 2)) for kk in sorted(times)][:6], '...')
# choose reads: stable (same ply for >= 0.75 s around), low motion, few disagreements
sel = []
for r in range(R):
    k = path[r]
    lo = max(0, r - 3); hi = min(R, r + 4)
    if any(path[x] != k for x in range(lo, hi)): continue
    vis = vis_all[r]
    pr = PR[r]; q = pr[:3][:, rr, cc].T; arg = q.argmax(1)
    dis = int(((arg != pos[k]) & vis & (q.max(1) >= 0.6)).sum())
    if dis > MAXDIS or vis.sum() < 40: continue
    sel.append((r, k))
sel = sel[::2]                       # 2 per second at 4 reads/s
print(name, 'selected', len(sel), 'boards')
# cut rectified boards at those times (same canvas as extract.py: 20 px/square, 1-square margin)
if src.endswith('.json'):
    meta = json.load(open(src)); VIDEO = src[:-5] + '.webm'
else:
    meta = json.load(open(src + '/log.json')); VIDEO = src + '/video.webm'
info = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', VIDEO], capture_output=True, text=True).stdout.split(',')
W, H = int(info[0]), int(info[1])
quad = [(x * W, y * H) for x, y in meta['corners']]
cx = sum(p[0] for p in quad) / 4; cy = sum(p[1] for p in quad) / 4
s = sorted(quad, key=lambda q: math.atan2(q[1] - cy, q[0] - cx)); st = min(range(4), key=lambda i: s[i][0] + s[i][1])
quad = [s[(st + i) % 4] for i in range(4)]
M = dlt([(0, 0), (1, 0), (1, 1), (0, 1)], quad) @ np.array([[1 / 160, 0, -1 / 8], [0, 1 / 160, -1 / 8], [0, 0, 1]])
want = {round(float(T[r]), 3): (r, k) for r, k in sel}
FPS_DEC = 8
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', VIDEO, '-vf', f'fps={FPS_DEC}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
X, Y, TT = [], [], []
i = 0
while True:
    raw = p.stdout.read(W * H * 3)
    if len(raw) < W * H * 3: break
    t = round(i / FPS_DEC, 3); i += 1
    if t not in want: continue
    r, k = want[t]
    f = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
    w = cv2.warpPerspective(cv2.GaussianBlur(f, (0, 0), 0.7), M, (200, 200), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    y = np.full((8, 8), -1, np.int8)
    still = MV[r][rr, cc] <= 6           # не двигалось — метка из позиции (в т.ч. там, где сеть видела «руку»)
    for sq in range(64):
        if still[sq]: y[RC[sq]] = pos[k][sq]
    X.append(w); Y.append(y); TT.append(t)
np.savez_compressed(f'data/{name}_auto.npz', X=np.array(X, np.uint8).reshape(-1, 200, 200, 3), Y=np.array(Y, np.int8).reshape(-1, 8, 8), T=np.array(TT), k=K)
print(name, 'saved', len(X))
