// complaints.js — блок «Претензии»: разбор жалоб клиентов, простановка решений, выгрузка, импорт истории.
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const { ensureComplaintSchema } = require('./complaints-schema');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

// Гарантируем схему перед любым запросом (идемпотентно, дёшево).
router.use(async (req, res, next) => {
  try { await ensureComplaintSchema(db.pool); next(); }
  catch (e) { next(e); }
});

const STATUS = {
  new:           'Новая',
  agent_reacted: 'Агент отреагировал',
  in_review:     'На проверке',
  resolved:      'Закрыта',
};

// ----- Страница -----
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('complaints', { settings, user: req.user });
});

// ----- Справочник для выпадашек/фильтров -----
router.get('/api/dicts', async (req, res) => {
  const r = await db.pool.query(
    `SELECT kind, code, label_ru, link_code, sort_order FROM tgbot.complaint_dicts
     WHERE active ORDER BY kind, sort_order`
  );
  const out = { type: [], severity: [], resolution: [], category: [], link: [] };
  for (const row of r.rows) (out[row.kind] = out[row.kind] || []).push(row);
  out.status = Object.entries(STATUS).map(([code, label_ru]) => ({ code, label_ru }));
  res.json(out);
});

// ----- Список с фильтрами -----
router.get('/api/list', async (req, res) => {
  const { from, to, status, type, link, severity, q } = req.query;

  // Собираем условия. base[] — фильтры без статуса (для сводки), full[] — со статусом (для списка).
  function build(includeStatus) {
    const p = [], w = [];
    const add = (sql, val) => { p.push(val); w.push(sql.replace('$?', '$' + p.length)); };
    if (from) add('c.created_at >= $?', from);
    if (to)   add('c.created_at < ($?::date + 1)', to);
    if (includeStatus && status) add('c.status = $?', status);
    if (type) add('c.complaint_type = $?', type);
    if (link) add('c.link_code = $?', link);
    if (severity) add('c.severity = $?', severity);
    if (q) { p.push('%' + String(q).trim() + '%'); const i = p.length;
      w.push(`(c.product_name ILIKE $${i} OR c.point_name ILIKE $${i} OR c.firm_name ILIKE $${i} OR c.agent_name ILIKE $${i})`); }
    return { params: p, whereSQL: w.length ? 'WHERE ' + w.join(' AND ') : '' };
  }

  const full = build(true);
  const rows = (await db.pool.query(
    `SELECT c.id, c.created_at, c.ship_date, c.point_name, c.firm_name, c.agent_name,
            c.product_name, c.product_category, c.complaint_type, c.link_code,
            c.severity, c.resolution, c.status, c.source,
            (SELECT count(*) FROM tgbot.complaint_files f WHERE f.complaint_id = c.id)::int AS media_count
     FROM tgbot.complaints c ${full.whereSQL}
     ORDER BY c.created_at DESC, c.id DESC LIMIT 1000`, full.params
  )).rows;

  // Сводка по статусам — по тем же фильтрам, но без самого статуса.
  const base = build(false);
  const counts = (await db.pool.query(
    `SELECT status, count(*)::int AS n FROM tgbot.complaints c ${base.whereSQL} GROUP BY status`,
    base.params
  )).rows;

  res.json({ items: rows, total: rows.length, counts });
});

