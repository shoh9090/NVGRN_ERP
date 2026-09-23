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

// Доставки берутся из того же ответа SalesDoctor, что и продажи: кто повёз,
// сколько точек, какой статус. Без этого Джарвис не мог ответить на вопрос
// «сколько доставок было за неделю по водителям» (замечание Шоха 24.09.2026).
test('из заказов забираем и доставки: водитель, клиент, статус', async () => {
  const saved = { cfg: integrations.getSdConfig, login: integrations.sdLogin, req: integrations.sdRequest };
  integrations.getSdConfig = async () => ({ url: 'x', login: 'l', password: 'p' });
  integrations.sdLogin = async () => ({ userId: 1, token: 't' });
  integrations.sdRequest = async () => ({ result: { order: [
    { ...order(1), SD_id: 'o1', summa: 1000, status: 3, expeditor: { SD_id: 'e1', name: 'Водитель Один' } },
    { ...order(2), SD_id: 'o2', summa: 2000, status: 2, expeditor: { SD_id: 'e1', name: 'Водитель Один' } },
    { ...order(3), SD_id: 'o3', summa: 3000, status: 3 },   // заказ без водителя — тоже строка
  ] } });
  try {
    const r = await sd.fetchRange('2026-09-01', '2026-09-30');
    assert.strictEqual(r.deliveries.length, 3, 'одна строка на заказ');
    const one = r.deliveries.find((d) => d.order_sd === 'o1');
    assert.strictEqual(one.expeditor_sd, 'e1');
    assert.strictEqual(one.expeditor_name, 'Водитель Один');
    assert.strictEqual(one.status, 3);
    assert.strictEqual(r.deliveries.find((d) => d.order_sd === 'o3').expeditor_sd, '',
      'заказ без водителя не теряем — иначе доставок окажется меньше, чем было');
  } finally {
    integrations.getSdConfig = saved.cfg; integrations.sdLogin = saved.login; integrations.sdRequest = saved.req;
  }
});

test('вес единицы берём из названия товара, выдуманного не даём', () => {
  const { unitKg } = require('../src/ai-tools');
  assert.strictEqual(unitKg('Айсберг 500 гр'), 0.5);
  assert.strictEqual(unitKg('Айсберг 100гр'), 0.1);
  assert.strictEqual(unitKg('Салат 1 кг'), 1);
  assert.strictEqual(unitKg('Руккола 250 г'), 0.25);
  assert.strictEqual(unitKg('Микрозелень СТМ'), null, 'веса в названии нет — считать нечего');
  assert.strictEqual(unitKg('Уксус 350 мл'), null, 'миллилитры это не килограммы');
});
