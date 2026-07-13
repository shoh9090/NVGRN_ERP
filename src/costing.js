// costing.js — «Калькуляция себестоимости» (ребилд по ТЗ TZ_costing_matrix_claude.md).
// Схема costing_*, периодность, снапшоты, каналы. Строится рядом с legacy /calculation.
const express = require('express');
const db = require('./db');

const router = express.Router();
const J = express.json({ limit: '4mb' });

let _ready = false;
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : parseInt(v, 10));
const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const asNum = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));

async function ensureSchema() {
  if (_ready) return;
  const q = (sql, p) => db.pool.query(sql, p);

  await q(`CREATE TABLE IF NOT EXISTS costing_periods (
    id SERIAL PRIMARY KEY,
    period TEXT NOT NULL UNIQUE,
    avg_monthly_output NUMERIC DEFAULT 0,
    payroll_total NUMERIC DEFAULT 0,
    payroll_with_taxes NUMERIC DEFAULT 0,
    production_expenses NUMERIC DEFAULT 0,
    overhead_expenses NUMERIC DEFAULT 0,
    vat_rate NUMERIC DEFAULT 12,
    profit_tax_rate NUMERIC DEFAULT 15,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS costing_expense_items (
    id SERIAL PRIMARY KEY,
    period_id INTEGER REFERENCES costing_periods(id) ON DELETE CASCADE,
    expense_group TEXT NOT NULL,          -- production | overhead | payroll
    expense_name TEXT NOT NULL,
    amount NUMERIC NOT NULL DEFAULT 0,
    allocation_base TEXT DEFAULT 'monthly_output',
    comment TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS costing_channel_terms (
    id SERIAL PRIMARY KEY,
    channel TEXT NOT NULL,
    retro_rate NUMERIC DEFAULT 0,
    vat_rate NUMERIC DEFAULT 12,
    profit_tax_rate NUMERIC DEFAULT 15,
    sd_price_type_id INTEGER,
    comment TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS costing_recipes (
    id SERIAL PRIMARY KEY,
    recipe_code TEXT,
    finished_good_id INTEGER,
    finished_good_code TEXT,
    finished_good_name TEXT NOT NULL,
    channel TEXT DEFAULT '',
    group_name TEXT DEFAULT '',
    gram_weight NUMERIC DEFAULT 0,
    unit TEXT DEFAULT 'шт',
    version TEXT DEFAULT 'v1',
    valid_from DATE,
    valid_to DATE,
    status TEXT DEFAULT 'draft',          -- draft | active | archived
    waste_method TEXT DEFAULT 'sku',      -- component | sku
    sku_waste_rate NUMERIC DEFAULT 0,
    calculation_type TEXT DEFAULT 'plan',
    labor_coeff NUMERIC DEFAULT 1,
    comment TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS costing_recipe_components (
    id SERIAL PRIMARY KEY,
    recipe_id INTEGER REFERENCES costing_recipes(id) ON DELETE CASCADE,
    component_type TEXT NOT NULL,         -- raw | packaging | other
    component_id INTEGER,
    component_code TEXT,
    component_name TEXT NOT NULL,
    qty NUMERIC NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT 'г',
    share_percent NUMERIC DEFAULT 0,
    waste_rate NUMERIC DEFAULT 0,
    price_source TEXT DEFAULT 'last_purchase',
    manual_price NUMERIC,
    comment TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS costing_snapshots (
    id SERIAL PRIMARY KEY,
    period_id INTEGER REFERENCES costing_periods(id),
    snapshot_name TEXT NOT NULL,
    snapshot_date DATE DEFAULT CURRENT_DATE,
    created_by INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS costing_snapshot_items (
    id SERIAL PRIMARY KEY,
    snapshot_id INTEGER REFERENCES costing_snapshots(id) ON DELETE CASCADE,
    recipe_id INTEGER, sku_code TEXT, sku_name TEXT, channel TEXT,
    raw_cost NUMERIC DEFAULT 0, packaging_cost NUMERIC DEFAULT 0, payroll_cost NUMERIC DEFAULT 0,
    production_cost NUMERIC DEFAULT 0, overhead_cost NUMERIC DEFAULT 0, other_cost NUMERIC DEFAULT 0,
    waste_rate NUMERIC DEFAULT 0, base_cost NUMERIC DEFAULT 0, cost_with_waste NUMERIC DEFAULT 0,
    sales_price NUMERIC DEFAULT 0, retro_rate NUMERIC DEFAULT 0, retro_amount NUMERIC DEFAULT 0,
    vat_rate NUMERIC DEFAULT 0, vat_amount NUMERIC DEFAULT 0, gross_profit NUMERIC DEFAULT 0,
    profit_tax_amount NUMERIC DEFAULT 0, net_profit NUMERIC DEFAULT 0, net_margin NUMERIC DEFAULT 0
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_costing_comp_recipe ON costing_recipe_components(recipe_id)`);

  await seedFromLegacy();
  _ready = true;
}

