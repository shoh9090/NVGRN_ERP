// Разнесение списаний по группам. Именно оно решает, какие деньги станут
// потерями компании, а какие — счётом поставщику. Ошибка здесь тихо испортит
// прибыль в P&L: либо занизит её чужим браком, либо спрячет свои потери.
const { test } = require('node:test');
const assert = require('node:assert');
const { writeoffCost } = require('../src/cash-pnl');

// Поддельная база: отдаёт заранее заданные строки.
const poolOf = (rows) => ({ query: async () => ({ rows }) });
const prices = new Map([['raw#1', 10000], ['raw#2', 5000]]);

test('порча и усушка идут в потери компании', async () => {
  const r = await writeoffCost(poolOf([
    { grp: 'loss', reason: 'Порча / истёк срок', item_kind: 'raw', item_id: 1, qty: 3 },
    { grp: 'loss', reason: 'Усушка / естественная убыль', item_kind: 'raw', item_id: 2, qty: 4 },
  ]), '2026-09-01', '2026-09-30', prices);
  assert.strictEqual(r.amount, 30000 + 20000);
  assert.strictEqual(r.qty, 7);
  assert.strictEqual(r.by_reason['Порча / истёк срок'], 30000);
});

test('брак поставщика в потери НЕ входит', async () => {
  // Это не наш убыток, а повод предъявить поставщику. Иначе мы дважды
  // накажем себя: и товар потеряли, и прибыль занизили.
  const r = await writeoffCost(poolOf([
    { grp: 'supplier', reason: 'Брак поставщика', item_kind: 'raw', item_id: 1, qty: 2 },
  ]), '2026-09-01', '2026-09-30', prices);
  assert.strictEqual(r.supplier, 20000);
  assert.strictEqual(r.amount, 0);
});

test('дегустации — не потеря', async () => {
  const r = await writeoffCost(poolOf([
    { grp: 'internal', reason: 'Внутреннее расходование', item_kind: 'raw', item_id: 2, qty: 1 },
  ]), '2026-09-01', '2026-09-30', prices);
  assert.strictEqual(r.internal, 5000);
  assert.strictEqual(r.amount, 0);
});

test('позиция без цены прихода в сумму не попадает, но количество считается', async () => {
  // Молча оценивать сырьё нулём нельзя — но и прятать, что его списали, тоже.
  const r = await writeoffCost(poolOf([
    { grp: 'loss', reason: 'Недостача', item_kind: 'raw', item_id: 99, qty: 5 },
  ]), '2026-09-01', '2026-09-30', prices);
  assert.strictEqual(r.amount, 0);
  assert.strictEqual(r.qty, 5);
});

test('неизвестная группа считается потерями', async () => {
  // Статью могли завести руками без группы. Безопаснее отнести к своим
  // потерям, чем потерять расход совсем.
  const r = await writeoffCost(poolOf([
    { grp: null, reason: 'Что-то новое', item_kind: 'raw', item_id: 1, qty: 1 },
  ]), '2026-09-01', '2026-09-30', prices);
  assert.strictEqual(r.amount, 10000);
});

test('нет списаний — нет данных', async () => {
  const r = await writeoffCost(poolOf([]), '2026-09-01', '2026-09-30', prices);
  assert.strictEqual(r.has_data, false);
  assert.strictEqual(r.amount, 0);
});

test('таблицы ещё нет — отчёт не падает', async () => {
  const broken = { query: async () => { throw new Error('relation does not exist'); } };
  const r = await writeoffCost(broken, '2026-09-01', '2026-09-30', prices);
  assert.strictEqual(r.has_data, false);
  assert.strictEqual(r.amount, 0);
});
