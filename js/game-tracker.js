/*
 * GameTracker — восстановление партии по ответам нейросети во времени.
 *
 * Держим несколько гипотез о том, какие ходы сыграны. Каждая проверка сети добавляет гипотезе
 * «штраф»: сумму по видимым клеткам −ln P(что на клетке по этой гипотезе); каждый ход тоже
 * немного штрафуется. Запись — гипотеза с наименьшим суммарным штрафом. Поэтому:
 *   • положение «фигура в руке над клеткой» видно доли секунды и проигрывает;
 *   • порядок ходов задаётся тем, когда какие клетки изменились;
 *   • постоянная ошибка сети на одной клетке штрафует все гипотезы одинаково.
 * Правила, без которых появляются ложные ходы:
 *   • ход возможен, только если клетку, откуда ушла фигура, видно и фигуры этого цвета там нет;
 *   • у хода должно быть свежее изменение (откуда или куда) — давняя ошибка сети ходов не рождает;
 *   • храним по несколько гипотез с разным числом ходов: «медленная» верная не выпадает раньше времени.
 * За одну проверку гипотеза может продлиться на 1–2 хода (лучшие — на 3).
 *
 * Работает и в браузере (window.GameTracker), и в Node (для проверок). Нужен chess.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameTracker = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SQ = [];
  for (let r = 1; r <= 8; r++) for (const f of 'abcdefgh') SQ.push(f + r); // индекс 0 = a1 … 63 = h8
  const IDX = {};
  SQ.forEach((q, i) => { IDX[q] = i; });

  const DEFAULTS = {
    cap: 4,        // штраф клетки не больше
    pen: 2,        // штраф за ход
    beam: 24,      // сколько гипотез держать
    div: 4,        // сколько гипотез с одинаковым числом ходов держать в любом случае
    conf: 0.55,    // уверенный ответ сети по клетке
    hand: 0.5,     // клетка закрыта рукой
    recent: 4,     // «свежее» изменение клетки, с
    d3: 2,         // скольким лучшим гипотезам можно продлиться сразу на 3 хода
    minVisible: 24,
    startBad: 2,   // старт: сколько клеток может не сходиться с начальной позицией
  };

  function Tracker(ChessCtor, opts) {
    this.Chess = ChessCtor;
    this.o = Object.assign({}, DEFAULTS, opts || {});
    this.cache = new Map(); // позиция (FEN) → { cls, moves: [{san, from, to, color, fen}] }
    this.reset();
  }

  Tracker.prototype.reset = function (fen) {
    this.startFen = fen || null;
    const c = new this.Chess();
    if (fen) c.load(fen);
    this.beam = [{ fen: c.fen(), moves: [], acc: 0 }];
    this.started = false;
    this.obsCls = new Int8Array(64).fill(-1);
    this.obsSince = new Float64Array(64);
    this.reads = 0;
  };

  /** Позиция: классы клеток и легальные ходы (считаем один раз на позицию). */
  Tracker.prototype.node = function (fen) {
    let n = this.cache.get(fen);
    if (n) return n;
    const c = new this.Chess(fen);
    const cls = new Int8Array(64);
    for (let i = 0; i < 64; i++) { const p = c.get(SQ[i]); cls[i] = p ? (p.color === 'w' ? 1 : 2) : 0; }
    n = { cls, list: null, c };
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(fen, n);
    return n;
  };

  Tracker.prototype.moves = function (fen) {
    const n = this.node(fen);
    if (!n.list) {
      const c = n.c;
      n.list = c.moves({ verbose: true }).map(m => {
        c.move(m);
        const f2 = c.fen();
        c.undo();
        return { san: m.san, from: IDX[m.from], to: IDX[m.to], color: m.color === 'w' ? 1 : 2, fen: f2 };
      });
    }
    return n.list;
  };

  const key4 = fen => fen.split(' ').slice(0, 4).join(' ');

  /**
   * Очередная проверка сети.
   * t — время, с; probs(i) → [пусто, белая, чёрная, рука] для клетки i (0 = a1 … 63 = h8) или null;
   * moving(i) → true, если на клетке сейчас движение (рука).
   * Возвращает лучшую гипотезу { moves: [{san, t}], acc } или null, если ещё не начали.
   */
  Tracker.prototype.read = function (t, probs, moving) {
    const o = this.o;
    const vis = new Uint8Array(64), conf = new Int8Array(64).fill(-1);
    const cost = new Float32Array(64 * 3), prob = new Float32Array(64 * 3);
    let nvis = 0;
    for (let i = 0; i < 64; i++) {
      const p = probs(i);
      if (!p || p[3] >= o.hand || moving(i)) continue;
      const s = p[0] + p[1] + p[2];
      let best = 0;
      for (let k = 0; k < 3; k++) {
        const q = p[k] / s;
        prob[i * 3 + k] = q;
        cost[i * 3 + k] = Math.min(o.cap, -Math.log(Math.max(q, 1e-9)));
        if (q > prob[i * 3 + best]) best = k;
      }
      vis[i] = 1; nvis++;
      if (prob[i * 3 + best] >= o.conf) conf[i] = best;
    }
    if (nvis < o.minVisible) return this.started ? this.best() : null;
    for (let i = 0; i < 64; i++) {
      if (conf[i] >= 0 && conf[i] !== this.obsCls[i]) { this.obsCls[i] = conf[i]; this.obsSince[i] = t; }
    }
    if (!this.started) {
      const cls = this.node(this.beam[0].fen).cls;
      let bad = 0;
      for (let i = 0; i < 64; i++) if (conf[i] >= 0 && conf[i] !== cls[i]) bad++;
      if (nvis >= 50 && bad <= o.startBad) { this.started = true; this.obsSince.fill(t); }
      return null;
    }
    this.reads++;
    const obs = cls => { let s = 0; for (let i = 0; i < 64; i++) if (vis[i]) s += cost[i * 3 + cls[i]]; return s; };
    const changed = cls => { const out = []; for (let i = 0; i < 64; i++) if (conf[i] >= 0 && conf[i] !== cls[i]) out.push(i); return out; };
    const ok = m => {
      if (!vis[m.from]) return false;
      if (prob[m.from * 3 + m.color] >= 0.5) return false;
      return t - this.obsSince[m.from] <= o.recent || (t - this.obsSince[m.to] <= o.recent && this.obsCls[m.to] === m.color);
    };
    const cand = new Map();
    const add = (h, fen, newm) => {
      const k = key4(fen);
      const acc = h.acc + obs(this.node(fen).cls) + o.pen * newm.length;
      const prev = cand.get(k);
      if (!prev || prev.acc > acc) cand.set(k, { fen, moves: newm.length ? h.moves.concat(newm.map(san => ({ san, t }))) : h.moves, acc });
    };
    this.beam.forEach((h, hi) => {
      add(h, h.fen, []);
      const ch = new Set(changed(this.node(h.fen).cls));
      if (!ch.size) return;
      for (const m1 of this.moves(h.fen)) {
        if (!ch.has(m1.from) && !ch.has(m1.to)) continue;
        if (!ok(m1)) continue;
        add(h, m1.fen, [m1.san]);
        const ch2 = new Set(changed(this.node(m1.fen).cls));
        if (!ch2.size) continue;
        for (const m2 of this.moves(m1.fen)) {
          if (!ch2.has(m2.from) && !ch2.has(m2.to)) continue;
          if (!ok(m2)) continue;
          add(h, m2.fen, [m1.san, m2.san]);
          if (hi >= o.d3) continue;
          // три хода за одно движение руки (Qg3+ Kf1 Qf2#) — только для лучших гипотез
          const ch3 = new Set(changed(this.node(m2.fen).cls));
          if (!ch3.size) continue;
          for (const m3 of this.moves(m2.fen)) {
            if (!ch3.has(m3.from) && !ch3.has(m3.to)) continue;
            if (!ok(m3)) continue;
            add(h, m3.fen, [m1.san, m2.san, m3.san]);
          }
        }
      }
    });
    const all = Array.from(cand.values()).sort((a, b) => a.acc - b.acc);
    let beam;
    if (o.div) {
      const by = new Map(), keep = [], rest = [];
      for (const h of all) {
        const n = h.moves.length, c = by.get(n) || 0;
        if (c < o.div) { by.set(n, c + 1); keep.push(h); } else rest.push(h);
      }
      beam = keep.concat(rest).slice(0, o.beam).sort((a, b) => a.acc - b.acc);
    } else beam = all.slice(0, o.beam);
    const base = beam[0].acc;
    for (const h of beam) h.acc -= base;
    this.beam = beam;
    return this.best();
  };

  Tracker.prototype.best = function () { return this.beam[0]; };

  /** Сколько первых ходов совпадает у всех гипотез в пределах margin — эти ходы уже не изменятся. */
  Tracker.prototype.locked = function (margin) {
    const near = this.beam.filter(h => h.acc < (margin || 15));
    let k = 0;
    for (;;) {
      if (!near.every(h => h.moves.length > k)) break;
      const s = near[0].moves[k].san;
      if (!near.every(h => h.moves[k].san === s)) break;
      k++;
    }
    return k;
  };

  return { Tracker, SQUARES: SQ, DEFAULTS };
}));
