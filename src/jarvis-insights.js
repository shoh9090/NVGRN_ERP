// jarvis-insights.js — наблюдения Джарвиса: то, о чём никто не спросил.
//
// Решение Шоха: бот должен сам замечать и говорить — «Korzinka третью неделю
// берёт меньше», «остатков айсберга не хватит на завтра». Правила:
//   • считает СИСТЕМА, не модель: всё это обычные запросы к нашим данным;
//   • у каждого наблюдения есть основание — цифры, по которым видно, почему;
//   • не чаще раза в день и не больше пяти строк: поток сообщений убивает бота;
//   • кому — по плиткам роли, как везде (продажи продажникам, склад складу).

const db = require('./db');

const money = (v) => Math.round(Number(v) || 0).toLocaleString('ru-RU');
const num1 = (v) => (Math.round(Number(v) * 10) / 10).toLocaleString('ru-RU');

// Клиенты, которые стали брать заметно меньше: две недели против двух прошлых.
// Мелочь отсеиваем порогом суммы — иначе список забьют разовые точки.
const DROP_PCT = 25;
const DROP_MIN_AMOUNT = 2000000;      // сум за две недели — ниже это шум
async function clientDrops(pool) {
  return (await pool.query(
    `WITH cur AS (
       SELECT client_name, SUM(amount - returned) AS s FROM sd_sales
        WHERE day > CURRENT_DATE - 14 GROUP BY 1),
     prev AS (
       SELECT client_name, SUM(amount - returned) AS s FROM sd_sales
        WHERE day > CURRENT_DATE - 28 AND day <= CURRENT_DATE - 14 GROUP BY 1)
     SELECT p.client_name, p.s AS was, COALESCE(c.s, 0) AS now_s,
            ROUND((COALESCE(c.s, 0) - p.s) * 100.0 / NULLIF(p.s, 0)) AS pct
       FROM prev p LEFT JOIN cur c ON c.client_name = p.client_name
      WHERE p.s >= $1 AND COALESCE(c.s, 0) < p.s * (1 - $2 / 100.0)
      ORDER BY (p.s - COALESCE(c.s, 0)) DESC LIMIT 5`, [DROP_MIN_AMOUNT, DROP_PCT])).rows;
}

// Клиент совсем перестал брать: раньше брал регулярно, две недели тишина.
async function clientsGone(pool) {
  return (await pool.query(
    `WITH prev AS (
       SELECT client_name, SUM(amount - returned) AS s, COUNT(DISTINCT day) AS days
         FROM sd_sales WHERE day > CURRENT_DATE - 56 AND day <= CURRENT_DATE - 14
        GROUP BY 1),
     cur AS (SELECT DISTINCT client_name FROM sd_sales WHERE day > CURRENT_DATE - 14)
     SELECT p.client_name, p.s AS was, p.days
       FROM prev p LEFT JOIN cur c ON c.client_name = p.client_name
      WHERE c.client_name IS NULL AND p.days >= 4 AND p.s >= $1
      ORDER BY p.s DESC LIMIT 5`, [DROP_MIN_AMOUNT])).rows;
}

// Сырья хватит меньше чем на N дней при нынешнем расходе.
// Расход берём средний за неделю по реестру движений (выдачи, списания).
const STOCK_DAYS_LEFT = 2;
async function stockRunningOut(pool) {
  return (await pool.query(
    `WITH bal AS (
       SELECT item_kind, item_id, SUM(qty) AS balance FROM stock_movements
        GROUP BY 1, 2),
     spend AS (
       SELECT item_kind, item_id, SUM(-qty) / 7.0 AS per_day FROM stock_movements
        WHERE qty < 0 AND moved_at >= CURRENT_DATE - 7 GROUP BY 1, 2)
     SELECT rm.name, b.balance, s.per_day, u.short_name AS unit,
            b.balance / NULLIF(s.per_day, 0) AS days_left
       FROM bal b JOIN spend s ON s.item_kind = b.item_kind AND s.item_id = b.item_id
       JOIN ref_raw_materials rm ON rm.id = b.item_id AND b.item_kind = 'raw'
       LEFT JOIN ref_units u ON u.id = rm.unit_id
      -- Только то, что ЗАКАНЧИВАЕТСЯ. Нулевой остаток у зелени — норма:
      -- её не хранят, сколько приняли, столько в тот же день и ушло,
      -- поэтому «остаток 0» было бы ложной тревогой каждый день.
      WHERE s.per_day > 0 AND b.balance > 0
        AND b.balance / NULLIF(s.per_day, 0) < $1
        AND NOT COALESCE(rm.is_waste, FALSE)
      ORDER BY days_left LIMIT 5`, [STOCK_DAYS_LEFT])).rows;
}

// Наблюдения по плиткам: что показывать человеку с такими правами.
// Возвращает [{ tile, icon, text }] — текст уже готов, модель не нужна.
async function collect(pool) {
  const out = [];
  const safe = async (fn) => { try { await fn(); } catch (e) { console.warn('[НАБЛЮДЕНИЯ]', e.message); } };

  await safe(async () => {
    for (const r of await clientDrops(pool)) {
      out.push({ tiles: ['/cash', '/tgbot'], icon: '📉',
        text: `${r.client_name}: за две недели ${money(r.now_s)} против ${money(r.was)} двумя неделями раньше — падение ${Math.abs(r.pct)}%.` });
    }
  });
  await safe(async () => {
    for (const r of await clientsGone(pool)) {
      out.push({ tiles: ['/cash', '/tgbot'], icon: '🚫',
        text: `${r.client_name} две недели ничего не брал, а до этого брал ${r.days} дней на ${money(r.was)}.` });
    }
  });
  await safe(async () => {
    for (const r of await stockRunningOut(pool)) {
      out.push({ tiles: ['/stock', '/purchase'], icon: '📦',
        text: `${r.name}: остаток ${num1(r.balance)} ${r.unit || ''} — при нынешнем расходе (${num1(r.per_day)} в день) хватит примерно на ${num1(r.days_left)} дн.` });
    }
  });
  return out;
}

module.exports = { collect, clientDrops, clientsGone, stockRunningOut, DROP_PCT, STOCK_DAYS_LEFT };
