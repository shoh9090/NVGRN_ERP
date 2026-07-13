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
  await q(`ALTER TABLE costing_periods ADD COLUMN IF NOT EXISTS logistics_expenses NUMERIC DEFAULT 0`);

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

// ===== Этап 3: расчёт матрицы себестоимости =====
async function calcSettingsMap() {
  const out = {};
  try { (await db.pool.query('SELECT key, value FROM calc_settings')).rows.forEach((r) => { out[r.key] = r.value; }); } catch (e) {}
  return out;
}

// Цена компонента: ручная → «Настр.» (calc_price) → последний «Закуп» → нет цены.
function resolveCompPrice(comp, pm) {
  if (comp.manual_price != null && comp.manual_price !== '') return { price: asNum(comp.manual_price), source: 'Ручн.' };
  const p = pm[`${comp.component_type === 'packaging' ? 'packaging' : 'raw'}:${comp.component_id}`] || {};
  if (p.calc != null) return { price: asNum(p.calc), source: 'Настр.' };
  if (p.last != null) return { price: asNum(p.last), source: 'Закуп' };
  return { price: 0, source: 'Нет цены' };
}

function computeRow(rec, comps, period, chTerms, pm, sdInfo) {
  const output = asNum(period && period.avg_monthly_output) || 1;
  const laborPer = (asNum(period && period.payroll_with_taxes) / output) * (asNum(rec.labor_coeff) || 1);
  const prodPer = asNum(period && period.production_expenses) / output;
  const ohPer = asNum(period && period.overhead_expenses) / output;
  const logiPer = asNum(period && period.logistics_expenses) / output;
  let raw = 0, pack = 0, other = 0, noPrice = false;
  const items = [];
  for (const c of comps) {
    const waste = 1 + asNum(c.waste_rate) / 100;
    const { price, source } = resolveCompPrice(c, pm);
    const hasQty = asNum(c.qty) > 0 || asNum(c.share_percent) > 0;
    if (source === 'Нет цены' && hasQty) noPrice = true;
    let cost = 0, effQty = asNum(c.qty);
    if (c.component_type === 'raw') {
      let kg;
      if (asNum(c.share_percent) > 0) { effQty = asNum(rec.gram_weight) * asNum(c.share_percent) / 100; kg = effQty / 1000; }
      else if (c.unit === 'кг' || c.unit === 'л') kg = asNum(c.qty);
      else kg = asNum(c.qty) / 1000;
      cost = price * kg * waste;
      raw += cost;
    } else if (c.component_type === 'packaging') {
      cost = price * asNum(c.qty) * waste;
      pack += cost;
    } else {
      cost = price * asNum(c.qty) * waste;
      other += cost;
    }
    items.push({ id: c.id, type: c.component_type, name: c.component_name, qty: effQty, unit: c.unit, waste_rate: asNum(c.waste_rate), price, source, cost });
  }
  const base = raw + pack + laborPer + prodPer + ohPer + logiPer + other;
  const wasteMult = rec.waste_method === 'sku' ? (1 + asNum(rec.sku_waste_rate) / 100) : 1;
  const costWithWaste = base * wasteMult;
  const ct = chTerms[rec.channel] || {};
  const retroR = asNum(ct.retro_rate);
  const vatR = ct.vat_rate != null ? asNum(ct.vat_rate) : asNum(period && period.vat_rate);
  const taxR = ct.profit_tax_rate != null ? asNum(ct.profit_tax_rate) : asNum(period && period.profit_tax_rate);
  // Состояние цены SD: значение / нет цены (привязан, но нет) / не привязан.
  const info = sdInfo || {};
  const price = info.price != null ? asNum(info.price) : null;
  let sdState = 'ok';
  if (price == null) sdState = info.matched ? 'no_price' : 'unlinked';
  const retro = (price || 0) * retroR / 100;
  const vat = (price || 0) * vatR / 100;
  const profit = price != null ? price - retro - vat - costWithWaste : null;
  const tax = profit != null ? Math.max(profit, 0) * taxR / 100 : null;
  const net = profit != null ? profit - tax : null;
  const margin = price ? (net / price) * 100 : null;
  return {
    id: rec.id, name: rec.finished_good_name, channel: rec.channel || '', status: rec.status,
    gram_weight: asNum(rec.gram_weight), comp_count: comps.length, items,
    raw, pack, labor: laborPer, production: prodPer, overhead: ohPer, logistics: logiPer, other,
    base, waste_method: rec.waste_method, waste_rate: rec.waste_method === 'sku' ? asNum(rec.sku_waste_rate) : 0,
    cost_with_waste: costWithWaste, no_price: noPrice,
    sd_price: price, sd_state: sdState, retro_rate: retroR, retro, vat_rate: vatR, vat,
    profit, tax_rate: taxR, tax, net, margin,
  };
}

