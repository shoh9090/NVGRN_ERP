// stock.js — блок «Склад сырья»: рабочее место кладовщика (приёмка, передача в производство, итоги дня)
const express = require('express');
const db = require('./db');
const { notify } = require('./notifications');

const router = express.Router();

router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('stock', { settings, user: req.user });
});

// ===== Вкладка 1: ПРИЁМКА СЕГОДНЯ =====
router.get('/api/calendar', async (req, res) => {
  const r = await db.pool.query(
    `SELECT delivery_date::text AS d, COUNT(*)::int AS total,
            SUM(CASE WHEN receipt_status = 'pending' THEN 1 ELSE 0 END)::int AS pending
     FROM purchase_orders
     WHERE delivery_date IS NOT NULL AND status IN ('ordered','draft','received')
     GROUP BY delivery_date ORDER BY delivery_date`
  );
  res.json({ days: r.rows });
});

router.get('/api/receipts', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const r = await db.pool.query(
    `SELECT po.id, po.number, po.receipt_status, po.delivery_date::text AS delivery_date,
            c.name AS supplier_name, SUM(i.qty) AS plan_qty, COUNT(i.id)::int AS positions
     FROM purchase_orders po
     JOIN ref_counterparties c ON c.id = po.supplier_id
     LEFT JOIN purchase_order_items i ON i.order_id = po.id
     WHERE po.delivery_date = $1::date AND po.status IN ('ordered','draft','received')
     GROUP BY po.id, c.name
     ORDER BY po.receipt_status = 'received', po.number`,
    [date]
  );
  const total = r.rows.length;
  const done = r.rows.filter((x) => x.receipt_status !== 'pending').length;
  res.json({ date, items: r.rows, total, done, left: total - done });
});

