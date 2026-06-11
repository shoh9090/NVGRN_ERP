// refs.js — JSON API справочников (раздел 18 ТЗ): list, get, create, update, archive, restore
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { REF_TYPES, COMMON_FIELDS, clientMeta } = require('./refs-config');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const router = express.Router();

function typeOr404(req, res) {
  const t = REF_TYPES[req.params.type];
  if (!t) {
    res.status(404).json({ error: 'Неизвестный справочник' });
    return null;
  }
  return t;
}

function allFields(t) {
  const list = [...COMMON_FIELDS, ...t.fields, { key: 'short_name', label: 'Краткое название', type: 'text' }];
  const seen = new Set();
  return list.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
}

function pickValues(t, body) {
  const out = {};
  for (const f of allFields(t)) {
    if (!(f.key in body)) continue;
    let v = body[f.key];
    if (f.type === 'bool') v = v === true || v === 'true' || v === 'on' || v === 1;
    else if (f.type === 'number') v = v === '' || v === null ? null : Number(v);
    else if (f.type === 'ref') v = v === '' || v === null ? null : parseInt(v);
    else v = v === null || v === undefined ? '' : String(v).trim();
    out[f.key] = v;
  }
  if ('sort' in body) out.sort = parseInt(body.sort) || 100;
  return out;
}

function validate(t, values, isCreate) {
  const errors = [];
  for (const f of allFields(t)) {
    if (f.required) {
      const v = values[f.key];
      const empty = v === undefined || v === null || v === '';
      if (isCreate && empty) errors.push(`Не заполнено обязательное поле: ${f.label}`);
      if (!isCreate && f.key in values && empty) errors.push(`Поле «${f.label}» не может быть пустым`);
    }
  }
  return errors;
}


// Автогенерация артикула: RM-<код категории>-<номер> (ТЗ «Номенклатура сырья», раздел 4)
async function nextArticle(t, prefix, categoryId, fixedPrefix) {
  let base;
  if (fixedPrefix) {
    base = fixedPrefix;
  } else {
    const cat = await db.pool.query('SELECT code, name FROM ref_categories WHERE id = $1', [categoryId]);
    if (!cat.rows.length) throw new Error('категория не найдена');
    const catCode = String(cat.rows[0].code || '').trim().toUpperCase();
    if (!catCode) {
      throw new Error(`категория «${cat.rows[0].name}» не имеет кода для формирования артикула — задайте код категории (например BL)`);
    }
    base = `${prefix}-${catCode}`;
  }
  const like = `${base}-%`;
  const r = await db.pool.query(
    `SELECT code FROM ${t.table} WHERE code LIKE $1`,
    [like]
  );
  let max = 0;
  for (const row of r.rows) {
    const m = String(row.code).match(/-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1]));
  }
  return `${base}-${String(max + 1).padStart(3, '0')}`;
}

// Ссылочные поля не должны указывать на архивные записи (ТЗ, раздел 11)
async function checkRefsActive(t, values) {
  for (const f of t.fields) {
    if (f.type !== 'ref') continue;
    const id = values[f.key];
    if (!id) continue;
    const refTable = REF_TYPES[f.ref].table;
    const r = await db.pool.query(`SELECT status, name FROM ${refTable} WHERE id = $1`, [id]);
    if (!r.rows.length) return `поле «${f.label}»: запись не найдена`;
    if (r.rows[0].status === 'archived') return `поле «${f.label}»: «${r.rows[0].name}» в архиве — выберите активную запись`;
  }
  return null;
}

function saveError(res, msg, code = 400) {
  return res.status(code).json({ error: `Не удалось сохранить позицию. Причина: ${msg}` });
}

// Метаданные схем для интерфейса
router.get('/_meta', (req, res) => {
  res.json(clientMeta());
});

// Уникальные значения текстового поля (для динамических фильтров, как «Направление торговли»)
router.get('/:type/distinct/:field', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const f = t.fields.find((x) => x.key === req.params.field && x.filterable);
  if (!f) return res.status(400).json({ error: 'Поле недоступно для фильтра' });
  const r = await db.pool.query(
    `SELECT DISTINCT ${f.key} AS v FROM ${t.table} WHERE ${f.key} IS NOT NULL AND ${f.key}::text <> '' ORDER BY 1`
  );
  res.json({ values: r.rows.map((x) => x.v) });
});



