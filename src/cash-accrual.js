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

// Дата приёмки — одно определение на всю систему (см. receipt-date.js).
const { RECEIPT_DATE: RD } = require('./receipt-date');
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
  // Полнота фонда проверяется ОТДЕЛЬНО от проведения и по составу ИМЕННО ТОГО
  // месяца, а не по тем, кто активен сегодня. Человек мог уволиться в сентябре —
  // в августе он работал и зарплату получал; устроиться в октябре — тогда
  // августовского начисления у него быть не должно.
  //
  // Сравниваем конкретных людей, а не количество строк: иначе 30 начислений на
  // 30 работавших выглядят полными, даже если это 30 разных людей.
  const staff = await staffOfMonth(pool, period);

  const total = num(r.total);
  // Кто работал в месяце, но начисления не получил, и наоборот.
  const paid = new Set(staff.paid_ids);
  const missingPeople = staff.known ? staff.worked.filter((e) => !paid.has(e.id)) : [];
  const extraPeople = staff.known ? staff.paid.filter((e) => !staff.worked_ids.has(e.id)) : [];
  const fund = staff.fund;
  return {
    total: total > 0 ? total : null,
    total_posted: num(r.total_posted),
    total_draft: num(r.total_draft),
    rows: Number(r.rows) || 0,
    posted: Number(r.posted) || 0,
    draft_rows: Number(r.draft_rows) || 0,
    with_money: Number(r.with_money) || 0,
    // Ведомость за месяц не заведена вовсе — это не «зарплаты не было».
    missing: !(total > 0),
    // Есть непроведённые строки с деньгами — суммы ещё могут измениться.
    draft: total > 0 && num(r.total_draft) > 0,
    // Состав месяца. known = false, если в карточках нет дат приёма: тогда
    // полнота фонда НЕ ПОДТВЕРЖДЕНА, и выдавать её за проверенную нельзя.
    staff_known: staff.known,
    staff_worked: staff.worked.length,
    staff_covered: staff.paid.length,
    staff_missing_people: missingPeople.map((e) => e.name),
    staff_extra_people: extraPeople.map((e) => e.name),
    staff_note: staff.note,
    salary_fund: fund > 0 ? fund : null,
    fund_diff_pct: (fund > 0 && total > 0) ? ((total - fund) / fund) * 100 : null,
    // Полным считаем, только когда состав месяца известен И начисление есть у
    // каждого, кто в этом месяце работал, и ни у кого лишнего.
    complete: staff.known && staff.worked.length > 0
      && missingPeople.length === 0 && extraPeople.length === 0,
  };
}

