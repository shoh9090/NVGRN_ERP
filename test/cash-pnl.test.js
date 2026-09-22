// Проверка сборки управленческого P&L на поддельной базе.
// Главное, что проверяем, — отчёт не врёт: не считает себестоимость дважды,
// не прячет неоценённые позиции и не выдаёт ноль там, где данных нет.
const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const { buildPnl } = require('../src/cash-pnl');

// Предупреждение — либо строка, либо объект с текстом, ссылкой «куда идти» и списком
// позиций. Для проверок склеиваем всё в одну строку.
const wtext = (w) => (typeof w === 'string' ? w : [w.text, ...(w.items || [])].join(' '));

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
      if (/reason = 'receive'|reason IN \('receive'/.test(q)) return { rows: o.prices || [] };
      if (/reason = 'adjust'/.test(q)) return { rows: [o.adjust || { qty: 0, cnt: 0 }] };
      if (/receive_waste/.test(q)) return { rows: o.waste || [] };
      if (/FROM ref_raw_materials WHERE id = ANY/.test(q)) return { rows: o.rawNames || [] };
      if (/FROM ref_packaging WHERE id = ANY/.test(q)) return { rows: o.packNames || [] };
      if (/FROM calc_sheet_products/.test(q)) return { rows: o.products || [] };
      if (/FROM calc_pack_templates/.test(q)) return { rows: o.templates || [] };
      if (/FROM calc_mix_items/.test(q)) return { rows: o.recipes || [] };
      if (/FROM purchase_orders po/.test(q)) return { rows: o.received || [] };
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

test('сырьё — принятое за месяц в Закупе; оплата поставщику расходом второй раз не считается', async () => {
  const pool = makePool({
    cash: CASH,                                                  // в Кассе оплата за сырьё 40 млн
    received: [{ m: '2026-08', orders: 12, total: 35000000 }],   // принято в Закупе на 35 млн
    used: [{ item_kind: 'raw', item_id: 1, qty: 1000 }],         // склад отметил выдачу на 30 млн
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 30000 }],
    rawNames: [{ id: 1, name: 'рукола' }],
  });
  const r = await buildPnl(pool, '2026-08');

  // Себестоимость — принятое в Закупе, а не выдачи склада и не оплата поставщику
  assert.strictEqual(r.cogs_source, 'purchase');
  assert.strictEqual(r.cogs_parts.raw, 35000000);
  assert.strictEqual(r.cogs_total, 35000000);                 // упаковки в CASH нет
  assert.strictEqual(r.stock_control.issued, 30000000);       // склад — только контроль
  // Оплата поставщикам ушла в справочный блок, а не в операционные расходы
  assert.strictEqual(r.excluded.materials_paid.total, 40000000);
  assert.strictEqual(r.opex.total, 8000000);
  assert.strictEqual(r.gross_profit, 65000000);
  assert.strictEqual(r.operating_profit, 57000000);
});

test('Закупа в месяце нет — сырьё по оплатам поставщикам, с предупреждением', async () => {
  const r = await buildPnl(makePool({ cash: CASH }), '2026-08');
  assert.strictEqual(r.cogs_source, 'paid');
  assert.strictEqual(r.cogs_total, 40000000);
  assert.ok(r.warnings.some((w) => wtext(w).includes('по оплатам поставщикам')));
});

test('упаковка — оплаченная за месяц, а не выданная со склада', async () => {
  const r = await buildPnl(makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1000000, exp: 0, cnt: 1 },
      { code: '11', name: 'Упаковка', group_name: '1. Сырьё и переменные затраты', flow_type: 'operating', inc: 0, exp: 80000, cnt: 1 }],
    received: [{ m: '2026-08', orders: 1, total: 300000 }],
  }), '2026-08');
  assert.strictEqual(r.cogs_parts.packaging, 80000);
  assert.strictEqual(r.cogs_total, 380000);
  assert.strictEqual(r.opex.total, 0);                        // упаковка не задвоилась в расходах
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
  // Склад на прибыль не влияет — подсказки о нём в P&L нет (дело в колокольчике у Закупа).
  assert.ok(!r.warnings.some((w) => wtext(w).includes('шпинат')), r.warnings.map(wtext).join(' | '));
});

