"""Corners for the app from the calm start segment itself (its own frames and digital-board position)."""
import os
import json, sys, numpy as np
from fitlib import *
from shiftcheck import best_shift, shifted
O = os.environ.get('TEST_DIR', 'test/')
rough = {l.split()[0]: [tuple(map(float, p.split(','))) for p in l.split()[1:]] for l in open('rough.txt')}
for v in sys.argv[1:]:
    gt = json.load(open(f'gt/{v}.json')); meta = json.load(open(O + 'i' + v[1:] + '.json'))
    t0 = meta['startAt'] - 1.0
    i = max(j for j in range(len(gt)) if gt[j]['t'] <= t0 + 1e-6)
    t1 = gt[i + 1]['t'] if i + 1 < len(gt) else t0 + 3
    fr = [grab(f'{v}.mp4', t) for t in np.linspace(t0 + 0.3, t1 - 0.3, 7)]
    med = np.median(np.stack([f for f in fr if f is not None]), 0).astype(np.float32)
    g = med.mean(2); pts = xcorners(g)
    Hs, _ = search(quad_h(order_quad(rough[v])), pts); H0, n, rms = icp(Hs, pts)
    r = best_shift(H0, g, gt[i]['placement']); b = r[0]
    Hm = shifted(H0, b[1], b[2])
    meta['corners'] = [[x / 720, y / 480] for x, y in corners_of(Hm)]; meta['k'] = int(b[3])
    json.dump(meta, open(O + 'i' + v[1:] + '.json', 'w'))
    print(v, 'fit', n, round(rms, 2), 'shift', b[1], b[2], 'k', b[3], 'score', round(b[0], 2), 'next', round(r[1][0], 2))
