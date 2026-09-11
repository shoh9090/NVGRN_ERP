// Разнесение оплат по заявкам. Оплата хранится ОДНИМ фактом, а раскладка по
// заявкам считается — от неё зависят статусы «оплачено / частично» и просрочка.
// Ошибка здесь либо покажет долг там, где его нет, либо спрячет настоящий.
const { test } = require('node:test');
const assert = require('node:assert');

// Чистая часть алгоритма: те же шаги, что в allocateUnassigned, но без базы.
// Порядок заявок — от самой ранней приёмки, как при оплате по FIFO.
function spread(orders, free) {
  const out = new Map();
  let rest = free;
  for (const o of orders) {
    if (rest <= 0.01) break;
    const need = o.total - o.own;
    if (need <= 0.01) continue;
    const put = Math.min(rest, need);
    out.set(o.id, put);
    rest -= put;
  }
  return { alloc: out, left: rest };
}

test('деньги закрывают заявки по порядку, начиная с самой ранней', () => {
  const r = spread([
    { id: 1, total: 1000, own: 0 },
    { id: 2, total: 2000, own: 0 },
    { id: 3, total: 500, own: 0 },
  ], 2500);
  assert.strictEqual(r.alloc.get(1), 1000);
  assert.strictEqual(r.alloc.get(2), 1500);   // закрыта частично
  assert.strictEqual(r.alloc.get(3), undefined);
  assert.strictEqual(r.left, 0);
});

test('уже оплаченную заявку деньги обходят', () => {
  const r = spread([
    { id: 1, total: 1000, own: 1000 },        // закрыта своей оплатой
    { id: 2, total: 800, own: 0 },
  ], 800);
  assert.strictEqual(r.alloc.get(1), undefined);
  assert.strictEqual(r.alloc.get(2), 800);
});

test('частично оплаченная получает только остаток', () => {
  const r = spread([{ id: 1, total: 1000, own: 400 }], 1000);
  assert.strictEqual(r.alloc.get(1), 600);
  assert.strictEqual(r.left, 400);            // лишнее остаётся авансом
});

test('лишние деньги не раскидываются сверх долга', () => {
  // Переплата не должна превращаться в «оплачено больше, чем поставлено»
  // по каждой заявке — остаток висит авансом у поставщика.
  const r = spread([{ id: 1, total: 500, own: 0 }], 3000);
  assert.strictEqual(r.alloc.get(1), 500);
  assert.strictEqual(r.left, 2500);
});

test('нет свободных денег — ничего не разносится', () => {
  const r = spread([{ id: 1, total: 500, own: 0 }], 0);
  assert.strictEqual(r.alloc.size, 0);
});

test('копейки не создают лишних строк разнесения', () => {
  // Порог 0.01 — иначе на каждой заявке появлялась бы запись на 0,001 сум.
  const r = spread([{ id: 1, total: 500, own: 499.999 }, { id: 2, total: 300, own: 0 }], 300);
  assert.strictEqual(r.alloc.get(1), undefined);
  assert.strictEqual(r.alloc.get(2), 300);
});
