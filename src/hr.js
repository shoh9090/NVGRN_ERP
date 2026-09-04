// hr.js — модуль «Персонал»: сотрудники, отделы (Этап 1). Зарплата/табель — далее.
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');

const router = express.Router();
const J = express.json();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
const intOrNull = (v) => (v === '' || v == null ? null : parseInt(v, 10));
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

// Типы графика — фиксированный набор (не текстом, чтобы не расползалось).
const SCHEDULES = [
  { code: 'day5', name: '5-дневка' },
  { code: 'day6', name: '6-дневка' },
  { code: 'shift22', name: 'Смена 2/2' },
];
const SCHEDULE_CODES = SCHEDULES.map((s) => s.code);
const STATUSES = ['active', 'fired', 'archived'];

let _ready = false;
async function ensureSchema() {
  if (_ready) return;
  const q = (s) => db.pool.query(s);
  await q(`CREATE TABLE IF NOT EXISTS hr_departments (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INT NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active'
  )`);
  await q(`CREATE TABLE IF NOT EXISTS hr_employees (
    id SERIAL PRIMARY KEY,
    full_name TEXT NOT NULL,
    department_id INT REFERENCES hr_departments(id),
    position TEXT,
    schedule_type TEXT,
    hire_date DATE,
    fire_date DATE,
    status TEXT NOT NULL DEFAULT 'active',       -- active | fired | archived
    base_salary NUMERIC,
    salary_official NUMERIC,
    salary_unofficial NUMERIC,
    phone TEXT,
    telegram_id TEXT,
    erp_user_id INT,
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_hr_emp_dept ON hr_employees (department_id)`);
  // «Полный месяц»: факт = план (нет табеля). «Заполнить нормы» проставляет таким факт автоматически.
  await q(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS full_month BOOLEAN DEFAULT FALSE`);
  // Переход на общие графики (не по отделам): office→5-дневка, production/shift→смена 2/2. Идемпотентно.
  await q("UPDATE hr_employees SET schedule_type='day5' WHERE schedule_type='office'");
  await q("UPDATE hr_employees SET schedule_type='shift22' WHERE schedule_type IN ('production','shift')");
  await q(`CREATE INDEX IF NOT EXISTS idx_hr_emp_status ON hr_employees (status)`);
  await q(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS card_number TEXT`); // для чтения выплат из выписки по номеру карты
  // Начисление зарплаты сотруднику за месяц (одна строка = сотрудник × период).
  await q(`CREATE TABLE IF NOT EXISTS hr_payroll (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    period TEXT NOT NULL,                          -- YYYY-MM
    status TEXT NOT NULL DEFAULT 'draft',          -- draft | approved | paid | cancelled
    plan_days NUMERIC, fact_days NUMERIC, plan_hours NUMERIC, fact_hours NUMERIC,
    accr_salary NUMERIC, accr_fact NUMERIC, accr_bonus NUMERIC, accr_premium NUMERIC,
    accr_gsm NUMERIC, accr_company_debt NUMERIC, accr_other NUMERIC,
    ded_fine NUMERIC, ded_advance_card NUMERIC, ded_advance_cash NUMERIC,
    ded_hold NUMERIC, ded_emp_debt NUMERIC, ded_other NUMERIC,
    paid_cash NUMERIC, paid_card NUMERIC, pay_date DATE, pay_method TEXT,
    amount_1c NUMERIC, comment TEXT,
    created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (employee_id, period)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_hr_payroll_period ON hr_payroll (period)`);
  // Журнал выплат зарплаты (вкладка «Выплаты»): каждая выплата — отдельная запись, поддержка частичных.
  await q(`CREATE TABLE IF NOT EXISTS hr_payouts (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    period TEXT NOT NULL,                          -- YYYY-MM
    amount NUMERIC NOT NULL DEFAULT 0,
    method TEXT NOT NULL DEFAULT 'cash',           -- cash | card
    pay_date DATE,
    cash_tx_id INT,                                -- ссылка на транзакцию Кассы (шаг 2)
    comment TEXT,
    created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_hr_payouts_emp_period ON hr_payouts (employee_id, period)`);
  // Доп. статьи начислений для массовых операций (больничные/отпускные/матпомощь/компенсация отпуска).
  for (const col of ['accr_sick', 'accr_vacation', 'accr_mataid', 'accr_comp_vac']) {
    await q(`ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS ${col} NUMERIC`);
  }
  await q(`ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC`); // переработка, часы (из табеля)
  // Момент начисления: пока NULL — зарплата НЕ показывается (ни в ведомости, ни в дашборде). Ставится кнопкой «Начислить».
  await q(`ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS accrued_at TIMESTAMPTZ`);
  // Кадровая история: приём/увольнение/отпуск/больничный/перемещения/смена оклада-должности-графика.
  await q(`CREATE TABLE IF NOT EXISTS hr_events (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,                     -- hire|fire|vacation|sick|transfer|position|salary|schedule|other
    event_date DATE NOT NULL,
    date_to DATE,                                 -- для отпуска/больничного (период с — по)
    from_text TEXT, to_text TEXT,                 -- старое → новое (отдел/оклад/должность/график)
    comment TEXT,
    created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_hr_events_emp ON hr_events (employee_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_hr_events_date ON hr_events (event_date)`);
  // История окладов (для расчёта месяца изменения по частям). Каждая запись — оклад с даты действия.
  await q(`CREATE TABLE IF NOT EXISTS hr_salary_history (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    base_salary NUMERIC NOT NULL DEFAULT 0,
    effective_from DATE NOT NULL,
    created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_hr_salhist ON hr_salary_history (employee_id, effective_from)`);
  // Постоянные (фиксированные) надбавки/удержания сотрудника: закрепляются в карточке и
  // подставляются в ведомость каждый месяц автоматически (бонус, ГСМ, удержание и т.п.).
  // Действуют с месяца date_from по date_to включительно (пусто = бессрочно).
  await q(`CREATE TABLE IF NOT EXISTS hr_employee_recurring (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    field TEXT NOT NULL,                           -- колонка ведомости: accr_bonus | ded_hold | ...
    amount NUMERIC NOT NULL DEFAULT 0,
    date_from TEXT,                                -- YYYY-MM (с какого месяца), пусто = всегда
    date_to TEXT,                                  -- YYYY-MM (по какой месяц), пусто = бессрочно
    comment TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_hr_recur_emp ON hr_employee_recurring (employee_id)`);
  // Плановые нормы по месяцам и графикам. Раньше нигде не хранились — их «вычисляли» из строк
  // сотрудников, поэтому до заполнения окно показывало значения по умолчанию, а история норм
  // терялась. Теперь норма — самостоятельная запись: месяц + график → план дни/часы.
  await q(`CREATE TABLE IF NOT EXISTS hr_norms (
    period TEXT NOT NULL,                          -- YYYY-MM
    schedule_type TEXT NOT NULL,                   -- day5 | day6 | shift22
    plan_days NUMERIC, plan_hours NUMERIC,
    updated_by INT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (period, schedule_type)
  )`);
  // Бэкфилл: переносим нормы, уже проставленные в ведомостях, чтобы прошлые месяцы не потерялись.
  await q(`INSERT INTO hr_norms (period, schedule_type, plan_days, plan_hours)
           SELECT pr.period, e.schedule_type, MAX(pr.plan_days), MAX(pr.plan_hours)
             FROM hr_employees e JOIN hr_payroll pr ON pr.employee_id = e.id
            WHERE e.schedule_type IS NOT NULL
              AND (pr.plan_days IS NOT NULL OR pr.plan_hours IS NOT NULL)
            GROUP BY pr.period, e.schedule_type
           ON CONFLICT (period, schedule_type) DO NOTHING`).catch(() => {});
  // Налоги на ФОТ по месяцам (вписываются вручную, платятся позже начисления): ИНПС, НДФЛ, соцналог.
  await q(`CREATE TABLE IF NOT EXISTS hr_fot_taxes (
    period TEXT PRIMARY KEY,
    inps NUMERIC DEFAULT 0, ndfl NUMERIC DEFAULT 0, social NUMERIC DEFAULT 0,
    updated_by INT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Бэкфилл: у кого нет истории — текущий оклад с даты приёма (или далёкого прошлого).
  await q(`INSERT INTO hr_salary_history (employee_id, base_salary, effective_from)
           SELECT id, COALESCE(base_salary,0), COALESCE(hire_date,'2000-01-01') FROM hr_employees e
            WHERE NOT EXISTS (SELECT 1 FROM hr_salary_history h WHERE h.employee_id=e.id)`).catch(() => {});
  // Разовый бэкфилл приёма/увольнения из дат карточки (идемпотентно — если события ещё нет).
  await q(`INSERT INTO hr_events (employee_id, event_type, event_date)
           SELECT id, 'hire', hire_date FROM hr_employees e
            WHERE hire_date IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hr_events v WHERE v.employee_id=e.id AND v.event_type='hire')`).catch(() => {});
  await q(`INSERT INTO hr_events (employee_id, event_type, event_date)
           SELECT id, 'fire', fire_date FROM hr_employees e
            WHERE fire_date IS NOT NULL AND status='fired' AND NOT EXISTS (SELECT 1 FROM hr_events v WHERE v.employee_id=e.id AND v.event_type='fire')`).catch(() => {});
  await seedDepartments();
  _ready = true;
}
const EVENT_TYPES = ['hire', 'fire', 'vacation', 'sick', 'transfer', 'position', 'salary', 'schedule', 'other'];
const schedLabel = (code) => { const s = SCHEDULES.find((x) => x.code === code); return s ? s.name : (code || '—'); };
const fmtSum = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('ru-RU'));
async function deptName(id) { if (!id) return '—'; const r = await db.pool.query('SELECT name FROM hr_departments WHERE id=$1', [id]); return r.rows[0] ? r.rows[0].name : '—'; }
async function addEvent(empId, type, date, opts = {}) {
  await db.pool.query(
    `INSERT INTO hr_events (employee_id, event_type, event_date, date_to, from_text, to_text, comment, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [empId, type, date || new Date().toISOString().slice(0, 10), opts.date_to || null, opts.from_text || null, opts.to_text || null, opts.comment || null, opts.created_by || null]);
}
// Поля начислений/удержаний/выплат — для расчётов и сохранения.
// Списки живут в общем src/hr-fields.js: тем же составом «Начислено» считает
// Калькуляция себестоимости, иначе ФОТ в себестоимости разойдётся с Кадрами.
// ВАЖНО: accr_salary (Фикса) — базовая ставка, НЕ входит в сумму «начислено».
// «Долг компании» (accr_company_debt) в итоге считается удержанием и уменьшает «К выплате».
// В список колонок вставки он идёт через ACCR_ALL, поэтому в DED его не кладём (иначе дубль колонки) — только в сумму.
const { ACCR_EXTRA, ACCR_ALL, ACCR_FIELDS: ACCR, DED, DED_SUM, PAID } = require('./hr-fields');
const PAYROLL_NUM = [...ACCR_ALL, ...DED, ...PAID, 'plan_days', 'fact_days', 'plan_hours', 'fact_hours', 'amount_1c'];

// Тип оплаты по графику: смена 2/2 — почасовая (табель); 5/6-дневка — по дням (оклад/план-дни × факт-дни).
const POCHASOVOY = new Set(['shift22']);
// Авторасчёт оклада-начисления (accr_fact) ПО ФАКТУ. Нет факта → 0 (не начисляем).
// Почасовые: оклад/план_часы × (факт_часы + переработка×2).
// Окладники: дневная ставка × факт-дни = (оклад / план_дни) × факт_дни.
function computePay(row) {
  const oklad = Number(row.base_salary) || 0;
  if (POCHASOVOY.has(row.schedule_type)) {
    const planH = Number(row.plan_hours) || 0, factH = Number(row.fact_hours) || 0, otH = Number(row.overtime_hours) || 0;
    if (!(planH > 0) || !((factH + otH) > 0)) return { base: 0, overtime: 0 };
    const rate = oklad / planH;
    return { base: Math.round(rate * (factH + otH * 2)), overtime: Math.round(rate * otH * 2) };
  }
  const planD = Number(row.plan_days) || 0, factD = Number(row.fact_days) || 0;
  if (!(planD > 0) || !(factD > 0)) return { base: 0, overtime: 0 };
  return { base: Math.round(oklad / planD * factD), overtime: 0 };
}
// Эффективный «месячный» оклад за период с учётом истории изменений (календарно-взвешенный).
// Оклад сменился в середине месяца → доля дней до/от даты × соответствующий оклад. Ставка потом = /план.
async function effectiveOklad(empId, period, fallback) {
  const [y, m] = period.split('-').map(Number);
  const monthStart = period + '-01';
  const D = new Date(Date.UTC(y, m, 0)).getUTCDate();                 // дней в месяце
  const monthEnd = `${period}-${String(D).padStart(2, '0')}`;
  const hist = (await db.pool.query(
    "SELECT base_salary, to_char(effective_from,'YYYY-MM-DD') AS eff FROM hr_salary_history WHERE employee_id=$1 ORDER BY effective_from, id", [empId])).rows;
  if (!hist.length) return Number(fallback) || 0;
  let startOklad = null;
  for (const h of hist) { if (h.eff <= monthStart) startOklad = Number(h.base_salary); }
  if (startOklad == null) startOklad = Number(hist[0].base_salary);   // раньше всех записей — берём первую
  const changes = hist.filter((h) => h.eff > monthStart && h.eff <= monthEnd)
    .map((h) => ({ day: Number(h.eff.slice(8, 10)), oklad: Number(h.base_salary) })).sort((a, b) => a.day - b.day);
  if (!changes.length) return startOklad;
  let sum = 0, prevDay = 1, prevOklad = startOklad;
  for (const ch of changes) { sum += prevOklad * (ch.day - prevDay); prevDay = ch.day; prevOklad = ch.oklad; }
  sum += prevOklad * (D - prevDay + 1);
  return sum / D;                                                     // календарно-взвешенный месячный оклад
}
// Пересчитать и сохранить accr_fact сотрудника за период. Возвращает посчитанную базу.
async function recomputeAccrFact(empId, period) {
  const r = (await db.pool.query(
    `SELECT e.base_salary, e.schedule_type, pr.plan_days, pr.fact_days, pr.plan_hours, pr.fact_hours, pr.overtime_hours
     FROM hr_employees e LEFT JOIN hr_payroll pr ON pr.employee_id = e.id AND pr.period = $2 WHERE e.id = $1`, [empId, period])).rows[0];
  if (!r) return 0;
  const effOklad = await effectiveOklad(empId, period, r.base_salary);
  const pay = computePay(Object.assign({}, r, { base_salary: effOklad }));
  await db.pool.query(
    `INSERT INTO hr_payroll (employee_id, period, accr_fact) VALUES ($1,$2,$3)
     ON CONFLICT (employee_id, period) DO UPDATE SET accr_fact = EXCLUDED.accr_fact, updated_at = now()`,
    [empId, period, pay.base]);
  return pay.base;
}
const sumF = (row, fields) => fields.reduce((s, f) => s + (Number(row[f]) || 0), 0);

// ===== Закрытие месяца в Кадрах =====
// Хранится месяц «закрыто по» (YYYY-MM) в settings.hr_locked_until. Всё по этот месяц
// включительно нельзя менять: ни начисления, ни табель, ни выплаты, ни импорт.
// Смысл тот же, что в Кассе: сверенные месяцы больше не «играют».
let _hrLock = { at: 0, val: null };
async function hrLockedUntil() {
  if (Date.now() - _hrLock.at < 5000) return _hrLock.val;
  const r = await db.pool.query("SELECT value FROM settings WHERE key = 'hr_locked_until'");
  const v = r.rows[0] && /^\d{4}-\d{2}$/.test(String(r.rows[0].value)) ? String(r.rows[0].value) : null;
  _hrLock = { at: Date.now(), val: v };
  return v;
}
const clearHrLock = () => { _hrLock = { at: 0, val: null }; };
const ruMonth = (p) => { const [y, m] = String(p).split('-'); return ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'][Number(m)] + ' ' + y; };
// Ошибка, если месяц закрыт. Принимает периоды 'YYYY-MM' (пустые игнорирует).
async function hrLockError(...periods) {
  const lock = await hrLockedUntil();
  if (!lock) return null;
  for (const p of periods) {
    if (p && /^\d{4}-\d{2}/.test(String(p)) && String(p).slice(0, 7) <= lock) {
      return `Месяц закрыт (по ${ruMonth(lock)}) — начисления и выплаты за закрытые месяцы менять нельзя. Откройте месяц в Кадрах, если правка действительно нужна.`;
    }
  }
  return null;
}
// Периоды строк ведомости по их id — для проверок в массовых операциях.
async function periodsOfPayrollIds(ids) {
  if (!ids || !ids.length) return [];
  return (await db.pool.query('SELECT DISTINCT period FROM hr_payroll WHERE id = ANY($1::int[])', [ids])).rows.map((r) => r.period);
}

// Фильтр по отделам: принимает один id, список через запятую («1,5,7») и «__none__» (без отдела).
// Дописывает условие в WHERE-массив w и параметры в p. Пусто = все отделы.
function deptFilter(raw, p, w, col = 'e.department_id') {
  const parts = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return;
  const noDept = parts.includes('__none__');
  const ids = parts.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n));
  const conds = [];
  if (ids.length) { p.push(ids); conds.push(`${col} = ANY($${p.length}::int[])`); }
  if (noDept) conds.push(`${col} IS NULL`);
  if (conds.length) w.push('(' + conds.join(' OR ') + ')');
}
// То же для списков, отфильтрованных в памяти (Выплаты). Пусто = все отделы.
function deptFilterMem(raw, items) {
  const parts = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return items;
  const noDept = parts.includes('__none__');
  const ids = new Set(parts.filter((x) => /^\d+$/.test(x)));
  return items.filter((x) => (noDept && !x.department_id) || ids.has(String(x.department_id)));
}

