#!/usr/bin/env node
'use strict';
/*
 * Sıfır-bağımlılık lint: repodaki her .js dosyasını Node'un kendi parser'ıyla
 * (`node --check` eşdeğeri, vm.Script) söz dizimi açısından doğrular.
 *
 * Neden eslint değil: bu servis BİLİNÇLİ olarak hiçbir npm bağımlılığı
 * taşımaz (tedarik zinciri saldırı yüzeyi = 0, app_security §11). Bir linter
 * uğruna yüzlerce transitif paket eklemek bu kararı bozardı.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

let failed = 0;
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(src, { filename: file });
  } catch (e) {
    failed++;
    console.error(`✗ ${path.relative(ROOT, file)}: ${e.message}`);
  }
}

if (failed) {
  console.error(`\nlint: ${failed} dosyada söz dizimi hatası`);
  process.exit(1);
}
console.log('lint: tüm .js dosyaları geçerli');
