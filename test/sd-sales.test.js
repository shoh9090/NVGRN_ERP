// Выгрузка продаж из SalesDoctor: тихая потеря строк — худшее, что может быть
// с аналитикой. Проверяем два места, где она происходила.
const test = require('node:test');
const assert = require('node:assert');

const integrations = require('../src/integrations');
const sd = require('../src/sd-sales');

// Заказ-заглушка: один товар на одну сумму.
const order = (i) => ({
  dateDocument: '2026-09-10', status: 3,
  client: { SD_id: 'c' + i, clientName: 'Клиент ' + i },
  agent: { SD_id: 'a1', name: 'Агент' },
  orderProducts: [{ product: { SD_id: 'p1', name: 'Руккола' }, quantity: 1, summa: 1000, returned: 0 }],
});

test('SalesDoctor не прислал total — выгрузка не обрывается на первой странице', async () => {
  const saved = { cfg: integrations.getSdConfig, login: integrations.sdLogin, req: integrations.sdRequest };
  integrations.getSdConfig = async () => ({ url: 'x', login: 'l', password: 'p' });
  integrations.sdLogin = async () => ({ userId: 1, token: 't' });
  const pages = [];
  integrations.sdRequest = async (url, body) => {
    const page = body.params.page;
    pages.push(page);
    // Первая страница полная (500 заказов), pagination вообще нет — так SD и отвечает.
    if (page === 1) return { result: { order: Array.from({ length: 500 }, (_, i) => order(i)) } };
    return { result: { order: [order(1000), order(1001)] } };
  };
  try {
    const r = await sd.fetchRange('2026-09-01', '2026-09-30');
    assert.deepStrictEqual(pages, [1, 2], 'должны быть запрошены обе страницы');
    assert.strictEqual(r.rows.length, 502);
  } finally {
    integrations.getSdConfig = saved.cfg; integrations.sdLogin = saved.login; integrations.sdRequest = saved.req;
  }
});

test('дни вперёд не отмечаются как выгруженные — это не «продаж не было»', async () => {
  const db = require('../src/db');
  const marked = [];
  const savedConnect = db.pool.connect;
  db.pool.connect = async () => ({
    query: async (sql, params) => {
      if (/INSERT INTO sd_sales_days/.test(String(sql))) marked.push(params[0]);
      return { rows: [] };
    },
    release() {},
  });
  try {
    const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    await sd.saveRange(month + '-01', lastDay, { rows: [], days: new Map() });
    assert.ok(marked.length, 'хоть один день должен отметиться');
    assert.ok(marked.every((d) => d <= today), 'отмечены дни из будущего: ' + marked.filter((d) => d > today).join(', '));
  } finally { db.pool.connect = savedConnect; }
});

test('продажи считаются одними и теми же статусами везде', () => {
  assert.deepStrictEqual(sd.STATUSES, integrations.SALES_STATUSES);
  assert.ok(!sd.STATUSES.includes(1), 'новый заказ ещё не отгружен — это не продажа');
});