// Полное удаление — только администратор (ТЗ, раздел 9)
router.delete('/:type/:id(\\d+)', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Недостаточно прав: удаление доступно только администратору' });

  const cur = await db.pool.query(`SELECT id, code, name FROM ${t.table} WHERE id = $1`, [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Запись не найдена' });
  const rec = cur.rows[0];

  // проверка использования в других справочниках и ценах
  const usedIn = [];
  for (const [otherKey, ot] of Object.entries(REF_TYPES)) {
    for (const f of ot.fields) {
      if (f.type === 'ref' && f.ref === req.params.type) {
        const u = await db.pool.query(`SELECT count(*)::int AS n FROM ${ot.table} WHERE ${f.key} = $1`, [req.params.id]);
        if (u.rows[0].n > 0) usedIn.push(`${ot.label} (${u.rows[0].n})`);
      }
    }
  }
  if (req.params.type === 'finished_goods') {
    const u = await db.pool.query('SELECT count(*)::int AS n FROM ref_prices WHERE product_id = $1', [req.params.id]);
    if (u.rows[0].n > 0) usedIn.push(`Отпускные цены (${u.rows[0].n})`);
  }
  if (req.params.type === 'price_types') {
    const u = await db.pool.query('SELECT count(*)::int AS n FROM ref_prices WHERE price_type_id = $1', [req.params.id]);
    if (u.rows[0].n > 0) usedIn.push(`Отпускные цены (${u.rows[0].n})`);
  }

  if (usedIn.length && req.query.force !== '1') {
    return res.status(409).json({ error: 'used', usedIn });
  }
  if (req.params.type === 'finished_goods' || req.params.type === 'price_types') {
    await db.pool.query(
      `DELETE FROM ref_prices WHERE ${req.params.type === 'finished_goods' ? 'product_id' : 'price_type_id'} = $1`,
      [req.params.id]
    );
  }
  await db.pool.query(`DELETE FROM ${t.table} WHERE id = $1`, [req.params.id]);
  await db.log(req.user.id, `ref_delete_${req.params.type}`,
    `id=${rec.id} код=${rec.code || '—'} «${rec.name}»${usedIn.length ? ' ПРИНУДИТЕЛЬНО, связи: ' + usedIn.join(', ') : ''}`);
  res.json({ ok: true });
});

// Перекодировка старых артикулов nvXX → RM-XX-000 (только администратор; раздел 10)
router.post('/raw_materials/recode-legacy', async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Недостаточно прав' });
  const t = REF_TYPES.raw_materials;
  const rows = await db.pool.query(
    `SELECT id, code, name, category_id FROM ${t.table} WHERE (code IS NULL OR code !~ '^RM-') ORDER BY name`
  );
  const mapping = [];
  let skipped = 0;
  for (const r of rows.rows) {
    if (!r.category_id) { mapping.push({ id: r.id, name: r.name, old: r.code, new: '', note: 'нет категории — пропущено' }); skipped++; continue; }
    try {
      const code = await nextArticle(t, 'RM', r.category_id);
      await db.pool.query(`UPDATE ${t.table} SET code = $1, updated_at = now(), updated_by = $2 WHERE id = $3`, [code, req.user.id, r.id]);
      mapping.push({ id: r.id, name: r.name, old: r.code, new: code });
    } catch (e) {
      mapping.push({ id: r.id, name: r.name, old: r.code, new: '', note: e.message });
      skipped++;
    }
  }
  await db.log(req.user.id, 'ref_recode_legacy_raw_materials', `перекодировано ${mapping.length - skipped}, пропущено ${skipped}`);
  res.json({ recoded: mapping.length - skipped, skipped, mapping });
});

