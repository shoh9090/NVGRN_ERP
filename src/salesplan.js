// salesplan.js — плитка «План продаж» (ГП): недельная сетка спроса по готовой продукции.
//
// Что это: РОП задаёт план в штуках по дням. Сетка строится САМА — все товары
// направления уже стоят строками, как в рабочем файле Excel. Никаких «сначала
// добавь товар, потом введи цифру»: открыл неделю и вбиваешь по столбцам.
// Производство и закуп потом читают эту же цифру, а не свои таблицы.
//
// Чего здесь НЕТ и не будет без отдельного решения Шоха: согласований по
// цепочке, обязательных статусов, автоматических заявок поставщику, проводок
// склада и записи в SalesDoctor. План — это запись намерения, не команда.
//
// Источники правды не дублируются: товар и его направление — ref_finished_goods
// (приходит из SD), цена — ref_prices по выбранному прайсу, факт — sd_sales.
const express = require('express');
const XLSX = require('xlsx');
const db = require('./db');
const { ensureSalesPlanSchema } = require('./salesplan-schema');
const core = require('./salesplan-core');

const router = express.Router();

router.use(async (req, res, next) => {
  try { await ensureSalesPlanSchema(db.pool); next(); }
  catch (e) { next(e); }
});

// Менять план продаж может РОП и админ — больше никто (решение Шоха 02.10.2026).
// Остальным, у кого есть плитка, план виден только на чтение: склад, закуп и
// производство должны ЗНАТЬ план, но не переписывать чужую цель.
const SALES_HEAD_ROLES = ['Руководитель продаж', 'РОП'];
const canEditPlan = (user) => !!user && (user.isAdmin
  || (user.roles || []).some((r) => SALES_HEAD_ROLES.some((n) => n.toLowerCase() === String(r || '').trim().toLowerCase())));

function requireEdit(req, res, next) {
  if (!req.user) return res.status(403).json({ error: 'Не авторизовано' });
  if (canEditPlan(req.user)) return next();
  return res.status(403).json({
    error: 'Менять план продаж может только руководитель отдела продаж. Вам план виден на чтение.',
  });
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

const channels = () => db.pool.query(
  `SELECT code, name, sd_trade, sort_order, default_price_type_id
     FROM sales_plan_channels WHERE active ORDER BY sort_order, code`).then((r) => r.rows);

// Строка сетки для «направление + товар». Нарочно без ON CONFLICT по выражению:
// уникальность задана индексом по COALESCE(price_type_id, 0), и опираться на то,
// как Postgres выведет такой индекс, не хочется — слишком тихая поломка.
// Нашли → вернули; нет → вставили; кто-то вставил одновременно (23505) → нашли
// ещё раз. Выключенная раньше строка возвращается в сетку, а не плодит вторую.
async function rowFor(channel, productId, userId) {
  const find = () => db.pool.query(
    `SELECT id, active FROM sales_plan_rows WHERE channel = $1 AND product_id = $2
      ORDER BY (price_type_id IS NULL), id LIMIT 1`, [channel, productId]);
  const wake = async (row) => {
    if (!row.active) {
      await db.pool.query('UPDATE sales_plan_rows SET active = TRUE, updated_by = $1, updated_at = now() WHERE id = $2',
        [userId, row.id]);
    }
    return row.id;
  };
  const found = await find();
  if (found.rowCount) return wake(found.rows[0]);
  try {
    const ins = await db.pool.query(
      `INSERT INTO sales_plan_rows (channel, product_id, price_type_id, created_by, updated_by)
       VALUES ($1,$2,NULL,$3,$3) RETURNING id`, [channel, productId, userId]);
    return ins.rows[0].id;
  } catch (e) {
    if (e.code !== '23505') throw e;
    const again = await find();
    if (!again.rowCount) throw e;
    return wake(again.rows[0]);
  }
}

// Строка, в которую пишем: либо прямо названная, либо по «направление + товар».
async function targetRow(body, userId) {
  if (body.row_id) {
    const r = await db.pool.query('SELECT id FROM sales_plan_rows WHERE id = $1', [parseInt(body.row_id, 10)]);
    if (!r.rowCount) throw Object.assign(new Error('Строка плана не найдена'), { status: 404 });
    return r.rows[0].id;
  }
  const channel = String(body.channel || '').trim();
  const productId = parseInt(body.product_id, 10);
  if (!channel || !productId) throw Object.assign(new Error('Нужны направление и товар'), { status: 400 });
  const ok = await db.pool.query(
    `SELECT 1 FROM sales_plan_channels WHERE code = $1 AND active`, [channel]);
  if (!ok.rowCount) throw Object.assign(new Error('Такого направления нет'), { status: 400 });
  const g = await db.pool.query('SELECT 1 FROM ref_finished_goods WHERE id = $1', [productId]);
  if (!g.rowCount) throw Object.assign(new Error('Такого товара нет в справочнике'), { status: 400 });
  return rowFor(channel, productId, userId);
}

// ----- Страница -----
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('salesplan', { settings, user: req.user, canEdit: canEditPlan(req.user) });
});

