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

  /* ---------- Камера ---------- */

  /**
   * Восстанавливает камеру по гомографии доски (как в калибровке Чжана): главная точка —
   * центр кадра, фокус — из того, что оси доски перпендикулярны и равны по длине.
   * H — гомография «единичный квадрат → пиксели», w×h — размер кадра.
   * Возвращает project(X, Y, Z) → [x, y] для точки доски в клетках (Z — вверх, к камере).
   */
  function cameraFromH(H, w, h) {
    const Hs = [H[0] / 8, H[1] / 8, H[2], H[3] / 8, H[4] / 8, H[5], H[6] / 8, H[7] / 8, H[8]];
    const cx = w / 2, cy = h / 2;
    const col = i => [Hs[i] - cx * Hs[6 + i], Hs[3 + i] - cy * Hs[6 + i], Hs[6 + i]];
    const [a1, b1, c1] = col(0), [a2, b2, c2] = col(1), [a3, b3, c3] = col(2);
    const ests = [];
    if (Math.abs(c1 * c2) > 1e-14) { const f2 = -(a1 * a2 + b1 * b2) / (c1 * c2); if (f2 > 0) ests.push(f2); }
    const den = c2 * c2 - c1 * c1;
    if (Math.abs(den) > 1e-14) { const f2 = (a1 * a1 + b1 * b1 - a2 * a2 - b2 * b2) / den; if (f2 > 0) ests.push(f2); }
    const size = Math.max(w, h);
    let f = ests.length ? Math.sqrt(ests.reduce((x, y) => x + y, 0) / ests.length) : size;
    if (!(f > 0.4 * size && f < 4 * size)) f = size;
    const m1 = [a1 / f, b1 / f, c1], m2 = [a2 / f, b2 / f, c2], m3 = [a3 / f, b3 / f, c3];
    const lam = 2 / (Math.hypot(...m1) + Math.hypot(...m2));
    let r1 = m1.map(x => x * lam), r2 = m2.map(x => x * lam), t = m3.map(x => x * lam);
    if (t[2] < 0) { r1 = r1.map(x => -x); r2 = r2.map(x => -x); t = t.map(x => -x); }
    let r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
    // фигуры стоят со стороны камеры: центр камеры C = -Rᵀt должен иметь Z > 0
    if (-(r3[0] * t[0] + r3[1] * t[1] + r3[2] * t[2]) < 0) r3 = r3.map(x => -x);
    const project = (X, Y, Z) => {
      const px = X * r1[0] + Y * r2[0] + Z * r3[0] + t[0];
      const py = X * r1[1] + Y * r2[1] + Z * r3[1] + t[1];
      const pz = X * r1[2] + Y * r2[2] + Z * r3[2] + t[2];
      return [f * px / pz + cx, f * py / pz + cy];
    };
    // Наклон камеры: угол между её осью и перпендикуляром к доске (0° — ровно сверху).
    const n = Math.hypot(r3[0], r3[1], r3[2]) || 1;
    const tilt = Math.acos(Math.min(1, Math.abs(r3[2]) / n)) * 180 / Math.PI;
    // Точка доски под камерой (в клетках): от неё фигуры на кадре «наклоняются» наружу.
    const Rt = [[r1[0], r1[1], r1[2]], [r2[0], r2[1], r2[2]], [r3[0], r3[1], r3[2]]];
    const C = Rt.map(row => -(row[0] * t[0] + row[1] * t[1] + row[2] * t[2]));
    return { f, project, tilt, center: C };
  }

  /** Куда на кадре «наклоняется» вертикальная фигура в точке доски (u, v ∈ [0,1]). */
  function leanDir(cam, u, v) {
    if (!cam) return [0, -1];
    const a = cam.project(u * 8, v * 8, 0), b = cam.project(u * 8, v * 8, 0.5);
    const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy);
    return n > 1e-6 ? [dx / n, dy / n] : [0, -1];
  }

  /* ---------- Отпечатки клеток ---------- */

  /**
   * План выборки: для каждой клетки — точки внутри неё (в пикселях кадра) и размер
   * окна усреднения вокруг каждой точки. Часть клетки со стороны камеры отбрасываем:
   * туда «заходит» высокая фигура с соседней клетки. Камера сбоку — это низ клетки
   * в кадре, камера сверху — сторона, обращённая к центру кадра (opts.camera).
   * H — гомография «единичный квадрат → пиксели кадра».
   */
  function samplePlan(H, opts) {
    opts = opts || {};
    const n = opts.samples || 8;
    const m = opts.margin != null ? opts.margin : 0.12;
    const keep = Math.max(1, Math.round(n * n * (1 - (opts.dropNear != null ? opts.dropNear : 0.3))));
    const xs = new Float32Array(64 * keep), ys = new Float32Array(64 * keep), rs = new Uint8Array(64 * keep);
    const step = (1 - 2 * m) / n / 8;
    const cam = opts.camera || null;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const pts = [];
        const [ldx, ldy] = leanDir(cam, (c + 0.5) / 8, (r + 0.5) / 8);
        for (let i = 0; i < n; i++) {
          const v = (r + m + (1 - 2 * m) * (i + 0.5) / n) / 8;
          for (let j = 0; j < n; j++) {
            const u = (c + m + (1 - 2 * m) * (j + 0.5) / n) / 8;
            const p = applyH(H, u, v);
            const pu = applyH(H, u + step, v), pv = applyH(H, u, v + step);
            const span = Math.min(Math.hypot(pu[0] - p[0], pu[1] - p[1]), Math.hypot(pv[0] - p[0], pv[1] - p[1]));
            pts.push([p[0], p[1], Math.max(0, Math.min(6, Math.round(span / 2 - 0.25))), p[0] * ldx + p[1] * ldy]);
          }
        }
        pts.sort((a, b) => b[3] - a[3]); // по направлению наклона фигур; ближние к камере отбрасываем
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
   * Как считать разницу точек. relK/relN — поправка на яркость: одинаковый сдвиг яркости
   * на тёмной клетке заметнее, чем на светлой (чёрная фигура на тёмно-коричневой клетке
   * отличается от неё всего на 20–30 единиц, а шум светлой клетки бывает таким же).
   * chroma — вес разницы оттенка (R−B): тёмная клетка доски «тёплая», чёрная фигура — серая,
   * светлые фигуры обычно желтоватее белой клетки. tex — вес изменения «неровности» клетки.
   * mode 'plain' — простая разница (камера сбоку).
   */
  const diffOpts = { mode: 'rel', relK: 80, relN: 130, chroma: 1, tex: 2 };

  /** Разброс яркости точек клетки (o — смещение клетки в данных, cnt — число точек). */
  function texOf(f, o, cnt) {
    let s = 0, s2 = 0;
    for (let i = 0, k = o; i < cnt; i++, k += 3) {
      const y = 0.299 * f.data[k] + 0.587 * f.data[k + 1] + 0.114 * f.data[k + 2];
      s += y; s2 += y * y;
    }
    const mu = s / cnt;
    return Math.sqrt(Math.max(0, s2 / cnt - mu * mu));
  }

  /**
   * Насколько изменилась каждая клетка (с поправкой на общую яркость/экспозицию).
   * Берём среднее по самой изменившейся доле точек: фигура занимает лишь часть клетки,
   * и обычное среднее «размывает» её появление или исчезновение.
   */
  function cellDiff(a, b, topFrac, plain) {
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
    const rel = !plain && diffOpts.mode !== 'plain', K = diffOpts.relK, N = diffOpts.relN, CH = diffOpts.chroma, TK = diffOpts.tex;
    for (let cell = 0; cell < 64; cell++) {
      const o = cell * a.per;
      for (let i = 0, k = o; i < cnt; i++, k += 3) {
        const r1 = a.data[k], g1 = a.data[k + 1], b1 = a.data[k + 2];
        const r2 = b.data[k] * g, g2 = b.data[k + 1] * g, b2 = b.data[k + 2] * g;
        let v = (Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2)) / 3;
        if (rel) {
          // на тёмном усиливаем (чёрная фигура на тёмной клетке), на светлом не ослабляем
          const vr = (v + CH * Math.abs((r1 - b1) - (r2 - b2))) * N / ((r1 + g1 + b1 + r2 + g2 + b2) / 6 + K);
          if (vr > v) v = vr;
        }
        d[i] = v;
      }
      d.sort();
      let sum = 0;
      for (let i = cnt - top; i < cnt; i++) sum += d[i];
      out[cell] = sum / top;
      if (rel && TK) {
        // Неровность клетки: светлая фигура на светлой клетке почти не меняет цвет, но пустая
        // клетка гладкая, а у фигуры есть контур и тень.
        const ta = texOf(a, o, cnt), tb = texOf(b, o, cnt) * g;
        const tv = TK * Math.abs(ta - tb);
        if (tv > out[cell]) out[cell] = tv;
      }
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
    // По клеткам: в середине доски (4 ряда) фигур быть не должно.
    // Средние по рядам могут «сойтись» и посреди партии, когда фигуры уже вышли в центр.
    const inner = [], outer = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) (edge(axisRows ? r : c) ? outer : inner).push(tex[r * 8 + c]);
    }
    const mid = (median(inner) + median(outer)) / 2;
    const innerOcc = inner.filter(x => x > mid).length, edgeEmpty = outer.filter(x => x < mid).length;
    // (пустые по виду клетки по краям не проверяем: чёрная фигура на тёмной клетке почти без текстуры)
    const cellsOk = innerOcc <= 2;
    const recognized = strength > 0.35 && occ > 2.5 && parityOk && Math.abs(wht) > 2 && cellsOk;
    return { k, recognized, strength, occ, par, wht, parityOk, occRows, occCols, innerOcc, edgeEmpty };
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
   * Клетки, которые может заслонить фигура, стоящая на данной клетке: проецируем
   * «цилиндр» высотой примерно с клетку. С моделью камеры (opts.camera) это честная
   * проекция; без неё — силуэт вверх по кадру.
   * При появлении/уходе фигуры эти клетки тоже меняются — это не должно мешать
   * распознать ход. H — гомография единичного квадрата в кадр, k — ориентация.
   * Возвращает {square: [squares]}.
   */
  function occlusionMap(H, k, opts) {
    opts = opts || {};
    const cam = opts.camera || null;
    const heightK = opts.height || 1.1, widthK = opts.width || 0.7;
    const quad = UNIT.map(p => applyH(H, p[0], p[1]));
    const Hinv = computeHomography(quad, UNIT);
    const map = {};
    for (const sq of SQUARES) {
      const cell = CELL_OF[k & 3][sq], r = cell >> 3, c = cell & 7;
      const hits = {};
      const hit = (x, y) => {
        const q = applyH(Hinv, x, y);
        const cc = Math.floor(q[0] * 8), rr = Math.floor(q[1] * 8);
        if (cc < 0 || cc > 7 || rr < 0 || rr > 7 || (cc === c && rr === r)) return;
        hits[rr * 8 + cc] = (hits[rr * 8 + cc] || 0) + 1;
      };
      if (cam) {
        for (let i = 1; i <= 8; i++) {
          const z = heightK * i / 8;
          for (let j = -2; j <= 2; j++) {
            for (let l = -2; l <= 2; l += 2) {
              const p = cam.project(c + 0.5 + widthK * j / 4 * 0.5, r + 0.5 + widthK * l / 4 * 0.5, z);
              hit(p[0], p[1]);
            }
          }
        }
        map[sq] = Object.keys(hits).filter(key => hits[key] >= 4).map(key => cellToSquare(+key, k));
      } else {
        const p = applyH(H, (c + 0.5) / 8, (r + 0.5) / 8);
        const a = applyH(H, (c + 1.5) / 8, (r + 0.5) / 8), b = applyH(H, (c + 0.5) / 8, (r + 1.5) / 8);
        const w = Math.max(Math.hypot(a[0] - p[0], a[1] - p[1]), Math.hypot(b[0] - p[0], b[1] - p[1]));
        for (let i = 1; i <= 8; i++) {
          for (let j = -2; j <= 2; j++) hit(p[0] + w * widthK * j / 4, p[1] - w * heightK * i / 8);
        }
        map[sq] = Object.keys(hits).filter(key => hits[key] >= 3).map(key => cellToSquare(+key, k));
      }
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

    // клетки, закрытые рукой (по мнению ИИ), не могут быть клетками хода
    const handAt = s => { const p = opts.classOf && opts.classOf(s); return !!p && p[3] >= 0.5; };
    const fits = m => squaresOfMove(m).every(s => changes[s] >= T && !handAt(s));
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

  /**
   * То же, что scoreMoves, но по готовому набору клеток, которые должны были измениться
   * (например, по разнице итоговых позиций: клетка, где пешка появилась и была тут же побита,
   * в итоге не меняется).
   */
  function scoreSquares(squares, changes, opts) {
    const T = opts.threshold || 14;
    const all = Object.keys(changes);
    const strong = all.filter(s => changes[s] >= T * 1.6);
    const set = new Set(squares), covered = new Set(squares);
    if (opts.occ) for (const s of squares) for (const o of opts.occ[s] || []) covered.add(o);
    let min = Infinity;
    for (const s of set) min = Math.min(min, changes[s] || 0);
    return {
      set, min,
      fits: squares.every(s => (changes[s] || 0) >= T * 0.7),
      direct: strong.filter(s => !set.has(s)).length,
      unexplained: strong.filter(s => !covered.has(s)).length,
      noise: all.filter(s => changes[s] >= T && !covered.has(s)).length,
    };
  }

  /**
   * Ход может оказаться первой половиной рокировки (когда она возможна): ладья с угла
   * («ладьёй вперёд») или король на соседнюю клетку в сторону рокировки
   * (король уже ушёл с e1, а ладья встала на f1 раньше, чем видна клетка g1).
   */
  function castlingPrefix(legal, m) {
    const rank = m.color === 'w' ? '1' : '8';
    let side = null;
    if (m.piece === 'r') side = m.from === 'h' + rank ? 'k' : m.from === 'a' + rank ? 'q' : null;
    if (m.piece === 'k' && m.from === 'e' + rank && m.flags.indexOf('k') < 0 && m.flags.indexOf('q') < 0) {
      side = m.to === 'f' + rank ? 'k' : m.to === 'd' + rank ? 'q' : null;
    }
    return !!side && legal.some(x => x.flags.indexOf(side) >= 0);
  }

  /**
   * Быстрая фиксация хода прямо во время движения руки.
   * Ход принимается, когда все его клетки изменились и уже неподвижны fastMs, причём
   * на клетке назначения что-то происходило уже после того, как фигуру подняли с исходной
   * (иначе это ещё «фигура в руке»: например, сначала сняли побитую фигуру).
   * Клетки, над которыми ещё движется рука, не мешают. Если соперник ответил так быстро,
   * что изменения сливаются, распознаётся сразу пара ходов (ход + ответ).
   * opts: threshold, occ, stillMs {square: мс неподвижности}, lastMotion {square: время
   *       последнего движения}, onset {square: когда клетка начала отличаться от эталона},
   *       fastMs, ignore (Set клеток с возможно устаревшим эталоном), maxOther,
   *       stillOk(square) — своя проверка неподвижности (вместо stillMs ≥ fastMs),
   *       classOf(square) — вероятности ИИ [пусто, белая, чёрная, рука] или null,
   *       aiVeto — ИИ обучен достаточно, чтобы запрещать ходы, с которыми он уверенно не согласен.
   * Возвращает массив verbose-ходов chess.js (1 или 2) или null.
   */
  function findFastMove(chess, changes, opts) {
    const T = opts.threshold || 14;
    const fastMs = opts.fastMs || 120;
    const stillOk = opts.stillOk || (s => opts.stillMs[s] >= fastMs);
    const ignore = opts.ignore || new Set();
    const cls = opts.classOf || (() => null);
    const isHand = s => { const p = cls(s); return !!p && p[3] >= 0.5; };
    const all = Object.keys(changes);
    // Готовые клетки: изменились и неподвижны. Клетки недавних ходов (ignore) могут
    // участвовать в ходе (взятие в ответ), но не считаются «лишними» изменениями.
    // Быстрая фиксация рискованнее проверки — клетки хода должны измениться уверенно.
    const ready = all.filter(s => stillOk(s) && changes[s] >= T * (opts.fastFactor || 2));
    // Слабо изменившиеся, но неподвижные клетки: годятся для пропущенного хода в паре,
    // если за ним последовал уверенный ответ.
    const weakSet = new Set(all.filter(s => stillOk(s) && changes[s] >= T));
    if (opts.trace) opts.trace.reasons.push('ready=' + ready.join(','));
    if (ready.length < 2) return null;
    const readySet = new Set(ready);
    const considered = ready.filter(s => !ignore.has(s) && !isHand(s));
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
    // Пятна изменений вокруг клеток хода должны целиком объясняться ходом (ходами):
    // иначе это рука, лежащая или зависшая над этими клетками.
    const blobLeft = squares => {
      const explained = new Set(squares);
      for (const q of squares) for (const o of (ctx.occ && ctx.occ[q]) || []) explained.add(o);
      const left = new Set();
      for (const q of squares) for (const b of blob(q)) if (!explained.has(b)) left.add(b);
      return Array.from(left);
    };
    // Лишние клетки рядом с ходом — это уже поставленная фигура соперника (он начал отвечать)?
    // Решаем по ИИ: там фигура цвета соперника, и туда есть легальный ответ.
    const pendingReply = (m1, cells) => {
      const opp = m1.color === 'w' ? 2 : 1;
      if (!cells.every(c => { const p = cls(c); return p && p[opp] >= 0.6; })) return false;
      // ответ начался после того, как взяли фигуру для этого хода
      const lifted = parts(m1).lifted;
      if (!cells.every(c => opts.onset[c] >= lifted - 100)) return false;
      if (!chess.move({ from: m1.from, to: m1.to, promotion: m1.promotion })) return false;
      const reach = new Set();
      for (const r of chess.moves({ verbose: true })) {
        reach.add(r.to);
        for (const o of (ctx.occ && ctx.occ[r.to]) || []) reach.add(o);
      }
      chess.undo();
      return cells.every(c => reach.has(c));
    };
    // ИИ уверенно видит на клетках хода не то, что должно быть после хода?
    const aiDisagrees = moves => {
      if (!opts.aiVeto) return false;
      let played = 0, bad = false;
      for (const m of moves) { if (chess.move({ from: m.from, to: m.to, promotion: m.promotion })) played++; }
      for (const m of moves) {
        for (const q of squaresOfMove(m)) {
          const p = cls(q);
          if (!p) continue;
          const piece = chess.get(q), exp = piece ? (piece.color === 'w' ? 1 : 2) : 0;
          let best = 0;
          for (let c = 1; c < 4; c++) if (p[c] > p[best]) best = c;
          if (best !== exp && best !== 3 && p[best] >= 0.9) bad = true;
        }
      }
      for (let i = 0; i < played; i++) chess.undo();
      return bad;
    };
    const minCarry = opts.minCarryMs != null ? opts.minCarryMs : 100;
    const trace = opts.trace && opts.trace.san;
    const why = (m, reason) => { if (trace === m.san) opts.trace.reasons.push(reason); };
    const parts = m => {
      const rank = m.color === 'w' ? '1' : '8';
      const froms = [m.from], dests = [m.to];
      if (m.flags.indexOf('k') >= 0) { froms.push('h' + rank); dests.push('f' + rank); }
      if (m.flags.indexOf('q') >= 0) { froms.push('a' + rank); dests.push('d' + rank); }
      return { froms, dests, lifted: Math.max(...froms.map(s => opts.onset[s])) };
    };
    // Все клетки хода готовы, и фигуру сначала подняли, потом поставили
    // (а не рука накрыла обе клетки разом).
    const ready1 = (m, weak) => {
      const sq = squaresOfMove(m);
      if (sq.some(isHand)) { why(m, 'hand-on-square'); return false; } // клетку хода закрывает рука
      if (!sq.every(s => (weak ? weakSet : readySet).has(s))) {
        why(m, 'not-ready ' + sq.map(s => s + ':' + Math.round(changes[s]) + '/' + Math.round(opts.stillMs[s])).join(' '));
        return false;
      }
      const p = parts(m);
      if (!p.dests.every(s => opts.lastMotion[s] >= p.lifted + minCarry)) { why(m, 'carry'); return false; }
      return true;
    };
    const pick = (cands, label) => {
      if (!cands.length) return null;
      cands.sort((a, b) => (better(a, b) ? -1 : 1));
      const best = cands[0], second = cands[1];
      // Неподвижные изменения вне хода: если их много — на доске лежит рука, ждём.
      if (best.noise > (opts.maxOther != null ? opts.maxOther : 6)) { why(best.moves[0], label + 'noise ' + best.noise); return null; }
      // Неоднозначно (два варианта объясняют почти одинаково) — пусть решит полная проверка.
      if (second && second.unexplained === best.unexplained && second.min >= best.min * 0.8 &&
          !isCastle(best)) { why(best.moves[0], label + 'ambiguous vs ' + second.moves.map(m => m.san).join(' ')); return null; }
      if (aiDisagrees(best.moves)) { why(best.moves[0], label + 'ai-disagrees'); return null; }
      return best.moves;
    };

    // Есть неподвижные изменения, начавшиеся раньше этого хода и им не объяснённые? Значит,
    // предыдущий ход ещё не записан (его закрыла рука) — этот ход пока не принимаем,
    // чтобы не перепутать порядок. Очень старые (> 4 с) изменения не мешают.
    const earlierPending = moves => {
      const explained = new Set();
      for (const m of moves) for (const q of squaresOfMove(m)) {
        explained.add(q);
        for (const o of (ctx.occ && ctx.occ[q]) || []) explained.add(o);
      }
      const lifted = Math.min(...moves.map(m => parts(m).lifted));
      return ctx.changed.some(c => !explained.has(c) && opts.onset[c] < lifted - 150 &&
        (opts.now == null || opts.onset[c] > opts.now - 4000));
    };
    const legal = chess.moves({ verbose: true });
    const firsts = uniqueMoves(legal).filter(m => !castlingPrefix(legal, m) && ready1(m));
    const singles = [];
    for (const m of firsts) {
      const left = blobLeft(squaresOfMove(m));
      if (left.length && !pendingReply(m, left)) { why(m, 'blob ' + left.join(',')); continue; }
      if (earlierPending([m])) { why(m, 'earlier'); continue; }
      singles.push(candidate([m], changes, ctx));
    }
    const one = pick(singles, '');
    if (one) return one;

    // Ход и мгновенный ответ соперника (первый ход может быть слабым — его пропустили).
    const pairs = [];
    const firstsWeak = uniqueMoves(legal).filter(m => !castlingPrefix(legal, m) && ready1(m, true));
    for (const m1 of firstsWeak) {
      if (!chess.move({ from: m1.from, to: m1.to, promotion: m1.promotion })) continue;
      const lifted1 = parts(m1).lifted, placed1 = Math.min(...parts(m1).dests.map(s => opts.onset[s]));
      for (const m2 of uniqueMoves(chess.moves({ verbose: true }))) {
        // Соперник берёт фигуру после того, как ход сделан (с небольшим запасом).
        if (!ready1(m2) || parts(m2).lifted < lifted1 || placed1 > parts(m2).lifted + 300) continue;
        const sq = new Set(squaresOfMove(m1).concat(squaresOfMove(m2)));
        if (blobLeft(Array.from(sq)).length || earlierPending([m1, m2])) continue;
        pairs.push(candidate([m1, m2], changes, ctx));
      }
      chess.undo();
    }
    return pick(pairs, 'pair ');
  }

  /**
   * «Тёмный уровень» клетки — яркость самых тёмных 10% точек. Чёрная фигура даёт почти чёрные
   * точки и на светлой, и на тёмной клетке; пустая тёмная клетка и светлая фигура (даже с тенью)
   * заметно светлее. Порог подбирается по проверенной позиции (calibrateDark).
   */
  function darkLevel(f, cell) {
    const n = f.per / 3, o = cell * f.per, d = f.data, lum = new Float32Array(n);
    for (let i = 0; i < n; i++) lum[i] = 0.299 * d[o + i * 3] + 0.587 * d[o + i * 3 + 1] + 0.114 * d[o + i * 3 + 2];
    lum.sort();
    return lum[Math.floor(n * 0.1)];
  }

  /** «Светлый уровень» клетки — яркость самых светлых 10% точек (светлая фигура на тёмной клетке). */
  function brightLevel(f, cell) {
    const n = f.per / 3, o = cell * f.per, d = f.data, lum = new Float32Array(n);
    for (let i = 0; i < n; i++) lum[i] = 0.299 * d[o + i * 3] + 0.587 * d[o + i * 3 + 1] + 0.114 * d[o + i * 3 + 2];
    lum.sort();
    return lum[Math.min(n - 1, Math.floor(n * 0.9))];
  }

  /**
   * Порог «на тёмной клетке светлая фигура». pieceAt(cell) → 'w' | 'b' | '' | 'x' (неизвестно),
   * darkCell(cell) — тёмная ли клетка доски. Возвращает {thr, gap} или null.
   */
  function calibrateBright(f, pieceAt, darkCell) {
    const white = [], other = [];
    for (let cell = 0; cell < 64; cell++) {
      if (!darkCell(cell)) continue;
      const p = pieceAt(cell);
      if (p === 'x') continue;
      (p === 'w' ? white : other).push(brightLevel(f, cell));
    }
    if (white.length < 3 || other.length < 3) return null;
    white.sort((a, b) => a - b); other.sort((a, b) => a - b);
    const loWhite = white[Math.floor(white.length * 0.2)], hiOther = other[Math.floor(other.length * 0.9)];
    const gap = loWhite - hiOther;
    if (gap < 15) return null;
    return { thr: (loWhite + hiOther) / 2, gap };
  }

  /**
   * Порог «на клетке чёрная фигура» по позиции, где известно, что где стоит.
   * pieceAt(cell) → 'b' | 'w' | '' . Возвращает {thr, gap} или null, если классы не разделяются.
   */
  function calibrateDark(f, pieceAt) {
    const black = [], other = [];
    for (let cell = 0; cell < 64; cell++) {
      const p = pieceAt(cell);
      if (p === 'x') continue; // неизвестно (клетка под рукой)
      (p === 'b' ? black : other).push(darkLevel(f, cell));
    }
    if (black.length < 3 || other.length < 3) return null;
    black.sort((a, b) => a - b); other.sort((a, b) => a - b);
    const hiBlack = black[Math.floor(black.length * 0.8)], loOther = other[Math.floor(other.length * 0.1)];
    const gap = loOther - hiBlack;
    if (gap < 12) return null;
    return { thr: (hiBlack + loOther) / 2, gap };
  }

  /**
   * Восстановление пропущенных ходов. Когда играют очень быстро и рука почти не уходит
   * с доски, отдельные ходы не успевают «замереть» — зато в короткие паузы видно, чем
   * доска отличается от последней проверенной позиции. Ищем цепочку до maxPlies ходов
   * от этой позиции, итог которой объясняет картину (сравниваем итоговые позиции,
   * а не каждый ход: фигура, побитая по пути, в итоге не видна).
   * chess — проверенная позиция (по итогам вызова не меняется).
   * opts: threshold, occ, maxPlies, maxNodes,
   *       active — Set клеток, которые менялись с момента проверки (ходы ищем только по ним),
   *       order — {клетка: когда на ней впервые что-то замерло} (для порядка ходов),
   *       events — {клетка: [моменты, когда она замирала в новом виде]} (точнее для порядка),
   *       recorded — SAN уже записанных ходов (при равенстве оставляем их),
   *       colorOf(square) → 'b' (видна чёрная фигура) | 'n' (чёрной нет) | null,
   *       mask — Set клеток, закрытых рукой (их не оцениваем),
   *       aiOf(square) — вероятности ИИ по клетке (сеть, обученная на этой партии) или null.
   * Возвращает {best, recorded} — оценки лучшей цепочки и записанной (или null).
   */
  function findSequence(chess, changes, opts) {
    const T = opts.threshold || 14;
    const maxPlies = opts.maxPlies != null ? opts.maxPlies : 6;
    const maxNodes = opts.maxNodes || 6000;
    const occ = opts.occ || {};
    const active = opts.active || new Set(SQUARES.filter(q => (changes[q] || 0) >= T * 0.7));
    const order = opts.order || {};
    const code = p => (p ? p.color + p.type : '');
    const basePos = {};
    for (const q of SQUARES) basePos[q] = code(chess.get(q));
    // Клетки под рукой (mask) не оцениваем: ни «изменилась», ни «не изменилась».
    const mask = opts.mask || new Set();
    const strong = SQUARES.filter(q => !mask.has(q) && (changes[q] || 0) >= T * 1.6);
    const changed = SQUARES.filter(q => !mask.has(q) && (changes[q] || 0) >= T);
    const recordedKey = (opts.recorded || []).join(' ');
    const events = opts.events || null;
    const aiOf = opts.aiOf || null; // вероятности ИИ по клетке [пусто, белая, чёрная, рука] или null
    const AI_SURE = 0.85;
    const timesOf = seq => {
      const touched = {}, out = [];
      for (const m of seq) {
        let t = null;
        if (events) {
          const ev = events[m.to], k = touched[m.to] || 0;
          if (ev && ev.length) t = ev[Math.min(k, ev.length - 1)];
        }
        if (t == null) { const a = order[m.to], b = order[m.from]; t = a != null ? a : b != null ? b : null; }
        out.push(t);
        for (const q of squaresOfMove(m)) touched[q] = (touched[q] || 0) + 1;
      }
      return out;
    };
    const occBy = {}; // клетка → с каких клеток на неё наклоняется фигура
    for (const o of Object.keys(occ)) for (const q of occ[o] || []) (occBy[q] = occBy[q] || []).push(o);

    const evaluate = seq => {
      const req = [], opt = [];
      for (const q of SQUARES) {
        const a = basePos[q], b = code(chess.get(q));
        if (a === b) continue;
        // сменился цвет/занятость — изменение обязано быть видно; та же сторона,
        // другая фигура (конь → король на g1) — может быть почти незаметно
        if (a[0] !== b[0]) req.push(q); else opt.push(q);
      }
      // Объяснены клетки итоговых изменений, клетки, куда фигуру поставили и она там осталась
      // (на d5 пешку побили и поставили другую — содержимое то же, а картинка изменилась),
      // и их «тени». Клетка, через которую фигура прошла и ушла, должна остаться как была.
      const covered = new Set(req.concat(opt));
      const placed = new Set();
      for (const m of seq) {
        for (const q of squaresOfMove(m)) placed.delete(q);
        placed.add(m.to);
        if (m.flags.indexOf('k') >= 0) placed.add('f' + m.to[1]);
        if (m.flags.indexOf('q') >= 0) placed.add('d' + m.to[1]);
      }
      for (const q of placed) covered.add(q);
      // «Тень» (наклон фигуры на соседнюю клетку) не может быть намного заметнее самой фигуры:
      // сильное изменение рядом — это другая фигура, а не тень.
      // Высокая фигура (слон, ферзь, король) сверху «лежит» изображением на соседней клетке
      // почти целиком, поэтому её тень может быть сильнее изменения на её собственной клетке.
      const HEIGHT = { p: 1.5, n: 2.5, r: 2.5, b: 4, q: 4, k: 4 };
      for (const q of Array.from(covered)) {
        const a = basePos[q], b = chess.get(q);
        const h = Math.max(a ? HEIGHT[a[1]] : 0, b ? HEIGHT[b.type] : 0, 1.5);
        const lim = Math.max(T * 3, (changes[q] || 0) * h);
        for (const o of occ[q] || []) if ((changes[o] || 0) <= lim) covered.add(o);
      }
      // Что видит ИИ (обученный на этой партии): совпадает ли его уверенный класс клетки с итогом цепочки.
      const aiClass = q => {
        const p = aiOf ? aiOf(q) : null;
        if (!p || p[3] >= 0.5) return -1;
        let c = 0;
        for (let k = 1; k < 3; k++) if (p[k] > p[c]) c = k;
        return p[c] >= AI_SURE ? c : -1;
      };
      const want = q => { const x = chess.get(q); return x ? (x.color === 'w' ? 1 : 2) : 0; };
      let missing = 0, weak = 0, min = Infinity;
      for (const q of req) {
        if (mask.has(q)) continue;
        const v = changes[q] || 0;
        if (v < T * 2 && aiClass(q) === want(q)) continue; // изменение слабое, но ИИ видит то, что нужно
        if (v < T) missing++; else if (v < T * 2) weak++;
        if (v < min) min = v;
      }
      let aiMis = 0;
      const aiMisAt = [];
      if (aiOf) {
        for (const q of SQUARES) {
          if (mask.has(q)) continue;
          const c = aiClass(q);
          if (c >= 0 && c !== want(q)) { aiMis++; aiMisAt.push(q); }
        }
      }
      // Порядок ходов: k-й раз, когда цепочка трогает клетку, должен совпасть с k-м разом,
      // когда клетка (без руки рядом) замерла в новом виде (opts.events); иначе — первое изменение.
      let inv = 0;
      const times = timesOf(seq);
      for (let i = 0; i < seq.length; i++) {
        for (let j = i + 1; j < seq.length; j++) {
          const a = times[i], b = times[j];
          if (a != null && b != null && a > b + 300) inv++;
        }
      }
      const touched = new Set();
      for (const m of seq) for (const q of squaresOfMove(m)) touched.add(q);
      let idle = 0;
      for (const q of Object.keys(order)) if (!touched.has(q) && !covered.has(q)) idle++;
      // Соседи клеток хода: высокая фигура наклоняется на соседнюю клетку (камера сверху —
      // наружу от центра кадра), рядом ложится тень. Умеренное изменение там — шум, а не
      // необъяснённый ход.
      const near = new Set();
      for (const q of covered) {
        const f = q.charCodeAt(0), r = +q[1];
        for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) near.add(String.fromCharCode(f + df) + (r + dr));
      }
      // Фигуру задели и она сдвинулась внутри клетки: изменение есть, но цвет на клетке тот,
      // что должен быть по позиции. Это не ход — считаем «сдвинутой» (дешевле необъяснённой).
      // (только для чёрных фигур: «не чёрная» не отличает светлую фигуру от пустой клетки)
      const sameColor = q => {
        const p = chess.get(q);
        if (!p || p.color !== 'b' || !opts.colorOf) return false;
        const c = opts.colorOf(q);
        return c === 'b' || (!!c && typeof c === 'object' && c.b === true);
      };
      // direct — сильные изменения, объяснённые самими ходами; объяснение «тенью» или наклоном
      // соседней фигуры слабее (indirect), как и клетка хода, закрытая рукой (unverified).
      const direct = new Set(req.concat(opt));
      for (const q of placed) direct.add(q);
      let unexplained = 0, bumped = 0, indirect = 0, unverified = 0;
      const unexplainedAt = [];
      for (const q of strong) {
        if (direct.has(q)) continue;
        if (covered.has(q) || (near.has(q) && changes[q] < T * 3)) { indirect++; continue; }
        if (sameColor(q) || aiClass(q) === want(q)) bumped++; else { unexplained++; unexplainedAt.push(q); }
      }
      for (const q of req) if (mask.has(q)) unverified++;
      const noise = changed.filter(q => !covered.has(q)).length;
      // Цвет: там, где по цепочке должна стоять чёрная фигура, она видна, и наоборот.
      let conflict = 0;
      const conflictAt = [];
      if (opts.colorOf) {
        for (const q of req) {
          // проверяем только клетки, куда фигура пришла: на опустевшую клетку часто «заходит»
          // соседняя фигура, и тёмные точки там ничего не значат
          const p = chess.get(q);
          if (!p) continue;
          const c = mask.has(q) ? null : opts.colorOf(q);
          if (!c) continue;
          const isBlack = p.color === 'b';
          const black = typeof c === 'string' ? (c === 'b' ? true : c === 'n' ? false : null) : c.b;
          // «Чёрное» на клетке может быть наклонившейся соседней чёрной фигурой (ферзь d8 над c8).
          const leanBlack = (occBy[q] || []).some(o => { const x = chess.get(o); return x && x.color === 'b'; });
          let bad = black != null && black !== isBlack && !(black && !isBlack && leanBlack);
          // Светлая фигура на тёмной клетке ярко видна: если по цепочке она там, а светлого нет — не то
          // (например, dxc5 вместо cxd4: клетки те же, но на c5 должна стоять белая пешка).
          if (!bad && typeof c === 'object' && c.w === false && p.color === 'w') bad = true;
          if (bad) { conflict++; conflictAt.push(q); }
        }
      }
      // Фигура ушла и вернулась на свою клетку — так обычно «объясняют» задетую фигуру. Редко бывает.
      let back = 0;
      for (let i = 0; i < seq.length; i++) {
        for (let j = i + 1; j < seq.length; j++) if (seq[j].from === seq[i].to && seq[j].to === seq[i].from) back++;
      }
      return {
        back,
        moves: seq.slice(), san: seq.map(m => m.san), plies: seq.length,
        req, opt, unexplained, unexplainedAt, bumped, indirect, unverified, missing, weak, noise, conflict, conflictAt, inv, idle, min,
        aiMis, aiMisAt,
        noiseAt: changed.filter(q => !covered.has(q)),
        // каждый лишний ход тоже «стоит»: шум не объясняем цепочкой выдуманных ходов
        cost: unexplained * 4 + missing * 3 + weak * 1.5 + conflict * 3 + noise + seq.length + indirect * 0.5 + back * 2 + aiMis * 2,
        fen: chess.fen().split(' ').slice(0, 4).join(' '),
        isRecorded: seq.map(m => m.san).join(' ') === recordedKey,
      };
    };
    const better = (a, b) => {
      if (!b) return true;
      if (a.cost !== b.cost) return a.cost < b.cost;
      if (a.plies !== b.plies) return a.plies < b.plies;
      if (a.inv !== b.inv) return a.inv < b.inv;
      if (a.idle !== b.idle) return a.idle < b.idle;
      if (a.isRecorded !== b.isRecorded) return a.isRecorded;
      return a.min > b.min;
    };

    const seenAt = q => (changes[q] || 0) >= T || (!mask.has(q) && ((changes[q] || 0) >= T * 0.7 || order[q] != null));
    let best = null, nodes = 0, budget = 0;
    const byFen = new Map(); // лучшая цепочка для каждой итоговой позиции — чтобы видеть неоднозначность
    const consider = c => {
      const o = byFen.get(c.fen);
      if (!o || better(c, o)) byFen.set(c.fen, c);
      if (better(c, best)) best = c;
    };
    const seq = [];
    // Одна и та же позиция, достигнутая другим порядком ходов, с тем же запасом глубины —
    // второй раз не раскрываем (оценка порядка у таких цепочек почти всегда та же).
    const seen = new Map();
    const dfs = depth => {
      const c = evaluate(seq);
      consider(c);
      if (depth <= 0 || nodes >= budget) return;
      const key = chess.fen().split(' ').slice(0, 2).join(' ');
      const was = seen.get(key);
      if (was && was.depth >= depth && was.inv <= c.inv) return;
      seen.set(key, { depth, inv: c.inv });
      const turn = chess.turn(), list = [];
      for (const q of active) {
        const p = chess.get(q);
        if (p && p.color === turn) for (const m of chess.moves({ square: q, verbose: true })) list.push(m);
      }
      // сначала ходы, клетки которых изменились сильнее всего
      const ev = m => (changes[m.from] || 0) + (changes[m.to] || 0);
      list.sort((a, b) => ev(b) - ev(a));
      for (const m of list) {
        if (!active.has(m.to)) continue;
        // ход целиком под рукой проверить нечем — хотя бы одна его клетка должна быть видна
        if (!seenAt(m.from) && !seenAt(m.to)) continue;
        // фигура той же стороны сразу возвращается назад — такую цепочку не рассматриваем
        const prev = seq[seq.length - 2];
        if (prev && prev.from === m.to && prev.to === m.from) continue;
        if (++nodes > budget) return;
        chess.move({ from: m.from, to: m.to, promotion: m.promotion });
        seq.push(m);
        dfs(depth - 1);
        seq.pop();
        chess.undo();
      }
    };
    // Сначала — продолжения записанного (обычно оно верно, просто не всё успели записать),
    // потом — без последних одного-двух записанных ходов, потом — с нуля.
    const recMoves = [];
    for (const san of opts.recorded || []) {
      const m = chess.move(san);
      if (!m) break;
      recMoves.push(m);
    }
    for (let i = 0; i < recMoves.length; i++) chess.undo();
    const L = recMoves.length;
    const play = list => { for (const m of list) chess.move({ from: m.from, to: m.to, promotion: m.promotion }); };
    const unplay = n => { for (let i = 0; i < n; i++) chess.undo(); };
    // Ходы-кандидаты из текущей позиции: по клеткам, которые менялись, и хотя бы одна клетка видна.
    const candidates = () => {
      const turn = chess.turn(), list = [];
      for (const q of active) {
        const p = chess.get(q);
        if (p && p.color === turn) for (const m of chess.moves({ square: q, verbose: true })) list.push(m);
      }
      const ev = m => (changes[m.from] || 0) + (changes[m.to] || 0);
      return list.filter(m => active.has(m.to) && (seenAt(m.from) || seenAt(m.to))).sort((a, b) => ev(b) - ev(a));
    };

    // 1) Продолжения записанного (обычно оно верно, просто не всё успели записать):
    //    перебор в глубину до 4 ходов после записанного и после него без последнего хода.
    for (const k of L ? [L, L - 1] : []) {
      play(recMoves.slice(0, k));
      for (let i = 0; i < k; i++) seq.push(recMoves[i]);
      budget = nodes + Math.round(maxNodes * (k === L ? 0.25 : 0.1));
      dfs(Math.min(4, maxPlies));
      for (let i = 0; i < k; i++) seq.pop();
      unplay(k);
    }

    // 2) Записанное с одним заменённым ходом (пешка c6 вместо коня на c6, Rg1 вместо рокировки):
    //    остальные записанные ходы сохраняем, если они ещё возможны.
    if (L) {
      const cap = nodes + Math.round(maxNodes * 0.2);
      for (let i = 0; i < L && nodes < cap; i++) {
        play(recMoves.slice(0, i));
        for (const alt of candidates()) {
          if (alt.from === recMoves[i].from && alt.to === recMoves[i].to) continue;
          if (++nodes > cap) break;
          chess.move({ from: alt.from, to: alt.to, promotion: alt.promotion });
          const line = recMoves.slice(0, i).concat([alt]);
          let n = i + 1;
          for (let j = i + 1; j < L; j++) {
            const m = chess.move({ from: recMoves[j].from, to: recMoves[j].to, promotion: recMoves[j].promotion });
            if (!m) break;
            line.push(m); n++;
          }
          const c = evaluate(line);
          consider(c);
          unplay(n - i);
        }
        unplay(i);
      }
    }

    // 3) С нуля — поиск лучом: на каждом шаге оставляем beam лучших цепочек
    //    (полный перебор на 5–6 ходов не успевается).
    {
      const B = opts.beam || 10;
      let beam = [[]];
      const cap = nodes + Math.round(maxNodes * 0.45);
      for (let d = 0; d < maxPlies && beam.length && nodes < cap; d++) {
        const next = new Map();
        for (const line of beam) {
          play(line);
          for (const m of candidates()) {
            const prev = line[line.length - 2];
            if (prev && prev.from === m.to && prev.to === m.from) continue;
            if (++nodes > cap) break;
            chess.move({ from: m.from, to: m.to, promotion: m.promotion });
            const nl = line.concat([m]);
            const c = evaluate(nl);
            consider(c);
            const old = next.get(c.fen);
            if (!old || better(c, old.c)) next.set(c.fen, { c, line: nl });
            chess.undo();
          }
          unplay(line.length);
        }
        beam = Array.from(next.values()).sort((a, b) => (better(a.c, b.c) ? -1 : 1)).slice(0, B).map(x => x.line);
      }
    }

    // Записанную цепочку оцениваем всегда (она может быть длиннее maxPlies).
    let rec = null;
    if (opts.recorded && recMoves.length === opts.recorded.length) {
      for (const m of recMoves) chess.move({ from: m.from, to: m.to, promotion: m.promotion });
      rec = evaluate(recMoves);
      for (let i = 0; i < recMoves.length; i++) chess.undo();
      consider(rec);
    }
    // Те же ходы, но в порядке, в каком менялись их клетки (лучом порядок теряется):
    // на каждом шаге берём самый ранний возможный ход нужного цвета.
    if (best && best.plies > 1 && best.inv > 0) {
      const left = best.moves.slice();
      const line = [];
      while (left.length) {
        const turn = chess.turn();
        const when = m => { const t = timesOf(line.concat([m])); const x = t[t.length - 1]; return x == null ? Infinity : x; };
        const cand = left.filter(m => m.color === turn).sort((a, b) => when(a) - when(b));
        let done = null;
        for (const m of cand) {
          const r = chess.move({ from: m.from, to: m.to, promotion: m.promotion });
          if (r) { done = m; line.push(r); break; }
        }
        if (!done) break;
        left.splice(left.indexOf(done), 1);
      }
      if (!left.length) consider(evaluate(line));
      unplay(line.length);
    }
    // Лучшая цепочка, ведущая к другой позиции (если она почти так же хороша — картина неоднозначна).
    let alt = null;
    for (const [fen, c] of byFen) if (fen !== best.fen && better(c, alt)) alt = c;
    // Для отладки: оценки заданных цепочек (opts.probe — массивы SAN).
    const probes = (opts.probe || []).map(line => {
      const played = [];
      for (const san of line) { const m = chess.move(san); if (!m) break; played.push(m); }
      const c = played.length === line.length ? evaluate(played) : null;
      for (let i = 0; i < played.length; i++) chess.undo();
      return c;
    });
    return { best, alt, recorded: rec, nodes, probes };
  }

  /* ---------- Детектор «рука над доской / доска успокоилась» ---------- */

  class MotionTracker {
    /**
     * opts.settleMs — сколько миллисекунд доска должна быть неподвижной после движения.
     * Время передаётся в push() снаружи, поэтому поведение не зависит от частоты кадров.
     * Порог движения у каждой клетки свой: он подстраивается под её обычный шум
     * (сжатие видео, дрожание текстуры), поэтому на реальной съёмке шум не считается рукой.
     */
    constructor(opts) {
      this.opts = Object.assign({
        settleMs: 700, minFrames: 2, keepFrames: 6,
        motionMin: 5, motionMax: 45, motionK: 2, noiseWindow: 120, noisePct: 0.1, skipDup: true,
      }, opts);
      this.reset();
    }

    reset() {
      this.prev = null;
      this.last = null;
      this.moving = false;
      this.stable = [];
      this.stableSince = 0;
      this.now = 0;
      this.lastMotion = 0;
      this.since = new Float64Array(64); // когда клетка двигалась последний раз
      const n = this.opts.noiseWindow;
      this.hist = new Float32Array(64 * n); // покадровые изменения клеток за последние n кадров
      this.histLen = 0;
      this.histPos = 0;
      this.frames = 0;
      this.cellThr = new Float32Array(64).fill(this.opts.motionMin);
      this.lastCells = new Float32Array(64);
    }

    /** Сколько мс клетка неподвижна. */
    cellStillMs(cell) {
      return this.now - this.since[cell];
    }

    threshold() {
      return median(this.cellThr);
    }

    updateThresholds() {
      const n = this.opts.noiseWindow, len = this.histLen;
      if (!len) return;
      const buf = new Float32Array(len), k = Math.floor(len * this.opts.noisePct);
      for (let c = 0; c < 64; c++) {
        for (let i = 0; i < len; i++) buf[i] = this.hist[c * n + i];
        buf.sort();
        const noise = buf[k];
        this.cellThr[c] = Math.min(this.opts.motionMax, Math.max(this.opts.motionMin, noise * this.opts.motionK + this.opts.motionMin));
      }
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
      // Движение — простая разница: относительная усиливает шум сжатия на тёмных клетках.
      const cells = cellDiff(feat, this.prev, 0.35, true);
      this.prev = feat;
      this.lastCells = cells;
      // Повтор того же кадра (видеофайл, браузер не успел получить новый) — для оценки шума
      // не считаем: иначе «шум» окажется нулевым и любое мерцание будет выглядеть движением.
      let dup = this.opts.skipDup;
      if (dup) for (let c = 0; c < 64; c++) if (cells[c] > 0.05) { dup = false; break; }
      const n = this.opts.noiseWindow;
      if (!dup) {
        for (let c = 0; c < 64; c++) this.hist[c * n + this.histPos] = cells[c];
        this.histPos = (this.histPos + 1) % n;
        this.histLen = Math.min(n, this.histLen + 1);
        if (this.frames++ % 5 === 0) this.updateThresholds();
      }
      let motion = 0, movingCells = 0;
      for (let c = 0; c < 64; c++) {
        if (cells[c] > this.cellThr[c]) {
          this.since[c] = t;
          movingCells++;
          motion = Math.max(motion, cells[c]);
        }
      }
      this.lastMotion = motion;
      const thr = this.threshold();
      if (movingCells) {
        this.moving = true;
        this.stable = [];
        return { motion, moving: true, settled: null, threshold: thr };
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
    computeHomography, applyH, orderQuad, isConvexQuad, cameraFromH,
    squareToCell, cellToSquare,
    samplePlan, sampleWithPlan, sampleBoard, averageFeatures, cellDiff, cellStats, diffOpts,
    cloneFeatures, copyCells, darkLevel, calibrateDark, brightLevel, calibrateBright,
    detectStartPosition, squareChanges, squaresOfMove, uniqueMoves, occlusionMap, findMove, findFastMove, scoreMoves, scoreSquares, findSequence,
    MotionTracker,
  };
}));
