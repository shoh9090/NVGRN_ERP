// calculation-sources.js — ЧТЕНИЕ источников данных для калькуляции (ТЗ раздел 8, 19.3).
//
// Правила модуля:
//  • только чтение. Ничего не пишет, не меняет остатки склада и денег;
//  • формулы себестоимости здесь НЕ живут — они в calculation-engine.js;
//  • одна и та же логика цены используется Закупом и Калькуляцией (ТЗ 8.3),
//    поэтому SQL «последней принятой цены» существует ровно в одном месте — здесь.

// Базовый SQL истории принятых цен (ТЗ 8.3):
//  • только завершённые приёмки (purchase_orders.status = 'received');
//  • цена = fact_price, если она положительная, иначе согласованная price;
//  • дата цены = дата приёмки (received_at), при её отсутствии — дата поставки.
const ACCEPTED_HISTORY_SQL = `
  SELECT i.item_kind, i.item_id,
         COALESCE(NULLIF(i.fact_price, 0), i.price) AS price,
         COALESCE(i.fact_qty, i.qty) AS qty,
         COALESCE(po.received_at::date, po.delivery_date) AS price_date,
         po.id AS order_id, po.number AS order_number, po.supplier_id
  FROM purchase_order_items i
  JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
  WHERE COALESCE(NULLIF(i.fact_price, 0), i.price) > 0
`;

// --- Последняя принятая цена одной позиции на дату (ТЗ 8.3) ----------------
// Возвращает null, если цены нет: подставлять ноль запрещено.
async function lastAcceptedPrice(pool, itemKind, itemId, onDate = null) {
  const params = [itemKind, itemId];
  let dateFilter = '';
  if (onDate) { params.push(onDate); dateFilter = ` AND h.price_date <= $${params.length}`; }
  const r = await pool.query(
    `WITH h AS (${ACCEPTED_HISTORY_SQL})
     SELECT h.price, h.price_date::text AS price_date, h.order_id, h.order_number,
            c.name AS supplier_name
     FROM h LEFT JOIN ref_counterparties c ON c.id = h.supplier_id
     WHERE h.item_kind = $1 AND h.item_id = $2${dateFilter}
     ORDER BY h.price_date DESC, h.order_id DESC
     LIMIT 1`, params);
  if (!r.rows.length) {
    // Резервный источник — импортированная история, только если живых приёмок нет (ТЗ 8.3 п.5).
    const imp = await pool.query(
      `SELECT price, price_date::text AS price_date FROM price_history_import
       WHERE item_kind = $1 AND item_id = $2${onDate ? ' AND price_date <= $3' : ''}
       ORDER BY price_date DESC LIMIT 1`, params).catch(() => ({ rows: [] }));
    if (!imp.rows.length) return null;
    return { ...imp.rows[0], price: Number(imp.rows[0].price), source: 'import', supplier_name: 'архив (импорт)', order_id: null, order_number: null };
  }
  const row = r.rows[0];
  return { ...row, price: Number(row.price), source: 'purchase' };
}

// Пакетное чтение цен для набора компонентов (чтобы не делать запрос на строку).
// items: [{ item_kind, item_id }]. Возвращает Map 'kind:id' → цена/источник|null.
async function lastAcceptedPricesMap(pool, items, onDate = null) {
  const map = new Map();
  const list = (items || []).filter((x) => x && x.item_id);
  if (!list.length) return map;
  const kinds = list.map((x) => (x.item_kind === 'packaging' ? 'packaging' : 'raw'));
  const ids = list.map((x) => Number(x.item_id));
  const params = [kinds, ids];
  let dateFilter = '';
  if (onDate) { params.push(onDate); dateFilter = ` AND h.price_date <= $${params.length}`; }
  const r = await pool.query(
    `WITH h AS (${ACCEPTED_HISTORY_SQL}),
     want AS (SELECT * FROM unnest($1::text[], $2::int[]) AS w(kind, id))
     SELECT DISTINCT ON (h.item_kind, h.item_id)
            h.item_kind, h.item_id, h.price, h.price_date::text AS price_date,
            h.order_id, h.order_number, c.name AS supplier_name
     FROM h
     JOIN want w ON w.kind = h.item_kind AND w.id = h.item_id
     LEFT JOIN ref_counterparties c ON c.id = h.supplier_id
     WHERE TRUE${dateFilter}
     ORDER BY h.item_kind, h.item_id, h.price_date DESC, h.order_id DESC`, params);
  for (const row of r.rows) {
    map.set(row.item_kind + ':' + row.item_id, { ...row, price: Number(row.price), source: 'purchase' });
  }
  // Резервный источник для тех, у кого живых приёмок нет.
  const missing = list.filter((x) => !map.has((x.item_kind === 'packaging' ? 'packaging' : 'raw') + ':' + Number(x.item_id)));
  if (missing.length) {
    const mk = missing.map((x) => (x.item_kind === 'packaging' ? 'packaging' : 'raw'));
    const mi = missing.map((x) => Number(x.item_id));
    const p2 = [mk, mi];
    let df2 = '';
    if (onDate) { p2.push(onDate); df2 = ` AND p.price_date <= $${p2.length}`; }
    const imp = await pool.query(
      `WITH want AS (SELECT * FROM unnest($1::text[], $2::int[]) AS w(kind, id))
       SELECT DISTINCT ON (p.item_kind, p.item_id) p.item_kind, p.item_id, p.price, p.price_date::text AS price_date
       FROM price_history_import p JOIN want w ON w.kind = p.item_kind AND w.id = p.item_id
       WHERE TRUE${df2}
       ORDER BY p.item_kind, p.item_id, p.price_date DESC`, p2).catch(() => ({ rows: [] }));
    for (const row of imp.rows) {
      map.set(row.item_kind + ':' + row.item_id, {
        ...row, price: Number(row.price), source: 'import',
        supplier_name: 'архив (импорт)', order_id: null, order_number: null,
      });
    }
  }
  return map;
}

