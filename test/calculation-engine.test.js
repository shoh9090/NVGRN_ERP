// Тесты расчётного двигателя себестоимости (обязательные случаи из ТЗ раздел 25.1).
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('../src/calculation-engine');

// Округление для сравнения: считаем с полной точностью, сверяем до копеек.
const r2 = (v) => Math.round(v * 100) / 100;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// Базовый вход: без накладных и ФОТ, чтобы проверять именно материалы.
const base = (over = {}) => ({
  today: '2026-08-09',
  recipe: { batch_output_qty: 1, items: [] },
  total_output: 1000,
  fot: { accrued: 0, inps: 0, ndfl: 0, social: 0 },
  monthly_expenses: { production: 0, admin: 0, commercial: 0, logistics: 0, finance: 0 },
  commercial: { price: 10000, price_includes_vat: true, vat_rate: 12, retro_rate: 0, profit_tax_rate: 15, waste_reserve_rate: 0, price_round_step: 500 },
  ...over,
});

test('один компонент без потерь', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 0, price: 20000, price_date: '2026-08-01' }] },
  }));
  assert.strictEqual(r2(res.layers.raw), 2000);
  assert.strictEqual(res.errors.length, 0);
});

test('сырьё в кг: норма введена в граммах и пересчитана в кг', () => {
  // Интерфейс принимает 100 г и сохраняет 0,1 кг — проверяем, что цена за кг даёт верную стоимость.
  const grams = 100;
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: grams / 1000, unit: 'кг', loss_rate: 0, price: 20000 }] },
  }));
  assert.strictEqual(r2(res.layers.raw), 2000);
});

test('технологические потери 10% (пример ТЗ 14.1)', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 10, price: 20000 }] },
  }));
  assert.strictEqual(r6(res.rows[0].qty_with_loss), 0.111111);
  assert.strictEqual(r2(res.layers.raw), 2222.22);
});

test('несколько компонентов салатной смеси', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [
      { item_kind: 'raw', name: 'Латук', qty_net: 0.06, unit: 'кг', loss_rate: 0, price: 20000 },
      { item_kind: 'raw', name: 'Руккола', qty_net: 0.03, unit: 'кг', loss_rate: 0, price: 35000 },
      { item_kind: 'raw', name: 'Радиккио', qty_net: 0.01, unit: 'кг', loss_rate: 0, price: 50000 },
    ] },
  }));
  // 1200 + 1050 + 500
  assert.strictEqual(r2(res.layers.raw), 2750);
});

test('несколько элементов упаковки', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [
      { item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 0, price: 20000 },
      { item_kind: 'packaging', name: 'Пакет вакуумный', qty_net: 1, unit: 'шт', loss_rate: 0, price: 600 },
      { item_kind: 'packaging', name: 'Этикетка', qty_net: 1, unit: 'шт', loss_rate: 0, price: 150 },
      { item_kind: 'packaging', name: 'Термолента', qty_net: 0.5, unit: 'шт', loss_rate: 0, price: 100 },
    ] },
  }));
  assert.strictEqual(r2(res.layers.raw), 2000);
  assert.strictEqual(r2(res.layers.packaging), 800);
});

test('рецептура на партию: состав на 100 упаковок приводится к одной', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 100, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 10, unit: 'кг', loss_rate: 0, price: 20000 }] },
  }));
  assert.strictEqual(r6(res.rows[0].qty_net_per_unit), 0.1);
  assert.strictEqual(r2(res.layers.raw), 2000);
});

test('резерв брака 50% даёт множитель 1,5', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 0, price: 20000 }] },
    commercial: { ...base().commercial, waste_reserve_rate: 50 },
  }));
  assert.strictEqual(r2(res.layers.cost_before_reserve), 2000);
  assert.strictEqual(r2(res.layers.cost_with_reserve), 3000);
});

test('ФОТ с налогами делится на общий выпуск', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 0, price: 20000 }] },
    total_output: 1000,
    fot: { accrued: 80000000, inps: 1000000, ndfl: 9000000, social: 10000000 },
  }));
  assert.strictEqual(res.fot.total_load, 100000000);
  assert.strictEqual(r2(res.fot.per_unit), 100000);
  assert.strictEqual(r2(res.layers.fot_per_unit), 100000);
});

test('нулевой выпуск блокирует расчёт, ноль не подставляется', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 0, price: 20000 }] },
    total_output: 0,
    fot: { accrued: 1000000, inps: 0, ndfl: 0, social: 0 },
  }));
  assert.strictEqual(res.fot.per_unit, null);
  assert.ok(res.errors.some((e) => e.code === 'OUTPUT_ZERO'));
  assert.strictEqual(res.can_approve, false);
});

