/*
 * PieceNet — сеть, узнающая тип фигуры по крупному снимку клетки (вторая сеть; быструю запись ходов ведёт board-net.js).
 *
 * Камера стоит близко и под углом, поэтому одна и та же фигура у дальнего края видна сбоку, а под камерой — сверху.
 * Чтобы сети не приходилось учить каждую фигуру на каждой клетке отдельно, снимок приводится к одному виду:
 *   1. по углам доски считаем, где камера: точку под ней (надир) и высоту;
 *   2. вырез клетки поворачиваем вдоль луча «от камеры» — фигура всегда «стоит вверх»;
 *   3. каждый снимок приводим к одной яркости и одному оттенку (по полосе, где стоит фигура), так что свет
 *      в зале — тусклый, яркий, жёлтый — на ответ не влияет.
 * Обучение: tools/net (canon.py, crops.py, cropnet.py). Классы: пусто, P N B R Q K, p n b r q k.
 */
// В фоновом потоке (этот же файл, загруженный как Worker) сначала подгружаем слои сети из board-net.js.
if (typeof importScripts === 'function' && typeof window === 'undefined' && typeof self !== 'undefined' && !self.BoardNet) {
  importScripts('board-net.js' + (self.location && self.location.search ? self.location.search : ''));
}
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./board-net.js'));
  else root.PieceNet = factory(root.BoardNet);
}(typeof self !== 'undefined' ? self : this, function (BN) {
  'use strict';

  const OUT = 64;
  const ACROSS = 1.5, BACK = 0.6, FWD = 1.7;   // вырез: 1,5 клетки поперёк луча, от −0,6 до +1,7 клетки вдоль него

  /**
   * Где камера. H8 — гомография «клетки доски (0..8, 0..8) → пиксели кадра» (9 чисел), W×Hh — размер кадра.
   * Возвращает { x, y, h }: точка под камерой и высота, в клетках. Считаем, что главная точка — центр кадра.
   */
  function camera(H8, W, Hh) {
    const h = [H8[0] - W / 2 * H8[6], H8[1] - W / 2 * H8[7], H8[2] - W / 2 * H8[8],
      H8[3] - Hh / 2 * H8[6], H8[4] - Hh / 2 * H8[7], H8[5] - Hh / 2 * H8[8], H8[6], H8[7], H8[8]];
    const den = h[6] * h[7];
    let f2 = Math.abs(den) > 1e-12 ? -(h[0] * h[1] + h[3] * h[4]) / den : -1;
    const m = Math.max(W, Hh);
    if (!(f2 > (0.4 * m) * (0.4 * m) && f2 < (4 * m) * (4 * m))) f2 = (0.9 * m) * (0.9 * m); // камера почти сверху — обычный угол обзора телефона
    const f = Math.sqrt(f2);
    let a = [h[0] / f, h[3] / f, h[6]], b = [h[1] / f, h[4] / f, h[7]], t = [h[2] / f, h[5] / f, h[8]];
    const norm = v => Math.hypot(v[0], v[1], v[2]);
    const lam = (norm(a) + norm(b)) / 2 * (t[2] < 0 ? -1 : 1);
    a = a.map(v => v / lam); b = b.map(v => v / lam); t = t.map(v => v / lam);
    // ортонормируем: r1 вдоль a, r2 — b без составляющей вдоль r1, r3 = r1 × r2
    const na = norm(a), r1 = a.map(v => v / na);
    const d = b[0] * r1[0] + b[1] * r1[1] + b[2] * r1[2];
    let r2 = [b[0] - d * r1[0], b[1] - d * r1[1], b[2] - d * r1[2]];
    const nb = norm(r2); r2 = r2.map(v => v / nb);
    const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
    const dot = r => -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]);
    return { x: dot(r1), y: dot(r2), h: Math.abs(dot(r3)) };
  }

  /**
   * Канонический снимок клетки (r, c) прямо из кадра: Float32Array 3×64×64, значения 0..1.
   * img — { data (RGBA), width, height }; cam — результат camera().
   */
  function crop(img, H8, r, c, cam, out) {
    const x = out || new Float32Array(3 * OUT * OUT), d = img.data, iw = img.width, ih = img.height, plane = OUT * OUT;
    const px = c + 0.5, py = r + 0.5;
    let ux = px - cam.x, uy = py - cam.y;
    const dist = Math.hypot(ux, uy);
    if (dist < 0.5) { ux = 0; uy = -1; } else { ux /= dist; uy /= dist; }
    const ex = -uy, ey = ux, ka = ACROSS / OUT, kb = (BACK + FWD) / OUT;
    for (let j = 0; j < OUT; j++) {
      for (let i = 0; i < OUT; i++) {
        let R = 0, G = 0, B = 0;
        for (let sj = 0; sj < 2; sj++) {
          const oy = j + (sj + 0.5) / 2, al = FWD - oy * kb;
          for (let si = 0; si < 2; si++) {
            const ac = (i + (si + 0.5) / 2 - OUT / 2) * ka;
            const bx = px + ex * ac + ux * al, by = py + ey * ac + uy * al;
            const w = H8[6] * bx + H8[7] * by + H8[8];
            let fx = (H8[0] * bx + H8[1] * by + H8[2]) / w - 0.5, fy = (H8[3] * bx + H8[4] * by + H8[5]) / w - 0.5;
            if (fx < 0) fx = 0; else if (fx > iw - 1.001) fx = iw - 1.001;
            if (fy < 0) fy = 0; else if (fy > ih - 1.001) fy = ih - 1.001;
            const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
            const o = (y0 * iw + x0) * 4, o2 = o + iw * 4;
            const w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay), w10 = (1 - ax) * ay, w11 = ax * ay;
            R += d[o] * w00 + d[o + 4] * w01 + d[o2] * w10 + d[o2 + 4] * w11;
            G += d[o + 1] * w00 + d[o + 5] * w01 + d[o2 + 1] * w10 + d[o2 + 5] * w11;
            B += d[o + 2] * w00 + d[o + 6] * w01 + d[o2 + 2] * w10 + d[o2 + 6] * w11;
          }
        }
        const k = j * OUT + i;
        // как при обучении: среднее по 4 отсчётам, округлённое до целого уровня яркости
        x[k] = Math.round(R / 4) / 255; x[plane + k] = Math.round(G / 4) / 255; x[2 * plane + k] = Math.round(B / 4) / 255;
      }
    }
    return x;
  }

  /**
   * Свет: каждый цветовой канал снимка — к нулевому среднему и единичному разбросу по полосе band = [x0, x1, y0, y1],
   * вне полосы — ноль. После этого общий свет, его цвет и контраст на ответ сети не влияют.
   */
  function normalize(x, band) {
    const plane = OUT * OUT, x0 = band[0], x1 = band[1], y0 = band[2], y1 = band[3], cnt = (x1 - x0) * (y1 - y0);
    for (let c = 0; c < 3; c++) {
      const o = c * plane;
      let s = 0;
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) s += x[o + j * OUT + i];
      const mean = s / cnt;
      let ss = 0;
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) { const t = x[o + j * OUT + i] - mean; ss += t * t; }
      const k = 1 / (Math.sqrt(ss / cnt) + 0.02);
      for (let j = 0; j < OUT; j++) for (let i = 0; i < OUT; i++) {
        const q = o + j * OUT + i;
        x[q] = (j >= y0 && j < y1 && i >= x0 && i < x1) ? (x[q] - mean) * k : 0;
      }
    }
    return x;
  }

  function Net(buf) {
    this.net = new BN.Net(buf);
    this.raw = buf;
    this.classes = this.net.meta.classes;
    this.band = this.net.meta.band || [12, 52, 0, 64];
    this._x = new Float32Array(3 * OUT * OUT);
  }

  /**
   * Что стоит на клетках cells = [[r, c], …] (строка и столбец в кадре). img — кадр, Hunit — гомография
   * «единичный квадрат доски → пиксели кадра» (как BoardVision.computeHomography). Возвращает Float32Array n×13.
   */
  Net.prototype.read = function (img, Hunit, cells) {
    const H8 = [Hunit[0] / 8, Hunit[1] / 8, Hunit[2], Hunit[3] / 8, Hunit[4] / 8, Hunit[5], Hunit[6] / 8, Hunit[7] / 8, Hunit[8]];
    const cam = camera(H8, img.width, img.height), K = this.classes.length, res = new Float32Array(cells.length * K);
    for (let n = 0; n < cells.length; n++) {
      crop(img, H8, cells[n][0], cells[n][1], cam, this._x);
      res.set(this.net.classify(normalize(this._x, this.band)), n * K);
    }
    return res;
  };

  function load(url) {
    return fetch(url).then(r => { if (!r.ok) throw new Error('нет файла сети фигур'); return r.arrayBuffer(); }).then(b => new Net(b));
  }

  /** Сеть фигур в фоновом потоке: одна проверка позиции на телефоне занимает до секунды. */
  function Background(scriptUrl, net) {
    this.busy = false;
    this.w = new Worker(scriptUrl);
    this.w.postMessage({ buf: net.raw });
    this.w.onmessage = e => {
      this.busy = false;
      const cb = this.cb; this.cb = null;
      if (cb) cb(e.data.p ? new Float32Array(e.data.p) : null, e.data.ms);
    };
    this.w.onerror = () => { this.busy = false; this.failed = true; const cb = this.cb; this.cb = null; if (cb) cb(null); };
  }
  /** cb(вероятности n×13 или null, мс) придёт позже; false — поток занят. */
  Background.prototype.read = function (img, Hunit, cells, cb) {
    if (this.busy || this.failed) return false;
    const data = img.data.buffer.slice(0);
    this.busy = true; this.cb = cb;
    this.w.postMessage({ img: data, width: img.width, height: img.height, H: Array.from(Hunit), cells }, [data]);
    return true;
  };

  // Код фонового потока.
  if (typeof importScripts === 'function' && typeof self !== 'undefined' && typeof window === 'undefined') {
    let net = null;
    self.onmessage = e => {
      try {
        if (e.data.buf) { net = new Net(e.data.buf); return; }
        const t0 = Date.now();
        const p = net.read({ data: new Uint8ClampedArray(e.data.img), width: e.data.width, height: e.data.height }, e.data.H, e.data.cells);
        self.postMessage({ p: p.buffer, ms: Date.now() - t0 }, [p.buffer]);
      } catch (err) {
        self.postMessage({ error: String(err && err.message || err) });
      }
    };
  }

  return { Net, Background, load, camera, crop, normalize, OUT };
}));
