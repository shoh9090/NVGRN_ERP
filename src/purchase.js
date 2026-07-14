// purchase.js — блок «Закуп»: поставщики, заявки, приёмка, взаиморасчёты
const express = require('express');
const db = require('./db');
const { notify } = require('./notifications');

const router = express.Router();

// Связка с Кассой: у поставщика — статья ДДС по умолчанию (для автоклассификации расходов по ИНН).
let _ccCol = false;
router.use(async (req, res, next) => {
  if (!_ccCol) { try { await db.pool.query('ALTER TABLE ref_counterparties ADD COLUMN IF NOT EXISTS cash_category_id INTEGER'); } catch (e) { /* ignore */ } _ccCol = true; }
  next();
});

// ---------- Страница ----------
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('purchase', { settings, user: req.user });
});

// ---------- Поставщики (с балансами) ----------
router.get('/api/suppliers', async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = [];
  let qSQL = '';
  if (q) {
    params.push('%' + q + '%');
    qSQL = ` AND (c.name ILIKE $${params.length} OR c.legal_name ILIKE $${params.length} OR c.inn ILIKE $${params.length} OR c.supplies ILIKE $${params.length})`;
  }
  let pcSQL = '';
  if (req.query.parent_category_id) { params.push(parseInt(req.query.parent_category_id)); pcSQL = ` AND c.parent_category_id = $${params.length}`; }
  const r = await db.pool.query(
    `SELECT c.id, c.name, c.legal_name, c.phone, c.inn, c.supplies, c.payment_terms, c.status,
            c.parent_category_id, pc.name AS parent_category_name, pc.color AS parent_category_color,
            c.cash_category_id, cc.code AS cash_cat_code, cc.name AS cash_cat_name,
            COALESCE(c.opening_balance, 0) AS opening_balance,
            COALESCE(d.delivered, 0) AS delivered,
            COALESCE(p.paid, 0) AS paid,
            COALESCE(c.opening_balance, 0) + COALESCE(d.delivered, 0) - COALESCE(p.paid, 0) AS balance,
            COALESCE(sm.n, 0) AS attached_count
     FROM ref_counterparties c
     LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_category_id
     LEFT JOIN cash_categories cc ON cc.id = c.cash_category_id
     LEFT JOIN (
       SELECT po.supplier_id, SUM(COALESCE(i.fact_qty, i.qty) * COALESCE(i.fact_price, i.price)) AS delivered
       FROM purchase_orders po
       JOIN purchase_order_items i ON i.order_id = po.id
       WHERE po.status = 'received'
       GROUP BY po.supplier_id
     ) d ON d.supplier_id = c.id
     LEFT JOIN (
       SELECT supplier_id, SUM(amount) AS paid FROM supplier_payments GROUP BY supplier_id
     ) p ON p.supplier_id = c.id
     LEFT JOIN (
       SELECT supplier_id, COUNT(*)::int AS n FROM supplier_materials GROUP BY supplier_id
     ) sm ON sm.supplier_id = c.id
     WHERE c.role_supplier = TRUE AND c.status = 'active'${qSQL}${pcSQL}
     ORDER BY c.name`,
    params
  );
  res.json({ items: r.rows });
});

router.put('/api/suppliers/:id(\\d+)', express.json(), async (req, res) => {
  const allowed = ['name', 'legal_name', 'phone', 'inn', 'supplies', 'payment_terms', 'opening_balance', 'comment', 'parent_category_id', 'cash_category_id'];
  const numeric = ['opening_balance', 'parent_category_id', 'cash_category_id'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in req.body) {
      vals.push(numeric.includes(k) ? (req.body[k] === '' || req.body[k] == null ? null : Number(req.body[k])) : String(req.body[k] ?? ''));
      sets.push(`${k} = $${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Нет данных' });
  vals.push(req.params.id);
  await db.pool.query(`UPDATE ref_counterparties SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
  await db.log(req.user.id, 'purchase_supplier_update', req.params.id);
  res.json({ ok: true });
});

router.post('/api/suppliers', express.json(), async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите имя поставщика' });
  const dup = await db.pool.query('SELECT id FROM ref_counterparties WHERE lower(name) = lower($1) LIMIT 1', [name]);
  if (dup.rows.length) return res.status(409).json({ error: `Поставщик «${name}» уже существует` });
  const r = await db.pool.query(
    `INSERT INTO ref_counterparties (name, legal_name, phone, inn, supplies, parent_category_id, cash_category_id, role_supplier, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8) RETURNING id`,
    [name, req.body.legal_name || '', req.body.phone || '', req.body.inn || '', req.body.supplies || '',
     req.body.parent_category_id ? Number(req.body.parent_category_id) : null,
     req.body.cash_category_id ? Number(req.body.cash_category_id) : null, req.user.id]
  );
  await db.log(req.user.id, 'purchase_supplier_create', name);
  res.json({ id: r.rows[0].id });
});


// Прикреплённые товары поставщика
router.get('/api/suppliers/:id(\\d+)/materials', async (req, res) => {
  const r = await db.pool.query(
    'SELECT item_kind, item_id FROM supplier_materials WHERE supplier_id = $1',
    [req.params.id]
  );
  res.json({ items: r.rows });
});

router.post('/api/suppliers/:id(\\d+)/materials', express.json({ limit: '1mb' }), async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  await db.pool.query('DELETE FROM supplier_materials WHERE supplier_id = $1', [req.params.id]);
  for (const it of items) {
    const kind = it.item_kind === 'packaging' ? 'packaging' : 'raw';
    const id = parseInt(it.item_id);
    if (!id) continue;
    await db.pool.query(
      'INSERT INTO supplier_materials (supplier_id, item_kind, item_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [req.params.id, kind, id]
    );
  }
  await db.log(req.user.id, 'purchase_supplier_materials', `supplier=${req.params.id} items=${items.length}`);
  res.json({ ok: true });
});

