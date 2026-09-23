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
        WHERE day > CURRENT_DATE - 28 AND day <= CURRENT_DATE - 14 GROUP BY 1),
     -- Имя менеджера SalesDoctor в заказ не кладёт, только код агента,
     -- поэтому имя берём из справочника агентов (tgbot.crm_agents).
     agent AS (
       SELECT DISTINCT ON (s.client_name) s.client_name,
              COALESCE(NULLIF(s.agent_name, ''), a.sd_agent_name) AS agent_name
         FROM sd_sales s
         LEFT JOIN tgbot.crm_agents a ON a.sd_agent_id = s.agent_sd
        WHERE s.day > CURRENT_DATE - 56
          AND COALESCE(NULLIF(s.agent_name, ''), a.sd_agent_name) IS NOT NULL
        ORDER BY s.client_name, s.day DESC)
     SELECT p.client_name, p.s AS was, COALESCE(c.s, 0) AS now_s, a.agent_name,
            ROUND((COALESCE(c.s, 0) - p.s) * 100.0 / NULLIF(p.s, 0)) AS pct
       FROM prev p LEFT JOIN cur c ON c.client_name = p.client_name
       LEFT JOIN agent a ON a.client_name = p.client_name
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
     cur AS (SELECT DISTINCT client_name FROM sd_sales WHERE day > CURRENT_DATE - 14),
     -- Имя менеджера SalesDoctor в заказ не кладёт, только код агента,
     -- поэтому имя берём из справочника агентов (tgbot.crm_agents).
     agent AS (
       SELECT DISTINCT ON (s.client_name) s.client_name,
              COALESCE(NULLIF(s.agent_name, ''), a.sd_agent_name) AS agent_name
         FROM sd_sales s
         LEFT JOIN tgbot.crm_agents a ON a.sd_agent_id = s.agent_sd
        WHERE s.day > CURRENT_DATE - 56
          AND COALESCE(NULLIF(s.agent_name, ''), a.sd_agent_name) IS NOT NULL
        ORDER BY s.client_name, s.day DESC)
     SELECT p.client_name, p.s AS was, p.days, a.agent_name
       FROM prev p LEFT JOIN cur c ON c.client_name = p.client_name
       LEFT JOIN agent a ON a.client_name = p.client_name
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

// «Молчуны»: кому Джарвис писал, а человек ни разу не отреагировал.
// Считаем по журналу: сколько ушло напоминаний и сколько было действий в ответ
// (ответ в карточку, поставленный срок). Ноль действий при трёх и более
// напоминаниях — человек просто не читает бота.
const SILENT_MIN_REMINDS = 3;
async function silentPeople(pool, days = 7) {
  return (await pool.query(
    `WITH sent AS (
       SELECT employee_id, COUNT(*)::int AS n FROM jarvis_log
        WHERE sent = TRUE AND employee_id IS NOT NULL
          AND created_at > now() - ($1 || ' days')::interval
          AND kind IN ('remind_mention', 'remind_no_due', 'remind_stale', 'remind_overdue',
                       'violation_mention', 'violation_overdue', 'violation_no_due', 'morning')
        GROUP BY 1),
     -- Реакцией считается ответ на дело, а не болтовня с ботом. Ответ прямо
     -- в карточке Trello — такая же реакция, как ответ через бота: раньше
     -- человек отвечал в Trello и всё равно попадал в «не отвечает».
     acted AS (
       SELECT employee_id, COUNT(*)::int AS n FROM jarvis_log
        WHERE employee_id IS NOT NULL AND created_at > now() - ($1 || ' days')::interval
          AND kind IN ('reply', 'due_set')
        GROUP BY 1
        UNION ALL
       SELECT employee_id, COUNT(*)::int AS n FROM jarvis_mentions
        WHERE employee_id IS NOT NULL AND answered_at > now() - ($1 || ' days')::interval
        GROUP BY 1),
     open_m AS (
       SELECT employee_id, COUNT(*)::int AS n FROM jarvis_mentions
        WHERE answered_at IS NULL AND employee_id IS NOT NULL GROUP BY 1)
     SELECT e.id AS employee_id, e.full_name, s.n AS reminds,
            COALESCE(o.n, 0) AS open_mentions, (u.jv_chat_id IS NOT NULL) AS in_bot
       FROM sent s
       JOIN hr_employees e ON e.id = s.employee_id AND e.status = 'active'
       LEFT JOIN users u ON u.id = e.erp_user_id
       LEFT JOIN (SELECT employee_id, SUM(n)::int AS n FROM acted GROUP BY 1) a ON a.employee_id = s.employee_id
       LEFT JOIN open_m o ON o.employee_id = s.employee_id
      WHERE COALESCE(a.n, 0) = 0 AND s.n >= $2
      ORDER BY s.n DESC LIMIT 10`, [String(days), SILENT_MIN_REMINDS])).rows;
}

