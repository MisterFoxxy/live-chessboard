"""Fine-tune a trained net with the user's own games mixed into the idChess data.
env: BASE=m1.pt OUT=... HOLD=u5 (user game held out) EPOCHS=4 REP=15"""
import os, time, numpy as np, torch, torch.nn.functional as F
from netdef import Net, normalize, NCLS
from train import load, augment, evaluate
import glob
torch.set_num_threads(int(os.environ.get('THREADS', 4)))
torch.manual_seed(1); np.random.seed(1)
USER = ['u1', 'u2', 'u4', 'u5']
hold = [h for h in os.environ.get('HOLD', '').split(',') if h]
VAL = os.environ.get('VAL', 'v40,v41,v42,v43,v44').split(',')
allv = sorted(os.path.basename(p)[:-4] for p in glob.glob('data/v*.npz'))
Xi, Yi = load([v for v in allv if v not in VAL])
Xu, Yu = load([u for u in USER if u not in hold])
rep = int(os.environ.get('REP', 15))
Xt = np.concatenate([Xi] + [Xu] * rep); Yt = np.concatenate([Yi] + [Yu] * rep)
print('idchess', len(Xi), 'user', len(Xu), 'x', rep, 'hold', hold, flush=True)
net = Net(); net.load_state_dict(torch.load(os.environ.get('BASE', 'm1.pt'), map_location='cpu'))
CW = torch.tensor([1, 1, 1, 0.5][:NCLS])
EP = int(os.environ.get('EPOCHS', 4)); BS = 48
opt = torch.optim.AdamW(net.parameters(), 5e-4, weight_decay=1e-4)
steps = EP * (len(Xt) // BS)
sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, steps)
Xv, Yv = load(VAL)
t0 = time.time()
for ep in range(EP):
    perm = np.random.permutation(len(Xt))
    for i in range(0, len(perm) - BS + 1, BS):
        idx = np.sort(perm[i:i + BS])
        x, y = augment(Xt[idx], Yt[idx])
        loss = F.cross_entropy(net(normalize(x)), y, ignore_index=-1, weight=CW)
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    res = {u: round(evaluate(net, *load([u]))[0] * 100, 2) for u in USER}
    print(f'ep {ep} val {evaluate(net, Xv, Yv)[0] * 100:.2f} user {res} {time.time() - t0:.0f}s', flush=True)
torch.save(net.state_dict(), os.environ.get('OUT', 'ft.pt'))
