// gt positions -> moves. usage: node gt_moves.js gt.json out.json
const { Chess } = require('chess.js');
const fs = require('fs');
const gt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const place = fen => fen.split(' ')[0];
function rights(p) {
  const rows = p.split('/').map(r => r.replace(/\d/g, d => '.'.repeat(+d)));
  const at = (sq) => rows[8 - +sq[1]]['abcdefgh'.indexOf(sq[0])];
  let r = '';
  if (at('e1') === 'K' && at('h1') === 'R') r += 'K';
  if (at('e1') === 'K' && at('a1') === 'R') r += 'Q';
  if (at('e8') === 'k' && at('h8') === 'r') r += 'k';
  if (at('e8') === 'k' && at('a8') === 'r') r += 'q';
  return r || '-';
}
function search(ch, target, depth) {
  if (place(ch.fen()) === target) return [];
  if (!depth) return null;
  for (const m of ch.moves({ verbose: true })) {
    ch.move(m);
    const rest = search(ch, target, depth - 1);
    ch.undo();
    if (rest) return [m.san].concat(rest);
  }
  return null;
}
let best = null;
for (const side of ['w', 'b']) {
  const ch = new Chess(`${gt[0].placement} ${side} ${rights(gt[0].placement)} - 0 1`);
  const start = ch.fen();
  const moves = [];
  let ok = 0;
  for (let i = 1; i < gt.length; i++) {
    const seq = search(ch, gt[i].placement, 2);
    if (!seq) { moves.push({ t: gt[i].t, san: null, note: 'no-path ' + gt[i].placement }); continue; }
    for (const san of seq) { ch.move(san); moves.push({ t: gt[i].t, san }); ok++; }
  }
  if (!best || ok > best.ok) best = { ok, start, moves };
}
fs.writeFileSync(process.argv[3], JSON.stringify(best, null, 1));
console.log(process.argv[2], 'start', best.start, '\n  ', best.moves.map(m => m.san || '??').join(' '));
