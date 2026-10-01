// Контроль покрытия ФОТ. У товара стоит доля от общего труда, и если доли
// занижены, себестоимость выглядит лучше, а зарплату компания платит ту же.
// Этот контроль обязан показывать разницу, иначе её никто не заметит.
const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const { laborCoverage } = require('../src/calculation');

// Заглушка базы: отвечает на запросы контроля подготовленными строками.
function fakeDb(o) {
  const saved = db.pool.query;
  db.pool.query = async (sql) => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM hr_employees/.test(q)) return { rows: [{ fund: o.fund, people: 3 }] };
    if (/FROM calc_cost_items/.test(q)) return { rows: [] };
    if (/FROM calc_sheet_products/.test(q)) return { rows: o.products || [] };
    if (/key LIKE 'pnl_sku_%'/.test(q)) {
      return { rows: o.sold ? [{ key: 'pnl_sku_2026-09', value: JSON.stringify(o.sold) }] : [] };
    }
    if (/FROM ref_finished_goods/.test(q)) return { rows: o.goods || [] };
    if (/FROM settings/.test(q)) return { rows: [{ key: 'monthly_units', value: String(o.output) }] };
    return { rows: [] };
  };
  return () => { db.pool.query = saved; };
}

const product = (id, name, pct, sd) => ({
  id, name, barcode: '', sd_product_id: sd, finished_good_id: null, sheet: 'retail', labor_pct: pct,
});

test('все доли по 100% — фонд разложен полностью', async () => {
  const restore = fakeDb({
    fund: 100000000, output: 100000,
    products: [product(1, 'Руккола 125г', 100, 'A'), product(2, 'Кинза 125г', 100, 'B')],
    sold: [['A', 60000, 'Руккола 125г'], ['B', 40000, 'Кинза 125г']],
  });
  try {
    const c = await laborCoverage();
    assert.strictEqual(Math.round(c.avg_pct), 100);
    assert.strictEqual(Math.round(c.distributed), 100000000);
    assert.strictEqual(Math.round(c.rest), 0);
    assert.strictEqual(c.source, 'sales');
  } finally { restore(); }
});

test('всем поставили 50% — половина фонда повисает в воздухе', async () => {
  const restore = fakeDb({
    fund: 100000000, output: 100000,
    products: [product(1, 'Руккола 125г', 50, 'A'), product(2, 'Кинза 125г', 50, 'B')],
    sold: [['A', 60000, 'Руккола 125г'], ['B', 40000, 'Кинза 125г']],
  });
  try {
    const c = await laborCoverage();
    assert.strictEqual(Math.round(c.avg_pct), 50);
    assert.strictEqual(Math.round(c.rest), 50000000);
    assert.strictEqual(c.reduced, 2);
  } finally { restore(); }
});

test('доля считается по объёмам: редкий товар не весит как основной', async () => {
  const restore = fakeDb({
    fund: 100000000, output: 100000,
    // У микрозелени доля 10%, но продают её мало — на фонд это почти не влияет.
    products: [product(1, 'Руккола 125г', 100, 'A'), product(2, 'Микрозелень', 10, 'B')],
    sold: [['A', 99000, 'Руккола 125г'], ['B', 1000, 'Микрозелень']],
  });
  try {
    const c = await laborCoverage();
    assert.ok(c.avg_pct > 99 && c.avg_pct < 100, 'средняя доля ' + c.avg_pct);
    // Простое среднее дало бы 55% и «потеряло» 45 млн на ровном месте.
    assert.ok(c.rest < 1000000, 'не разложено ' + c.rest);
  } finally { restore(); }
});

test('товар продаётся, но его нет в Калькуляции — считаем обычным, и это видно', async () => {
  const restore = fakeDb({
    fund: 100000000, output: 100000,
    products: [product(1, 'Руккола 125г', 100, 'A')],
    sold: [['A', 50000, 'Руккола 125г'], ['X', 50000, 'Непосчитанный товар']],
  });
  try {
    const c = await laborCoverage();
    assert.strictEqual(c.unmatched, 50000);
    assert.strictEqual(Math.round(c.avg_pct), 100, 'непосчитанный товар не должен улучшать покрытие');
  } finally { restore(); }
});

test('продаж ещё нет — считаем простое среднее и честно это называем', async () => {
  const restore = fakeDb({
    fund: 100000000, output: 100000,
    products: [product(1, 'Руккола 125г', 100, 'A'), product(2, 'Микрозелень', 20, 'B')],
  });
  try {
    const c = await laborCoverage();
    assert.strictEqual(c.source, 'flat');
    assert.strictEqual(Math.round(c.avg_pct), 60);
  } finally { restore(); }
});

test('в Персонале нет окладов — контроль молчит, а не показывает ноль', async () => {
  const restore = fakeDb({ fund: 0, output: 100000, products: [product(1, 'Руккола', 100, 'A')] });
  try {
    const c = await laborCoverage();
    assert.strictEqual(c.distributed, null);
    assert.match(c.reason, /нет окладов/);
  } finally { restore(); }
});
