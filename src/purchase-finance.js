// purchase-finance.js — ЕДИНЫЙ источник расчёта задолженности поставщикам.
// Используется и в «Закуп» (взаиморасчёты, список заявок), и в «Касса → Обязательства»
// (read-only зеркало + агрегаты сводки). Бизнес-логику НЕ дублировать по модулям.
const db = require('./db');

// Расчёт срока и статуса оплаты по заявке (ТЗ Закупа разд. 7-8). Долг возникает по факту приёмки.
function enrichOrderFinance(o) {
  const received = o.status === 'received';
  const factTotal = Number(o.fact_total) || 0;
  const paid = Number(o.paid) || 0;
  const base = received ? factTotal : 0;          // долг по заявке = фактически принято
  const remainder = base - paid;
  const cond = o.pay_condition || 'on_fact';
  // received_at приходит из pg как Date, delivery_date — как строка 'YYYY-MM-DD'.
  const dOf = (d) => { if (!d) return null; const x = new Date(d); return isNaN(x.getTime()) ? null : x; };
  const today = new Date(new Date().toISOString().slice(0, 10));
  let dueDate = null;
  if (cond === 'prepay') dueDate = dOf(o.delivery_date);
  else if (received && o.received_at) {
    dueDate = dOf(o.received_at);
    if (cond === 'defer') dueDate.setDate(dueDate.getDate() + (parseInt(o.defer_days, 10) || 0));
  }
  const overdue = dueDate && remainder > 0.01 && dueDate < today;
  let payStatus;
  if (!received) payStatus = (cond === 'prepay' && paid <= 0.01) ? 'Ожидает предоплаты' : 'Ожидает поставки';
  else if (paid > base + 0.01) payStatus = 'Переплата / аванс';
  else if (remainder <= 0.01) payStatus = 'Оплачено';
  else if (overdue) payStatus = 'Просрочено';
  else if (paid > 0.01) payStatus = 'Частично оплачено';
  else payStatus = 'Не оплачено';
  return {
    ...o,
    total: Number(o.total) || 0, fact_total: factTotal, paid,
    remainder: received ? remainder : 0,
    due_date: dueDate ? dueDate.toISOString().slice(0, 10) : null,
    pay_status: payStatus, overdue: !!overdue,
  };
}

