// Замок закрытого периода Кассы для других модулей (src/cash-lock.js, аудит A04).
const test = require('node:test');
const assert = require('node:assert');
const { lockErrorFor, cashLockError } = require('../src/cash-lock');

test('дата в закрытом периоде — ошибка, после замка — можно', () => {
  assert.match(lockErrorFor('2026-08-31', ['2026-08-31']), /Касса закрыта по 31\.08\.2026/);
  assert.equal(lockErrorFor('2026-08-31', ['2026-09-01']), null);
  assert.equal(lockErrorFor(null, ['2020-01-01']), null);
  assert.match(lockErrorFor('2026-08-31', ['2026-09-05', '2026-08-01']), /закрыта/); // любая из дат
  assert.equal(lockErrorFor('2026-08-31', [null, undefined]), null);
});

test('замок читается из настроек; мусор в настройке = замка нет', async () => {
  const pool = (v) => ({ query: async () => ({ rows: v === undefined ? [] : [{ value: v }] }) });
  assert.match(await cashLockError(pool('2026-08-31'), '2026-08-15'), /закрыта/);
  assert.equal(await cashLockError(pool('abc'), '2026-08-15'), null);
  assert.equal(await cashLockError(pool(undefined), '2026-08-15'), null);
});
