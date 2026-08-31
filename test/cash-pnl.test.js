// Проверка сборки управленческого P&L на поддельной базе.
// Главное, что проверяем, — отчёт не врёт: не считает себестоимость дважды,
// не прячет неоценённые позиции и не выдаёт ноль там, где данных нет.
const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const { buildPnl } = require('../src/cash-pnl');

// Поддельный пул: отвечает на запросы P&L заранее подготовленными строками.
function makePool(opts) {
  const o = opts || {};
  return {
    query: async (sql) => {
      const q = String(sql).replace(/\s+/g, ' ');
      // Проверяем даты как настоящий Postgres: колонку date драйвер отдаёт
      // объектом Date, а to_char — строкой. Раньше заглушка всегда возвращала
      // строку, и ошибка «invalid input syntax for type date: Mon Aug 31»
      // до прода дошла незамеченной.
      // to_char просим текстом — база возвращает готовую строку
      if (/to_char/.test(q) && /INTERVAL/.test(q)) return { rows: [{ d: '2026-08-31' }] };
      // а голую колонку date драйвер отдал бы объектом Date
      if (/INTERVAL '1 month'/.test(q)) return { rows: [{ d: new Date('2026-08-31T00:00:00+05:00') }] };
      if (/FROM settings WHERE key/.test(q)) return { rows: o.settings || [] };
      if (/FROM cash_transactions t JOIN cash_categories/.test(q)) return { rows: o.cash || [] };
      if (/AND t\.category_id IS NULL/.test(q)) return { rows: [o.unclassified || { inc: 0, exp: 0, cnt: 0 }] };
      if (/direction_hint = 'transfer'/.test(q)) return { rows: [{ inc: o.transfersIn || 0 }] };
      if (/reason = 'production'/.test(q)) return { rows: o.used || [] };
      if (/reason = 'receive'/.test(q)) return { rows: o.prices || [] };
      if (/reason = 'adjust'/.test(q)) return { rows: [o.adjust || { qty: 0, cnt: 0 }] };
      if (/FROM ref_raw_materials WHERE id = ANY/.test(q)) return { rows: o.rawNames || [] };
      if (/FROM ref_packaging WHERE id = ANY/.test(q)) return { rows: o.packNames || [] };
      if (/FROM calc_sheet_products/.test(q)) return { rows: o.products || [] };
      if (/FROM calc_pack_templates/.test(q)) return { rows: o.templates || [] };
      if (/FROM calc_mix_items/.test(q)) return { rows: o.recipes || [] };
      return { rows: [] };
    },
  };
}

const CASH = [
  { code: '200', name: 'Выручка от продаж', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 100000000, exp: 0, cnt: 12 },
  { code: '10', name: 'Сырьё (зелень)', group_name: '1. Сырьё и переменные затраты', flow_type: 'operating', inc: 0, exp: 40000000, cnt: 8 },
  { code: '23', name: 'Электричество', group_name: '2. Производственные затраты', flow_type: 'operating', inc: 0, exp: 5000000, cnt: 2 },
  { code: '50', name: 'Топливо', group_name: '5. Логистика', flow_type: 'operating', inc: 0, exp: 3000000, cnt: 4 },
  { code: '61', name: 'Возврат тела кредита', group_name: '6. Финансы', flow_type: 'financing', inc: 0, exp: 20000000, cnt: 1 },
  { code: '70', name: 'Оборудование', group_name: '7. Капекс (инвестиции)', flow_type: 'investing', inc: 0, exp: 15000000, cnt: 1 },
];

test('оплата поставщикам за сырьё не считается расходом дважды', async () => {
  const pool = makePool({
    cash: CASH,
    used: [{ item_kind: 'raw', item_id: 1, qty: 1000 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 30000 }],
    rawNames: [{ id: 1, name: 'рукола' }],
  });
  const r = await buildPnl(pool, '2026-08');

  // Себестоимость — со склада (1000 кг × 30 000), а не 40 млн оплаты поставщику
  assert.strictEqual(r.cogs.fact.total, 30000000);
  // Оплата поставщикам ушла в справочный блок, а не в операционные расходы
  assert.strictEqual(r.excluded.materials_paid.total, 40000000);
  // В расходах остались только производственные и логистика
  assert.strictEqual(r.opex.total, 8000000);
  assert.strictEqual(r.cogs_source, 'fact');
  assert.strictEqual(r.gross_profit, 70000000);
  assert.strictEqual(r.operating_profit, 62000000);
});