test('нет ни приёмок, ни оплат за сырьё — прибыль не считается, а не показывается нулём', async () => {
  const pool = makePool({ cash: CASH.filter((x) => x.code !== '10'), used: [] });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs_total, null);
  assert.strictEqual(r.cogs_source, null);
  assert.strictEqual(r.gross_profit, null);
  assert.strictEqual(r.operating_profit, null);
  assert.strictEqual(r.gross_margin_pct, null);
  assert.ok(r.warnings.some((w) => wtext(w).includes('посчитать не из чего')));
});

test('склад не вёлся — на прибыль это больше не влияет', async () => {
  const pool = makePool({
    cash: CASH,
    used: [],                                        // выдач со склада нет
    received: [{ m: '2026-08', orders: 3, total: 4000000 }],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs_source, 'purchase');
  assert.strictEqual(r.gross_profit, 100000000 - 4000000);
  assert.strictEqual(r.stock_control.issued, 0);
});

test('неразнесённые операции попадают в предупреждения', async () => {
  const pool = makePool({
    cash: CASH, unclassified: { inc: 0, exp: 900000, cnt: 3 },
    used: [{ item_kind: 'raw', item_id: 1, qty: 1 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.excluded.unclassified.cnt, 3);
  assert.ok(r.warnings.some((w) => wtext(w).includes('без статьи')));
});

test('плановая себестоимость не считается без количества отгрузок', async () => {
  const pool = makePool({ cash: CASH, used: [{ item_kind: 'raw', item_id: 1, qty: 1 }], prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }] });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs.plan.total, null);
  assert.strictEqual(r.cogs.diff, null);
  assert.ok(r.warnings.some((w) => wtext(w).includes('отгрузок')));
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

test('отходы оцениваются по цене сырья, из которого получены', async () => {
  // Показатель из отчёта финансиста: «% отходов» от выручки.
  // Отход приходит с ценой ноль, но заплачено за него было — считаем по
  // цене родительской позиции (ref_raw_materials.waste_of_id).
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка от продаж', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1000000000, exp: 0, cnt: 100 }],
    used: [{ item_kind: 'raw', item_id: 1, qty: 10000 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 30000 }],
    rawNames: [{ id: 1, name: 'рукола' }],
    waste: [{ parent_id: 1, qty: 2000 }],
    received: [{ m: '2026-07', orders: 5, total: 360000000 }],
  });
  const r = await buildPnl(pool, '2026-07');

  assert.strictEqual(r.waste.qty, 2000);
  assert.strictEqual(r.waste.amount, 60000000);          // 2000 × 30 000
  assert.strictEqual(r.waste.no_price, 0);
  assert.strictEqual(Math.round(r.ratios.waste_pct * 10) / 10, 6);   // 60 млн / 1 млрд
  // Сырьевая нагрузка = принятое сырьё / выручка; отход уже внутри купленного веса
  assert.strictEqual(Math.round(r.ratios.raw_load_pct * 10) / 10, 36);
  assert.strictEqual(r.cogs_total, 360000000);            // отход НЕ прибавлен второй раз
});

test('отход без цены родителя не занижает показатель молча', async () => {
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1000000000, exp: 0, cnt: 1 }],
    used: [{ item_kind: 'raw', item_id: 1, qty: 1 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 30000 }],
    waste: [{ parent_id: 1, qty: 1000 }, { parent_id: 99, qty: 500 }],  // у 99 цены нет
  });
  const r = await buildPnl(pool, '2026-07');
  assert.strictEqual(r.waste.qty, 1500);          // количество учтено всё
  assert.strictEqual(r.waste.amount, 30000000);   // а в деньги вошла только оценённая часть
  assert.strictEqual(r.waste.priced, 1);
  assert.strictEqual(r.waste.no_price, 1);        // и об этом сказано
});

test('выручка в P&L — это реализация, а не поступление денег', async () => {
  // Случай Шоха: в августе по SalesDoctor отгружено на 1,75 млрд, а денег
  // пришло меньше — отсрочка до 30 дней. На поступлениях получался мнимый
  // убыток. В P&L выручка должна быть отгрузкой.
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка от продаж', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1200000000, exp: 0, cnt: 400 }],
    settings: [{ key: 'pnl_sales_2026-08', value: '1750000000' }],
    received: [{ m: '2026-08', orders: 40, total: 300000000 }],
  });
  const r = await buildPnl(pool, '2026-08');

  assert.strictEqual(r.revenue.source, 'shipped');
  assert.strictEqual(r.revenue.total, 1750000000);       // в прибыль идёт отгрузка
  assert.strictEqual(r.revenue.cash_in, 1200000000);     // поступления — справочно
  assert.strictEqual(r.revenue.receivable, 550000000);   // отгрузили, но не получили
  // Прибыль считается от реализации
  assert.strictEqual(r.gross_profit, 1750000000 - 300000000);
  // Показатели тоже от реализации, иначе проценты будут про другую величину
  assert.strictEqual(r.ratios.base, 1750000000);
});

