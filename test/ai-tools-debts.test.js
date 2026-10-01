// Долги клиентов: главное — не выдать разницу за период за «полный долг».
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { TOOLS } = require('../src/ai-tools');

const tool = TOOLS.find((t) => t.name === 'dolgi_klientov');

function fake({ rows = [], payRows = 1 }) {
  const real = db.pool.query;
  db.pool.query = async (q) => {
    const sql = String(q);
    if (/FROM sd_sales_days/.test(sql)) return { rows: [{ first_day: '2026-01-01', last_day: '2026-10-01', days: 200, rows: 100, last_sync: '02.10 03:00' }] };
    if (/FROM sd_deliveries/.test(sql)) return { rows: [{ rows: 0 }] };
    if (/FROM sd_payments$|FROM sd_payments\b.*COUNT/.test(sql)) return { rows: [{ first_day: '2026-09-01', last_day: '2026-10-01', rows: payRows }] };
    if (/FULL OUTER JOIN/.test(sql)) return { rows };
    if (/FROM settings/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  return () => { db.pool.query = real; };
}

test('показывает, кто отгрузился и не заплатил', async () => {
  const restore = fake({ rows: [
    { sd: 'c1', клиент: 'Mari Wellness', отгружено: '5000000', оплачено: '1000000', разница: '4000000', последняя_оплата: '12.09' },
    { sd: 'c2', клиент: 'Resto', отгружено: '2000000', оплачено: '2000000', разница: '0', последняя_оплата: '28.09' },
    { sd: 'c3', клиент: 'Ctr', отгружено: '1000000', оплачено: '3000000', разница: '-2000000', последняя_оплата: '30.09' },
  ] });
  try {
    const r = await tool.run({ from: '2026-09-01', to: '2026-09-30' }, { user: { id: 1, isAdmin: true } });
    assert.strictEqual(r.клиентов_с_долгом, 1, 'в долгах только тот, у кого разница положительная');
    assert.strictEqual(r.кто_должен[0].клиент, 'Mari Wellness');
    assert.match(r.кто_должен[0].последняя_оплата, /12\.09/);
    // Честная подпись: это не полный долг.
    assert.match(r.что_это, /не полный долг/);
    assert.match(r.что_это, /отрицательной/, 'объяснено, почему бывает минус');
    assert.ok(r.данные.оплаты, 'видно, за какой период вообще есть оплаты');
  } finally { restore(); }
});

test('пока оплаты не выгружены — честный отказ, а не нулевые долги', async () => {
  const restore = fake({ rows: [], payRows: 0 });
  try {
    const r = await tool.run({}, { user: { id: 1, isAdmin: true } });
    assert.match(r.итог, /ещё не выгружены/);
    assert.ok(!r.кто_должен, 'никаких придуманных нулей');
  } finally { restore(); }
});
