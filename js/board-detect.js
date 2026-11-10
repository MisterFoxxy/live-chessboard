/*
 * BoardDetect — автоматический поиск шахматной доски на кадре.
 *
 * 1. Находим «крестики» — точки, где сходятся углы четырёх клеток (детектор ChESS).
 * 2. От самого сильного крестика наращиваем решётку: соседи вдоль двух направлений
 *    сетки, с учётом перспективы.
 * 3. По решётке строим гомографию «номер узла → кадр».
 * 4. Решётка внутренних узлов доски — 7×7; где именно в ней наша часть, определяем
 *    по начальной расстановке (BoardVision.detectStartPosition): ряды 1–2 и 7–8 заняты,
 *    3–6 пусты.
 *
 * Работает в браузере (window.BoardDetect) и в Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./board-vision.js'));
  else root.BoardDetect = factory(root.BoardVision);
}(typeof self !== 'undefined' ? self : this, function (BV) {
  'use strict';

  const WORK_W = 400;   // ширина, до которой уменьшаем кадр для поиска
  const RADIUS = 5;     // радиус кольца детектора крестиков (в пикселях уменьшенного кадра)

  /** Яркость кадра (RGBA) в уменьшенном размере, с лёгким размытием. */
  function grayscale(img) {
    const scale = Math.min(1, WORK_W / img.width);
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const g = new Float32Array(w * h);
    const step = 1 / scale;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // усредняем блок исходных пикселей
        const x0 = Math.floor(x * step), y0 = Math.floor(y * step);
        const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * step)));
        const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * step)));
        let s = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const i = (yy * img.width + xx) * 4;
            s += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
            n++;
          }
        }
        g[y * w + x] = s / n;
      }
    }
    // размытие 3×3
    const b = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += g[(y + dy) * w + x + dx];
        b[y * w + x] = s / 9;
      }
    }
    return { w, h, g: b, scale };
  }

  /** Отклик детектора крестиков ChESS (Bennett & Lasenby) и локальные максимумы. */
  function findCorners(G) {
    const { w, h, g } = G;
    const ring = [];
    for (let n = 0; n < 16; n++) {
      const a = 2 * Math.PI * n / 16;
      ring.push(Math.round(RADIUS * Math.cos(a)) + Math.round(RADIUS * Math.sin(a)) * w);
    }
    const R = new Float32Array(w * h);
    const I = new Float32Array(16);
    let rmax = 0;
    for (let y = RADIUS + 1; y < h - RADIUS - 1; y++) {
      for (let x = RADIUS + 1; x < w - RADIUS - 1; x++) {
        const c = y * w + x;
        let mean = 0;
        for (let n = 0; n < 16; n++) { I[n] = g[c + ring[n]]; mean += I[n]; }
        mean /= 16;
        let sr = 0, dr = 0;
        for (let n = 0; n < 4; n++) sr += Math.abs((I[n] + I[n + 8]) - (I[n + 4] + I[n + 12]));
        for (let n = 0; n < 8; n++) dr += Math.abs(I[n] - I[n + 8]);
        const local = (g[c] + g[c - 1] + g[c + 1] + g[c - w] + g[c + w]) / 5;
        const r = sr - dr - 16 * Math.abs(mean - local);
        if (r > 0) { R[c] = r; if (r > rmax) rmax = r; }
      }
    }
    const thr = rmax * 0.12, out = [], nms = 3;
    for (let y = nms; y < h - nms; y++) {
      for (let x = nms; x < w - nms; x++) {
        const c = y * w + x, r = R[c];
        if (r <= thr) continue;
        let isMax = true;
        for (let dy = -nms; dy <= nms && isMax; dy++) {
          for (let dx = -nms; dx <= nms; dx++) {
            if ((dx || dy) && R[c + dy * w + dx] > r) { isMax = false; break; }
          }
        }
        if (!isMax) continue;
        // уточнение до долей пикселя (центр масс отклика 3×3)
        let sx = 0, sy = 0, sw = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = R[c + dy * w + dx];
            sx += v * (x + dx); sy += v * (y + dy); sw += v;
          }
        }
        out.push({ x: sx / sw, y: sy / sw, r });
      }
    }
    out.sort((a, b) => b.r - a.r);
    return out.slice(0, 400);
  }

  /** Гомография по многим точкам (наименьшие квадраты). src/dst — массивы [x, y]. */
  function fitHomography(src, dst) {
    const n = src.length;
    if (n < 4) return null;
    // нормировка для устойчивости
    const norm = pts => {
      let mx = 0, my = 0;
      for (const p of pts) { mx += p[0]; my += p[1]; }
      mx /= pts.length; my /= pts.length;
      let d = 0;
      for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
      const s = (d / pts.length) || 1;
      return { mx, my, s };
    };
    const ns = norm(src), nd = norm(dst);
    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Atb = new Array(8).fill(0);
    for (let k = 0; k < n; k++) {
      const x = (src[k][0] - ns.mx) / ns.s, y = (src[k][1] - ns.my) / ns.s;
      const X = (dst[k][0] - nd.mx) / nd.s, Y = (dst[k][1] - nd.my) / nd.s;
      const rows = [[x, y, 1, 0, 0, 0, -x * X, -y * X, X], [0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]];
      for (const r of rows) {
        for (let i = 0; i < 8; i++) {
          Atb[i] += r[i] * r[8];
          for (let j = 0; j < 8; j++) AtA[i][j] += r[i] * r[j];
        }
      }
    }
    // решаем 8×8 методом Гаусса
    const M = AtA.map((row, i) => row.concat([Atb[i]]));
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        for (let c = col; c <= 8; c++) M[r][c] -= f * M[col][c];
      }
    }
    const h = M.map((row, i) => row[8] / row[i]);
    // H = Tdst⁻¹ · Hn · Tsrc
    const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    const Ts = [1 / ns.s, 0, -ns.mx / ns.s, 0, 1 / ns.s, -ns.my / ns.s, 0, 0, 1];
    const Tdi = [nd.s, 0, nd.mx, 0, nd.s, nd.my, 0, 0, 1];
    const mul = (A, B) => {
      const C = new Array(9).fill(0);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
      return C;
    };
    const H = mul(Tdi, mul(Hn, Ts));
    return H.map(v => v / H[8]);
  }

  function nearest(corners, x, y, maxD, used) {
    let best = -1, bd = maxD;
    for (let i = 0; i < corners.length; i++) {
      if (used && used.has(i)) continue;
      const d = Math.hypot(corners[i].x - x, corners[i].y - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /**
   * Шаг вдоль линии доски идёт по границе клеток: по разные стороны от середины шага —
   * тёмная и светлая клетки. Шаг по диагонали проходит через середину одной клетки.
   */
  function edgeContrast(G, s, v) {
    const len = Math.hypot(v[0], v[1]);
    const nx = -v[1] / len, ny = v[0] / len, off = 0.25 * len;
    const mx = s.x + v[0] / 2, my = s.y + v[1] / 2;
    const at = (x, y) => {
      const xi = Math.min(G.w - 1, Math.max(0, Math.round(x))), yi = Math.min(G.h - 1, Math.max(0, Math.round(y)));
      return G.g[yi * G.w + xi];
    };
    return Math.abs(at(mx + nx * off, my + ny * off) - at(mx - nx * off, my - ny * off));
  }

  /** Наращивает решётку от крестика seed. Возвращает {nodes: Map("i,j" → индекс), H} или null. */
  function growGrid(corners, seed, G) {
    const s = corners[seed];
    let nb = corners.map((c, i) => ({ i, d: Math.hypot(c.x - s.x, c.y - s.y) }))
      .filter(o => o.i !== seed && o.d > 4).sort((a, b) => a.d - b.d).slice(0, 12);
    // оставляем только шаги вдоль линий доски (по границе тёмной и светлой клеток)
    for (const o of nb) o.c = edgeContrast(G, s, [corners[o.i].x - s.x, corners[o.i].y - s.y]);
    const cmax = Math.max(0, ...nb.map(o => o.c));
    nb = nb.filter(o => o.c >= 0.45 * cmax);
    let best = null;
    for (let p = 0; p < nb.length; p++) {
      for (let q = p + 1; q < nb.length; q++) {
        const a = [corners[nb[p].i].x - s.x, corners[nb[p].i].y - s.y];
        const b = [corners[nb[q].i].x - s.x, corners[nb[q].i].y - s.y];
        const la = Math.hypot(...a), lb = Math.hypot(...b);
        if (la / lb > 1.8 || lb / la > 1.8) continue;
        const cos = (a[0] * b[0] + a[1] * b[1]) / (la * lb);
        if (Math.abs(cos) > 0.6) continue;
        const tol = 0.3 * Math.min(la, lb);
        let sup = 0;
        for (const [u, v] of [[-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          if (nearest(corners, s.x + u * a[0] + v * b[0], s.y + u * a[1] + v * b[1], tol) >= 0) sup++;
        }
        const key = sup * 1000 - (la + lb);
        if (sup >= 3 && (!best || key > best.key)) best = { key, a, b };
      }
    }
    if (!best) return null;

    // Начинаем с 3×3 вокруг крестика, дальше растим кольцами: каждое новое кольцо
    // предсказываем по сетке, подогнанной по ВСЕМ уже найденным узлам.
    const nodes = new Map([['0,0', seed]]);
    const taken = new Set([seed]);
    const a = best.a, b = best.b;
    for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const idx = nearest(corners, s.x + u * a[0] + v * b[0], s.y + u * a[1] + v * b[1], 0.3 * Math.min(Math.hypot(...a), Math.hypot(...b)), taken);
      if (idx >= 0) { nodes.set(u + ',' + v, idx); taken.add(idx); }
    }
    if (nodes.size < 5) return null;
    const fitNodes = () => {
      const src = [], dst = [];
      for (const [k, idx] of nodes) { const [i, j] = k.split(',').map(Number); src.push([i, j]); dst.push([corners[idx].x, corners[idx].y]); }
      return fitHomography(src, dst);
    };
    const extent = () => {
      let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
      for (const k of nodes.keys()) {
        const [i, j] = k.split(',').map(Number);
        i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      }
      return [i0, i1, j0, j1];
    };
    let H = fitNodes();
    if (!H) return null;
    for (let ring = 0; ring < 12; ring++) {
      const [i0, i1, j0, j1] = extent();
      let added = 0;
      for (let i = i0 - 1; i <= i1 + 1; i++) {
        for (let j = j0 - 1; j <= j1 + 1; j++) {
          const k = i + ',' + j;
          if (nodes.has(k)) continue;
          if (Math.max(i1, i) - Math.min(i0, i) > 8 || Math.max(j1, j) - Math.min(j0, j) > 8) continue;
          const [x, y] = BV.applyH(H, i, j), [x2, y2] = BV.applyH(H, i + 1, j), [x3, y3] = BV.applyH(H, i, j + 1);
          const step = Math.min(Math.hypot(x2 - x, y2 - y), Math.hypot(x3 - x, y3 - y));
          if (!isFinite(step) || step < 3) continue;
          const idx = nearest(corners, x, y, 0.22 * step, taken);
          if (idx < 0) continue;
          nodes.set(k, idx); taken.add(idx); added++;
        }
      }
      if (!added) break;
      H = fitNodes();
      if (!H) return null;
    }
    if (nodes.size < 10) return null;
    let [imin, imax, jmin, jmax] = extent();

    // Устойчивая подгонка: узлы, далёкие от сетки (контуры фигур), отбрасываем и пересчитываем.
    for (let iter = 0; iter < 4; iter++) {
      const res = [];
      for (const [k, idx] of nodes) {
        const [i, j] = k.split(',').map(Number);
        const [x, y] = BV.applyH(H, i, j);
        res.push([k, Math.hypot(x - corners[idx].x, y - corners[idx].y)]);
      }
      const sorted = res.map(r => r[1]).sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      const thr = Math.max(1.2, med * 2.5);
      let removed = 0;
      for (const [k, r] of res) if (r > thr) { nodes.delete(k); removed++; }
      if (nodes.size < 10) return null;
      const src = [], dst = [];
      for (const [k, idx] of nodes) { const [i, j] = k.split(',').map(Number); src.push([i, j]); dst.push([corners[idx].x, corners[idx].y]); }
      H = fitHomography(src, dst);
      if (!H) return null;
      if (!removed) break;
    }
    imin = Infinity; imax = -Infinity; jmin = Infinity; jmax = -Infinity;
    for (const k of nodes.keys()) {
      const [i, j] = k.split(',').map(Number);
      imin = Math.min(imin, i); imax = Math.max(imax, i); jmin = Math.min(jmin, j); jmax = Math.max(jmax, j);
    }
    return { nodes, H, imin, imax, jmin, jmax };
  }

  /** Яркость точки исходного кадра (билинейно). */
  function lumAt(img, x, y) {
    const w = img.width, h = img.height, d = img.data;
    if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
    if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const L = (xx, yy) => { const i = (yy * w + xx) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
    return L(x0, y0) * (1 - fx) * (1 - fy) + L(x0 + 1, y0) * fx * (1 - fy) + L(x0, y0 + 1) * (1 - fx) * fy + L(x0 + 1, y0 + 1) * fx * fy;
  }

  /**
   * Насколько клетки под четырёхугольником чередуются «светлая/тёмная» в каждом ряду и столбце.
   * Если сетка сдвинута на ряд, один ряд попадает на однотонную рамку доски — оценка падает.
   */
  function checkerScore(img, quad) {
    const H = BV.computeHomography(BV.UNIT, quad);
    if (!H) return 0;
    const lum = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        let s = 0;
        for (const [du, dv] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.5]]) {
          const p = BV.applyH(H, (c + du) / 8, (r + dv) / 8);
          s += lumAt(img, p[0], p[1]);
        }
        lum.push(s / 5);
      }
    }
    // по каждому ряду и столбцу — медиана перепадов между соседями (фигуры дают выбросы)
    const med = a => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
    let total = 0, minLine = Infinity;
    for (let r = 0; r < 8; r++) {
      const d = [];
      for (let c = 0; c < 7; c++) d.push(Math.abs(lum[r * 8 + c] - lum[r * 8 + c + 1]));
      const m = med(d); total += m; minLine = Math.min(minLine, m);
    }
    for (let c = 0; c < 8; c++) {
      const d = [];
      for (let r = 0; r < 7; r++) d.push(Math.abs(lum[r * 8 + c] - lum[(r + 1) * 8 + c]));
      const m = med(d); total += m; minLine = Math.min(minLine, m);
    }
    return total / 16 + minLine;
  }

  /**
   * Точная подгонка углов: границы между соседними пустыми клетками (в начальной позиции —
   * ряды 3–6) должны быть максимально контрастными.
   */
  function refine(img, quad, k) {
    const emptyCells = [];
    for (const sq of BV.SQUARES) if (+sq[1] >= 3 && +sq[1] <= 6) emptyCells.push(BV.squareToCell(sq, k));
    const empty = new Set(emptyCells);
    const pairs = [];
    for (const cell of emptyCells) {
      const r = cell >> 3, c = cell & 7;
      if (c < 7 && empty.has(cell + 1)) pairs.push([r, c, 'v']);
      if (r < 7 && empty.has(cell + 8)) pairs.push([r, c, 'h']);
    }
    const d = 0.15, offs = [0.25, 0.4, 0.6, 0.75];
    const score = q => {
      const H = BV.computeHomography(BV.UNIT, q);
      if (!H) return -1;
      let s = 0;
      for (const [r, c, t] of pairs) {
        for (const o of offs) {
          const [u1, v1, u2, v2] = t === 'v'
            ? [(c + 1 - d) / 8, (r + o) / 8, (c + 1 + d) / 8, (r + o) / 8]
            : [(c + o) / 8, (r + 1 - d) / 8, (c + o) / 8, (r + 1 + d) / 8];
          const a = BV.applyH(H, u1, v1), b = BV.applyH(H, u2, v2);
          s += Math.abs(lumAt(img, a[0], a[1]) - lumAt(img, b[0], b[1]));
        }
      }
      return s;
    };
    const q = quad.map(p => p.slice());
    let best = score(q);
    const size = Math.max(img.width, img.height);
    for (const step of [size / 160, size / 320, size / 640, size / 1280]) {
      let improved = true, guard = 0;
      while (improved && guard++ < 20) {
        improved = false;
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 2; j++) {
            for (const sgn of [1, -1]) {
              q[i][j] += sgn * step;
              const sc = score(q);
              if (sc > best + 1e-6) { best = sc; improved = true; } else q[i][j] -= sgn * step;
            }
          }
        }
      }
    }
    return q;
  }

  /**
   * Ищет доску в начальной позиции. img — {data (RGBA), width, height}.
   * Возвращает {corners: [[x,y]×4] в долях кадра, k, recognized, strength, nodes} или null.
   */
  function detect(img, opts) {
    opts = opts || {};
    const G = grayscale(img);
    const corners = findCorners(G);
    if (corners.length < 12) return null;
    let grid = null;
    const seeds = Math.min(corners.length, opts.seeds || 25);
    for (let sidx = 0; sidx < seeds; sidx++) {
      const g = growGrid(corners, sidx, G);
      if (g && (!grid || g.nodes.size > grid.nodes.size)) grid = g;
      if (grid && grid.nodes.size >= 30) break;
    }
    if (!grid) return null;
    if (opts.debug) {
      const pts = [];
      for (const [k, idx] of grid.nodes) pts.push([k, corners[idx].x / G.scale, corners[idx].y / G.scale]);
      opts.debug.push({ range: [grid.imin, grid.imax, grid.jmin, grid.jmax], pts, H: grid.H, scale: G.scale });
    }

    // где наша часть решётки внутри доски: внутренние узлы доски — индексы 1..7 от угла
    let best = null;
    const toFull = (x, y) => [x / G.scale, y / G.scale];
    // перебираем с запасом: среди найденных узлов могут быть лишние (фигуры, рамка)
    for (let I0 = grid.imax - 9; I0 <= grid.imin + 1; I0++) {
      for (let J0 = grid.jmax - 9; J0 <= grid.jmin + 1; J0++) {
        const quad = [[I0, J0], [I0 + 8, J0], [I0 + 8, J0 + 8], [I0, J0 + 8]].map(([i, j]) => toFull(...BV.applyH(grid.H, i, j)));
        if (quad.some(p => !isFinite(p[0]) || !isFinite(p[1]))) continue;
        const inFrame = quad.every(p => p[0] > -0.05 * img.width && p[0] < 1.05 * img.width && p[1] > -0.05 * img.height && p[1] < 1.05 * img.height);
        if (!inFrame) continue;
        const ordered = BV.orderQuad(quad);
        if (!BV.isConvexQuad(ordered)) continue;
        const Hb = BV.computeHomography(BV.UNIT, ordered);
        if (!Hb) continue;
        const r = BV.detectStartPosition(BV.sampleBoard(img, Hb, { samples: 6, margin: 0.15 }));
        // главное — чтобы все 8 рядов и столбцов были клетками доски (а не рамкой)
        // Сначала — узнаётся ли начальная расстановка и насколько уверенно (это однозначно
        // задаёт и сдвиг, и чётность клеток); «шахматность» рядов — при равенстве.
        const score = (r.recognized ? 1000 : 0) + r.strength * 100 + checkerScore(img, ordered) * 0.1;
        if (opts.debug) opts.debug.push({ I0, J0, checker: +checkerScore(img, ordered).toFixed(1), rec: r.recognized, strength: +r.strength.toFixed(2), k: r.k });
        if (!best || score > best.score) best = { score, quad: ordered, r };
      }
    }
    if (!best) return null;
    if (best.r.recognized && opts.refine === true) {
      best.quad = refine(img, best.quad, best.r.k);
      const Hb = BV.computeHomography(BV.UNIT, best.quad);
      if (Hb) best.r = BV.detectStartPosition(BV.sampleBoard(img, Hb, { samples: 6, margin: 0.15 }));
    }
    return {
      corners: best.quad.map(([x, y]) => [x / img.width, y / img.height]),
      k: best.r.k,
      recognized: best.r.recognized,
      strength: best.r.strength,
      nodes: grid.nodes.size,
    };
  }

  return { detect, findCorners, grayscale, fitHomography };
}));