// Выписка по поставщику: поставки с позициями + оплаты
router.get('/api/suppliers/:id(\\d+)/statement', async (req, res) => {
  const sup = await db.pool.query(
    'SELECT id, name, legal_name, phone, inn, supplies, payment_terms, parent_category_id, COALESCE(opening_balance,0) AS opening_balance FROM ref_counterparties WHERE id = $1',
    [req.params.id]
  );
  if (!sup.rows.length) return res.status(404).json({ error: 'Поставщик не найден' });
  const orders = await db.pool.query(
    `SELECT po.id, po.number, po.received_at, po.payment_type, po.comment,
            SUM(COALESCE(i.fact_qty, i.qty) * COALESCE(i.fact_price, i.price)) AS total
     FROM purchase_orders po
     JOIN purchase_order_items i ON i.order_id = po.id
     WHERE po.supplier_id = $1 AND po.status = 'received'
     GROUP BY po.id ORDER BY po.received_at DESC`,
    [req.params.id]
  );
  const items = await db.pool.query(
    `SELECT i.order_id, i.item_kind, i.item_id, COALESCE(i.fact_qty, i.qty) AS qty, COALESCE(i.fact_price, i.price) AS price,
            COALESCE(rm.name, pk.name) AS item_name, COALESCE(rm.code, pk.code) AS item_code,
            COALESCE(u1.short_name, u2.short_name) AS unit
     FROM purchase_order_items i
     JOIN purchase_orders po ON po.id = i.order_id
     LEFT JOIN ref_raw_materials rm ON i.item_kind = 'raw' AND rm.id = i.item_id
     LEFT JOIN ref_packaging pk ON i.item_kind = 'packaging' AND pk.id = i.item_id
     LEFT JOIN ref_units u1 ON u1.id = rm.unit_id
     LEFT JOIN ref_units u2 ON u2.id = pk.unit_id
     WHERE po.supplier_id = $1 AND po.status = 'received'`,
    [req.params.id]
  );
  const payments = await db.pool.query(
    'SELECT id, amount, payment_type, paid_at, comment FROM supplier_payments WHERE supplier_id = $1 ORDER BY paid_at DESC, id DESC',
    [req.params.id]
  );
  res.json({ supplier: sup.rows[0], orders: orders.rows, items: items.rows, payments: payments.rows });
});

// ---------- Оплаты ----------
router.post('/api/payments', express.json(), async (req, res) => {
  const amount = Number(req.body.amount);
  const supplierId = parseInt(req.body.supplier_id);
  if (!supplierId || !amount || amount <= 0) return res.status(400).json({ error: 'Укажите поставщика и сумму больше нуля' });
  const ptype = req.body.payment_type === 'наличка' ? 'наличка' : 'перечисление';
  await db.pool.query(
    `INSERT INTO supplier_payments (supplier_id, amount, payment_type, paid_at, comment, created_by)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6)`,
    [supplierId, amount, ptype, req.body.paid_at || null, req.body.comment || '', req.user.id]
  );
  await db.log(req.user.id, 'purchase_payment', `supplier=${supplierId} sum=${amount} (${ptype})`);
  res.json({ ok: true });
});

