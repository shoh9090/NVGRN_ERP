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
//   • амортизации — капекс виден только справочно.
//
// Выручка здесь — РЕАЛИЗАЦИЯ (отгружено за месяц по SalesDoctor), а не приход
// денег: при отсрочке платежа до 30 дней деньги за августовские отгрузки
// приходят в сентябре, и отчёт на поступлениях показывает мнимый убыток.
// Поступления остаются в отчёте справочно, для сверки с Кэш-флоу.
// Это управленческая картина, а не бухгалтерский ОПиУ.

// Ключ, под которым храним подтянутое из SalesDoctor количество отгрузок.
// Хранится по месяцам: цифра нужна, чтобы посчитать плановую себестоимость.
const UNITS_KEY = (period) => 'pnl_units_' + period;
// Сумма реализации из SalesDoctor за месяц. В P&L выручка — это ОТГРУЖЕНО,
// а не «деньги пришли»: при отсрочке до 30 дней поступления отстают от
// отгрузок на месяц, и отчёт на поступлениях показывает мнимый убыток.
const SALES_KEY = (period) => 'pnl_sales_' + period;
// Продажи по товарам SalesDoctor за месяц: [[sd_id, штук, название], …].
// Нужны, чтобы план считался по ассортименту, а не по «средней пачке».
const SKU_KEY = (period) => 'pnl_sku_' + period;
// Снимок отчёта за закрытый месяц. Пока месяц открыт, отчёт считается заново из
// движений; при закрытии месяца в Кассе цифры сохраняются и дальше показываются
// как есть — закрытый месяц не должен меняться от новых закупок и правок
// Калькуляции (аудит A12). Открыли месяц заново — снимок снимается.
const SNAP_KEY = (period) => 'pnl_snapshot_' + period;
// Реализация за месяц загружена из SD: в настройке есть число (в том числе 0 или минус).
const salesLoaded = (v) => v != null && String(v).trim() !== '' && isFinite(Number(v));

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
// Решение Шоха (сентябрь 2026): в группе «6. Финансы» лежат не только кредиты, но и
// настоящие расходы — налоги и комиссии банка. Раньше вся группа выпадала из
// прибыли, и прибыль была завышена на налоги. Теперь:
//   • налоги от ЗП, НДС, прочие налоги, % банка, % за обнал — операционные расходы;
//   • налог на прибыль — отдельной строкой ПОСЛЕ операционной прибыли;
//   • кредиты, займы, возвраты долгов, резервы — по-прежнему вне прибыли.
const OPEX_FROM_FINANCE = new Set(['62', '64', '65', '66', '68']);
const PROFIT_TAX_CODE = '67';
// Проценты по кредитам (статья 60) — настоящий расход компании, в отличие от
// возврата тела кредита (61): тело — это отданные свои деньги, проценты — плата
// за них. Раньше вся статья выпадала из прибыли вместе с телом, и чистая
// прибыль была завышена на проценты. Показываем отдельной строкой ПОСЛЕ
// операционной прибыли: к работе компании они отношения не имеют, это цена денег.
const LOAN_INTEREST_CODE = '60';
const GRP_TAXES = 'Налоги и комиссии банка';

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
  const profitTax = [];    // налог на прибыль — после операционной прибыли
  const interest = [];     // проценты по кредитам — тоже после операционной прибыли

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
      const code = String(r.code);
      if (code === PROFIT_TAX_CODE) profitTax.push(item);
      else if (code === LOAN_INTEREST_CODE) interest.push(item);
      else if (OPEX_FROM_FINANCE.has(code)) {
        // Налоги и комиссии банка — расход, хоть статья и в группе «Финансы».
        if (!opex.has(GRP_TAXES)) opex.set(GRP_TAXES, { group_name: GRP_TAXES, amount: 0, items: [] });
        const g = opex.get(GRP_TAXES);
        g.amount += item.exp;
        g.items.push(item);
      }
      else if (fin) { if (item.inc <= 0) finance.push(item); }
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
    revenue, opex, materials, finance, capex, otherIn, otherIncome, refunds, conversion, profitTax, interest,
    profitTaxTotal: sum(profitTax, 'exp'),
    interestTotal: sum(interest, 'exp'),
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
    profit_tax: { total: c.profitTaxTotal, items: c.profitTax },
    interest: { total: c.interestTotal, items: c.interest },
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
async function wasteCost(pool, from, to, priceOf) {
  const rows = (await pool.query(
    `SELECT w.waste_of_id AS parent_id, SUM(m.qty) AS qty
       FROM stock_movements m
       JOIN ref_raw_materials w ON w.id = m.item_id AND w.waste_of_id IS NOT NULL
      WHERE m.item_kind = 'raw' AND m.reason = 'receive_waste'
        AND m.moved_at BETWEEN $1 AND $2 AND m.qty > 0
      GROUP BY w.waste_of_id`, [from, to])).rows;
  if (!rows.length) return { qty: 0, amount: 0, priced: 0, no_price: 0, has_data: false };

  let qty = 0, amount = 0, priced = 0, noPrice = 0;
  for (const r of rows) {
    const q = num(r.qty);
    qty += q;
    const price = priceOf.get('raw#' + r.parent_id);
    // Без цены родителя отход не оцениваем — молча считать его бесплатным
    // нельзя, иначе показатель отходов занизится.
    if (price === undefined) { noPrice++; continue; }
    amount += q * price;
    priced++;
  }
  return { qty, amount, priced, no_price: noPrice, has_data: true };
}

