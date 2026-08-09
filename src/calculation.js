// calculation.js — плитка «Калькуляция себестоимости» (ТЗ TZ_CALCULATION.md).
//
// Ответственность файла (ТЗ 19.1): маршруты, права, транзакции, сбор ответа.
// Формулы живут в calculation-engine.js, чтение источников — в calculation-sources.js,
// схема — в calculation-schema.js. Дублировать формулы здесь запрещено.
//
// Готово: этап 1 (ядро) и этап 2 (изделия и рецептуры).
// Старая вкладка «Справочники» (статьи затрат/ставки/каналы) убрана из интерфейса;
// её таблицы в базе НЕ удаляются (ТЗ 20.9) — просто больше не используются.
const express = require('express');
const db = require('./db');
const engine = require('./calculation-engine');
const sources = require('./calculation-sources');
const { ensureCalculationSchema } = require('./calculation-schema');

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
    const periods = (await db.pool.query('SELECT * FROM calculation_periods ORDER BY period DESC')).rows;
    const active = periods.find((p) => p.status === 'active') || periods[0] || null;
    const activeVersion = (await db.pool.query(
      `SELECT v.id, v.revision_no, v.approved_at, p.period
       FROM calculation_versions v JOIN calculation_periods p ON p.id = v.period_id
       WHERE v.version_kind = 'approved' AND v.status = 'active' LIMIT 1`)).rows[0] || null;
    res.json({
      rights: { can_edit: canEdit(req), can_approve: canApprove(req) },
      families: FAMILIES,
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
  'name', 'internal_code', 'product_family', 'linked_finished_good_id', 'barcode',
  'output_unit_id', 'output_unit_name', 'net_weight', 'net_weight_unit_id',
  'price', 'price_includes_vat', 'vat_rate', 'retro_rate', 'profit_tax_rate',
  'target_margin_rate', 'price_round_step', 'waste_reserve_rate', 'status', 'comment',
];
const normProductValue = (f, v) => {
  if (f === 'product_family') return FAMILY_SET.has(v) ? v : 'other';
  if (f === 'status') return v === 'archived' ? 'archived' : 'active';
  if (f === 'price_includes_vat') return asBool(v);
  if (['linked_finished_good_id', 'output_unit_id', 'net_weight_unit_id'].includes(f)) return intOrNull(v);
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
    if (req.query.family && FAMILY_SET.has(req.query.family)) { params.push(req.query.family); where.push(`p.product_family = $${params.length}`); }
    if (req.query.q) { params.push('%' + String(req.query.q).trim() + '%'); where.push(`(p.name ILIKE $${params.length} OR p.internal_code ILIKE $${params.length} OR p.barcode ILIKE $${params.length})`); }
    const r = await db.pool.query(
      `SELECT p.*, u.short_name AS output_unit_short,
              fg.name AS linked_name,
              (SELECT id FROM calculation_recipes rc WHERE rc.product_id = p.id AND rc.status <> 'archived'
                ORDER BY (rc.status = 'approved') DESC, rc.version_no DESC LIMIT 1) AS recipe_id
       FROM calculation_products p
       LEFT JOIN ref_units u ON u.id = p.output_unit_id
       LEFT JOIN ref_finished_goods fg ON fg.id = p.linked_finished_good_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.name`, params);

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

    const items = r.rows.map((p) => {
      const list = itemsByRecipe.get(p.recipe_id) || [];
      const batch = asNum(list[0] && list[0].batch_output_qty) || 1;
      let raw = 0, pack = 0, missing = 0;
      for (const ri of list) {
        const pr = priceMap.get(ri.item_kind + ':' + ri.item_id);
        if (!pr) { missing++; continue; }
        const loss = asNum(ri.loss_rate) / 100;
        const qty = loss < 1 ? (asNum(ri.qty_net) / batch) / (1 - loss) : 0;
        const cost = qty * pr.price;
        if (ri.item_kind === 'packaging') pack += cost; else raw += cost;
      }
      return {
        ...p,
        components: list.length,
        raw_cost: raw, packaging_cost: pack, material_cost: raw + pack,
        missing_prices: missing,
      };
    });
    res.json({ items, families: FAMILIES });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Карточка изделия: паспорт + рецептуры + компоненты с ценами и источниками.
router.get('/api/products/:id(\\d+)', async (req, res) => {
  try {
    const p = (await db.pool.query(
      `SELECT p.*, u.short_name AS output_unit_short, fg.name AS linked_name, fg.status AS linked_status
       FROM calculation_products p
       LEFT JOIN ref_units u ON u.id = p.output_unit_id
       LEFT JOIN ref_finished_goods fg ON fg.id = p.linked_finished_good_id
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
    res.json({ product: p, recipes, recipe, items, families: FAMILIES });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Создать изделие
router.post('/api/products', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название изделия' });
  try {
    const cols = [], vals = [], ph = [];
    for (const f of PRODUCT_FIELDS) {
      if (!(f in b) && f !== 'name') continue;
      cols.push(f); vals.push(f === 'name' ? name : normProductValue(f, b[f])); ph.push('$' + vals.length);
    }
    cols.push('created_by'); vals.push(req.user.id); ph.push('$' + vals.length);
    const r = await db.pool.query(
      `INSERT INTO calculation_products (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING id`, vals);
    const id = r.rows[0].id;
    // Сразу создаём черновик рецептуры — чтобы было куда добавлять компоненты.
    await db.pool.query(
      `INSERT INTO calculation_recipes (product_id, version_no, batch_output_qty, status, created_by)
       VALUES ($1, 1, $2, 'draft', $3)`, [id, asNum(b.batch_output_qty) || 1, req.user.id]);
    await db.log(req.user.id, 'calculation_product_create', { id, name });
    res.json({ ok: true, id });
  } catch (e) {
    if (/uq_calc_products_name_active/.test(e.message)) return res.status(400).json({ error: 'Изделие с таким названием уже есть' });
    if (/uq_calc_products_linked_active/.test(e.message)) return res.status(400).json({ error: 'Эта готовая продукция уже связана с другим изделием' });
    res.status(400).json({ error: e.message });
  }
});

// Изменить карточку / архивировать
router.patch('/api/products/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  try {
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
    const items = Array.isArray(b.items) ? b.items : [];
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

    const result = engine.calculateProduct({
      today: today(),
      recipe: { batch_output_qty: asNum(b.batch_output_qty) || 1, items: rows },
      total_output: totalOutput,
      fot: { accrued: fot.accrued, inps: fot.inps, ndfl: fot.ndfl, social: fot.social },
      monthly_expenses: cash.buckets,
      commercial: b.commercial || {},
    });

    res.json({
      period,
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

module.exports = router;
