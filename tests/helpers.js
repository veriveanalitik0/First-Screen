'use strict';
/*
 * Test yardımcıları — sıfır bağımlılık (node:test + node:http).
 *
 * server.js yapılandırmayı MODÜL YÜKLENİRKEN env'den okur. Bu yüzden farklı
 * yapılandırmalar (CORS listesi, rate limit sınırları) AYRI test dosyalarında
 * test edilir: `node --test` her dosyayı ayrı süreçte koşturur, dolayısıyla
 * her dosya kendi env'ini kurup server.js'i temiz yükleyebilir.
 */
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { once } = require('events');

// Her test dosyası kendi geçici state dosyasını kullanır (repo'daki
// state.json'a dokunulmaz, testler birbirini etkilemez).
function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-test-'));
  return path.join(dir, 'state.json');
}

async function startServer() {
  // require env kurulduktan SONRA yapılmalı.
  const { createServer } = require('..');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}`, port };
}

/*
 * Ham HTTP isteği. fetch() KULLANILMAZ: WHATWG URL ayrıştırıcısı '/../x' gibi
 * yolları istemcide normalize eder, dolayısıyla path-traversal denemesi
 * sunucuya hiç ulaşmaz. http.request `path`i olduğu gibi gönderir.
 */
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent: false -> her istek YENİ bağlantı. Node'un global agent'ı
      // keep-alive kullanır; 413 testinde sunucu soketi kapattığında havuzdaki
      // ölü soket sonraki teste sızıp ECONNRESET üretiyordu.
      { host: '127.0.0.1', port, method, path: p, headers, agent: false },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function json(res) {
  return JSON.parse(res.body);
}

module.exports = { startServer, request, json, tempStateFile, randomId: () => crypto.randomUUID() };
