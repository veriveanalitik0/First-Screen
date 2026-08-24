'use strict';
/*
 * KuveytTürk – Yapay Zeka Laboratuvarı dikey kiosk sunucusu.
 * Harici bağımlılık YOK; sadece Node.js standart kütüphanesi.
 *
 *   /              -> kiosk.html   (dikey TV'de açılacak dönen 3B maket)
 *   /control       -> control.html (telefon/bilgisayardan kontrol paneli)
 *   GET  /api/state     -> mevcut ayarları JSON döner
 *   POST /api/state     -> ayarları günceller (kısmi JSON gövde) ve JSON döner
 *   POST /api/reset     -> ayarları varsayılana döndürür
 *   GET  /api/health    -> liveness (bağımlılıksız; orchestrator restart kararı)
 *   GET  /api/readiness -> readiness (ayar dosyası yazılabilir mi)
 *
 * Kiosk her ~2 sn'de /api/state'i yoklar; panelden yaptığın değişiklik
 * container yeniden başlatılmadan TV'ye yansır. Ayarlar STATE_FILE'a yazılır
 * (Docker volume ile kalıcı olur).
 *
 * GÜVENLİK NOTU (docs/security/app_security.md):
 *  - Statik servis ALLOWLIST'tir; ROOT altında serbest dosya okuma YOKTUR
 *    (server.js / state.json / .env gibi dosyalar hiçbir yoldan servis edilmez).
 *  - HTML yanıtlarına istek-başına nonce'lu CSP eklenir (inline script/style
 *    etiketleri sunucu tarafında nonce'lanır; 'unsafe-inline' YOK).
 *  - Durum değiştiren uçlar (POST) cross-origin isteklerde Origin doğrular.
 *  - IP başına kaba-kuvvet/DoS koruması için basit sayaç tabanlı rate limit.
 */

const http = require('http');
const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- yapılandırma
const PORT       = Number(process.env.PORT || 5353);
const HOST       = process.env.HOST || '0.0.0.0';
const ROOT       = __dirname;
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'state.json');
const LOG_LEVEL  = (process.env.LOG_LEVEL || 'info').toLowerCase();

// Backend'in önünde kaç proxy var (nginx / ingress / LB). 0 = doğrudan.
// Yanlış değer, rate limit'in tüm istemcileri tek kovada saymasına yol açar.
const TRUST_PROXY_HOPS = Math.max(0, Number(process.env.TRUST_PROXY_HOPS || 0));

// Çapraz-origin erişime izin verilen adresler (virgülle). Boş = YALNIZ same-origin.
// Kiosk ve panel aynı origin'den servis edildiği için varsayılan boştur;
// eski davranış (Access-Control-Allow-Origin: *) bilinçli olarak kaldırıldı.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

// Rate limit — DISABLE_RATE_LIMIT=1 ile e2e/DAST koşularında kapatılabilir.
const RATE_LIMIT_DISABLED   = process.env.DISABLE_RATE_LIMIT === '1';
const RATE_LIMIT_WINDOW_MS  = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX        = Number(process.env.RATE_LIMIT_MAX || 600);
const MUTATION_RATE_LIMIT_MAX = Number(process.env.MUTATION_RATE_LIMIT_MAX || 60);

// HSTS yalnız https üzerinden gelen isteklerde gönderilir (düz http kurulumda
// tarayıcıyı bir yıl boyunca https'e kilitlememek için). HSTS_ENABLED=false ile
// https altında da kapatılabilir.
const HSTS_ENABLED = process.env.HSTS_ENABLED !== 'false';

// Gövde üst sınırı — JSON ayar yamaları birkaç yüz bayttır.
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 16 * 1024);

// CSP'de izin verilen dış kaynaklar. kiosk.html three.js'i cdnjs'ten, yazı
// tiplerini Google Fonts'tan yükler (README "Notlar"). Tam çevrimdışı kurulumda
// bu varlıklar repoya alınıp liste boşaltılabilir.
const CDN_SCRIPT_SRC = 'https://cdnjs.cloudflare.com';
const CDN_STYLE_SRC  = 'https://fonts.googleapis.com';
const CDN_FONT_SRC   = 'https://fonts.gstatic.com';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, msg, extra) {
  if ((LEVELS[level] ?? 2) > (LEVELS[LOG_LEVEL] ?? 2)) return;
  const line = Object.assign({ ts: new Date().toISOString(), level, msg }, extra);
  process.stdout.write(JSON.stringify(line) + '\n');
}

