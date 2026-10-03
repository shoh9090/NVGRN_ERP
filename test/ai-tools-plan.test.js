// План продаж в Джарвисе. Правило плитки: пусто ≠ ноль — ни в плане, ни в факте.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { TOOLS } = require('../src/ai-tools');

const tool = TOOLS.find((t) => t.name === 'plan_prodazh');

function fake({ plan = [], fact = [] }) {
  const real = db.pool.query;
  db.pool.query = async (q) => {
    const sql = String(q);
    if (/FROM sales_plan_rows/.test(sql)) return { rows: plan };
    if (/FROM sd_sales WHERE day BETWEEN/.test(sql)) return { rows: fact };
    if (/FROM sd_sales_days/.test(sql)) return { rows: [{ first_day: '2026-01-01', last_day: '2026-10-03', days: 200, rows: 10, last_sync: '03.10 03:00' }] };
    if (/FROM sd_deliveries/.test(sql)) return { rows: [{ rows: 0 }] };
    return { rows: [] };
  };
  return () => { db.pool.query = real; };
}

test('план на неделю: по направлениям и товарам, видно полноту заполнения', async () => {
  const restore = fake({ plan: [
    { id: 1, channel: 'horeca', 'товар': 'Айсберг 500 гр', 'план': '700', 'дней_заполнено': 7 },
    { id: 2, channel: 'retail', 'товар': 'Руккола 100 гр', 'план': '300', 'дней_заполнено': 3 },
  ] });
  try {
    const r = await tool.run({ from: '2026-10-07' }, { user: { id: 1, isAdmin: true } });
    assert.strictEqual(r.всего_штук_по_плану, 1000);
    assert.deepStrictEqual(r.по_направлениям, [{ направление: 'HoReCa', штук: 700 }, { направление: 'Розница', штук: 300 }]);
    assert.strictEqual(r.товары[1].дней_заполнено, 3, 'видно, что строка заполнена не на всю неделю');
    assert.match(r.неделя, /2026-10-05 — 2026-10-11/, 'неделя считается от понедельника');
  } finally { restore(); }
});

test('пустой план — «ещё не планировали», а не ноль продаж', async () => {
  const restore = fake({ plan: [] });
  try {
    const r = await tool.run({}, { user: { id: 1, isAdmin: true } });
    assert.match(r.итог, /ещё не планировали/);
    assert.ok(!r.всего_штук_по_плану, 'никаких нулевых итогов');
  } finally { restore(); }
});

test('план и факт: товар без продаж даёт «нет данных», а не ноль', async () => {
  const restore = fake({
    plan: [
      { id: 1, channel: 'horeca', 'товар': 'Айсберг 500 гр', 'план': '700', 'дней_заполнено': 7 },
      { id: 2, channel: 'horeca', 'товар': 'Новинка 250 гр', 'план': '100', 'дней_заполнено': 7 },
    ],
    fact: [{ 'товар': 'Айсберг 500 гр', 'штук': '560' }],
  });
  try {
    const r = await tool.run({ from: '2026-10-07', fact: true }, { user: { id: 1, isAdmin: true } });
    const ice = r.план_и_факт.find((x) => x.товар === 'Айсберг 500 гр');
    assert.strictEqual(ice.факт, 560);
    assert.strictEqual(ice.выполнение, '80%');
    const novelty = r.план_и_факт.find((x) => x.товар === 'Новинка 250 гр');
    assert.strictEqual(novelty.факт, null, 'нет в продажах — нет данных, а не ноль');
    assert.strictEqual(novelty.выполнение, null, 'выполнение без факта не считается');
    assert.match(r.про_факт, /не как ноль/);
  } finally { restore(); }
});