// Экспорт справочника в Excel (учитывает поиск, статус и фильтры полей)
router.get('/:type/export', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const XLSX = require('xlsx');
  const status = req.query.status || 'active';
  const q = (req.query.q || '').trim();
  const where = [];
  const params = [];
  if (status !== 'all') { params.push(status); where.push(`status = $${params.length}`); }
  if (q) {
    const searchCols = ['name', 'code', 'code_1c', 'short_name', ...t.fields.filter((f) => f.searchable).map((f) => f.key)];
    params.push('%' + q + '%');
    where.push('(' + searchCols.map((c) => `${c} ILIKE $${params.length}`).join(' OR ') + ')');
  }
  for (const f of t.fields) {
    if (!f.filterable) continue;
    const raw = req.query['f_' + f.key];
    if (raw === undefined || raw === '') continue;
    params.push(f.type === 'ref' ? parseInt(raw) : String(raw));
    where.push(`${f.key} = $${params.length}`);
  }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await db.pool.query(`SELECT * FROM ${t.table} ${whereSQL} ORDER BY code, name`, params);

  // имена для ссылочных полей
  const refNames = {};
  for (const f of t.fields) {
    if (f.type !== 'ref' || refNames[f.ref]) continue;
    const r = await db.pool.query(`SELECT id, name FROM ${REF_TYPES[f.ref].table}`);
    refNames[f.ref] = Object.fromEntries(r.rows.map((x) => [x.id, x.name]));
  }
  const fields = [
    { key: 'code', label: 'Артикул' },
    { key: 'name', label: 'Наименование' },
    ...t.fields.filter((f) => !f.system),
    { key: 'status', label: 'Статус' },
    { key: 'comment', label: 'Комментарий' },
  ];
  const data = rows.rows.map((row) => {
    const out = {};
    for (const f of fields) {
      let v = row[f.key];
      if (f.type === 'ref') v = refNames[f.ref][v] || '';
      if (f.type === 'bool') v = v ? 'да' : '';
      out[f.label] = v === null || v === undefined ? '' : v;
    }
    return out;
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t.label.slice(0, 30));
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(t.label)}.xlsx"`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
});

