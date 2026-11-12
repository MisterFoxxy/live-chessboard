"""Разметка «свободного» видео для обучения сети типов: фигуры переставляют по одной на любые клетки (правила не важны,
взятия можно). Кто где стоит, отслеживаем по занятости клеток: одна клетка освободилась, другая занялась — фигура переехала.
python3 freemove.py NAME [FEN] -> data13/NAME_auto.npz (Y: 8×8 в координатах кадра, -1 — не знаем), печатает число перестановок.
Нужен cache/NAME.npz (ответы сети «цвет» 4 раза в секунду: cache_net.py)."""
import sys, numpy as np, chess
from fitlib import cell_of
name = sys.argv[1]
d = np.load(f'cache/{name}.npz'); T, PR, MV, K = d['t'], d['pr'].astype(np.float32), d['mov'].astype(np.float32), int(d['k'])
board = chess.Board(sys.argv[2]) if len(sys.argv) > 2 else chess.Board()
CODE = {'P': 1, 'N': 2, 'B': 3, 'R': 4, 'Q': 5, 'K': 6, 'p': 7, 'n': 8, 'b': 9, 'r': 10, 'q': 11, 'k': 12}
RC = [cell_of(chess.square_name(sq), K) for sq in chess.SQUARES]
rr = np.array([r for r, c in RC]); cc = np.array([c for r, c in RC])
state = np.zeros(64, np.int8)            # тип фигуры на клетке (0 пусто, -1 неизвестная фигура), цвет отдельно
colour = np.zeros(64, np.int8)
for sq, p in board.piece_map().items(): state[sq] = CODE[p.symbol()]; colour[sq] = 1 if p.color else 2
import os
NEED = int(os.environ.get('NEED', 2))       # столько проверок подряд картина должна быть одной и той же (0,5 с)
MINVIS = int(os.environ.get('MINVIS', 58))  # столько клеток должно быть видно
prev = None; run = 0; moves = 0; unknown = 0; Ts, Ys = [], []
for i in range(len(T)):
    pr = PR[i]; q = pr[:3][:, rr, cc].T; s = q.sum(1, keepdims=True); q = q / np.maximum(s, 1e-6)
    vis = (pr[3][rr, cc] < 0.5) & (MV[i][rr, cc] <= 6)
    obs = np.where(q.max(1) >= 0.7, q.argmax(1), -1)
    if vis.sum() < MINVIS: prev = None; run = 0; continue
    obs = np.where(vis & (obs >= 0), obs, colour)      # закрытые клетки считаем неизменившимися
    if prev is not None and (obs == prev).all(): run += 1
    else: prev = obs; run = 1
    if run < NEED: continue
    if not (obs == colour).all():
        V = [x for x in range(64) if colour[x] and obs[x] == 0]                      # освободились
        A = [x for x in range(64) if not colour[x] and obs[x]]                       # заняты заново
        R = [x for x in range(64) if colour[x] and obs[x] and obs[x] != colour[x]]   # сменили цвет (взятие)
        dst = A + R
        new_state, new_col = state.copy(), colour.copy()
        for x in V: new_state[x] = 0; new_col[x] = 0
        used = set()
        for y in dst:
            cand = [x for x in V if colour[x] == obs[y] and x not in used]
            same = [x for x in V if colour[x] == obs[y]]
            if len(same) == 1 and len([z for z in dst if obs[z] == obs[y]]) == 1:
                new_state[y] = state[same[0]]; used.add(same[0]); moves += 1
            else:
                new_state[y] = -1; unknown += 1    # две фигуры одного цвета сразу или фигура «из ниоткуда» — тип неизвестен
            new_col[y] = obs[y]
        state, colour = new_state, new_col
    y8 = np.full((8, 8), -1, np.int8)
    for sq in range(64): y8[RC[sq]] = state[sq]
    Ts.append(float(T[i])); Ys.append(y8)
keep = list(range(0, len(Ts), 2))
np.savez_compressed(f'data13/{name}_auto.npz', Y=np.array(Ys, np.int8)[keep], T=np.array(Ts)[keep], k=K, X=np.zeros((0, 200, 200, 3), np.uint8))
print(name, 'перестановок', moves, 'неизвестных', unknown, 'снимков', len(keep))
if __name__ == '__main__' and len(sys.argv) > 3:   # проверка: сравнить с разметкой по правилам (data13/<argv[3]>.npz)
    ref = np.load(f'data13/{sys.argv[3]}.npz'); rt = {round(float(t), 3): y for t, y in zip(ref['T'], ref['Y'])}
    ok = bad = 0
    for t, y in zip(np.array(Ts)[keep], np.array(Ys)[keep]):
        r = rt.get(round(float(t), 3))
        if r is None: continue
        m = (r >= 0) & (y >= 0); ok += int((r[m] == y[m]).sum()); bad += int((r[m] != y[m]).sum())
    print('  совпадение с разметкой по правилам:', ok, 'клеток, расхождений', bad)
