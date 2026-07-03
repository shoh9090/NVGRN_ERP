// src/tgbot.js — плитка «Бот HoReCa».
// 4a: экспорт формы (HoReCa-точки + столбцы для номеров).
// 4b: импорт заполненной формы → превью с проверкой → запись в базу бота (схема tgbot).

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const integrations = require('./integrations');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Доступ: администратор — всегда; сотрудник — если его роли назначена плитка /tgbot
// (как в остальных модулях). Раньше проверка шла по точному имени роли «Руководитель
// продаж», поэтому при другом названии роли плитка была видна, но вход давал 403.
async function requireSalesAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.isAdmin) return next();
  try {
    const r = await db.pool.query(
      `SELECT 1 FROM tiles t
       JOIN role_tiles rt ON rt.tile_id = t.id
       JOIN user_roles ur ON ur.role_id = rt.role_id
       WHERE ur.user_id = $1 AND t.url = '/tgbot' LIMIT 1`,
      [req.user.id]
    );
    if (r.rows.length) return next();
  } catch (e) { /* падать на проверке доступа нельзя — ниже отдадим 403 */ }
  return res.status(403).send('Нет доступа к разделу «Бот HoReCa». Обратитесь к администратору.');
}
router.use(requireSalesAccess);

// Таблицы контактов живут в схеме бота (tgbot). Создаём, если их ещё нет.
let _tablesReady = false;
async function ensureTables() {
  if (_tablesReady) return;
  await db.pool.query('CREATE SCHEMA IF NOT EXISTS tgbot');
  await db.pool.query(`CREATE TABLE IF NOT EXISTS tgbot.point_contacts (
    sd_id          TEXT PRIMARY KEY,
    point_name     TEXT,
    firm_name      TEXT,
    inn            TEXT,
    zavsklad_phone TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by     TEXT
  )`);
  await db.pool.query(`CREATE TABLE IF NOT EXISTS tgbot.chain_managers (
    inn           TEXT PRIMARY KEY,
    firm_name     TEXT,
    manager_phone TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by    TEXT
  )`);
  await db.pool.query(`CREATE TABLE IF NOT EXISTS tgbot.bot_settings (
    id              INT PRIMARY KEY DEFAULT 1,
    reminder_times  TEXT NOT NULL DEFAULT '18:00,21:00,23:00',
    deadline        TEXT NOT NULL DEFAULT '00:00',
    avg_window_days INT NOT NULL DEFAULT 14,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT
  )`);
  await db.pool.query(`INSERT INTO tgbot.bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await db.pool.query(`ALTER TABLE tgbot.bot_settings ADD COLUMN IF NOT EXISTS digest_time TEXT NOT NULL DEFAULT '08:30'`);
  await db.pool.query(`ALTER TABLE tgbot.bot_settings ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT true`);
  await db.pool.query(`ALTER TABLE tgbot.bot_settings ADD COLUMN IF NOT EXISTS signals_enabled BOOLEAN NOT NULL DEFAULT true`);
  await db.pool.query(`ALTER TABLE tgbot.bot_settings ADD COLUMN IF NOT EXISTS signal1_days INT NOT NULL DEFAULT 3`);
  await db.pool.query(`ALTER TABLE tgbot.bot_settings ADD COLUMN IF NOT EXISTS signal2_pct INT NOT NULL DEFAULT 40`);
  await db.pool.query(`ALTER TABLE tgbot.bot_settings ADD COLUMN IF NOT EXISTS signal2_window INT NOT NULL DEFAULT 7`);
  await db.pool.query(`ALTER TABLE tgbot.bot_settings ADD COLUMN IF NOT EXISTS order_alerts_enabled BOOLEAN NOT NULL DEFAULT true`);
  await db.pool.query(`ALTER TABLE tgbot.bot_settings ADD COLUMN IF NOT EXISTS quiet_from TEXT NOT NULL DEFAULT '22:00'`);
  await db.pool.query(`ALTER TABLE tgbot.bot_settings ADD COLUMN IF NOT EXISTS quiet_to TEXT NOT NULL DEFAULT '08:00'`);
  await db.pool.query(`ALTER TABLE tgbot.bot_settings ADD COLUMN IF NOT EXISTS lost_summary_freq TEXT NOT NULL DEFAULT 'weekly'`);
  await db.pool.query(`CREATE TABLE IF NOT EXISTS tgbot.crm_agents (
    sd_agent_id TEXT PRIMARY KEY, sd_agent_code TEXT, sd_agent_name TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true, last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.pool.query(`CREATE TABLE IF NOT EXISTS tgbot.telegram_staff (
    id SERIAL PRIMARY KEY, telegram_user_id BIGINT UNIQUE, telegram_chat_id BIGINT,
    telegram_username TEXT, telegram_first_name TEXT, telegram_last_name TEXT,
    phone_original TEXT, phone_normalized TEXT, crm_agent_id TEXT, role TEXT,
    status TEXT NOT NULL DEFAULT 'new_request', confirmed_by TEXT, confirmed_at TIMESTAMPTZ,
    disabled_at TIMESTAMPTZ, comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_phone ON tgbot.telegram_staff(phone_normalized)`);
  await db.pool.query(`ALTER TABLE tgbot.point_contacts ADD COLUMN IF NOT EXISTS agent_sd_id TEXT`);
  await db.pool.query(`ALTER TABLE tgbot.point_contacts ADD COLUMN IF NOT EXISTS active TEXT`);
  await db.pool.query(`ALTER TABLE tgbot.point_contacts ADD COLUMN IF NOT EXISTS last_order_date DATE`);
  await db.pool.query(`CREATE TABLE IF NOT EXISTS tgbot.salesdoctor_sync_log (
    id SERIAL PRIMARY KEY, sync_type TEXT, created INT DEFAULT 0, updated INT DEFAULT 0,
    conflicts INT DEFAULT 0, error TEXT, ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.pool.query(`CREATE TABLE IF NOT EXISTS tgbot.product_replacements (
    id SERIAL PRIMARY KEY, product_sd_id TEXT, product_name TEXT,
    replacement_sd_id TEXT, replacement_name TEXT, active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (product_sd_id, replacement_sd_id)
  )`);

  // Реестр упущенных продаж (бот пишет, Hub читает для дашборда).
  await db.pool.query(`CREATE TABLE IF NOT EXISTS tgbot.lost_sales (
    id BIGSERIAL PRIMARY KEY, detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    order_sd_id TEXT, order_code TEXT, client_sd_id TEXT, client_name TEXT, agent_sd_id TEXT,
    product_sd_id TEXT, product_name TEXT, qty_before NUMERIC, qty_after NUMERIC, qty_lost NUMERIC,
    price NUMERIC, amount_lost NUMERIC, reason TEXT NOT NULL DEFAULT 'stock'
  )`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_lost_sales_detected ON tgbot.lost_sales (detected_at)`);

  // Претензии: схема и справочник вынесены в общий модуль (единый источник).
  await require('./complaints-schema').ensureComplaintSchema(db.pool);

  _tablesReady = true;
}

function normPhone9(v) { const d = String(v || '').replace(/\D/g, ''); return d.length > 9 ? d.slice(-9) : d; }
const ROLES = ['agent', 'head_of_sales', 'logistics', 'expeditor', 'marketing', 'admin'];

const DEFAULT_BOT_SETTINGS = { reminder_times: '18:00,21:00,23:00', deadline: '00:00', avg_window_days: 14, enabled: true, digest_time: '08:30', digest_enabled: true, signals_enabled: true, signal1_days: 3, signal2_pct: 40, signal2_window: 7, order_alerts_enabled: true, quiet_from: '22:00', quiet_to: '08:00', lost_summary_freq: 'weekly' };
async function getBotSettings() {
  await ensureTables();
  const r = await db.pool.query('SELECT * FROM tgbot.bot_settings WHERE id=1');
  return Object.assign({}, DEFAULT_BOT_SETTINGS, r.rows[0] || {});
}
function normTimes(str) {
  return String(str || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(\d{1,2}):(\d{2})$/); if (!m) return null;
    const h = Math.min(23, Number(m[1])), mi = Math.min(59, Number(m[2]));
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }).filter(Boolean);
}

