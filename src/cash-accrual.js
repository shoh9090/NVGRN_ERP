// cash-accrual.js — прибыль месяца ПО НАЧИСЛЕНИЮ (вариант А задания от 01.10.2026).
//
// Чем отличается от действующего P&L: расход относится к месяцу, ЗА КОТОРЫЙ он
// возник, а не к месяцу, когда за него заплатили.
//   • зарплата — начисления Персонала за этот период (`hr_payroll`), независимо
//     от даты выплаты: августовская зарплата, выданная в сентябре, остаётся
//     расходом августа;
//   • упаковка — потребление по нормам Калькуляции × проданные штуки, а не
//     оплата поставщику упаковки за месяц;
//   • сырьё — принятое за месяц в Закупе. Это уже начисление: заплатили мы
//     поставщику или остались должны, значения не имеет;
//   • остальные расходы, проценты, налог на прибыль — пока по дате оплаты:
//     периода начисления у них в системе нет. Это ОЦЕНКА, и так помечено.
//
// Модуль НИЧЕГО не меняет в действующем отчёте. Он считает вторую цифру рядом,
// чтобы сначала сверить месяц — как прямо требует задание: «для закрытого
// августа сначала подготовить сравнение».
//
// Чего здесь осознанно НЕТ (и это написано на экране):
//   • НДС из выручки не исключается — трактовка цен ждёт бухгалтера;
//   • ретро-бонусы сетей не вычитаются — природа платежей ждёт бухгалтера;
//   • амортизации нет;
//   • остатки сырья и готовой продукции между месяцами считаются несущественными
//     (зелень не хранится). Если это перестанет быть правдой, метод врёт.

const { ACCR_FIELDS } = require('./hr-fields');

const num = (v) => Number(v) || 0;
// Статьи Кассы, по которым проходит выплата зарплаты. В расчёте по начислению
// они исключаются из «остальных расходов»: зарплата берётся из Персонала.
const SALARY_CODES = new Set(['20', '40']);

// ---------------------------------------------------------------------------
// Зарплата: начислено за период
// ---------------------------------------------------------------------------
// Берём ТОТ ЖЕ список полей, что и Кадры (`hr-fields.ACCR_FIELDS`), иначе ФОТ
// в прибыли и ФОТ на странице Кадров разойдутся. Удержания не вычитаем: аванс
// и штраф — это часть уже начисленной зарплаты, а не отдельный расход.
// `accrued_at` — отметка «ведомость проведена». Непроведённая ведомость тоже
// считается, но помечается как черновик: цифра ещё может измениться.
async function accruedPayroll(pool, period) {
  const sum = ACCR_FIELDS.map((f) => `COALESCE(${f}, 0)`).join(' + ');
  const r = (await pool.query(
    `SELECT COALESCE(SUM(${sum}), 0) AS total,
            COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE accrued_at IS NOT NULL)::int AS posted,
            COUNT(*) FILTER (WHERE (${sum}) > 0)::int AS with_money
       FROM hr_payroll WHERE period = $1`, [period])).rows[0];
  const total = num(r.total);
  return {
    total: total > 0 ? total : null,
    rows: Number(r.rows) || 0,
    posted: Number(r.posted) || 0,
    with_money: Number(r.with_money) || 0,
    // Ведомость за месяц не заведена вовсе — это не «зарплаты не было».
    missing: !(total > 0),
    draft: total > 0 && Number(r.posted) === 0,
  };
}

