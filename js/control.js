/*
 * Пульт турнира (control.html): ноутбук организатора видит все доски и начинает партии.
 * Связь — через сервер server/server.js (адрес вводит организатор).
 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rnd = n => { const a = new Uint8Array(n), abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; crypto.getRandomValues(a); return Array.from(a, x => abc[x % abc.length]).join(''); };
  const fetchJ = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || ('ошибка ' + r.status)); return j; }));

  const VER = 24;          // версия приложения: ссылки телефонов с ?v= не берут из кэша старую страницу
  const NEED_SERVER = 23;  // server.js старше не передаёт команды через бесплатный туннель Cloudflare
  let T = null;            // { server, room, key, name, boards, pairs: [[w, b]], bc: {round, token, per} }
  let es = null, poll = null;
  const boards = {};       // n → состояние от телефона

  const PHASE = {
    offline: ['', 'телефон не на связи'], search: ['search', 'ищет доску'], ready: ['ready', 'доска найдена — готова'],
    pending: ['search', '«Начать» отправлена — телефон ещё не ответил'],
    started: ['rec', 'начата, ждёт первого хода'], recording: ['rec', 'идёт запись'], finished: ['done', 'партия закончена'], error: ['err', 'ошибка'],
  };

  function parsePairs(text) {
    return String(text || '').split(/\n/).map(l => l.trim()).map(l => { const m = l.split(/\s+[–—-]\s+|\s*\t\s*/); return [(m[0] || '').trim(), (m[1] || '').trim()]; });
  }

  function phoneLink(n) {
    const base = location.origin + location.pathname.replace(/control\.html$/, '') + 'record.html?v=' + VER;
    const p = new URLSearchParams();
    p.set('ctl', T.server); p.set('room', T.room); p.set('board', String(n));
    const pair = T.pairs[n - 1] || [];
    if (pair[0]) p.set('w', pair[0]);
    if (pair[1]) p.set('b', pair[1]);
    if (T.bc && T.bc.round && T.bc.token) {
      const m = String(T.bc.round).match(/([A-Za-z0-9]{8})\/?$/);
      if (m) { p.set('bc', m[1]); p.set('lt', T.bc.token); p.set('boards', String(T.bc.per || T.boards)); }
    }
    return base + '#' + p.toString().replace(/%2F/g, '/').replace(/%3A/g, ':');
  }

  function renderLinks() {
    const box = $('#links');
    box.innerHTML = '';
    for (let n = 1; n <= T.boards; n++) {
      const url = phoneLink(n), pair = T.pairs[n - 1] || [];
      const d = document.createElement('div');
      d.className = 'qr';
      let img = '';
      try { const q = window.qrcode(0, 'L'); q.addData(url); q.make(); img = q.createImgTag(4, 8); } catch (e) { img = '<p>QR не построен</p>'; }
      d.innerHTML = `<b>Доска ${n}</b>${pair[0] || pair[1] ? '<br>' + esc(pair[0]) + ' – ' + esc(pair[1]) : ''}${img}<a href="${esc(url)}" target="_blank" rel="noopener">ссылка</a>`;
      box.appendChild(d);
    }
  }

  function mini(fen) {
    const place = String(fen || '').split(' ')[0];
    const rows = place.split('/');
    if (rows.length !== 8) return '<div class="mini"></div>';
    let html = '<div class="mini">';
    rows.forEach((row, r) => {
      let c = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) { for (let k = 0; k < +ch; k++, c++) html += `<div class="${(r + c) % 2 ? 'd' : 'l'}"></div>`; continue; }
        const p = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
        html += `<div class="${(r + c) % 2 ? 'd' : 'l'}"><img src="img/chesspieces/cburnett/${p}.svg" alt=""></div>`;
        c++;
      }
    });
    return html + '</div>';
  }

  function stateOf(b) {
    if (!b || !b.online) return 'offline';
    if (b.started && !b.go && (b.phase === 'ready' || b.phase === 'search' || !b.phase)) return 'pending';
    return b.phase || 'search';
  }

  function renderBoards() {
    const box = $('#boards');
    let ready = 0, rec = 0, online = 0;
    const html = [];
    for (let n = 1; n <= T.boards; n++) {
      const b = boards[n] || {}, st = stateOf(b), [cls, text] = PHASE[st] || ['', st];
      if (st !== 'offline') online++;
      if (st === 'ready') ready++;
      if (st === 'recording' || st === 'started') rec++;
      const pair = T.pairs[n - 1] || [];
      const w = b.white || pair[0] || 'Белые', bl = b.black || pair[1] || 'Чёрные';
      const pv = parseInt(b.version, 10);
      const old = st !== 'offline' && b.version && pv < VER
        ? `<div class="warn">⚠ На телефоне старая версия ${pv}: закройте вкладку и снова откройте ссылку доски (QR-код).</div>` : '';
      html.push(`<div class="bd" data-n="${n}">
        <div class="top"><span class="dot ${cls}"></span><span class="num">${n}</span><span class="st">${esc(text)}${b.battery ? ' · 🔋' + esc(b.battery) + '%' : ''}</span></div>
        <div class="names">${esc(w)} – ${esc(bl)}${b.version ? ' <span class="muted">· v' + esc(pv) + '</span>' : ''}</div>${old}
        ${mini(b.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR')}
        <div class="moves">${b.plies ? 'полуходов ' + b.plies + (b.last ? ' · …' + esc(b.last) : '') : (st === 'search' && b.text ? esc(b.text).slice(0, 80) : '')}</div>
        <div class="acts"><button data-act="start" ${st === 'offline' ? 'disabled' : ''}>▶ Начать</button><button data-act="show" ${st === 'offline' ? 'disabled' : ''}>Диаграмма</button><button data-act="reset" ${st === 'offline' ? 'disabled' : ''}>Сброс</button></div>
      </div>`);
    }
    box.innerHTML = html.join('');
    $('#summary').textContent = `на связи ${online} из ${T.boards} · готовы ${ready} · идёт запись ${rec}`;
    $('#startReady').textContent = `▶ Начать все готовые (${ready})`;
    $('#startReady').disabled = !ready;
  }

  function command(cmd, list, data) {
    const perBoard = {};
    if (cmd === 'start') for (const n of list) { const p = T.pairs[n - 1] || []; if (p[0] || p[1]) perBoard[n] = { white: p[0], black: p[1] }; }
    return fetchJ(T.server + '/room/cmd', { room: T.room, key: T.key, cmd, boards: list, data: Object.assign({ perBoard }, data || {}) })
      .then(j => { refresh(); return j; })
      .catch(e => alert('Не получилось: ' + e.message));
  }

  function serverVersion(j) {
    const v = +j.version || 0, el = $('#srvWarn');
    el.hidden = v >= NEED_SERVER;
    if (v < NEED_SERVER) el.innerHTML = `⚠ <b>На ноутбуке запущен старый server.js${v ? ' (версия ' + v + ')' : ''}.</b> Через бесплатный адрес trycloudflare.com он не передаёт телефонам команду «Начать». `
      + 'Скачайте server.js заново (ссылка в инструкции), в окне сервера нажмите Ctrl+C и снова запустите <code>node server.js</code>. Окно cloudflared можно не трогать.';
  }

  // Бесплатный туннель Cloudflare не пропускает поток событий — поэтому пульт ещё и опрашивает сервер каждые 2 с
  function refresh() {
    if (!T) return;
    fetchJ(T.server + '/room', { room: T.room, key: T.key, name: T.name, boards: T.boards }).then(j => {
      serverVersion(j);
      for (const k in boards) delete boards[k];
      (j.boards || []).forEach(b => { boards[b.board] = b; });
      renderBoards();
      $('#link').textContent = '● на связи с сервером'; $('#link').style.color = 'var(--green)';
    }).catch(() => { $('#link').textContent = 'нет связи с сервером — повторяю…'; $('#link').style.color = 'var(--red)'; });
  }

  function connect() {
    if (es) es.close();
    if (poll) clearInterval(poll);
    poll = setInterval(refresh, 2000);
    $('#link').textContent = 'подключаюсь…';
    fetchJ(T.server + '/room', { room: T.room, key: T.key, name: T.name, boards: T.boards }).then(j => {
      serverVersion(j);
      (j.boards || []).forEach(b => { boards[b.board] = b; });
      renderBoards();
      es = new EventSource(T.server + '/room/stream?room=' + encodeURIComponent(T.room) + '&key=' + encodeURIComponent(T.key));
      es.onopen = () => { $('#link').textContent = '● на связи с сервером'; $('#link').style.color = 'var(--green)'; };
      es.addEventListener('boards', e => { const list = JSON.parse(e.data); for (const k in boards) delete boards[k]; list.forEach(b => { boards[b.board] = b; }); renderBoards(); });
      es.addEventListener('board', e => { const b = JSON.parse(e.data); boards[b.board] = Object.assign(boards[b.board] || {}, b); renderBoards(); });
    }).catch(e => { $('#link').textContent = 'сервер не отвечает: ' + e.message; $('#link').style.color = 'var(--red)'; });
  }

  function openTournament(t) {
    T = t;
    store.set('vc_ctl_tournament', T);
    $('#tName').textContent = T.name ? '· ' + T.name : '';
    $('#boardsCard').hidden = false;
    $('#linksCard').hidden = false;
    $('#setupInfo').textContent = `Код турнира ${T.room}. Ключ организатора хранится на этом ноутбуке.`;
    renderLinks();
    renderBoards();
    connect();
  }

  function readForm() {
    const server = $('#server').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/\S+$/.test(server)) { $('#setupInfo').textContent = 'Укажите адрес сервера пульта (https://…).'; return null; }
    const n = Math.max(1, Math.min(200, Math.floor(+$('#nBoards').value) || 1));
    return { server, name: $('#name').value.trim(), boards: n, pairs: parsePairs($('#pairs').value),
      bc: { round: $('#bcRound').value.trim(), token: $('#bcToken').value.trim(), per: Math.floor(+$('#bcPer').value) || 0 } };
  }

  $('#create').addEventListener('click', () => {
    const f = readForm();
    if (!f) return;
    openTournament(Object.assign(f, { room: rnd(8), key: rnd(24) }));
  });
  $('#open').addEventListener('click', () => {
    const t = store.get('vc_ctl_tournament', null);
    if (!t) { $('#setupInfo').textContent = 'Сохранённого турнира нет — создайте новый.'; return; }
    const f = readForm();
    // поля формы (пары, число досок, трансляция) можно поправить и открыть тот же турнир
    if (f && f.server === t.server) Object.assign(t, { name: f.name || t.name, boards: f.boards, pairs: f.pairs.some(p => p[0] || p[1]) ? f.pairs : t.pairs, bc: f.bc.round ? f.bc : t.bc });
    openTournament(t);
  });
  $('#boards').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const n = +btn.closest('.bd').dataset.n, act = btn.dataset.act;
    if (act === 'start') command('start', [n]);
    if (act === 'show') command('show', [n], { on: true });
    if (act === 'reset' && confirm(`Сбросить старт на доске ${n}? Телефон перестанет записывать ходы до новой команды «Начать».`)) command('reset', [n]);
  });
  const all = () => Array.from({ length: T.boards }, (_, i) => i + 1);
  $('#startReady').addEventListener('click', () => command('start', all().filter(n => stateOf(boards[n]) === 'ready')));
  $('#startAll').addEventListener('click', () => {
    const on = all().filter(n => stateOf(boards[n]) !== 'offline');
    const notReady = on.filter(n => stateOf(boards[n]) !== 'ready' && stateOf(boards[n]) !== 'recording' && stateOf(boards[n]) !== 'started');
    if (notReady.length && !confirm(`Доски ${notReady.join(', ')} ещё не нашли начальную позицию. Начать все равно?`)) return;
    command('start', on);
  });
  $('#showAll').addEventListener('click', () => command('show', all(), { on: true }));
  $('#resetAll').addEventListener('click', () => { if (confirm('Сбросить старт на всех досках?')) command('reset', all()); });
  $('#print').addEventListener('click', () => window.print());
  setInterval(() => { if (T) renderBoards(); }, 5000);   // «не на связи», если телефон давно молчит

  // форма: последние настройки
  const last = store.get('vc_ctl_tournament', null);
  if (last) {
    $('#server').value = last.server || ''; $('#name').value = last.name || ''; $('#nBoards').value = last.boards || 10;
    $('#pairs').value = (last.pairs || []).map(p => (p[0] || p[1]) ? `${p[0]} – ${p[1]}` : '').join('\n').replace(/\n+$/, '');
    if (last.bc) { $('#bcRound').value = last.bc.round || ''; $('#bcToken').value = last.bc.token || ''; $('#bcPer').value = last.bc.per || ''; }
  }
  window.vcControl = { get T() { return T; }, boards, phoneLink, command };
})();
