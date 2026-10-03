// Правка заявки задним числом: закрытый месяц трогать нельзя, а любая правка
// обязана оставлять след (решение Шоха 03.10.2026 — система отражает факт).
const test = require('node:test');
const assert = require('node:assert');
const { lockErrorFor } = require('../src/cash-lock');

test('принятая заявка закрытого месяца не правится', () => {
  const lock = '2026-08-31';
  // Приёмка была в августе — месяц сведён и закрыт.
  assert.match(String(lockErrorFor(lock, ['2026-08-15'])), /Касса закрыта по 31\.08\.2026/);
  // Сентябрь открыт — правка возможна.
  assert.strictEqual(lockErrorFor(lock, ['2026-09-15']), null);
  // Замка нет вообще — ничего не запрещаем.
  assert.strictEqual(lockErrorFor(null, ['2026-08-15']), null);
});

test('в журнале остаётся, что именно поменяли, а не «del=2 add=1»', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'purchase.js'), 'utf8');
  const i = src.indexOf("'purchase_order_reconcile'");
  assert.ok(i > 0, 'запись в журнал пропала');
  const block = src.slice(Math.max(0, i - 1600), i + 300);
  assert.match(block, /was\.qty.*→|→ \$\{qty\}/s, 'должно писаться «было → стало»');
  assert.match(block, /удалено \$\{/, 'удалённые позиции названы поимённо');
  assert.match(block, /причина/, 'причину правки сохраняем, если её указали');
});

test('замок проверяется ДО изменения данных, а не после', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'purchase.js'), 'utf8');
  const start = src.indexOf('/reconcile');
  const block = src.slice(start, start + 3000);
  const lock = block.indexOf('cashLockError');
  const firstWrite = block.indexOf('UPDATE purchase_orders SET supplier_id');
  assert.ok(lock > 0 && firstWrite > 0 && lock < firstWrite,
    'проверка закрытого периода обязана стоять до первой записи');
});
