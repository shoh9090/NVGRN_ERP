// Тест единого расчёта долга поставщику (общий сервис Закупа и Кассы→Обязательства).
const { test } = require('node:test');
const assert = require('node:assert');
// Модуль требует ./db; подменяем require, чтобы не подключать реальную БД для чистой функции.
const Module = require('module');
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './db' && parent && parent.filename && parent.filename.includes('purchase-finance')) {
    return { pool: { query: async () => ({ rows: [] }) } };
  }
  return origLoad.apply(this, arguments);
};
const { enrichOrderFinance } = require('../src/purchase-finance');
Module._load = origLoad; void origResolve;

const iso = (daysFromToday) => { const d = new Date(); d.setDate(d.getDate() + daysFromToday); return d.toISOString().slice(0, 10); };

test('не принято, предоплата, не оплачено → Ожидает предоплаты', () => {
  const r = enrichOrderFinance({ status: 'draft', pay_condition: 'prepay', delivery_date: iso(3), fact_total: 0, paid: 0, total: 100 });
  assert.strictEqual(r.pay_status, 'Ожидает предоплаты');
  assert.strictEqual(r.remainder, 0);
});

test('не принято, по факту → Ожидает поставки', () => {
  const r = enrichOrderFinance({ status: 'ordered', pay_condition: 'on_fact', fact_total: 0, paid: 0 });
  assert.strictEqual(r.pay_status, 'Ожидает поставки');
});

test('принято, по факту, не оплачено, срок сегодня → Не оплачено (не просрочено)', () => {
  const r = enrichOrderFinance({ status: 'received', pay_condition: 'on_fact', received_at: iso(0), total: 1000, fact_total: 1000, paid: 0 });
  assert.strictEqual(r.pay_status, 'Не оплачено');
  assert.strictEqual(r.overdue, false);
  assert.strictEqual(r.remainder, 1000);
});

test('принято, отсрочка 7 дней, приёмка 30 дней назад, не оплачено → Просрочено', () => {
  const r = enrichOrderFinance({ status: 'received', pay_condition: 'defer', defer_days: 7, received_at: iso(-30), total: 5000, fact_total: 5000, paid: 0 });
  assert.strictEqual(r.overdue, true);
  assert.strictEqual(r.pay_status, 'Просрочено');
});

test('принято, оплачено полностью → Оплачено', () => {
  const r = enrichOrderFinance({ status: 'received', pay_condition: 'on_fact', received_at: iso(0), total: 2000, fact_total: 2000, paid: 2000 });
  assert.strictEqual(r.pay_status, 'Оплачено');
  assert.ok(r.remainder <= 0.01);
});

test('принято, оплачено частично → Частично оплачено, остаток верный', () => {
  const r = enrichOrderFinance({ status: 'received', pay_condition: 'on_fact', received_at: iso(0), total: 10000, fact_total: 10000, paid: 3000 });
  assert.strictEqual(r.pay_status, 'Частично оплачено');
  assert.strictEqual(r.remainder, 7000);
});

test('принято, оплачено больше факта → Переплата / аванс', () => {
  const r = enrichOrderFinance({ status: 'received', pay_condition: 'on_fact', received_at: iso(0), total: 1000, fact_total: 1000, paid: 1500 });
  assert.strictEqual(r.pay_status, 'Переплата / аванс');
});

test('план не создаёт долг: не принято → remainder 0', () => {
  const r = enrichOrderFinance({ status: 'ordered', pay_condition: 'on_fact', total: 25000, fact_total: 0, paid: 0 });
  assert.strictEqual(r.remainder, 0);
});
