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
  { code: 'office', name: 'Офис (5/2)' },
  { code: 'production', name: 'Производство' },
  { code: 'shift', name: 'Производство — смена' },
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
  // Доп. статьи начислений для массовых операций (больничные/отпускные/матпомощь/компенсация отпуска).
  for (const col of ['accr_sick', 'accr_vacation', 'accr_mataid', 'accr_comp_vac']) {
    await q(`ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS ${col} NUMERIC`);
  }
  await q(`ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC`); // переработка, часы (из табеля)
  await seedDepartments();
  _ready = true;
}
// Поля начислений/удержаний/выплат — для расчётов и сохранения.
// ВАЖНО: accr_salary (Фикса) — базовая ставка, НЕ входит в сумму «начислено».
const ACCR_EXTRA = ['accr_sick', 'accr_vacation', 'accr_mataid', 'accr_comp_vac']; // больничные/отпускные/матпомощь/компенсация
const ACCR_ALL = ['accr_salary', 'accr_fact', 'accr_bonus', 'accr_premium', 'accr_gsm', 'accr_company_debt', 'accr_other', ...ACCR_EXTRA];
const ACCR = ['accr_fact', 'accr_bonus', 'accr_premium', 'accr_gsm', 'accr_company_debt', 'accr_other', ...ACCR_EXTRA]; // счётные
const DED = ['ded_fine', 'ded_advance_card', 'ded_advance_cash', 'ded_hold', 'ded_emp_debt', 'ded_other'];
const PAID = ['paid_cash', 'paid_card'];
const PAYROLL_NUM = [...ACCR_ALL, ...DED, ...PAID, 'plan_days', 'fact_days', 'plan_hours', 'fact_hours', 'amount_1c'];

