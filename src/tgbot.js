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

// Доступ: администратор или роль «Руководитель продаж».
function requireSalesAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  const roles = req.user.roles || [];
  if (req.user.isAdmin || roles.includes('Руководитель продаж')) return next();
  return res.status(403).send('Доступ к этому разделу только у администратора и руководителя продаж.');
}
router.use(requireSalesAccess);

// Таблицы контактов живут в схеме бота (tgbot). Создаём, если их ещё нет.
async function ensureTables() {
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
}

const DEFAULT_BOT_SETTINGS = { reminder_times: '18:00,21:00,23:00', deadline: '00:00', avg_window_days: 14, enabled: true };
async function getBotSettings() {
  await ensureTables();
  const r = await db.pool.query('SELECT reminder_times, deadline, avg_window_days, enabled FROM tgbot.bot_settings WHERE id=1');
  return r.rows[0] || DEFAULT_BOT_SETTINGS;
}
function normTimes(str) {
  return String(str || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(\d{1,2}):(\d{2})$/); if (!m) return null;
    const h = Math.min(23, Number(m[1])), mi = Math.min(59, Number(m[2]));
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }).filter(Boolean);
}

const cleanPhone = (v) => String(v || '').replace(/[^\d+]/g, '').trim();
const render = (res, req, settings, extra) =>
  res.render('tgbot', Object.assign({ settings, user: req.user, preview: null, result: null, error: null,
    botSettings: DEFAULT_BOT_SETTINGS, settingsSaved: false }, extra));

// Страница плитки.
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  const botSettings = await getBotSettings();
  render(res, req, settings, { botSettings });
});

// Сохранение настроек напоминаний (только РОП/админ).
router.post('/settings', async (req, res) => {
  const settings = await db.getSettings();
  try {
    await ensureTables();
    const times = normTimes(req.body.reminder_times).join(',');
    const deadline = normTimes(req.body.deadline)[0] || '00:00';
    let win = parseInt(req.body.avg_window_days, 10); if (!(win >= 1 && win <= 60)) win = 14;
    const enabled = ['on', 'true', '1'].includes(String(req.body.enabled));
    await db.pool.query(
      `UPDATE tgbot.bot_settings SET reminder_times=$1, deadline=$2, avg_window_days=$3, enabled=$4, updated_at=now(), updated_by=$5 WHERE id=1`,
      [times, deadline, win, enabled, String(req.user.id)]
    );
    await db.log(req.user.id, 'tgbot_settings', `times=${times} deadline=${deadline} window=${win} enabled=${enabled}`);
    const botSettings = await getBotSettings();
    render(res, req, settings, { botSettings, settingsSaved: true });
  } catch (e) {
    const botSettings = await getBotSettings().catch(() => DEFAULT_BOT_SETTINGS);
    render(res, req, settings, { botSettings, error: 'Не удалось сохранить настройки: ' + e.message });
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
    render(res, req, settings, { botSettings, preview: { summary, errors, conflicts, sample: valid.slice(0, 20), payload } });
  } catch (e) {
    render(res, req, settings, { error: 'Не удалось прочитать файл: ' + e.message });
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
    render(res, req, settings, { botSettings, result: { points: pts, managers: mgrs } });
  } catch (e) {
    render(res, req, settings, { error: 'Не удалось сохранить: ' + e.message });
  }
});

module.exports = router;
