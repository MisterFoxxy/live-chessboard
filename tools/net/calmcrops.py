"""Ответы сети «крупный план» по всем 64 клеткам в спокойные моменты клипа: python3 calmcrops.py NAME SRC.json model.pt [S=48]
-> cache/NAME_cp.npz: I (номера проверок из cache/NAME.npz), P (n, 64, 13) в порядке клеток a1..h8. Маска — как при обучении (BAND)."""
import sys, os, json, math, subprocess, numpy as np, cv2, torch, torch.nn.functional as F, chess
from fitlib import dlt, cell_of
name, src, model = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(model[:-3] + '.json')) if os.path.exists(model[:-3] + '.json') else {'ch': [12, 24, 40, 64, 96, 96], 'norm': 'fixed', 'band': os.environ.get('BAND', ''), 'crops': 'crops'}
os.environ['NORM'] = cfg['norm']; os.environ['BAND'] = cfg['band']
import cropnet, canon
S = int(sys.argv[4]) if len(sys.argv) > 4 else 48
torch.set_num_threads(4)
net = cropnet.CropLite(tuple(cfg['ch'])); net.load_state_dict(torch.load(model, map_location='cpu')); net.eval()
d = np.load(f'cache/{name}.npz'); T, PR, MV, K = d['t'], d['pr'].astype(np.float32), d['mov'].astype(np.float32), int(d['k'])
RC = [cell_of(chess.square_name(sq), K) for sq in chess.SQUARES]
rr = np.array([r for r, c in RC]); cc = np.array([c for r, c in RC])
want = {}
for i in range(len(T)):
    vis = (PR[i][3][rr, cc] < 0.5) & (MV[i][rr, cc] <= 6)
    if vis.sum() >= int(os.environ.get('MINVIS', 58)): want[round(float(T[i]), 3)] = i
meta = json.load(open(src)); VIDEO = src[:-5] + '.webm'
info = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', VIDEO], capture_output=True, text=True).stdout.strip().split(',')
W, H = int(info[0]), int(info[1])
quad = [(x * W, y * H) for x, y in meta['corners']]
cx = sum(p[0] for p in quad) / 4; cy = sum(p[1] for p in quad) / 4
s = sorted(quad, key=lambda q: math.atan2(q[1] - cy, q[0] - cx)); st = min(range(4), key=lambda i: s[i][0] + s[i][1])
quad = [s[(st + i) % 4] for i in range(4)]
N = 10 * S
NAD = canon.camera(quad, W, H); CAN = cfg['crops'] == 'ccrops'
M = dlt([(0, 0), (1, 0), (1, 1), (0, 1)], quad) @ np.array([[1 / (8 * S), 0, -1 / 8], [0, 1 / (8 * S), -1 / 8], [0, 0, 1]])
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', VIDEO, '-vf', 'fps=8', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
I, P = [], []
i = 0
while True:
    raw = p.stdout.read(W * H * 3)
    if len(raw) < W * H * 3: break
    t = round(i / 8, 3); i += 1
    if t not in want: continue
    f = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
    w = cv2.warpPerspective(f, M, (N, N), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    if CAN: X = canon.crops64(w, S, RC, NAD)
    else:
        X = np.empty((64, 64, 64, 3), np.uint8)
        for sq in range(64):
            r, c = RC[sq]; y0 = (r + 1) * S - S // 2; x0 = (c + 1) * S - S // 2
            X[sq] = cv2.resize(w[y0:y0 + 2 * S, x0:x0 + 2 * S], (64, 64), interpolation=cv2.INTER_AREA)
    with torch.no_grad(): P.append(F.softmax(net(cropnet.prep(X)), 1).numpy().astype(np.float16))
    I.append(want[t])
np.savez_compressed(f"cache/{name}_{os.environ.get('TAG', 'cp')}.npz", I=np.array(I), P=np.array(P))
print(name, 'calm reads with crop predictions', len(I))
