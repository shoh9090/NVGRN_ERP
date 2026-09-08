// Разбор того, что вписали в ячейку табеля. Ошибка здесь либо не даст
// поставить смену, либо тихо запишет не те часы — и то и другое про деньги.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCell } = require('../public/timesheet-input');

test('число — это отработанные часы', () => {
  assert.deepStrictEqual(parseCell('12', 12), { mark: 'work', hours: 12, overtime_hours: null });
  assert.deepStrictEqual(parseCell('8', 12), { mark: 'work', hours: 8, overtime_hours: null });
});

test('«12+3» — часы и переработка', () => {
  assert.deepStrictEqual(parseCell('12+3', 12), { mark: 'work', hours: 12, overtime_hours: 3 });
  assert.deepStrictEqual(parseCell('12 + 3', 12), { mark: 'work', hours: 12, overtime_hours: 3 });
});

test('«+3» — смена по графику плюс переработка', () => {
  assert.deepStrictEqual(parseCell('+3', 12), { mark: 'work', hours: 12, overtime_hours: 3 });
});

test('запятая работает как точка', () => {
  assert.deepStrictEqual(parseCell('7,5', 12), { mark: 'work', hours: 7.5, overtime_hours: null });
});

test('буквы — статусы дня', () => {
  assert.strictEqual(parseCell('в', 12).mark, 'off');
  assert.strictEqual(parseCell('О', 12).mark, 'vacation');
  assert.strictEqual(parseCell('б', 12).mark, 'sick');
  assert.strictEqual(parseCell('нб', 12).mark, 'absent');
});

test('пусто — снять отметку', () => {
  assert.deepStrictEqual(parseCell('', 12), { mark: null });
  assert.deepStrictEqual(parseCell('   ', 12), { mark: null });
});

test('чушь не превращается в смену', () => {
  assert.ok(parseCell('абв', 12).error);
  assert.ok(parseCell('12ч', 12).error);
});

test('больше суток в сутки не влезает', () => {
  assert.ok(parseCell('25', 12).error);
  assert.ok(parseCell('0', 12).error);
});