const cleanPhone = (v) => String(v || '').replace(/[^\d+]/g, '').trim();
async function loadStaffData() {
  await ensureTables();
  const agents = (await db.pool.query("SELECT sd_agent_id, sd_agent_name, sd_agent_code FROM tgbot.crm_agents WHERE is_active ORDER BY sd_agent_name")).rows;
  const staff = (await db.pool.query(
    `SELECT s.*, a.sd_agent_name FROM tgbot.telegram_staff s
     LEFT JOIN tgbot.crm_agents a ON a.sd_agent_id = s.crm_agent_id
     ORDER BY CASE s.status WHEN 'new_request' THEN 0 ELSE 1 END, s.created_at DESC`)).rows;
  const sync = (await db.pool.query("SELECT ran_at FROM tgbot.salesdoctor_sync_log WHERE sync_type <> 'agents' ORDER BY ran_at DESC LIMIT 1")).rows[0];
  const replacements = (await db.pool.query('SELECT * FROM tgbot.product_replacements ORDER BY product_name')).rows;
  return { agents, staff, syncedAt: sync ? sync.ran_at : null, replacements };
}
async function render(res, req, settings, extra) {
  let sd = { agents: [], staff: [], syncedAt: null, replacements: [] };
  try { sd = await loadStaffData(); } catch (e) { /* модалка будет пустой, не падаем */ }
  let products = [];
  if (extra && extra.openRepl) { try { products = await integrations.getSdProducts(); } catch (e) { /* список пуст */ } }
  res.render('tgbot', Object.assign({ settings, user: req.user, preview: null, result: null, error: null,
    botSettings: DEFAULT_BOT_SETTINGS, settingsSaved: false,
    agents: sd.agents, staff: sd.staff, syncedAt: sd.syncedAt || null, replacements: sd.replacements || [], products, staffMsg: null, staffErr: null, openStaff: false, openSettings: false, openImport: false, openAgent: false, openRepl: false }, extra));
}

