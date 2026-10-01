// salesplan.js — плитка «План продаж» (ГП): недельная сетка спроса по готовой продукции.
//
// Что это: отдел продаж задаёт план в штуках по дням, направлениям (HoReCa,
// Розница) и прайс-листам SalesDoctor. Производство и закуп потом читают эту
// же цифру, а не свои таблицы.
//
// Чего здесь НЕТ и не будет без отдельного решения Шоха: согласований по
// цепочке, обязательных статусов, автоматических заявок поставщику, проводок
// склада и записи в SalesDoctor. План — это запись намерения, не команда.
//
// Источники правды не дублируются: товар — ref_finished_goods (идентичность из
// SD), цена — ref_prices по выбранному прайсу, факт — sd_sales. Своих формул
// денег в плитке нет.
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

// Править план может админ или тот, кому назначена плитка (как в Претензиях).
async function requireEdit(req, res, next) {
  if (!req.user) return res.status(403).json({ error: 'Не авторизовано' });
  if (req.user.isAdmin) return next();
  try {
    const r = await db.pool.query(
      `SELECT 1 FROM tiles t
       JOIN role_tiles rt ON rt.tile_id = t.id
       JOIN user_roles ur ON ur.role_id = rt.role_id
       WHERE ur.user_id = $1 AND t.url = '/salesplan' LIMIT 1`,
      [req.user.id]
    );
    if (r.rows.length) return next();
  } catch (e) { /* на проверке доступа не падаем */ }
  return res.status(403).json({ error: 'Менять план может администратор или тот, кому назначена плитка «План продаж»' });
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Строка сетки для «направление + товар + прайс» — одна на всю систему.
// Нарочно без ON CONFLICT по выражению: уникальность у нас задана индексом по
// COALESCE(price_type_id, 0), и опираться на то, как Postgres выведет такой
// индекс, не хочется — слишком тихая поломка. Делаем явно: нашли → вернули,
// не нашли → вставили, кто-то вставил одновременно (23505) → нашли ещё раз.
// Выключенная ранее строка возвращается в сетку, а не плодит вторую.
async function ensureRow(ch, productId, priceTypeId, userId) {
  const find = () => db.pool.query(
    `SELECT id, active FROM sales_plan_rows
      WHERE channel = $1 AND product_id = $2 AND COALESCE(price_type_id, 0) = COALESCE($3, 0) LIMIT 1`,
    [ch, productId, priceTypeId]);
  const wake = async (row) => {
    if (!row.active) {
      await db.pool.query('UPDATE sales_plan_rows SET active = TRUE, updated_by = $1, updated_at = now() WHERE id = $2',
        [userId, row.id]);
    }
    return { id: row.id, created: false, woken: !row.active };
  };
  const found = await find();
  if (found.rowCount) return wake(found.rows[0]);
  try {
    const ins = await db.pool.query(
      `INSERT INTO sales_plan_rows (channel, product_id, price_type_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$4) RETURNING id`, [ch, productId, priceTypeId, userId]);
    return { id: ins.rows[0].id, created: true, woken: false };
  } catch (e) {
    if (e.code !== '23505') throw e;            // не про уникальность — это настоящая ошибка
    const again = await find();
    if (!again.rowCount) throw e;
    return wake(again.rows[0]);
  }
}

// ----- Страница -----
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('salesplan', { settings, user: req.user });
});

// ----- Справочники для экрана -----
router.get('/api/meta', async (req, res) => {
  const channels = (await db.pool.query(
    'SELECT code, name, sd_trade, sort_order FROM sales_plan_channels WHERE active ORDER BY sort_order, code')).rows;
  const priceTypes = (await db.pool.query(
    "SELECT id, name FROM ref_price_types WHERE COALESCE(status,'active') <> 'archived' ORDER BY name")).rows
    .map((r) => ({ id: r.id, name: r.name }));
  const products = (await db.pool.query(
    `SELECT id, name, COALESCE(trade_direction,'') AS trade_direction, COALESCE(sd_sd_id,'') AS sd_sd_id
       FROM ref_finished_goods WHERE COALESCE(status,'active') <> 'archived' ORDER BY name`)).rows;
  res.json({ channels, priceTypes, products });
});

