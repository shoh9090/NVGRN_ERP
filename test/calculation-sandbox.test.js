// Песочница «а что если». Проверяем не сами цифры себестоимости (их держит
// calculation-sku.test.js), а два обещания, которые песочница даёт на экране:
//   • доли считаются от ЦЕНЫ и в сумме дают ровно её — иначе структура врёт;
//   • вклад минус постоянные расходы = прибыль с листа — иначе песочница
//     разошлась бы с калькуляцией, и по ней нельзя было бы принимать решения.
const test = require('node:test');
const assert = require('node:assert');
const { sandboxLine, skuEconomics, priceForContribution, SKU_SHEET_COMPONENTS } = require('../src/calculation-engine');

const opts = { components: SKU_SHEET_COMPONENTS };
const round2 = (v) => Math.round(v * 100) / 100;

// Латук 100 г с дописанным ФОТ: те же цифры, что в тесте товарного листа.
const LATUK = {
  pack: 1007.25, raw: 1700, production: 5594.06, labor: 1000,
  defect_pct: 50, price: 21000, retro_pct: 21, vat_pct: 12, profit_tax_pct: 15,
};

test('доли складываются ровно в цену', () => {
  const r = sandboxLine(LATUK, opts);
  const sum = r.parts.reduce((s, p) => s + p.value, 0);
  assert.strictEqual(round2(sum), 21000);
  const pct = r.parts.reduce((s, p) => s + p.pct, 0);
  assert.strictEqual(Math.round(pct), 100);
});

test('вклад минус постоянные расходы = прибыль товарного листа', () => {
  const r = sandboxLine(LATUK, opts);
  const e = skuEconomics(LATUK, opts);
  assert.strictEqual(round2(r.contribution - r.fix_cost), round2(e.profit));
  // Переменные — сырьё и упаковка с браком плюс ретро и НДС.
  assert.strictEqual(round2(r.var_cost), round2((1007.25 + 1700) * 1.5));
  assert.strictEqual(round2(r.contribution), 10009.13);
});

test('скидка режет только вклад, постоянные расходы не двигаются', () => {
  const was = sandboxLine(LATUK, opts);
  const now = sandboxLine({ ...LATUK, price: 18900 }, opts);   // минус 10%
  assert.strictEqual(round2(now.fix_cost), round2(was.fix_cost));
  assert.ok(now.contribution < was.contribution);
  // Ретро и НДС считаются от цены, поэтому вклад падает не на всю сумму скидки.
  assert.strictEqual(round2(was.contribution - now.contribution), round2(2100 * (1 - 0.21 - 0.12)));
});

test('предельная цена возвращает ровно заданный вклад', () => {
  const r = sandboxLine(LATUK, opts);
  // Клиент обещает вдвое больший объём: значит вклад с единицы может упасть
  // вдвое, и общий останется прежним.
  const target = r.contribution / 2;
  const floor = priceForContribution(target, r.var_cost, LATUK.retro_pct, LATUK.vat_pct);
  const at = sandboxLine({ ...LATUK, price: floor }, opts);
  assert.strictEqual(round2(at.contribution), round2(target));
  assert.ok(floor < LATUK.price);
});

test('удержания съедают всю цену — предельной цены нет, а не бесконечность', () => {
  assert.strictEqual(priceForContribution(1000, 500, 60, 40), null);
});

test('незаполненный компонент не превращается в ноль', () => {
  const r = sandboxLine({ ...LATUK, raw: null }, opts);
  assert.strictEqual(r.incomplete, true);
  assert.strictEqual(r.contribution, null);
  assert.ok(r.missing_keys.includes('raw'));
});

test('нет цены — вклада нет, а не ноль', () => {
  const r = sandboxLine({ ...LATUK, price: null }, opts);
  assert.strictEqual(r.incomplete, true);
  assert.strictEqual(r.contribution, null);
});