test('реализация не подтянута — считаем по деньгам, но предупреждаем', async () => {
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1200000000, exp: 0, cnt: 400 }],
    used: [{ item_kind: 'raw', item_id: 1, qty: 1 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.revenue.source, 'cash');
  assert.strictEqual(r.revenue.total, 1200000000);
  assert.strictEqual(r.revenue.receivable, null);
  assert.ok(r.warnings.some((w) => wtext(w).includes('ПОСТУПЛЕНИЮ ДЕНЕГ') && w.includes('мнимый убыток')),
    'должно быть предупреждение о мнимом убытке: ' + r.warnings.map(wtext).join(' | '));
});

test('SD загружен, продаж за месяц ноль — выручка ноль, оплата старых долгов её не подменяет', async () => {
  // Аудит A10: раньше условие «реализация > 0» превращало поступления денег
  // (оплату прошлых отгрузок) в выручку месяца, в котором ничего не продали.
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1000000, exp: 0, cnt: 1 }],
    settings: [{ key: 'pnl_sales_2026-08', value: '0' }],
    used: [{ item_kind: 'raw', item_id: 1, qty: 1 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 1 }],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.revenue.source, 'shipped');
  assert.strictEqual(r.revenue.total, 0);
  assert.strictEqual(r.revenue.cash_in, 1000000);        // деньги видны справочно
  assert.strictEqual(r.revenue.receivable, -1000000);    // клиенты погасили долг
  assert.ok(!r.warnings.some((w) => wtext(w).includes('ПОСТУПЛЕНИЮ ДЕНЕГ')));
});

test('цена сырья — средняя за этот месяц; сентябрьская закупка не меняет август', async () => {
  // Аудит A12: в карточке цены брались со всех приходов до конца месяца, а на
  // графике — до конца всего показанного отрезка, и прошлое «плыло».
  // Теперь: цена месяца, а если прихода в месяце не было — последняя известная.
  const prices = [
    { m: '2026-07', item_kind: 'raw', item_id: 1, avg_price: 10000 },
    { m: '2026-08', item_kind: 'raw', item_id: 1, avg_price: 12000 },
    { m: '2026-09', item_kind: 'raw', item_id: 1, avg_price: 30000 },  // подорожало позже
    { m: '2026-08', item_kind: 'raw', item_id: 2, avg_price: 5000 },
  ];
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1, exp: 0, cnt: 1 }],
    used: [{ item_kind: 'raw', item_id: 1, qty: 10 }, { item_kind: 'raw', item_id: 2, qty: 2 }],
    prices,
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs.fact.total, 10 * 12000 + 2 * 5000);       // по августовским ценам
});

test('в месяце без приходов берётся последняя известная цена', async () => {
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1, exp: 0, cnt: 1 }],
    used: [{ item_kind: 'raw', item_id: 1, qty: 10 }],
    prices: [{ m: '2026-06', item_kind: 'raw', item_id: 1, avg_price: 9000 }],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs.fact.total, 90000);
});

test('план по ассортименту: дорогой товар с одной продажей не тянет средний вверх', async () => {
  // Аудит A11. Руккола 100 г (материалы 2 000) и микс (10 000). Продали 99 и 1.
  // «Средняя пачка» дала бы 100 × 6 000 = 600 000, по ассортименту — 208 000.
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1, exp: 0, cnt: 1 }],
    settings: [
      { key: 'pnl_units_2026-08', value: '100' },
      { key: 'pnl_sku_2026-08', value: JSON.stringify([['SD1', 99, 'Руккола 100 гр'], ['SD2', 1, 'Микс']]) },
    ],
    products: [
      { name: 'Руккола 100 гр', sd_product_id: 'SD1', net_weight_g: 100, raw_price_per_kg: 20000, pack_template_id: null, recipe_id: null, raw_cost: null },
      { name: 'Микс', sd_product_id: 'SD2', net_weight_g: null, raw_price_per_kg: null, raw_cost: 10000, pack_template_id: null, recipe_id: null },
    ],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs.plan.method, 'assortment');
  assert.strictEqual(r.cogs.plan.total, 99 * 2000 + 1 * 10000);
  assert.strictEqual(r.cogs.plan.unmatched_units, 0);
});

