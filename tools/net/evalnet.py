"""Evaluate a trained net: python3 evalnet.py model.pt name1 name2 ... [--img prefix]
Per-square accuracy on E/W/B squares, whole-board accuracy, hand detection, error gallery."""
import sys, os, numpy as np, torch
from PIL import Image, ImageDraw
from netdef import Net, normalize, NCLS
import torch.nn.functional as F
args = [a for a in sys.argv[1:] if not a.startswith('--')]
img = next((a.split('=')[1] for a in sys.argv if a.startswith('--img=')), None)
net = Net(); net.load_state_dict(torch.load(args[0], map_location='cpu')); net.eval()
tot = {'sq': 0, 'ok': 0, 'boards': 0, 'boards_ok': 0, 'boards_ok_strict': 0, 'hand': 0, 'hand_hit': 0, 'fa': 0}
C = np.zeros((3, 4), int)
gallery = []
for name in args[1:]:
    d = np.load(f'data/{name}.npz'); X, Y = d['X'], d['Y']
    st = {'sq': 0, 'ok': 0, 'b': 0, 'bok': 0}
    for i in range(0, len(X), 64):
        x = torch.from_numpy(X[i:i + 64]).permute(0, 3, 1, 2).float() / 255.
        x = F.interpolate(x, size=(160, 160), mode='bilinear', align_corners=False, antialias=True)
        with torch.no_grad():
            o = torch.softmax(net(normalize(x)), 1).numpy()
        y = Y[i:i + 64]
        for b in range(len(y)):
            p = o[b]; yy = y[b]
            arg4 = p.argmax(0); arg3 = p[:3].argmax(0)
            lab = (yy >= 0)
            # a square counts as correct if the net names the right class among E/W/B and does not call it 'hand'
            corr = (arg3 == yy) & (arg4 != 3) & lab
            np.add.at(C, (yy[lab], arg4[lab]), 1)
            n = int(lab.sum()); k = int(corr.sum())
            st['sq'] += n; st['ok'] += k; st['b'] += 1; st['bok'] += int(n == k)
            tot['boards_ok_strict'] += int(n == k and n == 64)
            h = yy < 0
            tot['hand'] += int(h.sum()); tot['hand_hit'] += int((h & (arg4 == 3)).sum())
            tot['fa'] += int((lab & (arg4 == 3)).sum())
            if n != k and img and len(gallery) < 12:
                gallery.append((X[i + b], yy, arg4, name, i + b))
    tot['sq'] += st['sq']; tot['ok'] += st['ok']; tot['boards'] += st['b']; tot['boards_ok'] += st['bok']
    print(f"{name}: squares {st['ok']}/{st['sq']} = {100 * st['ok'] / max(1, st['sq']):.2f}%  boards all-correct {st['bok']}/{st['b']} = {100 * st['bok'] / max(1, st['b']):.1f}%")
print(f"TOTAL squares {100 * tot['ok'] / max(1, tot['sq']):.2f}%  boards all-correct {100 * tot['boards_ok'] / max(1, tot['boards']):.1f}% ({tot['boards_ok']}/{tot['boards']}), strict 64/64 visible {tot['boards_ok_strict']}")
print(f"hand squares: {tot['hand']}, called hand {100 * tot['hand_hit'] / max(1, tot['hand']):.0f}%; piece/empty squares wrongly called hand: {100 * tot['fa'] / max(1, tot['sq']):.2f}%")
print('confusion rows true E/W/B, cols pred E/W/B/hand:\n', C)
if img and gallery:
    tiles = []
    for X0, yy, a4, name, idx in gallery:
        im = Image.fromarray(X0).resize((400, 400), Image.BILINEAR); dr = ImageDraw.Draw(im)
        for r in range(8):
            for c in range(8):
                if yy[r, c] >= 0 and a4[r, c] != yy[r, c]:
                    x0, y0 = (1 + c) * 40, (1 + r) * 40
                    dr.rectangle([x0, y0, x0 + 40, y0 + 40], outline=(255, 0, 0), width=3)
                    dr.text((x0 + 3, y0 + 3), 'EWBH'[yy[r, c]] + '>' + 'EWBH'[a4[r, c]], fill=(255, 0, 0))
        dr.text((5, 5), f'{name}#{idx}', fill=(255, 255, 0))
        tiles.append(im)
    sh = Image.new('RGB', (1200, 400 * ((len(tiles) + 2) // 3)))
    for k, t in enumerate(tiles): sh.paste(t, ((k % 3) * 400, (k // 3) * 400))
    sh.save(img)
