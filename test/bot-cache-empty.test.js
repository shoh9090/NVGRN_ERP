// Пустой ответ CRM не должен застревать в памяти бота (tg-bot/cache.js).
// Разбор 03.10.2026: пока токен бота не действовал, SalesDoctor отдавал пустые
// списки. Бот запомнил «заказов нет» на полный срок кэша и держал это часами:
// напоминания не уходили, претензию подать было нельзя, человек видел
// «отгрузок по этой точке нет».
const test = require('node:test');
const assert = require('node:assert');
const { createCache, isEmpty } = require('../tg-bot/cache');

test('пустой список забывается через минуту, а не держится весь срок', async () => {
  let t = 0;
  const cached = createCache(() => t);
  let calls = 0;
  const ask = (rows) => cached('orders', 600000, async () => { calls++; return rows; });

  assert.deepEqual(await ask([]), []);            // CRM отдала пустоту
  t += 30000;
  assert.deepEqual(await ask(['x']), []);         // полминуты ещё помним
  assert.equal(calls, 1);
  t += 40000;                                     // прошла минута
  assert.deepEqual(await ask(['x']), ['x']);      // спросили заново и ожили
  assert.equal(calls, 2);
});

test('нормальный ответ живёт полный срок — лишних запросов в CRM не делаем', async () => {
  let t = 0;
  const cached = createCache(() => t);
  let calls = 0;
  const ask = () => cached('orders', 600000, async () => { calls++; return ['a', 'b']; });

  await ask();
  t += 5 * 60000;
  await ask();
  assert.equal(calls, 1);                         // пять минут — из кэша
  t += 6 * 60000;
  await ask();
  assert.equal(calls, 2);                         // срок вышел — спросили снова
});

test('пустой каталог остатков тоже считается пустотой', () => {
  assert.equal(isEmpty({ catalog: [], map: {} }), true);
  assert.equal(isEmpty({ catalog: [{ SD_id: '1' }], map: {} }), false);
  assert.equal(isEmpty([]), true);
  assert.equal(isEmpty([1]), false);
});

test('сброс вручную работает: бот умеет забыть остатки перед заказом', async () => {
  let t = 0;
  const cached = createCache(() => t);
  let calls = 0;
  const ask = () => cached('stock', 300000, async () => { calls++; return ['товар']; });
  await ask();
  cached.forget('stock');
  await ask();
  assert.equal(calls, 2);
});
