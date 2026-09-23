// Вердикт песочницы. На него смотрит продажник, решая, давать скидку или нет,
// поэтому ошибка здесь стоит денег: либо запретит нормальную сделку, либо
// разрешит убыточную.
const { test } = require('node:test');
const assert = require('node:assert');
const { sandboxVerdict } = require('../src/calculation');

// Минимальная строка сценария в том виде, в каком её отдаёт расчёт.
const line = (o = {}) => Object.assign({
  name: 'Микс салат', qty: 100, qty_new: 100,
  now: { incomplete: false }, below_min: false,
  was_total: 100000, now_total: 100000, delta_total: 0,
  need_qty: null, price_floor: null, max_discount_pct: null,
}, o);

test('объём не задан вообще — просим вписать', () => {
  const v = sandboxVerdict([line({ qty: 0, qty_new: 0 })], 0, 15);
  assert.strictEqual(v.level, 'warn');
  assert.match(v.text, /Впишите объём/);
});

test('новый товар: «берёт сейчас» ноль — это не ошибка', () => {
  // Для нового товара «сколько берёт сейчас» не существует. Раньше песочница
  // на этом останавливалась и не показывала ни маржу, ни вклад.
  const v = sandboxVerdict([line({ qty: 0, qty_new: 800 })], 4543200, 15);
  assert.strictEqual(v.level, 'good');
  assert.match(v.text, /Новый товар/);
  assert.doesNotMatch(v.text, /Впишите/);
});

test('новый товар в минусе — так и говорим', () => {
  const v = sandboxVerdict([line({ qty: 0, qty_new: 800 })], -536000, null);
  assert.strictEqual(v.level, 'bad');
  assert.match(v.text, /отнимает/);
});

test('маржа ниже минимальной перевешивает любой объём', () => {
  const v = sandboxVerdict([line({ qty: 0, qty_new: 800, below_min: true })], 4543200, 15);
  assert.strictEqual(v.level, 'bad');
  assert.match(v.text, /ниже минимальной/);
});

test('незаполненная себестоимость — вывод делать не из чего', () => {
  const v = sandboxVerdict([line({ now: { incomplete: true } })], 1000, 15);
  assert.strictEqual(v.level, 'warn');
  assert.match(v.text, /себестоимост/);
});

test('обычная сделка с ростом вклада — скидка окупается', () => {
  const v = sandboxVerdict([line({ qty: 100, qty_new: 150 })], 50000, 15);
  assert.strictEqual(v.level, 'good');
  assert.match(v.text, /окупается/);
});
