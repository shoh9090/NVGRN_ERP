// Разбор того, что вписали в ячейку табеля. Ошибка здесь либо не даст
// поставить смену, либо тихо запишет не те часы — и то и другое про деньги.
// Норма смены приходит из графика сотрудника: у «6/1 по 10 ч» это 10.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCell } = require('../public/timesheet-input');

test('число в пределах нормы — просто отработанные часы', () => {
  assert.deepStrictEqual(parseCell('10', 10), { mark: 'work', hours: 10, overtime_hours: null });
  assert.deepStrictEqual(parseCell('8', 10), { mark: 'work', hours: 8, overtime_hours: null });
});

test('часы сверх нормы смены сами становятся переработкой', () => {
  // Норма 10, написали 13 — значит смена и три часа сверх неё. Делить руками
  // не надо: человек смотрит на часы, а не считает, какие из них «лишние».
  assert.deepStrictEqual(parseCell('13', 10), { mark: 'work', hours: 10, overtime_hours: 3 });
  assert.deepStrictEqual(parseCell('12', 8), { mark: 'work', hours: 8, overtime_hours: 4 });
});

test('явно указанную переработку не пересчитываем', () => {
  assert.deepStrictEqual(parseCell('10+3', 10), { mark: 'work', hours: 10, overtime_hours: 3 });
  assert.deepStrictEqual(parseCell('10 + 3', 10), { mark: 'work', hours: 10, overtime_hours: 3 });
});

test('«+3» — смена по графику плюс переработка', () => {
  assert.deepStrictEqual(parseCell('+3', 10), { mark: 'work', hours: 10, overtime_hours: 3 });
});

test('запятая работает как точка', () => {
  assert.deepStrictEqual(parseCell('7,5', 10), { mark: 'work', hours: 7.5, overtime_hours: null });
});

test('буквы — статусы дня', () => {
  assert.strictEqual(parseCell('в', 10).mark, 'off');
  assert.strictEqual(parseCell('О', 10).mark, 'vacation');
  assert.strictEqual(parseCell('б', 10).mark, 'sick');
  assert.strictEqual(parseCell('нб', 10).mark, 'absent');
});

test('пусто — снять отметку', () => {
  assert.deepStrictEqual(parseCell('', 10), { mark: null });
  assert.deepStrictEqual(parseCell('   ', 10), { mark: null });
});

test('чушь не превращается в смену', () => {
  assert.ok(parseCell('абв', 10).error);
  assert.ok(parseCell('12ч', 10).error);
});

test('больше суток в сутки не влезает', () => {
  assert.ok(parseCell('25', 10).error);
  assert.ok(parseCell('0', 10).error);
});

test('без нормы графика число остаётся как есть', () => {
  // Норма не задана — делить не на что, записываем то, что вписали.
  assert.deepStrictEqual(parseCell('13', 0), { mark: 'work', hours: 13, overtime_hours: null });
});
