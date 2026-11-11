"""14-class board net: 0 empty, 1-6 white PNBRQK, 7-12 black pnbrqk, 13 hand. env: BASE (4-class), OUT, EPOCHS, THREADS, CH"""
import os, glob, time, numpy as np, torch, torch.nn.functional as F
os.environ['NCLS'] = '14'
from netdef import Net, normalize
from train import augment
torch.set_num_threads(int(os.environ.get('THREADS', 4)))
torch.manual_seed(3); np.random.seed(3)
def load(names):
    X, Y = [], []
    for n in names:
        d = np.load(f'data13/{n}.npz'); X.append(d['X']); Y.append(d['Y'])
    return np.concatenate(X), np.concatenate(Y)
VAL = ['v40', 'v41', 'v42', 'v43', 'v44']
allv = sorted(os.path.basename(p)[:-4] for p in glob.glob('data13/v*.npz'))
Xi, Yi = load([v for v in allv if v not in VAL]); Xv, Yv = load(VAL)
users = ['u1', 'u2', 'u4', 'u5', 'u6', 'u7']
Xu, Yu = load([u + '_auto' for u in users])
rep = int(os.environ.get('REP', 6))
Xt = np.concatenate([Xi] + [Xu] * rep); Yt = np.concatenate([Yi] + [Yu] * rep)
print('train', len(Xt), 'val', len(Xv), flush=True)
net = Net()
base = torch.load(os.environ['BASE'], map_location='cpu')
sd = net.state_dict()
for k, v in base.items():
    if k in sd and sd[k].shape == v.shape: sd[k] = v
# last conv: copy colour logits into every type of that colour
last = [k for k in sd if k.endswith('.weight') and sd[k].dim() == 4][-1]; lb = last.replace('weight', 'bias')
W4, B4 = base[last], base[lb]                      # (4, C, 1, 1)
src = [0] + [1] * 6 + [2] * 6 + [3]
sd[last] = W4[src].clone(); sd[lb] = B4[src].clone()
net.load_state_dict(sd)
CW = torch.ones(14); CW[13] = 0.5
EP = int(os.environ.get('EPOCHS', 8)); BS = 48
opt = torch.optim.AdamW(net.parameters(), 1e-3, weight_decay=1e-4)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, 1.5e-3, total_steps=EP * (len(Xt) // BS), pct_start=0.15)
def evaluate(X, Y):
    net.eval(); col_ok = col_n = typ_ok = typ_n = 0; C = np.zeros((13, 13), int)
    with torch.no_grad():
        for i in range(0, len(X), 64):
            x = torch.from_numpy(X[i:i + 64]).permute(0, 3, 1, 2).float() / 255.
            x = F.interpolate(x, size=(160, 160), mode='bilinear', align_corners=False, antialias=True)
            o = net(normalize(x))[:, :13].argmax(1).numpy(); y = Y[i:i + 64]
            m = y >= 0
            colp = np.where(o == 0, 0, np.where(o <= 6, 1, 2)); coly = np.where(y == 0, 0, np.where(y <= 6, 1, 2))
            col_ok += int(((colp == coly) & m).sum()); col_n += int(m.sum())
            occ = m & (y > 0); typ_ok += int(((o == y) & occ).sum()); typ_n += int(occ.sum())
            np.add.at(C, (y[m], o[m]), 1)
    net.train()
    return col_ok / max(1, col_n), typ_ok / max(1, typ_n), C
t0 = time.time()
for ep in range(EP):
    perm = np.random.permutation(len(Xt))
    for i in range(0, len(perm) - BS + 1, BS):
        idx = np.sort(perm[i:i + BS]); x, y = augment(Xt[idx], Yt[idx]); y[y < 0] = 13
        loss = F.cross_entropy(net(normalize(x)), y, weight=CW)
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    ca, ta, C = evaluate(Xv, Yv)
    print(f'ep {ep} val colour {ca * 100:.2f} type {ta * 100:.2f} {time.time() - t0:.0f}s', flush=True)
    torch.save(net.state_dict(), os.environ['OUT'])
names = '. P N B R Q K p n b r q k'.split()
print('val type confusion (rows true):'); print('     ' + ' '.join(f'{n:>5}' for n in names))
for r in range(13): print(f'{names[r]:>4} ' + ' '.join(f'{v:5d}' for v in C[r]))
