/*
 * Связь телефона с пультом турнира (control.html через сервер server/server.js).
 * Телефон слушает команды (Server-Sent Events) и раз в секунду сообщает своё состояние.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pult = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clean = s => String(s || '').trim().replace(/\/+$/, '');

  /** Настройки из ссылки record.html#ctl=СЕРВЕР&room=КОД&board=N (остальные параметры — для трансляции). */
  function parseLink(hash) {
    const h = String(hash || '').replace(/^#/, '');
    if (!/(^|&)ctl=/.test(h)) return null;
    const p = new URLSearchParams(h);
    const server = clean(p.get('ctl')), room = (p.get('room') || '').trim(), board = Math.floor(+p.get('board'));
    if (!/^https?:\/\/[^\s]+$/.test(server) || !/^[A-Za-z0-9_-]{4,40}$/.test(room) || !(board >= 1 && board <= 200)) return null;
    return { server, room, board, white: p.get('w') || '', black: p.get('b') || '' };
  }

  /**
   * opts: { server, room, board, onCommand(msg), onLink(state), fetch, EventSource, minGap, poll }
   * Команды приходят двумя путями: поток SSE и ответ на каждую отправку состояния (раз в poll мс) —
   * бесплатный туннель Cloudflare потоки SSE не пропускает. Повторы отсекаются по номеру команды seq;
   * после перезапуска сервера (другой boot) нумерация начинается заново. «Начать» сервер повторяет в каждом
   * ответе (start), пока её не сбросят, — телефон начнёт партию, даже если отдельная команда потерялась.
   * state: 'connecting' | 'online' | 'offline'
   */
  function Pult(opts) {
    this.o = Object.assign({ minGap: 1000, poll: 2000, timeout: 8000 }, opts);
    this.seq = null; this.boot = null; this.startSeq = null;
    this.server = clean(opts.server);
    this.fetch = this.o.fetch || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : globalThis) : null);
    this.ES = this.o.EventSource || (typeof EventSource === 'function' ? EventSource : null);
    this.link = 'off';
    this.pending = null; this.busy = false; this.lastAt = 0; this.timer = null; this.lastSent = ''; this.fails = 0;
  }

  Pult.prototype.setLink = function (s) { if (this.link !== s) { this.link = s; if (this.o.onLink) this.o.onLink(s); } };

  Pult.prototype.connect = function () {
    if (this.es || !this.ES) return;
    const url = this.server + '/board/stream?room=' + encodeURIComponent(this.o.room) + '&board=' + this.o.board;
    this.setLink('connecting');
    const es = this.es = new this.ES(url);
    es.onopen = () => this.setLink('online');
    // EventSource переподключается сам; пока отправки состояния проходят, связь с пультом есть
    es.onerror = () => { if (!(this.okAt && Date.now() - this.okAt < 6000)) this.setLink(es.readyState === 2 ? 'offline' : 'connecting'); };
    es.addEventListener('hello', () => this.setLink('online'));
    es.addEventListener('cmd', e => { let m = null; try { m = JSON.parse(e.data); } catch (err) { return; } this.handle(m); });
  };

  Pult.prototype.handle = function (m) {
    if (!m || typeof m !== 'object') return;
    if (Number.isInteger(m.seq)) { if (this.seq != null && m.seq <= this.seq) return; this.seq = m.seq; }
    if (m.cmd === 'start') this.startSeq = m.seq;
    if (this.o.onCommand) this.o.onCommand(m);
  };

  /** «Начать», которую сервер держит для этой доски: выполняется один раз на каждую новую команду. */
  Pult.prototype.startLevel = function (m) {
    if (!m || m.cmd !== 'start' || m.seq === this.startSeq) return;
    this.startSeq = m.seq;
    if (this.o.onCommand) this.o.onCommand(m);
  };

  Pult.prototype.close = function () {
    if (this.es) { this.es.close(); this.es = null; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.setLink('off');
  };

  /** Новое состояние доски; отправится не чаще раза в minGap мс (urgent — сразу), одинаковое — раз в poll мс (заодно забираем команды). */
  Pult.prototype.status = function (st, urgent) {
    this.pending = st;
    const same = JSON.stringify(st) === this.lastSent, now = Date.now();
    if (same && now - this.lastAt < this.o.poll) return;
    if (this.busy || this.timer) return;
    const wait = urgent ? 0 : Math.max(0, this.lastAt + this.o.minGap - now);
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
  };

  Pult.prototype.flush = function () {
    if (!this.fetch || this.pending == null || this.busy) return;
    const st = this.pending, text = JSON.stringify(st);
    this.pending = null; this.busy = true; this.lastAt = Date.now();
    const body = JSON.stringify(Object.assign({ room: this.o.room, board: this.o.board }, this.seq != null ? { seq: this.seq, boot: this.boot } : {}, st));
    // запрос, который повис в сети, не должен останавливать связь: через timeout мс бросаем его и шлём новый
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let killer = null;
    const hang = new Promise((_, rej) => { killer = setTimeout(() => { if (ctl) ctl.abort(); rej(new Error('timeout')); }, this.o.timeout); });
    Promise.race([this.fetch(this.server + '/board/status', Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, ctl ? { signal: ctl.signal } : {})), hang])
      .then(r => {
        this.lastSent = text;
        this.fails = 0;
        if (r.ok) this.okAt = Date.now();
        this.setLink(r.ok ? 'online' : 'offline');
        return r.ok && r.json ? r.json().catch(() => null) : null;
      })
      .then(j => {
        if (!j) return;
        if (!Array.isArray(j.cmds)) {
          // старый server.js (до версии 23) не присылает команды в ответе — хотя бы «начать» по флагу started
          if (j.started && !this.oldStart) this.handle({ cmd: 'start', data: {} });
          this.oldStart = !!j.started;
          return;
        }
        if (j.boot && j.boot !== this.boot) { this.boot = j.boot; this.seq = null; }   // сервер перезапущен — нумерация заново
        j.cmds.forEach(m => this.handle(m));
        if (Number.isInteger(j.seq)) this.seq = Math.max(this.seq || 0, j.seq);   // все команды этой доски до j.seq уже получены
        if (j.start) this.startLevel(j.start);
      })
      .catch(() => { if (this.pending == null) this.pending = st; if (++this.fails >= 3) this.setLink('offline'); })
      .then(() => { clearTimeout(killer); this.busy = false; if (this.pending != null) this.status(this.pending); });
  };

  return { Pult, parseLink };
}));
