// Права Джарвиса обязаны совпадать с правами экрана. Доступ в Кассу могут дать
// ради «Транзакций», а P&L и кошельки закрыть — тогда и вопрос в боте не должен
// приносить прибыль месяца.
const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const { toolsFor, hasTile } = require('../src/ai-tools');

// Подменяем базу: у человека есть плитка /cash, но из вкладок разрешена одна.
function fakeDb(tabs) {
  const saved = db.pool.query;
  db.pool.query = async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM tiles t JOIN role_tiles/.test(q)) return { rows: params[1] === '/cash' ? [{ '?column?': 1 }] : [] };
    if (/FROM user_roles ur JOIN role_tiles rt/.test(q)) return { rows: [{ role_id: 7 }] };
    if (/FROM role_tile_tabs rtt/.test(q)) return { rows: tabs.map((code) => ({ role_id: 7, code })) };
    return { rows: [] };
  };
  return () => { db.pool.query = saved; };
}

test('вкладка P&L закрыта — Джарвис не отдаёт прибыль и кошельки', async () => {
  const restore = fakeDb(['tx']);                 // разрешены только «Транзакции»
  try {
    const names = (await toolsFor({ id: 5, isAdmin: false })).map((t) => t.name);
    assert.ok(!names.includes('pribyl_za_mesyats'), 'прибыль просочилась: ' + names.join(', '));
    assert.ok(!names.includes('ostatki_deneg'), 'остатки денег просочились');
    assert.ok(names.includes('moi_dela'), 'личные инструменты должны остаться у всех');
  } finally { restore(); }
});

test('вкладка P&L открыта — прибыль доступна', async () => {
  const restore = fakeDb(['tx', 'pnl']);
  try {
    const names = (await toolsFor({ id: 5, isAdmin: false })).map((t) => t.name);
    assert.ok(names.includes('pribyl_za_mesyats'));
    assert.ok(!names.includes('ostatki_deneg'), 'кошельки отдельной вкладкой — их не открывали');
  } finally { restore(); }
});

test('админу доступно всё, проверка вкладок его не трогает', async () => {
  const names = (await toolsFor({ id: 1, isAdmin: true })).map((t) => t.name);
  assert.ok(names.includes('pribyl_za_mesyats'));
  assert.ok(await hasTile({ id: 1, isAdmin: true }, '/cash', 'pnl'));
});

// Сводка по команде — не личный инструмент: её видит админ и Персонал, а
// руководитель — свой отдел. Проверяем, что отказ происходит ДО запроса в базу.
test('отчёт «кто не отвечает» чужому человеку без Персонала не отдаётся', async () => {
  const { TOOLS } = require('../src/ai-tools');
  const t = TOOLS.find((x) => x.name === 'kto_ne_otvechaet');
  assert.ok(t, 'инструмент пропал');
  const r = await t.run({}, { user: null });
  assert.match(String(r.итог || ''), /кто спрашивает/);
});

test('файл Excel по всей компании — только администратору и только в чат', async () => {
  const { TOOLS } = require('../src/ai-tools');
  const t = TOOLS.find((x) => x.name === 'otchet_excel');
  assert.ok(t, 'инструмент пропал');
  const notAdmin = await t.run({}, { user: { id: 1, isAdmin: false }, chatId: 5 });
  assert.match(String(notAdmin.итог || ''), /администратору/);
  const noChat = await t.run({}, { user: { id: 1, isAdmin: true } });
  assert.match(String(noChat.итог || ''), /в чат/);
});
