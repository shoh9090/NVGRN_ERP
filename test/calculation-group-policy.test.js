const { test } = require('node:test');
const assert = require('node:assert');
const policy = require('../src/calculation-group-policy');

const group = {
  price_includes_vat: true,
  vat_rate: 12,
  retro_rate: 21,
  profit_tax_rate: 15,
  waste_reserve_rate: 50,
};

test('обычный расчёт берёт общие условия из группы, а цену — из изделия', () => {
  const result = policy.commercialForGroup(group, {
    price: 28000,
    vat_rate: 99,
    retro_rate: 0,
    target_margin_rate: 30,
    price_round_step: 500,
  });
  assert.strictEqual(result.price, 28000);
  assert.strictEqual(result.vat_rate, 12);
  assert.strictEqual(result.retro_rate, 21);
  assert.strictEqual(result.profit_tax_rate, 15);
  assert.strictEqual(result.waste_reserve_rate, 50);
  assert.strictEqual(result.target_margin_rate, null);
  assert.strictEqual(result.price_round_step, 0);
});

test('модель может временно переопределить условия группы', () => {
  const result = policy.commercialForGroup(group, { price: 30000, waste_reserve_rate: 20 }, 'model');
  assert.strictEqual(result.price, 30000);
  assert.strictEqual(result.waste_reserve_rate, 20);
  assert.strictEqual(result.vat_rate, 12);
});

test('упаковка группы переводится из нормы на единицу в рецептуру партии', () => {
  const result = policy.packagingForBatch([
    { item_id: 8, qty: 1, comment: 'пакет' },
    { item_id: 9, qty: 0.5 },
  ], 100);
  assert.deepStrictEqual(result.map((row) => row.qty_net), [100, 50]);
  assert.ok(result.every((row) => row.item_kind === 'packaging' && row.inherited_from_group));
});
