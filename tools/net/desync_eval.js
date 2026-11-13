// Тревога «запись расходится с доской»: N клеток не сходятся на спокойной доске дольше HOLD с. node desync_eval.js N HOLD
const GT = require(process.env.GTJS || '../../js/game-tracker.js');
const fs = require('fs');
const N = +(process.argv[2] || 2), HOLD = +(process.argv[3] || 4);
for (const g of 'u1 u2 u4 u5 u6 u7 u8 u9 u10 u11 u12'.split(' ')) {
  const out = [];
  for (const ph of ['', '_p1', '_app0', '_app83']) {
    const f = 'cache/' + g + ph + '.json'; if (!fs.existsSync(f)) continue;
    const d = JSON.parse(fs.readFileSync(f));
    const tr = new GT.Tracker(null, {}); tr.reset();
    let since = null, alarms = [];
    for (const x of d.reads) {
      const b = tr.read(x.t, i => x.p[i], i => !!x.m[i]);
      const calm = x.m.every(v => !v) && x.p.every(p => p[3] < 0.5);
      if (!b || !calm) continue;
      const mm = tr.mismatch();
      if (mm.length >= N) { if (since == null) since = x.t; if (x.t - since >= HOLD && (!alarms.length || x.t - alarms[alarms.length - 1] > 10)) alarms.push(x.t); }
      else since = null;
    }
    out.push((ph.replace('_', '') || 'p0') + ': ' + (alarms.map(a => a.toFixed(0)).join(',') || '—'));
  }
  console.log(g.padEnd(4), out.join(' | '));
}
