"""Check a recorded game against its video with the network: python3 verify_report.py REPORT_DIR model.pt"""
import sys, json, subprocess, numpy as np, torch, cv2, chess
import torch.nn.functional as F
from netdef import Net, normalize
from fitlib import dlt, cell_of
rd = sys.argv[1]
log = json.load(open(rd + '/log.json'))
net = Net(); net.load_state_dict(torch.load(sys.argv[2], map_location='cpu')); net.eval()
W, H = 720, 1280
quad = [(x * W, y * H) for x, y in log['corners']]
# the app orders corners on screen (TL, TR, BR, BL) before computing H
import math
cx = sum(p[0] for p in quad) / 4; cy = sum(p[1] for p in quad) / 4
s = sorted(quad, key=lambda q: math.atan2(q[1] - cy, q[0] - cx)); st = min(range(4), key=lambda i: s[i][0] + s[i][1])
quad = [s[(st + i) % 4] for i in range(4)]
Hm = dlt([(0, 0), (1, 0), (1, 1), (0, 1)], quad)
S, MG = 20, 1
A = np.array([[1 / (8 * S), 0, -MG / 8], [0, 1 / (8 * S), -MG / 8], [0, 0, 1]])
M = Hm @ A; K = log['k']
b = chess.Board(); occs = []
def occ(bd):
    o = np.zeros((8, 8), int)
    for sq, p in bd.piece_map().items():
        r, c = cell_of(chess.square_name(sq), K); o[r, c] = 1 if p.color else 2
    return o
occs.append(occ(b))
import os
hist = os.environ['HIST'].split() if os.environ.get('HIST') else log['history']
for san in hist: b.push_san(san); occs.append(occ(b))
FPS = 2
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', rd + '/video.webm', '-vf', f'fps={FPS}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
i = 0; last = 0; rows = []
while True:
    raw = p.stdout.read(W * H * 3)
    if len(raw) < W * H * 3: break
    f = np.frombuffer(raw, np.uint8).reshape(H, W, 3); t = i / FPS; i += 1
    w = cv2.warpPerspective(cv2.GaussianBlur(f, (0, 0), 0.7), M, (200, 200), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    x = torch.from_numpy(w[None]).permute(0, 3, 1, 2).float() / 255.
    x = F.interpolate(x, size=(160, 160), mode='bilinear', align_corners=False, antialias=True)
    with torch.no_grad(): pr = torch.softmax(net(normalize(x)), 1)[0].numpy()
    hand = pr[3] >= 0.5; arg = pr[:3].argmax(0); conf = pr[:3].max(0) >= 0.8
    vis = ~hand & conf
    if vis.sum() < 40: continue
    mism = [int(((arg != o) & vis).sum()) for o in occs]
    k = int(np.argmin(mism))
    names = {}
    for sq in chess.SQUARES:
        r, c = cell_of(chess.square_name(sq), K); names[(r, c)] = chess.square_name(sq)
    bad = [names[(r, c)] + ':' + 'EWB'[arg[r, c]] for r in range(8) for c in range(8) if vis[r, c] and arg[r, c] != occs[k][r, c]]
    rows.append((t, k, mism[k], int(vis.sum()), ' '.join(bad)))
for t, k, m, v, bd in rows: print(f'{t:6.1f}s  best ply {k:2d}  mismatched {m}  visible {v}  {bd}')
