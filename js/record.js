/*
 * Запись живой партии камерой телефона.
 * Экран «Сейчас» → «Запись» (Экран / Доска) → «Партия записана» (PGN).
 */
(function () {
  'use strict';

  const BV = window.BoardVision;
  if (typeof Chess === 'undefined' || !BV) {
    document.body.innerHTML = '<p style="padding:24px;color:#fff">Не удалось загрузить скрипты. Проверьте интернет и обновите страницу.</p>';
    return;
  }

  /* ---------- Константы и утилиты ---------- */

  const TICK_MS = 100;
  const PROC_W = 640;
  const SAMPLE_OPTS = { samples: 8, margin: 0.12, dropNear: 0.3 };
  const DEFAULT_CORNERS = [[0.25, 0.06], [0.75, 0.06], [0.75, 0.94], [0.25, 0.94]];
  const PIECE = p => `img/chesspieces/wikipedia/${p}.png`;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp01 = v => Math.min(1, Math.max(0, v));

  function validCorners(c) {
    return Array.isArray(c) && c.length === 4 &&
      c.every(p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && v >= 0 && v <= 1)) ? c : null;
  }

  let toastTimer = null;
  function toast(text, ms) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

  let audioCtx = null;
  function initAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { audioCtx = null; }
  }
  function feedback() {
    if (!settings.sound) return;
    try {
      if (audioCtx) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.08, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(); o.stop(audioCtx.currentTime + 0.12);
      }
    } catch (e) { /* ignore */ }
    if (navigator.vibrate) navigator.vibrate(35);
  }

  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* не критично */ }
  }
  function releaseAwake() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  /* ---------- Настройки ---------- */

  const settings = Object.assign(
    { threshold: 14, settleMs: 700, sound: true, heatmap: false },
    store.get('vc_settings', {}));
  const saveSettings = () => store.set('vc_settings', settings);

  /* ---------- Состояние ---------- */

  const video = $('#video');
  const overlay = $('#overlay');
  const camWrap = $('#camWrap');
  const proc = document.createElement('canvas');
  const pctx = proc.getContext('2d', { willReadFrequently: true });
  const tracker = new BV.MotionTracker({ settleMs: settings.settleMs });
  const debugLog = [];
  const motionLog = [];

  const S = {
    source: null,          // 'camera' | 'file'
    stream: null,
    phase: 'idle',         // idle | setup | ready | recording | finished
    corners: (validCorners(store.get('vc_corners')) || DEFAULT_CORNERS).map(p => p.slice()),
    k: store.get('vc_k', 0) & 3,
    kManual: false,
    H: null,
    plan: null,
    occ: null,
    occK: -1,
    badQuad: false,
    tickMs: 0,
    recog: null,
    recogStreak: 0,
    recognizedAt: 0,
    lastRecogAt: 0,
    chess: new Chess(),
    times: [],
    startedAt: null,
    ref: null,
    changes: null,
    handOver: false,
    warn: null,
    error: null,
    flipped: false,
    selected: null,
    promo: null,
    lastMove: [],
    headers: {},
    timer: null,
    drag: null,
    autoplay: false,
  };

  /* ---------- Экраны и вкладки ---------- */

  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
    window.scrollTo(0, 0);
  }

  function switchTab(tab) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $('#panelScreen').classList.toggle('active', tab === 'screen');
    $('#panelBoard').classList.toggle('active', tab === 'board');
    $('#screenRecord').classList.toggle('board-mode', tab === 'board');
    layoutCam();
    if (tab === 'board') renderBoard();
  }
  const isBoardMode = () => $('#screenRecord').classList.contains('board-mode');

  /* ---------- Форма партии ---------- */

  const FORM_FIELDS = { event: 'fEvent', site: 'fSite', round: 'fRound', time: 'fTime', white: 'fWhite', black: 'fBlack', whiteElo: 'fWhiteElo', blackElo: 'fBlackElo' };

  function readForm() {
    const h = {};
    for (const key in FORM_FIELDS) h[key] = $('#' + FORM_FIELDS[key]).value.trim();
    return h;
  }
  function fillForm(h) {
    for (const key in FORM_FIELDS) if (h && h[key] != null) $('#' + FORM_FIELDS[key]).value = h[key];
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }) +
      ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- Сохранённые партии ---------- */

  function renderSaved() {
    const games = store.get('vc_games', []);
    const box = $('#savedList');
    if (!games.length) { box.innerHTML = '<p class="empty">Пока нет сохранённых партий.</p>'; return; }
    box.innerHTML = games.map(g => `
      <div class="saved-item" data-id="${g.id}">
        <div class="info">
          <b>${esc(g.white)} – ${esc(g.black)} · ${esc(g.result)}</b>
          <small>${esc(new Date(g.id).toLocaleString('ru-RU'))} · ${g.plies} пол.</small>
        </div>
        <button data-act="download" aria-label="Скачать">⬇</button>
        <button data-act="copy" aria-label="Копировать">⧉</button>
        <button data-act="delete" aria-label="Удалить">✕</button>
      </div>`).join('');
  }

  function renderResume() {
    const cur = store.get('vc_current', null);
    const has = cur && Array.isArray(cur.moves) && cur.moves.length > 0;
    $('#resumeBanner').hidden = !has;
    if (has) {
      const h = cur.headers || {};
      $('#resumeInfo').textContent = `${h.white || 'Белые'} – ${h.black || 'Чёрные'}, ${cur.moves.length} пол.`;
    }
  }

  function autosave() {
    if (S.phase === 'finished') return;
    store.set('vc_current', {
      headers: S.headers, moves: S.chess.history(), times: S.times,
      startedAt: S.startedAt, savedAt: Date.now(),
    });
  }

  /* ---------- Камера / видео ---------- */

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Браузер не даёт доступ к камере. Откройте страницу по https:// в Safari или Chrome.');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (e) {
      if (e && e.name === 'NotAllowedError') throw new Error('Нет доступа к камере. Разрешите его в настройках браузера и обновите страницу.');
      throw new Error('Не удалось включить камеру: ' + (e && e.message ? e.message : e));
    }
    S.stream = stream;
    video.autoplay = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
  }

  function startFile(url) {
    return new Promise((resolve, reject) => {
      video.srcObject = null;
      video.autoplay = false;
      video.loop = false;
      video.onloadeddata = () => { video.onloadeddata = null; video.pause(); resolve(); };
      video.onerror = () => reject(new Error('Не удалось открыть видео. Попробуйте файл MP4 или MOV.'));
      video.src = url;
      video.load();
    });
  }

  function stopMedia() {
    clearInterval(S.timer);
    S.timer = null;
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    S.stream = null;
    video.pause();
    video.srcObject = null;
    if (video.src && video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
    releaseAwake();
  }

  function layoutCam() {
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    camWrap.style.aspectRatio = vw + ' / ' + vh;
    const avail = $('#app').clientWidth - 32;
    const maxH = window.innerHeight * 0.62;
    camWrap.style.width = '';
    camWrap.style.marginLeft = camWrap.style.marginRight = '';
    if (!isBoardMode() && avail * vh / vw > maxH) {
      camWrap.style.width = Math.round(maxH * vw / vh) + 'px';
      camWrap.style.marginLeft = camWrap.style.marginRight = 'auto';
    }
    drawOverlay();
  }

  /* ---------- Обработка кадров ---------- */

  function grab() {
    if (video.readyState < 2 || !video.videoWidth) return null;
    const scale = Math.min(1, PROC_W / video.videoWidth);
    const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
    if (proc.width !== w || proc.height !== h) { proc.width = w; proc.height = h; S.H = null; }
    if (!S.H) {
      const q = BV.orderQuad(S.corners);
      S.badQuad = !BV.isConvexQuad(q);
      if (S.badQuad) return null;
      S.H = BV.computeHomography(BV.UNIT, q.map(p => [p[0] * w, p[1] * h]));
      if (!S.H) return null;
      S.plan = BV.samplePlan(S.H, SAMPLE_OPTS);
      S.occ = null;
    }
    pctx.drawImage(video, 0, 0, w, h);
    let img;
    try { img = pctx.getImageData(0, 0, w, h); } catch (e) {
      S.error = 'Браузер не даёт читать кадры этого видео.';
      return null;
    }
    return BV.sampleWithPlan(img, S.plan);
  }

  /*
   * Часы распознавания. Для видеофайла идут по времени видео (обработка может не
   * успевать за воспроизведением), на паузе и для камеры — по реальному времени.
   */
  const clk = { ms: 0, real: 0, video: 0 };
  function clock() {
    const now = performance.now();
    if (S.source === 'file' && !video.paused) {
      clk.ms += Math.max(0, (video.currentTime - clk.video) * 1000);
    } else if (clk.real) {
      clk.ms += now - clk.real;
    }
    clk.video = video.currentTime;
    clk.real = now;
    return clk.ms;
  }

  function tick() {
    if (S.phase === 'idle' || S.phase === 'finished') return;
    const t0 = performance.now();
    const feat = grab();
    if (feat) {
      const res = tracker.push(feat, clock());
      S.handOver = res.moving;
      motionLog.push([Math.round(video.currentTime * 100) / 100, Math.round(res.motion), Math.round(res.threshold), res.moving ? 1 : 0]);
      if (motionLog.length > 900) motionLog.shift();
      const now = performance.now();
      if (S.phase === 'setup') {
        if (tracker.isSteady() && now - S.lastRecogAt > 300) {
          S.lastRecogAt = now;
          recognize(tracker.steadyFeatures());
        }
      } else if (!S.ref) {
        if (tracker.isSteady()) S.ref = tracker.steadyFeatures();
      } else if (res.settled) {
        onSettled(res.settled);
      }
    }
    updateStatus();
    drawOverlay();
    S.tickMs = S.tickMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  function startLoop() {
    clearInterval(S.timer);
    S.timer = setInterval(tick, TICK_MS);
  }

  function recognize(feat) {
    const r = BV.detectStartPosition(feat);
    S.recog = r;
    if (!S.kManual) S.k = r.k;
    S.recogStreak = r.recognized ? S.recogStreak + 1 : 0;
    if (S.recogStreak >= 2) goReady(feat);
  }

  function goReady(feat) {
    S.phase = 'ready';
    S.ref = feat || (tracker.isSteady() ? tracker.steadyFeatures() : null);
    S.recognizedAt = performance.now();
    store.set('vc_k', S.k);
    feedback();
    if (S.source === 'file' && S.autoplay) video.play().catch(() => {});
    updatePlayButton();
  }

  function onSettled(feat) {
    const ch = BV.squareChanges(S.ref, feat, S.k);
    S.changes = ch;
    if (!S.occ || S.occK !== S.k) { S.occ = BV.occlusionMap(S.H, S.k); S.occK = S.k; }
    const r = BV.findMove(S.chess, ch.bySquare, { threshold: settings.threshold, occ: S.occ, allowDouble: true });
    debugLog.push({
      t: Math.round(video.currentTime * 10) / 10, type: r.type,
      moves: r.moves ? r.moves.map(m => m.san) : [],
      top: Object.entries(ch.bySquare).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, v]) => s + ':' + v.toFixed(0)),
    });
    if (debugLog.length > 300) debugLog.shift();
    if (r.type === 'move') {
      let ok = true;
      for (const m of r.moves) {
        if (!applyMove({ from: m.from, to: m.to, promotion: m.promotion }, 'camera')) { ok = false; break; }
      }
      if (ok) {
        S.ref = feat;
        S.warn = null;
        if (r.double) toast('Записаны два хода подряд');
      }
    } else if (r.type === 'none') {
      // Фигуры не двигались (или их чуть поправили) — обновим эталон, чтобы не копить дрейф освещения.
      if (ch.max < settings.threshold * 0.6) S.ref = feat;
    } else {
      S.warn = {
        text: 'Не понял ход. Поправьте фигуры или сделайте ход на цифровой доске.',
        until: Date.now() + 6000,
      };
    }
  }

  /* ---------- Ходы ---------- */

  function applyMove(mv, source) {
    const played = S.chess.move(mv);
    if (!played) return null;
    if (S.phase === 'setup' || S.phase === 'ready') {
      S.phase = 'recording';
      keepAwake();
    }
    if (!S.startedAt) S.startedAt = Date.now();
    S.times.push(Date.now());
    S.lastMove = [played.from, played.to];
    S.selected = null;
    if (source === 'manual') S.ref = null; // эталон снимем заново, когда доска успокоится
    feedback();
    renderBoard();
    renderMoves();
    autosave();
    if (S.chess.game_over()) setTimeout(() => openFinish(), 700);
    return played;
  }

  function undoMove() {
    const m = S.chess.undo();
    if (!m) { toast('Отменять нечего'); return; }
    S.times.pop();
    const hist = S.chess.history({ verbose: true });
    const last = hist[hist.length - 1];
    S.lastMove = last ? [last.from, last.to] : [];
    S.ref = null;
    S.selected = null;
    S.warn = null;
    renderBoard();
    renderMoves();
    autosave();
    toast('Ход ' + m.san + ' отменён');
  }

  function onSquare(sq) {
    if (S.phase === 'finished' || S.promo) return;
    if (S.selected) {
      const moves = S.chess.moves({ square: S.selected, verbose: true }).filter(m => m.to === sq);
      if (moves.length) {
        if (moves.some(m => m.promotion)) { showPromo(S.selected, sq); return; }
        applyMove({ from: S.selected, to: sq }, 'manual');
        return;
      }
    }
    const p = S.chess.get(sq);
    S.selected = p && p.color === S.chess.turn() && S.selected !== sq ? sq : null;
    renderBoard();
  }

  function showPromo(from, to) {
    S.promo = { from, to };
    const c = S.chess.turn();
    const box = $('#promo');
    box.innerHTML = ['q', 'r', 'b', 'n'].map(p =>
      `<button data-p="${p}" aria-label="${p}"><img src="${PIECE(c + p.toUpperCase())}" alt=""/></button>`).join('');
    box.hidden = false;
  }

  /* ---------- Цифровая доска ---------- */

  function renderBoard() {
    const el = $('#board');
    const files = S.flipped ? 'hgfedcba' : 'abcdefgh';
    const ranks = S.flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    const targets = S.selected ? S.chess.moves({ square: S.selected, verbose: true }).map(m => m.to) : [];
    const turn = S.chess.turn();
    const inCheck = S.chess.in_check();
    let html = '';
    ranks.forEach((rank, ri) => {
      for (let fi = 0; fi < 8; fi++) {
        const f = files[fi], sq = f + rank;
        const p = S.chess.get(sq);
        const light = ('abcdefgh'.indexOf(f) + rank) % 2 === 0;
        const cls = ['sq', light ? 'l' : 'd'];
        if (S.lastMove.indexOf(sq) >= 0) cls.push('hl');
        if (S.selected === sq) cls.push('sel');
        if (targets.indexOf(sq) >= 0) cls.push('target', p ? 'has-piece' : '');
        if (inCheck && p && p.type === 'k' && p.color === turn) cls.push('check');
        html += `<div class="${cls.join(' ')}" data-sq="${sq}">`;
        if (fi === 0) html += `<span class="coord rank">${rank}</span>`;
        if (ri === 7) html += `<span class="coord file">${f}</span>`;
        if (p) html += `<img src="${PIECE(p.color + p.type.toUpperCase())}" alt="${p.color + p.type}"/>`;
        html += '</div>';
      }
    });
    el.innerHTML = html;

    const plies = S.chess.history().length;
    $('#turnDot').className = 'dot ' + (turn === 'w' ? 'white' : 'black');
    let text = turn === 'w' ? 'Ход белых' : 'Ход чёрных';
    if (S.chess.in_checkmate()) text = 'Мат! ' + (turn === 'w' ? 'Чёрные' : 'Белые') + ' выиграли';
    else if (S.chess.in_stalemate()) text = 'Пат';
    else if (S.chess.in_draw()) text = 'Ничья по правилам';
    else if (inCheck) text += ' · шах';
    $('#turnText').textContent = text;
    $('#moveCounter').textContent = plies ? `ход ${Math.floor(plies / 2) + 1} · записано полуходов: ${plies}` : 'ходов пока нет';
    $('#dimMoves').textContent = plies;
  }

  function renderMoves() {
    const hist = S.chess.history();
    const box = $('#moveList');
    if (!hist.length) { box.innerHTML = '<div class="none">Ходов пока нет</div>'; return; }
    let html = '';
    for (let i = 0; i < hist.length; i += 2) {
      const lastW = i === hist.length - 1, lastB = i + 1 === hist.length - 1;
      html += `<div class="n">${i / 2 + 1}.</div><div class="${lastW ? 'last' : ''}">${esc(hist[i])}</div>` +
        `<div class="${lastB ? 'last' : ''}">${esc(hist[i + 1] || '')}</div>`;
    }
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  /* ---------- Статус ---------- */

  let lastStatus = '';
  function computeStatus() {
    if (S.error) return ['err', S.error];
    if (S.warn && S.warn.until > Date.now()) return ['warn', S.warn.text];
    switch (S.phase) {
      case 'setup':
        if (video.readyState < 2) return ['search', S.source === 'file' ? 'Открываю видео…' : 'Включаю камеру…'];
        if (S.badQuad) return ['err', 'Углы заданы неверно — поставьте точки на 4 угла доски.'];
        if (!S.recog) return ['search', 'Ищу доску…'];
        return ['search', 'Ищу начальную расстановку… Проверьте углы и фигуры. Если игра уже идёт — «Начать без проверки».'];
      case 'ready':
        if (S.source === 'file' && video.paused) return ['ok', 'Доска распознана — запустите видео.'];
        return ['ok', 'Доска распознана — ждём первого хода.'];
      case 'recording':
        if (S.source === 'file' && video.ended) return ['ok', 'Видео закончилось. Проверьте ходы и нажмите «Закончить партию».'];
        return ['rec', 'Идёт запись. Ход засчитывается, когда рука ушла с доски.'];
      default:
        return ['', ''];
    }
  }

  function updateStatus() {
    const [kind, text] = computeStatus();
    const key = kind + '|' + text;
    if (key !== lastStatus) {
      lastStatus = key;
      const el = $('#status');
      el.className = 'status ' + kind;
      el.textContent = text;
    }
    const badge = $('#camBadge');
    const rec = S.phase === 'recording';
    badge.textContent = rec ? '● REC' : (S.source === 'file' ? 'ВИДЕО' : 'КАМЕРА');
    badge.classList.toggle('rec', rec);
    $('#camMotion').hidden = !(S.handOver && (S.phase === 'ready' || S.phase === 'recording'));
  }

  function updatePlayButton() {
    const b = $('#btnPlay');
    b.hidden = S.source !== 'file';
    b.textContent = video.paused ? (video.ended ? '↺ Сначала' : '▶ Запустить видео') : '❚❚ Пауза';
  }

  /* ---------- Оверлей: сетка, углы, лупа ---------- */

  function drawOverlay() {
    const dpr = window.devicePixelRatio || 1;
    const w = camWrap.clientWidth, h = camWrap.clientHeight;
    if (!w || !h) return;
    const W = Math.round(w * dpr), Hh = Math.round(h * dpr);
    if (overlay.width !== W || overlay.height !== Hh) { overlay.width = W; overlay.height = Hh; }
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (S.phase === 'idle') return;

    const q = BV.orderQuad(S.corners).map(p => [p[0] * w, p[1] * h]);
    const Hd = BV.isConvexQuad(q) ? BV.computeHomography(BV.UNIT, q) : null;
    const good = S.phase === 'ready' || S.phase === 'recording';
    const color = S.badQuad ? '#ff5a64' : good ? '#2ecc71' : '#f6b93b';
    const mini = isBoardMode();

    if (Hd) {
      const P = (u, v) => BV.applyH(Hd, u, v);
      const cellPath = (r, c) => {
        const pts = [P(c / 8, r / 8), P((c + 1) / 8, r / 8), P((c + 1) / 8, (r + 1) / 8), P(c / 8, (r + 1) / 8)];
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
      };

      if (settings.heatmap && S.changes) {
        for (let cell = 0; cell < 64; cell++) {
          const a = Math.min(0.65, S.changes.grid[cell] / (settings.threshold * 2));
          if (a < 0.04) continue;
          ctx.fillStyle = `rgba(255,70,70,${a})`;
          cellPath(cell >> 3, cell & 7);
          ctx.fill();
        }
      }

      if (good && S.lastMove.length) {
        ctx.fillStyle = 'rgba(247,207,69,.35)';
        for (const sq of S.lastMove) {
          const cell = BV.squareToCell(sq, S.k);
          cellPath(cell >> 3, cell & 7);
          ctx.fill();
        }
      }

      ctx.strokeStyle = color;
      ctx.globalAlpha = good ? 0.85 : 0.7;
      ctx.lineWidth = mini ? 0.8 : 1.2;
      ctx.beginPath();
      for (let i = 1; i < 8; i++) {
        let a = P(i / 8, 0), b = P(i / 8, 1);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        a = P(0, i / 8); b = P(1, i / 8);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = mini ? 1.5 : 2.5;
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.stroke();

      if (!mini) {
        // Подписи угловых клеток — чтобы было видно, где белые.
        const fs = Math.max(10, Math.min(14, w / 45));
        ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const sq of ['a1', 'h1', 'a8', 'h8']) {
          const cell = BV.squareToCell(sq, S.k);
          const [x, y] = P(((cell & 7) + 0.5) / 8, ((cell >> 3) + 0.5) / 8);
          ctx.fillStyle = 'rgba(0,0,0,.6)';
          ctx.fillRect(x - fs * 1.1, y - fs * 0.7, fs * 2.2, fs * 1.4);
          ctx.fillStyle = sq[1] === '1' ? '#fff' : '#f6b93b';
          ctx.fillText(sq, x, y);
        }
      }

      const [cx, cy] = P(0.5, 0.5);
      const R = Math.max(14, Math.min(w, h) * 0.07);
      const since = performance.now() - S.recognizedAt;
      if (S.phase === 'setup' && !S.badQuad) {
        // Крутилка «ищу доску».
        const t = performance.now() / 600;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(3, R / 4);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy, R, t, t + Math.PI * 1.5);
        ctx.stroke();
      } else if (good && since < 1800 && S.recognizedAt) {
        // Зелёный кружок с галочкой — доска распознана.
        ctx.globalAlpha = Math.min(1, (1800 - since) / 400);
        ctx.strokeStyle = '#2ecc71';
        ctx.lineWidth = Math.max(3, R / 4);
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - R * 0.45, cy + R * 0.02);
        ctx.lineTo(cx - R * 0.1, cy + R * 0.35);
        ctx.lineTo(cx + R * 0.5, cy - R * 0.3);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    if (mini) return;

    // Точки-углы.
    S.corners.forEach((p, i) => {
      const x = p[0] * w, y = p[1] * h;
      ctx.beginPath();
      ctx.arc(x, y, S.drag && S.drag.i === i ? 9 : 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(246,185,59,.35)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#f6b93b';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    });

    // Лупа при перетаскивании угла.
    if (S.drag && video.videoWidth) {
      const p = S.corners[S.drag.i];
      const x = p[0] * w, y = p[1] * h;
      const LR = Math.min(56, w / 6), zoom = 3;
      const lx = Math.min(w - LR - 4, Math.max(LR + 4, x));
      const ly = y - LR - 36 > 0 ? y - LR - 36 : y + LR + 36;
      const sx = p[0] * video.videoWidth, sy = p[1] * video.videoHeight;
      const sr = LR / zoom * (video.videoWidth / w);
      ctx.save();
      ctx.beginPath(); ctx.arc(lx, ly, LR, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = '#000'; ctx.fillRect(lx - LR, ly - LR, LR * 2, LR * 2);
      try { ctx.drawImage(video, sx - sr, sy - sr, sr * 2, sr * 2, lx - LR, ly - LR, LR * 2, LR * 2); } catch (e) { /* ignore */ }
      ctx.restore();
      ctx.strokeStyle = '#f6b93b'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(lx, ly, LR, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lx - 10, ly); ctx.lineTo(lx + 10, ly);
      ctx.moveTo(lx, ly - 10); ctx.lineTo(lx, ly + 10);
      ctx.stroke();
    }
  }

  function cornersChanged() {
    store.set('vc_corners', S.corners);
    S.H = null;
    S.ref = null;
    S.changes = null;
    tracker.reset();
    if (S.phase === 'ready') { S.phase = 'setup'; S.recogStreak = 0; }
    if (S.phase === 'setup') { S.recog = null; S.recogStreak = 0; }
    drawOverlay();
  }

  function pointerPos(e) {
    const r = camWrap.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  }

  camWrap.addEventListener('pointerdown', e => {
    if (isBoardMode()) { switchTab('screen'); return; }
    if (S.phase === 'idle' || S.phase === 'finished') return;
    const p = pointerPos(e);
    let best = -1, bestD = 48;
    S.corners.forEach((c, i) => {
      const d = Math.hypot(c[0] * p.w - p.x, c[1] * p.h - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return;
    S.drag = { i: best, id: e.pointerId };
    camWrap.setPointerCapture(e.pointerId);
    e.preventDefault();
    drawOverlay();
  });
  camWrap.addEventListener('pointermove', e => {
    if (!S.drag || S.drag.id !== e.pointerId) return;
    const p = pointerPos(e);
    S.corners[S.drag.i] = [clamp01(p.x / p.w), clamp01(p.y / p.h)];
    S.H = null;
    drawOverlay();
  });
  const endDrag = e => {
    if (!S.drag || S.drag.id !== e.pointerId) return;
    S.drag = null;
    cornersChanged();
  };
  camWrap.addEventListener('pointerup', endDrag);
  camWrap.addEventListener('pointercancel', endDrag);

  /* ---------- Запуск / выход ---------- */

  function newGame() {
    S.chess = new Chess();
    S.times = [];
    S.startedAt = null;
    S.lastMove = [];
    S.selected = null;
    S.promo = null;
    $('#promo').hidden = true;
  }

  function loadCurrent(cur) {
    S.chess = new Chess();
    for (const san of cur.moves) if (!S.chess.move(san)) break;
    S.times = (cur.times || []).slice(0, S.chess.history().length);
    S.startedAt = cur.startedAt || null;
    const hist = S.chess.history({ verbose: true });
    const last = hist[hist.length - 1];
    S.lastMove = last ? [last.from, last.to] : [];
  }

  async function openRecorder(source, url, resume) {
    initAudio();
    if (resume) {
      const cur = store.get('vc_current', null);
      S.headers = (cur && cur.headers) || readForm();
      fillForm(S.headers);
      loadCurrent(cur);
    } else {
      S.headers = readForm();
      store.set('vc_form', S.headers);
      newGame();
    }
    S.source = source;
    S.error = null;
    S.warn = null;
    S.recog = null;
    S.recogStreak = 0;
    S.recognizedAt = 0;
    S.ref = null;
    S.changes = null;
    S.H = null;
    S.kManual = false;
    tracker.reset();
    S.phase = resume ? 'recording' : 'setup';
    if (resume) S.k = store.get('vc_k', 0) & 3;

    showScreen('screenRecord');
    switchTab('screen');
    renderBoard();
    renderMoves();
    updatePlayButton();
    updateStatus();

    try {
      if (source === 'camera') await startCamera();
      else await startFile(url);
    } catch (e) {
      S.error = e.message;
      updateStatus();
      return;
    }
    layoutCam();
    updatePlayButton();
    startLoop();
    keepAwake();
    if (resume) toast('Продолжаем запись. Проверьте, что фигуры стоят как на цифровой доске.', 4000);
  }

  function leaveRecorder() {
    stopMedia();
    S.phase = 'idle';
    S.drag = null;
    $('#dimmer').hidden = true;
    showScreen('screenSetup');
    renderResume();
    renderSaved();
  }

  /* ---------- Завершение и PGN ---------- */

  function suggestedResult() {
    const c = S.chess;
    if (c.in_checkmate()) return c.turn() === 'w' ? '0-1' : '1-0';
    if (c.in_draw() || c.in_stalemate()) return '1/2-1/2';
    return null;
  }

  function openFinish() {
    if (S.phase === 'finished' || S.phase === 'idle') return;
    const sug = suggestedResult();
    $$('#finishSheet [data-result]').forEach(b => b.classList.toggle('suggested', b.dataset.result === sug));
    $('#finishHint').textContent = sug
      ? (S.chess.in_checkmate() ? 'На доске мат. Подтвердите результат.' : 'На доске ничья по правилам. Подтвердите результат.')
      : `Записано полуходов: ${S.chess.history().length}. Выберите результат.`;
    $('#finishSheet').hidden = false;
  }

  function pgnDate(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  }

  function buildPgn(result) {
    const h = S.headers || {};
    const clean = v => String(v || '').replace(/["\\]/g, "'");
    const g = new Chess();
    for (const san of S.chess.history()) g.move(san);
    g.header(
      'Event', clean(h.event) || 'Партия',
      'Site', clean(h.site) || '?',
      'Date', pgnDate(S.startedAt || Date.now()),
      'Round', clean(h.round) || '-',
      'White', clean(h.white) || 'Белые',
      'Black', clean(h.black) || 'Чёрные',
      'Result', result);
    if (/^\d+$/.test(h.whiteElo || '')) g.header('WhiteElo', h.whiteElo);
    if (/^\d+$/.test(h.blackElo || '')) g.header('BlackElo', h.blackElo);
    if (h.time) g.header('TimeControl', clean(h.time));
    g.header('Annotator', 'Запись камерой · live-chessboard');
    return g.pgn({ max_width: 80, newline_char: '\n' });
  }

  function finishGame(result) {
    $('#finishSheet').hidden = true;
    const pgn = buildPgn(result);
    const h = S.headers || {};
    const games = store.get('vc_games', []);
    games.unshift({
      id: Date.now(), white: h.white || 'Белые', black: h.black || 'Чёрные',
      result, plies: S.chess.history().length, pgn,
    });
    store.set('vc_games', games.slice(0, 50));
    store.del('vc_current');
    stopMedia();
    S.phase = 'finished';
    $('#dimmer').hidden = true;

    $('#sumWhite').textContent = h.white || 'Белые';
    $('#sumBlack').textContent = h.black || 'Чёрные';
    $('#sumScore').textContent = result === '1/2-1/2' ? '½ – ½' : result.replace('-', ' – ');
    $('#sumMeta').textContent = `${h.event || 'Партия'} · полуходов: ${S.chess.history().length}`;
    $('#pgnOut').value = pgn;
    showScreen('screenResult');
  }

  function fileName(pgn) {
    const tag = n => (pgn.match(new RegExp('\\[' + n + ' "([^"]*)"\\]')) || [])[1] || '';
    const base = `${tag('White')}-${tag('Black')}-${tag('Date')}`.replace(/[^\p{L}\p{N}.-]+/gu, '_');
    return (base || 'game') + '.pgn';
  }

  function download(pgn) {
    const url = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(pgn);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
      ta.remove();
    }
    toast('PGN скопирован');
  }

  async function share(pgn) {
    if (navigator.share) {
      try { await navigator.share({ title: 'Партия (PGN)', text: pgn }); return; } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    copy(pgn);
  }

  /* ---------- Обработчики ---------- */

  function bind() {
    $('#metaDate').textContent = formatDate(Date.now());
    fillForm(store.get('vc_form', {}));

    $('#btnCamera').addEventListener('click', () => openRecorder('camera'));
    $('#fileVideo').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) openRecorder('file', URL.createObjectURL(f));
      e.target.value = '';
    });
    $('#btnResume').addEventListener('click', () => openRecorder('camera', null, true));

    $('#savedList').addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = +btn.closest('.saved-item').dataset.id;
      const games = store.get('vc_games', []);
      const g = games.find(x => x.id === id);
      if (!g) return;
      if (btn.dataset.act === 'download') download(g.pgn);
      if (btn.dataset.act === 'copy') copy(g.pgn);
      if (btn.dataset.act === 'delete' && confirm('Удалить партию?')) {
        store.set('vc_games', games.filter(x => x.id !== id));
        renderSaved();
      }
    });

    $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

    $('#btnBack').addEventListener('click', () => {
      if (S.phase === 'recording' && S.chess.history().length &&
          !confirm('Выйти из записи? Партия сохранится, её можно будет продолжить.')) return;
      leaveRecorder();
    });

    $('#btnPlay').addEventListener('click', () => {
      if (video.paused) video.play().catch(() => {}); else video.pause();
    });
    ['play', 'pause', 'ended'].forEach(ev => video.addEventListener(ev, updatePlayButton));
    video.addEventListener('loadedmetadata', layoutCam);

    $('#btnRotate').addEventListener('click', () => {
      S.k = (S.k + 1) & 3;
      S.kManual = true;
      store.set('vc_k', S.k);
      drawOverlay();
      toast('Белые: ' + ['снизу', 'слева', 'сверху', 'справа'][S.k]);
    });
    $('#btnResetCorners').addEventListener('click', () => {
      S.corners = DEFAULT_CORNERS.map(p => p.slice());
      cornersChanged();
    });
    $('#btnForceStart').addEventListener('click', () => {
      if (S.phase !== 'setup') { toast('Запись уже идёт'); return; }
      S.kManual = true;
      goReady(null);
      toast('Проверьте подписи a1/h8 на сетке. Если белые не там — «Повернуть».', 3500);
    });

    $('#board').addEventListener('click', e => {
      const sq = e.target.closest('.sq');
      if (sq) onSquare(sq.dataset.sq);
    });
    $('#promo').addEventListener('click', e => {
      const b = e.target.closest('button[data-p]');
      if (!b || !S.promo) return;
      const { from, to } = S.promo;
      S.promo = null;
      $('#promo').hidden = true;
      applyMove({ from, to, promotion: b.dataset.p }, 'manual');
    });
    $('#btnUndo').addEventListener('click', undoMove);
    $('#btnFlip').addEventListener('click', () => { S.flipped = !S.flipped; renderBoard(); });
    $('#btnRebase').addEventListener('click', () => {
      S.ref = tracker.isSteady() ? tracker.steadyFeatures() : null;
      S.warn = null;
      toast('Принято: фигуры на доске совпадают с цифровой доской');
    });

    $('#btnFinish').addEventListener('click', openFinish);
    $('#btnFinishCancel').addEventListener('click', () => { $('#finishSheet').hidden = true; });
    $('#finishSheet').addEventListener('click', e => {
      if (e.target.id === 'finishSheet') { $('#finishSheet').hidden = true; return; }
      const b = e.target.closest('[data-result]');
      if (b) finishGame(b.dataset.result);
    });

    $('#btnDim').addEventListener('click', () => { $('#dimmer').hidden = false; });
    $('#dimmer').addEventListener('click', () => { $('#dimmer').hidden = true; });

    $('#btnResultBack').addEventListener('click', leaveRecorder);
    $('#btnNewGame').addEventListener('click', leaveRecorder);
    $('#btnDownload').addEventListener('click', () => download($('#pgnOut').value));
    $('#btnCopy').addEventListener('click', () => copy($('#pgnOut').value));
    $('#btnShare').addEventListener('click', () => share($('#pgnOut').value));

    // Настройки распознавания.
    const th = $('#setThreshold'), st = $('#setSettle');
    const showVals = () => {
      $('#valThreshold').textContent = settings.threshold;
      $('#valSettle').textContent = (settings.settleMs / 1000).toFixed(1) + ' с';
    };
    th.value = settings.threshold;
    st.value = settings.settleMs;
    $('#setSound').checked = settings.sound;
    $('#setHeatmap').checked = settings.heatmap;
    showVals();
    th.addEventListener('input', () => { settings.threshold = +th.value; showVals(); saveSettings(); });
    st.addEventListener('input', () => {
      settings.settleMs = +st.value;
      tracker.opts.settleMs = settings.settleMs;
      showVals();
      saveSettings();
    });
    $('#setSound').addEventListener('change', e => { settings.sound = e.target.checked; saveSettings(); });
    $('#setHeatmap').addEventListener('change', e => { settings.heatmap = e.target.checked; saveSettings(); drawOverlay(); });

    window.addEventListener('resize', layoutCam);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && S.phase !== 'idle' && S.phase !== 'finished') keepAwake();
    });
    window.addEventListener('beforeunload', autosaveIfRecording);
  }

  function autosaveIfRecording() {
    if (S.phase === 'recording') autosave();
  }

  /* ---------- Старт ---------- */

  bind();
  renderSaved();
  renderResume();
  renderBoard();
  renderMoves();

  // ?video=путь — сразу распознать видео (удобно для проверки), &autoplay=1 — запустить после распознавания доски.
  const params = new URLSearchParams(location.search);
  if (params.get('video')) {
    S.autoplay = params.get('autoplay') === '1';
    openRecorder('file', params.get('video'));
  }

  // Доступ для отладки из консоли.
  window.vcDebug = {
    state: S, settings, tracker,
    setCorners(c) { if (validCorners(c)) { S.corners = c.map(p => p.slice()); cornersChanged(); } },
    history: () => S.chess.history(),
    phase: () => S.phase,
    log: debugLog,
    motionLog,
  };
})();
