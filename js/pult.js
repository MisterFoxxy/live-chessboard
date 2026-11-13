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
   * opts: { server, room, board, onCommand(msg), onLink(state), fetch, EventSource, minGap }
   * state: 'connecting' | 'online' | 'offline'
   */
  function Pult(opts) {
    this.o = Object.assign({ minGap: 1000 }, opts);
    this.server = clean(opts.server);
    this.fetch = this.o.fetch || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : globalThis) : null);
    this.ES = this.o.EventSource || (typeof EventSource === 'function' ? EventSource : null);
    this.link = 'off';
    this.pending = null; this.busy = false; this.lastAt = 0; this.timer = null; this.lastSent = '';
  }

  Pult.prototype.setLink = function (s) { if (this.link !== s) { this.link = s; if (this.o.onLink) this.o.onLink(s); } };

  Pult.prototype.connect = function () {
    if (this.es || !this.ES) return;
    const url = this.server + '/board/stream?room=' + encodeURIComponent(this.o.room) + '&board=' + this.o.board;
    this.setLink('connecting');
    const es = this.es = new this.ES(url);
    es.onopen = () => this.setLink('online');
    es.onerror = () => this.setLink(es.readyState === 2 ? 'offline' : 'connecting');   // EventSource переподключается сам
    es.addEventListener('hello', () => this.setLink('online'));
    es.addEventListener('cmd', e => { let m = null; try { m = JSON.parse(e.data); } catch (err) { return; } if (this.o.onCommand) this.o.onCommand(m); });
  };

  Pult.prototype.close = function () {
    if (this.es) { this.es.close(); this.es = null; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.setLink('off');
  };

  /** Новое состояние доски; отправится не чаще раза в minGap мс (urgent — сразу), одинаковое — раз в 10 с. */
  Pult.prototype.status = function (st, urgent) {
    this.pending = st;
    const same = JSON.stringify(st) === this.lastSent, now = Date.now();
    if (same && now - this.lastAt < 10000) return;
    if (this.busy || this.timer) return;
    const wait = urgent ? 0 : Math.max(0, this.lastAt + this.o.minGap - now);
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
  };

  Pult.prototype.flush = function () {
    if (!this.fetch || this.pending == null || this.busy) return;
    const st = this.pending, text = JSON.stringify(st);
    this.pending = null; this.busy = true; this.lastAt = Date.now();
    const body = JSON.stringify(Object.assign({ room: this.o.room, board: this.o.board }, st));
    this.fetch(this.server + '/board/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
      .then(r => { this.lastSent = text; if (r.ok && this.link !== 'online' && this.es && this.es.readyState === 1) this.setLink('online'); })
      .catch(() => { if (this.pending == null) this.pending = st; })
      .then(() => { this.busy = false; if (this.pending != null) this.status(this.pending); });
  };

  return { Pult, parseLink };
}));
