// Урок 03.10.2026: пропущенное поле модель читает как «такой возможности нет».
// Логисту сказали, что разбивки «висит Отгружен» по водителям не бывает — а она
// есть, просто у всех был ноль, и поле в ответ не попадало.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { TOOLS } = require('../src/ai-tools');

const deliveries = TOOLS.find((t) => t.name === 'dostavki_po_voditelyam');
const byGoods = TOOLS.find((t) => t.name === 'prodazhi_po_tovaram');

function fake(map) {
  const real = db.pool.query;
  db.pool.query = async (q) => {
    const sql = String(q);
    for (const [re, rows] of map) if (re.test(sql)) return { rows };
    return { rows: [] };
  };
  return () => { db.pool.query = real; };
}

test('«висит Отгружен» показан у каждого водителя, даже когда ноль', async () => {
  const restore = fake([
    [/FROM sd_sales_days/, [{ first_day: '2026-09-01', last_day: '2026-10-02', days: 30, rows: 100, last_sync: '03.10 03:00' }]],
    [/FROM sd_deliveries d/, [
      { водитель: 'Назиров Суннат', доставок: 97, точек: 40, висит_отгружен: 0, сумма: '0' },
      { водитель: 'Джураев Икром', доставок: 58, точек: 25, висит_отгружен: 3, сумма: '0' },
    ]],
    [/EXTRACT\(ISODOW/, [{ dow: 1, n: 20, dney: 1 }]],
    [/FROM sd_deliveries$|FROM sd_deliveries\b.*COUNT/, [{ rows: 10 }]],
  ]);
  try {
    const r = await deliveries.run({ from: '2026-09-26', to: '2026-10-02' }, { user: { id: 1, isAdmin: true } });
    assert.strictEqual(r.водители.length, 2);
    // Главное: поле есть у обоих, в том числе у того, у кого ноль.
    assert.ok('висит_отгружен' in r.водители[0], 'поле обязано присутствовать даже при нуле');
    assert.strictEqual(r.водители[0].висит_отгружен, 0);
    assert.strictEqual(r.водители[1].висит_отгружен, 3);
    assert.strictEqual(r.всего_висит_отгружен, 3, 'есть и общий счётчик');
    assert.match(r.примечание, /Ноль значит, что отметили всё/);
  } finally { restore(); }
});

test('килограммы: неизвестный вес — null, а не пропущенное поле', async () => {
  const restore = fake([
    [/FROM sd_sales_days/, [{ first_day: '2026-09-01', last_day: '2026-10-02', days: 30, rows: 100, last_sync: '03.10 03:00' }]],
    [/FROM sd_deliveries/, [{ rows: 0 }]],
    [/COUNT\(\*\)::int AS позиций/, [{ позиций: 2, штук: '20', сумма: '1000' }]],
    [/GROUP BY product_name ORDER BY/, [
      { товар: 'Айсберг 500 гр', штук: '10', сумма: '500' },
      { товар: 'Микрозелень СТМ', штук: '10', сумма: '500' },
    ]],
    [/GROUP BY product_name/, [{ товар: 'Айсберг 500 гр', штук: '10' }, { товар: 'Микрозелень СТМ', штук: '10' }]],
  ]);
  try {
    const r = await byGoods.run({ from: '2026-09-01', to: '2026-09-30' }, { user: { id: 1, isAdmin: true } });
    const noWeight = r.товары.find((x) => x.товар === 'Микрозелень СТМ');
    assert.ok('кг' in noWeight, 'поле есть всегда');
    assert.strictEqual(noWeight.кг, null, 'вес неизвестен — честный null');
    assert.strictEqual(r.товары.find((x) => x.товар === 'Айсберг 500 гр').кг, 5);
  } finally { restore(); }
});
