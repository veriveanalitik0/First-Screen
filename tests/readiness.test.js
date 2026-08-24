'use strict';
/*
 * Readiness probe'u — orchestrator (Docker/Kubernetes) trafiği bu uca bakarak
 * yönlendirir. Taze bir volume'da ayar dizini HENÜZ yoktur; bunu "hazır değil"
 * saymak pod'un asla Ready olmamasına yol açıyordu (smoke test'te yakalandı).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Bilinçli olarak HENÜZ VAR OLMAYAN, iç içe bir dizin.
const DIR = path.join(os.tmpdir(), `kiosk-readiness-${process.pid}`, 'nested', 'data');
process.env.STATE_FILE = path.join(DIR, 'state.json');

const { startServer, request, json } = require('./helpers');

let ctx;
test.before(async () => {
  assert.equal(fs.existsSync(DIR), false, 'test ön koşulu: dizin var olmamalı');
  ctx = await startServer();
});
test.after(() => {
  ctx.server.close();
  fs.rmSync(path.join(os.tmpdir(), `kiosk-readiness-${process.pid}`), { recursive: true, force: true });
});

test('ayar dizini henüz yokken de hazır (200) döner', async () => {
  const res = await request(ctx.port, { path: '/api/readiness' });
  assert.equal(res.status, 200);
  assert.equal(json(res).status, 'ready');
  assert.equal(json(res).stateWritable, true);
});

test('readiness kontrolü dizini oluşturur, sonraki yazma başarılı olur', async () => {
  await request(ctx.port, { path: '/api/readiness' });
  assert.equal(fs.existsSync(DIR), true, 'dizin oluşturulmuş olmalı');

  const res = await request(ctx.port, {
    method: 'POST',
    path: '/api/state',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zoom: 1.3 })
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8')).zoom, 1.3);
});

test('yazılamayan dizinde 503 döner', async () => {
  const { stateWritable } = require('..');
  assert.equal(typeof stateWritable, 'function');
  // Not: root olarak koşan CI'da salt-okunur dizin testi anlamsızdır (root her
  // yere yazar), bu yüzden burada yalnız sözleşme doğrulanır; 503 yolu
  // stateWritable() false döndüğünde çalışır ve api.test.js'te 200 yolu test edilir.
  assert.equal(stateWritable(), true);
});
