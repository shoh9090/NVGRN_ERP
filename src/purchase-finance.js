// purchase-finance.js — ЕДИНЫЙ источник расчёта задолженности поставщикам.
// Используется и в «Закуп» (взаиморасчёты, список заявок), и в «Касса → Обязательства»
// (read-only зеркало + агрегаты сводки). Бизнес-логику НЕ дублировать по модулям.
const db = require('./db');

const DAY_MS = 86400000;
const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / DAY_MS);

// Старт учёта долгов/оплат. Всё ДО этой даты в системе не считаем — оно уже зашито в «начальный
// остаток» поставщика (opening_balance). Так начальные остатки имеют смысл, а не задваиваются со
// старыми документами. Дата запуска учёта — 17.07.2026.
const SETTLE_START = '2026-07-17';

// Перечисления поставщикам из банковской выписки (Касса) — авто-оплаты во Взаиморасчётах (Часть 2).
// Берём расходы (out) с банковских кошельков, у которых ИНН плательщика = ИНН поставщика из Закупа.
// Дедуп: если та же оплата уже внесена вручную в Закуп (тот же поставщик, сумма, дата ±5 дней) —
// НЕ считаем повторно (оплата вносится один раз, но видна и в Кассе, и во Взаиморасчётах).
// Наличную кассу (kind='cash') и переводы между счетами сюда НЕ берём.
async function wireSupplierPayments() {
  const txs = (await db.pool.query(
    `SELECT t.id, c.id AS supplier_id, to_char(t.tx_date,'YYYY-MM-DD') AS paid_at, t.amount, t.purpose
       FROM cash_transactions t
       JOIN cash_wallets w ON w.id = t.wallet_id AND w.kind = 'bank'
       JOIN ref_counterparties c ON c.role_supplier = TRUE AND c.status = 'active'
            AND NULLIF(TRIM(c.inn),'') = NULLIF(TRIM(t.payer_inn),'')
      WHERE t.tx_type = 'out' AND t.source <> 'opening' AND COALESCE(TRIM(t.payer_inn),'') <> ''
        AND t.tx_date >= '${SETTLE_START}'
      ORDER BY t.tx_date, t.id`)).rows
    .map((r) => ({ id: r.id, supplier_id: r.supplier_id, paid_at: r.paid_at, amount: Number(r.amount) || 0, purpose: r.purpose || '' }));
  if (!txs.length) return [];
  const manual = (await db.pool.query("SELECT supplier_id, to_char(paid_at,'YYYY-MM-DD') AS paid_at, amount FROM supplier_payments")).rows
    .map((r) => ({ supplier_id: r.supplier_id, paid_at: r.paid_at, amount: Number(r.amount) || 0, used: false }));
  const manBySup = {};
  for (const m of manual) (manBySup[m.supplier_id] = manBySup[m.supplier_id] || []).push(m);
  const out = [];
  for (const t of txs) {
    const cands = manBySup[t.supplier_id] || [];
    const hit = cands.find((m) => !m.used && Math.abs(m.amount - t.amount) < 0.5 && Math.abs(daysBetween(m.paid_at, t.paid_at)) <= 5);
    if (hit) { hit.used = true; continue; } // уже внесено вручную — не задваиваем
    out.push(t);
  }
  return out;
}

