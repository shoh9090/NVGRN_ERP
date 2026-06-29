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
  const out = { type: [], severity: [], resolution: [], category: [], link: [], usage: [], dish_form: [] };
  for (const row of r.rows) (out[row.kind] = out[row.kind] || []).push(row);
  out.status = Object.entries(STATUS).map(([code, label_ru]) => ({ code, label_ru }));
  res.json(out);
});

// ----- Управление справочником (админ или РОП) -----
// Редактируем только пользовательские разделы; служебные (link/category/resolution/status) не трогаем здесь.
const EDITABLE_KINDS = ['type', 'severity', 'usage', 'dish_form'];
async function requireManager(req, res, next) {
  if (!req.user) return res.status(403).json({ error: 'Не авторизовано' });
  if (req.user.isAdmin) return next();
  try {
    const r = await db.pool.query(
      `SELECT 1 FROM tiles t
       JOIN role_tiles rt ON rt.tile_id = t.id
       JOIN user_roles ur ON ur.role_id = rt.role_id
       WHERE ur.user_id = $1 AND t.url = '/complaints' LIMIT 1`,
      [req.user.id]
    );
    if (r.rows.length) return next();
  } catch (e) { /* не падаем на проверке доступа */ }
  return res.status(403).json({ error: 'Действие доступно администратору или тем, кому назначена плитка «Претензии»' });
}

// Все записи справочника (включая выключенные) — для экрана настроек.
router.get('/api/dicts/all', async (req, res) => {
  const r = await db.pool.query(
    'SELECT id, kind, code, label_ru, link_code, sort_order, active FROM tgbot.complaint_dicts ORDER BY kind, sort_order, id'
  );
  res.json({ items: r.rows });
});

