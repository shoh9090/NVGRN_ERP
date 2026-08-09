// calculation.js — плитка «Калькуляция себестоимости» (ТЗ TZ_CALCULATION.md).
//
// Ответственность файла (ТЗ 19.1): маршруты, права, транзакции, сбор ответа.
// Формулы живут в calculation-engine.js, чтение источников — в calculation-sources.js,
// схема — в calculation-schema.js. Дублировать формулы здесь запрещено.
//
// Готово: этап 1 (ядро), этап 2 (изделия и рецептуры), этап 2.1 (группы).
// Старая вкладка «Справочники» (статьи затрат/ставки/каналы) убрана из интерфейса;
// её таблицы в базе НЕ удаляются (ТЗ 20.9) — просто больше не используются.
const express = require('express');
const db = require('./db');
const engine = require('./calculation-engine');
const sources = require('./calculation-sources');
const groupPolicy = require('./calculation-group-policy');
const { ensureCalculationSchema } = require('./calculation-schema');
const matrix = require('./calculation-matrix');

const router = express.Router();
const J = express.json({ limit: '2mb' });

const asNum = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const numOrNull = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : parseInt(v, 10) || null);
const asBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const today = () => new Date().toISOString().slice(0, 10);
const curPeriod = () => new Date().toISOString().slice(0, 7);

// --- Права (ТЗ раздел 5) ---------------------------------------------------
// Доступ к странице уже проверен middleware плитки в server.js.
// Внутри: редактирование — финансы/админ; утверждение версии — только админ.
const canEdit = (req) => !!(req.user && (req.user.isAdmin || req.user.isFinance));
const canApprove = (req) => !!(req.user && req.user.isAdmin);
const denyEdit = (res) => res.status(403).json({ error: 'Изменять калькуляцию может финансовый сотрудник или администратор' });

// Виды изделий — маленький технический классификатор карточки (ТЗ 7),
// а не новый пользовательский справочник.
const FAMILIES = [
  { v: 'mono', t: 'Монопродукт' },
  { v: 'mix', t: 'Салат / смесь' },
  { v: 'bunch', t: 'Пучок' },
  { v: 'pot', t: 'Горшок' },
  { v: 'set', t: 'Набор' },
  { v: 'other', t: 'Другое' },
];
const FAMILY_SET = new Set(FAMILIES.map((f) => f.v));

const GROUP_FIELDS = [
  'name', 'price_includes_vat', 'vat_rate', 'retro_rate',
  'profit_tax_rate', 'waste_reserve_rate', 'sort_order', 'status', 'comment',
];
const normGroupValue = (f, v) => {
  if (f === 'price_includes_vat') return asBool(v);
  if (f === 'status') return v === 'archived' ? 'archived' : 'active';
  if (f === 'sort_order') return parseInt(v, 10) || 100;
  if (['vat_rate', 'retro_rate', 'profit_tax_rate', 'waste_reserve_rate'].includes(f)) return asNum(v);
  return v === undefined || v === null ? '' : String(v).trim();
};

async function groupsWithPackaging(includeArchived = false) {
  const where = includeArchived ? '' : "WHERE g.status='active'";
  const groups = (await db.pool.query(
    `SELECT g.*, COUNT(p.id)::int AS product_count
     FROM calculation_groups g
     LEFT JOIN calculation_products p ON p.group_id=g.id AND p.status='active'
     ${where}
     GROUP BY g.id ORDER BY g.sort_order, g.name`)).rows;
  if (!groups.length) return [];

  const packRows = (await db.pool.query(
    `SELECT gp.*, pk.name, pk.code, COALESCE(u.short_name,'') AS unit
     FROM calculation_group_packaging gp
     LEFT JOIN ref_packaging pk ON pk.id=gp.item_id
     LEFT JOIN ref_units u ON u.id=COALESCE(gp.unit_id,pk.unit_id)
     WHERE gp.group_id=ANY($1)
     ORDER BY gp.group_id,gp.sort_order,gp.id`, [groups.map((g) => g.id)])).rows;
  const priceMap = await sources.lastAcceptedPricesMap(db.pool, packRows.map((x) => ({ item_kind: 'packaging', item_id: x.item_id })));
  const byGroup = new Map();
  for (const row of packRows) {
    const price = priceMap.get('packaging:' + row.item_id) || null;
    const item = {
      ...row,
      qty: asNum(row.qty),
      price: price ? price.price : null,
      price_date: price ? price.price_date : null,
      price_source: price ? price.source : null,
      supplier_name: price ? price.supplier_name : null,
      line_cost: price ? asNum(row.qty) * asNum(price.price) : null,
      nomenclature_missing: !row.name,
    };
    if (!byGroup.has(row.group_id)) byGroup.set(row.group_id, []);
    byGroup.get(row.group_id).push(item);
  }
  return groups.map((g) => {
    const packaging = byGroup.get(g.id) || [];
    const known = packaging.filter((x) => x.line_cost !== null);
    return {
      ...g,
      vat_rate: asNum(g.vat_rate), retro_rate: asNum(g.retro_rate),
      profit_tax_rate: asNum(g.profit_tax_rate), waste_reserve_rate: asNum(g.waste_reserve_rate),
      packaging,
      packaging_cost: known.reduce((sum, x) => sum + x.line_cost, 0),
      packaging_missing_prices: packaging.length - known.length,
    };
  });
}

async function validateGroup(groupId, client = db.pool) {
  if (!groupId) return null;
  return (await client.query("SELECT * FROM calculation_groups WHERE id=$1 AND status='active'", [groupId])).rows[0] || null;
}

router.use(async (req, res, next) => {
  try { await ensureCalculationSchema(db.pool); next(); } catch (e) { next(e); }
});

router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('calculation', { settings, user: req.user });
});

