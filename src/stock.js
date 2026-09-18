// stock.js — блок «Склад сырья»: рабочее место кладовщика (приёмка, передача в производство, итоги дня)
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { notify } = require('./notifications');

const router = express.Router();

// Отход-подноменклатура: находим (или создаём один раз) бесплатную парную карточку
// сырья «<товар> отх». Кладовщик её не выбирает — формируется автоматически.
// Возвращает id карточки отхода для заданного основного сырья (rawId).
async function ensureWasteItem(rawId, userId) {
  const found = await db.pool.query('SELECT id FROM ref_raw_materials WHERE waste_of_id = $1 LIMIT 1', [rawId]);
  if (found.rows.length) return found.rows[0].id;
  const p = await db.pool.query('SELECT name, code, unit_id, category_id FROM ref_raw_materials WHERE id = $1', [rawId]);
  if (!p.rows.length) return null;
  const par = p.rows[0];
  const ins = await db.pool.query(
    `INSERT INTO ref_raw_materials (name, code, unit_id, category_id, status, is_waste, waste_of_id, created_by, comment)
     VALUES ($1, $2, $3, $4, 'active', true, $5, $6, 'Отход (бесплатная подноменклатура), создан автоматически')
     RETURNING id`,
    [`${par.name} отх`, par.code ? `${par.code}-ОТХ` : '', par.unit_id || null, par.category_id || null, rawId, userId || null]
  );
  return ins.rows[0].id;
}

// ---------------------------------------------------------------------------
// Списание со склада
// ---------------------------------------------------------------------------
// Раньше испорченное сырьё уходило через «Корректировку»: остаток уменьшался,
// а причина была свободным текстом. Из-за этого деньги нельзя было отнести
// ни к себестоимости, ни к потерям — в P&L так и написано, что корректировки
// в себестоимость не берём, «причина у них разная».
//
// Списание — та же операция, но со СТАТЬЁЙ. Статья решает, куда уйдут деньги:
//   loss     — потери (порча, усушка, зачистка, недостача): наш расход;
//   supplier — брак поставщика: не наш расход, если предъявили ему;
//   internal — внутреннее расходование (дегустации, образцы): не потеря.
// Статьи живут в справочнике `reject_reasons` со scope='writeoff' — там же,
// где причины отклонения приёмки, чтобы не заводить вторую такую таблицу.
const WRITEOFF_SCOPE = 'writeoff';
const WRITEOFF_REASONS = [
  ['Порча / истёк срок', 'loss', 10],
  ['Брак поставщика', 'supplier', 20],
  ['Зачистка / переборка', 'loss', 30],
  ['Усушка / естественная убыль', 'loss', 40],
  ['Внутреннее расходование', 'internal', 50],
  ['Недостача', 'loss', 60],
];

let _woReady = false;
async function ensureWriteoffSchema() {
  if (_woReady) return;
  const q = (s, p) => db.pool.query(s, p);
  await q(`ALTER TABLE reject_reasons ADD COLUMN IF NOT EXISTS pnl_group TEXT`);
  // Документ списания. Суммы в нём НЕ храним: количество берём из позиций,
  // деньги считаются по цене месяца — той же, что в P&L.
  await q(`CREATE TABLE IF NOT EXISTS stock_writeoffs (
    id SERIAL PRIMARY KEY,
    reason_id INT REFERENCES reject_reasons(id),
    comment TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | confirmed
    supplier_claim BOOLEAN DEFAULT FALSE,        -- брак поставщика предъявлен
    moved_at DATE NOT NULL DEFAULT CURRENT_DATE,
    created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_by INT, confirmed_at TIMESTAMPTZ
  )`);
  await q(`CREATE TABLE IF NOT EXISTS stock_writeoff_items (
    id SERIAL PRIMARY KEY,
    writeoff_id INT NOT NULL REFERENCES stock_writeoffs(id) ON DELETE CASCADE,
    item_kind TEXT NOT NULL DEFAULT 'raw',
    item_id INT NOT NULL,
    qty NUMERIC NOT NULL
  )`);
  // Фото обязательно: сфотографировать надо до того, как выбросил.
  // Байты лежат в общей таблице files, отдаются через /file/:id с проверкой прав.
  await q(`CREATE TABLE IF NOT EXISTS stock_writeoff_files (
    id SERIAL PRIMARY KEY,
    writeoff_id INT NOT NULL REFERENCES stock_writeoffs(id) ON DELETE CASCADE,
    file_ref INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_stock_wo_items ON stock_writeoff_items (writeoff_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_stock_wo_date ON stock_writeoffs (moved_at)`);
  // Статьи сидируются идемпотентно: имя — ключ, группа и порядок обновляются.
  for (const [name, group, sort] of WRITEOFF_REASONS) {
    const ex = await q('SELECT id FROM reject_reasons WHERE scope=$1 AND name=$2 LIMIT 1', [WRITEOFF_SCOPE, name]);
    if (ex.rows.length) {
      await q('UPDATE reject_reasons SET pnl_group=$1, sort_order=$2 WHERE id=$3', [group, sort, ex.rows[0].id]);
    } else {
      await q('INSERT INTO reject_reasons (name, scope, sort_order, pnl_group) VALUES ($1,$2,$3,$4)',
        [name, WRITEOFF_SCOPE, sort, group]);
    }
  }
  _woReady = true;
}
router.use(async (req, res, next) => { try { await ensureWriteoffSchema(); } catch (e) { /* не роняем плитку */ } next(); });

