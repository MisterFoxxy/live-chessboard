"""Beam decoder on cached network reads. decode(name, **params) -> list of (t, san)."""
import os, sys, json, math, numpy as np, chess
from fitlib import cell_of
DEF = dict(CAP=3.0, PEN=2.0, BEAM=24, MOV=6.0, HAND=0.5, NSTABLE=1, RECENT=4.0, AGE_FULL=2.0, AGE_DECAY=4.0, W_MIN=0.25,
           VAC=1, STEP=1, CONF=0.6, DIV=0, D3=0, MU=0.5, TCAP=2.0)

CODE = {'P': 1, 'N': 2, 'B': 3, 'R': 4, 'Q': 5, 'K': 6, 'p': 7, 'n': 8, 'b': 9, 'r': 10, 'q': 11, 'k': 12}
def classes(b):
    a = np.zeros(64, np.int8)
    for sq, p in b.piece_map().items(): a[sq] = CODE[p.symbol()]
    return a
def colour(a): return np.where(a == 0, 0, np.where(a <= 6, 1, 2)).astype(np.int8)

class Hyp:
    __slots__ = ('board', 'moves', 'acc', 'cls')
    def __init__(s, board, moves, acc, cls=None):
        s.board = board; s.moves = moves; s.acc = acc; s.cls = classes(board) if cls is None else cls

def decode(name, **kw):
    P_ = dict(DEF); P_.update(kw)
    d = np.load(f'cache/{name}.npz')
    T, PR, MV, K = d['t'], d['pr'].astype(np.float32), d['mv'] if 'mv' in d else d['mov'].astype(np.float32), int(d['k'])
    fen = str(d['fen'])
    START = chess.Board(fen) if fen else chess.Board()
    RC = [cell_of(chess.square_name(sq), K) for sq in chess.SQUARES]
    rr = np.array([RC[s][0] for s in range(64)]); cc = np.array([RC[s][1] for s in range(64)])
    legal_cache = {}
    def legal(b):
        k = b.fen()
        if k not in legal_cache: legal_cache[k] = list(b.legal_moves)
        return legal_cache[k]
    beam = [Hyp(START.copy(), [], 0.0)]
    started = False
    obs_cls = np.full(64, -1, np.int8); obs_since = np.zeros(64, np.float32); hist = []
    for idx in range(0, len(T), P_['STEP']):
        t = float(T[idx]); pr = PR[idx]; mv = MV[idx].astype(np.float32)
        T13 = pr.shape[0] == 14
        hand = pr[13 if T13 else 3][rr, cc] >= P_['HAND']; mov = mv[rr, cc] > P_['MOV']
        if T13:
            p13 = pr[:13][:, rr, cc].T; p13 = p13 / p13.sum(1, keepdims=True)
            q = np.stack([p13[:, 0], p13[:, 1:7].sum(1), p13[:, 7:13].sum(1)], 1)
        else:
            q = pr[:3][:, rr, cc].T; q = q / q.sum(1, keepdims=True)
        vis = ~hand & ~mov
        cost = np.where(vis[:, None], np.minimum(P_['CAP'], -np.log(np.maximum(q, 1e-9))), 0).astype(np.float32)
        # стоимость по 13 классам: цвет + mu * (−ln P(тип | цвет)), не больше TCAP
        col_of = np.array([0] + [1] * 6 + [2] * 6)
        if T13:
            pt = p13 / np.maximum(q[:, col_of], 1e-9)
            cost13 = cost[:, col_of] + P_['MU'] * np.minimum(P_['TCAP'], -np.log(np.maximum(pt, 1e-9))) * vis[:, None]
            cost13[:, 0] = cost[:, 0]
        else:
            cost13 = cost[:, col_of]
        conf = np.where(vis & (q.max(1) >= P_['CONF']), q.argmax(1), -1).astype(np.int8)
        prob = q
        if P_['NSTABLE'] > 1:
            cur = np.where(vis, np.where(conf >= 0, conf, -2), -1).astype(np.int8)
            hist.append(cur); hist[:] = hist[-P_['NSTABLE']:]
            if len(hist) == P_['NSTABLE']:
                stable = np.all([h == cur for h in hist], axis=0) & (cur != -1)
                cost[vis & ~stable] = 0; vis = vis & stable; conf = np.where(stable, conf, -1).astype(np.int8)
        if vis.sum() < 24: continue
        ch_ = (conf >= 0) & (conf != obs_cls)
        obs_cls[ch_] = conf[ch_]; obs_since[ch_] = t
        weight = np.clip(1 - (t - obs_since - P_['AGE_FULL']) / P_['AGE_DECAY'], P_['W_MIN'], 1).astype(np.float32)
        if not started:
            sc = colour(classes(START))
            if vis.sum() >= 50 and int(((conf >= 0) & (conf != sc)).sum()) <= 2:
                started = True; obs_since[:] = t
            continue
        wc = cost13 * weight[:, None]
        ar = np.arange(64)
        def obs(cls): return float(wc[ar, cls].sum())
        def changed(cls): return set(np.nonzero((conf >= 0) & (conf != colour(cls)))[0].tolist())
        def ok(m, b):
            if not P_['VAC']: return True
            if not vis[m.from_square]: return False
            col = 1 if b.turn == chess.WHITE else 2
            if prob[m.from_square][col] >= 0.5: return False
            return t - obs_since[m.from_square] <= P_['RECENT'] or (t - obs_since[m.to_square] <= P_['RECENT'] and obs_cls[m.to_square] == col)
        cand = {}
        def add(h, board, newm):
            key = board.fen().rsplit(' ', 2)[0]
            cls = classes(board)
            acc = h.acc + obs(cls) + P_['PEN'] * len(newm)
            if key not in cand or cand[key].acc > acc: cand[key] = Hyp(board, h.moves + newm, acc, cls)
        for hi, h in enumerate(beam):
            add(h, h.board, [])
            ch = changed(h.cls)
            if not ch: continue
            for m in legal(h.board):
                if m.from_square not in ch and m.to_square not in ch: continue
                if not ok(m, h.board): continue
                b1 = h.board.copy(stack=False); s1 = b1.san(m); b1.push(m)
                add(h, b1, [(round(t, 2), s1)])
                ch2 = changed(classes(b1))
                if not ch2: continue
                for m2 in legal(b1):
                    if m2.from_square not in ch2 and m2.to_square not in ch2: continue
                    if not ok(m2, b1): continue
                    b2 = b1.copy(stack=False); s2 = b2.san(m2); b2.push(m2)
                    add(h, b2, [(round(t, 2), s1), (round(t, 2), s2)])
                    if hi < P_['D3']:
                        # три хода за одно движение руки (Qg3+ Kf1 Qf2#) — только для лучших гипотез
                        ch3 = changed(classes(b2))
                        if not ch3: continue
                        for m3 in legal(b2):
                            if m3.from_square not in ch3 and m3.to_square not in ch3: continue
                            if not ok(m3, b2): continue
                            b3 = b2.copy(stack=False); s3 = b3.san(m3); b3.push(m3)
                            add(h, b3, [(round(t, 2), s1), (round(t, 2), s2), (round(t, 2), s3)])
        allc = sorted(cand.values(), key=lambda h: h.acc)
        if P_['DIV']:
            # keep a few hypotheses per number of moves so a "slower" line is not pruned too early
            by = {}; keep = []
            for h in allc:
                n = len(h.moves)
                if by.get(n, 0) < P_['DIV']: by[n] = by.get(n, 0) + 1; keep.append(h)
            rest = [h for h in allc if h not in keep]
            beam = (keep + rest)[:P_['BEAM']]; beam.sort(key=lambda h: h.acc)
        else:
            beam = allc[:P_['BEAM']]
        base = beam[0].acc
        for h in beam: h.acc -= base
    return beam[0].moves

