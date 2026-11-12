"""Точность сети типов в зависимости от того, видела ли она этот тип на этой клетке: python3 covtest.py eval.npz "обуч. наборы" [папка снимков]"""
import sys, numpy as np
e = np.load(sys.argv[1]); tr = sys.argv[2].split(); D = sys.argv[3] if len(sys.argv) > 3 else 'crops'
Yt = np.concatenate([np.load(f'{D}/{n}.npz')['Y'] for n in tr]).astype(int); Ct = np.concatenate([np.load(f'{D}/{n}.npz')['C'] for n in tr]).astype(int)
P, Y, C = e['P'], e['Y'].astype(int), e['C'].astype(int); o = P.argmax(1)
seen = {y: set(Ct[Yt == y]) for y in range(1, 13)}
dist = lambda y, c: min(max(abs(c // 8 - s // 8), abs(c % 8 - s % 8)) for s in seen[y]) if seen[y] else 9
Dm = np.array([dist(y, c) if y > 0 else -1 for y, c in zip(Y, C)])
off = (Y > 0) & (Y != 1) & (Y != 7); pw = (Y == 1) | (Y == 7)
names = '. P N B R Q K p n b r q k'.split()
print(f'все фигуры {100 * (o[Y > 0] == Y[Y > 0]).mean():.1f}% | пешки {100 * (o[pw] == Y[pw]).mean():.1f}% | фигуры без пешек {100 * (o[off] == Y[off]).mean():.1f}% | пусто {100 * (o[Y == 0] == 0).mean():.1f}%')
print('  без пешек: ' + ' ; '.join(f'{nm}: {100 * (o[m] == Y[m]).mean():.1f}% из {int(m.sum())}' for nm, m in (('тип уже видели на этой клетке', off & (Dm == 0)), ('на соседней', off & (Dm == 1)), ('дальше', off & (Dm >= 2))) if m.sum()))
print('  по типам: ' + ' '.join(f'{names[r]}:{100 * (o[Y == r] == r).mean():.0f}' for r in range(1, 13)))