// Страница плитки.
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  const botSettings = await getBotSettings();
  await render(res, req, settings, { botSettings, staffMsg: req.query.msg || null, staffErr: req.query.err || null, openStaff: req.query.staff === '1', openSettings: req.query.settings === '1', openImport: req.query.import === '1', openAgent: req.query.agent === '1', openRepl: req.query.repl === '1' });
});

// ---- Бандл 1: раздел «Telegram-агенты» ----
async function renderStaff(res, req, extra = {}) {
  await ensureTables();
  const settings = await db.getSettings();
  const agents = (await db.pool.query("SELECT sd_agent_id, sd_agent_name, sd_agent_code FROM tgbot.crm_agents WHERE is_active ORDER BY sd_agent_name")).rows;
  const staff = (await db.pool.query(
    `SELECT s.*, a.sd_agent_name FROM tgbot.telegram_staff s
     LEFT JOIN tgbot.crm_agents a ON a.sd_agent_id = s.crm_agent_id
     ORDER BY CASE s.status WHEN 'new_request' THEN 0 ELSE 1 END, s.created_at DESC`)).rows;
  res.render('staff', Object.assign({ settings, user: req.user, agents, staff, msg: null, err: null }, extra));
}
router.get('/staff', async (req, res) => {
  try { await renderStaff(res, req, { msg: req.query.msg || null, err: req.query.err || null }); }
  catch (e) { res.status(500).send('Ошибка раздела: ' + e.message); }
});
router.post('/staff/load-agents', async (req, res) => {
  try { const n = await integrations.syncCrmAgents(); res.redirect('/tgbot?staff=1&msg=' + encodeURIComponent('Загружено агентов из CRM: ' + n)); }
  catch (e) { res.redirect('/tgbot?staff=1&err=' + encodeURIComponent(e.message)); }
});
router.post('/staff/sync-clients', async (req, res) => {
  try { const n = await integrations.syncClientsToContacts(); res.redirect('/tgbot?staff=1&msg=' + encodeURIComponent('Синхронизировано клиентов: ' + n)); }
  catch (e) { res.redirect('/tgbot?staff=1&err=' + encodeURIComponent(e.message)); }
});
router.post('/staff/assign', async (req, res) => {
  try {
    const id = req.body.id;
    let role = ROLES.includes(req.body.role) ? req.body.role : null;
    const agentId = req.body.crm_agent_id || null;
    if (agentId && !role) role = 'agent';
    const confirmed = !!(role && (role !== 'agent' || agentId));
    await db.pool.query(
      `UPDATE tgbot.telegram_staff SET crm_agent_id=$1, role=$2, status=$3,
        confirmed_by=CASE WHEN $3='confirmed' THEN $4 ELSE confirmed_by END,
        confirmed_at=CASE WHEN $3='confirmed' THEN now() ELSE confirmed_at END,
        updated_at=now() WHERE id=$5`,
      [agentId, role, confirmed ? 'confirmed' : 'new_request', String(req.user.id), id]);
    res.redirect('/tgbot?staff=1');
  } catch (e) { res.redirect('/tgbot?staff=1&err=' + encodeURIComponent(e.message)); }
});
router.post('/staff/delete', async (req, res) => {
  try { await db.pool.query('DELETE FROM tgbot.telegram_staff WHERE id=$1', [req.body.id]); res.redirect('/tgbot?staff=1&msg=' + encodeURIComponent('Сотрудник удалён.')); }
  catch (e) { res.redirect('/tgbot?staff=1&err=' + encodeURIComponent(e.message)); }
});
router.post('/staff/confirm', async (req, res) => {
  try {
    const role = ROLES.includes(req.body.role) ? req.body.role : 'agent';
    const agentId = req.body.crm_agent_id || null;
    if (role === 'agent' && !agentId) return res.redirect('/tgbot?staff=1&err=' + encodeURIComponent('Для роли «агент» выберите агента из CRM.'));
    await db.pool.query(
      `UPDATE tgbot.telegram_staff SET crm_agent_id=$1, role=$2, status='confirmed', confirmed_by=$3, confirmed_at=now(), disabled_at=NULL, updated_at=now() WHERE id=$4`,
      [agentId, role, String(req.user.id), req.body.id]);
    res.redirect('/tgbot?staff=1&msg=' + encodeURIComponent('Сотрудник подтверждён.'));
  } catch (e) { res.redirect('/tgbot?staff=1&err=' + encodeURIComponent(e.message)); }
});
router.post('/staff/reject', async (req, res) => {
  await db.pool.query(`UPDATE tgbot.telegram_staff SET status='rejected', updated_at=now() WHERE id=$1`, [req.body.id]);
  res.redirect('/tgbot?staff=1&msg=' + encodeURIComponent('Заявка отклонена.'));
});
router.post('/staff/disable', async (req, res) => {
  await db.pool.query(`UPDATE tgbot.telegram_staff SET status='disabled', disabled_at=now(), updated_at=now() WHERE id=$1`, [req.body.id]);
  res.redirect('/tgbot?staff=1&msg=' + encodeURIComponent('Сотрудник отключён.'));
});
router.post('/staff/role', async (req, res) => {
  const role = ROLES.includes(req.body.role) ? req.body.role : 'agent';
  await db.pool.query(`UPDATE tgbot.telegram_staff SET role=$1, updated_at=now() WHERE id=$2`, [role, req.body.id]);
  res.redirect('/tgbot?staff=1&msg=' + encodeURIComponent('Роль изменена.'));
});
router.post('/staff/add-manual', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const role = ROLES.includes(req.body.role) ? req.body.role : 'head_of_sales';
    if (!name || !phone) return res.redirect('/tgbot?staff=1&err=' + encodeURIComponent('Укажите ФИО и телефон.'));
    await db.pool.query(
      `INSERT INTO tgbot.telegram_staff (telegram_first_name, phone_original, phone_normalized, crm_agent_id, role, status, confirmed_by, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,'confirmed',$6,now())`,
      [name, phone, normPhone9(phone), req.body.crm_agent_id || null, role, String(req.user.id)]);
    res.redirect('/tgbot?staff=1&msg=' + encodeURIComponent('Сотрудник добавлен. Пусть напишет боту и поделится номером.'));
  } catch (e) { res.redirect('/tgbot?staff=1&err=' + encodeURIComponent(e.message)); }
});

