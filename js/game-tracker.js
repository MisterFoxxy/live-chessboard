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
 * Работает и в браузере (window.GameTracker), и в Node (для проверок). Ходы генерирует сам
 * (быстрее chess.js в десятки раз); ходы в ответе — {from, to, promotion}.
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
    pen: 4,        // штраф за ход
    beam: 24,      // сколько гипотез держать
    div: 4,        // сколько гипотез с одинаковым числом ходов держать в любом случае
    conf: 0.7,     // уверенный ответ сети по клетке
    hand: 0.5,     // клетка закрыта рукой
    recent: 4,     // «свежее» изменение клетки, с
    d3: 6,         // скольким лучшим гипотезам можно продлиться сразу на 3 хода
    d4: 2,         // … и на 4 хода (после паузы за доской мог пройти целый размен)
    minVisible: 24,
    budget: 0,     // мс на одну проверку (0 — без предела); лучшие гипотезы перебираются первыми
    startBad: 2,   // старт: сколько клеток может не сходиться с начальной позицией
    rate: 0,       // вес проверки = прошедшее время / rate с (0 — каждая проверка весит 1): не зависит от скорости телефона
    mvis: 0.99,    // клетка с движением рядом всё же учитывается, если сеть уверена в ней не меньше mvis, а руки нет (0 — выкл.)
    maxHold: 2.0,  // ход, который доска ещё не подтвердила чисто, показываем через столько секунд, если гипотезы в нём сходятся
    holdMargin: 6, // «близкие» гипотезы: отстают от лучшей не больше чем на столько
    passPen: 0,    // ход вне очереди (одна сторона сходила дважды): гипотеза «пропуск хода» стоит столько сверх обычного хода (0 — выкл.)
    passTop: 6,    // сколько лучших гипотез проверяют пропуск хода
    arrive: 1,     // ход виден только по клетке «куда»: там уверенно стоит новая фигура ходящего дольше arrive с,
                   // а клетку «откуда» сеть по ошибке всё ещё видит занятой (0 — выкл.)
    hid: 0.9,      // ход с клетки под рукой: на клетке «куда» уверенно (не меньше hid) и недавно появилась фигура ходящего (0 — выкл.)
  };

  function Tracker(ChessCtor, opts) {
    this.Chess = ChessCtor;
    this.o = Object.assign({}, DEFAULTS, opts || {});
    this.cache = new Map(); // позиция (FEN) → { cls, moves: [{san, from, to, color, fen}] }
    this.reset();
  }

  Tracker.prototype.reset = function (fen) {
    this.startFen = fen || null;
    this.beam = [{ node: this.node(fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), moves: [], acc: 0 }];
    this.started = false;
    this.obsCls = new Int8Array(64).fill(-1);
    this.obsSince = new Float64Array(64);
    this.reads = 0;
    this.lastT = null;
    // «чистое» наблюдение клетки: рука не над ней, движения нет, сеть уверена — что видно и когда в последний раз
    this.cleanCls = new Int8Array(64).fill(-1);
    this.cleanT = new Float64Array(64).fill(-1e9);
  };

  /* ---------- Свой быстрый генератор ходов ----------
   * chess.js при каждом переборе считает запись ходов (SAN) и проверку шаха — для перебора гипотез
   * это лишнее и в десятки раз медленнее. Здесь позиция — массив из 64 клеток (0 = a1), фигура:
   * 1 пешка, 2 конь, 3 слон, 4 ладья, 5 ферзь, 6 король; +8 — чёрная. Ходы генерируем только с
   * нужной клетки, легальность — «не остаётся ли свой король под боем».
   */
  const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6, BLACK = 8;
  const KN = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]], ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const ALL8 = DIAG.concat(ORTH);
  const LETTER = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
  const at = (r, f) => (r >= 0 && r < 8 && f >= 0 && f < 8 ? r * 8 + f : -1);

  function fromFen(fen) {
    const [place, turn, cast, ep] = fen.split(' ');
    const b = new Int8Array(64);
    place.split('/').forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') { f += +ch; continue; }
        const lo = ch.toLowerCase();
        b[(7 - i) * 8 + f] = LETTER[lo] | (ch === lo ? BLACK : 0);
        f++;
      }
    });
    let c = 0;
    if (cast && cast !== '-') { if (cast.indexOf('K') >= 0) c |= 1; if (cast.indexOf('Q') >= 0) c |= 2; if (cast.indexOf('k') >= 0) c |= 4; if (cast.indexOf('q') >= 0) c |= 8; }
    return { b, turn: turn === 'b' ? 1 : 0, castle: c, ep: ep && ep !== '-' ? IDX[ep] : -1 };
  }
  function keyOf(pos) { return String.fromCharCode.apply(null, pos.b) + pos.turn + pos.castle + ',' + pos.ep; }
  function clsOf(pos) {
    const cls = new Int8Array(64);
    for (let i = 0; i < 64; i++) cls[i] = pos.b[i] ? (pos.b[i] & BLACK ? 2 : 1) : 0;
    return cls;
  }
  /** Бьёт ли сторона byBlack клетку sq. */
  function attacked(b, sq, byBlack) {
    const r = sq >> 3, f = sq & 7, col = byBlack ? BLACK : 0;
    const pr = byBlack ? r + 1 : r - 1; // пешка бьёт по диагонали вперёд
    for (const df of [-1, 1]) { const s2 = at(pr, f + df); if (s2 >= 0 && b[s2] === (PAWN | col)) return true; }
    for (const [dr, df] of KN) { const s2 = at(r + dr, f + df); if (s2 >= 0 && b[s2] === (KNIGHT | col)) return true; }
    for (const [dr, df] of ALL8) { const s2 = at(r + dr, f + df); if (s2 >= 0 && b[s2] === (KING | col)) return true; }
    for (const [dr, df] of DIAG) {
      for (let k = 1; ; k++) { const s2 = at(r + dr * k, f + df * k); if (s2 < 0) break; const p = b[s2]; if (!p) continue; if (p === (BISHOP | col) || p === (QUEEN | col)) return true; break; }
    }
    for (const [dr, df] of ORTH) {
      for (let k = 1; ; k++) { const s2 = at(r + dr * k, f + df * k); if (s2 < 0) break; const p = b[s2]; if (!p) continue; if (p === (ROOK | col) || p === (QUEEN | col)) return true; break; }
    }
    return false;
  }
  /** Позиция после хода m = {from, to, promo, ep, castle} (без проверки легальности). */
  function make(pos, m) {
    const b = new Int8Array(pos.b), p = b[m.from], black = (p & BLACK) !== 0;
    b[m.to] = m.promo ? (m.promo | (p & BLACK)) : p; b[m.from] = 0;
    if (m.ep) b[m.to + (black ? 8 : -8)] = 0;
    if (m.castle) { const r = m.from & ~7; if (m.to > m.from) { b[r + 5] = b[r + 7]; b[r + 7] = 0; } else { b[r + 3] = b[r]; b[r] = 0; } }
    let c = pos.castle;
    const clear = sq => { if (sq === 4) c &= ~3; if (sq === 60) c &= ~12; if (sq === 0) c &= ~2; if (sq === 7) c &= ~1; if (sq === 56) c &= ~8; if (sq === 63) c &= ~4; };
    clear(m.from); clear(m.to);
    const ep = (p & 7) === PAWN && Math.abs(m.to - m.from) === 16 ? (m.from + m.to) >> 1 : -1;
    return { b, turn: 1 - pos.turn, castle: c, ep };
  }
  function kingSq(b, black) { const k = KING | (black ? BLACK : 0); for (let i = 0; i < 64; i++) if (b[i] === k) return i; return -1; }
  /** Легальные ходы фигуры с клетки from (превращение — только в ферзя: тип фигуры сеть не различает). */
  function movesFromSq(pos, from) {
    const b = pos.b, p = b[from], out = [];
    if (!p) return out;
    const black = (p & BLACK) !== 0;
    if (black !== (pos.turn === 1)) return out;
    const type = p & 7, r = from >> 3, f = from & 7, own = black ? BLACK : 0;
    const enemy = s => b[s] && (b[s] & BLACK) !== own;
    const push = (to, extra) => out.push(Object.assign({ from, to }, extra || {}));
    if (type === PAWN) {
      const dir = black ? -1 : 1, last = black ? 0 : 7, start = black ? 6 : 1;
      const one = at(r + dir, f);
      if (one >= 0 && !b[one]) {
        push(one, r + dir === last ? { promo: QUEEN } : null);
        const two = at(r + 2 * dir, f);
        if (r === start && !b[two]) push(two);
      }
      for (const df of [-1, 1]) {
        const s2 = at(r + dir, f + df);
        if (s2 < 0) continue;
        if (enemy(s2)) push(s2, r + dir === last ? { promo: QUEEN } : null);
        else if (s2 === pos.ep) push(s2, { ep: true });
      }
    } else if (type === KNIGHT || type === KING) {
      for (const [dr, df] of type === KNIGHT ? KN : ALL8) { const s2 = at(r + dr, f + df); if (s2 >= 0 && (!b[s2] || enemy(s2))) push(s2); }
      if (type === KING) {
        const base = black ? 56 : 0, ks = black ? 4 : 1, qs = black ? 8 : 2, opp = !black;
        if (from === base + 4 && !attacked(b, from, opp)) {
          if ((pos.castle & ks) && !b[base + 5] && !b[base + 6] && b[base + 7] === (ROOK | own) && !attacked(b, base + 5, opp) && !attacked(b, base + 6, opp)) push(base + 6, { castle: true });
          if ((pos.castle & qs) && !b[base + 3] && !b[base + 2] && !b[base + 1] && b[base] === (ROOK | own) && !attacked(b, base + 3, opp) && !attacked(b, base + 2, opp)) push(base + 2, { castle: true });
        }
      }
    } else {
      const dirs = type === BISHOP ? DIAG : type === ROOK ? ORTH : ALL8;
      for (const [dr, df] of dirs) {
        for (let k = 1; ; k++) { const s2 = at(r + dr * k, f + df * k); if (s2 < 0) break; if (!b[s2]) { push(s2); continue; } if (enemy(s2)) push(s2); break; }
      }
    }
    // легальность: свой король не под боем
    return out.filter(m => { const n = make(pos, m); const k = kingSq(n.b, black); return k >= 0 && !attacked(n.b, k, !black); });
  }

  /** Позиция в кэше: что стоит на клетках и ходы с отдельных клеток. */
  Tracker.prototype.node = function (pos) {
    const k = typeof pos === 'string' ? null : keyOf(pos);
    if (typeof pos === 'string') pos = fromFen(pos);
    const key = k || keyOf(pos);
    let n = this.cache.get(key);
    if (n) return n;
    n = { pos, key, cls: clsOf(pos), from: new Map() };
    if (this.cache.size > 50000) this.cache.clear();
    this.cache.set(key, n);
    return n;
  };
  Tracker.prototype.movesFrom = function (n, sq) {
    let list = n.from.get(sq);
    if (!list) {
      list = movesFromSq(n.pos, sq).map(m => ({ m, from: m.from, to: m.to, color: n.pos.turn === 0 ? 1 : 2 }));
      n.from.set(sq, list);
    }
    return list;
  };
  /** Та же позиция, но ход у другой стороны (пропуск хода); взятие на проходе пропадает. */
  Tracker.prototype.passNode = function (n) {
    if (!n.pass) n.pass = this.node({ b: n.pos.b, turn: 1 - n.pos.turn, castle: n.pos.castle, ep: -1 });
    return n.pass;
  };
  Tracker.prototype.child = function (n, mv) {
    if (!mv.node) mv.node = this.node(make(n.pos, mv.m));
    return mv.node;
  };

  /**
   * Очередная проверка сети.
   * t — время, с; probs(i) → [пусто, белая, чёрная, рука] для клетки i (0 = a1 … 63 = h8) или null;
   * moving(i) → true, если на клетке сейчас движение (рука).
   * Возвращает лучшую гипотезу { moves: [{from, to, promotion, t}], acc } или null, если ещё не начали.
   */
  Tracker.prototype.read = function (t, probs, moving) {
    const o = this.o;
    const vis = new Uint8Array(64), conf = new Int8Array(64).fill(-1);
    const cost = new Float32Array(64 * 3), prob = new Float32Array(64 * 3);
    let nvis = 0;
    for (let i = 0; i < 64; i++) {
      const p = probs(i);
      if (!p || p[3] >= o.hand) continue;
      const s = p[0] + p[1] + p[2];
      if (moving(i) && !(o.mvis && p[3] < 0.05 && Math.max(p[0], p[1], p[2]) / s >= o.mvis)) continue;
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
    this.lastReadT = t;
    this.lastConf = conf;
    for (let i = 0; i < 64; i++) {
      if (!vis[i] || conf[i] < 0 || moving(i)) continue;
      this.cleanCls[i] = conf[i]; this.cleanT[i] = t;
    }
    if (nvis < o.minVisible) return this.started ? this.best() : null;
    for (let i = 0; i < 64; i++) {
      if (conf[i] >= 0 && conf[i] !== this.obsCls[i]) { this.obsCls[i] = conf[i]; this.obsSince[i] = t; }
    }
    if (!this.started) {
      const cls = this.beam[0].node.cls;
      let bad = 0;
      for (let i = 0; i < 64; i++) if (conf[i] >= 0 && conf[i] !== cls[i]) bad++;
      if (nvis >= 50 && bad <= o.startBad) { this.started = true; this.obsSince.fill(t); }
      return null;
    }
    this.reads++;
    const w = o.rate && this.lastT != null ? Math.max(0.25, Math.min(2, (t - this.lastT) / o.rate)) : 1;
    this.lastT = t;
    const obs = cls => { let s = 0; for (let i = 0; i < 64; i++) if (vis[i]) s += cost[i * 3 + cls[i]]; return s * w; };
    const changedSet = cls => { const out = new Set(); for (let i = 0; i < 64; i++) if (conf[i] >= 0 && conf[i] !== cls[i]) out.add(i); return out; };
    const ok = mv => {
      if (!vis[mv.from]) return false;
      if (prob[mv.from * 3 + mv.color] >= 0.5) return false;
      return t - this.obsSince[mv.from] <= o.recent || (t - this.obsSince[mv.to] <= o.recent && this.obsCls[mv.to] === mv.color);
    };
    // ходы только с клеток, где по гипотезе стоит фигура ходящего, а сеть её там не видит (условие ok)
    const fromSquares = n => {
      const cls = n.cls, col = n.pos.turn === 0 ? 1 : 2, out = [];
      for (let i = 0; i < 64; i++) if (cls[i] === col && vis[i] && prob[i * 3 + col] < 0.5) out.push(i);
      return out;
    };
    const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
    const tEnd = o.budget ? now() + o.budget : Infinity;
    const cand = new Map();
    const add = (h, node, newm, extra) => {
      const acc = h.acc + obs(node.cls) + o.pen * newm.length + (extra || 0);
      const prev = cand.get(node.key);
      if (!prev || prev.acc > acc) cand.set(node.key, { node, moves: newm.length ? h.moves.concat(newm.map(mv => (mv.pass ? { pass: true, t, c: mv.color } : { from: SQ[mv.from], to: SQ[mv.to], promotion: mv.m.promo ? 'q' : undefined, t, c: mv.color }))) : h.moves, acc });
    };
    // клетка «откуда» под рукой: ход виден только по клетке «куда» (фигуру уже поставили, руку ещё не убрали)
    const okHid = mv => vis[mv.to] && conf[mv.to] === mv.color && prob[mv.to * 3 + mv.color] >= o.hid &&
      this.obsCls[mv.to] === mv.color && t - this.obsSince[mv.to] <= o.recent;
    const expand = (n, ch) => {
      const out = [];
      for (const sq of fromSquares(n)) for (const mv of this.movesFrom(n, sq)) {
        if (!ch.has(mv.from) && !ch.has(mv.to)) continue;
        if (!ok(mv)) continue;
        out.push(mv);
      }
      if (o.hid) {
        const col = n.pos.turn === 0 ? 1 : 2, cls = n.cls;
        for (let i = 0; i < 64; i++) {
          if (cls[i] !== col || vis[i]) continue;
          for (const mv of this.movesFrom(n, i)) if (ch.has(mv.to) && okHid(mv)) out.push(mv);
        }
      }
      if (o.arrive) {
        const col = n.pos.turn === 0 ? 1 : 2, cls = n.cls;
        for (let i = 0; i < 64; i++) {
          if (cls[i] !== col || !vis[i] || prob[i * 3 + col] < 0.5) continue;   // источник сеть видит занятым — обычное правило его не берёт
          for (const mv of this.movesFrom(n, i)) {
            const j = mv.to;
            if (ch.has(j) && vis[j] && conf[j] === col && this.obsCls[j] === col && t - this.obsSince[j] >= o.arrive && t - this.obsSince[j] <= o.arrive + o.recent) out.push(mv);
          }
        }
      }
      return out;
    };
    this.beam.forEach((h, hi) => {
      add(h, h.node, []);
      if (now() > tEnd) return;
      const n0 = h.node, ch = changedSet(n0.cls);
      if (!ch.size) return;
      for (const m1 of expand(n0, ch)) {
        const n1 = this.child(n0, m1);
        add(h, n1, [m1]);
        const ch2 = changedSet(n1.cls);
        if (!ch2.size) continue;
        for (const m2 of expand(n1, ch2)) {
          const n2 = this.child(n1, m2);
          add(h, n2, [m1, m2]);
          if (hi >= o.d3) continue;
          // три хода за одно движение руки (Qg3+ Kf1 Qf2#) — только для лучших гипотез
          const ch3 = changedSet(n2.cls);
          if (!ch3.size) continue;
          for (const m3 of expand(n2, ch3)) {
            const n3 = this.child(n2, m3);
            add(h, n3, [m1, m2, m3]);
            if (hi >= o.d4) continue;
            // четыре хода: после паузы (телефон не успел, рука закрыла доску) за доской мог пройти целый размен
            const ch4 = changedSet(n3.cls);
            if (!ch4.size) continue;
            for (const m4 of expand(n3, ch4)) add(h, this.child(n3, m4), [m1, m2, m3, m4]);
          }
        }
      }
      // ход вне очереди: сторона, которая только что ходила, ходит ещё раз (на быстрой игре бывает) —
      // записываем «пропуск хода» соперника и этот ход, иначе трекер начнёт выдумывать ходы
      if (o.passPen && hi < o.passTop && h.moves.length && !h.moves[h.moves.length - 1].pass) {
        const np = this.passNode(n0), pass = { pass: true, color: n0.pos.turn === 0 ? 1 : 2 };
        for (const m1 of expand(np, ch)) {
          const n1 = this.child(np, m1);
          add(h, n1, [pass, m1], o.passPen);
          const ch2 = changedSet(n1.cls);
          if (!ch2.size) continue;
          for (const m2 of expand(n1, ch2)) add(h, this.child(n1, m2), [pass, m1, m2], o.passPen);
        }
      }
    });
    const all = Array.from(cand.values()).sort((a, b) => a.acc - b.acc);
    let beam;
    if (o.div) {
      const by = new Map(), keep = [], rest = [];
      for (const h of all) {
        const n = h.moves.length, cnt = by.get(n) || 0;
        if (cnt < o.div) { by.set(n, cnt + 1); keep.push(h); } else rest.push(h);
      }
      beam = keep.concat(rest).slice(0, o.beam).sort((a, b) => a.acc - b.acc);
    } else beam = all.slice(0, o.beam);
    const base = beam[0].acc;
    for (const h of beam) h.acc -= base;
    this.beam = beam;
    return this.best();
  };

  Tracker.prototype.best = function () { return this.beam[0]; };

  /** Клетки, где последняя проверка уверенно видит не то, что стоит по лучшей гипотезе (индексы 0 = a1 … 63 = h8). */
  Tracker.prototype.mismatch = function (fresh) {
    const b = this.best(), out = [], t = this.lastReadT, win = fresh == null ? 20 : fresh;
    if (!b || !this.lastConf) return out;
    // давняя ошибка сети на клетке (картинка не менялась дольше win с) — не расхождение записи
    for (let i = 0; i < 64; i++) if (this.lastConf[i] >= 0 && this.lastConf[i] !== b.node.cls[i] && t - this.obsSince[i] <= win) out.push(i);
    return out;
  };

  /**
   * Сколько ходов moves[from…] подряд уже подтверждены доской: после того как ход попал в гипотезу,
   * клетку «куда» хоть раз было видно чисто (без руки и без движения) с фигурой ходящего.
   * Пока рука держит фигуру над клеткой, ход в записи не показываем — так не бывает ложных «Исправлено».
   * Следующие ходы ждут предыдущий: запись — всегда начало гипотезы.
   */
  Tracker.prototype.confirmed = function (moves, from, maxHold) {
    const now = this.lastReadT, wait = maxHold == null ? this.o.maxHold : maxHold, margin = this.o.holdMargin;
    // ходы, в которых сходятся все гипотезы, отстающие от лучшей не больше чем на margin
    const near = this.beam.filter(h => h.acc <= margin);
    const agreed = j => near.every(h => h.moves.length > j && h.moves[j].from === moves[j].from && h.moves[j].to === moves[j].to && !h.moves[j].pass === !moves[j].pass);
    let k = from || 0;
    while (k < moves.length) {
      let m = moves[k], n = 1;
      if (m.pass) { if (k + 1 >= moves.length) break; m = moves[k + 1]; n = 2; }   // пропуск — вместе со следующим ходом
      const i = IDX[m.to];
      const clean = this.cleanT[i] >= m.t && this.cleanCls[i] === m.c;
      // доска подтвердила; или ход ждёт дольше wait, и все близкие гипотезы с ним согласны
      if (!(clean || (now != null && now - m.t >= wait && agreed(k) && (n === 1 || agreed(k + 1))))) break;
      k += n;
    }
    return k;
  };

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

  return { Tracker, SQUARES: SQ, DEFAULTS, _movesFromSq: movesFromSq, _fromFen: fromFen, _make: make };
}));