test('товар продан, но его нет в Калькуляции — не в сумме и видно отдельно', async () => {
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1, exp: 0, cnt: 1 }],
    settings: [
      { key: 'pnl_units_2026-08', value: '30' },
      { key: 'pnl_sku_2026-08', value: JSON.stringify([['SD1', 20, 'Руккола 100 гр'], ['SDX', 10, 'Новый салат']]) },
    ],
    products: [{ name: 'Руккола 100 гр', sd_product_id: 'SD1', net_weight_g: 100, raw_price_per_kg: 20000, pack_template_id: null, recipe_id: null, raw_cost: null }],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs.plan.total, 40000);
  assert.strictEqual(r.cogs.plan.unmatched_units, 10);
  assert.deepStrictEqual(r.cogs.plan.unmatched.map((x) => x.name), ['Новый салат']);
  // На прибыль не влияет — подсказки в P&L нет, дело висит в колокольчике у Калькуляции.
  assert.ok(!r.warnings.some((w) => wtext(w).includes('Новый салат')), r.warnings.map(wtext).join(' | '));
});

test('разбивки по товарам нет — считаем средней пачкой, но честно говорим об этом', async () => {
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1, exp: 0, cnt: 1 }],
    settings: [{ key: 'pnl_units_2026-08', value: '100' }],
    products: [
      { name: 'A', sd_product_id: 'SD1', net_weight_g: 100, raw_price_per_kg: 20000, pack_template_id: null, recipe_id: null, raw_cost: null },
      { name: 'B', sd_product_id: 'SD2', net_weight_g: null, raw_price_per_kg: null, raw_cost: 10000, pack_template_id: null, recipe_id: null },
    ],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs.plan.method, 'average');
  assert.strictEqual(r.cogs.plan.total, 600000);
  assert.ok(!r.warnings.some((w) => wtext(w).includes('средней пачкой')));   // план — справочно, без подсказки
});

test('снимок закрытого месяца сохраняется и читается', async () => {
  const { saveSnapshot, loadSnapshot, SNAP_KEY } = require('../src/cash-pnl');
  const store = new Map();
  const base = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 5000000, exp: 0, cnt: 3 }],
    used: [{ item_kind: 'raw', item_id: 1, qty: 10 }],
    prices: [{ m: '2026-08', item_kind: 'raw', item_id: 1, avg_price: 12000 }],
  });
  const pool = {
    query: async (sql, params) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/INSERT INTO settings/.test(q)) { store.set(params[0], params[1]); return { rows: [] }; }
      if (/SELECT value FROM settings WHERE key = \$1/.test(q)) {
        return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
      }
      return base.query(sql, params);
    },
  };
  const snap = await saveSnapshot(pool, '2026-08');
  assert.ok(snap.snapshot_at, 'у снимка есть отметка времени');
  assert.strictEqual(snap.cogs.fact.total, 120000);
  assert.ok(store.has(SNAP_KEY('2026-08')));

  const back = await loadSnapshot(pool, '2026-08');
  assert.strictEqual(back.cogs.fact.total, 120000);
  assert.strictEqual(await loadSnapshot(pool, '2026-07'), null);
});

// ---------------------------------------------------------------------------
// Связь товара Калькуляции с товаром SalesDoctor ищется сама
// ---------------------------------------------------------------------------
const { linkProducts, matchKey } = require('../src/cash-pnl');

test('название сравнивается «на слух»: руколла = руккола, но 500 ≠ 50', () => {
  assert.strictEqual(matchKey('Руколла 100 гр '), matchKey('Руккола 100гр'));
  assert.strictEqual(matchKey('Айсберг резанный квадрат 500 гр'), matchKey('Айсберг резаный квадрат 500гр'));
  assert.notStrictEqual(matchKey('Айсберг 500 гр'), matchKey('Айсберг 50 гр'));
  assert.notStrictEqual(matchKey('Айсберг 500 гр'), matchKey('Айсберг резанный квадрат 500 гр'));
});