def ed(a, b):
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        p, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] != b[j - 1]))
    return d[len(b)]

T_ = '/tmp/claude-0/-home-user-live-chessboard/8c1593a9-9b2c-56b1-bd63-831f68b04c26/scratchpad/site/test/'
EXP = {g: json.load(open(T_ + g + '.json'))['expected'] for g in ['u1', 'u2', 'u4', 'u5']}
EXP['u6'] = 'e4 c5 Nf3 Nc6 h4 h6 g4 g5 hxg5 hxg5 Rxh8 Bg7 Rxg8+ Bf8'.split()
EXP['u7'] = open('g7_decoded.txt').read().split()
def evaluate(games=('u1', 'u2', 'u4', 'u5', 'u6', 'u7'), verbose=False, **kw):
    tot = 0; ok = 0; out = {}
    for g in games:
        got = [s for _, s in decode(g, **kw)]
        e = EXP[g]; err = ed(got[:len(e)], e)
        pre = 0
        while pre < min(len(got), len(e)) and got[pre] == e[pre]: pre += 1
        tot += err; ok += int(err == 0 and len(got) >= len(e)); out[g] = (pre, len(e), err)
        if verbose: print(f'  {g} prefix {pre}/{len(e)} err {err} | {" ".join(got)[:140]}')
    return tot, ok, out

if __name__ == '__main__':
    kw = {k: type(DEF[k])(v) for k, v in (a.split('=') for a in sys.argv[1:])}
    tot, ok, out = evaluate(verbose=True, **kw)
    print('TOTAL errors', tot, 'perfect', ok, '/6')
