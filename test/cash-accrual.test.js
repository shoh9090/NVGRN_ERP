// Прибыль по НАЧИСЛЕНИЮ (вариант А задания от 01.10.2026) и сверка с действующей
// методикой. Проверяем ровно те случаи, которые задание называет обязательными:
// зарплата августа, выплаченная в сентябре; упаковка, купленная впрок; отходы,
// уже сидящие в стоимости сырья; пробел вместо красивой цифры.
const test = require('node:test');
const assert = require('node:assert');

const { buildAccrual, compareMethods, accruedPayroll, packagingByNorms } = require('../src/cash-accrual');
const { linkProducts } = require('../src/cash-pnl');

// Ведомость, в которой начислений нет вовсе.
const ZERO_PAYROLL = { total: 0, total_posted: 0, total_draft: 0, rows: 0, posted: 0, draft_rows: 0, with_money: 0 };
// Ведомость проведена целиком и на всех активных сотрудников.
const FULL = (total, people = 2) => ({
  total, total_posted: total, total_draft: 0, rows: people, posted: people, draft_rows: 0, with_money: people,
});

// Поддельная база: отвечает на запросы расчёта по начислению.
function pool(o) {
  const opts = o || {};
  return {
    query: async (sql) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/FROM hr_payroll WHERE period/.test(q)) return { rows: [opts.payroll || ZERO_PAYROLL] };
      if (/FROM hr_employees WHERE status/.test(q)) return { rows: [opts.staff || { active: 2, fund: 240000000 }] };
      if (/FROM settings WHERE key/.test(q)) return { rows: opts.normsSnapshot ? [{ value: JSON.stringify(opts.normsSnapshot) }] : [] };
      if (/FROM purchase_orders po/.test(q)) return { rows: opts.orders || [] };
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
    payroll: FULL(250000000),
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
    payroll: FULL(250000000),
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
    payroll: FULL(1),
    products: [PRODUCTS[0]], templates: TEMPLATES,
  }), '2026-08', pnlOf(), SOLD, linkProducts);
  assert.strictEqual(r.packaging.matched_units, 1000);
  assert.strictEqual(r.packaging.unmatched_units, 500);
  assert.strictEqual(Math.round(r.packaging.coverage_pct), 67);
  assert.match(r.lines.find((l) => l.key === 'pack').note, /Покрыто 67%/);
});

