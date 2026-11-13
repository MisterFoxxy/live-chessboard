/*
 * BoardNet — свёрточная нейросеть, которая по снимку доски говорит, что стоит на каждой клетке:
 * пусто, белая фигура или чёрная.
 *
 * Сеть обучена заранее на тысячах размеченных снимков настоящих партий (разные доски, фигуры,
 * свет, руки в кадре) и не зависит от того, как выглядела доска в начале записи. Поэтому
 * смена экспозиции, тень или блик ей мешают гораздо меньше, чем сравнению с эталонным кадром.
 *
 * Четвёртый класс — «рука»: клетку закрывает рука или рукав, что под ней — не видно.
 *
 * Вход: доска, выпрямленная по 4 углам, 16 пикселей на клетку плюс поле в одну клетку вокруг
 * (160×160). Каждый цветовой канал нормируется по самой доске. Выход: для каждой клетки сетки
 * (строка r, столбец c после выпрямления, как в BoardVision) три вероятности.
 *
 * Работает в браузере (window.BoardNet) и в Node (module.exports) для тестов.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardNet = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMPTY = 0, WHITE = 1, BLACK = 2, HAND = 3;

  /** Разбор файла весов (формат BNET, см. tools/net/export.py). */
  function parse(buf) {
    const u8 = new Uint8Array(buf);
    if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'BNET') throw new Error('не файл BoardNet');
    const len = new DataView(buf).getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + len)));
    const start = 8 + len + ((4 - ((8 + len) % 4)) % 4);
    const w = new Float32Array(buf.slice(start));
    return { meta, w };
  }

  function Net(buf) {
    const { meta, w } = parse(buf);
    this.raw = buf;
    this.meta = meta;
    this.layers = meta.layers.map(l => l.type === 'conv'
      ? Object.assign({}, l, { W: w.subarray(l.w, l.w + l.out * l.in * l.k * l.k), B: w.subarray(l.b, l.b + l.out) })
      : l);
    this.size = meta.input;
    this.sq = meta.square;
    this.margin = meta.margin;
    this.classes = meta.classes.length;
  }

  /**
   * Выпрямленная доска для сети. img — {data, width, height} (RGBA), H — гомография
   * «единичный квадрат доски → пиксели кадра» (массив из 9 чисел, как BoardVision.computeHomography).
   * Возвращает Float32Array 3×N×N (каналы подряд), уже нормированный.
   */
  Net.prototype.rectify = function (img, H, out) {
    const N = this.size, SQ = this.sq, M = this.margin / SQ;
    const plane = N * N;
    const x = out || new Float32Array(3 * plane);
    const d = img.data, iw = img.width, ih = img.height;
    // сколько пикселей кадра приходится на клетку — столько подвыборок берём на пиксель входа
    const p = (u, v) => { const ww = H[6] * u + H[7] * v + H[8]; return [(H[0] * u + H[1] * v + H[2]) / ww, (H[3] * u + H[4] * v + H[5]) / ww]; };
    const c0 = p(0, 0), c1 = p(1, 0), c2 = p(1, 1), c3 = p(0, 1);
    const area = Math.abs((c0[0] * c1[1] - c1[0] * c0[1]) + (c1[0] * c2[1] - c2[0] * c1[1]) + (c2[0] * c3[1] - c3[0] * c2[1]) + (c3[0] * c0[1] - c0[0] * c3[1])) / 2;
    const perSq = Math.sqrt(area) / 8;
    const n = Math.max(1, Math.min(4, Math.ceil(perSq / SQ)));
    const inv = 1 / (n * n * 255);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let r = 0, g = 0, b = 0;
        for (let a = 0; a < n; a++) {
          const v = ((j + (a + 0.5) / n) / SQ - M) / 8;
          for (let e = 0; e < n; e++) {
            const u = ((i + (e + 0.5) / n) / SQ - M) / 8;
            const ww = H[6] * u + H[7] * v + H[8];
            let fx = (H[0] * u + H[1] * v + H[2]) / ww - 0.5, fy = (H[3] * u + H[4] * v + H[5]) / ww - 0.5;
            if (fx < 0) fx = 0; else if (fx > iw - 1.001) fx = iw - 1.001;
            if (fy < 0) fy = 0; else if (fy > ih - 1.001) fy = ih - 1.001;
            const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
            const o = (y0 * iw + x0) * 4, o2 = o + iw * 4;
            const w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay), w10 = (1 - ax) * ay, w11 = ax * ay;
            r += d[o] * w00 + d[o + 4] * w01 + d[o2] * w10 + d[o2 + 4] * w11;
            g += d[o + 1] * w00 + d[o + 5] * w01 + d[o2 + 1] * w10 + d[o2 + 5] * w11;
            b += d[o + 2] * w00 + d[o + 6] * w01 + d[o2 + 2] * w10 + d[o2 + 6] * w11;
          }
        }
        const k = j * N + i;
        x[k] = Math.round(r * inv * 255) / 255; x[plane + k] = Math.round(g * inv * 255) / 255; x[2 * plane + k] = Math.round(b * inv * 255) / 255;
      }
    }
    normalize(x, N, this.margin);
    return x;
  };

  /** Каждый канал: минус среднее и делить на разброс — по самой доске (без поля вокруг). */
  function normalize(x, N, m) {
    const plane = N * N, cnt = (N - 2 * m) * (N - 2 * m);
    for (let c = 0; c < 3; c++) {
      const o = c * plane;
      let s = 0;
      for (let j = m; j < N - m; j++) for (let i = m; i < N - m; i++) s += x[o + j * N + i];
      const mean = s / cnt;
      let ss = 0;
      for (let j = m; j < N - m; j++) for (let i = m; i < N - m; i++) { const t = x[o + j * N + i] - mean; ss += t * t; }
      const k = 1 / (Math.sqrt(ss / (cnt - 1)) + 0.02);
      for (let i = 0; i < plane; i++) x[o + i] = (x[o + i] - mean) * k;
    }
  }

  // Слои считаем в буферах с рамкой из нулей в 1 пиксель: свёртка 3×3 не проверяет края.
  function pad(x, C, S) {
    const P = S + 2, out = new Float32Array(C * P * P);
    for (let c = 0; c < C; c++) for (let y = 0; y < S; y++) out.set(x.subarray(c * S * S + y * S, c * S * S + (y + 1) * S), c * P * P + (y + 1) * P + 1);
    return out;
  }

  /*
   * Свёртка 3×3 (или 1×1) по буферу с нулевой рамкой. Считаем сразу 4 выходных канала,
   * сумму держим в переменных: каждое входное значение читается один раз на 4 канала,
   * а выход записывается один раз (на телефоне это в 2–3 раза быстрее).
   */
  function packWeights(l) {
    if (l.packed) return l.packed;
    const C = l.in, O = l.out, k = l.k, kk = k * k, G = Math.ceil(O / 4);
    const pw = new Float32Array(G * C * kk * 4), pb = new Float32Array(G * 4);
    for (let o = 0; o < O; o++) {
      const g = o >> 2, j = o & 3;
      pb[g * 4 + j] = l.B[o];
      for (let c = 0; c < C; c++) for (let t = 0; t < kk; t++) pw[((g * C + c) * kk + t) * 4 + j] = l.W[(o * C + c) * kk + t];
    }
    l.packed = { pw, pb, G, kk };
    return l.packed;
  }

  function conv(inp, l, S) {
    const P = S + 2, plane = P * P, C = l.in, O = l.out, k = l.k;
    const { pw, pb, G, kk } = packWeights(l);
    const out = new Float32Array(O * plane);
    const offs = new Int32Array(kk);
    for (let t = 0; t < kk; t++) offs[t] = k === 3 ? ((t / 3 | 0) - 1) * P + (t % 3 - 1) : 0;
    const relu = l.relu;
    for (let g = 0; g < G; g++) {
      const n = Math.min(4, O - g * 4), ob = g * 4 * plane;
      const b0 = pb[g * 4], b1 = pb[g * 4 + 1], b2 = pb[g * 4 + 2], b3 = pb[g * 4 + 3];
      const wg = g * C * kk * 4;
      for (let y = 1; y <= S; y++) {
        for (let x = 1; x <= S; x++) {
          const pix = y * P + x;
          let a0 = b0, a1 = b1, a2 = b2, a3 = b3;
          let w = wg;
          for (let c = 0; c < C; c++) {
            const base = c * plane + pix;
            for (let t = 0; t < kk; t++, w += 4) {
              const v = inp[base + offs[t]];
              a0 += pw[w] * v; a1 += pw[w + 1] * v; a2 += pw[w + 2] * v; a3 += pw[w + 3] * v;
            }
          }
          if (relu) { if (a0 < 0) a0 = 0; if (a1 < 0) a1 = 0; if (a2 < 0) a2 = 0; if (a3 < 0) a3 = 0; }
          out[ob + pix] = a0;
          if (n > 1) out[ob + plane + pix] = a1;
          if (n > 2) out[ob + 2 * plane + pix] = a2;
          if (n > 3) out[ob + 3 * plane + pix] = a3;
        }
      }
    }
    return out;
  }

  function pool(inp, C, S) {
    const P = S + 2, h = S >> 1, Q = h + 2;
    const out = new Float32Array(C * Q * Q);
    for (let c = 0; c < C; c++) {
      const ib = c * P * P, ob = c * Q * Q;
      for (let y = 0; y < h; y++) {
        const r0 = ib + (2 * y + 1) * P + 1, r1 = r0 + P, oi = ob + (y + 1) * Q + 1;
        for (let x = 0; x < h; x++) {
          const a = inp[r0 + 2 * x], b = inp[r0 + 2 * x + 1], cc = inp[r1 + 2 * x], d = inp[r1 + 2 * x + 1];
          out[oi + x] = Math.max(Math.max(a, b), Math.max(cc, d));
        }
      }
    }
    return out;
  }

  /**
   * Вероятности для 64 клеток: Float32Array(64×K), клетка r*8+c, порядок [пусто, белая, чёрная, рука]
   * (K = this.classes: 3 или 4).
   * x — результат rectify.
   */
  Net.prototype.predict = function (x) {
    if (!this.noWasm && this.initWasm()) return this.predictWasm(x);
    return this.predictJs(x);
  };

  Net.prototype.predictJs = function (x) {
    let S = this.size, C = 3;
    let a = pad(x, C, S);
    for (const l of this.layers) {
      if (l.type === 'pool') { a = pool(a, C, S); S >>= 1; } else { a = conv(a, l, S); C = l.out; }
    }
    return softmaxCells(a, C, S);
  };

  /** Выход S×S (поле в одну клетку вокруг доски) → вероятности по клеткам 1..8. */
  function softmaxCells(a, K, S) {
    const P = S + 2, plane = P * P, res = new Float32Array(64 * K), z = new Float64Array(K);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const k = (r + 2) * P + (c + 2);
        let m = -Infinity, s = 0;
        for (let j = 0; j < K; j++) { z[j] = a[j * plane + k]; if (z[j] > m) m = z[j]; }
        for (let j = 0; j < K; j++) { z[j] = Math.exp(z[j] - m); s += z[j]; }
        const o = (r * 8 + c) * K;
        for (let j = 0; j < K; j++) res[o + j] = z[j] / s;
      }
    }
    return res;
  }

  /*
   * Быстрый путь: те же свёртки в WebAssembly с векторными инструкциями (SIMD), в 3–4 раза быстрее
   * обычного JavaScript. Модуль (tools/wasm/boardnet.c) встроен сюда. Если браузер не умеет SIMD,
   * считаем на JavaScript.
   */
  const WASM_B64 = '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';
  let wasmModule = null, wasmTried = false;
  function getWasm() {
    if (wasmTried) return wasmModule;
    wasmTried = true;
    try {
      if (typeof WebAssembly !== 'object') return null;
      const bin = typeof atob === 'function' ? Uint8Array.from(atob(WASM_B64), c => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(WASM_B64, 'base64'));
      wasmModule = new WebAssembly.Module(bin);
    } catch (e) { wasmModule = null; }
    return wasmModule;
  }

  Net.prototype.initWasm = function () {
    if (this.wasm !== undefined) return this.wasm;
    this.wasm = null;
    const mod = getWasm();
    if (!mod) return null;
    try {
      // размеры буферов: самый большой слой (с рамкой) и вход
      let S = this.size, C = 3, maxBuf = 3 * (S + 2) * (S + 2), wTotal = 0;
      for (const l of this.layers) {
        if (l.type === 'pool') { S >>= 1; continue; }
        maxBuf = Math.max(maxBuf, l.out * (S + 2) * (S + 2));
        wTotal += Math.ceil(l.out / 4) * (l.in * l.k * l.k * 4 + 4);
        C = l.out;
      }
      const floats = 2 * maxBuf + wTotal + 64;
      const memory = new WebAssembly.Memory({ initial: Math.ceil((floats * 4 + 262144) / 65536) });
      const inst = new WebAssembly.Instance(mod, { env: { memory } });
      const heap = inst.exports.__heap_base.value;
      const f = new Float32Array(memory.buffer);
      let off = Math.ceil(heap / 16) * 4; // в числах float, кратно 16 байтам
      const alloc = n => { const at = off; off += Math.ceil(n / 4) * 4; return at; };
      const layers = this.layers.map(l => {
        if (l.type === 'pool') return l;
        const { pw, pb } = packWeights(l);
        const w = alloc(pw.length), b = alloc(pb.length);
        f.set(pw, w); f.set(pb, b);
        return Object.assign({}, l, { pw: w, pb: b });
      });
      this.wasm = { ex: inst.exports, f, layers, A: alloc(maxBuf), B: alloc(maxBuf) };
    } catch (e) { this.wasm = null; }
    return this.wasm;
  };

  Net.prototype.predictWasm = function (x) {
    const W = this.wasm, f = W.f, ex = W.ex;
    let S = this.size, C = 3, P = S + 2, cur = W.A, nxt = W.B;
    f.fill(0, cur, cur + 3 * P * P);
    for (let c = 0; c < 3; c++) for (let y = 0; y < S; y++) f.set(x.subarray(c * S * S + y * S, c * S * S + (y + 1) * S), cur + c * P * P + (y + 1) * P + 1);
    for (const l of W.layers) {
      if (l.type === 'pool') { ex.pool(cur * 4, C, S, nxt * 4); S >>= 1; }
      else { ex.conv(cur * 4, l.in, S, l.pw * 4, l.pb * 4, nxt * 4, l.out, l.k, l.relu ? 1 : 0); C = l.out; }
      const t = cur; cur = nxt; nxt = t;
    }
    P = S + 2;
    return softmaxCells(f.subarray(cur, cur + C * P * P), C, S);
  };

  /**
   * Сеть-классификатор (js/piece-net.js): вход size×size, карта на выходе 1×1 → вероятности классов.
   * x — Float32Array 3×size×size, уже нормированный.
   */
  Net.prototype.classify = function (x) {
    let S = this.size, C = 3, a;
    if (!this.noWasm && this.initWasm()) {
      const W = this.wasm, f = W.f, ex = W.ex;
      let P = S + 2, cur = W.A, nxt = W.B;
      f.fill(0, cur, cur + 3 * P * P);
      for (let c = 0; c < 3; c++) for (let y = 0; y < S; y++) f.set(x.subarray(c * S * S + y * S, c * S * S + (y + 1) * S), cur + c * P * P + (y + 1) * P + 1);
      for (const l of W.layers) {
        if (l.type === 'pool') { ex.pool(cur * 4, C, S, nxt * 4); S >>= 1; }
        else { ex.conv(cur * 4, l.in, S, l.pw * 4, l.pb * 4, nxt * 4, l.out, l.k, l.relu ? 1 : 0); C = l.out; }
        const t = cur; cur = nxt; nxt = t;
      }
      a = f.subarray(cur, cur + C * (S + 2) * (S + 2));
    } else {
      a = pad(x, C, S);
      for (const l of this.layers) {
        if (l.type === 'pool') { a = pool(a, C, S); S >>= 1; } else { a = conv(a, l, S); C = l.out; }
      }
    }
    if (S !== 1) throw new Error('classify: на выходе не 1×1');
    const res = new Float32Array(C);
    let m = -Infinity, sum = 0;
    for (let j = 0; j < C; j++) { res[j] = a[j * 9 + 4]; if (res[j] > m) m = res[j]; }
    for (let j = 0; j < C; j++) { res[j] = Math.exp(res[j] - m); sum += res[j]; }
    for (let j = 0; j < C; j++) res[j] /= sum;
    return res;
  };

  /**
   * Вероятности клетки в виде [пусто, белая, чёрная, рука] — для любой сети: 4 класса
   * или 14 (пусто, 6 белых фигур, 6 чёрных, рука; тип фигуры пока не используем).
   */
  function probs4(p, cell, K) {
    const c = cell * K;
    if (K === 14) {
      let w = 0, b = 0;
      for (let j = 1; j <= 6; j++) { w += p[c + j]; b += p[c + 6 + j]; }
      return [p[c], w, b, p[c + 13]];
    }
    return [p[c], p[c + 1], p[c + 2], K > 3 ? p[c + 3] : 0];
  }

  /** Снимок кадра → вероятности по клеткам. */
  Net.prototype.run = function (img, H) {
    this._x = this.rectify(img, H, this._x);
    return this.predict(this._x);
  };

  async function load(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('не удалось загрузить нейросеть: ' + r.status);
    return new Net(await r.arrayBuffer());
  }

  /*
   * Сеть в фоновом потоке (Web Worker): на телефоне один прогон занимает до трети секунды,
   * и в основном потоке на это время останавливалась бы обработка кадров.
   * Снимок доски выпрямляем в основном потоке (это быстро), считаем — в фоне.
   */
  function Background(scriptUrl, net) {
    this.net = net; // для rectify (те же размеры), сама сеть считает в фоне
    this.busy = false;
    this.w = new Worker(scriptUrl);
    this.w.postMessage({ buf: net.raw });
    this.w.onmessage = e => {
      if (e.data.trackError) { this.trackFailed = e.data.trackError; return; }
      this.busy = false;
      const cb = this.cb;
      this.cb = null;
      if (cb) cb(e.data.p ? new Float32Array(e.data.p) : null, e.data.error, e.data);
    };
    this.w.onerror = e => { this.busy = false; this.failed = true; const cb = this.cb; this.cb = null; if (cb) cb(null, String(e.message || e)); };
  }
  /*
   * Трекер партии (game-tracker.js) тоже живёт в фоновом потоке: на телефоне его перебор гипотез
   * занимал бы основной поток. scripts — адреса chess.js и game-tracker.js.
   */
  Background.prototype.trackInit = function (scripts) { this.w.postMessage({ track: 'init', scripts }); this.tracking = true; };
  Background.prototype.trackReset = function (fen, sqCell, gen) { this.w.postMessage({ track: 'reset', fen, sqCell: Array.from(sqCell), gen }); };
  /** Кадр → сеть → трекер; cb(вероятности, ходы лучшей гипотезы или null, gen, мс). */
  Background.prototype.runTracked = function (img, H, t, moving, gen, cb) {
    if (this.busy || this.failed) return false;
    const data = img.data.slice().buffer;
    this.busy = true;
    this.cb = (p, err, d) => cb(p, d ? d.best : null, d ? d.gen : -1, d ? d.ms : null);
    this.w.postMessage({ img: data, width: img.width, height: img.height, H: Array.from(H), t, moving: Array.from(moving), gen }, [data]);
    return true;
  };

  /** Запуск в фоне; cb(вероятности) придёт позже. false — поток занят. */
  Background.prototype.run = function (img, H, cb) {
    if (this.busy || this.failed) return false;
    // кадр копируем и отдаём потоку целиком: выпрямление тоже идёт в фоне
    const data = img.data.slice().buffer;
    this.busy = true;
    this.cb = cb;
    this.w.postMessage({ img: data, width: img.width, height: img.height, H: Array.from(H) }, [data]);
    return true;
  };

  // Код фонового потока: тот же файл, загруженный как Worker.
  if (typeof importScripts === 'function' && typeof self !== 'undefined' && typeof window === 'undefined') {
    let net = null, tr = null, sqCell = null, gen = -1;
    self.onmessage = e => {
      try {
        if (e.data.buf) { net = new Net(e.data.buf); return; }
        if (e.data.track === 'init') {
          try { importScripts.apply(null, e.data.scripts); } catch (err) { self.postMessage({ trackError: String(err && err.message || err) }); }
          return;
        }
        if (e.data.track === 'reset') {
          tr = new self.GameTracker.Tracker(null); tr.reset(e.data.fen); sqCell = e.data.sqCell; gen = e.data.gen;
          return;
        }
        const img = { data: new Uint8ClampedArray(e.data.img), width: e.data.width, height: e.data.height };
        const t0 = Date.now();
        const p = net.predict(net.rectify(img, e.data.H));
        const t1 = Date.now();
        let best = null;
        if (tr && e.data.gen === gen && e.data.t != null) {
          const K = net.classes, mv = e.data.moving;
          const b = tr.read(e.data.t / 1000, i => probs4(p, sqCell[i], K), i => !!mv[i]);
          best = b ? b.moves.map(m => ({ from: m.from, to: m.to, promotion: m.promotion })) : null;
        }
        self.postMessage({ p: p.buffer, best, gen: e.data.gen, ms: { net: t1 - t0, track: Date.now() - t1 }, wasm: !!net.wasm }, [p.buffer]);
      } catch (err) {
        self.postMessage({ error: String(err && err.message || err) });
      }
    };
  }

  return { Net, Background, load, parse, probs4, EMPTY, WHITE, BLACK, HAND };
}));
