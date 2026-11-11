// Подбор настроек трекера по всем партиям и сдвигам: node grid_eval.js part nparts
const { Chess } = require('chess.js');
const GT = require(process.env.GTJS || '../../js/game-tracker.js');
const fs = require('fs'), path = require('path');
const TEST = process.env.TEST || 'test';
const ref = g => { const f = path.join(TEST, g + 's.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)).expected : fs.readFileSync('g9_beam.txt').toString().trim().split(/\s+/); };
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const games = (process.env.GAMES || 'u1 u2 u4 u5 u6 u7 u8 u9').split(' '), phases = (process.env.PHASES || ',_p1,_p2,_p3').split(',');
const data = [];
for (const g of games) for (const ph of phases) data.push({ g, ph, r: ref(g), d: JSON.parse(fs.readFileSync('cache/' + g + ph + '.json')) });
const grid = [];
const G = JSON.parse(process.env.GRID);
const keys = Object.keys(G);
(function rec(i, cur) { if (i === keys.length) { grid.push(Object.assign({}, cur)); return; } for (const v of G[keys[i]]) { cur[keys[i]] = v; rec(i + 1, cur); } })(0, {});
const part = +process.argv[2] || 0, np = +process.argv[3] || 1;
for (let gi = part; gi < grid.length; gi += np) {
  const o = grid[gi]; let tot = 0, perf = 0; const per = {};
  for (const x of data) {
    const tr = new GT.Tracker(null, o); tr.reset(x.d.fen || undefined);
    for (const rd of x.d.reads) tr.read(rd.t, i => rd.p[i], i => !!rd.m[i]);
    const c = new Chess(x.d.fen || undefined), san = [];
    for (const m of tr.best().moves) { const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' }); if (!mv) break; san.push(mv.san); }
    const e = lev(san.slice(0, x.r.length), x.r); tot += e; if (!e) perf++; per[x.g] = (per[x.g] || 0) + e;
  }
  console.log(JSON.stringify({ o, tot, perf, per }));
}
