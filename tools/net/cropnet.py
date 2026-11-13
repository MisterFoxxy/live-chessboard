"""Сеть типов по крупным снимкам фигур. env: TRAIN="u1 u2 ...", TEST="u10 u11", OUT, EPOCHS, THREADS"""
import os, sys, time, numpy as np, torch, torch.nn as nn, torch.nn.functional as F
torch.set_num_threads(int(os.environ.get('THREADS', 4))); torch.manual_seed(5); np.random.seed(5)
def load(names):
    X, Y, G, C = [], [], [], []
    for gi, n in enumerate(names):
        d = np.load(f"{os.environ.get('CROPS', 'crops')}/{n}.npz"); X.append(d['X']); Y.append(d['Y']); G.append(d['G'].astype(np.int64) + gi * 100000); C.append(d['C'])
    return np.concatenate(X), np.concatenate(Y).astype(np.int64), np.concatenate(G), np.concatenate(C)
class CropNet(nn.Module):
    def __init__(s, ch=(24, 32, 48, 64, 96), ncls=13):
        super().__init__()
        L = []; cin = 3
        for i, c in enumerate(ch):
            L += [nn.Conv2d(cin, c, 3, stride=1 if i == 0 else 2, padding=1, bias=False), nn.BatchNorm2d(c), nn.ReLU(inplace=True)]; cin = c
        s.f = nn.Sequential(*L); s.fc = nn.Linear(cin, ncls)
    def forward(s, x): return s.fc(s.f(x).mean((2, 3)))
class CropLite(nn.Module):
    """Только слои, которые умеет js/board-net.js: свёртка 3×3 + BN + ReLU, MaxPool 2, в конце свёртка 1×1. Вход 64×64 → карта 1×1."""
    def __init__(s, ch=(12, 24, 40, 64, 96, 96), ncls=13):
        super().__init__()
        L = []; cin = 3
        for c in ch:
            L += [nn.Conv2d(cin, c, 3, padding=1, bias=False), nn.BatchNorm2d(c), nn.ReLU(inplace=True), nn.MaxPool2d(2)]; cin = c
        L.append(nn.Conv2d(cin, ncls, 1))
        s.f = nn.Sequential(*L)
    def forward(s, x): return s.f(x).flatten(1)
MASK = None
if os.environ.get('BAND'):
    x0, x1, y0, y1 = [int(v) for v in os.environ['BAND'].split(',')]
    MASK = torch.zeros(1, 1, 64, 64); MASK[:, :, y0:y1, x0:x1] = 1
NORM = os.environ.get('NORM', 'fixed')
def normalize(x):
    """x — снимки 0..1. NORM=crop: каждый снимок и каждый цветовой канал приводится к нулевому среднему и единичному
    разбросу (по полосе, где стоит фигура) — общий свет, его цвет и контраст перестают влиять на ответ."""
    if NORM == 'crop':
        m = MASK if MASK is not None else torch.ones(1, 1, 64, 64); cnt = m.sum()
        mu = (x * m).sum((2, 3), keepdim=True) / cnt
        sd = ((((x - mu) ** 2) * m).sum((2, 3), keepdim=True) / cnt).sqrt()
        x = (x - mu) / (sd + 0.02)
    else: x = (x - 0.5) / 0.25
    return x * MASK if MASK is not None else x
def to01(X): return torch.from_numpy(X).permute(0, 3, 1, 2).float() / 255.
def prep(X): return normalize(to01(X))
_yy, _xx = torch.meshgrid(torch.linspace(-1, 1, 64), torch.linspace(-1, 1, 64), indexing='ij')
def light(x, k=1.0):
    """Случайный свет: гамма (темно/контрастно), общая яркость, цвет ламп, тень с одной стороны, шум матрицы."""
    n = x.shape[0]; r = lambda *sh: (torch.rand(n, *sh) - 0.5) * 2
    x = x.clamp(1e-4, 1) ** torch.exp(r(1, 1, 1) * 0.7 * k)
    ang = torch.rand(n, 1, 1, 1) * 6.283; sh = torch.rand(n, 1, 1, 1) * 0.4 * k
    x = x * torch.exp(r(1, 1, 1) * 0.5 * k) * torch.exp(r(3, 1, 1) * 0.2 * k) * (1 + sh * (_xx * torch.cos(ang) + _yy * torch.sin(ang))) + r(1, 1, 1) * 0.05 * k
    x = x + torch.randn_like(x) * torch.rand(n, 1, 1, 1) * 0.03 * k
    return x.clamp(0, 1)