// Какая вкладка Склада стоит за адресом — чтобы закрывать её данные на сервере.
// null — общее для всей плитки (справочник причин, доступное сырьё).
function stockTabOf(req) {
  const p = req.path;
  if (p.startsWith('/api/receipt')) return 'receiving';
  if (p.startsWith('/api/issue')) return 'issue';
  if (p.startsWith('/api/writeoff')) return 'writeoff';
  if (p.startsWith('/api/inventory')) return 'inventory';
  if (p.startsWith('/api/day-summary') || p.startsWith('/api/calendar')) return 'summary';
  return null;
}
router.use(require('./tab-access').requireTab(db.pool, '/stock', stockTabOf));

router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  let allowedTabs = null;
  try {
    const a = await require('./tab-access').allowedTabs(db.pool, req.user, '/stock');
    allowedTabs = a === null ? null : Array.from(a);
  } catch (e) { allowedTabs = null; }
  res.render('stock', { settings, user: req.user, allowedTabs });
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

// Сверить замеры приёмки со спецификацией. Меняет c.passed у числовых параметров
// по коридору min/max; качественные (✓/✗) берём как отметил кладовщик. Пустой замер
// не считается провалом (замер не обязателен). Возвращает true, если что-то не прошло.
function applySpecVerdict(checks, specRows) {
  let failed = false;
  for (const c of checks) {
    const sp = specRows.find((r) => String(r.item_id) === String(c.item_id) && r.name === String(c.param_name || ''));
    if (sp && sp.ptype === 'range') {
      const raw = String(c.measured == null ? '' : c.measured).trim();
      if (raw === '') c.passed = true;
      else {
        const v = Number(raw.replace(',', '.'));
        c.passed = isFinite(v)
          && !(sp.min_val != null && v < Number(sp.min_val))
          && !(sp.max_val != null && v > Number(sp.max_val));
      }
    }
    if (c.passed === false) failed = true;
  }
  return failed;
}

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
  // Принять с отклонением может только администратор — как и кнопка в интерфейсе.
  // Флагу из запроса не доверяем: раньше его мог прислать кто угодно (аудит A07).
  const overrideSpec = !!req.body.override_spec && !!req.user.isAdmin;

  // Проверка спеки. Числовые замеры сервер пересчитывает сам по коридору из спецификации,
  // а не верит пометке «в норме» из браузера.
  const checks = Array.isArray(req.body.checks) ? req.body.checks : [];
  const specRows = (await db.pool.query(
    `SELECT i.id AS item_id, p.name, p.ptype, p.min_val, p.max_val
       FROM purchase_order_items i
       JOIN specifications s ON s.item_kind = i.item_kind AND s.item_id = i.item_id
       JOIN specification_params p ON p.spec_id = s.id
      WHERE i.order_id = $1`, [req.params.id])).rows;
  const specFailed = applySpecVerdict(checks, specRows);

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

  // Бесплатный отход: по каждой позиции сырья кладовщик мог указать кол-во отхода.
  // Кладём приход по авто-карточке «<товар> отх» (цена 0). Привязка к этой приёмке
  // (ref_type='purchase_order') — при откате/переприёмке отход удаляется/перезаписывается
  // вместе с основным приходом (DELETE выше это уже сделал).
  const wasteRows = Array.isArray(req.body.waste) ? req.body.waste : [];
  for (const w of wasteRows) {
    const oiId = parseInt(w.order_item_id);
    const wq = Number(w.qty);
    if (!oiId || !(wq > 0)) continue;
    const oi = await db.pool.query(
      "SELECT item_kind, item_id FROM purchase_order_items WHERE id = $1 AND order_id = $2 AND item_kind = 'raw'",
      [oiId, req.params.id]
    );
    if (!oi.rows.length) continue; // отход только для сырья и только по позициям этой заявки
    const wasteId = await ensureWasteItem(oi.rows[0].item_id, req.user.id);
    if (!wasteId) continue;
    await db.pool.query(
      `INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, price, ref_type, ref_id, comment, moved_at, created_by)
       VALUES ('raw', $1, $2, 'in', 'receive_waste', 0, 'purchase_order', $3, 'Бесплатный отход', now()::date, $4)`,
      [wasteId, wq, req.params.id, req.user.id]
    );
  }

  const dev = factSum - planSum;
  const statusText = rstatus === 'received' ? 'принята полностью' : rstatus === 'partial' ? 'принята частично' : 'не приехала';
  await notify({
    role: 'purchaser', tile: '/purchase', userId: o.rows[0].created_by || null,
    title: 'Поставка ' + statusText,
    body: `${o.rows[0].supplier_name}, заявка ${o.rows[0].number}: план ${planSum}, факт ${factSum}${dev !== 0 ? ', отклонение ' + (dev > 0 ? '+' : '') + dev : ''}`,
    kind: rstatus === 'received' ? 'success' : 'warning', link: '/purchase#orders',
  });
  if (planSum > 0 && factSum < planSum * 0.85) {
    await notify({ role: 'manager', tile: '/purchase', title: 'Крупное отклонение поставки',
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
  { const _wb = require('./wipe-guard').wipeBlocked(); if (_wb) return res.status(423).json({ error: _wb }); }
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
  await notify({ role: 'manager', tile: '/stock', title: 'Новая передача в производство', body: `${area}: ${items.length} позиц. — ожидает подтверждения`, kind: 'info', link: '/stock#issue' });
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
  { const _wb = require('./wipe-guard').wipeBlocked(); if (_wb) return res.status(423).json({ error: _wb }); }
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
              rm.category_id, c.name AS category_name, c.parent_id AS pc_id, pc.name AS pc_name, rm.is_waste
       FROM ref_raw_materials rm
       LEFT JOIN ref_units u ON u.id = rm.unit_id
       LEFT JOIN ref_categories c ON c.id = rm.category_id
       LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_id
       WHERE rm.status='active'
       UNION ALL
       SELECT 'packaging', pk.id, pk.code, pk.name, u.short_name, NULL,
              pk.category_id, c.name, c.parent_id, pc.name, false
       FROM ref_packaging pk
       LEFT JOIN ref_units u ON u.id = pk.unit_id
       LEFT JOIN ref_categories c ON c.id = pk.category_id
       LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_id
       WHERE pk.status='active'
     ),
     bal AS (SELECT item_kind, item_id, SUM(qty) AS balance FROM stock_movements WHERE moved_at <= $1::date GROUP BY item_kind, item_id),
     opening AS (SELECT item_kind, item_id, SUM(qty) AS s FROM stock_movements WHERE reason='opening' GROUP BY item_kind, item_id),
     today_in AS (SELECT item_kind, item_id, SUM(qty) AS s FROM stock_movements WHERE reason='receive' AND moved_at=$1::date GROUP BY item_kind, item_id),
     today_out AS (SELECT item_kind, item_id, SUM(-qty) AS s FROM stock_movements WHERE reason='production' AND moved_at=$1::date GROUP BY item_kind, item_id),
     reserved AS (
       SELECT pii.item_kind, pii.item_id, SUM(pii.qty) AS s
       FROM production_issue_items pii JOIN production_issues pi ON pi.id=pii.issue_id AND pi.status='pending'
       GROUP BY pii.item_kind, pii.item_id
     )
     SELECT m.kind, m.id, m.code, m.name, m.unit, m.characteristics,
            m.category_id, m.category_name, m.pc_id, m.pc_name, m.is_waste,
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

// ===== Вкладка: СПИСАНИЕ =====
// Право менять цифру остатка — это вкладка «Резюме / Остатки». У кого она есть,
// тот и заверяет списание. Отдельной галочки не заводим: подтверждать списание
// и править остаток — одна и та же ответственность.
async function canConfirmWriteoff(req) {
  try {
    const ta = require('./tab-access');
    return ta.tabAllowed(await ta.allowedTabs(db.pool, req.user, '/stock'), 'inventory');
  } catch (e) { return !!(req.user && req.user.isAdmin); }
}

// Цены месяца — те же, что в P&L (средняя приходов месяца, иначе последняя известная).
async function priceMapFor(month) {
  try {
    const maps = await require('./cash-pnl').monthlyPriceMaps(db.pool, month, month);
    return maps.get(month) || new Map();
  } catch (e) { return new Map(); }
}
const monthOf = (d) => String(d).slice(0, 7);

router.get('/api/writeoff/reasons', async (req, res) => {
  const r = await db.pool.query(
    'SELECT id, name, pnl_group FROM reject_reasons WHERE scope=$1 AND status=$2 ORDER BY sort_order, name',
    [WRITEOFF_SCOPE, 'active']);
  res.json({ items: r.rows, can_confirm: await canConfirmWriteoff(req) });
});

// Список списаний за период + итоги. Процент считаем от ПРИХОДА за тот же
// период: «сколько из купленного не дошло до производства». Это операционная
// цифра склада; в P&L потери меряются от выручки — там другой вопрос.
router.get('/api/writeoff/list', async (req, res) => {
  try {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : to.slice(0, 8) + '01';
    const docs = (await db.pool.query(
      `SELECT w.*, r.name AS reason_name, r.pnl_group,
              u.full_name AS created_name, c.full_name AS confirmed_name
         FROM stock_writeoffs w
         LEFT JOIN reject_reasons r ON r.id = w.reason_id
         LEFT JOIN users u ON u.id = w.created_by
         LEFT JOIN users c ON c.id = w.confirmed_by
        WHERE w.moved_at BETWEEN $1 AND $2 ORDER BY w.moved_at DESC, w.id DESC`, [from, to])).rows;
    const ids = docs.map((d) => d.id);
    const items = ids.length ? (await db.pool.query(
      `SELECT i.*, COALESCE(rm.name, pk.name) AS name, COALESCE(ur.short_name, up.short_name) AS unit
         FROM stock_writeoff_items i
         LEFT JOIN ref_raw_materials rm ON i.item_kind='raw' AND rm.id = i.item_id
         LEFT JOIN ref_packaging pk ON i.item_kind='packaging' AND pk.id = i.item_id
         LEFT JOIN ref_units ur ON ur.id = rm.unit_id
         LEFT JOIN ref_units up ON up.id = pk.unit_id
        WHERE i.writeoff_id = ANY($1::int[])`, [ids])).rows : [];
    const files = ids.length ? (await db.pool.query(
      'SELECT writeoff_id, file_ref FROM stock_writeoff_files WHERE writeoff_id = ANY($1::int[]) ORDER BY id', [ids])).rows : [];
    // Оценка по цене месяца, в котором списали.
    const priceCache = new Map();
    const priceOf = async (mon, kind, id) => {
      if (!priceCache.has(mon)) priceCache.set(mon, await priceMapFor(mon));
      return priceCache.get(mon).get(kind + '#' + id);
    };
    const byDoc = new Map(docs.map((d) => [d.id, Object.assign(d, { items: [], files: [], qty: 0, amount: 0, no_price: 0 })]));
    for (const it of items) {
      const doc = byDoc.get(it.writeoff_id);
      if (!doc) continue;
      const price = await priceOf(monthOf(doc.moved_at.toISOString ? doc.moved_at.toISOString().slice(0, 10) : doc.moved_at), it.item_kind, it.item_id);
      const qty = Number(it.qty) || 0;
      const amount = price ? qty * Number(price) : 0;
      if (!price) doc.no_price += qty;
      doc.qty += qty; doc.amount += amount;
      doc.items.push({ ...it, qty, price: price ? Number(price) : null, amount });
    }
    for (const f of files) { const d = byDoc.get(f.writeoff_id); if (d) d.files.push(f.file_ref); }
    const list = [...byDoc.values()];
    // Приход за тот же период — знаменатель процента потерь.
    const inc = (await db.pool.query(
      `SELECT COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(qty*price),0) AS amount
         FROM stock_movements WHERE reason='receive' AND moved_at BETWEEN $1 AND $2`, [from, to])).rows[0];
    const byReason = {};
    for (const d of list) {
      const k = d.reason_name || 'Без статьи';
      byReason[k] = byReason[k] || { qty: 0, amount: 0, cnt: 0, group: d.pnl_group || 'loss' };
      byReason[k].qty += d.qty; byReason[k].amount += d.amount; byReason[k].cnt += 1;
    }
    const qty = list.reduce((s, d) => s + d.qty, 0);
    const amount = list.reduce((s, d) => s + d.amount, 0);
    const incQty = Number(inc.qty) || 0, incAmount = Number(inc.amount) || 0;
    res.json({
      from, to, items: list,
      can_confirm: await canConfirmWriteoff(req),
      totals: {
        qty, amount, docs: list.length,
        pending: list.filter((d) => d.status === 'pending').length,
        pending_amount: list.filter((d) => d.status === 'pending').reduce((s, d) => s + d.amount, 0),
        received_qty: incQty, received_amount: incAmount,
        pct_qty: incQty > 0 ? (qty / incQty) * 100 : null,
        pct_amount: incAmount > 0 ? (amount / incAmount) * 100 : null,
        by_reason: byReason,
      },
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Создание списания. Остаток уменьшается СРАЗУ: товар уже выброшен, и склад
// не должен показывать то, чего нет. Подтверждение — вторая подпись на причине
// и сумме, оно товар не воскрешает.
const woUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 6 } });
router.post('/api/writeoff', woUpload.array('photos', 6), async (req, res) => {
  let b = {};
  try { b = JSON.parse(req.body.payload || '{}'); } catch (e) { return res.status(400).json({ error: 'Не разобрал данные формы' }); }
  const reasonId = parseInt(b.reason_id, 10);
  const photos = req.files || [];
  const items = (Array.isArray(b.items) ? b.items : [])
    .map((x) => ({ kind: x.item_kind === 'packaging' ? 'packaging' : 'raw', id: parseInt(x.item_id, 10), qty: Number(x.qty) }))
    .filter((x) => x.id && x.qty > 0);
  if (!reasonId) return res.status(400).json({ error: 'Выберите статью списания' });
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы одну позицию с количеством' });
  // Фото обязательно для всех статей. Исключения не делаем специально: иначе
  // всё начнут списывать по той статье, где фотографировать не надо.
  if (!photos.length) return res.status(400).json({ error: 'Приложите фото — без него списание не проводим' });
  if (photos.some((f) => !String(f.mimetype || '').startsWith('image/'))) {
    return res.status(400).json({ error: 'Прикладывать можно только фотографии' });
  }
  const reason = (await db.pool.query(
    'SELECT id FROM reject_reasons WHERE id=$1 AND scope=$2', [reasonId, WRITEOFF_SCOPE])).rows[0];
  if (!reason) return res.status(400).json({ error: 'Неизвестная статья списания' });
  // Больше, чем лежит, списать нельзя — иначе на складе появится минус,
  // и остаток перестанет быть правдой.
  for (const it of items) {
    const bal = Number((await db.pool.query(
      'SELECT COALESCE(SUM(qty),0) AS b FROM stock_movements WHERE item_kind=$1 AND item_id=$2',
      [it.kind, it.id])).rows[0].b) || 0;
    if (it.qty > bal + 1e-9) {
      const nm = (await db.pool.query(
        it.kind === 'raw' ? 'SELECT name FROM ref_raw_materials WHERE id=$1' : 'SELECT name FROM ref_packaging WHERE id=$1',
        [it.id])).rows[0];
      return res.status(400).json({ error: `«${(nm && nm.name) || it.id}»: на складе ${bal}, списать больше нельзя` });
    }
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const doc = (await client.query(
      `INSERT INTO stock_writeoffs (reason_id, comment, supplier_claim, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id, moved_at`,
      [reasonId, String(b.comment || '').trim().slice(0, 500), !!b.supplier_claim, req.user.id])).rows[0];
    for (const it of items) {
      await client.query(
        'INSERT INTO stock_writeoff_items (writeoff_id, item_kind, item_id, qty) VALUES ($1,$2,$3,$4)',
        [doc.id, it.kind, it.id, it.qty]);
      await client.query(
        `INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, ref_type, ref_id, comment, moved_at, created_by)
         VALUES ($1,$2,$3,'out','writeoff','stock_writeoff',$4,$5,CURRENT_DATE,$6)`,
        [it.kind, it.id, -it.qty, doc.id, String(b.comment || '').slice(0, 200), req.user.id]);
    }
    for (const f of photos) {
      const ins = await client.query(
        'INSERT INTO files (name, mime, data) VALUES ($1,$2,$3) RETURNING id',
        [f.originalname || 'photo.jpg', f.mimetype, f.buffer]);
      await client.query('INSERT INTO stock_writeoff_files (writeoff_id, file_ref) VALUES ($1,$2)', [doc.id, ins.rows[0].id]);
    }
    await client.query('COMMIT');
    await db.log(req.user.id, 'stock_writeoff', `#${doc.id}: ${items.length} поз.`);
    // Тот, кто заверяет остаток, должен узнать сразу — иначе списание повиснет.
    await notify({
      tile: '/stock', kind: 'warning', link: '/stock#writeoff',
      title: 'Списание ждёт подтверждения',
      body: `${items.length} поз. · внёс ${req.user.name || '—'}`,
    });
    res.json({ ok: true, id: doc.id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

router.post('/api/writeoff/:id(\\d+)/confirm', express.json(), async (req, res) => {
  if (!(await canConfirmWriteoff(req))) {
    return res.status(403).json({ error: 'Подтверждать списания может тот, кто отвечает за остатки склада' });
  }
  const r = await db.pool.query(
    `UPDATE stock_writeoffs SET status='confirmed', confirmed_by=$1, confirmed_at=now()
      WHERE id=$2 AND status='pending'`, [req.user.id, req.params.id]);
  if (!r.rowCount) return res.status(409).json({ error: 'Списание уже подтверждено или не найдено' });
  await db.log(req.user.id, 'stock_writeoff_confirm', '#' + req.params.id);
  res.json({ ok: true });
});

// Отмена до подтверждения — возвращает товар на склад. После подтверждения
// отменять нельзя: подпись уже стоит, и цифра ушла в отчёты.
router.post('/api/writeoff/:id(\\d+)/cancel', express.json(), async (req, res) => {
  const doc = (await db.pool.query('SELECT status, created_by FROM stock_writeoffs WHERE id=$1', [req.params.id])).rows[0];
  if (!doc) return res.status(404).json({ error: 'Списание не найдено' });
  if (doc.status !== 'pending') return res.status(409).json({ error: 'Подтверждённое списание отменить нельзя — обратитесь к администратору' });
  const mine = String(doc.created_by) === String(req.user.id);
  if (!mine && !(await canConfirmWriteoff(req))) {
    return res.status(403).json({ error: 'Отменить может тот, кто внёс, или тот, кто подтверждает' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM stock_movements WHERE ref_type='stock_writeoff' AND ref_id=$1", [req.params.id]);
    await client.query('DELETE FROM stock_writeoffs WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
  await db.log(req.user.id, 'stock_writeoff_cancel', '#' + req.params.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.applySpecVerdict = applySpecVerdict;
