// Ходы во время «задумчивости»: выбрасываем подряд все проверки за W секунд (телефон не успел, рука закрыла доску)
// и сравниваем итог с прогоном без выброса. node burst_eval.js '{опции}' W
const { Chess } = require('chess.js');
const GT = require(process.env.GTJS || '../../js/game-tracker.js');
const fs = require('fs');
const opts = JSON.parse(process.argv[2] || '{}'), W = +(process.argv[3] || 2), STEP = +(process.env.STEP || 6);
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const run = (reads) => { const tr = new GT.Tracker(null, opts); tr.reset(); for (const x of reads) tr.read(x.t, i => x.p[i], i => !!x.m[i]);
  const c = new Chess(), san = []; for (const m of tr.best().moves) { if (m.pass) { san.push('--'); continue; } const z = c.move({ from: m.from, to: m.to, promotion: 'q' }); if (!z) break; san.push(z.san); } return san; };
let trials = 0, broken = 0, edits = 0, lost = 0; const ms0 = Date.now();
for (const g of (process.env.GAMES || 'u1 u2 u4 u5 u8 u9 u10 u12').split(' ')) {
  const f = 'cache/' + g + '_app0.json'; if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f)), base = run(d.reads);
  // окна, в которые попадает хотя бы один ход базового прогона (время хода — момент, когда он появился)
  const tr0 = new GT.Tracker(null, opts); tr0.reset(); for (const x of d.reads) tr0.read(x.t, i => x.p[i], i => !!x.m[i]);
  const times = tr0.best().moves.map(m => m.t);
  for (let k = 0; k < times.length; k += STEP > 3 ? 2 : 1) {
    const s = times[k] - W * 0.6, e = s + W;              // окно накрывает момент хода
    const inWin = times.filter(t => t >= s && t <= e).length;
    const r = run(d.reads.filter(x => x.t < s || x.t > e));
    const ed = lev(r, base); trials++; edits += ed; if (ed) broken++; lost += Math.max(0, base.length - r.length);
    if (ed && process.env.V) { let i = 0; while (i < r.length && r[i] === base[i]) i++;
      console.log(`  ${g} окно ${s.toFixed(1)}–${e.toFixed(1)} с, ходов в окне ${inWin}: с ${i + 1}-го полухода | было: ${base.slice(Math.max(0, i - 2), i + 5).join(' ')} | стало: ${r.slice(Math.max(0, i - 2), i + 5).join(' ')}`); }
  }
}
console.log(`${JSON.stringify(opts)} окно ${W} с: прогонов ${trials}, с отличиями ${broken} (${(100 * broken / trials).toFixed(1)}%), правок ${edits}, потеряно ходов ${lost} | ${((Date.now() - ms0) / 1000).toFixed(0)} с`);
