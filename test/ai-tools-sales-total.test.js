// J04: короткий список в чате не должен занижать итог.
// Проверяем на подменённой базе: 80 позиций, в ответе топ-10, итог по всем 80.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { TOOLS } = require('../src/ai-tools');

const tool = TOOLS.find((t) => t.name === 'prodazhi_po_tovaram');

function fakeSales({ positions, topRows }) {
  const real = db.pool.query;
  db.pool.query = async (q) => {
    const sql = String(q);
    if (/FROM sd_sales_days/.test(sql)) {
      return { rows: [{ first_day: '2026-01-01', last_day: '2026-09-30', days: 270, rows: 1000, last_sync: '30.09 03:00' }] };
    }
    if (/FROM sd_deliveries/.test(sql)) return { rows: [{ rows: 0 }] };
    if (/FROM settings/.test(sql)) return { rows: [] };
    if (/COUNT\(\*\)::int AS позиций/.test(sql)) {
      return { rows: [{ позиций: positions.length, штук: positions.reduce((a, x) => a + x.штук, 0),
        сумма: positions.reduce((a, x) => a + x.сумма, 0) }] };
    }
    if (/GROUP BY product_name ORDER BY/.test(sql)) return { rows: topRows };
    if (/GROUP BY product_name/.test(sql)) return { rows: positions };
    return { rows: [] };
  };
  return () => { db.pool.query = real; };
}

test('в чате топ-10, но итог посчитан по всем 80 позициям', async () => {
  const positions = Array.from({ length: 80 }, (_, i) => ({ товар: `Товар ${i + 1} 500 гр`, штук: 10, сумма: 1000 }));
  const topRows = positions.slice(0, 10).map((x) => ({ ...x }));
  const restore = fakeSales({ positions, topRows });
  try {
    const r = await tool.run({ from: '2026-09-01', to: '2026-09-30' }, { user: { id: 1, isAdmin: true } });
    assert.strictEqual(r.товары.length, 10, 'в чате короткий список');
    assert.strictEqual(r.итого_за_период.позиций, 80);
    assert.strictEqual(r.итого_за_период.штук, 800, 'итог по всем, а не по показанным');
    assert.strictEqual(r.итого_за_период.кг, 400, 'килограммы тоже по всем 80');
    assert.match(r.полнота, /топ 10 из 80/);
  } finally { restore(); }
});

test('период без выгрузки не превращается в «продаж нет»', async () => {
  const restore = fakeSales({ positions: [], topRows: [] });
  try {
    const r = await tool.run({ from: '2026-10-01', to: '2026-10-31' }, { user: { id: 1, isAdmin: true } });
    assert.match(r.итог, /не покрыт выгрузкой/);
    assert.ok(!/продаж нет/i.test(r.итог) || /не могу/.test(r.итог));
  } finally { restore(); }
});