// ---------- Номенклатура для заявки (сырьё + упаковка, с последней ценой поставщика) ----------
router.get('/api/materials', async (req, res) => {
  const supplierId = parseInt(req.query.supplier_id) || 0;
  const q = (req.query.q || '').trim();
  const params = [supplierId];
  let qSQL = '';
  if (q) {
    params.push('%' + q + '%');
    qSQL = ` WHERE (name ILIKE $2 OR code ILIKE $2)`;
  }
  const r = await db.pool.query(
    `WITH mats AS (
       SELECT 'raw' AS kind, rm.id, rm.code, rm.name, u.short_name AS unit, c.name AS category
       FROM ref_raw_materials rm
       LEFT JOIN ref_units u ON u.id = rm.unit_id
       LEFT JOIN ref_categories c ON c.id = rm.category_id
       WHERE rm.status = 'active'
       UNION ALL
       SELECT 'packaging', pk.id, pk.code, pk.name, u.short_name, c.name
       FROM ref_packaging pk
       LEFT JOIN ref_units u ON u.id = pk.unit_id
       LEFT JOIN ref_categories c ON c.id = pk.category_id
       WHERE pk.status = 'active'
     ),
     last_sup AS (
       SELECT DISTINCT ON (i.item_kind, i.item_id) i.item_kind, i.item_id,
              COALESCE(i.fact_price, i.price) AS price
       FROM purchase_order_items i
       JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
       WHERE po.supplier_id = $1
       ORDER BY i.item_kind, i.item_id, po.received_at DESC
     ),
     last_any AS (
       SELECT DISTINCT ON (i.item_kind, i.item_id) i.item_kind, i.item_id,
              COALESCE(i.fact_price, i.price) AS price
       FROM purchase_order_items i
       JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
       ORDER BY i.item_kind, i.item_id, po.received_at DESC
     ),
     stock AS (
       SELECT item_kind, item_id, SUM(qty) AS received_total
       FROM stock_movements GROUP BY item_kind, item_id
     )
     SELECT m.*, ls.price AS supplier_price, la.price AS any_price,
            COALESCE(st.received_total, 0) AS stock,
            (sm.id IS NOT NULL) AS attached
     FROM mats m
     LEFT JOIN last_sup ls ON ls.item_kind = m.kind AND ls.item_id = m.id
     LEFT JOIN last_any la ON la.item_kind = m.kind AND la.item_id = m.id
     LEFT JOIN stock st ON st.item_kind = m.kind AND st.item_id = m.id
     LEFT JOIN supplier_materials sm ON sm.supplier_id = $1 AND sm.item_kind = m.kind AND sm.item_id = m.id
     ${q ? "WHERE (m.name ILIKE $2 OR m.code ILIKE $2)" : ''}
     ORDER BY m.name`,
    params
  );
  res.json({ items: r.rows });
});



// Справочные списки для фильтров вкладки «Цены»
router.get('/api/filter-options', async (req, res) => {
  const sup = await db.pool.query(
    "SELECT id, name FROM ref_counterparties WHERE role_supplier = TRUE AND status = 'active' ORDER BY name"
  );
  const cat = await db.pool.query(
    "SELECT id, name FROM ref_categories WHERE kind = 'категория' AND (sd_sd_id IS NULL OR sd_sd_id = '') ORDER BY name"
  );
  const parents = await db.pool.query(
    "SELECT id, name, color FROM ref_parent_categories WHERE status = 'active' ORDER BY name"
  );
  const items = await db.pool.query(
    `SELECT 'raw' AS kind, id, code, name FROM ref_raw_materials WHERE status='active'
     UNION ALL SELECT 'packaging', id, code, name FROM ref_packaging WHERE status='active'
     ORDER BY name`
  );
  // Статьи ДДС из Кассы (для присвоения поставщику) — ВСЕ активные (не только группа «Сырьё»),
  // иначе сохранённая у поставщика статья из другой группы не находится в списке и «пропадает».
  // Переводы (direction=transfer) не показываем — это не расходные статьи.
  let cashCats = [];
  try {
    const cc = await db.pool.query(
      "SELECT id, code, name, group_name FROM cash_categories WHERE status = 'active' AND direction_hint IS DISTINCT FROM 'transfer' ORDER BY sort_order, code"
    );
    cashCats = cc.rows;
  } catch (e) { /* Касса ещё не инициализирована */ }
  res.json({ suppliers: sup.rows, categories: cat.rows, parents: parents.rows, items: items.rows, cashCats });
});

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Доступно только администратору' });
  next();
}

// --- Импорт истории закупочных цен (вариант А: артикул + дата + цена, без поставщика) ---
// Парсер дат из заголовков: понимает «цены\nна 19.08.2023», «март 2026», Excel-серийное число, ISO/datetime
function parseHeaderDate(raw) {
  if (raw == null || raw === '') return null;
  // настоящий Date (datetime из xlsx)
  if (raw instanceof Date && !isNaN(raw)) return raw.toISOString().slice(0, 10);
  const str = String(raw).trim();

  // Excel-серийное число (например 45132)
  if (/^\d{5}$/.test(str)) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    epoch.setUTCDate(epoch.getUTCDate() + parseInt(str));
    return epoch.toISOString().slice(0, 10);
  }
  // dd.mm.yyyy в любом месте строки
  let m = str.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  // ISO yyyy-mm-dd
  m = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // «март 2026», «апр 2026», «янв.2026», «Цена на июль 2025»
  const months = { янв:1, фев:2, мар:3, апр:4, май:5, мая:5, июн:6, июл:7, авг:8, сен:9, окт:10, ноя:11, дек:12 };
  const low = str.toLowerCase();
  for (const [k, v] of Object.entries(months)) {
    if (low.includes(k)) {
      const ym = low.match(/(20\d{2})/);
      if (ym) return `${ym[1]}-${String(v).padStart(2, '0')}-01`;
    }
  }
  return null;
}

