// calculation-matrix.js — сборка матрицы себестоимости (ТЗ 17.3, этап 3).
//
// Ответственность: собрать входные данные (рецептуры + упаковка группы + ФОТ +
// расходы Кассы + выпуск), прогнать каждое изделие через ЕДИНЫЙ двигатель и
// разложить результат в строки-показатели.
//
// Здесь НЕТ своих денежных формул: любая цифра приходит из calculation-engine.
// Строки матрицы формирует сервер, чтобы браузер не знал устройство расчёта.

const engine = require('./calculation-engine');
const sources = require('./calculation-sources');
const groupPolicy = require('./calculation-group-policy');

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));

// --- Входные данные по изделиям группы ------------------------------------
// Возвращает по каждому изделию: карточку, группу, выход рецептуры и состав
// (сырьё из рецептуры + упаковка группы, если у изделия нет своей).
async function loadProductInputs(pool, opts = {}) {
  const where = ["p.status = 'active'"];
  const params = [];
  if (opts.group_id === 'none') where.push('p.group_id IS NULL');
  else if (opts.group_id) { params.push(Number(opts.group_id)); where.push(`p.group_id = $${params.length}`); }

  const products = (await pool.query(
    `SELECT p.*, g.name AS group_name, g.sort_order AS group_sort_order,
            g.price_includes_vat, g.vat_rate, g.retro_rate, g.profit_tax_rate, g.waste_reserve_rate,
            (SELECT id FROM calculation_recipes rc WHERE rc.product_id = p.id AND rc.status <> 'archived'
              ORDER BY (rc.status = 'approved') DESC, rc.version_no DESC LIMIT 1) AS recipe_id
     FROM calculation_products p
     LEFT JOIN calculation_groups g ON g.id = p.group_id
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(g.sort_order, 9999), COALESCE(g.name, 'Я'), p.name`, params)).rows;
  if (!products.length) return [];

  const recipeIds = products.map((p) => p.recipe_id).filter(Boolean);
  const byRecipe = new Map();
  let batchByRecipe = new Map();
  if (recipeIds.length) {
    const rows = (await pool.query(
      `SELECT ri.*, rc.batch_output_qty
       FROM calculation_recipe_items ri
       JOIN calculation_recipes rc ON rc.id = ri.recipe_id
       WHERE ri.recipe_id = ANY($1) ORDER BY ri.sort_order, ri.id`, [recipeIds])).rows;
    rows.forEach((r) => {
      if (!byRecipe.has(r.recipe_id)) byRecipe.set(r.recipe_id, []);
      byRecipe.get(r.recipe_id).push(r);
      batchByRecipe.set(r.recipe_id, num(r.batch_output_qty) || 1);
    });
    // Выход рецептуры нужен и у пустых рецептур.
    const batches = (await pool.query('SELECT id, batch_output_qty FROM calculation_recipes WHERE id = ANY($1)', [recipeIds])).rows;
    batches.forEach((b) => { if (!batchByRecipe.has(b.id)) batchByRecipe.set(b.id, num(b.batch_output_qty) || 1); });
  }

  // Комплекты упаковки групп — одним запросом.
  const groupIds = [...new Set(products.map((p) => p.group_id).filter(Boolean))];
  const packByGroup = new Map();
  if (groupIds.length) {
    const rows = (await pool.query(
      `SELECT group_id, item_id, qty, unit_id, comment FROM calculation_group_packaging
       WHERE group_id = ANY($1) ORDER BY group_id, sort_order, id`, [groupIds])).rows;
    rows.forEach((r) => {
      if (!packByGroup.has(r.group_id)) packByGroup.set(r.group_id, []);
      packByGroup.get(r.group_id).push(r);
    });
  }

  return products.map((p) => {
    const list = byRecipe.get(p.recipe_id) || [];
    const batch = batchByRecipe.get(p.recipe_id) || 1;
    const ownPackaging = list.filter((x) => x.item_kind === 'packaging');
    const items = list.map((x) => ({
      item_kind: x.item_kind, item_id: x.item_id,
      qty_net: num(x.qty_net), loss_rate: num(x.loss_rate),
    }));
    // Упаковка наследуется от группы, если у изделия нет своей (ТЗ 1.1).
    let packagingSource = 'group';
    if (ownPackaging.length) packagingSource = 'product';
    else if (p.group_id) items.push(...groupPolicy.packagingForBatch(packByGroup.get(p.group_id) || [], batch));
    else packagingSource = 'none';
    return { product: p, batch, items, packaging_source: packagingSource };
  });
}

