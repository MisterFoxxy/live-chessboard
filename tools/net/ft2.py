"""Fine-tune on idChess + user auto-labelled games. env: BASE, OUT, HOLD (user game), EPOCHS, REP, THREADS, CH"""
import os, glob, time, numpy as np, torch, torch.nn.functional as F
from netdef import Net, normalize, NCLS
from train import load, augment, evaluate
torch.set_num_threads(int(os.environ.get('THREADS', 2)))
torch.manual_seed(2); np.random.seed(2)
USERS = ['u1', 'u2', 'u4', 'u5', 'u6', 'u7']
hold = os.environ.get('HOLD', '')
VAL = 'v40,v41,v42,v43,v44'.split(',')
allv = sorted(os.path.basename(p)[:-4] for p in glob.glob('data/v*.npz'))
Xi, Yi = load([v for v in allv if v not in VAL])
Xu, Yu = load([u + '_auto' for u in USERS if u != hold])
rep = int(os.environ.get('REP', 6))
Xt = np.concatenate([Xi] + [Xu] * rep); Yt = np.concatenate([Yi] + [Yu] * rep)
net = Net(); net.load_state_dict(torch.load(os.environ['BASE'], map_location='cpu'))
CW = torch.tensor([1, 1, 1, 0.5][:NCLS])
EP = int(os.environ.get('EPOCHS', 3)); BS = 48
opt = torch.optim.AdamW(net.parameters(), 5e-4, weight_decay=1e-4)
sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EP * (len(Xt) // BS))
Xh, Yh = load([hold + '_auto']) if hold else (None, None)
if hold: print('held-out', hold, 'before', round(evaluate(net, Xh, Yh)[0] * 100, 2), flush=True)
t0 = time.time()
for ep in range(EP):
    perm = np.random.permutation(len(Xt))
    for i in range(0, len(perm) - BS + 1, BS):
        idx = np.sort(perm[i:i + BS]); x, y = augment(Xt[idx], Yt[idx])
        loss = F.cross_entropy(net(normalize(x)), y, ignore_index=-1, weight=CW)
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    msg = f'ep {ep} {time.time() - t0:.0f}s'
    if hold: msg += f' held-out {hold} {evaluate(net, Xh, Yh)[0] * 100:.2f}'
    print(msg, flush=True)
torch.save(net.state_dict(), os.environ['OUT'])
