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
    let S = this.size, C = 3;
    let a = pad(x, C, S);
    for (const l of this.layers) {
      if (l.type === 'pool') { a = pool(a, C, S); S >>= 1; } else { a = conv(a, l, S); C = l.out; }
    }
    // выход S×S (поле в одну клетку вокруг доски) → клетки 1..8
    const P = S + 2, plane = P * P, K = C, res = new Float32Array(64 * K), z = new Float64Array(K);
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
  };

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
      this.busy = false;
      const cb = this.cb;
      this.cb = null;
      if (cb) cb(e.data.p ? new Float32Array(e.data.p) : null, e.data.error);
    };
    this.w.onerror = e => { this.busy = false; this.failed = true; const cb = this.cb; this.cb = null; if (cb) cb(null, String(e.message || e)); };
  }
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
    let net = null;
    self.onmessage = e => {
      try {
        if (e.data.buf) { net = new Net(e.data.buf); return; }
        const img = { data: new Uint8ClampedArray(e.data.img), width: e.data.width, height: e.data.height };
        const p = net.predict(net.rectify(img, e.data.H));
        self.postMessage({ p: p.buffer }, [p.buffer]);
      } catch (err) {
        self.postMessage({ error: String(err && err.message || err) });
      }
    };
  }

  return { Net, Background, load, parse, EMPTY, WHITE, BLACK, HAND };
}));
