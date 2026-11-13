"""Сеть типов (cropnet.CropLite) → файл для js/piece-net.js: python3 export_crop.py model.pt out.bnet  (настройки — из model.json)"""
import json, struct, sys, os, numpy as np, torch, torch.nn as nn
cfg = json.load(open(sys.argv[1][:-3] + '.json'))
os.environ['NORM'] = cfg['norm']; os.environ['BAND'] = cfg['band']
import cropnet
assert cfg['norm'] == 'crop', 'приложение умеет только выравнивание света по снимку (NORM=crop)'
net = cropnet.CropLite(tuple(cfg['ch'])); net.load_state_dict(torch.load(sys.argv[1], map_location='cpu')); net.eval()
mods = list(net.f); layers, blobs, off = [], [], 0; i = 0
while i < len(mods):
    m = mods[i]
    if isinstance(m, nn.Conv2d):
        w = m.weight.detach().numpy().astype(np.float64); b = m.bias.detach().numpy().astype(np.float64) if m.bias is not None else np.zeros(w.shape[0])
        relu = False
        if i + 1 < len(mods) and isinstance(mods[i + 1], nn.BatchNorm2d):
            bn = mods[i + 1]; g = bn.weight.detach().numpy() / np.sqrt(bn.running_var.numpy() + bn.eps)
            w = w * g[:, None, None, None]; b = (b - bn.running_mean.numpy()) * g + bn.bias.detach().numpy(); i += 1
        if i + 1 < len(mods) and isinstance(mods[i + 1], nn.ReLU): relu = True; i += 1
        layers.append({'type': 'conv', 'in': w.shape[1], 'out': w.shape[0], 'k': w.shape[2], 'relu': relu, 'w': off, 'b': off + w.size})
        blobs += [w.astype(np.float32).ravel(), b.astype(np.float32).ravel()]; off += w.size + b.size
    elif isinstance(m, nn.MaxPool2d): layers.append({'type': 'pool'})
    i += 1
band = [int(v) for v in cfg['band'].split(',')]
meta = json.dumps({'kind': 'piece', 'input': 64, 'square': 0, 'margin': 0, 'band': band, 'classes': ['empty', 'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'], 'layers': layers}).encode()
data = np.concatenate(blobs).astype('<f4').tobytes()
with open(sys.argv[2], 'wb') as f:
    f.write(b'BNET'); f.write(struct.pack('<I', len(meta))); f.write(meta); f.write(b'\0' * ((-(8 + len(meta))) % 4)); f.write(data)
print('layers', len(layers), 'params', off, 'bytes', 8 + len(meta) + len(data))
