"""Train the board-state FCN. Input: rectified board 160x160 (16 px/square, 1-square margin).
Output: 8x8 x 3 classes (empty / white / black)."""
import glob, math, os, sys, time, json
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F
from netdef import Net, normalize, NCLS
torch.set_num_threads(int(os.environ.get('THREADS', 4)))
torch.manual_seed(0); np.random.seed(0)
VAL = set(os.environ.get('VAL', 'v40,v41,v42,v43,v44').split(','))
USER = ['u1', 'u2', 'u4', 'u5']
EPOCHS = int(os.environ.get('EPOCHS', 12)); BS = 48
OUT = os.environ.get('OUT', 'model.pt')

def load(names):
    X, Y = [], []
    for n in names:
        if not os.path.exists(f'data/{n}.npz'): continue
        d = np.load(f'data/{n}.npz'); X.append(d['X']); Y.append(d['Y'])
    return (np.concatenate(X), np.concatenate(Y)) if X else (np.zeros((0, 200, 200, 3), np.uint8), np.zeros((0, 8, 8), np.int8))


_YS, _XS = torch.meshgrid(torch.linspace(-1 + 1 / 160, 1 - 1 / 160, 160), torch.linspace(-1 + 1 / 160, 1 - 1 / 160, 160), indexing='ij')
_P = torch.stack([_XS.flatten(), _YS.flatten(), torch.ones(160 * 160)], 0)

def homog_grid(B, jitter):
    """Random perspective near identity (batched): output [-1,1]^2 -> input normalized coords."""
    src = torch.tensor([[-1., -1.], [1., -1.], [1., 1.], [-1., 1.]])
    ang = torch.empty(B, 1).uniform_(-3, 3) * math.pi / 180; sc = torch.exp(torch.empty(B, 1).uniform_(-0.07, 0.07))
    t = torch.empty(B, 1, 2).uniform_(-0.03, 0.03)
    x, y = src[:, 0][None], src[:, 1][None]
    X = sc * (torch.cos(ang) * x - torch.sin(ang) * y) + t[..., 0] + torch.empty(B, 4).uniform_(-jitter, jitter)
    Y = sc * (torch.sin(ang) * x + torch.cos(ang) * y) + t[..., 1] + torch.empty(B, 4).uniform_(-jitter, jitter)
    A = torch.zeros(B, 8, 8); bvec = torch.zeros(B, 8)
    for i in range(4):
        xi, yi = float(src[i, 0]), float(src[i, 1])
        A[:, 2 * i, 0], A[:, 2 * i, 1], A[:, 2 * i, 2] = xi, yi, 1
        A[:, 2 * i, 6], A[:, 2 * i, 7] = -xi * X[:, i], -yi * X[:, i]
        A[:, 2 * i + 1, 3], A[:, 2 * i + 1, 4], A[:, 2 * i + 1, 5] = xi, yi, 1
        A[:, 2 * i + 1, 6], A[:, 2 * i + 1, 7] = -xi * Y[:, i], -yi * Y[:, i]
        bvec[:, 2 * i], bvec[:, 2 * i + 1] = X[:, i], Y[:, i]
    h = torch.linalg.solve(A, bvec)
    Hm = torch.cat([h, torch.ones(B, 1)], 1).view(B, 3, 3)
    q = Hm @ _P
    return (q[:, :2] / q[:, 2:]).transpose(1, 2).reshape(B, 160, 160, 2)

def augment(xb, yb, strong=True):
    x = torch.from_numpy(xb).permute(0, 3, 1, 2).float() / 255.
    y = torch.from_numpy(yb).long()
    if NCLS == 4: y[y < 0] = 3
    B = x.shape[0]
    # dihedral (per sample)
    for b in range(B):
        k = np.random.randint(4)
        x[b] = torch.rot90(x[b], k, (1, 2)); y[b] = torch.rot90(y[b], k, (0, 1))
        if np.random.rand() < 0.5:
            x[b] = torch.flip(x[b], (2,)); y[b] = torch.flip(y[b], (1,))
    if not strong:
        return F.interpolate(x, size=(160, 160), mode='bilinear', align_corners=False, antialias=True), y
    x = F.grid_sample(x, homog_grid(B, 0.012), mode='bilinear', padding_mode='border', align_corners=False)
    # photometric
    g = torch.exp(torch.empty(B, 1, 1, 1).uniform_(math.log(0.45), math.log(1.8)))
    cg = torch.exp(torch.empty(B, 3, 1, 1).uniform_(-0.2, 0.2))
    gam = torch.exp(torch.empty(B, 1, 1, 1).uniform_(-0.45, 0.45))
    sat = torch.empty(B, 1, 1, 1).uniform_(0.3, 1.5)
    gx = torch.empty(B, 1, 1, 1).uniform_(-0.35, 0.35); gy = torch.empty(B, 1, 1, 1).uniform_(-0.35, 0.35)
    lin = torch.linspace(-1, 1, 160)
    grad = 1 + gx * lin.view(1, 1, 1, -1) + gy * lin.view(1, 1, -1, 1)
    x = x.clamp(1e-4, 1) ** gam
    m = x.mean(1, keepdim=True); x = m + (x - m) * sat
    x = (x * g * cg * grad.clamp(0.3, 2)).clamp(0, 1)
    # blur
    sig = np.random.choice([0, 0, 0.6, 1.0])
    if sig > 0:
        k = torch.exp(-torch.arange(-2, 3).float() ** 2 / (2 * sig * sig)); k = k / k.sum()
        x = F.conv2d(x, k.view(1, 1, 1, 5).repeat(3, 1, 1, 1), padding=(0, 2), groups=3)
        x = F.conv2d(x, k.view(1, 1, 5, 1).repeat(3, 1, 1, 1), padding=(2, 0), groups=3)
    x = x + torch.randn_like(x) * torch.empty(B, 1, 1, 1).uniform_(0, 0.03)
    x = (x * 255).round().clamp(0, 255) / 255  # quantise like 8-bit video
    return x, y

