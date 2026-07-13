// calculation.js — плитка «Калькуляция» (перезапуск по ТЗ).
// Этап 1: вкладка «Справочники» — периоды, статьи затрат, ставки, условия каналов.
// Матрица/рецептуры/упаковка — позже, на этом фундаменте. Схема calculation_*.
const express = require('express');
const db = require('./db');

const router = express.Router();
const J = express.json({ limit: '2mb' });

let _ready = false;
const asNum = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : parseInt(v, 10));
const asBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

async function ensureSchema() {
  if (_ready) return;
  const q = (sql, p) => db.pool.query(sql, p);

  await q(`CREATE TABLE IF NOT EXISTS calculation_periods (
    id SERIAL PRIMARY KEY,
    period TEXT NOT NULL UNIQUE,
    avg_monthly_output NUMERIC NOT NULL DEFAULT 0,
    vat_rate NUMERIC NOT NULL DEFAULT 12,
    profit_tax_rate NUMERIC NOT NULL DEFAULT 15,
    status TEXT NOT NULL DEFAULT 'draft',
    comment TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS calculation_expense_items (
    id SERIAL PRIMARY KEY,
    period_id INTEGER REFERENCES calculation_periods(id) ON DELETE CASCADE,
    cost_block TEXT NOT NULL DEFAULT 'Прочее',
    expense_name TEXT NOT NULL DEFAULT 'Статья',
    expense_type TEXT NOT NULL DEFAULT 'fixed',       -- fixed | variable
    amount_month NUMERIC NOT NULL DEFAULT 0,
    include_in_calc BOOLEAN NOT NULL DEFAULT true,
    source TEXT NOT NULL DEFAULT 'manual',
    comment TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS calculation_rates (
    id SERIAL PRIMARY KEY,
    period_id INTEGER REFERENCES calculation_periods(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Ставка',
    rate_percent NUMERIC NOT NULL DEFAULT 0,
    applies_to TEXT DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT true,
    comment TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS calculation_channels (
    id SERIAL PRIMARY KEY,
    period_id INTEGER REFERENCES calculation_periods(id) ON DELETE CASCADE,
    channel_name TEXT NOT NULL DEFAULT 'Канал',
    retro_rate NUMERIC NOT NULL DEFAULT 0,
    vat_rate NUMERIC NOT NULL DEFAULT 12,
    price_from_sd BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    comment TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_exp_period ON calculation_expense_items(period_id)`);
  await q(`CREATE TABLE IF NOT EXISTS calculation_flags (key TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now())`);

  await seedDefaults();
  // Разовая чистка: НДС и налог на прибыль живут в строке периода, в «Ставках» они дублировались.
  const dedup = (await q("SELECT 1 FROM calculation_flags WHERE key='rates_dedup_v1'")).rows[0];
  if (!dedup) {
    await q("DELETE FROM calculation_rates WHERE lower(name) IN ('ндс','налог на прибыль')");
    await q("INSERT INTO calculation_flags (key) VALUES ('rates_dedup_v1') ON CONFLICT DO NOTHING");
  }
  _ready = true;
}

// Идемпотентный сид базового периода/ставок/каналов — только если периодов ещё нет.
async function seedDefaults() {
  const cnt = asNum((await db.pool.query('SELECT COUNT(*)::int AS n FROM calculation_periods')).rows[0].n);
  if (cnt > 0) return;
  const p = await db.pool.query(
    `INSERT INTO calculation_periods (period, avg_monthly_output, vat_rate, profit_tax_rate, status, comment)
     VALUES ('2026-07', 70000, 12, 15, 'active', 'базовый период') RETURNING id`);
  const pid = p.rows[0].id;
  // НДС и налог на прибыль задаются в самом периоде — здесь только ретро/доп. ставки.
  const rates = [
    ['Ретро Retail', 20, 'Цена продажи', 'сети'],
  ];
  for (const [n, r, a, c] of rates) {
    await db.pool.query('INSERT INTO calculation_rates (period_id, name, rate_percent, applies_to, comment) VALUES ($1,$2,$3,$4,$5)', [pid, n, r, a, c]);
  }
  const channels = [
    ['Розница', 20, 12, true, 'сети'],
    ['HoReCa', 0, 12, true, 'рестораны'],
    ['Торг', 0, 12, true, 'перепродажа'],
    ['Салаты', 0, 12, true, 'внутренняя группа'],
    ['Внутреннее', 0, 0, false, 'если нужно'],
  ];
  for (const [n, retro, vat, sd, c] of channels) {
    await db.pool.query('INSERT INTO calculation_channels (period_id, channel_name, retro_rate, vat_rate, price_from_sd, comment) VALUES ($1,$2,$3,$4,$5,$6)', [pid, n, retro, vat, sd, c]);
  }
}

