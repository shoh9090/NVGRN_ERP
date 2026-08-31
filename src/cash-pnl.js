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
// Конверсия валюты: покупка/продажа собственных денег. Ни доход, ни расход.
const CODE_CONVERSION = '102';
const GRP_INCOME = 'Доходы и поступления';
// Статья «Выручка от продаж». Её и только её показывает строка выручки в
// Кэш-флоу, поэтому в P&L она идёт ОТДЕЛЬНОЙ строкой с тем же названием:
// иначе цифры двух отчётов не сойдутся, и доверия к ним не будет.
// Прочие доходные статьи (компенсации, продажа тары и т. п.) — своя строка.
const CODE_SALES = '200';
const isSales = (code) => String(code) === CODE_SALES;
const isIncomeGroup = (g) => String(g || '') === GRP_INCOME;
// Из операционных расходов исключаются только те статьи, чей расход мы берём
// со склада: сырьё и упаковка. Раньше исключалась вся группа «1. Сырьё и
// переменные затраты», и статья 12 «Расходники производства (перчатки)»
// пропадала из отчёта совсем: в себестоимость со склада она не попадает
// (там только сырьё и упаковка), а из расходов была вычеркнута.
const CODES_FROM_STOCK = new Set(['10', '11']);
const isFromStock = (code) => CODES_FROM_STOCK.has(String(code));
const GRP_MATERIALS = '1.';
const GRP_FINANCE = '6.';
const GRP_CAPEX = '7.';
const isMaterials = (g) => String(g || '').startsWith(GRP_MATERIALS);
const isFinance = (g) => String(g || '').startsWith(GRP_FINANCE);
const isCapex = (g) => String(g || '').startsWith(GRP_CAPEX);

const num = (v) => Number(v) || 0;
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