// ---------------------------------------------------------------------- durum
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
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Diskteki dosya elle bozulmuş olabilir; yalnız DOĞRULANMIŞ alanlar alınır.
    return Object.assign({}, DEFAULT_STATE, sanitize(parsed && typeof parsed === 'object' ? parsed : {}));
  } catch (_) {
    return Object.assign({}, DEFAULT_STATE);
  }
}

/*
 * Ayar dizini yazılabilir mi? (readiness probe'unun tek kriteri.)
 * Dizin HENÜZ YOKSA oluşturulur: taze bir volume'da (ör. Kubernetes PVC ilk
 * mount) dizin var olmayabilir ve bunu "hazır değil" saymak pod'un ASLA Ready
 * olmamasına yol açardı — oysa ilk yazma anında zaten oluşturulacaktı.
 */
function stateWritable() {
  const dir = path.dirname(STATE_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });   // varsa no-op
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    log('error', 'state kaydedilemedi', { err: e.message });
    return false;
  }
}

// Sadece geçerli alanları, güvenli aralıklara sıkıştırarak al.
// (Prototype pollution: çıktı düz bir nesnedir, girdinin anahtarları taşınmaz.)
function sanitize(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  if (isNum(s.secPerTurn))                       out.secPerTurn = clamp(+s.secPerTurn, 3, 600);
  if (+s.direction === 1 || +s.direction === -1) out.direction  = +s.direction;
  if (typeof s.paused === 'boolean')             out.paused     = s.paused;
  if (isNum(s.phi))                              out.phi        = clamp(+s.phi, 0.15, 1.45);
  if (isNum(s.zoom))                             out.zoom       = clamp(+s.zoom, 0.5, 2.2);
  if (isNum(s.targetY))                          out.targetY    = clamp(+s.targetY, -400, 600);
  return out;
}

// ------------------------------------------------------------ statik allowlist
// Yol -> dosya eşlemesi. Bu haritada OLMAYAN hiçbir yol servis edilmez; böylece
// path traversal (../, %2e%2e, mutlak yol) ve ROOT içindeki hassas dosyaların
// (server.js, state.json, .env, package.json) sızması yapısal olarak imkânsızdır.
const STATIC_ROUTES = new Map([
  ['/',             'kiosk.html'],
  ['/index.html',   'kiosk.html'],
  ['/kiosk.html',   'kiosk.html'],
  ['/control',      'control.html'],
  ['/control/',     'control.html'],
  ['/control.html', 'control.html']
]);

// ------------------------------------------------------------------ yardımcılar
function clientIp(req) {
  if (TRUST_PROXY_HOPS > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[Math.max(0, xff.length - TRUST_PROXY_HOPS)];
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  if (TRUST_PROXY_HOPS > 0 && req.headers['x-forwarded-proto']) {
    return String(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https';
  }
  return Boolean(req.socket.encrypted);
}

function securityHeaders(req, { nonce } = {}) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none'
  };
  if (nonce) {
    // default-src 'self': XHR/img dışındaki her şey kapalı başlar.
    // script/style yalnız nonce ile ya da bilinen CDN'den yüklenebilir —
    // 'unsafe-inline' YOK (inline etiketler sunucuda nonce'lanır).
    // style-src-attr 'unsafe-inline': three.js/DOM'un yazdığı style
    // ATTRIBUTE'ları için (stylesheet'ler yine nonce'a tabidir).
    h['Content-Security-Policy'] = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' ${CDN_SCRIPT_SRC}`,
      `style-src 'self' 'nonce-${nonce}' ${CDN_STYLE_SRC}`,
      "style-src-attr 'unsafe-inline'",
      `font-src 'self' ${CDN_FONT_SRC} data:`,
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; ');
  }
  if (isHttps(req) && HSTS_ENABLED) {
    h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return h;
}

// İstek origin'i beyaz listede mi? (CORS yanıt başlıkları için)
function corsOriginFor(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  const normalized = String(origin).replace(/\/$/, '');
  return ALLOWED_ORIGINS.includes(normalized) ? normalized : null;
}

// Durum değiştiren istekler için origin doğrulama (CSRF sınıfı koruma).
// Origin YOKSA (curl/otomasyon, tarayıcı-dışı istemci) izin verilir; VARSA
// same-origin ya da ALLOWED_ORIGINS'te olmak zorundadır.
function mutationOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const normalized = String(origin).replace(/\/$/, '');
  if (ALLOWED_ORIGINS.includes(normalized)) return true;
  const host = req.headers.host;
  if (!host) return false;
  const proto = isHttps(req) ? 'https' : 'http';
  return normalized === `${proto}://${host}`;
}

