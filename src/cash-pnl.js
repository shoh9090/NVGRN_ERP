// cash-pnl.js — управленческий отчёт о прибыли (вкладка «P&L» в Кассе).
//
// Чем он отличается от Кэш-флоу: там движение денег, здесь попытка показать
// заработок. Отличия сведены к трём:
//   1. Себестоимость берётся НЕ из оплат поставщикам, а из списания склада —
//      деньги за сырьё платятся в одном месяце, а расходуется оно в другом.
//   2. Из расчёта убраны финансовые и инвестиционные потоки: возврат тела
//      кредита, взносы учредителей, капекс. Это не доход и не расход.
//   3. Внутренние перемещения между своими счетами исключены полностью.
//
// Чего в этом отчёте ЧЕСТНО НЕТ (написано и на экране):
//   • начислений — расходы попадают по дате оплаты, поэтому аренда, оплаченная
//     раз в квартал, ложится одним месяцем, а не тремя;
//   • амортизации — капекс виден только справочно;
//   • выручки по отгрузке — пока считаются поступления денег.
// Это управленческая картина, а не бухгалтерский ОПиУ.

// Ключ, под которым храним подтянутое из SalesDoctor количество отгрузок.
// Хранится по месяцам: цифра нужна, чтобы посчитать плановую себестоимость.
const UNITS_KEY = (period) => 'pnl_units_' + period;

// Группы классификатора ДДС. Первая — оплаты поставщикам за сырьё и упаковку:
// в P&L они НЕ расход, иначе себестоимость посчиталась бы дважды (её мы берём
// со склада). Шестая и седьмая — финансы и капекс, они вне прибыли.
const GRP_MATERIALS = '1.';
const GRP_FINANCE = '6.';
const GRP_CAPEX = '7.';
const isMaterials = (g) => String(g || '').startsWith(GRP_MATERIALS);
const isFinance = (g) => String(g || '').startsWith(GRP_FINANCE);
const isCapex = (g) => String(g || '').startsWith(GRP_CAPEX);

const num = (v) => Number(v) || 0;
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

