// Когда «409 Conflict» от Telegram стоит показывать админу (tg-bot/polling-guard.js).
// Разбор 03.10.2026: при выкладке Railway держит старый и новый контейнер
// одновременно, в логах появился один 409 через 8 секунд после старта — и
// улетела тревога «запущено два экземпляра», хотя всё было в порядке.
const test = require('node:test');
const assert = require('node:assert');
const { conflictWatch } = require('../tg-bot/polling-guard');

const T0 = Date.parse('2026-10-03T18:35:26Z');
const CONFLICT = 'ETELEGRAM: 409 Conflict: terminated by other getUpdates request';
const min = (n) => T0 + n * 60000;

test('409 сразу после старта — это пересменка при выкладке, молчим', () => {
  const w = conflictWatch({ startedAt: T0 });
  assert.equal(w(CONFLICT, T0 + 8000), false);
  assert.equal(w(CONFLICT, T0 + 20000), false);
});

test('одиночный 409 позже — тоже не повод будить', () => {
  const w = conflictWatch({ startedAt: T0 });
  assert.equal(w(CONFLICT, min(5)), false);
  assert.equal(w(CONFLICT, min(6)), false);
});

test('конфликты идут один за другим — вот это два бота, говорим', () => {
  const w = conflictWatch({ startedAt: T0 });
  assert.equal(w(CONFLICT, min(5)), false);
  assert.equal(w(CONFLICT, min(6)), false);
  assert.equal(w(CONFLICT, min(7)), true);
});

test('пока война идёт, тревога не повторяется каждую минуту', () => {
  const w = conflictWatch({ startedAt: T0 });
  [5, 6, 7].forEach((m) => w(CONFLICT, min(m)));          // первая тревога на 7-й минуте
  for (let m = 8; m <= 15; m++) assert.equal(w(CONFLICT, min(m)), false);
});

test('война вернулась через час — тревожим снова, но опять не с первого раза', () => {
  const w = conflictWatch({ startedAt: T0 });
  [5, 6, 7].forEach((m) => w(CONFLICT, min(m)));
  assert.equal(w(CONFLICT, min(70)), false);              // после долгой тишины счёт сначала
  assert.equal(w(CONFLICT, min(71)), false);
  assert.equal(w(CONFLICT, min(72)), true);
});

test('конфликты прекратились — счёт начинается заново', () => {
  const w = conflictWatch({ startedAt: T0 });
  assert.equal(w(CONFLICT, min(5)), false);
  assert.equal(w(CONFLICT, min(6)), false);
  assert.equal(w(CONFLICT, min(40)), false);              // пауза 34 минуты обнулила счёт
  assert.equal(w(CONFLICT, min(41)), false);
  assert.equal(w(CONFLICT, min(42)), true);
});

test('другие ошибки опроса сторожа не касаются', () => {
  const w = conflictWatch({ startedAt: T0 });
  ['ETELEGRAM: 502 Bad Gateway', 'EFATAL: socket hang up', ''].forEach((m, i) => {
    assert.equal(w(m, min(10 + i)), false);
  });
});
