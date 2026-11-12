"""Кадры клипа с наложенной разметкой типов: python3 labelview.py NAME ОТЧЁТ out.png t1 t2 ...  (берёт ближайший размеченный снимок)"""
import sys, json, subprocess, math, numpy as np, cv2, chess
from fitlib import cell_of
name, R, out = sys.argv[1], sys.argv[2], sys.argv[3]; ts = [float(x) for x in sys.argv[4:]]
z = np.load(f'data13/{name}_auto.npz'); Y, T, K = z['Y'], z['T'], int(z['k'])
d = json.load(open(R + '/log.json')); W, H = 720, 1280; S = 90
quad = [(x * W, y * H) for x, y in d['corners']]
cx = sum(p[0] for p in quad) / 4; cy = sum(p[1] for p in quad) / 4
s = sorted(quad, key=lambda q: math.atan2(q[1] - cy, q[0] - cx)); st = min(range(4), key=lambda i: s[i][0] + s[i][1]); quad = [s[(st + i) % 4] for i in range(4)]
M = cv2.getPerspectiveTransform(np.float32(quad), np.float32([[0, 0], [8 * S, 0], [8 * S, 8 * S], [0, 8 * S]]))
names = '. P N B R Q K p n b r q k'.split(); tiles = []
for t in ts:
    j = int(np.argmin(np.abs(T - t))); tt = float(T[j])
    f = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(tt), '-i', R + '/video.webm', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
    w = cv2.warpPerspective(np.frombuffer(f, np.uint8).reshape(H, W, 3), M, (8 * S, 8 * S), flags=cv2.INTER_CUBIC)
    idx = np.arange(64).reshape(8, 8); o = None
    for n in range(4):
        g = np.rot90(idx, n); ra, ca = cell_of('a1', K); rh, ch = cell_of('h1', K)
        if g[7, 0] == ra * 8 + ca and g[7, 7] == rh * 8 + ch: o = np.ascontiguousarray(np.rot90(w, n)); break
    for sq in chess.SQUARES:
        r, c = cell_of(chess.square_name(sq), K); y = int(Y[j, r, c]); fi, ri = sq % 8, sq // 8
        if y == 0: continue
        txt = '?' if y < 0 else names[y]; col = (0, 0, 255) if y < 0 else (0, 255, 0)
        cv2.putText(o, txt, (fi * S + S - 30, (7 - ri) * S + S - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 5)
        cv2.putText(o, txt, (fi * S + S - 30, (7 - ri) * S + S - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.9, col, 2)
    for i in range(1, 8): cv2.line(o, (i * S, 0), (i * S, 8 * S), (0, 255, 255), 1); cv2.line(o, (0, i * S), (8 * S, i * S), (0, 255, 255), 1)
    cv2.putText(o, f'{tt:.1f}s', (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2); tiles.append(o)
cv2.imwrite(out, np.hstack(tiles)); print('ok')