// Собрать матрицу целиком (переиспользуется в /matrix, экспорте и снапшоте).
async function buildMatrix(periodQuery) {
  const periods = (await db.pool.query('SELECT * FROM costing_periods ORDER BY period DESC')).rows;
  const cur = periodQuery && periods.find((p) => p.period === periodQuery) ? periodQuery : (periods[0] ? periods[0].period : null);
  const period = periods.find((p) => p.period === cur) || null;
  const chRows = (await db.pool.query('SELECT * FROM costing_channel_terms')).rows;
  const chTerms = {}; chRows.forEach((c) => { chTerms[c.channel] = c; });
  const pm = await priceMap();
  const cs = await calcSettingsMap();
  const sdDefault = intOrNull(cs.sd_price_type_id);
  // SD-цена по названию SKU + тип цены канала (иначе общий из настроек).
  const sdRows = await db.pool.query(
    `SELECT r.id, rp.price AS sd_price,
            COALESCE(r.finished_good_id, gm.id) AS matched_id
     FROM costing_recipes r
     LEFT JOIN costing_channel_terms ct ON ct.channel = r.channel
     LEFT JOIN LATERAL (
       SELECT fg.id FROM ref_finished_goods fg
       WHERE fg.status='active' AND lower(fg.name) = lower(r.finished_good_name) LIMIT 1
     ) gm ON true
     LEFT JOIN ref_prices rp ON rp.product_id = COALESCE(r.finished_good_id, gm.id)
            AND rp.price_type_id = COALESCE(ct.sd_price_type_id, ${sdDefault || 'NULL'})
     WHERE r.status <> 'archived'`).catch(() => ({ rows: [] }));
  const sdById = {}; sdRows.rows.forEach((x) => { sdById[x.id] = { price: x.sd_price, matched: x.matched_id != null }; });
  const recs = (await db.pool.query("SELECT * FROM costing_recipes WHERE status <> 'archived' ORDER BY finished_good_name")).rows;
  const allComps = (await db.pool.query('SELECT * FROM costing_recipe_components ORDER BY recipe_id, sort_order, id')).rows;
  const byRecipe = {}; allComps.forEach((c) => { (byRecipe[c.recipe_id] = byRecipe[c.recipe_id] || []).push(c); });
  const rows = recs.map((r) => computeRow(r, byRecipe[r.id] || [], period, chTerms, pm, sdById[r.id]));
  return { period: cur, periodRow: period, rows };
}

router.get('/api/matrix', async (req, res) => {
  const m = await buildMatrix(req.query.period);
  res.json({ period: m.period, rows: m.rows });
});

