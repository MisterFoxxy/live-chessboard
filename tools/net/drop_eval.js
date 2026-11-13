// Трекер на прочтениях приложения с выброшенной долей проверок (имитация медленного телефона)
const { Chess } = require('chess.js');
const GT = require(process.env.GTJS || '../../js/game-tracker.js');
const fs = require('fs');
const opts = JSON.parse(process.argv[2] || '{}'), drop = +(process.argv[3] || 0.2), seeds = +(process.argv[4] || 20);
const games = (process.env.GAMES || 'u10').split(' ');
const ref = g => JSON.parse(fs.readFileSync((process.env.TEST || 'test') + '/' + g + 's.json')).expected;
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
let tot = 0, perf = 0, runs = 0; const per = {};
for (const g of games) for (const ph of (process.env.PHASES || '_app0,_app83,_app167').split(',')) {
  const f = 'cache/' + g + ph + '.json'; if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f)), r = ref(g);
  for (let s = 1; s <= seeds; s++) {
    let seed = s * 7919; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const tr = new GT.Tracker(null, opts); tr.reset(d.fen || undefined);
    for (const x of d.reads) if (rnd() >= drop) tr.read(x.t, i => x.p[i], i => !!x.m[i]);
    const c = new Chess(d.fen || undefined), san = [];
    for (const m of tr.best().moves) { if (m.pass) { const f = c.fen().split(' '); f[1] = f[1] === 'w' ? 'b' : 'w'; f[3] = '-'; c.load(f.join(' ')); san.push('--'); continue; } const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' }); if (!mv) break; san.push(mv.san); }
    const e = lev(san.slice(0, r.length), r); tot += e; runs++; if (!e) perf++; per[g] = (per[g] || 0) + e;
  }
}
console.log(JSON.stringify(opts), 'drop', drop, 'edits', tot, 'perfect', perf + '/' + runs, JSON.stringify(per));
