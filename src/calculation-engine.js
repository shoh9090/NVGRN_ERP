// calculation-engine.js — ЕДИНЫЙ расчётный двигатель себестоимости (ТЗ раздел 14).
//
// Правила модуля (важно соблюдать при любых правках):
//  • Только чистые формулы. Никаких запросов к БД, проверок прав и уведомлений.
//  • Входной объект НЕ изменяется (см. тест «неизменность исходного объекта»).
//  • Промежуточные значения не округляются — округление только последним действием.
//  • Один и тот же снимок всегда даёт один и тот же результат.
//
// Этот же модуль обязаны использовать веб, тесты и будущий Telegram-бот.
// Дублировать формулы в браузере или в боте запрещено.

const FORMULA_VERSION = 'v1';

// Порог «устаревшей» цены (ТЗ 23.3): предупреждение, не блокировка.
const STALE_PRICE_DAYS = 30;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
// Округление вверх до шага (для коммерческой цены). Шаг <= 0 — не округляем.
const ceilTo = (value, step) => {
  const s = num(step);
  if (!(s > 0)) return value;
  return Math.ceil(value / s) * s;
};
const daysBetween = (fromIso, toIso) => {
  const a = new Date(fromIso), b = new Date(toIso);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.floor((b - a) / 86400000);
};