router.use(async (req, res, next) => { try { await ensureSchema(); next(); } catch (e) { next(e); } });

router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('calculation', { settings, user: req.user });
});

// Все справочники выбранного периода за один запрос.
router.get('/api/bootstrap', async (req, res) => {
  const periods = (await db.pool.query('SELECT * FROM calculation_periods ORDER BY period DESC')).rows;
  const active = periods.find((p) => p.status === 'active');
  const wanted = req.query.period && periods.find((p) => p.period === req.query.period) ? req.query.period : (active ? active.period : (periods[0] ? periods[0].period : null));
  const period = periods.find((p) => p.period === wanted) || null;
  const pid = period ? period.id : -1;
  const expenses = (await db.pool.query('SELECT * FROM calculation_expense_items WHERE period_id=$1 ORDER BY sort_order, id', [pid])).rows;
  const rates = (await db.pool.query('SELECT * FROM calculation_rates WHERE period_id=$1 ORDER BY id', [pid])).rows;
  const channels = (await db.pool.query('SELECT * FROM calculation_channels WHERE period_id=$1 ORDER BY id', [pid])).rows;
  res.json({ periods, period, expenses, rates, channels });
});

// ===== Периоды =====
router.post('/api/periods', J, async (req, res) => {
  const b = req.body || {};
  const period = (b.period || '').trim() || new Date().toISOString().slice(0, 7);
  try {
    const r = await db.pool.query(
      `INSERT INTO calculation_periods (period, avg_monthly_output, vat_rate, profit_tax_rate, status, comment)
       VALUES ($1,$2,$3,$4,'draft',$5) RETURNING id`,
      [period, asNum(b.avg_monthly_output), b.vat_rate != null ? asNum(b.vat_rate) : 12, b.profit_tax_rate != null ? asNum(b.profit_tax_rate) : 15, b.comment || '']);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    res.status(400).json({ error: /unique/i.test(e.message) ? 'Такой период уже есть' : e.message });
  }
});

