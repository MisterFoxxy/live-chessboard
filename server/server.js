/*
 * Пульт турнира: сервер-посредник между ноутбуком организатора (control.html) и телефонами на досках (record.html).
 * Без сторонних библиотек: node server.js (порт — переменная PORT, по умолчанию 8080).
 *
 * Комната турнира — код room и секретный ключ организатора key (их придумывает страница пульта).
 * Телефон доски N:  GET  /board/stream?room=R&board=N   — поток команд (Server-Sent Events)
 *                   POST /board/status {room, board, …}  — состояние: камера, доска найдена, запись, ходы
 * Организатор:      POST /room {room, key, name, boards}  — создать комнату (или войти в свою)
 *                   GET  /room/stream?room=R&key=K       — поток состояний всех досок
 *                   POST /room/cmd {room, key, cmd, boards, data} — команда доскам (start, show, finish…)
 * Всё хранится в памяти; комната, в которую сутки никто не заходил, удаляется.
 */
'use strict';
const http = require('http');
const VERSION = 25;
const BOOT = Math.random().toString(36).slice(2, 10);   // новый при каждом запуске: телефон сбрасывает нумерацию команд   // пульт сверяет: старый server.js не умеет передавать команды через бесплатный туннель
const PORT = +(process.env.PORT || 8080);
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_ROOMS = 500, MAX_BOARDS = 200, MAX_BODY = 32 * 1024, ROOM_TTL = 24 * 3600 * 1000;

const rooms = new Map(); // room → { key, name, boards: Map(n → state), started: Map(n → {cmd, data, at, seq}), log: Map(n → [msg]), seq, org: Set(res), phones: Map(n → Set(res)), seen }
// Бесплатный туннель Cloudflare (trycloudflare.com) не пропускает потоки Server-Sent Events,
// поэтому всё работает и без них: телефон забирает команды в ответе на /board/status, пульт опрашивает /room.
const ONLINE_MS = 15000;

const okRoom = s => typeof s === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(s);
const okKey = s => typeof s === 'string' && /^[A-Za-z0-9_-]{12,80}$/.test(s);
const okBoard = n => Number.isInteger(n) && n >= 1 && n <= MAX_BOARDS;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function sse(res) {
  cors(res);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
}
const send = (res, type, obj) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* соединение закрыто */ } };

function room(id) {
  const r = rooms.get(id);
  if (r) r.seen = Date.now();
  return r;
}
function boardList(r) {
  const out = [];
  for (const [n, st] of r.boards) out.push(Object.assign({ board: n, online: online(r, n, st), started: r.started.has(n) }, st, { ago: Math.round((Date.now() - st.at) / 1000) }));
  return out.sort((a, b) => a.board - b.board);
}
// на связи — значит, состояние приходило недавно (поток SSE через туннель может «висеть», не доставляя ничего)
function online(r, n, st) { return st ? Date.now() - st.at < ONLINE_MS : (r.phones.get(n) || new Set()).size > 0; }
function toOrg(r, type, obj) { for (const res of r.org) send(res, type, obj); }

