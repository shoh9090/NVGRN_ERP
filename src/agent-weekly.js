// agent-weekly.js — недельный список «кого обзвонить» торговому агенту.
//
// Решение Шоха (03.10.2026): агент должен сам видеть, кто из ЕГО клиентов за
// неделю взял меньше обычного или пропал совсем. Дважды в неделю:
//   • пятница утром — успеть дожать до выходных;
//   • понедельник утром — с кого начать неделю.
//
// Где что живёт. Считает Hub — по той же таблице sd_sales, что и наблюдения
// Джарвиса для РОПа (jarvis-insights): одна цифра на всех, иначе у агента и
// руководителя списки разойдутся. Отправляет Hub через КЛИЕНТСКИЙ бот: агент
// подключён к нему, а в Джарвиса агентов не тащим (решение 23.09.2026 — второй
// бот у агента будет бардаком). Токен клиентского бота в ERP уже есть
// (так же шлёт решения по претензиям src/jarvis-complaints.js).
//
// Правила, ломать нельзя:
//   • отстала выгрузка продаж — не шлём НИЧЕГО. Пустая неделя в данных
//     означала бы «все ваши клиенты пропали», и агент пошёл бы звонить людям,
//     которые на самом деле заказывали;
//   • «обычно» — среднее за неделю по предыдущим четырём неделям, а не одна
//     прошлая неделя: один праздник или одна отгрузка не должны делать «спад»;
//   • мелочь не беспокоит: клиент, который обычно берёт меньше порога, в
//     список не попадает — иначе звонить придётся всем и каждый день;
//   • клиент, которого РОП пометил «ушёл по-хорошему» (mute_clients в правилах
//     Джарвиса), молчит и у агента — один список исключений на всю систему.

const TZ = 5 * 3600000;                 // Ташкент, UTC+5
const DROP_PCT = 25;                    // падение от «обычного», с которого стоит звонить
const MIN_WEEK = 500000;                // сум в неделю: ниже — не повод дёргать агента
const GONE_MIN_DAYS = 4;                // «брал регулярно» = минимум 4 дня за 4 недели
const MAX_LINES = 12;                   // длиннее список никто не читает
const WINDOW_H = 3;                     // сколько часов после времени рассылки ещё можно слать
const STALE_DAYS = 2;                   // выгрузка продаж старше — считаем неполной

const money = (v) => Math.round(Number(v) || 0).toLocaleString('ru-RU');
const dm = (iso) => `${String(iso).slice(8, 10)}.${String(iso).slice(5, 7)}`;
const localDate = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// ---------- Чистые функции (их проверяет тест) ----------

// Пора ли слать и какой это день. Окно, а не точная минута: перезапуск сервиса
// ровно в 08:30 не должен означать, что сводка за этот день пропала совсем.
function dueKind(nowMs, sendAt, windowH = WINDOW_H) {
  const m = String(sendAt || '08:30').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const l = new Date(nowMs + TZ);
  const minutesNow = l.getUTCHours() * 60 + l.getUTCMinutes();
  const minutesSend = Number(m[1]) * 60 + Number(m[2]);
  if (minutesNow < minutesSend || minutesNow >= minutesSend + windowH * 60) return null;
  const day = l.getUTCDay();
  if (day === 5) return 'friday';
  if (day === 1) return 'monday';
  return null;
}

// Свежая ли выгрузка продаж. Нет данных за последние дни — молчим: пустые дни
// выглядят как «клиент перестал брать», а это неправда.
function dataFresh(maxDay, today, staleDays = STALE_DAYS) {
  if (!maxDay) return false;
  return Date.parse(String(maxDay).slice(0, 10)) >= Date.parse(today) - staleDays * 86400000;
}