// ---------------------------------------------------------------------------
// Разбор статей по назначению
// ---------------------------------------------------------------------------
// Вынесено в отдельную функцию, потому что этим же правилом пользуется график
// динамики. Две копии правила означали бы, что график и таблица показывают
// разное, а это худшее, что может случиться с отчётом о деньгах.
function classifyRows(rows) {
  const revenue = [];      // выручка: ТОЛЬКО доходные операционные статьи
  const opex = new Map();  // операционные расходы по группам
  const materials = [];    // оплата за сырьё и упаковку (справочно)
  const finance = [];      // финансовые потоки (вне прибыли)
  const capex = [];        // инвестиции (вне прибыли)
  const otherIncome = []; // прочие доходные статьи, кроме 200 «Выручка от продаж»
  const otherIn = [];      // приходы по РАСХОДНЫМ статьям — это возвраты, не выручка
  const refunds = [];      // расход по ДОХОДНОЙ статье — возврат покупателю
  const conversion = [];   // конверсия валюты: обе ноги, деньги никуда не делись

  // Приход и расход по одной статье разбираем ОТДЕЛЬНО. Раньше статья целиком
  // уходила в одну корзину, и возврат от поставщика сырья пропадал из сверки:
  // расход попадал в «оплачено поставщикам», а приход не попадал никуда.
  for (const r of rows) {
    const item = {
      code: r.code, name: r.name, group_name: r.group_name,
      inc: num(r.inc), exp: num(r.exp), cnt: Number(r.cnt),
    };
    // Конверсия валюты — покупка/продажа своих же денег. В Кэш-флоу она тоже
    // исключается; без этого приход по ней раздувал выручку, а расход — затраты.
    if (String(r.code) === CODE_CONVERSION) { conversion.push(item); continue; }

    const fin = isFinance(r.group_name) || r.flow_type === 'financing';
    const cap = isCapex(r.group_name) || r.flow_type === 'investing';
    const mat = isFromStock(r.code);
    const inc = isIncomeGroup(r.group_name);

    // --- приход ---
    // Выручка — только доходные статьи. Возврат от поставщика приходит на
    // расходную статью и выручкой не является: раньше он туда падал, и цифра
    // расходилась и с Кэш-флоу, и с реализацией в SalesDoctor.
    if (item.inc > 0) {
      if (fin) finance.push(item);
      else if (inc && isSales(r.code)) revenue.push(item);
      else if (inc) otherIncome.push(item);
      else otherIn.push(item);
    }

    // --- расход ---
    if (item.exp > 0) {
      if (fin) { if (item.inc <= 0) finance.push(item); }
      else if (cap) capex.push(item);
      else if (mat) materials.push(item);
      // Расход по ДОХОДНОЙ статье — это возврат покупателю. Он уменьшает
      // выручку, а не увеличивает расходы; раньше пропадал совсем.
      else if (inc) refunds.push(item);
      else {
        const key = r.group_name || 'Без группы';
        if (!opex.has(key)) opex.set(key, { group_name: key, amount: 0, items: [] });
        const g = opex.get(key);
        g.amount += item.exp;
        g.items.push(item);
      }
    }
  }


  const sum = (list, f) => list.reduce((s, x) => s + x[f], 0);
  const refundsTotal = sum(refunds, 'exp');
  return {
    revenue, opex, materials, finance, capex, otherIn, otherIncome, refunds, conversion,
    // Выручка от продаж — ровно статья 200, как в Кэш-флоу
    salesTotal: sum(revenue, 'inc'),
    otherIncomeTotal: sum(otherIncome, 'inc'),
    // В прибыли участвуют все доходы за вычетом возвратов покупателям
    revenueTotal: sum(revenue, 'inc') + sum(otherIncome, 'inc') - refundsTotal,
    refundsTotal,
    opexTotal: [...opex.values()].reduce((s, g) => s + g.amount, 0),
    financeIn: sum(finance, 'inc'),
    otherInTotal: sum(otherIn, 'inc'),
    convIn: sum(conversion, 'inc'),
  };
}

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

  const c = classifyRows(rows);
  const { revenue, opex, materials, finance, capex, otherIn, otherIncome, refunds, conversion } = c;

  // Переводы между своими счетами — для сверки с Кэш-флоу.
  const tr = (await pool.query(
    `SELECT COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'in'), 0) AS inc
       FROM cash_transactions t
       JOIN cash_categories c ON c.id = t.category_id
      WHERE t.tx_date BETWEEN $1 AND $2 AND t.source <> 'opening'
        AND c.direction_hint = 'transfer'`, [from, to])).rows[0];

  const sum = (list, f) => list.reduce((s, x) => s + x[f], 0);
  // Выручка — за вычетом возвратов покупателям: продали столько, сколько
  // у нас в итоге осталось, а не столько, сколько выставили.
  const { refundsTotal, revenueTotal, salesTotal, otherIncomeTotal, financeIn, otherInTotal, convIn } = c;
  const transferIn = num(tr.inc);

  return {
    revenue: {
      total: revenueTotal,
      sales: salesTotal, sales_items: revenue,
      other: otherIncomeTotal, other_items: otherIncome,
      refunds: refundsTotal,
      items: revenue.concat(otherIncome),
    },
    opex: { total: c.opexTotal, groups: [...opex.values()] },
    materials_paid: { total: sum(materials, 'exp'), items: materials },
    finance: { in: financeIn, out: sum(finance, 'exp'), items: finance },
    capex: { total: sum(capex, 'exp'), items: capex },
    other_inflows: { total: otherInTotal, items: otherIn },
    refunds: { total: refundsTotal, items: refunds },
    conversion: { in: convIn, out: sum(conversion, 'exp'), items: conversion },
    unclassified: { inc: num(un.inc), exp: num(un.exp), cnt: Number(un.cnt) },
    // Сверка: из чего складывается расхождение с приходом в Кэш-флоу.
    // Показываем арифметикой, чтобы не выяснять это в переписке.
    reconcile: {
      all_in: revenueTotal + refundsTotal + financeIn + otherInTotal + convIn + transferIn + num(un.inc),
      revenue: revenueTotal,
      sales: salesTotal,
      other_income: otherIncomeTotal,
      refunds: refundsTotal,
      finance_in: financeIn,
      other_inflows: otherInTotal,
      conversion_in: convIn,
      transfers_in: transferIn,
      unclassified_in: num(un.inc),
    },
  };
}

