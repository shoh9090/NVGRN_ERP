// Три даты заявки и одно определение «месяца поставки». Из-за того, что раньше
// P&L и долг поставщику брали разные пары дат, в августе 2026 сырьё на 104 млн
// оказалось в разных месяцах у двух плиток. Эти проверки держат их вместе.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { RECEIPT_DATE, receiptDate, receiptDateSource } = require('../src/receipt-date');

test('порядок дат: подтверждённая → отметка приёмки → плановая', () => {
  assert.strictEqual(RECEIPT_DATE,
    'COALESCE(po.delivery_confirmed_date, po.received_at::date, po.delivery_date)');
  // Алиас таблицы может быть другим — выражение собирается, а не копируется руками.
  assert.match(receiptDate('o'), /o\.delivery_confirmed_date/);
});

test('видно, откуда взялась дата месяца', () => {
  assert.strictEqual(receiptDateSource({ delivery_confirmed_date: '2026-08-29' }).source, 'confirmed');
  assert.strictEqual(receiptDateSource({ received_at: '2026-09-01' }).source, 'marked');
  assert.strictEqual(receiptDateSource({ delivery_date: '2026-08-31' }).source, 'plan');
  assert.strictEqual(receiptDateSource({}).source, 'none');
  // Про отметку приёмки прямо сказано, что она может не совпасть с днём поставки.
  assert.match(receiptDateSource({ received_at: '2026-09-01' }).label, /может отличаться/);
});

test('ни один модуль не считает месяц приёмки по-своему', () => {
  const dir = path.join(__dirname, '..', 'src');
  const bad = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js') || f === 'receipt-date.js') continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.match(/COALESCE\(\s*\w+\.received_at[^)]*?\w+\.delivery_date\s*\)/g) || []) {
      if (!/delivery_confirmed_date/.test(m)) bad.push(f + ': ' + m.replace(/\s+/g, ' '));
    }
  }
  assert.deepStrictEqual(bad, [], 'своя пара дат приёмки — месяцы разойдутся');
});

test('подтверждённая дата поставки пишется с журналом и показывает оба месяца', async () => {
  const { confirmDeliveryDate } = require('../src/cash-accrual');
  const logged = [];
  const pool = {
    query: async (sql, params) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/SELECT po\.id, po\.number/.test(q)) {
        return { rows: [{ id: 160, number: 'PO-2026-160', delivery_date: '2026-08-30',
          received_date: '2026-09-01', confirmed: null, month_before: '2026-09', raw_amount: 22380000 }] };
      }
      if (/UPDATE purchase_orders/.test(q)) { logged.push({ sql: q, params }); return { rowCount: 1 }; }
      return { rows: [] };
    },
  };
  const journal = [];
  const r = await confirmDeliveryDate(pool, {
    orderId: 160, date: '2026-08-30', doc: 'накладная 418', who: 'Абдушукур',
    log: async (action, details) => { journal.push({ action, details }); },
  });

  assert.strictEqual(r.month_before, '2026-09');
  assert.strictEqual(r.month_after, '2026-08');
  assert.strictEqual(r.moved, true);
  // Человеку сразу говорим, что это делает с прибылью обоих месяцев.
  assert.match(r.effect, /из 2026-09 в 2026-08/);
  assert.match(r.effect, /прибыль 2026-09 вырастет/);
  // Запись в журнале: заявка, оба месяца, документ.
  assert.strictEqual(journal.length, 1);
  assert.strictEqual(journal[0].action, 'purchase_delivery_date');
  assert.match(journal[0].details, /PO-2026-160/);
  assert.match(journal[0].details, /накладная 418/);
  // В заявку пишется и кто подтвердил — иначе спросить будет некого.
  assert.ok(logged[0].params.includes('Абдушукур'));
});

test('дата в неверном виде не записывается', async () => {
  const { confirmDeliveryDate } = require('../src/cash-accrual');
  await assert.rejects(
    () => confirmDeliveryDate({ query: async () => ({ rows: [] }) }, { orderId: 1, date: '30.08.2026' }),
    /2026-08-29/);
});