// Строки из базы → по агентам, с разделением «просел» / «пропал».
// muted — куски названий клиентов, о которых не напоминать (из правил Джарвиса).
function groupByAgent(rows, muted = []) {
  const mute = muted.map((x) => String(x).toLowerCase()).filter(Boolean);
  const isMuted = (n) => mute.some((m) => String(n || '').toLowerCase().includes(m));
  const by = new Map();
  for (const r of rows) {
    if (!r.agent_sd) continue;
    if (isMuted(r.client_name)) continue;
    const now = Number(r.now_s) || 0;
    const usual = Number(r.usual) || 0;
    const gone = now <= 0;
    // Пропал — только тот, кто брал регулярно: разовая отгрузка месяц назад
    // это не «клиент перестал работать», звонить по ней нечего.
    if (gone && Number(r.days) < GONE_MIN_DAYS) continue;
    const key = String(r.agent_sd);
    if (!by.has(key)) by.set(key, { agent_sd: key, agent_name: r.agent_name || null, drops: [], gone: [] });
    const g = by.get(key);
    const item = { name: r.client_name || r.client_sd, now, usual, lost: usual - now, days: Number(r.days) || 0 };
    (gone ? g.gone : g.drops).push(item);
  }
  for (const g of by.values()) {
    g.gone.sort((a, b) => b.usual - a.usual);
    g.drops.sort((a, b) => b.lost - a.lost);
  }
  return [...by.values()].sort((a, b) => (b.gone.length + b.drops.length) - (a.gone.length + a.drops.length));
}

// Текст сообщения агенту. null — писать не о чем.
function formatMessage(group, { kind, from, to }) {
  const all = [
    ...group.gone.map((c) => ({ sort: c.usual, text: `🚫 ${c.name} — неделю тишины, обычно ${money(c.usual)} в неделю` })),
    ...group.drops.map((c) => ({
      sort: c.lost,
      text: `📉 ${c.name} — ${money(c.now)} за неделю, обычно ${money(c.usual)}`
        + ` (меньше на ${Math.round((1 - c.now / c.usual) * 100)}%)`,
    })),
  ];
  if (!all.length) return null;
  all.sort((a, b) => b.sort - a.sort);
  const head = kind === 'friday'
    ? '📞 Кого обзвонить до выходных'
    : '📞 С кого начать неделю';
  const lines = [head, `Неделя ${dm(from)}–${dm(to)}: эти клиенты взяли меньше обычного или не взяли совсем.`, ''];
  all.slice(0, MAX_LINES).forEach((x) => lines.push(x.text));
  if (all.length > MAX_LINES) lines.push(`…и ещё ${all.length - MAX_LINES}`);
  lines.push('', 'Позвоните и узнайте причину. Если клиент ушёл по-хорошему — скажите РОПу, уберём из списка.');
  return lines.join('\n').slice(0, 3900);
}

// ---------- Запросы и отправка ----------

// Клиенты, которые за последние 7 дней взяли заметно меньше обычного.
// «Обычно» = среднее за неделю по предыдущим четырём неделям.
// Агент у клиента — последний, кто ему отгружал (в SD клиент может перейти).
async function fetchRows(pool, { minWeek = MIN_WEEK, dropPct = DROP_PCT } = {}) {
  return (await pool.query(
    `WITH cur AS (
       SELECT client_sd, MAX(client_name) AS client_name, SUM(amount - returned) AS s
         FROM sd_sales WHERE day >= CURRENT_DATE - 7 AND day < CURRENT_DATE GROUP BY 1),
     prev AS (
       SELECT client_sd, MAX(client_name) AS client_name,
              SUM(amount - returned) / 4.0 AS week_avg, COUNT(DISTINCT day) AS days
         FROM sd_sales WHERE day >= CURRENT_DATE - 35 AND day < CURRENT_DATE - 7 GROUP BY 1),
     agent AS (
       SELECT DISTINCT ON (s.client_sd) s.client_sd, s.agent_sd,
              COALESCE(NULLIF(s.agent_name, ''), a.sd_agent_name) AS agent_name
         FROM sd_sales s LEFT JOIN tgbot.crm_agents a ON a.sd_agent_id = s.agent_sd
        WHERE s.day >= CURRENT_DATE - 35 AND COALESCE(s.agent_sd, '') <> ''
        ORDER BY s.client_sd, s.day DESC)
     SELECT p.client_sd, COALESCE(c.client_name, p.client_name) AS client_name,
            p.week_avg AS usual, COALESCE(c.s, 0) AS now_s, p.days,
            g.agent_sd, g.agent_name
       FROM prev p
       LEFT JOIN cur c ON c.client_sd = p.client_sd
       JOIN agent g ON g.client_sd = p.client_sd
      WHERE p.week_avg >= $1 AND COALESCE(c.s, 0) < p.week_avg * (1 - $2 / 100.0)
      ORDER BY (p.week_avg - COALESCE(c.s, 0)) DESC
      LIMIT 300`, [minWeek, dropPct])).rows;
}

