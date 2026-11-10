"""Samples from the user's own games: python3 user_extract.py u1 [fps]
Uses test metadata (corners, k, expected moves, move times). Keeps frames where the board is still."""
import os, sys, json, subprocess
import numpy as np, cv2, chess
from fitlib import dlt, cell_of
O = os.environ.get('TEST_DIR', 'test/')
u = sys.argv[1]; FPS = float(sys.argv[2]) if len(sys.argv) > 2 else 10
meta = json.load(open(O + u + '.json'))
info = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', O + u + '.webm'], capture_output=True, text=True).stdout.split(',')
Wv, Hv = int(info[0]), int(info[1])
S, MG = 20, 1; SZ = S * 10
quad = [(x * Wv, y * Hv) for x, y in meta['corners']]
Hm = dlt([(0, 0), (1, 0), (1, 1), (0, 1)], quad)
A = np.array([[1 / (8 * S), 0, -MG / 8], [0, 1 / (8 * S), -MG / 8], [0, 0, 1]])
M = Hm @ A
K = meta['k']
board = chess.Board(meta['fen'])
pos = [board.board_fen()]
for san in meta['expected']:
    board.push_san(san); pos.append(board.board_fen())
times = meta['times']
def labels(fen):
    y = np.zeros((8, 8), np.int8)
    b = chess.Board(fen + ' w - - 0 1')
    for sqi, p in b.piece_map().items():
        r, c = cell_of(chess.square_name(sqi), K)
        y[r, c] = 1 if p.color else 2
    return y
proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', O + u + '.webm', '-vf', f'fps={FPS}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
frames = []
fi = 0
while True:
    raw = proc.stdout.read(Wv * Hv * 3)
    if len(raw) < Wv * Hv * 3: break
    f = np.frombuffer(raw, np.uint8).reshape(Hv, Wv, 3)
    w = cv2.warpPerspective(cv2.GaussianBlur(f, (0, 0), 0.7), M, (SZ, SZ), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    frames.append((fi / FPS, w)); fi += 1
# stillness: max per-square change vs frames 0.3 s before and after
n = len(frames); lag = max(1, int(round(0.3 * FPS)))
X, Y, T = [], [], []
for i in range(lag, n - lag):
    t, w = frames[i]
    if t < meta.get('startAt', 0) - 0.5: continue
    a = np.abs(w.astype(np.float32) - frames[i - lag][1]).mean(2); b = np.abs(w.astype(np.float32) - frames[i + lag][1]).mean(2)
    d = np.maximum(a, b)[S:9 * S, S:9 * S].reshape(8, S, 8, S).mean((1, 3))
    nmov = int((d > 6).sum())
    # moves done before t (with margins)
    done = sum(1 for tm in times if tm <= t)
    near = any(abs(t - tm) < 0.35 for tm in times)
    if near or nmov > 0: continue
    y = labels(pos[done])
    X.append(w); Y.append(y); T.append(t)
X = np.array(X, np.uint8).reshape(-1, SZ, SZ, 3)
# thin out: keep at most one frame per 0.5 s
keep, last = [], -9
for i, t in enumerate(T):
    if t - last >= 0.5: keep.append(i); last = t
np.savez_compressed(f'data/{u}.npz', X=X[keep], Y=np.array(Y, np.int8)[keep], T=np.array(T)[keep], k=K)
print(u, 'frames', n, 'still', len(T), 'kept', len(keep))
