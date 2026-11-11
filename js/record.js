/*
 * Запись живой партии камерой телефона.
 * Экран «Сейчас» → «Запись» (Экран / Доска) → «Партия записана» (PGN).
 */
(function () {
  'use strict';

  const BV = window.BoardVision;
  const AI = window.SquareAI;
  const BD = window.BoardDetect;
  const BN = window.BoardNet;
  const GT = window.GameTracker;
  if (typeof Chess === 'undefined' || !BV || !AI || !BD) {
    document.body.innerHTML = '<p style="padding:24px;color:#fff">Не удалось загрузить скрипты. Проверьте интернет и обновите страницу.</p>';
    return;
  }

  /* ---------- Константы и утилиты ---------- */

  const APP_VERSION = '19.1 · ровно 4 проверки в секунду';
  const TICK_MS = 33;      // ~30 кадров/с
  const SETTLE_MS = 600;   // полная проверка, когда вся доска неподвижна
  const PROC_W = 640;
  const SAMPLE_OPTS = { samples: 8, margin: 0.12, dropNear: 0.3 };
  const DEFAULT_CORNERS = [[0.25, 0.06], [0.75, 0.06], [0.75, 0.94], [0.25, 0.94]];
  const PIECE = p => `img/chesspieces/cburnett/${p}.svg`;

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
  function feedback(alarm) {
    if (!settings.sound) return;
    try {
      if (audioCtx) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = alarm ? 330 : 880; // низкий звук — «не понял ход»
        g.gain.setValueAtTime(0.08, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(); o.stop(audioCtx.currentTime + 0.12);
      }
    } catch (e) { /* ignore */ }
    if (navigator.vibrate) navigator.vibrate(alarm ? [60, 80, 60] : 35);
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
    { threshold: 14, fastMs: 120, sound: true, heatmap: false, ai: true, saveVideo: true },
    store.get('vc_settings', {}));
  const saveSettings = () => store.set('vc_settings', settings);

  /* ---------- Состояние ---------- */

  const video = $('#video');
  const overlay = $('#overlay');
  const camWrap = $('#camWrap');
  const proc = document.createElement('canvas');
  const pctx = proc.getContext('2d', { willReadFrequently: true });
  const tracker = new BV.MotionTracker({ settleMs: SETTLE_MS, skipDup: false });
  const ai = new AI.SquareAI();
  const debugLog = [];
  const motionLog = [];
  const moveLog = [];
  const quietLog = []; // решения проверки в паузах (для отладочного журнала)
  const netLog = [];   // решения нейросети (для отладочного журнала)
  const perfLog = [];  // скорость проверок: [время видео, мс сети, мс трекера, мс до ответа]
  // Нейросеть, обученная на записях настоящих партий: что стоит на каждой клетке.
  let boardNet = null, netBg = null, netBgs = [];
  window.vcNetReady = BN ? BN.load((/[?&]net=light/.test(location.search) ? 'models/board-net-light.bnet' : 'models/board-net.bnet') + '?v=19.1').then(n => {
    boardNet = n;
    try {
      if (typeof Worker === 'function') {
        // две копии сети в двух фоновых потоках: кадры обрабатываются по очереди, проверок вдвое больше
        const nw = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
        for (let i = 0; i < nw; i++) netBgs.push(new BN.Background('js/board-net.js?v=19.1', n));
        netBg = netBgs[0];
      }
    } catch (e) { netBg = null; netBgs = []; }
    return true;
  }).catch(e => { console.warn(e); return false; }) : Promise.resolve(false);

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
    autoDetect: true,    // искать доску автоматически
    autoShown: false,
    lastAutoAt: 0,
    lastImg: null,
    tickMs: 0,
    recog: null,
    recogStreak: 0,
    recognizedAt: 0,
    lastRecogAt: 0,
    chess: new Chess(),
    times: [],
    startedAt: null,
    ref: null,           // рабочий эталон (обновляется по клеткам при быстрой фиксации)
    fullRef: null,       // эталон на момент последней полной проверки
    basePly: 0,          // сколько полуходов было на момент fullRef
    recent: new Set(),   // клетки недавних ходов: их эталон мог устареть
    snaps: [],           // снимки эталона после быстрых ходов: {ply, ref}
    refine: null,        // клетки последнего хода, которые надо переснять, когда рука уйдёт
    lastFast: null,      // последний быстрый ход: {ply, to, pre (эталон до хода), t} — для отмены «остановки в пути»
    onset: {},           // клетка → когда начала отличаться от эталона
    firstChange: {},     // клетка → когда на ней впервые что-то замерло после проверки (порядок ходов)
    quietAt: -1,         // какую паузу уже проверили
    weakCand: null,      // позиция со слабыми признаками и с какого момента она лучшая: {fen, since}
    lostSince: 0,        // с какого момента запись не сходится с тем, что видит ИИ
    lostWarned: false,
    settled: null,       // как выглядела каждая клетка, когда в последний раз замирала
    events: {},          // клетка → моменты, когда она замирала в новом виде (рядом без руки)
    darkCal: null,       // порог «чёрная фигура» по тёмному уровню клетки
    brightCal: null,     // порог «светлая фигура на тёмной клетке»
    pending: new Set(),  // клетки, чей эталон устарел (менялись под рукой) — переснимаем, когда видны
    empty: { feat: null, known: new Set() }, // как выглядят пустые клетки (по номерам клеток кадра)
    aiP: null,           // вероятности ИИ по клеткам кадра: [пусто, белая, чёрная, рука]
    aiFrame: 0,
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
          <b>${esc(g.white)} – ${esc(g.black)}</b>
          <small>${esc(g.result === '1/2-1/2' ? '½–½' : g.result)} · ${esc(new Date(g.id).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} · ${g.plies} пол.</small>
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
    bcUpdate('*');
  }

  /* ---------- Трансляция на lichess (js/broadcast.js) ---------- */
  const LB = window.LiveBroadcast;
  const bcConf = () => Object.assign({ round: '', board: '', boards: '', on: false }, store.get('vc_bc', {}));
  const bcToken = () => store.get('vc_bc_token', '');
  let bcPusher = null, bcKey = '', bcLast = null;

  /** Партия ушла на lichess? Создаём отправщика при первом ходе и после смены настроек. */
  function bcUpdate(result, final) {
    const c = bcConf(), round = LB && LB.roundId(c.round), token = bcToken();
    if (!c.on || !round || !token || !S.chess.history().length) { bcBadge(); return; }
    const key = [round, token, c.board, c.boards].join('|');
    if (!bcPusher || bcKey !== key) {
      if (bcPusher) bcPusher.stop();
      bcKey = key;
      bcPusher = new LB.Pusher({ round, token, interval: LB.minInterval(c.boards), onStatus: st => { bcLast = st; bcBadge(); } });
    }
    if (!S.startedAt) S.startedAt = Date.now();
    const t = LB.tags(S.headers || {}, c.board, S.startedAt.toString(36));
    bcPusher.update(buildPgn(result, t));
    if (final) bcPusher.flush();
    bcBadge();
  }

  function bcBadge() {
    const el = $('#bcBadge');
    if (!el) return;
    const c = bcConf();
    el.hidden = !(c.on && bcPusher);
    if (el.hidden) return;
    const st = bcLast || { state: 'wait', text: 'жду первого хода' };
    const n = st.plies != null ? ' · ' + st.plies + ' пол.' : '';
    el.textContent = '📡 lichess, доска ' + (Math.floor(+c.board) || 1) + ': ' + st.text + (st.state === 'ok' ? n : '');
    el.classList.toggle('ok', st.state === 'ok');
    el.classList.toggle('bad', st.state === 'error' || st.state === 'denied');
  }

  /**
   * Ссылка record.html#bc=ID_РАУНДА&board=N&boards=M&lt=ТОКЕН настраивает трансляцию на телефоне доски N
   * и сразу убирает токен из адресной строки.
   */
  function bcFromLink() {
    const h = location.hash.replace(/^#/, '');
    if (!/(^|&)bc=/.test(h)) return;
    const p = new URLSearchParams(h);
    const round = LB && LB.roundId(p.get('bc') || '');
    if (round) {
      store.set('vc_bc', Object.assign(bcConf(), { round, board: p.get('board') || '', boards: p.get('boards') || '', on: true }));
      const tok = (p.get('lt') || '').trim();
      if (tok) store.set('vc_bc_token', tok);
      keepStorage();
      setTimeout(() => toast('Трансляция настроена: доска ' + (p.get('board') || '1')), 300);
    }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  }

  function bcLinks() {
    const c = bcConf(), round = LB.roundId(c.round), n = Math.max(1, Math.floor(+c.boards) || 1);
    const base = location.origin + location.pathname;
    const out = [];
    for (let i = 1; i <= n; i++) {
      out.push('Доска ' + i + ': ' + base + '#bc=' + round + '&board=' + i + '&boards=' + n + '&lt=' + encodeURIComponent(bcToken()));
    }
    return out.join('\n');
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
    startDebugRecording(stream);
  }

  /*
   * Видео партии для отладки: пишем поток камеры (MediaRecorder). После партии его можно
   * отправить вместе с журналом решений программы и воспроизвести распознавание кадр за кадром.
   */
  const DEBUG_MAX_BYTES = 300 * 1024 * 1024;
  function startDebugRecording(stream) {
    S.debug = null;
    if (!settings.saveVideo || typeof MediaRecorder === 'undefined') return;
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      .find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } });
    let rec;
    try {
      // ~0,6 Мбит/с: для разбора хватает, а 5 минут партии — около 25 МБ, такой файл можно отправить
      rec = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: 600000 }, type ? { mimeType: type } : {}));
    } catch (e) { return; }
    const D = { rec, chunks: [], bytes: 0, type: rec.mimeType || type || 'video/webm', videoT0: video.currentTime, startedAt: Date.now(), blob: null };
    rec.ondataavailable = e => {
      if (!e.data || !e.data.size) return;
      D.chunks.push(e.data);
      D.bytes += e.data.size;
      if (D.bytes > DEBUG_MAX_BYTES && rec.state === 'recording') rec.stop(); // не забиваем память телефона
    };
    rec.onstop = () => {
      D.blob = new Blob(D.chunks, { type: D.type });
      D.chunks = [];
      updateDebugCard();
    };
    try { rec.start(2000); } catch (e) { return; }
    S.debug = D;
  }

  function stopDebugRecording() {
    const D = S.debug;
    if (D && D.rec && D.rec.state !== 'inactive') { try { D.rec.stop(); } catch (e) { /* ignore */ } }
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
    stopDebugRecording();
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
    pctx.drawImage(video, 0, 0, w, h);
    let img;
    try { img = pctx.getImageData(0, 0, w, h); } catch (e) {
      S.error = 'Браузер не даёт читать кадры этого видео.';
      return null;
    }
    S.lastImg = img; // для автопоиска доски
    if (!S.H) {
      const q = BV.orderQuad(S.corners);
      S.badQuad = !BV.isConvexQuad(q);
      if (S.badQuad) return null;
      S.H = BV.computeHomography(BV.UNIT, q.map(p => [p[0] * w, p[1] * h]));
      if (!S.H) return null;
      S.cam = BV.cameraFromH(S.H, w, h); // где камера: куда на кадре наклоняются фигуры
      // Сверху чёрная фигура на тёмной клетке почти не отличается по яркости — сравниваем клетки
      // с поправкой на яркость и по оттенку. Сбоку фигуры видны контрастно, там проще и надёжнее
      // обычная разница.
      BV.diffOpts.mode = S.cam.tilt < QUIET_MAX_TILT ? 'rel' : 'plain';
      // Повторы кадра (видеофайл обрабатывается быстрее, чем идут кадры) не считаем шумом.
      tracker.opts.skipDup = !window.vcKeepDup && S.cam.tilt < QUIET_MAX_TILT;
      // Сверху наклон фигур мал и по форме доски определяется ненадёжно — берём всю клетку.
      const topDown = S.cam.tilt < QUIET_MAX_TILT;
      S.plan = BV.samplePlan(S.H, Object.assign({ camera: S.cam }, SAMPLE_OPTS, topDown ? { dropNear: 0 } : {}));
      S.occ = null;
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
    if (S.manual) { clk.ms = video.currentTime * 1000; return clk.ms; } // покадровая проверка: время видео
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
    if (S.phase === 'setup') autoFind(t0);
    if (feat) {
      const res = tracker.push(feat, clock());
      S.handOver = res.moving;
      motionLog.push([Math.round(video.currentTime * 100) / 100, Math.round(res.motion), Math.round(res.threshold), res.moving ? 1 : 0]);
      if (motionLog.length > 900) motionLog.shift();
      const now = performance.now();
      if (S.phase === 'setup') {
        // Для поиска начальной позиции доска должна быть спокойна, но 1–2 мерцающие клетки
        // (край кадра, сжатие видео, лампа) не мешают: рука над доской задевает больше клеток.
        const topDown = !!S.cam && S.cam.tilt < QUIET_MAX_TILT;
        if ((tracker.isSteady() || (topDown && cellsMoving(300) <= 2)) && now - S.lastRecogAt > 300) {
          S.lastRecogAt = now;
          recognize(tracker.isSteady() ? tracker.steadyFeatures() : feat);
        }
      } else if (trackerOn()) {
        trackerTick(tracker.now);
      } else if (!S.ref) {
        if (tracker.isSteady()) setBase(tracker.steadyFeatures());
        else netBootstrap(feat);
      } else if (res.settled) {
        onSettled(res.settled);
      } else {
        fastCheck(feat);
      }
    }
    updateStatus();
    updateAIInfo();
    drawOverlay();
    const dt = performance.now() - t0;
    S.tickMs = S.tickMs * 0.9 + dt * 0.1;
    if (window.vcPerf) window.vcPerf.push(Math.round(dt * 10) / 10); // замер скорости в тестах
  }

  /** Сколько клеток двигались за последние ms миллисекунд. */
  function cellsMoving(ms) {
    let n = 0;
    for (let c = 0; c < 64; c++) if (tracker.now - tracker.since[c] < ms) n++;
    return n;
  }

  function startLoop() {
    clearInterval(S.timer);
    if (S.manual) return; // проверка по кадрам: тики вызывает vcDebug.step
    S.timer = setInterval(tick, TICK_MS);
  }

  /*
   * Автопоиск доски: пока идёт настройка и кадр спокоен, примерно раз в секунду ищем
   * доску в начальной позиции. Нашли — ставим углы сами; сетка станет зелёной, когда
   * начальная расстановка подтвердится. Если пользователь тронул точки вручную — не мешаем.
   */
  function autoFind(now) {
    if (!S.autoDetect || !S.lastImg || S.drag || tracker.moving || now - S.lastAutoAt < 900) return;
    S.lastAutoAt = now;
    let r = null;
    try { r = BD.detect(S.lastImg); } catch (e) { r = null; }
    if (!r) return;
    if (r.recognized) {
      S.corners = r.corners.map(p => p.slice());
      S.k = r.k;
      S.kManual = false;
      S.autoDetect = false; // нашли — дальше подтвердит распознавание начальной позиции
      cornersChanged();
      toast('Доска найдена');
    } else if (!S.autoShown) {
      // Сетку нашли, но начальной расстановки не видно: покажем, где доска, и продолжим искать.
      S.autoShown = true;
      S.corners = r.corners.map(p => p.slice());
      cornersChanged();
    }
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
    const base = feat || (tracker.isSteady() ? tracker.steadyFeatures() : null);
    if (base) setBase(base); else S.ref = null;
    S.recognizedAt = performance.now();
    store.set('vc_k', S.k);
    feedback();
    if (S.source === 'file' && S.autoplay) video.play().catch(() => {});
    updatePlayButton();
  }

  function ensureOcc() {
    if (!S.occ || S.occK !== S.k) { S.occ = BV.occlusionMap(S.H, S.k, { camera: S.cam }); S.occK = S.k; }
  }

  /** Новый эталон: доска сейчас совпадает с позицией на цифровой доске. */
  function setBase(feat, hidden) {
    hidden = hidden || [];
    S.fullRef = BV.cloneFeatures(feat);
    S.ref = BV.cloneFeatures(feat);
    S.basePly = S.chess.history().length;
    S.snaps = [];
    S.refine = null;
    S.lastFast = null;
    S.recent.clear();
    S.onset = {};
    S.firstChange = {};
    S.weakCand = null;
    S.settled = BV.cloneFeatures(feat);
    S.events = {};
    // По проверенной позиции подбираем порог «на клетке чёрная фигура».
    // Клетки под рукой (hidden): их эталон устарел — переснимем, когда рука уйдёт.
    S.pending = new Set(hidden);
    const cal = BV.calibrateDark(feat, cell => {
      const sq = BV.cellToSquare(cell, S.k);
      if (S.pending.has(sq)) return 'x';
      const p = S.chess.get(sq);
      return p ? p.color : '';
    });
    if (cal) S.darkCal = cal;
    const bcal = BV.calibrateBright(feat, cell => {
      const sq = BV.cellToSquare(cell, S.k);
      if (S.pending.has(sq)) return 'x';
      const p = S.chess.get(sq);
      return p ? p.color : '';
    }, cell => !isLight(BV.cellToSquare(cell, S.k)));
    if (bcal) S.brightCal = bcal;
    // Запоминаем, как выглядят пустые клетки, — это помогает отличить «фигура ушла» от «пришла».
    if (!S.empty.feat) S.empty.feat = { n: feat.n, per: feat.per, data: new Float32Array(feat.data.length), mean: feat.mean };
    const cells = [];
    for (const sq of BV.SQUARES) {
      if (!S.chess.get(sq) && !S.pending.has(sq)) { const cell = BV.squareToCell(sq, S.k); cells.push(cell); S.empty.known.add(cell); }
    }
    BV.copyCells(S.empty.feat, feat, cells);
    // Доска совпадает с цифровой — каждая клетка становится размеченным примером для ИИ.
    if (settings.ai) {
      const norm = AI.boardNorm(feat);
      for (const sq of BV.SQUARES) {
        if (S.pending.has(sq)) continue;
        const piece = S.chess.get(sq), cell = BV.squareToCell(sq, S.k);
        ai.add(AI.describe(feat, cell, isLight(sq), norm), piece ? (piece.color === 'w' ? AI.WHITE : AI.BLACK) : AI.EMPTY);
      }
    }
  }

  const isLight = sq => ('abcdefgh'.indexOf(sq[0]) + +sq[1]) % 2 === 0;

  /** Позиция после первых ply ходов партии (с её начальной позиции, если партия начата не с начала). */
  function positionAt(ply) {
    const c = new Chess();
    const fen = S.chess.header().FEN;
    if (fen) c.load(fen);
    for (const m of S.chess.history().slice(0, ply)) c.move(m);
    return c;
  }

  /** ИИ: дообучение и оценка всех клеток текущего кадра. */
  function runAI(feat) {
    if (!settings.ai) { S.aiP = null; return; }
    if (ai.count()) ai.train(6);
    if (!ai.ready()) { S.aiP = null; return; }
    const norm = AI.boardNorm(feat), probs = new Array(64);
    for (const sq of BV.SQUARES) {
      const cell = BV.squareToCell(sq, S.k);
      probs[cell] = ai.predict(AI.describe(feat, cell, isLight(sq), norm));
    }
    S.aiP = probs;
  }

  /** Примеры «рука»: клетки, по которым сейчас движется что-то, сильно непохожее на эталон. */
  function collectHand(feat, ch, t) {
    if (!settings.ai || !tracker.moving || (S.aiFrame++ % 2)) return;
    // Примеров «рука» не больше, чем примеров доски: иначе сеть начнёт видеть руку везде.
    const board = ai.count(AI.EMPTY) + ai.count(AI.WHITE) + ai.count(AI.BLACK);
    if (ai.count(AI.HAND) >= board * 0.5) return;
    const T = settings.threshold, norm = AI.boardNorm(feat), cand = [];
    for (const sq of BV.SQUARES) {
      const cell = BV.squareToCell(sq, S.k);
      // клетка сейчас сильно меняется от кадра к кадру и сильно отличается от эталона
      if (tracker.since[cell] === t && tracker.lastCells[cell] > tracker.cellThr[cell] * 2 &&
          ch.bySquare[sq] >= T * 3) cand.push([sq, cell]);
    }
    for (let i = 0; i < 2 && cand.length; i++) {
      const [sq, cell] = cand.splice(Math.floor(Math.random() * cand.length), 1)[0];
      ai.add(AI.describe(feat, cell, isLight(sq), norm), AI.HAND);
    }
  }

  function resetEmpty() {
    S.empty = { feat: null, known: new Set() };
  }

  /** Клетки, содержимое которых отличается в двух позициях. */
  function netSquares(a, b) {
    const out = [];
    for (const sq of BV.SQUARES) {
      const x = a.get(sq), y = b.get(sq);
      if ((x ? x.color + x.type : '') !== (y ? y.color + y.type : '')) out.push(sq);
    }
    return out;
  }

  /** Сколько клеток не сходятся с ожидаемым «пусто/занято» в позиции. */
  function occupancyMismatch(position, touched, emptyDiff) {
    const T = settings.threshold;
    let bad = 0;
    for (const q of touched) {
      const cell = BV.squareToCell(q, S.k);
      const piece = position.get(q);
      if (emptyDiff && S.empty.known.has(cell)) {
        const d = emptyDiff[cell];
        if (piece ? d < T * 0.8 : d > T * 1.5) bad++;
      }
    }
    return bad;
  }

  function logMove(san, via) {
    moveLog.push({ t: Math.round(video.currentTime * 100) / 100, san, via });
    if (moveLog.length > 500) moveLog.shift();
  }

  /*
   * Быстрая фиксация: на каждом кадре. Ход записывается, как только клетки
   * «откуда» и «куда» изменились и замерли — рука может оставаться над доской.
   */
  function fastCheck(feat) {
    const t = tracker.now;
    const T = settings.threshold;
    const ch = BV.squareChanges(S.ref, feat, S.k);
    S.changes = ch;
    // Клетка «успокоилась», только если неподвижны и её соседи: однотонная рука
    // или предплечье внутри выглядят неподвижными, но по краям всегда движутся.
    const nbSince = new Float64Array(64);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        let m = -Infinity;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) m = Math.max(m, tracker.since[rr * 8 + cc]);
          }
        }
        nbSince[r * 8 + c] = m;
      }
    }
    const stillMs = {}, lastMotion = {}, onset = {};
    for (const sq of BV.SQUARES) {
      const cell = BV.squareToCell(sq, S.k);
      stillMs[sq] = t - nbSince[cell];
      lastMotion[sq] = tracker.since[cell];
      const v = ch.bySquare[sq];
      if (v >= T) { if (S.onset[sq] == null) S.onset[sq] = t; } else if (v < T * 0.7) delete S.onset[sq];
      onset[sq] = S.onset[sq] != null ? S.onset[sq] : t;
    }
    ensureOcc();
    trackFirstChange(feat, t, stillMs);
    if (quietCheck(feat, t)) return;
    if (revertInTransit(feat, t, stillMs)) return;
    refineRef(feat, ch, t, stillMs, lastMotion);
    absorbStale(feat, ch, stillMs);
    collectHand(feat, ch, t);
    runAI(feat);
    const aiP = S.aiP, handKnown = !!aiP && ai.knowsHand();
    const classOf = sq => (aiP ? aiP[BV.squareToCell(sq, S.k)] : null);
    // Клетка готова, если неподвижна сама и её соседи; если ИИ уверен, что на клетке
    // не рука, — достаточно её собственной неподвижности (рука соседа не мешает).
    const stillOk = sq => {
      const cell = BV.squareToCell(sq, S.k);
      if (t - tracker.since[cell] < settings.fastMs) return false;
      if (stillMs[sq] >= settings.fastMs) return true;
      return handKnown && aiP[cell][AI.HAND] < 0.15;
    };
    const found = BV.findFastMove(S.chess, ch.bySquare, {
      threshold: T, occ: S.occ, stillMs, stillOk, lastMotion, onset, now: t, fastMs: settings.fastMs, ignore: S.recent,
      classOf: handKnown ? classOf : null,
      aiVeto: handKnown && ai.count(AI.EMPTY) + ai.count(AI.WHITE) + ai.count(AI.BLACK) >= 192,
      trace: window.vcTrace,
    });
    if (!found) return;
    const pre = BV.cloneFeatures(S.ref);
    const moveSq = [];
    for (const m of found) {
      const played = applyMove({ from: m.from, to: m.to, promotion: m.promotion }, 'fast');
      if (!played) return;
      moveSq.push(...BV.squaresOfMove(played));
    }
    // Эталон обновляем только на клетках хода и тех клетках в их «тени», что уже неподвижны.
    const touched = new Set(moveSq);
    for (const sq of moveSq) for (const o of S.occ[sq] || []) touched.add(o);
    const cells = [];
    for (const sq of touched) {
      if (moveSq.indexOf(sq) >= 0 || stillMs[sq] >= settings.fastMs) cells.push(BV.squareToCell(sq, S.k));
      S.recent.add(sq);
      delete S.onset[sq];
    }
    BV.copyCells(S.ref, feat, cells);
    S.refine = { squares: new Set(touched), at: t };
    S.lastFast = found.length === 1 ? { ply: S.chess.history().length, from: found[0].from, to: found[0].to, pre, t } : null;
    S.snaps.push({ ply: S.chess.history().length, ref: BV.cloneFeatures(S.ref) });
    if (S.snaps.length > 8) S.snaps.shift();
    S.warn = null;
  }

  /** Когда на клетке впервые что-то замерло после последней проверки (для порядка ходов). */
  function trackFirstChange(feat, t, stillMs) {
    const T = settings.threshold;
    const ch = BV.squareChanges(S.fullRef, feat, S.k).bySquare;
    for (const sq of BV.SQUARES) {
      if (S.firstChange[sq] != null || ch[sq] < T) continue;
      const since = tracker.since[BV.squareToCell(sq, S.k)];
      if (t - since >= 150) S.firstChange[sq] = since;
    }
    // История клетки: каждый раз, когда она замерла в новом виде, а рядом нет движения.
    if (!S.settled) return;
    const cs = BV.squareChanges(S.settled, feat, S.k).bySquare;
    const cells = [];
    for (const sq of BV.SQUARES) {
      if (cs[sq] < T || stillMs[sq] < 150) continue;
      const cell = BV.squareToCell(sq, S.k);
      (S.events[sq] = S.events[sq] || []).push(tracker.since[cell]);
      cells.push(cell);
    }
    if (cells.length) BV.copyCells(S.settled, feat, cells);
  }

  /*
   * Короткая пауза: вся доска неподвижна QUIET_MS (рука могла и не уйти с доски, просто замерла
   * или ушла на мгновение). Сравниваем доску с последней проверенной позицией и ищем цепочку
   * ходов, которая объясняет картину. Так находятся ходы, которые быстрая фиксация пропустила
   * или записала неверно (очень быстрая игра, чёрная фигура на тёмной клетке).
   */
  const QUIET_MS = 250;
  const QUIET_MAX_MOVING = 6; // рука может лежать или шевелиться в углу доски — эти клетки не оцениваем
  // Восстановление ходов по паузам включаем, когда камера смотрит на доску сверху (как в держателе
  // над центром доски). Сбоку рука и наклоны фигур закрывают слишком много клеток — там
  // надёжнее прежняя проверка (onSettled).
  const QUIET_MAX_TILT = 35;
  function quietCheck(feat, t) {
    if (!S.fullRef || window.vcNoQuiet || !S.cam || !(S.cam.tilt < QUIET_MAX_TILT)) return false;
    const movingCells = [];
    let last = 0;
    for (let c = 0; c < 64; c++) {
      if (t - tracker.since[c] < QUIET_MS) movingCells.push(c);
      else if (tracker.since[c] > last) last = tracker.since[c];
    }
    if (movingCells.length > QUIET_MAX_MOVING) return false;
    const newQuiet = S.quietAt !== last;
    const mask = new Set();
    for (const c of movingCells) {
      const r = c >> 3, col = c & 7;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = col + dc;
          if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) mask.add(BV.cellToSquare(rr * 8 + cc, S.k));
        }
      }
    }
    const steady = mask.size ? feat : tracker.steadyFeatures();
    // Сначала — нейросеть: подтверждает запись или исправляет её. Тогда эталон сравнения
    // просто переснимаем (сеть видит саму доску, ей не нужен эталон).
    const nr = netCheck(t, mask, newQuiet, BV.squareChanges(S.fullRef, steady, S.k).bySquare);
    if (nr && !S.netStale) {
      S.quietAt = last;
      advanceBase(steady, mask, positionAt(S.basePly), []);
      return true;
    }
    if (nr) return true;
    if (!newQuiet) return false;
    S.quietAt = last;
    const T = settings.threshold;
    const hist = S.chess.history({ verbose: true });
    const recorded = hist.slice(S.basePly);
    const base = positionAt(S.basePly);
    // Клетки, менявшиеся под рукой при прошлой проверке, теперь видны — переснимаем их эталон.
    if (S.pending.size) {
      const moved = new Set();
      for (const m of recorded) for (const q of BV.squaresOfMove(m)) moved.add(q);
      const seen = Array.from(S.pending).filter(q => !mask.has(q) && !moved.has(q));
      const cells = seen.map(q => BV.squareToCell(q, S.k));
      BV.copyCells(S.fullRef, steady, cells);
      BV.copyCells(S.ref, steady, cells);
      for (const q of seen) S.pending.delete(q);
      for (const q of S.pending) mask.add(q);
    }
    const ch = BV.squareChanges(S.fullRef, steady, S.k).bySquare;
    const active = new Set(Object.keys(S.firstChange));
    for (const sq of BV.SQUARES) if (ch[sq] >= T * 0.7) active.add(sq);
    for (const sq of mask) active.add(sq);
    for (const m of recorded) for (const q of BV.squaresOfMove(m)) active.add(q);
    const cal = S.darkCal, bc = S.brightCal;
    const colorOf = (cal || bc) ? sq => {
      const cell = BV.squareToCell(sq, S.k);
      let b = null, w = null;
      if (cal) { const v = BV.darkLevel(steady, cell), m = cal.gap * 0.2; b = v < cal.thr - m ? true : v > cal.thr + m ? false : null; }
      if (bc && !isLight(sq)) { const v = BV.brightLevel(steady, cell), m = bc.gap * 0.2; w = v > bc.thr + m ? true : v < bc.thr - m ? false : null; }
      return { b, w };
    } : null;
    const netFresh = S.netP && S.netPAt === t;
    const aiP = settings.ai && ai.ready() ? S.aiP : null;
    const aiOf = netFresh ? netProbs
      : aiP ? sq => aiP[BV.squareToCell(sq, S.k)] : null;
    const t0 = performance.now();
    const r = BV.findSequence(base, ch, {
      threshold: T, occ: S.occ, active, order: S.firstChange, events: S.events, colorOf, mask, aiOf,
      recorded: recorded.map(m => m.san), maxPlies: 8, maxNodes: 2000,
      probe: window.vcExpected ? [window.vcExpected.slice(S.basePly, S.basePly + Math.max(1, recorded.length, 0) + 0),
        window.vcExpected.slice(S.basePly, S.basePly + 5)] : null,
    });
    const b = r.best;
    if (!b) return false;
    const rec = r.recorded;
    const qe = {
      t: Math.round(video.currentTime * 100) / 100, mask: mask.size, best: b.san.join(' '), cost: b.cost,
      u: b.unexplained, m: b.missing, c: b.conflict, n: b.noise, ai: b.aiMis,
      rec: r.recorded ? r.recorded.cost : null, alt: r.alt ? r.alt.cost : null, act: '-',
    };
    if (recorded.length || b.plies || b.unexplained) { quietLog.push(qe); if (quietLog.length > 300) quietLog.shift(); }
    if (window.vcQuietTrace) {
      const f = c => c ? `${c.san.join(' ')} [u${c.unexplained} b${c.bumped} i${c.indirect} v${c.unverified} m${c.missing} w${c.weak} a${c.aiMis}${c.aiMisAt && c.aiMisAt.length ? '(' + c.aiMisAt.join(',') + ')' : ''} c${c.conflict}${c.conflictAt.length ? '(' + c.conflictAt.join(',') + ')' : ''} n${c.noise}(${c.noiseAt.join(',')}) inv${c.inv} cost${c.cost}]` : '-';
      const pr = q => { const p = aiOf && aiOf(q); return p ? q + '=' + Array.from(p).map(x => Math.round(x * 100)).join('/') : q + '=-'; };
      window.vcQuietTrace.push(`${video.currentTime.toFixed(2)} AI[${b.moves.map(m => pr(m.to)).join(' ')}] mask ${Array.from(mask).join(',') || '-'} best ${f(b)} alt ${f(r.alt)} rec ${f(r.recorded)} ${(r.probes || []).map(p => 'probe ' + f(p)).join(' ')} nodes ${r.nodes} ${Math.round(performance.now() - t0)}ms top ` +
        Object.entries(ch).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([q, v]) => q + ':' + v.toFixed(0)).join(' '));
    }
    // Другая позиция объясняет картину почти так же (например, под рукой не видно, пешка
    // пошла на c6 или конь): точку отсчёта не двигаем — решим, когда рука уйдёт.
    let ambiguous = false;
    if (r.alt && r.alt.cost <= b.cost + 0.5) {
      const pa = new Chess(b.fen + ' 0 1'), pb = new Chess(r.alt.fen + ' 0 1');
      const code = (pos, q) => { const p = pos.get(q); return p ? p.color + p.type : ''; };
      ambiguous = BV.SQUARES.some(q => mask.has(q) && code(pa, q) !== code(pb, q));
    }
    // Мелкий шум допустим, и тем больше, чем больше клеток изменили ходы (тени, наклоны).
    const clean = !ambiguous && b.unexplained === 0 && b.missing === 0 && b.conflict === 0 &&
      b.noise <= 2 + b.bumped + Math.floor(b.req.length / 4) && b.bumped <= 2;
    // ИИ уверенно видит на изменившихся клетках то же, что в записи (сменился свет, камера
    // перенастроила экспозицию, фигуру поправили) — эталон этих клеток устарел, переснимаем их.
    if (!clean && aiOf) {
      const sure = q => {
        const p = aiOf(q);
        if (!p || p[3] >= 0.5) return -1;
        let c = 0;
        for (let k = 1; k < 3; k++) if (p[k] > p[c]) c = k;
        return p[c] >= 0.9 ? c : -1;
      };
      const content = q => { const x = S.chess.get(q); return x ? (x.color === 'w' ? 1 : 2) : 0; };
      const busy = new Set(b.req.concat(b.opt));
      const stale = b.unexplainedAt.concat(b.noiseAt).filter(q => !mask.has(q) && !busy.has(q) && sure(q) === content(q));
      if (stale.length) {
        const cells = stale.map(q => BV.squareToCell(q, S.k));
        BV.copyCells(S.fullRef, steady, cells);
        BV.copyCells(S.ref, steady, cells);
        if (S.settled) BV.copyCells(S.settled, steady, cells);
        logMove(stale.length + ' cells (ai)', 'absorb');
        S.quietAt = -1; // проверим ещё раз уже с обновлённым эталоном
        return false;
      }
    }
    // Запись не сходится с тем, что видит ИИ, и исправить не получается — сообщаем сразу,
    // чтобы ход поправили на цифровой доске, а не узнали о сбое в конце партии.
    const recMis = rec ? rec.aiMis : 0;
    if (!clean && recMis >= 2) {
      if (!S.lostSince) S.lostSince = t;
      else if (t - S.lostSince > 3000 && !S.lostWarned) {
        S.lostWarned = true;
        S.warn = { text: 'Не понял ход — проверьте доску: ' + rec.aiMisAt.slice(0, 4).join(', '), until: Date.now() + 8000 };
        feedback(true);
      }
    } else if (clean) {
      S.lostSince = 0;
      S.lostWarned = false;
    }
    if (!clean) return false;
    // Исправляем, если найденное заметно лучше; или те же ходы в другом порядке — и порядок
    // лучше сходится с тем, когда менялись клетки.
    const reorder = !!rec && !b.isRecorded && rec.fen === b.fen && b.inv < rec.inv && b.cost <= rec.cost + 0.5;
    // Новые ходы добавляем только по явным изменениям: слабые (сдвинули телефон, тень) не в счёт.
    // Ход, обе клетки которого закрыты рукой, проверить нечем — такие исправления не принимаем.
    const hiddenMove = b.moves.some((m, i) => mask.has(m.from) && mask.has(m.to) &&
      !(recorded[i] && recorded[i].from === m.from && recorded[i].to === m.to));
    // Уже записанные ходы переписываем, только когда большая часть доски видна.
    let keep = 0;
    while (keep < recorded.length && keep < b.moves.length && recorded[keep].from === b.moves[keep].from &&
      recorded[keep].to === b.moves[keep].to) keep++;
    const rewrites = keep < recorded.length;
    // Слабые признаки (светлая пешка на светлой клетке) принимаем, если та же позиция остаётся
    // лучшим объяснением 1,5 с подряд: сдвиг телефона так долго одно и то же не «показывает».
    let weakOk = b.weak === 0;
    if (!weakOk) {
      if (S.weakCand && S.weakCand.fen === b.fen) weakOk = t - S.weakCand.since >= 1500;
      else S.weakCand = { fen: b.fen, since: t };
    }
    // Новый ход не добавляем, если ИИ (обученный на этой партии) уверенно видит на клетке назначения
    // другое — пусто или фигуру другого цвета: значит, это рука или тень, «объяснённая» ходом.
    const unconfirmed = !!aiOf && b.moves.some((m, i) => {
      if (i < keep || mask.has(m.to)) return false;
      const fin = new Chess(b.fen + ' 0 1').get(m.to);
      if (!fin || fin.color !== m.color) return false; // фигуру потом побили — проверять нечего
      const p = aiOf(m.to);
      if (!p || p[AI.HAND] >= 0.5) return false;
      // ИИ почти исключает фигуру этого цвета и видит там другое (пусто или фигуру другого цвета)
      const mine = p[m.color === 'w' ? AI.WHITE : AI.BLACK];
      const other = p[AI.EMPTY] + p[m.color === 'w' ? AI.BLACK : AI.WHITE];
      if (mine < 0.1 && other >= 0.6) return true;
      // клетку, откуда «ушла» фигура, закрывает лежащая рука — тогда нужен явный признак фигуры на месте
      const pf = aiOf(m.from);
      return !!pf && pf[AI.HAND] >= 0.5 && mine < 0.5;
    });
    const fix = !b.isRecorded && !hiddenMove && !unconfirmed && !(rewrites && mask.size > 12) &&
      (!rec || rec.cost > b.cost + 2 || reorder) && (weakOk || reorder);
    if (!fix && !b.isRecorded) return false;
    qe.act = fix ? 'fix' : 'ok';
    if (fix) {
      debugLog.push({
        t: Math.round(video.currentTime * 10) / 10, type: 'recover', moves: b.san, fast: recorded.map(m => m.san),
        top: Object.entries(ch).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([q, v]) => q + ':' + v.toFixed(0)),
      });
      if (debugLog.length > 300) debugLog.shift();
      undoPlies(recorded.length);
      for (const m of b.moves) applyMove({ from: m.from, to: m.to, promotion: m.promotion }, 'recover');
      S.warn = null;
      if (recorded.length) toast('Ходы исправлены: ' + b.san.join(' '));
    } else if (!recorded.length && !Object.keys(S.firstChange).length) {
      return false; // ничего не происходило
    }
    // Новая точка отсчёта. Клетки под рукой берём из старого эталона, если их содержимое
    // не изменилось; если изменилось — точку отсчёта не двигаем, эти клетки переснимем позже.
    // Остаток изменений похож на ещё один ход (слабо видный: белая пешка на светлой клетке сбоку)?
    // Тогда точку отсчёта не двигаем — иначе этот ход «растворится» в эталоне.
    const left = new Set(b.noiseAt);
    if (S.chess.moves({ verbose: true }).some(m => BV.squaresOfMove(m).every(q => left.has(q)))) {
      qe.act += '/wait';
      if (fix) {
        // эталон быстрой фиксации — по клеткам исправленных ходов
        const cells = new Set();
        for (const m of b.moves) for (const q of BV.squaresOfMove(m)) if (!mask.has(q)) cells.add(BV.squareToCell(q, S.k));
        BV.copyCells(S.ref, steady, Array.from(cells));
        S.snaps = [];
        S.lastFast = null;
      }
      return fix;
    }
    // Новая точка отсчёта. Клетки под рукой берём из старого эталона; те из них, где содержимое
    // изменилось (или эталон уже был устаревшим), переснимем, когда рука уйдёт.
    // Необъяснённые изменения в эталон не впитываем: это может быть половина хода, вторая
    // половина которого сейчас видна слабо (светлая пешка на светлой клетке в тени руки).
    advanceBase(steady, mask, base, b.noiseAt.filter(q => !mask.has(q)));
    return true;
  }

  /** Новая точка отсчёта сравнения: текущий кадр; клетки под рукой и keepOld — из старого эталона. */
  function advanceBase(steady, mask, base, keepOld) {
    const code = (pos, q) => { const p = pos.get(q); return p ? p.color + p.type : ''; };
    const hidden = Array.from(mask).filter(q => S.pending.has(q) || code(base, q) !== code(S.chess, q));
    const nf = BV.cloneFeatures(steady);
    BV.copyCells(nf, S.fullRef, Array.from(mask).map(q => BV.squareToCell(q, S.k)));
    BV.copyCells(nf, S.fullRef, keepOld.map(q => BV.squareToCell(q, S.k)));
    setBase(nf, hidden);
    for (const q of hidden) S.recent.add(q);
    if (hidden.length) S.refine = { squares: new Set(hidden), at: tracker.now };
  }

  /*
   * Проверка нейросетью. Сеть смотрит на сам кадр и говорит, что стоит на каждой видимой клетке.
   * Ищем легальные ходы от последней подтверждённой сетью позиции, итог которых лучше всего
   * совпадает с её ответом. Записанное подтверждается; если другая цепочка ходов объясняет
   * доску заметно лучше и это повторилось дважды подряд — запись исправляется.
   * Возвращает 'ok' | 'fixed' | null (сеть не уверена — решает обычная проверка).
   */
  const NET_RETRY_MS = 600;   // повторная проверка в той же паузе, если в прошлый раз не сошлось
  const NET_IDLE_MS = 2000;   // и раз в 2 с, даже если ничего не менялось (пропущенный слабый ход)
  const NET_MARGIN = 3;       // насколько исправленная цепочка должна объяснять доску лучше записанной
  function netCheck(t, mask, newQuiet, ch) {
    if (!boardNet || !settings.ai || window.vcNoNet || !S.lastImg || !S.H || !S.fullRef) return null;
    if (!(S.cam && S.cam.tilt < QUIET_MAX_TILT)) return null; // сеть обучена на съёмке сверху
    const due = newQuiet || (S.netOpen && t - S.netAt >= NET_RETRY_MS) || t - S.netAt >= NET_IDLE_MS;
    if (netBg && !netBg.failed && !S.manual) {
      // Ответ фонового потока по кадру, снятому чуть раньше. Годится, если с тех пор ничего
      // не записали и на видимых тогда клетках ничего не двигалось.
      const R = S.netRes;
      if (R && !R.used) {
        R.used = true;
        // Ответ по кадру, снятому чуть раньше. Годится, если с тех пор не записали новых ходов.
        // Если на открытых тогда клетках что-то двигалось, эталон по нынешнему кадру не переснимаем.
        if (S.chess.history().length === R.plies) {
          let moved = false;
          for (let c = 0; c < 64 && !moved; c++) if (tracker.since[c] > R.t && !R.mask.has(BV.cellToSquare(c, S.k))) moved = true;
          S.netStale = moved;
          if (!moved) { S.netP = R.probs; S.netPAt = t; }
          return netDecide(R.probs, t, R.mask, moved ? null : ch, R.ms);
        }
      }
      if (due && !netBg.busy) {
        const req = { t, mask: new Set(mask), plies: S.chess.history().length, at: performance.now() };
        S.netAt = t;
        const fr = netFrame();
        if (fr) netBg.run(fr.img, fr.H, p => { if (p) { req.probs = p; req.ms = Math.round(performance.now() - req.at); S.netRes = req; } });
      }
      return null;
    }
    if (!due) return null;
    S.netStale = false;
    const t0 = performance.now();
    const fr = netFrame();
    if (!fr) return null;
    const probs = boardNet.run(fr.img, fr.H);
    S.netP = probs;
    S.netAt = S.netPAt = t;
    return netDecide(probs, t, mask, ch, Math.round(performance.now() - t0));
  }

  function netDecide(probs, t, mask, ch, ms) {
    const t0 = performance.now();
    const P = sq => {
      if (mask.has(sq)) return null;
      const p = netProbs(sq, probs);
      if (p[3] >= 0.5) return null; // клетку закрывает рука
      const s = p[0] + p[1] + p[2];
      return [p[0] / s, p[1] / s, p[2] / s];
    };
    const hist = S.chess.history({ verbose: true });
    if (S.netPly == null || S.netPly > hist.length) S.netPly = Math.min(S.basePly || 0, hist.length);
    const recorded = hist.slice(S.netPly);
    const base = positionAt(S.netPly);
    const rc = BV.netCost(S.chess, P);
    const recCost = rc.cost + recorded.length;
    const recKey = S.chess.fen().split(' ').slice(0, 3).join(' ');
    // Запись уже объясняет всё, что видит сеть, — искать нечего (обычный случай, без затрат).
    // Сеть видит то же расхождение, что и в прошлый раз (например, наклонённая фигура на соседней
    // клетке) — повторять поиск незачем, берём прошлый ответ.
    const sig = !rc.bad.length ? '' : S.netPly + '|' + hist.length + '|' + BV.SQUARES.map(q => {
      const p = P(q);
      if (!p) return '-';
      return p[0] >= 0.5 ? '0' : p[1] >= 0.5 ? '1' : p[2] >= 0.5 ? '2' : '?';
    }).join('');
    let r;
    if (!rc.bad.length) r = { best: { key: recKey, san: recorded.map(m => m.san), moves: recorded, cost: recCost, bad: [] }, second: null };
    else if (S.netCache && S.netCache.sig === sig) r = S.netCache.r;
    else {
      r = BV.findByNet(base, P, { prefer: recorded.map(m => m.san), maxPlies: Math.min(6, Math.max(4, recorded.length + 2)), maxNodes: 1500, budgetMs: 120 });
      S.netCache = { sig, r };
    }
    const b = r.best;
    const e = {
      t: Math.round(video.currentTime * 100) / 100, mask: mask.size, rec: recorded.map(m => m.san).join(' '),
      best: b.san.join(' '), cost: +b.cost.toFixed(2), recCost: +recCost.toFixed(2), bad: rc.bad.join(','), bbad: (b.bad || []).join(','),
      ms, search: Math.round(performance.now() - t0), act: '-',
    };
    netLog.push(e);
    if (netLog.length > 400) netLog.shift();
    if (window.vcNetTrace) window.vcNetTrace.push(e);
    if (b.key === recKey) {
      S.netCand = null;
      S.netOpen = rc.bad.length > 0;
      // Одну клетку, которую не объясняет ни одна цепочка ходов, считаем ошибкой сети:
      // она не мешает подтвердить запись, но её эталон не переснимаем.
      if (rc.bad.length > 1) { netLost(t, rc.bad); return null; }
      for (const q of rc.bad) mask.add(q);
      netFound();
      // Где картинка изменилась, сеть должна уверенно видеть записанное — иначе эталон
      // не переснимаем (там может быть ход, который сеть видит неуверенно).
      const T = settings.threshold;
      const doubt = !ch ? [] : BV.SQUARES.filter(q => {
        if (mask.has(q) || (ch[q] || 0) < T * 0.7) return false;
        const x = S.chess.get(q), p = P(q);
        return !p || p[x ? (x.color === 'w' ? 1 : 2) : 0] < 0.9; // под рукой — проверить нечем
      });
      if (doubt.length) { e.act = 'doubt:' + doubt.join(','); return null; }
      // Всё записанное сеть видит на доске. Ходы, клетки которых сейчас под рукой, проверим позже.
      let ok = recorded.length;
      while (ok > 0 && BV.squaresOfMove(recorded[ok - 1]).some(q => mask.has(q))) ok--;
      S.netPly += ok;
      e.act = 'ok';
      return 'ok';
    }
    S.netOpen = true;
    // Клетки, с которыми сеть не согласна и в записи, и в найденной цепочке, — её собственные ошибки
    // (например, наклонённая фигура на соседней клетке); решению они не мешают, если их не больше двух.
    const own = (b.bad || []).filter(q => rc.bad.indexOf(q) < 0);
    const sure = !own.length && b.bad.length <= 2 && recCost - b.cost >= NET_MARGIN + b.bad.length &&
      (!r.second || r.second.cost - b.cost >= 1.5);
    if (!sure) {
      S.netCand = null;
      if (rc.bad.length > 1) netLost(t, rc.bad);
      return null;
    }
    // Ход, обе клетки которого закрыты рукой, проверить нечем.
    if (b.moves.some(m => mask.has(m.from) && mask.has(m.to))) { S.netCand = null; return null; }
    if (!S.netCand || S.netCand.key !== b.key) { S.netCand = { key: b.key, n: 1 }; e.act = 'cand'; return null; }
    let keep = 0;
    while (keep < recorded.length && keep < b.moves.length && recorded[keep].san === b.moves[keep].san) keep++;
    debugLog.push({ t: e.t, type: 'net', moves: b.san, fast: recorded.map(m => m.san), top: rc.bad.slice(0, 8) });
    if (debugLog.length > 300) debugLog.shift();
    undoPlies(recorded.length - keep);
    for (const m of b.moves.slice(keep)) applyMove({ from: m.from, to: m.to, promotion: m.promotion }, 'net');
    if (recorded.length > keep) toast('Ходы исправлены: ' + b.san.slice(keep).join(' '));
    S.netCand = null;
    S.netOpen = false;
    S.netPly = S.chess.history().length;
    netFound();
    e.act = 'fixed';
    return 'fixed';
  }

  /*
   * Кадр для сети — уменьшенный до 320 пикселей по ширине (уменьшает видеокарта, почти даром):
   * сети нужно 16 пикселей на клетку, а копировать в фоновый поток и выпрямлять в 4 раза меньше.
   */
  const NET_W = 320;
  const netCanvas = document.createElement('canvas');
  const netCtx = netCanvas.getContext('2d', { willReadFrequently: true });
  function netFrame() {
    if (!video.videoWidth || !S.H || !proc.width) return null;
    const s = Math.min(1, NET_W / proc.width);
    const w = Math.round(proc.width * s), h = Math.round(proc.height * s);
    if (netCanvas.width !== w || netCanvas.height !== h) { netCanvas.width = w; netCanvas.height = h; }
    netCtx.drawImage(video, 0, 0, w, h);
    let img;
    try { img = netCtx.getImageData(0, 0, w, h); } catch (e) { return null; }
    const H = S.H.slice();
    for (let i = 0; i < 6; i++) H[i] *= s; // гомография «доска → пиксели» для уменьшенного кадра
    return { img, H };
  }

  /*
   * Основной режим при съёмке сверху: партию ведёт GameTracker по ответам нейросети.
   * Сеть смотрит на доску непрерывно (READ_MS), трекер держит гипотезы о сыгранных ходах,
   * запись = лучшая гипотеза. Старая логика (сравнение с эталоном) работает, если сети нет
   * или камера сбоку.
   */
  const READ_MS = 250;     // проверка сетью 4 раза в секунду (две копии сети в фоне — успевают и телефоны)
  const MOVE_MS = 150;     // клетка «в движении», если движение было за последние 150 мс
  let gtr = null;
  function trackerOn() {
    return !!(boardNet && GT && settings.ai && !window.vcNoTracker && S.cam && S.cam.tilt < QUIET_MAX_TILT);
  }
  function trackerReset() { gtr = null; S.gtRes = null; S.gtNeedReset = true; S.gtQueue = []; }
  function sqCellMap() { return GT.SQUARES.map(q => BV.squareToCell(q, S.k)); }
  function movingNow(t) {
    const m = new Uint8Array(64);
    for (let i = 0; i < 64; i++) m[i] = t - tracker.since[BV.squareToCell(GT.SQUARES[i], S.k)] < MOVE_MS ? 1 : 0;
    return m;
  }
  function trackerTick(t) {
    // Телефон: сеть считают фоновые потоки (по очереди), перебор гипотез — здесь, ответы строго по порядку кадров.
    if (netBgs.length && !S.manual && netBgs.some(b => !b.failed)) {
      if (!gtr || S.gtNeedReset) {
        gtr = new GT.Tracker(null, window.vcTrackerOpts);
        gtr.reset(S.chess.fen());
        S.gtBase = S.chess.history().length;
        S.gtAt = -1e9; S.gtQueue = []; S.gtNeedReset = false;
        S.gtGen = (S.gtGen || 0) + 1;
      }
      const q = S.gtQueue;
      // ответ, которого нет дольше 3 с (поток завис), пропускаем, чтобы не держать очередь
      while (q.length && (q[0].done || performance.now() - q[0].at > 3000)) {
        const R = q.shift();
        if (!R.probs) continue;
        const a = performance.now();
        trackerApply(R.t, R.probs, R.moving, R.ms);
        if (R.perf) R.perf[2] = Math.round(performance.now() - a);
      }
      if (t - S.gtAt >= READ_MS) {
        const bg = netBgs.find(b => !b.busy && !b.failed);
        if (bg) {
          const fr = netFrame();
          if (!fr) return;
          // расписание по сетке 250 мс, а не от момента запуска: шаг цикла на телефоне ~50 мс,
          // и «от запуска» выходило 0,30 с между проверками вместо 0,25
          S.gtAt = Math.max(S.gtAt + READ_MS, t - READ_MS / 2);
          const req = { t, moving: movingNow(t), at: performance.now(), done: false, probs: null, gen: S.gtGen };
          const vt = Math.round(video.currentTime * 100) / 100;
          q.push(req);
          bg.run(fr.img, fr.H, (p, err, d) => {
            req.ms = Math.round(performance.now() - req.at);
            req.perf = [vt, d && d.ms ? d.ms.net : null, null, req.ms];
            if (d && d.wasm != null) S.netWasm = d.wasm;
            perfLog.push(req.perf);
            if (perfLog.length > 600) perfLog.shift();
            req.probs = p && req.gen === S.gtGen ? p : null;
            req.done = true;
          });
        }
      }
      return;
    }
    if (!gtr) {
      gtr = new GT.Tracker(Chess, window.vcTrackerOpts);
      gtr.reset(S.chess.fen());
      S.gtBase = S.chess.history().length;
      S.gtAt = -1e9;
    }
    // без фоновых потоков (и в покадровых тестах) — сеть прямо здесь
    if (t - S.gtAt < READ_MS) return;
    const fr = netFrame();
    if (!fr) return;
    S.gtAt = t;
    const t0 = performance.now();
    const probs = boardNet.run(fr.img, fr.H);
    trackerApply(t, probs, movingNow(t), Math.round(performance.now() - t0));
  }
  function trackerApply(t, probs, moving, ms) {
    S.netP = probs;
    S.netPAt = t;
    const K = boardNet.classes;
    const t0 = performance.now();
    const best = gtr.read(t / 1000, i => BN.probs4(probs, BV.squareToCell(GT.SQUARES[i], S.k), K), i => !!moving[i]);
    if (window.vcReadTrace) window.vcReadTrace.push({ t: t / 1000, vt: video.currentTime, p: GT.SQUARES.map(sq => BN.probs4(probs, BV.squareToCell(sq, S.k), K).map(x => Math.round(x * 1e4) / 1e4)), m: Array.from(moving, x => x ? 1 : 0) });
    const searchMs = Math.round(performance.now() - t0);
    if (!best) return;
    syncRecord(best.moves, ms, searchMs);
  }

  /** Запись = начало партии до трекера + ходы лучшей гипотезы ({from, to, promotion}). */
  function syncRecord(want, ms, searchMs) {
    const hist = S.chess.history({ verbose: true }).slice(S.gtBase);
    const same = (a, b) => a.from === b.from && a.to === b.to && (a.promotion || '') === (b.promotion || '');
    let k = 0;
    while (k < hist.length && k < want.length && same(hist[k], want[k])) k++;
    if (k === hist.length && k === want.length) return;
    const e = { t: Math.round(video.currentTime * 100) / 100, rec: hist.slice(k).map(m => m.san).join(' '), best: '', ms, search: searchMs, act: 'track' };
    undoPlies(hist.length - k);
    const played = [];
    for (const m of want.slice(k)) { const p = applyMove({ from: m.from, to: m.to, promotion: m.promotion }, 'net'); if (!p) break; played.push(p.san); }
    e.best = played.join(' ');
    // переписаны уже записанные ходы — сразу говорим, какие, чтобы было видно, что подогнано
    if (hist.length > k) toast('Исправлено: ' + (e.rec || '—') + ' → ' + (e.best || '—'));
    netLog.push(e);
    if (netLog.length > 400) netLog.shift();
    if (window.vcNetTrace) window.vcNetTrace.push(e);
    if (hist.length > k) {
      const h2 = S.chess.history({ verbose: true }), last = h2[h2.length - 1];
      S.lastMove = last ? [last.from, last.to] : [];
      renderBoard(); renderMoves(); autosave();
    }
  }

  /** Вероятности сети по клетке: [пусто, белая, чёрная, рука]. */
  function netProbs(sq, probs) {
    return BN.probs4(probs || S.netP, BV.squareToCell(sq, S.k), boardNet.classes);
  }

  /*
   * Точка отсчёта без спокойной доски: руки над доской почти всё время (быстрая игра, двое детей),
   * а эталон снимать нужно. Если сеть видит на всех открытых клетках ровно записанную позицию —
   * берём текущий кадр; клетки под рукой переснимем, когда она уйдёт.
   */
  function netBootstrap(feat) {
    if (!boardNet || !settings.ai || window.vcNoNet || !S.lastImg || !S.H) return;
    if (!(S.cam && S.cam.tilt < QUIET_MAX_TILT)) return;
    const t = tracker.now;
    if (t - S.netAt < NET_RETRY_MS) return;
    const fr = netFrame();
    if (!fr) return;
    S.netAt = S.netPAt = t;
    S.netP = boardNet.run(fr.img, fr.H);
    const hidden = new Set();
    for (let c = 0; c < 64; c++) {
      if (t - tracker.since[c] >= QUIET_MS) continue;
      const r = c >> 3, col = c & 7;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = col + dc;
        if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) hidden.add(BV.cellToSquare(rr * 8 + cc, S.k));
      }
    }
    for (const sq of BV.SQUARES) if (netProbs(sq)[3] >= 0.5) hidden.add(sq);
    if (hidden.size > 24) { netLog.push({ t: Math.round(video.currentTime * 100) / 100, mask: hidden.size, act: 'boot-busy' }); return; }
    // Как обычная проверка сетью: подтвердить позицию или найти ходы, сделанные, пока руки были над доской.
    const r = netDecide(S.netP, t, hidden, null, 0);
    if (r !== 'ok' && r !== 'fixed') return;
    setBase(feat, Array.from(hidden));
    S.netPly = S.chess.history().length;
  }

  function netLost(t, bad) {
    if (!S.netLostSince) { S.netLostSince = t; return; }
    if (t - S.netLostSince > 3000 && !S.lostWarned) {
      S.lostWarned = true;
      S.warn = { text: 'Не понял ход — проверьте доску: ' + bad.slice(0, 4).join(', '), until: Date.now() + 8000 };
      feedback(true);
    }
  }

  function netFound() {
    S.netLostSince = 0;
    S.lostSince = 0;
    S.lostWarned = false;
  }

  /*
   * Ход записан, когда клетки замерли на доли секунды, — рука могла ещё частично
   * закрывать клетку. Когда клетки хода и их соседи спокойны 0,3 с, переснимаем их эталон.
   * Если соперник уже начал ход (изменилась другая клетка), не трогаем — это решит проверка.
   */
  function refineRef(feat, ch, t, stillMs, lastMotion) {
    const R = S.refine;
    if (!R) return;
    if (t - R.at > 5000) { S.refine = null; return; }
    const T = settings.threshold;
    for (const sq of BV.SQUARES) {
      if (!R.squares.has(sq) && !S.recent.has(sq) && ch.bySquare[sq] >= T && S.onset[sq] != null && S.onset[sq] > R.at) {
        S.refine = null;
        return;
      }
    }
    const cells = [];
    for (const sq of Array.from(R.squares)) {
      if (stillMs[sq] >= 300 && t - lastMotion[sq] >= 300) {
        cells.push(BV.squareToCell(sq, S.k));
        R.squares.delete(sq);
        delete S.onset[sq];
      }
    }
    if (cells.length) BV.copyCells(S.ref, feat, cells);
    if (!R.squares.size) S.refine = null;
  }

  /*
   * Руку с фигурой задержали над клеткой по пути — ход записался раньше времени.
   * Если вскоре клетка назначения снова выглядит как до хода, ход ложный: отменяем его
   * (настоящий ход найдётся, когда фигуру поставят).
   */
  function revertInTransit(feat, t, stillMs) {
    const L = S.lastFast;
    if (!L) return false;
    if (t - L.t > 2500 || S.chess.history().length !== L.ply) { S.lastFast = null; return false; }
    const chPre = BV.squareChanges(L.pre, feat, S.k).bySquare;
    if (chPre[L.to] >= settings.threshold * 0.6 || stillMs[L.to] < settings.fastMs) return false;
    // Та же фигура явно стоит на другой клетке, куда могла пойти этим ходом?
    // и больше ничего не изменилось (иначе это уже ответ соперника, например взятие на проходе).
    const T = settings.threshold;
    const undone = S.chess.undo();
    const alt = undone ? S.chess.moves({ square: L.from, verbose: true })
      .filter(m => m.to !== L.to && chPre[m.to] >= T && stillMs[m.to] >= settings.fastMs) : [];
    if (undone) S.chess.move(undone);
    if (alt.length !== 1) return false;
    const explained = new Set([L.from, L.to, alt[0].to]);
    for (const q of [L.from, L.to, alt[0].to]) for (const o of S.occ[q] || []) explained.add(o);
    if (BV.SQUARES.some(q => !explained.has(q) && chPre[q] >= T * 1.6)) return false;
    undoPlies(1);
    const hist = S.chess.history({ verbose: true });
    const last = hist[hist.length - 1];
    S.lastMove = last ? [last.from, last.to] : [];
    S.ref = L.pre;
    S.refine = null;
    S.lastFast = null;
    S.snaps = S.snaps.filter(x => x.ply <= S.chess.history().length);
    renderBoard();
    renderMoves();
    autosave();
    return true;
  }

  /*
   * Клетка давно (5 с) изменилась и неподвижна, но ни один возможный ход её не объясняет
   * (на углу доски лежит рука, сдвинули часы, изменился свет) — принимаем её новый вид
   * как норму, иначе она навсегда мешает проверке.
   */
  const ABSORB_MS = 5000;
  function absorbStale(feat, ch, stillMs) {
    const T = settings.threshold;
    const stale = BV.SQUARES.filter(sq => ch.bySquare[sq] >= T && stillMs[sq] >= ABSORB_MS);
    if (!stale.length) return;
    const legal = S.chess.moves({ verbose: true });
    const cells = [];
    for (const sq of stale) {
      // клетка может быть частью хода, другие клетки которого видны слабо — такую не впитываем
      const part = S.cam && S.cam.tilt < QUIET_MAX_TILT ? 0.5 : 1; // сверху светлые фигуры видны слабо
      const used = legal.some(m => {
        const q = BV.squaresOfMove(m);
        return q.indexOf(sq) >= 0 && q.every(x => ch.bySquare[x] >= T * part);
      });
      if (used) continue;
      cells.push(BV.squareToCell(sq, S.k));
      delete S.onset[sq];
    }
    if (!cells.length) return;
    BV.copyCells(S.ref, feat, cells);
    if (S.fullRef) BV.copyCells(S.fullRef, feat, cells);
    logMove(cells.length + ' cells', 'absorb');
  }

  /** Вероятности ИИ по клетке доски (только когда ИИ уже узнаёт руку). */
  function aiClassOf() {
    if (!S.aiP || !ai.knowsHand()) return null;
    const P = S.aiP;
    return sq => P[BV.squareToCell(sq, S.k)];
  }

  function undoPlies(n) {
    for (let i = 0; i < n; i++) {
      const m = S.chess.undo();
      if (m) { S.times.pop(); logMove(m.san, 'undo'); }
    }
  }

  /*
   * Полная проверка: вся доска неподвижна. Сравниваем с эталоном прошлой проверки
   * и сверяем с быстро записанными ходами: подтверждаем, исправляем или отменяем.
   */
  function onSettled(feat) {
    ensureOcc();
    const hist = S.chess.history({ verbose: true });
    // Проверяем не больше двух последних ходов: если быстрых ходов накопилось больше,
    // сравниваем со снимком эталона, сделанным перед двумя последними.
    let bPly = S.basePly, bRef = S.fullRef;
    if (hist.length - bPly > 2) {
      const snap = S.snaps.find(x => x.ply === hist.length - 2) || S.snaps.find(x => x.ply === hist.length - 1);
      if (snap) { bPly = snap.ply; bRef = snap.ref; }
    }
    const fast = hist.slice(bPly);
    const base = positionAt(bPly);
    const ch = BV.squareChanges(bRef, feat, S.k);
    S.changes = ch;
    const T = settings.threshold;
    const r = BV.findMove(base, ch.bySquare, { threshold: T, occ: S.occ, allowDouble: true , classOf: aiClassOf() });
    debugLog.push({
      t: Math.round(video.currentTime * 10) / 10, type: r.type,
      moves: r.moves ? r.moves.map(m => m.san) : [], fast: fast.map(m => m.san),
      top: Object.entries(ch.bySquare).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([q, v]) => q + ':' + v.toFixed(0)),
    });
    if (debugLog.length > 300) debugLog.shift();
    const same = (a, b) => a.length === b.length && a.every((m, i) => m.from === b[i].from && m.to === b[i].to);

    // Быстро записанные ходы — гипотеза: оставляем их, если их клетки действительно
    // изменились и они объясняют картину не хуже, чем результат проверки.
    // Сравниваем итоговые позиции: должны измениться клетки, где содержимое стало другим.
    const opts = { threshold: T, occ: S.occ };
    const netF = netSquares(base, S.chess);
    const fs = fast.length ? BV.scoreSquares(netF, ch.bySquare, opts) : null;
    let rs = null, posR = null, netR = null;
    if (r.type === 'move') {
      posR = new Chess(base.fen());
      for (const m of r.moves) posR.move({ from: m.from, to: m.to, promotion: m.promotion });
      netR = netSquares(base, posR);
      rs = BV.scoreSquares(netR, ch.bySquare, opts);
    }
    let fastBetter = true;
    if (rs) {
      const emptyDiff = S.empty.feat ? BV.cellDiff(feat, S.empty.feat) : null;
      const fi = occupancyMismatch(S.chess, netF, emptyDiff), ri = occupancyMismatch(posR, netR, emptyDiff);
      // При равенстве лучше то объяснение, где изменения объяснены самими ходами, а не «тенью».
      fastBetter = !!fs && (fi < ri || (fi === ri && (fs.unexplained < rs.unexplained ||
        (fs.unexplained === rs.unexplained && fs.direct <= rs.direct))));
    }
    const fastOk = fs && fs.fits && fs.unexplained <= 1 && fs.noise <= 3 && fastBetter;

    if (fastOk) {
      // Записанное подтвердилось. Нет ли ещё хода среди оставшихся (слабых) изменений?
      // Например, чёрная пешка на тёмных клетках меняет картинку слабо.
      const r2 = BV.findMove(S.chess, BV.squareChanges(S.ref, feat, S.k).bySquare, { threshold: T, occ: S.occ, allowDouble: false , classOf: aiClassOf() });
      if (r2.type === 'move' && !r2.relaxed) {
        for (const m of r2.moves) applyMove({ from: m.from, to: m.to, promotion: m.promotion }, 'camera');
      }
      setBase(feat);
      S.warn = null;
    } else if (r.type === 'move') {
      if (!same(r.moves, fast)) {
        if (!fast.length) {
          for (const m of r.moves) applyMove({ from: m.from, to: m.to, promotion: m.promotion }, 'camera');
          if (r.double) toast('Записаны два хода подряд');
        } else {
          undoPlies(fast.length);
          for (const m of r.moves) applyMove({ from: m.from, to: m.to, promotion: m.promotion }, 'fix');
          toast('Ход исправлен: ' + S.chess.history().slice(-r.moves.length).join(' '));
        }
      }
      setBase(feat);
      S.warn = null;
    } else if (r.type === 'none') {
      if (fast.length) {
        undoPlies(fast.length);
        S.lastMove = [];
        renderBoard(); renderMoves(); autosave();
        toast('Ложный ход отменён');
        setBase(feat);
      } else if (ch.max < T * 0.6) {
        setBase(feat); // фигуры не двигались — обновим эталон, чтобы не копить дрейф освещения
      }
    } else {
      // С прошлой проверкой не сходится (например, после быстрых ходов успели сделать ещё один).
      // Сравним с рабочим эталоном — доской после уже записанных ходов.
      const r2 = fast.length
        ? BV.findMove(S.chess, BV.squareChanges(S.ref, feat, S.k).bySquare, { threshold: T, occ: S.occ, allowDouble: true , classOf: aiClassOf() })
        : { type: 'unclear' };
      if (r2.type === 'move' && !r2.weak) {
        for (const m of r2.moves) applyMove({ from: m.from, to: m.to, promotion: m.promotion }, 'camera');
        setBase(feat);
      } else if (r2.type === 'none' || fast.length > 2) {
        setBase(feat); // доска совпадает с записанным (или цепочка слишком длинная, чтобы перепроверить)
      } else if (!fast.length && r.changed.length > 1) {
        // Одна изменившаяся клетка — скорее всего, фигуру ещё держат в руке: просто ждём.
        S.warn = {
          text: 'Не понял ход. Поправьте фигуры или сделайте ход на цифровой доске.',
          until: Date.now() + 6000,
        };
      }
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
    logMove(played.san, source);
    S.selected = null;
    if (source === 'manual') { S.ref = null; S.netPly = S.chess.history().length; trackerReset(); } // эталон снимем заново, когда доска успокоится
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
    S.netPly = S.chess.history().length;
    trackerReset();
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
        if (S.autoDetect) return ['search', 'Ищу доску… Наведите камеру так, чтобы вся доска в начальной позиции была в кадре.'];
        if (S.badQuad) return ['err', 'Углы заданы неверно — поставьте точки на 4 угла доски.'];
        if (!S.recog) return ['search', 'Ищу доску…'];
        return ['search', 'Ищу начальную расстановку… Проверьте углы и фигуры. Если игра уже идёт — «Начать без проверки».'];
      case 'ready':
        if (S.source === 'file' && video.paused) return ['ok', 'Доска распознана — запустите видео.'];
        return ['ok', 'Доска распознана — ждём первого хода.'];
      case 'recording':
        if (S.source === 'file' && video.ended) return ['ok', 'Видео закончилось. Проверьте ходы и нажмите «Закончить партию».'];
        return ['rec', 'Идёт запись. Ход засчитывается, как только вы отпустили фигуру.'];
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

  let aiInfoAt = 0;
  function updateAIInfo() {
    if (performance.now() - aiInfoAt < 1000) return;
    aiInfoAt = performance.now();
    const el = $('#aiInfo');
    if (!settings.ai) { el.textContent = 'ИИ выключен: работают только правила.'; return; }
    const n = ai.count();
    if (!n) { el.textContent = 'Нейросеть начнёт учиться, когда доска будет распознана.'; return; }
    el.textContent = `Обучено на ${n} клетках (рука: ${ai.count(AI.HAND)}), ` +
      (ai.ready() ? `точность ${Math.round(ai.accuracy() * 100)}%.` : 'ещё учится…');
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
    if (S.phase === 'setup' && S.autoDetect && !S.autoShown) {
      // Доска ещё не найдена — только крутилка «ищу доску».
      const R = Math.max(14, Math.min(w, h) * 0.07), t = performance.now() / 600;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(3, R / 4);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, R, t, t + Math.PI * 1.5);
      ctx.stroke();
      return;
    }

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

      if (settings.heatmap && S.aiP) {
        for (let cell = 0; cell < 64; cell++) {
          const p = S.aiP[cell];
          if (!p || p[AI.HAND] < 0.5) continue;
          ctx.fillStyle = `rgba(60,140,255,${0.25 + 0.35 * p[AI.HAND]})`;
          cellPath(cell >> 3, cell & 7);
          ctx.fill();
        }
      }
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
    resetEmpty();
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
    S.autoDetect = false; // углы правят вручную — автопоиск больше не вмешивается
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
    S.debug = null;
    S.autoDetect = !resume;
    S.autoShown = false;
    S.lastAutoAt = 0;
    S.lastImg = null;
    S.ref = null;
    S.fullRef = null;
    resetEmpty();
    ai.reset();
    S.aiP = null;
    S.netP = null;
    S.netPAt = -1;
    S.netStale = false;
    S.netCache = null;
    S.netRes = null;
    S.netPly = null;
    S.netCand = null;
    trackerReset();
    S.netAt = -1e9;
    S.netOpen = false;
    S.netLostSince = 0;
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

  function buildPgn(result, extra) {
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
    for (const k in extra || {}) g.header(k, clean(extra[k]));
    return g.pgn({ max_width: 80, newline_char: '\n' });
  }

  function finishGame(result) {
    $('#finishSheet').hidden = true;
    bcUpdate(result, true);
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
    updateDebugCard();
    showScreen('screenResult');
  }

  const TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
    л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
    ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const translit = str => Array.from(str).map(ch => {
    const lo = ch.toLowerCase(), t = TRANSLIT[lo];
    if (t === undefined) return ch;
    return ch !== lo && t ? t[0].toUpperCase() + t.slice(1) : t;
  }).join('');

  // Имя файла латиницей: некоторые браузеры заменяют кириллическое имя на «download».
  /** Журнал для отладки: где была доска, настройки и все решения программы со временем. */
  function debugLogJson() {
    return JSON.stringify({
      app: 'live-chessboard/record', createdAt: new Date().toISOString(), ua: navigator.userAgent,
      device: { cores: navigator.hardwareConcurrency || null, netWorkers: netBgs.filter(b => !b.failed).length, wasm: S.netWasm == null ? null : S.netWasm },
      video: { width: video.videoWidth || null, height: video.videoHeight || null, recordStartT: S.debug ? S.debug.videoT0 : null, type: S.debug ? S.debug.type : null },
      version: APP_VERSION, corners: S.corners, k: S.k, settings, headers: S.headers,
      broadcast: (() => { const c = bcConf(); return c.on ? { round: c.round, board: c.board, boards: c.boards, last: bcLast } : null; })(),
      camera: S.cam ? { tilt: Math.round(S.cam.tilt * 10) / 10, diff: BV.diffOpts.mode } : null,
      moves: moveLog, settles: debugLog, quiet: quietLog, net: netLog, perf: perfLog, history: S.chess.history(), pgn: $('#pgnOut').value,
    }, null, 1);
  }

  function debugBaseName() {
    const d = new Date(S.debug ? S.debug.startedAt : Date.now());
    const p = n => String(n).padStart(2, '0');
    return `game-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function debugVideoFile() {
    const D = S.debug;
    if (!D || !D.blob) return null;
    const ext = /mp4/.test(D.type) ? 'mp4' : 'webm';
    return new File([D.blob], debugBaseName() + '.' + ext, { type: D.blob.type || D.type });
  }

  function debugLogFile() {
    return new File([debugLogJson()], debugBaseName() + '-log.json', { type: 'application/json' });
  }

  function saveFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Блок «отправить для отладки» показываем после каждой партии: журнал есть всегда, видео — если удалось записать.
  function updateDebugCard() {
    const D = S.debug;
    const card = $('#debugCard');
    if (!card) return;
    card.hidden = false;
    const ready = !!(D && D.blob);
    $('#btnDebugVideo').hidden = !D;
    $('#btnSendDebug').disabled = !!D && !ready;
    $('#btnGhSend').disabled = !!D && !ready;
    $('#btnDebugVideo').disabled = !ready;
    $('#debugInfo').textContent = !D
      ? (settings.saveVideo ? 'Этот браузер не смог записать видео — отправьте хотя бы журнал.' : 'Запись видео выключена в настройках — отправьте журнал.')
      : ready
        ? `Видео: ${(D.blob.size / 1048576).toFixed(1)} МБ` + (D.bytes > DEBUG_MAX_BYTES ? ' (записано только начало партии)' : '')
        : 'Готовлю видео…';
  }

  /* ---------- Отправка отчёта в репозиторий GitHub ---------- */
  // Видео и журнал загружаются в закрытый репозиторий владельца (токен хранится только на телефоне),
  // откуда их забирает разработчик. Размер видео не ограничен чатом: большие делим на части.
  const GH_API = 'https://api.github.com';
  const GH_PART = 15 * 1024 * 1024;
  // Адрес репозитория для отчётов можно вписать сюда. Токен — нельзя: код сайта открыт всем,
  // а GitHub сам отзывает токены, попавшие в открытый репозиторий.
  const GH_DEFAULT_REPO = 'MisterFoxxy/live-chessboard-reports';
  const gh = {
    get repo() { return store.get('vc_gh_repo', '') || GH_DEFAULT_REPO; },
    get token() { return store.get('vc_gh_token', ''); },
  };

  /** Просим браузер не стирать данные сайта (иначе Safari может удалить их через неделю без визитов). */
  function keepStorage() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* нет API */ }
  }

  /**
   * Ссылка вида record.html#gh=ТОКЕН (можно с &repo=владелец/имя) сохраняет токен на телефоне и
   * сразу убирает его из адресной строки. Такую ссылку удобно держать в заметках или закладках:
   * если телефон сотрёт данные сайта, достаточно открыть её снова.
   */
  function ghTokenFromLink() {
    const h = location.hash.replace(/^#/, '');
    if (!/(^|&)gh=/.test(h)) return;
    const p = new URLSearchParams(h);
    const token = (p.get('gh') || '').trim(), repo = (p.get('repo') || '').trim();
    if (token) store.set('vc_gh_token', token);
    if (repo) store.set('vc_gh_repo', repo);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    keepStorage();
    if (token) setTimeout(() => toast('Токен для отчётов сохранён на этом телефоне'), 300);
  }

  function ghRestoreLink() {
    const base = location.origin + location.pathname;
    return base + '#gh=' + encodeURIComponent(gh.token) + (gh.repo !== GH_DEFAULT_REPO ? '&repo=' + encodeURIComponent(gh.repo) : '');
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error || new Error('read'));
      r.readAsDataURL(blob);
    });
  }

  function ghRequest(method, path, body, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, GH_API + path);
      x.setRequestHeader('Authorization', 'Bearer ' + gh.token);
      x.setRequestHeader('Accept', 'application/vnd.github+json');
      if (body) x.setRequestHeader('Content-Type', 'application/json');
      if (onProgress && x.upload) x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded); };
      x.onload = () => {
        let data = null;
        try { data = JSON.parse(x.responseText); } catch (e) { /* не JSON */ }
        resolve({ status: x.status, data });
      };
      x.onerror = () => reject(new Error('network'));
      x.send(body ? JSON.stringify(body) : null);
    });
  }

  const ghPath = p => p.split('/').map(encodeURIComponent).join('/');

  function ghError(status, data) {
    if (status === 401) return 'GitHub не принял токен: проверьте его или создайте новый.';
    if (status === 403) return 'У токена нет права записи (Contents: Read and write) или он истёк.';
    if (status === 404) return 'Репозиторий не найден или токен к нему не допущен.';
    if (status === 413) return 'Файл слишком большой для GitHub.';
    return 'Ошибка GitHub ' + status + (data && data.message ? ': ' + data.message : '');
  }

  async function ghCheck() {
    if (!/^[\w.-]+\/[\w.-]+$/.test(gh.repo) || !gh.token) return 'Укажите репозиторий (владелец/имя) и токен.';
    let r;
    try { r = await ghRequest('GET', '/repos/' + gh.repo); } catch (e) { return 'Нет связи с GitHub.'; }
    if (r.status !== 200) return ghError(r.status, r.data);
    if (r.data && r.data.permissions && r.data.permissions.push === false) return 'У токена нет права записи в репозиторий.';
    return null;
  }

  /** Загружает файлы в папку репозитория по одному (большие делит на части), с полосой прогресса. */
  async function ghUploadFiles(folder, files, label, bar, info) {
    const part = window.vcGhPart || GH_PART; // размер части (в проверках — меньше)
    const list = [];
    for (const f of files) {
      if (f.blob.size <= part) list.push(f);
      else for (let i = 0, k = 1; i < f.blob.size; i += part, k++) list.push({ name: `${f.name}.part${k}`, blob: f.blob.slice(i, i + part) });
    }
    const total = list.reduce((n, f) => n + f.blob.size, 0) * 4 / 3 + 1;
    let done = 0;
    bar.hidden = false;
    const show = x => { bar.firstElementChild.style.width = Math.min(100, Math.round(x / total * 100)) + '%'; };
    show(0);
    for (const f of list) {
      info.textContent = `Отправляю ${f.name} (${(f.blob.size / 1048576).toFixed(1)} МБ)…`;
      const content = await blobToBase64(f.blob);
      const r = await ghRequest('PUT', `/repos/${gh.repo}/contents/${ghPath(folder + '/' + f.name)}`,
        { message: `${label}: ${f.name}`, content }, loaded => show(done + loaded));
      if (r.status !== 200 && r.status !== 201) throw new Error(ghError(r.status, r.data));
      done += content.length;
      show(done);
    }
    show(total);
  }

  const ghFail = e => (e && e.message === 'network' ? 'Нет связи с GitHub. Попробуйте ещё раз.' : (e && e.message) || 'Не удалось отправить.');

  async function ghSend() {
    const info = $('#ghInfo'), bar = $('#ghProgress'), btn = $('#btnGhSend');
    if (!gh.repo || !gh.token) {
      $('#ghSetup').open = true;
      info.textContent = 'Сначала настройте отправку: репозиторий и токен (один раз).';
      return;
    }
    btn.disabled = true;
    try {
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
      const folder = `reports/${debugBaseName()}-${stamp}`;
      const files = [{ name: 'log.json', blob: new Blob([debugLogJson()], { type: 'application/json' }) }];
      const v = debugVideoFile();
      if (v) files.push({ name: 'video.' + v.name.split('.').pop(), blob: v });
      await ghUploadFiles(folder, files, 'Отчёт ' + debugBaseName(), bar, info);
      store.set('vc_gh_last', folder);
      info.textContent = `Отправлено: ${gh.repo} → ${folder}. Напишите разработчику «отправил отчёт».`;
      toast('Отчёт отправлен');
    } catch (e) {
      info.textContent = ghFail(e);
    } finally {
      btn.disabled = false;
    }
  }

  /** Видео партий (например, из idChess) для обучения распознавания — в папку training. */
  async function ghSendTraining(fileList) {
    const info = $('#trainInfo'), bar = $('#trainProgress');
    if (!gh.token) {
      $('#trainTokenRow').hidden = false;
      info.textContent = 'Сначала вставьте токен GitHub (тот же, что для отчётов) и нажмите «Сохранить».';
      return;
    }
    const files = Array.from(fileList || []);
    if (!files.length) return;
    $('#trainPick').classList.add('disabled');
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    let sent = 0;
    try {
      for (const f of files) {
        const base = translit(f.name.replace(/\.[^.]+$/, '')).replace(/[^A-Za-z0-9.-]+/g, '_').replace(/^_+|_+$/g, '') || 'video';
        const ext = (f.name.match(/\.([A-Za-z0-9]+)$/) || [])[1] || 'mp4';
        const folder = `training/${stamp}-${String(sent + 1).padStart(2, '0')}-${base}`;
        await ghUploadFiles(folder, [{ name: 'video.' + ext.toLowerCase(), blob: f }], `Видео для обучения ${sent + 1}/${files.length}`, bar, info);
        sent++;
      }
      info.textContent = `Отправлено видео: ${sent}. Напишите разработчику «отправил видео для обучения».`;
      toast('Видео отправлены');
    } catch (e) {
      info.textContent = (sent ? `Отправлено ${sent} из ${files.length}. ` : '') + ghFail(e);
    } finally {
      $('#trainPick').classList.remove('disabled');
      $('#trainFiles').value = '';
    }
  }

  function fileName(pgn) {
    const tag = n => (pgn.match(new RegExp('\\[' + n + ' "([^"]*)"\\]')) || [])[1] || '';
    const base = translit(`${tag('White')}-${tag('Black')}-${tag('Date')}`)
      .replace(/[^A-Za-z0-9.-]+/g, '_').replace(/^_+|_+$/g, '');
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
    $('#appVersion').textContent = APP_VERSION;
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
      resetEmpty();
      S.ref = null;
      store.set('vc_k', S.k);
      drawOverlay();
      toast('Белые: ' + ['снизу', 'слева', 'сверху', 'справа'][S.k]);
    });
    $('#btnAutoFind').addEventListener('click', () => {
      if (S.phase === 'recording') { toast('Запись уже идёт'); return; }
      S.autoDetect = true;
      S.autoShown = false;
      S.lastAutoAt = 0;
      if (S.phase === 'ready') { S.phase = 'setup'; S.recogStreak = 0; }
      toast('Ищу доску…');
    });
    $('#btnForceStart').addEventListener('click', () => {
      if (S.phase !== 'setup') { toast(S.phase === 'ready' ? 'Доска уже распознана' : 'Запись уже идёт'); return; }
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
      if (tracker.isSteady()) setBase(tracker.steadyFeatures()); else S.ref = null;
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
    $('#btnDebugVideo').addEventListener('click', () => { const f = debugVideoFile(); if (f) saveFile(f); });
    $('#btnDebugLog').addEventListener('click', () => saveFile(debugLogFile()));
    const ghFill = () => { $('#ghRepo').value = gh.repo; $('#ghToken').value = gh.token ? '••••••••' : ''; };
    ghTokenFromLink();
    ghFill();
    // ссылку могли открыть во вкладке, где приложение уже открыто
    window.addEventListener('hashchange', () => { ghTokenFromLink(); ghFill(); });
    $('#ghLink').addEventListener('click', async () => {
      if (!gh.token) { $('#ghInfo').textContent = 'Сначала сохраните токен.'; return; }
      const link = ghRestoreLink();
      try {
        await navigator.clipboard.writeText(link);
        $('#ghInfo').textContent = 'Ссылка скопирована. Сохраните её в Заметках (не пересылайте никому): если телефон сотрёт данные сайта, откройте её — токен восстановится.';
      } catch (e) {
        prompt('Скопируйте и сохраните ссылку (не пересылайте никому):', link);
      }
    });
    $('#ghSave').addEventListener('click', async () => {
      const repo = $('#ghRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
      const token = $('#ghToken').value.trim();
      store.set('vc_gh_repo', repo);
      if (token && !/^•+$/.test(token)) { store.set('vc_gh_token', token); keepStorage(); }
      $('#ghRepo').value = repo;
      $('#ghToken').value = gh.token ? '••••••••' : '';
      $('#ghInfo').textContent = 'Проверяю доступ…';
      const err = await ghCheck();
      $('#ghInfo').textContent = err || 'Готово: отчёты будут уходить в ' + repo + '.';
      if (!err) $('#ghSetup').open = false;
    });
    $('#ghForget').addEventListener('click', () => {
      store.del('vc_gh_token');
      $('#ghToken').value = '';
      $('#ghInfo').textContent = 'Токен удалён с этого телефона.';
    });
    $('#btnGhSend').addEventListener('click', ghSend);
    // трансляция на lichess
    const bcFill = () => {
      const c = bcConf();
      $('#bcRound').value = c.round; $('#bcBoard').value = c.board; $('#bcBoards').value = c.boards;
      $('#bcOn').checked = !!c.on;
      $('#bcToken').value = bcToken() ? '••••••••' : '';
      const n = Math.max(1, Math.floor(+c.boards) || 1);
      $('#bcRate').textContent = 'Один аккаунт lichess принимает до 120 обновлений в минуту на все свои доски: при ' + n +
        (n === 1 ? ' доске' : ' досках') + ' ход появится на lichess не позже чем через ' + LB.minInterval(n) + ' с.' +
        (n > 8 ? ' Быстрее — если у групп досок свои аккаунты lichess (участники трансляции).' : '');
    };
    const bcSave = () => {
      const tok = $('#bcToken').value.trim();
      if (tok && !/^•+$/.test(tok)) { store.set('vc_bc_token', tok); keepStorage(); }
      const round = $('#bcRound').value.trim();
      store.set('vc_bc', { round, board: $('#bcBoard').value.trim(), boards: $('#bcBoards').value.trim(), on: $('#bcOn').checked });
      bcFill();
      bcUpdate('*');
    };
    if (LB) {
      bcFromLink();
      bcFill();
      window.addEventListener('hashchange', () => { bcFromLink(); bcFill(); });
      ['#bcRound', '#bcBoard', '#bcBoards', '#bcToken', '#bcOn'].forEach(id => $(id).addEventListener('change', bcSave));
      $('#bcCheck').addEventListener('click', async () => {
        bcSave();
        const round = LB.roundId(bcConf().round);
        if (!round) { $('#bcInfo').textContent = 'Вставьте ссылку на раунд: lichess.org/broadcast/…/…/xxxxxxxx'; return; }
        if (!bcToken()) { $('#bcInfo').textContent = 'Вставьте токен lichess.'; return; }
        $('#bcInfo').textContent = 'Проверяю…';
        try {
          const r = await LB.check(round, bcToken());
          $('#bcInfo').textContent = 'Готово: аккаунт ' + r.user + ', «' + (r.tour || '') + '», ' + (r.round || 'раунд') + '. Доска ' + (Math.floor(+bcConf().board) || 1) + '.';
        } catch (e) {
          $('#bcInfo').textContent = 'Не получилось: ' + (e && e.message || e) + '.';
        }
      });
      $('#bcLinks').addEventListener('click', async () => {
        bcSave();
        if (!LB.roundId(bcConf().round) || !bcToken()) { $('#bcInfo').textContent = 'Сначала укажите раунд и токен.'; return; }
        const text = bcLinks();
        $('#bcLinkList').hidden = false;
        $('#bcLinkList').value = text;
        try { await navigator.clipboard.writeText(text); $('#bcInfo').textContent = 'Ссылки скопированы. В них ваш токен — отправляйте их только на телефоны досок. Ссылка, открытая на телефоне, настроит его доску.'; }
        catch (e) { $('#bcInfo').textContent = 'Скопируйте ссылки из поля ниже. В них ваш токен — отправляйте их только на телефоны досок.'; }
      });
    } else $('#bcCard').hidden = true;
    $('#trainFiles').addEventListener('change', e => ghSendTraining(e.target.files));
    $('#trainTokenRow').hidden = !!gh.token;
    $('#trainTokenSave').addEventListener('click', async () => {
      const token = $('#trainToken').value.trim();
      if (!token) return;
      store.set('vc_gh_token', token);
      keepStorage();
      $('#trainToken').value = '';
      ghFill();
      $('#trainInfo').textContent = 'Проверяю доступ…';
      const err = await ghCheck();
      $('#trainInfo').textContent = err || 'Готово: можно выбирать видео.';
      if (!err) $('#trainTokenRow').hidden = true;
    });
    $('#btnSendDebug').addEventListener('click', async () => {
      const files = [debugVideoFile(), debugLogFile()].filter(Boolean);
      try {
        if (navigator.canShare && navigator.canShare({ files })) {
          await navigator.share({ files, title: 'Партия: видео и журнал' });
          return;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
      files.forEach(saveFile); // поделиться файлами нельзя — просто скачиваем
    });
    $('#setSaveVideo').checked = settings.saveVideo;
    $('#setSaveVideo').addEventListener('change', e => { settings.saveVideo = e.target.checked; saveSettings(); });

    // Настройки распознавания.
    const th = $('#setThreshold'), st = $('#setFast');
    const showVals = () => {
      $('#valThreshold').textContent = settings.threshold;
      $('#valFast').textContent = (settings.fastMs / 1000).toFixed(2) + ' с';
    };
    th.value = settings.threshold;
    st.value = settings.fastMs;
    $('#setSound').checked = settings.sound;
    $('#setHeatmap').checked = settings.heatmap;
    showVals();
    th.addEventListener('input', () => { settings.threshold = +th.value; showVals(); saveSettings(); });
    st.addEventListener('input', () => {
      settings.fastMs = +st.value;
      showVals();
      saveSettings();
    });
    $('#setSound').addEventListener('change', e => { settings.sound = e.target.checked; saveSettings(); });
    $('#setAI').checked = settings.ai;
    $('#setAI').addEventListener('change', e => { settings.ai = e.target.checked; saveSettings(); if (!settings.ai) S.aiP = null; });
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
    setCorners(c) { if (validCorners(c)) { S.autoDetect = false; S.corners = c.map(p => p.slice()); cornersChanged(); } },
    history: () => S.chess.history(),
    phase: () => S.phase,
    log: debugLog,
    motionLog,
    moves: moveLog,
    ai,
    /** Покадровая проверка (для повторяемых тестов): свой таймер выключается, кадр — по вызову. */
    manual() { S.manual = true; clearInterval(S.timer); },
    /** Для замеров: сколько фоновых потоков сети использовать (1 или 2). */
    setWorkers(n) { netBgs.forEach((b, i) => { b.failed = i >= n; }); },
    netLog,
    perfLog,
    async step(t) {
      video.pause();
      if (Math.abs(video.currentTime - t) > 1e-4) {
        // ждём не только перемотку, но и показ нового кадра (под нагрузкой кадр приходит позже)
        await new Promise(r => {
          let n = 0;
          const done = () => { if (++n === 2) r(); };
          video.addEventListener('seeked', done, { once: true });
          if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(done); else n++;
          setTimeout(() => r(), 3000);
          video.currentTime = t;
        });
      }
      tick();
    },
    /** Начать запись с произвольной позиции (FEN) и известной ориентации доски (для проверки на роликах). */
    startFrom(fen, k) {
      const c = new Chess();
      if (!c.load(fen)) return false;
      S.chess = c;
      S.times = [];
      S.lastMove = [];
      trackerReset();
      S.k = k & 3;
      S.kManual = true;
      S.autoDetect = false;
      S.ref = null;
      S.fullRef = null;
      tracker.reset();
      S.phase = 'ready';
      renderBoard();
      renderMoves();
      return true;
    },
  };
})();
