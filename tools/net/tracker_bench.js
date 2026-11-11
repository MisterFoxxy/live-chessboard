const {Chess}=require('chess.js');
const GT=require('../../js/game-tracker.js');
const fs=require('fs');
let calls=0; const orig=Chess; 
for (const g of process.argv.slice(2)) {
  const d=JSON.parse(fs.readFileSync('cache/'+g+'.json'));
  const tr=new GT.Tracker(Chess, {}); tr.reset(d.fen||undefined);
  const times=[];
  for (const r of d.reads) { const t0=process.hrtime.bigint(); tr.read(r.t, i=>r.p[i], i=>!!r.m[i]); times.push(Number(process.hrtime.bigint()-t0)/1e6); }
  times.sort((a,b)=>a-b);
  console.log(g.padEnd(4), 'ms/read median', times[times.length>>1].toFixed(1), 'p95', times[Math.floor(times.length*0.95)].toFixed(1), 'max', times[times.length-1].toFixed(1), '|', (()=>{const c=new Chess(d.fen||undefined); return tr.best().moves.map(m=>c.move({from:m.from,to:m.to,promotion:m.promotion||'q'}).san).join(' ');})().slice(0,150));
}
