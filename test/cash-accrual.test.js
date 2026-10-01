// Прибыль по НАЧИСЛЕНИЮ (вариант А задания от 01.10.2026) и сверка с действующей
// методикой. Проверяем ровно те случаи, которые задание называет обязательными:
// зарплата августа, выплаченная в сентябре; упаковка, купленная впрок; отходы,
// уже сидящие в стоимости сырья; пробел вместо красивой цифры.
const test = require('node:test');
const assert = require('node:assert');

const { buildAccrual, compareMethods, accruedPayroll, packagingByNorms } = require('../src/cash-accrual');
const { linkProducts } = require('../src/cash-pnl');

// Поддельная база: отвечает на запросы расчёта по начислению.
function pool(o) {
  const opts = o || {};
  return {
    query: async (sql) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/FROM hr_payroll WHERE period/.test(q)) return { rows: [opts.payroll || { total: 0, rows: 0, posted: 0, with_money: 0 }] };
      if (/FROM calc_sheet_products/.test(q)) return { rows: opts.products || [] };
      if (/FROM calc_pack_templates/.test(q)) return { rows: opts.templates || [] };
      if (/FROM ref_finished_goods/.test(q)) return { rows: opts.goods || [] };
      return { rows: [] };
    },
  };
}

// Действующий отчёт в том виде, в каком его отдаёт cash-pnl.
const pnlOf = (o = {}) => ({
  period: '2026-08',
  revenue: { total: o.revenue === undefined ? 1000000000 : o.revenue, source: o.revenueSource || 'shipped' },
  cogs_parts: {
    raw: o.raw === undefined ? 600000000 : o.raw,
    packaging: o.packPaid === undefined ? 80000000 : o.packPaid,
    raw_source: o.rawSource || 'purchase',
    raw_no_price: o.rawNoPrice || 0,
  },
  opex: { total: o.opex === undefined ? 300000000 : o.opex, groups: o.groups || [
    { group_name: '4. Административные', amount: 300000000, items: [
      { code: '40', name: 'Зарплата офиса', exp: 200000000 },
      { code: '41', name: 'Аренда', exp: 100000000 },
    ] },
  ] },
  interest: { total: o.interest || 0 },
  profit_tax: { total: o.tax || 0 },
  net_profit: o.net === undefined ? 20000000 : o.net,
});

const SOLD = [['A', 1000, 'Руккола 125г'], ['B', 500, 'Кинза 125г']];
const PRODUCTS = [
  { id: 1, name: 'Руккола 125г', barcode: '', sd_product_id: 'A', finished_good_id: null, pack_template_id: 7, pack_cost: null },
  { id: 2, name: 'Кинза 125г', barcode: '', sd_product_id: 'B', finished_good_id: null, pack_template_id: 7, pack_cost: null },
];
const TEMPLATES = [{ id: 7, total: 900, missing: 0 }];