test('приёмок с ценами нет — сырьё не подменяется оплатами поставщикам', async () => {
  const r = await buildAccrual(pool({
    payroll: FULL(250000000),
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
    payroll: FULL(1),
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf({ revenueSource: 'cash' }), SOLD, linkProducts);
  const rev = r.lines.find((l) => l.key === 'revenue');
  assert.strictEqual(rev.amount, null);
  assert.strictEqual(rev.basis, 'missing');
  assert.strictEqual(r.totals.net, null);
});

test('«остаток после материалов» не называется валовой прибылью', async () => {
  const r = await buildAccrual(pool({
    payroll: FULL(250000000),
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
    payroll: FULL(1),
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf(), SOLD, linkProducts);
  assert.ok(!r.lines.some((l) => /отход|списани/i.test(l.label)), 'отходы вычитаются второй раз');
  assert.match(r.assumption, /не хранится/);
});

test('у каждой строки есть сумма, источник и способ расчёта', async () => {
  const r = await buildAccrual(pool({
    payroll: FULL(250000000),
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf(), SOLD, linkProducts);
  for (const l of r.lines) {
    assert.ok(l.label, 'строка без названия');
    assert.ok(l.source, 'строка без источника: ' + l.label);
    assert.ok(['fact', 'estimate', 'missing'].includes(l.basis), 'непонятный способ расчёта: ' + l.label);
  }
  // Пока расходы берутся по дате оплаты, отчёт не может называться подтверждённым.
  assert.strictEqual(r.status.code, 'preliminary');
  assert.strictEqual(r.status.label, 'Предварительный результат');
  assert.ok(r.status.open_questions.length >= 3, 'открытые вопросы методики не перечислены');
});

test('закрытие месяца в Кассе НЕ подтверждает этот расчёт', async () => {
  const pnl = pnlOf();
  pnl.snapshot_at = '2026-09-01 10:00';          // действующий отчёт закрыт снимком
  const r = await buildAccrual(pool({ payroll: FULL(250000000), products: PRODUCTS, templates: TEMPLATES }),
    '2026-08', pnl, SOLD, linkProducts);
  // Раньше закрытый месяц автоматически получал «сверено и подтверждено».
  assert.notStrictEqual(r.status.code, 'confirmed');
  assert.strictEqual(r.status.label, 'Предварительный результат');
  assert.strictEqual(r.current_closed, true);     // но то, что старый отчёт закрыт, показываем
});

test('зарплата: проведённое и непроведённое видно отдельно', async () => {
  const r = await buildAccrual(pool({
    payroll: { total: 250000000, total_posted: 150000000, total_draft: 100000000, rows: 30, posted: 18, draft_rows: 12, with_money: 30 },
    staff: { active: 30, fund: 240000000 },
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf(), SOLD, linkProducts);
  const line = r.lines.find((l) => l.key === 'payroll');
  // Есть непроведённые строки — это оценка, а не факт.
  assert.strictEqual(line.basis, 'estimate');
  assert.match(line.note, /Проведено 18 строк/);
  assert.match(line.note, /не проведено 12/);
});

test('зарплата: полнота фонда проверяется отдельно от проведения', async () => {
  const r = await buildAccrual(pool({
    // Ведомость проведена аккуратно, но только на половину людей.
    payroll: { total: 120000000, total_posted: 120000000, total_draft: 0, rows: 15, posted: 15, draft_rows: 0, with_money: 15 },
    staff: { active: 30, fund: 240000000 },
    products: PRODUCTS, templates: TEMPLATES,
  }), '2026-08', pnlOf(), SOLD, linkProducts);
  const line = r.lines.find((l) => l.key === 'payroll');
  assert.strictEqual(line.basis, 'estimate', 'половина фонда не может быть «фактом»');
  assert.match(line.note, /15 из 30 активных сотрудников/);
  assert.strictEqual(r.payroll.complete, false);
  assert.strictEqual(r.payroll.staff_missing, 15);
});

test('итог проверки: исходная прибыль плюс изменения даёт новый результат', async () => {
  const { bridge } = require('../src/cash-accrual');
  const pnl = pnlOf({ net: 20000000, packPaid: 80000000 });
  const r = await buildAccrual(pool({ payroll: FULL(250000000), products: PRODUCTS, templates: TEMPLATES }),
    '2026-08', pnl, SOLD, linkProducts);
  const b = bridge(pnl, r);
  assert.strictEqual(b.from, 20000000);
  // Арифметика обязана сходиться: иначе где-то потерялось изменение.
  const sum = b.steps.reduce((t, x) => t + x.amount, 0);
  assert.strictEqual(b.to, b.from + sum);
  assert.strictEqual(b.checks_out, true);
  // Упаковка: было 80 млн оплат, стало 1,35 млн по нормам — прибыль выросла.
  assert.strictEqual(b.steps.find((x) => x.key === 'pack').amount, 80000000 - 1350000);
  // Зарплата: выплатили 200 млн, начислили 250 млн — прибыль упала.
  assert.strictEqual(b.steps.find((x) => x.key === 'payroll').amount, 200000000 - 250000000);
  // Неподтверждённое названо, но в цифру не заложено.
  assert.ok(b.unconfirmed.some((u) => u.key === 'vat'));
  assert.ok(b.unconfirmed.some((u) => u.key === 'retro'));
  assert.ok(b.unconfirmed.some((u) => u.key === 'period'));
});

test('разницу по упаковке не называем запасом упаковки', async () => {
  const { bridge } = require('../src/cash-accrual');
  const pnl = pnlOf();
  const r = await buildAccrual(pool({ payroll: FULL(250000000), products: PRODUCTS, templates: TEMPLATES }),
    '2026-08', pnl, SOLD, linkProducts);
  const step = bridge(pnl, r).steps.find((x) => x.key === 'pack');
  assert.ok(!/запас/i.test(step.why), 'разница подана как запас упаковки: ' + step.why);
  assert.match(step.why, /не определить/);
});

test('нормы упаковки можно зафиксировать — месяц перестаёт меняться', async () => {
  const snap = {
    at: '2026-09-01 12:00',
    items: [{ cost: 1500, name: 'Руккола 125г', barcode: '', sd_product_id: 'A', finished_good_id: null }],
    no_norm: [],
  };
  const r = await buildAccrual(pool({
    payroll: FULL(1), products: PRODUCTS, templates: TEMPLATES, normsSnapshot: snap,
  }), '2026-08', pnlOf(), SOLD, linkProducts);
  // Снимок сильнее текущих норм: 1000 штук по 1500, а не по 900.
  assert.strictEqual(r.packaging.norms_source, 'snapshot');
  assert.strictEqual(r.packaging.norms_at, '2026-09-01 12:00');
  assert.strictEqual(r.totals.pack, 1500000);
});

test('покрытие упаковки видно и в штуках, и в товарах, и с ценами расчёта', async () => {
  const r = await buildAccrual(pool({ payroll: FULL(1), products: [PRODUCTS[0]], templates: TEMPLATES }),
    '2026-08', pnlOf(), SOLD, linkProducts);
  const pk = r.packaging;
  assert.strictEqual(pk.sku_total, 2);
  assert.strictEqual(pk.sku_covered, 1);
  assert.strictEqual(Math.round(pk.sku_coverage_pct), 50);
  assert.strictEqual(Math.round(pk.coverage_pct), 67);
  // Цены расчёта: по каждому товару норма, штуки и сумма — чтобы перепроверить руками.
  assert.deepStrictEqual(pk.used, [{ sd_id: 'A', name: 'Руккола 125г', pack_cost: 900, units: 1000, amount: 900000 }]);
});

test('сверка: разница по каждой строке и объяснение, откуда она', async () => {
  const pnl = pnlOf();
  const r = await buildAccrual(pool({
    payroll: FULL(250000000),
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
  // Функция делает два запроса: начисления и состав активных сотрудников.
  // Нас интересует первый — в нём должен быть тот же список полей, что в Кадрах.
  const seen = [];
  await accruedPayroll({ query: async (q) => { seen.push(String(q)); return { rows: [{ total: 0, rows: 0, posted: 0, with_money: 0, active: 0, fund: 0 }] }; } }, '2026-08');
  const sql = seen.find((q) => /hr_payroll/.test(q)) || '';
  for (const f of ACCR_FIELDS) assert.ok(sql.includes(f), 'поле ' + f + ' не попало в сумму начислений');
  // «Фикса» — базовая ставка, в начислено она не входит (правило Кадров).
  assert.ok(!sql.includes('accr_salary'), 'базовая ставка не должна попадать в сумму');
});

test('сверка дат приёмок: заявка, обе даты, сумма и влияние на прибыль', async () => {
  const { rawDateAudit } = require('../src/cash-accrual');
  const r = await rawDateAudit(pool({ orders: [
    // Планировали 31 августа, приняли 1 сентября — сырьё ушло из августа.
    { id: 100, delivery_date: '2026-08-31', received_date: '2026-09-01', supplier: 'Дехкан', amount: 12000000, plan_month: '2026-08', fact_month: '2026-09' },
    // Планировали 31 июля, приняли 1 августа — сырьё пришло в август.
    { id: 101, delivery_date: '2026-07-31', received_date: '2026-08-01', supplier: 'Фермер', amount: 5000000, plan_month: '2026-07', fact_month: '2026-08' },
    // Даты в одном месяце — заявка не переезжала, в список не попадает.
    { id: 102, delivery_date: '2026-08-10', received_date: '2026-08-10', supplier: 'Дехкан', amount: 9000000, plan_month: '2026-08', fact_month: '2026-08' },
  ] }), '2026-08');

  assert.strictEqual(r.moved.length, 2);
  assert.strictEqual(r.left_amount, 12000000);
  assert.strictEqual(r.came_amount, 5000000);
  // Сырья в августе стало меньше на 7 млн — ровно настолько прибыль выросла.
  assert.strictEqual(r.profit_effect, 7000000);
  const out = r.moved.find((m) => m.order_id === 100);
  assert.strictEqual(out.direction, 'out');
  assert.strictEqual(out.plan_date, '2026-08-31');
  assert.strictEqual(out.fact_date, '2026-09-01');
  assert.strictEqual(out.profit_effect, 12000000);
  // И прямо сказано, что даты правит закупщик по документу, а не мы под результат.
  assert.match(r.note, /по документу, а не под результат/);
});

test('переездов нет — так и говорим, а не показываем пустую таблицу', async () => {
  const { rawDateAudit } = require('../src/cash-accrual');
  const r = await rawDateAudit(pool({ orders: [
    { id: 1, delivery_date: '2026-08-05', received_date: '2026-08-05', supplier: 'Дехкан', amount: 1000, plan_month: '2026-08', fact_month: '2026-08' },
  ] }), '2026-08');
  assert.strictEqual(r.moved.length, 0);
  assert.strictEqual(r.profit_effect, 0);
  assert.match(r.note, /сырьё этого месяца не изменил/);
});

test('продаж по товарам нет — упаковку по нормам считать не из чего', async () => {
  const r = await packagingByNorms(pool({ products: PRODUCTS, templates: TEMPLATES }), null, linkProducts);
  assert.strictEqual(r.total, null);
  assert.match(r.reason, /не подтянуты/);
});
