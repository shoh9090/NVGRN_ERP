// Тесты строк матрицы себестоимости (ТЗ 17.3).
// Матрица не считает сама — она раскладывает результат двигателя по строкам.
// Эти тесты ловят расхождение, если в двигателе переименуют или потеряют поле.
const { test } = require('node:test');
const assert = require('node:assert');
const engine = require('../src/calculation-engine');
const { ROWS } = require('../src/calculation-matrix');

const r2 = (v) => Math.round(v * 100) / 100;

// Контрольное изделие: латук 100 г с потерями 10%, пакет, ФОТ и накладные.
const result = engine.calculateProduct({
  today: '2026-08-09',
  recipe: {
    batch_output_qty: 1,
    items: [
      { item_kind: 'raw', name: 'Латук Афицион', qty_net: 0.1, unit: 'кг', loss_rate: 10, price: 20000, price_date: '2026-08-05' },
      { item_kind: 'raw', name: 'Руккола', qty_net: 0.01, unit: 'кг', loss_rate: 0, price: 35000, price_date: '2026-08-05' },
      { item_kind: 'packaging', name: 'Пакет', qty_net: 1, unit: 'шт', loss_rate: 0, price: 600, price_date: '2026-08-05' },
    ],
  },
  total_output: 10000,
  fot: { accrued: 8000000, inps: 100000, ndfl: 900000, social: 1000000 },
  monthly_expenses: { production: 2000000, admin: 1000000, commercial: 500000, logistics: 300000, finance: 200000 },
  commercial: { price: 12000, price_includes_vat: true, vat_rate: 12, retro_rate: 10, profit_tax_rate: 15, waste_reserve_rate: 5, price_round_step: 500 },
});
const product = { net_weight: 100 };

const rowByKey = (key) => ROWS.find((r) => r.key === key);
const value = (key) => rowByKey(key).get(result, product);

test('ни одна строка матрицы не падает и не даёт undefined', () => {
  for (const row of ROWS) {
    let v;
    assert.doesNotThrow(() => { v = row.get(result, product); }, 'строка «' + row.label + '» упала');
    assert.notStrictEqual(v, undefined, 'строка «' + row.label + '» вернула undefined — вероятно, поле переименовано');
  }
});

test('строки материалов берут значения из слоёв двигателя', () => {
  assert.strictEqual(r2(value('raw')), r2(result.layers.raw));
  assert.strictEqual(r2(value('packaging')), 600);
  assert.strictEqual(r2(value('fot')), 1000);
  assert.strictEqual(r2(value('full_cost')), r2(result.layers.full_cost));
});

test('коммерческие строки совпадают с расчётом двигателя', () => {
  assert.strictEqual(r2(value('price')), 12000);
  assert.strictEqual(r2(value('retro')), 1200);
  assert.strictEqual(r2(value('vat')), r2(result.commercial.vat));
  assert.strictEqual(r2(value('net_profit')), r2(result.commercial.net_profit));
  assert.strictEqual(r2(value('net_margin')), r2(result.commercial.net_margin));
  assert.strictEqual(value('recommended'), result.recommended.price);
});

test('«основное сырьё» — самая дорогая строка сырья, а не первая по порядку', () => {
  // Латук 2222,22 дороже рукколы 350 — значит основным должен быть латук.
  assert.strictEqual(value('main_raw'), 'Латук Афицион');
});

test('граммовка берётся из карточки изделия, а не из расчёта', () => {
  assert.strictEqual(value('net_weight'), 100);
  assert.strictEqual(rowByKey('net_weight').get(result, { net_weight: null }), null);
});

test('обязательные показатели ТЗ 17.3 присутствуют', () => {
  const need = ['raw', 'packaging', 'fot', 'admin', 'before_reserve', 'reserve', 'full_cost',
    'markup', 'price', 'retro', 'vat', 'profit_before_tax', 'profit_tax', 'net_profit',
    'net_margin', 'recommended'];
  for (const key of need) assert.ok(rowByKey(key), 'нет строки ' + key);
});

test('краткий вид короче подробного и содержит ключевые строки', () => {
  const short = ROWS.filter((r) => !r.detail).map((r) => r.key);
  assert.ok(short.length < ROWS.length, 'краткий вид должен быть короче');
  for (const key of ['raw', 'packaging', 'fot', 'full_cost', 'price', 'net_margin', 'recommended']) {
    assert.ok(short.includes(key), 'в кратком виде должна быть строка ' + key);
  }
});

test('отрицательные значения помечены признаком знака (для красного цвета)', () => {
  for (const key of ['profit_before_tax', 'net_profit', 'net_margin']) {
    assert.strictEqual(rowByKey(key).sign, true, 'строка ' + key + ' должна отмечаться по знаку');
  }
});

test('без цены компонента строка стоимости не превращается в ноль', () => {
  const noPrice = engine.calculateProduct({
    today: '2026-08-09',
    recipe: { batch_output_qty: 1, items: [{ item_kind: 'raw', name: 'Латук', qty_net: 0.1, unit: 'кг', loss_rate: 0, price: null }] },
    total_output: 1000,
    fot: { accrued: 0, inps: 0, ndfl: 0, social: 0 },
    monthly_expenses: {},
    commercial: { price: 10000, vat_rate: 12, profit_tax_rate: 15 },
  });
  assert.strictEqual(rowByKey('main_raw').get(noPrice, product), null);
  assert.strictEqual(noPrice.can_approve, false);
});
