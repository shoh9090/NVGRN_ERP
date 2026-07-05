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
  await seedDepartments();
  _ready = true;
}
async function seedDepartments() {
  const D = ['АУП', 'Производство', 'Производство смена', 'Склад', 'Продажи', 'Маркетинг', 'Бухгалтерия', 'Закупки', 'Логистика', 'Другое'];
  let i = 0;
  for (const name of D) { i += 10; await db.pool.query('INSERT INTO hr_departments (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, i]); }
}

router.use(async (req, res, next) => { try { await ensureSchema(); } catch (e) { /* не роняем модуль */ } next(); });

// ---------- Страница ----------
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('hr', { settings, user: req.user });
});

// ---------- Справочники ----------
router.get('/api/dicts', async (req, res) => {
  const departments = (await db.pool.query("SELECT id, name, sort_order FROM hr_departments WHERE status='active' ORDER BY sort_order, name")).rows;
  const counts = (await db.pool.query("SELECT status, count(*)::int n FROM hr_employees GROUP BY status")).rows;
  const byStatus = {}; counts.forEach((c) => { byStatus[c.status] = c.n; });
  res.json({ departments, schedules: SCHEDULES, statuses: STATUSES, counts: byStatus });
});

// ---------- Сотрудники ----------
router.get('/api/employees', async (req, res) => {
  const p = [], w = [];
  if (req.query.department) { p.push(parseInt(req.query.department)); w.push(`e.department_id = $${p.length}`); }
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
    numOrNull(b.base_salary), numOrNull(b.salary_official), numOrNull(b.salary_unofficial), b.phone || null, b.telegram_id || null, intOrNull(b.erp_user_id), b.comment || null];
  try {
    if (b.id) {
      await db.pool.query(
        `UPDATE hr_employees SET full_name=$1, department_id=$2, position=$3, schedule_type=$4, hire_date=$5, fire_date=$6, status=$7,
          base_salary=$8, salary_official=$9, salary_unofficial=$10, phone=$11, telegram_id=$12, erp_user_id=$13, comment=$14, updated_at=now() WHERE id=$15`,
        [...args, b.id]);
    } else {
      await db.pool.query(
        `INSERT INTO hr_employees (full_name, department_id, position, schedule_type, hire_date, fire_date, status, base_salary, salary_official, salary_unofficial, phone, telegram_id, erp_user_id, comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, args);
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
router.post('/api/department/:id(\\d+)/archive', async (req, res) => {
  await db.pool.query("UPDATE hr_departments SET status='archived' WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
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

// Оптовое удаление (только админ) или архивирование выбранных.
router.post('/api/employees/bulk', J, async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => parseInt(x)).filter(Boolean);
  const action = req.body.action;
  if (!ids.length) return res.status(400).json({ error: 'Ничего не выбрано' });
  if (action === 'delete') {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Удаление — только администратор' });
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
