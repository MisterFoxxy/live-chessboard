// Сколько пропусков хода ставит трекер (верных — по эталону) и как меняются ошибки: node pass_eval.js '{опции}'
const { Chess } = require('chess.js');
const GT = require(process.env.GTJS || '../../js/game-tracker.js');
const fs = require('fs'), path = require('path');
const TEST = process.env.TEST, opts = JSON.parse(process.argv[2] || '{}');
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const ref = g => { const f = path.join(TEST, g + 's.json'); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f)).expected; return fs.readFileSync('g' + g.slice(1) + '_beam.txt').toString().trim().split(/\s+/); };
let tot = 0, passes = 0, good = 0, ms = 0, n = 0; const per = {};
const sets = (process.env.SETS || 'py,app').split(',');
for (const g of 'u1 u2 u4 u5 u6 u7 u8 u9 u10 u11 u12'.split(' ')) for (const ph of [].concat(sets.includes('py') ? ['', '_p1', '_p2', '_p3'] : [], sets.includes('app') ? ['_app0', '_app83', '_app167'] : [])) {
  const f = 'cache/' + g + ph + '.json'; if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f)), r = ref(g);
  const tr = new GT.Tracker(null, opts); tr.reset(d.fen || undefined);
  const t0 = Date.now(); for (const x of d.reads) tr.read(x.t, i => x.p[i], i => !!x.m[i]); ms += Date.now() - t0; n += d.reads.length;
  const c = new Chess(d.fen || undefined), san = [];
  for (const m of tr.best().moves) { if (m.pass) { const q = c.fen().split(' '); q[1] = q[1] === 'w' ? 'b' : 'w'; q[3] = '-'; c.load(q.join(' ')); san.push('--'); continue; } const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' }); if (!mv) break; san.push(mv.san); }
  const e = lev(san.slice(0, r.length), r); tot += e; per[g] = (per[g] || 0) + e;
  const p = san.filter(x => x === '--').length; passes += p; if (r.includes('--') && san.includes('--')) good++;
}
console.log(`${JSON.stringify(opts)} ошибок ${tot} | пропусков поставлено ${passes} (партий с верным пропуском: ${good}) | мс на проверку ${(ms / n).toFixed(2)} | ${JSON.stringify(per)}`);
