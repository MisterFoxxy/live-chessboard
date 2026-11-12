"""Точность 14-классной сети: python3 eval13.py model.pt имя1 имя2 ... (data13/имя.npz). Цвет, тип, путаница типов."""
import os, sys, numpy as np, torch, torch.nn.functional as F
os.environ['NCLS'] = '14'
from netdef import Net, normalize
torch.set_num_threads(4)
net = Net(); net.load_state_dict(torch.load(sys.argv[1], map_location='cpu')); net.eval()
names = '. P N B R Q K p n b r q k'.split()
Call = np.zeros((13, 13), int)
for n in sys.argv[2:]:
    d = np.load(f'data13/{n}.npz'); X, Y = d['X'], d['Y']; C = np.zeros((13, 13), int)
    with torch.no_grad():
        for i in range(0, len(X), 64):
            x = torch.from_numpy(X[i:i + 64]).permute(0, 3, 1, 2).float() / 255.
            x = F.interpolate(x, size=(160, 160), mode='bilinear', align_corners=False, antialias=True)
            o = net(normalize(x))[:, :13].argmax(1).numpy(); y = Y[i:i + 64]; m = y >= 0
            np.add.at(C, (y[m], o[m]), 1)
    col = lambda v: 0 if v == 0 else (1 if v <= 6 else 2)
    colok = sum(C[r, c] for r in range(13) for c in range(13) if col(r) == col(c)); occ = C[1:].sum()
    print(f'{n:10} boards {len(X):4d} colour {100 * colok / C.sum():6.2f}%  type {100 * np.trace(C[1:, 1:]) / occ:6.2f}%')
    Call += C
occ = Call[1:].sum()
print(f'ALL type {100 * np.trace(Call[1:, 1:]) / occ:.2f}%  by piece: ' + ' '.join(f'{names[r]}:{100 * Call[r, r] / max(1, Call[r].sum()):.0f}' for r in range(1, 13)))
if os.environ.get('CONF'):
    print('     ' + ' '.join(f'{n:>5}' for n in names))
    for r in range(13): print(f'{names[r]:>4} ' + ' '.join(f'{v:5d}' for v in Call[r]))