// ----- Справочники для экрана -----
router.get('/api/meta', async (req, res) => {
  const priceTypes = (await db.pool.query(
    "SELECT id, name FROM ref_price_types WHERE COALESCE(status,'active') <> 'archived' ORDER BY name")).rows;
  res.json({ channels: await channels(), priceTypes, can_edit: canEditPlan(req.user) });
});

// Справочник готовой продукции — для окна «добавить товар не из направления».
// Отдельным запросом, а не в /meta: список длинный, а нужен раз в сто открытий.
router.get('/api/goods', async (req, res) => {
  const r = await db.pool.query(
    `SELECT g.id, g.name, COALESCE(c.name, g.trade_direction, '') AS trade_direction
       FROM ref_finished_goods g
       LEFT JOIN ref_categories c ON c.id = g.category_id
      WHERE COALESCE(g.status,'active') <> 'archived' ORDER BY g.name`);
  res.json({ items: r.rows });
});

// Прайсы, в которых у товара есть цена (и те, где её нет — помечены).
router.get('/api/prices/:productId(\\d+)', async (req, res) => {
  const r = await db.pool.query(
    `SELECT pt.id, pt.name, p.price, p.last_sync_at
       FROM ref_price_types pt
       LEFT JOIN ref_prices p ON p.price_type_id = pt.id AND p.product_id = $1
      WHERE COALESCE(pt.status,'active') <> 'archived'
      ORDER BY (p.price IS NULL), pt.name`, [req.params.productId]);
  res.json({ items: r.rows.map((x) => ({ id: x.id, name: x.name, price: num(x.price), synced_at: x.last_sync_at })) });
});

// ----- Сетка плана -----
// Период задаётся днями: неделя — это 7 дней, месяц и квартал — те же дни,
// просто больше. Отдельной «месячной цифры» не существует (решение Шоха).
// Дни периода из запроса. Бросает понятную ошибку — её показываем человеку.
function daysOf(q) {
  const days = q.to ? core.daysBetween(String(q.from), String(q.to))
    : core.weekDays(String(q.from || new Date().toISOString().slice(0, 10))).map((d) => d.day);
  if (days.length > 92) throw new Error('Период больше квартала — выберите отрезок короче');
  return days;
}

