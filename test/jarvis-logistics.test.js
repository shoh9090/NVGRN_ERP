// Сводка по доставке логисту на стороне Джарвиса. Цифры в ней должны сходиться
// с напоминаниями водителям, иначе логист и водитель спорят о разном.
const test = require('node:test');
const assert = require('node:assert');

const lg = require('../src/jarvis-logistics');

const order = (o) => ({ status: 3, dateDocument: '2026-09-24', ...o });

test('итог дня: план, доставлено, висит «Отгружен», не отгружено', () => {
  const text = lg.buildDigest({
    day: '2026-09-24',
    orders: [
      order({ status: 3 }), order({ status: 4 }),
      order({ status: 2, expeditor: { SD_id: 'e1' } }),
      order({ status: 1 }),
    ],
    nameOf: { e1: 'Водитель Один' },
  });
  assert.match(text, /План на день: 4 заказа/);
  assert.match(text, /Доставлено: 2 из 4 \(50%\)/);
  assert.match(text, /Висит «Отгружен»: 1/);
  assert.match(text, /Ещё не отгружено: 1/);
  assert.match(text, /Водитель Один — 1/);
});

test('заказы прошлых дней в «Отгружен» считаются отдельно, а не в плане дня', () => {
  const text = lg.buildDigest({
    day: '2026-09-24',
    orders: [order({ status: 3 }), order({ status: 2, dateDocument: '2026-09-22', expeditor: { SD_id: 'e2' } })],
    nameOf: {},
  });
  assert.match(text, /План на день: 1 заказ/);
  assert.match(text, /с прошлых дней: 1/);
  assert.match(text, /e2 — 1/, 'водителя без имени показываем как есть, а не прячем');
});

test('всё закрыто — хвалим и не выдумываем строк про водителей', () => {
  const text = lg.buildDigest({ day: '2026-09-24', orders: [order({ status: 3 }), order({ status: 4 })] });
  assert.match(text, /Все отгруженные заказы отмечены/);
  assert.ok(!/Не отметили/.test(text));
});

test('нечего сказать — не пишем вовсе', () => {
  assert.strictEqual(lg.buildDigest({ day: '2026-09-24', orders: [] }), null);
});

test('дата доставки берётся как в напоминаниях водителям', () => {
  assert.strictEqual(lg.deliveryDate({ dateDocument: '2026-09-24 10:00' }), '2026-09-24');
  assert.strictEqual(lg.deliveryDate({ dateShipment: '2026-09-23' }), '2026-09-23', 'нет даты документа — берём отгрузку');
});

test('переключатель сводки выключен по умолчанию', () => {
  assert.strictEqual(require('../src/jarvis-rules').normalizeRules({}).logistics_digest, false);
});
