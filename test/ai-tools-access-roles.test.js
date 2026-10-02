// Доступ к инструментам даёт не только плитка, но и роль в боте.
// Случай логиста: Джарвис сам шлёт ему сводку по доставкам, а на вопрос
// словами отвечал «такого инструмента у меня нет».
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const tools = require('../src/ai-tools');

function fakeRoles({ tiles = [], botRole = null }) {
  const real = db.pool.query;
  db.pool.query = async (q, p) => {
    const sql = String(q);
    if (/FROM tiles/.test(sql)) return { rows: tiles.includes(p[1]) ? [{ ok: 1 }] : [] };
    if (/r\.bot_role = \$2/.test(sql)) return { rows: botRole === p[1] ? [{ ok: 1 }] : [] };
    return { rows: [] };
  };
  return () => { db.pool.query = real; };
}

test('логист получает доставки по водителям без Кассы и Бота HoReCa', async () => {
  const restore = fakeRoles({ tiles: [], botRole: 'logistics' });
  try {
    const list = await tools.toolsFor({ id: 10, isAdmin: false });
    assert.ok(list.some((t) => t.name === 'dostavki_po_voditelyam'),
      'человеку, которому система сама шлёт сводку доставок, вопрос о них закрывать незачем');
    // При этом деньги ему не открылись.
    assert.ok(!list.some((t) => t.name === 'ostatki_deneg'), 'роль логистики не открывает Кассу');
  } finally { restore(); }
});

test('без плиток и без роли инструмент не выдаётся, но числится закрытым', async () => {
  const restore = fakeRoles({ tiles: [], botRole: null });
  try {
    const list = await tools.toolsFor({ id: 11, isAdmin: false });
    assert.ok(!list.some((t) => t.name === 'dostavki_po_voditelyam'));
    const blocked = await tools.blockedFor({ id: 11, isAdmin: false });
    const names = blocked.map((b) => b.name);
    assert.ok(names.includes('dostavki_po_voditelyam'),
      'Джарвис должен знать, что функция есть, просто закрыта — иначе скажет «такого нет»');
    assert.ok(blocked.every((b) => b.description), 'у закрытого есть описание, чтобы объяснить человеку');
  } finally { restore(); }
});

test('админу открыто всё, закрытых нет', async () => {
  const restore = fakeRoles({ tiles: [], botRole: null });
  try {
    const blocked = await tools.blockedFor({ id: 1, isAdmin: true });
    assert.deepStrictEqual(blocked, []);
  } finally { restore(); }
});
