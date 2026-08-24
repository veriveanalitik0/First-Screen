'use strict';
/* Güvenlik başlıkları + CSP nonce davranışı (app_security §6). */
const test = require('node:test');
const assert = require('node:assert/strict');

const { tempStateFile } = require('./helpers');
process.env.STATE_FILE = tempStateFile();

const { startServer, request } = require('./helpers');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(() => ctx.server.close());

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-permitted-cross-domain-policies': 'none'
};

test('HTML yanıtı tüm temel güvenlik başlıklarını taşır', async () => {
  const res = await request(ctx.port, { path: '/' });
  assert.equal(res.status, 200);
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    assert.equal(res.headers[name], value, `${name} başlığı eksik/yanlış`);
  }
  assert.match(res.headers['permissions-policy'], /camera=\(\)/);
  assert.match(res.headers['permissions-policy'], /microphone=\(\)/);
});

test('JSON yanıtı da güvenlik başlıklarını taşır', async () => {
  const res = await request(ctx.port, { path: '/api/state' });
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    assert.equal(res.headers[name], value, `${name} başlığı eksik/yanlış`);
  }
});

test('404 yanıtı da güvenlik başlıklarını taşır', async () => {
  const res = await request(ctx.port, { path: '/yok' });
  assert.equal(res.status, 404);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
});

test('CSP unsafe-inline içermez ve script/style nonce ile kısıtlanır', async () => {
  const res = await request(ctx.port, { path: '/' });
  const csp = res.headers['content-security-policy'];
  assert.ok(csp, 'CSP başlığı yok');

  const scriptSrc = csp.split(';').map(s => s.trim()).find(d => d.startsWith('script-src '));
  const styleSrc = csp.split(';').map(s => s.trim()).find(d => d.startsWith('style-src '));
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "script-src 'unsafe-inline' içermemeli");
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), "script-src 'unsafe-eval' içermemeli");
  assert.ok(!styleSrc.includes("'unsafe-inline'"), "style-src 'unsafe-inline' içermemeli");
  assert.match(scriptSrc, /'nonce-[A-Za-z0-9+/=]+'/);

  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
});

test('CSP nonce inline script ve style etiketlerine yazılır', async () => {
  const res = await request(ctx.port, { path: '/' });
  const nonce = res.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];

  assert.ok(res.body.includes(`<script nonce="${nonce}"`), 'inline script nonce almamış');
  assert.ok(res.body.includes(`<style nonce="${nonce}"`), 'inline style nonce almamış');
  assert.ok(!/<script(?![^>]*nonce)[\s>]/i.test(res.body), 'nonce almayan script etiketi var');
});

test('nonce her istekte yenilenir ve yanıt cache lenmez', async () => {
  const a = await request(ctx.port, { path: '/' });
  const b = await request(ctx.port, { path: '/' });
  const nonceA = a.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
  const nonceB = b.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
  assert.notEqual(nonceA, nonceB, 'nonce tekrar kullanılmamalı');
  assert.equal(a.headers['cache-control'], 'no-store', 'nonce lu HTML cache lenmemeli');
});

test('kontrol paneli de nonce lu CSP ile servis edilir', async () => {
  const res = await request(ctx.port, { path: '/control' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-security-policy'], /'nonce-/);
  assert.match(res.body, /<script nonce="/);
});

test('sunucu sürüm/teknoloji bilgisi sızdırmaz', async () => {
  const res = await request(ctx.port, { path: '/api/state' });
  assert.equal(res.headers['x-powered-by'], undefined);
  assert.equal(res.headers['server'], undefined);
});

test('düz HTTP üzerinde HSTS gönderilmez', async () => {
  // HSTS yalnız https isteklerinde anlamlıdır; düz http kurulumda gönderilmesi
  // tarayıcıyı bir yıl boyunca https e kilitler (.env.prod.example notu).
  const res = await request(ctx.port, { path: '/' });
  assert.equal(res.headers['strict-transport-security'], undefined);
});