// ------------------------------------------------------------------ rate limit
const buckets = new Map();       // ip -> { count, mutations, reset }
function rateLimit(ip, isMutation) {
  if (RATE_LIMIT_DISABLED) return true;
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || b.reset <= now) {
    b = { count: 0, mutations: 0, reset: now + RATE_LIMIT_WINDOW_MS };
    buckets.set(ip, b);
  }
  b.count++;
  if (isMutation) b.mutations++;
  if (b.count > RATE_LIMIT_MAX) return false;
  if (isMutation && b.mutations > MUTATION_RATE_LIMIT_MAX) return false;
  return true;
}
// Sızıntı önleyici temizlik — süresi dolan kovalar atılır (bellek DoS).
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (b.reset <= now) buckets.delete(ip);
}, 60_000);
sweeper.unref();

// --------------------------------------------------------------------- yanıtlar
function send(res, code, headers, body) {
  res.writeHead(code, headers);
  res.end(body);
}

function sendJSON(req, res, obj, code) {
  const headers = Object.assign(securityHeaders(req), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  const cors = corsOriginFor(req);
  if (cors) {
    headers['Access-Control-Allow-Origin'] = cors;
    headers['Vary'] = 'Origin';
  }
  send(res, code || 200, headers, JSON.stringify(obj));
}

// HTML servis: her yanıtta yeni nonce üretilir ve inline <script>/<style>
// etiketlerine yazılır. Bu yüzden HTML no-store ile servis edilir (cache'lenmiş
// bir sayfa eski nonce'u taşır ve CSP tarafından bloklanırdı).
async function sendHTML(req, res, file) {
  let html;
  try {
    html = await fsp.readFile(file, 'utf8');
  } catch (e) {
    log('error', 'html okunamadı', { file, err: e.message });
    return send(res, 500, securityHeaders(req), 'Sunucu hatası');
  }
  const nonce = crypto.randomBytes(16).toString('base64');
  html = html
    .replace(/<script(?=[\s>])(?![^>]*\snonce=)/gi, `<script nonce="${nonce}"`)
    .replace(/<style(?=[\s>])(?![^>]*\snonce=)/gi, `<style nonce="${nonce}"`);
  const headers = Object.assign(securityHeaders(req, { nonce }), {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  if (req.method === 'HEAD') return send(res, 200, headers, undefined);
  send(res, 200, headers, html);
}

// --------------------------------------------------------------------- handler
function createRequestHandler() {
  let state = loadState();

  return function handler(req, res) {
    // Sürüm/teknoloji sızdırma (ZAP 10036) — Node varsayılanı zaten X-Powered-By
    // göndermez; Server başlığını da bilinçli olarak eklemiyoruz.
    let p;
    try {
      const url = new URL(req.url, 'http://placeholder.invalid');
      p = decodeURIComponent(url.pathname);
    } catch (_) {
      return send(res, 400, securityHeaders(req), 'Hatalı istek');
    }

    const ip = clientIp(req);
    const isMutation = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';

    // CORS ön-uçuş — yalnız beyaz listedeki origin'lere yanıt verilir.
    if (req.method === 'OPTIONS') {
      const cors = corsOriginFor(req);
      const headers = Object.assign(securityHeaders(req), {
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin'
      });
      if (cors) headers['Access-Control-Allow-Origin'] = cors;
      return send(res, 204, headers, undefined);
    }

    if (!['GET', 'HEAD', 'POST', 'PUT'].includes(req.method)) {
      return sendJSON(req, res, { error: 'yontem desteklenmiyor' }, 405);
    }

    if (!rateLimit(ip, isMutation)) {
      log('warn', 'rate limit', { ip, path: p });
      const headers = Object.assign(securityHeaders(req), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000))
      });
      return send(res, 429, headers, JSON.stringify({ error: 'cok fazla istek' }));
    }

    // --- Sağlık uçları (orchestrator/Helm probe'ları) ---
    if (p === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJSON(req, res, { status: 'ok', uptime: Math.round(process.uptime()) });
    }
    if (p === '/api/readiness' && (req.method === 'GET' || req.method === 'HEAD')) {
      // Ayar dosyasının bulunduğu dizin yazılabilir değilse panelden yapılan
      // değişiklikler kalıcı olmaz → hazır DEĞİL (ör. salt-okunur volume,
      // yanlış sahiplikte bind-mount).
      const writable = stateWritable();
      return sendJSON(req, res,
        { status: writable ? 'ready' : 'degraded', stateWritable: writable },
        writable ? 200 : 503);
    }

    // --- Durum oku ---
    if (p === '/api/state' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJSON(req, res, state);
    }

    // --- Durum güncelle ---
    if (p === '/api/state' && (req.method === 'POST' || req.method === 'PUT')) {
      if (!mutationOriginAllowed(req)) {
        log('warn', 'cross-origin mutasyon reddedildi', { ip, origin: req.headers.origin });
        return sendJSON(req, res, { error: 'origin reddedildi' }, 403);
      }
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ctype && ctype !== 'application/json') {
        return sendJSON(req, res, { error: 'application/json bekleniyor' }, 415);
      }
      let body = '';
      let aborted = false;
      req.on('data', c => {
        body += c;
        if (body.length > MAX_BODY_BYTES) {
          aborted = true;
          // Gövdenin kalanını OKUMADAN kes: sınırsız veri tamponlamak bellek
          // tüketimi (DoS) demektir. Yanıt tamamen yazıldıktan sonra soket
          // kapatılır — 'Connection: close' olmadan istemci aynı soketi tekrar
          // kullanmaya çalışıp ECONNRESET alırdı.
          const headers = Object.assign(securityHeaders(req), {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Connection': 'close'
          });
          res.writeHead(413, headers);
          res.end(JSON.stringify({ error: 'govde cok buyuk' }));
          res.on('finish', () => req.socket.destroy());
        }
      });
      req.on('end', () => {
        if (aborted) return;
        let patch;
        try { patch = JSON.parse(body || '{}'); }
        catch (_) { return sendJSON(req, res, { error: 'gecersiz JSON' }, 400); }
        state = Object.assign({}, state, sanitize(patch));
        saveState(state);
        sendJSON(req, res, state);
      });
      return;
    }

    // --- Varsayılana dön ---
    if (p === '/api/reset' && req.method === 'POST') {
      if (!mutationOriginAllowed(req)) {
        log('warn', 'cross-origin mutasyon reddedildi', { ip, origin: req.headers.origin });
        return sendJSON(req, res, { error: 'origin reddedildi' }, 403);
      }
      state = Object.assign({}, DEFAULT_STATE);
      saveState(state);
      return sendJSON(req, res, state);
    }

    // Tanımlı API yolu ama yanlış yöntem → 405 (404 ile karıştırma).
    if (p === '/api/state' || p === '/api/reset' || p === '/api/health' || p === '/api/readiness') {
      return sendJSON(req, res, { error: 'yontem desteklenmiyor' }, 405);
    }
    if (p.startsWith('/api/')) {
      return sendJSON(req, res, { error: 'bulunamadi' }, 404);
    }

    // --- Statik (yalnız allowlist) ---
    const rel = STATIC_ROUTES.get(p);
    if (rel && (req.method === 'GET' || req.method === 'HEAD')) {
      return void sendHTML(req, res, path.join(ROOT, rel));
    }

    const headers = Object.assign(securityHeaders(req), {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    send(res, 404, headers, 'Bulunamadı');
  };
}

function createServer() {
  const server = http.createServer(createRequestHandler());
  // Slowloris sınıfı bağlantı tüketimine karşı zaman aşımları.
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 30_000;
  return server;
}

// -------------------------------------------------------------------- bootstrap
if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    log('info', 'kiosk sunucusu calisiyor', { host: HOST, port: PORT, stateFile: STATE_FILE });
    log('info', 'yollar', { kiosk: '/', panel: '/control', health: '/api/health' });
    if (ALLOWED_ORIGINS.length === 0) {
      log('info', 'CORS kapali (yalniz same-origin) — ALLOWED_ORIGINS ile acilabilir');
    }
  });

  // Orchestrator (Docker/Kubernetes) SIGTERM gönderir; açık bağlantıları
  // tamamlayıp temiz kapan — yarıda kesilen yanıt/yazma olmasın.
  const shutdown = signal => {
    log('info', 'kapaniyor', { signal });
    clearInterval(sweeper);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

module.exports = { createServer, createRequestHandler, sanitize, stateWritable, DEFAULT_STATE, STATIC_ROUTES };
