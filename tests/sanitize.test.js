'use strict';
/* sanitize() birim testleri — girdi doğrulama sınırları (app_security §3). */
const test = require('node:test');
const assert = require('node:assert/strict');

const { tempStateFile } = require('./helpers');
process.env.STATE_FILE = tempStateFile();

const { sanitize, DEFAULT_STATE } = require('..');

test('geçerli değerler aynen geçer', () => {
  assert.deepEqual(sanitize({ secPerTurn: 30, zoom: 1.5, paused: true, direction: 1 }),
    { secPerTurn: 30, direction: 1, paused: true, zoom: 1.5 });
});

test('sayısal string ler sayıya çevrilir', () => {
  assert.deepEqual(sanitize({ secPerTurn: '45' }), { secPerTurn: 45 });
});

test('sayı olmayan ve sonsuz değerler düşürülür', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'abc', '', null, undefined, {}, []]) {
    assert.deepEqual(sanitize({ secPerTurn: bad }), {}, `${String(bad)} kabul edilmemeli`);
  }
});

test('sınırlar iki uçta da clamp lenir', () => {
  assert.equal(sanitize({ secPerTurn: 1 }).secPerTurn, 3);
  assert.equal(sanitize({ secPerTurn: 10_000 }).secPerTurn, 600);
  assert.equal(sanitize({ phi: 0 }).phi, 0.15);
  assert.equal(sanitize({ phi: 10 }).phi, 1.45);
  assert.equal(sanitize({ zoom: 0 }).zoom, 0.5);
  assert.equal(sanitize({ zoom: 99 }).zoom, 2.2);
  assert.equal(sanitize({ targetY: -10_000 }).targetY, -400);
  assert.equal(sanitize({ targetY: 10_000 }).targetY, 600);
});

test('direction yalnız -1 veya 1 kabul eder', () => {
  assert.equal(sanitize({ direction: 1 }).direction, 1);
  assert.equal(sanitize({ direction: '-1' }).direction, -1);
  assert.equal(sanitize({ direction: 0 }).direction, undefined);
  assert.equal(sanitize({ direction: 2 }).direction, undefined);
});

test('paused yalnız boolean kabul eder', () => {
  assert.equal(sanitize({ paused: true }).paused, true);
  assert.equal(sanitize({ paused: 'true' }).paused, undefined);
  assert.equal(sanitize({ paused: 1 }).paused, undefined);
});

test('şema dışı alanlar taşınmaz', () => {
  const out = sanitize({ secPerTurn: 20, rce: 'x', __proto__: { p: 1 }, constructor: 'y' });
  assert.deepEqual(Object.keys(out), ['secPerTurn']);
});

test('nesne olmayan girdi boş nesne döner', () => {
  for (const bad of [null, undefined, 'str', 42, true]) {
    assert.deepEqual(sanitize(bad), {});
  }
});

test('DEFAULT_STATE sanitize sınırları içindedir', () => {
  assert.deepEqual(sanitize(DEFAULT_STATE), DEFAULT_STATE);
});