// Список с поиском, фильтром, сортировкой, пагинацией
router.get('/:type', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(1000, parseInt(req.query.limit) || 100);
  const offset = (page - 1) * limit;
  const status = req.query.status || 'active';
  const q = (req.query.q || '').trim();

  const fields = allFields(t);
  const sortable = new Set(['id', 'name', 'code', 'sort', 'updated_at', ...fields.map((f) => f.key)]);
  const sortField = sortable.has(req.query.sort) ? req.query.sort : 'name';
  const order = req.query.order === 'desc' ? 'DESC' : 'ASC';

  const where = [];
  const params = [];
  if (status !== 'all') {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (q) {
    const searchCols = ['name', 'code', 'code_1c', 'short_name', ...t.fields.filter((f) => f.searchable).map((f) => f.key)];
    params.push('%' + q + '%');
    where.push('(' + searchCols.map((c) => `${c} ILIKE $${params.length}`).join(' OR ') + ')');
  }

  // Фильтры по полям (f_<имя_поля>) — для ref- и enum-полей
  for (const f of t.fields) {
    if (!f.filterable) continue;
    const raw = req.query['f_' + f.key];
    if (raw === undefined || raw === '') continue;
    if (f.type === 'ref') {
      params.push(parseInt(raw));
      where.push(`${f.key} = $${params.length}`);
    } else {
      params.push(String(raw));
      where.push(`${f.key} = $${params.length}`);
    }
  }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = await db.pool.query(`SELECT count(*)::int AS n FROM ${t.table} ${whereSQL}`, params);
  const rows = await db.pool.query(
    `SELECT * FROM ${t.table} ${whereSQL} ORDER BY ${sortField} ${order} NULLS LAST, id LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ total: total.rows[0].n, page, limit, items: rows.rows });
});

router.get('/:type/:id(\\d+)', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const r = await db.pool.query(`SELECT * FROM ${t.table} WHERE id = $1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Запись не найдена' });
  res.json(r.rows[0]);
});

router.post('/:type', express.json(), async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const values = pickValues(t, req.body || {});
  const errors = validate(t, values, true);
  if (errors.length) return saveError(res, errors.join('; '));

  const refErr = await checkRefsActive(t, values);
  if (refErr) return saveError(res, refErr);

  // Автоартикул (если включён для справочника и код не задан вручную)
  if ((t.autoCode || t.autoCodeFixed) && !values.code) {
    try {
      values.code = await nextArticle(t, t.autoCode, values.category_id, t.autoCodeFixed);
    } catch (e) {
      return saveError(res, e.message);
    }
  }

  // Проверка дублей
  for (const dk of t.dedupe || []) {
    const v = values[dk];
    if (!v) continue;
    const dup = await db.pool.query(`SELECT id, name FROM ${t.table} WHERE lower(${dk}::text) = lower($1) LIMIT 1`, [String(v)]);
    if (dup.rows.length) {
      const label = dk === 'code' ? 'артикул ' + values.code + ' уже существует' : `дубль по полю «${dk}»: уже есть запись «${dup.rows[0].name}»`;
      return saveError(res, label, 409);
    }
  }

  const keys = Object.keys(values);
  keys.push('created_by', 'updated_by');
  const vals = [...Object.values(values), req.user.id, req.user.id];
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.pool.query(
    `INSERT INTO ${t.table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals
  );
  await db.log(req.user.id, `ref_create_${req.params.type}`, r.rows[0].name);
  res.json(r.rows[0]);
});

router.put('/:type/:id(\\d+)', express.json(), async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const values = pickValues(t, req.body || {});
  if ((t.autoCode || t.autoCodeFixed) && 'code' in values) {
    if (!req.user.isAdmin) {
      delete values.code; // обычный пользователь номенклатурный код не меняет
    } else {
      const cur = await db.pool.query(`SELECT code, name FROM ${t.table} WHERE id = $1`, [req.params.id]);
      const oldCode = cur.rows.length ? cur.rows[0].code : '';
      const newCode = String(values.code || '').trim().toUpperCase();
      if (newCode === String(oldCode || '')) {
        delete values.code;
      } else {
        if (!/^RM-[A-Z]{2,3}-[0-9]{3,4}$/.test(newCode)) {
          return saveError(res, `код «${newCode}» не соответствует формату RM-XX-000`);
        }
        const dup = await db.pool.query(`SELECT id FROM ${t.table} WHERE upper(code::text) = $1 AND id <> $2 LIMIT 1`, [newCode, req.params.id]);
        if (dup.rows.length) return saveError(res, `артикул ${newCode} уже существует`, 409);
        values.code = newCode;
        await db.log(req.user.id, `ref_code_change_${req.params.type}`,
          `id=${req.params.id} «${cur.rows.length ? cur.rows[0].name : ''}»: ${oldCode} → ${newCode}`);
      }
    }
  }
  const errors = validate(t, values, false);
  if (errors.length) return saveError(res, errors.join('; '));
  const refErr = await checkRefsActive(t, values);
  if (refErr) return saveError(res, refErr);
  const keys = Object.keys(values);
  if (!keys.length) return res.status(400).json({ error: 'Нет данных для сохранения' });
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const vals = Object.values(values);
  vals.push(req.user.id, req.params.id);
  const r = await db.pool.query(
    `UPDATE ${t.table} SET ${sets.join(', ')}, updated_at = now(), updated_by = $${vals.length - 1} WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Запись не найдена' });
  await db.log(req.user.id, `ref_update_${req.params.type}`, String(req.params.id));
  res.json(r.rows[0]);
});

router.post('/:type/:id(\\d+)/archive', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  await db.pool.query(
    `UPDATE ${t.table} SET status = 'archived', archived_at = now(), archived_by = $1 WHERE id = $2`,
    [req.user.id, req.params.id]
  );
  await db.log(req.user.id, `ref_archive_${req.params.type}`, String(req.params.id));
  res.json({ ok: true });
});

router.post('/:type/:id(\\d+)/restore', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  await db.pool.query(
    `UPDATE ${t.table} SET status = 'active', archived_at = NULL, archived_by = NULL WHERE id = $1`,
    [req.params.id]
  );
  await db.log(req.user.id, `ref_restore_${req.params.type}`, String(req.params.id));
  res.json({ ok: true });
});


// ===== Мастер импорта (Итерация 3): предпросмотр → подтверждение =====
// Понимает реальные файлы Novagreen: вкладку db (сырьё), список поставщиков, TOTAL (долги)

function sheetRows(buf) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out = [];
  for (const name of wb.SheetNames) {
    out.push({ name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) });
  }
  return out;
}