router.post('/api/price-history/import-preview', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const header = rows[0] || [];
    // столбцы с датами: ищем начиная со 2-го (0=артикул, 1=наименование), берём всё, что парсится как дата
    const dateCols = [];
    for (let c = 2; c < header.length; c++) {
      const d = parseHeaderDate(header[c]);
      if (d) dateCols.push({ col: c, date: d });
    }
    const raw = await db.pool.query("SELECT id, code FROM ref_raw_materials WHERE code IS NOT NULL");
    const pk = await db.pool.query("SELECT id, code FROM ref_packaging WHERE code IS NOT NULL");
    const byCode = {};
    for (const r of raw.rows) byCode[String(r.code).toUpperCase()] = { kind: 'raw', id: r.id };
    for (const r of pk.rows) byCode[String(r.code).toUpperCase()] = { kind: 'packaging', id: r.id };

    let matched = 0, unmatched = 0, points = 0;
    const sample = [];
    for (let i = 1; i < rows.length; i++) {
      const code = String(rows[i][0] || '').trim().toUpperCase();
      const name = String(rows[i][1] || '').trim();
      if (!code) continue;
      const mat = byCode[code];
      if (!mat) { unmatched++; if (sample.length < 10) sample.push({ code, name, status: 'не найден артикул' }); continue; }
      let cnt = 0;
      for (const dc of dateCols) {
        const v = parseFloat(String(rows[i][dc.col]).replace(/\s/g, '').replace(',', '.'));
        if (!isNaN(v) && v > 0) { cnt++; points++; }
      }
      matched++;
      if (sample.length < 10) sample.push({ code, name, status: cnt + ' цен' });
    }
    res.json({ dates: dateCols.length, matched, unmatched, points, sample });
  } catch (e) {
    res.status(400).json({ error: 'Не удалось прочитать файл: ' + e.message });
  }
});

router.post('/api/price-history/import-commit', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const client = await db.pool.connect();
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const header = rows[0] || [];
    const dateCols = [];
    for (let c = 2; c < header.length; c++) {
      const d = parseHeaderDate(header[c]);
      if (d) dateCols.push({ col: c, date: d });
    }
    const raw = await client.query("SELECT id, code FROM ref_raw_materials WHERE code IS NOT NULL");
    const pk = await client.query("SELECT id, code FROM ref_packaging WHERE code IS NOT NULL");
    const byCode = {};
    for (const r of raw.rows) byCode[String(r.code).toUpperCase()] = { kind: 'raw', id: r.id };
    for (const r of pk.rows) byCode[String(r.code).toUpperCase()] = { kind: 'packaging', id: r.id };

    await client.query('BEGIN');
    let saved = 0;
    for (let i = 1; i < rows.length; i++) {
      const code = String(rows[i][0] || '').trim().toUpperCase();
      if (!code) continue;
      const mat = byCode[code];
      if (!mat) continue;
      for (const dc of dateCols) {
        const v = parseFloat(String(rows[i][dc.col]).replace(/\s/g, '').replace(',', '.'));
        if (isNaN(v) || v <= 0) continue;
        await client.query(
          `INSERT INTO price_history_import (item_kind, item_id, price_date, price, source)
           VALUES ($1, $2, $3, $4, 'import')
           ON CONFLICT (item_kind, item_id, price_date, source) DO UPDATE SET price = EXCLUDED.price`,
          [mat.kind, mat.id, dc.date, Math.round(v)]
        );
        saved++;
      }
    }
    await client.query('COMMIT');
    await db.log(req.user.id, 'price_history_import', `точек=${saved}`);
    res.json({ saved });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: 'Ошибка импорта: ' + e.message });
  } finally {
    client.release();
  }
});


// ===== Справочник спецификаций (физические параметры на продукт) =====
// Список продуктов (сырьё + упаковка) с признаком наличия спеки
router.get('/api/spec-products', async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = [];
  let qSQL = '';
  if (q) { params.push('%' + q + '%'); qSQL = ` AND (m.name ILIKE $1 OR m.code ILIKE $1)`; }
  const r = await db.pool.query(
    `WITH mats AS (
       SELECT 'raw' AS kind, id, code, name FROM ref_raw_materials WHERE status='active'
       UNION ALL SELECT 'packaging', id, code, name FROM ref_packaging WHERE status='active'
     )
     SELECT m.*, s.id AS spec_id,
            (SELECT COUNT(*) FROM specification_params sp WHERE sp.spec_id = s.id)::int AS param_count
     FROM mats m
     LEFT JOIN specifications s ON s.item_kind = m.kind AND s.item_id = m.id
     WHERE TRUE ${qSQL} ORDER BY m.name`,
    params
  );
  res.json({ items: r.rows });
});

// Получить спеку продукта (с параметрами)
router.get('/api/spec', async (req, res) => {
  const kind = req.query.kind === 'packaging' ? 'packaging' : 'raw';
  const id = parseInt(req.query.id);
  if (!id) return res.status(400).json({ error: 'Не указан продукт' });
  const s = await db.pool.query('SELECT id FROM specifications WHERE item_kind=$1 AND item_id=$2', [kind, id]);
  if (!s.rows.length) return res.json({ params: [] });
  const p = await db.pool.query('SELECT id, name, ptype, min_val, max_val, unit, target, sort_order FROM specification_params WHERE spec_id=$1 ORDER BY sort_order, id', [s.rows[0].id]);
  res.json({ spec_id: s.rows[0].id, params: p.rows });
});

