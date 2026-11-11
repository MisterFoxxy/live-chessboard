"""Cache network reads for a game: python3 cache_net.py NAME SRC model.pt rps [phase_s] -> cache/NAME.npz (t, pr, mov)
phase_s shifts the sampling (e.g. 0.125 at 4 rps) to test other frame timings."""
import sys, os, json, math, subprocess, numpy as np, torch, cv2
import torch.nn.functional as F
from netdef import Net, normalize
from fitlib import dlt
name, src, model, RPS = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
PHASE = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
if src.endswith('.json'):
    meta = json.load(open(src)); VIDEO = src[:-5] + '.webm'
else:
    meta = json.load(open(src + '/log.json')); VIDEO = src + '/video.webm'
info = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', VIDEO], capture_output=True, text=True).stdout.split(',')
W, H = int(info[0]), int(info[1])
net = Net(); net.load_state_dict(torch.load(model, map_location='cpu')); net.eval()
quad = [(x * W, y * H) for x, y in meta['corners']]
cx = sum(p[0] for p in quad) / 4; cy = sum(p[1] for p in quad) / 4
s = sorted(quad, key=lambda q: math.atan2(q[1] - cy, q[0] - cx)); st = min(range(4), key=lambda i: s[i][0] + s[i][1])
quad = [s[(st + i) % 4] for i in range(4)]
M = dlt([(0, 0), (1, 0), (1, 1), (0, 1)], quad) @ np.array([[1 / 160, 0, -1 / 8], [0, 1 / 160, -1 / 8], [0, 0, 1]])
FPS_DEC = RPS * 2
p = subprocess.Popen(['ffmpeg', '-v', 'error'] + (['-ss', str(PHASE)] if PHASE else []) + ['-i', VIDEO, '-vf', f'fps={FPS_DEC}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
T, PR, MV = [], [], []
i = 0; prevg = None
while True:
    raw = p.stdout.read(W * H * 3)
    if len(raw) < W * H * 3: break
    t = PHASE + i / FPS_DEC; i += 1
    f = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
    w = cv2.warpPerspective(cv2.GaussianBlur(f, (0, 0), 0.7), M, (200, 200), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    g = w.astype(np.float32).mean(2)
    if (i - 1) % 2 == 0: prevg = g; continue
    mov = np.abs(g - prevg)[20:180, 20:180].reshape(8, 20, 8, 20).mean((1, 3))
    x = F.interpolate(torch.from_numpy(w[None]).permute(0, 3, 1, 2).float() / 255., size=(160, 160), mode='bilinear', align_corners=False, antialias=True)
    with torch.no_grad(): pr = torch.softmax(net(normalize(x)), 1)[0].numpy()
    T.append(t); PR.append(pr.astype(np.float16)); MV.append(mov.astype(np.float16))
os.makedirs('cache', exist_ok=True)
np.savez_compressed(f'cache/{name}.npz', t=np.array(T), pr=np.array(PR), mov=np.array(MV), k=meta['k'], fen=meta.get('fen') or '')
print(name, len(T), 'reads')