// --- Описание строк матрицы (ТЗ 17.3) -------------------------------------
// detail: true — строка только в подробном виде. format задаёт вид на экране.
const ROWS = [
  { key: 'net_weight', label: 'Граммовка нетто, г', format: 'qty', get: (r, p) => (p.net_weight === null ? null : num(p.net_weight)) },
  { key: 'main_raw', label: 'Основное сырьё', format: 'text', detail: true, get: (r) => {
    const raw = (r.rows || []).filter((x) => x.item_kind === 'raw' && x.cost !== null);
    if (!raw.length) return null;
    return raw.slice().sort((a, b) => b.cost - a.cost)[0].name || null;
  } },
  { key: 'raw', label: 'Стоимость сырья', format: 'money', get: (r) => r.layers.raw },
  { key: 'packaging', label: 'Стоимость упаковки', format: 'money', get: (r) => r.layers.packaging },
  { key: 'fot', label: 'ФОТ с налогами', format: 'money', get: (r) => r.layers.fot_per_unit },
  { key: 'production', label: 'Производственные расходы', format: 'money', detail: true, get: (r) => r.layers.production_per_unit },
  { key: 'admin', label: 'Административные накладные', format: 'money', detail: true, get: (r) => r.layers.admin_per_unit },
  { key: 'before_reserve', label: 'Себестоимость до резерва', format: 'money', detail: true, get: (r) => r.layers.cost_before_reserve },
  { key: 'reserve', label: 'Резерв брака, %', format: 'pct', detail: true, get: (r) => r.layers.waste_reserve_rate },
  { key: 'commercial_oh', label: 'Коммерческие расходы', format: 'money', detail: true, get: (r) => r.layers.commercial_per_unit },
  { key: 'logistics', label: 'Логистика', format: 'money', detail: true, get: (r) => r.layers.logistics_per_unit },
  { key: 'finance', label: 'Финансовые расходы', format: 'money', detail: true, get: (r) => r.layers.finance_per_unit },
  { key: 'full_cost', label: 'Полная себестоимость', format: 'money', strong: true, get: (r) => r.layers.full_cost },
  { key: 'markup', label: 'Наценка к себестоимости, %', format: 'pct', detail: true, get: (r) => r.commercial.markup },
  { key: 'price', label: 'Цена продажи', format: 'money0', strong: true, get: (r) => r.commercial.price },
  { key: 'retro', label: 'Ретро', format: 'money', get: (r) => r.commercial.retro },
  { key: 'vat', label: 'НДС', format: 'money', get: (r) => r.commercial.vat },
  { key: 'profit_before_tax', label: 'Прибыль до налога', format: 'money', detail: true, sign: true, get: (r) => r.commercial.profit_before_tax },
  { key: 'profit_tax', label: 'Расчётный налог на прибыль', format: 'money', detail: true, get: (r) => r.commercial.profit_tax },
  { key: 'net_profit', label: 'Чистая прибыль', format: 'money', sign: true, strong: true, get: (r) => r.commercial.net_profit },
  { key: 'net_margin', label: 'Чистая маржа, %', format: 'pct', sign: true, strong: true, get: (r) => r.commercial.net_margin },
  { key: 'recommended', label: 'Рекомендуемая цена', format: 'money0', get: (r) => (r.recommended ? r.recommended.price : null) },
];