test('зарплата берётся начислением за месяц, а не выплатой из Кассы', async () => {
  // В Кассе за август выплачено 200 млн (это зарплата июля), а начислено 250 млн.
  const r = await buildAccrual(pool({
    payroll: { total: 250000000, rows: 30, posted: 30, with_money: 30 },
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf(), SOLD, linkProducts);

  const payroll = r.lines.find((l) => l.key === 'payroll');
  assert.strictEqual(payroll.amount, -250000000);
  assert.strictEqual(payroll.basis, 'fact');
  // Выплата из Кассы ушла из «остальных расходов», иначе зарплата посчиталась бы дважды.
  assert.strictEqual(r.salary_paid, 200000000);
  assert.strictEqual(r.totals.other, 100000000);
});

test('ведомость за месяц не заведена — это пробел, а не «зарплаты не было»', async () => {
  const r = await buildAccrual(pool({ products: PRODUCTS, templates: TEMPLATES }), '2026-08', pnlOf(), SOLD, linkProducts);
  const payroll = r.lines.find((l) => l.key === 'payroll');
  assert.strictEqual(payroll.amount, null);
  assert.strictEqual(payroll.basis, 'missing');
  // И прибыль не считается: ноль вместо зарплаты дал бы красивую цифру из ничего.
  assert.strictEqual(r.totals.operating, null);
  assert.strictEqual(r.totals.net, null);
  assert.strictEqual(r.status.code, 'incomplete');
});

test('упаковка считается по нормам и проданным штукам, а не по оплате поставщику', async () => {
  const r = await buildAccrual(pool({
    payroll: { total: 250000000, rows: 30, posted: 30, with_money: 30 },
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf({ packPaid: 80000000 }), SOLD, linkProducts);

  const pack = r.lines.find((l) => l.key === 'pack');
  // 1500 проданных штук × 900 сум упаковки = 1,35 млн, а оплачено было 80 млн.
  assert.strictEqual(pack.amount, -1350000);
  assert.strictEqual(pack.basis, 'estimate');       // это норма, а не факт расхода
  assert.strictEqual(Math.round(r.packaging.coverage_pct), 100);
});

test('товар продавался, но нормы упаковки у него нет — видно, сколько штук не покрыто', async () => {
  const r = await buildAccrual(pool({
    payroll: { total: 1, rows: 1, posted: 1, with_money: 1 },
    products: [PRODUCTS[0]], templates: TEMPLATES,
  }), '2026-08', pnlOf(), SOLD, linkProducts);
  assert.strictEqual(r.packaging.matched_units, 1000);
  assert.strictEqual(r.packaging.unmatched_units, 500);
  assert.strictEqual(Math.round(r.packaging.coverage_pct), 67);
  assert.match(r.lines.find((l) => l.key === 'pack').note, /Покрыто 67%/);
});

test('приёмок с ценами нет — сырьё не подменяется оплатами поставщикам', async () => {
  const r = await buildAccrual(pool({
    payroll: { total: 250000000, rows: 30, posted: 30, with_money: 30 },
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf({ rawSource: 'paid', raw: 599000000 }), SOLD, linkProducts);
  const raw = r.lines.find((l) => l.key === 'raw');
  assert.strictEqual(raw.amount, null);
  assert.strictEqual(raw.basis, 'missing');
  assert.match(raw.note, /показываем пробел/);
  assert.strictEqual(r.totals.net, null);
});

test('реализация не подтянута — выручка не подменяется деньгами', async () => {
  const r = await buildAccrual(pool({
    payroll: { total: 1, rows: 1, posted: 1, with_money: 1 },
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf({ revenueSource: 'cash' }), SOLD, linkProducts);
  const rev = r.lines.find((l) => l.key === 'revenue');
  assert.strictEqual(rev.amount, null);
  assert.strictEqual(rev.basis, 'missing');
  assert.strictEqual(r.totals.net, null);
});

test('«остаток после материалов» не называется валовой прибылью', async () => {
  const r = await buildAccrual(pool({
    payroll: { total: 250000000, rows: 30, posted: 30, with_money: 30 },
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf(), SOLD, linkProducts);
  const line = r.lines.find((l) => l.key === 'after_materials');
  assert.strictEqual(line.label, 'Остаток после материалов');
  assert.match(line.note, /НЕ валовая прибыль/);
  // Выручка 1000 млн − сырьё 600 млн − упаковка 1,35 млн
  assert.strictEqual(line.amount, 1000000000 - 600000000 - 1350000);
});

test('отходы в расчёт отдельной строкой не входят — они внутри стоимости сырья', async () => {
  const r = await buildAccrual(pool({
    payroll: { total: 1, rows: 1, posted: 1, with_money: 1 },
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf(), SOLD, linkProducts);
  assert.ok(!r.lines.some((l) => /отход|списани/i.test(l.label)), 'отходы вычитаются второй раз');
  assert.match(r.assumption, /не хранится/);
});

test('у каждой строки есть сумма, источник и способ расчёта', async () => {
  const r = await buildAccrual(pool({
    payroll: { total: 250000000, rows: 30, posted: 30, with_money: 30 },
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf(), SOLD, linkProducts);
  for (const l of r.lines) {
    assert.ok(l.label, 'строка без названия');
    assert.ok(l.source, 'строка без источника: ' + l.label);
    assert.ok(['fact', 'estimate', 'missing'].includes(l.basis), 'непонятный способ расчёта: ' + l.label);
  }
  // Пока расходы берутся по дате оплаты, отчёт не может называться подтверждённым.
  assert.strictEqual(r.status.code, 'estimated');
});

test('сверка: разница по каждой строке и объяснение, откуда она', async () => {
  const pnl = pnlOf();
  const r = await buildAccrual(pool({
    payroll: { total: 250000000, rows: 30, posted: 30, with_money: 30 },
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnl, SOLD, linkProducts);
  const cmp = compareMethods(pnl, r);

  const pack = cmp.find((x) => x.key === 'pack');
  assert.strictEqual(pack.current, 80000000);
  assert.strictEqual(pack.accrual, 1350000);
  assert.strictEqual(pack.diff, 1350000 - 80000000);

  const pay = cmp.find((x) => x.key === 'payroll');
  assert.strictEqual(pay.current, 200000000);
  assert.strictEqual(pay.accrual, 250000000);
  assert.strictEqual(pay.diff, 50000000);

  for (const row of cmp) assert.ok(row.why, 'разница без объяснения: ' + row.label);
});

test('начисления считаются тем же списком полей, что и в Кадрах', async () => {
  const { ACCR_FIELDS } = require('../src/hr-fields');
  let sql = '';
  await accruedPayroll({ query: async (q) => { sql = String(q); return { rows: [{ total: 0, rows: 0, posted: 0, with_money: 0 }] }; } }, '2026-08');
  for (const f of ACCR_FIELDS) assert.ok(sql.includes(f), 'поле ' + f + ' не попало в сумму начислений');
  // «Фикса» — базовая ставка, в начислено она не входит (правило Кадров).
  assert.ok(!sql.includes('accr_salary'), 'базовая ставка не должна попадать в сумму');
});

test('продаж по товарам нет — упаковку по нормам считать не из чего', async () => {
  const r = await packagingByNorms(pool({ products: PRODUCTS, templates: TEMPLATES }), null, linkProducts);
  assert.strictEqual(r.total, null);
  assert.match(r.reason, /не подтянуты/);
});