const PERIOD_FIELDS = ['period', 'avg_monthly_output', 'vat_rate', 'profit_tax_rate', 'status', 'comment'];
router.post('/api/periods/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  // Активным может быть только один период.
  if (b.status === 'active') await db.pool.query("UPDATE calculation_periods SET status='draft' WHERE status='active' AND id<>$1", [req.params.id]);
  const sets = [], vals = []; let i = 1;
  for (const f of PERIOD_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (['avg_monthly_output', 'vat_rate', 'profit_tax_rate'].includes(f)) v = asNum(v);
    sets.push(`${f}=$${i++}`); vals.push(v);
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  try {
    await db.pool.query(`UPDATE calculation_periods SET ${sets.join(',')} WHERE id=$${i}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: /unique/i.test(e.message) ? 'Такой период уже есть' : e.message }); }
});

router.delete('/api/periods/:id(\\d+)', async (req, res) => {
  await db.pool.query('DELETE FROM calculation_periods WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ФОТ из «Персонала»: сумма окладов активных сотрудников (всего и по отделам).
router.get('/api/hr-fot', async (req, res) => {
  try {
    const tot = (await db.pool.query("SELECT COALESCE(SUM(base_salary),0) AS s, COUNT(*)::int AS n FROM hr_employees WHERE status='active'")).rows[0];
    const byDept = (await db.pool.query(
      `SELECT COALESCE(d.name,'Без отдела') AS department, COALESCE(SUM(e.base_salary),0) AS amount, COUNT(*)::int AS n
       FROM hr_employees e LEFT JOIN hr_departments d ON d.id=e.department_id
       WHERE e.status='active' GROUP BY d.name ORDER BY amount DESC`)).rows;
    res.json({ ok: true, total: asNum(tot.s), count: asNum(tot.n), byDept });
  } catch (e) { res.status(500).json({ error: 'Не удалось прочитать «Персонал»: ' + e.message }); }
});

// ===== Статьи затрат =====
router.post('/api/expenses', J, async (req, res) => {
  const b = req.body || {};
  const mx = asNum((await db.pool.query('SELECT COALESCE(MAX(sort_order),0)+10 AS s FROM calculation_expense_items WHERE period_id=$1', [intOrNull(b.period_id)])).rows[0].s);
  const r = await db.pool.query(
    `INSERT INTO calculation_expense_items (period_id, cost_block, expense_name, expense_type, amount_month, include_in_calc, source, comment, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [intOrNull(b.period_id), b.cost_block || 'Прочее', b.expense_name || 'Новая статья', b.expense_type === 'variable' ? 'variable' : 'fixed',
      asNum(b.amount_month), b.include_in_calc == null ? true : asBool(b.include_in_calc), b.source || 'manual', b.comment || '', mx]);
  res.json({ ok: true, id: r.rows[0].id });
});

const EXP_FIELDS = ['cost_block', 'expense_name', 'expense_type', 'amount_month', 'include_in_calc', 'source', 'comment'];
router.post('/api/expenses/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  for (const f of EXP_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (f === 'amount_month') v = asNum(v);
    else if (f === 'include_in_calc') v = asBool(v);
    else if (f === 'expense_type') v = v === 'variable' ? 'variable' : 'fixed';
    sets.push(`${f}=$${i++}`); vals.push(v);
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  await db.pool.query(`UPDATE calculation_expense_items SET ${sets.join(',')} WHERE id=$${i}`, vals);
  res.json({ ok: true });
});

router.delete('/api/expenses/:id(\\d+)', async (req, res) => {
  await db.pool.query('DELETE FROM calculation_expense_items WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ===== Ставки =====
router.post('/api/rates', J, async (req, res) => {
  const b = req.body || {};
  const r = await db.pool.query(
    'INSERT INTO calculation_rates (period_id, name, rate_percent, applies_to, is_active, comment) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [intOrNull(b.period_id), b.name || 'Ставка', asNum(b.rate_percent), b.applies_to || '', b.is_active == null ? true : asBool(b.is_active), b.comment || '']);
  res.json({ ok: true, id: r.rows[0].id });
});

const RATE_FIELDS = ['name', 'rate_percent', 'applies_to', 'is_active', 'comment'];
router.post('/api/rates/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  for (const f of RATE_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (f === 'rate_percent') v = asNum(v);
    else if (f === 'is_active') v = asBool(v);
    sets.push(`${f}=$${i++}`); vals.push(v);
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  await db.pool.query(`UPDATE calculation_rates SET ${sets.join(',')} WHERE id=$${i}`, vals);
  res.json({ ok: true });
});

router.delete('/api/rates/:id(\\d+)', async (req, res) => {
  await db.pool.query('DELETE FROM calculation_rates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ===== Каналы =====
router.post('/api/channels', J, async (req, res) => {
  const b = req.body || {};
  const r = await db.pool.query(
    'INSERT INTO calculation_channels (period_id, channel_name, retro_rate, vat_rate, price_from_sd, is_active, comment) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [intOrNull(b.period_id), b.channel_name || 'Канал', asNum(b.retro_rate), b.vat_rate != null ? asNum(b.vat_rate) : 12,
      b.price_from_sd == null ? true : asBool(b.price_from_sd), b.is_active == null ? true : asBool(b.is_active), b.comment || '']);
  res.json({ ok: true, id: r.rows[0].id });
});

const CH_FIELDS = ['channel_name', 'retro_rate', 'vat_rate', 'price_from_sd', 'is_active', 'comment'];
router.post('/api/channels/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  for (const f of CH_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (['retro_rate', 'vat_rate'].includes(f)) v = asNum(v);
    else if (['price_from_sd', 'is_active'].includes(f)) v = asBool(v);
    sets.push(`${f}=$${i++}`); vals.push(v);
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  await db.pool.query(`UPDATE calculation_channels SET ${sets.join(',')} WHERE id=$${i}`, vals);
  res.json({ ok: true });
});

router.delete('/api/channels/:id(\\d+)', async (req, res) => {
  await db.pool.query('DELETE FROM calculation_channels WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
