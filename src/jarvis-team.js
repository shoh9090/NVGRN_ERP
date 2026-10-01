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
// 'stale' встречается только в старых записях: с 01.10.2026 давность гасит
// напоминания (muted_at), а обращение остаётся открытым. Старые помечаем
// отдельно и в заслугу человеку не ставим.

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
              COUNT(*) FILTER (WHERE answered_at IS NULL)::int AS still_open,
              COUNT(*) FILTER (WHERE answered_at IS NULL AND muted_at IS NOT NULL)::int AS muted,
              COUNT(*) FILTER (WHERE answered_via = 'stale')::int AS stale_old,
              COUNT(DISTINCT card_id)::int AS cards,
              COUNT(DISTINCT card_id) FILTER (WHERE answered_at IS NULL)::int AS cards_open,
              MIN(created_at) FILTER (WHERE answered_at IS NULL) AS oldest_open
         FROM jarvis_mentions
        WHERE created_at >= $1::date AND created_at < ($2::date + 1)
        GROUP BY employee_id),
     old AS (
       SELECT employee_id, COUNT(*)::int AS n, MIN(created_at) AS oldest,
              COUNT(DISTINCT card_id)::int AS cards
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
            COALESCE(per.still_open, 0) AS still_open, COALESCE(per.muted, 0) AS muted,
            COALESCE(per.stale_old, 0) AS stale_old,
            COALESCE(per.cards, 0) AS cards, COALESCE(per.cards_open, 0) AS cards_open,
            per.oldest_open,
            COALESCE(old.n, 0) AS old_open, old.oldest, COALESCE(old.cards, 0) AS old_cards,
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
    карточек_затронуто: (r.cards || 0),
    карточек_открыто: (r.cards_open || 0) + (r.old_cards || 0),
    напоминания_прекращены: (r.muted || 0),
    снято_по_давности_старые: (r.stale_old || 0),
    старых_открытых: r.old_open,
    // Возраст считаем от ПЕРВОГО неотвеченного обращения: повторное «???»
    // не обнуляет счётчик (задание J01, кейс Асилбека).
    дней_самое_старое: (() => {
      const dates = [r.oldest, r.oldest_open].filter(Boolean).map((x) => new Date(x).getTime());
      return dates.length ? Math.floor((Date.now() - Math.min(...dates)) / day) : null;
    })(),
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
    карточек_открыто: sum('карточек_открыто'),
    напоминания_прекращены: sum('напоминания_прекращены'),
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
      карточек_открыто: 'сколько РАЗНЫХ карточек ждут его реакции — четыре обращения могут быть в двух карточках',
      напоминания_прекращены: 'бот перестал напоминать по давности, но ответа так и нет — вопрос открыт',
      снято_по_давности_старые: 'старые записи до 01.10.2026, когда давность закрывала вопрос целиком; '
        + 'в заслугу человеку не ставятся, но полную историю по ним восстановить нельзя',
      дней_самое_старое: 'считается от первого неотвеченного обращения; повторное напоминание возраст не обнуляет',
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

// ---- Раскрытие по человеку: какие именно карточки и с какого числа ----
// Задание 01.10.2026: «Сколько открытых карточек у Асилбека и как долго он на
// них не реагирует?» должно давать список со ссылками, а не одно число.
// По каждой карточке видно, когда к нему обратились впервые, когда напомнили
// последний раз и была ли вообще его реакция.
async function personCards({ employeeId, scope }) {
  const emp = (await db.pool.query(
    `SELECT e.id, e.full_name, e.position, COALESCE(d.name, '— без отдела —') AS department,
            (e.trello_member_id IS NOT NULL) AS in_trello, e.department_id
       FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
      WHERE e.id = $1`, [employeeId])).rows[0];
  if (!emp) return { error: 'Такого сотрудника нет в Персонале' };
  if (scope && scope.depts && !scope.depts.has(emp.department_id)) {
    return { error: `${emp.full_name} не в вашей зоне ответственности` };
  }
  const real = REAL.map((x) => `'${x}'`).join(',');
  const rows = (await db.pool.query(
    `SELECT card_id, MAX(card_name) AS card_name, MAX(card_url) AS card_url, MAX(board_name) AS board_name,
            COUNT(*)::int AS обращений,
            COUNT(*) FILTER (WHERE answered_at IS NULL)::int AS без_ответа,
            MIN(created_at) FILTER (WHERE answered_at IS NULL) AS первое_без_ответа,
            MAX(created_at) FILTER (WHERE answered_at IS NULL) AS последнее_напоминание,
            MAX(answered_at) FILTER (WHERE answered_via IN (${real})) AS последняя_реакция,
            MAX(muted_at) AS напоминания_прекращены,
            MAX(author_name) AS кто_обращался
       FROM jarvis_mentions
      WHERE employee_id = $1 AND answered_at IS NULL
      GROUP BY card_id
      ORDER BY MIN(created_at)`, [employeeId])).rows;
  const day = 86400000;
  const ru = (d) => (d ? new Date(new Date(d).getTime() + 5 * 3600000).toISOString().slice(0, 10) : null);
  return {
    сотрудник: emp.full_name, должность: emp.position || '', отдел: emp.department,
    в_trello: emp.in_trello,
    открытых_карточек: rows.length,
    обращений_без_ответа: rows.reduce((a, r) => a + r.без_ответа, 0),
    карточки: rows.map((r) => ({
      карточка: r.card_name, ссылка: r.card_url, доска: r.board_name,
      обращений: r.обращений, без_ответа: r.без_ответа,
      кто_обращался: r.кто_обращался,
      первое_обращение_без_ответа: ru(r.первое_без_ответа),
      календарных_дней: r.первое_без_ответа
        ? Math.floor((Date.now() - new Date(r.первое_без_ответа).getTime()) / day) : null,
      последнее_напоминание: ru(r.последнее_напоминание),
      последняя_реакция: ru(r.последняя_реакция),
      напоминания_прекращены: r.напоминания_прекращены ? ru(r.напоминания_прекращены) : null,
      основание: 'его упомянули в карточке',
    })),
    чего_здесь_нет: 'Срок задачи и факт выполнения берутся в Trello — здесь только обращения к человеку. '
      + 'Карточка, где он просто участник и к нему не обращались, в список не попадает.',
  };
}

module.exports = { teamReport, personCards, REAL, AUTO };
