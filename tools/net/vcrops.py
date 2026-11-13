"""Канонические снимки фигур из записей idChess: python3 vcrops.py v01 ... -> ccrops/vNN.npz.
Камера в записи неподвижна, поэтому её положение берём по грубым углам доски из rough.txt (точность ±1 клетка достаточна)."""
import sys, os, numpy as np, canon
from fitlib import order_quad
rough = {l.split()[0]: [tuple(map(float, p.split(','))) for p in l.split()[1:]] for l in open('rough.txt')}
rng = np.random.default_rng(2); os.makedirs('ccrops', exist_ok=True)
for v in sys.argv[1:]:
    a = np.load(f'data/{v}.npz'); b = np.load(f'data13/{v}.npz'); X, Y = a['X'], b['Y']
    nad = canon.camera(order_quad(rough[v]), 720, 480)
    out, yy, gg, cc = [], [], [], []; nads = []
    for i in range(len(X)):
        nads.append(nad)
        cells = []
        for r in range(8):
            for c in range(8):
                y = int(Y[i, r, c])
                if y < 0 or (y == 0 and rng.random() > 0.04) or (y in (1, 7) and rng.random() > 0.35): continue
                cells.append((r, c)); yy.append(y); gg.append(i); cc.append(r * 8 + c)
        if cells: out.append(canon.crops64(X[i], 20, cells, nad))
    np.savez_compressed(f'ccrops/{v}.npz', X=np.concatenate(out), Y=np.array(yy, np.int8), G=np.array(gg, np.int32), C=np.array(cc, np.int8), k=int(a['k']))
    n = np.array(nads); print(v, 'снимков', len(yy), 'надир ср. (%.1f, %.1f) высота %.1f' % tuple(n.mean(0)), flush=True)