test('отсутствующая цена не превращается в ноль и блокирует утверждение', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 0, price: null }] },
  }));
  assert.strictEqual(res.rows[0].price, null);
  assert.strictEqual(res.rows[0].cost, null);
  assert.strictEqual(res.layers.raw, 0);
  assert.ok(res.errors.some((e) => e.code === 'PRICE_MISSING'));
  assert.strictEqual(res.can_approve, false);
});

test('НДС включён в цену', () => {
  const v = E.calcVat(11200, 12, true);
  assert.strictEqual(r2(v.vat), 1200);
  assert.strictEqual(r2(v.revenue_net), 10000);
  assert.strictEqual(r2(v.invoice_price), 11200);
});

test('НДС не включён в цену', () => {
  const v = E.calcVat(10000, 12, false);
  assert.strictEqual(r2(v.vat), 1200);
  assert.strictEqual(r2(v.revenue_net), 10000);
  assert.strictEqual(r2(v.invoice_price), 11200);
});

test('ретро 21% считается от цены продажи', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 0, price: 20000 }] },
    commercial: { ...base().commercial, price: 10000, retro_rate: 21 },
  }));
  assert.strictEqual(r2(res.commercial.retro), 2100);
  // Выручка без НДС = 10000 − 10000×12/112 = 8928,57
  assert.strictEqual(r2(res.commercial.revenue_net), 8928.57);
  // Прибыль = 8928,57 − 2100 − 2000
  assert.strictEqual(r2(res.commercial.profit_before_tax), 4828.57);
});

test('прибыль отрицательная — налог на прибыль равен нулю', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 1, unit: 'кг', loss_rate: 0, price: 20000 }] },
    commercial: { ...base().commercial, price: 5000 },
  }));
  assert.ok(res.commercial.profit_before_tax < 0);
  assert.strictEqual(res.commercial.profit_tax, 0);
  assert.strictEqual(res.commercial.net_profit, res.commercial.profit_before_tax);
  assert.ok(res.warnings.some((w) => w.code === 'PROFIT_NEGATIVE'));
});

test('целевая маржа: рекомендуемая цена по формуле ТЗ 14.8', () => {
  // Себестоимость 5000, НДС 12% в цене, ретро 0, налог 15%, целевая маржа 20%.
  // Доля НДС = 12/112 = 0,107142857; маржа/(1−налог) = 0,2/0,85 = 0,235294118
  // Знаменатель = 1 − 0,107142857 − 0 − 0,235294118 = 0,657563025
  // Цена = 5000 / 0,657563025 = 7603,83 → вверх до 500 = 8000
  const rec = E.recommendPrice({
    full_cost: 5000, includes_vat: true, vat_rate: 12, retro_rate: 0,
    profit_tax_rate: 15, goal: 'target_margin', target_margin: 20, round_step: 500,
  });
  assert.strictEqual(r2(rec.price_before_round), 7603.83);
  assert.strictEqual(rec.price, 8000);
  assert.strictEqual(rec.error, null);
});

test('округление цены вверх до 500 сум', () => {
  assert.strictEqual(E.ceilTo(7604.57, 500), 8000);
  assert.strictEqual(E.ceilTo(8000, 500), 8000);
  assert.strictEqual(E.ceilTo(8000.01, 500), 8500);
});

test('недостижимая целевая маржа: цена не выдаётся, есть объяснение', () => {
  const rec = E.recommendPrice({
    full_cost: 5000, includes_vat: true, vat_rate: 12, retro_rate: 21,
    profit_tax_rate: 15, goal: 'target_margin', target_margin: 90, round_step: 500,
  });
  assert.strictEqual(rec.price, null);
  assert.ok(/недостижима/i.test(rec.error));
});

test('цель «сохранить чистую прибыль» даёт ту же прибыль на единицу', () => {
  const cost = 5000, vatRate = 12, retroRate = 10, taxRate = 15, targetNet = 1000;
  const rec = E.recommendPrice({
    full_cost: cost, includes_vat: true, vat_rate: vatRate, retro_rate: retroRate,
    profit_tax_rate: taxRate, goal: 'keep_profit', target_net_profit: targetNet, round_step: 0,
  });
  const P = rec.price_before_round;
  const revenueNet = P - (P * vatRate) / (100 + vatRate);
  const profit = revenueNet - (P * retroRate) / 100 - cost;
  const net = profit - (Math.max(profit, 0) * taxRate) / 100;
  assert.strictEqual(r2(net), targetNet);
});

test('наценка к себестоимости', () => {
  const rec = E.recommendPrice({ full_cost: 5000, goal: 'markup', markup_rate: 40, round_step: 0 });
  assert.strictEqual(r2(rec.price_before_round), 7000);
});

test('средневзвешенная цена нескольких поставок', () => {
  // (100×20000 + 50×26000) / 150 = 22000
  const w = E.weightedAveragePrice([{ qty: 100, price: 20000 }, { qty: 50, price: 26000 }]);
  assert.strictEqual(r2(w.price), 22000);
  assert.strictEqual(w.qty, 150);
  assert.strictEqual(w.used_deliveries, 2);
});

