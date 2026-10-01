// jarvis-team.js — отчёт «кто отвечает, а кто нет»: один сбор данных на всех.
//
// Почему отдельный модуль: один и тот же отчёт нужен в чате с ботом, в файле
// Excel и на экране. Пока он собирался в трёх местах, цифры расходились.
//
// ГЛАВНОЕ ПРО ОПРЕДЕЛЕНИЯ (задание J01/J02 от 01.10.2026). Раньше «ответил»
// считалось по любому заполненному answered_at — но это поле закрывается
// пятью разными путями, и только два из них означают, что человек правда
// отреагировал:
//   • trello   — написал комментарий в карточке после обращения;
//   • telegram — ответил кнопкой из бота.
// Остальное — автоматическое снятие ожидания, и дисциплину человека оно не
// улучшает:
//   • moved — в карточке попросили уже другого, мяч ушёл;
//   • stale — прошло mention_stale_days, вопрос протух;
//   • done  — карточку закрыли или убрали в «не актуально»;
//   • ack   — сам комментарий был подтверждением («принято»), отвечать нечего.
// Старые записи, где способ не сохранён, честно показываем как «не удалось
// определить», а не записываем человеку в заслугу.
//
// Единица счёта — одно обращение к человеку (упоминание), а не карточка:
// в одной карточке его могут позвать трижды.

const db = require('./db');

const REAL = ['trello', 'telegram'];                 // реакция человека
const AUTO = ['moved', 'stale', 'done', 'ack'];      // ожидание снято системой

// Строка охвата для SQL: null — вся компания, Set — список отделов.
function scopeWhere(scope, p) {
  if (!scope || scope.depts === null) return '';
  const ids = [...scope.depts];
  if (!ids.length) return ' AND FALSE';
  p.push(ids);
  return ` AND e.department_id = ANY($${p.length}::int[])`;
}

