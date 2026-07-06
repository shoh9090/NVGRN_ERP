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
  // спецификация по каждой позиции (физпараметры)
  for (const it of items.rows) {
    const sp = await db.pool.query(
      `SELECT p.name, p.ptype, p.min_val, p.max_val, p.unit, p.target
       FROM specifications s JOIN specification_params p ON p.spec_id = s.id
       WHERE s.item_kind = $1 AND s.item_id = $2 ORDER BY p.sort_order, p.id`,
      [it.item_kind, it.item_id]
    );
    it.spec_params = sp.rows;
  }
  res.json({ order: o.rows[0], items: items.rows, isAdmin: !!req.user.isAdmin });
});

router.post('/api/receipt/:id(\\d+)', express.json({ limit: '2mb' }), async (req, res) => {
  const o = await db.pool.query(
    `SELECT po.number, po.created_by, c.name AS supplier_name
     FROM purchase_orders po JOIN ref_counterparties c ON c.id = po.supplier_id WHERE po.id = $1`,
    [req.params.id]
  );
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  const facts = Array.isArray(req.body.items) ? req.body.items : [];
  const temperature = String(req.body.temperature || '').trim();
  const receiptComment = String(req.body.comment || '').trim();
  const receiptReason = String(req.body.reason || '').trim();
  const overrideSpec = !!req.body.override_spec; // принять с отклонением (админ/руководитель)

  // проверка спеки: есть ли проваленные параметры
  let specFailed = false;
  const checks = Array.isArray(req.body.checks) ? req.body.checks : [];
  for (const c of checks) { if (c.passed === false) specFailed = true; }

  // мягкая блокировка: спека провалена и нет override → отказ
  if (specFailed && !overrideSpec) {
    return res.status(409).json({ error: 'spec_failed', message: 'Часть параметров не соответствует спецификации. Принять может только администратор/руководитель — кнопкой «Принять с отклонением».' });
  }

  for (const f of facts) {
    const id = parseInt(f.id);
    const fq = Number(f.fact_qty);
    if (!id || isNaN(fq) || fq < 0) continue;
    await db.pool.query('UPDATE purchase_order_items SET fact_qty = $1 WHERE id = $2 AND order_id = $3', [fq, id, req.params.id]);
  }
  // сохранить результаты проверки спеки
  await db.pool.query('DELETE FROM receipt_param_checks WHERE order_id = $1', [req.params.id]);
  for (const c of checks) {
    await db.pool.query(
      'INSERT INTO receipt_param_checks (order_id, item_id, param_name, ptype, measured, passed) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.params.id, c.item_id || null, String(c.param_name || ''), c.ptype || null, String(c.measured || ''), c.passed === false ? false : true]
    );
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
    `UPDATE purchase_orders SET status = 'received', receipt_status = $1, received_at = now(), received_by = $2,
            temperature = $3, receipt_comment = $4, receipt_reason = $5 WHERE id = $6`,
    [rstatus, req.user.id, temperature, receiptComment, receiptReason, req.params.id]
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


// ===== Справочник причин =====
router.get('/api/reasons', async (req, res) => {
  const scope = req.query.scope;
  const params = [];
  let where = "status = 'active'";
  if (scope) { params.push(scope); where += ` AND scope = $${params.length}`; }
  const r = await db.pool.query(`SELECT id, name, scope FROM reject_reasons WHERE ${where} ORDER BY sort_order, name`, params);
  res.json({ items: r.rows });
});
router.post('/api/reasons', express.json(), async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Только администратор' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название' });
  await db.pool.query('INSERT INTO reject_reasons (name, scope) VALUES ($1, $2)', [name, req.body.scope || 'receipt']);
  res.json({ ok: true });
});
router.delete('/api/reasons/:id(\\d+)', async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Только администратор' });
  await db.pool.query("UPDATE reject_reasons SET status='archived' WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ===== Откат приёмки (отмена-возврат): убирает приход со склада, возвращает статус заявки =====
router.post('/api/receipt/:id(\\d+)/cancel', async (req, res) => {
  const o = await db.pool.query('SELECT number, receipt_status FROM purchase_orders WHERE id=$1', [req.params.id]);
  if (!o.rows.length) return res.status(404).json({ error: 'Заявка не найдена' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Откат приёмки доступен только администратору' });
  // убираем движения склада этой приёмки и обнуляем факт/статус
  await db.pool.query("DELETE FROM stock_movements WHERE ref_type='purchase_order' AND ref_id=$1", [req.params.id]);
  await db.pool.query('UPDATE purchase_order_items SET fact_qty = NULL WHERE order_id=$1', [req.params.id]);
  await db.pool.query("UPDATE purchase_orders SET receipt_status='pending', received_at=NULL, temperature='', receipt_comment='', receipt_reason='' WHERE id=$1", [req.params.id]);
  await db.pool.query('DELETE FROM receipt_param_checks WHERE order_id=$1', [req.params.id]);
  await db.log(req.user.id, 'stock_receipt_cancel', o.rows[0].number);
  res.json({ ok: true });
});

// ===== Зачистка склада для тестов (только админ) =====
router.post('/api/wipe', express.json(), async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Только администратор' });
  if ((req.body.confirm || '').trim().toUpperCase() !== 'ОЧИСТИТЬ') {
    return res.status(400).json({ error: 'Введите слово ОЧИСТИТЬ для подтверждения' });
  }
  await db.pool.query('TRUNCATE stock_movements, production_issue_items, production_issues, receipt_param_checks RESTART IDENTITY');
  await db.pool.query("UPDATE purchase_orders SET receipt_status='pending', received_at=NULL, temperature='', receipt_comment='', receipt_reason='' WHERE receipt_status <> 'pending'");
  await db.pool.query('UPDATE purchase_order_items SET fact_qty = NULL');
  await db.log(req.user.id, 'stock_wipe', 'полная зачистка склада для тестов');
  res.json({ ok: true });
});

// ===== Вкладка 2: ПЕРЕДАЧА В ПРОИЗВОДСТВО =====
router.get('/api/available', async (req, res) => {
  const r = await db.pool.query(
    `WITH mats AS (
       SELECT 'raw' AS kind, rm.id, rm.code, rm.name, u.short_name AS unit,
              rm.category_id, c.name AS category_name, c.parent_id AS pc_id, pc.name AS pc_name
       FROM ref_raw_materials rm
       LEFT JOIN ref_units u ON u.id = rm.unit_id
       LEFT JOIN ref_categories c ON c.id = rm.category_id
       LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_id
       WHERE rm.status='active'
       UNION ALL
       SELECT 'packaging', pk.id, pk.code, pk.name, u.short_name,
              pk.category_id, c.name, c.parent_id, pc.name
       FROM ref_packaging pk
       LEFT JOIN ref_units u ON u.id = pk.unit_id
       LEFT JOIN ref_categories c ON c.id = pk.category_id
       LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_id
       WHERE pk.status='active'
     ),
     mv AS (SELECT item_kind, item_id, SUM(qty) AS balance FROM stock_movements GROUP BY item_kind, item_id),
     reserved AS (
       SELECT pii.item_kind, pii.item_id, SUM(pii.qty) AS in_transit
       FROM production_issue_items pii
       JOIN production_issues pi ON pi.id = pii.issue_id AND pi.status = 'pending'
       GROUP BY pii.item_kind, pii.item_id
     )
     SELECT m.*, COALESCE(mv.balance,0) AS balance,
            COALESCE(rs.in_transit,0) AS in_transit,
            COALESCE(mv.balance,0) - COALESCE(rs.in_transit,0) AS available
     FROM mats m
     LEFT JOIN mv ON mv.item_kind=m.kind AND mv.item_id=m.id
     LEFT JOIN reserved rs ON rs.item_kind=m.kind AND rs.item_id=m.id
     WHERE COALESCE(mv.balance,0) > 0 ORDER BY m.name`
  );
  let zones = [];
  try {
    const z = await db.pool.query("SELECT name FROM ref_production_areas WHERE status='active' ORDER BY name");
    zones = z.rows.map((x) => x.name);
  } catch (e) { /* нет справочника */ }
  if (!zones.length) zones = ['Производство 1 / грязный цех', 'Производство 2 / чистый цех'];
  const parents = await db.pool.query("SELECT id, name FROM ref_parent_categories WHERE status='active' ORDER BY name");
  const cats = await db.pool.query("SELECT id, name, parent_id FROM ref_categories WHERE kind='категория' AND (sd_sd_id IS NULL OR sd_sd_id='') ORDER BY name");
  res.json({ items: r.rows, zones, parents: parents.rows, categories: cats.rows });
});

router.post('/api/issue', express.json({ limit: '2mb' }), async (req, res) => {
  const area = String(req.body.area || '').trim();
  const items = (Array.isArray(req.body.items) ? req.body.items : [])
    .map((it) => ({ kind: it.item_kind === 'packaging' ? 'packaging' : 'raw', id: parseInt(it.item_id), qty: Number(it.qty) }))
    .filter((it) => it.id && it.qty > 0);
  if (!area) return res.status(400).json({ error: 'Выберите производственную зону' });
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы одну позицию с количеством' });

  // Атомарно: проверка доступного остатка + создание документа в одной транзакции
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // блокируем строки движений по этим позициям, чтобы исключить гонку
    for (const it of items) {
      const bal = await client.query(
        'SELECT COALESCE(SUM(qty),0) AS b FROM stock_movements WHERE item_kind=$1 AND item_id=$2',
        [it.kind, it.id]
      );
      const res2 = await client.query(
        `SELECT COALESCE(SUM(pii.qty),0) AS r FROM production_issue_items pii
         JOIN production_issues pi ON pi.id = pii.issue_id AND pi.status='pending'
         WHERE pii.item_kind=$1 AND pii.item_id=$2`, [it.kind, it.id]);
      const available = Number(bal.rows[0].b) - Number(res2.rows[0].r);
      if (it.qty > available + 1e-9) {
        await client.query('ROLLBACK');
        const nm = await db.pool.query(
          it.kind === 'raw' ? 'SELECT name FROM ref_raw_materials WHERE id=$1' : 'SELECT name FROM ref_packaging WHERE id=$1', [it.id]);
        return res.status(400).json({ error: `Нельзя передать больше доступного остатка по «${nm.rows[0] ? nm.rows[0].name : ''}». Доступно: ${available}` });
      }
    }
    const iss = await client.query(
      "INSERT INTO production_issues (area, status, issued_at, comment, created_by) VALUES ($1, 'pending', COALESCE($2::date, CURRENT_DATE), $3, $4) RETURNING id",
      [area, req.body.issued_at || null, req.body.comment || '', req.user.id]
    );
    var issueId = iss.rows[0].id;
    for (const it of items) {
      await client.query('INSERT INTO production_issue_items (issue_id, item_kind, item_id, qty) VALUES ($1,$2,$3,$4)', [issueId, it.kind, it.id, it.qty]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ error: 'Ошибка создания передачи: ' + e.message });
  } finally {
    client.release();
  }
  await notify({ role: 'manager', title: 'Новая передача в производство', body: `${area}: ${items.length} позиц. — ожидает подтверждения`, kind: 'info', link: '/stock#issue' });
  await db.log(req.user.id, 'stock_issue_create', `#${issueId} ${area}, позиций ${items.length}`);
  res.json({ ok: true, issueId });
});

// Список передач (для вкладки склада: история своих передач со статусами)
router.get('/api/issues', async (req, res) => {
  const r = await db.pool.query(
    `SELECT pi.id, pi.area, pi.status, pi.issued_at::text AS issued_at, pi.created_at,
            COUNT(pii.id)::int AS positions,
            COALESCE(SUM(pii.qty),0) AS total_qty,
            COALESCE(SUM(pii.fact_qty),0) AS total_fact
     FROM production_issues pi
     LEFT JOIN production_issue_items pii ON pii.issue_id = pi.id
     GROUP BY pi.id ORDER BY pi.id DESC LIMIT 100`
  );
  res.json({ items: r.rows });
});

// Позиции передачи (карточка)
router.get('/api/issue/:id(\\d+)', async (req, res) => {
  const pi = await db.pool.query('SELECT * FROM production_issues WHERE id=$1', [req.params.id]);
  if (!pi.rows.length) return res.status(404).json({ error: 'Передача не найдена' });
  const items = await db.pool.query(
    `SELECT pii.id, pii.qty, pii.fact_qty, pii.diff_comment, pii.item_kind, pii.item_id,
            COALESCE(rm.name, pk.name) AS item_name, COALESCE(rm.code, pk.code) AS item_code,
            COALESCE(u1.short_name, u2.short_name) AS unit
     FROM production_issue_items pii
     LEFT JOIN ref_raw_materials rm ON pii.item_kind='raw' AND rm.id=pii.item_id
     LEFT JOIN ref_packaging pk ON pii.item_kind='packaging' AND pk.id=pii.item_id
     LEFT JOIN ref_units u1 ON u1.id=rm.unit_id
     LEFT JOIN ref_units u2 ON u2.id=pk.unit_id
     WHERE pii.issue_id=$1 ORDER BY pii.id`, [req.params.id]);
  res.json({ issue: pi.rows[0], items: items.rows });
});

// Отмена передачи складом (только до подтверждения производством)
// Массовая очистка всех передач (только админ, для тестов)
router.post('/api/issues/wipe', async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Доступно только администратору' });
  await db.pool.query("DELETE FROM stock_movements WHERE ref_type='production_issue'");
  await db.pool.query('DELETE FROM production_issues');
  await db.log(req.user.id, 'stock_issues_wipe', 'удалены все передачи');
  res.json({ ok: true });
});

// Удаление передачи (только админ, для чистки тестовых)
router.delete('/api/issue/:id(\\d+)', async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Удаление доступно только администратору' });
  // если передача была подтверждена — вернуть списанное на склад (откат движения)
  await db.pool.query("DELETE FROM stock_movements WHERE ref_type='production_issue' AND ref_id=$1", [req.params.id]);
  await db.pool.query('DELETE FROM production_issues WHERE id=$1', [req.params.id]);
  await db.log(req.user.id, 'stock_issue_delete', '#' + req.params.id);
  res.json({ ok: true });
});