test('связь по штрих-коду и по названию — без ручных кодов', () => {
  const products = [
    { cost: 2000, name: 'Руккола 100 гр', barcode: '4780000000011', sd_product_id: null, finished_good_id: null },
    { cost: 5000, name: 'Мята пучок свежая 60 гр уп.', barcode: '', sd_product_id: null, finished_good_id: null },
    { cost: 7000, name: 'Айсберг 500 гр', barcode: '', sd_product_id: null, finished_good_id: 42 },
  ];
  const sold = [['SD1', 99, 'Руколла 100 гр'], ['SD2', 10, 'Мята пучок свежая 60 гр уп'], ['SD3', 5, 'Айсберг 500 гр']];
  const goods = [
    { id: 7, name: 'Руккола 100 гр', barcode: '4780000000011', sd_sd_id: 'SD1' },
    { id: 42, name: 'Айсберг 500 гр', barcode: '', sd_sd_id: 'SD3' },
  ];
  const { costBySd, by } = linkProducts(products, sold, goods);
  assert.strictEqual(costBySd.get('SD1').cost, 2000);   // по штрих-коду
  assert.strictEqual(costBySd.get('SD2').cost, 5000);   // по названию из продаж
  assert.strictEqual(costBySd.get('SD3').cost, 7000);   // по привязке к готовой продукции
  assert.strictEqual(by.barcode, 1);
  assert.strictEqual(by.name, 1);
  assert.strictEqual(by.good, 1);
});

test('вписанный код SalesDoctor сильнее любых догадок', () => {
  const { costBySd, by } = linkProducts(
    [{ cost: 1000, name: 'Руккола 100 гр', barcode: '111', sd_product_id: 'SD9', finished_good_id: null }],
    [['SD1', 5, 'Руккола 100 гр']],
    [{ id: 1, name: 'Руккола 100 гр', barcode: '111', sd_sd_id: 'SD1' }]);
  assert.ok(costBySd.has('SD9'));
  assert.ok(!costBySd.has('SD1'));
  assert.strictEqual(by.code, 1);
});

test('два товара под одним названием — связь не угадываем', () => {
  const { costBySd } = linkProducts(
    [{ cost: 1000, name: 'Айсберг', barcode: '', sd_product_id: null, finished_good_id: null }],
    [['SD1', 5, 'Айсберг'], ['SD2', 5, 'айсберг ']],
    []);
  assert.strictEqual(costBySd.size, 0);
});

test('план сам находит товары по названию из продаж', async () => {
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1, exp: 0, cnt: 1 }],
    settings: [
      { key: 'pnl_units_2026-08', value: '100' },
      { key: 'pnl_sku_2026-08', value: JSON.stringify([['SD1', 99, 'Руколла 100 гр'], ['SD2', 1, 'Микс']]) },
    ],
    products: [
      { name: 'Руккола 100 гр', sd_product_id: null, barcode: '', finished_good_id: null, net_weight_g: 100, raw_price_per_kg: 20000, pack_template_id: null, recipe_id: null, raw_cost: null },
      { name: 'Микс', sd_product_id: null, barcode: '', finished_good_id: null, net_weight_g: null, raw_price_per_kg: null, raw_cost: 10000, pack_template_id: null, recipe_id: null },
    ],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs.plan.total, 99 * 2000 + 10000);
  assert.strictEqual(r.cogs.plan.unmatched_units, 0);
  assert.strictEqual(r.cogs.plan.linked_by.name, 2);
});

test('проверка отчёта: склад против оплат, план, зарплата и неразнесённое', () => {
  const { selfCheck } = require('../src/cash-pnl');
  const sc = selfCheck({
    revenue: 1_000_000_000,
    cogs: 200_000_000,
    opexTotal: 300_000_000,
    operating: 500_000_000,
    fact: { has_data: true, total: 200_000_000 },
    plan: { total: 400_000_000 },
    waste: { amount: 50_000_000 },
    writeoff: { amount: 10_000_000 },
    cash: {
      finance: { items: [] },
      materials_paid: { total: 500_000_000 },
      opex: { groups: [{ items: [{ code: '41', exp: 300_000_000 }] }] },   // аренда есть, ЗП нет
      unclassified: { exp: 5_000_000 },
    },
  });
  const by = Object.fromEntries(sc.items.map((x) => [x.key, x]));
  assert.ok(!by.taxes && !by.losses, 'налоги и отход теперь в самой формуле — в проверке их нет');
  assert.ok(!by.stock_vs_paid && !by.fact_vs_plan, 'склад на прибыль больше не влияет');
  assert.ok(by.no_salary);                                   // зарплаты в месяце нет
  assert.strictEqual(by.unclassified.amount, 5_000_000);
  assert.strictEqual(sc.total_gap, 5_000_000);
  assert.strictEqual(sc.profit_if_all, 500_000_000 - sc.total_gap);
});