router.post('/replacements/add', async (req, res) => {
  try {
    await ensureTables();
    const ps = req.body.product_sd_id, rs = req.body.replacement_sd_id;
    if (!ps || !rs) return res.redirect('/tgbot?repl=1&err=' + encodeURIComponent('Выберите оба товара.'));
    if (ps === rs) return res.redirect('/tgbot?repl=1&err=' + encodeURIComponent('Товар и замена не могут совпадать.'));
    let pn = '', rn = '';
    try { const prods = await integrations.getSdProducts(); const m = {}; prods.forEach((p) => { m[p.SD_id] = p.name; }); pn = m[ps] || ps; rn = m[rs] || rs; } catch (e) { pn = ps; rn = rs; }
    await db.pool.query(
      `INSERT INTO tgbot.product_replacements (product_sd_id, product_name, replacement_sd_id, replacement_name, active)
       VALUES ($1,$2,$3,$4,true) ON CONFLICT (product_sd_id, replacement_sd_id) DO UPDATE SET active=true, product_name=$2, replacement_name=$4`,
      [ps, pn, rs, rn]);
    res.redirect('/tgbot?repl=1&msg=' + encodeURIComponent('Замена добавлена.'));
  } catch (e) { res.redirect('/tgbot?repl=1&err=' + encodeURIComponent(e.message)); }
});
router.post('/replacements/delete', async (req, res) => {
  try { await db.pool.query('DELETE FROM tgbot.product_replacements WHERE id=$1', [req.body.id]); res.redirect('/tgbot?repl=1&msg=' + encodeURIComponent('Замена удалена.')); }
  catch (e) { res.redirect('/tgbot?repl=1&err=' + encodeURIComponent(e.message)); }
});

