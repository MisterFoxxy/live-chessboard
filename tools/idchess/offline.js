// Offline analysis: run BoardVision on decoded frames of a real clip.
// usage: node offline.js rN [t0] [t1] [squares...]
// Prints per-frame change (vs reference at t0) and stillness for given squares.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const BV = require(path.join(__dirname, '../../js/board-vision.js'));
const S = process.env.DATA || path.resolve(__dirname, 'data');
const [v, t0s, t1s, ...sqs] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(S, 'site/test', v + '.json'), 'utf8'));
const W = 640, H = 427, FPS = 30;
const t0 = +t0s || 0, t1 = +t1s || 5;
const q = BV.orderQuad(meta.corners).map(p => [p[0] * W, p[1] * H]);
const Hm = BV.computeHomography(BV.UNIT, q);
const cam = BV.cameraFromH(Hm, W, H);
const plan = BV.samplePlan(Hm, { samples: 8, margin: 0.12, dropNear: 0.3, camera: cam });
const tracker = new BV.MotionTracker({ settleMs: 600 });
const ff = spawn('ffmpeg', ['-v', 'error', '-ss', String(t0), '-t', String(t1 - t0), '-i', path.join(S, 'site/test', v + '.webm'),
  '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
let buf = Buffer.alloc(0), n = 0, ref = null;
const frameSize = W * H * 4;
ff.stdout.on('data', d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= frameSize) {
    const fr = buf.subarray(0, frameSize);
    buf = buf.subarray(frameSize);
    const feat = BV.sampleWithPlan({ data: fr, width: W, height: H }, plan);
    const t = t0 + n / FPS;
    tracker.push(feat, t * 1000);
    if (!ref) ref = feat;
    if (n % 3 === 0) {
      const ch = BV.squareChanges(ref, feat, meta.k).bySquare;
      const top = Object.entries(ch).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, x]) => s + ':' + Math.round(x)).join(' ');
      const sel = sqs.map(s => { const c = BV.squareToCell(s, meta.k); return `${s}=${Math.round(ch[s])}/${Math.round(t * 1000 - tracker.since[c])}`; }).join(' ');
      console.log(t.toFixed(2), tracker.moving ? 'M' : '-', sel, '| top', top);
    }
    n++;
  }
});