// ---------------------------------------------------------------------------
// Упаковка: потребление по нормам
// ---------------------------------------------------------------------------
// Достоверного учёта расхода упаковки нет (со склада её не выдают), поэтому
// считаем по нормам: сколько упаковки положено на единицу товара по Калькуляции,
// умноженное на проданные штуки. Это ОЦЕНКА, и она так называется.
//
// sold — продажи по товарам из SalesDoctor: [[код SD, штук, название], …].
// Товары без нормы и без пары в Калькуляции возвращаются списком: пробел должен
// быть виден, а не спрятан в итоге.
async function packagingByNorms(pool, sold, linkProducts) {
  const out = {
    total: null, method: 'norms', matched_units: 0, unmatched_units: 0,
    unmatched: [], no_norm: [], products: 0, reason: null,
  };
  if (!Array.isArray(sold) || !sold.length) {
    out.reason = 'Продажи по товарам за месяц не подтянуты — расход упаковки считать не из чего.';
    return out;
  }
  const rows = (await pool.query(
    `SELECT p.id, p.name, p.barcode, p.sd_product_id, p.finished_good_id, p.pack_template_id, p.pack_cost
       FROM calc_sheet_products p WHERE p.status = 'active'`)).rows;
  if (!rows.length) { out.reason = 'В Калькуляции нет товаров.'; return out; }

  const tpl = new Map((await pool.query(
    `SELECT t.id, COALESCE(SUM(i.price * i.qty), 0) AS total,
            COUNT(*) FILTER (WHERE i.price IS NULL)::int AS missing
       FROM calc_pack_templates t
       LEFT JOIN calc_pack_template_items i ON i.template_id = t.id
      WHERE t.status = 'active' GROUP BY t.id`)).rows.map((t) => [t.id, t]));

  // Стоимость упаковки одной единицы: комплект с листа «Упаковка» или ручная
  // строка (лист «Уксус»). Нет ни того, ни другого — товар идёт в «без нормы».
  const costed = [];
  for (const p of rows) {
    const t = p.pack_template_id ? tpl.get(p.pack_template_id) : null;
    const manual = p.pack_cost === null || p.pack_cost === undefined ? null : num(p.pack_cost);
    const cost = t ? num(t.total) : manual;
    if (cost === null || !(cost > 0) || (t && t.missing > 0)) {
      out.no_norm.push({ name: p.name, reason: t && t.missing > 0 ? 'в комплекте упаковки есть строки без цены' : 'нет комплекта упаковки' });
      continue;
    }
    costed.push({ cost, name: p.name, barcode: p.barcode, sd_product_id: p.sd_product_id, finished_good_id: p.finished_good_id });
  }
  out.products = costed.length;
  if (!costed.length) { out.reason = 'Ни у одного товара нет стоимости упаковки.'; return out; }

  const goods = (await pool.query(
    "SELECT id, name, barcode, sd_sd_id FROM ref_finished_goods WHERE COALESCE(sd_sd_id, '') <> ''")).rows;
  const { costBySd } = linkProducts(costed, sold, goods);

  let total = 0;
  for (const line of sold) {
    const sd = String(line[0] || '');
    const qty = num(line[1]);
    if (!(qty > 0)) continue;
    const hit = costBySd.get(sd);
    if (!hit) { out.unmatched.push({ sd_id: sd, name: line[2] || sd, units: qty }); out.unmatched_units += qty; continue; }
    total += qty * num(hit.cost);
    out.matched_units += qty;
  }
  out.unmatched.sort((a, b) => b.units - a.units);
  out.total = total;
  // Насколько полно покрыты продажи: если половина штук без нормы, цифре верить нельзя.
  const all = out.matched_units + out.unmatched_units;
  out.coverage_pct = all > 0 ? (out.matched_units / all) * 100 : null;
  return out;
}

