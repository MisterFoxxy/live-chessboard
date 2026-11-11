/*
 * Трансляция партии на lichess (lichess.org/broadcast): каждый телефон отправляет PGN своей доски
 * в общий раунд трансляции. Для 30 досок — 30 телефонов и один раунд.
 *
 * Как lichess принимает партии (исходники lila, modules/relay: RelayPush, RelayUpdatePlan):
 *  - POST /api/broadcast/round/{id}/push с PGN в теле и токеном со скоупом study:write;
 *  - партия попадает в главу раунда с тем же тегом GameId — остальные доски не трогаются,
 *    поэтому телефоны могут отправлять свои партии независимо;
 *  - если запись исправлена задним числом, старые ходы lichess оставит вариантом, а основной
 *    линией станет новая запись;
 *  - предел: 120 отправок в минуту на аккаунт (на все телефоны с токеном этого аккаунта).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveBroadcast = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API = 'https://lichess.org';
  const PUSHES_PER_MIN = 120;

  /** ID раунда из ссылки lichess.org/broadcast/турнир/раунд/ID (или просто ID из 8 знаков). */
  function roundId(s) {
    s = String(s || '').trim();
    if (/^[A-Za-z0-9]{8}$/.test(s)) return s;
    const m = s.match(/lichess\.org\/broadcast\/(?:[^/?#]+\/){2}([A-Za-z0-9]{8})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }

  /** Сколько секунд держать между отправками, если с одного аккаунта транслируются boards досок. */
  function minInterval(boards) {
    const n = Math.max(1, Math.floor(+boards || 1));
    return Math.max(2, Math.ceil(n * 60 / PUSHES_PER_MIN));
  }

  /**
   * Отправляет последнюю версию PGN не чаще раза в interval секунд; при ошибках повторяет.
   * opts: { round, token, interval (с), fetch, now, setTimeout, clearTimeout, onStatus(st) }
   * st: { state: 'idle'|'wait'|'sending'|'ok'|'error'|'denied', text, plies, at }
   */
  function Pusher(opts) {
    this.o = Object.assign({ interval: 2 }, opts);
    this.fetch = this.o.fetch || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : globalThis) : null);
    this.now = this.o.now || (() => Date.now());
    this.st = this.o.setTimeout || ((f, ms) => setTimeout(f, ms));
    this.ct = this.o.clearTimeout || (id => clearTimeout(id));
    this.pending = null;   // PGN, который ещё не отправлен
    this.sent = null;      // последний принятый lichess PGN
    this.busy = false;
    this.timer = null;
    this.lastAt = -1e15;   // время последней отправки, мс
    this.backoff = 0;      // пауза после ошибки, мс
    this.stopped = false;
  }

  Pusher.prototype.status = function (state, text, extra) {
    this.state = state;
    if (this.o.onStatus) this.o.onStatus(Object.assign({ state, text }, extra || {}));
  };

  /** Новая версия партии. Отправится сразу или как только позволит предел частоты. */
  Pusher.prototype.update = function (pgn) {
    if (this.stopped || pgn === this.sent) { this.pending = null; return; }
    this.pending = pgn;
    this.schedule();
  };

  /** Отправить без ожидания интервала (конец партии); если идёт отправка — сразу после неё. */
  Pusher.prototype.flush = function () {
    if (this.stopped || this.pending == null) return;
    this.urgent = true;
    if (this.timer) { this.ct(this.timer); this.timer = null; }
    this.schedule();
  };

  Pusher.prototype.stop = function () {
    this.stopped = true;
    if (this.timer) this.ct(this.timer);
    this.timer = null;
  };

  Pusher.prototype.schedule = function () {
    if (this.busy || this.timer || this.pending == null) return;
    const wait = this.urgent ? 0 : Math.max(0, this.lastAt + Math.max(this.o.interval * 1000, this.backoff) - this.now());
    if (wait > 0) this.status('wait', 'отправлю через ' + Math.ceil(wait / 1000) + ' с');
    this.timer = this.st(() => { this.timer = null; this.send(); }, wait);
  };

  Pusher.prototype.send = function () {
    if (this.stopped || this.busy || this.pending == null) return;
    if (!this.fetch) { this.status('error', 'браузер не умеет отправлять запросы'); return; }
    const pgn = this.pending;
    this.pending = null;
    this.urgent = false;
    this.busy = true;
    this.lastAt = this.now();
    this.status('sending', 'отправляю…');
    const done = () => { this.busy = false; this.schedule(); };
    const retry = (text, ms) => {
      if (this.pending == null) this.pending = pgn; // новее ничего нет — повторим этот же
      this.backoff = ms;
      this.status('error', text);
      done();
    };
    this.fetch(API + '/api/broadcast/round/' + encodeURIComponent(this.o.round) + '/push', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.o.token, 'Content-Type': 'text/plain; charset=utf-8' },
      body: pgn,
    }).then(r => r.text().then(body => ({ r, body })), err => ({ err })).then(({ r, body, err }) => {
      if (err || !r) return retry('нет связи, повторю', this.nextBackoff());
      if (r.status === 401 || r.status === 403) {
        this.pending = this.pending == null ? pgn : this.pending;
        this.busy = false;
        this.status('denied', r.status === 401 ? 'токен не подходит (нужен скоуп study:write)' : 'нет прав на эту трансляцию (добавьте аккаунт в участники трансляции)');
        return;
      }
      if (r.status === 404) { this.busy = false; this.status('denied', 'раунд не найден — проверьте ссылку'); return; }
      if (r.status === 429) return retry('lichess просит реже — подожду минуту', 60000);
      if (!r.ok) return retry('ошибка lichess ' + r.status + ', повторю', this.nextBackoff());
      let j = null;
      try { j = JSON.parse(body); } catch (e) { /* не JSON */ }
      const g = j && Array.isArray(j.games) ? j.games[0] : null;
      if (g && g.error) { this.busy = false; this.sent = pgn; this.status('error', 'lichess не принял партию: ' + g.error); this.schedule(); return; }
      this.backoff = 0;
      this.sent = pgn;
      this.status('ok', 'отправлено', { plies: g && g.moves != null ? g.moves : null, at: this.now() });
      done();
    });
  };

  Pusher.prototype.nextBackoff = function () {
    return Math.min(60000, Math.max(5000, (this.backoff || 2500) * 2));
  };

  /** Проверка токена и раунда: { user, round, tour } или исключение с понятным текстом. */
  async function check(round, token, fetchFn) {
    const f = fetchFn || fetch;
    const who = await f(API + '/api/account', { headers: { Authorization: 'Bearer ' + token } });
    if (who.status === 401) throw new Error('токен не подходит');
    if (!who.ok) throw new Error('lichess ответил ' + who.status);
    const user = (await who.json()).username;
    // раунд читаем без токена: для чтения трансляции lichess требует другой скоуп, а открытый раунд виден всем
    const rr = await f(API + '/api/broadcast/-/-/' + encodeURIComponent(round));
    if (rr.status === 404) throw new Error('раунд не найден');
    if (!rr.ok) throw new Error('lichess ответил ' + rr.status);
    const j = await rr.json();
    return { user, round: j.round && j.round.name, tour: j.tour && j.tour.name };
  }

  /**
   * Теги PGN для доски трансляции. GameId связывает отправки телефона с его главой раунда;
   * game — метка партии (время начала), чтобы следующая партия на той же доске не затёрла предыдущую.
   */
  function tags(h, board, game) {
    const n = Math.max(1, Math.floor(+board || 1));
    return {
      Board: String(n),
      GameId: 'board-' + n + (game ? '-' + game : ''),
      White: h.white || 'Доска ' + n + ', белые',
      Black: h.black || 'Доска ' + n + ', чёрные',
    };
  }

  return { roundId, minInterval, Pusher, check, tags, API, PUSHES_PER_MIN };
}));