// Списания со склада по статьям. В отличие от корректировок, тут причина
// известна, поэтому деньги можно разнести:
//   loss     — порча, усушка, зачистка, недостача: наши потери;
//   supplier — брак поставщика: не наш расход, если предъявили ему;
//   internal — дегустации и образцы: это не потеря, а представительские.
// Оцениваем той же ценой месяца, что и себестоимость, — иначе Склад и P&L
// показали бы разные суммы за одно и то же списание.
async function writeoffCost(pool, from, to, priceOf) {
  let rows = [];
  try {
    rows = (await pool.query(
      `SELECT COALESCE(r.pnl_group, 'loss') AS grp, r.name AS reason,
              i.item_kind, i.item_id, SUM(i.qty) AS qty
         FROM stock_writeoffs w
         JOIN stock_writeoff_items i ON i.writeoff_id = w.id
         LEFT JOIN reject_reasons r ON r.id = w.reason_id
        WHERE w.moved_at BETWEEN $1 AND $2
        GROUP BY 1, 2, 3, 4`, [from, to])).rows;
  } catch (e) { return { amount: 0, loss: 0, supplier: 0, internal: 0, qty: 0, by_reason: {}, has_data: false }; }
  const out = { amount: 0, loss: 0, supplier: 0, internal: 0, qty: 0, by_reason: {}, has_data: rows.length > 0 };
  for (const r of rows) {
    const q = num(r.qty);
    const price = priceOf.get(r.item_kind + '#' + r.item_id);
    const amount = price ? q * Number(price) : 0;
    const grp = ['loss', 'supplier', 'internal'].includes(r.grp) ? r.grp : 'loss';
    out.qty += q;
    out[grp] += amount;
    if (grp === 'loss') out.amount += amount;      // в потери идёт только наше
    const key = r.reason || 'Без статьи';
    out.by_reason[key] = (out.by_reason[key] || 0) + amount;
  }
  return out;
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

// ---------------------------------------------------------------------------
// Цены сырья и упаковки по месяцам — одна функция для карточки, графика и Excel
// ---------------------------------------------------------------------------
// Решение Шоха (сентябрь 2026): позиция оценивается СРЕДНЕЙ ЦЕНОЙ ПРИХОДОВ ЭТОГО
// МЕСЯЦА, а если в месяце прихода не было — последней известной ценой до него.
// Так у зелени видны сезонные скачки, а прошлые месяцы не «плывут»: раньше
// карточка брала все приходы с начала времён до конца месяца, а график — до
// конца всего показанного отрезка, и сентябрьская закупка меняла себестоимость
// августа на графике, но не в карточке августа (аудит A12).
// Последний день месяца, строкой для базы. Считаем в JS: так запрос остаётся
// простым и его легко подменить в тесте.
const monthEnd = (month) => {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const monthList = (fromMonth, toMonth) => {
  const out = [];
  const [fy, fm] = String(fromMonth).split('-').map(Number);
  const [ty, tm] = String(toMonth).split('-').map(Number);
  for (let y = fy, m = fm; y * 12 + m <= ty * 12 + tm; m === 12 ? (y++, m = 1) : m++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
};

// Возвращает Map 'ГГГГ-ММ' → Map 'вид#id' → цена. Цены накапливаются по
// месяцам: цена «переносится» вперёд, пока не появится новый приход.
async function monthlyPriceMaps(pool, fromMonth, toMonth) {
  const rows = (await pool.query(
    `SELECT to_char(moved_at, 'YYYY-MM') AS m, item_kind, item_id,
            SUM(qty * price) / NULLIF(SUM(qty), 0) AS avg_price
       FROM stock_movements
      WHERE reason IN ('receive', 'opening', 'adjust') AND price > 0 AND qty > 0 AND moved_at <= $1
      GROUP BY 1, 2, 3
      ORDER BY 1`, [monthEnd(toMonth)])).rows;
  const carry = new Map();                  // последняя известная цена позиции
  const byMonth = new Map();
  for (const r of rows) {
    const key = r.item_kind + '#' + r.item_id;
    const price = Number(r.avg_price);
    if (!r.m) { carry.set(key, price); continue; }   // приходы до начала отрезка
    if (!byMonth.has(r.m)) byMonth.set(r.m, []);
    byMonth.get(r.m).push([key, price]);
  }
  const months = [...new Set([...byMonth.keys(), ...monthList(fromMonth, toMonth)])].sort();
  const out = new Map();
  for (const m of months) {
    for (const [key, price] of byMonth.get(m) || []) carry.set(key, price);
    if (m >= fromMonth && m <= toMonth) out.set(m, new Map(carry));
  }
  return out;
}

async function factCogs(pool, from, to, priceOf) {
  const used = (await pool.query(
    `SELECT item_kind, item_id, SUM(-qty) AS qty
       FROM stock_movements
      WHERE reason = 'production' AND moved_at BETWEEN $1 AND $2
      GROUP BY item_kind, item_id
     HAVING SUM(-qty) > 0`, [from, to])).rows;

  if (!used.length) {
    return { raw: 0, packaging: 0, total: 0, lines: [], no_price: [], has_data: false };
  }

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
// Себестоимость: сырьё — принятое за месяц в Закупе, упаковка — оплаченная
// ---------------------------------------------------------------------------
// Решение Шоха (сентябрь 2026) после разбора августа. Раньше сырьё бралось со
// склада («выдано в производство»), а склад вёлся неполно: в августе принято
// зелени на 651 млн, выдано отмечено на 374, на складе «лежало» 10,7 т свежей
// зелени, упаковку не выдавали ни разу. Прибыль вышла завышенной на ~360 млн.
//
// Зелень не хранится: что приняли в месяце, то в месяце и ушло — в продукт или
// в отход. Поэтому сырьё = всё принятое за месяц в Закупе (факт × цена, так же,
// как считается долг поставщику). Отход и потери уже внутри купленного веса,
// отдельно их к себестоимости НЕ прибавляем — иначе посчитаем дважды.
// Упаковка хранится долго и со склада не выдаётся — берём оплаченное за месяц
// (Касса, статья 11). Месяцы до запуска Закупа — сырьё по оплатам (статья 10).
// Склад перестал влиять на прибыль: выдачи, отход и остаток — контроль.
const CODE_RAW_PAID = '10';
const CODE_PACK_PAID = '11';

// Сырьё, принятое в Закупе, по месяцам: Map 'ГГГГ-ММ' → { total, orders, no_price }.
//
// Месяц определяет ФАКТИЧЕСКАЯ дата приёмки (received_at), а плановая дата
// поставки — только для старых документов, где приёмку не отметили. Ровно так
// же считает долг поставщику `purchase-finance.js`. Раньше P&L брал плановую
// дату, и заявка с планом на 31 августа, принятая 1 сентября, попадала в
// себестоимость августа, а в долг — в сентябрь: две плитки про одну поставку
// показывали разные месяцы.
async function rawReceivedByMonth(pool, from, to) {
  const rows = (await pool.query(
    `SELECT to_char(COALESCE(po.received_at::date, po.delivery_date), 'YYYY-MM') AS m,
            COUNT(DISTINCT po.id) AS orders,
            COALESCE(SUM(COALESCE(i.fact_qty, 0) * i.price), 0) AS total,
            COUNT(*) FILTER (WHERE COALESCE(i.fact_qty, 0) > 0 AND COALESCE(i.price, 0) = 0) AS no_price
       FROM purchase_orders po
       JOIN purchase_order_items i ON i.order_id = po.id
      WHERE po.status = 'received' AND i.item_kind = 'raw'
        AND COALESCE(po.received_at::date, po.delivery_date) BETWEEN $1 AND $2
      GROUP BY 1`, [from, to])).rows;
  return new Map(rows.filter((r) => r.m).map((r) => [r.m, {
    total: num(r.total), orders: Number(r.orders) || 0, no_price: Number(r.no_price) || 0,
  }]));
}

// Себестоимость месяца из двух источников. Чистая функция — проверяется тестом.
// received — { total, orders } из Закупа или undefined; materials — оплаты по
// статьям 10/11 (classifyRows().materials).
function materialsCost(received, materials) {
  const paidBy = (code) => (materials || []).filter((x) => String(x.code) === code).reduce((a, x) => a + num(x.exp), 0);
  // Приёмки берём, только если у них есть СУММА. Заявка принята, но цены не
  // проставлены — это не «сырьё стоило ноль», это незаполненные данные: раньше
  // такой месяц показывал себестоимость 0 и зелёный светофор «данные полные».
  const hasOrders = !!(received && received.orders > 0);
  const fromPurchase = hasOrders && received.total > 0;
  const rawPaid = paidBy(CODE_RAW_PAID);
  const raw = fromPurchase ? received.total : rawPaid;
  const packaging = paidBy(CODE_PACK_PAID);
  // Ни приёмок с ценой, ни оплат за сырьё — себестоимость посчитать не из чего.
  // Ноль тут был бы враньём: прибыль вышла бы равной выручке минус расходы.
  const nothing = !fromPurchase && rawPaid <= 0;
  return {
    raw, packaging, total: nothing ? null : raw + packaging,
    raw_source: fromPurchase ? 'purchase' : (nothing ? null : 'paid'),
    raw_orders: hasOrders ? received.orders : 0,
    // Принятые позиции без цены: на столько сырьё месяца занижено.
    raw_no_price: hasOrders ? (received.no_price || 0) : 0,
    // Приёмки есть, а денег в них нет — цены не проставлены совсем.
    purchase_empty: hasOrders && !(received.total > 0),
    raw_paid: rawPaid,
  };
}

// ---------------------------------------------------------------------------
// Какой товар Калькуляции какому товару SalesDoctor соответствует
// ---------------------------------------------------------------------------
// Шох: «нельзя чтобы всё само било? может по штрих-коду?». Да: руками код
// SalesDoctor вписывать не нужно, связь ищется сама, по очереди:
//   1) код SD вписан в карточке Калькуляции — берём его;
//   2) карточка привязана к готовой продукции — берём код SD оттуда;
//   3) совпал штрих-код карточки и товара SD;
//   4) совпало название — с готовой продукцией или прямо с названием из продаж.
// Название сравниваем «на слух»: без пробелов и знаков, ё=е, сдвоенные буквы
// сжимаем (руколла = руккола = рукола). Цифры не сжимаем, иначе 500 стало бы 50
// и «Айсберг 500 гр» совпал бы с «Айсберг 50 гр».
// Если под одно название подходят ДВА разных товара — связь не угадываем, такой
// товар честно остаётся в списке «не оценено».
// Ключ сравнения названий. Единицы измерения пишут по-разному в SalesDoctor и в
// Калькуляции: «Кинза 250гр» и «Кинза 250г» — один товар, а раньше это были
// «разные» товары, и себестоимость по ним не считалась. Приводим к одному виду:
// 250гр / 250 г / 250 g → 250г, 350 мл → 350мл, 1 шт → 1шт.
const matchKey = (s) => String(s || '').toLowerCase()
  .replace(/ё/g, 'е')
  // Граница слова (\b) с кириллицей не работает — проверяем «дальше не буква» сами.
  .replace(/(\d)\s*(?:кг|kg)(?![a-zа-я])/g, '$1кг')
  .replace(/(\d)\s*(?:грамм\w*|гр|г|g)(?![a-zа-я])/g, '$1г')
  .replace(/(\d)\s*(?:мл|ml)(?![a-zа-я])/g, '$1мл')
  .replace(/(\d)\s*(?:л|l)(?![a-zа-я])/g, '$1л')
  .replace(/(\d)\s*(?:шт\.?|pcs)(?![a-zа-я])/g, '$1шт')
  .replace(/[^a-zа-я0-9]+/g, '')
  .replace(/([a-zа-я])\1+/g, '$1');
const normBarcode = (s) => String(s || '').replace(/\D+/g, '');

// Однозначный указатель ключ → значение: второе совпадение делает ключ спорным.
function uniqueIndex(pairs) {
  const m = new Map();
  for (const [k, v] of pairs) {
    if (!k) continue;
    if (m.has(k) && m.get(k) !== v) { m.set(k, null); continue; }   // null = спорно
    m.set(k, v);
  }
  return m;
}

// products — карточки Калькуляции [{ cost, name, barcode, sd_product_id, finished_good_id }],
// sold — продажи SD [[sd_id, штук, название]], goods — ref_finished_goods.
// Возвращает Map код SD → { cost, name } и статистику, чем именно сшилось.
function linkProducts(products, sold, goods) {
  const sdOfGoodId = new Map();
  const sdOfBarcode = [];
  const sdOfGoodName = [];
  for (const g of goods || []) {
    const sd = String(g.sd_sd_id || '').trim();
    if (!sd) continue;
    sdOfGoodId.set(Number(g.id), sd);
    sdOfBarcode.push([normBarcode(g.barcode), sd]);
    sdOfGoodName.push([matchKey(g.name), sd]);
  }
  const byBarcode = uniqueIndex(sdOfBarcode);
  const byGoodName = uniqueIndex(sdOfGoodName);
  const bySoldName = uniqueIndex((sold || []).map(([sd, , name]) => [matchKey(name), String(sd)]));

  const costBySd = new Map();
  const by = { code: 0, good: 0, barcode: 0, name: 0, ambiguous: 0 };
  for (const p of products) {
    const direct = String(p.sd_product_id || '').trim();
    let sd = null, how = null;
    if (direct) { sd = direct; how = 'code'; }
    else if (p.finished_good_id && sdOfGoodId.has(Number(p.finished_good_id))) { sd = sdOfGoodId.get(Number(p.finished_good_id)); how = 'good'; }
    else {
      const bc = normBarcode(p.barcode);
      const nk = matchKey(p.name);
      const cands = [[byBarcode.get(bc), 'barcode'], [byGoodName.get(nk), 'name'], [bySoldName.get(nk), 'name']];
      // null в указателе — спорное название/штрих-код: не угадываем.
      if (cands.some(([v]) => v === null)) by.ambiguous++;
      const hit = cands.find(([v]) => v);
      if (hit) { sd = hit[0]; how = hit[1]; }
    }
    if (!sd) continue;
    if (!costBySd.has(sd)) { costBySd.set(sd, { cost: p.cost, name: p.name }); by[how]++; }
  }
  return { costBySd, by };
}

// ---------------------------------------------------------------------------
// Плановая себестоимость: сколько материалов ДОЛЖНО было уйти
// ---------------------------------------------------------------------------
// Считается только материальная часть (зелень + упаковка) — ровно то же, что
// меряет склад. Сравнивать полную себестоимость с материальным списанием было
// бы подлогом: в полную входят ещё ФОТ и общезаводские расходы.
async function planCogs(pool, units, sold) {
  if (!(units > 0)) return { units: 0, unit_cost: null, total: null, products: 0, reason: 'Не подтянуто количество отгрузок' };
  const r = await pool.query(
    `SELECT p.name, p.sd_product_id, p.barcode, p.finished_good_id,
            p.net_weight_g, p.raw_price_per_kg, p.raw_cost, p.pack_template_id, p.recipe_id
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

  // Материальная стоимость одной единицы каждого товара Калькуляции.
  let sum = 0, counted = 0, skipped = 0;
  const costed = [];
  for (const p of r.rows) {
    const weight = p.net_weight_g === null ? null : Number(p.net_weight_g);
    const perKg = p.raw_price_per_kg === null ? null : Number(p.raw_price_per_kg);
    const green = p.recipe_id
      ? (recTotal.has(p.recipe_id) ? recTotal.get(p.recipe_id) : null)
      : ((weight !== null && perKg !== null) ? (weight / 1000) * perKg
        : (p.raw_cost === null ? null : Number(p.raw_cost)));
    const pack = p.pack_template_id ? (tplTotal.get(p.pack_template_id) || null) : null;
    if (green === null && pack === null) { skipped++; continue; }
    const cost = (green || 0) + (pack || 0);
    sum += cost;
    counted++;
    costed.push({ cost, name: p.name, barcode: p.barcode, sd_product_id: p.sd_product_id, finished_good_id: p.finished_good_id });
  }
  if (!counted) return { units, unit_cost: null, total: null, products: 0, skipped, reason: 'У товаров не заполнены зелень и упаковка' };

  // Решение Шоха (сентябрь 2026): план считается ПО АССОРТИМЕНТУ — штуки каждого
  // товара из SalesDoctor × его себестоимость из Калькуляции. Раньше бралась
  // «средняя пачка» по всем карточкам, и товар с одной продажей весил столько
  // же, сколько самый ходовой (аудит A11). Товары, которых нет в Калькуляции
  // (не заполнен код SD), в сумму не попадают и показываются отдельно.
  if (Array.isArray(sold) && sold.length) {
    // Связь товаров ищется сама: код SD → готовая продукция → штрих-код → название.
    const goods = (await pool.query(
      "SELECT id, name, barcode, sd_sd_id FROM ref_finished_goods WHERE COALESCE(sd_sd_id, '') <> ''")).rows;
    const { costBySd, by } = linkProducts(costed, sold, goods);
    let total = 0, matchedUnits = 0;
    const unmatched = [];
    for (const [sd, qty, name] of sold) {
      const q = Number(qty) || 0;
      if (q <= 0) continue;
      const hit = costBySd.get(String(sd));
      if (!hit) { unmatched.push({ sd_id: String(sd), name: name || String(sd), units: q }); continue; }
      total += q * hit.cost;
      matchedUnits += q;
    }
    unmatched.sort((a, b) => b.units - a.units);
    const unmatchedUnits = unmatched.reduce((acc, x) => acc + x.units, 0);
    return {
      units, total, method: 'assortment',
      unit_cost: matchedUnits > 0 ? total / matchedUnits : null,
      products: counted, skipped, linked_by: by,
      matched_units: matchedUnits, unmatched_units: unmatchedUnits, unmatched,
      reason: null,
    };
  }

  // Разбивки по товарам нет (старые месяцы, подтянутые до этой правки) —
  // считаем как раньше, средней карточкой, и честно это называем.
  const unitCost = sum / counted;
  return { units, unit_cost: unitCost, total: unitCost * units, products: counted, skipped, method: 'average', reason: null };
}

// ---------------------------------------------------------------------------
// Проверка отчёта: почему прибыль может быть не такой, как на самом деле
// ---------------------------------------------------------------------------
// Шох: «не может быть 642 млн прибыли за август». Отчёт складывается из трёх
// источников (реализация SD, склад, Касса), и каждый может быть неполным. Молча
// показывать красивую прибыль нельзя — считаем те же цифры ещё раз «с другой
// стороны» и показываем, на сколько прибыль могла бы отличаться.
//
// Чистая функция: на вход уже посчитанные блоки, на выход список проверок.
// Ничего не меняет в самой прибыли — решение о формуле принимает Шох.
const SALARY_CODES = new Set(['20', '40']);                // ЗП производства и офиса

function selfCheck({ revenue, cogs, opexTotal, operating, fact, plan, waste, writeoff, cash }) {
  const checks = [];
  const add = (key, text, amount, profitIf) => checks.push({ key, text, amount, profit_if: profitIf });

  // Налоги, комиссии банка, отход и списания раньше тоже были здесь — теперь они
  // в самой формуле прибыли (решение Шоха), проверять их отдельно не нужно.

  // Склад и Калькуляция на прибыль больше не влияют (сырьё берётся из Закупа) —
  // их полнота видна в таблице «Готовность данных», а здесь только то, что
  // действительно меняет прибыль.

  // 5. В расходах месяца нет зарплаты — значит, месяц неполный.
  const opexItems = [].concat(...((cash.opex && cash.opex.groups) || []).map((g) => g.items || []));
  const salary = opexItems.filter((x) => SALARY_CODES.has(String(x.code))).reduce((a, x) => a + num(x.exp), 0);
  if (!salary && opexTotal > 0) {
    add('no_salary', 'В расходах месяца нет ни одной выплаты зарплаты. Либо зарплата за этот месяц выплачена '
      + 'в следующем (расходы считаются по дате оплаты), либо выплаты не попали в Кассу.', 0, null);
  }

  // 6. Деньги без статьи: пока не разнесены, расходы занижены.
  const un = (cash.unclassified && num(cash.unclassified.exp)) || 0;
  if (un > 0 && operating !== null) {
    add('unclassified', `Расходов без статьи: ${Math.round(un / 1e6)} млн. В прибыль они не попали.`,
      un, operating - un);
  }

  // Итог «если учесть всё»: пока это только расходы без статьи.
  const byKey = Object.fromEntries(checks.map((c) => [c.key, c]));
  const totalGap = byKey.unclassified ? byKey.unclassified.amount : 0;
  return {
    items: checks,
    total_gap: totalGap,
    profit_if_all: operating === null ? null : operating - totalGap,
    revenue,
  };
}

// ---------------------------------------------------------------------------
// Готовность данных месяца: можно ли верить прибыли
// ---------------------------------------------------------------------------
// Шох: «механика везде должна быть одной и той же». Формула и так одна для всех
// месяцев — отличается только полнота данных. Поэтому каждый месяц проходит один
// и тот же набор проверок, и по нему видно, где прибыль честная, а где нет.
// Чистая функция: на вход готовый отчёт buildPnl, на выход светофор.
function monthReadiness(r) {
  const checks = [];
  const add = (key, label, level, note) => checks.push({ key, label, level, note });
  const mln = (v) => Math.round((Number(v) || 0) / 1e6) + ' млн';

  // 0. Месяц ещё идёт: зарплату за него платят в следующем, часть расходов
  // ещё впереди — прибыль текущего месяца всегда выглядит лучше настоящей.
  const nowMonth = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7);
  if (r.period >= nowMonth) add('open', 'Месяц закончился', 'warn', 'ещё идёт — зарплата и часть расходов будут позже, прибыль завышена');
  else add('open', 'Месяц закончился', 'ok', 'да');

  // 1. Продажи из SalesDoctor.
  if (r.revenue.source === 'shipped' && !(r.revenue.total > 0) && r.revenue.cash_in > 0) {
    add('sales', 'Продажи из SalesDoctor', 'bad', 'сохранён ноль, хотя деньги от клиентов пришли — обновится ночью или кнопкой');
  } else if (r.revenue.source === 'shipped') add('sales', 'Продажи из SalesDoctor', 'ok', mln(r.revenue.total));
  else add('sales', 'Продажи из SalesDoctor', 'bad', 'не подтянуты — выручка взята по деньгам');

  // 2. Сырьё: из Закупа (точно) или по оплатам (приблизительно).
  // Зелёным — только когда у ВСЕХ принятых позиций есть цена. Принятая заявка
  // без цены молча занижает себестоимость, а месяц при этом выглядел «полным».
  const parts = r.cogs_parts || {};
  if (parts.purchase_empty) {
    add('raw', 'Сырьё из Закупа', 'bad', `заявок ${parts.raw_orders}, но цен в них нет — сырьё взято по оплатам ${mln(parts.raw)}`);
  } else if (parts.raw_source === 'purchase' && parts.raw_no_price > 0) {
    add('raw', 'Сырьё из Закупа', 'warn', `${mln(parts.raw)}, заявок ${parts.raw_orders}; ${parts.raw_no_price} позиций без цены — сырьё занижено`);
  } else if (parts.raw_source === 'purchase') {
    add('raw', 'Сырьё из Закупа', 'ok', `${mln(parts.raw)}, заявок ${parts.raw_orders}`);
  } else if (parts.raw_source === 'paid') {
    add('raw', 'Сырьё из Закупа', 'warn', `приёмок нет — по оплатам ${mln(parts.raw)}`);
  } else {
    add('raw', 'Сырьё из Закупа', 'bad', 'ни приёмок, ни оплат поставщикам — себестоимости нет');
  }

  // 5. Зарплата в расходах месяца.
  const noSalary = ((r.self_check && r.self_check.items) || []).some((x) => x.key === 'no_salary');
  add('salary', 'Зарплата в расходах', noSalary ? 'bad' : 'ok', noSalary ? 'выплат нет' : 'есть');

  // 6. Все деньги разнесены по статьям.
  const un = r.excluded && r.excluded.unclassified;
  if (un && un.cnt) add('unclassified', 'Операции без статьи', 'bad', `${un.cnt} шт на ${mln(un.exp)} расходов`);
  else add('unclassified', 'Операции без статьи', 'ok', 'нет');

  // Контроль склада — на прибыль не влияет (уровень info), но показывает, что
  // кладовщики не отметили: сколько принятого сырья ушло в выдачи, отход, потери.
  const sc = r.stock_control || {};
  if (sc.received > 0) {
    const covered = (sc.issued_raw || 0) + (sc.waste || 0) + (sc.writeoff || 0);
    const share = Math.round((covered / sc.received) * 100);
    add('stock', 'Склад: отмечено из принятого', 'info', `${share}% (выдано ${mln(sc.issued_raw)}, отход ${mln(sc.waste)}, потери ${mln(sc.writeoff)})`);
  } else add('stock', 'Склад: отмечено из принятого', 'info', 'приёмок в Закупе нет');

  const bad = checks.filter((c) => c.level === 'bad').length;
  const warn = checks.filter((c) => c.level === 'warn').length;
  const verdict = bad ? 'bad' : (warn ? 'warn' : 'ok');
  return {
    period: r.period,
    verdict,
    verdict_text: verdict === 'ok' ? 'данные полные — прибыли можно верить'
      : (verdict === 'warn' ? 'данные неполные — прибыль приблизительная' : 'данных не хватает — прибыли верить нельзя'),
    revenue: r.revenue.total,
    net_profit: r.net_profit === undefined ? null : r.net_profit,
    margin_pct: r.net_margin_pct === undefined ? null : r.net_margin_pct,
    closed: !!r.snapshot_at,
    checks,
  };
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
    [[UNITS_KEY(period), UNITS_KEY(period) + '_at', SALES_KEY(period), SKU_KEY(period)]])).rows;
  const byKey = new Map(st.map((x) => [x.key, x.value]));
  const units = Number(byKey.get(UNITS_KEY(period))) || 0;
  const unitsAt = byKey.get(UNITS_KEY(period) + '_at') || '';
  // Загружена ли реализация вообще — отдельно от её суммы. Ноль продаж из SD — это
  // честный ноль, а не «данных нет»: подменять его поступлениями денег нельзя, иначе
  // оплата старых долгов превращается в выручку месяца без продаж (аудит A10).
  const shippedLoaded = salesLoaded(byKey.get(SALES_KEY(period)));
  const shipped = shippedLoaded ? Number(byKey.get(SALES_KEY(period))) : 0;
  let sold = null;                       // продажи по товарам: [[sd_id, штук, название], …]
  try { const raw = byKey.get(SKU_KEY(period)); if (raw) sold = JSON.parse(raw); } catch (e) { sold = null; }

  const priceOf = (await monthlyPriceMaps(pool, period, period)).get(period) || new Map();
  const [cash, fact, plan, adjust, waste, writeoff, receivedMap] = await Promise.all([
    cashSide(pool, from, toStr),
    factCogs(pool, from, toStr, priceOf),
    planCogs(pool, units, sold),
    stockAdjustments(pool, from, toStr),
    wasteCost(pool, from, toStr, priceOf),
    writeoffCost(pool, from, toStr, priceOf),
    rawReceivedByMonth(pool, from, toStr),
  ]);

  // ВЫРУЧКА В P&L = РЕАЛИЗАЦИЯ (отгружено за месяц по SalesDoctor).
  // Поступления денег остаются в отчёте, но как справка: это Кэш-флоу.
  // Разница между ними — то, что отгрузили и ещё не получили (отсрочка).
  const cashIn = cash.revenue.total;
  const revenue = shippedLoaded ? shipped : cashIn;
  const revenueSource = shippedLoaded ? 'shipped' : 'cash';
  // Себестоимость: сырьё, принятое за месяц в Закупе (или оплаченное, если Закупа
  // ещё не было), + упаковка, оплаченная за месяц. Склад — только контроль.
  const mc = materialsCost(receivedMap.get(period), cash.materials_paid.items);
  const cogsSource = mc.raw_source;
  const cogs = mc.total;
  const gross = cogs === null ? null : revenue - cogs;
  const operating = gross === null ? null : gross - cash.opex.total;
  // Проценты по кредитам и налог на прибыль — после операционной прибыли,
  // по дате оплаты. Операционную прибыль они не трогают: она про работу
  // компании, а это цена заёмных денег и расчёт с государством.
  const profitTax = num(cash.profit_tax.total);
  const interest = num(cash.interest.total);
  const net = operating === null ? null : operating - interest - profitTax;

  // Честные предупреждения: пусть человек видит, чему верить нельзя.
  // Каждое — не только «что не так», но и куда идти исправлять: ссылка на нужную
  // плитку (href) или переход на вкладку внутри Кассы (go), плюс полный список
  // позиций (items), чтобы не выписывать их из текста руками.
  const warnings = [];
  if (cogsSource === null) {
    warnings.push('За месяц нет ни принятых заявок в Закупе, ни оплат поставщикам сырья — себестоимость и прибыль посчитать не из чего.');
  }
  if (mc.raw_no_price) {
    warnings.push({
      text: `В Закупе ${mc.raw_no_price} принятых позиций сырья без цены — сырьё за месяц занижено на их стоимость.`,
      href: '/purchase#noprice', label: 'Внести цены',
    });
  }
  if (mc.purchase_empty) {
    warnings.push({
      text: `За месяц принято заявок: ${mc.raw_orders}, но цен в них нет ни одной — сырьё по приёмкам посчитать не из чего.`
        + (mc.raw_paid > 0 ? ' Взята оплата поставщикам (статья 10), это приблизительно.' : ''),
      href: '/purchase#noprice', label: 'Внести цены',
    });
  }
  if (cogsSource === 'paid') {
    warnings.push('В этом месяце в Закупе нет принятых заявок на сырьё — сырьё посчитано по оплатам поставщикам (статья 10). '
      + 'Это приблизительно: оплата и поставка могут приходиться на разные месяцы.');
  }
  if (cash.unclassified.cnt) {
    warnings.push({
      text: 'Операций без статьи: ' + cash.unclassified.cnt + '. Пока они не разнесены, отчёт неполный.',
      go: 'triage', label: 'Разнести операции',
    });
  }
  if (!units) warnings.push('Количество отгрузок за месяц не подтянуто — плановая себестоимость не посчитана.');
  if (revenueSource === 'cash') {
    warnings.push('Выручка считается по ПОСТУПЛЕНИЮ ДЕНЕГ — реализация из SalesDoctor не подтянута. '
      + 'При отсрочке платежа это занижает выручку и даёт мнимый убыток. Нажмите «обновить» внизу.');
  }

  return {
    period, from, to: toStr,
    revenue: {
      ...cash.revenue,
      // total — то, что реально идёт в прибыль
      total: revenue,
      source: revenueSource,
      shipped,                 // реализация из SalesDoctor
      cash_in: cashIn,         // поступило денег (как в Кэш-флоу)
      // Отгрузили, но денег ещё не получили. При отсрочке это норма,
      // но если растёт месяц к месяцу — деньги зависают у клиентов.
      receivable: shippedLoaded ? shipped - cashIn : null,
    },
    cogs: {
      fact,
      plan,
      // Расхождение считаем только когда есть обе цифры, иначе это не сравнение.
      diff: (fact.has_data && plan.total !== null) ? fact.total - plan.total : null,
      diff_pct: (fact.has_data && plan.total > 0) ? pct(fact.total - plan.total, plan.total) : null,
    },
    cogs_source: cogsSource,
    // Себестоимость целиком и из чего она сложилась. Экран, график и Excel берут
    // ЭТУ цифру, а не собирают свою.
    cogs_total: cogs,
    cogs_parts: {
      raw: mc.raw, packaging: mc.packaging, raw_source: mc.raw_source, raw_orders: mc.raw_orders,
      raw_paid: mc.raw_paid, raw_no_price: mc.raw_no_price, purchase_empty: mc.purchase_empty,
    },
    // Контроль склада — на прибыль не влияет: сколько из принятого сырья склад
    // отметил выданным в производство, отходом и потерями.
    stock_control: {
      issued: fact.has_data ? fact.total : 0,
      issued_raw: fact.has_data ? fact.raw : 0,
      waste: num(waste.amount),
      writeoff: num(writeoff.amount),
      received: mc.raw_source === 'purchase' ? mc.raw : null,
    },
    gross_profit: gross,
    gross_margin_pct: gross === null ? null : pct(gross, revenue),
    opex: cash.opex,
    operating_profit: operating,
    operating_margin_pct: operating === null ? null : pct(operating, revenue),
    profit_tax: cash.profit_tax,
    interest: cash.interest,
    net_profit: net,
    net_margin_pct: net === null ? null : pct(net, revenue),
    reconcile: cash.reconcile,
    // Самопроверка: из-за чего прибыль в отчёте может быть выше настоящей.
    self_check: selfCheck({
      revenue, cogs, opexTotal: cash.opex.total, operating, fact, plan, waste, writeoff, cash,
    }),
    stock_adjust: adjust,
    // Показатели из отчёта финансиста: сколько копеек с сума выручки съедают
    // сырьё и отходы. Считаем от выручки ОТ ПРОДАЖ — от той же цифры, что
    // в Кэш-флоу, иначе процент не с чем будет сверить.
    waste,
    // Потери по статьям списания — строкой рядом с отходами.
    writeoff,
    ratios: {
      // Считаем от той же выручки, что и прибыль: иначе проценты и итог
      // будут про разные величины.
      base: revenue,
      base_source: revenueSource,
      raw_load_pct: pct(mc.raw, revenue),
      waste_pct: pct(waste.amount, revenue),
      writeoff_pct: pct(writeoff.amount, revenue),
      pack_pct: pct(mc.packaging, revenue),
      opex_pct: pct(cash.opex.total, revenue),
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


// Сохранить снимок отчёта за месяц (вызывается при закрытии месяца в Кассе).
async function saveSnapshot(pool, period) {
  const report = await buildPnl(pool, period);
  const snap = { ...report, snapshot_at: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [SNAP_KEY(period), JSON.stringify(snap)]);
  return snap;
}

// Снимок закрытого месяца, если он есть. Возвращает объект отчёта или null.
async function loadSnapshot(pool, period) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [SNAP_KEY(period)]);
    if (!r.rows.length) return null;
    const snap = JSON.parse(r.rows[0].value);
    return snap && typeof snap === 'object' ? snap : null;
  } catch (e) { return null; }
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
  // Цены — по месяцу списания, ровно как в карточке месяца.
  const firstMonth = bounds.f.slice(0, 7);
  const priceMaps = await monthlyPriceMaps(pool, firstMonth, endPeriod);

  // Раскладываем по месяцам
  const byMonth = new Map();
  const monthOf = (m) => {
    if (!byMonth.has(m)) byMonth.set(m, { period: m, rows: [], cogs: 0, cogs_known: false });
    return byMonth.get(m);
  };
  // Реализация по месяцам — та же, что в месячном отчёте: подтянутая кнопкой
  // и сохранённая. Где её нет, на графике честно берём поступления денег.
  const salesRows = (await pool.query(
    "SELECT key, value FROM settings WHERE key LIKE 'pnl_sales_%'")).rows;
  const shippedOf = new Map(salesRows.filter((x) => salesLoaded(x.value)).map((x) => [String(x.key).replace('pnl_sales_', ''), Number(x.value)]));
  cashRows.forEach((r) => monthOf(r.m).rows.push(r));
  usedRows.forEach((u) => {
    const slot = monthOf(u.m);
    const price = (priceMaps.get(u.m) || new Map()).get(u.item_kind + '#' + u.item_id);
    if (price === undefined) return;          // без цены прихода не оцениваем
    slot.cogs += (Number(u.qty) || 0) * price;
    slot.cogs_known = true;
  });

  // Сырьё из Закупа по месяцам — та же себестоимость, что в карточке месяца.
  const receivedOf = await rawReceivedByMonth(pool, bounds.f, bounds.t);

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
    const cogs = materialsCost(receivedOf.get(key), c.materials).total;
    const shippedLoadedM = shippedOf.has(key);
    const rev = shippedLoadedM ? shippedOf.get(key) : c.revenueTotal;
    out.push({
      period: key,
      revenue: rev,
      revenue_source: shippedLoadedM ? 'shipped' : 'cash',
      cogs,
      opex: c.opexTotal,
      profit: cogs === null ? null : rev - cogs - c.opexTotal,
    });
  }
  return { months: n, from: bounds.f, to: bounds.t, points: out };
}

module.exports = { buildPnl, buildTrend, UNITS_KEY, SALES_KEY, SKU_KEY, SNAP_KEY, planCogs, saveSnapshot, loadSnapshot, linkProducts, matchKey, selfCheck, monthReadiness, materialsCost };
// Открыто для Склада: списания оцениваются ТОЙ ЖЕ ценой, что себестоимость в
// P&L, иначе отчёт о потерях и P&L покажут разные деньги за одно и то же.
module.exports.monthlyPriceMaps = monthlyPriceMaps;
// Открыто для тестов: разнесение списаний по группам решает, какие деньги
// станут потерями компании, а какие — счётом поставщику.
module.exports.writeoffCost = writeoffCost;
