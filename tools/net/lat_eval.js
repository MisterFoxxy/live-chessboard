const { Chess } = require('chess.js');
const GT = require(process.env.GTJS || '../../js/game-tracker.js');
const fs = require('fs');
const TEST = (process.env.TEST || 'test') + '/';
const opts = JSON.parse(process.argv[2] || '{}');
let all = [];
for (const g of ['u1', 'u2', 'u4', 'u5']) for (const ph of ['', '_p1', '_p2', '_p3']) {
  const meta = JSON.parse(fs.readFileSync(TEST + g + 's.json')), d = JSON.parse(fs.readFileSync('cache/' + g + ph + '.json'));
  const tr = new GT.Tracker(null, opts); tr.reset(d.fen || undefined);
  // когда ход k впервые появился в записи и больше не исчезал
  const firstSeen = [];
  for (const r of d.reads) {
    const b = tr.read(r.t, i => r.p[i], i => !!r.m[i]);
    if (!b) continue;
    const c = new Chess(), san = b.moves.map(m => c.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' })).map(x => x && x.san);
    for (let k = 0; k < meta.expected.length; k++) {
      const ok = san.slice(0, k + 1).join(' ') === meta.expected.slice(0, k + 1).join(' ');
      if (ok && firstSeen[k] == null) firstSeen[k] = r.t;
      if (!ok) firstSeen[k] = null;
    }
  }
  meta.times.forEach((tm, k) => { if (firstSeen[k] != null) all.push(firstSeen[k] - tm); });
}
all.sort((a, b) => a - b);
const q = f => all[Math.floor(all.length * f)].toFixed(2);
console.log(JSON.stringify(opts), 'n', all.length, 'median', q(0.5), 'p90', q(0.9), 'max', all[all.length - 1].toFixed(2));
