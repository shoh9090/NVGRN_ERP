// Праздничные: работа в красный день оплачивается вдвойне. Доплата идёт
// отдельно от факта — иначе в табеле «часов» показывало бы вдвое больше, чем
// человек отработал, и сверить его с собой было бы нечем.
const { test } = require('node:test');
const assert = require('node:assert');
const { computePay } = require('../src/hr');

test('почасовой: 10 часов в праздник оплачиваются как 20', () => {
  const без = computePay({ base_salary: 1000000, schedule_type: 'shift22', plan_hours: 100, fact_hours: 10 });
  const с = computePay({ base_salary: 1000000, schedule_type: 'shift22', plan_hours: 100, fact_hours: 10, holiday_hours: 10 });
  assert.strictEqual(без.base, 100000);
  assert.strictEqual(с.base, 200000, 'праздничные часы должны удвоить оплату дня');
  assert.strictEqual(с.holiday, 100000, 'доплата показывается отдельно');
});

test('почасовой: праздник и переработка складываются, а не заменяют друг друга', () => {
  const r = computePay({ base_salary: 1000000, schedule_type: 'shift22', plan_hours: 100,
    fact_hours: 10, overtime_hours: 2, holiday_hours: 10 });
  // 10 обычных + 2 переработки ×2 + 10 праздничной доплаты = 24 часа к оплате
  assert.strictEqual(r.base, 240000);
});

test('дневной график: праздничный день считается за два', () => {
  const r = computePay({ base_salary: 1000000, schedule_type: 'day5', plan_days: 20, fact_days: 10, holiday_days: 1 });
  assert.strictEqual(r.base, 550000, 'один праздничный день добавляет ещё один день оплаты');
});

test('без праздников формула прежняя', () => {
  const r = computePay({ base_salary: 1000000, schedule_type: 'day5', plan_days: 20, fact_days: 10 });
  assert.strictEqual(r.base, 500000);
  assert.strictEqual(r.holiday, 0);
});