// Сетка собирается в ОДНОМ месте: экран и выгрузка обязаны показывать одно и
// то же. Разойдутся — и Excel будет спорить с экраном.
async function buildPlan(days, user) {
  const from = days[0], to = days[days.length - 1];

  const chans = await channels();
  // Сетка = все товары направления. Список берётся из справочника, а не
  // набирается руками: иначе каждый новый товар надо «не забыть добавить».
  const goods = (await db.pool.query(
    `SELECT g.id, g.name, COALESCE(c.name,'') AS category, COALESCE(g.trade_direction,'') AS trade
       FROM ref_finished_goods g
       LEFT JOIN ref_categories c ON c.id = g.category_id
      WHERE COALESCE(g.status,'active') <> 'archived'
      ORDER BY g.name`)).rows;
  const rows = (await db.pool.query(
    `SELECT r.id, r.channel, r.product_id, r.price_type_id, r.sort_order, r.note
       FROM sales_plan_rows r WHERE r.active`)).rows;
  const ptName = new Map((await db.pool.query('SELECT id, name FROM ref_price_types')).rows.map((x) => [x.id, x.name]));
  const priceMap = new Map((await db.pool.query(
    'SELECT price_type_id, product_id, price FROM ref_prices')).rows
    .map((x) => [x.price_type_id + '|' + x.product_id, Number(x.price)]));

  const cells = (await db.pool.query(
    `SELECT row_id, to_char(day,'YYYY-MM-DD') AS day, qty, source
       FROM sales_plan_cells WHERE day BETWEEN $1 AND $2`, [from, to])).rows;
  const byRow = new Map();
  for (const c of cells) {
    if (!byRow.has(c.row_id)) byRow.set(c.row_id, { cells: {}, src: {} });
    const o = byRow.get(c.row_id);
    o.cells[c.day] = Number(c.qty);
    o.src[c.day] = c.source;
  }

  // Фактическая средняя цена продажи за 4 недели до начала периода — чтобы
  // видеть, похож ли выбранный прайс на реальность. Это подсказка, а не цена плана.
  const factPrice = new Map();
  try {
    const f = (await db.pool.query(
      `SELECT g.id AS product_id, SUM(s.amount - s.returned) AS amount, SUM(s.qty) AS qty
         FROM sd_sales s JOIN ref_finished_goods g ON g.sd_sd_id = s.product_sd
        WHERE s.day >= ($1::date - 28) AND s.day < $1::date
        GROUP BY g.id HAVING SUM(s.qty) > 0`, [from])).rows;
    for (const x of f) factPrice.set(x.product_id, Math.round(Number(x.amount) / Number(x.qty)));
  } catch (e) { /* продажи SD ещё не выгружены — подсказки просто не будет */ }

  const goodById = new Map(goods.map((g) => [g.id, g]));
  const out = [];
  for (const ch of chans) {
    const mine = rows.filter((r) => r.channel === ch.code);
    const haveRow = new Set(mine.map((r) => r.product_id));
    const list = [];
    const push = (g, row) => {
      const ptId = (row && row.price_type_id) || ch.default_price_type_id || null;
      const price = ptId ? (priceMap.has(ptId + '|' + g.id) ? priceMap.get(ptId + '|' + g.id) : null) : null;
      const o = (row && byRow.get(row.id)) || { cells: {}, src: {} };
      const t = core.rowTotal(o.cells, days);
      list.push({
        id: row ? row.id : null, product_id: g.id, product_name: g.name,
        price_type_id: ptId, price_type_name: ptId ? (ptName.get(ptId) || null) : null,
        price_own: !!(row && row.price_type_id),      // прайс задан на строке, а не взят у направления
        price, fact_price: factPrice.has(g.id) ? factPrice.get(g.id) : null,
        note: (row && row.note) || '', cells: o.cells, src: o.src,
        total: t.qty, money: t.qty !== null && price !== null ? t.qty * price : null,
      });
    };
    // Сначала товары этого направления из справочника…
    for (const g of goods) if (!haveRow.has(g.id) && core.channelOf([g.category, g.trade], chans) === ch.code) push(g, null);
    // …затем те, у кого строка уже заведена (в том числе добавленные руками).
    for (const r of mine) { const g = goodById.get(r.product_id); if (g) push(g, r); }
    list.sort((a, b) => a.product_name.localeCompare(b.product_name, 'ru'));
    out.push({ code: ch.code, name: ch.name, default_price_type_id: ch.default_price_type_id,
      default_price_type_name: ch.default_price_type_id ? (ptName.get(ch.default_price_type_id) || null) : null,
      rows: list, totals: core.summarize(list, days) });
  }

  return {
    from, to, days: days.map((d) => ({ day: d, wd: core.wdOf(d) })),
    week_label: core.weekLabel(from), can_edit: canEditPlan(user), channels: out,
    totals: core.summarize(out.flatMap((c) => c.rows), days),
  };
}

