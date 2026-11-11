const {Chess}=require('chess.js');
const GT=require('../../js/game-tracker.js');
let seed=11; const rnd=()=>{seed=(seed*1664525+1013904223)>>>0; return seed/4294967296;};
const SQ=GT.SQUARES; let positions=0, mism=0, castles=0, eps=0, promos=0;
for (let g=0; g<400; g++) {
  const c=new Chess();
  for (let ply=0; ply<120 && !c.game_over(); ply++) {
    const pos=GT._fromFen(c.fen());
    const mine=new Set(); for (let i=0;i<64;i++) for (const m of GT._movesFromSq(pos,i)) { mine.add(SQ[m.from]+SQ[m.to]); if (m.castle) castles++; if (m.ep) eps++; if (m.promo) promos++; }
    const ref=new Set(c.moves({verbose:true}).map(m=>m.from+m.to));
    positions++;
    if (mine.size!==ref.size || [...ref].some(x=>!mine.has(x))) { mism++; if (mism<4) console.log('MISMATCH', c.fen(), [...ref].filter(x=>!mine.has(x)), [...mine].filter(x=>!ref.has(x))); }
    // after move: our make() must give the same placement/castling/ep as chess.js
    const ms=c.moves({verbose:true}); const m=ms[Math.floor(rnd()*ms.length)];
    const mm=GT._movesFromSq(pos, SQ.indexOf(m.from)).find(x=>SQ[x.to]===m.to);
    c.move(m.promotion ? {from:m.from,to:m.to,promotion:'q'} : m);
    const a=GT._make(pos, mm), b=GT._fromFen(c.fen());
    if (a.b.join()!==b.b.join() || a.castle!==b.castle || a.turn!==b.turn || (a.ep!==b.ep && !(b.ep===-1))) { mism++; if (mism<6) console.log('MAKE MISMATCH', c.fen(), a.ep, b.ep, a.castle, b.castle); }
  }
}
console.log('positions', positions, 'mismatches', mism, '| castling moves seen', castles, 'en passant', eps, 'promotions', promos);
