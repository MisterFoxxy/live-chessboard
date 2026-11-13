// Что видит пользователь: сколько раз запись переписывалась («Исправлено») и с какой задержкой появлялся ход.
// node rewrite_eval.js '{опции трекера}' [hold]   — hold: показывать ход только после чистого подтверждения доской
const { Chess } = require('chess.js');
const GT = require(process.env.GTJS || '../../js/game-tracker.js');
const fs = require('fs');
const TEST = (process.env.TEST || 'test') + '/';
const opts = JSON.parse(process.argv[2] || '{}'), mode = process.argv[3] || 'now', hold = mode !== 'now', margin = +(process.argv[4] || 4);
// сколько первых ходов (начиная с from) одинаковы у всех гипотез, отстающих от лучшей не больше чем на margin
const agreed = (tr, want, from) => { const near = tr.beam.filter(h => h.acc <= margin); let k = from; while (k < want.length && near.every(h => h.moves.length > k && same(h.moves[k], want[k]))) k++; return k; };
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const same = (a, b) => a.from === b.from && a.to === b.to && !a.pass === !b.pass;
const games = (process.env.GAMES || 'u1 u2 u4 u5 u6 u7 u8 u9 u10 u12').split(' ');
let quick = 0, rew = 0, rewMoves = 0, edits = 0, runs = 0; const lat = [], perGame = {};
for (const g of games) for (const ph of ['_app0', '_app83', '_app167']) {
  const f = 'cache/' + g + ph + '.json'; if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f)), ref = JSON.parse(fs.readFileSync(TEST + g + 's.json')).expected;
  const tr = new GT.Tracker(null, opts); tr.reset(d.fen || undefined);
  let shown = [], shownAt = [], bestAt = [], bestPrev = [];
  for (const x of d.reads) {
    const b = tr.read(x.t, i => x.p[i], i => !!x.m[i]);
    if (!b) continue;
    const want = b.moves;
    { let kk = 0; while (kk < bestPrev.length && kk < want.length && same(bestPrev[kk], want[kk])) kk++; bestAt = bestAt.slice(0, kk).concat(want.slice(kk).map(() => x.t)); bestPrev = want; }
    let k = 0; while (k < shown.length && k < want.length && same(shown[k], want[k])) k++;
    const n = mode === 'now' ? want.length : mode === 'hold' ? tr.confirmed(want, k) : mode === 'agree' ? agreed(tr, want, k) : Math.max(tr.confirmed(want, k), agreed(tr, want, k));
    if (shown.length > k && x.t - shownAt[k] < 1.5) quick++;
    if (shown.length > k) { rew++; rewMoves += shown.length - k; perGame[g] = (perGame[g] || 0) + 1; }
    if (shown.length > k || n > k) { shown = want.slice(0, n); shownAt = shownAt.slice(0, k).concat(want.slice(k, n).map(() => x.t)); }
  }
  const fin = tr.best().moves;
  const c0 = new Chess(); const finSan = [];
  for (const m of fin) { if (m.pass) { const f = c0.fen().split(' '); f[1] = f[1] === 'w' ? 'b' : 'w'; f[3] = '-'; c0.load(f.join(' ')); finSan.push('--'); continue; } const mv = c0.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' }); finSan.push(mv ? mv.san : '?'); }
  for (let i = 0; i < fin.length; i++) {
    if (finSan[i] !== ref[i]) continue;                         // только верные ходы
    const L = i < shown.length && same(shown[i], fin[i]) ? Math.max(0, shownAt[i] - bestAt[i]) : 99;
    lat.push(L);
  }
  const c = new Chess(), san = [];
  for (const m of fin) { if (m.pass) { const f = c.fen().split(' '); f[1] = f[1] === 'w' ? 'b' : 'w'; f[3] = '-'; c.load(f.join(' ')); san.push('--'); continue; } const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' }); if (!mv) break; san.push(mv.san); }
  edits += lev(san.slice(0, ref.length), ref); runs++;
}
lat.sort((a, b) => a - b);
const q = f => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * f))].toFixed(2) : '-';
const over = v => lat.filter(x => x > v).length;
console.log(`${JSON.stringify(opts)} ${mode}${hold && mode !== 'hold' ? ' m=' + margin : ''} | «Исправлено» ${rew} раз, из них быстрых (ход провисел < 1,5 с) ${quick} | ошибок в итоге ${edits} | задержка показа (сверх трекера): медиана ${q(0.5)} с, 90% ${q(0.9)} с, макс ${q(1)} с | верных ходов позже 1 с: ${over(1)}, позже 2 с: ${over(2)}, не показаны до конца: ${over(90)} из ${lat.length}`);
if (process.env.V) console.log('  по партиям:', JSON.stringify(perGame));
