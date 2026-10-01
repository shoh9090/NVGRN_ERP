// jarvis-report.js — отчёт «кто отвечает, а кто нет» одной книгой Excel.
//
// Один и тот же файл собирается для кнопки в плитке «Джарвис» и для просьбы
// «пришли отчёт в Excel» в чате с ботом. Раньше это жило внутри роутера, и
// бот такого не умел: приходилось объяснять человеку, что отчёта нет.
//
// Листы: нарушения за период (по отделам, по людям, построчно), карточки
// Trello без ответа, претензии без реакции и незакрытые, сводка по звеньям.
// Открытые позиции берутся целиком, без периода: важно не когда это
// случилось, а что ответа нет до сих пор.

const db = require('./db');
const XLSX = require('xlsx');

const VIOLATIONS = {
  violation_mention: 'Не ответил на упоминание',
  violation_overdue: 'Просрочил карточку',
  violation_no_due: 'Карточка без срока',
};

// scope = { depts: null | Set<int> } — та же область, что в чате (задание J03):
// кому нельзя видеть чужой отдел, тот не получит его и файлом. Претензии и
// доставка — данные компании целиком, поэтому при суженной области в книгу
// они не попадают, и об этом прямо сказано в листе.
async function workbook({ from, to, rules, scope, department }) {
  const limited = !!(scope && scope.depts);
  const depIds = limited ? [...scope.depts] : null;
  const depWhere = limited ? ' AND e.department_id = ANY($3::int[])' : '';
  const depArgs = limited ? [from, to, depIds] : [from, to];
  const rows = (await db.pool.query(
    `SELECT l.kind, l.text, l.card_name, l.sent, l.created_at,
            e.full_name, e.position, COALESCE(d.name, '— без отдела —') AS department
       FROM jarvis_log l
       LEFT JOIN hr_employees e ON e.id = l.employee_id
       LEFT JOIN hr_departments d ON d.id = e.department_id
      WHERE l.kind LIKE 'violation%' AND l.created_at >= $1::date AND l.created_at < ($2::date + 1)${depWhere}
      ORDER BY l.created_at`, depArgs)).rows;
  // Цена нарушения: за неответ и за срок — своя, «без срока» считаем как просрочку.
  const price = (kind) => (kind === 'violation_mention' ? rules.fine_mention : rules.fine_overdue) || 0;
  const byDep = new Map(), byMan = new Map();
  for (const r of rows) {
    const dep = r.department, who = r.full_name || '— не опознан —';
    const d = byDep.get(dep) || { dep, n: 0, mention: 0, overdue: 0, nodue: 0, sum: 0, people: new Set() };
    d.n++; d.sum += price(r.kind); d.people.add(who);
    if (r.kind === 'violation_mention') d.mention++;
    else if (r.kind === 'violation_overdue') d.overdue++;
    else d.nodue++;
    byDep.set(dep, d);
    const key = dep + '|' + who;
    const m = byMan.get(key) || { dep, who, position: r.position || '', n: 0, sum: 0, notSent: 0 };
    m.n++; m.sum += price(r.kind);
    if (!r.sent) m.notSent++;
    byMan.set(key, m);
  }
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const head = [[`Нарушения с ${from} по ${to}`],
    [rules.fines_enabled ? 'Штрафы включены' : 'Штрафы ВЫКЛЮЧЕНЫ — суммы справочные'],
    [`Цена: неответ ${rules.fine_mention} сум, срок ${rules.fine_overdue} сум`], []];
  const dep = [...byDep.values()].sort((a, b) => b.n - a.n)
    .map((d) => [d.dep, d.people.size, d.n, d.mention, d.overdue, d.nodue, d.sum]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...head,
    ['Отдел', 'Людей', 'Нарушений', 'Не ответил', 'Просрочил', 'Без срока', 'Сумма, сум'], ...dep,
    ['ИТОГО', '', rows.length, '', '', '', dep.reduce((a, x) => a + x[6], 0)]]), 'По отделам');
  const man = [...byMan.values()].sort((a, b) => b.n - a.n)
    .map((m) => [m.dep, m.who, m.position, m.n, m.sum, m.notSent]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...head,
    ['Отдел', 'Сотрудник', 'Должность', 'Нарушений', 'Сумма, сум', 'Не дошло до него'], ...man]), 'По людям');
  const ru = (d) => new Date(new Date(d).getTime() + 5 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Дата', 'Отдел', 'Сотрудник', 'Нарушение', 'Карточка', 'Подробности', 'Дошло'],
    ...rows.map((r) => [ru(r.created_at), r.department, r.full_name || '', VIOLATIONS[r.kind] || r.kind,
      r.card_name || '', r.text || '', r.sent ? 'да' : 'нет'])]), 'Построчно');

  // Карточки Trello, где ждут ответа. Период тут не при чём: важно не «когда
  // упомянули», а что ответа нет до сих пор — поэтому берём всё открытое.
  const days = (d) => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  const ment = (await db.pool.query(
    `SELECT m.card_name, m.board_name, m.author_name, m.created_at, m.reminded_at, m.violation_at,
            e.full_name, COALESCE(d.name, '— без отдела —') AS department
       FROM jarvis_mentions m
       LEFT JOIN hr_employees e ON e.id = m.employee_id
       LEFT JOIN hr_departments d ON d.id = e.department_id
      WHERE m.answered_at IS NULL${limited ? ' AND e.department_id = ANY($1::int[])' : ''}
      ORDER BY m.created_at`, limited ? [depIds] : [])).rows;
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Упоминания в Trello без ответа — на ' + new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10)], [],
    ['Кого ждут', 'Отдел', 'Карточка', 'Доска', 'Кто упомянул', 'Когда', 'Дней без ответа', 'Стадия'],
    ...ment.map((m) => [m.full_name || '— не опознан —', m.department, m.card_name || '', m.board_name || '',
      m.author_name || '', ru(m.created_at), days(m.created_at),
      m.violation_at ? 'нарушение' : m.reminded_at ? 'напомнили' : 'ждём'])]), 'Карточки без ответа');

  // Претензии: две разные беды. Агент не взял в работу — это про скорость
  // реакции; претензия не закрыта — про то, что вопрос клиента висит.
  // Схемы претензий может не быть (бот ещё не поднимался) — тогда просто
  // отдаём файл без этих листов, а не роняем всю выгрузку.
  let openClaims = [];
  let claimsNote = null;
  try {
    if (limited) throw new Error('ограниченная область: претензии не показываем');
    openClaims = (await db.pool.query(
      `SELECT c.id, c.created_at, c.status, c.point_name, c.firm_name, c.product_name, c.agent_name,
              c.agent_reacted_at, c.internal_note, c.source,
              (SELECT label_ru FROM tgbot.complaint_dicts WHERE kind = 'type' AND code = c.complaint_type LIMIT 1) AS type_label,
              (SELECT label_ru FROM tgbot.complaint_dicts WHERE kind = 'link' AND code = c.link_code LIMIT 1) AS link_label
         FROM tgbot.complaints c
        WHERE c.status <> 'resolved' ORDER BY c.created_at`)).rows;
  } catch (e) { openClaims = []; claimsNote = limited
    ? 'Претензии в этом файле не показаны: они по всей компании, а вам открыты только свои отделы.'
    : 'Претензии прочитать не удалось: ' + e.message + '. Пустой список тут не значит «претензий нет».'; }
  const claimRow = (c) => [c.id, ru(c.created_at), days(c.created_at), c.link_label || '',
    c.point_name || c.firm_name || '', c.product_name || '', c.type_label || '', c.agent_name || '',
    c.agent_reacted_at ? 'да' : 'нет', String(c.internal_note || '').trim() ? 'да' : 'нет',
    c.source === 'client_bot' ? 'клиент' : 'агент'];
  const claimHead = ['№', 'Подана', 'Дней открыта', 'Звено', 'Точка', 'Товар', 'Тип', 'Агент',
    'Агент принял в работу', 'Есть причина', 'Кто подал'];
  // Пустой лист без объяснения читается как «проблем нет» — поэтому причина
  // пустоты всегда написана прямо в листе (задание J05).
  const claimTop = (title) => (claimsNote ? [[title], ['⚠️ ' + claimsNote], []] : [[title], []]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ...claimTop('Претензии, где агент не взял в работу'),
    claimHead, ...openClaims.filter((c) => !c.agent_reacted_at).map(claimRow)]), 'Претензии без реакции');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ...claimTop('Претензии, которые до сих пор не закрыты'),
    claimHead, ...openClaims.map(claimRow)]), 'Претензии не закрыты');
  // Кто именно тормозит: по звеньям и по агентам.
  const byLink = new Map(), byAgent = new Map();
  for (const c of openClaims) {
    const L = byLink.get(c.link_label || '— без звена —') || { n: 0, noReact: 0, old: 0 };
    L.n++; if (!c.agent_reacted_at) L.noReact++; if (days(c.created_at) > 1) L.old++;
    byLink.set(c.link_label || '— без звена —', L);
    const A = byAgent.get(c.agent_name || '— без агента —') || { n: 0, noReact: 0 };
    A.n++; if (!c.agent_reacted_at) A.noReact++;
    byAgent.set(c.agent_name || '— без агента —', A);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Открытые претензии по звеньям'], [],
    ['Звено', 'Открыто', 'Из них агент не взял', 'Висят дольше суток'],
    ...[...byLink.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, v.n, v.noReact, v.old]), [],
    ['Открытые претензии по агентам'], [],
    ['Агент', 'Открыто', 'Из них не взял в работу'],
    // Имя листа без двоеточия и слэшей — Excel их не принимает, и файл
    // не скачивался вовсе («Sheet name cannot contain : \ / ? * [ ]»).
    ...[...byAgent.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, v.n, v.noReact])]), 'Претензии сводка');

  // Листы отчёта по команде собираются ИЗ ТОГО ЖЕ набора данных, что и ответ
  // в чате (задание J06): период, охват и определения одни, цифры сходятся.
  try {
    const rep = await require('./jarvis-team').teamReport({ from, to, scope, department });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      [`Кто отвечает, а кто нет: ${from} — ${to}`],
      [`Охват: ${rep.охват}${department ? `, отдел: ${department}` : ''}`],
      [`Открытые вопросы — снимок на ${rep.снимок_открытых_на}`], [],
      ['Отдел', 'Людей', 'Обращений', 'Ответили сами', 'Открыто', 'Старых открытых', 'Нарушений', 'Не в боте'],
      ...rep.по_отделам.map((d) => [d.отдел, d.людей, d.обращений, d.ответили_сами, d.открыто,
        d.старых_открытых, d.нарушений, d.не_в_боте]),
      [], ['ИТОГО', rep.итого.людей, rep.итого.обращений, rep.итого.ответили_сами,
        rep.итого.открыто_из_них, rep.итого.старых_открытых, rep.итого.нарушений, ''],
    ]), 'Команда по отделам');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Все сотрудники охвата — включая тех, у кого обращений не было'], [],
      ['Сотрудник', 'Отдел', 'Должность', 'Есть в Trello', 'В боте', 'Обращений', 'Ответил сам',
        'Снято системой', 'Не определено', 'Открыто', 'Карточек открыто', 'Напоминать перестали',
        'Старых открытых', 'Дней самое старое', 'Нарушений', 'Не дошло до него', 'Замечание'],
      ...rep.по_людям.map((x) => [x.сотрудник, x.отдел, x.должность, x.в_trello ? 'да' : 'нет',
        x.в_боте ? 'да' : 'нет', x.обращений, x.ответил_сам, x.снято_системой, x.не_определено,
        x.открыто_из_них, x.карточек_открыто, x.напоминания_прекращены, x.старых_открытых,
        x.дней_самое_старое, x.нарушений, x.не_дошло_до_него, x.замечание || '']),
      [], ['Определения:'],
      ...Object.entries(rep.определения).map(([k, v]) => [k, v]),
    ]), 'Команда по людям');
  } catch (e) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Отчёт по команде собрать не удалось'], ['⚠️ ' + e.message],
      ['Пустой лист тут не значит «всё хорошо» — данные не прочитались.'],
    ]), 'Команда по людям');
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { buf, name: `otchet_${from}_${to}.xlsx` };
}

module.exports = { workbook, VIOLATIONS };