// Дашборд АКБ/ОКБ по агентам (для РОПа). Позже переедет в плитку «Продажи».
router.get('/analytics', async (req, res) => {
  const settings = await db.getSettings();
  let data = null, error = null;
  try { data = await integrations.getAgentCoverage(14); }
  catch (e) { error = e.message; }
  res.render('analytics', { settings, user: req.user, data, error });
});

// Дашборд «Упущенные продажи» — страница + JSON API (читает реестр из схемы бота).
router.get('/lost-sales', async (req, res) => {
  const settings = await db.getSettings();
  res.render('lost-sales', { settings, user: req.user });
});
router.get('/lost-sales/api', async (req, res) => {
  try {
    await ensureTables();
    const days = req.query.period === 'month' ? 30 : 7;
    const p = [days];
    const agentExpr = "COALESCE(NULLIF(TRIM(CONCAT_WS(' ', s.telegram_first_name, s.telegram_last_name)),''), l.agent_sd_id, '—')";
    const kpi = (await db.pool.query(
      `SELECT coalesce(sum(amount_lost),0)::numeric amount, coalesce(sum(qty_lost),0)::numeric qty,
              count(distinct order_sd_id)::int orders, count(*)::int items
       FROM tgbot.lost_sales WHERE detected_at >= now() - make_interval(days => $1)`, p)).rows[0];
    const byProduct = (await db.pool.query(
      `SELECT product_name name, sum(amount_lost)::numeric amt, sum(qty_lost)::numeric qty
       FROM tgbot.lost_sales WHERE detected_at >= now() - make_interval(days => $1)
       GROUP BY 1 ORDER BY amt DESC NULLS LAST LIMIT 12`, p)).rows;
    const byAgent = (await db.pool.query(
      `SELECT ${agentExpr} name, sum(l.amount_lost)::numeric amt, sum(l.qty_lost)::numeric qty
       FROM tgbot.lost_sales l LEFT JOIN tgbot.telegram_staff s ON s.crm_agent_id = l.agent_sd_id
       WHERE l.detected_at >= now() - make_interval(days => $1)
       GROUP BY 1 ORDER BY amt DESC NULLS LAST LIMIT 12`, p)).rows;
    const rows = (await db.pool.query(
      `SELECT to_char(l.detected_at,'DD.MM HH24:MI') ts, l.order_code, l.client_name, l.product_name,
              l.qty_before, l.qty_after, l.qty_lost, l.amount_lost, ${agentExpr} agent_name
       FROM tgbot.lost_sales l LEFT JOIN tgbot.telegram_staff s ON s.crm_agent_id = l.agent_sd_id
       WHERE l.detected_at >= now() - make_interval(days => $1)
       ORDER BY l.detected_at DESC LIMIT 500`, p)).rows;
    res.json({ kpi, byProduct, byAgent, rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Сохранение настроек напоминаний (только РОП/админ).
router.post('/settings', async (req, res) => {
  const settings = await db.getSettings();
  try {
    await ensureTables();
    const slots = [];
    for (let i = 1; i <= 5; i++) {
      const on = ['on', 'true', '1'].includes(String(req.body['reminder_on_' + i]));
      const v = normTimes(req.body['reminder_' + i])[0];
      if (on && v) slots.push(v); // напоминание учитываем только при включённой галочке
    }
    const times = slots.join(',');
    const deadline = normTimes(req.body.deadline)[0] || '00:00';
    let win = parseInt(req.body.avg_window_days, 10); if (!(win >= 1 && win <= 60)) win = 14;
    const enabled = ['on', 'true', '1'].includes(String(req.body.enabled));
    await db.pool.query(
      `UPDATE tgbot.bot_settings SET reminder_times=$1, deadline=$2, avg_window_days=$3, enabled=$4, updated_at=now(), updated_by=$5 WHERE id=1`,
      [times, deadline, win, enabled, String(req.user.id)]
    );
    await db.log(req.user.id, 'tgbot_settings', `times=${times} deadline=${deadline} window=${win} enabled=${enabled}`);
    const botSettings = await getBotSettings();
    await render(res, req, settings, { botSettings, settingsSaved: true, openSettings: true });
  } catch (e) {
    const botSettings = await getBotSettings().catch(() => DEFAULT_BOT_SETTINGS);
    await render(res, req, settings, { botSettings, error: 'Не удалось сохранить настройки: ' + e.message, openSettings: true });
  }
});

router.post('/settings/agent', async (req, res) => {
  const settings = await db.getSettings();
  try {
    await ensureTables();
    const dt = normTimes(req.body.digest_time)[0] || '08:30';
    const de = ['on', 'true', '1'].includes(String(req.body.digest_enabled));
    const se = ['on', 'true', '1'].includes(String(req.body.signals_enabled));
    let s1 = parseInt(req.body.signal1_days, 10); if (!(s1 >= 1 && s1 <= 30)) s1 = 3;
    let s2 = parseInt(req.body.signal2_pct, 10); if (!(s2 >= 5 && s2 <= 95)) s2 = 40;
    let s2w = parseInt(req.body.signal2_window, 10); if (!(s2w >= 3 && s2w <= 30)) s2w = 7;
    const oae = ['on', 'true', '1'].includes(String(req.body.order_alerts_enabled));
    const qf = normTimes(req.body.quiet_from)[0] || '22:00';
    const qt = normTimes(req.body.quiet_to)[0] || '08:00';
    const lf = ['off', 'daily', 'weekly'].includes(String(req.body.lost_summary_freq)) ? req.body.lost_summary_freq : 'weekly';
    await db.pool.query(
      `UPDATE tgbot.bot_settings SET digest_time=$1, digest_enabled=$2, signals_enabled=$3, signal1_days=$4, signal2_pct=$5, signal2_window=$6,
         order_alerts_enabled=$7, quiet_from=$8, quiet_to=$9, lost_summary_freq=$10, updated_at=now(), updated_by=$11 WHERE id=1`,
      [dt, de, se, s1, s2, s2w, oae, qf, qt, lf, String(req.user.id)]);
    await db.log(req.user.id, 'tgbot_agent_settings', `digest=${dt} de=${de} se=${se} alerts=${oae} quiet=${qf}-${qt} lost=${lf}`);
    const botSettings = await getBotSettings();
    await render(res, req, settings, { botSettings, settingsSaved: true, openAgent: true });
  } catch (e) {
    const botSettings = await getBotSettings().catch(() => DEFAULT_BOT_SETTINGS);
    await render(res, req, settings, { botSettings, error: 'Не удалось сохранить: ' + e.message, openAgent: true });
  }
});

// Экспорт готовой формы: активные HoReCa-точки + два столбца для номеров.
router.get('/export', async (req, res) => {
  try {
    const points = await integrations.getHorecaPoints();
    const rows = points.map((p) => ({
      SD_id: p.SD_id,
      'Название точки': p.name || '',
      'Контрагент (юр. название)': p.firmName || '',
      'ИНН': p.inn || '',
      'Телефон завсклада (для бота)': p.tel || '',
      'Телефон менеджера сети': '',
    }));
    const header = ['SD_id', 'Название точки', 'Контрагент (юр. название)', 'ИНН', 'Телефон завсклада (для бота)', 'Телефон менеджера сети'];
    const ws = XLSX.utils.json_to_sheet(rows, { header });
    ws['!cols'] = [{ wch: 10 }, { wch: 28 }, { wch: 26 }, { wch: 14 }, { wch: 24 }, { wch: 24 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'HoReCa');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const today = new Date().toISOString().slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="horeca_form_${today}.xlsx"`);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
    await db.log(req.user.id, 'tgbot_export_form', String(points.length));
  } catch (e) {
    res.status(500).send('Не удалось выгрузить форму: ' + e.message);
  }
});

// Импорт: читаем файл, проверяем, показываем превью (НИЧЕГО не сохраняем).
router.post('/import', upload.single('file'), async (req, res) => {
  const settings = await db.getSettings();
  try {
    if (!req.file) throw new Error('Файл не выбран.');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const parsed = rows.map((r) => ({
      sd_id: String(r['SD_id'] || '').trim(),
      point_name: String(r['Название точки'] || '').trim(),
      firm_name: String(r['Контрагент (юр. название)'] || '').trim(),
      inn: String(r['ИНН'] || '').trim(),
      zavsklad_phone: cleanPhone(r['Телефон завсклада (для бота)']),
      manager_phone: cleanPhone(r['Телефон менеджера сети']),
    }));

    const errors = [];
    const valid = [];
    parsed.forEach((p, i) => {
      const line = i + 2; // +2: строка 1 — заголовки
      if (!p.sd_id) { errors.push(`Строка ${line}: пустой SD_id — пропущена.`); return; }
      if (!p.inn) { errors.push(`Строка ${line} (${p.point_name || '—'}): пустой ИНН — заполни в SalesDoctor. Пропущена.`); return; }
      valid.push(p);
    });

    // Менеджеры сети: группируем по ИНН, ловим конфликты разных номеров.
    const byInn = {};
    for (const p of valid) {
      if (!p.manager_phone) continue;
      byInn[p.inn] = byInn[p.inn] || { firm: p.firm_name, phones: new Set() };
      byInn[p.inn].phones.add(p.manager_phone);
    }
    const conflicts = [];
    const managers = [];
    for (const [inn, m] of Object.entries(byInn)) {
      if (m.phones.size > 1) conflicts.push(`${m.firm || 'ИНН ' + inn}: разные номера менеджера — ${[...m.phones].join(', ')}. Возьму первый, поправь форму при необходимости.`);
      managers.push({ inn, firm_name: m.firm, manager_phone: [...m.phones][0] });
    }

    const summary = {
      totalRows: parsed.length,
      validPoints: valid.length,
      withZavsklad: valid.filter((p) => p.zavsklad_phone).length,
      managers: managers.length,
    };
    const payload = Buffer.from(JSON.stringify({ valid, managers })).toString('base64');
    const botSettings = await getBotSettings();
    await render(res, req, settings, { botSettings, preview: { summary, errors, conflicts, sample: valid.slice(0, 20), payload }, openImport: true });
  } catch (e) {
    await render(res, req, settings, { error: 'Не удалось прочитать файл: ' + e.message, openImport: true });
  }
});

// Подтверждение: записываем проверенные данные в базу.
router.post('/import/commit', async (req, res) => {
  const settings = await db.getSettings();
  try {
    await ensureTables();
    const data = JSON.parse(Buffer.from(String(req.body.payload || ''), 'base64').toString('utf8'));
    let pts = 0, mgrs = 0;
    for (const p of data.valid || []) {
      await db.pool.query(
        `INSERT INTO tgbot.point_contacts (sd_id, point_name, firm_name, inn, zavsklad_phone, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,now(),$6)
         ON CONFLICT (sd_id) DO UPDATE SET point_name=$2, firm_name=$3, inn=$4,
           zavsklad_phone=$5,
           updated_at=now(), updated_by=$6`,
        [p.sd_id, p.point_name, p.firm_name, p.inn, p.zavsklad_phone, String(req.user.id)]
      );
      pts++;
    }
    for (const m of data.managers || []) {
      await db.pool.query(
        `INSERT INTO tgbot.chain_managers (inn, firm_name, manager_phone, updated_at, updated_by)
         VALUES ($1,$2,$3,now(),$4)
         ON CONFLICT (inn) DO UPDATE SET firm_name=$2, manager_phone=$3, updated_at=now(), updated_by=$4`,
        [m.inn, m.firm_name, m.manager_phone, String(req.user.id)]
      );
      mgrs++;
    }
    await db.log(req.user.id, 'tgbot_import', `точек ${pts}, менеджеров ${mgrs}`);
    const botSettings = await getBotSettings();
    await render(res, req, settings, { botSettings, result: { points: pts, managers: mgrs }, openImport: true });
  } catch (e) {
    await render(res, req, settings, { error: 'Не удалось сохранить: ' + e.message, openImport: true });
  }
});

module.exports = router;
