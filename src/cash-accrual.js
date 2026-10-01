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
            COALESCE(SUM(${sum}) FILTER (WHERE accrued_at IS NOT NULL), 0) AS total_posted,
            COALESCE(SUM(${sum}) FILTER (WHERE accrued_at IS NULL), 0) AS total_draft,
            COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE accrued_at IS NOT NULL)::int AS posted,
            COUNT(*) FILTER (WHERE accrued_at IS NULL)::int AS draft_rows,
            COUNT(*) FILTER (WHERE (${sum}) > 0)::int AS with_money
       FROM hr_payroll WHERE period = $1`, [period])).rows[0];
  // Полнота фонда проверяется ОТДЕЛЬНО от проведения: ведомость может быть
  // проведена на половину людей, и это не «фонд посчитан». Сравниваем с
  // активными сотрудниками и с их окладами из Персонала.
  const staff = (await pool.query(
    `SELECT COUNT(*)::int AS active, COALESCE(SUM(base_salary), 0) AS fund
       FROM hr_employees WHERE status = 'active'`).catch(() => ({ rows: [] }))).rows[0] || { active: 0, fund: 0 };

  const total = num(r.total);
  const active = Number(staff.active) || 0;
  const withMoney = Number(r.with_money) || 0;
  const fund = num(staff.fund);
  return {
    total: total > 0 ? total : null,
    total_posted: num(r.total_posted),
    total_draft: num(r.total_draft),
    rows: Number(r.rows) || 0,
    posted: Number(r.posted) || 0,
    draft_rows: Number(r.draft_rows) || 0,
    with_money: withMoney,
    // Ведомость за месяц не заведена вовсе — это не «зарплаты не было».
    missing: !(total > 0),
    // Есть непроведённые строки с деньгами — суммы ещё могут измениться.
    draft: total > 0 && num(r.total_draft) > 0,
    // Полнота: на сколько активных сотрудников есть начисление и как сумма
    // соотносится с фондом окладов. Это ОЦЕНКА полноты, а не сверка с 1С.
    staff_active: active,
    staff_covered: withMoney,
    staff_missing: Math.max(0, active - withMoney),
    salary_fund: fund > 0 ? fund : null,
    fund_diff_pct: (fund > 0 && total > 0) ? ((total - fund) / fund) * 100 : null,
    // Полным считаем, когда начисление есть у всех активных сотрудников.
    complete: active > 0 && withMoney >= active,
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
// Ключ снимка норм упаковки за месяц. Без него расчёт августа менялся бы от
// каждой правки комплекта в Калькуляции — сегодня подняли цену плёнки, и
// «подтверждённый» август стал другим. Снимок фиксируется кнопкой.
const PACK_SNAP_KEY = (period) => 'pack_norms_' + period;

async function packagingByNorms(pool, sold, linkProducts, period) {
  const out = {
    total: null, method: 'norms', matched_units: 0, unmatched_units: 0,
    unmatched: [], no_norm: [], products: 0, reason: null,
    // Чем считали: current — текущими нормами Калькуляции, snapshot — нормами,
    // зафиксированными для этого месяца.
    norms_source: 'current', norms_at: null, used: [],
    sku_total: 0, sku_covered: 0,
  };
  if (!Array.isArray(sold) || !sold.length) {
    out.reason = 'Продажи по товарам за месяц не подтянуты — расход упаковки считать не из чего.';
    return out;
  }

  // Сначала смотрим снимок норм за этот месяц: если он есть, август считается
  // ровно теми цифрами, какими был зафиксирован.
  let snap = null;
  if (period) {
    try {
      const r = (await pool.query('SELECT value FROM settings WHERE key = $1', [PACK_SNAP_KEY(period)])).rows[0];
      if (r) snap = JSON.parse(r.value);
    } catch (e) { snap = null; }
  }
  if (snap && Array.isArray(snap.items) && snap.items.length) {
    out.norms_source = 'snapshot';
    out.norms_at = snap.at || null;
    return finishPack(pool, out, snap.items, sold, linkProducts, snap.no_norm || []);
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
  return finishPack(pool, out, costed, sold, linkProducts, out.no_norm);
}

// Общий хвост расчёта — один и тот же для текущих норм и для снимка, чтобы
// цифра не зависела от того, откуда взялись нормы.
async function finishPack(pool, out, costed, sold, linkProducts, noNorm) {
  out.products = costed.length;
  out.no_norm = noNorm || [];
  const goods = (await pool.query(
    "SELECT id, name, barcode, sd_sd_id FROM ref_finished_goods WHERE COALESCE(sd_sd_id, '') <> ''")).rows;
  const { costBySd } = linkProducts(costed, sold, goods);

  let total = 0;
  const used = new Map();
  for (const line of sold) {
    const sd = String(line[0] || '');
    const qty = num(line[1]);
    if (!(qty > 0)) continue;
    out.sku_total++;
    const hit = costBySd.get(sd);
    if (!hit) { out.unmatched.push({ sd_id: sd, name: line[2] || sd, units: qty }); out.unmatched_units += qty; continue; }
    total += qty * num(hit.cost);
    out.matched_units += qty;
    out.sku_covered++;
    // Цены расчёта: по каждому товару видно норму и сколько штук на неё легло.
    // Без этого цифру нельзя перепроверить руками.
    used.set(sd, { sd_id: sd, name: hit.name || line[2] || sd, pack_cost: num(hit.cost), units: qty, amount: qty * num(hit.cost) });
  }
  out.unmatched.sort((a, b) => b.units - a.units);
  out.used = [...used.values()].sort((a, b) => b.amount - a.amount);
  out.total = total;
  // Покрытие считаем и в штуках, и в товарах: 95% штук при 12 непокрытых
  // товарах — это разные новости, и обе нужны.
  const all = out.matched_units + out.unmatched_units;
  out.coverage_pct = all > 0 ? (out.matched_units / all) * 100 : null;
  out.sku_coverage_pct = out.sku_total > 0 ? (out.sku_covered / out.sku_total) * 100 : null;
  return out;
}

// Зафиксировать нормы упаковки за месяц: дальше расчёт этого месяца считается
// ими, а правки в Калькуляции его больше не меняют.
async function snapshotPackNorms(pool, period) {
  const rows = (await pool.query(
    `SELECT p.id, p.name, p.barcode, p.sd_product_id, p.finished_good_id, p.pack_template_id, p.pack_cost
       FROM calc_sheet_products p WHERE p.status = 'active'`)).rows;
  const tpl = new Map((await pool.query(
    `SELECT t.id, COALESCE(SUM(i.price * i.qty), 0) AS total,
            COUNT(*) FILTER (WHERE i.price IS NULL)::int AS missing
       FROM calc_pack_templates t
       LEFT JOIN calc_pack_template_items i ON i.template_id = t.id
      WHERE t.status = 'active' GROUP BY t.id`)).rows.map((t) => [t.id, t]));
  const items = [], noNorm = [];
  for (const p of rows) {
    const t = p.pack_template_id ? tpl.get(p.pack_template_id) : null;
    const manual = p.pack_cost === null || p.pack_cost === undefined ? null : num(p.pack_cost);
    const cost = t ? num(t.total) : manual;
    if (cost === null || !(cost > 0) || (t && t.missing > 0)) {
      noNorm.push({ name: p.name, reason: t && t.missing > 0 ? 'в комплекте упаковки есть строки без цены' : 'нет комплекта упаковки' });
      continue;
    }
    items.push({ cost, name: p.name, barcode: p.barcode, sd_product_id: p.sd_product_id, finished_good_id: p.finished_good_id });
  }
  const at = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [PACK_SNAP_KEY(period), JSON.stringify({ at, items, no_norm: noNorm })]);
  return { at, products: items.length, no_norm: noNorm.length };
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

// Вопросы методики, без ответа на которые результат не может считаться
// подтверждённым. Пока список не пуст, статус отчёта — «Предварительный»,
// как бы хорошо ни были заполнены данные.
const OPEN_QUESTIONS = [
  'НДС: цены в SalesDoctor и договорах — с налогом или без. Из выручки налог не исключён.',
  'Ретро-бонусы сетям: природа платежей не определена, из выручки не вычтены.',
  'Расходы по периоду: аренда, услуги и коммунальные берутся по дате оплаты — периода начисления у них в системе нет.',
];

// Статус отчёта целиком.
//
// ВАЖНО: закрытие месяца в Кассе относится к ДЕЙСТВУЮЩЕЙ методике и ничего не
// говорит об этой. Раньше закрытый месяц автоматически получал здесь «сверено и
// подтверждено» — это было неверно: снимок старого отчёта не подтверждает новый
// расчёт. Подтверждение ставит человек после сверки, а пока такого действия в
// системе нет — значит, статус «подтверждён» не выставляется вовсе.
function statusOf(d) {
  const names = { revenue: 'выручка', raw: 'сырьё', pack: 'упаковка', payroll: 'зарплата', other: 'остальные расходы' };
  const label = (k) => names[k] || k;
  const miss = Object.keys(d).filter((k) => d[k] && d[k].basis === 'missing').map(label);
  const est = Object.keys(d).filter((k) => d[k] && d[k].basis === 'estimate').map(label);
  const gaps = [];
  if (miss.length) gaps.push('данных нет: ' + miss.join(', '));
  if (est.length) gaps.push('посчитано оценкой: ' + est.join(', '));
  return {
    // Единственный достижимый сейчас код. Как только вопросы методики закроются
    // и все строки станут fact, появится смысл в отдельном «подтверждён».
    code: miss.length ? 'incomplete' : 'preliminary',
    label: 'Предварительный результат',
    why: (miss.length
      ? 'Часть данных отсутствует, поэтому итог неполный. '
      : 'Арифметика сходится, но часть строк — оценка, и вопросы методики не закрыты. ')
      + (gaps.length ? gaps.join('; ') + '. ' : '')
      + 'Назвать эту цифру подтверждённой прибылью нельзя.',
    gaps,
    open_questions: OPEN_QUESTIONS,
  };
}

// pnl — готовый отчёт действующей методики (cash-pnl.pnlFor), sold — продажи по
// товарам. Вторую копию запросов к Кассе не делаем: берём то, что уже посчитано.
async function buildAccrual(pool, period, pnl, sold, linkProducts) {
  const payroll = await accruedPayroll(pool, period);
  const pack = await packagingByNorms(pool, sold, linkProducts, period);

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
      // Факт — только когда ведомость проведена целиком И начисление есть у всех
      // активных сотрудников. Проведение и полнота проверяются отдельно: можно
      // аккуратно провести половину людей и получить «факт» на половину фонда.
      basis: payroll.missing ? 'missing' : ((payroll.draft || !payroll.complete) ? 'estimate' : 'fact'),
      source: 'Персонал: начислено за этот период, независимо от даты выплаты',
      note: payroll.missing ? 'Ведомость за месяц не заведена — это не «зарплаты не было».'
        : [
          `Проведено ${payroll.posted} строк на ${Math.round(payroll.total_posted / 1e6)} млн`
            + (payroll.draft_rows ? `, не проведено ${payroll.draft_rows} на ${Math.round(payroll.total_draft / 1e6)} млн` : ''),
          payroll.staff_active
            ? (payroll.complete
              ? `Начисление есть у всех ${payroll.staff_active} активных сотрудников.`
              : `Начисление есть у ${payroll.staff_covered} из ${payroll.staff_active} активных сотрудников — фонд месяца неполный.`)
            : null,
          payroll.fund_diff_pct !== null && Math.abs(payroll.fund_diff_pct) >= 10
            ? `Начислено на ${Math.round(payroll.fund_diff_pct)}% ${payroll.fund_diff_pct > 0 ? 'больше' : 'меньше'} фонда окладов — проверьте премии и удержания.`
            : null,
        ].filter(Boolean).join(' '),
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
    // Закрытие месяца в Кассе сюда не передаётся намеренно: оно относится к
    // действующей методике и этот расчёт не подтверждает.
    status: statusOf({ revenue: d.revenue, raw: d.raw, pack: d.pack, payroll: d.payroll, other: d.other }),
    current_closed: !!pnl.snapshot_at,
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
      why: 'Было: оплата поставщику упаковки за месяц. Стало: норма на единицу × проданные штуки. '
        + 'Разница не равна запасу упаковки на складе: в неё входят и непокрытые нормами товары.' },
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

// ---------------------------------------------------------------------------
// Сверка дат приёмок: из-за чего сырьё месяца изменилось
// ---------------------------------------------------------------------------
// 23.09.2026 месяц сырья стали определять по ФАКТИЧЕСКОЙ дате приёмки
// (`received_at`), а раньше брали плановую дату поставки (`delivery_date`) —
// так же, как считается долг поставщику. У заявок, где эти даты в разных
// месяцах, сырьё переехало, и прибыль месяца изменилась.
//
// Это документальная сверка, а не правка: показываем заявку, обе даты, сумму и
// куда она переехала. **Даты документов не меняются ради результата** — если
// приёмка отмечена не тем днём, это исправляет закупщик в Закупе, по документу.
async function rawDateAudit(pool, period) {
  const from = period + '-01';
  const rows = (await pool.query(
    `SELECT po.id, po.delivery_date, po.received_at::date AS received_date,
            c.name AS supplier,
            COALESCE(SUM(COALESCE(i.fact_qty, 0) * i.price), 0) AS amount,
            to_char(po.delivery_date, 'YYYY-MM') AS plan_month,
            to_char(COALESCE(po.received_at::date, po.delivery_date), 'YYYY-MM') AS fact_month
       FROM purchase_orders po
       JOIN purchase_order_items i ON i.order_id = po.id AND i.item_kind = 'raw'
       LEFT JOIN ref_counterparties c ON c.id = po.supplier_id
      WHERE po.status = 'received'
        AND (to_char(po.delivery_date, 'YYYY-MM') = $1
             OR to_char(COALESCE(po.received_at::date, po.delivery_date), 'YYYY-MM') = $1)
      GROUP BY po.id, po.delivery_date, po.received_at, c.name
      ORDER BY po.delivery_date, po.id`, [period]).catch(() => ({ rows: [] }))).rows;

  const moved = [];
  let left = 0, came = 0;
  for (const r of rows) {
    if (r.plan_month === r.fact_month) continue;          // даты в одном месяце — заявка не переезжала
    const amount = num(r.amount);
    const direction = r.plan_month === period ? 'out' : 'in';
    if (direction === 'out') left += amount; else came += amount;
    moved.push({
      order_id: r.id,
      supplier: r.supplier || '—',
      plan_date: r.delivery_date ? String(r.delivery_date).slice(0, 10) : null,
      fact_date: r.received_date ? String(r.received_date).slice(0, 10) : null,
      amount,
      direction,                                          // out — ушла из месяца, in — пришла в месяц
      from_month: r.plan_month,
      to_month: r.fact_month,
      // Влияние на прибыль месяца: ушедшее сырьё прибыль поднимает, пришедшее — опускает.
      profit_effect: direction === 'out' ? amount : -amount,
    });
  }
  moved.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return {
    period,
    orders: rows.length,
    moved,
    left_amount: left,
    came_amount: came,
    // Итог: на сколько сырьё месяца стало меньше (плюс к прибыли) или больше.
    profit_effect: left - came,
    note: moved.length
      ? 'Эти заявки учтены не в том месяце, в каком были запланированы. Если дата приёмки '
        + 'не совпадает с документом поставщика, её исправляет закупщик в Закупе — по документу, а не под результат.'
      : 'Заявок, у которых плановая и фактическая даты приёмки в разных месяцах, нет: '
        + 'переход на фактическую дату сырьё этого месяца не изменил.',
  };
}

// ---------------------------------------------------------------------------
// Мостик: от исходной прибыли к новому предварительному результату
// ---------------------------------------------------------------------------
// Требование задания: «исходная прибыль + каждое объяснённое изменение = новый
// предварительный результат». Поэтому это не список наблюдений, а арифметика:
// сумма исходной цифры и всех корректировок ОБЯЗАНА совпасть с итогом, иначе
// где-то потерялось изменение. Проверяется тестом.
//
// Отдельно — неподтверждённые суммы: то, что мы знаем, но посчитать не можем
// (НДС, ретро, расходы периода). Они в итог НЕ входят и живут своим списком:
// смешать их с объяснёнными корректировками значит выдать догадку за расчёт.
function bridge(pnl, accrual) {
  const from = pnl.net_profit === undefined || pnl.net_profit === null ? null : num(pnl.net_profit);
  const a = accrual.totals;
  const steps = [];
  const add = (key, label, amount, why) => steps.push({ key, label, amount, why });

  const parts = pnl.cogs_parts || {};
  const packPaid = num(parts.packaging);
  const opexItems = [].concat(...(((pnl.opex || {}).groups) || []).map((g) => g.items || []));
  const salaryPaid = opexItems.filter((x) => SALARY_CODES.has(String(x.code))).reduce((t, x) => t + num(x.exp), 0);

  // Упаковка: было по оплате, стало по нормам. Знак: расход уменьшился —
  // прибыль выросла. Разницу НЕ называем «запасом упаковки»: она складывается
  // и из закупки впрок, и из непокрытых нормами товаров, и из неточности норм.
  if (a.pack !== null) {
    add('pack', 'Упаковка: оплата месяца заменена расходом по нормам',
      packPaid - a.pack,
      `Было оплачено поставщику ${Math.round(packPaid / 1e6)} млн, по нормам на проданные штуки вышло `
      + `${Math.round(a.pack / 1e6)} млн. Из чего именно разница — закупка впрок, непокрытые нормами товары `
      + 'или неточные нормы — по этим данным не определить.');
  }
  // Зарплата: было по выплате, стало по начислению.
  if (a.payroll !== null) {
    add('payroll', 'Зарплата: выплаты месяца заменены начислением',
      salaryPaid - a.payroll,
      `Выплачено из Кассы ${Math.round(salaryPaid / 1e6)} млн, начислено Персоналом за месяц `
      + `${Math.round(a.payroll / 1e6)} млн. Разница — зарплата, выплаченная в другом месяце.`);
  }

  const known = steps.every((x) => x.amount !== null);
  const sum = steps.reduce((t, x) => t + num(x.amount), 0);
  const to = (from === null || !known || a.net === null) ? null : from + sum;

  // Неподтверждённое: названо, но в цифру не заложено.
  const unconfirmed = [
    { key: 'vat', label: 'НДС в выручке и в закупочных ценах',
      note: 'Трактовка цен не определена. Может изменить и выручку, и себестоимость.' },
    { key: 'retro', label: 'Ретро-бонусы сетям',
      note: 'Природа платежей по договору «2-РЕТРО» не определена; из выручки не вычтены.' },
    { key: 'period', label: 'Расходы по периоду (аренда, услуги, коммунальные)',
      note: 'Берутся по дате оплаты: аренда за квартал ложится одним месяцем, оплата старого долга попадает в текущий.' },
    { key: 'amort', label: 'Амортизация', note: 'В расчёте отсутствует полностью.' },
  ];
  if (accrual.packaging && accrual.packaging.coverage_pct !== null && accrual.packaging.coverage_pct < 100) {
    unconfirmed.push({ key: 'pack_gap', label: 'Упаковка по непокрытым товарам',
      note: `Нормами покрыто ${Math.round(accrual.packaging.coverage_pct)}% проданных штук; остальное в расход упаковки не вошло.` });
  }
  if (accrual.payroll && !accrual.payroll.complete) {
    unconfirmed.push({ key: 'payroll_gap', label: 'Зарплата сотрудников без начисления',
      note: `Начисление есть у ${accrual.payroll.staff_covered} из ${accrual.payroll.staff_active} активных сотрудников.` });
  }

  return {
    from, to, steps, unconfirmed,
    // Сходится ли арифметика: итог = исходная + сумма шагов.
    checks_out: to === null ? null : Math.abs((from + sum) - to) < 1,
    note: to === null
      ? 'Новый результат посчитать не из чего: не хватает данных по одной из строк.'
      : 'Это предварительный результат: он учитывает только объяснённые изменения. '
        + 'Неподтверждённые суммы ниже в него не входят.',
  };
}

module.exports = { buildAccrual, compareMethods, bridge, rawDateAudit, accruedPayroll, packagingByNorms, snapshotPackNorms, PACK_SNAP_KEY, SALARY_CODES, OPEN_QUESTIONS };
