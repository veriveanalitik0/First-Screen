'use strict';
/* /api/* uçlarının davranışı: okuma, doğrulama/clamp, kalıcılık, hata kodları. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { tempStateFile } = require('./helpers');
const STATE_FILE = tempStateFile();
process.env.STATE_FILE = STATE_FILE;

const { startServer, request, json } = require('./helpers');
const { DEFAULT_STATE } = require('..');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(() => ctx.server.close());

const post = (path, body, headers) =>
  request(ctx.port, {
    method: 'POST',
    path,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body
  });

test('GET /api/state varsayılan ayarları döner', async () => {
  const res = await request(ctx.port, { path: '/api/state' });
  assert.equal(res.status, 200);
  assert.deepEqual(json(res), DEFAULT_STATE);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('POST /api/state yalnız gönderilen alanı günceller', async () => {
  const res = await post('/api/state', JSON.stringify({ secPerTurn: 30 }));
  assert.equal(res.status, 200);
  const body = json(res);
  assert.equal(body.secPerTurn, 30);
  assert.equal(body.zoom, DEFAULT_STATE.zoom, 'dokunulmayan alan korunmalı');
});

test('POST /api/state aralık dışı değerleri clamp eder', async () => {
  const res = await post('/api/state', JSON.stringify({
    secPerTurn: 99999, zoom: 0.01, phi: 99, targetY: -99999
  }));
  const body = json(res);
  assert.equal(body.secPerTurn, 600, 'üst sınır');
  assert.equal(body.zoom, 0.5, 'alt sınır');
  assert.equal(body.phi, 1.45, 'üst sınır');
  assert.equal(body.targetY, -400, 'alt sınır');
});

test('POST /api/state bilinmeyen ve geçersiz alanları yok sayar', async () => {
  const res = await post('/api/state', JSON.stringify({
    direction: 7,            // yalnız -1 / 1 kabul edilir
    paused: 'evet',          // yalnız boolean kabul edilir
    adminPassword: 'x',      // şemada olmayan alan
    __proto__: { polluted: true }
  }));
  const body = json(res);
  assert.ok(body.direction === 1 || body.direction === -1);
  assert.equal(typeof body.paused, 'boolean');
  assert.equal(body.adminPassword, undefined, 'şema dışı alan taşınmamalı');
  assert.equal({}.polluted, undefined, 'prototype pollution olmamalı');
});

test('POST /api/state geçersiz JSON için 400 döner', async () => {
  const res = await post('/api/state', '{bozuk');
  assert.equal(res.status, 400);
  assert.equal(json(res).error, 'gecersiz JSON');
});

test('POST /api/state yanlış Content-Type için 415 döner', async () => {
  const res = await post('/api/state', '{}', { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 415);
});

test('POST /api/state aşırı büyük gövdeyi 413 ile keser', async () => {
  const huge = JSON.stringify({ secPerTurn: 30, pad: 'a'.repeat(64 * 1024) });
  const res = await post('/api/state', huge).catch(e => e);
  // Sunucu gövdeyi keserken bağlantıyı da düşürebilir; iki sonuç da kabul:
  // ya 413 döner ya da soket resetlenir (ECONNRESET).
  if (res instanceof Error) assert.match(res.code || res.message, /ECONNRESET|EPIPE/);
  else assert.equal(res.status, 413);
});

test('POST /api/reset varsayılanlara döner ve diske yazar', async () => {
  await post('/api/state', JSON.stringify({ secPerTurn: 11, paused: true }));
  const res = await request(ctx.port, { method: 'POST', path: '/api/reset' });
  assert.equal(res.status, 200);
  assert.deepEqual(json(res), DEFAULT_STATE);

  const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  assert.deepEqual(onDisk, DEFAULT_STATE, 'ayarlar kalıcı olmalı');
});

test('ayarlar STATE_FILE üzerinde kalıcıdır', async () => {
  await post('/api/state', JSON.stringify({ zoom: 1.7 }));
  const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  assert.equal(onDisk.zoom, 1.7);
});

test('GET /api/health ve /api/readiness 200 döner', async () => {
  const health = await request(ctx.port, { path: '/api/health' });
  assert.equal(health.status, 200);
  assert.equal(json(health).status, 'ok');

  const ready = await request(ctx.port, { path: '/api/readiness' });
  assert.equal(ready.status, 200);
  assert.equal(json(ready).stateWritable, true);
});

test('tanımlı uçta yanlış yöntem 405, bilinmeyen API yolu 404 döner', async () => {
  const wrongMethod = await request(ctx.port, { method: 'GET', path: '/api/reset' });
  assert.equal(wrongMethod.status, 405);

  const unknown = await request(ctx.port, { path: '/api/bilinmeyen' });
  assert.equal(unknown.status, 404);
  assert.equal(json(unknown).error, 'bulunamadi');
});

test('desteklenmeyen HTTP yöntemi 405 döner', async () => {
  const res = await request(ctx.port, { method: 'DELETE', path: '/api/state' });
  assert.equal(res.status, 405);
});