// Тип оплаты по графику: производство/смена — почасовая; офис (АУП) — фиксированный оклад.
const POCHASOVOY = new Set(['production', 'shift']);
// Авторасчёт оклада-начисления (accr_fact). Почасовые: оклад/план_часы × (факт_часы + переработка×2). АУП: оклад.
function computePay(row) {
  const oklad = Number(row.base_salary) || 0;
  const planH = Number(row.plan_hours) || 0, factH = Number(row.fact_hours) || 0, otH = Number(row.overtime_hours) || 0;
  if (POCHASOVOY.has(row.schedule_type)) {
    if (!(planH > 0)) return { base: 0, overtime: 0 };
    const rate = oklad / planH;
    return { base: Math.round(rate * (factH + otH * 2)), overtime: Math.round(rate * otH * 2) };
  }
  return { base: Math.round(oklad), overtime: 0 };
}
// Пересчитать и сохранить accr_fact сотрудника за период (после норм/табеля/правки часов).
async function recomputeAccrFact(empId, period) {
  const r = (await db.pool.query(
    `SELECT e.base_salary, e.schedule_type, pr.plan_hours, pr.fact_hours, pr.overtime_hours
     FROM hr_employees e LEFT JOIN hr_payroll pr ON pr.employee_id = e.id AND pr.period = $2 WHERE e.id = $1`, [empId, period])).rows[0];
  if (!r) return;
  const pay = computePay(r);
  await db.pool.query(
    `INSERT INTO hr_payroll (employee_id, period, accr_fact) VALUES ($1,$2,$3)
     ON CONFLICT (employee_id, period) DO UPDATE SET accr_fact = EXCLUDED.accr_fact, updated_at = now()`,
    [empId, period, pay.base]);
}
const sumF = (row, fields) => fields.reduce((s, f) => s + (Number(row[f]) || 0), 0);
async function seedDepartments() {
  const D = ['АУП', 'Производство', 'Производство смена', 'Склад', 'Продажи', 'Маркетинг', 'Бухгалтерия', 'Закупки', 'Логистика', 'Другое'];
  let i = 0;
  for (const name of D) { i += 10; await db.pool.query('INSERT INTO hr_departments (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, i]); }
  await seedJune2026();
}
// Разовая загрузка сотрудников и начислений за июнь 2026 из файла Шоха.
async function seedJune2026() {
  try {
    const flag = (await db.pool.query("SELECT value FROM settings WHERE key='hr_seed_june2026'")).rows[0];
    if (flag && flag.value === 'done') return;
    let data; try { data = require('./data/hr_seed_june2026.json'); } catch (e) { return; }
    const emps = data.employees || [];
    if (!emps.length) return;
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
    }
    await db.setSetting('hr_seed_june2026', 'done');
    console.log('[HR SEED] Загружено сотрудников за июнь 2026:', emps.length);
  } catch (e) { console.warn('[HR SEED]', e.message); }
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
  if (req.query.department === '__none__') w.push('e.department_id IS NULL');
  else if (req.query.department) { p.push(parseInt(req.query.department)); w.push(`e.department_id = $${p.length}`); }
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

router.post('/api/employee', J, async (req, res) => {
  const b = req.body || {};
  const name = String(b.full_name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите ФИО' });
  const sched = SCHEDULE_CODES.includes(b.schedule_type) ? b.schedule_type : null;
  const status = STATUSES.includes(b.status) ? b.status : 'active';
  const args = [name, intOrNull(b.department_id), b.position || null, sched, b.hire_date || null, b.fire_date || null, status,
    numOrNull(b.base_salary), numOrNull(b.salary_official), numOrNull(b.salary_unofficial), b.phone || null, b.telegram_id || null, intOrNull(b.erp_user_id), b.comment || null,
    b.card_number || null];
  try {
    if (b.id) {
      await db.pool.query(
        `UPDATE hr_employees SET full_name=$1, department_id=$2, position=$3, schedule_type=$4, hire_date=$5, fire_date=$6, status=$7,
          base_salary=$8, salary_official=$9, salary_unofficial=$10, phone=$11, telegram_id=$12, erp_user_id=$13, comment=$14, card_number=$15, updated_at=now() WHERE id=$16`,
        [...args, b.id]);
    } else {
      await db.pool.query(
        `INSERT INTO hr_employees (full_name, department_id, position, schedule_type, hire_date, fire_date, status, base_salary, salary_official, salary_unofficial, phone, telegram_id, erp_user_id, comment, card_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, args);
    }
    await db.log(req.user.id, 'hr_employee_save', name);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Смена статуса (не удаляем физически).
router.post('/api/employee/:id(\\d+)/status', J, async (req, res) => {
  const st = STATUSES.includes(req.body.status) ? req.body.status : null;
  if (!st) return res.status(400).json({ error: 'Неверный статус' });
  const fire = st === 'fired' ? (req.body.fire_date || new Date().toISOString().slice(0, 10)) : null;
  await db.pool.query('UPDATE hr_employees SET status=$1, fire_date=COALESCE($2, fire_date), updated_at=now() WHERE id=$3', [st, fire, req.params.id]);
  await db.log(req.user.id, 'hr_employee_status', `#${req.params.id} → ${st}`);
  res.json({ ok: true });
});

// ---------- Зарплата ----------
function withTotals(row) {
  const accrued = sumF(row, ACCR), deducted = sumF(row, DED), paid = sumF(row, PAID);
  return Object.assign({}, row, { accrued, deducted, paid, to_pay: accrued - deducted - paid });
}
// ---------- Выплаты зарплаты из наличной кассы (производно — всегда в синхроне с кассой) ----------
// Расход наличной кассы со статьёй 20 (ЗП производство) / 40 (Зарплата офиса) → выплата сотруднику.
// ФИО берём из назначения; «аванс» в тексте → аванс наличными, иначе — выплата наличными.
// Период: «за <месяц>» из назначения, иначе месяц даты платежа. Сумма — сум-эквивалент (t.amount).
const CS_MONTHS = { янв: 1, фев: 2, мар: 3, апр: 4, ма: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12 };
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
async function computeCashSalary(period) {
  const byEmp = {}, unmatched = [];
  const cats = (await db.pool.query("SELECT id FROM cash_categories WHERE code IN ('20','40')")).rows.map((r) => r.id);
  if (!cats.length) return { byEmp, unmatched };
  const emps = (await db.pool.query("SELECT id, full_name FROM hr_employees WHERE status <> 'archived'")).rows;
  const txs = (await db.pool.query(
    `SELECT t.id, to_char(t.tx_date,'YYYY-MM-DD') d, t.tx_date, t.amount, t.purpose
     FROM cash_transactions t JOIN cash_wallets w ON w.id = t.wallet_id AND w.kind = 'cash'
     WHERE t.tx_type = 'out' AND t.category_id = ANY($1)`, [cats])).rows;
  for (const t of txs) {
    if (csPeriod(t.purpose, t.tx_date) !== period) continue;
    const kind = /аванс/i.test(t.purpose || '') ? 'advance' : 'salary';
    const amt = Math.round(Number(t.amount) || 0);
    const emp = csMatchEmp(t.purpose, emps);
    if (emp) { const b = byEmp[emp.id] || (byEmp[emp.id] = { advance: 0, paid: 0 }); if (kind === 'advance') b.advance += amt; else b.paid += amt; }
    else unmatched.push({ tx_id: t.id, date: t.d, amount: amt, kind, purpose: t.purpose || '' });
  }
  return { byEmp, unmatched };
}

router.get('/api/payroll', async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
  const p = [period], w = ["e.status <> 'archived'"];
  if (req.query.department === '__none__') w.push('e.department_id IS NULL');
  else if (req.query.department) { p.push(parseInt(req.query.department)); w.push(`e.department_id = $${p.length}`); }
  if (req.query.schedule && SCHEDULE_CODES.includes(req.query.schedule)) { p.push(req.query.schedule); w.push(`e.schedule_type = $${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).trim() + '%'); w.push(`e.full_name ILIKE $${p.length}`); }
  const rows = (await db.pool.query(
    `SELECT e.id AS emp_id, e.full_name, e.position, e.base_salary, e.schedule_type, d.name AS department_name, pr.*
     FROM hr_employees e
     LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN hr_payroll pr ON pr.employee_id = e.id AND pr.period = $1
     WHERE ${w.join(' AND ')} ORDER BY e.full_name`, p)).rows.map((r) => { const t = withTotals(r); t.overtime_pay = computePay(r).overtime; return t; });
  let items = rows;
  if (req.query.status) {
    if (req.query.status === 'none') items = rows.filter((r) => !r.id);
    else items = rows.filter((r) => (r.status || 'draft') === req.query.status && r.id);
  }
  // Выплаты из наличной кассы за период (производно) — добавляем к каждому сотруднику + список нераспознанных.
  let cashUnmatched = [];
  try {
    const cs = await computeCashSalary(period);
    cashUnmatched = cs.unmatched;
    items.forEach((r) => { const b = cs.byEmp[r.emp_id]; r.cash_advance = b ? b.advance : 0; r.cash_paid = b ? b.paid : 0; });
  } catch (e) { console.error('cash salary:', e.message); }
  const sum = (f) => items.reduce((s, r) => s + (Number(r[f]) || 0), 0);
  const summary = {
    accrued: sum('accrued'), deducted: sum('deducted'), paid: sum('paid'), to_pay: sum('to_pay'),
    bonus: sum('accr_bonus'), advances: items.reduce((s, r) => s + (Number(r.ded_advance_card) || 0) + (Number(r.ded_advance_cash) || 0), 0),
    amount_1c: sum('amount_1c'), count: items.length,
    cash_advance: sum('cash_advance'), cash_paid: sum('cash_paid'),
  };
  res.json({ period, items, summary, cash_unmatched: cashUnmatched });
});

// Заполнить плановые нормы (дни/часы) по графикам за месяц — всем активным сотрудникам графика,
// затем пересчитать начисление (для АУП оклад проставится сразу; почасовым — после табеля).
router.post('/api/fill-norms', J, async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
  if (!period) return res.status(400).json({ error: 'Не указан месяц' });
  const norms = req.body.norms || {};
  let count = 0;
  for (const [sched, v] of Object.entries(norms)) {
    if (!SCHEDULE_CODES.includes(sched)) continue;
    const pd = numOrNull(v.plan_days), ph = numOrNull(v.plan_hours);
    if (pd == null && ph == null) continue;
    const emps = (await db.pool.query("SELECT id FROM hr_employees WHERE status = 'active' AND schedule_type = $1", [sched])).rows;
    for (const e of emps) {
      await db.pool.query(
        `INSERT INTO hr_payroll (employee_id, period, plan_days, plan_hours, created_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (employee_id, period) DO UPDATE SET plan_days = COALESCE($3, hr_payroll.plan_days), plan_hours = COALESCE($4, hr_payroll.plan_hours), updated_at = now()`,
        [e.id, period, pd, ph, req.user.id]);
      await recomputeAccrFact(e.id, period);
      count++;
    }
  }
  await db.log(req.user.id, 'hr_fill_norms', `${period}: ${count}`);
  res.json({ ok: true, count });
});
router.post('/api/payroll', J, async (req, res) => {
  const b = req.body || {};
  const empId = intOrNull(b.employee_id);
  const period = /^\d{4}-\d{2}$/.test(b.period) ? b.period : null;
  if (!empId || !period) return res.status(400).json({ error: 'Нет сотрудника или периода' });
  const status = ['draft', 'approved', 'paid', 'cancelled'].includes(b.status) ? b.status : 'draft';
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
    await db.log(req.user.id, 'hr_payroll_save', `emp ${empId} ${period} ${status}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Табель ----------
// Сохранение табеля: трогаем ТОЛЬКО дни/часы, деньги начислений не задеваем.
// (Обычный /api/payroll перезаписывает все колонки — для табеля он не годится.)
router.post('/api/timesheet', J, async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
  if (!period) return res.status(400).json({ error: 'Нет периода' });
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
  const r = await db.pool.query('DELETE FROM hr_payroll WHERE id = ANY($1)', [ids]);
  await db.log(req.user.id, 'hr_payroll_bulk_delete', String(ids.length));
  res.json({ ok: true, affected: r.rowCount });
});

// ---------- Массовые операции ----------
// Начислить выбранным сотрудникам за период по одной статье (бонусы/ГСМ/больничные/…).
const MASS_FIELDS = new Set(['accr_bonus', 'accr_premium', 'accr_gsm', 'accr_company_debt', 'accr_other', ...ACCR_EXTRA]);
router.post('/api/mass-op', J, async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : null;
  const field = req.body.field;
  if (!period) return res.status(400).json({ error: 'Нет периода' });
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
router.get('/api/dashboard', async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
  const rows = (await db.pool.query(
    `SELECT d.name AS dept, pr.*
     FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN hr_payroll pr ON pr.employee_id = e.id AND pr.period = $1
     WHERE e.status = 'active'`, [period])).rows.map(withTotals);
  const byDept = {};
  rows.forEach((r) => { const d = r.dept || 'Без отдела'; const o = byDept[d] = byDept[d] || { name: d, count: 0, accrued: 0, to_pay: 0, paid: 0 }; o.count++; o.accrued += r.accrued; o.to_pay += r.to_pay; o.paid += r.paid; });
  const deptArr = Object.values(byDept).sort((a, b) => b.accrued - a.accrued);
  const totals = {
    accrued: rows.reduce((s, r) => s + r.accrued, 0), to_pay: rows.reduce((s, r) => s + r.to_pay, 0),
    paid: rows.reduce((s, r) => s + r.paid, 0), deducted: rows.reduce((s, r) => s + r.deducted, 0), count: rows.length,
  };
  res.json({ period, byDept: deptArr, totals });
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

// Оптовое удаление или архивирование выбранных.
// Доступ к модулю «Персонал» уже проверен requireHrAccess (галочка плитки),
// поэтому внутри — полные права: кому выдан доступ, тот может и удалять.
router.post('/api/employees/bulk', J, async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => parseInt(x)).filter(Boolean);
  const action = req.body.action;
  if (!ids.length) return res.status(400).json({ error: 'Ничего не выбрано' });
  if (action === 'delete') {
    const r = await db.pool.query('DELETE FROM hr_employees WHERE id = ANY($1)', [ids]);
    await db.log(req.user.id, 'hr_employees_bulk_delete', String(ids.length));
    return res.json({ ok: true, affected: r.rowCount });
  }
  const st = ['active', 'fired', 'archived'].includes(action) ? action : null;
  if (!st) return res.status(400).json({ error: 'Неверное действие' });
  const r = await db.pool.query('UPDATE hr_employees SET status=$1, updated_at=now() WHERE id = ANY($2)', [st, ids]);
  await db.log(req.user.id, 'hr_employees_bulk_status', `${st}: ${ids.length}`);
  res.json({ ok: true, affected: r.rowCount });
});

module.exports = router;