// ---------------------------------------------------------------------------
// Деньги Кассы за период, разложенные по назначению
// ---------------------------------------------------------------------------
async function cashSide(pool, from, to) {
  // Переводы между своими счетами исключены на входе: они не доход и не расход.
  const rows = (await pool.query(
    `SELECT c.code, c.name, c.group_name, c.flow_type,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'in'), 0)  AS inc,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'out'), 0) AS exp,
            COUNT(*) AS cnt
       FROM cash_transactions t
       JOIN cash_categories c ON c.id = t.category_id
      WHERE t.tx_date BETWEEN $1 AND $2
        AND t.tx_type IN ('in', 'out')
        AND t.source <> 'opening'
        AND (c.direction_hint IS DISTINCT FROM 'transfer')
      GROUP BY c.code, c.name, c.group_name, c.flow_type
      ORDER BY c.code`, [from, to])).rows;

  // Операции без статьи — их нельзя молча потерять, иначе итог не сойдётся
  // с Кэш-флоу и человек справедливо перестанет верить отчёту.
  const un = (await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE tx_type = 'in'), 0)  AS inc,
            COALESCE(SUM(amount) FILTER (WHERE tx_type = 'out'), 0) AS exp,
            COUNT(*) AS cnt
       FROM cash_transactions t
      WHERE t.tx_date BETWEEN $1 AND $2 AND t.tx_type IN ('in', 'out')
        AND t.source <> 'opening' AND t.category_id IS NULL`, [from, to])).rows[0];

  const revenue = [];      // операционные доходы = выручка
  const opex = new Map();  // операционные расходы по группам
  const materials = [];    // оплата за сырьё и упаковку (справочно)
  const finance = [];      // финансовые потоки (вне прибыли)
  const capex = [];        // инвестиции (вне прибыли)

  for (const r of rows) {
    const item = {
      code: r.code, name: r.name, group_name: r.group_name,
      inc: num(r.inc), exp: num(r.exp), cnt: Number(r.cnt),
    };
    if (isFinance(r.group_name) || r.flow_type === 'financing') { finance.push(item); continue; }
    if (isCapex(r.group_name) || r.flow_type === 'investing') { capex.push(item); continue; }
    if (isMaterials(r.group_name)) { materials.push(item); continue; }
    if (item.inc > 0) revenue.push(item);
    if (item.exp > 0) {
      const key = r.group_name || 'Без группы';
      if (!opex.has(key)) opex.set(key, { group_name: key, amount: 0, items: [] });
      const g = opex.get(key);
      g.amount += item.exp;
      g.items.push(item);
    }
  }

  const sum = (list, f) => list.reduce((s, x) => s + x[f], 0);
  return {
    revenue: { total: sum(revenue, 'inc'), items: revenue },
    opex: { total: [...opex.values()].reduce((s, g) => s + g.amount, 0), groups: [...opex.values()] },
    materials_paid: { total: sum(materials, 'exp'), items: materials },
    finance: { in: sum(finance, 'inc'), out: sum(finance, 'exp'), items: finance },
    capex: { total: sum(capex, 'exp'), items: capex },
    unclassified: { inc: num(un.inc), exp: num(un.exp), cnt: Number(un.cnt) },
  };
}

// ---------------------------------------------------------------------------
// Фактическая себестоимость: что реально ушло со склада в производство
// ---------------------------------------------------------------------------
// Списание оценивается средневзвешенной ценой приходов этой позиции. Позиции,
// по которым цены прихода нет, в сумму НЕ попадают и показываются отдельным
// списком: молча занизить себестоимость хуже, чем показать пробел.
async function factCogs(pool, from, to) {
  const used = (await pool.query(
    `SELECT item_kind, item_id, SUM(-qty) AS qty
       FROM stock_movements
      WHERE reason = 'production' AND moved_at BETWEEN $1 AND $2
      GROUP BY item_kind, item_id
     HAVING SUM(-qty) > 0`, [from, to])).rows;

  if (!used.length) {
    return { raw: 0, packaging: 0, total: 0, lines: [], no_price: [], has_data: false };
  }

  // Средневзвешенная цена прихода — по всем поставкам до конца периода.
  const prices = (await pool.query(
    `SELECT item_kind, item_id,
            SUM(qty * price) / NULLIF(SUM(qty), 0) AS avg_price
       FROM stock_movements
      WHERE reason = 'receive' AND price > 0 AND qty > 0 AND moved_at <= $1
      GROUP BY item_kind, item_id`, [to])).rows;
  const priceOf = new Map(prices.map((p) => [p.item_kind + '#' + p.item_id, Number(p.avg_price)]));

  const names = new Map();
  for (const kind of ['raw', 'packaging']) {
    const table = kind === 'raw' ? 'ref_raw_materials' : 'ref_packaging';
    const ids = used.filter((u) => u.item_kind === kind).map((u) => u.item_id);
    if (!ids.length) continue;
    const r = await pool.query(`SELECT id, name FROM ${table} WHERE id = ANY($1)`, [ids]);
    r.rows.forEach((x) => names.set(kind + '#' + x.id, x.name));
  }

  const lines = [];
  const noPrice = [];
  let raw = 0, packaging = 0;
  for (const u of used) {
    const key = u.item_kind + '#' + u.item_id;
    const qty = num(u.qty);
    const price = priceOf.has(key) ? priceOf.get(key) : null;
    const name = names.get(key) || ('позиция #' + u.item_id);
    if (price === null) { noPrice.push({ kind: u.item_kind, id: u.item_id, name, qty }); continue; }
    const amount = qty * price;
    lines.push({ kind: u.item_kind, id: u.item_id, name, qty, price, amount });
    if (u.item_kind === 'raw') raw += amount; else packaging += amount;
  }
  lines.sort((a, b) => b.amount - a.amount);
  return { raw, packaging, total: raw + packaging, lines, no_price: noPrice, has_data: true };
}

// ---------------------------------------------------------------------------
// Плановая себестоимость: сколько материалов ДОЛЖНО было уйти
// ---------------------------------------------------------------------------
// Считается только материальная часть (зелень + упаковка) — ровно то же, что
// меряет склад. Сравнивать полную себестоимость с материальным списанием было
// бы подлогом: в полную входят ещё ФОТ и общезаводские расходы.
async function planCogs(pool, units) {
  if (!(units > 0)) return { units: 0, unit_cost: null, total: null, products: 0, reason: 'Не подтянуто количество отгрузок' };
  const r = await pool.query(
    `SELECT p.net_weight_g, p.raw_price_per_kg, p.raw_cost, p.pack_template_id, p.recipe_id
       FROM calc_sheet_products p
      WHERE p.status = 'active'`);
  if (!r.rows.length) return { units, unit_cost: null, total: null, products: 0, reason: 'В Калькуляции нет товаров' };

  const tpl = (await pool.query(
    `SELECT t.id, COALESCE(SUM(i.price * i.qty), 0) AS total
       FROM calc_pack_templates t
       LEFT JOIN calc_pack_template_items i ON i.template_id = t.id AND i.price IS NOT NULL
      WHERE t.status = 'active' GROUP BY t.id`)).rows;
  const tplTotal = new Map(tpl.map((t) => [t.id, Number(t.total)]));

  // У миксов (салатов) зелень задана рецептурой, а не граммажом одной позиции.
  // Берём ту же цифру, что показывает лист «Рецептуры», иначе такие товары
  // выпали бы из среднего и план оказался бы занижен.
  const rec = (await pool.query(
    `SELECT rp.recipe_id,
            SUM(CASE WHEN pr.price IS NULL THEN 0 ELSE (rp.qty_g / 1000.0) * pr.price END) AS total,
            COUNT(*) FILTER (WHERE pr.price IS NOT NULL) AS priced
       FROM calc_mix_items rp
       LEFT JOIN (
         -- Цена сырья: из Закупа (последние приёмки), а где её нет —
         -- вписанная вручную. Тот же порядок, что на листе «Рецептуры».
         SELECT COALESCE(b.raw_id, m.raw_material_id) AS raw_id,
                COALESCE(b.price, m.price) AS price
           FROM (
             SELECT i.item_id AS raw_id,
                    SUM(i.qty * COALESCE(i.fact_price, i.price)) / NULLIF(SUM(i.qty), 0) AS price
               FROM purchase_order_items i
               JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
              WHERE i.item_kind = 'raw' AND COALESCE(i.fact_price, i.price) > 0
              GROUP BY i.item_id
           ) b
           FULL JOIN calc_raw_manual_prices m ON m.raw_material_id = b.raw_id
       ) pr ON pr.raw_id = rp.raw_material_id
      GROUP BY rp.recipe_id`)).rows;
  const recTotal = new Map(rec.map((x) => [x.recipe_id, Number(x.priced) > 0 ? Number(x.total) : null]));

  let sum = 0, counted = 0, skipped = 0;
  for (const p of r.rows) {
    const weight = p.net_weight_g === null ? null : Number(p.net_weight_g);
    const perKg = p.raw_price_per_kg === null ? null : Number(p.raw_price_per_kg);
    const green = p.recipe_id
      ? (recTotal.has(p.recipe_id) ? recTotal.get(p.recipe_id) : null)
      : ((weight !== null && perKg !== null) ? (weight / 1000) * perKg
        : (p.raw_cost === null ? null : Number(p.raw_cost)));
    const pack = p.pack_template_id ? (tplTotal.get(p.pack_template_id) || null) : null;
    if (green === null && pack === null) { skipped++; continue; }
    sum += (green || 0) + (pack || 0);
    counted++;
  }
  if (!counted) return { units, unit_cost: null, total: null, products: 0, skipped, reason: 'У товаров не заполнены зелень и упаковка' };
  const unitCost = sum / counted;
  return { units, unit_cost: unitCost, total: unitCost * units, products: counted, skipped, reason: null };
}

// ---------------------------------------------------------------------------
// Сборка отчёта
// ---------------------------------------------------------------------------
async function buildPnl(pool, period) {
  const from = period + '-01';
  // Дату форматирует САМА база. Postgres отдаёт колонку date объектом Date,
  // и String(...) даёт «Mon Aug 31» вместо «2026-08-31» — такую строку
  // следующий же запрос не примет. Просим сразу текст.
  const toStr = (await pool.query(
    "SELECT to_char(($1::date + INTERVAL '1 month') - INTERVAL '1 day', 'YYYY-MM-DD') AS d",
    [from])).rows[0].d;

  // Настройки читаем через ПЕРЕДАННЫЙ пул, а не через глобальный: иначе
  // функцию нельзя проверить тестом, не поднимая настоящую базу.
  const st = (await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)',
    [[UNITS_KEY(period), UNITS_KEY(period) + '_at']])).rows;
  const byKey = new Map(st.map((x) => [x.key, x.value]));
  const units = Number(byKey.get(UNITS_KEY(period))) || 0;
  const unitsAt = byKey.get(UNITS_KEY(period) + '_at') || '';

  const [cash, fact, plan] = await Promise.all([
    cashSide(pool, from, toStr),
    factCogs(pool, from, toStr),
    planCogs(pool, units),
  ]);

  const revenue = cash.revenue.total;
  const cogs = fact.has_data ? fact.total : null;
  const gross = cogs === null ? null : revenue - cogs;
  const operating = gross === null ? null : gross - cash.opex.total;

  // Честные предупреждения: пусть человек видит, чему верить нельзя.
  const warnings = [];
  if (!fact.has_data) warnings.push('За период нет списаний со склада — себестоимость и валовая прибыль не посчитаны.');
  if (fact.no_price.length) {
    warnings.push('Не оценено позиций: ' + fact.no_price.length
      + ' — по ним нет цены прихода, в себестоимость они не вошли.');
  }
  if (cash.unclassified.cnt) {
    warnings.push('Операций без статьи: ' + cash.unclassified.cnt
      + '. Пока они не разнесены, отчёт неполный.');
  }
  if (!units) warnings.push('Количество отгрузок за месяц не подтянуто — плановая себестоимость не посчитана.');

  return {
    period, from, to: toStr,
    revenue: cash.revenue,
    cogs: {
      fact,
      plan,
      // Расхождение считаем только когда есть обе цифры, иначе это не сравнение.
      diff: (fact.has_data && plan.total !== null) ? fact.total - plan.total : null,
      diff_pct: (fact.has_data && plan.total > 0) ? pct(fact.total - plan.total, plan.total) : null,
    },
    gross_profit: gross,
    gross_margin_pct: gross === null ? null : pct(gross, revenue),
    opex: cash.opex,
    operating_profit: operating,
    operating_margin_pct: operating === null ? null : pct(operating, revenue),
    excluded: {
      materials_paid: cash.materials_paid,
      finance: cash.finance,
      capex: cash.capex,
      unclassified: cash.unclassified,
    },
    units, units_at: unitsAt,
    warnings,
  };
}

module.exports = { buildPnl, UNITS_KEY };
