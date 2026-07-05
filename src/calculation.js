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

  const defaults = {
    monthly_units: '70000',
    labor_per_unit: '0',
    production_per_unit: '0',
    overhead_per_unit: '0',
    retro_pct: '0',
    vat_pct: '12',
    profit_tax_pct: '15',
    waste_pct: '3',
  };
  for (const [key, value] of Object.entries(defaults)) {
    await q('INSERT INTO calc_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, value]);
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
    last_price AS (
      SELECT DISTINCT ON (item_kind, item_id) item_kind, item_id, price, price_date, source
      FROM points
      ORDER BY item_kind, item_id, price_date DESC NULLS LAST
    )
    SELECT COALESCE(m.item_kind, lp.item_kind) AS item_kind,
           COALESCE(m.item_id, lp.item_id) AS item_id,
           (m.item_kind IS NOT NULL) AS has_manual,
           m.calc_price, m.market_price, m.market_price_at, m.comment,
           lp.price AS last_purchase_price, lp.price_date AS last_purchase_at, lp.source AS last_source
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
    };
  }
  return map;
}

async function getMaterials() {
  const prices = await priceMap();
  const rows = await db.pool.query(`
    SELECT 'raw' AS kind, rm.id, rm.code, rm.name, COALESCE(u.short_name, 'кг') AS unit,
           c.name AS category_name, pc.name AS parent_name
    FROM ref_raw_materials rm
    LEFT JOIN ref_units u ON u.id = rm.unit_id
    LEFT JOIN ref_categories c ON c.id = rm.category_id
    LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_id
    WHERE rm.status = 'active'
    UNION ALL
    SELECT 'packaging' AS kind, pk.id, pk.code, pk.name, COALESCE(u.short_name, 'шт') AS unit,
           c.name AS category_name, pc.name AS parent_name
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
  const rows = await db.pool.query(
    `SELECT r.*, g.name AS fg_name, g.code AS fg_code, pt.name AS price_type_name, rp.price AS sd_sale_price,
            grp.name AS group_name
     FROM calc_recipes r
     LEFT JOIN ref_finished_goods g ON g.id = r.product_id
     LEFT JOIN ref_price_types pt ON pt.id = r.sale_price_type_id
     LEFT JOIN ref_prices rp ON rp.price_type_id = r.sale_price_type_id AND rp.product_id = r.product_id
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
  const labor = asNum(settings.labor_per_unit) * asNum(recipe.labor_coeff);
  const production = asNum(settings.production_per_unit) * asNum(recipe.production_coeff);
  const overhead = asNum(settings.overhead_per_unit) * asNum(recipe.overhead_coeff);
  const fixed = labor + production + overhead;
  const wasteMult = 1 + asNum(recipe.waste_pct) / 100;
  const costCalc = (itemCalc + fixed) * wasteMult;
  const costMarket = (itemMarket + fixed) * wasteMult;
  const salePrice = recipe.sale_price_override != null ? asNum(recipe.sale_price_override) : asNum(recipe.sd_sale_price);
  const retro = salePrice * asNum(recipe.retro_pct) / 100;
  const vat = salePrice * asNum(recipe.vat_pct) / 100;
  const profit = salePrice - costCalc - retro - vat;
  const profitTax = Math.max(profit, 0) * asNum(recipe.profit_tax_pct) / 100;
  const netProfit = profit - profitTax;
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
      retro,
      vat,
      profit,
      profit_tax: profitTax,
      net_profit: netProfit,
      margin_pct: salePrice ? netProfit / salePrice * 100 : null,
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
  const groups = (await db.pool.query("SELECT id, name, sort_order FROM calc_groups WHERE status='active' ORDER BY sort_order, name")).rows;
  res.json({ priceTypes, products, groups, settings: await settingsMap() });
});

// Группы товаров (розница/хорека/…) — CRUD из настроек.
router.get('/api/groups', async (req, res) => {
  const rows = (await db.pool.query("SELECT id, name, sort_order, status FROM calc_groups WHERE status='active' ORDER BY sort_order, name")).rows;
  res.json({ items: rows });
});
router.post('/api/group', J, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Пустое название' });
  const id = intOrNull(req.body.id);
  const sort = numOrNull(req.body.sort_order) ?? 100;
  if (id) {
    await db.pool.query('UPDATE calc_groups SET name=$1, sort_order=$2 WHERE id=$3', [name, sort, id]);
  } else {
    await db.pool.query('INSERT INTO calc_groups (name, sort_order) VALUES ($1,$2)', [name, sort]);
  }
  await db.log(req.user.id, 'calc_group_save', name);
  res.json({ ok: true });
});
router.post('/api/group/:id(\\d+)/archive', async (req, res) => {
  await db.pool.query("UPDATE calc_groups SET status='archived' WHERE id=$1", [req.params.id]);
  await db.log(req.user.id, 'calc_group_archive', '#' + req.params.id);
  res.json({ ok: true });
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
    b.comment || null,
    req.user.id,
  ];
  if (id) {
    await db.pool.query(
      `UPDATE calc_recipes SET product_id=$1, group_id=$2, product_name=$3, pack_weight_g=$4, pack_unit=$5,
       sale_price_type_id=$6, sale_price_override=$7, retro_pct=$8, vat_pct=$9, profit_tax_pct=$10,
       waste_pct=$11, labor_coeff=$12, production_coeff=$13, overhead_coeff=$14, comment=$15,
       updated_by=$16, updated_at=now() WHERE id=$17`,
      [...args, id]
    );
  } else {
    const r = await db.pool.query(
      `INSERT INTO calc_recipes (product_id, group_id, product_name, pack_weight_g, pack_unit, sale_price_type_id,
       sale_price_override, retro_pct, vat_pct, profit_tax_pct, waste_pct, labor_coeff, production_coeff,
       overhead_coeff, comment, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING id`,
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

router.post('/api/recipe/:id(\\d+)/archive', async (req, res) => {
  await db.pool.query("UPDATE calc_recipes SET status='archived', updated_by=$1, updated_at=now() WHERE id=$2", [req.user.id, req.params.id]);
  await db.log(req.user.id, 'calc_recipe_archive', '#' + req.params.id);
  res.json({ ok: true });
});

router.post('/api/settings', J, async (req, res) => {
  const allowed = ['monthly_units', 'labor_per_unit', 'production_per_unit', 'overhead_per_unit', 'retro_pct', 'vat_pct', 'profit_tax_pct', 'waste_pct'];
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

module.exports = router;
