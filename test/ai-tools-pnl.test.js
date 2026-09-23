// Джарвис обязан называть те же итоговые строки P&L, что видит Шох в Кассе.
// Складская выдача — контроль, а не себестоимость в действующей формуле.
const test = require('node:test');
const assert = require('node:assert');
const { pnlAnswer } = require('../src/ai-tools');

test('ответ Джарвиса по прибыли совпадает с итоговыми строками P&L', () => {
  const report = {
    revenue: { total: 1_719_277_995 },
    cogs: { fact: { total: 374_140_544 } }, // контроль склада: брать нельзя
    cogs_total: 731_902_716,
    opex: { total: 779_946_785 },
    gross_profit: 987_375_279,
    operating_profit: 207_428_494,
    net_profit: 207_428_494,
    gross_margin_pct: 57.43,
  };

  const answer = pnlAnswer(report, '2026-08');
  assert.strictEqual(answer.себестоимость, 731_902_716);
  assert.strictEqual(answer.операционные_расходы, 779_946_785);
  assert.strictEqual(answer.выручка - answer.себестоимость, answer.валовая_прибыль);
  assert.strictEqual(answer.валовая_прибыль - answer.операционные_расходы, answer.операционная_прибыль);
  assert.strictEqual(answer.маржа_валовая_процент, 57);
});

test('при неполных данных Джарвис не превращает неизвестную прибыль в ноль', () => {
  const answer = pnlAnswer({
    revenue: { total: 100 }, cogs_total: null, opex: { total: 20 },
    gross_profit: null, operating_profit: null, net_profit: null, gross_margin_pct: null,
  }, '2026-09');

  assert.strictEqual(answer.себестоимость, null);
  assert.strictEqual(answer.чистая_прибыль, null);
  assert.match(answer.примечание, /не хватает данных/);
});