// Добавить пункт. Код генерируем сами (стабильный, человеку не показываем).
router.post('/api/dict', requireManager, express.json(), async (req, res) => {
  const { kind, label_ru, link_code, sort_order } = req.body || {};
  if (!EDITABLE_KINDS.includes(kind)) return res.status(400).json({ error: 'Недопустимый раздел справочника' });
  const label = (label_ru || '').trim();
  if (!label) return res.status(400).json({ error: 'Введите название пункта' });
  const code = `${kind}_${Date.now().toString(36)}`;
  await db.pool.query(
    `INSERT INTO tgbot.complaint_dicts (kind, code, label_ru, link_code, sort_order, active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [kind, code, label, kind === 'type' ? (link_code || null) : null, parseInt(sort_order) || 0]
  );
  await db.log(req.user.id, 'complaint_dict_add', `${kind}: ${label}`);
  res.json({ ok: true, code });
});

// Изменить пункт: название, звено (для типов), порядок, вкл/выкл. Код и связи остаются.
router.post('/api/dict/:id(\\d+)', requireManager, express.json(), async (req, res) => {
  const { label_ru, link_code, sort_order, active } = req.body || {};
  const cur = (await db.pool.query('SELECT kind FROM tgbot.complaint_dicts WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Пункт не найден' });
  if (!EDITABLE_KINDS.includes(cur.kind)) return res.status(400).json({ error: 'Этот раздел нельзя менять здесь' });
  await db.pool.query(
    `UPDATE tgbot.complaint_dicts SET
       label_ru   = COALESCE($1, label_ru),
       link_code  = CASE WHEN $2 = 'type' THEN $3 ELSE link_code END,
       sort_order = COALESCE($4, sort_order),
       active     = COALESCE($5, active)
     WHERE id = $6`,
    [label_ru != null ? String(label_ru).trim() : null, cur.kind, link_code || null,
     sort_order != null ? parseInt(sort_order) : null, typeof active === 'boolean' ? active : null, req.params.id]
  );
  await db.log(req.user.id, 'complaint_dict_edit', `#${req.params.id}`);
  res.json({ ok: true });
});

// Удалить пункт. Если он уже встречается в претензиях — не теряем историю: прячем (active=false).
router.post('/api/dict/:id(\\d+)/delete', requireManager, async (req, res) => {
  const cur = (await db.pool.query('SELECT kind, code FROM tgbot.complaint_dicts WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Пункт не найден' });
  if (!EDITABLE_KINDS.includes(cur.kind)) return res.status(400).json({ error: 'Этот раздел нельзя менять здесь' });
  let used = 0;
  if (cur.kind === 'type') used = (await db.pool.query('SELECT 1 FROM tgbot.complaints WHERE complaint_type = $1 LIMIT 1', [cur.code])).rowCount;
  else if (cur.kind === 'severity') used = (await db.pool.query('SELECT 1 FROM tgbot.complaints WHERE severity = $1 LIMIT 1', [cur.code])).rowCount;
  if (used) {
    await db.pool.query('UPDATE tgbot.complaint_dicts SET active = false WHERE id = $1', [req.params.id]);
    await db.log(req.user.id, 'complaint_dict_hide', `#${req.params.id}`);
    return res.json({ ok: true, soft: true });
  }
  await db.pool.query('DELETE FROM tgbot.complaint_dicts WHERE id = $1', [req.params.id]);
  await db.log(req.user.id, 'complaint_dict_delete', `#${req.params.id}`);
  res.json({ ok: true, soft: false });
});

// ----- Список с фильтрами -----
router.get('/api/list', async (req, res) => {
  const { from, to, status, type, link, severity, q, product, usage, dish } = req.query;

  // Собираем условия. base[] — фильтры без статуса (для сводки), full[] — со статусом (для списка).
  function build(includeStatus) {
    const p = [], w = [];
    const add = (sql, val) => { p.push(val); w.push(sql.replace('$?', '$' + p.length)); };
    if (from) add('c.created_at >= $?', from);
    if (to)   add('c.created_at < ($?::date + 1)', to);
    if (includeStatus && status) add('c.status = $?', status);
    if (type) add('c.complaint_type = $?', type);
    if (product) add('c.product_name = $?', product);
    if (usage) add('c.product_usage = $?', usage);
    if (dish) add('c.dish_form = $?', dish);
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

// ----- Удаление претензии целиком (админ/РОП). Чистим и медиа из public.files. -----
router.post('/api/one/:id(\\d+)/delete', requireManager, async (req, res) => {
  const id = req.params.id;
  const files = (await db.pool.query(
    'SELECT file_ref FROM tgbot.complaint_files WHERE complaint_id = $1 AND file_ref IS NOT NULL', [id]
  )).rows;
  await db.pool.query('DELETE FROM tgbot.complaints WHERE id = $1', [id]); // complaint_files уйдут каскадом
  for (const f of files) { await db.pool.query('DELETE FROM public.files WHERE id = $1', [f.file_ref]).catch(() => {}); }
  await db.log(req.user.id, 'complaint_delete', `#${id}`);
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
  // «Продукт» точно (исключаем «категория продукта», где тоже есть слово «продукт»).
  const findProduct = (obj) => {
    const k = Object.keys(obj).find((x) => x.toLowerCase().includes('продукт') && !x.toLowerCase().includes('категори'));
    return k ? obj[k] : null;
  };

  const client = await db.pool.connect();
  let inserted = 0;
  const unmatchedTypes = new Set();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM tgbot.complaints WHERE source = 'import'");
    for (const r of rows) {
      const typeLabel = norm(findCol(r, 'тип жалоб'));
      if (!typeLabel && !norm(findProduct(r))) continue; // пустая строка
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
         norm(findProduct(r)) || null, dict.category.get(cat.toLowerCase()) || (cat || null),
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

// ----- Сводка для дашборда (по месяцу, со сравнением месяц-к-месяцу) -----
router.get('/api/stats', async (req, res) => {
  // месяц вида YYYY-MM; по умолчанию — текущий
  let ym = String(req.query.month || '').match(/^\d{4}-\d{2}$/) ? req.query.month : null;
  const now = new Date();
  if (!ym) ym = now.toISOString().slice(0, 7);
  const [yy, mm] = ym.split('-').map(Number);
  const from = `${ym}-01`;
  const toD = new Date(Date.UTC(yy, mm, 1)); const to = toD.toISOString().slice(0, 10);          // первый день след. месяца
  const prevFromD = new Date(Date.UTC(yy, mm - 2, 1)); const prevFrom = prevFromD.toISOString().slice(0, 10);
  const prevTo = from;

  const one = async (sql, p) => (await db.pool.query(sql, p)).rows;
  const scalar = async (sql, p) => Number((await db.pool.query(sql, p)).rows[0]?.n || 0);

  const inP = 'created_at >= $1 AND created_at < $2';
  const total = await scalar(`SELECT count(*) n FROM tgbot.complaints WHERE ${inP}`, [from, to]);
  const totalPrev = await scalar(`SELECT count(*) n FROM tgbot.complaints WHERE created_at >= $1 AND created_at < $2`, [prevFrom, prevTo]);
  const zhiv = await scalar(`SELECT count(*) n FROM tgbot.complaints WHERE ${inP} AND complaint_type='zhivnost'`, [from, to]);
  const zhivPrev = await scalar(`SELECT count(*) n FROM tgbot.complaints WHERE created_at >= $1 AND created_at < $2 AND complaint_type='zhivnost'`, [prevFrom, prevTo]);
  const critical = await scalar(`SELECT count(*) n FROM tgbot.complaints WHERE ${inP} AND severity='critical'`, [from, to]);

  const byLink = await one(`SELECT link_code code, count(*)::int n FROM tgbot.complaints WHERE ${inP} AND link_code IS NOT NULL GROUP BY 1 ORDER BY n DESC`, [from, to]);
  const byType = await one(`SELECT complaint_type code, count(*)::int n FROM tgbot.complaints WHERE ${inP} AND complaint_type IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 8`, [from, to]);
  const byProduct = await one(`SELECT product_name name, count(*)::int n FROM tgbot.complaints WHERE ${inP} AND product_name IS NOT NULL AND product_name<>'' GROUP BY 1 ORDER BY n DESC LIMIT 8`, [from, to]);
  const byUsage = await one(`SELECT product_usage code, count(*)::int n FROM tgbot.complaints WHERE ${inP} AND product_usage IS NOT NULL AND product_usage<>'' GROUP BY 1 ORDER BY n DESC LIMIT 8`, [from, to]);
  const byDish = await one(`SELECT dish_form code, count(*)::int n FROM tgbot.complaints WHERE ${inP} AND dish_form IS NOT NULL AND dish_form<>'' GROUP BY 1 ORDER BY n DESC LIMIT 8`, [from, to]);
  const byAgent = await one(`SELECT COALESCE(NULLIF(agent_name,''),'—') name, count(*)::int n FROM tgbot.complaints WHERE ${inP} GROUP BY 1 ORDER BY n DESC LIMIT 8`, [from, to]);

  // Тренд: последние 12 месяцев до конца выбранного
  const trendFrom = new Date(Date.UTC(yy, mm - 12, 1)).toISOString().slice(0, 10);
  const trend = await one(
    `SELECT to_char(date_trunc('month', created_at),'YYYY-MM') ym, count(*)::int n
     FROM tgbot.complaints WHERE created_at >= $1 AND created_at < $2
     GROUP BY 1 ORDER BY 1`, [trendFrom, to]);

  // Матрица продукт×месяц: топ-6 продуктов за последние 6 месяцев
  const mxFrom = new Date(Date.UTC(yy, mm - 6, 1)).toISOString().slice(0, 10);
  const topProds = (await one(
    `SELECT product_name FROM tgbot.complaints
     WHERE created_at >= $1 AND created_at < $2 AND product_name IS NOT NULL AND product_name<>''
     GROUP BY 1 ORDER BY count(*) DESC LIMIT 6`, [mxFrom, to])).map((r) => r.product_name);
  let matrix = { months: [], rows: [] };
  if (topProds.length) {
    const cells = await one(
      `SELECT product_name, to_char(date_trunc('month', created_at),'YYYY-MM') ym, count(*)::int n
       FROM tgbot.complaints WHERE created_at >= $1 AND created_at < $2 AND product_name = ANY($3)
       GROUP BY 1,2`, [mxFrom, to, topProds]);
    const months = [];
    for (let i = 6; i >= 1; i--) months.push(new Date(Date.UTC(yy, mm - i, 1)).toISOString().slice(0, 7));
    const lut = {}; cells.forEach((c) => { (lut[c.product_name] = lut[c.product_name] || {})[c.ym] = c.n; });
    matrix = {
      months: months.map((m) => ({ ym: m, label: monthLabel(m) })),
      rows: topProds.map((p) => { const vals = months.map((m) => (lut[p] && lut[p][m]) || 0); return { product: p, vals, tot: vals.reduce((a, b) => a + b, 0) }; }),
    };
  }

  // Список доступных месяцев для селектора
  const monthsAvail = (await one(
    `SELECT DISTINCT to_char(date_trunc('month', created_at),'YYYY-MM') ym FROM tgbot.complaints ORDER BY ym DESC`)).map((r) => r.ym);
  if (!monthsAvail.includes(ym)) monthsAvail.unshift(ym);

  const pct = (a, b) => (b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100));
  res.json({
    month: ym, monthLabel: monthLabel(ym), prevLabel: monthLabel(prevTo.slice(0, 7)),
    monthsAvail,
    kpi: {
      total, totalPrev, totalDelta: pct(total, totalPrev),
      zhivnost: zhiv, zhivnostPrev: zhivPrev, zhivnostDelta: pct(zhiv, zhivPrev),
      critical,
      topLink: byLink[0] || null, topProduct: byProduct[0] || null,
    },
    byLink, byType, byProduct, byUsage, byDish, byAgent, trend, matrix,
  });
});

function monthLabel(ym) {
  const names = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const [y, m] = String(ym).split('-').map(Number);
  return names[(m || 1) - 1] + ' ' + y;
}

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
