/*
 * SquareAI — небольшая нейросеть, которая учится прямо во время партии.
 *
 * Для каждой клетки она оценивает, что на ней сейчас: пусто, белая фигура,
 * чёрная фигура или рука (рука, рукав, фигура в руке). Размеченные примеры
 * появляются сами: в начальной позиции и после каждой проверенной позиции
 * мы точно знаем, что стоит на каждой клетке, а клетки, по которым только что
 * прошла рука, — примеры класса «рука». Поэтому сеть подстраивается под вашу
 * доску, фигуры, освещение и камеру без заранее собранного набора фотографий.
 *
 * Модель: многослойный перцептрон D → 16 (tanh) → 4 (softmax), обучение Adam.
 * Работает в браузере (window.SquareAI) и в Node (module.exports) для тестов.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SquareAI = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMPTY = 0, WHITE = 1, BLACK = 2, HAND = 3;
  const CLASSES = ['пусто', 'белая', 'чёрная', 'рука'];
  const D = 14, HID = 16, C = 4;

  /**
   * Признаки клетки по её отпечатку (см. BoardVision.sampleBoard).
   * f — отпечатки кадра, cell — номер клетки, light — светлая ли клетка доски,
   * norm — средняя яркость доски в кадре (поправка на экспозицию).
   */
  function describe(f, cell, light, norm) {
    const per = f.per, n = per / 3, o = cell * per, d = f.data;
    const lum = new Float32Array(n);
    let sr = 0, sg = 0, sb = 0, sat = 0, warm = 0;
    for (let i = 0; i < n; i++) {
      const r = d[o + i * 3], g = d[o + i * 3 + 1], b = d[o + i * 3 + 2];
      sr += r; sg += g; sb += b;
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sat += mx > 1 ? (mx - mn) / mx : 0;
      if (r > g && g > b && (r - b) > 0.15 * (r + g + b) / 3) warm++;
    }
    const k = 1 / (norm || 128);
    lum.sort();
    let mu = 0, m2 = 0;
    for (let i = 0; i < n; i++) { mu += lum[i]; m2 += lum[i] * lum[i]; }
    mu /= n;
    const sd = Math.sqrt(Math.max(0, m2 / n - mu * mu));
    const q = p => lum[Math.min(n - 1, Math.floor(p * n))];
    const x = new Float32Array(D);
    x[0] = sr / n * k; x[1] = sg / n * k; x[2] = sb / n * k;
    x[3] = mu * k;
    x[4] = sd * k;
    x[5] = q(0.1) * k; x[6] = q(0.5) * k; x[7] = q(0.9) * k;
    x[8] = q(0.9) * k - q(0.1) * k;
    x[9] = sat / n;
    x[10] = warm / n;
    x[11] = (sr - sb) / n * k;
    x[12] = (sr - sg) / n * k;
    x[13] = light ? 1 : 0;
    return x;
  }

  /** Средняя яркость доски в кадре — для поправки на экспозицию. */
  function boardNorm(f) {
    const n = f.data.length / 3;
    let s = 0;
    for (let i = 0; i < f.data.length; i += 3) s += 0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2];
    return s / n;
  }

  function randn(rng) {
    const u = 1 - rng(), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  class SquareAI {
    constructor(opts) {
      this.opts = Object.assign({ cap: 1200, lr: 0.01, l2: 1e-4, batch: 16, seed: 1 }, opts);
      let seed = this.opts.seed >>> 0 || 1;
      this.rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      this.reset();
    }

    reset() {
      const r = this.rng;
      this.W1 = new Float32Array(HID * D).map(() => randn(r) * Math.sqrt(1 / D));
      this.b1 = new Float32Array(HID);
      this.W2 = new Float32Array(C * HID).map(() => randn(r) * Math.sqrt(1 / HID));
      this.b2 = new Float32Array(C);
      this.adam = [this.W1, this.b1, this.W2, this.b2].map(p => ({ m: new Float32Array(p.length), v: new Float32Array(p.length) }));
      this.t = 0;
      this.data = [[], [], [], []]; // примеры по классам (FIFO)
      this.mean = new Float32Array(D);
      this.std = new Float32Array(D).fill(1);
      this.statsAt = -1;
      this.steps = 0;
      this.added = 0;
    }

    /** Добавляет размеченный пример (x — признаки, y — класс). */
    add(x, y) {
      const bucket = this.data[y];
      bucket.push(x);
      if (bucket.length > this.opts.cap) bucket.splice(0, bucket.length - this.opts.cap);
      this.added++;
    }

    count(y) { return y == null ? this.data.reduce((s, b) => s + b.length, 0) : this.data[y].length; }

    /** Обучена ли сеть настолько, чтобы ей доверять (и знает ли она руку). */
    ready() {
      return this.steps >= 300 && this.count(EMPTY) >= 8 && this.count(WHITE) >= 8 && this.count(BLACK) >= 8;
    }
    knowsHand() { return this.ready() && this.count(HAND) >= 15; }

    updateStats() {
      const all = [].concat(...this.data);
      if (!all.length) return;
      this.mean.fill(0);
      const v = new Float32Array(D);
      for (const x of all) for (let i = 0; i < D; i++) this.mean[i] += x[i];
      for (let i = 0; i < D; i++) this.mean[i] /= all.length;
      for (const x of all) for (let i = 0; i < D; i++) v[i] += (x[i] - this.mean[i]) ** 2;
      for (let i = 0; i < D; i++) this.std[i] = Math.sqrt(v[i] / all.length) + 1e-3;
      this.statsAt = this.added;
    }

    forward(x) {
      const z = new Float32Array(D);
      for (let i = 0; i < D; i++) z[i] = (x[i] - this.mean[i]) / this.std[i];
      const h = new Float32Array(HID);
      for (let j = 0; j < HID; j++) {
        let s = this.b1[j];
        for (let i = 0; i < D; i++) s += this.W1[j * D + i] * z[i];
        h[j] = Math.tanh(s);
      }
      const p = new Float32Array(C);
      let mx = -Infinity;
      for (let c = 0; c < C; c++) {
        let s = this.b2[c];
        for (let j = 0; j < HID; j++) s += this.W2[c * HID + j] * h[j];
        p[c] = s;
        if (s > mx) mx = s;
      }
      let sum = 0;
      for (let c = 0; c < C; c++) { p[c] = Math.exp(p[c] - mx); sum += p[c]; }
      for (let c = 0; c < C; c++) p[c] /= sum;
      return { z, h, p };
    }

    /** Вероятности классов [пусто, белая, чёрная, рука]. */
    predict(x) {
      const p = this.forward(x).p;
      if (!this.count(HAND)) { // руку ещё не видели — делим её долю между остальными
        const s = 1 - p[HAND];
        p[HAND] = 0;
        for (let c = 0; c < 3; c++) p[c] /= s || 1;
      }
      return p;
    }

    /** Несколько шагов обучения на случайных примерах (с выравниванием классов). */
    train(steps) {
      const present = [0, 1, 2, 3].filter(c => this.data[c].length);
      if (present.length < 2) return 0;
      if (this.added - this.statsAt > 50 || this.statsAt < 0) this.updateStats();
      const { lr, l2, batch } = this.opts;
      const gW1 = new Float32Array(HID * D), gb1 = new Float32Array(HID);
      const gW2 = new Float32Array(C * HID), gb2 = new Float32Array(C);
      let loss = 0;
      for (let s = 0; s < steps; s++) {
        gW1.fill(0); gb1.fill(0); gW2.fill(0); gb2.fill(0);
        for (let b = 0; b < batch; b++) {
          const y = present[Math.floor(this.rng() * present.length)];
          const bucket = this.data[y];
          const x = bucket[Math.floor(this.rng() * bucket.length)];
          const { z, h, p } = this.forward(x);
          loss -= Math.log(p[y] + 1e-9);
          const dz = Array.from(p);
          dz[y] -= 1;
          for (let c = 0; c < C; c++) {
            gb2[c] += dz[c];
            for (let j = 0; j < HID; j++) gW2[c * HID + j] += dz[c] * h[j];
          }
          for (let j = 0; j < HID; j++) {
            let dh = 0;
            for (let c = 0; c < C; c++) dh += this.W2[c * HID + j] * dz[c];
            const dp = dh * (1 - h[j] * h[j]);
            gb1[j] += dp;
            for (let i = 0; i < D; i++) gW1[j * D + i] += dp * z[i];
          }
        }
        this.t++;
        const params = [this.W1, this.b1, this.W2, this.b2], grads = [gW1, gb1, gW2, gb2];
        const b1c = 1 - Math.pow(0.9, this.t), b2c = 1 - Math.pow(0.999, this.t);
        for (let k = 0; k < 4; k++) {
          const P = params[k], G = grads[k], A = this.adam[k];
          for (let i = 0; i < P.length; i++) {
            const g = G[i] / batch + (k % 2 === 0 ? l2 * P[i] : 0);
            A.m[i] = 0.9 * A.m[i] + 0.1 * g;
            A.v[i] = 0.999 * A.v[i] + 0.001 * g * g;
            P[i] -= lr * (A.m[i] / b1c) / (Math.sqrt(A.v[i] / b2c) + 1e-8);
          }
        }
        this.steps++;
      }
      return loss / (steps * batch);
    }

    /** Доля верных ответов на собственных примерах (для статуса и тестов). */
    accuracy() {
      let ok = 0, n = 0;
      for (let y = 0; y < C; y++) {
        for (const x of this.data[y]) {
          const p = this.predict(x);
          let best = 0;
          for (let c = 1; c < C; c++) if (p[c] > p[best]) best = c;
          if (best === y) ok++;
          n++;
        }
      }
      return n ? ok / n : 0;
    }
  }

  return { SquareAI, describe, boardNorm, EMPTY, WHITE, BLACK, HAND, CLASSES, D };
}));