test('налоги и комиссии банка — расход; налог на прибыль — после операционной; кредит — вне прибыли', async () => {
  // Решение Шоха: раньше вся группа «6. Финансы» выпадала из прибыли вместе с налогами.
  const pool = makePool({
    cash: [
      { code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1000000, exp: 0, cnt: 1 },
      { code: '65', name: 'Налоги от ЗП', group_name: '6. Финансы', flow_type: 'financing', inc: 0, exp: 30000, cnt: 1 },
      { code: '66', name: 'НДС', group_name: '6. Финансы', flow_type: 'financing', inc: 0, exp: 20000, cnt: 1 },
      { code: '62', name: '% банка', group_name: '6. Финансы', flow_type: 'financing', inc: 0, exp: 5000, cnt: 1 },
      { code: '67', name: 'Налог на прибыль', group_name: '6. Финансы', flow_type: 'financing', inc: 0, exp: 40000, cnt: 1 },
      { code: '61', name: 'Возврат кредитов', group_name: '6. Финансы', flow_type: 'financing', inc: 0, exp: 99000, cnt: 1 },
    ],
    received: [{ m: '2026-08', orders: 1, total: 100000 }],
  });
  const r = await buildPnl(pool, '2026-08');
  const taxes = r.opex.groups.find((g) => g.group_name === 'Налоги и комиссии банка');
  assert.strictEqual(taxes.amount, 55000);                       // 65 + 66 + 62
  assert.strictEqual(r.opex.total, 55000);                       // кредит в расходы не попал
  assert.strictEqual(r.operating_profit, 1000000 - 100000 - 55000);
  assert.strictEqual(r.profit_tax.total, 40000);
  assert.strictEqual(r.net_profit, r.operating_profit - 40000);
  assert.strictEqual(r.excluded.finance.out, 99000);             // кредит — справочно, вне прибыли
});

test('отход не прибавляется к себестоимости — он уже внутри купленного веса', async () => {
  const pool = makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1000000, exp: 0, cnt: 1 }],
    received: [{ m: '2026-08', orders: 1, total: 130000 }],
    used: [{ item_kind: 'raw', item_id: 1, qty: 10 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 10000 }],
    waste: [{ parent_id: 1, qty: 3 }],
  });
  const r = await buildPnl(pool, '2026-08');
  assert.strictEqual(r.cogs_total, 130000);
  assert.strictEqual(r.stock_control.waste, 30000);          // видно как контроль
  assert.strictEqual(r.gross_profit, 1000000 - 130000);
});

test('всё сходится — проверка молчит', () => {
  const { selfCheck } = require('../src/cash-pnl');
  const sc = selfCheck({
    revenue: 1_000_000, cogs: 500_000, opexTotal: 200_000, operating: 300_000,
    fact: { has_data: true, total: 500_000 }, plan: { total: 520_000 },
    waste: { amount: 0 }, writeoff: { amount: 0 },
    cash: {
      finance: { items: [] }, materials_paid: { total: 500_000 },
      opex: { groups: [{ items: [{ code: '20', exp: 200_000 }] }] }, unclassified: { exp: 0 },
    },
  });
  assert.deepStrictEqual(sc.items, []);
  assert.strictEqual(sc.total_gap, 0);
});

