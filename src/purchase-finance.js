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
  return r.rows.map((x) => ({
    id: x.id, name: x.name, legal_name: x.legal_name, inn: x.inn,
    parent_category_name: x.parent_category_name, parent_category_color: x.parent_category_color,
    opening_balance: Number(x.opening_balance) || 0,
    delivered: Number(x.delivered) || 0,
    paid: Number(x.paid) || 0,
    balance: Number(x.balance) || 0,
  }));
}

// Открытые обязательства перед поставщиками по заявкам (принятые, с остатком) — для сводки/календаря.
// Долг = фактически принято − оплачено; срок/просрочка — из условий оплаты (enrichOrderFinance).
async function openSupplierObligations() {
  const r = await db.pool.query(
    `SELECT po.id, po.number, po.status, po.pay_condition, po.defer_days,
            po.delivery_date, po.received_at, c.name AS supplier_name,
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

module.exports = { enrichOrderFinance, supplierBalances, openSupplierObligations };
