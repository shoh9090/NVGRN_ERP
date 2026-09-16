// logistics-digest.js — сводка по доставке руководителю логистики.
//
// Зачем: водителям бот напоминает отметить «Доставлен» (deliveryReminderTick),
// но проверить, отметили ли они, раньше мог только логист — нажав кнопку сам.
// Теперь итог приходит ему дважды:
//   • вечером — через 30 минут после последнего напоминания водителям;
//   • утром в 08:00 — итог вчерашнего дня на утро (кто-то закрывает ночью).
// В сводке: сколько было в плане, сколько доставлено, сколько висит «Отгружен»
// и кто из водителей получил напоминание, но так и не отметил.
//
// Дата доставки — та же, что в напоминаниях водителям (dateDocument, иначе
// dateShipment), чтобы цифры в сводке и в напоминаниях не расходились.

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const dayWords = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
const deliveryDate = (o) => String(o.dateDocument || o.dateShipment || '').slice(0, 10);
const zakazov = (n) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return n + ' заказов';
  if (b === 1) return n + ' заказ';
  if (b >= 2 && b <= 4) return n + ' заказа';
  return n + ' заказов';
};

// Чистая функция: текст сводки или null, если сообщать нечего.
//   day       — 'YYYY-MM-DD', день, по которому итог;
//   orders    — заказы из SalesDoctor (статусы 1–4);
//   nameOf    — { sd_id водителя: имя };
//   reminded  — Set водителей, которым в этот день ушло напоминание;
//   connected — Set водителей, подключённых к боту;
//   morning   — утренний вариант (итог вчерашнего дня на утро).
function buildLogisticsDigest({ day, orders, nameOf = {}, reminded = new Set(), connected = new Set(), morning = false }) {
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
    morning ? `🚚 Доставка за ${dayWords(day)} — итог на утро` : `🚚 Доставка за ${dayWords(day)} — итог дня`,
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
      const name = ex ? (nameOf[ex] || ex) : 'без водителя в заказе';
      let why = '';
      if (ex && reminded.has(ex)) why = morning ? ' · напоминание вчера получил, так и не отметил' : ' · напоминание получил, не отметил';
      else if (ex && !connected.has(ex)) why = ' · не подключён к боту — напоминание не дошло';
      lines.push(`👤 ${name} — ${n}${why}`);
    });
    lines.push('', 'Проверьте в SalesDoctor и попросите отметить «Доставлен».');
  } else {
    lines.push('', 'Все отгруженные заказы отмечены «Доставлен» 👍');
  }
  return lines.join('\n');
}

// Время вечерней сводки: через 30 минут после последнего напоминания водителям.
function eveningTime(remindTimes) {
  const last = [...(remindTimes || [])].filter((t) => /^\d{2}:\d{2}$/.test(t)).sort().pop() || '21:00';
  const [h, m] = last.split(':').map(Number);
  const total = Math.min(h * 60 + m + 30, 23 * 60 + 59);
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

module.exports = { buildLogisticsDigest, eveningTime, deliveryDate };
