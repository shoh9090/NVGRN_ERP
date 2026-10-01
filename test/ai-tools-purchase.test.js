// J09: сценарий закупщика. Главное требование — не выдумывать дефицит:
// килограммы сырья и пачки готовой продукции нельзя вычитать друг из друга.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { TOOLS } = require('../src/ai-tools');

const tool = TOOLS.find((t) => t.name === 'chto_s_tovarom');

function fake({ stock = [], sold = [], coming = [] }) {
  const real = db.pool.query;
  db.pool.query = async (q) => {
    const sql = String(q);
    if (/FROM stock_movements GROUP BY/.test(sql)) return { rows: stock };
    if (/FROM sd_sales WHERE day BETWEEN/.test(sql)) return { rows: sold };
    if (/FROM purchase_orders po/.test(sql)) return { rows: coming };
    if (/FROM sd_sales_days/.test(sql)) return { rows: [{ first_day: '2026-01-01', last_day: '2026-10-01', days: 300, rows: 10, last_sync: '01.10 03:00' }] };
    if (/FROM sd_deliveries/.test(sql)) return { rows: [{ rows: 0 }] };
    return { rows: [] };
  };
  return () => { db.pool.query = real; };
}

test('три блока в одном ответе: склад, продажи, ожидаемые поставки', async () => {
  const restore = fake({
    stock: [{ позиция: 'Айсберг', вид: 'raw', остаток: '120.5', единица: 'кг' }],
    sold: [{ товар: 'Айсберг 500 гр', штук: '1164' }],
    coming: [{ заявка: 'ЗК-12', поставщик: 'Ферма', ожидается: '03.10', позиция: 'Айсберг', количество: '300', единица: 'кг' }],
  });
  try {
    const r = await tool.run({ query: 'айсберг', days: 7 }, { user: { id: 1, isAdmin: true } });
    assert.strictEqual(r.склад.остатки[0].остаток, 120.5);
    assert.strictEqual(r.склад.остатки[0].вид, 'сырьё');
    assert.strictEqual(r.продажи.всего_штук, 1164);
    assert.strictEqual(r.продажи.всего_кг, 582, 'килограммы считаются из фасовки в названии');
    assert.strictEqual(r.ожидается.заявок, 1);
    assert.match(r.ожидается.строки[0].ожидается, /03\.10/);
    // Источник и свежесть каждого блока подписаны.
    assert.match(r.склад.источник, /реестр движений/);
    assert.match(r.продажи.источник, /01\.10 03:00/);
  } finally { restore(); }
});

test('дефицит не выдумывается: сырьё и готовая продукция не вычитаются', async () => {
  const restore = fake({
    stock: [{ позиция: 'Айсберг', вид: 'raw', остаток: '10', единица: 'кг' }],
    sold: [{ товар: 'Айсберг 500 гр', штук: '1000' }],
  });
  try {
    const r = await tool.run({ query: 'айсберг' }, { user: { id: 1, isAdmin: true } });
    assert.ok(!('дефицит' in r), 'никакого дефицита система не считает');
    assert.ok(!('надо_закупить' in r));
    assert.match(r.как_читать, /не вычитаю/);
    assert.match(r.как_читать, /Решение о закупе — за вами/);
  } finally { restore(); }
});

test('ничего не нашлось — честный ответ, а не пустые нули', async () => {
  const restore = fake({});
  try {
    const r = await tool.run({ query: 'ананас' }, { user: { id: 1, isAdmin: true } });
    assert.match(r.итог, /ничего не нашлось/);
    assert.match(r.итог, /название в системе другое/);
  } finally { restore(); }
});
