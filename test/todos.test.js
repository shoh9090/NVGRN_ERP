// «Нужно внести» (src/todos.js): дела считаются на лету и пропадают сами.
const test = require('node:test');
const assert = require('node:assert');
const { unmatchedSold } = require('../src/todos');

function pool({ sku, products, goods }) {
  return {
    query: async (sql) => {
      if (/FROM settings/.test(sql)) return { rows: sku.map((v, i) => ({ key: 'pnl_sku_' + i, value: JSON.stringify(v) })) };
      if (/FROM calc_sheet_products/.test(sql)) return { rows: products };
      if (/FROM ref_finished_goods/.test(sql)) return { rows: goods || [] };
      return { rows: [] };
    },
  };
}

test('проданный товар без пары в Калькуляции попадает в дела; с парой — нет', async () => {
  const rows = await unmatchedSold(pool({
    sku: [[['SD1', 10, 'Руколла 100 гр'], ['SD2', 5, 'Арбуз нарезанный 500 g']], [['SD2', 7, 'Арбуз нарезанный 500 g']]],
    products: [{ id: 1, name: 'Руккола 100 гр', barcode: '', sd_product_id: null, finished_good_id: null }],
  }));
  assert.deepStrictEqual(rows, [{ sd_id: 'SD2', name: 'Арбуз нарезанный 500 g', units: 12 }]);   // два месяца сложились
});

test('продаж не подтянуто — дел нет', async () => {
  assert.deepStrictEqual(await unmatchedSold(pool({ sku: [], products: [] })), []);
});
