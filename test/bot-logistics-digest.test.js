// Сводка по доставке руководителю логистики (tg-bot/logistics-digest.js).
const test = require('node:test');
const assert = require('node:assert');
const { buildLogisticsDigest, eveningTime } = require('../tg-bot/logistics-digest');

const DAY = '2026-09-16';
const O = (status, date, exp) => ({ status, dateDocument: date, expeditor: exp ? { SD_id: exp } : null });

test('план, доставлено, висит «Отгружен», не отгружено, хвосты прошлых дней', () => {
  const orders = [
    O(3, DAY, 'd1'), O(4, DAY, 'd1'), O(3, DAY, 'd2'),          // доставлено 3
    O(2, DAY, 'd1'), O(2, DAY, 'd2'),                            // висит 2
    O(1, DAY, 'd2'),                                             // не отгружен 1
    O(2, '2026-09-14', 'd1'),                                    // хвост с прошлых дней
    O(2, '2026-09-17', 'd1'),                                    // завтрашний — не в счёт
  ];
  const t = buildLogisticsDigest({ day: DAY, orders, nameOf: { d1: 'Абидов', d2: 'Джураев' } });
  assert.match(t, /Доставка за 16 сентября — итог дня/);
  assert.match(t, /План на день: 6 заказов/);
  assert.match(t, /Доставлено: 3 из 6 \(50%\)/);
  assert.match(t, /Висит «Отгружен»: 2/);
  assert.match(t, /Ещё не отгружено: 1/);
  assert.match(t, /с прошлых дней: 1/);
  assert.match(t, /👤 Абидов — 2/);           // сегодняшний + хвост; завтрашний не считается
  assert.match(t, /👤 Джураев — 1/);
});

test('кто получил напоминание и не отметил, кто не подключён к боту', () => {
  const orders = [O(2, DAY, 'd1'), O(2, DAY, 'd2'), O(2, DAY, 'd3')];
  const t = buildLogisticsDigest({
    day: DAY, orders, nameOf: { d1: 'Абидов', d2: 'Джураев', d3: 'Назиров' },
    reminded: new Set(['d1']), connected: new Set(['d1', 'd2']),
  });
  assert.match(t, /Абидов — 1 · напоминание получил, не отметил/);
  assert.match(t, /Назиров — 1 · не подключён к боту — напоминание не дошло/);
  assert.match(t, /Джураев — 1$/m);            // подключён, но напоминание ещё не уходило — без пометки
});

test('утренний вариант — «итог на утро», «напоминание вчера получил»', () => {
  const t = buildLogisticsDigest({ day: DAY, orders: [O(2, DAY, 'd1')], nameOf: { d1: 'Абидов' }, reminded: new Set(['d1']), morning: true });
  assert.match(t, /итог на утро/);
  assert.match(t, /напоминание вчера получил, так и не отметил/);
});

test('всё закрыто — хвалим, не ругаем', () => {
  const t = buildLogisticsDigest({ day: DAY, orders: [O(3, DAY, 'd1'), O(4, DAY, 'd2')] });
  assert.match(t, /Доставлено: 2 из 2 \(100%\)/);
  assert.match(t, /Все отгруженные заказы отмечены «Доставлен»/);
});

test('заказов не было и ничего не висит — сводку не шлём', () => {
  assert.equal(buildLogisticsDigest({ day: DAY, orders: [O(2, '2026-09-18', 'd1')] }), null);
});

test('склонение: 1 заказ, 2 заказа, 11 заказов', () => {
  const n = (k) => Array.from({ length: k }, () => O(3, DAY, 'd1'));
  assert.match(buildLogisticsDigest({ day: DAY, orders: n(1) }), /План на день: 1 заказ$/m);
  assert.match(buildLogisticsDigest({ day: DAY, orders: n(2) }), /План на день: 2 заказа$/m);
  assert.match(buildLogisticsDigest({ day: DAY, orders: n(11) }), /План на день: 11 заказов$/m);
});

test('вечерняя сводка — через 30 минут после последнего напоминания', () => {
  assert.equal(eveningTime(['21:00', '22:00']), '22:30');
  assert.equal(eveningTime(['19:45']), '20:15');
  assert.equal(eveningTime([]), '21:30');
  assert.equal(eveningTime(['23:50']), '23:59');   // не переваливаем за полночь
});