test('кредит и капекс в прибыль не попадают', async () => {
  const pool = makePool({ cash: CASH, used: [{ item_kind: 'raw', item_id: 1, qty: 1 }], prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }] });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.excluded.finance.out, 20000000);
  assert.strictEqual(r.excluded.capex.total, 15000000);
  // ...и не сидят внутри операционных расходов
  const names = r.opex.groups.map((g) => g.group_name);
  assert.ok(!names.some((n) => n.startsWith('6.')));
  assert.ok(!names.some((n) => n.startsWith('7.')));
});

test('позиция без цены прихода не занижает себестоимость молча', async () => {
  const pool = makePool({
    cash: CASH,
    used: [
      { item_kind: 'raw', item_id: 1, qty: 1000 },
      { item_kind: 'raw', item_id: 2, qty: 500 },   // цены нет
    ],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 30000 }],
    rawNames: [{ id: 1, name: 'рукола' }, { id: 2, name: 'шпинат' }],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs.fact.total, 30000000);
  assert.strictEqual(r.cogs.fact.no_price.length, 1);
  assert.strictEqual(r.cogs.fact.no_price[0].name, 'шпинат');
  assert.ok(r.warnings.some((w) => w.includes('Нет цены прихода') && w.includes('шпинат')),
    'предупреждение должно называть позицию по имени: ' + r.warnings.join(' | '));
});

test('нет ни списаний, ни отгрузок — прибыль не считается, а не показывается нулём', async () => {
  const pool = makePool({ cash: CASH, used: [] });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs.fact.has_data, false);
  assert.strictEqual(r.cogs_source, null);
  assert.strictEqual(r.gross_profit, null);
  assert.strictEqual(r.operating_profit, null);
  assert.strictEqual(r.gross_margin_pct, null);
  assert.ok(r.warnings.some((w) => w.includes('посчитать не из чего')));
});

test('склад не вёлся — прибыль считается по плану, и это видно', async () => {
  const pool = makePool({
    cash: CASH,
    used: [],                                        // выдач со склада нет
    settings: [{ key: 'pnl_units_2026-08', value: '1000' }],
    products: [{ net_weight_g: 100, raw_price_per_kg: 30000, raw_cost: null, pack_template_id: 1, recipe_id: null }],
    templates: [{ id: 1, total: 1000 }],
  });
  const r = await buildPnl(pool, '2026-08');
  // Источник назван явно — подмена факта планом не должна быть незаметной
  assert.strictEqual(r.cogs_source, 'plan');
  assert.strictEqual(r.cogs.plan.total, 4000000);
  assert.strictEqual(r.gross_profit, 100000000 - 4000000);
  assert.ok(r.warnings.some((w) => w.includes('по плану')));
});

test('неразнесённые операции попадают в предупреждения', async () => {
  const pool = makePool({
    cash: CASH, unclassified: { inc: 0, exp: 900000, cnt: 3 },
    used: [{ item_kind: 'raw', item_id: 1, qty: 1 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.excluded.unclassified.cnt, 3);
  assert.ok(r.warnings.some((w) => w.includes('без статьи')));
});

test('плановая себестоимость не считается без количества отгрузок', async () => {
  const pool = makePool({ cash: CASH, used: [{ item_kind: 'raw', item_id: 1, qty: 1 }], prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }] });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs.plan.total, null);
  assert.strictEqual(r.cogs.diff, null);
  assert.ok(r.warnings.some((w) => w.includes('отгрузок')));
});

