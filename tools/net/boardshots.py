"""Rectified board crops with square names at given times: python3 boardshots.py REPORT out.png t1 t2 ..."""
import sys, json, math, subprocess, numpy as np, cv2, chess
from PIL import Image, ImageDraw
from fitlib import dlt, cell_of
rd, out = sys.argv[1], sys.argv[2]; times = [float(x) for x in sys.argv[3:]]
log = json.load(open(rd + '/log.json')); V = rd + '/video.webm'
W, H = 720, 1280
quad = [(x * W, y * H) for x, y in log['corners']]
cx = sum(p[0] for p in quad) / 4; cy = sum(p[1] for p in quad) / 4
s = sorted(quad, key=lambda q: math.atan2(q[1] - cy, q[0] - cx)); st = min(range(4), key=lambda i: s[i][0] + s[i][1])
quad = [s[(st + i) % 4] for i in range(4)]
S = 48
M = dlt([(0, 0), (1, 0), (1, 1), (0, 1)], quad) @ np.array([[1 / (8 * S), 0, -1 / 8], [0, 1 / (8 * S), -1 / 8], [0, 0, 1]])
K = log['k']; name = {}
for sq in chess.SQUARES: name[cell_of(chess.square_name(sq), K)] = chess.square_name(sq)
tiles = []
for t in times:
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', V, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    f = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
    w = cv2.warpPerspective(f, M, (10 * S, 10 * S), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    im = Image.fromarray(w); d = ImageDraw.Draw(im)
    for r in range(8):
        for c in range(8):
            d.text(((c + 1) * S + 2, (r + 1) * S + 1), name[(r, c)], fill=(255, 0, 0))
    d.text((4, 4), f'{t:.1f}s', fill=(255, 255, 0))
    tiles.append(im.resize((360, 360)))
cols = 3; sheet = Image.new('RGB', (360 * cols, 360 * ((len(tiles) + cols - 1) // cols)))
for i, tl in enumerate(tiles): sheet.paste(tl, ((i % cols) * 360, (i // cols) * 360))
sheet.save(out)