// --- Средневзвешенная принятая цена за месяц (ТЗ 8.4) ---------------------
// period — 'YYYY-MM'. Если в месяце закупок не было, берётся последняя принятая
// цена до конца месяца с пометкой carried_from_previous.
async function weightedAvgPriceForPeriod(pool, itemKind, itemId, period) {
  const from = period + '-01';
  const r = await pool.query(
    `WITH h AS (${ACCEPTED_HISTORY_SQL})
     SELECT SUM(h.qty * h.price) AS amount, SUM(h.qty) AS qty, COUNT(*)::int AS deliveries
     FROM h
     WHERE h.item_kind = $1 AND h.item_id = $2
       AND h.qty > 0 AND h.price > 0
       AND h.price_date >= $3::date AND h.price_date < ($3::date + INTERVAL '1 month')`,
    [itemKind, itemId, from]);
  const row = r.rows[0] || {};
  const qty = Number(row.qty) || 0;
  if (qty > 0) {
    return {
      price: Number(row.amount) / qty, qty, deliveries: row.deliveries,
      carried_from_previous: false, source: 'purchase_month',
    };
  }
  // Замены нет — берём последнюю принятую цену до конца месяца.
  const endOfMonth = new Date(new Date(from).getFullYear(), new Date(from).getMonth() + 1, 0)
    .toISOString().slice(0, 10);
  const last = await lastAcceptedPrice(pool, itemKind, itemId, endOfMonth);
  if (!last) return { price: null, qty: 0, deliveries: 0, carried_from_previous: false, source: null };
  return {
    price: last.price, qty: 0, deliveries: 0,
    carried_from_previous: true, source: last.source, price_date: last.price_date,
  };
}

// --- ФОТ и налоги месяца (ТЗ 8.5) -----------------------------------------
// «Начислено» считается ровно теми же полями, что и в Персонале: список берём
// из hr.js, чтобы цифра калькуляции не разошлась с цифрой на странице Кадров.
const { ACCR_FIELDS } = require('./hr-fields');

async function monthlyFot(pool, period) {
  const accrSum = ACCR_FIELDS.map((f) => `COALESCE(SUM(${f}),0)`).join(' + ');
  const pr = await pool.query(
    `SELECT (${accrSum}) AS accrued, COUNT(*)::int AS rows_count
     FROM hr_payroll WHERE period = $1 AND status <> 'cancelled'`, [period]);
  const tx = await pool.query(
    `SELECT COALESCE(inps,0) AS inps, COALESCE(ndfl,0) AS ndfl, COALESCE(social,0) AS social
     FROM hr_fot_taxes WHERE period = $1`, [period]);
  const accrued = Number((pr.rows[0] || {}).accrued) || 0;
  const t = tx.rows[0] || {};
  const inps = Number(t.inps) || 0, ndfl = Number(t.ndfl) || 0, social = Number(t.social) || 0;
  const warnings = [];
  if (!(accrued > 0)) warnings.push({ code: 'FOT_EMPTY', message: `В Персонале нет начислений за ${period}.` });
  if (!tx.rows.length) warnings.push({ code: 'FOT_TAXES_EMPTY', message: `Налоги ФОТ за ${period} не заполнены (Персонал → Налоги на ФОТ).` });
  return {
    period, accrued, inps, ndfl, social,
    total_load: accrued + inps + ndfl + social,
    payroll_rows: Number((pr.rows[0] || {}).rows_count) || 0,
    has_taxes: tx.rows.length > 0,
    warnings,
  };
}

// --- Расходы Кассы по блокам (ТЗ 8.6) -------------------------------------
// Блоки определяются по НОМЕРУ группы существующей статьи Кассы, а не по тексту платежа.
// 1 Сырьё — исключаем (уже в рецептуре), 7 Капекс — не в себестоимости версии 1.
const BUCKET_BY_GROUP = {
  1: { bucket: null, reason: 'сырьё и упаковка уже учтены через рецептуру' },
  2: { bucket: 'production', reason: null },
  3: { bucket: 'commercial', reason: null },
  4: { bucket: 'admin', reason: null },
  5: { bucket: 'logistics', reason: null },
  6: { bucket: 'finance', reason: null },
  7: { bucket: null, reason: 'капитальные вложения не входят в себестоимость единицы' },
  8: { bucket: 'admin', reason: null },
};
// Статьи, которые нельзя брать второй раз: ФОТ и налоги ФОТ приходят из Персонала.
const FOT_CODES = new Set(['20', '40']);

