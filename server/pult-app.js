/*
 * Программа пульта турнира для ноутбука — запуск одной кнопкой (Pult.bat или значок «Пульт турнира» на рабочем столе).
 * Сама: обновляет server.js, скачивает cloudflared (если его нет), запускает сервер и бесплатный туннель Cloudflare,
 * проверяет адрес, открывает пульт в браузере с этим адресом и не даёт ноутбуку уснуть, пока окно открыто.
 * Нужен только Node.js (nodejs.org, версия LTS). Закрыть окно — пульт выключен.
 */
'use strict';
const fs = require('fs'), path = require('path'), https = require('https'), http = require('http');
const { spawn, exec } = require('child_process');

const DIR = __dirname;
const WIN = process.platform === 'win32';
const RAW = 'https://raw.githubusercontent.com/MisterFoxxy/live-chessboard/main/server/';
const CONTROL = process.env.PULT_CONTROL || 'https://misterfoxxy.github.io/live-chessboard/control.html';
const CF_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const CF = process.env.PULT_CLOUDFLARED || path.join(DIR, WIN ? 'cloudflared.exe' : 'cloudflared');
const NO_OPEN = !!process.env.PULT_NO_OPEN, NO_UPDATE = !!process.env.PULT_NO_UPDATE;

const say = s => console.log(s);
const line = () => say('─'.repeat(64));
const wait = ms => new Promise(r => setTimeout(r, ms));
const children = [];

/** Скачать файл (с переходами по redirect), показывая проценты для больших файлов. */
function download(url, dest, label, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('слишком много переадресаций'));
    const req = https.get(url, { headers: { 'User-Agent': 'live-chessboard-pult' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, label, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('ответ ' + res.statusCode)); }
      const total = +res.headers['content-length'] || 0;
      let got = 0, shown = -1;
      const tmp = dest + '.part', out = fs.createWriteStream(tmp);
      res.on('data', c => {
        got += c.length;
        const p = total ? Math.floor(got * 100 / total / 10) * 10 : -1;
        if (label && total > 1e6 && p !== shown) { shown = p; process.stdout.write(`\r   ${label}: ${p}%   `); }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        if (label && total > 1e6) process.stdout.write('\n');
        try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); }
      }));
      res.on('error', reject); out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('нет ответа')));
    req.on('error', reject);
  });
}

async function updateServer() {
  const dest = path.join(DIR, 'server.js');
  if (NO_UPDATE) return;
  try {
    await download(RAW + 'server.js', dest + '.new');
    const s = fs.readFileSync(dest + '.new', 'utf8');
    if (s.length > 2000 && /module\.exports/.test(s)) { fs.renameSync(dest + '.new', dest); say('✓ Сервер пульта обновлён до последней версии'); }
    else fs.unlinkSync(dest + '.new');
  } catch (e) {
    try { fs.unlinkSync(dest + '.new'); } catch (err) { /* нет файла */ }
    say('• Обновить сервер не удалось (' + e.message + ') — запускаю тот, что есть');
  }
}

async function ensureCloudflared() {
  if (fs.existsSync(CF)) return true;
  if (!WIN) { say('✗ Нет программы cloudflared рядом с pult-app.js — установите её (brew install cloudflared) и положите сюда.'); return false; }
  say('• Скачиваю программу Cloudflare (один раз, около 50 МБ)…');
  for (let i = 0; i < 3; i++) {
    try { await download(CF_URL, CF, 'cloudflared'); say('✓ Cloudflare скачан'); return true; }
    catch (e) { say('   не получилось: ' + e.message + (i < 2 ? ' — пробую ещё раз' : '')); await wait(2000); }
  }
  say('✗ Не удалось скачать cloudflared. Скачайте вручную: ' + CF_URL);
  say('  и положите файл в эту папку под именем cloudflared.exe');
  return false;
}

function health(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url + '/health', { timeout: 5000 }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
  });
}

/** Запустить сервер в этом же окне; если порт занят нашим же сервером (второе окно) — пользоваться им. */
async function startServer() {
  delete require.cache[require.resolve(path.join(DIR, 'server.js'))];
  const { server, VERSION } = require(path.join(DIR, 'server.js'));
  for (let port = 8080; port <= 8090; port++) {
    const ok = await new Promise(resolve => {
      const onErr = () => { server.removeListener('listening', onOk); resolve(false); };
      const onOk = () => { server.removeListener('error', onErr); resolve(true); };
      server.once('error', onErr); server.once('listening', onOk);
      server.listen(port, '127.0.0.1');
    });
    if (ok) { say('✓ Сервер пульта запущен (порт ' + port + ')'); return port; }
    const h = await health('http://127.0.0.1:' + port);
    if (h && h.ok && (+h.version || 0) >= VERSION) { say('✓ Сервер пульта уже работает в другом окне (порт ' + port + ') — использую его'); return port; }
    if (h && h.ok) say('• В другом окне работает старый сервер пульта (порт ' + port + ') — его окно можно закрыть');
  }
  throw new Error('нет свободного порта 8080–8090');
}