router.get('/api/plan', async (req, res) => {
  let days;
  try { days = daysOf(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json(await buildPlan(days, req.user));
});

// ----- Одна клетка -----
// qty: число — записываем; null/'' — удаляем запись (клетка «не заполнена»).
// Ноль записывается как ноль: это решение «ничего не планируем», а не пустота.
router.post('/api/cell', requireEdit, express.json(), async (req, res, next) => {
  const day = String(req.body.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Нужна дата' });
  let qty;
  try { qty = core.parseQty(req.body.qty); } catch (e) { return res.status(400).json({ error: e.message }); }
  let rowId;
  try { rowId = await targetRow(req.body, req.user.id); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

  if (qty === null) {
    await db.pool.query('DELETE FROM sales_plan_cells WHERE row_id = $1 AND day = $2', [rowId, day]);
  } else {
    await db.pool.query(
      `INSERT INTO sales_plan_cells (row_id, day, qty, source, updated_by, updated_at)
       VALUES ($1,$2,$3,'manual',$4,now())
       ON CONFLICT (row_id, day) DO UPDATE SET qty = EXCLUDED.qty, source = 'manual',
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [rowId, day, qty, req.user.id]);
  }
  await db.pool.query('UPDATE sales_plan_rows SET updated_by = $1, updated_at = now() WHERE id = $2', [req.user.id, rowId]);
  res.json({ ok: true, qty, row_id: rowId });
});

// ----- Разложить неделю по дням -----
// Чтобы планировать на месяц и дальше, РОП вводит одно число на неделю, а
// система раскладывает его по дням в пропорции фактических продаж: у ресторанов
// пятница крупная, понедельник мелкий. Нет факта — раскладываем ровно и прямо
// об этом говорим: равномерность не выдаётся за профиль спроса.
router.post('/api/spread', requireEdit, express.json(), async (req, res) => {
  let week, total;
  try { week = core.weekStart(String(req.body.week)); total = core.parseQty(req.body.total); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (total === null) return res.status(400).json({ error: 'Укажите количество на неделю' });
  let rowId;
  try { rowId = await targetRow(req.body, req.user.id); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

  const sd = (await db.pool.query(
    `SELECT COALESCE(g.sd_sd_id,'') AS sd FROM sales_plan_rows r
       JOIN ref_finished_goods g ON g.id = r.product_id WHERE r.id = $1`, [rowId])).rows[0].sd;
  let profile = null, basis = 'even';
  if (sd) {
    try {
      const f = (await db.pool.query(
        `SELECT to_char(day,'YYYY-MM-DD') AS day, SUM(qty - returned) AS qty
           FROM sd_sales WHERE product_sd = $1 AND day >= ($2::date - 56) AND day < $2::date
           GROUP BY 1`, [sd, week])).rows;
      profile = core.weekdayProfile(f);
      if (profile) basis = 'fact';
    } catch (e) { /* продаж нет — останется ровная раскладка */ }
  }

  const parts = core.spreadWeek(total, profile);
  const days = core.weekDays(week).map((d) => d.day);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < 7; i++) {
      await client.query(
        `INSERT INTO sales_plan_cells (row_id, day, qty, source, updated_by, updated_at)
         VALUES ($1,$2,$3,'spread',$4,now())
         ON CONFLICT (row_id, day) DO UPDATE SET qty = EXCLUDED.qty, source = 'spread',
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [rowId, days[i], parts[i], req.user.id]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }

  const out = {};
  days.forEach((d, i) => { out[d] = parts[i]; });
  res.json({ ok: true, basis, days: out, row_id: rowId });
});

// ----- Прайс и примечание строки -----
// Прайс берётся у направления; на строке он нужен только там, где товар идёт
// по другому прайсу. Поэтому меняется прямо по «направление + товар», без
// отдельного шага «сначала заведи строку».
router.post('/api/row-price', requireEdit, express.json(), async (req, res) => {
  const v = req.body.price_type_id ? parseInt(req.body.price_type_id, 10) : null;
  if (v) {
    const ok = await db.pool.query('SELECT 1 FROM ref_price_types WHERE id = $1', [v]);
    if (!ok.rowCount) return res.status(400).json({ error: 'Такого прайс-листа нет' });
  }
  let rowId;
  try { rowId = await targetRow(req.body, req.user.id); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  await db.pool.query(
    'UPDATE sales_plan_rows SET price_type_id = $1, updated_by = $2, updated_at = now() WHERE id = $3',
    [v, req.user.id, rowId]);
  res.json({ ok: true, row_id: rowId });
});

router.post('/api/row-note', requireEdit, express.json(), async (req, res) => {
  let rowId;
  try { rowId = await targetRow(req.body, req.user.id); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  await db.pool.query('UPDATE sales_plan_rows SET note = $1, updated_by = $2, updated_at = now() WHERE id = $3',
    [String(req.body.note || '').slice(0, 300), req.user.id, rowId]);
  res.json({ ok: true, row_id: rowId });
});

// Прайс всего направления — одной кнопкой, а не по строке у каждого товара.
router.post('/api/channel-price', requireEdit, express.json(), async (req, res) => {
  const code = String(req.body.channel || '').trim();
  const v = req.body.price_type_id ? parseInt(req.body.price_type_id, 10) : null;
  if (v) {
    const ok = await db.pool.query('SELECT 1 FROM ref_price_types WHERE id = $1', [v]);
    if (!ok.rowCount) return res.status(400).json({ error: 'Такого прайс-листа нет' });
  }
  const r = await db.pool.query(
    'UPDATE sales_plan_channels SET default_price_type_id = $1 WHERE code = $2', [v, code]);
  if (!r.rowCount) return res.status(404).json({ error: 'Направление не найдено' });
  await db.log(req.user.id, 'salesplan_channel_price', `${code}: прайс ${v || '—'}`);
  res.json({ ok: true });
});

// Добавить товар, у которого направление в SD не проставлено или другое.
router.post('/api/rows', requireEdit, express.json(), async (req, res) => {
  const channel = String(req.body.channel || '').trim();
  const ids = (Array.isArray(req.body.product_ids) ? req.body.product_ids : [])
    .map((x) => parseInt(x, 10)).filter(Boolean);
  if (!channel || !ids.length) return res.status(400).json({ error: 'Выберите направление и товары' });
  const ch = await db.pool.query('SELECT code FROM sales_plan_channels WHERE code = $1 AND active', [channel]);
  if (!ch.rowCount) return res.status(400).json({ error: 'Такого направления нет' });
  const okIds = (await db.pool.query(
    'SELECT id FROM ref_finished_goods WHERE id = ANY($1::int[])', [ids])).rows.map((r) => r.id);
  if (!okIds.length) return res.status(400).json({ error: 'Таких товаров в справочнике нет' });
  for (const pid of okIds) await rowFor(channel, pid, req.user.id);
  await db.log(req.user.id, 'salesplan_rows_add', `${channel}: ${okIds.length} поз.`);
  res.json({ ok: true, added: okIds.length });
});

// Убрать строку из сетки. Цифры плана не выбрасываем: строка выключается,
// история дней остаётся. Товар своего направления вернётся в сетку сам.
router.post('/api/row/:id(\\d+)/delete', requireEdit, async (req, res) => {
  const r = await db.pool.query(
    'UPDATE sales_plan_rows SET active = FALSE, updated_by = $1, updated_at = now() WHERE id = $2', [req.user.id, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Строка не найдена' });
  res.json({ ok: true });
});

// ----- Копирование недели -----
// По дням недели: понедельник источника → понедельник цели. По умолчанию
// заполняем только пустые клетки, чтобы не затереть уже введённое руками.
router.post('/api/copy', requireEdit, express.json(), async (req, res) => {
  let src, dst;
  try { src = core.weekStart(String(req.body.from)); dst = core.weekStart(String(req.body.to)); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (src === dst) return res.status(400).json({ error: 'Это одна и та же неделя' });
  const over = !!req.body.overwrite;
  const r = await db.pool.query(
    `INSERT INTO sales_plan_cells (row_id, day, qty, source, updated_by, updated_at)
     SELECT c.row_id, (c.day + ($2::date - $1::date)), c.qty, 'copy', $3, now()
       FROM sales_plan_cells c
       JOIN sales_plan_rows r ON r.id = c.row_id AND r.active
      WHERE c.day BETWEEN $1::date AND ($1::date + 6)
     ON CONFLICT (row_id, day) DO UPDATE
       SET qty = EXCLUDED.qty, source = 'copy', updated_by = EXCLUDED.updated_by, updated_at = now()
       WHERE $4::boolean`,
    [src, dst, req.user.id, over]);
  await db.log(req.user.id, 'salesplan_copy_week', `${src} → ${dst}, клеток ${r.rowCount}${over ? ', с перезаписью' : ''}`);
  res.json({ ok: true, cells: r.rowCount });
});

// ----- Заполнить из факта -----
// Холодный старт: берём фактические отгрузки недели-образца (sd_sales) и кладём
// их в план по тем же дням недели. Пустые клетки заполняем, введённое руками не
// трогаем. Направление — по «Направлению торговли» товара из SD.
router.post('/api/fill-fact', requireEdit, express.json(), async (req, res) => {
  let src, dst;
  try { dst = core.weekStart(String(req.body.to)); src = core.weekStart(String(req.body.from || core.weekShift(dst, -1))); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let fact;
  try {
    fact = (await db.pool.query(
      `SELECT to_char(s.day,'YYYY-MM-DD') AS day, g.id AS product_id, COALESCE(c.name,'') AS category,
              COALESCE(g.trade_direction,'') AS trade, g.name, SUM(s.qty - s.returned) AS qty
         FROM sd_sales s JOIN ref_finished_goods g ON g.sd_sd_id = s.product_sd
         LEFT JOIN ref_categories c ON c.id = g.category_id
        WHERE s.day BETWEEN $1::date AND ($1::date + 6)
        GROUP BY 1,2,3,4,5 HAVING SUM(s.qty - s.returned) > 0`, [src])).rows;
  } catch (e) { return res.status(400).json({ error: 'Продажи из SalesDoctor ещё не выгружены — заполнять нечем' }); }
  if (!fact.length) return res.json({ ok: true, cells: 0, rows: 0, skipped: [], skipped_total: 0, note: 'За неделю-образец продаж в базе нет' });

  const chans = await channels();
  const shift = (Date.parse(dst) - Date.parse(src)) / 86400000;
  const rowCache = new Map();
  let cells = 0;
  const skipped = new Set();
  for (const f of fact) {
    const ch = core.channelOf([f.category, f.trade], chans);
    if (!ch) { skipped.add(f.name); continue; }
    const key = ch + '|' + f.product_id;
    if (!rowCache.has(key)) rowCache.set(key, await rowFor(ch, f.product_id, req.user.id));
    const day = new Date(Date.parse(f.day) + shift * 86400000).toISOString().slice(0, 10);
    const r = await db.pool.query(
      `INSERT INTO sales_plan_cells (row_id, day, qty, source, updated_by, updated_at)
       VALUES ($1,$2,$3,'fact',$4,now()) ON CONFLICT (row_id, day) DO NOTHING`,
      [rowCache.get(key), day, Math.max(0, Math.round(Number(f.qty))), req.user.id]);
    cells += r.rowCount;
  }
  await db.log(req.user.id, 'salesplan_fill_fact', `${src} → ${dst}: клеток ${cells}, строк ${rowCache.size}`);
  res.json({ ok: true, cells, rows: rowCache.size, skipped: [...skipped].slice(0, 12), skipped_total: skipped.size, from: src });
});

// ----- Выгрузка -----
// Итоги считаем сами. В рабочем файле Шоха итог розницы охватывал не все
// строки и занижал неделю на 4 280 штук — повторять это нельзя.
router.get('/api/export.xlsx', async (req, res) => {
  let days;
  try { days = daysOf(req.query); } catch (e) { return res.status(400).send(e.message); }
  // Берём ровно то, что показано на экране: одна сборка сетки на оба ответа.
  const inner = await buildPlan(days, req.user);

  const head = ['Направление', 'Товар', 'Прайс-лист', 'Цена']
    .concat(days.map((d) => core.wdOf(d) + ' ' + d.slice(8, 10) + '.' + d.slice(5, 7)))
    .concat(['Итого, шт', 'Итого, сум', 'Примечание']);
  const aoa = [head];
  for (const ch of inner.channels) {
    for (const r of ch.rows) {
      aoa.push([ch.name, r.product_name, r.price_type_name || 'не выбран', r.price]
        .concat(days.map((d) => (r.cells[d] === undefined ? null : r.cells[d])))
        .concat([r.total, r.money === null ? null : Math.round(r.money), r.note || '']));
    }
    const s = ch.totals;
    aoa.push(['Итого ' + ch.name, '', '', ''].concat(days.map((d) => s.byDay[d].qty))
      .concat([s.qty, s.money === null ? null : Math.round(s.money), '']));
    aoa.push([]);
  }
  const t = inner.totals;
  aoa.push(['ВСЕГО', '', '', ''].concat(days.map((d) => t.byDay[d].qty))
    .concat([t.qty, t.money === null ? null : Math.round(t.money), '']));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, { wch: 34 }, { wch: 20 }, { wch: 10 }]
    .concat(days.map(() => ({ wch: 8 }))).concat([{ wch: 11 }, { wch: 14 }, { wch: 18 }]);
  XLSX.utils.book_append_sheet(wb, ws, 'План ' + days[0]);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="plan-${days[0]}_${days[days.length - 1]}.xlsx"`);
  res.send(buf);
});

module.exports = router;
module.exports.canEditPlan = canEditPlan;
