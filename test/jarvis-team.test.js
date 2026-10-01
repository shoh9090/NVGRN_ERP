// Отчёт «кто отвечает, а кто нет»: главное здесь — определения.
// Задание J01/J02 (01.10.2026): «ответил» должно означать, что человек правда
// отреагировал, а не что система сама сняла ожидание.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { teamReport, REAL, AUTO } = require('../src/jarvis-team');

// Поддельная база: возвращаем одну строку сотрудника с заданными счётчиками,
// а заодно проверяем, какой SQL ушёл — именно в нём живут определения.
function withFakeDb(row, fn) {
  const real = db.pool.query;
  let sql = '';
  db.pool.query = async (q, p) => {
    sql = String(q);
    return { rows: [{ id: 1, full_name: 'Тестов Тест', position: 'Технолог', department: 'Производство',
      in_trello: true, in_bot: true, got: 0, real_reply: 0, auto_closed: 0, unknown_closed: 0,
      still_open: 0, old_open: 0, oldest: null, violations: 0, not_delivered: 0, ...row }] };
  };
  return fn(() => sql).finally(() => { db.pool.query = real; });
}

test('реальной реакцией считаются только ответ в карточке и ответ из бота', () => {
  assert.deepStrictEqual(REAL, ['trello', 'telegram']);
  // Передача другому, давность, закрытие карточки и подтверждение — не ответ.
  assert.deepStrictEqual(AUTO, ['moved', 'stale', 'done', 'ack']);
});

test('протухшее и переданное другому не попадают в «ответил сам»', async () => {
  await withFakeDb({ got: 5, real_reply: 1, auto_closed: 3, unknown_closed: 1 }, async (getSql) => {
    const r = await teamReport({ from: '2026-09-01', to: '2026-09-30', scope: { depts: null, label: 'вся компания' } });
    const p = r.по_людям[0];
    assert.strictEqual(p.ответил_сам, 1, 'ответ один, остальное сняла система');
    assert.strictEqual(p.снято_системой, 3);
    assert.strictEqual(p.не_определено, 1, 'старые записи без способа — отдельная категория');
    // Категории обязаны сходиться с числом обращений (требование J02).
    assert.strictEqual(p.ответил_сам + p.снято_системой + p.не_определено + p.открыто_из_них, p.обращений);
    const sql = getSql();
    assert.ok(/answered_via IN \('trello','telegram'\)/.test(sql), 'реакция считается по способу ответа');
    assert.ok(/answered_via IN \('moved','stale','done','ack'\)/.test(sql), 'автозакрытие считается отдельно');
  });
});

test('старые открытые обращения показаны отдельным остатком, а не в периоде', async () => {
  await withFakeDb({ got: 2, real_reply: 2, old_open: 7 }, async (getSql) => {
    const r = await teamReport({ from: '2026-09-01', to: '2026-09-30', scope: { depts: null } });
    const p = r.по_людям[0];
    assert.strictEqual(p.обращений, 2, 'старые в нагрузку периода не попадают');
    assert.strictEqual(p.старых_открытых, 7);
    assert.ok(r.снимок_открытых_на, 'у остатка должна быть дата снимка');
    assert.ok(/created_at < \$1::date/.test(getSql()), 'старые берутся до начала периода');
  });
});

test('человек без Trello не выглядит отличником, а помечается «измерить нечем»', async () => {
  await withFakeDb({ in_trello: false }, async () => {
    const r = await teamReport({ from: '2026-09-01', to: '2026-09-30', scope: { depts: null } });
    assert.match(r.по_людям[0].замечание, /измерить нечем/);
  });
});

test('не открыл бота — это сказано прямо, а не засчитано как дисциплина', async () => {
  await withFakeDb({ in_bot: false, got: 3 }, async () => {
    const r = await teamReport({ from: '2026-09-01', to: '2026-09-30', scope: { depts: null } });
    assert.match(r.по_людям[0].замечание, /не открыл бота/);
  });
});

test('охват по отделам сужает выборку, пустой список не отдаёт никого', async () => {
  await withFakeDb({}, async (getSql) => {
    await teamReport({ from: '2026-09-01', to: '2026-09-30', scope: { depts: new Set([3, 5]) } });
    assert.ok(/department_id = ANY/.test(getSql()), 'по отделам фильтруем в запросе');
  });
  await withFakeDb({}, async (getSql) => {
    await teamReport({ from: '2026-09-01', to: '2026-09-30', scope: { depts: new Set() } });
    assert.ok(/AND FALSE/.test(getSql()), 'нет разрешённых отделов — не показываем никого');
  });
});
