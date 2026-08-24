'use strict';
/* IP başına istek sınırı — kaba kuvvet / kaynak tüketimi koruması. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { tempStateFile } = require('./helpers');
process.env.STATE_FILE = tempStateFile();
process.env.RATE_LIMIT_MAX = '5';
process.env.MUTATION_RATE_LIMIT_MAX = '2';
process.env.RATE_LIMIT_WINDOW_MS = '60000';

const { startServer, request, json } = require('./helpers');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(() => ctx.server.close());

test('mutasyon sınırı aşılınca 429 ve Retry-After döner', async () => {
  const body = JSON.stringify({ secPerTurn: 20 });
  const headers = { 'Content-Type': 'application/json' };

  const first = await request(ctx.port, { method: 'POST', path: '/api/state', headers, body });
  const second = await request(ctx.port, { method: 'POST', path: '/api/state', headers, body });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const third = await request(ctx.port, { method: 'POST', path: '/api/state', headers, body });
  assert.equal(third.status, 429, 'mutasyon sınırı (2) aşılmalı');
  assert.equal(json(third).error, 'cok fazla istek');
  assert.equal(third.headers['retry-after'], '60');
});

test('genel istek sınırı aşılınca 429 döner', async () => {
  // Önceki testte 3 istek harcandı; genel sınır 5.
  const fourth = await request(ctx.port, { path: '/api/state' });
  const fifth = await request(ctx.port, { path: '/api/state' });
  assert.equal(fourth.status, 200);
  assert.equal(fifth.status, 200);

  const sixth = await request(ctx.port, { path: '/api/state' });
  assert.equal(sixth.status, 429, 'genel sınır (5) aşılmalı');
});

test('429 yanıtı da güvenlik başlıklarını taşır', async () => {
  const res = await request(ctx.port, { path: '/api/state' });
  assert.equal(res.status, 429);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
});