const IMPORT_PROFILES = {
  raw_materials: {
    must: ['наимен', 'артикул'],
    map: [
      { kw: 'наимен', field: 'name' },
      { kw: 'категор', field: '_category' },
      { kw: 'характер', field: 'characteristics' },
      { kw: 'артикул', field: 'code' },
      { kw: 'ед', field: '_unit' },
    ],
  },
  counterparties: {
    must: ['имя'],
    map: [
      { kw: 'код', field: 'code' },
      { kw: 'имя', field: 'name' },
      { kw: 'фирм', field: 'legal_name' },
      { kw: 'сырь', field: 'supplies' },
      { kw: 'тел', field: 'phone' },
      { kw: 'инн', field: 'inn' },
      { kw: 'приход', field: 'opening_balance' },
      { kw: 'долг', field: 'opening_balance' },
    ],
  },
};

function detectTable(sheets, profile) {
  for (const sh of sheets) {
    for (let i = 0; i < Math.min(sh.rows.length, 12); i++) {
      const row = sh.rows[i].map((c) => String(c || '').toLowerCase());
      const hit = profile.must.every((kw) => row.some((c) => c.includes(kw)));
      if (!hit) continue;
      const cols = {};
      for (const m of profile.map) {
        const idx = row.findIndex((c) => c.includes(m.kw));
        if (idx >= 0 && !(m.field in cols)) cols[m.field] = idx;
      }
      return { sheet: sh.name, headerRow: i, cols, rows: sh.rows.slice(i + 1) };
    }
  }
  return null;
}

async function buildPreview(typeKey, t, buf) {
  const profile = IMPORT_PROFILES[typeKey];
  if (!profile) return { error: 'Для этого справочника мастер импорта пока не настроен' };
  const det = detectTable(sheetRows(buf), profile);
  if (!det) return { error: 'Не нашёл таблицу в файле: нет строки заголовков с нужными колонками' };

  // справочные карты для подсказок
  const units = await db.pool.query('SELECT id, lower(name) AS n, lower(short_name) AS s FROM ref_units');
  const unitMap = {};
  for (const u of units.rows) { unitMap[u.n] = u.id; unitMap[u.s] = u.id; }
  const cats = await db.pool.query("SELECT id, lower(name) AS n FROM ref_categories WHERE kind = 'категория'");
  const catMap = {};
  for (const c of cats.rows) catMap[c.n] = c.id;
  const existing = await db.pool.query(`SELECT id, lower(name) AS n, lower(code::text) AS c FROM ${t.table}`);
  const byName = {};
  const byCode = {};
  for (const e of existing.rows) { byName[e.n] = e.id; if (e.c) byCode[e.c] = e.id; }

  const seen = new Set();
  const rows = [];
  for (const raw of det.rows) {
    const get = (f) => (det.cols[f] !== undefined ? String(raw[det.cols[f]] ?? '').trim() : '');
    const name = get('name');
    if (!name || /^(итого|total|№)/i.test(name)) continue;
    const values = { name };
    for (const f of ['code', 'characteristics', 'legal_name', 'supplies', 'phone', 'inn']) {
      const v = get(f);
      if (v) values[f] = v;
    }
    if (det.cols.opening_balance !== undefined) {
      const num = parseFloat(String(raw[det.cols.opening_balance]).replace(/\s/g, '').replace(',', '.'));
      if (!isNaN(num)) values.opening_balance = num;
    }
    let note = '';
    let error = '';
    if (typeKey === 'raw_materials') {
      const unitName = get('_unit').toLowerCase();
      if (unitName && unitMap[unitName]) values.unit_id = unitMap[unitName];
      else if (unitName) note += `единица «${unitName}» будет создана; `;
      values._unit_name = get('_unit');
      const catName = get('_category').toLowerCase();
      if (catName && catMap[catName]) values.category_id = catMap[catName];
      else if (catName) note += `категория «${get('_category')}» будет создана; `;
      values._category_name = get('_category');
    }
    if (typeKey === 'counterparties') values.role_supplier = true;
    const key = (values.code || name).toLowerCase();
    if (seen.has(key)) error = 'дубль внутри файла — строка будет пропущена';
    seen.add(key);
    const exId = (values.code && byCode[String(values.code).toLowerCase()]) || byName[name.toLowerCase()];
    const action = error ? 'skip' : exId ? 'update' : 'create';
    rows.push({ action, values, note: note.trim(), error });
  }
  return { sheet: det.sheet, total: rows.length, rows };
}

router.post('/:type/import/preview', upload.single('file'), async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  try {
    const preview = await buildPreview(req.params.type, t, req.file.buffer);
    if (preview.error) return res.status(400).json({ error: preview.error });
    res.json(preview);
  } catch (e) {
    res.status(400).json({ error: 'Не удалось прочитать файл: ' + e.message });
  }
});