router.get('/api/receipt/:id(\\d+)', async (req, res) => {
  const o = await db.pool.query(
    `SELECT po.id, po.number, po.receipt_status, po.delivery_date::text AS delivery_date, c.name AS supplier_name
     FROM purchase_orders po JOIN ref_counterparties c ON c.id = po.supplier_id WHERE po.id = $1`,
    [req.params.id]
  );
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  const items = await db.pool.query(
    `SELECT i.id, i.qty AS plan_qty, i.fact_qty,
            COALESCE(rm.name, pk.name) AS item_name, COALESCE(rm.code, pk.code) AS item_code,
            COALESCE(u1.short_name, u2.short_name) AS unit, i.item_kind, i.item_id
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

router.post('/api/receipt/:id(\\d+)', express.json({ limit: '2mb' }), async (req, res) => {
  const o = await db.pool.query(
    `SELECT po.number, po.created_by, c.name AS supplier_name
     FROM purchase_orders po JOIN ref_counterparties c ON c.id = po.supplier_id WHERE po.id = $1`,
    [req.params.id]
  );
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  const facts = Array.isArray(req.body.items) ? req.body.items : [];
  for (const f of facts) {
    const id = parseInt(f.id);
    const fq = Number(f.fact_qty);
    if (!id || isNaN(fq) || fq < 0) continue;
    await db.pool.query('UPDATE purchase_order_items SET fact_qty = $1 WHERE id = $2 AND order_id = $3', [fq, id, req.params.id]);
  }
  const sums = await db.pool.query(
    'SELECT COALESCE(SUM(qty),0) AS plan, COALESCE(SUM(fact_qty),0) AS fact FROM purchase_order_items WHERE order_id = $1',
    [req.params.id]
  );
  const planSum = Number(sums.rows[0].plan);
  const factSum = Number(sums.rows[0].fact);
  let rstatus = 'received';
  if (factSum === 0) rstatus = 'not_arrived';
  else if (factSum < planSum) rstatus = 'partial';

  await db.pool.query(
    "UPDATE purchase_orders SET status = 'received', receipt_status = $1, received_at = now(), received_by = $2 WHERE id = $3",
    [rstatus, req.user.id, req.params.id]
  );
  await db.pool.query(
    `INSERT INTO supplier_materials (supplier_id, item_kind, item_id)
     SELECT po.supplier_id, i.item_kind, i.item_id FROM purchase_order_items i
     JOIN purchase_orders po ON po.id = i.order_id
     WHERE i.order_id = $1 AND COALESCE(i.fact_qty,0) > 0 ON CONFLICT DO NOTHING`,
    [req.params.id]
  );
  await db.pool.query("DELETE FROM stock_movements WHERE ref_type = 'purchase_order' AND ref_id = $1", [req.params.id]);
  await db.pool.query(
    `INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, price, ref_type, ref_id, moved_at, created_by)
     SELECT i.item_kind, i.item_id, i.fact_qty, 'in', 'receive', COALESCE(i.fact_price, i.price),
            'purchase_order', $1, now()::date, $2
     FROM purchase_order_items i WHERE i.order_id = $1 AND COALESCE(i.fact_qty,0) > 0`,
    [req.params.id, req.user.id]
  );

  const dev = factSum - planSum;
  const statusText = rstatus === 'received' ? 'принята полностью' : rstatus === 'partial' ? 'принята частично' : 'не приехала';
  await notify({
    role: 'purchaser', userId: o.rows[0].created_by || null,
    title: 'Поставка ' + statusText,
    body: `${o.rows[0].supplier_name}, заявка ${o.rows[0].number}: план ${planSum}, факт ${factSum}${dev !== 0 ? ', отклонение ' + (dev > 0 ? '+' : '') + dev : ''}`,
    kind: rstatus === 'received' ? 'success' : 'warning', link: '/purchase#orders',
  });
  if (planSum > 0 && factSum < planSum * 0.85) {
    await notify({ role: 'manager', title: 'Крупное отклонение поставки',
      body: `${o.rows[0].supplier_name}, ${o.rows[0].number}: факт ниже плана (${factSum} из ${planSum})`,
      kind: 'warning', link: '/purchase#orders' });
  }
  await db.log(req.user.id, 'stock_receipt', `${o.rows[0].number} → ${rstatus} (план ${planSum}, факт ${factSum})`);
  res.json({ ok: true, status: rstatus, planSum, factSum });
});

// ===== Вкладка 2: ПЕРЕДАЧА В ПРОИЗВОДСТВО =====
router.get('/api/available', async (req, res) => {
  const r = await db.pool.query(
    `WITH mats AS (
       SELECT 'raw' AS kind, rm.id, rm.code, rm.name, u.short_name AS unit
       FROM ref_raw_materials rm LEFT JOIN ref_units u ON u.id = rm.unit_id WHERE rm.status='active'
       UNION ALL
       SELECT 'packaging', pk.id, pk.code, pk.name, u.short_name
       FROM ref_packaging pk LEFT JOIN ref_units u ON u.id = pk.unit_id WHERE pk.status='active'
     ),
     mv AS (SELECT item_kind, item_id, SUM(qty) AS balance FROM stock_movements GROUP BY item_kind, item_id)
     SELECT m.*, COALESCE(mv.balance,0) AS balance
     FROM mats m LEFT JOIN mv ON mv.item_kind=m.kind AND mv.item_id=m.id
     WHERE COALESCE(mv.balance,0) > 0 ORDER BY m.name`
  );
  let zones = [];
  try {
    const z = await db.pool.query("SELECT name FROM ref_production_areas WHERE status='active' ORDER BY name");
    zones = z.rows.map((x) => x.name);
  } catch (e) { /* нет справочника */ }
  if (!zones.length) zones = ['Производство 1 / грязный цех', 'Производство 2 / чистый цех'];
  res.json({ items: r.rows, zones });
});

router.post('/api/issue', express.json({ limit: '2mb' }), async (req, res) => {
  const area = String(req.body.area || '').trim();
  const items = (Array.isArray(req.body.items) ? req.body.items : [])
    .map((it) => ({ kind: it.item_kind === 'packaging' ? 'packaging' : 'raw', id: parseInt(it.item_id), qty: Number(it.qty) }))
    .filter((it) => it.id && it.qty > 0);
  if (!area) return res.status(400).json({ error: 'Выберите производственную зону' });
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы одну позицию с количеством' });

  const iss = await db.pool.query(
    'INSERT INTO production_issues (area, issued_at, comment, created_by) VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4) RETURNING id',
    [area, req.body.issued_at || null, req.body.comment || '', req.user.id]
  );
  const issueId = iss.rows[0].id;
  for (const it of items) {
    await db.pool.query('INSERT INTO production_issue_items (issue_id, item_kind, item_id, qty) VALUES ($1,$2,$3,$4)', [issueId, it.kind, it.id, it.qty]);
    await db.pool.query(
      `INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, ref_type, ref_id, moved_at, created_by)
       VALUES ($1, $2, $3, 'out', 'production', 'production_issue', $4, COALESCE($5::date, CURRENT_DATE), $6)`,
      [it.kind, it.id, -Math.abs(it.qty), issueId, req.body.issued_at || null, req.user.id]
    );
  }
  await notify({ role: 'manager', title: 'Передача в производство', body: `${area}: ${items.length} позиц.`, kind: 'info', link: '/stock#issue' });
  await db.log(req.user.id, 'stock_issue', `${area}, позиций ${items.length}`);
  res.json({ ok: true });
});

// ===== Вкладка 3: ИТОГИ ДНЯ =====
router.get('/api/day-summary', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const arrived = await db.pool.query("SELECT COALESCE(SUM(qty),0) AS s FROM stock_movements WHERE reason='receive' AND moved_at = $1::date", [date]);
  const issued = await db.pool.query("SELECT COALESCE(SUM(-qty),0) AS s FROM stock_movements WHERE reason='production' AND moved_at = $1::date", [date]);
  const balance = await db.pool.query('SELECT COALESCE(SUM(qty),0) AS s FROM stock_movements');
  const problems = await db.pool.query(
    `SELECT po.number, c.name AS supplier_name, po.receipt_status,
            COALESCE(SUM(i.qty),0) AS plan, COALESCE(SUM(i.fact_qty),0) AS fact
     FROM purchase_orders po JOIN ref_counterparties c ON c.id = po.supplier_id
     LEFT JOIN purchase_order_items i ON i.order_id = po.id
     WHERE po.delivery_date = $1::date AND po.receipt_status IN ('partial','not_arrived')
     GROUP BY po.id, c.name ORDER BY po.number`,
    [date]
  );
  res.json({
    date,
    arrived: Number(arrived.rows[0].s), issued: Number(issued.rows[0].s), balance: Number(balance.rows[0].s),
    problems: problems.rows, problemsCount: problems.rows.length,
    notArrived: problems.rows.filter((x) => x.receipt_status === 'not_arrived').length,
  });
});

module.exports = router;
