// Фильтр цен по поставщику и его родительской категории (Закуп → Цены).
// Проверяем, что условия собираются с правильной нумерацией параметров —
// ошибка в номере $n молча подставила бы не то значение в запрос.
const test = require('node:test');
const assert = require('node:assert');
const { priceSupplierWhere } = require('../src/purchase');

test('без фильтров — условий нет', () => {
  const params = [];
  assert.deepEqual(priceSupplierWhere({ query: {} }, params), []);
  assert.deepEqual(params, []);
});

test('только родительская категория — поставщики этой категории', () => {
  const params = [];
  const w = priceSupplierWhere({ query: { parent_category_id: '3' } }, params);
  assert.equal(w.length, 1);
  assert.match(w[0], /parent_category_id = \$1/);
  assert.deepEqual(params, [3]);
});

test('поставщик и категория вместе — оба условия, номера по порядку', () => {
  const params = ['уже был'];
  const w = priceSupplierWhere({ query: { supplier_id: '17', parent_category_id: '3' } }, params);
  assert.equal(w.length, 2);
  assert.match(w[0], /po\.supplier_id = \$2/);
  assert.match(w[1], /parent_category_id = \$3/);
  assert.deepEqual(params, ['уже был', 17, 3]);
});

test('мусор вместо числа не попадает в запрос', () => {
  const params = [];
  const w = priceSupplierWhere({ query: { supplier_id: 'abc', parent_category_id: '' } }, params);
  assert.deepEqual(w, []);
  assert.deepEqual(params, []);
});