router.post('/:type/import/commit', express.json({ limit: '10mb' }), async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const r of rows) {
    if (!r || r.action === 'skip' || !r.values || !r.values.name) { skipped++; continue; }
    const v = { ...r.values };
    try {
      // создаём недостающие единицы/категории (для сырья)
      if (req.params.type === 'raw_materials') {
        if (!v.unit_id && v._unit_name) {
          const un = String(v._unit_name).trim();
          const ex = await db.pool.query('SELECT id FROM ref_units WHERE lower(short_name)=lower($1) OR lower(name)=lower($1) LIMIT 1', [un]);
          v.unit_id = ex.rows.length ? ex.rows[0].id
            : (await db.pool.query('INSERT INTO ref_units (name, short_name, created_by, updated_by) VALUES ($1,$1,$2,$2) RETURNING id', [un, req.user.id])).rows[0].id;
        }
        if (!v.category_id && v._category_name) {
          const cn = String(v._category_name).trim();
          const ex = await db.pool.query("SELECT id FROM ref_categories WHERE lower(name)=lower($1) AND kind='категория' LIMIT 1", [cn]);
          v.category_id = ex.rows.length ? ex.rows[0].id
            : (await db.pool.query("INSERT INTO ref_categories (name, kind, created_by, updated_by) VALUES ($1,'категория',$2,$2) RETURNING id", [cn, req.user.id])).rows[0].id;
        }
      }
      delete v._unit_name;
      delete v._category_name;

      // существующая запись: по коду, затем по имени
      let exId = null;
      if (v.code) {
        const ex = await db.pool.query(`SELECT id FROM ${t.table} WHERE lower(code::text)=lower($1) LIMIT 1`, [String(v.code)]);
        exId = ex.rows.length ? ex.rows[0].id : null;
      }
      if (!exId) {
        const ex = await db.pool.query(`SELECT id FROM ${t.table} WHERE lower(name)=lower($1) LIMIT 1`, [v.name]);
        exId = ex.rows.length ? ex.rows[0].id : null;
      }
      const keys = Object.keys(v);
      if (exId) {
        const sets = keys.map((k, i) => `${k} = $${i + 1}`);
        await db.pool.query(
          `UPDATE ${t.table} SET ${sets.join(', ')}, updated_at = now(), updated_by = $${keys.length + 1} WHERE id = $${keys.length + 2}`,
          [...Object.values(v), req.user.id, exId]
        );
        updated++;
      } else {
        keys.push('created_by', 'updated_by');
        const ph = keys.map((_, i) => `$${i + 1}`).join(', ');
        await db.pool.query(`INSERT INTO ${t.table} (${keys.join(', ')}) VALUES (${ph})`, [...Object.values(v), req.user.id, req.user.id]);
        created++;
      }
    } catch (e) {
      skipped++;
    }
  }
  await db.log(req.user.id, `ref_import_wizard_${req.params.type}`, `created=${created} updated=${updated} skipped=${skipped}`);
  res.json({ created, updated, skipped });
});

// Простой импорт (для остальных справочников): колонка A — название, B — код
router.post('/:type/import-simple', upload.single('file'), async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  let rows = [];
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Не удалось прочитать файл: ' + e.message });
  }
  let added = 0;
  let skipped = 0;
  for (const row of rows) {
    const name = String(row[0] || '').trim();
    const code = String(row[1] || '').trim();
    if (!name || /^(название|наименование)$/i.test(name)) continue;
    const dup = await db.pool.query(`SELECT 1 FROM ${t.table} WHERE lower(name) = lower($1)`, [name]);
    if (dup.rows.length) {
      skipped++;
      continue;
    }
    try {
      // Заполняем обязательные ref-поля значением по умолчанию нельзя — пропускаем их проверку на импорте
      await db.pool.query(`INSERT INTO ${t.table} (name, code, created_by, updated_by) VALUES ($1, $2, $3, $3)`, [
        name,
        code,
        req.user.id,
      ]);
      added++;
    } catch (e) {
      skipped++;
    }
  }
  await db.log(req.user.id, `ref_import_${req.params.type}`, `added=${added} skipped=${skipped}`);
  res.json({ added, skipped });
});

module.exports = router;
