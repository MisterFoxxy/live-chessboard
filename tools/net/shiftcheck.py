import sys, json, numpy as np
from PIL import Image
from fitlib import *
rough = {l.split()[0]: [tuple(map(float, p.split(','))) for p in l.split()[1:]] for l in open('rough.txt')}

def shifted(Hm, sx, sy):
    T = np.array([[1, 0, sx / 8], [0, 1, sy / 8], [0, 0, 1]])
    return Hm @ T

def best_shift(Hm, gray, placement):
    res = []
    for sx in (-1, 0, 1):
        for sy in (-1, 0, 1):
            Hs = shifted(Hm, sx, sy)
            o = orient(Hs, gray, placement)
            res.append((o[0], sx, sy, o[1]))
    res.sort(reverse=True)
    return res

if __name__ == '__main__':
    out = {}
    for v in sys.argv[1:]:
        gt = json.load(open(f'gt/{v}.json'))
        med = np.asarray(Image.open(f'med/{v}.png').convert('RGB')).astype(np.float32)
        gray = med.mean(2)
        pts = xcorners(gray)
        Hs, _ = search(quad_h(order_quad(rough[v])), pts)
        H0, n0, rms0 = icp(Hs, pts)
        pl0 = [g for g in gt if g['t'] <= 30]
        pl0 = pl0[-1]['placement'] if pl0 else gt[0]['placement']
        r = best_shift(H0, gray, pl0)
        flag = '' if (r[0][1], r[0][2]) == (0, 0) else '  <-- SHIFT'
        print(v, 'best', [round(r[0][0], 2), r[0][1], r[0][2], r[0][3]], 'zero', [round(x[0], 2) for x in r if x[1] == 0 and x[2] == 0][0], 'second', round(r[1][0], 2), flag, flush=True)
        out[v] = [r[0][1], r[0][2]]
    json.dump(out, open('shifts_' + sys.argv[1] + '.json', 'w'))