async function cashExpensesByBucket(pool, period) {
  const from = period + '-01';
  const r = await pool.query(
    `SELECT c.id AS category_id, c.code, c.name, c.group_name, c.flow_type,
            COALESCE(SUM(t.amount), 0) AS amount, COUNT(t.id)::int AS tx_count
     FROM cash_transactions t
     LEFT JOIN cash_categories c ON c.id = t.category_id
     WHERE t.tx_type = 'out'
       AND t.tx_date >= $1::date AND t.tx_date < ($1::date + INTERVAL '1 month')
     GROUP BY c.id, c.code, c.name, c.group_name, c.flow_type
     ORDER BY c.code NULLS LAST`, [from]);

  const buckets = { production: 0, admin: 0, commercial: 0, logistics: 0, finance: 0 };
  const lines = [];
  let unclassified = 0;
  for (const row of r.rows) {
    const amount = Number(row.amount) || 0;
    if (!row.category_id) {
      // Не разобранные операции: в себестоимость не берём, но обязаны предупредить.
      unclassified += amount;
      lines.push({ ...row, amount, bucket: null, excluded_reason: 'операция не разобрана (нет статьи ДДС)' });
      continue;
    }
    const groupNo = parseInt(String(row.group_name || '').trim(), 10);
    const rule = BUCKET_BY_GROUP[groupNo] || { bucket: 'admin', reason: null };
    let bucket = rule.bucket, reason = rule.reason;
    if (FOT_CODES.has(String(row.code))) { bucket = null; reason = 'ФОТ и налоги уже учтены через Персонал'; }
    if (bucket) buckets[bucket] += amount;
    lines.push({ ...row, amount, bucket, excluded_reason: bucket ? null : reason });
  }
  const warnings = [];
  if (unclassified > 0) {
    warnings.push({ code: 'CASH_UNCLASSIFIED', message: `В Кассе за ${period} есть неразобранные расходы (${Math.round(unclassified).toLocaleString('ru-RU')} сум). Они не вошли в себестоимость.` });
  }
  return { period, buckets, lines, unclassified, warnings };
}

// --- Выпуск периода (ТЗ 8.7, 20.5) ---------------------------------------
// Итог всегда считается SUM по строкам изделий, отдельной итоговой колонки нет.
async function periodOutput(pool, periodId, mode = 'planned') {
  const col = mode === 'actual' ? 'actual_output_qty' : 'planned_output_qty';
  const r = await pool.query(
    `SELECT COALESCE(SUM(${col}), 0) AS total, COUNT(*)::int AS products,
            COUNT(${col})::int AS filled
     FROM calculation_period_products WHERE period_id = $1`, [periodId]);
  const row = r.rows[0] || {};
  return { total: Number(row.total) || 0, products: Number(row.products) || 0, filled: Number(row.filled) || 0, mode };
}

// --- Изделия, использующие компонент (ТЗ 19.3, нужно для уведомлений) -----
async function productsUsingComponent(pool, itemKind, itemId) {
  const r = await pool.query(
    `SELECT DISTINCT p.id, p.name, p.status
     FROM calculation_recipe_items ri
     JOIN calculation_recipes rc ON rc.id = ri.recipe_id AND rc.status IN ('draft','approved')
     JOIN calculation_products p ON p.id = rc.product_id
     WHERE ri.item_kind = $1 AND ri.item_id = $2 AND p.status = 'active'
     ORDER BY p.name`, [itemKind, itemId]);
  return r.rows;
}

// --- Контроль нормы и склада (ТЗ 11.4) ------------------------------------
// Фактическая выдача сырья в производство за месяц (только контроль, не себестоимость).
async function productionIssuedByItem(pool, period) {
  const from = period + '-01';
  const r = await pool.query(
    `SELECT item_kind, item_id, COALESCE(SUM(-qty), 0) AS issued_qty
     FROM stock_movements
     WHERE direction = 'out' AND reason IN ('issue', 'production')
       AND moved_at >= $1::date AND moved_at < ($1::date + INTERVAL '1 month')
     GROUP BY item_kind, item_id`, [from]).catch(() => ({ rows: [] }));
  return r.rows.map((x) => ({ ...x, issued_qty: Math.abs(Number(x.issued_qty) || 0) }));
}

module.exports = {
  ACCEPTED_HISTORY_SQL,
  lastAcceptedPrice,
  lastAcceptedPricesMap,
  weightedAvgPriceForPeriod,
  monthlyFot,
  cashExpensesByBucket,
  periodOutput,
  productsUsingComponent,
  productionIssuedByItem,
  BUCKET_BY_GROUP,
};