// Отчёт за период. from/to — 'YYYY-MM-DD' включительно.
// scope = { depts: null | Set<int>, label }.
async function teamReport({ from, to, scope, department }) {
  const p = [from, to];
  let where = scopeWhere(scope, p);
  if (String(department || '').trim()) {
    // Фильтр только сужает разрешённое, выйти за охват им нельзя.
    p.push('%' + String(department).trim() + '%');
    where += ` AND d.name ILIKE $${p.length}`;
  }
  const real = REAL.map((x) => `'${x}'`).join(',');
  const auto = AUTO.map((x) => `'${x}'`).join(',');
  const rows = (await db.pool.query(
    `WITH per AS (
       SELECT employee_id,
              COUNT(*)::int AS got,
              COUNT(*) FILTER (WHERE answered_via IN (${real}))::int AS real_reply,
              COUNT(*) FILTER (WHERE answered_via IN (${auto}))::int AS auto_closed,
              COUNT(*) FILTER (WHERE answered_at IS NOT NULL AND answered_via IS NULL)::int AS unknown_closed,
              COUNT(*) FILTER (WHERE answered_at IS NULL)::int AS still_open
         FROM jarvis_mentions
        WHERE created_at >= $1::date AND created_at < ($2::date + 1)
        GROUP BY employee_id),
     old AS (
       SELECT employee_id, COUNT(*)::int AS n, MIN(created_at) AS oldest
         FROM jarvis_mentions
        WHERE answered_at IS NULL AND created_at < $1::date
        GROUP BY employee_id),
     vio AS (
       SELECT employee_id, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE NOT sent)::int AS not_delivered
         FROM jarvis_log
        WHERE kind LIKE 'violation%' AND created_at >= $1::date AND created_at < ($2::date + 1)
        GROUP BY employee_id)
     SELECT e.id, e.full_name, e.position, COALESCE(d.name, '— без отдела —') AS department,
            (e.trello_member_id IS NOT NULL) AS in_trello,
            (u.jv_chat_id IS NOT NULL) AS in_bot,
            COALESCE(per.got, 0) AS got, COALESCE(per.real_reply, 0) AS real_reply,
            COALESCE(per.auto_closed, 0) AS auto_closed, COALESCE(per.unknown_closed, 0) AS unknown_closed,
            COALESCE(per.still_open, 0) AS still_open,
            COALESCE(old.n, 0) AS old_open, old.oldest,
            COALESCE(vio.n, 0) AS violations, COALESCE(vio.not_delivered, 0) AS not_delivered
       FROM hr_employees e
       LEFT JOIN hr_departments d ON d.id = e.department_id
       LEFT JOIN users u ON u.id = e.erp_user_id
       LEFT JOIN per ON per.employee_id = e.id
       LEFT JOIN old ON old.employee_id = e.id
       LEFT JOIN vio ON vio.employee_id = e.id
      WHERE e.status = 'active'${where}
      ORDER BY (COALESCE(per.still_open, 0) + COALESCE(old.n, 0)) DESC, COALESCE(vio.n, 0) DESC, e.full_name`, p)).rows;

  const day = 86400000;
  const people = rows.map((r) => ({
    id: r.id,
    сотрудник: r.full_name,
    отдел: r.department,
    должность: r.position || '',
    в_trello: r.in_trello,
    в_боте: r.in_bot,
    обращений: r.got,
    ответил_сам: r.real_reply,
    снято_системой: r.auto_closed,
    не_определено: r.unknown_closed,
    открыто_из_них: r.still_open,
    старых_открытых: r.old_open,
    дней_самое_старое: r.oldest ? Math.floor((Date.now() - new Date(r.oldest).getTime()) / day) : null,
    нарушений: r.violations,
    не_дошло_до_него: r.not_delivered,
    // Нулевая нагрузка — не отличная работа. Говорим прямо, что мерить нечего.
    замечание: !r.in_trello ? 'в Trello не наблюдается — дисциплину по карточкам измерить нечем'
      : (!r.got && !r.old_open) ? 'обращений за период не было'
        : (!r.in_bot ? 'не открыл бота — напоминания до него не доходили' : null),
  }));

  const sum = (f) => people.reduce((a, x) => a + (x[f] || 0), 0);
  const totals = {
    людей: people.length,
    обращений: sum('обращений'),
    ответили_сами: sum('ответил_сам'),
    снято_системой: sum('снято_системой'),
    не_определено: sum('не_определено'),
    открыто_из_них: sum('открыто_из_них'),
    старых_открытых: sum('старых_открытых'),
    нарушений: sum('нарушений'),
  };
  const byDep = new Map();
  for (const x of people) {
    const d = byDep.get(x.отдел) || { отдел: x.отдел, людей: 0, обращений: 0, ответили_сами: 0,
      открыто: 0, старых_открытых: 0, нарушений: 0, не_в_боте: 0 };
    d.людей++; d.обращений += x.обращений; d.ответили_сами += x.ответил_сам;
    d.открыто += x.открыто_из_них; d.старых_открытых += x.старых_открытых;
    d.нарушений += x.нарушений; if (!x.в_боте) d.не_в_боте++;
    byDep.set(x.отдел, d);
  }
  return {
    период: { с: from, по: to },
    охват: (scope && scope.label) || 'вся компания',
    снимок_открытых_на: new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10),
    определения: {
      обращение: 'одно упоминание человека в карточке Trello',
      ответил_сам: 'написал комментарий в карточке или ответил кнопкой из бота',
      снято_системой: 'вопрос ушёл другому, протух по давности, карточку закрыли или это было подтверждение',
      не_определено: 'старые записи, где способ закрытия не сохранён',
      старых_открытых: 'пришли раньше периода и до сих пор без ответа',
    },
    итого: totals,
    по_отделам: [...byDep.values()].sort((a, b) => (b.открыто + b.старых_открытых) - (a.открыто + a.старых_открытых)),
    по_людям: people,
  };
}

module.exports = { teamReport, REAL, AUTO };