// Сальдо по поставщикам (тот же расчёт, что Закуп → Взаиморасчёты): стартовый долг + принято − оплачено.
// Если заданы opts.from/opts.to — дополнительно считаем период (SD-стиль):
// баланс на начало = стартовый + принято ДО начала − оплачено ДО начала;
// оборот за период (поставлено/оплачено); баланс на конец = начало + поставлено − оплачено.
async function supplierBalances(opts = {}) {
  const params = [];
  let qSQL = '';
  if (opts.q) { params.push('%' + String(opts.q).trim() + '%'); qSQL = ` AND (c.name ILIKE $${params.length} OR c.legal_name ILIKE $${params.length} OR c.inn ILIKE $${params.length})`; }
  let pcSQL = '';
  if (opts.parent_category_id) { params.push(parseInt(opts.parent_category_id, 10)); pcSQL = ` AND c.parent_category_id = $${params.length}`; }
  const r = await db.pool.query(
    `SELECT c.id, c.name, c.legal_name, c.inn,
            c.parent_category_id, pc.name AS parent_category_name, pc.color AS parent_category_color,
            COALESCE(c.opening_balance, 0) AS opening_balance,
            COALESCE(d.delivered, 0) AS delivered,
            COALESCE(p.paid, 0) AS paid,
            COALESCE(c.opening_balance, 0) + COALESCE(d.delivered, 0) - COALESCE(p.paid, 0) AS balance
     FROM ref_counterparties c
     LEFT JOIN ref_parent_categories pc ON pc.id = c.parent_category_id
     LEFT JOIN (
       SELECT po.supplier_id, SUM(COALESCE(i.fact_qty, i.qty) * COALESCE(i.fact_price, i.price)) AS delivered
       FROM purchase_orders po JOIN purchase_order_items i ON i.order_id = po.id
       WHERE po.status = 'received' GROUP BY po.supplier_id
     ) d ON d.supplier_id = c.id
     LEFT JOIN (
       SELECT supplier_id, SUM(amount) AS paid FROM supplier_payments GROUP BY supplier_id
     ) p ON p.supplier_id = c.id
     WHERE c.role_supplier = TRUE AND c.status = 'active'${qSQL}${pcSQL}
     ORDER BY c.name`, params);
  const rows = r.rows.map((x) => ({
    id: x.id, name: x.name, legal_name: x.legal_name, inn: x.inn,
    parent_category_name: x.parent_category_name, parent_category_color: x.parent_category_color,
    opening_balance: Number(x.opening_balance) || 0,
    delivered: Number(x.delivered) || 0,
    paid: Number(x.paid) || 0,
    balance: Number(x.balance) || 0,
  }));

  // Период (SD-стиль): баланс на начало / оборот / баланс на конец.
  const from = opts.from || null, to = opts.to || null;
  if (from || to) {
    const dAgg = (await db.pool.query(
      `WITH ord AS (
         SELECT po.supplier_id, COALESCE(po.received_at::date, po.delivery_date) d,
                SUM(COALESCE(i.fact_qty, i.qty) * COALESCE(i.fact_price, i.price)) val
         FROM purchase_orders po JOIN purchase_order_items i ON i.order_id = po.id
         WHERE po.status = 'received' GROUP BY po.id)
       SELECT supplier_id,
         COALESCE(SUM(val) FILTER (WHERE $1::date IS NULL OR d < $1),0) AS before_v,
         COALESCE(SUM(val) FILTER (WHERE ($1::date IS NULL OR d >= $1) AND ($2::date IS NULL OR d <= $2)),0) AS period_v
       FROM ord GROUP BY supplier_id`, [from, to])).rows;
    const pAgg = (await db.pool.query(
      `SELECT supplier_id,
         COALESCE(SUM(amount) FILTER (WHERE $1::date IS NULL OR paid_at < $1),0) AS before_v,
         COALESCE(SUM(amount) FILTER (WHERE ($1::date IS NULL OR paid_at >= $1) AND ($2::date IS NULL OR paid_at <= $2)),0) AS period_v
       FROM supplier_payments GROUP BY supplier_id`, [from, to])).rows;
    const dm = {}; dAgg.forEach((x) => { dm[x.supplier_id] = x; });
    const pm = {}; pAgg.forEach((x) => { pm[x.supplier_id] = x; });
    for (const s of rows) {
      const db4 = Number(dm[s.id]?.before_v) || 0, dp = Number(dm[s.id]?.period_v) || 0;
      const pb = Number(pm[s.id]?.before_v) || 0, pp = Number(pm[s.id]?.period_v) || 0;
      s.balance_start = s.opening_balance + db4 - pb;
      s.delivered_period = dp;
      s.paid_period = pp;
      s.balance_end = s.balance_start + dp - pp;
    }
  }
  return rows;
}

// Просрочка и ближайший срок по каждому поставщику (из принятых заявок с остатком).
async function supplierDueAgg() {
  const orders = await openSupplierObligations();
  const map = {};
  for (const o of orders) {
    const id = o.supplier_id;
    if (!map[id]) map[id] = { overdue: 0, nearest_due: null };
    if (o.overdue) map[id].overdue += o.remainder;
    if (o.due_date && (!map[id].nearest_due || o.due_date < map[id].nearest_due)) map[id].nearest_due = o.due_date;
  }
  return map;
}

// Открытые обязательства перед поставщиками по заявкам (принятые, с остатком) — для сводки/календаря.
// Долг = фактически принято − оплачено; срок/просрочка — из условий оплаты (enrichOrderFinance).
async function openSupplierObligations() {
  const r = await db.pool.query(
    `SELECT po.id, po.number, po.status, po.pay_condition, po.defer_days,
            po.delivery_date, po.received_at, po.supplier_id, c.name AS supplier_name,
            COALESCE(SUM(COALESCE(i.fact_qty, i.qty) * COALESCE(i.fact_price, i.price)), 0) AS total,
            COALESCE(SUM(i.fact_qty * i.fact_price), 0) AS fact_total,
            COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.order_id = po.id), 0) AS paid
     FROM purchase_orders po
     JOIN ref_counterparties c ON c.id = po.supplier_id
     LEFT JOIN purchase_order_items i ON i.order_id = po.id
     WHERE po.status = 'received'
     GROUP BY po.id, c.name`);
  return r.rows.map(enrichOrderFinance).filter((o) => o.remainder > 0.01);
}

module.exports = { enrichOrderFinance, supplierBalances, openSupplierObligations, supplierDueAgg };
