// П.2 задания Шоха (03.10.2026): руководитель звена видит претензии СВОЕГО
// звена, не получая всю картину компании.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const tools = require('../src/ai-tools');

const pretenzii = tools.TOOLS.find((t) => t.name === 'pretenzii');

function fake({ links = [], tile = false, headOfSales = false, rows = [] }) {
  const real = db.pool.query;
  const seen = [];
  db.pool.query = async (q, p) => {
    const sql = String(q);
    seen.push({ sql, p });
    if (/FROM tiles/.test(sql)) return { rows: tile ? [{ ok: 1 }] : [] };
    if (/bot_role = \$2/.test(sql)) return { rows: headOfSales ? [{ ok: 1 }] : [] };
    if (/complaint_dicts d\s+JOIN user_roles/.test(sql)) return { rows: links };
    if (/FROM tgbot\.complaints c/.test(sql)) return { rows };
    return { rows: [] };
  };
  return { restore: () => { db.pool.query = real; }, seen };
}

test('начальник производства видит только своё звено', async () => {
  const f = fake({
    links: [{ code: 'production', label_ru: 'Производство · сушка' }, { code: 'packing', label_ru: 'Фасовка' }],
    rows: [{ complaint_type: 'vlazhnost', product_name: 'Айсберг 500 гр', point_name: 'Ctr', status: 'new', link_code: 'production', 'тип': 'Избыточная влажность' }],
  });
  try {
    const r = await pretenzii.run({ from: '2026-09-01', to: '2026-09-30' }, { user: { id: 7, isAdmin: false } });
    assert.match(r.охват, /ваше звено/);
    assert.match(r.охват, /Производство/);
    const call = f.seen.find((x) => /FROM tgbot\.complaints c/.test(x.sql));
    assert.match(call.sql, /link_code = ANY/, 'запрос ограничен его звеньями');
    assert.deepStrictEqual(call.p[2], ['production', 'packing']);
  } finally { f.restore(); }
});

test('инструмент выдаётся по звену, даже когда плитки «Претензии» нет', async () => {
  const f = fake({ links: [{ code: 'fulfillment', label_ru: 'Комплектация · логистика' }] });
  try {
    const list = await tools.toolsFor({ id: 8, isAdmin: false });
    assert.ok(list.some((t) => t.name === 'pretenzii'), 'тому, кому шлют карточки звена, вопрос о них закрывать незачем');
  } finally { f.restore(); }
});

test('у кого нет ни плитки, ни звена — претензии закрыты', async () => {
  const f = fake({ links: [] });
  try {
    const list = await tools.toolsFor({ id: 9, isAdmin: false });
    assert.ok(!list.some((t) => t.name === 'pretenzii'));
    const blocked = await tools.blockedFor({ id: 9, isAdmin: false });
    assert.ok(blocked.some((b) => b.name === 'pretenzii'), 'числится закрытым, а не несуществующим');
  } finally { f.restore(); }
});

test('кому открыто всё — видит все претензии, без сужения по звену', async () => {
  const f = fake({ rows: [{ complaint_type: 'x', product_name: 'y', point_name: 'z', status: 'new', link_code: 'field', 'тип': 'Живность' }] });
  try {
    const r = await pretenzii.run({}, { user: { id: 1, isAdmin: true } });
    assert.strictEqual(r.охват, 'все претензии');
    const call = f.seen.find((x) => /FROM tgbot\.complaints c/.test(x.sql));
    assert.ok(!/link_code = ANY/.test(call.sql), 'сужения быть не должно');
  } finally { f.restore(); }
});