def augment(X):
    x = to01(X); n = x.shape[0]
    x = F.pad(x, (5, 5, 5, 5), mode='replicate')
    out = torch.empty(n, 3, 64, 64)
    for i in range(n):
        dx, dy = np.random.randint(0, 11, 2); out[i] = x[i, :, dy:dy + 64, dx:dx + 64]
    if os.environ.get('LIGHT'): out = light(out, float(os.environ['LIGHT']))
    else:
        a = 1 + (torch.rand(n, 1, 1, 1) - 0.5) * 0.5; b = (torch.rand(n, 1, 1, 1) - 0.5) * 0.15
        g = 1 + (torch.rand(n, 3, 1, 1) - 0.5) * 0.12
        out = ((out - 0.5) * a * g + 0.5 + b).clamp(0, 1)
    if os.environ.get('AUG'):
        # отражение, поворот и масштаб: наклон и размер фигуры перестают выдавать место на доске
        flip = torch.rand(n) < 0.5; out[flip] = out[flip].flip(3)
        ang = (torch.rand(n) - 0.5) * 2 * 0.26; sc = 1 + (torch.rand(n) - 0.5) * 0.3
        th = torch.zeros(n, 2, 3); th[:, 0, 0] = torch.cos(ang) / sc; th[:, 0, 1] = -torch.sin(ang) / sc; th[:, 1, 0] = torch.sin(ang) / sc; th[:, 1, 1] = torch.cos(ang) / sc
        out = F.grid_sample(out, F.affine_grid(th, out.shape, align_corners=False), padding_mode='border', align_corners=False)
    return normalize(out)
if __name__ == '__main__':
    tr = os.environ['TRAIN'].split(); te = os.environ.get('TEST', '').split()
    Xt, Yt, Gt, Ct = load(tr)
    SW = None
    if os.environ.get('BAL'):
        key = Yt * 64 + Ct.astype(np.int64); cnt2 = np.bincount(key, minlength=13 * 64).astype(np.float64)
        SW = 1.0 / (cnt2[key] if os.environ['BAL'] == '2' else np.sqrt(cnt2[key])); SW = SW / SW.mean()   # 2: все пары (фигура, клетка) поровну
        uw = float(os.environ.get('USERW', 1))   # свои партии и клипы (тот же комплект фигур) весят больше чужих записей
        if uw != 1: SW = SW * np.where(np.array([not n.startswith('v') for n in tr])[Gt // 100000], uw, 1.0); SW = SW / SW.mean()
    if te: Xv, Yv, Gv, Cv = load(te)
    CHS = tuple(int(c) for c in os.environ['CH'].split(',')) if os.environ.get('CH') else (12, 24, 40, 64, 96, 96)
    net = CropLite(CHS) if os.environ.get('ARCH') == 'lite' else CropNet()
    if os.environ.get('INIT'): net.load_state_dict(torch.load(os.environ['INIT'], map_location='cpu'))
    import json as _json
    _json.dump({'arch': os.environ.get('ARCH', 'crop'), 'ch': CHS, 'norm': NORM, 'band': os.environ.get('BAND', ''), 'crops': os.environ.get('CROPS', 'crops'), 'train': tr}, open(os.environ['OUT'][:-3] + '.json', 'w'))
    EP = int(os.environ.get('EPOCHS', 12)); BS = 128
    opt = torch.optim.AdamW(net.parameters(), 2e-3, weight_decay=5e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 4e-3, total_steps=EP * (len(Xt) // BS), pct_start=0.15)
    cnt = np.bincount(Yt, minlength=13).astype(np.float32); cw = torch.tensor((cnt.sum() / 13 / np.maximum(cnt, 1)) ** 0.5)
    print('train', len(Xt), 'test', len(Xv) if te else 0, flush=True)
    def evaluate():
        net.eval(); P = []
        with torch.no_grad():
            for i in range(0, len(Xv), 512): P.append(F.softmax(net(prep(Xv[i:i + 512])), 1).numpy())
        net.train(); return np.concatenate(P)
    t0 = time.time()
    for ep in range(EP):
        perm = np.random.choice(len(Xt), len(Xt), p=SW / SW.sum()) if SW is not None else np.random.permutation(len(Xt))
        for i in range(0, len(perm) - BS + 1, BS):
            idx = np.sort(perm[i:i + BS])
            loss = F.cross_entropy(net(augment(Xt[idx])), torch.from_numpy(Yt[idx]), weight=cw, label_smoothing=0.05)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        if te:
            P = evaluate(); o = P.argmax(1); occ = Yv > 0
            print(f'ep {ep} all {100 * (o == Yv).mean():.2f} pieces {100 * (o[occ] == Yv[occ]).mean():.2f} {time.time() - t0:.0f}s', flush=True)
        torch.save(net.state_dict(), os.environ['OUT'])
    if te:
        names = '. P N B R Q K p n b r q k'.split(); C = np.zeros((13, 13), int); np.add.at(C, (Yv, o), 1)
        print('by piece: ' + ' '.join(f'{names[r]}:{100 * C[r, r] / max(1, C[r].sum()):.1f}' for r in range(13)))
        print('     ' + ' '.join(f'{n:>5}' for n in names))
        for r in range(13): print(f'{names[r]:>4} ' + ' '.join(f'{v:5d}' for v in C[r]))
        np.savez(os.environ['OUT'][:-3] + '_eval.npz', P=P, Y=Yv, G=Gv, C=Cv)
