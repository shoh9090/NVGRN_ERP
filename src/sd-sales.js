// sd-sales.js — подробные продажи из SalesDoctor в нашей базе.
//
// Зачем: SD отвечает десятки секунд, поэтому спрашивать его при каждом вопросе
// нельзя — бот будет висеть. Ночью забираем заказы и раскладываем по строкам
// «день + клиент + агент + товар», а Джарвис потом отвечает из нашей таблицы
// за доли секунды. Плюс это база для прогнозов: видно, кто сколько берёт и когда.
//
// Правило как в P&L (аудит A09): НЕПОЛНАЯ выгрузка не сохраняется. Лучше не
// иметь данных за день, чем иметь половину и считать по ней.

const db = require('./db');
const integrations = require('./integrations');

const TZ = 5 * 3600000;                 // Ташкент
const KEEP_MONTHS = 24;                 // глубина хранения (решение Шоха)
const STATUSES = [1, 2, 3, 4];          // новый, отправлен, доставлен, закрыт; 5 — отменён, не берём
const today = () => new Date(Date.now() + TZ).toISOString().slice(0, 10);

let _ready = false;
async function ensureSchema() {
  if (_ready) return;
  await db.pool.query(`CREATE TABLE IF NOT EXISTS sd_sales (
    day DATE NOT NULL,
    client_sd TEXT NOT NULL DEFAULT '',
    client_name TEXT NOT NULL DEFAULT '',
    agent_sd TEXT NOT NULL DEFAULT '',
    agent_name TEXT NOT NULL DEFAULT '',
    product_sd TEXT NOT NULL DEFAULT '',
    product_name TEXT NOT NULL DEFAULT '',
    qty NUMERIC NOT NULL DEFAULT 0,
    amount NUMERIC NOT NULL DEFAULT 0,
    returned NUMERIC NOT NULL DEFAULT 0,
    PRIMARY KEY (day, client_sd, agent_sd, product_sd)
  )`);
  await db.pool.query('CREATE INDEX IF NOT EXISTS idx_sd_sales_day ON sd_sales (day)');
  await db.pool.query('CREATE INDEX IF NOT EXISTS idx_sd_sales_client ON sd_sales (client_sd, day)');
  // Какие дни уже выгружены: без этого непонятно, «продаж не было» или «не забрали».
  await db.pool.query(`CREATE TABLE IF NOT EXISTS sd_sales_days (
    day DATE PRIMARY KEY,
    orders INT NOT NULL DEFAULT 0,
    rows INT NOT NULL DEFAULT 0,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _ready = true;
}

// Забор заказов за отрезок. Возвращает строки или бросает ошибку — половину не отдаём.
async function fetchRange(from, to) {
  const cfg = await integrations.getSdConfig();
  if (!cfg.url || !cfg.login || !cfg.password) throw new Error('SalesDoctor не настроен');
  const auth = await integrations.sdLogin(cfg);
  const rows = new Map();          // ключ день|клиент|агент|товар
  const days = new Map();          // день → число заказов
  const limit = 500;
  for (let page = 1; page <= 200; page++) {
    const data = await integrations.sdRequest(cfg.url, {
      method: 'getOrder',
      auth: { userId: auth.userId, token: auth.token },
      params: { limit, page, filter: { period: { date: { from, to } }, status: STATUSES } },
    });
    const items = (data.result && data.result.order) || [];
    for (const o of items) {
      const day = String(o.dateDocument || o.dateCreate || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      days.set(day, (days.get(day) || 0) + 1);
      const client = o.client || {}, agent = o.agent || {};
      for (const op of (o.orderProducts || [])) {
        const prod = op.product || {};
        const key = [day, client.SD_id || '', agent.SD_id || '', prod.SD_id || ''].join('|');
        const cur = rows.get(key) || {
          day, client_sd: client.SD_id || '', client_name: client.clientName || client.name || '',
          agent_sd: agent.SD_id || '', agent_name: agent.name || '',
          product_sd: prod.SD_id || '', product_name: prod.name || '', qty: 0, amount: 0, returned: 0,
        };
        cur.qty += Number(op.quantity) || 0;
        cur.amount += Number(op.summa) || 0;
        cur.returned += Number(op.returned) || 0;
        rows.set(key, cur);
      }
    }
    const total = data.pagination ? data.pagination.total : 0;
    if (!items.length || items.length < limit || page * limit >= total) break;
    if (page === 200) throw new Error('Слишком много страниц — отрезок не сохраняю целиком');
  }
  return { rows: [...rows.values()], days };
}

// Сохранение отрезка: старые строки этих дней заменяем целиком, одной транзакцией.
async function saveRange(from, to, data) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sd_sales WHERE day BETWEEN $1 AND $2', [from, to]);
    for (const r of data.rows) {
      await client.query(
        `INSERT INTO sd_sales (day, client_sd, client_name, agent_sd, agent_name, product_sd, product_name, qty, amount, returned)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (day, client_sd, agent_sd, product_sd) DO UPDATE SET
           client_name = EXCLUDED.client_name, agent_name = EXCLUDED.agent_name,
           product_name = EXCLUDED.product_name, qty = EXCLUDED.qty,
           amount = EXCLUDED.amount, returned = EXCLUDED.returned`,
        [r.day, r.client_sd, r.client_name, r.agent_sd, r.agent_name, r.product_sd, r.product_name, r.qty, r.amount, r.returned]);
    }
    // Отмечаем каждый день отрезка, даже пустой: «продаж не было» — тоже знание.
    for (let d = new Date(from); d <= new Date(to); d = new Date(d.getTime() + 86400000)) {
      const day = d.toISOString().slice(0, 10);
      const n = data.rows.filter((r) => r.day === day).length;
      await client.query(
        `INSERT INTO sd_sales_days (day, orders, rows, synced_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (day) DO UPDATE SET orders = $2, rows = $3, synced_at = now()`,
        [day, data.days.get(day) || 0, n]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
  return data.rows.length;
}

async function syncRange(from, to) {
  await ensureSchema();
  return saveRange(from, to, await fetchRange(from, to));
}

// Ночью: последние 4 дня. Заказы в SD правят задним числом, поэтому свежие дни
// перезабираем целиком, а не только вчерашний.
async function syncRecent(daysBack = 4) {
  const to = today();
  const from = new Date(Date.now() + TZ - daysBack * 86400000).toISOString().slice(0, 10);
  const n = await syncRange(from, to);
  await db.pool.query('DELETE FROM sd_sales WHERE day < (CURRENT_DATE - $1::int)', [KEEP_MONTHS * 31]);
  return { from, to, rows: n };
}

// Первичная заливка истории: по месяцу за заход, чтобы не положить SD.
// Состояние — в settings, поэтому переживает перезапуск.
const BACKFILL_KEY = 'sd_sales_backfill';
async function backfillState() {
  const r = await db.pool.query('SELECT value FROM settings WHERE key = $1', [BACKFILL_KEY]);
  try { return JSON.parse((r.rows[0] && r.rows[0].value) || '{}') || {}; } catch (e) { return {}; }
}
const saveBackfill = (s) => db.setSetting(BACKFILL_KEY, JSON.stringify(s));

// Месяц вида 2026-09 → границы.
const monthBounds = (m) => {
  const from = m + '-01';
  const d = new Date(from);
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { from, to };
};
const prevMonth = (m) => {
  const d = new Date(m + '-01');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};

async function startBackfill(months = KEEP_MONTHS) {
  await ensureSchema();
  const cur = today().slice(0, 7);
  const s = { started_at: new Date().toISOString(), next_month: cur, months, done: 0, finished: false, error: null };
  await saveBackfill(s);
  return s;
}

// Один шаг заливки: забрать очередной месяц. Зовётся по такту, не блокирует ничего.
async function backfillStep() {
  const s = await backfillState();
  if (!s.next_month || s.finished) return s;
  const { from, to } = monthBounds(s.next_month);
  try {
    const n = await syncRange(from, to);
    s.done = (s.done || 0) + 1;
    s.last_month = s.next_month;
    s.last_rows = n;
    s.error = null;
    s.next_month = s.done >= (s.months || KEEP_MONTHS) ? null : prevMonth(s.next_month);
    if (!s.next_month) s.finished = true;
  } catch (e) {
    s.error = e.message;                   // месяц не сохранён — повторим на следующем такте
    s.errors = (s.errors || 0) + 1;
    if (s.errors > 20) { s.finished = true; s.next_month = null; }
  }
  await saveBackfill(s);
  return s;
}

// Сколько строк по месяцам — чтобы видеть дырки в истории (месяц без данных).
async function byMonth() {
  await ensureSchema();
  return (await db.pool.query(
    `SELECT to_char(day, 'YYYY-MM') AS month, COUNT(DISTINCT day)::int AS days,
            COUNT(*)::int AS rows, COALESCE(SUM(amount - returned), 0)::numeric AS amount
       FROM sd_sales GROUP BY 1 ORDER BY 1`)).rows;
}

// Что вообще есть в базе — для плитки и для честного ответа «за этот день выгрузки нет».
async function coverage() {
  await ensureSchema();
  const r = (await db.pool.query(
    `SELECT to_char(MIN(day), 'YYYY-MM-DD') AS first_day, to_char(MAX(day), 'YYYY-MM-DD') AS last_day,
            COUNT(*)::int AS days, COALESCE(SUM(rows), 0)::int AS rows
       FROM sd_sales_days`)).rows[0];
  return { ...r, backfill: await backfillState() };
}

module.exports = { ensureSchema, byMonth, syncRange, syncRecent, startBackfill, backfillStep, backfillState, coverage, KEEP_MONTHS };
