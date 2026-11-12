"""Разметка «свободного» видео для обучения сети типов: фигуры переставляют по одной на любые клетки (правила не важны).
Кто где стоит, отслеживаем по занятости клеток (сеть «цвет»): клетка освободилась, другая занялась тем же цветом — фигура переехала.
Сеть «цвет» в необычных позициях иногда теряет фигуру (её заслонила соседняя, сменилась яркость), поэтому пропавшая фигура
не забывается, а становится «призраком»: вернулась на той же клетке — та же фигура; появилась того же цвета в другом месте
сразу или в течение WIN секунд — переехала. Всё сомнительное получает метку -1 (не учим на этом).
python3 freemove.py NAME [FEN] [REF] -> data13/NAME_auto.npz (Y: 8×8 в координатах кадра; -1 — не знаем или клетка закрыта).
Нужен cache/NAME.npz (ответы сети «цвет» 4 раза в секунду: cache_net.py). REF — разметка по правилам для сверки."""
import sys, os, numpy as np, chess
from fitlib import cell_of
name = sys.argv[1]
d = np.load(f'cache/{name}.npz'); T, PR, MV, K = d['t'], d['pr'].astype(np.float32), d['mov'].astype(np.float32), int(d['k'])
board = chess.Board(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else chess.Board()
CODE = {'P': 1, 'N': 2, 'B': 3, 'R': 4, 'Q': 5, 'K': 6, 'p': 7, 'n': 8, 'b': 9, 'r': 10, 'q': 11, 'k': 12}
RC = [cell_of(chess.square_name(sq), K) for sq in chess.SQUARES]
rr = np.array([r for r, c in RC]); cc = np.array([c for r, c in RC])
NEED = int(os.environ.get('NEED', 2))       # столько проверок подряд картина должна быть одной и той же (0,5 с)
MINVIS = int(os.environ.get('MINVIS', 58))  # столько клеток должно быть видно
WIN = float(os.environ.get('WIN', 6))       # фигура в руке: столько секунд ждём, где она появится
ident = np.zeros(64, np.int8)               # тип фигуры на клетке: 0 пусто, 1..12, -1 фигура неизвестного типа
seen = np.zeros(64, np.int8)                # что сеть видела в прошлый спокойный момент: 0 пусто, 1 белая, 2 чёрная
for sq, p in board.piece_map().items(): ident[sq] = CODE[p.symbol()]; seen[sq] = 1 if p.color else 2
ghost = {}                                  # клетка → (тип, цвет, когда пропала)
# ответы сети «крупный план» в спокойные моменты (calmcrops.py): точнее видит, занята ли клетка, и отличает пешку от фигуры
CP = {}
if os.path.exists(f'cache/{name}_cp.npz') and os.environ.get('CP', '1') != '0':
    z = np.load(f'cache/{name}_cp.npz'); CP = {int(i): p.astype(np.float32) for i, p in zip(z['I'], z['P'])}
PAWN = {1, 7}
def pick(cp, y, types):
    """Тип появившейся фигуры среди возможных types по сети «крупный план»; None — не уверена."""
    types = sorted(types)
    if len(types) == 1: return types[0]
    if cp is None: return None
    p = cp[y][types]; p = p / max(float(p.sum()), 1e-6)
    return types[int(p.argmax())] if p.max() >= 0.9 else None
prev = None; run = 0; Ts, Ys = [], []
st = dict(moves=0, later=0, restored=0, unknown=0, vanished=0)
for i in range(len(T)):
    pr = PR[i]; q = pr[:3][:, rr, cc].T; q = q / np.maximum(q.sum(1, keepdims=True), 1e-6)
    vis = (pr[3][rr, cc] < 0.5) & (MV[i][rr, cc] <= 6)
    obs = np.where(q.max(1) >= 0.7, q.argmax(1), -1)
    if vis.sum() < MINVIS: prev = None; run = 0; continue
    ok = vis & (obs >= 0)
    obs = np.where(ok, obs, seen)             # закрытые клетки считаем неизменившимися
    cp = CP.get(i)
    if cp is not None:                        # где «крупный план» уверен — верим ему
        c3 = np.stack([cp[:, 0], cp[:, 1:7].sum(1), cp[:, 7:13].sum(1)], 1)
        sure = vis & (c3.max(1) >= 0.9)
        obs = np.where(sure, c3.argmax(1), obs); ok = ok | sure
    if prev is not None and (obs == prev).all(): run += 1
    else: prev = obs; run = 1
    if run < NEED: continue
    t = float(T[i])
    if not (obs == seen).all():
        gone = [x for x in range(64) if seen[x] and obs[x] != seen[x]]            # пропали (или сменили цвет)
        came = [x for x in range(64) if obs[x] and obs[x] != seen[x]]             # появились
        now_gone = set()
        for x in gone:
            if ident[x] != 0: ghost[x] = (int(ident[x]), int(seen[x]), t); now_gone.add(x); st['vanished'] += 1
            ident[x] = 0
        left = []
        for y in came:                                                             # вернулась на своё место
            g = ghost.get(y)
            if g and g[1] == obs[y] and y not in now_gone: ident[y] = g[0]; del ghost[y]; st['restored'] += 1
            else: left.append(y)
        for c in (1, 2):
            ys = [y for y in left if obs[y] == c]
            if not ys: continue
            same = [x for x in now_gone if x in ghost and ghost[x][1] == c]                         # пропали в этот же момент
            late = [x for x, g in ghost.items() if g[1] == c and x not in now_gone and t - g[2] <= WIN]  # подняты чуть раньше
            def veto(y, typ):                 # пешку с фигурой «крупный план» не путает: явное несогласие — не верим слежению
                if cp is None or typ <= 0: return False
                pp = float(cp[y][1] + cp[y][7]) / max(float(cp[y][1:].sum()), 1e-6)
                return pp < 0.02 if typ in PAWN else pp > 0.98
            if len(ys) == 1 and len(same) == 1 and not veto(ys[0], ghost[same[0]][0]): ident[ys[0]] = ghost.pop(same[0])[0]; st['moves'] += 1
            elif len(ys) == 1 and not same and len(late) == 1 and not veto(ys[0], ghost[late[0]][0]): ident[ys[0]] = ghost.pop(late[0])[0]; st['later'] += 1
            elif CP:
                # несколько возможных фигур: выбираем по типу (если все возможные одного типа — тип известен и так)
                for y in ys:
                    cands = [x for x, g in ghost.items() if g[1] == c]
                    typ = None
                    if cands and all(ghost[x][0] > 0 for x in cands): typ = pick(cp, y, {ghost[x][0] for x in cands})
                    if typ is None or veto(y, typ):
                        if os.environ.get('DBG'): print(f"  ? {t:6.1f} цвет {c} {chess.square_name(y)}: возможные {[(chess.square_name(x), ghost[x][0]) for x in cands]}")
                        ident[y] = -1; st['unknown'] += 1; continue
                    best = sorted([x for x in cands if ghost[x][0] == typ], key=lambda x: (x not in same, -ghost[x][2]))[0]
                    ident[y] = typ; del ghost[best]; st['bytype'] = st.get('bytype', 0) + 1
                for x in same: ghost.pop(x, None) if False else None
            else:
                if os.environ.get('DBG'): print(f"  ? {t:6.1f} цвет {c} появились {[chess.square_name(y) for y in ys]} пропали сейчас {[chess.square_name(x) for x in same]} недавно {[(chess.square_name(x), round(t - ghost[x][2], 1)) for x in late]} все призраки этого цвета {[(chess.square_name(x), round(t - g[2])) for x, g in ghost.items() if g[1] == c]}")
                for y in ys: ident[y] = -1; st['unknown'] += 1
                for x in same: ghost.pop(x, None)                                  # кто из них куда ушёл — неизвестно
        seen = obs.astype(np.int8).copy()
    y8 = np.full((8, 8), -1, np.int8)
    for sq in range(64):
        if not ok[sq] or (ident[sq] == 0 and sq in ghost): continue               # закрыта рукой / фигура, возможно, стоит, но не видна
        y8[RC[sq]] = ident[sq]
    Ts.append(t); Ys.append(y8)
keep = list(range(0, len(Ts), 2))
Ya = np.array(Ys, np.int8)[keep]; Ta = np.array(Ts)[keep]
np.savez_compressed(f'data13/{name}_auto.npz', Y=Ya, T=Ta, k=K, X=np.zeros((0, 200, 200, 3), np.uint8))
known = int((Ya > 0).sum()); unk = int(((Ya == -1)).sum())
print(name, f"по типу {st.get('bytype', 0)};", f"перестановок {st['moves']} + {st['later']} (подняли, потом поставили), вернулись на место {st['restored']}, пропаж {st['vanished']}, неизвестных {st['unknown']}; снимков {len(keep)}, фигур с известным типом {known}")
last = Ya[-1]; print('  в конце известны типы у', int((last > 0).sum()), 'фигур; по типам за весь клип:', {n: int((Ya == c).sum()) for n, c in CODE.items()})
if len(sys.argv) > 3:   # проверка: сравнить с разметкой по правилам (data13/<argv[3]>.npz)
    ref = np.load(f'data13/{sys.argv[3]}.npz'); rt = {round(float(tt), 3): y for tt, y in zip(ref['T'], ref['Y'])}
    okc = bad = 0
    for tt, y in zip(Ta, Ya):
        r = rt.get(round(float(tt), 3))
        if r is None: continue
        m = (r > 0) & (y > 0); okc += int((r[m] == y[m]).sum()); bad += int((r[m] != y[m]).sum())
    print('  совпадение с разметкой по правилам:', okc, 'фигур, расхождений', bad)