// Идемпотентный перенос из текущего модуля calc_* + сид периода/каналов.
async function seedFromLegacy() {
  const flag = (await db.pool.query("SELECT value FROM calc_settings WHERE key='costing_seed_v1'")).rows[0];
  if (flag) return;
  // 1) Период 2026-07 из calc_settings / calc_cost_items.
  let cs = {};
  try { (await db.pool.query('SELECT key, value FROM calc_settings')).rows.forEach((r) => { cs[r.key] = r.value; }); } catch (e) {}
  const output = asNum(cs.monthly_units) || 55000;
  let prod = 0, oh = 0;
  try {
    const r = await db.pool.query("SELECT kind, COALESCE(SUM(amount),0) AS s FROM calc_cost_items WHERE status='active' GROUP BY kind");
    r.rows.forEach((x) => { if (x.kind === 'production') prod = asNum(x.s); else if (x.kind === 'overhead') oh = asNum(x.s); });
  } catch (e) {}
  let payrollBase = 0;
  try { payrollBase = asNum((await db.pool.query("SELECT COALESCE(SUM(base_salary),0) AS s FROM hr_employees WHERE status='active'")).rows[0].s); } catch (e) {}
  const coeff = asNum(cs.fot_tax_coeff) || 1.39;
  const period = new Date().toISOString().slice(0, 7);
  const pr = await db.pool.query(
    `INSERT INTO costing_periods (period, avg_monthly_output, payroll_total, payroll_with_taxes, production_expenses, overhead_expenses, vat_rate, profit_tax_rate)
     VALUES ($1,$2,$3,$4,$5,$6,12,15) ON CONFLICT (period) DO NOTHING RETURNING id`,
    [period, output, payrollBase, payrollBase * coeff, prod, oh]);
  const periodId = pr.rows[0] ? pr.rows[0].id : (await db.pool.query('SELECT id FROM costing_periods WHERE period=$1', [period])).rows[0].id;
  // 1a) Статьи затрат периода из calc_cost_items (аренда/электро уже в overhead).
  try {
    const items = (await db.pool.query("SELECT kind, name, amount FROM calc_cost_items WHERE status='active' ORDER BY kind, sort")).rows;
    for (const it of items) {
      await db.pool.query('INSERT INTO costing_expense_items (period_id, expense_group, expense_name, amount) VALUES ($1,$2,$3,$4)',
        [periodId, it.kind === 'production' ? 'production' : 'overhead', it.name, it.amount]);
    }
  } catch (e) {}
  // 2) Каналы из групп calc_groups (+ дефолтные ретро из Excel).
  try {
    const groups = (await db.pool.query("SELECT name FROM calc_groups WHERE status='active'")).rows.map((r) => r.name);
    const retroByName = (n) => (/розниц|retail/i.test(n) ? 21 : 0);
    for (const g of groups) {
      await db.pool.query('INSERT INTO costing_channel_terms (channel, retro_rate, vat_rate, profit_tax_rate) VALUES ($1,$2,12,15)', [g, retroByName(g)]);
    }
    if (!groups.length) await db.pool.query("INSERT INTO costing_channel_terms (channel, retro_rate) VALUES ('Розница',21),('Хорека',0)");
  } catch (e) {}
  // 3) Рецептуры + компоненты из calc_recipes / calc_recipe_items.
  try {
    const recs = (await db.pool.query(
      `SELECT r.*, grp.name AS group_name FROM calc_recipes r LEFT JOIN calc_groups grp ON grp.id=r.group_id WHERE r.status='active'`)).rows;
    for (const r of recs) {
      const nr = await db.pool.query(
        `INSERT INTO costing_recipes (finished_good_id, finished_good_name, channel, group_name, gram_weight, sku_waste_rate, waste_method, status, labor_coeff, calculation_type)
         VALUES ($1,$2,$3,$3,$4,$5,'sku','active',$6,'plan') RETURNING id`,
        [intOrNull(r.product_id), r.product_name || r.fg_name || 'SKU', r.group_name || '', asNum(r.pack_weight_g), asNum(r.waste_pct), asNum(r.labor_coeff) || 1]);
      const nid = nr.rows[0].id;
      const comps = (await db.pool.query('SELECT * FROM calc_recipe_items WHERE recipe_id=$1 ORDER BY sort_order, id', [r.id])).rows;
      let sort = 0;
      for (const c of comps) {
        let nm = '';
        try {
          const t = c.item_kind === 'packaging' ? 'ref_packaging' : 'ref_raw_materials';
          nm = (await db.pool.query(`SELECT name FROM ${t} WHERE id=$1`, [c.item_id])).rows[0]?.name || '';
        } catch (e) {}
        sort += 10;
        await db.pool.query(
          `INSERT INTO costing_recipe_components (recipe_id, component_type, component_id, component_name, qty, unit, waste_rate, manual_price, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [nid, c.item_kind === 'packaging' ? 'packaging' : 'raw', c.item_id, nm, asNum(c.qty), c.unit || 'г', asNum(c.waste_pct), numOrNull(c.manual_price), sort]);
      }
    }
  } catch (e) { console.error('costing seed recipes:', e.message); }
  await db.pool.query("INSERT INTO calc_settings (key, value) VALUES ('costing_seed_v1','1') ON CONFLICT (key) DO NOTHING").catch(() => {});
}

router.use(async (req, res, next) => { try { await ensureSchema(); next(); } catch (e) { next(e); } });

router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('costing', { settings, user: req.user });
});

// Данные для скелета: периоды, каналы, настройки периода, счётчики.
router.get('/api/bootstrap', async (req, res) => {
  const periods = (await db.pool.query('SELECT id, period, status FROM costing_periods ORDER BY period DESC')).rows;
  const cur = req.query.period && periods.find((p) => p.period === req.query.period) ? req.query.period : (periods[0] ? periods[0].period : null);
  const period = cur ? (await db.pool.query('SELECT * FROM costing_periods WHERE period=$1', [cur])).rows[0] : null;
  const channels = (await db.pool.query('SELECT * FROM costing_channel_terms ORDER BY channel')).rows;
  const expenses = period ? (await db.pool.query('SELECT id, expense_group, expense_name, amount FROM costing_expense_items WHERE period_id=$1 ORDER BY expense_group, id', [period.id])).rows : [];
  const recipeCount = asNum((await db.pool.query('SELECT COUNT(*)::int AS n FROM costing_recipes')).rows[0].n);
  res.json({ periods, period, channels, expenses, recipeCount });
});

// Список рецептур (для вкладки «Рецептуры», read-only на Этапе 1).
router.get('/api/recipes', async (req, res) => {
  const rows = (await db.pool.query(
    `SELECT r.*, (SELECT COUNT(*) FROM costing_recipe_components c WHERE c.recipe_id=r.id)::int AS comp_count
     FROM costing_recipes r WHERE r.status <> 'archived' ORDER BY r.finished_good_name`)).rows;
  res.json({ items: rows });
});
router.get('/api/recipe/:id(\\d+)/components', async (req, res) => {
  const rows = (await db.pool.query('SELECT * FROM costing_recipe_components WHERE recipe_id=$1 ORDER BY sort_order, id', [req.params.id])).rows;
  res.json({ items: rows });
});

// ===== Этап 2: справочник компонентов с текущей ценой (Закуп/ручная) =====
async function priceMap() {
  const rows = await db.pool.query(`
    WITH live AS (
      SELECT i.item_kind, i.item_id, COALESCE(i.fact_price, i.price) AS price,
             COALESCE(po.received_at::date, po.delivery_date, po.created_at::date) AS price_date
      FROM purchase_order_items i
      JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
      WHERE COALESCE(i.fact_price, i.price) > 0
    ),
    hist AS (SELECT item_kind, item_id, price, price_date FROM price_history_import WHERE price > 0),
    points AS (SELECT * FROM live UNION ALL SELECT * FROM hist),
    ranked AS (
      SELECT item_kind, item_id, price,
             ROW_NUMBER() OVER (PARTITION BY item_kind, item_id ORDER BY price_date DESC NULLS LAST) AS rn
      FROM points)
    SELECT r.item_kind, r.item_id, r.price AS last_price, m.calc_price
    FROM ranked r
    LEFT JOIN calc_material_prices m ON m.item_kind=r.item_kind AND m.item_id=r.item_id
    WHERE r.rn = 1`).catch(() => ({ rows: [] }));
  const map = {};
  for (const r of rows.rows) map[`${r.item_kind}:${r.item_id}`] = { last: numOrNull(r.last_price), calc: numOrNull(r.calc_price) };
  return map;
}

router.get('/api/refs', async (req, res) => {
  const pm = await priceMap();
  const rows = await db.pool.query(`
    SELECT 'raw' AS kind, rm.id, rm.name, COALESCE(u.short_name,'кг') AS unit
      FROM ref_raw_materials rm LEFT JOIN ref_units u ON u.id=rm.unit_id WHERE rm.status='active'
    UNION ALL
    SELECT 'packaging' AS kind, pk.id, pk.name, COALESCE(u.short_name,'шт') AS unit
      FROM ref_packaging pk LEFT JOIN ref_units u ON u.id=pk.unit_id WHERE pk.status='active'
    ORDER BY name`).catch(() => ({ rows: [] }));
  const items = rows.rows.map((m) => {
    const p = pm[`${m.kind}:${m.id}`] || {};
    return { kind: m.kind, id: m.id, name: m.name, unit: m.unit, price: p.calc != null ? p.calc : (p.last != null ? p.last : null) };
  });
  const channels = (await db.pool.query('SELECT channel FROM costing_channel_terms ORDER BY channel')).rows.map((r) => r.channel);
  res.json({ items, channels });
});

// ===== Этап 2: CRUD рецептур =====
const REC_FIELDS = ['finished_good_name', 'channel', 'group_name', 'gram_weight', 'unit', 'version', 'status', 'waste_method', 'sku_waste_rate', 'labor_coeff', 'calculation_type', 'comment'];

router.post('/api/recipe', J, async (req, res) => {
  const b = req.body || {};
  const r = await db.pool.query(
    `INSERT INTO costing_recipes (finished_good_name, channel, group_name, gram_weight, unit, status, waste_method, sku_waste_rate, labor_coeff)
     VALUES ($1,$2,$3,$4,COALESCE($5,'шт'),'draft','sku',$6,$7) RETURNING id`,
    [b.finished_good_name || 'Новый SKU', b.channel || '', b.group_name || '', asNum(b.gram_weight), b.unit || 'шт', asNum(b.sku_waste_rate), asNum(b.labor_coeff) || 1]);
  res.json({ ok: true, id: r.rows[0].id });
});

router.post('/api/recipe/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  for (const f of REC_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (['gram_weight', 'sku_waste_rate', 'labor_coeff'].includes(f)) v = asNum(v);
    sets.push(`${f}=$${i++}`); vals.push(v);
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at=now()');
  vals.push(req.params.id);
  await db.pool.query(`UPDATE costing_recipes SET ${sets.join(',')} WHERE id=$${i}`, vals);
  res.json({ ok: true });
});

router.post('/api/recipe/:id(\\d+)/duplicate', async (req, res) => {
  const id = req.params.id;
  const src = (await db.pool.query('SELECT * FROM costing_recipes WHERE id=$1', [id])).rows[0];
  if (!src) return res.status(404).json({ error: 'Не найдено' });
  const nr = await db.pool.query(
    `INSERT INTO costing_recipes (finished_good_name, channel, group_name, gram_weight, unit, version, status, waste_method, sku_waste_rate, labor_coeff, calculation_type, comment)
     VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11) RETURNING id`,
    [src.finished_good_name + ' (копия)', src.channel, src.group_name, src.gram_weight, src.unit, src.version, src.waste_method, src.sku_waste_rate, src.labor_coeff, src.calculation_type, src.comment]);
  const nid = nr.rows[0].id;
  await db.pool.query(
    `INSERT INTO costing_recipe_components (recipe_id, component_type, component_id, component_code, component_name, qty, unit, share_percent, waste_rate, price_source, manual_price, comment, sort_order)
     SELECT $1, component_type, component_id, component_code, component_name, qty, unit, share_percent, waste_rate, price_source, manual_price, comment, sort_order
     FROM costing_recipe_components WHERE recipe_id=$2`, [nid, id]);
  res.json({ ok: true, id: nid });
});

router.delete('/api/recipe/:id(\\d+)', async (req, res) => {
  if (req.user && req.user.isAdmin) await db.pool.query('DELETE FROM costing_recipes WHERE id=$1', [req.params.id]);
  else await db.pool.query("UPDATE costing_recipes SET status='archived', updated_at=now() WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ===== Этап 2: CRUD компонентов =====
router.post('/api/recipe/:id(\\d+)/component', J, async (req, res) => {
  const b = req.body || {};
  const mx = (await db.pool.query('SELECT COALESCE(MAX(sort_order),0)+10 AS s FROM costing_recipe_components WHERE recipe_id=$1', [req.params.id])).rows[0].s;
  const r = await db.pool.query(
    `INSERT INTO costing_recipe_components (recipe_id, component_type, component_id, component_name, qty, unit, share_percent, waste_rate, price_source, manual_price, sort_order)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'г'),$7,$8,COALESCE($9,'last_purchase'),$10,$11) RETURNING id`,
    [req.params.id, b.component_type || 'raw', intOrNull(b.component_id), b.component_name || 'Компонент', asNum(b.qty), b.unit, asNum(b.share_percent), asNum(b.waste_rate), b.price_source, numOrNull(b.manual_price), mx]);
  res.json({ ok: true, id: r.rows[0].id });
});

const COMP_FIELDS = ['component_type', 'component_id', 'component_name', 'qty', 'unit', 'share_percent', 'waste_rate', 'price_source', 'manual_price'];
router.post('/api/component/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  for (const f of COMP_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (['qty', 'share_percent', 'waste_rate'].includes(f)) v = asNum(v);
    else if (f === 'manual_price') v = numOrNull(v);
    else if (f === 'component_id') v = intOrNull(v);
    sets.push(`${f}=$${i++}`); vals.push(v);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await db.pool.query(`UPDATE costing_recipe_components SET ${sets.join(',')} WHERE id=$${i}`, vals);
  res.json({ ok: true });
});

router.delete('/api/component/:id(\\d+)', async (req, res) => {
  await db.pool.query('DELETE FROM costing_recipe_components WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
