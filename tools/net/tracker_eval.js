// Трекер на кэшированных прочтениях сети, со сдвигами кадров: node tracker_eval.js [опции JSON] 
// Для каждой партии: cache/uN.json (сдвиг 0) и cache/uN_p1..p3.json (сдвиги 1/16, 1/8, 3/16 с).
// Печатает: сколько первых ходов совпало с эталоном / длина эталона и расстояние правки.
const { Chess } = require('chess.js');
const GT = require('../../js/game-tracker.js');
const fs = require('fs'), path = require('path');
const opts = JSON.parse(process.argv[2] || '{}');
const TEST = process.env.TEST || 'test';
const ref = g => {
  const f = path.join(TEST, g + 's.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f)).expected;
  return fs.readFileSync({ u9: 'g9_beam.txt' }[g]).toString().trim().split(/\s+/);
};
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const games = (process.env.GAMES || 'u1 u2 u4 u5 u6 u7 u8 u9').split(' ');
const phases = (process.env.PHASES || ',_p1,_p2,_p3').split(',');
let tot = 0, perfect = 0, runs = 0;
const lines = [];
for (const g of games) {
  const r = ref(g), cells = [];
  for (const ph of phases) {
    const f = 'cache/' + g + ph + '.json';
    if (!fs.existsSync(f)) { cells.push('   -   '); continue; }
    const d = JSON.parse(fs.readFileSync(f));
    const tr = new GT.Tracker(null, opts); tr.reset(d.fen || undefined);
    for (const x of d.reads) tr.read(x.t, i => x.p[i], i => !!x.m[i]);
    const c = new Chess(d.fen || undefined), san = [];
    for (const m of tr.best().moves) { const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' }); if (!mv) break; san.push(mv.san); }
    let k = 0; while (k < r.length && san[k] === r[k]) k++;
    const e = lev(san.slice(0, r.length), r); // ходы после конца эталона не считаем
    tot += e; runs++; if (e === 0) perfect++;
    cells.push(`${String(k).padStart(2)}/${r.length} e${e}`.padEnd(10));
    if (process.env.V && e) lines.push(`${g}${ph}: ${san.join(' ')}`);
  }
  console.log(g.padEnd(3), cells.join(' '));
}
console.log(`всего правок ${tot}, без ошибок ${perfect}/${runs}`);
if (lines.length) console.log(lines.join('\n'));
