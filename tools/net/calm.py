"""First moment when the board region is truly still for >= 1.5 s, inside a stable digital-board segment."""
import os
import json, sys, subprocess, numpy as np, cv2, chess
O = os.environ.get('TEST_DIR', 'test/')
for v in sys.argv[1:]:
    meta = json.load(open(O + 'i' + v[1:] + '.json')); gt = json.load(open(f'gt/{v}.json')); mv = json.load(open(f'gt/{v}_moves.json'))
    q = np.array([[x * 720, y * 480] for x, y in meta['corners']], np.int32)
    mask = np.zeros((480, 720), np.uint8); cv2.fillConvexPoly(mask, q, 1)
    mask = cv2.dilate(mask, np.ones((25, 25), np.uint8)).astype(bool)
    FPS = 10
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', f'{v}.mp4', '-t', '240', '-vf', f'fps={FPS},crop=720:480:0:0,format=gray', '-f', 'rawvideo', '-'], stdout=subprocess.PIPE)
    prev, still, i, found = None, 0, 0, None
    while True:
        b = p.stdout.read(720 * 480)
        if len(b) < 720 * 480: break
        f = np.frombuffer(b, np.uint8).reshape(480, 720).astype(np.int16); t = i / FPS; i += 1
        if prev is not None:
            d = np.abs(f - prev)[mask]
            moving = (d > 25).mean() > 0.002
            still = 0 if moving else still + 1
            if still >= 15 and t > 2:
                ts = t - 1.5
                seg = max(j for j in range(len(gt)) if gt[j]['t'] <= ts)
                nxt = gt[seg + 1]['t'] if seg + 1 < len(gt) else 1e9
                if ts >= gt[seg]['t'] + 0.5 and nxt - t >= 1.0:
                    found = round(ts + 0.2, 2); break
        prev = f
    p.kill()
    if found is None: print(v, 'no calm moment'); continue
    b = chess.Board(mv['start'])
    done = [m for m in mv['moves'] if m['san'] and m['t'] <= found]
    for m in done: b.push_san(m['san'])
    rest = [m for m in mv['moves'] if m['san'] and m['t'] > found]
    meta.update({'fen': b.fen(), 'expected': [m['san'] for m in rest], 'times': [m['t'] for m in rest], 'startAt': found, 'skipped': len(done)})
    json.dump(meta, open(O + 'i' + v[1:] + '.json', 'w'))
    print(v, 'calm at', found, 's after', len(done), 'plies; to recognise', len(rest))
