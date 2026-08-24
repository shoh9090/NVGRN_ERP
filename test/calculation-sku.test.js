// Проверка экономики товарной позиции на настоящих цифрах Excel Шоха
// (лист «Рознич. тара», файл 00calc_NVGRN11.xlsx). Если формулу когда-нибудь
// поправят «на глаз», эти тесты покажут расхождение с рабочим файлом.
const test = require('node:test');
const assert = require('node:assert');
const { skuEconomics } = require('../src/calculation-engine');

const round2 = (v) => Math.round(v * 100) / 100;

test('Латук 100г — совпадает с Excel', () => {
  const r = skuEconomics({
    pack: 1007.25, raw: 1700, production: 5594.06,
    defect_pct: 50, price: 21000, retro_pct: 21, vat_pct: 12, profit_tax_pct: 15,
  });
  assert.strictEqual(round2(r.cost), 8301.31);
  assert.strictEqual(round2(r.cost_defect), 12451.97);   // в Excel 12 451,96 — разница только в округлении
  assert.strictEqual(Math.round(r.markup_pct), 69);
  assert.strictEqual(round2(r.retro), 4410);
  assert.strictEqual(round2(r.vat), 2520);
  assert.strictEqual(round2(r.profit), 1618.03);        // в Excel 1 618,04 — тот же тийин округления
  assert.strictEqual(round2(r.profit_tax), 242.71);
  assert.strictEqual(round2(r.net_profit), 1375.33);
  assert.strictEqual(Math.round(r.net_pct), 7);
  assert.strictEqual(r.missing, 2);                      // накладные и ФОТ ещё не заполнены
});

test('рукола 100г — половинные производственные затраты', () => {
  const r = skuEconomics({
    pack: 1007.25, raw: 3000, production: 2797.03,
    defect_pct: 50, price: 20800, retro_pct: 21, vat_pct: 12, profit_tax_pct: 15,
  });
  assert.strictEqual(round2(r.cost), 6804.28);
  assert.strictEqual(round2(r.cost_defect), 10206.42);
  assert.strictEqual(Math.round(r.markup_pct), 104);
  assert.strictEqual(round2(r.net_profit), 3170.14);    // в Excel 3 170,15
  assert.strictEqual(Math.round(r.net_pct), 15);
});

test('мангольд 100г — свой процент брака 20%', () => {
  const r = skuEconomics({
    pack: 1007.25, raw: 5000, production: 5594.06,
    defect_pct: 20, price: 22400, retro_pct: 21, vat_pct: 12, profit_tax_pct: 15,
  });
  assert.strictEqual(round2(r.cost), 11601.31);
  assert.strictEqual(round2(r.cost_defect), 13921.57);
  assert.strictEqual(Math.round(r.markup_pct), 61);
  assert.strictEqual(round2(r.profit), 1086.43);
  // В Excel 923,47: он считает по уже округлённым числам, движок — по точным.
  assert.strictEqual(round2(r.net_profit), 923.46);
  assert.strictEqual(Math.round(r.net_pct), 4);
});

test('незаполненный компонент не превращается в ноль', () => {
  const r = skuEconomics({ pack: 1000, defect_pct: 50, price: 5000 });
  assert.strictEqual(r.cost, 1000);
  assert.strictEqual(r.missing, 4);
  assert.strictEqual(r.components.raw, null);
});

test('нет ни одного компонента — себестоимости нет, а не ноль', () => {
  const r = skuEconomics({ price: 5000, defect_pct: 50 });
  assert.strictEqual(r.cost, null);
  assert.strictEqual(r.cost_defect, null);
  assert.strictEqual(r.markup_pct, null);
  assert.strictEqual(r.profit, null);
  assert.strictEqual(r.net_pct, null);
});

test('нет цены — прибыль не считается, но себестоимость видна', () => {
  const r = skuEconomics({ pack: 1007.25, raw: 1700, production: 5594.06, defect_pct: 50 });
  assert.strictEqual(round2(r.cost_defect), 12451.97);
  assert.strictEqual(r.price, null);
  assert.strictEqual(r.markup_pct, null);
  assert.strictEqual(r.profit, null);
});

test('убыток налогом не облагается', () => {
  const r = skuEconomics({
    pack: 1000, raw: 20000, production: 0, overhead: 0, labor: 0,
    defect_pct: 0, price: 15000, retro_pct: 0, vat_pct: 0, profit_tax_pct: 15,
  });
  assert.ok(r.profit < 0);
  assert.strictEqual(r.profit_tax, 0);
  assert.strictEqual(round2(r.net_profit), round2(r.profit));
});

test('входной объект не меняется', () => {
  const input = { pack: 1000, raw: 500, defect_pct: 50, price: 4000 };
  const copy = JSON.parse(JSON.stringify(input));
  skuEconomics(input);
  assert.deepStrictEqual(input, copy);
});
