"""Устойчивость сети типов к свету: python3 lighttest.py model.pt [наборы…]  (настройки сети — из model.json)
Те же проверочные снимки при разном искусственном свете; печатает долю верно узнанных фигур (без пустых клеток)."""
import sys, os, json, numpy as np, torch
cfg = json.load(open(sys.argv[1][:-3] + '.json'))
os.environ['NORM'] = cfg['norm']; os.environ['BAND'] = cfg['band']
import cropnet
torch.set_num_threads(4)
net = cropnet.CropLite(tuple(cfg['ch'])); net.load_state_dict(torch.load(sys.argv[1], map_location='cpu')); net.eval()
names = sys.argv[2:] or ['u8', 'u10', 'u11']
X = np.concatenate([np.load(f"{cfg['crops']}/{n}.npz")['X'] for n in names]); Y = np.concatenate([np.load(f"{cfg['crops']}/{n}.npz")['Y'] for n in names]).astype(int)
yy, xx = torch.meshgrid(torch.linspace(-1, 1, 64), torch.linspace(-1, 1, 64), indexing='ij')
col = lambda r, g, b: torch.tensor([r, g, b]).view(1, 3, 1, 1)
CASES = [('как снято', lambda x: x),
         ('вдвое темнее', lambda x: x * 0.5),
         ('вчетверо темнее + шум', lambda x: (x * 0.25 + torch.randn_like(x) * 0.02).clamp(0, 1)),
         ('пересвет (ярче в 1,6 раза)', lambda x: (x * 1.6).clamp(0, 1)),
         ('жёлтые лампы', lambda x: (x * col(1.15, 1.0, 0.7)).clamp(0, 1)),
         ('холодный синий свет', lambda x: (x * col(0.8, 0.95, 1.15)).clamp(0, 1)),
         ('тень с одной стороны', lambda x: (x * (1 + 0.45 * xx)).clamp(0, 1)),
         ('тускло и контрастно (гамма 2)', lambda x: x.clamp(1e-4, 1) ** 2.0),
         ('блёкло (гамма 0,5)', lambda x: x.clamp(1e-4, 1) ** 0.5)]
occ = Y > 0; off = occ & (Y != 1) & (Y != 7)
torch.manual_seed(0)
for nm, f in CASES:
    o = []
    with torch.no_grad():
        for i in range(0, len(X), 512): o.append(net(cropnet.normalize(f(cropnet.to01(X[i:i + 512])))).argmax(1).numpy())
    o = np.concatenate(o)
    print(f'{nm:32} все фигуры {100 * (o[occ] == Y[occ]).mean():5.1f}%   без пешек {100 * (o[off] == Y[off]).mean():5.1f}%')