// Сохранить спеку продукта (перезаписывает параметры)
router.post('/api/spec', express.json({ limit: '1mb' }), async (req, res) => {
  const kind = req.body.item_kind === 'packaging' ? 'packaging' : 'raw';
  const id = parseInt(req.body.item_id);
  if (!id) return res.status(400).json({ error: 'Не указан продукт' });
  const params = Array.isArray(req.body.params) ? req.body.params : [];
  let spec = await db.pool.query('SELECT id FROM specifications WHERE item_kind=$1 AND item_id=$2', [kind, id]);
  let specId;
  if (spec.rows.length) {
    specId = spec.rows[0].id;
    await db.pool.query('UPDATE specifications SET updated_at=now(), updated_by=$1 WHERE id=$2', [req.user.id, specId]);
  } else {
    const r = await db.pool.query('INSERT INTO specifications (item_kind, item_id, updated_by) VALUES ($1,$2,$3) RETURNING id', [kind, id, req.user.id]);
    specId = r.rows[0].id;
  }
  await db.pool.query('DELETE FROM specification_params WHERE spec_id=$1', [specId]);
  let i = 0;
  for (const p of params) {
    const name = String(p.name || '').trim();
    if (!name) continue;
    const ptype = p.ptype === 'quality' ? 'quality' : 'range';
    await db.pool.query(
      `INSERT INTO specification_params (spec_id, name, ptype, min_val, max_val, unit, target, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [specId, name, ptype,
       p.min_val === '' || p.min_val == null ? null : Number(p.min_val),
       p.max_val === '' || p.max_val == null ? null : Number(p.max_val),
       p.unit || '', p.target || '', i++]
    );
  }
  await db.log(req.user.id, 'spec_save', `${kind}#${id}, параметров ${i}`);
  res.json({ ok: true, spec_id: specId });
});

// ---------- Динамика цен ----------
// Сводка по номенклатуре: последняя/мин/макс/средняя цена и число закупок
router.get('/api/price-list', async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = [];
  // фильтры истории цен: поставщик, категория, период
  const histWhere = ["COALESCE(i.fact_price, i.price) > 0"];
  if (req.query.supplier_id) { params.push(parseInt(req.query.supplier_id)); histWhere.push(`po.supplier_id = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); histWhere.push(`po.received_at >= $${params.length}::date`); }
  if (req.query.to) { params.push(req.query.to); histWhere.push(`po.received_at < ($${params.length}::date + INTERVAL '1 day')`); }
  let catSQL = '';
  if (req.query.category_id) { params.push(parseInt(req.query.category_id)); catSQL = ` AND m.category_id = $${params.length}`; }
  let qSQL = '';
  if (q) { params.push('%' + q + '%'); qSQL = ` AND (m.name ILIKE $${params.length} OR m.code ILIKE $${params.length})`; }
  const r = await db.pool.query(
    `WITH hist AS (
       SELECT i.item_kind, i.item_id,
              COALESCE(i.fact_price, i.price) AS price,
              po.received_at
       FROM purchase_order_items i
       JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
       WHERE ${histWhere.join(' AND ')}
     ),
     agg AS (
       SELECT item_kind, item_id,
              COUNT(*)::int AS buys,
              MIN(price) AS min_price,
              MAX(price) AS max_price,
              ROUND(AVG(price)) AS avg_price
       FROM hist GROUP BY item_kind, item_id
     ),
     last AS (
       SELECT DISTINCT ON (item_kind, item_id) item_kind, item_id, price AS last_price, received_at AS last_at
       FROM hist ORDER BY item_kind, item_id, received_at DESC
     ),
     prev AS (
       SELECT item_kind, item_id, price AS prev_price,
              ROW_NUMBER() OVER (PARTITION BY item_kind, item_id ORDER BY received_at DESC) AS rn
       FROM hist
     ),
     mats AS (
       SELECT 'raw' AS kind, id, code, name, category_id, characteristics FROM ref_raw_materials WHERE status = 'active'
       UNION ALL
       SELECT 'packaging', id, code, name, category_id, NULL AS characteristics FROM ref_packaging WHERE status = 'active'
     )
     SELECT m.kind, m.id, m.code, m.name, m.characteristics,
            l.last_price, l.last_at, a.min_price, a.max_price, a.avg_price, a.buys,
            p2.prev_price
     FROM mats m
     JOIN agg a ON a.item_kind = m.kind AND a.item_id = m.id
     JOIN last l ON l.item_kind = m.kind AND l.item_id = m.id
     LEFT JOIN prev p2 ON p2.item_kind = m.kind AND p2.item_id = m.id AND p2.rn = 2
     WHERE TRUE${catSQL}${qSQL}
     ORDER BY m.name`,
    params
  );
  res.json({ items: r.rows });
});

// История цен по конкретной позиции (для сезонности)
router.get('/api/price-history', async (req, res) => {
  const kind = req.query.kind === 'packaging' ? 'packaging' : 'raw';
  const id = parseInt(req.query.id);
  if (!id) return res.status(400).json({ error: 'Не указана позиция' });
  const live = await db.pool.query(
    `SELECT po.received_at AS d, po.number, c.name AS supplier_name,
            COALESCE(i.fact_qty, i.qty) AS qty,
            COALESCE(i.fact_price, i.price) AS price, 'live' AS source
     FROM purchase_order_items i
     JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
     JOIN ref_counterparties c ON c.id = po.supplier_id
     WHERE i.item_kind = $1 AND i.item_id = $2 AND COALESCE(i.fact_price, i.price) > 0`,
    [kind, id]
  );
  const arch = await db.pool.query(
    `SELECT price_date AS d, NULL AS number, 'архив (импорт)' AS supplier_name,
            NULL AS qty, price, 'import' AS source
     FROM price_history_import WHERE item_kind = $1 AND item_id = $2`,
    [kind, id]
  );
  const items = [...arch.rows, ...live.rows].sort((a, b) => new Date(a.d) - new Date(b.d));
  res.json({ items });
});


// Матрица цен: строки = товары, столбцы = даты (объединяет архив-импорт и живые приёмки)
router.get('/api/price-matrix', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.q) { params.push('%' + req.query.q + '%'); where.push(`(m.name ILIKE $${params.length} OR m.code ILIKE $${params.length})`); }
  if (req.query.category_id) { params.push(parseInt(req.query.category_id)); where.push(`m.category_id = $${params.length}`); }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // все точки (архив + приёмки) по дате
  const pts = await db.pool.query(
    `SELECT item_kind, item_id, price_date::text AS d, price FROM price_history_import
     UNION ALL
     SELECT i.item_kind, i.item_id, po.received_at::date::text AS d, COALESCE(i.fact_price, i.price) AS price
     FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
     WHERE COALESCE(i.fact_price, i.price) > 0`
  );
  const mats = await db.pool.query(
    `SELECT m.kind, m.id, m.code, m.name, m.characteristics FROM (
       SELECT 'raw' AS kind, id, code, name, category_id, characteristics FROM ref_raw_materials WHERE status='active'
       UNION ALL
       SELECT 'packaging', id, code, name, category_id, NULL FROM ref_packaging WHERE status='active'
     ) m ${whereSQL} ORDER BY m.name`,
    params
  );
  // собрать набор дат и матрицу
  const dateSet = new Set();
  const byItem = {};
  for (const p of pts.rows) {
    dateSet.add(p.d);
    const k = p.item_kind + ':' + p.item_id;
    (byItem[k] = byItem[k] || {})[p.d] = Math.round(Number(p.price));
  }
  const dates = [...dateSet].sort();
  const items = mats.rows
    .map((m) => ({ kind: m.kind, id: m.id, code: m.code, name: m.name, characteristics: m.characteristics, prices: byItem[m.kind + ':' + m.id] || {} }))
    .filter((it) => Object.keys(it.prices).length > 0);
  res.json({ dates, items });
});

// ---------- Заявки ----------
async function nextOrderNumber() {
  const year = new Date().getFullYear();
  const r = await db.pool.query(`SELECT number FROM purchase_orders WHERE number LIKE $1`, [`PO-${year}-%`]);
  let max = 0;
  for (const row of r.rows) {
    const m = row.number.match(/-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1]));
  }
  return `PO-${year}-${String(max + 1).padStart(3, '0')}`;
}

router.get('/api/orders', async (req, res) => {
  const status = req.query.status || 'all';
  const params = [];
  let where = '1=1';
  if (status !== 'all') {
    params.push(status);
    where = `po.status = $${params.length}`;
  }
  const q = (req.query.q || '').trim();
  if (q) {
    params.push('%' + q + '%');
    where += ` AND (po.number ILIKE $${params.length} OR c.name ILIKE $${params.length})`;
  }
  if (req.query.parent_category_id) {
    params.push(parseInt(req.query.parent_category_id));
    where += ` AND c.parent_category_id = $${params.length}`;
  }
  if (req.query.supplier_id) {
    params.push(parseInt(req.query.supplier_id));
    where += ` AND po.supplier_id = $${params.length}`;
  }
  // мультивыбор товаров: показываем заявки, где есть хотя бы один из выбранных
  let itemJoin = '';
  const itemIds = String(req.query.item_ids || '').split(',').map((x) => parseInt(x)).filter(Boolean);
  if (itemIds.length) {
    params.push(itemIds);
    where += ` AND EXISTS (SELECT 1 FROM purchase_order_items pi WHERE pi.order_id = po.id AND pi.item_id = ANY($${params.length}))`;
  }
  const r = await db.pool.query(
    `SELECT po.id, po.number, po.status, po.payment_type, po.created_at, po.received_at, po.comment,
            c.name AS supplier_name, pc.name AS parent_category_name, pc.color AS parent_category_color,
            COALESCE(SUM(COALESCE(i.fact_qty, i.qty) * COALESCE(i.fact_price, i.price)), 0) AS total,
            COUNT(i.id)::int AS positions
     FROM purchase_orders po
     JOIN ref_counterparties c ON c.id = po.supplier_id
     LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_category_id
     LEFT JOIN purchase_order_items i ON i.order_id = po.id
     WHERE ${where}
     GROUP BY po.id, c.name, pc.name, pc.color
     ORDER BY po.id DESC LIMIT 300`,
    params
  );
  res.json({ items: r.rows });
});

router.get('/api/orders/:id(\\d+)', async (req, res) => {
  const o = await db.pool.query(
    `SELECT po.*, c.name AS supplier_name FROM purchase_orders po
     JOIN ref_counterparties c ON c.id = po.supplier_id WHERE po.id = $1`,
    [req.params.id]
  );
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  const items = await db.pool.query(
    `SELECT i.*, COALESCE(rm.name, pk.name) AS item_name, COALESCE(rm.code, pk.code) AS item_code,
            COALESCE(u1.short_name, u2.short_name) AS unit
     FROM purchase_order_items i
     LEFT JOIN ref_raw_materials rm ON i.item_kind = 'raw' AND rm.id = i.item_id
     LEFT JOIN ref_packaging pk ON i.item_kind = 'packaging' AND pk.id = i.item_id
     LEFT JOIN ref_units u1 ON u1.id = rm.unit_id
     LEFT JOIN ref_units u2 ON u2.id = pk.unit_id
     WHERE i.order_id = $1 ORDER BY i.id`,
    [req.params.id]
  );
  res.json({ order: o.rows[0], items: items.rows });
});

function cleanItems(raw) {
  const out = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    const qty = Number(it.qty);
    const price = Number(it.price) || 0;
    const id = parseInt(it.item_id);
    const kind = it.item_kind === 'packaging' ? 'packaging' : 'raw';
    if (!id || !qty || qty <= 0) continue;
    out.push({ item_kind: kind, item_id: id, qty, price });
  }
  return out;
}

router.post('/api/orders', express.json({ limit: '2mb' }), async (req, res) => {
  const supplierId = parseInt(req.body.supplier_id);
  if (!supplierId) return res.status(400).json({ error: 'Выберите поставщика' });
  const items = cleanItems(req.body.items);
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы одну позицию с количеством' });
  // П5: все позиции должны быть прикреплены к поставщику
  const att = await db.pool.query('SELECT item_kind, item_id FROM supplier_materials WHERE supplier_id = $1', [supplierId]);
  const attSet = new Set(att.rows.map((r) => r.item_kind + ':' + r.item_id));
  const bad = items.filter((it) => !attSet.has(it.item_kind + ':' + it.item_id));
  if (bad.length) {
    return res.status(400).json({ error: 'В заявке есть товары, не закреплённые за поставщиком. Сначала прикрепите их в карточке поставщика (📎 Товары поставщика).' });
  }
  const ptype = req.body.payment_type === 'наличка' ? 'наличка' : 'перечисление';
  const number = await nextOrderNumber();
  const deliveryDate = req.body.delivery_date || null;
  const deliveryWindow = String(req.body.delivery_window || '').trim();
  const o = await db.pool.query(
    `INSERT INTO purchase_orders (number, supplier_id, payment_type, delivery_date, delivery_window, comment, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, number`,
    [number, supplierId, ptype, deliveryDate, deliveryWindow, req.body.comment || '', req.user.id]
  );
  for (const it of items) {
    await db.pool.query(
      'INSERT INTO purchase_order_items (order_id, item_kind, item_id, qty, price) VALUES ($1,$2,$3,$4,$5)',
      [o.rows[0].id, it.item_kind, it.item_id, it.qty, it.price]
    );
  }
  await db.log(req.user.id, 'purchase_order_create', number);
  // уведомление кладовщику, если поставка ожидается сегодня или завтра
  if (deliveryDate) {
    const today = new Date().toISOString().slice(0, 10);
    const tmr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    if (deliveryDate === today || deliveryDate === tmr) {
      const sup = await db.pool.query('SELECT name FROM ref_counterparties WHERE id = $1', [supplierId]);
      await notify({
        role: 'warehouse',
        title: 'Новая заявка на приёмку',
        body: `${deliveryDate === today ? 'Сегодня' : 'Завтра'}: ${sup.rows[0] ? sup.rows[0].name : ''}, ${items.length} позиц.`,
        kind: 'info', link: '/stock#receiving',
      });
    }
  }
  res.json({ id: o.rows[0].id, number: o.rows[0].number });
});

router.put('/api/orders/:id(\\d+)', express.json({ limit: '2mb' }), async (req, res) => {
  const o = await db.pool.query('SELECT status FROM purchase_orders WHERE id = $1', [req.params.id]);
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  if (o.rows[0].status !== 'draft') return res.status(400).json({ error: 'Редактировать можно только черновик' });
  const items = cleanItems(req.body.items);
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы одну позицию' });
  const ptype = req.body.payment_type === 'наличка' ? 'наличка' : 'перечисление';
  await db.pool.query('UPDATE purchase_orders SET payment_type = $1, comment = $2, delivery_date = $3, delivery_window = $4 WHERE id = $5', [
    ptype, req.body.comment || '', req.body.delivery_date || null, String(req.body.delivery_window || '').trim(), req.params.id,
  ]);
  await db.pool.query('DELETE FROM purchase_order_items WHERE order_id = $1', [req.params.id]);
  for (const it of items) {
    await db.pool.query(
      'INSERT INTO purchase_order_items (order_id, item_kind, item_id, qty, price) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, it.item_kind, it.item_id, it.qty, it.price]
    );
  }
  await db.log(req.user.id, 'purchase_order_update', req.params.id);
  res.json({ ok: true });
});

router.post('/api/orders/:id(\\d+)/status', express.json(), async (req, res) => {
  const action = req.body.action;
  const o = await db.pool.query('SELECT status, number FROM purchase_orders WHERE id = $1', [req.params.id]);
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  const cur = o.rows[0].status;
  if (action === 'order' && cur === 'draft') {
    await db.pool.query("UPDATE purchase_orders SET status = 'ordered', ordered_at = now() WHERE id = $1", [req.params.id]);
  } else if (action === 'cancel' && (cur === 'draft' || cur === 'ordered')) {
    await db.pool.query("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1", [req.params.id]);
  } else if (action === 'reopen' && cur === 'ordered') {
    await db.pool.query("UPDATE purchase_orders SET status = 'draft', ordered_at = NULL WHERE id = $1", [req.params.id]);
  } else {
    return res.status(400).json({ error: 'Недопустимое действие для статуса «' + cur + '»' });
  }
  await db.log(req.user.id, 'purchase_order_' + action, o.rows[0].number);
  res.json({ ok: true });
});

// Приёмка: фиксирует факт и закрывает заявку (создаёт долг поставщику и историю цен)
router.post('/api/orders/:id(\\d+)/receive', express.json({ limit: '2mb' }), async (req, res) => {
  const o = await db.pool.query('SELECT status, number FROM purchase_orders WHERE id = $1', [req.params.id]);
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  if (o.rows[0].status !== 'ordered' && o.rows[0].status !== 'draft') {
    return res.status(400).json({ error: 'Принять можно черновик или заказанную заявку' });
  }
  const facts = Array.isArray(req.body.items) ? req.body.items : [];
  let any = false;
  for (const f of facts) {
    const id = parseInt(f.id);
    const fq = Number(f.fact_qty);
    const fp = Number(f.fact_price);
    if (!id || isNaN(fq) || fq < 0) continue;
    await db.pool.query('UPDATE purchase_order_items SET fact_qty = $1, fact_price = $2 WHERE id = $3 AND order_id = $4', [
      fq, isNaN(fp) ? 0 : fp, id, req.params.id,
    ]);
    if (fq > 0) any = true;
  }
  if (!any) return res.status(400).json({ error: 'Укажите фактическое количество хотя бы по одной позиции' });
  await db.pool.query('DELETE FROM purchase_order_items WHERE order_id = $1 AND COALESCE(fact_qty, 0) = 0 AND fact_qty IS NOT NULL', [req.params.id]);
  await db.pool.query("UPDATE purchase_orders SET status = 'received', received_at = now(), received_by = $1 WHERE id = $2", [
    req.user.id, req.params.id,
  ]);
  // система запоминает, что этот поставщик возит эти позиции
  await db.pool.query(
    `INSERT INTO supplier_materials (supplier_id, item_kind, item_id)
     SELECT po.supplier_id, i.item_kind, i.item_id
     FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.order_id
     WHERE i.order_id = $1 AND COALESCE(i.fact_qty, 0) > 0
     ON CONFLICT DO NOTHING`,
    [req.params.id]
  );
  // приход на склад сырья: журнал движений (идемпотентно для повторной приёмки)
  await db.pool.query("DELETE FROM stock_movements WHERE ref_type = 'purchase_order' AND ref_id = $1", [req.params.id]);
  await db.pool.query(
    `INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, price, ref_type, ref_id, moved_at, created_by)
     SELECT i.item_kind, i.item_id, i.fact_qty, 'in', 'receive', COALESCE(i.fact_price, i.price),
            'purchase_order', $1, now()::date, $2
     FROM purchase_order_items i
     WHERE i.order_id = $1 AND COALESCE(i.fact_qty, 0) > 0`,
    [req.params.id, req.user.id]
  );
  await db.log(req.user.id, 'purchase_order_receive', o.rows[0].number);
  res.json({ ok: true });
});

router.delete('/api/orders/:id(\\d+)', async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Удаление заявок доступно только администратору' });
  const o = await db.pool.query('SELECT status, number FROM purchase_orders WHERE id = $1', [req.params.id]);
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  // принятая заявка влияет на долг — предупреждаем и требуем подтверждение
  if (o.rows[0].status === 'received' && req.query.force !== '1') {
    return res.status(409).json({ error: 'received', message: 'Заявка уже принята и учтена в долге поставщика. Удаление откатит поставку.' });
  }
  await db.pool.query("DELETE FROM stock_movements WHERE ref_type = 'purchase_order' AND ref_id = $1", [req.params.id]);
  await db.pool.query('DELETE FROM purchase_orders WHERE id = $1', [req.params.id]); // позиции удалятся каскадом
  await db.log(req.user.id, 'purchase_order_delete', o.rows[0].number + (o.rows[0].status === 'received' ? ' (принятая, откат поставки)' : ''));
  res.json({ ok: true });
});

module.exports = router;