test('средневзвешенная цена игнорирует нулевые и отрицательные строки', () => {
  const w = E.weightedAveragePrice([
    { qty: 100, price: 20000 }, { qty: 0, price: 99000 },
    { qty: -5, price: 30000 }, { qty: 10, price: 0 },
  ]);
  assert.strictEqual(r2(w.price), 20000);
  assert.strictEqual(w.used_deliveries, 1);
});

test('нет ни одной пригодной поставки — цена null, а не ноль', () => {
  const w = E.weightedAveragePrice([{ qty: 0, price: 0 }]);
  assert.strictEqual(w.price, null);
});

test('смешанная срочная закупка (пример ТЗ 15.1)', () => {
  const s = E.calcShortage({ planned_qty: 200, available_qty: 70, base_price: 20000, urgent_qty: 130, urgent_price: 34000 });
  assert.strictEqual(s.shortage_qty, 130);
  assert.strictEqual(r2(s.blended_price), 29100);
  assert.strictEqual(r2(s.extra_cost), 1820000);
});

test('дефицит: срочное количество по умолчанию = недостача', () => {
  const s = E.calcShortage({ planned_qty: 200, available_qty: 70, base_price: 20000, urgent_price: 34000 });
  assert.strictEqual(s.urgent_qty, 130);
});

test('потери 100% блокируют расчёт', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 100, price: 20000 }] },
  }));
  assert.ok(res.errors.some((e) => e.code === 'LOSS_TOO_BIG'));
});

test('нулевое количество компонента блокирует расчёт', () => {
  const res = E.calculateProduct(base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0, unit: 'кг', loss_rate: 0, price: 20000 }] },
  }));
  assert.ok(res.errors.some((e) => e.code === 'QTY_NOT_POSITIVE'));
});

test('пустая рецептура блокирует расчёт', () => {
  const res = E.calculateProduct(base());
  assert.ok(res.errors.some((e) => e.code === 'RECIPE_EMPTY'));
});

test('устаревшая цена — предупреждение, а не блокировка', () => {
  const res = E.calculateProduct(base({
    today: '2026-08-09',
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 0, price: 20000, price_date: '2026-06-01' }] },
  }));
  assert.ok(res.warnings.some((w) => w.code === 'PRICE_STALE'));
  assert.strictEqual(res.errors.length, 0);
  assert.strictEqual(res.can_approve, true);
});

test('неизменность исходного объекта расчёта', () => {
  const input = base({
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 10, price: 20000 }] },
  });
  const before = JSON.stringify(input);
  E.calculateProduct(input);
  assert.strictEqual(JSON.stringify(input), before);
});

test('полный сквозной расчёт: слои, прибыль, маржа', () => {
  const res = E.calculateProduct({
    today: '2026-08-09',
    recipe: { batch_output_qty: 1, items: [
      { item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 10, price: 20000, price_date: '2026-08-05' },
      { item_kind: 'packaging', name: 'Пакет', qty_net: 1, unit: 'шт', loss_rate: 0, price: 600, price_date: '2026-08-05' },
    ] },
    total_output: 10000,
    fot: { accrued: 8000000, inps: 100000, ndfl: 900000, social: 1000000 }, // 10 000 000 / 10 000 = 1000
    monthly_expenses: { production: 2000000, admin: 1000000, commercial: 500000, logistics: 300000, finance: 200000 },
    commercial: { price: 12000, price_includes_vat: true, vat_rate: 12, retro_rate: 10, profit_tax_rate: 15, waste_reserve_rate: 5, price_round_step: 500, target_margin_rate: 15 },
  });
  // сырьё 2222,22 + упаковка 600 + ФОТ 1000 + производство 200 = 4022,22
  assert.strictEqual(r2(res.layers.production_cost), 4022.22);
  // + админ 100 = 4122,22 → ×1,05 = 4328,33
  assert.strictEqual(r2(res.layers.cost_before_reserve), 4122.22);
  assert.strictEqual(r2(res.layers.cost_with_reserve), 4328.33);
  // + коммерч 50 + логистика 30 + финансы 20 = 4428,33
  assert.strictEqual(r2(res.layers.full_cost), 4428.33);
  // НДС = 12000×12/112 = 1285,71; выручка = 10714,29; ретро = 1200
  assert.strictEqual(r2(res.commercial.vat), 1285.71);
  assert.strictEqual(r2(res.commercial.retro), 1200);
  assert.strictEqual(r2(res.commercial.profit_before_tax), 5085.95);
  assert.strictEqual(r2(res.commercial.profit_tax), 762.89);
  assert.strictEqual(r2(res.commercial.net_profit), 4323.06);
  assert.strictEqual(r2(res.commercial.net_margin), 36.03);
  assert.strictEqual(res.errors.length, 0);
  assert.strictEqual(res.can_approve, true);
});
