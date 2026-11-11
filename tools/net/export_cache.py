import sys, json, numpy as np, chess
from fitlib import cell_of
name = sys.argv[1]; MOV = float(sys.argv[2]) if len(sys.argv) > 2 else 6
d = np.load(f'cache/{name}.npz'); K = int(d['k'])
RC = [cell_of(chess.square_name(sq), K) for sq in chess.SQUARES]
rr = np.array([RC[s][0] for s in range(64)]); cc = np.array([RC[s][1] for s in range(64)])
reads = []
for t, pr, mv in zip(d['t'], d['pr'].astype(np.float32), d['mov'].astype(np.float32)):
    reads.append({'t': round(float(t), 3), 'p': np.round(pr[:, rr, cc].T, 4).tolist(), 'm': (mv[rr, cc] > MOV).astype(int).tolist()})
json.dump({'fen': str(d['fen']), 'reads': reads}, open(f'cache/{name}.json', 'w'))
