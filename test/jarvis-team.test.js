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
      still_open: 0, old_open: 0, oldest: null, violations: 0, not_delivered: 0,
      muted: 0, stale_old: 0, cards: 0, cards_open: 0, old_cards: 0, oldest_open: null, ...row }] };
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

// J03: плитка открывает экран, а кого на нём видно — решают разрешённые отделы.
test('Персонал с привязкой к отделам не получает чужие отделы', async () => {
  const { TOOLS } = require('../src/ai-tools');
  const t = TOOLS.find((x) => x.name === 'kto_ne_otvechaet');
  const real = db.pool.query;
  const seen = [];
  db.pool.query = async (q, p) => {
    const sql = String(q);
    seen.push(sql);
    if (/FROM tiles/.test(sql)) return { rows: [{ ok: 1 }] };              // плитка /hr есть
    if (/hr_user_departments/.test(sql)) return { rows: [{ department_id: 4 }] };  // но только отдел 4
    if (/FROM settings/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  try {
    const r = await t.run({ department: 'Производство' }, { user: { id: 7, isAdmin: false }, employee_id: 7 });
    assert.strictEqual(r.охват, 'ваши отделы', 'охват сужен до разрешённых');
    const main = seen.find((x) => /FROM hr_employees e/.test(x) && /per AS/.test(x));
    assert.ok(main && /department_id = ANY/.test(main), 'запрос ограничен разрешёнными отделами');
    assert.ok(/d\.name ILIKE/.test(main), 'фильтр по названию только сужает, а не открывает чужой отдел');
  } finally { db.pool.query = real; }
});

test('Персонал без привязки видит всю компанию — так работают Кадры', async () => {
  const { TOOLS } = require('../src/ai-tools');
  const t = TOOLS.find((x) => x.name === 'kto_ne_otvechaet');
  const real = db.pool.query;
  db.pool.query = async (q) => {
    const sql = String(q);
    if (/FROM tiles/.test(sql)) return { rows: [{ ok: 1 }] };
    if (/hr_user_departments/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  try {
    const r = await t.run({}, { user: { id: 8, isAdmin: false }, employee_id: 8 });
    assert.strictEqual(r.охват, 'вся компания');
  } finally { db.pool.query = real; }
});

// Кейс Асилбека (задание 01.10.2026): обращение от 15.09 без ответа не должно
// исчезать из статистики только потому, что ему исполнилось 14 дней.
test('давность гасит напоминания, но вопрос остаётся открытым', () => {
  const R = require('../src/jarvis-rules');
  const rules = R.normalizeRules({ work_from: 9, work_to: 20, work_days: [1, 2, 3, 4, 5, 6, 7] });
  const старое = { created_at: '2026-09-15T06:00:00Z', answered_at: null, muted_at: '2026-09-29T06:00:00Z' };
  // Бота это больше не заставляет писать человеку...
  assert.strictEqual(R.mentionStep(старое, Date.parse('2026-10-01T06:00:00Z'), rules), null);
  // ...но ответа нет, и это видно: answered_at пустой.
  assert.strictEqual(старое.answered_at, null, 'прекращение напоминаний не является ответом');
});

test('повторное напоминание не обнуляет возраст первого обращения', async () => {
  // Первое неотвеченное — 15.09, повторное — 23.09. Возраст считаем от 15.09.
  await withFakeDb({ got: 2, still_open: 2, oldest_open: '2026-09-15T06:00:00Z', cards: 1, cards_open: 1 }, async () => {
    const r = await teamReport({ from: '2026-09-01', to: '2026-09-30', scope: { depts: null } });
    const p = r.по_людям[0];
    const days = Math.floor((Date.now() - Date.parse('2026-09-15T06:00:00Z')) / 86400000);
    assert.strictEqual(p.дней_самое_старое, days, 'возраст от первого обращения, а не от последнего напоминания');
  });
});

test('четыре обращения в двух карточках — это две карточки, а не четыре', async () => {
  await withFakeDb({ got: 4, still_open: 4, cards: 2, cards_open: 2 }, async () => {
    const r = await teamReport({ from: '2026-09-01', to: '2026-09-30', scope: { depts: null } });
    const p = r.по_людям[0];
    assert.strictEqual(p.обращений, 4);
    assert.strictEqual(p.карточек_открыто, 2, 'уникальные карточки считаются отдельно');
  });
});

test('затихшие и старые «протухшие» показаны отдельно, а не как ответ', async () => {
  await withFakeDb({ got: 3, still_open: 2, muted: 2, stale_old: 1, auto_closed: 1 }, async () => {
    const r = await teamReport({ from: '2026-09-01', to: '2026-09-30', scope: { depts: null } });
    const p = r.по_людям[0];
    assert.strictEqual(p.ответил_сам, 0, 'ни один из этих случаев не является ответом');
    assert.strictEqual(p.напоминания_прекращены, 2);
    assert.strictEqual(p.снято_по_давности_старые, 1);
    assert.match(r.определения.снято_по_давности_старые, /в заслугу человеку не ставятся/);
  });
});