// То же самое, но сгруппированное по менеджерам — для сводки РОПу.
// Решение Шоха (23.09.2026): агентов в Джарвиса не подключаем (у них уже есть
// клиентский бот, второй будет бардаком). Вместо этого РОП получает готовые
// куски по каждому менеджеру и пересылает их ему одним касанием.
async function clientsByManager(pool, rules) {
  const mute = ((rules && rules.mute_clients) || []).map((x) => String(x).toLowerCase());
  const muted = (n) => mute.some((m) => String(n || '').toLowerCase().includes(m));
  const by = new Map();
  const add = (agent, line) => {
    const key = agent || 'Без менеджера';
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(line);
  };
  for (const r of (await clientDrops(pool)).filter((x) => !muted(x.client_name))) {
    add(r.agent_name, `📉 ${r.client_name}: ${money(r.now_s)} за две недели против ${money(r.was)} — падение ${Math.abs(r.pct)}%`);
  }
  for (const r of (await clientsGone(pool)).filter((x) => !muted(x.client_name))) {
    add(r.agent_name, `🚫 ${r.client_name}: две недели тишины, до этого ${r.days} дней на ${money(r.was)}`);
  }
  return [...by.entries()].map(([manager, lines]) => ({ manager, lines }))
    .sort((a, b) => b.lines.length - a.lines.length);
}

// Наблюдения по плиткам: что показывать человеку с такими правами.
// Возвращает [{ tile, icon, text }] — текст уже готов, модель не нужна.
async function collect(pool, rules) {
  const mute = ((rules && rules.mute_clients) || []).map((x) => String(x).toLowerCase());
  const muted = (name) => mute.some((m) => String(name || '').toLowerCase().includes(m));
  const out = [];
  const safe = async (fn) => { try { await fn(); } catch (e) { console.warn('[НАБЛЮДЕНИЯ]', e.message); } };

  await safe(async () => {
    for (const r of (await clientDrops(pool)).filter((x) => !muted(x.client_name))) {
      out.push({ tiles: ['/cash', '/tgbot'], icon: '📉',
        text: `${r.client_name}${r.agent_name ? ' (менеджер ' + r.agent_name + ')' : ''}: за две недели ${money(r.now_s)} `
          + `против ${money(r.was)} двумя неделями раньше — падение ${Math.abs(r.pct)}%.` });
    }
  });
  await safe(async () => {
    for (const r of (await clientsGone(pool)).filter((x) => !muted(x.client_name))) {
      out.push({ tiles: ['/cash', '/tgbot'], icon: '🚫',
        text: `${r.client_name}${r.agent_name ? ' (менеджер ' + r.agent_name + ')' : ''} две недели ничего не брал, `
          + `а до этого брал ${r.days} дней на ${money(r.was)}.` });
    }
  });
  await safe(async () => {
    for (const r of await stockRunningOut(pool)) {
      // «остаток 0, хватит на 0 дней» — это округление, а не ноль. Говорим по-человечески.
      const left = Number(r.days_left) < 1 ? 'меньше дня' : `примерно на ${num1(r.days_left)} дн.`;
      const bal = Number(r.balance) < 1 ? 'почти нулевой' : `${num1(r.balance)} ${r.unit || ''}`;
      out.push({ tiles: ['/stock', '/purchase'], icon: '📦',
        text: `${r.name}: остаток ${bal}, расход ${num1(r.per_day)} ${r.unit || ''} в день — хватит ${left}.` });
    }
  });
  return out;
}

module.exports = { collect, clientDrops, clientsGone, stockRunningOut, silentPeople, clientsByManager, DROP_PCT, STOCK_DAYS_LEFT, SILENT_MIN_REMINDS };