// ----- Одна претензия (карточка) -----
router.get('/api/one/:id(\\d+)', async (req, res) => {
  const c = (await db.pool.query('SELECT * FROM tgbot.complaints WHERE id = $1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'Претензия не найдена' });
  const files = (await db.pool.query(
    'SELECT id, kind, file_ref, tg_file_id FROM tgbot.complaint_files WHERE complaint_id = $1 ORDER BY id',
    [req.params.id]
  )).rows.map((f) => ({ ...f, url: f.file_ref ? '/file/' + f.file_ref : null }));
  res.json({ complaint: c, files });
});

// ----- Обработка в вебе: степень / решение / примечание / статус -----
router.post('/api/one/:id(\\d+)', express.json(), async (req, res) => {
  const { severity, resolution, internal_note, status } = req.body || {};
  const valid = await validCodes();
  if (severity && !valid.severity.has(severity)) return res.status(400).json({ error: 'Неизвестная степень' });
  if (resolution && !valid.resolution.has(resolution)) return res.status(400).json({ error: 'Неизвестное решение' });
  if (status && !STATUS[status]) return res.status(400).json({ error: 'Неизвестный статус' });

  const setResolved = status === 'resolved';
  await db.pool.query(
    `UPDATE tgbot.complaints SET
       severity = $1, resolution = $2, internal_note = $3,
       status = COALESCE($4, status),
       resolved_at = CASE WHEN $5 THEN now() ELSE resolved_at END,
       resolved_by = CASE WHEN $5 THEN $6 ELSE resolved_by END,
       updated_at = now()
     WHERE id = $7`,
    [severity || null, resolution || null, (internal_note || '').slice(0, 2000),
     status || null, setResolved, req.user.name || req.user.login || 'web', req.params.id]
  );
  await db.log(req.user.id, 'complaint_update', `#${req.params.id} → ${status || ''}`);
  res.json({ ok: true });
});

async function validCodes() {
  const r = await db.pool.query("SELECT kind, code FROM tgbot.complaint_dicts WHERE active");
  const m = { severity: new Set(), resolution: new Set(), type: new Set(), category: new Set() };
  for (const row of r.rows) (m[row.kind] = m[row.kind] || new Set()).add(row.code);
  return m;
}

// ----- Выгрузка в Excel (в формате вкладки 02_претензии) -----
router.get('/api/export.xlsx', async (req, res) => {
  const labels = await labelMaps();
  const rows = (await db.pool.query(
    `SELECT c.*,
            (SELECT count(*) FROM tgbot.complaint_files f WHERE f.complaint_id=c.id AND f.kind='photo')::int AS photos,
            (SELECT count(*) FROM tgbot.complaint_files f WHERE f.complaint_id=c.id AND f.kind IN ('video','video_note'))::int AS videos
     FROM tgbot.complaints c ORDER BY c.created_at`
  )).rows;
  const data = rows.map((c) => ({
    'Дата обращения': fmtDate(c.created_at),
    'Дата отгрузки': fmtDate(c.ship_date),
    'Менеджер/Агент': c.agent_name || '',
    'Ресторан': c.point_name || c.firm_name || '',
    'Объем закупки': c.volume_text || '',
    'категория продукта': c.product_category || '',
    'Продукт': c.product_name || '',
    'Тип жалобы': labels.type[c.complaint_type] || c.complaint_type || '',
    'Звено': labels.link[c.link_code] || '',
    'Степень проблемы': labels.severity[c.severity] || '',
    'Температура хранения (°C)': c.storage_temp ?? '',
    'Часов пакет открыт': c.open_hours ?? '',
    'Где хранили': c.storage_place || '',
    'Фото получено': c.photos > 0 ? 'да' : 'нет',
    'Видео получено': c.videos > 0 ? 'да' : 'нет',
    'Решение': labels.resolution[c.resolution] || '',
    'Статус': STATUS[c.status] || c.status,
    'Дата закрытия': fmtDate(c.resolved_at),
    'Комментарий клиента': c.client_comment || '',
    'примечания': c.internal_note || '',
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'претензии');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="pretenzii.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ----- Импорт истории из Excel (только админ). Перезаписывает строки source='import'. -----
router.post('/api/import', upload.single('file'), async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Импорт доступен только администратору' });
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames.find((n) => n.toLowerCase().includes('претензи')) || wb.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
  } catch (e) {
    return res.status(400).json({ error: 'Не удалось прочитать файл: ' + e.message });
  }

  const dict = await labelToCodeMaps();
  const norm = (s) => String(s == null ? '' : s).trim();
  const findCol = (obj, ...names) => {
    const keys = Object.keys(obj);
    for (const n of names) { const k = keys.find((x) => x.toLowerCase().includes(n)); if (k) return obj[k]; }
    return null;
  };

  const client = await db.pool.connect();
  let inserted = 0;
  const unmatchedTypes = new Set();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM tgbot.complaints WHERE source = 'import'");
    for (const r of rows) {
      const typeLabel = norm(findCol(r, 'тип жалоб'));
      if (!typeLabel && !norm(findCol(r, 'продукт'))) continue; // пустая строка
      const typeCode = dict.type.get(typeLabel.toLowerCase()) || null;
      if (typeLabel && !typeCode) unmatchedTypes.add(typeLabel);
      const linkCode = typeCode ? (dict.typeLink.get(typeCode) || null) : null;

      const sevLabel = norm(findCol(r, 'степень'));
      const sevCode = dict.severity.get(sevLabel.toLowerCase()) || null;
      const resLabelRaw = norm(findCol(r, 'решение'));
      const resCode = dict.resolution.get(resLabelRaw.toLowerCase()) || null;

      const created = toDate(findCol(r, 'дата обращ')) || null;
      const volRaw = norm(findCol(r, 'объем', 'объём'));
      let ship = toDate(findCol(r, 'дата отгруз'));
      if (!ship) { const m = volRaw.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/); if (m) ship = `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }

      const photo = norm(findCol(r, 'фото')).toLowerCase().startsWith('д');
      const video = norm(findCol(r, 'видео')).toLowerCase().startsWith('д');
      const noteParts = [];
      if (resLabelRaw && !resCode) noteParts.push('Решение (из файла): ' + resLabelRaw);
      noteParts.push(`Фото: ${photo ? 'да' : 'нет'}; Видео: ${video ? 'да' : 'нет'}`);
      const extraNote = norm(findCol(r, 'примечан'));
      if (extraNote) noteParts.push(extraNote);

      const cat = norm(findCol(r, 'категория'));
      const status = (resCode || resLabelRaw) ? 'resolved' : 'in_review';

      await client.query(
        `INSERT INTO tgbot.complaints
           (created_at, source, point_name, agent_name, volume_text, ship_date,
            product_name, product_category, complaint_type, link_code,
            severity, resolution, internal_note, status, resolved_at,
            storage_place, storage_temp, open_hours)
         VALUES ($1,'import',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [created || new Date(), norm(findCol(r, 'ресторан')) || null, norm(findCol(r, 'менеджер')) || null,
         volRaw || null, ship || null,
         norm(findCol(r, 'продукт')) || null, dict.category.get(cat.toLowerCase()) || (cat || null),
         typeCode, linkCode, sevCode, resCode, noteParts.join('\n'),
         status, status === 'resolved' ? (created || new Date()) : null,
         norm(findCol(r, 'где хран')) || null, numOrNull(findCol(r, 'температур')), numOrNull(findCol(r, 'часов'))]
      );
      inserted++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: 'Ошибка импорта: ' + e.message });
  } finally {
    client.release();
  }
  await db.log(req.user.id, 'complaints_import', `строк: ${inserted}`);
  res.json({ ok: true, inserted, unmatchedTypes: [...unmatchedTypes] });
});

// ---------- helpers ----------
function fmtDate(d) { if (!d) return ''; const x = new Date(d); return isNaN(x) ? '' : x.toISOString().slice(0, 10); }
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
function numOrNull(v) { if (v == null || String(v).trim() === '') return null; const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; }

async function labelMaps() {
  const r = await db.pool.query("SELECT kind, code, label_ru FROM tgbot.complaint_dicts WHERE active");
  const m = { type: {}, severity: {}, resolution: {}, category: {}, link: {} };
  for (const row of r.rows) (m[row.kind] = m[row.kind] || {})[row.code] = row.label_ru;
  return m;
}
async function labelToCodeMaps() {
  const r = await db.pool.query("SELECT kind, code, label_ru, link_code FROM tgbot.complaint_dicts WHERE active");
  const m = { type: new Map(), severity: new Map(), resolution: new Map(), category: new Map(), typeLink: new Map() };
  for (const row of r.rows) {
    if (m[row.kind]) m[row.kind].set(String(row.label_ru).toLowerCase(), row.code);
    if (row.kind === 'type') m.typeLink.set(row.code, row.link_code);
  }
  return m;
}

module.exports = router;