// Экспорт матрицы в Excel.
router.get('/api/export.xlsx', async (req, res) => {
  const XLSX = require('xlsx');
  const m = await buildMatrix(req.query.period);
  const data = m.rows.map((r, i) => ({
    '№': i + 1, 'SKU': r.name, 'Канал': r.channel, 'Граммаж': r.gram_weight,
    'Сырьё': Math.round(r.raw), 'Упаковка': Math.round(r.pack), 'ФОТ': Math.round(r.labor),
    'Производство': Math.round(r.production), 'Логистика': Math.round(r.logistics), 'Накладные': Math.round(r.overhead), 'Прочее': Math.round(r.other),
    'С/с': Math.round(r.base), 'Отход %': r.waste_rate, 'С/с с отходом': Math.round(r.cost_with_waste),
    'Цена SD': r.sd_price == null ? '' : Math.round(r.sd_price),
    'Ретро': r.sd_price == null ? '' : Math.round(r.retro), 'НДС': r.sd_price == null ? '' : Math.round(r.vat),
    'Прибыль': r.profit == null ? '' : Math.round(r.profit), 'Налог': r.tax == null ? '' : Math.round(r.tax),
    'ЧП': r.net == null ? '' : Math.round(r.net), 'Маржа %': r.margin == null ? '' : Math.round(r.margin * 10) / 10,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'матрица');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="costing-${m.period || 'period'}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ===== Этап 5: снапшоты (фиксация расчёта) + история =====
router.post('/api/snapshot', J, async (req, res) => {
  const m = await buildMatrix((req.body || {}).period);
  if (!m.periodRow) return res.status(400).json({ error: 'Нет периода' });
  const name = (req.body || {}).name || (m.period + ' · ' + new Date().toISOString().slice(0, 10));
  const snap = await db.pool.query(
    'INSERT INTO costing_snapshots (period_id, snapshot_name, created_by) VALUES ($1,$2,$3) RETURNING id',
    [m.periodRow.id, name, req.user ? req.user.id : null]);
  const sid = snap.rows[0].id;
  for (const r of m.rows) {
    await db.pool.query(
      `INSERT INTO costing_snapshot_items (snapshot_id, recipe_id, sku_name, channel,
        raw_cost, packaging_cost, payroll_cost, production_cost, overhead_cost, other_cost,
        waste_rate, base_cost, cost_with_waste, sales_price, retro_rate, retro_amount,
        vat_rate, vat_amount, gross_profit, profit_tax_amount, net_profit, net_margin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [sid, r.id, r.name, r.channel, r.raw, r.pack, r.labor, r.production, r.overhead, r.other,
        r.waste_rate, r.base, r.cost_with_waste, r.sd_price, r.retro_rate, r.retro,
        r.vat_rate, r.vat, r.profit, r.tax, r.net, r.margin]);
  }
  res.json({ ok: true, id: sid, name });
});

router.get('/api/snapshots', async (req, res) => {
  const rows = (await db.pool.query(
    `SELECT s.id, s.snapshot_name, s.snapshot_date, s.created_at, p.period,
            (SELECT COUNT(*) FROM costing_snapshot_items i WHERE i.snapshot_id=s.id)::int AS n,
            (SELECT AVG(net_margin) FROM costing_snapshot_items i WHERE i.snapshot_id=s.id AND sales_price>0) AS avg_margin
     FROM costing_snapshots s LEFT JOIN costing_periods p ON p.id=s.period_id
     ORDER BY s.created_at DESC`)).rows;
  res.json({ items: rows });
});

router.get('/api/snapshot/:id(\\d+)', async (req, res) => {
  const meta = (await db.pool.query(
    `SELECT s.id, s.snapshot_name, s.snapshot_date, p.period FROM costing_snapshots s
     LEFT JOIN costing_periods p ON p.id=s.period_id WHERE s.id=$1`, [req.params.id])).rows[0];
  const items = (await db.pool.query('SELECT * FROM costing_snapshot_items WHERE snapshot_id=$1 ORDER BY sku_name', [req.params.id])).rows;
  // Текущая живая матрица для сравнения (по названию+каналу).
  const live = await buildMatrix(meta ? meta.period : null);
  const liveKey = {}; live.rows.forEach((r) => { liveKey[r.name + '|' + r.channel] = r; });
  const rows = items.map((it) => {
    const l = liveKey[it.sku_name + '|' + (it.channel || '')];
    return { ...it, live_net: l ? l.net : null, live_margin: l ? l.margin : null, live_cost: l ? l.cost_with_waste : null };
  });
  res.json({ meta, rows });
});

router.delete('/api/snapshot/:id(\\d+)', async (req, res) => {
  await db.pool.query('DELETE FROM costing_snapshots WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
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

// ===== Этап 4: Настройки расчёта (период / статьи затрат / каналы) =====
// Пересчёт итогов периода из статей затрат.
async function recalcPeriodTotals(periodId) {
  await db.pool.query(
    `UPDATE costing_periods p SET
       production_expenses = COALESCE((SELECT SUM(amount) FROM costing_expense_items WHERE period_id=p.id AND expense_group='production'),0),
       overhead_expenses  = COALESCE((SELECT SUM(amount) FROM costing_expense_items WHERE period_id=p.id AND expense_group='overhead'),0),
       logistics_expenses = COALESCE((SELECT SUM(amount) FROM costing_expense_items WHERE period_id=p.id AND expense_group='logistics'),0),
       updated_at=now()
     WHERE p.id=$1`, [periodId]);
}

const PERIOD_FIELDS = ['avg_monthly_output', 'payroll_total', 'payroll_with_taxes', 'vat_rate', 'profit_tax_rate', 'status'];
router.post('/api/period/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  for (const f of PERIOD_FIELDS) {
    if (!(f in b)) continue;
    sets.push(`${f}=$${i++}`); vals.push(f === 'status' ? b[f] : asNum(b[f]));
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  await db.pool.query(`UPDATE costing_periods SET ${sets.join(',')} WHERE id=$${i}`, vals);
  res.json({ ok: true });
});

// ФОТ из «Персонала»: оклады активных × коэффициент налогов.
router.post('/api/period/:id(\\d+)/payroll-from-hr', async (req, res) => {
  let base = 0;
  try { base = asNum((await db.pool.query("SELECT COALESCE(SUM(base_salary),0) AS s FROM hr_employees WHERE status='active'")).rows[0].s); } catch (e) {}
  const cs = await calcSettingsMap();
  const coeff = asNum(cs.fot_tax_coeff) || 1.39;
  await db.pool.query('UPDATE costing_periods SET payroll_total=$1, payroll_with_taxes=$2, updated_at=now() WHERE id=$3', [base, base * coeff, req.params.id]);
  res.json({ ok: true, payroll_total: base, payroll_with_taxes: base * coeff, coeff });
});

router.post('/api/expense', J, async (req, res) => {
  const b = req.body || {};
  const periodId = intOrNull(b.period_id);
  const grp = ['production', 'overhead', 'logistics'].includes(b.expense_group) ? b.expense_group : 'overhead';
  const r = await db.pool.query(
    'INSERT INTO costing_expense_items (period_id, expense_group, expense_name, amount) VALUES ($1,$2,$3,$4) RETURNING id',
    [periodId, grp, b.expense_name || 'Статья', asNum(b.amount)]);
  await recalcPeriodTotals(periodId);
  res.json({ ok: true, id: r.rows[0].id });
});

router.post('/api/expense-item/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  if ('expense_name' in b) { sets.push(`expense_name=$${i++}`); vals.push(b.expense_name); }
  if ('expense_group' in b) { sets.push(`expense_group=$${i++}`); vals.push(['production', 'overhead', 'logistics'].includes(b.expense_group) ? b.expense_group : 'overhead'); }
  if ('amount' in b) { sets.push(`amount=$${i++}`); vals.push(asNum(b.amount)); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await db.pool.query(`UPDATE costing_expense_items SET ${sets.join(',')} WHERE id=$${i}`, vals);
  const pid = (await db.pool.query('SELECT period_id FROM costing_expense_items WHERE id=$1', [req.params.id])).rows[0];
  if (pid) await recalcPeriodTotals(pid.period_id);
  res.json({ ok: true });
});

router.delete('/api/expense-item/:id(\\d+)', async (req, res) => {
  const pid = (await db.pool.query('SELECT period_id FROM costing_expense_items WHERE id=$1', [req.params.id])).rows[0];
  await db.pool.query('DELETE FROM costing_expense_items WHERE id=$1', [req.params.id]);
  if (pid) await recalcPeriodTotals(pid.period_id);
  res.json({ ok: true });
});

router.post('/api/channel', J, async (req, res) => {
  const b = req.body || {};
  const r = await db.pool.query(
    'INSERT INTO costing_channel_terms (channel, retro_rate, vat_rate, profit_tax_rate, sd_price_type_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [b.channel || 'Канал', asNum(b.retro_rate), b.vat_rate != null ? asNum(b.vat_rate) : 12, b.profit_tax_rate != null ? asNum(b.profit_tax_rate) : 15, intOrNull(b.sd_price_type_id)]);
  res.json({ ok: true, id: r.rows[0].id });
});

const CH_FIELDS = ['channel', 'retro_rate', 'vat_rate', 'profit_tax_rate', 'sd_price_type_id'];
router.post('/api/channel/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  for (const f of CH_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (f === 'sd_price_type_id') v = intOrNull(v);
    else if (f !== 'channel') v = asNum(v);
    sets.push(`${f}=$${i++}`); vals.push(v);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await db.pool.query(`UPDATE costing_channel_terms SET ${sets.join(',')} WHERE id=$${i}`, vals);
  res.json({ ok: true });
});

router.delete('/api/channel/:id(\\d+)', async (req, res) => {
  await db.pool.query('DELETE FROM costing_channel_terms WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Типы цен SalesDoctor для привязки канала.
router.get('/api/price-types', async (req, res) => {
  const rows = (await db.pool.query("SELECT id, name FROM ref_price_types WHERE status='active' ORDER BY name").catch(() => ({ rows: [] }))).rows;
  res.json({ items: rows });
});

// ===== Этап 4: Упаковка — каталог с ценой (последний Закуп + ручная) =====
router.get('/api/packaging', async (req, res) => {
  const pm = await priceMap();
  const rows = (await db.pool.query(
    `SELECT pk.id, pk.code, pk.name, pk.size, COALESCE(u.short_name,'шт') AS unit
     FROM ref_packaging pk LEFT JOIN ref_units u ON u.id=pk.unit_id
     WHERE pk.status='active' ORDER BY pk.name`).catch(() => ({ rows: [] }))).rows;
  const items = rows.map((m) => {
    const p = pm[`packaging:${m.id}`] || {};
    return { id: m.id, code: m.code, name: m.name, size: m.size, unit: m.unit,
      last_price: p.last, manual_price: p.calc };
  });
  res.json({ items });
});

router.post('/api/packaging/:id(\\d+)/price', J, async (req, res) => {
  const v = numOrNull((req.body || {}).calc_price);
  await db.pool.query(
    `INSERT INTO calc_material_prices (item_kind, item_id, calc_price, updated_at)
     VALUES ('packaging',$1,$2,now())
     ON CONFLICT (item_kind, item_id) DO UPDATE SET calc_price=$2, updated_at=now()`,
    [req.params.id, v]);
  res.json({ ok: true });
});

module.exports = router;
