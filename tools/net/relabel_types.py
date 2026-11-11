"""Add piece-type labels to data/vNN.npz from the digital board (gt/vNN.json) at each sample time.
Y13: -1 masked, 0 empty, 1..6 white P N B R Q K, 7..12 black p n b r q k. Saves data13/vNN.npz."""
import sys, os, json, glob, numpy as np, chess
from fitlib import cell_of
os.makedirs('data13', exist_ok=True)
CODE = {'P': 1, 'N': 2, 'B': 3, 'R': 4, 'Q': 5, 'K': 6, 'p': 7, 'n': 8, 'b': 9, 'r': 10, 'q': 11, 'k': 12}
bad_total = 0; n_total = 0
for path in sorted(glob.glob('data/v*.npz')):
    v = os.path.basename(path)[:-4]
    d = np.load(path); X, Y, T, K = d['X'], d['Y'], d['T'], int(d['k'])
    gt = json.load(open(f'gt/{v}.json'))
    starts = [g['t'] for g in gt]
    Y13 = np.full(Y.shape, -1, np.int8); bad = 0
    for i, t in enumerate(T):
        j = max(k for k in range(len(starts)) if starts[k] <= t + 1e-6)
        b = chess.Board(gt[j]['placement'] + ' w - - 0 1')
        lab = np.zeros((8, 8), np.int8)
        for sq, p in b.piece_map().items():
            r, c = cell_of(chess.square_name(sq), K); lab[r, c] = CODE[p.symbol()]
        col = np.where(lab == 0, 0, np.where(lab <= 6, 1, 2))
        m = Y >= 0
        bad += int(((col != Y[i]) & m[i]).sum())
        Y13[i] = np.where(m[i], lab, -1)
    bad_total += bad; n_total += int((Y >= 0).sum())
    np.savez_compressed(f'data13/{v}.npz', X=X, Y=Y13, T=T, k=K)
print('colour disagreements', bad_total, 'of', n_total, 'labelled squares')