router.post('/api/issue/:id(\\d+)/cancel', async (req, res) => {
  const pi = await db.pool.query('SELECT status FROM production_issues WHERE id=$1', [req.params.id]);
  if (!pi.rows.length) return res.status(404).json({ error: 'Передача не найдена' });
  if (pi.rows[0].status !== 'pending') return res.status(400).json({ error: 'Отменить можно только передачу, ожидающую подтверждения' });
  await db.pool.query("UPDATE production_issues SET status='cancelled' WHERE id=$1", [req.params.id]);
  await db.log(req.user.id, 'stock_issue_cancel', '#' + req.params.id);
  res.json({ ok: true });
});

// Подтверждение получения производством (ЗАГЛУШКА, пока нет модуля производства).
// Списывает сырьё со склада движением reason='production' — так цепочка закуп→склад→
// производство замыкается: остаток уменьшается по факту передачи.
router.post('/api/issue/:id(\\d+)/confirm', express.json(), async (req, res) => {
  const id = parseInt(req.params.id);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const pi = await client.query('SELECT status FROM production_issues WHERE id=$1 FOR UPDATE', [id]);
    if (!pi.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Передача не найдена' }); }
    if (pi.rows[0].status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Передача уже обработана' }); }
    const items = (await client.query('SELECT id, item_kind, item_id, qty FROM production_issue_items WHERE issue_id=$1', [id])).rows;
    for (const it of items) {
      await client.query('UPDATE production_issue_items SET fact_qty=qty WHERE id=$1', [it.id]);
      await client.query(
        `INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, ref_type, ref_id, comment, moved_at, created_by)
         VALUES ($1,$2,$3,'out','production','production_issue',$4,$5,CURRENT_DATE,$6)`,
        [it.item_kind, it.item_id, -Math.abs(Number(it.qty)), id, 'Передано в производство', req.user.id]);
    }
    await client.query("UPDATE production_issues SET status='accepted' WHERE id=$1", [id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
  finally { client.release(); }
  await db.log(req.user.id, 'stock_issue_confirm', '#' + id);
  res.json({ ok: true });
});


// ===== Вкладка: РЕЗЮМЕ / ОСТАТКИ (инвентаризация) =====
router.get('/api/inventory', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const r = await db.pool.query(
    `WITH mats AS (
       SELECT 'raw' AS kind, rm.id, rm.code, rm.name, u.short_name AS unit, rm.characteristics,
              rm.category_id, c.name AS category_name, c.parent_id AS pc_id, pc.name AS pc_name
       FROM ref_raw_materials rm
       LEFT JOIN ref_units u ON u.id = rm.unit_id
       LEFT JOIN ref_categories c ON c.id = rm.category_id
       LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_id
       WHERE rm.status='active'
       UNION ALL
       SELECT 'packaging', pk.id, pk.code, pk.name, u.short_name, NULL,
              pk.category_id, c.name, c.parent_id, pc.name
       FROM ref_packaging pk
       LEFT JOIN ref_units u ON u.id = pk.unit_id
       LEFT JOIN ref_categories c ON c.id = pk.category_id
       LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_id
       WHERE pk.status='active'
     ),
     bal AS (SELECT item_kind, item_id, SUM(qty) AS balance FROM stock_movements GROUP BY item_kind, item_id),
     opening AS (SELECT item_kind, item_id, SUM(qty) AS s FROM stock_movements WHERE reason='opening' GROUP BY item_kind, item_id),
     today_in AS (SELECT item_kind, item_id, SUM(qty) AS s FROM stock_movements WHERE reason='receive' AND moved_at=$1::date GROUP BY item_kind, item_id),
     today_out AS (SELECT item_kind, item_id, SUM(-qty) AS s FROM stock_movements WHERE reason='production' AND moved_at=$1::date GROUP BY item_kind, item_id),
     reserved AS (
       SELECT pii.item_kind, pii.item_id, SUM(pii.qty) AS s
       FROM production_issue_items pii JOIN production_issues pi ON pi.id=pii.issue_id AND pi.status='pending'
       GROUP BY pii.item_kind, pii.item_id
     )
     SELECT m.kind, m.id, m.code, m.name, m.unit, m.characteristics,
            m.category_id, m.category_name, m.pc_id, m.pc_name,
            COALESCE(o.s,0) AS opening_balance,
            COALESCE(b.balance,0) AS balance,
            COALESCE(ti.s,0) AS today_in,
            COALESCE(to2.s,0) AS today_out,
            COALESCE(rv.s,0) AS reserved
     FROM mats m
     LEFT JOIN bal b ON b.item_kind=m.kind AND b.item_id=m.id
     LEFT JOIN opening o ON o.item_kind=m.kind AND o.item_id=m.id
     LEFT JOIN today_in ti ON ti.item_kind=m.kind AND ti.item_id=m.id
     LEFT JOIN today_out to2 ON to2.item_kind=m.kind AND to2.item_id=m.id
     LEFT JOIN reserved rv ON rv.item_kind=m.kind AND rv.item_id=m.id
     ORDER BY m.name`,
    [date]
  );
  // справочники для фильтров
  const parents = await db.pool.query("SELECT id, name FROM ref_parent_categories WHERE status='active' ORDER BY name");
  const cats = await db.pool.query("SELECT id, name, parent_id FROM ref_categories WHERE kind='категория' AND (sd_sd_id IS NULL OR sd_sd_id='') ORDER BY name");
  res.json({ date, items: r.rows, parents: parents.rows, categories: cats.rows });
});


// Задать первоначальный остаток (один раз на позицию) — движение reason='opening'
router.post('/api/inventory/opening', express.json(), async (req, res) => {
  const kind = req.body.item_kind === 'packaging' ? 'packaging' : 'raw';
  const id = parseInt(req.body.item_id);
  const qty = Number(req.body.qty);
  if (!id || isNaN(qty)) return res.status(400).json({ error: 'Укажите позицию и количество' });
  // запрет повторного стартового
  const ex = await db.pool.query("SELECT 1 FROM stock_movements WHERE item_kind=$1 AND item_id=$2 AND reason='opening' LIMIT 1", [kind, id]);
  if (ex.rows.length) return res.status(400).json({ error: 'Первоначальный остаток уже задан. Используйте корректировку.' });
  await db.pool.query(
    `INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, ref_type, comment, moved_at, created_by)
     VALUES ($1,$2,$3,'in','opening','manual',$4,CURRENT_DATE,$5)`,
    [kind, id, qty, req.body.comment || 'Первоначальный остаток', req.user.id]
  );
  await db.log(req.user.id, 'stock_opening', `${kind}#${id} = ${qty}`);
  res.json({ ok: true });
});

// Корректировка остатка (инвентаризация) — вводим фактический, система пишет дельту, след в журнале
router.post('/api/inventory/adjust', express.json(), async (req, res) => {
  const kind = req.body.item_kind === 'packaging' ? 'packaging' : 'raw';
  const id = parseInt(req.body.item_id);
  const factual = Number(req.body.factual); // фактический остаток по пересчёту
  if (!id || isNaN(factual)) return res.status(400).json({ error: 'Укажите позицию и фактический остаток' });
  if (!req.body.comment || !String(req.body.comment).trim()) return res.status(400).json({ error: 'Укажите причину корректировки' });
  const cur = await db.pool.query('SELECT COALESCE(SUM(qty),0) AS b FROM stock_movements WHERE item_kind=$1 AND item_id=$2', [kind, id]);
  const delta = factual - Number(cur.rows[0].b);
  if (delta === 0) return res.json({ ok: true, note: 'Остаток уже совпадает' });
  await db.pool.query(
    `INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, ref_type, comment, moved_at, created_by)
     VALUES ($1,$2,$3,$4,'adjust','manual',$5,CURRENT_DATE,$6)`,
    [kind, id, delta, delta >= 0 ? 'in' : 'out', req.body.comment, req.user.id]
  );
  await db.log(req.user.id, 'stock_adjust', `${kind}#${id}: ${cur.rows[0].b} → ${factual} (Δ${delta})`);
  res.json({ ok: true, delta });
});

// Пакетный пересчёт (инвентаризация одним экраном): фактические остатки списком,
// система пишет дельту по каждой изменившейся позиции одним комментарием.
router.post('/api/inventory/adjust-bulk', express.json(), async (req, res) => {
  const comment = String(req.body.comment || '').trim();
  if (!comment) return res.status(400).json({ error: 'Укажите причину/комментарий пересчёта' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Нет позиций для пересчёта' });
  const client = await db.pool.connect();
  let applied = 0;
  try {
    await client.query('BEGIN');
    for (const it of items) {
      const kind = it.item_kind === 'packaging' ? 'packaging' : 'raw';
      const id = parseInt(it.item_id);
      const factual = Number(it.factual);
      if (!id || isNaN(factual)) continue;
      const cur = await client.query('SELECT COALESCE(SUM(qty),0) AS b FROM stock_movements WHERE item_kind=$1 AND item_id=$2', [kind, id]);
      const delta = factual - Number(cur.rows[0].b);
      if (delta === 0) continue;
      await client.query(
        `INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, ref_type, comment, moved_at, created_by)
         VALUES ($1,$2,$3,$4,'adjust','manual',$5,CURRENT_DATE,$6)`,
        [kind, id, delta, delta >= 0 ? 'in' : 'out', comment, req.user.id]);
      applied++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
  finally { client.release(); }
  await db.log(req.user.id, 'stock_adjust_bulk', `${applied} поз., «${comment}»`);
  res.json({ ok: true, applied });
});

// Лог движений-корректировок по позиции (кто/что/когда)
router.get('/api/inventory/log/:kind/:id(\\d+)', async (req, res) => {
  const kind = req.params.kind === 'packaging' ? 'packaging' : 'raw';
  const r = await db.pool.query(
    `SELECT sm.qty, sm.reason, sm.comment, sm.moved_at, sm.created_at, u.full_name AS user_name
     FROM stock_movements sm
     LEFT JOIN users u ON u.id = sm.created_by
     WHERE sm.item_kind=$1 AND sm.item_id=$2 AND sm.reason IN ('opening','adjust')
     ORDER BY sm.created_at DESC`,
    [kind, req.params.id]
  );
  res.json({ items: r.rows });
});

// ===== Вкладка 3: ИТОГИ ДНЯ =====
router.get('/api/day-summary', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const arrived = await db.pool.query("SELECT COALESCE(SUM(qty),0) AS s FROM stock_movements WHERE reason='receive' AND moved_at = $1::date", [date]);
  const issued = await db.pool.query("SELECT COALESCE(SUM(-qty),0) AS s FROM stock_movements WHERE reason='production' AND moved_at = $1::date", [date]);
  const inTransit = await db.pool.query("SELECT COALESCE(SUM(qty),0) AS s FROM production_issue_items pii JOIN production_issues pi ON pi.id=pii.issue_id AND pi.status='pending'");
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
    inTransit: Number(inTransit.rows[0].s),
    problems: problems.rows, problemsCount: problems.rows.length,
    notArrived: problems.rows.filter((x) => x.receipt_status === 'not_arrived').length,
  });
});

module.exports = router;
