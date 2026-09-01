// health.js — состояние внешних связей Hub для индикаторов в шапке.
//
// Зачем: SalesDoctor и бот отваливаются молча. Отчёт приходит пустым, и
// понять, это «данных нет» или «связь оборвалась», по экрану нельзя —
// выясняется только когда кто-то заметит странные цифры.
//
// Эндпоинт нарочно дешёвый: состояние SalesDoctor берётся из памяти процесса
// (его пишет integrations.js на каждом обращении), активность бота — одним
// запросом к его журналу. Ответ кэшируется, чтобы шапка на каждой вкладке
// не дёргала базу.
const express = require('express');
const db = require('./db');
const integrations = require('./integrations');

const router = express.Router();

const CACHE_MS = 20000;
let cache = { at: 0, data: null };

// Бот пишет в журнал только при действиях людей. Ночью тишина — это норма,
// а не поломка, поэтому «молчит» и «сломан» разводим по времени суток:
// до 6 часов тишины — спокойно, до двух суток — предупреждение.
const OK_HOURS = 6;
const WARN_HOURS = 48;

// Отдельно от запроса к базе, чтобы пороги можно было проверить тестом.
function classifyBot(last, now = Date.now()) {
  if (!last) return { state: 'unknown', last: null, note: 'В журнале бота пока нет событий' };
  const hours = (now - new Date(last).getTime()) / 3600000;
  if (hours <= OK_HOURS) return { state: 'ok', last, hours };
  if (hours <= WARN_HOURS) return { state: 'quiet', last, hours };
  return { state: 'stale', last, hours };
}

async function botActivity() {
  try {
    const r = await db.pool.query(
      `SELECT to_char(MAX(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last
       FROM tgbot.bot_events`);
    return classifyBot(r.rows[0] && r.rows[0].last);
  } catch (e) {
    // Схемы бота может не быть на свежей базе — это не ошибка Hub.
    return { state: 'unknown', last: null, note: 'Журнал бота недоступен' };
  }
}

router.get('/api/health/links', async (req, res) => {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);
  const [sd, bot] = await Promise.all([
    integrations.sdHealth().catch(() => ({ state: 'unknown' })),
    botActivity(),
  ]);
  const data = { sd, bot, at: new Date().toISOString() };
  cache = { at: Date.now(), data };
  res.json(data);
});

// Проверка связи с SalesDoctor по кнопке. Медленная (реальный вход в CRM),
// поэтому только по явному нажатию и только тем, кто настраивает интеграции.
router.post('/api/health/sd-check', async (req, res) => {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Только администратор' });
  try {
    await integrations.testConnection();
    cache = { at: 0, data: null };
    res.json({ ok: true });
  } catch (e) {
    cache = { at: 0, data: null };
    res.status(200).json({ ok: false, error: e.message });
  }
});

module.exports = router;
module.exports.classifyBot = classifyBot;