// Расчёт срока и статуса оплаты по заявке (ТЗ Закупа разд. 7-8). Долг возникает по факту приёмки.
function enrichOrderFinance(o) {
  const received = o.status === 'received';
  const factTotal = Number(o.fact_total) || 0;
  const total = Number(o.total) || 0;
  const paid = Number(o.paid) || 0;
  // Долг = стоимость фактически принятого: КОЛИЧЕСТВО из приёмки зав. склада × ЦЕНА из заявки.
  // Цена факта (fact_price) не используется — зав. склад цену не задаёт. Пустой факт у принятой = 0, не план.
  // Запросы отдают o.total уже по этому правилу (для принятых — факт×цена_заявки, иначе план×цена).
  const base = received ? total : 0;
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
       SELECT po.supplier_id, SUM(COALESCE(i.fact_qty, 0) * i.price) AS delivered
       FROM purchase_orders po JOIN purchase_order_items i ON i.order_id = po.id
       WHERE po.status = 'received' AND COALESCE(po.received_at::date, po.delivery_date) >= '${SETTLE_START}' GROUP BY po.supplier_id
     ) d ON d.supplier_id = c.id
     LEFT JOIN (
       SELECT supplier_id, SUM(amount) AS paid FROM supplier_payments WHERE paid_at >= '${SETTLE_START}' GROUP BY supplier_id
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

  const from = opts.from || null, to = opts.to || null;

  // Часть 2: перечисления из выписки (Касса) по ИНН добавляем в «оплачено» (дедуп внутри хелпера).
  const wire = await wireSupplierPayments();
  const wAll = {}, wBefore = {}, wPeriod = {};
  for (const t of wire) {
    wAll[t.supplier_id] = (wAll[t.supplier_id] || 0) + t.amount;
    if (from && t.paid_at < from) wBefore[t.supplier_id] = (wBefore[t.supplier_id] || 0) + t.amount;
    if ((!from || t.paid_at >= from) && (!to || t.paid_at <= to)) wPeriod[t.supplier_id] = (wPeriod[t.supplier_id] || 0) + t.amount;
  }
  for (const s of rows) {
    const w = wAll[s.id] || 0;
    s.paid += w; s.balance -= w;
  }

  // Период (SD-стиль): баланс на начало / оборот / баланс на конец.
  if (from || to) {
    const dAgg = (await db.pool.query(
      `WITH ord AS (
         SELECT po.supplier_id, COALESCE(po.received_at::date, po.delivery_date) d,
                SUM(COALESCE(i.fact_qty, 0) * i.price) val
         FROM purchase_orders po JOIN purchase_order_items i ON i.order_id = po.id
         WHERE po.status = 'received' AND COALESCE(po.received_at::date, po.delivery_date) >= '${SETTLE_START}' GROUP BY po.id)
       SELECT supplier_id,
         COALESCE(SUM(val) FILTER (WHERE $1::date IS NULL OR d < $1),0) AS before_v,
         COALESCE(SUM(val) FILTER (WHERE ($1::date IS NULL OR d >= $1) AND ($2::date IS NULL OR d <= $2)),0) AS period_v
       FROM ord GROUP BY supplier_id`, [from, to])).rows;
    const pAgg = (await db.pool.query(
      `SELECT supplier_id,
         COALESCE(SUM(amount) FILTER (WHERE $1::date IS NULL OR paid_at < $1),0) AS before_v,
         COALESCE(SUM(amount) FILTER (WHERE ($1::date IS NULL OR paid_at >= $1) AND ($2::date IS NULL OR paid_at <= $2)),0) AS period_v
       FROM supplier_payments WHERE paid_at >= '${SETTLE_START}' GROUP BY supplier_id`, [from, to])).rows;
    const dm = {}; dAgg.forEach((x) => { dm[x.supplier_id] = x; });
    const pm = {}; pAgg.forEach((x) => { pm[x.supplier_id] = x; });
    for (const s of rows) {
      const db4 = Number(dm[s.id]?.before_v) || 0, dp = Number(dm[s.id]?.period_v) || 0;
      const pb = Number(pm[s.id]?.before_v) || 0, pp = Number(pm[s.id]?.period_v) || 0;
      s.balance_start = s.opening_balance + db4 - pb - (wBefore[s.id] || 0);
      s.delivered_period = dp;
      s.paid_period = pp + (wPeriod[s.id] || 0);
      s.balance_end = s.balance_start + dp - s.paid_period;
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
            COALESCE(SUM(COALESCE(i.fact_qty, 0) * i.price), 0) AS total,
            COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.order_id = po.id), 0) AS paid
     FROM purchase_orders po
     JOIN ref_counterparties c ON c.id = po.supplier_id
     LEFT JOIN purchase_order_items i ON i.order_id = po.id
     WHERE po.status = 'received' AND COALESCE(po.received_at::date, po.delivery_date) >= '${SETTLE_START}'
     GROUP BY po.id, c.name`);
  return r.rows.map(enrichOrderFinance).filter((o) => o.remainder > 0.01);
}

// Взаиморасчёты «под ключ» (общее для Закупа и зеркала в Кассе): баланс+период+просрочка+фильтр статуса.
async function settlements(opts = {}) {
  const balances = await supplierBalances({ q: opts.q, parent_category_id: opts.parent_category_id, from: opts.from || null, to: opts.to || null });
  const due = await supplierDueAgg();
  // Просрочка считается по заявкам (per-order), а перечисления из выписки гасят ОБЩИЙ долг,
  // не привязываясь к заявке. Чтобы не было противоречия «оплачено, но просрочено» — ограничиваем
  // просрочку текущим общим сальдо поставщика (не больше того, что реально осталось должны).
  let items = balances.map((s) => {
    const overdueRaw = due[s.id] ? due[s.id].overdue : 0;
    return { ...s, overdue: Math.max(0, Math.min(overdueRaw, s.balance)), nearest_due: due[s.id] ? due[s.id].nearest_due : null };
  });
  if (opts.status === 'debt') items = items.filter((s) => s.balance > 0.01);
  else if (opts.status === 'overdue') items = items.filter((s) => s.overdue > 0.01);
  else if (opts.status === 'advance') items = items.filter((s) => s.balance < -0.01);
  return { items, period: !!(opts.from || opts.to), from: opts.from || null, to: opts.to || null };
}

// Подотчёт снабженца: наличные, выданные ему под отчёт из Наличной кассы (расход с галочкой
// is_supply_advance), минус его наличные оплаты поставщикам (в Закупе, тип «наличка»).
// Остаток = сколько денег у снабженца на руках, ещё не отчитано закупками. Снабженец один.
async function supplyAdvance() {
  const issuedR = await db.pool.query(
    `SELECT COALESCE(SUM(t.amount),0) AS issued,
            COALESCE(SUM(t.fx_amount) FILTER (WHERE t.currency='USD'),0) AS issued_usd
       FROM cash_transactions t JOIN cash_wallets w ON w.id = t.wallet_id
      WHERE t.tx_type='out' AND t.is_supply_advance=true AND w.kind='cash' AND t.source<>'opening' AND t.tx_date >= '${SETTLE_START}'`);
  const spentR = await db.pool.query(
    `SELECT COALESCE(SUM(amount),0) AS spent,
            COALESCE(SUM(fx_amount) FILTER (WHERE currency='USD'),0) AS spent_usd
       FROM supplier_payments WHERE payment_type='наличка' AND paid_at >= '${SETTLE_START}'`);
  const issued = Number(issuedR.rows[0].issued) || 0;
  const spent = Number(spentR.rows[0].spent) || 0;
  const issued_usd = Number(issuedR.rows[0].issued_usd) || 0;
  const spent_usd = Number(spentR.rows[0].spent_usd) || 0;
  return { issued, spent, balance: issued - spent, issued_usd, spent_usd };
}

module.exports = { enrichOrderFinance, supplierBalances, openSupplierObligations, supplierDueAgg, settlements, supplyAdvance, wireSupplierPayments };