// ---------------------------------------------------------------------------
// Отчёт по начислению
// ---------------------------------------------------------------------------
// basis каждой строки: 'fact' — взято из документов этого месяца;
// 'estimate' — посчитано по нормам или по дате оплаты; 'missing' — данных нет.
// Строка без данных НЕ превращается в ноль: иначе отчёт покажет прибыль,
// которой нет.
function lines(d) {
  const L = [];
  const add = (key, label, amount, basis, source, note) => L.push({ key, label, amount, basis, source, note });

  add('revenue', 'Чистая выручка', d.revenue.total, d.revenue.basis, d.revenue.source, d.revenue.note);
  add('raw', 'Сырьё', d.raw.total === null ? null : -d.raw.total, d.raw.basis, d.raw.source, d.raw.note);
  add('pack', 'Упаковка', d.pack.total === null ? null : -d.pack.total, d.pack.basis, d.pack.source, d.pack.note);
  add('after_materials', 'Остаток после материалов', d.after_materials, d.materials_basis,
    'Выручка минус сырьё и упаковка',
    'Это НЕ валовая прибыль: производственные зарплаты и общезаводские расходы ещё не вычтены.');
  add('payroll', 'Зарплаты (начислено)', d.payroll.total === null ? null : -d.payroll.total, d.payroll.basis, d.payroll.source, d.payroll.note);
  add('other', 'Остальные расходы', d.other.total === null ? null : -d.other.total, d.other.basis, d.other.source, d.other.note);
  add('operating', 'Операционная прибыль', d.operating, d.operating_basis, 'Остаток после материалов минус зарплаты и расходы', null);
  add('interest', 'Проценты по кредитам', d.interest.total === null ? null : -d.interest.total, d.interest.basis, d.interest.source, d.interest.note);
  add('tax', 'Налог на прибыль', d.tax.total === null ? null : -d.tax.total, d.tax.basis, d.tax.source, d.tax.note);
  add('net', 'Чистая прибыль', d.net, d.net_basis, 'Операционная прибыль минус проценты и налог', null);
  return L;
}

// Статус отчёта целиком. Три состояния из задания: предварительный, с
// расчётными строками, сверено и подтверждено. Третье выставляется не кодом —
// его ставит человек, закрывая месяц после сверки.
function statusOf(d, closed) {
  const miss = Object.keys(d).filter((k) => d[k] && d[k].basis === 'missing');
  if (miss.length) {
    return { code: 'incomplete', label: 'Предварительный: часть данных отсутствует',
      why: 'Нет данных по строкам: ' + miss.join(', ') + '. Прибыль показана не полностью.' };
  }
  if (closed) {
    return { code: 'confirmed', label: 'Сверено и подтверждено',
      why: 'Месяц закрыт, отчёт берётся из снимка и не пересчитывается.' };
  }
  const est = Object.keys(d).filter((k) => d[k] && d[k].basis === 'estimate');
  if (est.length) {
    return { code: 'estimated', label: 'Есть расчётные строки',
      why: 'По нормам или по дате оплаты посчитано: ' + est.join(', ') + '. Это оценка, не факт.' };
  }
  return { code: 'fact', label: 'Все строки из документов месяца',
    why: 'Остаётся сверить суммы с первичными документами.' };
}