// Поля, которые можно закрепить в карточке как постоянные (фиксированные) суммы.
const RECUR_FIELDS = [
  ['accr_bonus', 'Бонус'], ['accr_premium', 'Премия'], ['accr_gsm', 'ГСМ'], ['accr_other', 'Прочее начисление'],
  ['ded_hold', 'Удержание'], ['ded_fine', 'Штраф'], ['ded_emp_debt', 'Долг сотрудника'], ['ded_other', 'Прочее удержание'],
];
const RECUR_CODES = RECUR_FIELDS.map(([c]) => c);
// Подставить постоянные надбавки/удержания сотрудника в ведомость за период.
// Проставляем только в ПУСТЫЕ ячейки (NULL) — ручная правка за месяц всегда приоритетнее.
async function applyRecurring(empId, period) {
  const rows = (await db.pool.query(
    `SELECT field, amount FROM hr_employee_recurring
     WHERE employee_id = $1 AND active = TRUE
       AND (date_from IS NULL OR date_from = '' OR date_from <= $2)
       AND (date_to   IS NULL OR date_to   = '' OR date_to   >= $2)`, [empId, period])).rows;
  if (!rows.length) return 0;
  // Несколько правил на одно поле складываем.
  const byField = {};
  for (const r of rows) {
    if (!RECUR_CODES.includes(r.field)) continue;
    byField[r.field] = (byField[r.field] || 0) + (Number(r.amount) || 0);
  }
  const fields = Object.keys(byField);
  if (!fields.length) return 0;
  await db.pool.query(
    `INSERT INTO hr_payroll (employee_id, period) VALUES ($1,$2) ON CONFLICT (employee_id, period) DO NOTHING`, [empId, period]);
  const sets = fields.map((f, i) => `${f} = COALESCE(${f}, $${i + 3})`);
  await db.pool.query(
    `UPDATE hr_payroll SET ${sets.join(', ')}, updated_at = now() WHERE employee_id = $1 AND period = $2`,
    [empId, period, ...fields.map((f) => byField[f])]);
  return fields.length;
}
async function seedDepartments() {
  const D = ['АУП', 'Производство', 'Производство смена', 'Склад', 'Продажи', 'Маркетинг', 'Бухгалтерия', 'Закупки', 'Логистика', 'Другое'];
  let i = 0;
  for (const name of D) { i += 10; await db.pool.query('INSERT INTO hr_departments (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, i]); }
  await seedJune2026();
}
// Разовая загрузка сотрудников и начислений за июнь 2026 из файла Шоха.
// force=true — перезапуск вручную (восстановление случайно удалённых карточек): флаг
// игнорируется, существующие по ФИО пропускаются, создаются только недостающие.
// Возвращает, сколько сотрудников восстановлено.
async function seedJune2026(force) {
  let restored = 0;
  try {
    const flag = (await db.pool.query("SELECT value FROM settings WHERE key='hr_seed_june2026'")).rows[0];
    if (!force && flag && flag.value === 'done') return restored;
    let data; try { data = require('./data/hr_seed_june2026.json'); } catch (e) { return restored; }
    const emps = data.employees || [];
    if (!emps.length) return restored;
    const deptMap = {};
    (await db.pool.query('SELECT id, name FROM hr_departments')).rows.forEach((d) => { deptMap[d.name.toLowerCase()] = d.id; });
    for (const e of emps) {
      if (!e.full_name) continue;
      const ex = await db.pool.query('SELECT id FROM hr_employees WHERE lower(full_name)=lower($1) LIMIT 1', [e.full_name]);
      if (ex.rows.length) continue; // не дублируем
      const deptId = e.department ? (deptMap[e.department.toLowerCase()] || null) : null;
      const ins = await db.pool.query(
        `INSERT INTO hr_employees (full_name, department_id, position, schedule_type, base_salary, salary_official, salary_unofficial)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [e.full_name, deptId, e.position || null, e.schedule || null, e.base_salary, e.salary_official, e.salary_unofficial]);
      await db.pool.query(
        `INSERT INTO hr_payroll (employee_id, period, status, plan_days, fact_days, fact_hours,
           accr_salary, accr_fact, accr_bonus, accr_premium, accr_gsm, accr_company_debt,
           ded_fine, ded_advance_card, ded_advance_cash, ded_hold, paid_cash, paid_card, amount_1c)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (employee_id, period) DO NOTHING`,
        [ins.rows[0].id, data.period, e.plan_days, e.fact_days, e.fact_hours, e.accr_salary, e.accr_fact, e.accr_bonus, e.accr_premium, e.accr_gsm, e.accr_company_debt, e.ded_fine, e.ded_advance_card, e.ded_advance_cash, e.ded_hold, e.paid_cash, e.paid_card, e.amount_1c]);
      restored++;
    }
    await db.setSetting('hr_seed_june2026', 'done');
    console.log('[HR SEED] Загружено сотрудников за июнь 2026:', restored);
  } catch (e) { console.warn('[HR SEED]', e.message); }
  return restored;
}

router.use(async (req, res, next) => { try { await ensureSchema(); } catch (e) { /* не роняем модуль */ } next(); });

// ---------- Страница ----------
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('hr', { settings, user: req.user });
});

// ---------- Справочники ----------
router.get('/api/dicts', async (req, res) => {
  const departments = (await db.pool.query(
    `SELECT d.id, d.name, d.sort_order,
            (SELECT COUNT(*) FROM hr_employees e WHERE e.department_id = d.id AND e.status = 'active')::int AS emp_count
     FROM hr_departments d WHERE d.status='active' ORDER BY d.sort_order, d.name`)).rows;
  const counts = (await db.pool.query("SELECT status, count(*)::int n FROM hr_employees GROUP BY status")).rows;
  const byStatus = {}; counts.forEach((c) => { byStatus[c.status] = c.n; });
  res.json({ departments, schedules: SCHEDULES, statuses: STATUSES, counts: byStatus });
});

// ---------- Сотрудники ----------
router.get('/api/employees', async (req, res) => {
  const p = [], w = [];
  deptFilter(req.query.department, p, w);
  if (req.query.schedule && SCHEDULE_CODES.includes(req.query.schedule)) { p.push(req.query.schedule); w.push(`e.schedule_type = $${p.length}`); }
  if (req.query.status && STATUSES.includes(req.query.status)) { p.push(req.query.status); w.push(`e.status = $${p.length}`); }
  else if (!req.query.status) w.push(`e.status <> 'archived'`); // по умолчанию скрываем архив
  if (req.query.q) { p.push('%' + String(req.query.q).trim() + '%'); w.push(`(e.full_name ILIKE $${p.length} OR e.position ILIKE $${p.length} OR e.phone ILIKE $${p.length})`); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const rows = (await db.pool.query(
    `SELECT e.*, d.name AS department_name
     FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
     ${where} ORDER BY e.full_name LIMIT 2000`, p)).rows;
  // ФОТ-заготовка: сумма окладов активных (по выборке).
  const fot = rows.filter((r) => r.status === 'active').reduce((s, r) => s + (Number(r.base_salary) || 0), 0);
  res.json({ items: rows, fot });
});

// Выгрузка справочника сотрудников в Excel — ровно то, что видно на вкладке
// (те же фильтры: отделы, статус, поиск). Отделы не выбраны = все отделы.
router.get('/api/employees-export.xlsx', async (req, res) => {
  try {
    const p = [], w = [];
    deptFilter(req.query.department, p, w);
    if (req.query.schedule && SCHEDULE_CODES.includes(req.query.schedule)) { p.push(req.query.schedule); w.push(`e.schedule_type = $${p.length}`); }
    if (req.query.status && STATUSES.includes(req.query.status)) { p.push(req.query.status); w.push(`e.status = $${p.length}`); }
    else if (!req.query.status) w.push(`e.status <> 'archived'`);
    if (req.query.q) { p.push('%' + String(req.query.q).trim() + '%'); w.push(`(e.full_name ILIKE $${p.length} OR e.position ILIKE $${p.length} OR e.phone ILIKE $${p.length})`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const rows = (await db.pool.query(
      `SELECT e.*, d.name AS department_name, COALESCE(d.sort_order, 999) AS dept_sort,
              to_char(e.hire_date,'DD.MM.YYYY') AS hire_txt, to_char(e.fire_date,'DD.MM.YYYY') AS fire_txt
       FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
       ${where} ORDER BY dept_sort, d.name NULLS LAST, e.full_name`, p)).rows;
    // Постоянные надбавки/удержания из карточки — одной колонкой текстом.
    const recur = {};
    if (rows.length) {
      const rr = (await db.pool.query(
        `SELECT employee_id, field, SUM(amount) AS amount FROM hr_employee_recurring
          WHERE active = TRUE AND employee_id = ANY($1::int[]) GROUP BY employee_id, field`,
        [rows.map((r) => r.id)])).rows;
      const NAME = Object.fromEntries(RECUR_FIELDS);
      rr.forEach((x) => {
        if (!NAME[x.field] || !Number(x.amount)) return;
        (recur[x.employee_id] = recur[x.employee_id] || []).push(NAME[x.field] + ' ' + Math.round(Number(x.amount)).toLocaleString('ru-RU'));
      });
    }
    const SCHED = Object.fromEntries(SCHEDULES.map((s) => [s.code, s.name]));
    const ST = { active: 'Активен', fired: 'Уволен', archived: 'Архив' };
    const num = (v) => (v === null || v === undefined || v === '' ? '' : Math.round(Number(v) || 0));
    const aoa = [['#', 'ФИО', 'Отдел', 'Должность', 'График', 'Дата приёма', 'Дата увольнения', 'Статус',
      'Оклад/ставка', 'Официальная часть', 'Неофициальная часть', 'Полный месяц', 'Телефон', 'Номер карты',
      'Telegram', 'Постоянные суммы', 'Комментарий']];
    rows.forEach((e, i) => aoa.push([
      i + 1, e.full_name || '', e.department_name || 'Без отдела', e.position || '',
      SCHED[e.schedule_type] || '', e.hire_txt || '', e.fire_txt || '', ST[e.status] || e.status,
      num(e.base_salary), num(e.salary_official), num(e.salary_unofficial), e.full_month ? 'да' : '',
      e.phone || '', e.card_number || '', e.telegram_id || '',
      (recur[e.id] || []).join('; '), e.comment || '',
    ]));
    const sum = (f) => Math.round(rows.reduce((s, e) => s + (Number(e[f]) || 0), 0));
    aoa.push(['', 'ИТОГО (' + rows.length + ' чел.)', '', '', '', '', '', '',
      sum('base_salary'), sum('salary_official'), sum('salary_unofficial'), '', '', '', '', '', '']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 5 }, { wch: 30 }, { wch: 20 }, { wch: 22 }, { wch: 12 }, { wch: 13 }, { wch: 15 }, { wch: 11 },
      { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 13 }, { wch: 16 }, { wch: 20 }, { wch: 14 }, { wch: 30 }, { wch: 30 }];
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Сотрудники');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="sotrudniki_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buf);
  } catch (e) { res.status(400).send('Ошибка выгрузки: ' + e.message); }
});

router.post('/api/employee', J, async (req, res) => {
  const b = req.body || {};
  const name = String(b.full_name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите ФИО' });
  const sched = SCHEDULE_CODES.includes(b.schedule_type) ? b.schedule_type : null;
  // При правке карточки статус и дату увольнения НЕ сбрасываем, если их не прислали:
  // раньше сохранение карточки уволенного молча возвращало его в актив и стирало дату.
  const prev = b.id ? (await db.pool.query("SELECT status, to_char(fire_date,'YYYY-MM-DD') AS fire_date FROM hr_employees WHERE id=$1", [b.id])).rows[0] : null;
  const status = STATUSES.includes(b.status) ? b.status : (prev ? prev.status : 'active');
  const fireDate = (b.fire_date !== undefined) ? (b.fire_date || null) : (prev ? prev.fire_date : null);
  const args = [name, intOrNull(b.department_id), b.position || null, sched, b.hire_date || null, fireDate, status,
    numOrNull(b.base_salary), numOrNull(b.salary_official), numOrNull(b.salary_unofficial), b.phone || null, b.telegram_id || null, intOrNull(b.erp_user_id), b.comment || null,
    b.card_number || null, !!b.full_month];
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (b.id) {
      const old = (await db.pool.query('SELECT department_id, position, schedule_type, base_salary, status FROM hr_employees WHERE id=$1', [b.id])).rows[0];
      await db.pool.query(
        `UPDATE hr_employees SET full_name=$1, department_id=$2, position=$3, schedule_type=$4, hire_date=$5, fire_date=$6, status=$7,
          base_salary=$8, salary_official=$9, salary_unofficial=$10, phone=$11, telegram_id=$12, erp_user_id=$13, comment=$14, card_number=$15, full_month=$16, updated_at=now() WHERE id=$17`,
        [...args, b.id]);
      // Авто-логирование изменений в кадровую историю.
      if (old) {
        const uid = req.user.id;
        const newDept = intOrNull(b.department_id);
        if (String(old.department_id || '') !== String(newDept || '')) await addEvent(b.id, 'transfer', today, { from_text: await deptName(old.department_id), to_text: await deptName(newDept), created_by: uid });
        if ((old.position || '') !== (b.position || '')) await addEvent(b.id, 'position', today, { from_text: old.position || '—', to_text: b.position || '—', created_by: uid });
        if ((old.schedule_type || '') !== (sched || '')) await addEvent(b.id, 'schedule', today, { from_text: schedLabel(old.schedule_type), to_text: schedLabel(sched), created_by: uid });
        if (Number(old.base_salary || 0) !== Number(numOrNull(b.base_salary) || 0)) {
          const newSal = numOrNull(b.base_salary) || 0;
          await addEvent(b.id, 'salary', today, { from_text: fmtSum(old.base_salary), to_text: fmtSum(newSal), created_by: uid });
          // Правка оклада в карточке = изменение с 1-го числа текущего месяца (без разбивки середины).
          // Пишем в историю окладов и пересчитываем текущий месяц и последующие, чтобы цифры не расходились.
          const effFrom = today.slice(0, 7) + '-01';
          await db.pool.query('INSERT INTO hr_salary_history (employee_id, base_salary, effective_from, created_by) VALUES ($1,$2,$3,$4)', [b.id, newSal, effFrom, uid]);
          for (const pr of (await db.pool.query('SELECT DISTINCT period FROM hr_payroll WHERE employee_id=$1 AND period >= $2', [b.id, today.slice(0, 7)])).rows) {
            await recomputeAccrFact(b.id, pr.period);
          }
        }
        if ((old.status || '') !== status) {
          if (status === 'fired') await addEvent(b.id, 'fire', fireDate || today, { created_by: uid });
          else if (old.status === 'fired' && status === 'active') await addEvent(b.id, 'hire', today, { comment: 'Восстановлен', created_by: uid });
        } else if (status === 'fired' && fireDate && fireDate !== (prev ? prev.fire_date : null)) {
          // Уволенному проставили/поправили дату в карточке — это тоже должно попасть в историю.
          const ex = (await db.pool.query(
            "SELECT id FROM hr_events WHERE employee_id=$1 AND event_type='fire' ORDER BY event_date DESC LIMIT 1", [b.id])).rows[0];
          if (ex) await db.pool.query('UPDATE hr_events SET event_date=$1, comment=$2 WHERE id=$3', [fireDate, 'Дата уточнена', ex.id]);
          else await addEvent(b.id, 'fire', fireDate, { created_by: uid, comment: 'Дата внесена' });
        }
      }
    } else {
      const ins = await db.pool.query(
        `INSERT INTO hr_employees (full_name, department_id, position, schedule_type, hire_date, fire_date, status, base_salary, salary_official, salary_unofficial, phone, telegram_id, erp_user_id, comment, card_number, full_month)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, args);
      await addEvent(ins.rows[0].id, 'hire', b.hire_date || today, { created_by: req.user.id });
    }
    await db.log(req.user.id, 'hr_employee_save', name);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===== Постоянные надбавки/удержания сотрудника (закреплены в карточке) =====
router.get('/api/employee/:id(\\d+)/recurring', async (req, res) => {
  const rows = (await db.pool.query(
    'SELECT id, field, amount, date_from, date_to, comment, active FROM hr_employee_recurring WHERE employee_id=$1 ORDER BY id',
    [req.params.id])).rows;
  res.json({ items: rows, fields: RECUR_FIELDS.map(([code, label]) => ({ code, label })) });
});
router.post('/api/employee/:id(\\d+)/recurring', J, async (req, res) => {
  const empId = parseInt(req.params.id, 10);
  const b = req.body || {};
  if (!RECUR_CODES.includes(b.field)) return res.status(400).json({ error: 'Неизвестный вид начисления/удержания' });
  const amount = numOrNull(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Укажите сумму больше нуля' });
  const mon = (v) => (/^\d{4}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  try {
    if (b.id) {
      await db.pool.query(
        'UPDATE hr_employee_recurring SET field=$1, amount=$2, date_from=$3, date_to=$4, comment=$5, active=$6 WHERE id=$7 AND employee_id=$8',
        [b.field, amount, mon(b.date_from), mon(b.date_to), b.comment || null, b.active !== false, b.id, empId]);
    } else {
      await db.pool.query(
        'INSERT INTO hr_employee_recurring (employee_id, field, amount, date_from, date_to, comment, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [empId, b.field, amount, mon(b.date_from), mon(b.date_to), b.comment || null, b.active !== false, req.user.id]);
    }
    await db.log(req.user.id, 'hr_recurring_save', `emp ${empId} ${b.field}=${amount}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/employee/:id(\\d+)/recurring/:rid(\\d+)/delete', async (req, res) => {
  await db.pool.query('DELETE FROM hr_employee_recurring WHERE id=$1 AND employee_id=$2', [req.params.rid, req.params.id]);
  await db.log(req.user.id, 'hr_recurring_delete', '#' + req.params.rid);
  res.json({ ok: true });
});
// Ручная простановка постоянных сумм за месяц (кнопка в ведомости/массовых операциях).
// ---------- Закрытие месяца в Кадрах ----------
router.get('/api/period-lock', async (req, res) => {
  res.json({ locked_until: await hrLockedUntil() });
});
router.post('/api/period-lock', J, async (req, res) => {
  const b = req.body || {};
  if (b.clear) {
    await db.pool.query("DELETE FROM settings WHERE key = 'hr_locked_until'");
    clearHrLock();
    await db.log(req.user.id, 'hr_period_unlock', 'замок снят');
    return res.json({ ok: true, locked_until: null });
  }
  const period = String(b.period || '');
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Укажите месяц в виде ГГГГ-ММ' });
  await db.pool.query(
    `INSERT INTO settings (key, value) VALUES ('hr_locked_until', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [period]);
  clearHrLock();
  await db.log(req.user.id, 'hr_period_lock', `закрыто по ${period}`);
  res.json({ ok: true, locked_until: period });
});

router.post('/api/payroll/apply-recurring', J, async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
  if (!period) return res.status(400).json({ error: 'Не указан месяц' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
  const emps = (await db.pool.query(
    "SELECT DISTINCT employee_id AS id FROM hr_employee_recurring WHERE active = TRUE")).rows;
  let done = 0;
  for (const e of emps) { if (await applyRecurring(e.id, period)) done++; }
  await db.log(req.user.id, 'hr_apply_recurring', `${period}: ${done}`);
  res.json({ ok: true, done });
});

// Массовая простановка графика выбранным сотрудникам (в списке «Сотрудники»).
// Пишем смену графика в кадровую историю у каждого, у кого он реально изменился.
router.post('/api/employees/set-schedule', J, async (req, res) => {
  const sched = SCHEDULE_CODES.includes(req.body.schedule_type) ? req.body.schedule_type : null;
  if (!sched) return res.status(400).json({ error: 'Неверный график' });
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => parseInt(x, 10)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'Не выбраны сотрудники' });
  const today = new Date().toISOString().slice(0, 10);
  const rows = (await db.pool.query('SELECT id, schedule_type FROM hr_employees WHERE id = ANY($1::int[])', [ids])).rows;
  let changed = 0;
  for (const r of rows) {
    if ((r.schedule_type || '') === sched) continue;
    await db.pool.query('UPDATE hr_employees SET schedule_type=$1, updated_at=now() WHERE id=$2', [sched, r.id]);
    await addEvent(r.id, 'schedule', today, { from_text: schedLabel(r.schedule_type), to_text: schedLabel(sched), created_by: req.user.id });
    changed++;
  }
  await db.log(req.user.id, 'hr_set_schedule', `${sched}: ${changed}/${ids.length}`);
  res.json({ ok: true, changed });
});

// Смена статуса (не удаляем физически).
router.post('/api/employee/:id(\\d+)/status', J, async (req, res) => {
  const st = STATUSES.includes(req.body.status) ? req.body.status : null;
  if (!st) return res.status(400).json({ error: 'Неверный статус' });
  const fire = st === 'fired' ? (req.body.fire_date || new Date().toISOString().slice(0, 10)) : null;
  const prev = (await db.pool.query('SELECT status FROM hr_employees WHERE id=$1', [req.params.id])).rows[0];
  await db.pool.query('UPDATE hr_employees SET status=$1, fire_date=COALESCE($2, fire_date), updated_at=now() WHERE id=$3', [st, fire, req.params.id]);
  if (prev && prev.status !== st) {
    if (st === 'fired') await addEvent(parseInt(req.params.id), 'fire', fire, { created_by: req.user.id });
    else if (prev.status === 'fired' && st === 'active') await addEvent(parseInt(req.params.id), 'hire', new Date().toISOString().slice(0, 10), { comment: 'Восстановлен', created_by: req.user.id });
  }
  await db.log(req.user.id, 'hr_employee_status', `#${req.params.id} → ${st}`);
  res.json({ ok: true });
});

// ---------- Кадровая история ----------
router.get('/api/events', async (req, res) => {
  try {
    const p = [], w = [];
    if (req.query.employee_id) { p.push(parseInt(req.query.employee_id)); w.push(`v.employee_id=$${p.length}`); }
    if (req.query.type && EVENT_TYPES.includes(req.query.type)) { p.push(req.query.type); w.push(`v.event_type=$${p.length}`); }
    deptFilter(req.query.department, p, w);
    if (req.query.from) { p.push(req.query.from); w.push(`v.event_date >= $${p.length}`); }
    if (req.query.to) { p.push(req.query.to); w.push(`v.event_date <= $${p.length}`); }
    if (req.query.q) { p.push('%' + String(req.query.q).trim() + '%'); w.push(`e.full_name ILIKE $${p.length}`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const rows = (await db.pool.query(
      `SELECT v.*, e.full_name, d.name AS dept_name FROM hr_events v
         JOIN hr_employees e ON e.id=v.employee_id
         LEFT JOIN hr_departments d ON d.id=e.department_id
       ${where} ORDER BY v.event_date DESC, v.id DESC LIMIT 500`, p)).rows;
    res.json({ items: rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/events', J, async (req, res) => {
  const b = req.body || {};
  const empId = intOrNull(b.employee_id);
  const type = EVENT_TYPES.includes(b.event_type) ? b.event_type : null;
  if (!empId || !type) return res.status(400).json({ error: 'Укажите сотрудника и тип события' });
  if (!b.event_date) return res.status(400).json({ error: 'Укажите дату' });
  let fromText = b.from_text || null, toText = b.to_text || null;
  let recalcNote = [];   // месяцы, которые уже были начислены и пересчитались из-за смены оклада
  // Перемещение из кадровой истории РЕАЛЬНО переводит сотрудника в новый отдел (меняем department_id),
  // а не просто пишет запись в журнал — иначе в зарплате человек остаётся в старом отделе.
  if (type === 'transfer') {
    const toDept = intOrNull(b.to_department_id);
    if (!toDept) return res.status(400).json({ error: 'Выберите отдел, куда переводим' });
    const cur = (await db.pool.query('SELECT department_id, position, schedule_type FROM hr_employees WHERE id=$1', [empId])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Сотрудник не найден' });
    fromText = await deptName(cur.department_id);
    toText = await deptName(toDept);
    await db.pool.query('UPDATE hr_employees SET department_id=$1, updated_at=now() WHERE id=$2', [toDept, empId]);
    // Должность: если указана и изменилась — обновляем в карточке + отдельным событием «смена должности».
    const newPos = (b.to_position != null ? String(b.to_position).trim() : '');
    if (newPos && newPos !== (cur.position || '')) {
      await db.pool.query('UPDATE hr_employees SET position=$1, updated_at=now() WHERE id=$2', [newPos, empId]);
      await addEvent(empId, 'position', b.event_date, { from_text: cur.position || '—', to_text: newPos, created_by: req.user.id });
    }
    // График: если выбран и изменился — обновляем + событие «смена графика».
    const newSched = SCHEDULE_CODES.includes(b.to_schedule) ? b.to_schedule : null;
    if (newSched && newSched !== (cur.schedule_type || '')) {
      await db.pool.query('UPDATE hr_employees SET schedule_type=$1, updated_at=now() WHERE id=$2', [newSched, empId]);
      await addEvent(empId, 'schedule', b.event_date, { from_text: schedLabel(cur.schedule_type), to_text: schedLabel(newSched), created_by: req.user.id });
    }
  }
  // Изменение оклада с даты: пишем в историю окладов, обновляем текущий оклад, пересчитываем месяцы с даты.
  if (type === 'salary') {
    const newSal = numOrNull(b.new_salary);
    if (!(newSal >= 0)) return res.status(400).json({ error: 'Укажите новый оклад' });
    const cur = (await db.pool.query('SELECT base_salary FROM hr_employees WHERE id=$1', [empId])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Сотрудник не найден' });
    fromText = fmtSum(cur.base_salary); toText = fmtSum(newSal);
    await db.pool.query('INSERT INTO hr_salary_history (employee_id, base_salary, effective_from, created_by) VALUES ($1,$2,$3,$4)', [empId, newSal, b.event_date, req.user.id]);
    await db.pool.query('UPDATE hr_employees SET base_salary=$1, updated_at=now() WHERE id=$2', [newSal, empId]);
    // Пересчитать начисление за месяц изменения и все последующие, где уже есть строки зарплаты.
    // Уже начисленные месяцы ТОЖЕ пересчитываем (решение Шоха: иначе оклад изменён, а зарплата
    // считается по-старому и это незаметно) — но возвращаем предупреждение, каких месяцев коснулись.
    const changePeriod = String(b.event_date).slice(0, 7);
    const affected = (await db.pool.query(
      'SELECT DISTINCT period, (accrued_at IS NOT NULL) AS was_accrued FROM hr_payroll WHERE employee_id=$1 AND period >= $2 ORDER BY period',
      [empId, changePeriod])).rows;
    for (const pr of affected) await recomputeAccrFact(empId, pr.period);
    recalcNote = affected.filter((p) => p.was_accrued).map((p) => p.period);
  }
  // Увольнение и приём РЕАЛЬНО меняют карточку — как перевод меняет отдел.
  // Раньше событие ложилось только в журнал: в истории человек уволен, а в
  // «Сотрудниках» он активен и сидит в ФОТ. Одно и то же действие должно
  // давать один и тот же результат, из какого бы места его ни сделали.
  let statusNote = '';
  if (type === 'fire') {
    const cur = (await db.pool.query('SELECT status FROM hr_employees WHERE id=$1', [empId])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Сотрудник не найден' });
    await db.pool.query(
      "UPDATE hr_employees SET status='fired', fire_date=$1, updated_at=now() WHERE id=$2", [b.event_date, empId]);
    statusNote = cur.status === 'fired' ? 'Дата увольнения обновлена' : 'Сотрудник переведён в уволенные';
  } else if (type === 'hire') {
    const cur = (await db.pool.query('SELECT status FROM hr_employees WHERE id=$1', [empId])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Сотрудник не найден' });
    if (cur.status === 'fired') {
      await db.pool.query(
        "UPDATE hr_employees SET status='active', fire_date=NULL, hire_date=$1, updated_at=now() WHERE id=$2",
        [b.event_date, empId]);
      statusNote = 'Сотрудник возвращён в активные';
    }
  }
  await addEvent(empId, type, b.event_date, { date_to: b.date_to || null, from_text: fromText, to_text: toText, comment: b.comment || null, created_by: req.user.id });
  await db.log(req.user.id, 'hr_event_add', `${type} emp#${empId}`);
  res.json({ ok: true, recalculated: recalcNote, status_note: statusNote });
});
router.post('/api/events/:id(\\d+)/delete', async (req, res) => {
  await db.pool.query('DELETE FROM hr_events WHERE id=$1', [req.params.id]);
  await db.log(req.user.id, 'hr_event_delete', '#' + req.params.id);
  res.json({ ok: true });
});

// ---------- Зарплата ----------
function withTotals(row) {
  // Начисление видно ВСЕГДА (это история). accrued_at — просто пометка «начислено» для статуса.
  const accrued = sumF(row, ACCR), deducted = sumF(row, DED_SUM), paid = sumF(row, PAID);
  return Object.assign({}, row, { accrued, deducted, paid, to_pay: Math.max(0, accrued - deducted - paid), posted: !!row.accrued_at });
}
// ---------- Выплаты зарплаты из наличной кассы (производно — всегда в синхроне с кассой) ----------
// Расход наличной кассы со статьёй 20 (ЗП производство) / 40 (Зарплата офиса) → выплата сотруднику.
// ФИО берём из назначения; «аванс» в тексте → аванс наличными, иначе — выплата наличными.
// Период: «за <месяц>» из назначения, иначе месяц даты платежа. Сумма — сум-эквивалент (t.amount).
// Ключи — по первым 3 буквам месяца из назначения (см. slice(0,3) ниже). Для мая нужны «май» и «мая»
// (склонение «за мая»), иначе распознавание падало на месяц даты платежа (баг: «за май» уходил в июнь).
const CS_MONTHS = { янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12 };
const csNorm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
function csPeriod(purpose, txDate) {
  const d = new Date(txDate);
  let y = d.getFullYear(), mon = d.getMonth() + 1;
  const m = csNorm(purpose).match(/за\s+([а-я]{3,})/);
  if (m) { const pm = CS_MONTHS[m[1].slice(0, 3)]; if (pm) { if (pm > mon) y -= 1; mon = pm; } }
  return y + '-' + String(mon).padStart(2, '0');
}
// Сравнение слов по ОСНОВЕ (общий префикс, терпит 1 букву окончания) — под русские склонения:
// «смирнова»≈«смирновой», «полина»≈«полине», «абдушукур»≈«абдушукуру». Порядок ФИО не важен.
function csWordMatch(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return n >= 4 && a.slice(0, 4) === b.slice(0, 4);
  let i = 0; while (i < n && a[i] === b[i]) i++;
  return i >= 5 && i >= n - 1;
}
// Совпадение по числу совпавших слов ФИО; при ничьей (однофамильцы без имени) — не угадываем.
function csMatchEmp(purpose, emps) {
  const words = csNorm(purpose).split(' ').filter((w) => w.length >= 4);
  if (!words.length) return null;
  const scored = emps.map((e) => {
    const parts = csNorm(e.full_name).split(' ').filter((w) => w.length >= 4);
    // уникальное сопоставление: одно слово назначения закрывает максимум одно слово ФИО
    const used = new Set(); let matched = 0;
    for (const nw of parts) { const wi = words.findIndex((w, i) => !used.has(i) && csWordMatch(nw, w)); if (wi >= 0) { used.add(wi); matched++; } }
    return { e, matched };
  }).filter((x) => x.matched >= 1);
  if (!scored.length) return null;
  const max = Math.max(...scored.map((x) => x.matched));
  const top = scored.filter((x) => x.matched === max);
  return top.length === 1 ? top[0].e : null;
}
// Зарплату из кассы ведём начиная с этого периода. Выплаты за более ранние месяцы (напр. «за май»)
// в блок «Зарплата» НЕ попадают — остаются только в кассе как расход. (Начали вести с июня 2026.)
const CS_START_PERIOD = '2026-06';
// Периоды, где наличные из кассы НЕ тянем в зарплату (июнь заводим импортом из файла — иначе двойной счёт).
const CS_CASH_OFF = new Set(['2026-06']);
async function computeCashSalary(period) {
  const byEmp = {}, unmatched = [];
  if (period < CS_START_PERIOD || CS_CASH_OFF.has(period)) return { byEmp, unmatched };
  const cats = (await db.pool.query("SELECT id FROM cash_categories WHERE code IN ('20','40')")).rows.map((r) => r.id);
  if (!cats.length) return { byEmp, unmatched };
  const emps = (await db.pool.query("SELECT id, full_name FROM hr_employees WHERE status <> 'archived'")).rows;
  const txs = (await db.pool.query(
    `SELECT t.id, to_char(t.tx_date,'YYYY-MM-DD') d, t.tx_date, t.amount, t.purpose, COALESCE(t.report_hidden,false) AS hidden
     FROM cash_transactions t JOIN cash_wallets w ON w.id = t.wallet_id AND w.kind = 'cash'
     WHERE t.tx_type = 'out' AND t.category_id = ANY($1)
       -- Расходы, созданные кнопкой «Выплатить», обычно НЕ берём: они уже учтены журналом выплат.
       -- Но если журнальная запись пропала (например, удалили сотрудника), расход остаётся
       -- «осиротевшим» — тогда учитываем его по ФИО из назначения, иначе выплата нигде не видна.
       AND (COALESCE(t.source,'') <> 'hr_payout'
            OR NOT EXISTS (SELECT 1 FROM hr_payouts p WHERE p.cash_tx_id = t.id))`, [cats])).rows;
  for (const t of txs) {
    if (csPeriod(t.purpose, t.tx_date) !== period) continue;
    const kind = /аванс/i.test(t.purpose || '') ? 'advance' : 'salary';
    const amt = Math.round(Number(t.amount) || 0);
    const emp = csMatchEmp(t.purpose, emps);
    if (emp) {
      const b = byEmp[emp.id] || (byEmp[emp.id] = { advance: 0, paid: 0, pay_date: null, txs: [] });
      // Скрытые («не учитывать») — остаются в списке, но не идут в суммы зарплаты (напр. выплата не за этот месяц).
      if (!t.hidden) {
        if (kind === 'advance') b.advance += amt; else b.paid += amt;
        // Дата выплаты — из кассы: берём последнюю (зарплата приоритетнее аванса).
        if (kind !== 'advance' && (!b.pay_date || t.d > b.pay_date)) b.pay_date = t.d;
      }
      b.txs.push({ tx_id: t.id, date: t.d, amount: amt, kind, purpose: t.purpose || '', hidden: !!t.hidden });
    }
    else unmatched.push({ tx_id: t.id, date: t.d, amount: amt, kind, purpose: t.purpose || '', hidden: !!t.hidden });
  }
  return { byEmp, unmatched };
}

router.get('/api/payroll', async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
  const p = [period], w = ["e.status <> 'archived'"];
  deptFilter(req.query.department, p, w);
  if (req.query.schedule && SCHEDULE_CODES.includes(req.query.schedule)) { p.push(req.query.schedule); w.push(`e.schedule_type = $${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).trim() + '%'); w.push(`e.full_name ILIKE $${p.length}`); }
  const rows = (await db.pool.query(
    `SELECT e.id AS emp_id, e.full_name, e.position, e.base_salary, e.schedule_type, e.status AS emp_status, to_char(e.fire_date,'YYYY-MM-DD') AS fire_date, d.name AS department_name, pr.*
     FROM hr_employees e
     LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN hr_payroll pr ON pr.employee_id = e.id AND pr.period = $1
     WHERE ${w.join(' AND ')} ORDER BY e.full_name`, p)).rows.map((r) => { const t = withTotals(r); t.overtime_pay = computePay(r).overtime; return t; });
  let items = rows;
  // Выплаты из наличной кассы за период (производно) — добавляем к каждому сотруднику + список нераспознанных.
  let cashUnmatched = [];
  try {
    const cs = await computeCashSalary(period);
    cashUnmatched = cs.unmatched;
    items.forEach((r) => {
      const b = cs.byEmp[r.emp_id];
      r.cash_advance = b ? b.advance : 0; r.cash_paid = b ? b.paid : 0;
      r.cash_txs = b ? (b.txs || []) : [];
      // Дата выплаты наличными тянется из кассы; своя (ручная/по карте) — в приоритете, если стоит.
      r.cash_pay_date = b && b.pay_date ? b.pay_date : null;
      if (!r.pay_date && r.cash_pay_date) r.pay_date = r.cash_pay_date;
      // Наличная касса — источник наличных выплат: они СРАЗУ считаются в «Выплачено»/«Аванс»
      // и уменьшают «К выплате» (раньше показывались только подсказкой и в остаток не шли).
      r.paid = (Number(r.paid) || 0) + r.cash_paid;
      r.deducted = (Number(r.deducted) || 0) + r.cash_advance;
      // «К выплате» без минуса (переплату не уводим в минус). Начисление видно всегда.
      r.to_pay = Math.max(0, (Number(r.accrued) || 0) - r.deducted - r.paid);
    });
  } catch (e) { console.error('cash salary:', e.message); }
  // Прячем только уволенных ДО этого месяца и без движения. Кто уволен в этом месяце (или позже) —
  // работал часть месяца, его нужно начислить, поэтому показываем. При поиске (q) не прячем никого.
  if (!req.query.q) {
    const monthStart = period + '-01';
    items = items.filter((r) => r.emp_status !== 'fired'
      || (r.fire_date && r.fire_date >= monthStart)
      || (Number(r.accrued) || 0) > 0 || (Number(r.paid) || 0) > 0 || (Number(r.deducted) || 0) > 0);
  }
  // Фильтр по состоянию расчёта — считается по живым цифрам (после учёта наличной кассы),
  // поэтому всегда совпадает с тем, что видно в строке.
  //   accrued — начисление есть; none — начисления нет;
  //   topay   — мы ещё должны сотруднику (в т.ч. выплачено частично);
  //   paid    — начислено и закрыто полностью.
  const st = req.query.status;
  if (st) {
    const acc = (r) => Number(r.accrued) || 0;
    const rest = (r) => Number(r.to_pay) || 0;
    if (st === 'accrued') items = items.filter((r) => acc(r) > 0);
    else if (st === 'none') items = items.filter((r) => acc(r) <= 0);
    else if (st === 'topay') items = items.filter((r) => rest(r) > 0.5);
    else if (st === 'paid') items = items.filter((r) => acc(r) > 0 && rest(r) <= 0.5);
  }
  const sum = (f) => items.reduce((s, r) => s + (Number(r[f]) || 0), 0);
  const summary = {
    accrued: sum('accrued'), deducted: sum('deducted'), paid: sum('paid'), to_pay: sum('to_pay'),
    bonus: sum('accr_bonus'), advances: items.reduce((s, r) => s + (Number(r.ded_advance_card) || 0) + (Number(r.ded_advance_cash) || 0), 0),
    amount_1c: sum('amount_1c'), count: items.length,
    cash_advance: sum('cash_advance'), cash_paid: sum('cash_paid'),
  };
  res.json({ period, items, summary, cash_unmatched: cashUnmatched });
});

// Нормы месяца: сначала сохранённые (hr_norms), если их нет — то, что фактически стоит
// в ведомостях этого месяца. Так окно всегда показывает правду по выбранному месяцу.
router.get('/api/norms', async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
  const norms = {};
  let saved = false;
  for (const r of (await db.pool.query(
    'SELECT schedule_type AS sched, plan_days, plan_hours FROM hr_norms WHERE period = $1', [period])).rows) {
    norms[r.sched] = { plan_days: r.plan_days, plan_hours: r.plan_hours };
    saved = true;
  }
  if (!saved) {
    const rows = (await db.pool.query(
      `SELECT e.schedule_type AS sched, MAX(pr.plan_days) AS plan_days, MAX(pr.plan_hours) AS plan_hours
         FROM hr_employees e JOIN hr_payroll pr ON pr.employee_id = e.id AND pr.period = $1
        WHERE e.status = 'active' AND e.schedule_type IS NOT NULL
          AND (pr.plan_days IS NOT NULL OR pr.plan_hours IS NOT NULL)
        GROUP BY e.schedule_type`, [period])).rows;
    rows.forEach((r) => { norms[r.sched] = { plan_days: r.plan_days, plan_hours: r.plan_hours }; });
  }
  res.json({ period, norms, saved });
});
// Нормы за все месяцы — чтобы видеть историю и не выдумывать цифры заново.
router.get('/api/norms/history', async (req, res) => {
  const rows = (await db.pool.query(
    'SELECT period, schedule_type, plan_days, plan_hours FROM hr_norms ORDER BY period DESC, schedule_type')).rows;
  res.json({ items: rows });
});

// Заполнить плановые нормы (дни/часы) по графикам за месяц — всем активным сотрудникам графика,
// затем пересчитать начисление (для АУП оклад проставится сразу; почасовым — после табеля).
router.post('/api/fill-norms', J, async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
  if (!period) return res.status(400).json({ error: 'Не указан месяц' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
  const norms = req.body.norms || {};
  // Уже начисленные строки не трогаем: иначе повторное заполнение норм пересчитывало
  // тех, кого ты посчитала раньше, и суммы уезжали. Чтобы пересчитать — снять начисление.
  const locked = new Set((await db.pool.query(
    'SELECT employee_id FROM hr_payroll WHERE period = $1 AND accrued_at IS NOT NULL', [period])).rows.map((r) => r.employee_id));
  let count = 0, skipped = 0;
  for (const [sched, v] of Object.entries(norms)) {
    if (!SCHEDULE_CODES.includes(sched)) continue;
    const pd = numOrNull(v.plan_days), ph = numOrNull(v.plan_hours);
    if (pd == null && ph == null) continue;
    // Норма сохраняется за месяц — в следующий раз окно покажет именно её, а не значения по умолчанию.
    await db.pool.query(
      `INSERT INTO hr_norms (period, schedule_type, plan_days, plan_hours, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (period, schedule_type) DO UPDATE SET plan_days=EXCLUDED.plan_days,
         plan_hours=EXCLUDED.plan_hours, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [period, sched, pd, ph, req.user.id]);
    const emps = (await db.pool.query("SELECT id FROM hr_employees WHERE status = 'active' AND schedule_type = $1", [sched])).rows;
    for (const e of emps) {
      if (locked.has(e.id)) { skipped++; continue; }   // строка уже начислена — не пересчитываем
      await db.pool.query(
        `INSERT INTO hr_payroll (employee_id, period, plan_days, plan_hours, created_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (employee_id, period) DO UPDATE SET plan_days = COALESCE($3, hr_payroll.plan_days), plan_hours = COALESCE($4, hr_payroll.plan_hours), updated_at = now()`,
        [e.id, period, pd, ph, req.user.id]);
      await recomputeAccrFact(e.id, period);
      await applyRecurring(e.id, period);   // постоянные надбавки/удержания из карточки
      count++;
    }
  }
  // «Полный месяц» (full_month): факт = план — проставляем автоматически после заполнения норм.
  // Начисленных пропускаем и здесь.
  const fm = await db.pool.query(
    `UPDATE hr_payroll SET fact_days = COALESCE(plan_days, fact_days), fact_hours = COALESCE(plan_hours, fact_hours), updated_at = now()
       WHERE period = $1 AND (plan_days IS NOT NULL OR plan_hours IS NOT NULL) AND accrued_at IS NULL
         AND employee_id IN (SELECT id FROM hr_employees WHERE full_month = true AND status = 'active')`, [period]);
  // Пересчитать начисление у «полного месяца» (факт только что проставили) — чтобы сумма появилась сразу.
  for (const e of (await db.pool.query("SELECT id FROM hr_employees WHERE full_month = true AND status = 'active'")).rows) {
    if (locked.has(e.id)) continue;
    await recomputeAccrFact(e.id, period);
  }
  await db.log(req.user.id, 'hr_fill_norms', `${period}: ${count}, пропущено начисленных ${skipped}, факт=план ${fm.rowCount}`);
  res.json({ ok: true, count, skipped, factFromPlan: fm.rowCount });
});

// Импорт табеля производства: 2 строки на сотрудника (1-я — факт дни/часы, 2-я — переработка дни/часы).
function parseProductionTimesheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sh = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, raw: false, defval: '' });
  const norm = (s) => String(s).toLowerCase().replace(/[\s.]/g, '');
  let hi = aoa.findIndex((r) => r.some((c) => /ф\.?и\.?о/i.test(String(c))));
  if (hi < 0) hi = 0;
  // Столбцы: факт «Дни»/«Часы» и «Переработка (дни)»/«Переработка (часы)».
  let fioCol = -1, dniCol = -1, chasyCol = -1, otDniCol = -1, otChasyCol = -1;
  for (let hr = hi; hr <= hi + 2 && hr < aoa.length; hr++) {
    (aoa[hr] || []).forEach((c, idx) => {
      const n = norm(c);
      if (fioCol < 0 && /фио/.test(n)) fioCol = idx;
      if (/переработка/.test(n)) { if (/час/.test(n) && otChasyCol < 0) otChasyCol = idx; else if (/дн/.test(n) && otDniCol < 0) otDniCol = idx; }
      else { if (n === 'дни' && dniCol < 0) dniCol = idx; if (n === 'часы' && chasyCol < 0) chasyCol = idx; }
    });
  }
  if (fioCol < 0 || dniCol < 0 || chasyCol < 0) return { rows: [], error: 'В файле не нашёл столбцы «Ф.И.О», «Дни», «Часы».' };
  const num = (v) => { const t = String(v).replace(/\s/g, '').replace(',', '.'); const n = parseFloat(t); return isNaN(n) ? 0 : n; };
  const isName = (s) => /[а-яё]{3,}/i.test(s) && !/ф\.?и\.?о|итого/i.test(s);
  const rows = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const fio = String((aoa[i] || [])[fioCol] || '').trim();
    if (!isName(fio)) continue;
    // У сотрудника 2 строки: факт-часы в строке с ФИО, переработка — во второй (без ФИО). Складываем обе.
    const sub = aoa[i + 1] || [];
    const subEmpty = !isName(String(sub[fioCol] || '').trim());
    const g = (col) => (col < 0 ? 0 : num(aoa[i][col]) + (subEmpty ? num(sub[col]) : 0));
    rows.push({ fio, factDays: g(dniCol), factHours: g(chasyCol), otDays: g(otDniCol), otHours: g(otChasyCol) });
  }
  return { rows };
}

router.post('/api/timesheet-import', upload.single('file'), async (req, res) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
    if (!period) return res.status(400).json({ error: 'Не указан месяц' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const parsed = parseProductionTimesheet(req.file.buffer);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (!parsed.rows.length) return res.status(400).json({ error: 'Не нашёл строк сотрудников в табеле.' });
    const emps = (await db.pool.query("SELECT id, full_name FROM hr_employees WHERE status <> 'archived'")).rows;
    let updated = 0; const unmatched = [];
    for (const r of parsed.rows) {
      const emp = csMatchEmp(r.fio, emps);
      if (!emp) { unmatched.push({ fio: r.fio, fact_hours: r.factHours, overtime_hours: r.otHours }); continue; }
      // Факт-часы = отработанные + переработка × 2 (переработка оплачивается вдвойне и «свёрнута» в факт).
      // overtime_hours обнуляем, чтобы начисление не удвоило переработку второй раз. План (часы/дни) не трогаем.
      const factHoursWithOt = (Number(r.factHours) || 0) + (Number(r.otHours) || 0) * 2;
      await db.pool.query(
        `INSERT INTO hr_payroll (employee_id, period, fact_days, fact_hours, overtime_hours, created_by) VALUES ($1,$2,$3,$4,0,$5)
         ON CONFLICT (employee_id, period) DO UPDATE SET fact_days = EXCLUDED.fact_days, fact_hours = EXCLUDED.fact_hours, overtime_hours = 0, updated_at = now()`,
        [emp.id, period, r.factDays, factHoursWithOt, req.user.id]);
      await recomputeAccrFact(emp.id, period);
      updated++;
    }
    await db.log(req.user.id, 'hr_timesheet_import', `${period}: +${updated}, не разнесено ${unmatched.length}`);
    res.json({ ok: true, updated, unmatched });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Точечная правка ОДНОГО поля строки зарплаты (инлайн-редактирование в таблице).
// Обычный /api/payroll перезаписывает всю строку — для одной ячейки он не годится.
// accr_fact правится вручную (после «Начислить»); авто-пересчёт для него НЕ делаем (CELL_RECALC),
// чтобы ручная сумма не затиралась. Правка accr_fact помечает строку начисленной (accrued_at).
const CELL_FIELDS = new Set(['plan_days', 'fact_days', 'plan_hours', 'fact_hours', 'overtime_hours',
  'accr_fact', ...ACCR.filter((f) => f !== 'accr_fact'), 'accr_company_debt', ...DED, ...PAID]);
const CELL_RECALC = ['plan_days', 'fact_days', 'plan_hours', 'fact_hours', 'overtime_hours'];
router.post('/api/payroll/cell', J, async (req, res) => {
  try {
    const b = req.body || {};
    const empId = intOrNull(b.employee_id);
    const period = /^\d{4}-\d{2}$/.test(b.period) ? b.period : null;
    const field = String(b.field || '');
    if (!empId || !period) return res.status(400).json({ error: 'Нет сотрудника или периода' });
    { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
    if (!CELL_FIELDS.has(field)) return res.status(400).json({ error: 'Это поле нельзя менять здесь' });
    const val = numOrNull(b.value);
    await db.pool.query(
      `INSERT INTO hr_payroll (employee_id, period, ${field}, created_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (employee_id, period) DO UPDATE SET ${field} = EXCLUDED.${field}, updated_at = now()`,
      [empId, period, val, req.user.id]);
    if (CELL_RECALC.includes(field)) await recomputeAccrFact(empId, period);  // часы/дни меняют оклад
    // Ручная правка начисления — сразу считается начисленной (показывается в ведомости/дашборде).
    if (field === 'accr_fact') await db.pool.query("UPDATE hr_payroll SET accrued_at=COALESCE(accrued_at, now()), status=CASE WHEN status='draft' THEN 'accrued' ELSE status END WHERE employee_id=$1 AND period=$2", [empId, period]);
    await db.log(req.user.id, 'hr_payroll_cell', `emp ${empId} ${period} ${field}=${val}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/payroll', J, async (req, res) => {
  const b = req.body || {};
  const empId = intOrNull(b.employee_id);
  const period = /^\d{4}-\d{2}$/.test(b.period) ? b.period : null;
  if (!empId || !period) return res.status(400).json({ error: 'Нет сотрудника или периода' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
  const status = ['draft', 'accrued', 'approved', 'paid', 'cancelled'].includes(b.status) ? b.status : 'draft';
  const cols = ['plan_days', 'fact_days', 'plan_hours', 'fact_hours', ...ACCR_ALL, ...DED, ...PAID, 'amount_1c'];
  const vals = cols.map((c) => numOrNull(b[c]));
  const allCols = ['employee_id', 'period', 'status', ...cols, 'pay_date', 'pay_method', 'comment'];
  const allVals = [empId, period, status, ...vals, b.pay_date || null, b.pay_method || null, b.comment || null];
  const ph = allVals.map((_, i) => '$' + (i + 1)).join(',');
  const upd = allCols.slice(2).map((c) => `${c}=EXCLUDED.${c}`).join(', ');
  try {
    await db.pool.query(
      `INSERT INTO hr_payroll (${allCols.join(',')}, created_by) VALUES (${ph}, $${allVals.length + 1})
       ON CONFLICT (employee_id, period) DO UPDATE SET ${upd}, updated_at=now()`,
      [...allVals, req.user.id]);
    // Видимость зарплаты: черновик — скрыт (accrued_at=NULL), любой другой статус — начислено.
    await db.pool.query(
      "UPDATE hr_payroll SET accrued_at = CASE WHEN status='draft' THEN NULL ELSE COALESCE(accrued_at, now()) END WHERE employee_id=$1 AND period=$2",
      [empId, period]);
    await db.log(req.user.id, 'hr_payroll_save', `emp ${empId} ${period} ${status}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// «Начислить» — явный расчёт по факту для выбранных сотрудников за месяц.
// Считает оклад по формуле (дневная ставка × факт-дни / часы), пишет в accr_fact и помечает
// строку начисленной (accrued_at). У кого нет факта (база 0) — пропускаем. До этого зарплата не видна.
router.post('/api/payroll/accrue', J, async (req, res) => {
  try {
    const b = req.body || {};
    const period = /^\d{4}-\d{2}$/.test(b.period) ? b.period : null;
    if (!period) return res.status(400).json({ error: 'Не указан месяц' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
    const ids = Array.isArray(b.employee_ids) ? b.employee_ids.map((x) => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Не выбраны сотрудники' });
    // Уже начисленных не пересчитываем — их суммы зафиксированы. Чтобы пересчитать,
    // сначала «Отменить начисление» у нужных строк.
    const locked = new Set((await db.pool.query(
      'SELECT employee_id FROM hr_payroll WHERE period = $1 AND accrued_at IS NOT NULL AND employee_id = ANY($2::int[])',
      [period, ids])).rows.map((r) => r.employee_id));
    let done = 0, skipped = 0, already = 0;
    for (const empId of ids) {
      if (locked.has(empId)) { already++; continue; }
      const base = await recomputeAccrFact(empId, period);
      await applyRecurring(empId, period);   // постоянные суммы из карточки — в пустые ячейки
      if (base > 0) {
        await db.pool.query(
          "UPDATE hr_payroll SET accrued_at=now(), status=CASE WHEN status='draft' THEN 'accrued' ELSE status END WHERE employee_id=$1 AND period=$2",
          [empId, period]);
        done++;
      } else skipped++;   // нет факта — не начисляем
    }
    await db.log(req.user.id, 'hr_payroll_accrue', `${period}: начислено ${done}, без факта ${skipped}, уже было ${already}`);
    res.json({ ok: true, done, skipped, already });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// «Отменить начисление» — снять accrued_at у выбранных (факт/дни остаются, зарплата снова скрыта).
router.post('/api/payroll/unaccrue', J, async (req, res) => {
  try {
    const b = req.body || {};
    const period = /^\d{4}-\d{2}$/.test(b.period) ? b.period : null;
    if (!period) return res.status(400).json({ error: 'Не указан месяц' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
    const ids = Array.isArray(b.employee_ids) ? b.employee_ids.map((x) => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Не выбраны сотрудники' });
    const r = await db.pool.query(
      "UPDATE hr_payroll SET accrued_at=NULL, status=CASE WHEN status='accrued' THEN 'draft' ELSE status END WHERE period=$1 AND employee_id = ANY($2::int[])",
      [period, ids]);
    await db.log(req.user.id, 'hr_payroll_unaccrue', `${period}: ${r.rowCount}`);
    res.json({ ok: true, affected: r.rowCount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Оптом «Факт = план» выбранным (для офисных: отработали весь месяц). Копирует plan_days/plan_hours в факт.
// Нужны заполненные нормы (plan). У кого строки/плана нет — пропускаем.
router.post('/api/payroll/fact-from-plan', J, async (req, res) => {
  try {
    const b = req.body || {};
    const period = /^\d{4}-\d{2}$/.test(b.period) ? b.period : null;
    if (!period) return res.status(400).json({ error: 'Не указан месяц' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
    const ids = Array.isArray(b.employee_ids) ? b.employee_ids.map((x) => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Не выбраны сотрудники' });
    // Начисленные строки не трогаем — их суммы зафиксированы.
    const locked = new Set((await db.pool.query(
      'SELECT employee_id FROM hr_payroll WHERE period = $1 AND accrued_at IS NOT NULL AND employee_id = ANY($2::int[])',
      [period, ids])).rows.map((r2) => r2.employee_id));
    const open = ids.filter((id) => !locked.has(id));
    if (!open.length) return res.json({ ok: true, affected: 0, already: locked.size });
    const r = await db.pool.query(
      `UPDATE hr_payroll SET fact_days = COALESCE(plan_days, fact_days), fact_hours = COALESCE(plan_hours, fact_hours), updated_at=now()
       WHERE period=$1 AND employee_id = ANY($2::int[]) AND accrued_at IS NULL`, [period, open]);
    for (const empId of open) await recomputeAccrFact(empId, period);   // пересчитать начисление сразу
    await db.log(req.user.id, 'hr_payroll_fact_from_plan', `${period}: ${r.rowCount}, пропущено начисленных ${locked.size}`);
    res.json({ ok: true, affected: r.rowCount, already: locked.size });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Табель ----------
// Сохранение табеля: трогаем ТОЛЬКО дни/часы, деньги начислений не задеваем.
// (Обычный /api/payroll перезаписывает все колонки — для табеля он не годится.)
router.post('/api/timesheet', J, async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
  if (!period) return res.status(400).json({ error: 'Нет периода' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Нет строк' });
  const client = await db.pool.connect();
  let saved = 0;
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const empId = intOrNull(r.employee_id);
      if (!empId) continue;
      await client.query(
        `INSERT INTO hr_payroll (employee_id, period, plan_days, fact_days, plan_hours, fact_hours, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (employee_id, period) DO UPDATE SET
           plan_days=EXCLUDED.plan_days, fact_days=EXCLUDED.fact_days,
           plan_hours=EXCLUDED.plan_hours, fact_hours=EXCLUDED.fact_hours, updated_at=now()`,
        [empId, period, numOrNull(r.plan_days), numOrNull(r.fact_days), numOrNull(r.plan_hours), numOrNull(r.fact_hours), req.user.id]);
      saved++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); return res.status(400).json({ error: e.message }); }
  finally { client.release(); }
  await db.log(req.user.id, 'hr_timesheet_save', `${period}: ${saved}`);
  res.json({ ok: true, saved });
});

// Массовое удаление начислений (сотрудники остаются).
router.post('/api/payroll/bulk-delete', J, async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => parseInt(x)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Ничего не выбрано' });
  // Среди выбранных не должно быть строк закрытого месяца.
  { const _e = await hrLockError(...(await periodsOfPayrollIds(ids))); if (_e) return res.status(423).json({ error: _e }); }
  const r = await db.pool.query('DELETE FROM hr_payroll WHERE id = ANY($1)', [ids]);
  await db.log(req.user.id, 'hr_payroll_bulk_delete', String(ids.length));
  res.json({ ok: true, affected: r.rowCount });
});

// Скрыть/вернуть строки «Выплаты из кассы без сотрудника» (только визуально — касса и суммы не меняются).
router.post('/api/salary/cash-hide', J, async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => parseInt(x)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Ничего не выбрано' });
  const hidden = !!req.body.hidden;
  await db.pool.query('UPDATE cash_transactions SET report_hidden=$1 WHERE id = ANY($2)', [hidden, ids]);
  await db.log(req.user.id, hidden ? 'hr_cash_hide' : 'hr_cash_unhide', String(ids.length));
  res.json({ ok: true, count: ids.length, hidden });
});

// ---------- Массовые операции ----------
// Начислить выбранным сотрудникам за период по одной статье (бонусы/ГСМ/больничные/…).
// Массовые операции: начисления + удержания (штрафы/удержания). Оклад (accr_fact) — только авторасчёт.
// Авансы тоже здесь: их выдают сразу многим и обычно одинаковой суммой,
// а до этого приходилось открывать карточку каждого сотрудника.
const MASS_FIELDS = new Set(['accr_bonus', 'accr_premium', 'accr_gsm', 'accr_company_debt', 'accr_other', ...ACCR_EXTRA,
  'ded_fine', 'ded_hold', 'ded_advance_cash', 'ded_advance_card']);
router.post('/api/mass-op', J, async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
  const field = req.body.field;
  if (!period) return res.status(400).json({ error: 'Нет периода' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
  if (!MASS_FIELDS.has(field)) return res.status(400).json({ error: 'Неверная операция' });
  const mode = req.body.mode === 'set' ? 'set' : 'add';
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const client = await db.pool.connect();
  let applied = 0;
  try {
    await client.query('BEGIN');
    for (const it of items) {
      const empId = intOrNull(it.employee_id);
      const amt = numOrNull(it.amount);
      if (!empId || amt == null) continue;
      const upd = mode === 'set' ? `${field}=EXCLUDED.${field}` : `${field}=COALESCE(hr_payroll.${field},0)+EXCLUDED.${field}`;
      await client.query(
        `INSERT INTO hr_payroll (employee_id, period, ${field}, created_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (employee_id, period) DO UPDATE SET ${upd}, updated_at=now()`,
        [empId, period, amt, req.user.id]);
      applied++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
  finally { client.release(); }
  await db.log(req.user.id, 'hr_mass_op', `${field} ${mode} ${applied} шт ${period}`);
  res.json({ ok: true, applied });
});

// ---------- Дашборд ----------
// ---------- Выплаты (реестр выдачи зарплаты) ----------
// Срок выплаты за месяц — до 10 числа СЛЕДУЮЩЕГО месяца (после — «просрочено»).
function payoutDue(period) { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 10)).toISOString().slice(0, 10); }
// Строки выплат за период: К выплате (net на руки) / Выплачено / Остаток / статус.
async function computePayouts(period) {
  const rows = (await db.pool.query(
    `SELECT e.id AS emp_id, e.full_name, e.department_id, e.status AS emp_status, d.name AS department_name, pr.*
     FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN hr_payroll pr ON pr.employee_id = e.id AND pr.period = $1
     WHERE e.status <> 'archived' ORDER BY e.full_name`, [period])).rows.map(withTotals);
  try {
    const cs = await computeCashSalary(period);
    rows.forEach((r) => { const b = cs.byEmp[r.emp_id]; r.paid = (Number(r.paid) || 0) + (b ? b.paid : 0); r.deducted = (Number(r.deducted) || 0) + (b ? b.advance : 0); });
  } catch (e) { /* ignore */ }
  const pos = (await db.pool.query(
    "SELECT employee_id, id, amount, method, to_char(pay_date,'YYYY-MM-DD') pay_date, comment FROM hr_payouts WHERE period = $1 ORDER BY pay_date, id", [period])).rows;
  const byEmp = {}; pos.forEach((x) => { (byEmp[x.employee_id] = byEmp[x.employee_id] || []).push(x); });
  const overdue = new Date().toISOString().slice(0, 10) > payoutDue(period);
  return rows.map((r) => {
    const net = (Number(r.accrued) || 0) - (Number(r.deducted) || 0);   // на руки = начислено − удержания − авансы
    const paid = Number(r.paid) || 0;
    const remainder = Math.max(0, net - paid);
    let status;
    if (remainder <= 0.5 && net > 0.5) status = 'paid';
    // Начисления нет, но деньги выданы — это не «пусто», а выплата без начисления.
    // Такую строку прятать нельзя: иначе выданные деньги пропадают из вкладки.
    else if (net <= 0.5 && paid > 0.5) status = 'no_accrual';
    else if (net <= 0.5) status = 'none';
    else if (overdue) status = 'overdue';
    else if (paid > 0.5) status = 'partial';
    else status = 'pending';
    return { emp_id: r.emp_id, full_name: r.full_name, department_id: r.department_id, department_name: r.department_name || null, emp_status: r.emp_status,
      accrued: Number(r.accrued) || 0, deducted: Number(r.deducted) || 0,
      net, paid, remainder, status, payouts: byEmp[r.emp_id] || [] };
  });
}
// ===========================================================================
// Расчёты с сотрудниками: накопительно за всё время
// ===========================================================================
// Кадры живут помесячно, и вопрос «сколько мы вообще должны человеку» задать
// было негде. Считаем тем же кодом, что и вкладка «Выплаты» (computePayouts),
// просто по всем месяцам сразу — иначе две правды разойдутся при первой правке.
//
// Старт — июнь 2026: раньше данные неполные, и накопленный остаток был бы
// выдуман. Ровно та же причина, по которой в Закупе есть SETTLE_START.
const HR_SETTLE_START = '2026-06';

function periodsSince(start) {
  const out = [];
  const [sy, sm] = start.split('-').map(Number);
  const now = new Date();
  let y = sy, m = sm;
  for (let i = 0; i < 120; i++) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    if (y > now.getFullYear() || (y === now.getFullYear() && m >= now.getMonth() + 1)) break;
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// Расчёты ведём по годам: 2026-й — с июня по декабрь, дальше календарные.
// Долг на границе года НЕ обнуляется: сколько не доплатили в декабре, столько
// и переходит на 1 января входящим остатком — как стартовый долг у поставщиков.
const HR_YEAR_FIRST = 2026;

router.get('/api/settlements', async (req, res) => {
  try {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonthNo = now.getMonth() + 1;
    const years = [];
    for (let y = HR_YEAR_FIRST; y <= Math.max(curYear, HR_YEAR_FIRST); y++) years.push(y);

    let year = parseInt(req.query.year, 10);
    if (!years.includes(year)) year = years[years.length - 1];
    const lastMonthOfYear = year === curYear ? curMonthNo : 12;
    let upto = parseInt(req.query.upto, 10);
    if (!(upto >= 1 && upto <= lastMonthOfYear)) upto = lastMonthOfYear;

    const firstMonthOfYear = year === HR_YEAR_FIRST ? Number(HR_SETTLE_START.slice(5, 7)) : 1;
    const ym = (y, m) => y + '-' + String(m).padStart(2, '0');
    const yearPeriods = [];
    for (let m = firstMonthOfYear; m <= upto; m++) yearPeriods.push(ym(year, m));
    // Всё, что было до выбранного года, нужно только чтобы получить входящий остаток.
    const before = periodsSince(HR_SETTLE_START).filter((p) => p < ym(year, firstMonthOfYear));

    const emp = new Map();      // emp_id → карточка
    const touch = (r) => {
      let e = emp.get(r.emp_id);
      if (!e) {
        e = { emp_id: r.emp_id, full_name: r.full_name, department_id: r.department_id,
          department_name: r.department_name, emp_status: r.emp_status,
          opening: 0, accrued: 0, deducted: 0, net: 0, paid: 0, months: [] };
        emp.set(r.emp_id, e);
      }
      return e;
    };

    // 1) Входящий остаток: прогоняем прошлые годы, но в лицевой счёт их не кладём.
    for (const period of before) {
      for (const r of await computePayouts(period)) {
        if (!(r.accrued > 0.5 || r.deducted > 0.5 || r.paid > 0.5)) continue;
        touch(r).opening += r.net - r.paid;
      }
    }
    // 2) Месяцы выбранного года — с движениями и накопленным остатком.
    const chart = yearPeriods.map((period) => ({ period, accrued: 0, paid: 0, balance: 0 }));
    for (let i = 0; i < yearPeriods.length; i++) {
      const period = yearPeriods[i];
      for (const r of await computePayouts(period)) {
        const e = touch(r);
        const empty = !(r.accrued > 0.5 || r.deducted > 0.5 || r.paid > 0.5);
        if (empty) continue;
        e.accrued += r.accrued; e.deducted += r.deducted; e.net += r.net; e.paid += r.paid;
        e.months.push({ period, accrued: r.accrued, deducted: r.deducted, net: r.net, paid: r.paid,
          remainder: r.net - r.paid, pay_dates: (r.payouts || []).map((p) => p.pay_date).filter(Boolean) });
        chart[i].accrued += r.accrued; chart[i].paid += r.paid;
      }
    }

    const items = [];
    emp.forEach((e) => {
      // Остаток копим сквозным итогом от входящего: переплата одного месяца
      // гасит долг другого, иначе у человека были бы сразу долг и переплата.
      let run = e.opening;
      e.months.forEach((m) => { run += m.remainder; m.balance = run; });
      const balance = run;
      let since = null;
      for (let i = e.months.length - 1; i >= 0; i--) {
        if (e.months[i].balance <= 0.5) break;
        since = e.months[i].period;
      }
      if (!e.months.length && Math.abs(balance) < 0.5) return;   // ни движений, ни долга
      const lastPay = e.months.reduce((acc, m) => m.pay_dates.reduce((a, d) => (a && a > d ? a : d), acc), null);
      items.push({ ...e, balance, since: since || (e.opening > 0.5 && !e.months.length ? 'opening' : since), last_pay_date: lastPay });
    });

    // Общий долг компании на конец каждого месяца — для линии на графике.
    chart.forEach((c, i) => {
      c.balance = items.reduce((s, x) => {
        const m = x.months.filter((mm) => mm.period <= chart[i].period);
        return s + (m.length ? m[m.length - 1].balance : x.opening);
      }, 0);
    });

    items.sort((a, b) => b.balance - a.balance || a.full_name.localeCompare(b.full_name));
    const totals = items.reduce((s, x) => ({
      opening: s.opening + x.opening, accrued: s.accrued + x.accrued, paid: s.paid + x.paid,
      debt: s.debt + Math.max(0, x.balance), overpaid: s.overpaid + Math.max(0, -x.balance),
    }), { opening: 0, accrued: 0, paid: 0, debt: 0, overpaid: 0 });

    // Где долг сосредоточен — по отделам.
    const byDeptMap = new Map();
    items.forEach((x) => {
      const key = x.department_name || 'Без отдела';
      const d = byDeptMap.get(key) || { name: key, people: 0, accrued: 0, paid: 0, debt: 0 };
      d.people += 1; d.accrued += x.accrued; d.paid += x.paid; d.debt += Math.max(0, x.balance);
      byDeptMap.set(key, d);
    });
    const byDept = [...byDeptMap.values()].sort((a, b) => b.debt - a.debt || b.accrued - a.accrued);

    res.json({
      start: HR_SETTLE_START, years, year, upto, last_month: lastMonthOfYear,
      first_month: firstMonthOfYear, items, totals, by_dept: byDept, chart, count: items.length,
    });
  } catch (e) {
    console.error('[КАДРЫ] расчёты:', e.message);
    res.status(400).json({ error: e.message });
  }
});

router.get('/api/payouts', async (req, res) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
    let items = await computePayouts(period);
    // «Нет начисления» и уволенных без остатка к выплате в список выплат не показываем.
    // Строку показываем всегда, если по ней есть выплаты — иначе выданные деньги исчезают
    // из вкладки (так август показывал «Выплачено 0» при реально выплаченных 12 млн).
    items = items.filter((x) => (Number(x.paid) || 0) > 0.5
      || (x.status !== 'none' && !(x.emp_status === 'fired' && x.remainder <= 0.5)));
    items = deptFilterMem(req.query.department, items);
    if (req.query.q) { const q = String(req.query.q).trim().toLowerCase(); items = items.filter((x) => (x.full_name || '').toLowerCase().includes(q)); }
    const summary = items.reduce((s, x) => ({ net: s.net + x.net, paid: s.paid + x.paid, remainder: s.remainder + x.remainder, overdue: s.overdue + (x.status === 'overdue' ? x.remainder : 0) }), { net: 0, paid: 0, remainder: 0, overdue: 0 });
    if (req.query.status) items = items.filter((x) => x.status === req.query.status);
    // Наличные выплаты из Кассы, которые не удалось привязать к сотруднику по ФИО —
    // показываем во вкладке «Выплаты» (это про выдачу денег, а не про расчёт).
    let cashUnmatched = [];
    try { cashUnmatched = (await computeCashSalary(period)).unmatched; } catch (e) { /* не критично */ }
    res.json({ period, due: payoutDue(period), items, summary, count: items.length, cash_unmatched: cashUnmatched });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Выгрузка «К выплате» в Excel (те же фильтры, что в списке; уволенных без остатка и «нет начисления» не берём).
router.get('/api/payouts-export.xlsx', async (req, res) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
    let items = await computePayouts(period);
    // Строку показываем всегда, если по ней есть выплаты — иначе выданные деньги исчезают
    // из вкладки (так август показывал «Выплачено 0» при реально выплаченных 12 млн).
    items = items.filter((x) => (Number(x.paid) || 0) > 0.5
      || (x.status !== 'none' && !(x.emp_status === 'fired' && x.remainder <= 0.5)));
    items = deptFilterMem(req.query.department, items);
    if (req.query.q) { const q = String(req.query.q).trim().toLowerCase(); items = items.filter((x) => (x.full_name || '').toLowerCase().includes(q)); }
    const ST = { pending: 'Ожидает', partial: 'Частично', overdue: 'Просрочено', paid: 'Выплачено' };
    const payDates = (x) => (x.payouts || []).map((p) => p.pay_date).filter(Boolean).join(', ');
    const aoa = [['ФИО', 'Отдел', 'К выплате', 'Выплачено', 'Дата выплаты', 'Остаток', 'Статус']];
    items.forEach((x) => aoa.push([x.full_name || '', x.department_name || '', Math.round(x.net), Math.round(x.paid), payDates(x), Math.round(x.remainder), ST[x.status] || x.status]));
    aoa.push(['ИТОГО', '', Math.round(items.reduce((s, x) => s + x.net, 0)), Math.round(items.reduce((s, x) => s + x.paid, 0)), '', Math.round(items.reduce((s, x) => s + x.remainder, 0)), '']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 28 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 12 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'К выплате');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="k_vyplate_${period}.xlsx"`);
    res.send(buf);
  } catch (e) { res.status(400).send('Ошибка выгрузки: ' + e.message); }
});
// Назначение расхода в Кассе по выплате зарплаты: обязательно с ФИО, чтобы в Кассе было видно,
// кому выдали. Один человек — фамилия целиком; несколько — до трёх фамилий и «и ещё N».
function payoutPurpose(g, period) {
  // period пустой — значит заголовок уже готов (пересборка назначения при отмене выплаты).
  const head = period ? `${g.label} за ${period}` : String(g.label || 'Зарплата');
  const names = (g.names || []).filter(Boolean);
  if (!names.length) return `${head} (${g.ids.length} чел.)`;
  if (names.length <= 3) return `${head} · ${names.join(', ')}`;
  return `${head} · ${names.slice(0, 3).join(', ')} и ещё ${names.length - 3} (всего ${names.length} чел.)`;
}

// Провести выплату(ы): по каждому сотруднику — остаток (или заданная сумма для одного = частичная).
router.post('/api/payouts/pay', J, async (req, res) => {
  const b = req.body || {};
  const period = /^\d{4}-\d{2}$/.test(b.period) ? b.period : null;
  if (!period) return res.status(400).json({ error: 'Нет периода' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
  const method = b.method === 'card' ? 'card' : 'cash';
  const payDate = b.pay_date || new Date().toISOString().slice(0, 10);
  const comment = b.comment || null;
  const ids = Array.isArray(b.employee_ids) ? b.employee_ids.map((x) => parseInt(x)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'Не выбраны сотрудники' });
  const fixed = (b.amount != null && b.amount !== '') ? Number(b.amount) : null;
  const rows = await computePayouts(period);
  const remBy = {}, deptBy = {}, nameBy = {};
  rows.forEach((r) => { remBy[r.emp_id] = r.remainder; deptBy[r.emp_id] = r.department_name || ''; nameBy[r.emp_id] = r.full_name || ''; });
  const col = method === 'card' ? 'paid_card' : 'paid_cash';
  // Группа для статьи Кассы: АУП/Бухгалтерия/Продажи → «Зарплата офиса» (код 40), остальные → «ЗП производство» (код 20).
  const groupOf = (name) => (/ауп|бухгалт|продаж/i.test(name || '') ? 'office' : 'prod');
  const client = await db.pool.connect();
  let done = 0, total = 0, cashNote = null;
  try {
    await client.query('BEGIN');
    const groups = { office: { code: '40', label: 'Зарплата офис', ids: [], total: 0, names: [] }, prod: { code: '20', label: 'Зарплата производство', ids: [], total: 0, names: [] } };
    for (const id of ids) {
      const rem = remBy[id] || 0;
      let amt = (fixed != null && ids.length === 1) ? fixed : rem;
      if (amt > rem + 0.5) amt = rem;             // не платим сверх остатка
      if (!(amt > 0)) continue;
      const po = await client.query('INSERT INTO hr_payouts (employee_id, period, amount, method, pay_date, comment, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [id, period, amt, method, payDate, comment, req.user.id]);
      await client.query(`INSERT INTO hr_payroll (employee_id, period, ${col}, created_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (employee_id, period) DO UPDATE SET ${col} = COALESCE(hr_payroll.${col},0) + $3, updated_at = now()`, [id, period, amt, req.user.id]);
      if (method === 'cash') { const g = groups[groupOf(deptBy[id])]; g.ids.push(po.rows[0].id); g.total += amt; g.names.push(nameBy[id] || ('#' + id)); }
      done++; total += amt;
    }
    // Наличные → авто-расход в Кассе: отдельно офис (ст. 40) и производство (ст. 20), со связью на выплаты.
    if (method === 'cash' && done) {
      const w = (await client.query("SELECT id FROM cash_wallets WHERE kind='cash' AND status='active' ORDER BY sort_order, id LIMIT 1")).rows[0];
      if (!w) cashNote = 'Наличная касса не найдена — расход в Кассе не создан, выплаты записаны.';
      else for (const key of ['office', 'prod']) {
        const g = groups[key];
        if (!(g.total > 0)) continue;
        const cat = (await client.query('SELECT id FROM cash_categories WHERE code=$1 LIMIT 1', [g.code])).rows[0];
        const tx = await client.query(
          `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, is_classified, created_by)
           VALUES ($1,$2,'out',$3,$4,$5,'hr_payout',$6,$7) RETURNING id`,
          [payDate, Number(g.total.toFixed(2)), w.id, cat ? cat.id : null, payoutPurpose(g, period), !!cat, req.user.id]);
        await client.query('UPDATE hr_payouts SET cash_tx_id=$1 WHERE id = ANY($2)', [tx.rows[0].id, g.ids]);
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
  finally { client.release(); }
  await db.log(req.user.id, 'hr_payout', `${period} ${method}: ${done} на ${Math.round(total)}`);
  res.json({ ok: true, count: done, total, cashNote });
});

// Отмена (удаление) выплаты: убирает запись из журнала, возвращает сумму в «К выплате»
// и синхронизирует Кассу. Наличные выплаты группируются в одну транзакцию Кассы на несколько
// человек: если после отмены в группе ещё остались выплаты — уменьшаем сумму транзакции,
// если это была последняя — транзакцию удаляем целиком.
router.post('/api/payouts/:id(\\d+)/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query(
      'SELECT employee_id, period, amount, method, cash_tx_id FROM hr_payouts WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Выплата не найдена' }); }
    { const _e = await hrLockError(p.period); if (_e) { await client.query('ROLLBACK'); return res.status(423).json({ error: _e }); } }
    const amt = Number(p.amount) || 0;
    const col = p.method === 'card' ? 'paid_card' : 'paid_cash';
    // Возвращаем сумму в ведомость (не уводим в минус).
    await client.query(
      `UPDATE hr_payroll SET ${col} = GREATEST(COALESCE(${col},0) - $1, 0), updated_at = now()
       WHERE employee_id = $2 AND period = $3`, [amt, p.employee_id, p.period]);
    await client.query('DELETE FROM hr_payouts WHERE id=$1', [id]);
    let cashNote = null;
    if (p.cash_tx_id) {
      const left = (await client.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS s FROM hr_payouts WHERE cash_tx_id=$1', [p.cash_tx_id])).rows[0];
      if (!left.n) {
        await client.query('DELETE FROM cash_transactions WHERE id=$1', [p.cash_tx_id]);
        cashNote = 'Расход в Кассе удалён';
      } else {
        // Пересобираем и назначение: в нём перечислены ФИО, а один человек из группы выбыл.
        const rest = (await client.query(
          `SELECT e.full_name FROM hr_payouts po JOIN hr_employees e ON e.id = po.employee_id
            WHERE po.cash_tx_id = $1 ORDER BY e.full_name`, [p.cash_tx_id])).rows.map((x) => x.full_name);
        const old = (await client.query('SELECT purpose FROM cash_transactions WHERE id=$1', [p.cash_tx_id])).rows[0];
        const head = String((old && old.purpose) || '').split(' · ')[0].replace(/\s*\(\d+\s*чел\..*$/, '');
        await client.query('UPDATE cash_transactions SET amount=$1, purpose=$2 WHERE id=$3',
          [Number(left.s), payoutPurpose({ label: head, ids: rest, names: rest }, ''), p.cash_tx_id]);
        cashNote = 'Сумма расхода в Кассе уменьшена';
      }
    }
    await client.query('COMMIT');
    await db.log(req.user.id, 'hr_payout_delete', `#${id} emp=${p.employee_id} ${p.period} ${p.method} ${Math.round(amt)}`);
    res.json({ ok: true, cashNote });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Налоги на ФОТ за месяц (ИНПС/НДФЛ/соцналог) — ручной ввод.
router.get('/api/fot-taxes', async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
  const r = (await db.pool.query('SELECT inps, ndfl, social FROM hr_fot_taxes WHERE period=$1', [period])).rows[0]
    || { inps: 0, ndfl: 0, social: 0 };
  res.json(r);
});
router.post('/api/fot-taxes', J, async (req, res) => {
  const b = req.body || {};
  const period = /^\d{4}-\d{2}$/.test(b.period) ? b.period : null;
  if (!period) return res.status(400).json({ error: 'Не указан месяц' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
  const inps = numOrNull(b.inps) || 0, ndfl = numOrNull(b.ndfl) || 0, social = numOrNull(b.social) || 0;
  await db.pool.query(
    `INSERT INTO hr_fot_taxes (period, inps, ndfl, social, updated_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (period) DO UPDATE SET inps=EXCLUDED.inps, ndfl=EXCLUDED.ndfl, social=EXCLUDED.social, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [period, inps, ndfl, social, req.user.id]);
  await db.log(req.user.id, 'hr_fot_taxes', `${period}: инпс ${inps}, ндфл ${ndfl}, соц ${social}`);
  res.json({ ok: true });
});

router.get('/api/dashboard', async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
  const rows = (await db.pool.query(
    `SELECT e.id AS emp_id, e.full_name, d.name AS dept, pr.*
     FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN hr_payroll pr ON pr.employee_id = e.id AND pr.period = $1
     WHERE e.status <> 'archived'`, [period])).rows.map(withTotals);   // как в «Зарплате»: уволенные за месяц тоже в ФОТ
  // Выплаты из наличной кассы — тот же учёт, что в «Зарплате», иначе дашборд снова разойдётся (ТЗ п.6).
  try {
    const cs = await computeCashSalary(period);
    rows.forEach((r) => {
      const b = cs.byEmp[r.emp_id];
      r.cash_advance = b ? b.advance : 0;
      r.paid = (Number(r.paid) || 0) + (b ? b.paid : 0);
      r.deducted = (Number(r.deducted) || 0) + (b ? b.advance : 0);
      r.to_pay = (Number(r.accrued) || 0) - r.deducted - r.paid;
    });
  } catch (e) { console.error('cash salary (dashboard):', e.message); }
  // Авансы (карта + наличные + касса) — выделяем, чтобы на дашборде плюсовать к «Выплачено».
  const advOf = (r) => (Number(r.ded_advance_card) || 0) + (Number(r.ded_advance_cash) || 0) + (Number(r.cash_advance) || 0);
  const byDept = {};
  rows.forEach((r) => { const d = r.dept || 'Без отдела'; const o = byDept[d] = byDept[d] || { name: d, count: 0, accrued: 0, to_pay: 0, paid: 0 }; o.count++; o.accrued += r.accrued; o.to_pay += r.to_pay; o.paid += r.paid; });
  const deptArr = Object.values(byDept).sort((a, b) => b.accrued - a.accrued);
  const totals = {
    accrued: rows.reduce((s, r) => s + r.accrued, 0),
    // Остаток к выплате — как во вкладке «Выплаты»: по человеку не уходит в минус (переплата не гасит чужой долг).
    to_pay: rows.reduce((s, r) => s + Math.max(0, r.to_pay), 0),
    // Порог тот же, что у списка «кому переплачено» ниже (−0.5), иначе копеечный минус от
    // округления давал «переплату» в итоге при пустом списке.
    overpay: rows.reduce((s, r) => s + (r.to_pay < -0.5 ? -r.to_pay : 0), 0),
    paid: rows.reduce((s, r) => s + r.paid, 0), deducted: rows.reduce((s, r) => s + r.deducted, 0),
    advances: rows.reduce((s, r) => s + advOf(r), 0), count: rows.length,
  };
  // Кому переплачено (выплачено больше, чем к выплате) — для клика по «переплата» на дашборде.
  const overpaid = rows.filter((r) => r.to_pay < -0.5).map((r) => ({ name: r.full_name, dept: r.dept || '—', amount: -r.to_pay })).sort((a, b) => b.amount - a.amount);
  // По сотрудникам — для разреза по клику на плитки дашборда.
  const emps = rows.map((r) => ({ full_name: r.full_name, dept: r.dept || '—', accrued: r.accrued, deducted: r.deducted, paid: r.paid, to_pay: r.to_pay, advances: advOf(r) }));
  res.json({ period, byDept: deptArr, totals, overpaid, emps });
});

// ---------- Отделы ----------
router.post('/api/department', J, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Введите название отдела' });
  try {
    if (b.id) await db.pool.query('UPDATE hr_departments SET name=$1, sort_order=$2 WHERE id=$3', [name, parseInt(b.sort_order) || 100, b.id]);
    else await db.pool.query('INSERT INTO hr_departments (name, sort_order) VALUES ($1,$2)', [name, parseInt(b.sort_order) || 100]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: 'Такой отдел уже есть или ошибка: ' + e.message }); }
});
// Архивация отдела с переносом сотрудников (не оставляем людей в удалённом отделе).
router.post('/api/department/:id(\\d+)/archive', J, async (req, res) => {
  const id = parseInt(req.params.id);
  const cnt = (await db.pool.query("SELECT COUNT(*)::int AS n FROM hr_employees WHERE department_id=$1 AND status<>'archived'", [id])).rows[0].n;
  const hasMove = req.body && ('move_to' in req.body);
  if (cnt > 0 && !hasMove) return res.status(409).json({ error: 'has_employees', count: cnt });
  if (cnt > 0) {
    const moveTo = intOrNull(req.body.move_to); // null = «без отдела»
    if (moveTo === id) return res.status(400).json({ error: 'Нельзя перенести в тот же отдел' });
    await db.pool.query('UPDATE hr_employees SET department_id=$1, updated_at=now() WHERE department_id=$2', [moveTo, id]);
  }
  await db.pool.query("UPDATE hr_departments SET status='archived' WHERE id=$1", [id]);
  await db.log(req.user.id, 'hr_department_archive', `#${id}${cnt ? ` (перенос ${cnt})` : ''}`);
  res.json({ ok: true, moved: cnt });
});

// ---------- Массовые операции ----------
function schedFromText(s) {
  const t = String(s || '').toLowerCase();
  if (/смен/.test(t)) return 'shift';
  if (/производ|цех/.test(t)) return 'production';
  if (/офис|ауп/.test(t)) return 'office';
  return null;
}

// Шаблон Excel для загрузки сотрудников.
router.get('/api/employees/template.xlsx', async (req, res) => {
  const wb = XLSX.utils.book_new();
  const main = XLSX.utils.aoa_to_sheet([
    ['ФИО', 'Отдел', 'Должность', 'График', 'Оклад/ставка', 'Официальная', 'Неофициальная', 'Телефон', 'Комментарий'],
    ['Пример: Иванов Иван', 'Производство', 'Оператор', 'смена', 4000000, 3000000, 1000000, '998901234567', ''],
    ['', '', '', '', '', '', '', '', ''],
  ]);
  main['!cols'] = [{ wch: 26 }, { wch: 20 }, { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, main, 'Сотрудники');
  const help = XLSX.utils.aoa_to_sheet([['График — пишите:'], ['офис — Офис (5/2)'], ['производство — Производство'], ['смена — Производство-смена']]);
  XLSX.utils.book_append_sheet(wb, help, 'Подсказка');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="hr_employees_template.xlsx"');
  res.send(buf);
});

// Оптовый импорт сотрудников из Excel. Отдел ищем по названию (создаём, если нет).
router.post('/api/employees/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sh = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sh, { header: 1, raw: false, defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'Пустой файл' });
    let hi = rows.findIndex((r) => r.some((c) => /фио|имя/i.test(String(c))));
    if (hi < 0) hi = 0;
    const head = rows[hi].map((c) => String(c).toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const iName = col(/фио|имя/), iDept = col(/отдел/), iPos = col(/должн/), iSched = col(/график/),
      iBase = col(/оклад|ставк/), iOff = col(/офиц/), iUn = col(/неофиц/), iPhone = col(/тел/), iCmt = col(/коммент/);
    if (iName < 0) return res.status(400).json({ error: 'Не нашёл колонку «ФИО»' });
    // Карта отделов (по названию, регистронезависимо).
    const deptMap = {};
    (await db.pool.query('SELECT id, name FROM hr_departments')).rows.forEach((d) => { deptMap[d.name.toLowerCase()] = d.id; });
    const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) && n !== 0 ? n : null; };
    let created = 0, skipped = 0;
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i];
      const name = String((r[iName] != null ? r[iName] : '')).trim();
      if (!name || /^пример/i.test(name)) { continue; }
      let deptId = null;
      if (iDept >= 0) {
        const dn = String(r[iDept] || '').trim();
        if (dn) {
          deptId = deptMap[dn.toLowerCase()];
          if (!deptId) { const ins = await db.pool.query('INSERT INTO hr_departments (name, sort_order) VALUES ($1, 200) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [dn]); deptId = ins.rows[0].id; deptMap[dn.toLowerCase()] = deptId; }
        }
      }
      await db.pool.query(
        `INSERT INTO hr_employees (full_name, department_id, position, schedule_type, base_salary, salary_official, salary_unofficial, phone, comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [name, deptId, iPos >= 0 ? (String(r[iPos] || '').trim() || null) : null, iSched >= 0 ? schedFromText(r[iSched]) : null,
         iBase >= 0 ? num(r[iBase]) : null, iOff >= 0 ? num(r[iOff]) : null, iUn >= 0 ? num(r[iUn]) : null,
         iPhone >= 0 ? (String(r[iPhone] || '').trim() || null) : null, iCmt >= 0 ? (String(r[iCmt] || '').trim() || null) : null]);
      created++;
    }
    await db.log(req.user.id, 'hr_employees_import', `создано ${created}`);
    res.json({ ok: true, created, skipped });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Шаблон Excel для номеров карт — уже со списком сотрудников (заполнить только карту).
router.get('/api/cards/template.xlsx', async (req, res) => {
  const emps = (await db.pool.query("SELECT full_name, card_number FROM hr_employees WHERE status<>'archived' ORDER BY full_name")).rows;
  const wb = XLSX.utils.book_new();
  const sh = XLSX.utils.aoa_to_sheet([['ФИО', 'Номер карты'], ...emps.map((e) => [e.full_name, e.card_number || ''])]);
  sh['!cols'] = [{ wch: 32 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, sh, 'Карты');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="hr_cards_template.xlsx"');
  res.send(buf);
});
// Импорт номеров карт: сопоставляем по ФИО, ставим card_number существующим сотрудникам.
router.post('/api/cards/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'Пустой файл' });
    let hi = rows.findIndex((r) => r.some((c) => /фио|имя/i.test(String(c))));
    if (hi < 0) hi = 0;
    const head = rows[hi].map((c) => String(c).toLowerCase());
    const iName = head.findIndex((h) => /фио|имя/.test(h));
    const iCard = head.findIndex((h) => /карт/.test(h));
    if (iName < 0 || iCard < 0) return res.status(400).json({ error: 'Нужны колонки «ФИО» и «Номер карты»' });
    const byName = {};
    (await db.pool.query("SELECT id, full_name FROM hr_employees WHERE status<>'archived'")).rows.forEach((e) => { byName[e.full_name.trim().toLowerCase()] = e.id; });
    let updated = 0; const notFound = [];
    for (let i = hi + 1; i < rows.length; i++) {
      const name = String(rows[i][iName] || '').trim();
      const card = String(rows[i][iCard] || '').trim();
      if (!name || /^пример/i.test(name) || !card) continue;
      const id = byName[name.toLowerCase()];
      if (!id) { notFound.push(name); continue; }
      await db.pool.query('UPDATE hr_employees SET card_number=$1, updated_at=now() WHERE id=$2', [card, id]);
      updated++;
    }
    await db.log(req.user.id, 'hr_cards_import', `обновлено ${updated}`);
    res.json({ ok: true, updated, notFound: notFound.slice(0, 30), notFoundCount: notFound.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Импорт банковской ведомости по карте: суммы садятся в paid_card (выплата) или ded_advance_card (аванс).
// Сопоставление по номеру карты (16 цифр из назначения). ФИО в выписке — полные латиницей, по ним не матчим.
router.post('/api/cards/statement-import', upload.single('file'), async (req, res) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
    if (!period) return res.status(400).json({ error: 'Нет периода' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const mode = req.body.mode === 'advance' ? 'advance' : 'payout';
    const field = mode === 'advance' ? 'ded_advance_card' : 'paid_card';
    const dry = String(req.body.dry) === 'true' || req.query.dry === '1';
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    // Денежная ячейка: «1 500 000.00» / «3 000 000» — с разрядами-пробелами (чтобы не спутать со счётом/№ документа).
    const moneyOf = (s) => { const m = String(s == null ? '' : s).match(/\d{1,3}(?:\s\d{3})+(?:[.,]\d{1,2})?/); return m ? Number(m[0].replace(/\s/g, '').replace(',', '.')) : 0; };
    const agg = {}; // card → { card, fio, amount }
    for (const sn of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' });
      for (const r of grid) {
        const cells = (r || []).map((c) => String(c == null ? '' : c));
        const cm = cells.join(' | ').match(/(?<!\d)(\d{16})(?!\d)/);   // карта = ровно 16 цифр (счёт — 20, № док короче)
        if (!cm) continue;
        const card = cm[1];
        let fio = '';
        for (const c of cells) { if (/\/\d*\/\s*[A-Za-z]/.test(c)) { const parts = c.split('/'); if (parts[2]) { fio = parts[2].split('(')[0].trim(); break; } } }
        let amount = 0;
        for (const c of cells) { const v = moneyOf(c); if (v > 0) amount = v; }   // последняя денежная ячейка строки = зачисление сотруднику
        if (amount <= 0) continue;
        if (!agg[card]) agg[card] = { card, fio, amount: 0 };
        agg[card].amount += amount;
      }
    }
    const list = Object.values(agg);
    if (!list.length) return res.status(400).json({ error: 'Не нашёл строк с номером карты и суммой. Это точно выписка по картам?' });
    const emps = (await db.pool.query(
      "SELECT id, full_name, regexp_replace(COALESCE(card_number,''),'\\D','','g') AS card FROM hr_employees WHERE status<>'archived' AND COALESCE(card_number,'')<>''")).rows;
    const byCard = {}; emps.forEach((e) => { if (e.card) byCard[e.card] = e; });
    const matched = [], unmatched = []; let total = 0;
    for (const it of list) {
      total += it.amount;
      const e = byCard[it.card];
      if (e) matched.push({ emp_id: e.id, name: e.full_name, card: it.card, amount: it.amount });
      else unmatched.push({ fio: it.fio, card: it.card, amount: it.amount });
    }
    if (!dry) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        for (const m of matched) {
          await client.query(
            `INSERT INTO hr_payroll (employee_id, period, ${field}, created_by) VALUES ($1,$2,$3,$4)
             ON CONFLICT (employee_id, period) DO UPDATE SET ${field}=EXCLUDED.${field}, updated_at=now()`,
            [m.emp_id, period, m.amount, req.user.id]);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
      finally { client.release(); }
      await db.log(req.user.id, 'hr_card_statement', `${period} ${mode}: ${matched.length} на ${Math.round(total)}`);
    }
    res.json({ ok: true, dry, mode, period, matched, unmatched, total, count: list.length });
  } catch (e) { res.status(400).json({ error: 'Не удалось прочитать файл: ' + e.message }); }
});

// Выгрузка ведомости на карту (для банка): ФИО · номер карты · сумма. Выплата → К выплате, Аванс → «Аванс на карту».
router.get('/api/cards/paysheet.xlsx', async (req, res) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
    const mode = req.query.mode === 'advance' ? 'advance' : 'payout';
    const rows = (await db.pool.query(
      `SELECT e.full_name, e.card_number, pr.* FROM hr_employees e
       LEFT JOIN hr_payroll pr ON pr.employee_id = e.id AND pr.period = $1
       WHERE e.status <> 'archived' AND COALESCE(e.card_number,'') <> '' ORDER BY e.full_name`, [period])).rows.map(withTotals);
    const data = []; let total = 0;
    for (const r of rows) {
      const amt = mode === 'advance' ? Math.round(Number(r.ded_advance_card) || 0) : Math.round(Number(r.to_pay) || 0);
      if (mode === 'payout' && amt <= 0) continue;      // выплата: только тем, кому есть что перечислять
      total += amt;
      data.push({ 'ФИО': r.full_name, 'Номер карты': String(r.card_number || ''), 'Сумма': amt || '' });
    }
    data.push({ 'ФИО': 'ИТОГО', 'Номер карты': '', 'Сумма': total });
    const ws = XLSX.utils.json_to_sheet(data, { header: ['ФИО', 'Номер карты', 'Сумма'] });
    ws['!cols'] = [{ wch: 34 }, { wch: 22 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, mode === 'advance' ? 'Аванс на карту' : 'Выплата на карту');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="paysheet_${period}_${mode}.xlsx"`);
    res.send(buf);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Шаблон Excel табеля за период — со списком сотрудников и текущими план/факт.
router.get('/api/timesheet/template.xlsx', async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
  const rows = (await db.pool.query(
    `SELECT e.full_name, pr.plan_days, pr.fact_days, pr.plan_hours, pr.fact_hours
     FROM hr_employees e LEFT JOIN hr_payroll pr ON pr.employee_id=e.id AND pr.period=$1
     WHERE e.status <> 'archived' ORDER BY e.full_name`, [period])).rows;
  const wb = XLSX.utils.book_new();
  const sh = XLSX.utils.aoa_to_sheet([['ФИО', 'План дней', 'Факт дней', 'План часов', 'Факт часов'],
    ...rows.map((r) => [r.full_name, r.plan_days || '', r.fact_days || '', r.plan_hours || '', r.fact_hours || ''])]);
  sh['!cols'] = [{ wch: 32 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 11 }];
  XLSX.utils.book_append_sheet(wb, sh, 'Табель ' + period);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="hr_timesheet_${period}.xlsx"`);
  res.send(buf);
});
// Импорт табеля из Excel: сопоставляем по ФИО, пишем ТОЛЬКО дни/часы (деньги не трогаем).
router.post('/api/timesheet/import', upload.single('file'), async (req, res) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
    if (!period) return res.status(400).json({ error: 'Нет периода' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'Пустой файл' });
    let hi = rows.findIndex((r) => r.some((c) => /фио|имя/i.test(String(c))));
    if (hi < 0) hi = 0;
    const head = rows[hi].map((c) => String(c).toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const iName = col(/фио|имя/), iPd = col(/план.*д/), iFd = col(/факт.*д/), iPh = col(/план.*ч/), iFh = col(/факт.*ч/);
    if (iName < 0) return res.status(400).json({ error: 'Не нашёл колонку «ФИО»' });
    const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
    const byName = {};
    (await db.pool.query("SELECT id, full_name FROM hr_employees WHERE status<>'archived'")).rows.forEach((e) => { byName[e.full_name.trim().toLowerCase()] = e.id; });
    let updated = 0; const notFound = [];
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = hi + 1; i < rows.length; i++) {
        const name = String(rows[i][iName] || '').trim();
        if (!name || /^пример/i.test(name)) continue;
        const id = byName[name.toLowerCase()];
        if (!id) { notFound.push(name); continue; }
        await client.query(
          `INSERT INTO hr_payroll (employee_id, period, plan_days, fact_days, plan_hours, fact_hours, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (employee_id, period) DO UPDATE SET plan_days=EXCLUDED.plan_days, fact_days=EXCLUDED.fact_days,
             plan_hours=EXCLUDED.plan_hours, fact_hours=EXCLUDED.fact_hours, updated_at=now()`,
          [id, period, iPd >= 0 ? num(rows[i][iPd]) : null, iFd >= 0 ? num(rows[i][iFd]) : null, iPh >= 0 ? num(rows[i][iPh]) : null, iFh >= 0 ? num(rows[i][iFh]) : null, req.user.id]);
        updated++;
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
    finally { client.release(); }
    await db.log(req.user.id, 'hr_timesheet_import', `${period}: ${updated}`);
    res.json({ ok: true, updated, notFound: notFound.slice(0, 30), notFoundCount: notFound.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Импорт зарплаты из Excel (все листы книги: АУП / произ / смена) ----------
// Раскладка столбцов по названиям; парные столбцы (аванс на карту, выплата на карту) суммируются.
// Начислено=Фактич зпл табель; удержания=штраф+удержание+авансы; выплаты=нал+карта. Перезапись по (сотрудник,период).
function classifyPayCol(h) {
  h = String(h == null ? '' : h).toLowerCase().replace(/ё/g, 'е').trim();
  if (!h) return null;
  if (/аванс/.test(h) && /карт/.test(h)) return 'ded_advance_card';
  if (/аванс/.test(h) && /нал/.test(h)) return 'ded_advance_cash';
  if (/выплач|выплат/.test(h) && /карт/.test(h)) return 'paid_card';
  if (/выплач|выплат/.test(h) && /нал/.test(h)) return 'paid_cash';
  if (/фактич/.test(h) && /табел/.test(h)) return 'accr_fact';
  if (/бонус/.test(h)) return 'accr_bonus';
  if (/преми/.test(h)) return 'accr_premium';
  if (/гсм/.test(h)) return 'accr_gsm';
  if (/долг/.test(h) && /компан/.test(h)) return 'accr_company_debt';
  if (/штраф/.test(h)) return 'ded_fine';
  if (/^удержание/.test(h)) return 'ded_hold';
  if (/факт/.test(h) && /дн/.test(h)) return 'fact_days';
  if (/кол-во/.test(h) && /дн/.test(h)) return 'plan_days';
  if (/отраб/.test(h) && /час/.test(h)) return 'fact_hours';
  return null;
}
const PAY_FIELDS = ['plan_days', 'fact_days', 'fact_hours', 'accr_fact', 'accr_bonus', 'accr_premium', 'accr_gsm', 'accr_company_debt', 'ded_fine', 'ded_hold', 'ded_advance_card', 'ded_advance_cash', 'paid_cash', 'paid_card'];
router.post('/api/payroll/import', upload.single('file'), async (req, res) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
    if (!period) return res.status(400).json({ error: 'Нет периода' });
  { const _e = await hrLockError(period); if (_e) return res.status(423).json({ error: _e }); }
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const clearFirst = String(req.body.clearFirst) === 'true' || req.body.clearFirst === true;
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    // raw:true → числа приходят числами; строки-числа (напр. " 5,000,000 ") чистим до цифр/точки/минуса.
    const num = (v) => { if (typeof v === 'number') return isFinite(v) ? v : 0; const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return isFinite(n) ? n : 0; };
    const emps = (await db.pool.query("SELECT id, full_name FROM hr_employees WHERE status <> 'archived'")).rows;
    const parsed = []; const notFound = []; const sheetsInfo = [];
    for (const sname of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sname], { header: 1, raw: true, defval: '' });
      let hi = rows.findIndex((r) => r.some((c) => /должност/i.test(String(c))));
      if (hi < 0) { sheetsInfo.push({ sheet: sname, rows: 0, note: 'нет заголовка' }); continue; }
      const head = rows[hi].map((c) => String(c));
      const iPos = head.findIndex((h) => /должност/i.test(h));
      const iName = iPos > 0 ? iPos - 1 : 1;
      const fmap = {}; head.forEach((h, ci) => { const f = classifyPayCol(h); if (f) (fmap[f] = fmap[f] || []).push(ci); });
      const getF = (row, f) => (fmap[f] || []).reduce((s, ci) => s + num(row[ci]), 0);
      let cnt = 0;
      for (let i = hi + 1; i < rows.length; i++) {
        const name = String(rows[i][iName] || '').trim();
        if (!name || /итого|^отдел|склад под|руководств|^пример/i.test(name)) continue;
        const hasData = PAY_FIELDS.some((f) => getF(rows[i], f) !== 0);
        if (!hasData) continue;
        const emp = csMatchEmp(name, emps);
        const vals = {}; PAY_FIELDS.forEach((f) => { vals[f] = getF(rows[i], f); });
        if (!emp) { notFound.push({ sheet: sname, name, accr: vals.accr_fact }); continue; }
        parsed.push({ emp_id: emp.id, vals }); cnt++;
      }
      sheetsInfo.push({ sheet: sname, imported: cnt });
    }
    const client = await db.pool.connect();
    let created = 0;
    try {
      await client.query('BEGIN');
      if (clearFirst) await client.query('DELETE FROM hr_payroll WHERE period=$1', [period]);
      for (const row of parsed) {
        const v = row.vals;
        await client.query(
          `INSERT INTO hr_payroll (employee_id, period, plan_days, fact_days, fact_hours, accr_fact, accr_bonus, accr_premium, accr_gsm, accr_company_debt, ded_fine, ded_hold, ded_advance_card, ded_advance_cash, paid_cash, paid_card, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (employee_id, period) DO UPDATE SET plan_days=EXCLUDED.plan_days, fact_days=EXCLUDED.fact_days, fact_hours=EXCLUDED.fact_hours,
             accr_fact=EXCLUDED.accr_fact, accr_bonus=EXCLUDED.accr_bonus, accr_premium=EXCLUDED.accr_premium, accr_gsm=EXCLUDED.accr_gsm, accr_company_debt=EXCLUDED.accr_company_debt,
             ded_fine=EXCLUDED.ded_fine, ded_hold=EXCLUDED.ded_hold, ded_advance_card=EXCLUDED.ded_advance_card, ded_advance_cash=EXCLUDED.ded_advance_cash,
             paid_cash=EXCLUDED.paid_cash, paid_card=EXCLUDED.paid_card, updated_at=now()`,
          [row.emp_id, period, v.plan_days || null, v.fact_days || null, v.fact_hours || null, v.accr_fact, v.accr_bonus, v.accr_premium, v.accr_gsm, v.accr_company_debt, v.ded_fine, v.ded_hold, v.ded_advance_card, v.ded_advance_cash, v.paid_cash, v.paid_card, req.user.id]);
        created++;
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
    finally { client.release(); }
    // Итоги для сверки с файлом.
    const tot = parsed.reduce((a, r) => {
      const v = r.vals;
      a.accr += v.accr_fact + v.accr_bonus + v.accr_premium + v.accr_gsm + v.accr_company_debt;
      a.ded += v.ded_fine + v.ded_hold + v.ded_advance_card + v.ded_advance_cash;
      a.paid += v.paid_cash + v.paid_card;
      return a;
    }, { accr: 0, ded: 0, paid: 0 });
    tot.to_pay = tot.accr - tot.ded - tot.paid;
    await db.log(req.user.id, 'hr_payroll_import', `${period}: ${created}, не найдено ${notFound.length}`);
    res.json({ ok: true, period, imported: created, sheets: sheetsInfo, notFound: notFound.slice(0, 60), notFoundCount: notFound.length, totals: tot });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Оптовое удаление или архивирование выбранных.
// Доступ к модулю «Персонал» уже проверен requireHrAccess (галочка плитки),
// поэтому внутри — полные права: кому выдан доступ, тот может и удалять.
// Восстановление сотрудников из справочного файла (июнь 2026): создаёт только тех, кого
// сейчас нет по ФИО, вместе с их июньским начислением. Нужен после случайного удаления карточек.
router.post('/api/employees/restore-seed', J, async (req, res) => {
  try {
    const before = (await db.pool.query('SELECT COUNT(*)::int c FROM hr_employees')).rows[0].c;
    const restored = await seedJune2026(true);
    const after = (await db.pool.query('SELECT COUNT(*)::int c FROM hr_employees')).rows[0].c;
    await db.log(req.user.id, 'hr_employees_restore_seed', `восстановлено ${restored}`);
    res.json({ ok: true, restored, before, after });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Что создало последнее «Восстановить»: карточки, заведённые в тот момент. Нужен, чтобы
// откатить неудачное восстановление (справочный файл содержит короткие имена — «Азиза», —
// а в базе полные, поэтому сравнение по точному ФИО наплодило дублей).
router.get('/api/employees/restore-preview', async (req, res) => {
  try {
    const last = (await db.pool.query(
      "SELECT to_char(created_at,'YYYY-MM-DD\"T\"HH24:MI:SS') AS ts FROM audit_log WHERE action='hr_employees_restore_seed' ORDER BY id DESC LIMIT 1")).rows[0];
    if (!last) return res.json({ items: [], ts: null });
    const items = (await db.pool.query(
      `SELECT e.id, e.full_name, d.name AS department_name, e.position,
              (SELECT COUNT(*) FROM hr_payroll p WHERE p.employee_id = e.id) AS payroll_rows,
              (SELECT COUNT(*) FROM hr_payouts o WHERE o.employee_id = e.id) AS payout_rows,
              (SELECT COUNT(*) FROM hr_events v WHERE v.employee_id = e.id) AS event_rows
         FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
        WHERE e.created_at >= $1::timestamptz
        ORDER BY e.full_name`, [last.ts])).rows;
    res.json({ ts: last.ts, items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Откат восстановления: удаляет карточки, созданные последним «Восстановить».
// Защита: не трогаем тех, у кого появились выплаты или начисления не за июнь (значит с ними уже работали).
router.post('/api/employees/undo-restore', J, async (req, res) => {
  try {
    const last = (await db.pool.query(
      "SELECT to_char(created_at,'YYYY-MM-DD\"T\"HH24:MI:SS') AS ts FROM audit_log WHERE action='hr_employees_restore_seed' ORDER BY id DESC LIMIT 1")).rows[0];
    if (!last) return res.status(400).json({ error: 'Не нашёл записи о восстановлении — откатывать нечего' });
    const cand = (await db.pool.query(
      `SELECT e.id, e.full_name,
              (SELECT COUNT(*) FROM hr_payouts o WHERE o.employee_id = e.id) AS po,
              (SELECT COUNT(*) FROM hr_payroll p WHERE p.employee_id = e.id AND p.period <> '2026-06') AS pr
         FROM hr_employees e WHERE e.created_at >= $1::timestamptz`, [last.ts])).rows;
    const safe = cand.filter((r) => Number(r.po) === 0 && Number(r.pr) === 0).map((r) => r.id);
    const kept = cand.length - safe.length;
    if (safe.length) await db.pool.query('DELETE FROM hr_employees WHERE id = ANY($1)', [safe]);
    await db.log(req.user.id, 'hr_employees_undo_restore', `удалено ${safe.length}, оставлено ${kept}`);
    res.json({ ok: true, deleted: safe.length, kept });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Поиск дублей по ФИО: одно имя целиком входит в другое («Азиза» ↔ «Мурадова Азиза»).
router.get('/api/employees/duplicates', async (req, res) => {
  try {
    const rows = (await db.pool.query(
      `SELECT e.id, e.full_name, d.name AS department_name, to_char(e.created_at,'YYYY-MM-DD') AS created,
              (SELECT COUNT(*) FROM hr_payroll p WHERE p.employee_id = e.id) AS payroll_rows,
              (SELECT COUNT(*) FROM hr_payouts o WHERE o.employee_id = e.id) AS payout_rows
         FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
        WHERE e.status <> 'archived' ORDER BY e.full_name`)).rows;
    const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
    const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length >= 3));
    const groups = [];
    const used = new Set();
    for (let i = 0; i < rows.length; i++) {
      if (used.has(rows[i].id)) continue;
      const wi = words(rows[i].full_name);
      const grp = [rows[i]];
      for (let j = i + 1; j < rows.length; j++) {
        if (used.has(rows[j].id)) continue;
        const wj = words(rows[j].full_name);
        if (!wi.size || !wj.size) continue;
        // считаем дублем, если все слова короткого имени входят в длинное
        const small = wi.size <= wj.size ? wi : wj, big = wi.size <= wj.size ? wj : wi;
        let all = true; for (const w of small) if (!big.has(w)) { all = false; break; }
        if (all) { grp.push(rows[j]); used.add(rows[j].id); }
      }
      if (grp.length > 1) { grp.forEach((g) => used.add(g.id)); groups.push(grp); }
    }
    res.json({ groups });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Удаление дубля-карточки. Разрешаем, только если с ней реально не работали:
// нет выплат и нет начислений, кроме июньской строки из справочного файла.
router.post('/api/employee/:id(\\d+)/delete-duplicate', J, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = (await db.pool.query(
      `SELECT e.full_name,
              (SELECT COUNT(*) FROM hr_payouts o WHERE o.employee_id = e.id) AS po,
              (SELECT COUNT(*) FROM hr_payroll p WHERE p.employee_id = e.id AND p.period <> '2026-06') AS pr
         FROM hr_employees e WHERE e.id = $1`, [id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Сотрудник не найден' });
    if (Number(r.po) > 0 || Number(r.pr) > 0) {
      return res.status(409).json({ error: `У «${r.full_name}» есть выплаты или начисления за рабочие месяцы — это не пустой дубль. Удалять нельзя, используйте «В архив».` });
    }
    await db.pool.query('DELETE FROM hr_employees WHERE id = $1', [id]);
    await db.log(req.user.id, 'hr_employee_delete_duplicate', `${id} «${r.full_name}»`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/employees/bulk', J, async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => parseInt(x)).filter(Boolean);
  const action = req.body.action;
  if (!ids.length) return res.status(400).json({ error: 'Ничего не выбрано' });
  if (action === 'delete') {
    // Удаление стирает карточку вместе с начислениями, выплатами и кадровой историей (каскад).
    // Поэтому удалять разрешаем только ПУСТЫЕ карточки (заведённые по ошибке). У кого есть
    // хоть одно начисление или выплата — предлагаем «Уволить» или «В архив».
    const busy = (await db.pool.query(
      `SELECT e.id, e.full_name,
              (SELECT COUNT(*) FROM hr_payroll p WHERE p.employee_id = e.id) AS pr,
              (SELECT COUNT(*) FROM hr_payouts o WHERE o.employee_id = e.id) AS po
         FROM hr_employees e WHERE e.id = ANY($1)`, [ids])).rows
      .filter((r) => Number(r.pr) > 0 || Number(r.po) > 0);
    if (busy.length) {
      const names = busy.slice(0, 5).map((r) => r.full_name).join(', ');
      return res.status(409).json({
        error: `Нельзя удалить: у ${busy.length} сотрудн. есть начисления или выплаты (${names}${busy.length > 5 ? ' и др.' : ''}). Удаление стёрло бы их зарплатную историю. Используйте «Уволить» (с датой) или «В архив» — карточка и история останутся.`,
      });
    }
    const r = await db.pool.query('DELETE FROM hr_employees WHERE id = ANY($1)', [ids]);
    await db.log(req.user.id, 'hr_employees_bulk_delete', String(ids.length));
    return res.json({ ok: true, affected: r.rowCount });
  }
  const st = ['active', 'fired', 'archived'].includes(action) ? action : null;
  if (!st) return res.status(400).json({ error: 'Неверное действие' });
  // Массовое увольнение — с датой, как и одиночное: без неё непонятно, по какой день человек
  // работал, и месяц увольнения нельзя правильно начислить. Пишем и в кадровую историю.
  if (st === 'fired') {
    const fireDate = String(req.body.fire_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fireDate)) return res.status(400).json({ error: 'Укажите дату увольнения' });
    const r = await db.pool.query('UPDATE hr_employees SET status=$1, fire_date=$2, updated_at=now() WHERE id = ANY($3)', [st, fireDate, ids]);
    // Событие пишем и тем, кто уже числился уволенным: обычно это как раз простановка даты,
    // которой не хватало. Если событие с этой датой уже есть — ничего не делаем; если есть
    // с другой датой — поправляем её, чтобы в истории не плодились дубли одного увольнения.
    for (const id of ids) {
      const ex = (await db.pool.query(
        "SELECT id, to_char(event_date,'YYYY-MM-DD') AS d FROM hr_events WHERE employee_id=$1 AND event_type='fire' ORDER BY event_date DESC LIMIT 1", [id])).rows[0];
      if (ex && ex.d === fireDate) continue;
      if (ex) await db.pool.query('UPDATE hr_events SET event_date=$1, comment=$2 WHERE id=$3', [fireDate, 'Дата уточнена', ex.id]);
      else await addEvent(id, 'fire', fireDate, { created_by: req.user.id, comment: 'Массовое увольнение' });
    }
    await db.log(req.user.id, 'hr_employees_bulk_fire', `${ids.length} с ${fireDate}`);
    return res.json({ ok: true, affected: r.rowCount });
  }
  const r = await db.pool.query('UPDATE hr_employees SET status=$1, updated_at=now() WHERE id = ANY($2)', [st, ids]);
  await db.log(req.user.id, 'hr_employees_bulk_status', `${st}: ${ids.length}`);
  res.json({ ok: true, affected: r.rowCount });
});

module.exports = router;
