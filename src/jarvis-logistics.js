// jarvis-logistics.js — сводка по доставке логисту, на стороне Джарвиса.
//
// Та же граница, что у претензий (решение Шоха 24.09.2026): водители в поле
// остаются в клиентском боте — он напоминает им отметить «Доставлен». Логист
// же сотрудник Hub с ролью и правами, поэтому его сводку ведёт Джарвис, рядом
// с доставками по водителям, которые теперь копятся в нашей базе.
//
// Пока правило logistics_digest выключено, модуль молчит и сводку шлёт бот.

const db = require('./db');
const integrations = require('./integrations');

const TZ = 5 * 3600000;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
  'сентября', 'октября', 'ноября', 'декабря'];
const dayWords = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
// Дата доставки — та же, что в напоминаниях водителям, иначе цифры разойдутся.
const deliveryDate = (o) => String(o.dateDocument || o.dateShipment || '').slice(0, 10);
const zakazov = (n) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return n + ' заказов';
  if (b === 1) return n + ' заказ';
  if (b >= 2 && b <= 4) return n + ' заказа';
  return n + ' заказов';
};
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Заказы дня из SalesDoctor. Статусы 1–4: нужен и «ещё не отгружен», иначе
// в сводке не видно, что половина дня вообще не уехала со склада.
async function fetchOrders(day) {
  const cfg = await integrations.getSdConfig();
  if (!cfg.url || !cfg.login || !cfg.password) throw new Error('SalesDoctor не настроен');
  const auth = await integrations.sdLogin(cfg);
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const data = await integrations.sdRequest(cfg.url, {
      method: 'getOrder',
      auth: { userId: auth.userId, token: auth.token },
      params: { limit: 500, page, filter: { period: { date: { from: day, to: day } }, status: [1, 2, 3, 4] } },
    });
    const items = (data.result && data.result.order) || [];
    out.push(...items);
    if (items.length < 500) break;
  }
  return out;
}

// Текст сводки. Чистая функция — проверяется тестом.
//   orders   — заказы SalesDoctor (статусы 1–4);
//   nameOf   — { sd_id водителя: имя };
//   morning  — утренний вариант (итог вчерашнего дня).
function buildDigest({ day, orders, nameOf = {}, morning = false }) {
  const planned = orders.filter((o) => deliveryDate(o) === day);
  const st = (o) => Number(o.status);
  const delivered = planned.filter((o) => st(o) === 3 || st(o) === 4).length;
  const shipped = planned.filter((o) => st(o) === 2).length;
  const notShipped = planned.filter((o) => st(o) === 1).length;
  const older = orders.filter((o) => st(o) === 2 && deliveryDate(o) && deliveryDate(o) < day).length;

  // Кто не закрыл: все «Отгружен» по этот день включительно, по водителям.
  const byExp = new Map();
  for (const o of orders) {
    if (st(o) !== 2 || !deliveryDate(o) || deliveryDate(o) > day) continue;
    const ex = (o.expeditor && o.expeditor.SD_id) || '';
    byExp.set(ex, (byExp.get(ex) || 0) + 1);
  }
  if (!planned.length && !byExp.size) return null;

  const pct = planned.length ? Math.round((delivered / planned.length) * 100) : 0;
  const lines = [
    morning ? `🚚 <b>Доставка за ${dayWords(day)}</b> — итог на утро` : `🚚 <b>Доставка за ${dayWords(day)}</b> — итог дня`,
    '',
    `План на день: ${zakazov(planned.length)}`,
    `✅ Доставлено: ${delivered}${planned.length ? ` из ${planned.length} (${pct}%)` : ''}`,
    `📦 Висит «Отгружен»: ${shipped}`,
  ];
  if (notShipped) lines.push(`🕓 Ещё не отгружено: ${notShipped}`);
  if (older) lines.push(`⏳ Висят «Отгружен» с прошлых дней: ${older}`);

  if (byExp.size) {
    lines.push('', 'Не отметили «Доставлен»:');
    [...byExp.entries()].sort((a, b) => b[1] - a[1]).forEach(([ex, n]) => {
      lines.push(`👤 ${esc(ex ? (nameOf[ex] || ex) : 'без водителя в заказе')} — ${n}`);
    });
    lines.push('', 'Проверьте в SalesDoctor и попросите отметить «Доставлен».');
  } else {
    lines.push('', 'Все отгруженные заказы отмечены «Доставлен» 👍');
  }
  return lines.join('\n');
}

// Имена водителей — из справочника, который бот сверяет с SalesDoctor.
async function driverNames() {
  try {
    const r = await db.pool.query('SELECT sd_id, name FROM tgbot.crm_expeditors');
    return Object.fromEntries(r.rows.map((x) => [x.sd_id, x.name]));
  } catch (e) { return {}; }
}

// Кому: люди роли «логистика» в ERP плюс админы, подключённые к Джарвису.
async function recipients() {
  const r = await db.pool.query(
    `SELECT DISTINCT u.jv_chat_id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = TRUE AND u.jv_chat_id IS NOT NULL
        AND (r.bot_role = 'logistics' OR r.is_admin = TRUE)`);
  return r.rows.map((x) => x.jv_chat_id);
}

const localDay = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);

// Вечером — итог сегодняшнего дня, утром — вчерашнего (кто-то закрывает ночью).
async function digestFor(nowMs, morning) {
  const day = morning ? localDay(nowMs - 86400000) : localDay(nowMs);
  const orders = await fetchOrders(day);
  return { day, text: buildDigest({ day, orders, nameOf: await driverNames(), morning }) };
}

module.exports = { buildDigest, deliveryDate, fetchOrders, driverNames, recipients, digestFor, localDay };