// pnl — готовый отчёт действующей методики (cash-pnl.pnlFor), sold — продажи по
// товарам. Вторую копию запросов к Кассе не делаем: берём то, что уже посчитано.
async function buildAccrual(pool, period, pnl, sold, linkProducts) {
  const payroll = await accruedPayroll(pool, period);
  const pack = await packagingByNorms(pool, sold, linkProducts);

  // Зарплата по ОПЛАТЕ — её надо убрать из «остальных расходов», иначе
  // зарплата будет посчитана дважды: начислением и выплатой.
  const opexItems = [].concat(...(((pnl.opex || {}).groups) || []).map((g) => g.items || []));
  const salaryPaid = opexItems.filter((x) => SALARY_CODES.has(String(x.code))).reduce((a, x) => a + num(x.exp), 0);
  const otherTotal = num((pnl.opex || {}).total) - salaryPaid;

  const parts = pnl.cogs_parts || {};
  const d = {
    revenue: {
      total: pnl.revenue.source === 'shipped' ? num(pnl.revenue.total) : null,
      basis: pnl.revenue.source === 'shipped' ? 'fact' : 'missing',
      source: 'SalesDoctor: отгружено за месяц, за вычетом возвратов',
      note: pnl.revenue.source === 'shipped'
        ? 'НДС из выручки не исключён и ретро сетям не вычтено — трактовка ждёт бухгалтера.'
        : 'Реализация из SalesDoctor за месяц не подтянута. Подменять её поступившими деньгами нельзя.',
    },
    raw: {
      total: parts.raw_source === 'purchase' ? num(parts.raw) : null,
      basis: parts.raw_source === 'purchase' ? (parts.raw_no_price > 0 ? 'estimate' : 'fact') : 'missing',
      source: 'Закуп: принято за месяц, факт × цена',
      note: parts.raw_source === 'purchase'
        ? (parts.raw_no_price > 0 ? `${parts.raw_no_price} принятых позиций без цены — сырьё занижено на их стоимость.` : null)
        : 'Приёмок с ценами за месяц нет. Подменять сырьё оплатами поставщикам в этом расчёте нельзя — показываем пробел.',
    },
    pack: {
      total: pack.total,
      basis: pack.total === null ? 'missing' : 'estimate',
      source: 'Калькуляция: норма упаковки на единицу × проданные штуки',
      note: pack.total === null ? pack.reason
        : `По нормам. Покрыто ${Math.round(pack.coverage_pct || 0)}% проданных штук`
          + (pack.unmatched.length ? `, без пары в Калькуляции ${pack.unmatched.length} товаров` : '')
          + (pack.no_norm.length ? `, без нормы упаковки ${pack.no_norm.length} карточек` : '') + '.',
    },
    payroll: {
      total: payroll.total,
      basis: payroll.missing ? 'missing' : (payroll.draft ? 'estimate' : 'fact'),
      source: 'Персонал: начислено за этот период, независимо от даты выплаты',
      note: payroll.missing ? 'Ведомость за месяц не заведена — это не «зарплаты не было».'
        : (payroll.draft ? 'Ведомость не проведена: суммы ещё могут измениться.'
          : `Проведено строк: ${payroll.posted} из ${payroll.rows}.`),
    },
    other: {
      total: otherTotal,
      basis: 'estimate',
      source: 'Касса: расходы месяца по дате оплаты, без зарплаты, сырья и упаковки',
      note: 'По дате ОПЛАТЫ: периода начисления у этих расходов в системе нет. '
        + 'Аренда за квартал ляжет одним месяцем, оплата старого долга попадёт в текущий.',
    },
    interest: {
      total: num((pnl.interest || {}).total),
      basis: 'estimate',
      source: 'Касса: статья 60, по дате оплаты',
      note: 'Проценты начисляются по графику, а здесь взяты по оплате.',
    },
    tax: {
      total: num((pnl.profit_tax || {}).total),
      basis: 'estimate',
      source: 'Касса: статья 67, по дате оплаты',
      note: 'Налог за период и платёж по нему — разные вещи; ставка и база ждут бухгалтера.',
    },
  };

  // Итоги. Любая отсутствующая строка делает итог неизвестным: ноль вместо
  // пробела — это и есть «красивая прибыль из неполных данных».
  const materialsKnown = d.revenue.total !== null && d.raw.total !== null && d.pack.total !== null;
  d.after_materials = materialsKnown ? d.revenue.total - d.raw.total - d.pack.total : null;
  d.materials_basis = materialsKnown ? (d.raw.basis === 'fact' && d.pack.basis === 'fact' ? 'fact' : 'estimate') : 'missing';
  const opKnown = materialsKnown && d.payroll.total !== null;
  d.operating = opKnown ? d.after_materials - d.payroll.total - d.other.total : null;
  d.operating_basis = opKnown ? 'estimate' : 'missing';
  d.net = opKnown ? d.operating - d.interest.total - d.tax.total : null;
  d.net_basis = d.operating_basis;

  return {
    period,
    method: 'accrual',
    lines: lines(d),
    totals: {
      revenue: d.revenue.total, raw: d.raw.total, pack: d.pack.total,
      after_materials: d.after_materials, payroll: d.payroll.total, other: d.other.total,
      operating: d.operating, interest: d.interest.total, tax: d.tax.total, net: d.net,
    },
    status: statusOf({ revenue: d.revenue, raw: d.raw, pack: d.pack, payroll: d.payroll, other: d.other }, !!pnl.snapshot_at),
    payroll, packaging: pack,
    salary_paid: salaryPaid,
    // Допущение метода. Если остатки сырья и готовой продукции между месяцами
    // станут существенными, цифра перестанет быть верной.
    assumption: 'Остатки сырья и готовой продукции между месяцами считаются несущественными: '
      + 'зелень не хранится, принятое за месяц уходит в этом же месяце. '
      + 'Появятся существенные остатки на границе месяца — метод надо менять, а не подгонять.',
  };
}

