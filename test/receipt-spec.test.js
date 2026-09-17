// Приёмка: сервер сам сверяет замеры со спецификацией (src/stock.js, аудит A07).
const test = require('node:test');
const assert = require('node:assert');
const { applySpecVerdict } = require('../src/stock');

const SPEC = [
  { item_id: 5, name: 'Длина', ptype: 'range', min_val: '10', max_val: '20' },
  { item_id: 5, name: 'Цвет', ptype: 'quality', min_val: null, max_val: null },
];

test('браузер прислал «в норме», а замер вне коридора — провал', () => {
  const checks = [{ item_id: 5, param_name: 'Длина', measured: '25', passed: true }];
  assert.equal(applySpecVerdict(checks, SPEC), true);
  assert.equal(checks[0].passed, false);
});

test('замер в коридоре, запятая как разделитель — в норме', () => {
  const checks = [{ item_id: 5, param_name: 'Длина', measured: '12,5', passed: false }];
  assert.equal(applySpecVerdict(checks, SPEC), false);
});

test('пустой замер не провал; качественный ✗ — провал', () => {
  assert.equal(applySpecVerdict([{ item_id: 5, param_name: 'Длина', measured: '' }], SPEC), false);
  assert.equal(applySpecVerdict([{ item_id: 5, param_name: 'Цвет', passed: false }], SPEC), true);
  assert.equal(applySpecVerdict([{ item_id: 5, param_name: 'Длина', measured: 'abc' }], SPEC), true);
});
