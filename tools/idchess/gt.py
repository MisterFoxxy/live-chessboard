"""Read the idChess digital board (bottom 720x720 of a 720x1200 video) frame by frame.

Usage: python3 gt.py TEMPLATE_FRAME.png VIDEO.mp4 OUT.json [fps]
TEMPLATE_FRAME must show the initial position (used to cut piece templates).
Writes [{t, placement}] — one entry per change of the digital position.
"""
import json
import subprocess
import sys

import numpy as np
from PIL import Image

SQ = 90
TOP = 480
INNER = 8  # skip borders (coordinate labels)


def squares(img):
    """img: HxWx3 array of the bottom board (720x720). Yields (file, rank, crop)."""
    for r in range(8):          # r=0 -> rank 8 (top)
        for f in range(8):
            yield f, 8 - r, img[r * SQ + INNER:(r + 1) * SQ - INNER, f * SQ + INNER:(f + 1) * SQ - INNER].astype(np.float32)


def bg_color(crop):
    # background = median of the crop's outer ring
    ring = np.concatenate([crop[:4].reshape(-1, 3), crop[-4:].reshape(-1, 3), crop[:, :4].reshape(-1, 3), crop[:, -4:].reshape(-1, 3)])
    return np.median(ring, axis=0)


def make_templates(frame):
    start = {'a1': 'wR', 'b1': 'wN', 'c1': 'wB', 'd1': 'wQ', 'e1': 'wK', 'a2': 'wP',
             'a8': 'bR', 'b8': 'bN', 'c8': 'bB', 'd8': 'bQ', 'e8': 'bK', 'a7': 'bP'}
    tpl = {}
    for f, r, crop in squares(frame):
        sq = 'abcdefgh'[f] + str(r)
        if sq in start:
            bg = bg_color(crop)
            diff = np.abs(crop - bg).sum(axis=2)
            mask = (diff > 40).astype(np.float32)
            tpl[start[sq]] = (crop, mask)
    return tpl


def classify(crop, tpl):
    bg = bg_color(crop)
    flat = np.abs(crop - bg).sum(axis=2)
    if (flat > 40).mean() < 0.03:
        return None
    best, best_err = None, 1e18
    for code, (pix, mask) in tpl.items():
        comp = pix * mask[..., None] + bg * (1 - mask[..., None])
        err = np.abs(comp - crop).mean()
        if err < best_err:
            best, best_err = code, err
    return best


def placement(frame, tpl):
    rows = []
    for r in range(8):
        row, empty = '', 0
        for f in range(8):
            crop = frame[r * SQ + INNER:(r + 1) * SQ - INNER, f * SQ + INNER:(f + 1) * SQ - INNER].astype(np.float32)
            code = classify(crop, tpl)
            if code is None:
                empty += 1
                continue
            if empty:
                row += str(empty)
                empty = 0
            ch = code[1]
            row += ch.upper() if code[0] == 'w' else ch.lower()
        if empty:
            row += str(empty)
        rows.append(row)
    return '/'.join(rows)


def main():
    tframe = np.asarray(Image.open(sys.argv[1]).convert('RGB'))[TOP:TOP + 720]
    tpl = make_templates(tframe)
    video, out = sys.argv[2], sys.argv[3]
    fps = float(sys.argv[4]) if len(sys.argv) > 4 else 10
    cmd = ['ffmpeg', '-v', 'error', '-i', video, '-vf', f'fps={fps},crop=720:720:0:{TOP}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n, res, last, cand, cand_n = 0, [], None, None, 0
    while True:
        buf = proc.stdout.read(720 * 720 * 3)
        if len(buf) < 720 * 720 * 3:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(720, 720, 3)
        p = placement(frame, tpl)
        t = n / fps
        n += 1
        # require 2 identical frames in a row (skip transition/animation frames)
        if p == cand:
            cand_n += 1
        else:
            cand, cand_n = p, 1
        if cand_n == 2 and p != last:
            res.append({'t': round(t - 1 / fps, 2), 'placement': p})
            last = p
    json.dump(res, open(out, 'w'), indent=0)
    print(video, 'frames', n, 'positions', len(res))


main()
