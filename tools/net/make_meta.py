import sys, json, numpy as np
import os
from PIL import Image
from fitlib import *
from shiftcheck import best_shift, shifted
O = os.environ.get('TEST_DIR', 'test/')
rough = {l.split()[0]: [tuple(map(float, p.split(','))) for p in l.split()[1:]] for l in open('rough.txt')}
for v in sys.argv[1:]:
    gt = json.load(open(f'gt/{v}.json')); mv = json.load(open(f'gt/{v}_moves.json'))
    # board position from a hand-free median of the first 20 s (the app's corners are fixed for the whole game)
    fr = [grab(f'{v}.mp4', t) for t in np.linspace(1, 20, 9)]
    med = np.median(np.stack([f for f in fr if f is not None]), 0).astype(np.float32)
    g = med.mean(2); pts = xcorners(g)
    Hs, _ = search(quad_h(order_quad(rough[v])), pts); H0, n, rms = icp(Hs, pts)
    b = best_shift(H0, g, gt[0]['placement'])[0]; Hm = shifted(H0, b[1], b[2])
    cs = corners_of(Hm)
    meta = {'corners': [[x / 720, y / 480] for x, y in cs], 'k': int(b[3]), 'fen': mv['start'],
            'expected': [m['san'] for m in mv['moves'] if m['san']], 'times': [m['t'] for m in mv['moves'] if m['san']],
            'startAt': max(0.5, gt[0]['t'])}
    json.dump(meta, open(O + 'i' + v[1:] + '.json', 'w'))
    print(v, 'fit', n, round(rms, 2), 'shift', b[1], b[2], 'k', b[3], 'plies', len(meta['expected']), 'missing', sum(1 for m in mv['moves'] if not m['san']))
