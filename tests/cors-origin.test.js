'use strict';
/*
 * CORS beyaz listesi + durum değiştiren isteklerde Origin doğrulama.
 * (Eski davranış Access-Control-Allow-Origin: * idi; kaldırıldı.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { tempStateFile } = require('./helpers');
process.env.STATE_FILE = tempStateFile();
process.env.ALLOWED_ORIGINS = 'https://panel.example,http://kiosk.local';

const { startServer, request, json } = require('./helpers');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(() => ctx.server.close());

test('beyaz listedeki origin e CORS izni verilir', async () => {
  const res = await request(ctx.port, {
    path: '/api/state',
    headers: { Origin: 'https://panel.example' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'https://panel.example');
  assert.equal(res.headers['vary'], 'Origin');
});

test('beyaz listede olmayan origin e CORS izni verilmez', async () => {
  const res = await request(ctx.port, {
    path: '/api/state',
    headers: { Origin: 'https://kotu.example' }
  });
  assert.equal(res.status, 200, 'okuma engellenmez, yalnız CORS başlığı verilmez');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('CORS yanıtı hiçbir zaman joker (*) değildir', async () => {
  for (const origin of ['https://panel.example', 'https://kotu.example', 'null']) {
    const res = await request(ctx.port, { path: '/api/state', headers: { Origin: origin } });
    assert.notEqual(res.headers['access-control-allow-origin'], '*');
  }
});

test('OPTIONS ön-uçuşu yalnız izinli origin için ACAO döner', async () => {
  const ok = await request(ctx.port, {
    method: 'OPTIONS',
    path: '/api/state',
    headers: { Origin: 'http://kiosk.local', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'http://kiosk.local');

  const blocked = await request(ctx.port, {
    method: 'OPTIONS',
    path: '/api/state',
    headers: { Origin: 'https://kotu.example', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(blocked.status, 204);
  assert.equal(blocked.headers['access-control-allow-origin'], undefined);
});

test('yabancı origin den gelen POST 403 ile reddedilir (CSRF sınıfı)', async () => {
  const res = await request(ctx.port, {
    method: 'POST',
    path: '/api/state',
    headers: { Origin: 'https://kotu.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ secPerTurn: 5 })
  });
  assert.equal(res.status, 403);
  assert.equal(json(res).error, 'origin reddedildi');

  const after = await request(ctx.port, { path: '/api/state' });
  assert.notEqual(json(after).secPerTurn, 5, 'reddedilen istek durumu değiştirmemeli');
});

test('yabancı origin den gelen /api/reset 403 ile reddedilir', async () => {
  const res = await request(ctx.port, {
    method: 'POST',
    path: '/api/reset',
    headers: { Origin: 'https://kotu.example' }
  });
  assert.equal(res.status, 403);
});

test('same-origin POST kabul edilir', async () => {
  const res = await request(ctx.port, {
    method: 'POST',
    path: '/api/state',
    headers: {
      Origin: `http://127.0.0.1:${ctx.port}`,
      Host: `127.0.0.1:${ctx.port}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ secPerTurn: 33 })
  });
  assert.equal(res.status, 200);
  assert.equal(json(res).secPerTurn, 33);
});

test('Origin başlığı olmayan istemci (curl/otomasyon) çalışmaya devam eder', async () => {
  const res = await request(ctx.port, {
    method: 'POST',
    path: '/api/state',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secPerTurn: 44 })
  });
  assert.equal(res.status, 200);
  assert.equal(json(res).secPerTurn, 44);
});