// ---------------------------------------------------------------------------
// Фактическая себестоимость: что реально ушло со склада в производство
// ---------------------------------------------------------------------------
// Списание оценивается средневзвешенной ценой приходов этой позиции. Позиции,
// по которым цены прихода нет, в сумму НЕ попадают и показываются отдельным
// списком: молча занизить себестоимость хуже, чем показать пробел.
// ---------------------------------------------------------------------------
// Отходы сырья: сколько денег ушло в обрезь
// ---------------------------------------------------------------------------
// Отход приходит на склад отдельной позицией с ценой ноль (он «бесплатный»),
// но заплачено-то за него было — он входил в вес купленной зелени. Поэтому
// оцениваем его по цене РОДИТЕЛЬСКОГО сырья: ref_raw_materials.waste_of_id
// указывает, из чего этот отход получен.
//
// Показатель взят из отчёта финансиста: у него «ОТХОДЫ сырья» отдельной
// строкой и «% отходов» от выручки. Для зелени это одно из главных чисел.
async function wasteCost(pool, from, to) {
  const rows = (await pool.query(
    `SELECT w.waste_of_id AS parent_id, SUM(m.qty) AS qty
       FROM stock_movements m
       JOIN ref_raw_materials w ON w.id = m.item_id AND w.waste_of_id IS NOT NULL
      WHERE m.item_kind = 'raw' AND m.reason = 'receive_waste'
        AND m.moved_at BETWEEN $1 AND $2 AND m.qty > 0
      GROUP BY w.waste_of_id`, [from, to])).rows;
  if (!rows.length) return { qty: 0, amount: 0, priced: 0, no_price: 0, has_data: false };

  const prices = (await pool.query(
    `SELECT item_id, SUM(qty * price) / NULLIF(SUM(qty), 0) AS avg_price
       FROM stock_movements
      WHERE item_kind = 'raw' AND reason = 'receive' AND price > 0 AND qty > 0 AND moved_at <= $1
      GROUP BY item_id`, [to])).rows;
  const priceOf = new Map(prices.map((x) => [x.item_id, Number(x.avg_price)]));

  let qty = 0, amount = 0, priced = 0, noPrice = 0;
  for (const r of rows) {
    const q = num(r.qty);
    qty += q;
    const price = priceOf.get(r.parent_id);
    // Без цены родителя отход не оцениваем — молча считать его бесплатным
    // нельзя, иначе показатель отходов занизится.
    if (price === undefined) { noPrice++; continue; }
    amount += q * price;
    priced++;
  }
  return { qty, amount, priced, no_price: noPrice, has_data: true };
}

// Корректировки остатка (инвентаризация, порча). Не считаем их себестоимостью
// автоматически — причина у них разная, — но и не прячем: минус на складе,
// который никуда не делся, должен быть виден.
async function stockAdjustments(pool, from, to) {
  const r = (await pool.query(
    `SELECT COALESCE(SUM(-qty), 0) AS qty, COUNT(*) AS cnt
       FROM stock_movements
      WHERE reason = 'adjust' AND qty < 0 AND moved_at BETWEEN $1 AND $2`, [from, to])).rows[0] || {};
  return { qty: num(r.qty), cnt: Number(r.cnt) || 0 };
}

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

  const [cash, fact, plan, adjust, waste] = await Promise.all([
    cashSide(pool, from, toStr),
    factCogs(pool, from, toStr),
    planCogs(pool, units),
    stockAdjustments(pool, from, toStr),
    wasteCost(pool, from, toStr),
  ]);

  const revenue = cash.revenue.total;
  // Себестоимость берём фактическую. Если склад за месяц не вёлся, считаем по
  // плану — иначе отчёт бесполезен целые месяцы. Чем посчитано, отдаём наружу:
  // подменять факт планом молча нельзя, человек должен это видеть.
  const factTotal = fact.has_data ? fact.total : null;
  const cogs = factTotal !== null ? factTotal : plan.total;
  const cogsSource = factTotal !== null ? 'fact' : (plan.total !== null ? 'plan' : null);
  const gross = cogs === null ? null : revenue - cogs;
  const operating = gross === null ? null : gross - cash.opex.total;

  // Честные предупреждения: пусть человек видит, чему верить нельзя.
  const warnings = [];
  if (!fact.has_data) {
    warnings.push(cogsSource === 'plan'
      ? 'За месяц нет выдач сырья в производство, поэтому себестоимость посчитана по плану из Калькуляции. Чтобы увидеть факт, отмечайте выдачи в Складе.'
      : 'За месяц нет ни выдач сырья со склада, ни количества отгрузок — себестоимость и прибыль посчитать не из чего.');
  }
  if (fact.no_price.length) {
    // Называем позиции поимённо: «не оценено 1» непонятно, что делать.
    warnings.push('Нет цены прихода: ' + fact.no_price.map((x) => x.name).join(', ')
      + '. В себестоимость эти позиции не вошли — проведите приёмку с ценой в Закупе.');
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
    cogs_source: cogsSource,
    gross_profit: gross,
    gross_margin_pct: gross === null ? null : pct(gross, revenue),
    opex: cash.opex,
    operating_profit: operating,
    operating_margin_pct: operating === null ? null : pct(operating, revenue),
    reconcile: cash.reconcile,
    stock_adjust: adjust,
    // Показатели из отчёта финансиста: сколько копеек с сума выручки съедают
    // сырьё и отходы. Считаем от выручки ОТ ПРОДАЖ — от той же цифры, что
    // в Кэш-флоу, иначе процент не с чем будет сверить.
    waste,
    ratios: {
      base: cash.revenue.sales,
      raw_load_pct: pct((fact.has_data ? fact.raw : 0) + waste.amount, cash.revenue.sales),
      waste_pct: pct(waste.amount, cash.revenue.sales),
      pack_pct: fact.has_data ? pct(fact.packaging, cash.revenue.sales) : null,
      opex_pct: pct(cash.opex.total, cash.revenue.sales),
    },
    excluded: {
      refunds: cash.refunds,
      other_inflows: cash.other_inflows,
      conversion: cash.conversion,
      materials_paid: cash.materials_paid,
      finance: cash.finance,
      capex: cash.capex,
      unclassified: cash.unclassified,
    },
    units, units_at: unitsAt,
    warnings,
  };
}