// Поток данных каждые 15 с — прокси не закрывают «молчащие» соединения
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (now - r.seen > ROOM_TTL && !r.org.size) { rooms.delete(id); continue; }
    for (const res of r.org) { try { res.write(': ping\n\n'); } catch (e) { /* */ } }
    for (const set of r.phones.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch (e) { /* */ } }
  }
}, 15000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, version: VERSION, rooms: rooms.size });

    if (req.method === 'POST' && url.pathname === '/room') {
      const b = await body(req);
      if (!okRoom(b.room) || !okKey(b.key)) return json(res, 400, { error: 'неверный код комнаты или ключ' });
      let r = room(b.room);
      if (r && r.key !== b.key) return json(res, 403, { error: 'комната занята другим организатором' });
      if (!r) {
        if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'сервер заполнен' });
        r = { key: b.key, name: '', boards: new Map(), started: new Map(), log: new Map(), seq: 0, org: new Set(), phones: new Map(), seen: Date.now() };
        rooms.set(b.room, r);
      }
      if (typeof b.name === 'string') r.name = b.name.slice(0, 120);
      return json(res, 200, { ok: true, version: VERSION, boards: boardList(r) });
    }

    if (req.method === 'GET' && url.pathname === '/room/stream') {
      const r = room(q.get('room'));
      if (!r || r.key !== q.get('key')) return json(res, 403, { error: 'нет такой комнаты или неверный ключ' });
      sse(res);
      r.org.add(res);
      send(res, 'boards', boardList(r));
      req.on('close', () => r.org.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/room/cmd') {
      const b = await body(req);
      const r = room(b.room);
      if (!r || r.key !== b.key) return json(res, 403, { error: 'нет такой комнаты или неверный ключ' });
      if (typeof b.cmd !== 'string' || !/^[a-z]{2,20}$/.test(b.cmd)) return json(res, 400, { error: 'неверная команда' });
      const targets = Array.isArray(b.boards) ? b.boards.filter(okBoard) : [];
      const data = b.data && typeof b.data === 'object' ? b.data : {};
      let delivered = 0;
      for (const n of targets) {
        const per = Object.assign({}, data, data.perBoard && data.perBoard[n] ? data.perBoard[n] : {});
        delete per.perBoard;
        const msg = { cmd: b.cmd, data: per, at: Date.now(), seq: ++r.seq };
        if (!r.log.has(n)) r.log.set(n, []);
        const log = r.log.get(n); log.push(msg); if (log.length > 20) log.shift();
        if (b.cmd === 'start') r.started.set(n, msg);          // поздно подключившийся телефон тоже получит «начать»
        if (b.cmd === 'reset') r.started.delete(n);
        const set = r.phones.get(n);
        if (set) for (const p of set) { send(p, 'cmd', msg); delivered++; }
      }
      toOrg(r, 'boards', boardList(r));
      return json(res, 200, { ok: true, delivered });
    }

    if (req.method === 'GET' && url.pathname === '/board/stream') {
      const r = room(q.get('room')), n = +q.get('board');
      if (!r || !okBoard(n)) return json(res, 404, { error: 'нет такой комнаты' });
      sse(res);
      if (!r.phones.has(n)) r.phones.set(n, new Set());
      r.phones.get(n).add(res);
      send(res, 'hello', { name: r.name, board: n });
      if (r.started.has(n)) send(res, 'cmd', r.started.get(n));
      toOrg(r, 'boards', boardList(r));
      req.on('close', () => { const s = r.phones.get(n); if (s) s.delete(res); toOrg(r, 'boards', boardList(r)); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/board/status') {
      const b = await body(req);
      const r = room(b.room), n = b.board;
      if (!r || !okBoard(n)) return json(res, 404, { error: 'нет такой комнаты' });
      const keep = ['phase', 'go', 'ok', 'text', 'plies', 'last', 'fen', 'white', 'black', 'result', 'battery', 'version', 'warn', 'pieces', 'bc'];
      const st = { at: Date.now() };
      for (const k of keep) if (b[k] !== undefined) st[k] = typeof b[k] === 'string' ? b[k].slice(0, 200) : b[k];
      if (r.boards.size >= MAX_BOARDS && !r.boards.has(n)) return json(res, 503, { error: 'слишком много досок' });
      r.boards.set(n, st);
      toOrg(r, 'board', Object.assign({ board: n, online: true, started: r.started.has(n) }, st));
      // команды, которых телефон ещё не видел (seq — номер последней полученной); новый телефон получает только «начать»
      const seen = b.boot === BOOT && Number.isInteger(b.seq) && b.seq >= 0 && b.seq <= r.seq ? b.seq : null;
      const cmds = seen == null ? (r.started.has(n) ? [r.started.get(n)] : []) : (r.log.get(n) || []).filter(m => m.seq > seen);
      return json(res, 200, { ok: true, version: VERSION, boot: BOOT, started: r.started.has(n), start: r.started.get(n) || null, seq: r.seq, cmds });
    }

    json(res, 404, { error: 'не найдено' });
  } catch (e) {
    json(res, 400, { error: 'неверный запрос' });
  }
});

if (require.main === module) server.listen(PORT, () => console.log('Пульт турнира: порт ' + PORT));
module.exports = { server, rooms, VERSION };
