'use strict';
/*
 * KuveytTürk – Yapay Zeka Laboratuvarı dikey kiosk sunucusu.
 * Harici bağımlılık YOK; sadece Node.js standart kütüphanesi.
 *
 *   /            -> kiosk.html   (dikey TV'de açılacak dönen 3B maket)
 *   /control     -> control.html (telefon/bilgisayardan kontrol paneli)
 *   GET  /api/state  -> mevcut ayarları JSON döner
 *   POST /api/state  -> ayarları günceller (kısmi JSON gövde) ve JSON döner
 *   POST /api/reset  -> ayarları varsayılana döndürür
 *
 * Kiosk her ~2 sn'de /api/state'i yoklar; panelden yaptığın değişiklik
 * container yeniden başlatılmadan TV'ye yansır. Ayarlar STATE_FILE'a yazılır
 * (Docker volume ile kalıcı olur).
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT       = process.env.PORT || 5353;
const ROOT       = __dirname;
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'state.json');

const DEFAULT_STATE = {
  secPerTurn: 48,     // bir tam turun süresi (sn); büyük = yavaş
  direction : -1,     // -1 veya 1
  paused    : false,  // dönüşü duraklat
  phi       : 0.95,   // kamera eğimi (rad); büyük = daha yandan
  zoom      : 1.0,    // model boyutu çarpanı; >1 daha büyük
  targetY   : 110     // dikey konum (bakış yüksekliği)
};

const isNum = v =>
  (typeof v === 'number' && isFinite(v)) ||
  (typeof v === 'string' && v.trim() !== '' && isFinite(+v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function loadState() {
  try {
    return Object.assign({}, DEFAULT_STATE, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (_) {
    return Object.assign({}, DEFAULT_STATE);
  }
}
let state = loadState();

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('state kaydedilemedi:', e.message);
  }
}

// Sadece geçerli alanları, güvenli aralıklara sıkıştırarak al.
function sanitize(s) {
  const out = {};
  if (isNum(s.secPerTurn))                       out.secPerTurn = clamp(+s.secPerTurn, 3, 600);
  if (+s.direction === 1 || +s.direction === -1) out.direction  = +s.direction;
  if (typeof s.paused === 'boolean')             out.paused     = s.paused;
  if (isNum(s.phi))                              out.phi        = clamp(+s.phi, 0.15, 1.45);
  if (isNum(s.zoom))                             out.zoom       = clamp(+s.zoom, 0.5, 2.2);
  if (isNum(s.targetY))                          out.targetY    = clamp(+s.targetY, -400, 600);
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'text/javascript; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png' : 'image/png',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon'
};

function sendJSON(res, obj, code) {
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Bulunamadı'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let p;
  try { p = new URL(req.url, 'http://x').pathname; }
  catch (_) { res.writeHead(400); return res.end('Hatalı istek'); }

  // CORS ön-uçuş
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Durum oku
  if (p === '/api/state' && req.method === 'GET') return sendJSON(res, state);

  // Durum güncelle
  if (p === '/api/state' && (req.method === 'POST' || req.method === 'PUT')) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      let patch;
      try { patch = JSON.parse(body || '{}'); }
      catch (_) { return sendJSON(res, { error: 'gecersiz JSON' }, 400); }
      Object.assign(state, sanitize(patch));
      saveState();
      sendJSON(res, state);
    });
    return;
  }

  // Varsayılana dön
  if (p === '/api/reset' && req.method === 'POST') {
    state = Object.assign({}, DEFAULT_STATE);
    saveState();
    return sendJSON(res, state);
  }

  // Statik dosyalar
  let file;
  if (p === '/' || p === '') file = path.join(ROOT, 'kiosk.html');
  else if (p === '/control' || p === '/control/') file = path.join(ROOT, 'control.html');
  else file = path.join(ROOT, path.normalize(p));

  // dizin dışına çıkışı engelle
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
    res.writeHead(403); return res.end('Yasak');
  }
  sendFile(res, file);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('KuveytTürk kiosk sunucusu çalışıyor: http://0.0.0.0:' + PORT);
  console.log('  Kiosk (TV):     /');
  console.log('  Kontrol paneli: /control');
  console.log('  Ayar dosyası:   ' + STATE_FILE);
});
