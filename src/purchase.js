// purchase.js — блок «Закуп»: поставщики, заявки, приёмка, взаиморасчёты
const express = require('express');
const db = require('./db');

const router = express.Router();

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
    qSQL = ` AND (c.name ILIKE $1 OR c.legal_name ILIKE $1 OR c.inn ILIKE $1 OR c.supplies ILIKE $1)`;
  }
  const r = await db.pool.query(
    `SELECT c.id, c.name, c.legal_name, c.phone, c.inn, c.supplies, c.payment_terms, c.status,
            COALESCE(c.opening_balance, 0) AS opening_balance,
            COALESCE(d.delivered, 0) AS delivered,
            COALESCE(p.paid, 0) AS paid,
            COALESCE(c.opening_balance, 0) + COALESCE(d.delivered, 0) - COALESCE(p.paid, 0) AS balance,
            COALESCE(sm.n, 0) AS attached_count
     FROM ref_counterparties c
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
     WHERE c.role_supplier = TRUE AND c.status = 'active'${qSQL}
     ORDER BY c.name`,
    params
  );
  res.json({ items: r.rows });
});

router.put('/api/suppliers/:id(\\d+)', express.json(), async (req, res) => {
  const allowed = ['name', 'legal_name', 'phone', 'inn', 'supplies', 'payment_terms', 'opening_balance', 'comment'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in req.body) {
      vals.push(k === 'opening_balance' ? (req.body[k] === '' ? null : Number(req.body[k])) : String(req.body[k] ?? ''));
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
    `INSERT INTO ref_counterparties (name, legal_name, phone, inn, supplies, role_supplier, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, $6) RETURNING id`,
    [name, req.body.legal_name || '', req.body.phone || '', req.body.inn || '', req.body.supplies || '', req.user.id]
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
    'SELECT id, name, legal_name, phone, inn, supplies, payment_terms, COALESCE(opening_balance,0) AS opening_balance FROM ref_counterparties WHERE id = $1',
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
       SELECT i.item_kind, i.item_id, SUM(COALESCE(i.fact_qty, 0)) AS received_total
       FROM purchase_order_items i
       JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
       GROUP BY i.item_kind, i.item_id
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
  const r = await db.pool.query(
    `SELECT po.id, po.number, po.status, po.payment_type, po.created_at, po.received_at, po.comment,
            c.name AS supplier_name,
            COALESCE(SUM(COALESCE(i.fact_qty, i.qty) * COALESCE(i.fact_price, i.price)), 0) AS total,
            COUNT(i.id)::int AS positions
     FROM purchase_orders po
     JOIN ref_counterparties c ON c.id = po.supplier_id
     LEFT JOIN purchase_order_items i ON i.order_id = po.id
     WHERE ${where}
     GROUP BY po.id, c.name
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
  const ptype = req.body.payment_type === 'наличка' ? 'наличка' : 'перечисление';
  const number = await nextOrderNumber();
  const o = await db.pool.query(
    `INSERT INTO purchase_orders (number, supplier_id, payment_type, comment, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, number`,
    [number, supplierId, ptype, req.body.comment || '', req.user.id]
  );
  for (const it of items) {
    await db.pool.query(
      'INSERT INTO purchase_order_items (order_id, item_kind, item_id, qty, price) VALUES ($1,$2,$3,$4,$5)',
      [o.rows[0].id, it.item_kind, it.item_id, it.qty, it.price]
    );
  }
  await db.log(req.user.id, 'purchase_order_create', number);
  res.json({ id: o.rows[0].id, number: o.rows[0].number });
});

router.put('/api/orders/:id(\\d+)', express.json({ limit: '2mb' }), async (req, res) => {
  const o = await db.pool.query('SELECT status FROM purchase_orders WHERE id = $1', [req.params.id]);
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  if (o.rows[0].status !== 'draft') return res.status(400).json({ error: 'Редактировать можно только черновик' });
  const items = cleanItems(req.body.items);
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы одну позицию' });
  const ptype = req.body.payment_type === 'наличка' ? 'наличка' : 'перечисление';
  await db.pool.query('UPDATE purchase_orders SET payment_type = $1, comment = $2 WHERE id = $3', [
    ptype, req.body.comment || '', req.params.id,
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
  await db.log(req.user.id, 'purchase_order_receive', o.rows[0].number);
  res.json({ ok: true });
});

router.delete('/api/orders/:id(\\d+)', async (req, res) => {
  const o = await db.pool.query('SELECT status, number FROM purchase_orders WHERE id = $1', [req.params.id]);
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  if (o.rows[0].status !== 'draft' && o.rows[0].status !== 'cancelled') {
    return res.status(400).json({ error: 'Удалить можно только черновик или отменённую заявку' });
  }
  await db.pool.query('DELETE FROM purchase_orders WHERE id = $1', [req.params.id]);
  await db.log(req.user.id, 'purchase_order_delete', o.rows[0].number);
  res.json({ ok: true });
});

module.exports = router;