test('миксы по рецептуре не выпадают из плановой себестоимости', async () => {
  const pool = makePool({
    cash: CASH,
    used: [{ item_kind: 'raw', item_id: 1, qty: 1 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }],
    settings: [{ key: 'pnl_units_2026-08', value: '1000' }],
    // один обычный товар (граммаж) и один микс (рецептура)
    products: [
      { net_weight_g: 100, raw_price_per_kg: 30000, raw_cost: null, pack_template_id: 1, recipe_id: null },
      { net_weight_g: null, raw_price_per_kg: null, raw_cost: null, pack_template_id: 1, recipe_id: 7 },
    ],
    templates: [{ id: 1, total: 1000 }],
    recipes: [{ recipe_id: 7, total: 5000, priced: 3 }],
  });
  const r = await buildPnl(pool, '2026-08');
  // Оба товара учтены: (3000+1000) и (5000+1000) → среднее 5000
  assert.strictEqual(r.cogs.plan.products, 2);
  assert.strictEqual(r.cogs.plan.skipped, 0);
  assert.strictEqual(r.cogs.plan.unit_cost, 5000);
  assert.strictEqual(r.cogs.plan.total, 5000000);
});

test('в запросы уходит дата в формате базы, а не текст Date', async () => {
  const seen = [];
  const base = makePool({ cash: CASH, used: [], settings: [] });
  const pool = {
    query: async (sql, params) => {
      // Ловим любую дату, ушедшую параметром: она должна быть ГГГГ-ММ-ДД
      (params || []).forEach((v) => { if (typeof v === 'string' && /^[A-Za-z]{3} /.test(v)) seen.push(v); });
      return base.query(sql, params);
    },
  };
  const r = await buildPnl(pool, '2026-08');
  assert.deepStrictEqual(seen, [], 'в параметры ушла дата в виде «Mon Aug 31»: ' + seen.join(', '));
  assert.strictEqual(r.to, '2026-08-31');
});

test('выручка — это доходные статьи, а не любой приход', async () => {
  const pool = makePool({
    cash: [
      { code: '200', name: 'Выручка от продаж', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1481000000, exp: 0, cnt: 300 },
      // возврат от поставщика приходит на РАСХОДНУЮ статью — это не выручка
      { code: '10', name: 'Сырьё (зелень)', group_name: '1. Сырьё и переменные затраты', flow_type: 'operating', inc: 120000000, exp: 400000000, cnt: 40 },
      { code: '50', name: 'Топливо', group_name: '5. Логистика', flow_type: 'operating', inc: 9000000, exp: 34000000, cnt: 20 },
      // конверсия валюты — обе ноги, деньги никуда не делись
      { code: '102', name: 'Конверсия валюты', group_name: '8. Прочее', flow_type: 'operating', inc: 500000000, exp: 500000000, cnt: 6 },
      // кредит — привлечённые деньги, не заработок
      { code: '202', name: 'Получение кредита', group_name: 'Доходы и поступления', flow_type: 'financing', inc: 30000000, exp: 0, cnt: 1 },
    ],
    transfersIn: 200000000,
    used: [{ item_kind: 'raw', item_id: 1, qty: 1 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }],
  });
  const r = await buildPnl(pool, '2026-07');

  // Ровно статья 200 — как реализация в SalesDoctor, а не всё подряд
  assert.strictEqual(r.revenue.total, 1481000000);
  assert.strictEqual(r.revenue.items.length, 1);

  // Возвраты по расходным статьям вынесены отдельно
  assert.strictEqual(r.excluded.other_inflows.total, 129000000);
  // Конверсия не раздувает ни выручку, ни затраты
  assert.strictEqual(r.excluded.conversion.in, 500000000);
  assert.ok(!r.opex.groups.some((g) => g.items.some((i) => i.code === '102')));
  // Кредит — в финансовых, не в выручке
  assert.strictEqual(r.excluded.finance.in, 30000000);

  // Сверка сходится: всё, что пришло, разложено без остатка
  const rc = r.reconcile;
  assert.strictEqual(
    rc.revenue + rc.finance_in + rc.other_inflows + rc.conversion_in + rc.transfers_in + rc.unclassified_in,
    rc.all_in);
});

