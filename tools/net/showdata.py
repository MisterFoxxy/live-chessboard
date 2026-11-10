import sys, numpy as np
from PIL import Image, ImageDraw
d = np.load(f'data/{sys.argv[1]}.npz')
X, Y = d['X'], d['Y']
idx = [int(i) for i in sys.argv[3:]] if len(sys.argv) > 3 else list(np.linspace(0, len(X) - 1, 6).astype(int))
S, MG = 20, 1
tiles = []
for i in idx:
    im = Image.fromarray(X[i]).resize((400, 400), Image.NEAREST); d2 = ImageDraw.Draw(im)
    for r in range(8):
        for c in range(8):
            l = Y[i, r, c]
            x, y = (MG + c) * S * 2 + 14, (MG + r) * S * 2 + 12
            if l == 1: d2.ellipse([x, y, x + 12, y + 12], fill=(255, 255, 255), outline=(255, 0, 0))
            elif l == 2: d2.ellipse([x, y, x + 12, y + 12], fill=(0, 0, 0), outline=(255, 0, 0))
            elif l == -1: d2.line([x, y, x + 12, y + 12], fill=(255, 0, 255), width=3)
    tiles.append(im)
sheet = Image.new('RGB', (400 * 3, 400 * ((len(tiles) + 2) // 3)))
for k, t in enumerate(tiles): sheet.paste(t, ((k % 3) * 400, (k // 3) * 400))
sheet.save(sys.argv[2])