// Чаты агентов в клиентском боте: код агента SalesDoctor → чат.
async function agentChats(pool) {
  const r = await pool.query(
    `SELECT crm_agent_id, MAX(telegram_chat_id) AS chat_id
       FROM tgbot.telegram_staff
      WHERE role = 'agent' AND status = 'confirmed'
        AND telegram_chat_id IS NOT NULL AND COALESCE(crm_agent_id, '') <> ''
      GROUP BY crm_agent_id`);
  const m = new Map();
  for (const x of r.rows) m.set(String(x.crm_agent_id), x.chat_id);
  return m;
}

// Отправка через клиентский бот (у него агент и живёт).
async function sendViaClientBot(chatId, text) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return false;
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(15000),
  });
  const d = await resp.json().catch(() => ({}));
  return !!d.ok;
}

// Схему бота заводит Hub (schema-first) — тем же кодом, что и плитка, без своей копии.
let _ready = false;
async function ensure(pool) {
  if (_ready) return;
  await require('./tgbot').ensureTables();
  _ready = true;
}

async function settings(pool) {
  const r = await pool.query(
    'SELECT digest_time, weekly_calls_enabled FROM tgbot.bot_settings WHERE id = 1');
  const s = r.rows[0] || {};
  return { sendAt: s.digest_time || '08:30', enabled: s.weekly_calls_enabled !== false };
}

// Один проход: посчитать, кому что, и разослать. Возвращает, скольким ушло.
async function run(pool, nowMs = Date.now()) {
  await ensure(pool);
  const cfg = await settings(pool);
  if (!cfg.enabled) return 0;
  const kind = dueKind(nowMs, cfg.sendAt);
  if (!kind) return 0;
  const today = localDate(nowMs);
  // Дату просим строкой: тип DATE приходит объектом Date, и сравнивать его как
  // «ГГГГ-ММ-ДД» нельзя — проверка свежести молча давала бы «данных нет».
  const maxDay = ((await pool.query("SELECT to_char(MAX(day), 'YYYY-MM-DD') AS d FROM sd_sales")).rows[0] || {}).d;
  if (!dataFresh(maxDay, today)) {
    console.warn('[ОБЗВОН] выгрузка продаж отстала (последний день ' + (maxDay || '—') + ') — сводку агентам не шлём');
    return 0;
  }
  let muted = [];
  try {
    const raw = JSON.parse(((await pool.query("SELECT value FROM settings WHERE key = 'jarvis_rules'")).rows[0] || {}).value || '{}');
    muted = require('./jarvis-rules').normalizeRules(raw).mute_clients || [];
  } catch (e) { muted = []; }
  const groups = groupByAgent(await fetchRows(pool), muted);
  if (!groups.length) return 0;
  const chats = await agentChats(pool);
  const period = { kind, from: addDays(today, -7), to: addDays(today, -1) };
  let sent = 0;
  for (const g of groups) {
    const chat = chats.get(String(g.agent_sd));
    if (!chat) continue;                                  // агент не подключён к боту — пропускаем
    const text = formatMessage(g, period);
    if (!text) continue;
    const key = `agweek:${g.agent_sd}:${today}`;
    // Сначала отметка, потом отправка: сбой сети не должен превращаться в
    // повтор каждую минуту всё окно рассылки.
    const ins = await pool.query(
      `INSERT INTO tgbot.notification_log (kind, dedup_key, target_chat_id, target_role)
       VALUES ('agent_weekly', $1, $2, 'agent') ON CONFLICT (dedup_key) DO NOTHING RETURNING id`, [key, chat]);
    if (!ins.rowCount) continue;                          // уже слали сегодня
    if (await sendViaClientBot(chat, text)) sent++;
  }
  if (sent) console.log(`[ОБЗВОН] Список «кому позвонить» (${kind === 'friday' ? 'пятница' : 'понедельник'}): агентов ${sent}`);
  return sent;
}

// Такт раз в минуту: само время рассылки берётся из плитки, здесь только проверка.
function start(pool) {
  const tick = () => run(pool).catch((e) => console.warn('[ОБЗВОН]', e.message));
  setTimeout(tick, 90 * 1000).unref();
  setInterval(tick, 60 * 1000).unref();
}

module.exports = {
  start, run, fetchRows, agentChats,
  dueKind, dataFresh, groupByAgent, formatMessage,
  DROP_PCT, MIN_WEEK, GONE_MIN_DAYS, MAX_LINES,
};
