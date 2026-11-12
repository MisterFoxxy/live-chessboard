"""Кадры доски, выпрямленные и повёрнутые белыми вниз: python3 boardview.py ОТЧЁТ out.png t1 t2 ... [--s=60] [--cols=4]"""
import os, sys, json, subprocess, numpy as np, cv2, math
from fitlib import cell_of
R = sys.argv[1]; out = sys.argv[2]
ts = [float(x) for x in sys.argv[3:] if not x.startswith('--')]
S = 60; cols = 4
for a in sys.argv:
    if a.startswith('--s='): S = int(a[4:])
    if a.startswith('--cols='): cols = int(a[7:])
d = json.load(open(R + '/log.json')); k = d['k']
info = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', R + '/video.webm'], capture_output=True, text=True).stdout.strip().split(',')
W, H = int(info[0]), int(info[1])
quad = [(x * W, y * H) for x, y in d['corners']]
cx = sum(p[0] for p in quad) / 4; cy = sum(p[1] for p in quad) / 4
s = sorted(quad, key=lambda q: math.atan2(q[1] - cy, q[0] - cx)); st = min(range(4), key=lambda i: s[i][0] + s[i][1]); quad = [s[(st + i) % 4] for i in range(4)]
M = cv2.getPerspectiveTransform(np.float32(quad), np.float32([[0, 0], [8 * S, 0], [8 * S, 8 * S], [0, 8 * S]]))
def frame(t):
    f = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', R + '/video.webm', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
    img = np.frombuffer(f, np.uint8).reshape(H, W, 3)
    w = cv2.warpPerspective(img, M, (8 * S, 8 * S), flags=cv2.INTER_CUBIC)
    # повернуть всю доску целиком так, чтобы a1 была слева внизу, h1 — справа внизу
    idx = np.arange(64).reshape(8, 8)
    o = None
    for n in range(4):
        g = np.rot90(idx, n)
        ra, ca = cell_of('a1', k); rh, ch = cell_of('h1', k)
        if g[7, 0] == ra * 8 + ca and g[7, 7] == rh * 8 + ch: o = np.ascontiguousarray(np.rot90(w, n)); break
    assert o is not None, 'ориентация'
    for i in range(1, 8):
        cv2.line(o, (i * S, 0), (i * S, 8 * S), (0, 255, 255), 1); cv2.line(o, (0, i * S), (8 * S, i * S), (0, 255, 255), 1)
    for fi, fl in enumerate('abcdefgh'): cv2.putText(o, fl, (fi * S + 2, 8 * S - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
    for ri in range(8): cv2.putText(o, str(ri + 1), (2, (7 - ri) * S + 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
    cv2.putText(o, f'{t}s', (8 * S - 70, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 255), 2)
    cv2.rectangle(o, (0, 0), (8 * S - 1, 8 * S - 1), (255, 255, 255), 2)
    return o
fr = [frame(t) for t in ts]
while len(fr) % cols: fr.append(np.zeros_like(fr[0]))
cv2.imwrite(out, np.vstack([np.hstack(fr[i:i + cols]) for i in range(0, len(fr), cols)]))
print('ok', len(ts))
