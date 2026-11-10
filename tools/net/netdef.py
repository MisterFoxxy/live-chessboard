"""Board-state FCN definition shared by training and export."""
import os
import torch, torch.nn as nn
CH = [int(c) for c in os.environ.get('CH', '16,32,48,64').split(',')]
NCLS = int(os.environ.get('NCLS', 4))  # empty, white, black, hand

def block(i, o):
    return [nn.Conv2d(i, o, 3, padding=1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True)]

class Net(nn.Module):
    def __init__(s, c=CH):
        super().__init__()
        s.f = nn.Sequential(*block(3, c[0]), nn.MaxPool2d(2), *block(c[0], c[1]), nn.MaxPool2d(2),
                            *block(c[1], c[2]), *block(c[2], c[2]), nn.MaxPool2d(2),
                            *block(c[2], c[3]), nn.MaxPool2d(2), *block(c[3], c[3]), nn.Conv2d(c[3], NCLS, 1))
    def forward(s, x):
        return s.f(x)[:, :, 1:9, 1:9]

def normalize(x):
    r = x[:, :, 16:144, 16:144]
    m = r.mean((2, 3), keepdim=True); sd = r.std((2, 3), keepdim=True)
    return (x - m) / (sd + 0.02)