// Кто работал в этом месяце и какой у него был оклад. Состав берём по датам
// приёма и увольнения, оклад — из истории оклада (`hr_salary_history`) на конец
// месяца: сегодняшняя ставка к августу отношения не имеет.
async function staffOfMonth(pool, period) {
  const out = { known: false, worked: [], worked_ids: new Set(), paid: [], paid_ids: [], fund: 0, note: null };
  try {
    const to = (await pool.query(
      "SELECT to_char(($1::date + INTERVAL '1 month') - INTERVAL '1 day', 'YYYY-MM-DD') AS d",
      [period + '-01'])).rows[0].d;
    const from = period + '-01';

    // Работал в месяце: принят не позже конца месяца и не уволен до его начала.
    const worked = (await pool.query(
      `SELECT e.id, e.full_name AS name, e.hire_date, e.fire_date,
              COALESCE((SELECT h.base_salary FROM hr_salary_history h
                         WHERE h.employee_id = e.id AND h.effective_from <= $2::date
                      ORDER BY h.effective_from DESC LIMIT 1), e.base_salary, 0) AS salary
         FROM hr_employees e
        WHERE e.hire_date IS NOT NULL
          AND e.hire_date <= $2::date
          AND (e.fire_date IS NULL OR e.fire_date >= $1::date)
        ORDER BY e.full_name`, [from, to])).rows;

    // Сколько карточек вообще без даты приёма: по ним состав месяца неизвестен.
    const noDates = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM hr_employees WHERE hire_date IS NULL')).rows[0];

    const sumF = ACCR_FIELDS.map((f) => `COALESCE(${f}, 0)`).join(' + ');
    const paid = (await pool.query(
      `SELECT pr.employee_id AS id, e.full_name AS name, (${sumF}) AS accrued
         FROM hr_payroll pr JOIN hr_employees e ON e.id = pr.employee_id
        WHERE pr.period = $1 AND (${sumF}) > 0
        ORDER BY e.full_name`, [period])).rows;

    out.worked = worked.map((e) => ({ id: e.id, name: e.name, salary: num(e.salary) }));
    out.worked_ids = new Set(out.worked.map((e) => e.id));
    out.paid = paid.map((e) => ({ id: e.id, name: e.name, accrued: num(e.accrued) }));
    out.paid_ids = out.paid.map((e) => e.id);
    out.fund = out.worked.reduce((t, e) => t + e.salary, 0);
    const blind = Number(noDates && noDates.n) || 0;
    out.known = out.worked.length > 0 && blind === 0;
    out.note = blind
      ? `У ${blind} сотрудников не заполнена дата приёма — состав месяца восстановить нельзя, полнота фонда не подтверждена.`
      : (out.worked.length ? null : 'По датам приёма и увольнения в этом месяце не работал никто — проверьте карточки сотрудников.');
  } catch (e) {
    out.note = 'Состав сотрудников за месяц прочитать не удалось: ' + e.message + '. Полнота фонда не подтверждена.';
  }
  return out;
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
          !payroll.staff_known ? (payroll.staff_note || 'Состав сотрудников за месяц неизвестен — полнота фонда не подтверждена.')
            : (payroll.complete
              ? `Начисление есть у каждого из ${payroll.staff_worked} работавших в этом месяце.`
              : [
                payroll.staff_missing_people.length
                  ? `Работали в месяце, но начисления нет: ${payroll.staff_missing_people.slice(0, 8).join(', ')}`
                    + (payroll.staff_missing_people.length > 8 ? ` и ещё ${payroll.staff_missing_people.length - 8}` : '') + '.'
                  : null,
                payroll.staff_extra_people.length
                  ? `Начисление есть, но по датам в месяце не работали: ${payroll.staff_extra_people.slice(0, 8).join(', ')}.`
                  : null,
              ].filter(Boolean).join(' ')),
          payroll.fund_diff_pct !== null && Math.abs(payroll.fund_diff_pct) >= 10
            ? `Начислено на ${Math.round(payroll.fund_diff_pct)}% ${payroll.fund_diff_pct > 0 ? 'больше' : 'меньше'} фонда окладов того месяца — проверьте премии и удержания.`
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
// От прибыли к деньгам: почему при прибыли нет денег
// ---------------------------------------------------------------------------
// Это НЕ отдельный отчёт и не «мостик» сбоку. Это вторая половина ДДС, которой у
// нас не было: прямая форма («пришло — ушло по статьям») отвечает, сколько денег
// двигалось, а косвенная — почему прибыль не равна деньгам. Поэтому блок живёт
// внизу Кэш-флоу, рядом с разделами «операционный / инвестиции / финансы».
//
// Правило чтения: прибыль — это про отгрузку и начисление, деньги — про оплату.
// Разница между ними складывается из того, что продали в долг, купили в долг,
// вернули долгов, вложили в стройку и оборудование.
//
// Честность важнее красоты: то, что не объясняется имеющимися данными, остаётся
// отдельной строкой «необъяснено». Её главная часть — дебиторка на даты
// (её в системе нет) и зарплата, выплаченная за другие месяцы.
async function profitToCash(pool, period, pnl) {
  const from = period + '-01';
  const to = (await pool.query(
    "SELECT to_char(($1::date + INTERVAL '1 month') - INTERVAL '1 day', 'YYYY-MM-DD') AS d",
    [from])).rows[0].d;

  // Деньги на начало и конец — тем же выражением, каким Касса считает остаток
  // кошелька на дату (walletBalanceUpTo): приход плюс, расход минус, перевод —
  // плюс получателю и минус отправителю, а неподтверждённый обнал получателю не
  // зачисляется (с банка ушло, в кассу не пришло).
  //
  // Считаем ТОЛЬКО по активным кошелькам. Первая версия складывала все движения
  // подряд и давала минус 2,3 млрд вместо 80 млн: в журнале есть операции без
  // кошелька и по отключённым счетам, и они в остаток не входят.
  const bal = async (d) => num((await pool.query(
    `SELECT COALESCE(SUM(CASE
              WHEN t.tx_type = 'in' AND t.wallet_id = w.id THEN t.amount
              WHEN t.tx_type = 'out' AND t.wallet_id = w.id THEN -t.amount
              WHEN t.tx_type = 'transfer' AND t.wallet_to_id = w.id AND NOT t.needs_cash_confirm THEN t.amount
              WHEN t.tx_type = 'transfer' AND t.wallet_id = w.id THEN -t.amount
              ELSE 0 END), 0) AS b
       FROM cash_wallets w
       LEFT JOIN cash_transactions t ON t.tx_date <= $1
      WHERE w.status = 'active'`, [d])).rows[0].b);
  const opening = await bal((await pool.query(
    "SELECT to_char($1::date - INTERVAL '1 day', 'YYYY-MM-DD') AS d", [from])).rows[0].d);
  const closing = await bal(to);

  // Деньги месяца по статьям: что привлекли и что вернули.
  const codes = (await pool.query(
    `SELECT c.code,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'in'), 0) AS inc,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'out'), 0) AS exp
       FROM cash_transactions t JOIN cash_categories c ON c.id = t.category_id
      WHERE t.tx_date BETWEEN $1 AND $2 AND t.source <> 'opening'
      GROUP BY c.code`, [from, to])).rows;
  const by = new Map(codes.map((r) => [String(r.code), { inc: num(r.inc), exp: num(r.exp) }]));
  const got = (code, side) => ((by.get(code) || {})[side] || 0);

  const borrowed = ['201', '202', '203'].reduce((t, c) => t + got(c, 'inc'), 0);
  const repaid = ['61', '63'].reduce((t, c) => t + got(c, 'exp'), 0);
  const capex = num((pnl.excluded && pnl.excluded.capex && pnl.excluded.capex.total) || 0);
  const rawPaid = num((pnl.cogs_parts && pnl.cogs_parts.raw_paid) || 0);
  const rawReceived = (pnl.cogs_parts && pnl.cogs_parts.raw_source === 'purchase')
    ? num(pnl.cogs_parts.raw) : null;
  const shipped = pnl.revenue.source === 'shipped' ? num(pnl.revenue.total) : null;
  const cashForGoods = pnl.revenue.cash_in_sales === undefined
    ? num(pnl.revenue.cash_in) : num(pnl.revenue.cash_in_sales);
  const net = pnl.net_profit === undefined || pnl.net_profit === null ? null : num(pnl.net_profit);

  const steps = [];
  const add = (key, label, amount, why) => steps.push({ key, label, amount, why });

  if (shipped !== null) {
    add('ar', 'Продали в долг: отгрузили больше, чем получили деньгами',
      -(shipped - cashForGoods),
      `Отгружено ${mln(shipped)}, деньгами за товар пришло ${mln(cashForGoods)}. `
      + 'Разница осталась у клиентов. Это главная причина, по которой прибыль есть, а денег нет.');
  }
  if (rawReceived !== null) {
    add('ap', 'Купили в долг: приняли сырья больше, чем оплатили',
      rawReceived - rawPaid,
      `Принято сырья на ${mln(rawReceived)}, оплачено поставщикам ${mln(rawPaid)}. `
      + 'Плюс означает, что часть сырья ещё не оплачена — деньги пока у нас, долг растёт.');
  }
  if (repaid) {
    add('repaid', 'Вернули кредиты и долги', -repaid,
      'Возврат тела кредита и долгов (статьи 61, 63). В прибыли этого расхода нет — '
      + 'это свои деньги, отданные обратно, но из кассы они уходят.');
  }
  if (borrowed) {
    add('borrowed', 'Привлекли займы и кредиты', borrowed,
      'Статьи 201–203. В прибыль не идёт — это не заработок, а деньги в долг.');
  }
  if (capex) {
    add('capex', 'Вложили в оборудование и стройку', -capex,
      'Капвложения в прибыль не входят, но деньги тратят.');
  }

  const sum = steps.reduce((t, x) => t + num(x.amount), 0);
  const expected = net === null ? null : net + sum;
  const actual = closing - opening;
  const residual = expected === null ? null : actual - expected;

  return {
    period, from, to,
    opening, closing, actual,
    net_profit: net,
    steps,
    expected,
    residual,
    // Что лежит в «необъяснено» — говорим прямо, чтобы цифру не принимали за ошибку счёта.
    residual_note: 'Сюда попадает всё, чего система пока не знает по датам: зарплата, выплаченная '
      + 'за другие месяцы, авансы клиентам и поставщикам, оплаты расходов прошлых периодов. '
      + 'Главный недостающий кусок — долг клиентов на начало и конец месяца: его в системе нет, '
      + 'и пока он не появится, строка будет крупной.',
    note: net === null
      ? 'Прибыль месяца посчитать не из чего, поэтому переход от прибыли к деньгам не строится.'
      : null,
  };
}

const mln = (v) => (Math.round((Number(v) || 0) / 1e6 * 10) / 10) + ' млн';

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
  let rows;
  try {
    rows = await loadReceiptDates(pool, period);
  } catch (e) {
    // Сломался запрос — это «не знаю», а не «расхождений нет». Раньше здесь
    // возвращался пустой список, и экран уверенно сообщал, что переход на
    // фактические даты ничего не изменил.
    return {
      period, available: false, orders: 0, moved: [],
      left_amount: null, came_amount: null, profit_effect: null,
      note: 'Сверка приёмок недоступна: ' + e.message
        + '. Вывода о причинах изменения прибыли по сырью сделать нельзя.',
    };
  }

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
    available: true,
    orders: rows.length,
    moved,
    left_amount: left,
    came_amount: came,
    // Итог: на сколько сырьё месяца стало меньше (плюс к прибыли) или больше.
    profit_effect: left - came,
    note: moved.length
      ? 'Эти заявки учтены не в том месяце, в каком были запланированы. Если дата приёмки '
        + 'не совпадает с документом поставщика, её исправляет закупщик в Закупе — по документу, а не под результат. '
        + 'Таблица показывает, как новое правило влияет на СЕГОДНЯШНИЕ документы; объяснить, почему цифра изменилась '
        + 'задним числом, можно только сравнением с исходным расчётом месяца.'
      : 'Заявок, у которых плановая и фактическая даты приёмки в разных месяцах, нет: '
        + 'на сегодняшних документах новое правило сырьё этого месяца не меняет.',
  };
}

