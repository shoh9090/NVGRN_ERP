// salesplan-core.js — счётная часть плитки «План продаж», без базы и без сети.
//
// Здесь живёт то, что должно проверяться автоматически: границы недели, итоги,
// различие «ноль» и «не заполнено», разбор рабочего файла Excel. В образце
// Шоха («ГП с 14.09.2026 по 20,09,2026.xlsx») итог розницы считался формулой
// по строкам 26–42 и не брал 4 последних товара: в файле неделя 14 060 штук,
// а по всем строкам 18 340 — разница 4 280 (23%). Поэтому итоги в ERP всегда
// считаются из строк, а из файла не берутся никогда.

const DAY = 86400000;
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const pad = (n) => String(n).padStart(2, '0');
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Дата как UTC-полдень: так сдвиг часового пояса не уводит день на соседний.
function at(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}
const isoOf = (dt) => dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());

// Понедельник недели, в которую попала дата. Неделя у нас Пн–Вс, как в рабочем файле.
function weekStart(iso) {
  if (!isIso(iso)) throw new Error('Дата должна быть в виде ГГГГ-ММ-ДД');
  const d = at(iso);
  const shift = (d.getUTCDay() + 6) % 7;        // Пн=0 … Вс=6
  return isoOf(new Date(d.getTime() - shift * DAY));
}

// Семь дней недели: [{ day, wd, label }]
function weekDays(anyDayOfWeek) {
  const from = weekStart(anyDayOfWeek);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(at(from).getTime() + i * DAY);
    out.push({ day: isoOf(d), wd: WD[i], label: d.getUTCDate() + '.' + pad(d.getUTCMonth() + 1) });
  }
  return out;
}

// Отрезок дней от и до включительно (для вида «месяц» и «квартал»).
function daysBetween(from, to) {
  if (!isIso(from) || !isIso(to)) throw new Error('Отрезок задаётся датами ГГГГ-ММ-ДД');
  let a = from, b = to;
  if (a > b) { const t = a; a = b; b = t; }      // перепутали местами — это опечатка
  const out = [];
  for (let d = at(a); isoOf(d) <= b; d = new Date(d.getTime() + DAY)) out.push(isoOf(d));
  return out;
}

const weekShift = (anyDay, weeks) => isoOf(new Date(at(weekStart(anyDay)).getTime() + weeks * 7 * DAY));

// День недели конкретной даты. Считать «Пн + номер колонки» нельзя: период
// может начинаться не с понедельника (месяц, произвольный отрезок).
const wdOf = (iso) => WD[(at(iso).getUTCDay() + 6) % 7];

// Подпись недели человеку: «14 — 20 сентября 2026».
function weekLabel(anyDay) {
  const from = at(weekStart(anyDay));
  const to = new Date(from.getTime() + 6 * DAY);
  const sameMonth = from.getUTCMonth() === to.getUTCMonth();
  const left = from.getUTCDate() + (sameMonth ? '' : ' ' + MONTHS_RU[from.getUTCMonth()]);
  return left + ' — ' + to.getUTCDate() + ' ' + MONTHS_RU[to.getUTCMonth()] + ' ' + to.getUTCFullYear();
}

// Штуки готовой продукции. Пустая строка/null — это «не заполнено» (вернём null),
// а не ноль: ноль означает принятое решение «ничего не планируем».
function parseQty(v) {
  if (v === null || v === undefined || v === '' || (typeof v === 'string' && !v.trim())) return null;
  const n = Number(String(v).replace(/\s+/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error('Количество должно быть числом');
  if (n < 0) throw new Error('Количество не может быть отрицательным');
  if (Math.abs(n - Math.round(n)) > 1e-9) throw new Error('План ведём в целых штуках');
  return Math.round(n);
}

// Итоги по строке и по дням. cells — { 'ГГГГ-ММ-ДД': число }.
// Заполненных клеток нет вовсе → итог null («не заполнено»), а не 0.
function rowTotal(cells, days) {
  let sum = 0, filled = 0;
  for (const d of days) {
    const v = cells ? cells[d] : undefined;
    if (v === null || v === undefined) continue;
    sum += Number(v); filled++;
  }
  return { qty: filled ? sum : null, filled };
}

// Свод по набору строк: итог каждого дня, итог периода, деньги.
// money у строки = итог штук × цена прайса; нет цены → null, а не 0.
function summarize(rows, days) {
  const byDay = {};
  for (const d of days) byDay[d] = { qty: null, money: null };
  let qty = null, money = null, noPrice = 0;
  for (const r of rows) {
    const price = r.price === null || r.price === undefined ? null : Number(r.price);
    if (price === null) noPrice++;
    for (const d of days) {
      const v = r.cells ? r.cells[d] : undefined;
      if (v === null || v === undefined) continue;
      byDay[d].qty = (byDay[d].qty || 0) + Number(v);
      qty = (qty || 0) + Number(v);
      if (price !== null) {
        byDay[d].money = (byDay[d].money || 0) + Number(v) * price;
        money = (money || 0) + Number(v) * price;
      }
    }
  }
  return { byDay, qty, money, noPrice };
}

// Профиль дня недели из факта: доля каждого дня в недельных продажах.
// Нужен, чтобы продажи могли задать неделю или месяц одним числом, а система
// разложила его по дням: пятница у ресторанов крупная, понедельник мелкий.
// Нет факта — возвращаем null, равномерную раскладку не выдаём за профиль.
function weekdayProfile(factRows) {
  const by = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  for (const r of factRows || []) {
    if (!isIso(r.day)) continue;
    const i = (at(r.day).getUTCDay() + 6) % 7;
    const q = Number(r.qty) || 0;
    by[i] += q; total += q;
  }
  if (total <= 0) return null;
  return by.map((v) => v / total);
}

// Разложить недельное количество по дням. profile — из weekdayProfile или null
// (тогда ровно по дням). Результат — целые штуки, остаток от округления
// отдаётся самым крупным дням, чтобы сумма совпала с заданной.
function spreadWeek(total, profile) {
  const n = 7;
  const t = Math.max(0, Math.round(Number(total) || 0));
  const p = (profile && profile.length === n) ? profile.slice() : new Array(n).fill(1 / n);
  const raw = p.map((x) => t * x);
  const out = raw.map((x) => Math.floor(x));
  let left = t - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k++, left--) out[order[k % n][1]]++;
  return out;
}

// Направление товара по «Направлению торговли», которое приходит из SalesDoctor.
// Сетка строится по нему сама: отдел продаж не должен каждую неделю руками
// набирать список товаров — он и так известен.
function channelOf(trade, channels) {
  const t = String(trade || '').trim().toLowerCase();
  if (!t) return null;
  const c = (channels || []).find((x) => String(x.sd_trade || '').trim().toLowerCase() === t
    || String(x.name || '').trim().toLowerCase() === t);
  return c ? c.code : null;
}

module.exports = {
  WD, weekStart, weekDays, weekShift, weekLabel, daysBetween, wdOf,
  parseQty, rowTotal, summarize, weekdayProfile, spreadWeek, channelOf,
};
