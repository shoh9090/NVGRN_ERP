// stock.js — блок «Склад сырья»: остатки, движения, списание, инвентаризация
const express = require('express');
const db = require('./db');

const router = express.Router();

router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('stock', { settings, user: req.user });
});

// Опции фильтров (родительские категории + категории)
router.get('/api/filter-options', async (req, res) => {
  const parents = await db.pool.query("SELECT id, name, color FROM ref_parent_categories WHERE status = 'active' ORDER BY name");
  const cats = await db.pool.query("SELECT id, name FROM ref_categories WHERE kind = 'категория' AND (sd_sd_id IS NULL OR sd_sd_id = '') ORDER BY name");
  res.json({ parents: parents.rows, categories: cats.rows });
});

// Остатки по позициям (приход − расход из журнала движений)
router.get('/api/balances', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.q) { params.push('%' + req.query.q + '%'); where.push(`(m.name ILIKE $${params.length} OR m.code ILIKE $${params.length})`); }
  if (req.query.parent_category_id) { params.push(parseInt(req.query.parent_category_id)); where.push(`pc.id = $${params.length}`); }
  if (req.query.category_id) { params.push(parseInt(req.query.category_id)); where.push(`m.category_id = $${params.length}`); }
  const onlyStock = req.query.only_stock === '1';
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const r = await db.pool.query(
    `WITH mats AS (
       SELECT 'raw' AS kind, rm.id, rm.code, rm.name, rm.characteristics, rm.category_id,
              u.short_name AS unit, c.name AS category, c.parent_id AS pc_id
       FROM ref_raw_materials rm
       LEFT JOIN ref_units u ON u.id = rm.unit_id
       LEFT JOIN ref_categories c ON c.id = rm.category_id
       WHERE rm.status = 'active'
       UNION ALL
       SELECT 'packaging', pk.id, pk.code, pk.name, NULL, pk.category_id,
              u.short_name, c.name, c.parent_id
       FROM ref_packaging pk
       LEFT JOIN ref_units u ON u.id = pk.unit_id
       LEFT JOIN ref_categories c ON c.id = pk.category_id
       WHERE pk.status = 'active'
     ),
     mv AS (
       SELECT item_kind, item_id,
              SUM(qty) AS balance,
              SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END) AS total_in,
              SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END) AS total_out
       FROM stock_movements GROUP BY item_kind, item_id
     ),
     lastprice AS (
       SELECT DISTINCT ON (item_kind, item_id) item_kind, item_id, price
       FROM stock_movements WHERE direction = 'in' AND price > 0
       ORDER BY item_kind, item_id, moved_at DESC, id DESC
     )
     SELECT m.kind, m.id, m.code, m.name, m.characteristics, m.unit, m.category, m.category_id,
            pc.id AS pc_id, pc.name AS pc_name, pc.color AS pc_color,
            COALESCE(mv.balance, 0) AS balance,
            COALESCE(mv.total_in, 0) AS total_in,
            COALESCE(mv.total_out, 0) AS total_out,
            lp.price AS last_price,
            COALESCE(mv.balance, 0) * COALESCE(lp.price, 0) AS value
     FROM mats m
     LEFT JOIN mv ON mv.item_kind = m.kind AND mv.item_id = m.id
     LEFT JOIN lastprice lp ON lp.item_kind = m.kind AND lp.item_id = m.id
     LEFT JOIN ref_parent_categories pc ON pc.id = m.pc_id
     ${whereSQL}
     ${onlyStock ? (whereSQL ? 'AND' : 'WHERE') + ' COALESCE(mv.balance,0) <> 0' : ''}
     ORDER BY m.name`,
    params
  );
  const totalValue = r.rows.reduce((s, x) => s + Number(x.value || 0), 0);
  const positions = r.rows.filter((x) => Number(x.balance) !== 0).length;
  res.json({ items: r.rows, totalValue, positions });
});

// Журнал движений по позиции (карточка)
router.get('/api/movements', async (req, res) => {
  const kind = req.query.kind === 'packaging' ? 'packaging' : 'raw';
  const id = parseInt(req.query.id);
  if (!id) return res.status(400).json({ error: 'Не указана позиция' });
  const r = await db.pool.query(
    `SELECT sm.id, sm.qty, sm.direction, sm.reason, sm.price, sm.comment, sm.moved_at,
            sm.ref_type, sm.ref_id, po.number AS order_number, c.name AS supplier_name
     FROM stock_movements sm
     LEFT JOIN purchase_orders po ON sm.ref_type = 'purchase_order' AND po.id = sm.ref_id
     LEFT JOIN ref_counterparties c ON c.id = po.supplier_id
     WHERE sm.item_kind = $1 AND sm.item_id = $2
     ORDER BY sm.moved_at DESC, sm.id DESC`,
    [kind, id]
  );
  res.json({ items: r.rows });
});

// Ручное движение: списание (out) или корректировка (adjust)
router.post('/api/movement', express.json(), async (req, res) => {
  const kind = req.body.item_kind === 'packaging' ? 'packaging' : 'raw';
  const id = parseInt(req.body.item_id);
  const reason = req.body.reason; // writeoff | adjust
  let qty = Number(req.body.qty);
  if (!id || isNaN(qty)) return res.status(400).json({ error: 'Укажите позицию и количество' });

  let direction, signedQty;
  if (reason === 'writeoff') {
    // списание: всегда уменьшает остаток
    direction = 'out';
    signedQty = -Math.abs(qty);
  } else if (reason === 'adjust') {
    // корректировка до фактического остатка: вычисляем дельту
    const cur = await db.pool.query(
      'SELECT COALESCE(SUM(qty),0) AS bal FROM stock_movements WHERE item_kind = $1 AND item_id = $2',
      [kind, id]
    );
    const delta = qty - Number(cur.rows[0].bal); // qty здесь = желаемый фактический остаток
    if (delta === 0) return res.json({ ok: true, note: 'остаток уже совпадает' });
    direction = 'adjust';
    signedQty = delta;
  } else {
    return res.status(400).json({ error: 'Неизвестная операция' });
  }

  await db.pool.query(
    `INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, ref_type, comment, moved_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6, COALESCE($7::date, CURRENT_DATE), $8)`,
    [kind, id, signedQty, direction, reason, req.body.comment || '', req.body.moved_at || null, req.user.id]
  );
  await db.log(req.user.id, 'stock_' + reason, `${kind}#${id} qty=${signedQty}`);
  res.json({ ok: true });
});

module.exports = router;