// Запрос вынесен отдельно, чтобы ошибку базы нельзя было принять за пустой
// результат: он либо отдаёт строки, либо падает.
async function loadReceiptDates(pool, period) {
  const rows = (await pool.query(
    `SELECT po.id,
            -- Даты просим ТЕКСТОМ: колонку date драйвер отдаёт объектом Date, и
            -- на экране получалось «Sun Aug 30» без года вместо 30.08.2026.
            to_char(po.delivery_date, 'YYYY-MM-DD') AS delivery_date,
            to_char(po.received_at::date, 'YYYY-MM-DD') AS received_date,
            c.name AS supplier,
            COALESCE(SUM(COALESCE(i.fact_qty, 0) * i.price), 0) AS amount,
            to_char(po.delivery_date, 'YYYY-MM') AS plan_month,
            to_char(${RD}, 'YYYY-MM') AS fact_month
       FROM purchase_orders po
       JOIN purchase_order_items i ON i.order_id = po.id AND i.item_kind = 'raw'
       LEFT JOIN ref_counterparties c ON c.id = po.supplier_id
      WHERE po.status = 'received'
        AND (to_char(po.delivery_date, 'YYYY-MM') = $1
             OR to_char(${RD}, 'YYYY-MM') = $1)
      GROUP BY po.id, po.delivery_date, po.received_at, c.name
      ORDER BY po.delivery_date, po.id`, [period])).rows;
  return rows;
}