test('расходники производства не пропадают из отчёта', async () => {
  // Статья 12 лежит в той же группе, что сырьё, но через склад не проходит.
  // Раньше она исключалась вместе с сырьём и исчезала совсем.
  const pool = makePool({
    cash: [
      { code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 100000000, exp: 0, cnt: 1 },
      { code: '10', name: 'Сырьё (зелень)', group_name: '1. Сырьё и переменные затраты', flow_type: 'operating', inc: 0, exp: 40000000, cnt: 5 },
      { code: '11', name: 'Упаковка', group_name: '1. Сырьё и переменные затраты', flow_type: 'operating', inc: 0, exp: 10000000, cnt: 3 },
      { code: '12', name: 'Расходники производства', group_name: '1. Сырьё и переменные затраты', flow_type: 'operating', inc: 0, exp: 7000000, cnt: 4 },
    ],
    used: [{ item_kind: 'raw', item_id: 1, qty: 1000 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 30000 }],
    rawNames: [{ id: 1, name: 'рукола' }],
  });
  const r = await buildPnl(pool, '2026-08');
  // Сырьё и упаковка — в справочном блоке (их расход берём со склада)
  assert.strictEqual(r.excluded.materials_paid.total, 50000000);
  // А расходники остались настоящим расходом
  assert.strictEqual(r.opex.total, 7000000);
  assert.ok(r.opex.groups.some((g) => g.items.some((i) => i.code === '12')),
    'статья 12 должна быть среди операционных расходов');
});

test('возврат покупателю уменьшает выручку, а не пропадает', async () => {
  const pool = makePool({
    cash: [
      { code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 100000000, exp: 4000000, cnt: 20 },
    ],
    used: [{ item_kind: 'raw', item_id: 1, qty: 1 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.excluded.refunds.total, 4000000);
  assert.strictEqual(r.revenue.total, 96000000);
  // и в расходы возврат не залез
  assert.strictEqual(r.opex.total, 0);
});

test('минусовые корректировки склада видны, а не спрятаны', async () => {
  const pool = makePool({
    cash: CASH,
    used: [{ item_kind: 'raw', item_id: 1, qty: 1 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }],
    adjust: { qty: 250, cnt: 4 },
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.stock_adjust.qty, 250);
  assert.strictEqual(r.stock_adjust.cnt, 4);
});

test('прочие доходы не приплюсовываются к выручке от продаж', async () => {
  // Случай из жизни: в Кэш-флоу строка «Выручка от продаж» = 1 485 957 206,
  // а P&L показывал 1 597 509 206. Разница — прочие доходные статьи, которые
  // сваливались в ту же строку. Теперь они видны отдельно.
  const pool = makePool({
    cash: [
      { code: '200', name: 'Выручка от продаж', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1485957206, exp: 0, cnt: 640 },
      { code: '204', name: 'Прочие доходы', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 111552000, exp: 0, cnt: 12 },
      { code: '202', name: 'Получение кредита', group_name: 'Доходы и поступления', flow_type: 'financing', inc: 80000000, exp: 0, cnt: 1 },
    ],
    used: [{ item_kind: 'raw', item_id: 1, qty: 1 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }],
  });
  const r = await buildPnl(pool, '2026-07');

  // Строка выручки совпадает с Кэш-флоу до копейки
  assert.strictEqual(r.revenue.sales, 1485957206);
  assert.strictEqual(r.revenue.sales_items.length, 1);
  // Прочие доходы видны отдельно и названы поимённо
  assert.strictEqual(r.revenue.other, 111552000);
  assert.strictEqual(r.revenue.other_items[0].code, '204');
  // Кредит по-прежнему в финансовых, а не в доходах
  assert.strictEqual(r.excluded.finance.in, 80000000);
  // В прибыль идут все доходы, и это ровно сумма двух строк
  assert.strictEqual(r.revenue.total, 1485957206 + 111552000);
  // Сверка по-прежнему сходится без остатка
  const rc = r.reconcile;
  assert.strictEqual(rc.sales + rc.other_income, rc.revenue + rc.refunds);
});
