'use strict';
/*
 * Statik servis allowlist i: path traversal ve hassas dosya sızıntısı.
 * (app_security §9 — dosya/kaynak yönetimi.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { tempStateFile } = require('./helpers');
process.env.STATE_FILE = tempStateFile();

const { startServer, request } = require('./helpers');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(() => ctx.server.close());

test('izin verilen yollar HTML döner', async () => {
  for (const p of ['/', '/index.html', '/kiosk.html', '/control', '/control.html']) {
    const res = await request(ctx.port, { path: p });
    assert.equal(res.status, 200, `${p} 200 dönmeli`);
    assert.match(res.headers['content-type'], /text\/html/);
  }
});

test('path traversal denemeleri dosya sızdırmaz', async () => {
  const attempts = [
    '/../server.js',
    '/../../etc/passwd',
    '/%2e%2e/server.js',
    '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/..%2fserver.js',
    '/./../../server.js',
    '/....//server.js',
    '//etc/passwd',
    '/%00/server.js'
  ];
  for (const p of attempts) {
    const res = await request(ctx.port, { path: p });
    assert.ok(res.status === 404 || res.status === 400, `${p} -> ${res.status} (404/400 bekleniyor)`);
    assert.ok(!res.body.includes('createRequestHandler'), `${p} kaynak kod sızdırdı`);
    assert.ok(!res.body.includes('root:x:'), `${p} /etc/passwd sızdırdı`);
  }
});

test('kök dizindeki hassas dosyalar servis edilmez', async () => {
  const sensitive = [
    '/server.js',
    '/state.json',
    '/package.json',
    '/package-lock.json',
    '/Dockerfile',
    '/docker-compose.prod.yml',
    '/.env',
    '/.env.prod',
    '/.git/config',
    '/scripts/lint.js',
    '/tests/api.test.js'
  ];
  for (const p of sensitive) {
    const res = await request(ctx.port, { path: p });
    assert.equal(res.status, 404, `${p} servis edilmemeli`);
  }
});

test('dizin listeleme yoktur', async () => {
  for (const p of ['/tests/', '/scripts/', '/docs/']) {
    const res = await request(ctx.port, { path: p });
    assert.equal(res.status, 404);
  }
});

test('bozuk yüzde kodlaması 400 ile reddedilir', async () => {
  const res = await request(ctx.port, { path: '/%zz' });
  assert.equal(res.status, 400);
});