test('готовность месяца: один и тот же светофор для любого месяца', async () => {
  const { monthReadiness } = require('../src/cash-pnl');
  // Месяц без склада, без SD и без зарплаты — прибыли верить нельзя.
  const empty = await buildPnl(makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1000000, exp: 0, cnt: 1 },
      { code: '41', name: 'Аренда', group_name: '4. Административные расходы', flow_type: 'operating', inc: 0, exp: 100000, cnt: 1 }],
  }), '2026-08');
  const e = monthReadiness(empty);
  assert.strictEqual(e.verdict, 'bad');
  const lv = Object.fromEntries(e.checks.map((c) => [c.key, c.level]));
  assert.strictEqual(lv.sales, 'bad');
  assert.strictEqual(lv.salary, 'bad');
  assert.strictEqual(lv.stock, 'info');                      // склад — контроль, на итог не влияет

  // Всё заведено — зелёный.
  const full = await buildPnl(makePool({
    cash: [{ code: '200', name: 'Выручка', group_name: 'Доходы и поступления', flow_type: 'operating', inc: 1000000, exp: 0, cnt: 1 },
      { code: '20', name: 'ЗП производство', group_name: '2. Производственные затраты', flow_type: 'operating', inc: 0, exp: 100000, cnt: 1 },
      { code: '10', name: 'Сырьё', group_name: '1. Сырьё и переменные затраты', flow_type: 'operating', inc: 0, exp: 100000, cnt: 1 }],
    settings: [{ key: 'pnl_sales_2026-08', value: '900000' }, { key: 'pnl_units_2026-08', value: '10' },
      { key: 'pnl_sku_2026-08', value: JSON.stringify([['SD1', 10, 'Руккола']]) }],
    used: [{ item_kind: 'raw', item_id: 1, qty: 10 }],
    prices: [{ item_kind: 'raw', item_id: 1, avg_price: 10000 }],
    waste: [{ parent_id: 1, qty: 1 }],
    received: [{ m: '2026-08', orders: 2, total: 100000 }],
    products: [{ name: 'Руккола', sd_product_id: 'SD1', net_weight_g: 100, raw_price_per_kg: 20000, pack_template_id: null, recipe_id: null, raw_cost: null }],
  }), '2026-08');
  const f = monthReadiness(full);
  assert.strictEqual(f.verdict, 'ok', JSON.stringify(f.checks));
});

test('готовность: продажи SD сохранены нулём, а деньги пришли — красный', () => {
  const { monthReadiness } = require('../src/cash-pnl');
  const m = monthReadiness({
    period: '2026-09', revenue: { source: 'shipped', total: 0, cash_in: 1000000 },
    cogs_parts: { raw_source: 'purchase', raw: 1, raw_orders: 1 }, self_check: { items: [] },
    excluded: { unclassified: { cnt: 0 } }, stock_control: {}, cogs: { fact: { no_price: [] }, plan: {} },
  });
  assert.strictEqual(m.checks.find((c) => c.key === 'sales').level, 'bad');
  assert.strictEqual(m.verdict, 'bad');
});

test('готовность: текущий месяц помечен как незаконченный', () => {
  const { monthReadiness } = require('../src/cash-pnl');
  const now = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7);
  const base = { revenue: { source: 'shipped', total: 1, cash_in: 1 }, cogs_parts: { raw_source: 'purchase', raw: 1, raw_orders: 1 },
    self_check: { items: [] }, excluded: { unclassified: { cnt: 0 } }, stock_control: {}, cogs: { fact: { no_price: [] }, plan: {} } };
  assert.strictEqual(monthReadiness({ ...base, period: now }).checks.find((c) => c.key === 'open').level, 'warn');
  assert.strictEqual(monthReadiness({ ...base, period: '2020-01' }).checks.find((c) => c.key === 'open').level, 'ok');
});

test('«250гр» из SalesDoctor и «250г» из Калькуляции — один товар', () => {
  const { matchKey } = require('../src/cash-pnl');
  assert.strictEqual(matchKey('Кинза 250гр'), matchKey('Кинза 250г'));
  assert.strictEqual(matchKey('Розмарин 20 гр'), matchKey('Розмарин 20г'));
  assert.strictEqual(matchKey('Уксус яблочный 350 мл'), matchKey('Уксус яблочный 350мл'));
  assert.strictEqual(matchKey('Микрозелень Горох 1 шт'), matchKey('Микрозелень Горох 1шт'));
  // разный вес — разные товары, их путать нельзя
  assert.notStrictEqual(matchKey('Кинза 250г'), matchKey('Кинза 40г'));
  assert.notStrictEqual(matchKey('Айсберг 500г'), matchKey('Айсберг 300г'));
});