// ---------------------------------------------------------------------------
// Сверка двух методик
// ---------------------------------------------------------------------------
// Для каждой строки: что показывает действующий отчёт, что — расчёт по
// начислению, и из-за чего разница. Цифры не «исправляются»: обе остаются на
// экране, пока Шох и бухгалтер не решат, какую считать верной.
function compareMethods(pnl, accrual) {
  const a = accrual.totals;
  const parts = pnl.cogs_parts || {};
  const opexItems = [].concat(...(((pnl.opex || {}).groups) || []).map((g) => g.items || []));
  const salaryPaid = opexItems.filter((x) => SALARY_CODES.has(String(x.code))).reduce((s, x) => s + num(x.exp), 0);

  const rows = [
    { key: 'revenue', label: 'Чистая выручка',
      current: num(pnl.revenue.total), accrual: a.revenue,
      why: 'Источник один — реализация SalesDoctor. НДС и ретро не исключены ни там, ни там.' },
    { key: 'raw', label: 'Сырьё',
      current: parts.raw_source === 'purchase' ? num(parts.raw) : num(parts.raw),
      accrual: a.raw,
      why: parts.raw_source === 'purchase'
        ? 'Совпадает: действующий отчёт тоже берёт приёмки Закупа.'
        : 'Действующий отчёт при отсутствии приёмок подставляет оплаты поставщикам, расчёт по начислению показывает пробел.' },
    { key: 'pack', label: 'Упаковка',
      current: num(parts.packaging), accrual: a.pack,
      why: 'Было: оплата поставщику упаковки за месяц. Стало: норма на единицу × проданные штуки.' },
    { key: 'payroll', label: 'Зарплаты',
      current: salaryPaid, accrual: a.payroll,
      why: 'Было: выплаты из Кассы за месяц. Стало: начислено Персоналом за этот период, независимо от даты выплаты.' },
    { key: 'other', label: 'Остальные расходы',
      current: num((pnl.opex || {}).total) - salaryPaid, accrual: a.other,
      why: 'Одна и та же цифра: по дате оплаты. Периода начисления у этих расходов пока нет.' },
    { key: 'interest', label: 'Проценты по кредитам',
      current: num((pnl.interest || {}).total), accrual: a.interest, why: 'Одинаково, по оплате.' },
    { key: 'tax', label: 'Налог на прибыль',
      current: num((pnl.profit_tax || {}).total), accrual: a.tax, why: 'Одинаково, по оплате.' },
    { key: 'net', label: 'Чистая прибыль',
      current: pnl.net_profit === undefined ? null : pnl.net_profit, accrual: a.net,
      why: 'Итог двух методик. Разница — это сумма корректировок выше, а не ошибка в одной из них.' },
  ];
  return rows.map((r) => ({
    ...r,
    diff: (r.current === null || r.accrual === null) ? null : r.accrual - r.current,
  }));
}

module.exports = { buildAccrual, compareMethods, accruedPayroll, packagingByNorms, SALARY_CODES };