// ---------------------------------------------------------------------------
// Динамика по месяцам — для графика на дашборде
// ---------------------------------------------------------------------------
// Считаем те же величины, что и месячный отчёт, но сразу за несколько месяцев
// и одним набором запросов: дёргать buildPnl двенадцать раз означало бы
// полсотни запросов к базе на каждое открытие вкладки.
//
// Классификация статей — ровно та же функция, что и в месячном отчёте
// (classifyRows). Если развести их на две копии, график и таблица начнут
// показывать разное, и доверие к отчёту закончится.
async function buildTrend(pool, endPeriod, months) {
  const n = Math.max(2, Math.min(24, Number(months) || 12));
  const bounds = (await pool.query(
    `SELECT to_char(($1::date - ($2 || ' months')::interval), 'YYYY-MM-DD') AS f,
            to_char((($1::date + INTERVAL '1 month') - INTERVAL '1 day'), 'YYYY-MM-DD') AS t`,
    [endPeriod + '-01', n - 1])).rows[0];

  // Деньги по месяцам и статьям
  const cashRows = (await pool.query(
    `SELECT to_char(t.tx_date, 'YYYY-MM') AS m,
            c.code, c.name, c.group_name, c.flow_type,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'in'), 0)  AS inc,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'out'), 0) AS exp,
            COUNT(*) AS cnt
       FROM cash_transactions t
       JOIN cash_categories c ON c.id = t.category_id
      WHERE t.tx_date BETWEEN $1 AND $2
        AND t.tx_type IN ('in', 'out')
        AND t.source <> 'opening'
        AND (c.direction_hint IS DISTINCT FROM 'transfer')
      GROUP BY 1, c.code, c.name, c.group_name, c.flow_type`, [bounds.f, bounds.t])).rows;

  // Списания со склада по месяцам, оценённые средней ценой прихода
  const usedRows = (await pool.query(
    `SELECT to_char(moved_at, 'YYYY-MM') AS m, item_kind, item_id, SUM(-qty) AS qty
       FROM stock_movements
      WHERE reason = 'production' AND moved_at BETWEEN $1 AND $2
      GROUP BY 1, item_kind, item_id
     HAVING SUM(-qty) > 0`, [bounds.f, bounds.t])).rows;
  const priceRows = usedRows.length ? (await pool.query(
    `SELECT item_kind, item_id, SUM(qty * price) / NULLIF(SUM(qty), 0) AS avg_price
       FROM stock_movements
      WHERE reason = 'receive' AND price > 0 AND qty > 0 AND moved_at <= $1
      GROUP BY item_kind, item_id`, [bounds.t])).rows : [];
  const priceOf = new Map(priceRows.map((p) => [p.item_kind + '#' + p.item_id, Number(p.avg_price)]));

  // Раскладываем по месяцам
  const byMonth = new Map();
  const monthOf = (m) => {
    if (!byMonth.has(m)) byMonth.set(m, { period: m, rows: [], cogs: 0, cogs_known: false });
    return byMonth.get(m);
  };
  cashRows.forEach((r) => monthOf(r.m).rows.push(r));
  usedRows.forEach((u) => {
    const slot = monthOf(u.m);
    const price = priceOf.get(u.item_kind + '#' + u.item_id);
    if (price === undefined) return;          // без цены прихода не оцениваем
    slot.cogs += (Number(u.qty) || 0) * price;
    slot.cogs_known = true;
  });

  // Идём по всем месяцам подряд, включая пустые: провал в данных должен быть
  // виден дырой на графике, а не «съеденным» месяцем.
  const out = [];
  const [ey, em] = endPeriod.split('-').map(Number);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(ey, em - 1 - i, 1));
    const key = d.toISOString().slice(0, 7);
    const slot = byMonth.get(key);
    if (!slot) { out.push({ period: key, revenue: 0, cogs: null, opex: 0, profit: null }); continue; }
    const c = classifyRows(slot.rows);
    const cogs = slot.cogs_known ? slot.cogs : null;
    out.push({
      period: key,
      revenue: c.revenueTotal,
      cogs,
      opex: c.opexTotal,
      profit: cogs === null ? null : c.revenueTotal - cogs - c.opexTotal,
    });
  }
  return { months: n, from: bounds.f, to: bounds.t, points: out };
}

module.exports = { buildPnl, buildTrend, UNITS_KEY };