def evaluate(net, X, Y):
    """Accuracy over squares with a piece label (E/W/B), argmax over E/W/B; plus how often such
    squares are called 'hand' (false alarms) and hand recall."""
    net.eval(); C = np.zeros((3, 3), int); fa = 0; hr = [0, 0]
    with torch.no_grad():
        for i in range(0, len(X), 64):
            x, y = augment(X[i:i + 64], Y[i:i + 64], strong=False)
            o = net(normalize(x))
            p = o[:, :3].argmax(1)
            m = (y >= 0) & (y < 3)
            np.add.at(C, (y[m].numpy(), p[m].numpy()), 1)
            if NCLS == 4:
                h = o.argmax(1) == 3
                fa += int((h & m).sum()); hr[0] += int((h & (y == 3)).sum()); hr[1] += int((y == 3).sum())
    net.train()
    acc = np.trace(C) / max(1, C.sum())
    evaluate.extra = (fa / max(1, C.sum()), hr[0] / max(1, hr[1]))
    return acc, C

if __name__ == '__main__':
    allv = sorted(os.path.basename(p)[:-4] for p in glob.glob('data/v*.npz'))
    trn = [v for v in allv if v not in VAL]; val = [v for v in allv if v in VAL]
    Xt, Yt = load(trn); Xv, Yv = load(val)
    EXTRA = [e for e in os.environ.get('EXTRA', '').split(',') if e]
    if EXTRA:
        Xe, Ye = load(EXTRA); rep = int(os.environ.get('EXTRA_REP', 20))
        Xt = np.concatenate([Xt] + [Xe] * rep); Yt = np.concatenate([Yt] + [Ye] * rep)
    print('train', len(Xt), 'val', len(Xv), 'videos', len(trn), len(val), flush=True)
    net = Net()
    CW = torch.tensor([1, 1, 1, 0.5][:NCLS])
    print('params', sum(p.numel() for p in net.parameters()), flush=True)
    opt = torch.optim.AdamW(net.parameters(), 2e-3, weight_decay=1e-4)
    steps = EPOCHS * (len(Xt) // BS)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 3e-3, total_steps=steps, pct_start=0.15)
    users = {u: load([u]) for u in USER}
    step = 0; t0 = time.time()
    for ep in range(EPOCHS):
        perm = np.random.permutation(len(Xt)); tl = 0; tn = 0
        for i in range(0, len(perm) - BS + 1, BS):
            idx = np.sort(perm[i:i + BS])
            x, y = augment(Xt[idx], Yt[idx])
            out = net(normalize(x))
            loss = F.cross_entropy(out, y, ignore_index=-1, weight=CW)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step(); step += 1
            tl += loss.item(); tn += 1
        va, C = evaluate(net, Xv, Yv); fa, hrec = evaluate.extra
        us = {}
        for u in USER:
            if len(users[u][0]):
                a, _ = evaluate(net, *users[u]); us[u] = f'{a * 100:.2f}/fa{evaluate.extra[0] * 100:.1f}'
        print(f'ep {ep} loss {tl / tn:.4f} val {va * 100:.2f} (hand: false {fa * 100:.2f}% recall {hrec * 100:.0f}%) user {us} {time.time() - t0:.0f}s', flush=True)
        torch.save(net.state_dict(), OUT)
    print('val confusion (rows true E/W/B):\n', C)
    for u in USER:
        if len(users[u][0]):
            a, Cu = evaluate(net, *users[u]); print(u, round(a * 100, 2), Cu.tolist())