// ===========================================================================
// Общие данные страницы (ТЗ 21.1 /bootstrap)
// ===========================================================================
router.get('/api/bootstrap', async (req, res) => {
  try {
    const units = (await db.pool.query('SELECT id, name, short_name FROM ref_units ORDER BY short_name')).rows;
    const groups = await groupsWithPackaging(false);
    const periods = (await db.pool.query('SELECT * FROM calculation_periods ORDER BY period DESC')).rows;
    const active = periods.find((p) => p.status === 'active') || periods[0] || null;
    const activeVersion = (await db.pool.query(
      `SELECT v.id, v.revision_no, v.approved_at, p.period
       FROM calculation_versions v JOIN calculation_periods p ON p.id = v.period_id
       WHERE v.version_kind = 'approved' AND v.status = 'active' LIMIT 1`)).rows[0] || null;
    res.json({
      rights: { can_edit: canEdit(req), can_approve: canApprove(req) },
      families: FAMILIES,
      groups,
      units,
      periods,
      period: active,
      active_version: activeVersion,
      formula_version: engine.FORMULA_VERSION,
      stale_price_days: engine.STALE_PRICE_DAYS,
      defaults: { vat_rate: 12, profit_tax_rate: 15, price_round_step: 500 },
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Группы калькуляции: общие условия и комплект упаковки
// ===========================================================================
router.get('/api/groups', async (req, res) => {
  try { res.json({ items: await groupsWithPackaging(req.query.status === 'all') }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

async function replaceGroupPackaging(client, groupId, items) {
  if (!Array.isArray(items)) return;
  const clean = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const itemId = intOrNull(items[i] && items[i].item_id);
    const qty = asNum(items[i] && items[i].qty);
    if (!itemId) throw new Error('В строке упаковки ' + (i + 1) + ' не выбрана позиция');
    if (!(qty > 0)) throw new Error('Количество упаковки должно быть больше нуля');
    if (seen.has(itemId)) throw new Error('Одна позиция упаковки добавлена дважды');
    seen.add(itemId);
    const row = (await client.query(
      "SELECT id,unit_id FROM ref_packaging WHERE id=$1 AND status='active'", [itemId])).rows[0];
    if (!row) throw new Error('Выбранной позиции упаковки больше нет в номенклатуре');
    clean.push({ itemId, qty, unitId: row.unit_id, comment: String(items[i].comment || '') });
  }
  await client.query('DELETE FROM calculation_group_packaging WHERE group_id=$1', [groupId]);
  for (let i = 0; i < clean.length; i++) {
    const x = clean[i];
    await client.query(
      `INSERT INTO calculation_group_packaging (group_id,item_id,qty,unit_id,sort_order,comment)
       VALUES ($1,$2,$3,$4,$5,$6)`, [groupId, x.itemId, x.qty, x.unitId, i, x.comment]);
  }
}

function validateGroupRates(body) {
  for (const key of ['vat_rate', 'retro_rate', 'profit_tax_rate']) {
    if (body[key] === undefined) continue;
    const value = asNum(body[key]);
    if (value < 0 || value > 100) throw new Error('Ставка должна быть от 0 до 100%');
  }
  if (body.waste_reserve_rate !== undefined) {
    const value = asNum(body.waste_reserve_rate);
    if (value < 0 || value > 500) throw new Error('Резерв брака должен быть от 0 до 500%');
  }
}

router.post('/api/groups', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название группы' });
  const client = await db.pool.connect();
  try {
    validateGroupRates(body);
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO calculation_groups
       (name,price_includes_vat,vat_rate,retro_rate,profit_tax_rate,waste_reserve_rate,sort_order,status,comment,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$9) RETURNING id`,
      [name, body.price_includes_vat === undefined ? true : asBool(body.price_includes_vat),
        body.vat_rate === undefined ? 12 : asNum(body.vat_rate), asNum(body.retro_rate),
        body.profit_tax_rate === undefined ? 15 : asNum(body.profit_tax_rate), asNum(body.waste_reserve_rate),
        parseInt(body.sort_order, 10) || 100, String(body.comment || ''), req.user.id]);
    await replaceGroupPackaging(client, inserted.rows[0].id, body.packaging || []);
    await client.query('COMMIT');
    await db.log(req.user.id, 'calculation_group_create', { id: inserted.rows[0].id, name });
    res.json({ ok: true, id: inserted.rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (/uq_calc_groups_name_active/.test(e.message)) return res.status(400).json({ error: 'Группа с таким названием уже есть' });
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

router.patch('/api/groups/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const body = req.body || {};
  const client = await db.pool.connect();
  try {
    validateGroupRates(body);
    await client.query('BEGIN');
    const current = (await client.query('SELECT * FROM calculation_groups WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!current) throw new Error('Группа не найдена');
    if (body.status === 'archived') {
      const used = (await client.query(
        "SELECT COUNT(*)::int AS n FROM calculation_products WHERE group_id=$1 AND status='active'", [req.params.id])).rows[0].n;
      if (used) throw new Error('Сначала перенесите активные изделия в другую группу');
    }
    const sets = [], vals = [];
    for (const fieldName of GROUP_FIELDS) {
      if (!(fieldName in body)) continue;
      if (fieldName === 'name' && !String(body.name || '').trim()) throw new Error('Название группы не может быть пустым');
      vals.push(normGroupValue(fieldName, body[fieldName]));
      sets.push(`${fieldName}=$${vals.length}`);
    }
    if (sets.length) {
      vals.push(req.user.id); sets.push(`updated_by=$${vals.length}`); sets.push('updated_at=now()');
      vals.push(req.params.id);
      await client.query(`UPDATE calculation_groups SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
    }
    await replaceGroupPackaging(client, Number(req.params.id), body.packaging);
    await client.query('COMMIT');
    await db.log(req.user.id, 'calculation_group_update', { id: Number(req.params.id), fields: Object.keys(body) });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (/uq_calc_groups_name_active/.test(e.message)) return res.status(400).json({ error: 'Группа с таким названием уже есть' });
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// ===========================================================================
// Поиск номенклатуры (ТЗ 21.1 /nomenclature)
// ===========================================================================
// Только существующие ref_raw_materials и ref_packaging. Свой справочник не создаём.
router.get('/api/nomenclature', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ items: [] });   // поиск с 2 символов (ТЗ 24)
    const kind = req.query.kind === 'packaging' ? 'packaging' : req.query.kind === 'raw' ? 'raw' : null;
    const like = '%' + q + '%';
    const parts = [];
    if (kind !== 'packaging') {
      parts.push(`SELECT 'raw' AS item_kind, m.id, m.code, m.name, m.unit_id,
                         COALESCE(u.short_name,'') AS unit, COALESCE(c.name,'') AS category
                  FROM ref_raw_materials m
                  LEFT JOIN ref_units u ON u.id = m.unit_id
                  LEFT JOIN ref_categories c ON c.id = m.category_id
                  WHERE m.status = 'active' AND (m.name ILIKE $1 OR m.code ILIKE $1)`);
    }
    if (kind !== 'raw') {
      parts.push(`SELECT 'packaging' AS item_kind, m.id, m.code, m.name, m.unit_id,
                         COALESCE(u.short_name,'') AS unit, COALESCE(c.name,'') AS category
                  FROM ref_packaging m
                  LEFT JOIN ref_units u ON u.id = m.unit_id
                  LEFT JOIN ref_categories c ON c.id = m.category_id
                  WHERE m.status = 'active' AND (m.name ILIKE $1 OR m.code ILIKE $1)`);
    }
    const r = await db.pool.query(parts.join(' UNION ALL ') + ' ORDER BY name LIMIT 40', [like]);
    // Сразу отдаём последнюю принятую цену — чтобы в списке было видно, есть ли она.
    const priceMap = await sources.lastAcceptedPricesMap(db.pool, r.rows.map((x) => ({ item_kind: x.item_kind, item_id: x.id })));
    res.json({
      items: r.rows.map((x) => {
        const p = priceMap.get(x.item_kind + ':' + x.id) || null;
        return { ...x, price: p ? p.price : null, price_date: p ? p.price_date : null, price_source: p ? p.source : null };
      }),
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Цена и её источник по конкретной позиции + короткая история (ТЗ 21.1 /prices)
router.get('/api/prices', async (req, res) => {
  try {
    const kind = req.query.kind === 'packaging' ? 'packaging' : 'raw';
    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json({ error: 'Не указана позиция' });
    const last = await sources.lastAcceptedPrice(db.pool, kind, id, req.query.on_date || null);
    const hist = await db.pool.query(
      `WITH h AS (${sources.ACCEPTED_HISTORY_SQL})
       SELECT h.price, h.price_date::text AS price_date, h.order_number, c.name AS supplier_name
       FROM h LEFT JOIN ref_counterparties c ON c.id = h.supplier_id
       WHERE h.item_kind = $1 AND h.item_id = $2
       ORDER BY h.price_date DESC LIMIT 12`, [kind, id]);
    res.json({ last, history: hist.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Изделия (ТЗ 12, 21.1/21.2)
// ===========================================================================
const PRODUCT_FIELDS = [
  'name', 'group_id', 'internal_code', 'product_family', 'linked_finished_good_id', 'barcode',
  'output_unit_id', 'output_unit_name', 'net_weight', 'net_weight_unit_id',
  'price', 'price_includes_vat', 'vat_rate', 'retro_rate', 'profit_tax_rate',
  'target_margin_rate', 'price_round_step', 'waste_reserve_rate', 'status', 'comment',
];
const normProductValue = (f, v) => {
  if (f === 'product_family') return FAMILY_SET.has(v) ? v : 'other';
  if (f === 'status') return v === 'archived' ? 'archived' : 'active';
  if (f === 'price_includes_vat') return asBool(v);
  if (['group_id', 'linked_finished_good_id', 'output_unit_id', 'net_weight_unit_id'].includes(f)) return intOrNull(v);
  if (['price', 'vat_rate', 'profit_tax_rate', 'target_margin_rate', 'net_weight'].includes(f)) return numOrNull(v);
  if (['retro_rate', 'price_round_step', 'waste_reserve_rate'].includes(f)) return asNum(v);
  return v === undefined || v === null ? '' : String(v);
};

// Список изделий с краткими итогами: сколько компонентов и предварительная
// стоимость материалов (сырьё + упаковка) по действующей рецептуре.
router.get('/api/products', async (req, res) => {
  try {
    const where = ["p.status = $1"];
    const params = [req.query.status === 'archived' ? 'archived' : 'active'];
    if (req.query.group_id === 'none') where.push('p.group_id IS NULL');
    else if (intOrNull(req.query.group_id)) { params.push(intOrNull(req.query.group_id)); where.push(`p.group_id = $${params.length}`); }
    if (req.query.q) { params.push('%' + String(req.query.q).trim() + '%'); where.push(`(p.name ILIKE $${params.length} OR p.internal_code ILIKE $${params.length} OR p.barcode ILIKE $${params.length})`); }
    const r = await db.pool.query(
      `SELECT p.*, u.short_name AS output_unit_short,
              fg.name AS linked_name, g.name AS group_name, g.sort_order AS group_sort_order,
              (SELECT id FROM calculation_recipes rc WHERE rc.product_id = p.id AND rc.status <> 'archived'
                ORDER BY (rc.status = 'approved') DESC, rc.version_no DESC LIMIT 1) AS recipe_id
       FROM calculation_products p
       LEFT JOIN ref_units u ON u.id = p.output_unit_id
       LEFT JOIN ref_finished_goods fg ON fg.id = p.linked_finished_good_id
       LEFT JOIN calculation_groups g ON g.id = p.group_id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(g.sort_order,9999), COALESCE(g.name,'Я'), p.name`, params);

    // Материалы считаем одним проходом: собираем все компоненты всех рецептур.
    const recipeIds = r.rows.map((x) => x.recipe_id).filter(Boolean);
    const itemsByRecipe = new Map();
    if (recipeIds.length) {
      const it = await db.pool.query(
        `SELECT ri.*, rc.batch_output_qty
         FROM calculation_recipe_items ri
         JOIN calculation_recipes rc ON rc.id = ri.recipe_id
         WHERE ri.recipe_id = ANY($1) ORDER BY ri.sort_order, ri.id`, [recipeIds]);
      it.rows.forEach((x) => {
        if (!itemsByRecipe.has(x.recipe_id)) itemsByRecipe.set(x.recipe_id, []);
        itemsByRecipe.get(x.recipe_id).push(x);
      });
    }
    const allItems = [].concat(...[...itemsByRecipe.values()]);
    const priceMap = await sources.lastAcceptedPricesMap(db.pool, allItems);
    const groupMap = new Map((await groupsWithPackaging(true)).map((g) => [Number(g.id), g]));

    const items = r.rows.map((p) => {
      const list = itemsByRecipe.get(p.recipe_id) || [];
      const batch = asNum(list[0] && list[0].batch_output_qty) || 1;
      const ownPackaging = list.filter((x) => x.item_kind === 'packaging');
      let raw = 0, ownPack = 0, missing = 0, rawComponents = 0;
      for (const ri of list) {
        if (ri.item_kind !== 'packaging') rawComponents++;
        const pr = priceMap.get(ri.item_kind + ':' + ri.item_id);
        if (!pr) { missing++; continue; }
        const loss = asNum(ri.loss_rate) / 100;
        const qty = loss < 1 ? (asNum(ri.qty_net) / batch) / (1 - loss) : 0;
        const cost = qty * pr.price;
        if (ri.item_kind === 'packaging') ownPack += cost;
        else raw += cost;
      }
      const group = groupMap.get(Number(p.group_id)) || null;
      const pack = ownPackaging.length ? ownPack : (group ? group.packaging_cost : 0);
      if (!ownPackaging.length && group) missing += group.packaging_missing_prices;
      return {
        ...p,
        components: rawComponents + (ownPackaging.length ? ownPackaging.length : (group ? group.packaging.length : 0)),
        raw_components: rawComponents,
        packaging_components: ownPackaging.length ? ownPackaging.length : (group ? group.packaging.length : 0),
        packaging_source: ownPackaging.length ? 'product' : 'group',
        raw_cost: raw, packaging_cost: pack, material_cost: raw + pack,
        missing_prices: missing,
      };
    });
    res.json({ items, groups: [...groupMap.values()] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Карточка изделия: паспорт + рецептуры + компоненты с ценами и источниками.
router.get('/api/products/:id(\\d+)', async (req, res) => {
  try {
    const p = (await db.pool.query(
      `SELECT p.*, u.short_name AS output_unit_short, fg.name AS linked_name, fg.status AS linked_status,
              g.name AS group_name
       FROM calculation_products p
       LEFT JOIN ref_units u ON u.id = p.output_unit_id
       LEFT JOIN ref_finished_goods fg ON fg.id = p.linked_finished_good_id
       LEFT JOIN calculation_groups g ON g.id = p.group_id
       WHERE p.id = $1`, [req.params.id])).rows[0];
    if (!p) return res.status(404).json({ error: 'Изделие не найдено' });

    const recipes = (await db.pool.query(
      `SELECT * FROM calculation_recipes WHERE product_id = $1 AND status <> 'archived'
       ORDER BY (status='approved') DESC, version_no DESC`, [req.params.id])).rows;
    const recipe = recipes[0] || null;
    let items = [];
    if (recipe) {
      const r = await db.pool.query(
        `SELECT ri.*, COALESCE(u.short_name,'') AS unit_short
         FROM calculation_recipe_items ri
         LEFT JOIN ref_units u ON u.id = ri.unit_id
         WHERE ri.recipe_id = $1 ORDER BY ri.sort_order, ri.id`, [recipe.id]);
      items = r.rows;
      const info = await nomenclatureInfo(items);
      const priceMap = await sources.lastAcceptedPricesMap(db.pool, items);
      items = items.map((x) => {
        const key = x.item_kind + ':' + x.item_id;
        const nom = info.get(key) || {};
        const pr = priceMap.get(key) || null;
        return {
          ...x,
          qty_net: Number(x.qty_net), loss_rate: Number(x.loss_rate),
          name: nom.name || '(позиция удалена из справочника)',
          code: nom.code || '',
          unit: nom.unit || x.unit_short || '',
          nomenclature_missing: !nom.name,
          price: pr ? pr.price : null,
          price_date: pr ? pr.price_date : null,
          price_source: pr ? pr.source : null,
          supplier_name: pr ? pr.supplier_name : null,
          order_number: pr ? pr.order_number : null,
        };
      });
    }
    const groups = await groupsWithPackaging(false);
    const group = groups.find((g) => Number(g.id) === Number(p.group_id)) || null;
    res.json({ product: p, recipes, recipe, items, group, groups });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Создать изделие
router.post('/api/products', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = { ...(req.body || {}) };
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название изделия' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const groupId = intOrNull(b.group_id);
    if (!groupId || !(await validateGroup(groupId, client))) throw new Error('Выберите группу калькуляции');
    b.group_id = groupId;
    // Для пользователя единица готового изделия очевидна: одна карточка = одна
    // готовая единица. Техническую «подпись выхода» больше не спрашиваем.
    if (!b.output_unit_id) {
      const unit = (await client.query(
        "SELECT id FROM ref_units WHERE lower(short_name) IN ('шт','шт.') OR lower(name) LIKE 'штук%' ORDER BY id LIMIT 1")).rows[0];
      b.output_unit_id = unit ? unit.id : null;
    }
    if (b.net_weight !== undefined && b.net_weight !== null && b.net_weight !== '' && !b.net_weight_unit_id) {
      const gram = (await client.query(
        "SELECT id FROM ref_units WHERE lower(short_name) IN ('г','гр','гр.') ORDER BY id LIMIT 1")).rows[0];
      b.net_weight_unit_id = gram ? gram.id : null;
    }
    const cols = [], vals = [], ph = [];
    for (const f of PRODUCT_FIELDS) {
      if (!(f in b) && f !== 'name') continue;
      cols.push(f); vals.push(f === 'name' ? name : normProductValue(f, b[f])); ph.push('$' + vals.length);
    }
    cols.push('created_by'); vals.push(req.user.id); ph.push('$' + vals.length);
    const r = await client.query(
      `INSERT INTO calculation_products (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING id`, vals);
    const id = r.rows[0].id;
    // Сразу создаём черновик рецептуры — чтобы было куда добавлять компоненты.
    await client.query(
      `INSERT INTO calculation_recipes (product_id, version_no, batch_output_qty, status, created_by)
       VALUES ($1, 1, $2, 'draft', $3)`, [id, asNum(b.batch_output_qty) || 1, req.user.id]);
    await client.query('COMMIT');
    await db.log(req.user.id, 'calculation_product_create', { id, name });
    res.json({ ok: true, id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (/uq_calc_products_name_active/.test(e.message)) return res.status(400).json({ error: 'Изделие с таким названием уже есть' });
    if (/uq_calc_products_linked_active/.test(e.message)) return res.status(400).json({ error: 'Эта готовая продукция уже связана с другим изделием' });
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Изменить карточку / архивировать
router.patch('/api/products/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  try {
    if ('group_id' in b) {
      const groupId = intOrNull(b.group_id);
      if (!groupId || !(await validateGroup(groupId))) return res.status(400).json({ error: 'Выберите группу калькуляции' });
    }
    const sets = [], vals = [];
    for (const f of PRODUCT_FIELDS) {
      if (!(f in b)) continue;
      if (f === 'name' && !String(b.name || '').trim()) return res.status(400).json({ error: 'Название не может быть пустым' });
      vals.push(f === 'name' ? String(b.name).trim() : normProductValue(f, b[f]));
      sets.push(`${f}=$${vals.length}`);
    }
    if (!sets.length) return res.json({ ok: true });
    sets.push(`updated_by=$${vals.length + 1}`); vals.push(req.user.id);
    sets.push('updated_at=now()');
    vals.push(req.params.id);
    await db.pool.query(`UPDATE calculation_products SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
    await db.log(req.user.id, 'calculation_product_update', { id: Number(req.params.id), fields: Object.keys(b) });
    res.json({ ok: true });
  } catch (e) {
    if (/uq_calc_products_name_active/.test(e.message)) return res.status(400).json({ error: 'Изделие с таким названием уже есть' });
    if (/uq_calc_products_linked_active/.test(e.message)) return res.status(400).json({ error: 'Эта готовая продукция уже связана с другим изделием' });
    res.status(400).json({ error: e.message });
  }
});

// Удалить изделие можно только пока оно не попало ни в одну версию (ТЗ 5, 20.10).
router.delete('/api/products/:id(\\d+)', async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  try {
    const used = (await db.pool.query('SELECT 1 FROM calculation_snapshots WHERE product_id=$1 LIMIT 1', [req.params.id])).rows[0];
    if (used) return res.status(400).json({ error: 'Изделие уже входит в утверждённую версию — его можно только архивировать' });
    await db.pool.query('DELETE FROM calculation_products WHERE id=$1', [req.params.id]);
    await db.log(req.user.id, 'calculation_product_delete', { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Копировать изделие вместе с рецептурой (ТЗ 12.2)
router.post('/api/products/:id(\\d+)/copy', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const src = (await client.query('SELECT * FROM calculation_products WHERE id=$1', [req.params.id])).rows[0];
    if (!src) throw new Error('Изделие не найдено');
    const newName = String((req.body && req.body.name) || (src.name + ' (копия)')).trim();
    const copyCols = PRODUCT_FIELDS.filter((f) => !['name', 'linked_finished_good_id', 'status'].includes(f));
    const cols = ['name', 'status', 'created_by', ...copyCols];
    const vals = [newName, 'active', req.user.id, ...copyCols.map((f) => src[f])];
    const ins = await client.query(
      `INSERT INTO calculation_products (${cols.join(',')})
       VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, vals);
    const newId = ins.rows[0].id;
    // Копируем действующую (или последнюю) рецептуру как черновик.
    const rc = (await client.query(
      `SELECT * FROM calculation_recipes WHERE product_id=$1 AND status <> 'archived'
       ORDER BY (status='approved') DESC, version_no DESC LIMIT 1`, [req.params.id])).rows[0];
    if (rc) {
      const nrc = await client.query(
        `INSERT INTO calculation_recipes (product_id, version_no, batch_output_qty, status, comment, created_by)
         VALUES ($1, 1, $2, 'draft', $3, $4) RETURNING id`,
        [newId, rc.batch_output_qty, 'Скопировано из «' + src.name + '»', req.user.id]);
      await client.query(
        `INSERT INTO calculation_recipe_items (recipe_id, item_kind, item_id, qty_net, unit_id, loss_rate, sort_order, comment)
         SELECT $1, item_kind, item_id, qty_net, unit_id, loss_rate, sort_order, comment
         FROM calculation_recipe_items WHERE recipe_id = $2`, [nrc.rows[0].id, rc.id]);
    }
    await client.query('COMMIT');
    await db.log(req.user.id, 'calculation_product_copy', { from: Number(req.params.id), to: newId });
    res.json({ ok: true, id: newId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (/uq_calc_products_name_active/.test(e.message)) return res.status(400).json({ error: 'Изделие с таким названием уже есть' });
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// ===========================================================================
// Рецептуры (ТЗ 13, 20.2, 20.3)
// ===========================================================================
// Сохранение черновика целиком: выход рецептуры + список компонентов.
// Утверждённую рецептуру напрямую не меняем — создаётся новый черновик.
router.patch('/api/recipes/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const rc = (await client.query('SELECT * FROM calculation_recipes WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!rc) throw new Error('Рецептура не найдена');
    if (rc.status === 'approved') throw new Error('Утверждённая рецептура не меняется: создайте новый черновик');

    const batch = asNum(b.batch_output_qty);
    if (b.batch_output_qty !== undefined && !(batch > 0)) throw new Error('Выход рецептуры должен быть больше нуля');
    if (b.batch_output_qty !== undefined || b.comment !== undefined) {
      await client.query(
        `UPDATE calculation_recipes SET batch_output_qty = COALESCE($1, batch_output_qty),
                comment = COALESCE($2, comment) WHERE id = $3`,
        [b.batch_output_qty !== undefined ? batch : null, b.comment !== undefined ? String(b.comment) : null, rc.id]);
    }

    if (Array.isArray(b.items)) {
      // Проверяем существование каждой позиции номенклатуры (внешнего ключа нет — ТЗ 20.3).
      const clean = [];
      for (let i = 0; i < b.items.length; i++) {
        const it = b.items[i];
        const kind = it.item_kind === 'packaging' ? 'packaging' : 'raw';
        const itemId = intOrNull(it.item_id);
        if (!itemId) throw new Error('В строке ' + (i + 1) + ' не выбрана позиция номенклатуры');
        const table = kind === 'packaging' ? 'ref_packaging' : 'ref_raw_materials';
        const ok = (await client.query(`SELECT id, unit_id FROM ${table} WHERE id=$1`, [itemId])).rows[0];
        if (!ok) throw new Error('В строке ' + (i + 1) + ' выбрана несуществующая позиция');
        const qty = asNum(it.qty_net);
        if (!(qty > 0)) throw new Error('В строке ' + (i + 1) + ' количество должно быть больше нуля');
        const loss = asNum(it.loss_rate);
        if (loss < 0 || loss >= 100) throw new Error('В строке ' + (i + 1) + ' потери должны быть от 0 до 99,99%');
        clean.push({ kind, itemId, qty, loss, unit_id: ok.unit_id, comment: String(it.comment || '') });
      }
      // Перезаписываем состав: строки черновика — не история, снимков не касается.
      await client.query('DELETE FROM calculation_recipe_items WHERE recipe_id=$1', [rc.id]);
      for (let i = 0; i < clean.length; i++) {
        const c = clean[i];
        await client.query(
          `INSERT INTO calculation_recipe_items (recipe_id, item_kind, item_id, qty_net, unit_id, loss_rate, sort_order, comment)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [rc.id, c.kind, c.itemId, c.qty, c.unit_id, c.loss, i, c.comment]);
      }
    }
    await client.query('COMMIT');
    await db.log(req.user.id, 'calculation_recipe_update', { recipe_id: rc.id, items: Array.isArray(b.items) ? b.items.length : undefined });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Новый черновик рецептуры (на основе действующей или пустой) — ТЗ 21.2
router.post('/api/recipes', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const productId = intOrNull((req.body || {}).product_id);
  if (!productId) return res.status(400).json({ error: 'Не указано изделие' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const exists = (await client.query('SELECT id FROM calculation_products WHERE id=$1', [productId])).rows[0];
    if (!exists) throw new Error('Изделие не найдено');
    const draft = (await client.query(
      `SELECT id FROM calculation_recipes WHERE product_id=$1 AND status='draft' LIMIT 1`, [productId])).rows[0];
    if (draft) { await client.query('COMMIT'); return res.json({ ok: true, id: draft.id, existing: true }); }
    const base = (await client.query(
      `SELECT * FROM calculation_recipes WHERE product_id=$1 AND status='approved'
       ORDER BY version_no DESC LIMIT 1`, [productId])).rows[0];
    const nextNo = (await client.query('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM calculation_recipes WHERE product_id=$1', [productId])).rows[0].n;
    const ins = await client.query(
      `INSERT INTO calculation_recipes (product_id, version_no, batch_output_qty, status, created_by)
       VALUES ($1,$2,$3,'draft',$4) RETURNING id`,
      [productId, nextNo, base ? base.batch_output_qty : 1, req.user.id]);
    if (base) {
      await client.query(
        `INSERT INTO calculation_recipe_items (recipe_id, item_kind, item_id, qty_net, unit_id, loss_rate, sort_order, comment)
         SELECT $1, item_kind, item_id, qty_net, unit_id, loss_rate, sort_order, comment
         FROM calculation_recipe_items WHERE recipe_id=$2`, [ins.rows[0].id, base.id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// ===========================================================================
// Предварительный расчёт без сохранения (ТЗ 21.2 /calculate)
// ===========================================================================
// Цены, ФОТ и расходы читает СЕРВЕР. Готовую себестоимость от клиента не принимаем (ТЗ 21.4).
router.post('/api/calculate', J, async (req, res) => {
  try {
    const b = req.body || {};
    const period = /^\d{4}-\d{2}$/.test(b.period || '') ? b.period : curPeriod();
    const group = await validateGroup(intOrNull(b.group_id));
    if (b.group_id && !group) return res.status(400).json({ error: 'Группа калькуляции не найдена' });
    const batchOutput = asNum(b.batch_output_qty) || 1;
    const items = Array.isArray(b.items) ? [...b.items] : [];
    const hasOwnPackaging = items.some((x) => x && x.item_kind === 'packaging');
    // Комплект группы — источник по умолчанию. Старые индивидуальные строки
    // упаковки сохраняются как осознанное исключение и не складываются второй раз.
    if (group && !hasOwnPackaging && b.use_group_packaging !== false) {
      const pack = (await db.pool.query(
        `SELECT item_id,qty,unit_id,comment FROM calculation_group_packaging
         WHERE group_id=$1 ORDER BY sort_order,id`, [group.id])).rows;
      items.push(...groupPolicy.packagingForBatch(pack, batchOutput));
    }
    if (!items.length) return res.status(400).json({ error: 'Не передан состав рецептуры' });

    const names = await nomenclatureInfo(items);
    const priceMap = await sources.lastAcceptedPricesMap(db.pool, items, b.price_on_date || null);

    const rows = items.map((it, idx) => {
      const kind = it.item_kind === 'packaging' ? 'packaging' : 'raw';
      const key = kind + ':' + Number(it.item_id);
      const info = names.get(key) || {};
      // Модельная цена разрешена только в режиме модели и подписывается отдельно (ТЗ 10.3).
      const manual = b.mode === 'model' && it.manual_price !== undefined && it.manual_price !== null && it.manual_price !== '';
      const p = manual ? { price: asNum(it.manual_price), price_date: null, source: 'model' } : priceMap.get(key) || null;
      return {
        item_kind: kind, item_id: Number(it.item_id), sort_order: idx,
        name: info.name || '', code: info.code || '', unit: info.unit || '',
        qty_net: asNum(it.qty_net), loss_rate: asNum(it.loss_rate),
        price: p ? p.price : null,
        price_unit: info.unit || '',
        price_date: p ? p.price_date : null,
        price_source: p ? p.source : null,
        supplier_name: p ? p.supplier_name : null,
        is_model_price: !!manual,
        inherited_from_group: !!it.inherited_from_group,
      };
    });

    const fot = await sources.monthlyFot(db.pool, period);
    const cash = await sources.cashExpensesByBucket(db.pool, period);
    let totalOutput = asNum(b.total_output);
    let outputInfo = { mode: 'manual', total: totalOutput };
    if (!totalOutput) {
      const pr = (await db.pool.query('SELECT id FROM calculation_periods WHERE period=$1', [period])).rows[0];
      if (pr) {
        outputInfo = await sources.periodOutput(db.pool, pr.id, b.output_mode === 'actual' ? 'actual' : 'planned');
        totalOutput = outputInfo.total;
      }
    }

    const commercial = groupPolicy.commercialForGroup(group, b.commercial || {}, b.mode);

    const result = engine.calculateProduct({
      today: today(),
      recipe: { batch_output_qty: batchOutput, items: rows },
      total_output: totalOutput,
      fot: { accrued: fot.accrued, inps: fot.inps, ndfl: fot.ndfl, social: fot.social },
      monthly_expenses: cash.buckets,
      commercial,
    });

    res.json({
      period,
      group: group ? {
        id: group.id, name: group.name, price_includes_vat: group.price_includes_vat,
        vat_rate: asNum(group.vat_rate), retro_rate: asNum(group.retro_rate),
        profit_tax_rate: asNum(group.profit_tax_rate), waste_reserve_rate: asNum(group.waste_reserve_rate),
      } : null,
      result,
      sources: {
        fot,
        cash: { buckets: cash.buckets, unclassified: cash.unclassified },
        output: outputInfo,
        warnings: [...fot.warnings, ...cash.warnings],
      },
    });
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] расчёт:', e.message);
    res.status(400).json({ error: 'Не удалось выполнить расчёт: ' + e.message });
  }
});

// ===========================================================================
// Периоды (нужны Этапу 3; здесь только чтение и создание черновика)
// ===========================================================================
router.get('/api/periods', async (req, res) => {
  try {
    const r = await db.pool.query('SELECT * FROM calculation_periods ORDER BY period DESC');
    res.json({ items: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/periods', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const period = String((req.body || {}).period || '').trim();
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Период указывается как ГГГГ-ММ, например 2026-08' });
  try {
    const r = await db.pool.query(
      `INSERT INTO calculation_periods (period, source_period, vat_rate, profit_tax_rate, status, created_by)
       VALUES ($1, $1, 12, 15, 'draft', $2)
       ON CONFLICT (period) DO NOTHING RETURNING id`, [period, req.user.id]);
    const id = r.rows[0] ? r.rows[0].id : (await db.pool.query('SELECT id FROM calculation_periods WHERE period=$1', [period])).rows[0].id;
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Удаление периода: утверждённый или закрытый удалять нельзя (ТЗ 20.9).
router.delete('/api/periods/:id(\\d+)', async (req, res) => {
  if (!canApprove(req)) return res.status(403).json({ error: 'Удалять период может только администратор' });
  try {
    const p = (await db.pool.query('SELECT * FROM calculation_periods WHERE id=$1', [req.params.id])).rows[0];
    if (!p) return res.status(404).json({ error: 'Период не найден' });
    if (p.status === 'active' || p.status === 'approved' || p.actual_status === 'closed') {
      return res.status(400).json({ error: 'Утверждённый или закрытый период удалить нельзя' });
    }
    const hasVersion = (await db.pool.query('SELECT 1 FROM calculation_versions WHERE period_id=$1 LIMIT 1', [req.params.id])).rows[0];
    if (hasVersion) return res.status(400).json({ error: 'По периоду уже есть версия расчёта — удалять нельзя' });
    await db.pool.query('DELETE FROM calculation_periods WHERE id=$1', [req.params.id]);
    await db.log(req.user.id, 'calculation_period_delete', { id: Number(req.params.id), period: p.period });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Названия, коды и единицы существующей номенклатуры (сырьё и упаковка).
async function nomenclatureInfo(items) {
  const map = new Map();
  const raw = items.filter((x) => x.item_kind !== 'packaging').map((x) => Number(x.item_id)).filter(Boolean);
  const pack = items.filter((x) => x.item_kind === 'packaging').map((x) => Number(x.item_id)).filter(Boolean);
  if (raw.length) {
    const r = await db.pool.query(
      `SELECT m.id, m.code, m.name, COALESCE(u.short_name, '') AS unit
       FROM ref_raw_materials m LEFT JOIN ref_units u ON u.id = m.unit_id WHERE m.id = ANY($1)`, [raw]);
    r.rows.forEach((x) => map.set('raw:' + x.id, x));
  }
  if (pack.length) {
    const r = await db.pool.query(
      `SELECT m.id, m.code, m.name, COALESCE(u.short_name, '') AS unit
       FROM ref_packaging m LEFT JOIN ref_units u ON u.id = m.unit_id WHERE m.id = ANY($1)`, [pack]);
    r.rows.forEach((x) => map.set('packaging:' + x.id, x));
  }
  return map;
}

// ===========================================================================
// Этап 3: матрица, план выпуска, утверждение версии, история
// ===========================================================================

// Матрица себестоимости (ТЗ 17.3). Всё считает сервер, строки приходят готовыми.
router.get('/api/matrix', async (req, res) => {
  try {
    const m = await matrix.buildMatrix(db.pool, {
      group_id: req.query.group_id === 'none' ? 'none' : intOrNull(req.query.group_id),
      period: req.query.period,
      output_mode: req.query.output_mode,
    });
    delete m._full;   // полные результаты нужны только утверждению
    res.json(m);
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] матрица:', e.message);
    res.status(400).json({ error: 'Не удалось собрать матрицу: ' + e.message });
  }
});

// Период: план выпуска по изделиям + расшифровка источников (ТЗ 17.7, 21.1).
router.get('/api/periods/:period/plan', async (req, res) => {
  try {
    const period = String(req.params.period);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Период указывается как ГГГГ-ММ' });
    const pr = (await db.pool.query('SELECT * FROM calculation_periods WHERE period=$1', [period])).rows[0] || null;
    const rows = (await db.pool.query(
      `SELECT p.id AS product_id, p.name, g.name AS group_name, g.sort_order AS group_sort_order,
              pp.planned_output_qty, pp.actual_output_qty, pp.actual_comment
       FROM calculation_products p
       LEFT JOIN calculation_groups g ON g.id = p.group_id
       LEFT JOIN calculation_period_products pp ON pp.product_id = p.id AND pp.period_id = $1
       WHERE p.status = 'active'
       ORDER BY COALESCE(g.sort_order,9999), COALESCE(g.name,'Я'), p.name`,
      [pr ? pr.id : -1])).rows;
    const fot = await sources.monthlyFot(db.pool, period);
    const cash = await sources.cashExpensesByBucket(db.pool, period);
    const planned = rows.reduce((a, x) => a + asNum(x.planned_output_qty), 0);
    const actual = rows.reduce((a, x) => a + asNum(x.actual_output_qty), 0);
    res.json({
      period, period_row: pr, items: rows,
      totals: { planned, actual },
      fot, cash,
      // Ссылка на операции Кассы того же месяца (ТЗ 8.6).
      cash_link: '/cash?tab=tx&from=' + period + '-01',
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Сохранение планового (и фактического) выпуска по изделиям.
router.post('/api/periods/:period/plan', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const period = String(req.params.period);
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Период указывается как ГГГГ-ММ' });
  const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    let pr = (await client.query('SELECT * FROM calculation_periods WHERE period=$1 FOR UPDATE', [period])).rows[0];
    if (!pr) {
      pr = (await client.query(
        `INSERT INTO calculation_periods (period, source_period, vat_rate, profit_tax_rate, status, created_by)
         VALUES ($1,$1,12,15,'draft',$2) RETURNING *`, [period, req.user.id])).rows[0];
    }
    if (pr.actual_status === 'closed') throw new Error('Фактический месяц закрыт: сначала переоткройте его');
    for (const it of items) {
      const pid = intOrNull(it.product_id);
      if (!pid) continue;
      const plannedGiven = it.planned_output_qty !== undefined;
      const actualGiven = it.actual_output_qty !== undefined;
      const planned = asNum(it.planned_output_qty);
      if (plannedGiven && planned < 0) throw new Error('Плановый выпуск не может быть отрицательным');
      const actual = it.actual_output_qty === null || it.actual_output_qty === '' ? null : asNum(it.actual_output_qty);
      if (actualGiven && actual !== null && actual < 0) throw new Error('Фактический выпуск не может быть отрицательным');
      await client.query(
        `INSERT INTO calculation_period_products
           (period_id, product_id, planned_output_qty, actual_output_qty, actual_comment, actual_source, actual_updated_by, actual_updated_at)
         VALUES ($1,$2,$3,$4,$5,'manual',$6, CASE WHEN $4 IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (period_id, product_id) DO UPDATE SET
           planned_output_qty = CASE WHEN $7 THEN EXCLUDED.planned_output_qty ELSE calculation_period_products.planned_output_qty END,
           actual_output_qty  = CASE WHEN $8 THEN EXCLUDED.actual_output_qty  ELSE calculation_period_products.actual_output_qty END,
           actual_comment     = CASE WHEN $8 THEN EXCLUDED.actual_comment     ELSE calculation_period_products.actual_comment END,
           actual_updated_by  = CASE WHEN $8 THEN EXCLUDED.actual_updated_by  ELSE calculation_period_products.actual_updated_by END,
           actual_updated_at  = CASE WHEN $8 THEN now() ELSE calculation_period_products.actual_updated_at END`,
        [pr.id, pid, planned, actual, String(it.actual_comment || ''), req.user.id, plannedGiven, actualGiven]);
    }
    await client.query('UPDATE calculation_periods SET updated_at=now() WHERE id=$1', [pr.id]);
    await client.query('COMMIT');
    await db.log(req.user.id, 'calculation_plan_update', { period, items: items.length });
    res.json({ ok: true, period_id: pr.id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Утверждение версии (ТЗ 9.2, 20.6). Только администратор, всё в одной транзакции.
router.post('/api/periods/:period/approve', J, async (req, res) => {
  if (!canApprove(req)) return res.status(403).json({ error: 'Утверждать версию может только администратор' });
  const period = String(req.params.period);
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Период указывается как ГГГГ-ММ' });
  const client = await db.pool.connect();
  try {
    // Считаем ВСЕ активные изделия периода, а не только выбранную группу.
    const m = await matrix.buildMatrix(db.pool, { period });
    if (!m.columns.length) throw new Error('Нет активных изделий: утверждать нечего');
    const blocked = m._full.filter((c) => !c.result.can_approve);
    if (blocked.length) {
      const err = new Error('Утверждение невозможно: ' + blocked.length + ' изделий с блокирующими ошибками');
      err.details = blocked.slice(0, 20).map((c) => ({ product: c.name, errors: c.result.errors.map((e) => e.message) }));
      throw err;
    }

    await client.query('BEGIN');
    let pr = (await client.query('SELECT * FROM calculation_periods WHERE period=$1 FOR UPDATE', [period])).rows[0];
    if (!pr) throw new Error('Период не создан: сначала заполните план выпуска');

    // Защита от повторного нажатия: уже есть активная версия этого периода с теми же данными?
    const nextRev = (await client.query(
      `SELECT COALESCE(MAX(revision_no),0)+1 AS n FROM calculation_versions
       WHERE period_id=$1 AND version_kind='approved'`, [pr.id])).rows[0].n;

    // Предыдущая действующая версия уходит в историю (не удаляется).
    await client.query(
      `UPDATE calculation_versions SET status='archived'
       WHERE version_kind='approved' AND status='active'`);

    const ver = (await client.query(
      `INSERT INTO calculation_versions
         (period_id, version_kind, revision_no, status, common_inputs_json, common_sources_json,
          formula_version, comment, created_by, approved_by, approved_at)
       VALUES ($1,'approved',$2,'active',$3,$4,$5,$6,$7,$7,now()) RETURNING *`,
      [pr.id, nextRev,
        JSON.stringify({ period, output: m.output, kpi: m.kpi }),
        JSON.stringify({ fot: m.fot, cash: m.cash, output: m.output, warnings: m.warnings }),
        m.formula_version, String((req.body || {}).comment || ''), req.user.id])).rows[0];

    // Снимок по каждому изделию: входы, источники цен и результат формул.
    for (const c of m._full) {
      await client.query(
        `INSERT INTO calculation_snapshots
           (version_id, product_id, recipe_id, inputs_json, sources_json, result_json, formula_version, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ver.id, c.product_id, c.recipe_id,
          JSON.stringify({ batch_output_qty: c.result.inputs.batch_output_qty, commercial: c.result.inputs.commercial, packaging_source: c.packaging_source }),
          JSON.stringify({ rows: c.result.rows, group: { id: c.group_id, name: c.group_name } }),
          JSON.stringify({ layers: c.result.layers, commercial: c.result.commercial, recommended: c.result.recommended, fot: c.result.fot, overheads: c.result.overheads }),
          c.result.formula_version, req.user.id]);
      // Черновик рецептуры утверждается в той же транзакции (ТЗ 20.2).
      if (c.recipe_id) {
        await client.query(
          `UPDATE calculation_recipes SET status='approved', approved_by=$1, approved_at=now(),
                  valid_from = COALESCE(valid_from, CURRENT_DATE)
           WHERE id=$2 AND status='draft'`, [req.user.id, c.recipe_id]);
      }
    }

    await client.query(
      `UPDATE calculation_periods SET status='active', approved_by=$1, approved_at=now(), updated_at=now() WHERE id=$2`,
      [req.user.id, pr.id]);
    await client.query('COMMIT');
    await db.log(req.user.id, 'calculation_version_approve', { period, version_id: ver.id, revision_no: nextRev, products: m._full.length });
    res.json({ ok: true, version_id: ver.id, revision_no: nextRev, products: m._full.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message, details: e.details });
  } finally { client.release(); }
});

// История версий (ТЗ 17.8)
router.get('/api/history', async (req, res) => {
  try {
    const r = await db.pool.query(
      `SELECT v.*, p.period,
              (SELECT COUNT(*)::int FROM calculation_snapshots s WHERE s.version_id = v.id) AS products,
              cu.full_name AS created_name, au.full_name AS approved_name
       FROM calculation_versions v
       JOIN calculation_periods p ON p.id = v.period_id
       LEFT JOIN users cu ON cu.id = v.created_by
       LEFT JOIN users au ON au.id = v.approved_by
       ORDER BY v.created_at DESC LIMIT 100`);
    res.json({ items: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Снимок версии: изделия и их зафиксированный расчёт.
router.get('/api/versions/:id(\\d+)', async (req, res) => {
  try {
    const v = (await db.pool.query(
      `SELECT v.*, p.period FROM calculation_versions v
       JOIN calculation_periods p ON p.id = v.period_id WHERE v.id=$1`, [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: 'Версия не найдена' });
    const s = (await db.pool.query(
      `SELECT s.*, pr.name AS product_name FROM calculation_snapshots s
       LEFT JOIN calculation_products pr ON pr.id = s.product_id
       WHERE s.version_id=$1 ORDER BY pr.name`, [req.params.id])).rows;
    res.json({ version: v, snapshots: s });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