// --- Сборка матрицы -------------------------------------------------------
async function buildMatrix(pool, opts = {}) {
  const period = /^\d{4}-\d{2}$/.test(opts.period || '') ? opts.period : new Date().toISOString().slice(0, 7);
  const outputMode = opts.output_mode === 'actual' ? 'actual' : 'planned';

  const inputs = await loadProductInputs(pool, { group_id: opts.group_id });
  const fot = await sources.monthlyFot(pool, period);
  const cash = await sources.cashExpensesByBucket(pool, period);

  // Общий выпуск — сумма строк изделий периода (всех, не только группы).
  const periodRow = (await pool.query('SELECT * FROM calculation_periods WHERE period = $1', [period])).rows[0] || null;
  let output = { total: 0, products: 0, filled: 0, mode: outputMode };
  if (periodRow) output = await sources.periodOutput(pool, periodRow.id, outputMode);

  // Цены всех компонентов — одним запросом (ТЗ 24: 100 изделий без зависаний).
  const allItems = [].concat(...inputs.map((x) => x.items));
  const priceMap = await sources.lastAcceptedPricesMap(pool, allItems, opts.price_on_date || null);
  const nomInfo = await nomenclatureInfo(pool, allItems);

  const today = new Date().toISOString().slice(0, 10);
  const columns = [];
  for (const inp of inputs) {
    const p = inp.product;
    const rows = inp.items.map((it, idx) => {
      const key = it.item_kind + ':' + Number(it.item_id);
      const nom = nomInfo.get(key) || {};
      const pr = priceMap.get(key) || null;
      return {
        item_kind: it.item_kind, item_id: it.item_id, sort_order: idx,
        name: nom.name || '', code: nom.code || '', unit: nom.unit || '',
        qty_net: it.qty_net, loss_rate: it.loss_rate,
        price: pr ? pr.price : null,
        price_unit: nom.unit || '',
        price_date: pr ? pr.price_date : null,
        price_source: pr ? pr.source : null,
        supplier_name: pr ? pr.supplier_name : null,
        inherited_from_group: !!it.inherited_from_group,
      };
    });
    const commercial = groupPolicy.commercialForGroup(p, { price: p.price === null ? 0 : num(p.price) }, 'standard');
    const result = engine.calculateProduct({
      today,
      recipe: { batch_output_qty: inp.batch, items: rows },
      total_output: output.total,
      fot: { accrued: fot.accrued, inps: fot.inps, ndfl: fot.ndfl, social: fot.social },
      monthly_expenses: cash.buckets,
      commercial,
    });
    columns.push({
      product: p,
      product_id: p.id,
      name: p.name,
      group_id: p.group_id,
      group_name: p.group_name,
      recipe_id: p.recipe_id,
      packaging_source: inp.packaging_source,
      has_recipe: inp.items.some((x) => x.item_kind === 'raw'),
      result,
    });
  }

  // Разложение в строки. Значение = массив по колонкам, в том же порядке.
  const matrixRows = ROWS.map((row) => ({
    key: row.key, label: row.label, format: row.format,
    detail: !!row.detail, strong: !!row.strong, sign: !!row.sign,
    values: columns.map((c) => {
      try { return row.get(c.result, c.product); } catch (e) { return null; }
    }),
  }));

  // Верхние показатели вкладки (ТЗ 17.2).
  const margins = columns.map((c) => c.result.commercial.net_margin).filter((v) => v !== null && Number.isFinite(v));
  const kpi = {
    products: columns.length,
    without_price: columns.filter((c) => c.result.errors.some((e) => e.code === 'PRICE_MISSING' || e.code === 'PRICE_NOT_POSITIVE')).length,
    margin_warnings: columns.filter((c) => c.result.warnings.some((w) => w.code === 'MARGIN_BELOW_TARGET' || w.code === 'PROFIT_NEGATIVE')).length,
    avg_net_margin: margins.length ? margins.reduce((a, v) => a + v, 0) / margins.length : null,
  };

  return {
    period,
    period_row: periodRow,
    output,
    fot,
    cash: { buckets: cash.buckets, unclassified: cash.unclassified },
    warnings: [...fot.warnings, ...cash.warnings],
    columns: columns.map((c) => ({
      product_id: c.product_id, name: c.name, group_id: c.group_id, group_name: c.group_name,
      packaging_source: c.packaging_source, has_recipe: c.has_recipe,
      can_approve: c.result.can_approve,
      errors: c.result.errors, warnings: c.result.warnings,
    })),
    rows: matrixRows,
    kpi,
    formula_version: engine.FORMULA_VERSION,
    // Полные результаты нужны утверждению версии (снимки) — на клиент не отдаём.
    _full: columns,
  };
}

async function nomenclatureInfo(pool, items) {
  const map = new Map();
  const raw = items.filter((x) => x.item_kind !== 'packaging').map((x) => Number(x.item_id)).filter(Boolean);
  const pack = items.filter((x) => x.item_kind === 'packaging').map((x) => Number(x.item_id)).filter(Boolean);
  if (raw.length) {
    const r = await pool.query(
      `SELECT m.id, m.code, m.name, COALESCE(u.short_name,'') AS unit
       FROM ref_raw_materials m LEFT JOIN ref_units u ON u.id = m.unit_id WHERE m.id = ANY($1)`, [[...new Set(raw)]]);
    r.rows.forEach((x) => map.set('raw:' + x.id, x));
  }
  if (pack.length) {
    const r = await pool.query(
      `SELECT m.id, m.code, m.name, COALESCE(u.short_name,'') AS unit
       FROM ref_packaging m LEFT JOIN ref_units u ON u.id = m.unit_id WHERE m.id = ANY($1)`, [[...new Set(pack)]]);
    r.rows.forEach((x) => map.set('packaging:' + x.id, x));
  }
  return map;
}

module.exports = { buildMatrix, loadProductInputs, ROWS };
