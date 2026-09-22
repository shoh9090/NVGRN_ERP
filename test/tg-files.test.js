// Видео претензий в Telegram (src/tg-files.js): место в базе освобождаем только
// когда Telegram точно отдаёт тот же файл.
const test = require('node:test');
const assert = require('node:assert');
const { safeToOffload } = require('../src/tg-files');

test('размер в Telegram совпал с базой — можно освобождать', () => {
  assert.strictEqual(safeToOffload(4500000, { size: 4500000 }), true);
});

test('не совпал, не отдал или размер неизвестен — не трогаем', () => {
  assert.strictEqual(safeToOffload(4500000, { size: 4400000 }), false);
  assert.strictEqual(safeToOffload(4500000, null), false);
  assert.strictEqual(safeToOffload(4500000, { size: null }), false);
  assert.strictEqual(safeToOffload(0, { size: 0 }), false);          // уже пусто — нечего освобождать
});
