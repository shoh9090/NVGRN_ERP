// calculation.js — плановая калькуляция себестоимости по рецептурам.
// Источник правды: рецептура + зафиксированная цена в калькуляции + текущая рыночная цена.
const express = require('express');
const db = require('./db');

const router = express.Router();
const J = express.json({ limit: '2mb' });

let _ready = false;

const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : parseInt(v, 10));
const asNum = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));

async function ensureSchema() {
  if (_ready) return;
  const q = (sql, params) => db.pool.query(sql, params);

  await q(`CREATE TABLE IF NOT EXISTS calc_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by INT
  )`);

  await q(`CREATE TABLE IF NOT EXISTS calc_material_prices (
    item_kind TEXT NOT NULL,                         -- raw | packaging
    item_id INT NOT NULL,
    calc_price NUMERIC,                              -- цена, зафиксированная в калькуляции
    market_price NUMERIC,                            -- новая/рыночная цена сейчас
    market_price_at DATE,
    comment TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by INT,
    PRIMARY KEY (item_kind, item_id)
  )`);

  // Группы товаров для калькуляции (розница / хорека / …) — заводит пользователь в настройках.
  await q(`CREATE TABLE IF NOT EXISTS calc_groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  for (const [name, sort] of [['Розница', 10], ['Хорека', 20]]) {
    await q(`INSERT INTO calc_groups (name, sort_order)
             SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM calc_groups WHERE lower(name)=lower($1))`, [name, sort]);
  }

  await q(`CREATE TABLE IF NOT EXISTS calc_recipes (
    id SERIAL PRIMARY KEY,
    product_id INT REFERENCES ref_finished_goods(id),
    group_id INT REFERENCES calc_groups(id),
    product_name TEXT,
    pack_weight_g NUMERIC DEFAULT 0,
    pack_unit TEXT DEFAULT 'шт',
    sale_price_type_id INT REFERENCES ref_price_types(id),
    sale_price_override NUMERIC,
    retro_pct NUMERIC NOT NULL DEFAULT 0,
    vat_pct NUMERIC NOT NULL DEFAULT 12,
    profit_tax_pct NUMERIC NOT NULL DEFAULT 15,
    waste_pct NUMERIC NOT NULL DEFAULT 3,
    labor_coeff NUMERIC NOT NULL DEFAULT 1,
    production_coeff NUMERIC NOT NULL DEFAULT 1,
    overhead_coeff NUMERIC NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    comment TEXT,
    created_by INT,
    updated_by INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS calc_recipe_items (
    id SERIAL PRIMARY KEY,
    recipe_id INT NOT NULL REFERENCES calc_recipes(id) ON DELETE CASCADE,
    item_kind TEXT NOT NULL,                         -- raw | packaging
    item_id INT NOT NULL,
    qty NUMERIC NOT NULL DEFAULT 0,                  -- raw: граммы, packaging: штуки
    unit TEXT NOT NULL DEFAULT 'г',
    waste_pct NUMERIC NOT NULL DEFAULT 0,
    manual_price NUMERIC,
    sort_order INT NOT NULL DEFAULT 100,
    comment TEXT
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_recipe_items_recipe ON calc_recipe_items(recipe_id)`);
  await q(`ALTER TABLE calc_recipes ADD COLUMN IF NOT EXISTS group_id INT REFERENCES calc_groups(id)`);
  // Второй ценовой сценарий (сравнение ретро, как два блока в Excel «рознич.тара»).
  await q(`ALTER TABLE calc_recipes ADD COLUMN IF NOT EXISTS sale_price_override_b NUMERIC`);
  await q(`ALTER TABLE calc_recipes ADD COLUMN IF NOT EXISTS retro_pct_b NUMERIC`);
  // Постоянные затраты на единицу — свои у каждой группы (розница/хорека/…).
  // NULL = брать общую настройку по умолчанию.
  for (const col of ['monthly_units', 'labor_per_unit', 'production_per_unit', 'overhead_per_unit']) {
    await q(`ALTER TABLE calc_groups ADD COLUMN IF NOT EXISTS ${col} NUMERIC`);
  }

  const defaults = {
    monthly_units: '55000',
    labor_per_unit: '0',
    production_per_unit: '0',
    overhead_per_unit: '0',
    fot_tax_coeff: '1.39',
    sd_price_type_id: '',
    retro_pct: '0',
    vat_pct: '12',
    profit_tax_pct: '15',
    waste_pct: '3',
  };
  for (const [key, value] of Object.entries(defaults)) {
    await q('INSERT INTO calc_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, value]);
  }

  // Реестры постоянных затрат (лист Excel «Произодство»): производственные + накладные, помесячно.
  await q(`CREATE TABLE IF NOT EXISTS calc_cost_items (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL,                               -- production | overhead
    name TEXT NOT NULL,
    amount NUMERIC NOT NULL DEFAULT 0,               -- сумма в месяц
    sort INT NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const costCount = (await q("SELECT COUNT(*)::int AS n FROM calc_cost_items")).rows[0].n;
  if (costCount === 0) {
    const seed = [
      ['production', 'Аренда', 11480800, 10],
      ['production', 'Электроэнергия и пр.', 4500000, 20],
      ['overhead', 'Сертификация и лаборатория', 1000000, 10],
      ['overhead', 'Логистика', 3500000, 20],
      ['overhead', 'Закупки для производства', 3000000, 30],
      ['overhead', 'Банковские услуги', 1300000, 40],
      ['overhead', 'Административные расходы', 7000000, 50],
      ['overhead', 'Маркетинг', 1200000, 60],
      ['overhead', 'Кредиты', 5227156, 70],
      ['overhead', 'Прочие (вода, канализация)', 312000, 80],
    ];
    for (const [kind, name, amount, sort] of seed) {
      await q('INSERT INTO calc_cost_items (kind, name, amount, sort) VALUES ($1,$2,$3,$4)', [kind, name, amount, sort]);
    }
  }

  _ready = true;
}

router.use(async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('calculation', { settings, user: req.user });
});

async function settingsMap() {
  const rows = await db.pool.query('SELECT key, value FROM calc_settings');
  const out = {};
  for (const r of rows.rows) out[r.key] = r.value;
  return out;
}

async function priceMap() {
  const rows = await db.pool.query(`
    WITH live AS (
      SELECT i.item_kind, i.item_id, COALESCE(i.fact_price, i.price) AS price,
             COALESCE(po.received_at::date, po.delivery_date, po.created_at::date) AS price_date,
             'purchase' AS source
      FROM purchase_order_items i
      JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
      WHERE COALESCE(i.fact_price, i.price) > 0
    ),
    hist AS (
      SELECT item_kind, item_id, price, price_date, 'import' AS source
      FROM price_history_import
      WHERE price > 0
    ),
    points AS (
      SELECT * FROM live
      UNION ALL
      SELECT * FROM hist
    ),
    ranked AS (
      SELECT item_kind, item_id, price, price_date, source,
             ROW_NUMBER() OVER (PARTITION BY item_kind, item_id ORDER BY price_date DESC NULLS LAST) AS rn
      FROM points
    ),
    last_price AS (
      SELECT l.item_kind, l.item_id, l.price, l.price_date, l.source, p.price AS prev_price
      FROM ranked l
      LEFT JOIN ranked p ON p.item_kind = l.item_kind AND p.item_id = l.item_id AND p.rn = 2
      WHERE l.rn = 1
    )
    SELECT COALESCE(m.item_kind, lp.item_kind) AS item_kind,
           COALESCE(m.item_id, lp.item_id) AS item_id,
           (m.item_kind IS NOT NULL) AS has_manual,
           m.calc_price, m.market_price, m.market_price_at, m.comment,
           lp.price AS last_purchase_price, lp.price_date AS last_purchase_at, lp.source AS last_source,
           lp.prev_price AS prev_purchase_price
    FROM calc_material_prices m
    FULL OUTER JOIN last_price lp ON lp.item_kind = m.item_kind AND lp.item_id = m.item_id
  `);
  const map = {};
  for (const r of rows.rows) {
    map[`${r.item_kind}:${r.item_id}`] = {
      calc_price: numOrNull(r.calc_price),
      market_price: numOrNull(r.market_price),
      has_manual: !!r.has_manual,
      market_price_at: r.market_price_at,
      comment: r.comment || '',
      last_purchase_price: numOrNull(r.last_purchase_price),
      last_purchase_at: r.last_purchase_at,
      last_source: r.last_source || '',
      prev_purchase_price: numOrNull(r.prev_purchase_price),
    };
  }
  return map;
}

async function getMaterials() {
  const prices = await priceMap();
  const rows = await db.pool.query(`
    SELECT 'raw' AS kind, rm.id, rm.code, rm.name, COALESCE(u.short_name, 'кг') AS unit,
           c.name AS category_name, pc.name AS parent_name, rm.characteristics AS characteristics
    FROM ref_raw_materials rm
    LEFT JOIN ref_units u ON u.id = rm.unit_id
    LEFT JOIN ref_categories c ON c.id = rm.category_id
    LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_id
    WHERE rm.status = 'active'
    UNION ALL
    SELECT 'packaging' AS kind, pk.id, pk.code, pk.name, COALESCE(u.short_name, 'шт') AS unit,
           c.name AS category_name, pc.name AS parent_name, pk.size AS characteristics
    FROM ref_packaging pk
    LEFT JOIN ref_units u ON u.id = pk.unit_id
    LEFT JOIN ref_categories c ON c.id = pk.category_id
    LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_id
    WHERE pk.status = 'active'
    ORDER BY name
  `);
  const seeds = [];
  const mapped = rows.rows.map((m) => {
    const p = prices[`${m.kind}:${m.id}`] || {};
    const last = asNum(p.last_purchase_price);
    if (!p.has_manual && p.last_purchase_price != null) seeds.push([m.kind, m.id, p.last_purchase_price]);
    const calc = p.calc_price != null ? asNum(p.calc_price) : last;
    const market = p.market_price != null ? asNum(p.market_price) : last;
    return {
      ...m,
      calc_price: calc,
      market_price: market,
      explicit_calc_price: p.calc_price,
      explicit_market_price: p.market_price,
      last_purchase_price: p.last_purchase_price,
      last_purchase_at: p.last_purchase_at,
      last_source: p.last_source,
      prev_purchase_price: p.prev_purchase_price,
      market_price_at: p.market_price_at,
      price_comment: p.comment || '',
    };
  });
  for (const seed of seeds) {
    await db.pool.query(
      `INSERT INTO calc_material_prices (item_kind, item_id, calc_price, updated_at)
       VALUES ($1,$2,$3,now()) ON CONFLICT (item_kind, item_id) DO NOTHING`,
      seed
    );
  }
  return mapped;
}

async function recipeRows(whereSql = "r.status = 'active'", params = []) {
  // Товар для SD: явный product_id, иначе матч по названию рецептуры (ref_finished_goods).
  // Тип цены: у рецептуры, иначе общий из настроек sd_price_type_id.
  const s = await settingsMap();
  const sdPt = intOrNull(s.sd_price_type_id);
  const rows = await db.pool.query(
    `SELECT r.*, g.name AS fg_name, g.code AS fg_code, g.barcode AS fg_barcode, pt.name AS price_type_name, rp.price AS sd_sale_price,
            grp.name AS group_name,
            grp.labor_per_unit AS g_labor, grp.production_per_unit AS g_production,
            grp.overhead_per_unit AS g_overhead, grp.monthly_units AS g_monthly
     FROM calc_recipes r
     LEFT JOIN ref_finished_goods g ON g.id = r.product_id
     LEFT JOIN LATERAL (
       SELECT fg.id FROM ref_finished_goods fg
       WHERE fg.status='active' AND lower(fg.name) = lower(COALESCE(NULLIF(r.product_name,''), g.name))
       LIMIT 1
     ) gm ON true
     LEFT JOIN ref_price_types pt ON pt.id = r.sale_price_type_id
     LEFT JOIN ref_prices rp ON rp.product_id = COALESCE(r.product_id, gm.id)
            AND rp.price_type_id = COALESCE(r.sale_price_type_id, ${sdPt || 'NULL'})
     LEFT JOIN calc_groups grp ON grp.id = r.group_id
     WHERE ${whereSql}
     ORDER BY r.updated_at DESC, r.id DESC`,
    params
  );
  return rows.rows;
}

function calcLineCost(item, materialsByKey, mode) {
  const material = materialsByKey[`${item.item_kind}:${item.item_id}`] || {};
  const qty = asNum(item.qty);
  const wasteMult = 1 + asNum(item.waste_pct) / 100;
  const manual = numOrNull(item.manual_price);
  const calcPrice = manual != null ? manual : asNum(material.calc_price);
  const marketPrice = manual != null ? manual : asNum(material.market_price || material.last_purchase_price || material.calc_price);
  const price = mode === 'market' ? marketPrice : calcPrice;
  const baseQty = item.item_kind === 'packaging' ? qty : qty / 1000;
  return baseQty * price * wasteMult;
}

// Ценовой блок: наценка/ретро/НДС/прибыль/налог/ЧП по цене и % ретро (общая формула для сценариев A и B).
function priceBlock(costCalc, salePrice, retroPct, vatPct, taxPct) {
  const retro = salePrice * asNum(retroPct) / 100;
  const vat = salePrice * asNum(vatPct) / 100;
  const profit = salePrice - costCalc - retro - vat;
  const profitTax = Math.max(profit, 0) * asNum(taxPct) / 100;
  const netProfit = profit - profitTax;
  return {
    sale_price: salePrice, retro_pct: asNum(retroPct), retro, vat, profit, profit_tax: profitTax, net_profit: netProfit,
    markup_pct: costCalc ? (salePrice - costCalc) / costCalc * 100 : null,
    margin_pct: salePrice ? netProfit / salePrice * 100 : null,
  };
}

function recipeSummary(recipe, items, materials, settings) {
  const materialsByKey = {};
  for (const m of materials) materialsByKey[`${m.kind}:${m.id}`] = m;

  const itemRows = items.map((it) => {
    const m = materialsByKey[`${it.item_kind}:${it.item_id}`] || {};
    const calcCost = calcLineCost(it, materialsByKey, 'calc');
    const marketCost = calcLineCost(it, materialsByKey, 'market');
    return {
      ...it,
      item_name: m.name || '',
      item_code: m.code || '',
      item_unit: m.unit || '',
      category_name: m.category_name || '',
      calc_price: it.manual_price != null ? asNum(it.manual_price) : asNum(m.calc_price),
      market_price: it.manual_price != null ? asNum(it.manual_price) : asNum(m.market_price || m.last_purchase_price || m.calc_price),
      last_purchase_price: m.last_purchase_price,
      calc_cost: calcCost,
      market_cost: marketCost,
    };
  });

  const itemCalc = itemRows.reduce((s, x) => s + asNum(x.calc_cost), 0);
  const itemMarket = itemRows.reduce((s, x) => s + asNum(x.market_cost), 0);
  // Постоянные затраты берём из группы рецептуры; если у группы пусто — из общих настроек.
  const perUnit = (groupVal, settingKey) => (groupVal != null ? asNum(groupVal) : asNum(settings[settingKey]));
  const labor = perUnit(recipe.g_labor, 'labor_per_unit') * asNum(recipe.labor_coeff);
  const production = perUnit(recipe.g_production, 'production_per_unit') * asNum(recipe.production_coeff);
  const overhead = perUnit(recipe.g_overhead, 'overhead_per_unit') * asNum(recipe.overhead_coeff);
  const fixed = labor + production + overhead;
  const wasteMult = 1 + asNum(recipe.waste_pct) / 100;
  const costCalc = (itemCalc + fixed) * wasteMult;
  const costMarket = (itemMarket + fixed) * wasteMult;
  const salePrice = recipe.sale_price_override != null ? asNum(recipe.sale_price_override) : asNum(recipe.sd_sale_price);
  const pb = priceBlock(costCalc, salePrice, recipe.retro_pct, recipe.vat_pct, recipe.profit_tax_pct);
  const marketDelta = costMarket - costCalc;
  return {
    items: itemRows,
    summary: {
      item_calc: itemCalc,
      item_market: itemMarket,
      labor,
      production,
      overhead,
      fixed,
      cost_calc: costCalc,
      cost_market: costMarket,
      market_delta: marketDelta,
      sale_price: salePrice,
      retro: pb.retro,
      vat: pb.vat,
      profit: pb.profit,
      profit_tax: pb.profit_tax,
      net_profit: pb.net_profit,
      margin_pct: pb.margin_pct,
    },
  };
}

async function getRecipe(id) {
  const rows = await recipeRows('r.id = $1', [id]);
  if (!rows.length) return null;
  const recipe = rows[0];
  const items = (await db.pool.query(
    'SELECT * FROM calc_recipe_items WHERE recipe_id = $1 ORDER BY sort_order, id',
    [id]
  )).rows;
  const materials = await getMaterials();
  const settings = await settingsMap();
  const calculated = recipeSummary(recipe, items, materials, settings);
  return { recipe, items: calculated.items, summary: calculated.summary };
}

router.get('/api/dicts', async (req, res) => {
  const priceTypes = (await db.pool.query("SELECT id, name, payment_type FROM ref_price_types WHERE status='active' ORDER BY name")).rows;
  const products = (await db.pool.query(
    `SELECT g.id, g.name, g.code, g.barcode, c.name AS category_name
     FROM ref_finished_goods g
     LEFT JOIN ref_categories c ON c.id = g.category_id
     WHERE g.status='active'
     ORDER BY g.name LIMIT 3000`
  )).rows;
  const groups = (await db.pool.query(
    "SELECT id, name, sort_order, monthly_units, labor_per_unit, production_per_unit, overhead_per_unit FROM calc_groups WHERE status='active' ORDER BY sort_order, name"
  )).rows;
  res.json({ priceTypes, products, groups, settings: await settingsMap() });
});

// Группы товаров (розница/хорека/…) — CRUD из настроек.
router.get('/api/groups', async (req, res) => {
  const rows = (await db.pool.query(
    "SELECT id, name, sort_order, status, monthly_units, labor_per_unit, production_per_unit, overhead_per_unit FROM calc_groups WHERE status='active' ORDER BY sort_order, name"
  )).rows;
  res.json({ items: rows });
});
router.post('/api/group', J, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Пустое название' });
  const id = intOrNull(req.body.id);
  const sort = numOrNull(req.body.sort_order) ?? 100;
  const fx = [numOrNull(req.body.monthly_units), numOrNull(req.body.labor_per_unit), numOrNull(req.body.production_per_unit), numOrNull(req.body.overhead_per_unit)];
  if (id) {
    await db.pool.query(
      'UPDATE calc_groups SET name=$1, sort_order=$2, monthly_units=$3, labor_per_unit=$4, production_per_unit=$5, overhead_per_unit=$6 WHERE id=$7',
      [name, sort, ...fx, id]);
  } else {
    await db.pool.query(
      'INSERT INTO calc_groups (name, sort_order, monthly_units, labor_per_unit, production_per_unit, overhead_per_unit) VALUES ($1,$2,$3,$4,$5,$6)',
      [name, sort, ...fx]);
  }
  await db.log(req.user.id, 'calc_group_save', name);
  res.json({ ok: true });
});
router.post('/api/group/:id(\\d+)/archive', async (req, res) => {
  await db.pool.query("UPDATE calc_groups SET status='archived' WHERE id=$1", [req.params.id]);
  await db.log(req.user.id, 'calc_group_archive', '#' + req.params.id);
  res.json({ ok: true });
});

// Разовая загрузка листовых рецептур (100г, розница) из таблицы Шоха.
// Идемпотентно: рецептуру с таким же названием второй раз не создаёт.
// Цены зелени/упаковки фиксируются в строке (manual_price), чтобы с/с совпал с Excel.
const LEAFY_SEED = [
  // name, зелень-поиск, граммы, цена зелени сум/кг, цена продажи, laborCoeff, prodCoeff
  ['Латук 100г', 'латук', 100, 17000, 21000, 1, 1],
  ['Романо 100г', 'романо', 100, 20000, 24000, 1, 1],
  ['Рукола 100г', 'рукол', 100, 30000, 20500, 0.5, 0.5],
  ['Шпинат 100г', 'шпинат', 100, 25000, 28700, 1, 1],
  ['Кейл 100г', 'кейл', 100, 35000, 25500, 1, 1],
  ['Мангольд 100г', 'мангольд', 100, 50000, 22400, 1, 1],
  ['Лоло-россо 100г', 'лоло', 100, 17000, 24600, 1, 1],
  ['Айсберг 150г', 'айсберг', 150, 12000, 20500, 1, 1],
];
router.post('/api/seed-leafy', async (req, res) => {
  const PACK_PRICE = 1007.25;
  const grp = (await db.pool.query("SELECT id FROM calc_groups WHERE lower(name)='розница' AND status='active' LIMIT 1")).rows[0];
  if (!grp) return res.status(400).json({ error: 'Нет группы «Розница»' });
  // Постоянные затраты группы «Розница» (линия бэби-лиф) — только если ещё пусто.
  await db.pool.query(
    `UPDATE calc_groups SET labor_per_unit=COALESCE(labor_per_unit,4792.98),
       production_per_unit=COALESCE(production_per_unit,290.56),
       overhead_per_unit=COALESCE(overhead_per_unit,409.80),
       monthly_units=COALESCE(monthly_units,55000) WHERE id=$1`, [grp.id]);
  const pack = (await db.pool.query(
    "SELECT id FROM ref_packaging WHERE status='active' AND (name ILIKE '%вак%' OR name ILIKE '%пакет%') ORDER BY name LIMIT 1"
  )).rows[0];
  const findGreen = async (needle) => (await db.pool.query(
    "SELECT id FROM ref_raw_materials WHERE status='active' AND name ILIKE $1 ORDER BY (lower(name)=lower($2)) DESC, length(name) ASC LIMIT 1",
    ['%' + needle + '%', needle]
  )).rows[0];

  const created = [], skipped = [], noGreen = [];
  const client = await db.pool.connect();
  try {
    for (const [name, needle, grams, greenPrice, salePrice, laborC, prodC] of LEAFY_SEED) {
      const exists = (await client.query('SELECT id FROM calc_recipes WHERE lower(product_name)=lower($1) LIMIT 1', [name])).rows[0];
      if (exists) { skipped.push(name); continue; }
      const green = await findGreen(needle);
      if (!green) noGreen.push(name);
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO calc_recipes (group_id, product_name, pack_weight_g, pack_unit, sale_price_override,
           retro_pct, vat_pct, profit_tax_pct, waste_pct, labor_coeff, production_coeff, overhead_coeff, created_by, updated_by)
         VALUES ($1,$2,$3,'шт',$4,21,12,15,50,$5,$6,1,$7,$7) RETURNING id`,
        [grp.id, name, grams, salePrice, laborC, prodC, req.user.id]);
      const rid = r.rows[0].id;
      let sort = 0;
      if (green) {
        await client.query(
          `INSERT INTO calc_recipe_items (recipe_id, item_kind, item_id, qty, unit, waste_pct, manual_price, sort_order)
           VALUES ($1,'raw',$2,$3,'г',0,$4,10)`, [rid, green.id, grams, greenPrice]);
        sort = 10;
      }
      if (pack) {
        await client.query(
          `INSERT INTO calc_recipe_items (recipe_id, item_kind, item_id, qty, unit, waste_pct, manual_price, sort_order)
           VALUES ($1,'packaging',$2,1,'шт',0,$3,$4)`, [rid, pack.id, PACK_PRICE, sort + 10]);
      }
      await client.query('COMMIT');
      created.push(name);
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
  await db.log(req.user.id, 'calc_seed_leafy', `created=${created.length} skipped=${skipped.length}`);
  res.json({ ok: true, created, skipped, noGreen, packFound: !!pack });
});

router.get('/api/materials', async (req, res) => {
  res.json({ items: await getMaterials() });
});

router.post('/api/material-price', J, async (req, res) => {
  const kind = req.body.item_kind === 'packaging' ? 'packaging' : 'raw';
  const id = intOrNull(req.body.item_id);
  if (!id) return res.status(400).json({ error: 'Не выбрана позиция' });
  await db.pool.query(
    `INSERT INTO calc_material_prices (item_kind, item_id, calc_price, market_price, market_price_at, comment, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7,now())
     ON CONFLICT (item_kind, item_id) DO UPDATE
       SET calc_price=$3, market_price=$4, market_price_at=COALESCE($5::date, CURRENT_DATE),
           comment=$6, updated_by=$7, updated_at=now()`,
    [kind, id, numOrNull(req.body.calc_price), numOrNull(req.body.market_price), req.body.market_price_at || null, req.body.comment || null, req.user.id]
  );
  await db.log(req.user.id, 'calc_material_price', `${kind}#${id}`);
  res.json({ ok: true });
});

router.get('/api/recipes', async (req, res) => {
  const rows = await recipeRows();
  const materials = await getMaterials();
  const settings = await settingsMap();
  const out = [];
  for (const r of rows) {
    const items = (await db.pool.query('SELECT * FROM calc_recipe_items WHERE recipe_id=$1 ORDER BY sort_order, id', [r.id])).rows;
    out.push({ recipe: r, summary: recipeSummary(r, items, materials, settings).summary, item_count: items.length });
  }
  res.json({ items: out });
});

router.get('/api/recipe/:id(\\d+)', async (req, res) => {
  const data = await getRecipe(req.params.id);
  if (!data) return res.status(404).json({ error: 'Рецептура не найдена' });
  res.json(data);
});

router.post('/api/recipe', J, async (req, res) => {
  const b = req.body || {};
  const productId = intOrNull(b.product_id);
  const productName = String(b.product_name || '').trim();
  if (!productId && !productName) return res.status(400).json({ error: 'Выберите товар или укажите название' });

  let id = intOrNull(b.id);
  const settings = await settingsMap();
  const args = [
    productId,
    intOrNull(b.group_id),
    productName || null,
    numOrNull(b.pack_weight_g),
    String(b.pack_unit || 'шт').trim() || 'шт',
    intOrNull(b.sale_price_type_id),
    numOrNull(b.sale_price_override),
    numOrNull(b.retro_pct) ?? asNum(settings.retro_pct),
    numOrNull(b.vat_pct) ?? asNum(settings.vat_pct),
    numOrNull(b.profit_tax_pct) ?? asNum(settings.profit_tax_pct),
    numOrNull(b.waste_pct) ?? asNum(settings.waste_pct),
    numOrNull(b.labor_coeff) ?? 1,
    numOrNull(b.production_coeff) ?? 1,
    numOrNull(b.overhead_coeff) ?? 1,
    numOrNull(b.sale_price_override_b),
    numOrNull(b.retro_pct_b) ?? 11,
    b.comment || null,
    req.user.id,
  ];
  if (id) {
    await db.pool.query(
      `UPDATE calc_recipes SET product_id=$1, group_id=$2, product_name=$3, pack_weight_g=$4, pack_unit=$5,
       sale_price_type_id=$6, sale_price_override=$7, retro_pct=$8, vat_pct=$9, profit_tax_pct=$10,
       waste_pct=$11, labor_coeff=$12, production_coeff=$13, overhead_coeff=$14,
       sale_price_override_b=$15, retro_pct_b=$16, comment=$17,
       updated_by=$18, updated_at=now() WHERE id=$19`,
      [...args, id]
    );
  } else {
    const r = await db.pool.query(
      `INSERT INTO calc_recipes (product_id, group_id, product_name, pack_weight_g, pack_unit, sale_price_type_id,
       sale_price_override, retro_pct, vat_pct, profit_tax_pct, waste_pct, labor_coeff, production_coeff,
       overhead_coeff, sale_price_override_b, retro_pct_b, comment, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18) RETURNING id`,
      args
    );
    id = r.rows[0].id;
  }
  await db.log(req.user.id, 'calc_recipe_save', `#${id}`);
  res.json({ ok: true, id });
});

router.post('/api/recipe/:id(\\d+)/items', J, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const exists = await db.pool.query('SELECT id FROM calc_recipes WHERE id=$1', [id]);
  if (!exists.rows.length) return res.status(404).json({ error: 'Рецептура не найдена' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM calc_recipe_items WHERE recipe_id=$1', [id]);
    let sort = 0;
    for (const raw of items) {
      const itemKind = raw.item_kind === 'packaging' ? 'packaging' : 'raw';
      const itemId = intOrNull(raw.item_id);
      const qty = numOrNull(raw.qty);
      if (!itemId || !(qty > 0)) continue;
      sort += 10;
      await client.query(
        `INSERT INTO calc_recipe_items (recipe_id, item_kind, item_id, qty, unit, waste_pct, manual_price, sort_order, comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, itemKind, itemId, qty, String(raw.unit || (itemKind === 'raw' ? 'г' : 'шт')).trim(), numOrNull(raw.waste_pct) || 0, numOrNull(raw.manual_price), sort, raw.comment || null]
      );
    }
    await client.query('UPDATE calc_recipes SET updated_by=$1, updated_at=now() WHERE id=$2', [req.user.id, id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
  await db.log(req.user.id, 'calc_recipe_items', `#${id}, items=${items.length}`);
  res.json({ ok: true });
});

// Быстрая правка граммажа из матрицы: только если у рецептуры одна строка сырья.
router.post('/api/recipe/:id(\\d+)/grammage', J, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const qty = numOrNull(req.body.qty);
  if (qty == null || !(qty > 0)) return res.status(400).json({ error: 'Неверный граммаж' });
  const raws = (await db.pool.query("SELECT id FROM calc_recipe_items WHERE recipe_id=$1 AND item_kind='raw'", [id])).rows;
  if (raws.length !== 1) return res.status(400).json({ error: 'Несколько ингредиентов — правьте граммаж в карточке' });
  await db.pool.query('UPDATE calc_recipe_items SET qty=$1 WHERE id=$2', [qty, raws[0].id]);
  await db.pool.query('UPDATE calc_recipes SET pack_weight_g=$1, updated_by=$2, updated_at=now() WHERE id=$3', [qty, req.user.id, id]);
  await db.log(req.user.id, 'calc_recipe_grammage', `#${id}=${qty}`);
  res.json({ ok: true });
});

// Точечная правка полей рецептуры из матрицы (не трогает остальные поля).
router.post('/api/recipe/:id(\\d+)/pricing', J, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fields = [], vals = [];
  const set = (col, v) => { vals.push(v); fields.push(`${col}=$${vals.length}`); };
  for (const col of ['sale_price_override', 'sale_price_override_b', 'retro_pct', 'retro_pct_b', 'waste_pct', 'product_id', 'sale_price_type_id']) {
    if (col in req.body) set(col, numOrNull(req.body[col]));
  }
  if (!fields.length) return res.json({ ok: true });
  vals.push(id);
  await db.pool.query(`UPDATE calc_recipes SET ${fields.join(', ')}, updated_at=now() WHERE id=$${vals.length}`, vals);
  await db.log(req.user.id, 'calc_recipe_pricing', '#' + id);
  res.json({ ok: true });
});

// Правка цены ингредиента из матрицы: manual_price первой строки сырья/упаковки рецептуры.
router.post('/api/recipe/:id(\\d+)/item-price', J, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const kind = req.body.item_kind === 'packaging' ? 'packaging' : 'raw';
  const mp = numOrNull(req.body.manual_price);
  const it = (await db.pool.query(
    'SELECT id FROM calc_recipe_items WHERE recipe_id=$1 AND item_kind=$2 ORDER BY sort_order, id LIMIT 1', [id, kind]
  )).rows[0];
  if (!it) return res.status(400).json({ error: 'Нет строки ' + (kind === 'raw' ? 'сырья' : 'упаковки') + ' — правьте в карточке' });
  await db.pool.query('UPDATE calc_recipe_items SET manual_price=$1 WHERE id=$2', [mp, it.id]);
  await db.pool.query('UPDATE calc_recipes SET updated_at=now() WHERE id=$1', [id]);
  await db.log(req.user.id, 'calc_item_price', `#${id} ${kind}=${mp}`);
  res.json({ ok: true });
});

// Матрица канала (лист «рознич.тара»): рецептуры группы колонками, полный разбор + 2 сценария ретро.
router.get('/api/matrix', async (req, res) => {
  const groupId = intOrNull(req.query.group);
  const where = groupId ? "r.status='active' AND r.group_id = $1" : "r.status='active'";
  const rows = await recipeRows(where, groupId ? [groupId] : []);
  const materials = await getMaterials();
  const settings = await settingsMap();
  const columns = [];
  for (const r of rows) {
    const items = (await db.pool.query('SELECT * FROM calc_recipe_items WHERE recipe_id=$1 ORDER BY sort_order, id', [r.id])).rows;
    const calc = recipeSummary(r, items, materials, settings);
    const s = calc.summary;
    const rawItems = calc.items.filter((it) => it.item_kind === 'raw');
    const packItems = calc.items.filter((it) => it.item_kind === 'packaging');
    const primary = rawItems[0] || null;
    const primaryPack = packItems[0] || null;
    // Цена сценария A — из SD (справочник отпускных цен), иначе зафиксированная в рецептуре.
    const sd = numOrNull(r.sd_sale_price);
    // Прибыль считаем по отгрузочной (ручной) цене; если её нет — по цене из SD.
    const priceAeff = r.sale_price_override != null ? asNum(r.sale_price_override) : (sd != null ? sd : 0);
    const A = priceBlock(s.cost_calc, priceAeff, r.retro_pct, r.vat_pct, r.profit_tax_pct);
    const priceB = r.sale_price_override_b != null ? asNum(r.sale_price_override_b) : priceAeff;
    const B = priceBlock(s.cost_calc, priceB, r.retro_pct_b, r.vat_pct, r.profit_tax_pct);
    columns.push({
      id: r.id,
      name: r.fg_name || r.product_name || 'Без названия',
      barcode: r.fg_barcode || '',
      grammage: asNum(r.pack_weight_g),
      single_raw: rawItems.length === 1,
      primary_raw: primary ? { item_id: primary.item_id, name: primary.item_name, qty: asNum(primary.qty), price: asNum(primary.calc_price) } : null,
      primary_pack: primaryPack ? { item_id: primaryPack.item_id, price: asNum(primaryPack.calc_price) } : null,
      raw_cost: rawItems.reduce((a, x) => a + asNum(x.calc_cost), 0),
      pack_cost: packItems.reduce((a, x) => a + asNum(x.calc_cost), 0),
      labor: s.labor, production: s.production, overhead: s.overhead,
      cost_raw: s.item_calc + s.fixed, cost_calc: s.cost_calc,
      waste_pct: asNum(r.waste_pct), vat_pct: asNum(r.vat_pct), profit_tax_pct: asNum(r.profit_tax_pct),
      product_id: r.product_id || '', product_label: r.fg_name || '', sale_price_type_id: r.sale_price_type_id || '',
      sd_price: sd, from_sd: sd != null,
      A: { ...A, sale_price: priceAeff, price_set: r.sale_price_override != null },
      B: { ...B, price_set: r.sale_price_override_b != null },
    });
  }
  res.json({ group_id: groupId, columns });
});

router.post('/api/recipe/:id(\\d+)/archive', async (req, res) => {
  await db.pool.query("UPDATE calc_recipes SET status='archived', updated_by=$1, updated_at=now() WHERE id=$2", [req.user.id, req.params.id]);
  await db.log(req.user.id, 'calc_recipe_archive', '#' + req.params.id);
  res.json({ ok: true });
});

router.post('/api/settings', J, async (req, res) => {
  const allowed = ['monthly_units', 'labor_per_unit', 'production_per_unit', 'overhead_per_unit', 'retro_pct', 'vat_pct', 'profit_tax_pct', 'waste_pct', 'sd_price_type_id'];
  for (const key of allowed) {
    if (!(key in req.body)) continue;
    await db.pool.query(
      `INSERT INTO calc_settings (key, value, updated_by, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()`,
      [key, String(req.body[key] ?? ''), req.user.id]
    );
  }
  await db.log(req.user.id, 'calc_settings_save');
  res.json({ ok: true, settings: await settingsMap() });
});

// ---------- Затраты (лист «Произодство» + ФОТ из «Персонала») ----------
// ФОТ = сумма окладов активных сотрудников × коэффициент налогов.
async function fotBase() {
  try {
    const r = await db.pool.query("SELECT COALESCE(SUM(base_salary),0) AS base, COUNT(*)::int AS n FROM hr_employees WHERE status='active'");
    return { base: asNum(r.rows[0].base), employees: r.rows[0].n };
  } catch (e) {
    return { base: 0, employees: 0 }; // «Персонал» ещё не создан — не падаем
  }
}
async function costsSummary() {
  const s = await settingsMap();
  const items = (await db.pool.query("SELECT id, kind, name, amount, sort FROM calc_cost_items WHERE status='active' ORDER BY kind, sort, id")).rows;
  const production = items.filter((i) => i.kind === 'production');
  const overhead = items.filter((i) => i.kind === 'overhead');
  const sumOf = (arr) => arr.reduce((a, i) => a + asNum(i.amount), 0);
  const monthly = asNum(s.monthly_units) || 0;
  const coeff = asNum(s.fot_tax_coeff) || 0;
  const fot = await fotBase();
  const fotTotal = fot.base * coeff;
  const per = (v) => (monthly > 0 ? v / monthly : 0);
  const sums = { production: sumOf(production), overhead: sumOf(overhead) };
  return {
    production, overhead, sums,
    monthly_units: monthly, fot_tax_coeff: coeff,
    fot_base: fot.base, fot_employees: fot.employees, fot_total: fotTotal,
    per_unit: { labor: per(fotTotal), production: per(sums.production), overhead: per(sums.overhead) },
  };
}
router.get('/api/costs', async (req, res) => {
  res.json(await costsSummary());
});
router.post('/api/cost-item', J, async (req, res) => {
  const kind = req.body.kind === 'overhead' ? 'overhead' : req.body.kind === 'production' ? 'production' : null;
  if (!kind) return res.status(400).json({ error: 'Неверный тип затрат' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Пустое наименование' });
  const amount = numOrNull(req.body.amount) ?? 0;
  const id = intOrNull(req.body.id);
  if (id) {
    await db.pool.query('UPDATE calc_cost_items SET kind=$1, name=$2, amount=$3 WHERE id=$4', [kind, name, amount, id]);
  } else {
    await db.pool.query('INSERT INTO calc_cost_items (kind, name, amount, sort) VALUES ($1,$2,$3,100)', [kind, name, amount]);
  }
  await db.log(req.user.id, 'calc_cost_item', `${kind}: ${name}`);
  res.json({ ok: true });
});
router.post('/api/cost-item/:id(\\d+)/archive', async (req, res) => {
  await db.pool.query("UPDATE calc_cost_items SET status='archived' WHERE id=$1", [req.params.id]);
  await db.log(req.user.id, 'calc_cost_item_archive', '#' + req.params.id);
  res.json({ ok: true });
});
// Применить: сохранить объём/коэф и записать пересчитанные *_per_unit в общие настройки.
router.post('/api/costs/apply', J, async (req, res) => {
  const setKV = async (key, value) => db.pool.query(
    `INSERT INTO calc_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()`,
    [key, String(value), req.user.id]);
  if (req.body.monthly_units != null) await setKV('monthly_units', asNum(req.body.monthly_units));
  if (req.body.fot_tax_coeff != null) await setKV('fot_tax_coeff', asNum(req.body.fot_tax_coeff));
  const c = await costsSummary();
  await setKV('labor_per_unit', c.per_unit.labor);
  await setKV('production_per_unit', c.per_unit.production);
  await setKV('overhead_per_unit', c.per_unit.overhead);
  await db.log(req.user.id, 'calc_costs_apply', `labor=${Math.round(c.per_unit.labor)} prod=${Math.round(c.per_unit.production)} oh=${Math.round(c.per_unit.overhead)}`);
  res.json({ ok: true, summary: await costsSummary() });
});

module.exports = router;