// ---------------------------------------------------------------------------
// Строки рецептуры
// ---------------------------------------------------------------------------
// ТЗ 14.1 (сырьё) и 14.2 (упаковка). Формула потерь применяется единообразно:
// при loss_rate = 0 она ничего не меняет, поэтому упаковка считается тем же кодом.
function calcRecipeRow(row, batchOutputQty, ctx) {
  const errors = [];
  const warnings = [];
  const qtyNet = num(row.qty_net);
  const lossRate = num(row.loss_rate);
  const label = row.name || (row.item_kind === 'packaging' ? 'элемент упаковки' : 'сырьё');

  if (!(qtyNet > 0)) errors.push({ code: 'QTY_NOT_POSITIVE', message: `«${label}»: количество должно быть больше нуля.` });
  if (lossRate < 0) errors.push({ code: 'LOSS_NEGATIVE', message: `«${label}»: технологические потери не могут быть отрицательными.` });
  if (lossRate >= 100) errors.push({ code: 'LOSS_TOO_BIG', message: `«${label}»: потери ${lossRate}% — 100% и больше недопустимо.` });

  const qtyPerUnit = batchOutputQty > 0 ? qtyNet / batchOutputQty : 0;
  const lossCoef = lossRate / 100;
  const qtyWithLoss = lossCoef < 1 ? qtyPerUnit / (1 - lossCoef) : 0;

  // Цена: отсутствие цены НЕ превращается в ноль (ТЗ 8.3).
  const hasPrice = row.price !== null && row.price !== undefined && row.price !== '' && num(row.price) > 0;
  const price = hasPrice ? num(row.price) : null;
  if (!hasPrice) {
    errors.push({ code: 'PRICE_MISSING', message: `«${label}»: нет закупочной цены. Утверждение невозможно.` });
  } else if (row.price_date && ctx && ctx.today) {
    const age = daysBetween(row.price_date, ctx.today);
    if (age !== null && age > STALE_PRICE_DAYS) {
      warnings.push({ code: 'PRICE_STALE', message: `«${label}»: цена старше ${STALE_PRICE_DAYS} дней (${age} дн.).` });
    }
  }
  if (row.price_carried_from_previous) {
    warnings.push({ code: 'PRICE_CARRIED', message: `«${label}»: цена перенесена из предыдущей закупки.` });
  }
  if (row.is_model_only) {
    warnings.push({ code: 'MODEL_COMPONENT', message: `«${label}»: временный модельный компонент — в утверждённую версию попасть не может.` });
  }

  const cost = hasPrice ? qtyWithLoss * price : null;
  return {
    item_kind: row.item_kind === 'packaging' ? 'packaging' : 'raw',
    item_id: row.item_id ?? null,
    name: row.name || '',
    code: row.code || '',
    unit: row.unit || '',
    qty_net: qtyNet,
    qty_net_per_unit: qtyPerUnit,
    loss_rate: lossRate,
    qty_with_loss: qtyWithLoss,
    price,
    price_unit: row.price_unit || row.unit || '',
    price_date: row.price_date || null,
    price_source: row.price_source || null,
    price_missing: !hasPrice,
    is_model_price: !!row.is_model_price,
    cost,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// ФОТ на единицу (ТЗ 14.3)
// ---------------------------------------------------------------------------
// Все четыре части показываются отдельно, ничего не прячется в итоге.
function calcFotPerUnit(fot, totalOutput) {
  const accrued = num(fot && fot.accrued);
  const inps = num(fot && fot.inps);
  const ndfl = num(fot && fot.ndfl);
  const social = num(fot && fot.social);
  const total = accrued + inps + ndfl + social;
  const out = num(totalOutput);
  return {
    accrued, inps, ndfl, social,
    total_load: total,
    total_output: out,
    // Деление на ноль запрещено: возвращаем null, вызывающий код выдаёт блокирующую ошибку.
    per_unit: out > 0 ? total / out : null,
  };
}

// Затраты на единицу: сумма за месяц / выпуск.
// Деление на ноль запрещено — возвращаем null, а не ноль (ТЗ 8.5, 23.1).
function perUnit(amount, output) {
  const out = num(output);
  return out > 0 ? num(amount) / out : null;
}

// Распределённые расходы на единицу (ТЗ 14.4) — поровну на произведённую единицу.
const OVERHEAD_KEYS = ['production', 'admin', 'commercial', 'logistics', 'finance'];
function calcOverheadsPerUnit(monthly, totalOutput) {
  const out = num(totalOutput);
  const res = {};
  for (const k of OVERHEAD_KEYS) {
    const sum = num(monthly && monthly[k]);
    res[k] = { monthly: sum, per_unit: out > 0 ? sum / out : null };
  }
  return res;
}

// ---------------------------------------------------------------------------
// НДС (ТЗ 14.6)
// ---------------------------------------------------------------------------
function calcVat(price, vatRate, includesVat) {
  const p = num(price), r = num(vatRate);
  if (includesVat) {
    const vat = r > 0 ? (p * r) / (100 + r) : 0;
    return { includes_vat: true, vat_rate: r, vat, revenue_net: p - vat, invoice_price: p };
  }
  const vat = (p * r) / 100;
  return { includes_vat: false, vat_rate: r, vat, revenue_net: p, invoice_price: p + vat };
}

// ---------------------------------------------------------------------------
// Рекомендуемая цена (ТЗ 14.8)
// ---------------------------------------------------------------------------
// goal: keep_margin (по умолчанию) | keep_profit | target_margin | markup
function recommendPrice(opts) {
  const fullCost = num(opts.full_cost);
  const vatShare = opts.includes_vat && num(opts.vat_rate) > 0 ? num(opts.vat_rate) / (100 + num(opts.vat_rate)) : 0;
  const retroShare = num(opts.retro_rate) / 100;
  const taxRate = num(opts.profit_tax_rate) / 100;
  const goal = opts.goal || 'keep_margin';
  const step = num(opts.round_step);

  const fail = (message) => ({ goal, price: null, price_before_round: null, error: message });

  if (goal === 'markup') {
    const m = num(opts.markup_rate);
    const raw = fullCost * (1 + m / 100);
    return { goal, markup_rate: m, price_before_round: raw, price: ceilTo(raw, step), error: null };
  }

  if (goal === 'keep_profit') {
    // Из net = (P×(1 − НДС − ретро) − себестоимость) × (1 − налог)
    const denom = 1 - vatShare - retroShare;
    if (!(denom > 0)) return fail('Удержания (НДС и ретро) забирают всю цену — цену рассчитать нельзя.');
    if (!(1 - taxRate > 0)) return fail('Ставка налога на прибыль 100% и выше — цену рассчитать нельзя.');
    const targetNet = num(opts.target_net_profit);
    const raw = (targetNet / (1 - taxRate) + fullCost) / denom;
    return { goal, target_net_profit: targetNet, price_before_round: raw, price: ceilTo(raw, step), error: null };
  }

  // keep_margin / target_margin — обе через целевую долю чистой маржи.
  const targetMargin = num(goal === 'keep_margin' ? opts.current_net_margin : opts.target_margin) / 100;
  if (!(1 - taxRate > 0)) return fail('Ставка налога на прибыль 100% и выше — цену рассчитать нельзя.');
  const denom = 1 - vatShare - retroShare - targetMargin / (1 - taxRate);
  if (!(denom > 0)) {
    return fail('Целевая маржа недостижима при заданных НДС, ретро и налоге: удержания превышают цену.');
  }
  const raw = fullCost / denom;
  return {
    goal,
    target_margin: targetMargin * 100,
    price_before_round: raw,
    price: ceilTo(raw, step),
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Полный расчёт одного изделия
// ---------------------------------------------------------------------------
function calculateProduct(input) {
  const errors = [];   // блокирующие (ТЗ 23.1)
  const warnings = []; // не всегда блокирующие (ТЗ 23.2)
  const ctx = { today: (input && input.today) || new Date().toISOString().slice(0, 10) };

  const recipe = (input && input.recipe) || {};
  const items = Array.isArray(recipe.items) ? recipe.items : [];
  const batchOutputQty = num(recipe.batch_output_qty) || 1;
  if (!(num(recipe.batch_output_qty) > 0)) {
    warnings.push({ code: 'BATCH_DEFAULTED', message: 'Выход рецептуры не указан — расчёт выполнен на 1 единицу.' });
  }
  if (!items.length) errors.push({ code: 'RECIPE_EMPTY', message: 'Рецептура пуста: добавьте хотя бы один компонент.' });

  const rows = items.map((r) => calcRecipeRow(r, batchOutputQty, ctx));
  rows.forEach((r) => { errors.push(...r.errors); warnings.push(...r.warnings); });

  const sumCost = (kind) => rows
    .filter((r) => r.item_kind === kind && r.cost !== null)
    .reduce((a, r) => a + r.cost, 0);
  const rawCost = sumCost('raw');
  const packagingCost = sumCost('packaging');

  // ФОТ и накладные
  const totalOutput = num(input && input.total_output);
  const fot = calcFotPerUnit(input && input.fot, totalOutput);
  const overheads = calcOverheadsPerUnit((input && input.monthly_expenses) || {}, totalOutput);
  if (!(totalOutput > 0)) {
    errors.push({ code: 'OUTPUT_ZERO', message: 'Общий выпуск равен нулю: ФОТ и накладные распределить нельзя.' });
  }

  const per = (k) => num(overheads[k] && overheads[k].per_unit);
  const fotPerUnit = num(fot.per_unit);

  // Слои себестоимости (ТЗ 14.5)
  const productionCost = rawCost + packagingCost + fotPerUnit + per('production');
  const costBeforeReserve = productionCost + per('admin');
  const com = (input && input.commercial) || {};
  const wasteReserveRate = num(com.waste_reserve_rate);
  const costWithReserve = costBeforeReserve * (1 + wasteReserveRate / 100);
  const fullCost = costWithReserve + per('commercial') + per('logistics') + per('finance');

  // Коммерческая часть (ТЗ 14.6–14.7)
  const price = num(com.price);
  const includesVat = com.price_includes_vat === undefined ? true : !!com.price_includes_vat;
  const vat = calcVat(price, com.vat_rate, includesVat);
  const retro = (price * num(com.retro_rate)) / 100;
  const profitBeforeTax = vat.revenue_net - retro - fullCost;
  const profitTaxRate = num(com.profit_tax_rate);
  const profitTax = (Math.max(profitBeforeTax, 0) * profitTaxRate) / 100;
  const netProfit = profitBeforeTax - profitTax;
  const netMargin = price > 0 ? (netProfit / price) * 100 : null;
  const markup = fullCost > 0 ? (price / fullCost - 1) * 100 : null;

  if (!(price > 0)) {
    errors.push({ code: 'PRICE_NOT_POSITIVE', message: 'Цена продажи должна быть положительной (обязательно для утверждения).' });
  }
  if (profitBeforeTax < 0) {
    warnings.push({ code: 'PROFIT_NEGATIVE', message: 'Прибыль отрицательная: цена ниже полной себестоимости с удержаниями.' });
  }
  const targetMargin = com.target_margin_rate === null || com.target_margin_rate === undefined ? null : num(com.target_margin_rate);
  if (targetMargin !== null && netMargin !== null && netMargin < targetMargin) {
    warnings.push({ code: 'MARGIN_BELOW_TARGET', message: `Чистая маржа ${netMargin.toFixed(1)}% ниже целевой ${targetMargin}%.` });
  }

  // Рекомендуемая цена
  const recommended = recommendPrice({
    full_cost: fullCost,
    includes_vat: includesVat,
    vat_rate: com.vat_rate,
    retro_rate: com.retro_rate,
    profit_tax_rate: profitTaxRate,
    goal: com.recommend_goal || 'keep_margin',
    current_net_margin: netMargin === null ? 0 : netMargin,
    target_margin: com.target_margin_rate,
    target_net_profit: com.target_net_profit === undefined ? netProfit : com.target_net_profit,
    markup_rate: com.target_markup_rate,
    round_step: com.price_round_step === undefined ? 500 : com.price_round_step,
  });

  return {
    formula_version: FORMULA_VERSION,
    inputs: {
      batch_output_qty: batchOutputQty,
      total_output: totalOutput,
      commercial: {
        price, price_includes_vat: includesVat, vat_rate: num(com.vat_rate),
        retro_rate: num(com.retro_rate), profit_tax_rate: profitTaxRate,
        waste_reserve_rate: wasteReserveRate, target_margin_rate: targetMargin,
        price_round_step: com.price_round_step === undefined ? 500 : num(com.price_round_step),
        recommend_goal: com.recommend_goal || 'keep_margin',
      },
    },
    rows,
    fot,
    overheads,
    layers: {
      raw: rawCost,
      packaging: packagingCost,
      fot_per_unit: fotPerUnit,
      production_per_unit: per('production'),
      production_cost: productionCost,
      admin_per_unit: per('admin'),
      cost_before_reserve: costBeforeReserve,
      waste_reserve_rate: wasteReserveRate,
      cost_with_reserve: costWithReserve,
      commercial_per_unit: per('commercial'),
      logistics_per_unit: per('logistics'),
      finance_per_unit: per('finance'),
      full_cost: fullCost,
    },
    commercial: {
      price,
      includes_vat: includesVat,
      vat: vat.vat,
      revenue_net: vat.revenue_net,
      invoice_price: vat.invoice_price,
      retro,
      profit_before_tax: profitBeforeTax,
      profit_tax: profitTax,
      net_profit: netProfit,
      net_margin: netMargin,
      markup,
    },
    recommended,
    warnings,
    errors,
    can_approve: errors.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Сценарий дефицита и срочной закупки (ТЗ 15)
// ---------------------------------------------------------------------------
function calcShortage(input) {
  const planned = num(input && input.planned_qty);
  const available = num(input && input.available_qty);
  const basePrice = num(input && input.base_price);
  const urgentQty = input && input.urgent_qty !== undefined ? num(input.urgent_qty) : Math.max(planned - available, 0);
  const urgentPrice = num(input && input.urgent_price);
  const errors = [];
  if (!(planned > 0)) errors.push({ code: 'PLANNED_NOT_POSITIVE', message: 'Плановое количество должно быть больше нуля.' });
  if (available < 0) errors.push({ code: 'AVAILABLE_NEGATIVE', message: 'Доступное количество не может быть отрицательным.' });

  const shortage = Math.max(planned - available, 0);
  const totalQty = available + urgentQty;
  const blendedPrice = totalQty > 0 ? (available * basePrice + urgentQty * urgentPrice) / totalQty : null;
  const extraCost = urgentQty * (urgentPrice - basePrice);
  return {
    formula_version: FORMULA_VERSION,
    planned_qty: planned,
    available_qty: available,
    shortage_qty: shortage,
    urgent_qty: urgentQty,
    base_price: basePrice,
    urgent_price: urgentPrice,
    total_qty: totalQty,
    blended_price: blendedPrice,
    extra_cost: extraCost,
    errors,
  };
}

// Средневзвешенная цена принятых поставок (ТЗ 8.4).
// Нулевые и отрицательные количества/цены не участвуют.
function weightedAveragePrice(deliveries) {
  const list = Array.isArray(deliveries) ? deliveries : [];
  let qtySum = 0, amountSum = 0, used = 0;
  for (const d of list) {
    const q = num(d && d.qty), p = num(d && d.price);
    if (!(q > 0) || !(p > 0)) continue;
    qtySum += q; amountSum += q * p; used++;
  }
  return { price: qtySum > 0 ? amountSum / qtySum : null, qty: qtySum, amount: amountSum, used_deliveries: used };
}


// ---------------------------------------------------------------------------
// Экономика товарной позиции (товарные листы: Рознич. тара, Хорека, Салаты…)
// ---------------------------------------------------------------------------
// Строки повторяют рабочий Excel Шоха: компоненты себестоимости → с/с →
// с/с с браком → цена → ретро, НДС, прибыль, налог, чистая прибыль.
//
// Незаполненный компонент остаётся НЕ ЗАПОЛНЕННЫМ и попадает в счётчик missing.
// Превращать его в ноль нельзя: с/с молча занизилась бы, а наценка выглядела бы
// здоровой. Пустая себестоимость (не заполнено вообще ничего) — это null.
const SKU_COMPONENTS = ['pack', 'raw', 'production', 'overhead', 'labor'];

// Из чего складывается себестоимость на ТОВАРНЫХ листах (Рознич. тара и т. д.).
// Один список на сервер и на тесты: если он разойдётся, себестоимость на экране
// перестанет совпадать с той, что проверена по рабочему файлу.
// «overhead» отдельной строкой не идёт: производственные и накладные затраты
// приходят с листа «Производство» уже одной цифрой.
const SKU_SHEET_COMPONENTS = ['pack', 'raw', 'production', 'labor'];

function skuEconomics(input, opts) {
  const i = input || {};
  const nOrNull = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  // Некоторые листы объединяют производственные и накладные в одну строку
  // (см. лист «Рознич. тара» Excel) — тогда «накладные» как отдельный
  // компонент не участвуют и не должны считаться незаполненными.
  const activeKeys = (opts && Array.isArray(opts.components)) ? opts.components : SKU_COMPONENTS;

  const components = {};
  let filled = 0, sum = 0;
  for (const key of activeKeys) {
    const v = nOrNull(i[key]);
    components[key] = v;
    if (v !== null) { filled++; sum += v; }
  }
  const missing = activeKeys.length - filled;
  // Не просто счётчик: показываем, ЧЕГО именно не хватает, — иначе непонятно,
  // куда идти дописывать.
  const missingKeys = activeKeys.filter((k) => components[k] === null);
  const cost = filled ? sum : null;

  const defectPct = num(i.defect_pct);
  const costDefect = cost === null ? null : cost * (1 + defectPct / 100);

  const price = nOrNull(i.price);
  const retroPct = num(i.retro_pct);
  const vatPct = num(i.vat_pct);
  const taxPct = num(i.profit_tax_pct);

  // Наценка считается от себестоимости с браком — именно её и покрывает цена.
  const markupPct = (price !== null && costDefect !== null && costDefect > 0)
    ? (price / costDefect - 1) * 100 : null;

  const retro = price === null ? null : price * retroPct / 100;
  const vat = price === null ? null : price * vatPct / 100;
  const profit = (price === null || costDefect === null) ? null : price - costDefect - retro - vat;
  // Убыток налогом не облагается, поэтому база налога не бывает отрицательной.
  const profitTax = profit === null ? null : Math.max(0, profit) * taxPct / 100;
  const netProfit = profit === null ? null : profit - profitTax;
  const netPct = (netProfit === null || !(price > 0)) ? null : netProfit / price * 100;

  return {
    components,
    missing,
    missing_keys: missingKeys,
    cost,
    cost_defect: costDefect,
    defect_pct: defectPct,
    markup_pct: markupPct,
    price,
    retro,
    vat,
    profit,
    profit_tax: profitTax,
    net_profit: netProfit,
    net_pct: netPct,
  };
}

// ---------------------------------------------------------------------------
// Песочница: разбор цены на доли и «вклад»
// ---------------------------------------------------------------------------
// Отвечает на вопрос «можно ли дать скидку». Для этого цену надо разложить на
// две разные по природе части:
//   • ПЕРЕМЕННЫЕ — сырьё, упаковка, ретро и НДС. Растут вместе с объёмом:
//     сделали вдвое больше — потратили вдвое больше.
//   • ПОСТОЯННЫЕ — ФОТ и производственные на штуку. Они пришли с листа
//     «Производство» уже поделёнными на общий выпуск: аренда и зарплаты за
//     месяц одни и те же, сколько бы пачек мы ни сделали.
// ВКЛАД = цена − переменные. Это то, что позиция приносит на покрытие
// постоянных расходов. Скидка окупается, если общий вклад не упал.
//
// Собственных денежных правил здесь нет: считаем через skuEconomics, а сверху
// только раскладываем уже посчитанное. Иначе песочница разошлась бы с листом.
function sandboxLine(input, opts) {
  const e = skuEconomics(input, opts);
  const c = e.components;
  const price = e.price;
  const val = (k) => (c[k] === null || c[k] === undefined ? null : c[k]);

  // Чего-то не хватает — «вклад» посчитать нельзя. Ноль вместо пропуска дал бы
  // красивую, но неправдивую картинку: скидка выглядела бы посильной.
  const incomplete = e.missing > 0 || e.cost === null || price === null;

  const d = num(input && input.defect_pct) / 100;
  const varCost = incomplete ? null : (num(val('pack')) + num(val('raw'))) * (1 + d);
  const fixCost = incomplete ? null : (num(val('production')) + num(val('labor'))) * (1 + d);
  const contribution = incomplete ? null : price - varCost - num(e.retro) - num(e.vat);

  // Доли от ЦЕНЫ: все строки плюс маржа дают ровно 100%. Считаем от цены, а не
  // от себестоимости, потому что скидка режет именно цену — так их можно
  // сравнивать напрямую.
  const share = (v) => (price > 0 && v !== null && v !== undefined ? (v / price) * 100 : null);
  const line = (key, label, value) => ({ key, label, value, pct: share(value) });
  const parts = [
    line('raw', 'Зелень', val('raw')),
    line('pack', 'Упаковка', val('pack')),
    line('labor', 'Оплата труда', val('labor')),
    line('production', 'Производ. и накладные', val('production')),
    line('defect', 'Брак', e.cost === null ? null : e.cost * d),
    line('retro', 'Ретро', e.retro),
    line('vat', 'НДС', e.vat),
    line('tax', 'Налог на прибыль', e.profit_tax),
    line('margin', 'Маржа', e.net_profit),
  ].filter((p) => p.value !== null && p.value !== undefined && p.value !== 0);

  return {
    price,
    cost: e.cost,
    cost_defect: e.cost_defect,
    missing: e.missing,
    missing_keys: e.missing_keys,
    incomplete,
    var_cost: varCost,
    fix_cost: fixCost,
    contribution,
    net_profit: e.net_profit,
    net_pct: e.net_pct,
    parts,
  };
}

module.exports = {
  FORMULA_VERSION,
  perUnit,
  SKU_COMPONENTS,
  SKU_SHEET_COMPONENTS,
  skuEconomics,
  sandboxLine,
  STALE_PRICE_DAYS,
  calculateProduct,
  calcRecipeRow,
  calcFotPerUnit,
  calcOverheadsPerUnit,
  calcVat,
  recommendPrice,
  calcShortage,
  weightedAveragePrice,
  ceilTo,
};