// Прайсы, в которых у товара есть цена (и те, где её нет — помечены).
router.get('/api/prices/:productId(\\d+)', async (req, res) => {
  const pid = parseInt(req.params.productId, 10);
  const r = await db.pool.query(
    `SELECT pt.id, pt.name, p.price, p.last_sync_at
       FROM ref_price_types pt
       LEFT JOIN ref_prices p ON p.price_type_id = pt.id AND p.product_id = $1
      WHERE COALESCE(pt.status,'active') <> 'archived'
      ORDER BY (p.price IS NULL), pt.name`, [pid]);
  res.json({ items: r.rows.map((x) => ({ id: x.id, name: x.name, price: num(x.price), synced_at: x.last_sync_at })) });
});

// ----- Сетка плана -----
// Период задаётся днями: неделя — это 7 дней, месяц и квартал — те же дни,
// просто больше. Отдельной «месячной цифры» не существует (решение Шоха).
router.get('/api/plan', async (req, res) => {
  let days;
  try {
    days = req.query.to
      ? core.daysBetween(String(req.query.from), String(req.query.to))
      : core.weekDays(String(req.query.from || new Date().toISOString().slice(0, 10))).map((d) => d.day);
  } catch (e) { return res.status(400).json({ error: e.message }); }
  // Горизонт ограничен не из вредности: 90 дней — это квартал, дальше сетка
  // перестаёт читаться, а запрос начинает тащить лишнее.
  if (days.length > 92) return res.status(400).json({ error: 'Период больше квартала — выберите отрезок короче' });
  const from = days[0], to = days[days.length - 1];

  const rows = (await db.pool.query(
    `SELECT r.id, r.channel, r.product_id, r.price_type_id, r.sort_order, r.note,
            g.name AS product_name, COALESCE(g.trade_direction,'') AS trade_direction,
            COALESCE(g.sd_sd_id,'') AS sd_sd_id,
            pt.name AS price_type_name, p.price, p.last_sync_at AS price_synced_at
       FROM sales_plan_rows r
       JOIN ref_finished_goods g ON g.id = r.product_id
       LEFT JOIN ref_price_types pt ON pt.id = r.price_type_id
       LEFT JOIN ref_prices p ON p.price_type_id = r.price_type_id AND p.product_id = r.product_id
      WHERE r.active
      ORDER BY r.channel, r.sort_order, g.name`)).rows;

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
  const factPrice = {};
  try {
    const f = (await db.pool.query(
      `SELECT product_sd, SUM(amount - returned) AS amount, SUM(qty) AS qty
         FROM sd_sales WHERE day >= ($1::date - 28) AND day < $1::date
         GROUP BY product_sd HAVING SUM(qty) > 0`, [from])).rows;
    for (const x of f) factPrice[x.product_sd] = Number(x.amount) / Number(x.qty);
  } catch (e) { /* продажи SD ещё не выгружены — подсказки просто не будет */ }

  const out = [];
  const chMeta = (await db.pool.query(
    'SELECT code, name, sort_order FROM sales_plan_channels WHERE active ORDER BY sort_order, code')).rows;
  for (const ch of chMeta) {
    const list = rows.filter((r) => r.channel === ch.code).map((r) => {
      const o = byRow.get(r.id) || { cells: {}, src: {} };
      const t = core.rowTotal(o.cells, days);
      const price = num(r.price);
      return {
        id: r.id, product_id: r.product_id, product_name: r.product_name,
        price_type_id: r.price_type_id, price_type_name: r.price_type_name || null,
        price, price_synced_at: r.price_synced_at,
        fact_price: r.sd_sd_id && factPrice[r.sd_sd_id] != null ? Math.round(factPrice[r.sd_sd_id]) : null,
        note: r.note || '', cells: o.cells, src: o.src,
        total: t.qty, money: t.qty !== null && price !== null ? t.qty * price : null,
      };
    });
    out.push({ code: ch.code, name: ch.name, rows: list, totals: core.summarize(list, days) });
  }

  res.json({
    from, to, days: days.map((d) => ({ day: d, wd: core.wdOf(d) })),
    week_label: core.weekLabel(from), channels: out,
    totals: core.summarize(out.flatMap((c) => c.rows), days),
  });
});