// ---------------------------------------------------------------------------
// Внесение подтверждённой даты поставки
// ---------------------------------------------------------------------------
// Дату вносит человек по документу поставщика — по одной заявке, не скриптом.
// Правило Шоха (01.10.2026): задним числом пачкой не переносим, каждое изменение
// попадает в журнал, и сразу видно, на какие месяцы оно повлияло.
//
// Что возвращается: прежний месяц, новый месяц, сумма сырья заявки и признак,
// закрыт ли затронутый период. Закрытый месяц НЕ перезаписывается — его снимок
// остаётся, а расхождение показывается сравнением.
async function confirmDeliveryDate(pool, { orderId, date, doc, who, log }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('Дата указывается как 2026-08-29');
  }
  const before = (await pool.query(
    `SELECT po.id, po.number, po.delivery_date, po.received_at::date AS received_date,
            po.delivery_confirmed_date AS confirmed,
            to_char(${RD}, 'YYYY-MM') AS month_before,
            COALESCE((SELECT SUM(COALESCE(i.fact_qty, 0) * i.price) FROM purchase_order_items i
                       WHERE i.order_id = po.id AND i.item_kind = 'raw'), 0) AS raw_amount
       FROM purchase_orders po WHERE po.id = $1`, [orderId])).rows[0];
  if (!before) throw new Error('Заявка не найдена');

  const monthAfter = String(date).slice(0, 7);
  await pool.query(
    `UPDATE purchase_orders
        SET delivery_confirmed_date = $1::date,
            delivery_confirmed_doc = COALESCE($2, ''),
            delivery_confirmed_by = $3,
            delivery_confirmed_at = now()
      WHERE id = $4`, [date, doc ? String(doc).slice(0, 200) : '', who || 'не указан', orderId]);

  // В журнал — чтобы потом было видно, почему цифра месяца изменилась.
  if (log) {
    await log('purchase_delivery_date', JSON.stringify({
      order: before.number || orderId,
      was_month: before.month_before, now_month: monthAfter,
      date, doc: doc || '', raw: Math.round(num(before.raw_amount)),
    })).catch(() => {});
  }

  return {
    order_id: orderId,
    number: before.number,
    plan_date: before.delivery_date ? String(before.delivery_date).slice(0, 10) : null,
    marked_date: before.received_date ? String(before.received_date).slice(0, 10) : null,
    was_confirmed: before.confirmed ? String(before.confirmed).slice(0, 10) : null,
    confirmed_date: date,
    raw_amount: num(before.raw_amount),
    month_before: before.month_before,
    month_after: monthAfter,
    moved: before.month_before !== monthAfter,
    // Что это значит для прибыли: сырьё уходит из одного месяца в другой.
    effect: before.month_before === monthAfter ? null
      : `Сырьё на ${Math.round(num(before.raw_amount) / 1e6 * 10) / 10} млн переходит из ${before.month_before} в ${monthAfter}: `
        + `прибыль ${before.month_before} вырастет, прибыль ${monthAfter} уменьшится на эту сумму.`,
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

  // Сырьё: обычно совпадает (оба источника — приёмки Закупа), но если
  // действующий отчёт подставил оплаты поставщикам, разница есть, и её надо
  // показать отдельным шагом — иначе итог не сойдётся.
  if (a.raw !== null) {
    const rawOld = num(parts.raw);
    if (Math.abs(rawOld - a.raw) >= 1) {
      add('raw', 'Сырьё: источник месяца', rawOld - a.raw,
        parts.raw_source === 'purchase'
          ? 'Обе методики берут приёмки Закупа — расхождение означает разные наборы заявок, это надо разобрать.'
          : `Действующий отчёт при отсутствии приёмок подставил оплаты поставщикам (${Math.round(rawOld / 1e6)} млн), `
            + 'расчёт по начислению берёт только приёмки.');
    }
  }

  const known = steps.every((x) => x.amount !== null);
  const sum = steps.reduce((t, x) => t + num(x.amount), 0);
  // Итог — НЕ «старый плюс шаги». Это прибыль, посчитанная новой методикой
  // самостоятельно, со своей выручкой, расходами и налогами.
  const to = a.net === null ? null : num(a.net);
  // А вот теперь проверка имеет смысл: сходится ли старый итог плюс объяснённые
  // шаги с независимо посчитанным новым. Раньше здесь сравнивалось «from + sum»
  // с «from + sum» — такое равенство выполняется само и ничего не проверяет.
  // Невязка означает ровно одно: есть изменение, которое мы не назвали.
  const residual = (from === null || to === null || !known) ? null : to - (from + sum);

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
    const pr = accrual.payroll;
    unconfirmed.push({
      key: 'payroll_gap',
      label: 'Полнота фонда зарплаты за месяц',
      note: !pr.staff_known
        ? (pr.staff_note || 'Состав сотрудников за месяц восстановить нельзя — полнота фонда не подтверждена.')
        : `Начисление есть у ${pr.staff_covered} из ${pr.staff_worked} работавших в этом месяце`
          + (pr.staff_missing_people && pr.staff_missing_people.length
            ? `; без начисления: ${pr.staff_missing_people.slice(0, 5).join(', ')}` : '') + '.',
    });
  }

  if (residual !== null && Math.abs(residual) >= 1) {
    // Невязку показываем как строку, а не прячем: это честнее, чем «подогнать».
    steps.push({
      key: 'residual', label: 'Необъяснённая разница',
      amount: residual,
      why: 'Старая прибыль плюс перечисленные изменения не дают новый итог. '
        + 'Значит, есть ещё одно отличие методик, которое здесь не названо. Его надо найти, а не списать.',
    });
  }

  return {
    from, to, steps, unconfirmed,
    residual,
    // Сходится ли разбор: сумма объяснённых шагов равна разнице итогов.
    // null — одну из цифр посчитать не из чего.
    checks_out: residual === null ? null : Math.abs(residual) < 1,
    note: to === null
      ? 'Новый результат посчитать не из чего: не хватает данных по одной из строк.'
      : ((residual !== null && Math.abs(residual) >= 1)
        ? 'Разбор неполный: перечисленные изменения не объясняют всю разницу между отчётами.'
        : 'Это предварительный результат: он учитывает только объяснённые изменения. '
          + 'Неподтверждённые суммы ниже в него не входят.'),
  };
}

module.exports = { buildAccrual, compareMethods, bridge, profitToCash, rawDateAudit, confirmDeliveryDate, staffOfMonth, accruedPayroll, packagingByNorms, snapshotPackNorms, PACK_SNAP_KEY, SALARY_CODES, OPEN_QUESTIONS };
