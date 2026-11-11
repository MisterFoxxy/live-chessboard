const {Chess}=require('chess.js');
const GT=require('../../js/game-tracker.js');
const fs=require('fs');
for (const g of process.argv.slice(2)) {
  const d=JSON.parse(fs.readFileSync('cache/'+g+'.json'));
  const tr=new GT.Tracker(Chess, {}); tr.reset(d.fen||undefined);
  const t0=Date.now(); let n=0;
  for (const r of d.reads) { tr.read(r.t, i=>r.p[i], i=>!!r.m[i]); n++; }
  const ms=(Date.now()-t0)/n;
  console.log(g, (ms).toFixed(1)+' ms/read', tr.best().moves.map(m=>m.san).join(' '));
}