// ----- Одна клетка -----
// qty: число — записываем; null/'' — удаляем запись (клетка «не заполнена»).
// Ноль записывается как ноль: это решение «ничего не планируем», а не пустота.
router.post('/api/cell', requireEdit, express.json(), async (req, res) => {
  const rowId = parseInt(req.body.row_id, 10);
  const day = String(req.body.day || '');
  if (!rowId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Нужны строка и дата' });
  let qty;
  try { qty = core.parseQty(req.body.qty); } catch (e) { return res.status(400).json({ error: e.message }); }
  const own = await db.pool.query('SELECT id FROM sales_plan_rows WHERE id = $1', [rowId]);
  if (!own.rowCount) return res.status(404).json({ error: 'Строка плана не найдена' });
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
  res.json({ ok: true, qty });
});

// ----- Разложить неделю по дням -----
// Чтобы планировать на месяц и дальше, продажник вводит одно число на неделю,
// а система раскладывает его по дням в пропорции фактических продаж: у
// ресторанов пятница крупная, понедельник мелкий. Нет факта — раскладываем
// ровно и прямо об этом говорим: равномерность не выдаётся за профиль спроса.
router.post('/api/spread', requireEdit, express.json(), async (req, res) => {
  const rowId = parseInt(req.body.row_id, 10);
  let week, total;
  try { week = core.weekStart(String(req.body.week)); total = core.parseQty(req.body.total); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (total === null) return res.status(400).json({ error: 'Укажите количество на неделю' });

  const r = await db.pool.query(
    `SELECT r.id, COALESCE(g.sd_sd_id,'') AS sd FROM sales_plan_rows r
       JOIN ref_finished_goods g ON g.id = r.product_id WHERE r.id = $1`, [rowId]);
  if (!r.rowCount) return res.status(404).json({ error: 'Строка плана не найдена' });

  let profile = null, basis = 'even';
  if (r.rows[0].sd) {
    try {
      const f = (await db.pool.query(
        `SELECT to_char(day,'YYYY-MM-DD') AS day, SUM(qty - returned) AS qty
           FROM sd_sales WHERE product_sd = $1 AND day >= ($2::date - 56) AND day < $2::date
           GROUP BY 1`, [r.rows[0].sd, week])).rows;
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
  res.json({ ok: true, basis, days: out });
});

// ----- Строки сетки -----
// Добавление пачкой: направление подставляется из «Направления торговли» SD,
// если оно совпало с нашим; не совпало — берём то, куда человек добавляет.
router.post('/api/rows', requireEdit, express.json(), async (req, res) => {
  const channel = String(req.body.channel || '').trim();
  const ids = (Array.isArray(req.body.product_ids) ? req.body.product_ids : [])
    .map((x) => parseInt(x, 10)).filter(Boolean);
  const priceTypeId = req.body.price_type_id ? parseInt(req.body.price_type_id, 10) : null;
  if (!channel || !ids.length) return res.status(400).json({ error: 'Выберите направление и товары' });
  const ch = await db.pool.query('SELECT code FROM sales_plan_channels WHERE code = $1 AND active', [channel]);
  if (!ch.rowCount) return res.status(400).json({ error: 'Такого направления нет' });

  // Товары должны существовать в справочнике: строка плана не заводится по
  // присланному номеру «на веру».
  const okIds = (await db.pool.query(
    'SELECT id FROM ref_finished_goods WHERE id = ANY($1::int[])', [ids])).rows.map((r) => r.id);
  if (!okIds.length) return res.status(400).json({ error: 'Таких товаров в справочнике нет' });
  if (priceTypeId) {
    const ok = await db.pool.query('SELECT 1 FROM ref_price_types WHERE id = $1', [priceTypeId]);
    if (!ok.rowCount) return res.status(400).json({ error: 'Такого прайс-листа нет' });
  }

  let added = 0, exists = 0;
  for (const pid of okIds) {
    const r = await ensureRow(channel, pid, priceTypeId, req.user.id);
    if (r.created || r.woken) added++; else exists++;
  }
  await db.log(req.user.id, 'salesplan_rows_add', `${channel}: +${added}, уже были ${exists}`);
  res.json({ ok: true, added, exists, skipped: ids.length - okIds.length });
});

router.post('/api/row/:id(\\d+)', requireEdit, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sets = [], params = [];
  if ('price_type_id' in req.body) {
    const v = req.body.price_type_id ? parseInt(req.body.price_type_id, 10) : null;
    if (v) {
      const ok = await db.pool.query('SELECT 1 FROM ref_price_types WHERE id = $1', [v]);
      if (!ok.rowCount) return res.status(400).json({ error: 'Такого прайс-листа нет' });
    }
    params.push(v); sets.push('price_type_id = $' + params.length);
  }
  if ('note' in req.body) { params.push(String(req.body.note || '').slice(0, 300)); sets.push('note = $' + params.length); }
  if ('sort_order' in req.body) { params.push(parseInt(req.body.sort_order, 10) || 100); sets.push('sort_order = $' + params.length); }
  if (!sets.length) return res.status(400).json({ error: 'Нечего менять' });
  params.push(req.user.id); sets.push('updated_by = $' + params.length);
  params.push(id);
  const r = await db.pool.query(
    `UPDATE sales_plan_rows SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  if (!r.rowCount) return res.status(404).json({ error: 'Строка не найдена' });
  res.json({ ok: true });
});

// Убрать строку из сетки. Цифры плана не выбрасываем: строка выключается,
// история дней остаётся. Вернуть товар в сетку — тот же «Добавить товары».
router.post('/api/row/:id(\\d+)/delete', requireEdit, async (req, res) => {
  const r = await db.pool.query(
    'UPDATE sales_plan_rows SET active = FALSE, updated_by = $1, updated_at = now() WHERE id = $2', [req.user.id, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Строка не найдена' });
  await db.log(req.user.id, 'salesplan_row_hide', `строка ${req.params.id}`);
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
// Холодный старт и профиль дня недели: берём фактические отгрузки недели-образца
// (sd_sales) и кладём их в план по тем же дням недели. Пустые клетки заполняем,
// введённое руками не трогаем. Направление определяем по «Направлению торговли»
// товара из SD; не определилось — честно говорим, сколько товаров пропустили.
router.post('/api/fill-fact', requireEdit, express.json(), async (req, res) => {
  let src, dst;
  try { dst = core.weekStart(String(req.body.to)); src = core.weekStart(String(req.body.from || core.weekShift(dst, -1))); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let fact;
  try {
    fact = (await db.pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, product_sd, SUM(qty - returned) AS qty
         FROM sd_sales WHERE day BETWEEN $1::date AND ($1::date + 6)
         GROUP BY 1,2 HAVING SUM(qty - returned) > 0`, [src])).rows;
  } catch (e) { return res.status(400).json({ error: 'Продажи из SalesDoctor ещё не выгружены — заполнять нечем' }); }
  if (!fact.length) return res.json({ ok: true, cells: 0, rows: 0, skipped: [], note: 'За неделю-образец продаж в базе нет' });

  const goods = (await db.pool.query(
    `SELECT id, name, COALESCE(sd_sd_id,'') AS sd, COALESCE(trade_direction,'') AS trade
       FROM ref_finished_goods WHERE COALESCE(sd_sd_id,'') <> ''`)).rows;
  const bySd = new Map(goods.map((g) => [g.sd, g]));
  const chans = (await db.pool.query('SELECT code, name, sd_trade FROM sales_plan_channels WHERE active')).rows;
  const chanOf = (trade) => {
    const t = String(trade || '').trim().toLowerCase();
    if (!t) return null;
    const c = chans.find((x) => String(x.sd_trade || '').toLowerCase() === t || String(x.name).toLowerCase() === t);
    return c ? c.code : null;
  };

  // Если товар уже есть в сетке с выбранным прайсом — пишем в ту же строку,
  // а не создаём вторую без прайса: иначе один товар задвоится в итогах.
  const rowCache = new Map();
  async function rowFor(channel, productId) {
    const key = channel + '|' + productId;
    if (rowCache.has(key)) return rowCache.get(key);
    const ex = await db.pool.query(
      `SELECT id, active FROM sales_plan_rows WHERE channel = $1 AND product_id = $2
        ORDER BY (price_type_id IS NULL), id LIMIT 1`, [channel, productId]);
    let id;
    if (ex.rowCount) {
      id = ex.rows[0].id;
      if (!ex.rows[0].active) {
        await db.pool.query('UPDATE sales_plan_rows SET active = TRUE, updated_by = $1, updated_at = now() WHERE id = $2',
          [req.user.id, id]);
      }
    } else {
      id = (await ensureRow(channel, productId, null, req.user.id)).id;
    }
    rowCache.set(key, id);
    return id;
  }

  const shift = (Date.parse(dst) - Date.parse(src)) / 86400000;
  let cells = 0;
  const skipped = new Set();
  for (const f of fact) {
    const g = bySd.get(String(f.product_sd));
    if (!g) { skipped.add('нет в справочнике: ' + f.product_sd); continue; }
    const ch = chanOf(g.trade);
    if (!ch) { skipped.add(g.name); continue; }
    const rowId = await rowFor(ch, g.id);
    const day = new Date(Date.parse(f.day) + shift * 86400000).toISOString().slice(0, 10);
    const qty = Math.max(0, Math.round(Number(f.qty)));
    const r = await db.pool.query(
      `INSERT INTO sales_plan_cells (row_id, day, qty, source, updated_by, updated_at)
       VALUES ($1,$2,$3,'fact',$4,now())
       ON CONFLICT (row_id, day) DO NOTHING`, [rowId, day, qty, req.user.id]);
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
  try {
    days = req.query.to ? core.daysBetween(String(req.query.from), String(req.query.to))
      : core.weekDays(String(req.query.from || new Date().toISOString().slice(0, 10))).map((d) => d.day);
  } catch (e) { return res.status(400).send(e.message); }
  if (days.length > 92) return res.status(400).send('Период больше квартала — выберите отрезок короче');
  const from = days[0], to = days[days.length - 1];

  const rows = (await db.pool.query(
    `SELECT r.id, r.channel, r.note, g.name AS product_name, pt.name AS price_type_name, p.price,
            ch.name AS channel_name, ch.sort_order AS ch_sort, r.sort_order
       FROM sales_plan_rows r
       JOIN ref_finished_goods g ON g.id = r.product_id
       JOIN sales_plan_channels ch ON ch.code = r.channel
       LEFT JOIN ref_price_types pt ON pt.id = r.price_type_id
       LEFT JOIN ref_prices p ON p.price_type_id = r.price_type_id AND p.product_id = r.product_id
      WHERE r.active ORDER BY ch.sort_order, r.sort_order, g.name`)).rows;
  const cells = (await db.pool.query(
    `SELECT row_id, to_char(day,'YYYY-MM-DD') AS day, qty FROM sales_plan_cells WHERE day BETWEEN $1 AND $2`,
    [from, to])).rows;
  const byRow = new Map();
  for (const c of cells) {
    if (!byRow.has(c.row_id)) byRow.set(c.row_id, {});
    byRow.get(c.row_id)[c.day] = Number(c.qty);
  }

  const head = ['Направление', 'Товар', 'Прайс-лист', 'Цена']
    .concat(days.map((d) => core.wdOf(d) + ' ' + d.slice(8, 10) + '.' + d.slice(5, 7)))
    .concat(['Итого, шт', 'Итого, сум', 'Примечание']);
  const aoa = [head];
  let curCh = null, chRows = [];
  const pushChannelTotal = () => {
    if (!curCh || !chRows.length) return;
    const s = core.summarize(chRows, days);
    aoa.push(['Итого ' + curCh, '', '', ''].concat(days.map((d) => s.byDay[d].qty))
      .concat([s.qty, s.money === null ? null : Math.round(s.money), '']));
    aoa.push([]);
  };
  const all = [];
  for (const r of rows) {
    if (curCh !== r.channel_name) { pushChannelTotal(); curCh = r.channel_name; chRows = []; }
    const c = byRow.get(r.id) || {};
    const t = core.rowTotal(c, days);
    const price = num(r.price);
    const item = { cells: c, price };
    chRows.push(item); all.push(item);
    aoa.push([r.channel_name, r.product_name, r.price_type_name || 'не выбран', price]
      .concat(days.map((d) => (c[d] === undefined ? null : c[d])))
      .concat([t.qty, t.qty !== null && price !== null ? t.qty * price : null, r.note || '']));
  }
  pushChannelTotal();
  const total = core.summarize(all, days);
  aoa.push(['ВСЕГО', '', '', ''].concat(days.map((d) => total.byDay[d].qty))
    .concat([total.qty, total.money === null ? null : Math.round(total.money), '']));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, { wch: 34 }, { wch: 20 }, { wch: 10 }]
    .concat(days.map(() => ({ wch: 8 }))).concat([{ wch: 11 }, { wch: 14 }, { wch: 18 }]);
  XLSX.utils.book_append_sheet(wb, ws, 'План ' + from);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="plan-${from}_${to}.xlsx"`);
  res.send(buf);
});

module.exports = router;
