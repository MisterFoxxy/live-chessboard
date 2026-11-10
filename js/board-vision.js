/*
 * BoardVision — распознавание ходов на живой доске по картинке с камеры.
 *
 * Модуль без DOM: на вход — пиксели кадра (ImageData) и 4 угла доски,
 * на выход — «отпечатки» 64 клеток, оценка изменений и подбор легального хода.
 *
 * Идея:
 *   1. По 4 углам строим гомографию «квадрат доски → кадр».
 *   2. В центральной части каждой клетки берём сетку точек (RGB) — это отпечаток клетки.
 *   3. Пока над доской рука — кадры сильно меняются. Когда рука ушла и картинка
 *      успокоилась, сравниваем отпечатки с последним принятым состоянием.
 *   4. Изменившиеся клетки сопоставляем с легальными ходами (chess.js):
 *      ход засчитывается, если изменились все его клетки (для рокировки — 4,
 *      для взятия на проходе — 3).
 *
 * Работает в браузере (window.BoardVision) и в Node (module.exports) для тестов.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardVision = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FILES = 'abcdefgh';
  const UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const SQUARES = [];
  for (let rk = 8; rk >= 1; rk--) for (let f = 0; f < 8; f++) SQUARES.push(FILES[f] + rk);

  /* ---------- Геометрия ---------- */

  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        if (!f) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  /** Гомография, переводящая 4 точки src в 4 точки dst. */
  function computeHomography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [X, Y] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    const h = solveLinear(A, b);
    return h ? [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] : null;
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  /** Упорядочивает 4 точки по часовой стрелке на экране: ЛВ, ПВ, ПН, ЛН. */
  function orderQuad(pts) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const sorted = pts.slice().sort((a, b) =>
      Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let start = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
    }
    return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
  }

  /** Выпуклый ли четырёхугольник (иначе гомография бессмысленна). */
  function isConvexQuad(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1e-9) return false;
      const s = Math.sign(cross);
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }

  /*
   * Ориентация k (0..3): как клетки доски лежат в сетке 8×8 кадра.
   * Сетка: строка r сверху вниз, столбец c слева направо (после выпрямления).
   *   k=0 — белые снизу, k=1 — белые слева, k=2 — белые сверху, k=3 — белые справа.
   */
  function squareToCell(square, k) {
    const f = FILES.indexOf(square[0]), rk = +square[1] - 1;
    let r = 7 - rk, c = f;
    for (let i = 0; i < k; i++) { const nr = c; c = 7 - r; r = nr; }
    return r * 8 + c;
  }

  const CELL_OF = [0, 1, 2, 3].map(k => {
    const map = {};
    for (const sq of SQUARES) map[sq] = squareToCell(sq, k);
    return map;
  });

  function cellToSquare(cell, k) {
    const map = CELL_OF[k & 3];
    for (const sq in map) if (map[sq] === cell) return sq;
    return null;
  }

  /* ---------- Отпечатки клеток ---------- */

  /**
   * План выборки: для каждой клетки — точки внутри неё (в пикселях кадра) и размер
   * окна усреднения вокруг каждой точки. Ближнюю к камере часть клетки (низ в кадре)
   * отбрасываем: туда «заходит» высокая фигура с соседней клетки.
   * H — гомография «единичный квадрат → пиксели кадра».
   */
  function samplePlan(H, opts) {
    opts = opts || {};
    const n = opts.samples || 8;
    const m = opts.margin != null ? opts.margin : 0.12;
    const keep = Math.max(1, Math.round(n * n * (1 - (opts.dropNear != null ? opts.dropNear : 0.3))));
    const xs = new Float32Array(64 * keep), ys = new Float32Array(64 * keep), rs = new Uint8Array(64 * keep);
    const step = (1 - 2 * m) / n / 8;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const pts = [];
        for (let i = 0; i < n; i++) {
          const v = (r + m + (1 - 2 * m) * (i + 0.5) / n) / 8;
          for (let j = 0; j < n; j++) {
            const u = (c + m + (1 - 2 * m) * (j + 0.5) / n) / 8;
            const p = applyH(H, u, v);
            const pu = applyH(H, u + step, v), pv = applyH(H, u, v + step);
            const span = Math.min(Math.hypot(pu[0] - p[0], pu[1] - p[1]), Math.hypot(pv[0] - p[0], pv[1] - p[1]));
            pts.push([p[0], p[1], Math.max(0, Math.min(6, Math.round(span / 2 - 0.25)))]);
          }
        }
        pts.sort((a, b) => a[1] - b[1]); // сверху вниз по кадру; нижние (ближние) отбрасываем
        const o = (r * 8 + c) * keep;
        for (let i = 0; i < keep; i++) { xs[o + i] = pts[i][0]; ys[o + i] = pts[i][1]; rs[o + i] = pts[i][2]; }
      }
    }
    return { keep, xs, ys, rs };
  }

  let integ = null;
  function integralImage(img) {
    const w = img.width, h = img.height, W = w + 1, size = W * (h + 1);
    if (!integ || integ.size !== size) {
      integ = { size, W, r: new Uint32Array(size), g: new Uint32Array(size), b: new Uint32Array(size) };
    }
    const { r: R, g: G, b: B } = integ, d = img.data;
    for (let y = 0; y < h; y++) {
      let sr = 0, sg = 0, sb = 0;
      const row = (y + 1) * W, prev = y * W;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
        R[row + x + 1] = R[prev + x + 1] + sr;
        G[row + x + 1] = G[prev + x + 1] + sg;
        B[row + x + 1] = B[prev + x + 1] + sb;
      }
    }
    return integ;
  }

  /** Снимает отпечатки 64 клеток по готовому плану (каждая точка — среднее по окну). */
  function sampleWithPlan(img, plan) {
    const I = integralImage(img), W = I.W, w = img.width, h = img.height;
    const per = plan.keep * 3, data = new Float32Array(64 * per);
    let sum = 0;
    for (let s = 0, o = 0; s < 64 * plan.keep; s++, o += 3) {
      const rad = plan.rs[s];
      let cx = Math.round(plan.xs[s]), cy = Math.round(plan.ys[s]);
      cx = cx < 0 ? 0 : cx > w - 1 ? w - 1 : cx;
      cy = cy < 0 ? 0 : cy > h - 1 ? h - 1 : cy;
      const x0 = Math.max(0, cx - rad), x1 = Math.min(w, cx + rad + 1);
      const y0 = Math.max(0, cy - rad), y1 = Math.min(h, cy + rad + 1);
      const a = y0 * W + x0, b = y0 * W + x1, c = y1 * W + x0, e = y1 * W + x1;
      const area = (x1 - x0) * (y1 - y0);
      data[o] = (I.r[e] - I.r[b] - I.r[c] + I.r[a]) / area;
      data[o + 1] = (I.g[e] - I.g[b] - I.g[c] + I.g[a]) / area;
      data[o + 2] = (I.b[e] - I.b[b] - I.b[c] + I.b[a]) / area;
      sum += data[o] + data[o + 1] + data[o + 2];
    }
    return { n: plan.keep, per, data, mean: sum / data.length };
  }

  /** То же за один вызов (план строится заново). */
  function sampleBoard(img, H, opts) {
    return sampleWithPlan(img, samplePlan(H, opts));
  }

  function averageFeatures(list) {
    if (list.length === 1) return list[0];
    const f0 = list[0], data = new Float32Array(f0.data.length);
    let mean = 0;
    for (const f of list) {
      for (let i = 0; i < data.length; i++) data[i] += f.data[i];
      mean += f.mean;
    }
    for (let i = 0; i < data.length; i++) data[i] /= list.length;
    return { n: f0.n, per: f0.per, data, mean: mean / list.length };
  }

  /**
   * Насколько изменилась каждая клетка (с поправкой на общую яркость/экспозицию).
   * Берём среднее по самой изменившейся доле точек: фигура занимает лишь часть клетки,
   * и обычное среднее «размывает» её появление или исчезновение.
   */
  function cellDiff(a, b, topFrac) {
    const cnt = a.per / 3, out = new Float32Array(64);
    // Поправка на экспозицию — медиана отношений яркости по клеткам:
    // рука над частью доски на неё почти не влияет.
    const ratios = new Float32Array(64);
    for (let cell = 0; cell < 64; cell++) {
      let sa = 0, sb = 0;
      const o = cell * a.per;
      for (let i = 0; i < a.per; i++) { sa += a.data[o + i]; sb += b.data[o + i]; }
      ratios[cell] = sb > 1 ? sa / sb : 1;
    }
    let g = median(ratios);
    if (!(g >= 0.7)) g = 0.7; else if (g > 1.4) g = 1.4;
    const top = Math.max(1, Math.round(cnt * (topFrac || 0.35)));
    const d = new Float32Array(cnt);
    for (let cell = 0; cell < 64; cell++) {
      const o = cell * a.per;
      for (let i = 0, k = o; i < cnt; i++, k += 3) {
        d[i] = (Math.abs(a.data[k] - b.data[k] * g) + Math.abs(a.data[k + 1] - b.data[k + 1] * g) +
                Math.abs(a.data[k + 2] - b.data[k + 2] * g)) / 3;
      }
      d.sort();
      let sum = 0;
      for (let i = cnt - top; i < cnt; i++) sum += d[i];
      out[cell] = sum / top;
    }
    return out;
  }

  function cloneFeatures(f) {
    return { n: f.n, per: f.per, data: new Float32Array(f.data), mean: f.mean };
  }

  /** Копирует отпечатки указанных клеток из src в dst. */
  function copyCells(dst, src, cells) {
    for (const cell of cells) {
      const o = cell * src.per;
      dst.data.set(src.data.subarray(o, o + src.per), o);
    }
  }

  /** Средняя яркость и «текстура» (СКО яркости) каждой клетки. */
  function cellStats(f) {
    const lum = new Float32Array(64), tex = new Float32Array(64);
    const per = f.per, cnt = per / 3;
    for (let cell = 0; cell < 64; cell++) {
      const o = cell * per;
      let s = 0, s2 = 0;
      for (let i = 0; i < per; i += 3) {
        const y = 0.299 * f.data[o + i] + 0.587 * f.data[o + i + 1] + 0.114 * f.data[o + i + 2];
        s += y; s2 += y * y;
      }
      const mu = s / cnt;
      lum[cell] = mu;
      tex[cell] = Math.sqrt(Math.max(0, s2 / cnt - mu * mu));
    }
    return { lum, tex };
  }

  function kthLargest(arr, k) {
    const a = Array.from(arr).sort((x, y) => y - x);
    return a[Math.min(k, a.length) - 1] || 0;
  }

  function median(arr) {
    const a = Array.from(arr).sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /* ---------- Начальная позиция и ориентация ---------- */

  /**
   * Проверяет, что в сетке стоит начальная расстановка, и определяет ориентацию:
   *  - занятые ряды (1,2,7,8) «пёстрые», пустые (3–6) — однотонные;
   *  - угол a1 — тёмный (по чередованию клеток в пустом центре);
   *  - белые фигуры светлее чёрных.
   */
  function detectStartPosition(f) {
    const { lum, tex } = cellStats(f);
    const avg = (arr, pred) => {
      let s = 0, n = 0;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        if (pred(r, c)) { s += arr[r * 8 + c]; n++; }
      }
      return n ? s / n : 0;
    };
    const edge = i => i < 2 || i > 5;
    const occRows = avg(tex, r => edge(r)) - avg(tex, r => !edge(r));
    const occCols = avg(tex, (r, c) => edge(c)) - avg(tex, (r, c) => !edge(c));
    const center = (r, c) => r >= 2 && r <= 5 && c >= 2 && c <= 5;
    const par = avg(lum, (r, c) => center(r, c) && (r + c) % 2 === 0) -
                avg(lum, (r, c) => center(r, c) && (r + c) % 2 === 1);
    const texScale = avg(tex, () => true) + 1e-6;
    const parVote = Math.max(-1, Math.min(1, par / 25));
    const rowsVote = (occRows - occCols) / texScale + parVote;
    const axisRows = rowsVote >= 0;

    const occ = axisRows ? occRows : occCols;
    const strength = occ / texScale;
    // Чередование клеток должно совпадать с осью: при белых снизу/сверху светлые — (r+c) чётные.
    const parityOk = Math.abs(par) < 6 || (axisRows ? par > 0 : par < 0);

    let k, wht;
    if (axisRows) {
      wht = avg(lum, r => r >= 6) - avg(lum, r => r <= 1);
      k = wht >= 0 ? 0 : 2;
    } else {
      wht = avg(lum, (r, c) => c <= 1) - avg(lum, (r, c) => c >= 6);
      k = wht >= 0 ? 1 : 3;
    }
    const recognized = strength > 0.35 && occ > 2.5 && parityOk && Math.abs(wht) > 2;
    return { k, recognized, strength, occ, par, wht, parityOk, occRows, occCols };
  }

  /* ---------- Изменения и подбор хода ---------- */

  /**
   * Изменение каждой клетки между эталоном и текущим кадром.
   * Вычитаем медиану — так общий сдвиг освещения не выглядит как ход.
   */
  function squareChanges(ref, cur, k) {
    const raw = cellDiff(cur, ref);
    const med = median(raw);
    const grid = new Float32Array(64);
    let max = 0;
    for (let i = 0; i < 64; i++) {
      grid[i] = Math.max(0, raw[i] - med);
      if (grid[i] > max) max = grid[i];
    }
    const bySquare = {};
    const map = CELL_OF[k & 3];
    for (const sq of SQUARES) bySquare[sq] = grid[map[sq]];
    return { grid, bySquare, max, median: med };
  }

  /** Клетки, которые меняются при ходе (verbose-ход chess.js). */
  function squaresOfMove(m) {
    const s = [m.from, m.to];
    const rank = m.color === 'w' ? '1' : '8';
    if (m.flags.indexOf('k') >= 0) s.push('h' + rank, 'f' + rank);
    if (m.flags.indexOf('q') >= 0) s.push('a' + rank, 'd' + rank);
    if (m.flags.indexOf('e') >= 0) s.push(m.to[0] + m.from[1]);
    return s;
  }

  /** Убирает дубли превращений: по умолчанию — ферзь. */
  function uniqueMoves(moves) {
    const seen = {};
    const out = [];
    for (const m of moves) {
      const key = m.from + m.to;
      if (seen[key] !== undefined) {
        if (m.promotion === 'q') out[seen[key]] = m;
        continue;
      }
      seen[key] = out.length;
      out.push(m);
    }
    return out;
  }

  /**
   * Клетки, которые может заслонить фигура, стоящая на данной клетке.
   * Фигура в кадре — вертикальный «силуэт» над центром клетки высотой примерно
   * в ширину клетки. Чем ниже камера, тем больше клеток он накрывает.
   * При появлении/уходе фигуры эти клетки тоже меняются — это не должно мешать
   * распознать ход. H — гомография единичного квадрата в кадр, k — ориентация.
   * Возвращает {square: [squares]}.
   */
  function occlusionMap(H, k, opts) {
    opts = opts || {};
    const heightK = opts.height || 1.1, widthK = opts.width || 0.7;
    const quad = UNIT.map(p => applyH(H, p[0], p[1]));
    const Hinv = computeHomography(quad, UNIT);
    const map = {};
    for (const sq of SQUARES) {
      const cell = CELL_OF[k & 3][sq], r = cell >> 3, c = cell & 7;
      const p = applyH(H, (c + 0.5) / 8, (r + 0.5) / 8);
      const a = applyH(H, (c + 1.5) / 8, (r + 0.5) / 8), b = applyH(H, (c + 0.5) / 8, (r + 1.5) / 8);
      const w = Math.max(Math.hypot(a[0] - p[0], a[1] - p[1]), Math.hypot(b[0] - p[0], b[1] - p[1]));
      const hits = {};
      for (let i = 1; i <= 8; i++) {
        const y = p[1] - w * heightK * i / 8;
        for (let j = -2; j <= 2; j++) {
          const x = p[0] + w * widthK * j / 4;
          const q = applyH(Hinv, x, y);
          const cc = Math.floor(q[0] * 8), rr = Math.floor(q[1] * 8);
          if (cc < 0 || cc > 7 || rr < 0 || rr > 7 || (cc === c && rr === r)) continue;
          const key = rr * 8 + cc;
          hits[key] = (hits[key] || 0) + 1;
        }
      }
      map[sq] = Object.keys(hits).filter(key => hits[key] >= 3).map(key => cellToSquare(+key, k));
    }
    return map;
  }

  function candidate(moves, changes, ctx) {
    const set = new Set();
    for (const m of moves) for (const s of squaresOfMove(m)) set.add(s);
    const covered = new Set(set);
    if (ctx.occ) for (const s of set) for (const o of ctx.occ[s] || []) covered.add(o);
    let min = Infinity;
    for (const s of set) { const v = changes[s] || 0; if (v < min) min = v; }
    return {
      moves, set, min,
      direct: ctx.strong.filter(s => !set.has(s)).length,
      unexplained: ctx.strong.filter(s => !covered.has(s)).length,
      noise: ctx.changed.filter(s => !covered.has(s)).length,
    };
  }

  const isCastle = c => c.moves.some(m => /[kq]/.test(m.flags));

  /*
   * Какое объяснение лучше: меньше необъяснённых сильных изменений; рокировка
   * (если все 4 её клетки изменились) лучше хода одной ладьёй или короля;
   * затем — у кого самая слабая клетка хода изменилась сильнее.
   */
  function better(a, b) {
    if (!b) return true;
    if (a.unexplained !== b.unexplained) return a.unexplained < b.unexplained;
    const ca = isCastle(a), cb = isCastle(b);
    if (ca !== cb) return ca;
    if (Math.abs(a.min - b.min) > 1e-6) return a.min > b.min;
    return a.set.size > b.set.size;
  }

  /**
   * Ищет ход (или два хода подряд — если соперник ответил, не дав картинке успокоиться),
   * который объясняет изменившиеся клетки.
   * chess — экземпляр chess.js (по итогам вызова не меняется).
   * opts: threshold — порог изменения клетки, occ — карта перекрытий (occlusionMap).
   * Возвращает {type:'move', moves:[...]} | {type:'none'} | {type:'unclear'}.
   */
  function findMove(chess, changes, opts) {
    opts = opts || {};
    const T = opts.threshold || 14;
    const maxExtra = opts.maxExtra != null ? opts.maxExtra : 3;
    const all = Object.keys(changes);
    const ctx = {
      occ: opts.occ || null,
      changed: all.filter(s => changes[s] >= T),
      strong: all.filter(s => changes[s] >= T * 1.6),
    };
    const report = { changed: ctx.changed, strong: ctx.strong };
    if (!ctx.changed.length) return Object.assign({ type: 'none' }, report);

    const fits = m => squaresOfMove(m).every(s => changes[s] >= T);
    const ok = c => c && c.unexplained <= 1 && c.noise <= maxExtra;

    const firstMoves = uniqueMoves(chess.moves({ verbose: true })).filter(fits);
    let best1 = null;
    for (const m of firstMoves) {
      const c = candidate([m], changes, ctx);
      if (better(c, best1)) best1 = c;
    }
    if (best1 && best1.direct === 0 && ok(best1)) {
      return Object.assign({ type: 'move', moves: best1.moves, min: best1.min }, report);
    }

    // Два хода подряд ищем, только если один ход (с учётом заслонённых клеток) картину не объясняет.
    if (opts.allowDouble !== false && ctx.strong.length >= 3 && (!best1 || best1.unexplained >= 1)) {
      let best2 = null;
      for (const m1 of firstMoves) {
        if (!chess.move({ from: m1.from, to: m1.to, promotion: m1.promotion })) continue;
        for (const m2 of uniqueMoves(chess.moves({ verbose: true }))) {
          if (!fits(m2)) continue;
          const c = candidate([m1, m2], changes, ctx);
          if (better(c, best2)) best2 = c;
        }
        chess.undo();
      }
      // Два хода принимаем, только если они объясняют изменения напрямую лучше одного.
      // Пара ходов — смелое предположение: все её клетки должны измениться явно.
      if (ok(best2) && best2.unexplained === 0 && best2.min >= T * 2.2 &&
          (!best1 || (best2.direct < best1.direct && best2.unexplained <= best1.unexplained))) {
        return Object.assign({ type: 'move', moves: best2.moves, min: best2.min, double: true }, report);
      }
    }

    if (ok(best1)) {
      return Object.assign({ type: 'move', moves: best1.moves, min: best1.min, weak: true }, report);
    }

    // Запасной вариант для низкой камеры: клетку, откуда ушла фигура, могут полностью
    // закрывать фигуры впереди. Тогда допускаем, что её уход виден по клеткам в её тени,
    // но только если клетка назначения изменилась явно и такой ход единственный.
    if (ctx.occ) {
      const seen = s => changes[s] >= T || (ctx.occ[s] || []).some(o => changes[o] >= T);
      const relaxed = [];
      for (const m of uniqueMoves(chess.moves({ verbose: true }))) {
        if ((changes[m.to] || 0) < T * 1.6 || !squaresOfMove(m).every(seen)) continue;
        const c = candidate([m], changes, ctx);
        if (c.unexplained === 0 && c.noise <= maxExtra) relaxed.push(c);
      }
      if (relaxed.length === 1) {
        return Object.assign({ type: 'move', moves: relaxed[0].moves, min: relaxed[0].min, weak: true, relaxed: true }, report);
      }
    }
    return Object.assign({ type: 'unclear' }, report);
  }

  /**
   * Насколько последовательность уже записанных ходов объясняет изменения:
   * fits — все клетки ходов действительно изменились; unexplained/noise — что осталось.
   */
  function scoreMoves(moves, changes, opts) {
    const T = opts.threshold || 14;
    const all = Object.keys(changes);
    const ctx = {
      occ: opts.occ || null,
      changed: all.filter(s => changes[s] >= T),
      strong: all.filter(s => changes[s] >= T * 1.6),
    };
    const c = candidate(moves, changes, ctx);
    c.fits = moves.every(m => squaresOfMove(m).every(s => (changes[s] || 0) >= T * 0.7));
    return c;
  }

  /** Ход — первая половина рокировки «ладьёй вперёд» (ладья с угла, когда рокировка возможна)? */
  function castlingPrefix(legal, m) {
    if (m.piece !== 'r') return false;
    const rank = m.color === 'w' ? '1' : '8';
    const side = m.from === 'h' + rank ? 'k' : m.from === 'a' + rank ? 'q' : null;
    return !!side && legal.some(x => x.flags.indexOf(side) >= 0);
  }

  /**
   * Быстрая фиксация хода прямо во время движения руки.
   * Ход принимается, когда все его клетки изменились и уже неподвижны fastMs, причём
   * на клетке назначения что-то происходило уже после того, как фигуру подняли с исходной
   * (иначе это ещё «фигура в руке»: например, сначала сняли побитую фигуру).
   * Клетки, над которыми ещё движется рука, не мешают.
   * opts: threshold, occ, stillMs {square: мс неподвижности}, lastMotion {square: время
   *       последнего движения}, onset {square: когда клетка начала отличаться от эталона},
   *       fastMs, ignore (Set клеток с возможно устаревшим эталоном), maxOther.
   * Возвращает verbose-ход chess.js или null.
   */
  function findFastMove(chess, changes, opts) {
    const T = opts.threshold || 14;
    const fastMs = opts.fastMs || 120;
    const still = s => opts.stillMs[s] >= fastMs;
    const ignore = opts.ignore || new Set();
    const all = Object.keys(changes);
    // Готовые клетки: изменились и неподвижны. Клетки недавних ходов (ignore) могут
    // участвовать в ходе (взятие в ответ), но не считаются «лишними» изменениями.
    const ready = all.filter(s => still(s) && changes[s] >= T);
    if (opts.trace) opts.trace.reasons.push('ready=' + ready.join(','));
    if (ready.length < 2) return null;
    const considered = ready.filter(s => !ignore.has(s));
    const ctx = {
      occ: opts.occ || null,
      changed: considered,
      strong: considered.filter(s => changes[s] >= T * 1.6),
    };
    const changedSet = new Set(ctx.changed);
    // Пятно соседних неподвижных изменившихся клеток вокруг клетки (по 8 соседям).
    const blob = start => {
      const seen = new Set([start]), queue = [start];
      while (queue.length) {
        const q = queue.pop(), f = q.charCodeAt(0), r = +q[1];
        for (let df = -1; df <= 1; df++) {
          for (let dr = -1; dr <= 1; dr++) {
            const n = String.fromCharCode(f + df) + (r + dr);
            if (changedSet.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
          }
        }
      }
      return seen;
    };
    const minCarry = opts.minCarryMs != null ? opts.minCarryMs : 100;
    const legal = chess.moves({ verbose: true });
    const cands = [];
    const trace = opts.trace && opts.trace.san;
    const why = (m, reason) => { if (trace === m.san) opts.trace.reasons.push(reason); };
    for (const m of uniqueMoves(legal)) {
      const sq = squaresOfMove(m);
      if (!sq.every(s => still(s) && changes[s] >= T)) {
        why(m, 'not-ready ' + sq.map(s => s + ':' + Math.round(changes[s]) + '/' + Math.round(opts.stillMs[s])).join(' '));
        continue;
      }
      const rank = m.color === 'w' ? '1' : '8';
      const froms = [m.from], dests = [m.to];
      if (m.flags.indexOf('k') >= 0) { froms.push('h' + rank); dests.push('f' + rank); }
      if (m.flags.indexOf('q') >= 0) { froms.push('a' + rank); dests.push('d' + rank); }
      // Фигуру сначала подняли, потом поставили (а не рука накрыла обе клетки разом).
      const lifted = Math.max(...froms.map(s => opts.onset[s]));
      if (!dests.every(s => opts.lastMotion[s] >= lifted + minCarry)) { why(m, 'carry'); continue; }
      // Пятна изменений вокруг клеток хода должны целиком объясняться ходом:
      // иначе это рука, лежащая или зависшая над этими клетками.
      const explained = new Set(sq);
      for (const q of sq) for (const o of (ctx.occ && ctx.occ[q]) || []) explained.add(o);
      let clean = true;
      for (const q of sq) {
        for (const b of blob(q)) if (!explained.has(b)) { clean = false; break; }
        if (!clean) break;
      }
      if (!clean) { why(m, 'blob'); continue; }
      if (castlingPrefix(legal, m)) continue;
      cands.push(candidate([m], changes, ctx));
    }
    if (!cands.length) return null;
    cands.sort((a, b) => (better(a, b) ? -1 : 1));
    const best = cands[0], second = cands[1];
    // Неподвижные изменения вне хода: если их много — на доске лежит рука, ждём.
    if (best.noise > (opts.maxOther != null ? opts.maxOther : 6)) { why(best.moves[0], 'noise ' + best.noise); return null; }
    // Неоднозначно (два хода объясняют почти одинаково) — пусть решит полная проверка.
    if (second && second.unexplained === best.unexplained && second.min >= best.min * 0.8 &&
        !isCastle(best)) { why(best.moves[0], 'ambiguous vs ' + second.moves[0].san); return null; }
    return best.moves[0];
  }

  /* ---------- Детектор «рука над доской / доска успокоилась» ---------- */

  class MotionTracker {
    /**
     * opts.settleMs — сколько миллисекунд доска должна быть неподвижной после движения.
     * Время передаётся в push() снаружи, поэтому поведение не зависит от частоты кадров.
     */
    constructor(opts) {
      this.opts = Object.assign({ settleMs: 700, minFrames: 2, keepFrames: 6, motionMin: 5, motionMax: 18, motionK: 3, rank: 1 }, opts);
      this.reset();
    }

    reset() {
      this.prev = null;
      this.last = null;
      this.moving = false;
      this.stable = [];
      this.stableSince = 0;
      this.now = 0;
      this.noise = null;
      this.lastMotion = 0;
      this.since = new Float64Array(64); // когда клетка двигалась последний раз
    }

    /** Сколько мс клетка неподвижна. */
    cellStillMs(cell) {
      return this.now - this.since[cell];
    }

    threshold() {
      const t = Math.max(this.opts.motionMin, (this.noise || 0) * this.opts.motionK);
      return Math.min(t, this.opts.motionMax);
    }

    /**
     * Добавляет кадр (t — время в мс). Возвращает {motion, moving, settled}, где settled —
     * усреднённый отпечаток в момент, когда после движения картинка снова стала неподвижной.
     */
    push(feat, t) {
      this.last = feat;
      this.now = t;
      if (!this.prev) {
        this.prev = feat;
        this.stable = [feat];
        this.stableSince = t;
        this.since.fill(t);
        return { motion: 0, moving: false, settled: null, threshold: this.threshold() };
      }
      const cells = cellDiff(feat, this.prev);
      const motion = kthLargest(cells, this.opts.rank);
      this.prev = feat;
      this.lastMotion = motion;
      const thr = this.threshold();
      for (let c = 0; c < 64; c++) if (cells[c] > thr) this.since[c] = t;
      if (motion > thr) {
        this.moving = true;
        this.stable = [];
        return { motion, moving: true, settled: null, threshold: thr };
      }
      if (motion < thr * 0.5 || this.noise == null) {
        this.noise = this.noise == null ? motion : this.noise * 0.95 + motion * 0.05;
      }
      if (!this.stable.length) this.stableSince = t;
      this.stable.push(feat);
      if (this.stable.length > this.opts.keepFrames) this.stable.shift();
      let settled = null;
      if (this.moving && this.steadyEnough()) {
        this.moving = false;
        settled = averageFeatures(this.stable);
      }
      return { motion, moving: this.moving, settled, threshold: thr };
    }

    steadyEnough() {
      return this.stable.length >= this.opts.minFrames && this.now - this.stableSince >= this.opts.settleMs;
    }

    isSteady() {
      return !this.moving && this.steadyEnough();
    }

    steadyFeatures() {
      return this.stable.length ? averageFeatures(this.stable) : this.last;
    }
  }

  return {
    FILES, SQUARES, UNIT,
    computeHomography, applyH, orderQuad, isConvexQuad,
    squareToCell, cellToSquare,
    samplePlan, sampleWithPlan, sampleBoard, averageFeatures, cellDiff, cellStats,
    cloneFeatures, copyCells,
    detectStartPosition, squareChanges, squaresOfMove, uniqueMoves, occlusionMap, findMove, findFastMove, scoreMoves,
    MotionTracker,
  };
}));