/** Туннель Cloudflare: адрес https://….trycloudflare.com. При обрыве — перезапуск (адрес будет новый). */
function startTunnel(port, onUrl) {
  let url = null, registered = false, stopped = false, proc = null;
  const run = () => {
    url = null; registered = false;
    proc = spawn(CF, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:' + port], { windowsHide: true });
    children.push(proc);
    let buf = '';
    const onData = d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = l.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !url) url = m[0];
        if (/Registered tunnel connection/.test(l) && !registered && url) { registered = true; onUrl(url); }
        if (process.env.PULT_VERBOSE) say('   [cloudflared] ' + l);
      }
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    proc.on('exit', code => {
      if (stopped) return;
      say(`• Туннель Cloudflare остановился (код ${code}) — перезапускаю…`);
      setTimeout(run, 3000);
    });
    // нет подключения за минуту — перезапуск
    setTimeout(() => { if (!registered && !stopped && proc.exitCode == null) { say('• Туннель долго не подключается — перезапускаю…'); proc.kill(); } }, 60000);
  };
  run();
  return { stop() { stopped = true; if (proc) proc.kill(); } };
}

function openBrowser(url) {
  if (NO_OPEN) return;
  if (WIN) exec(`start "" "${url}"`);
  else exec((process.platform === 'darwin' ? 'open' : 'xdg-open') + ` "${url}"`, () => {});
}

/** Пока окно открыто, Windows не усыпит ноутбук (экран может гаснуть). */
function keepAwake() {
  if (!WIN) return;
  const ps = `$t=Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name P -Namespace W -PassThru; `
    + `$t::SetThreadExecutionState([uint32]2147483649) | Out-Null; while ($true) { Start-Sleep 60 }`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', enc], { windowsHide: true, stdio: 'ignore' });
    p.on('error', () => {});
    children.push(p);
  } catch (e) { /* не критично */ }
}

/** Значок «Пульт турнира» на рабочем столе (один раз). */
function desktopShortcut() {
  if (!WIN || process.env.PULT_NO_SHORTCUT) return;
  const bat = path.join(DIR, 'Pult.bat');
  if (!fs.existsSync(bat)) return;
  const q = s => s.replace(/'/g, "''");
  const ps = `$d=[Environment]::GetFolderPath('Desktop'); $p=Join-Path $d 'Пульт турнира.lnk'; if (-not (Test-Path $p)) { `
    + `$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); $s.TargetPath='${q(bat)}'; $s.WorkingDirectory='${q(DIR)}'; `
    + `$s.IconLocation=\"$env:SystemRoot\\System32\\shell32.dll,15\"; $s.Description='Пульт турнира: сервер и адрес для телефонов'; $s.Save(); 'new' }`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  exec(`powershell -NoProfile -EncodedCommand ${enc}`, { windowsHide: true }, (err, out) => {
    if (!err && /new/.test(out || '')) say('✓ На рабочем столе появился значок «Пульт турнира» — в следующий раз запускайте его');
  });
}

function cleanup() { for (const c of children) { try { c.kill(); } catch (e) { /* уже закрыт */ } } }
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));

(async () => {
  if (WIN) process.title = 'Пульт турнира';
  line(); say('   ПУЛЬТ ТУРНИРА — запуск'); line();
  await updateServer();
  if (!(await ensureCloudflared())) { say('\nНажмите любую клавишу, чтобы закрыть окно.'); return process.exit(1); }
  let port;
  try { port = await startServer(); } catch (e) { say('✗ Сервер не запустился: ' + e.message); return process.exit(1); }
  keepAwake();
  desktopShortcut();
  say('• Подключаю бесплатный адрес Cloudflare (10–30 секунд)…');
  startTunnel(port, async url => {
    say('• Адрес получен, проверяю…');
    let ok = false;
    for (let i = 0, n = +process.env.PULT_VERIFY_TRIES || 20; i < n && !ok; i++) { const h = await health(url); ok = !!(h && h.ok); if (!ok) await wait(3000); }
    line();
    say(ok ? '   ✓ ПУЛЬТ РАБОТАЕТ' : '   ⚠ Адрес пока не отвечает — пульт будет пробовать сам');
    say('');
    say('   Адрес сервера:  ' + url);
    say('');
    say('   Пульт открывается в браузере, адрес уже вписан.');
    say('   Если адрес поменялся (новый запуск) — откройте на телефонах');
    say('   новые QR-коды с пульта.');
    say('');
    say('   НЕ ЗАКРЫВАЙТЕ это окно, пока идёт тур. Закончили — закройте окно.');
    line();
    openBrowser(CONTROL + '#server=' + url);
  });
})();
