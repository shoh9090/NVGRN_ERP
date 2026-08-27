// calculation.js — плитка «Калькуляция себестоимости».
//
// ПЕРЕСБОРКА ПО ЭТАПАМ. Собираем по образцу рабочего Excel Шоха
// (00calc_NVGRN11.xlsx): каждый лист Excel = отдельная вкладка модуля.
// Готово: «Производство» (выпуск и затраты), «Упаковка» (комплекты),
// товарные листы (Рознич. тара, Хорека 250/500, Салаты, Пучки и горшки).
// Отдельного листа под цены на сырьё нет: цена зелени приходит из Закупа.
//
// Три колонки, как в Excel:
//   • «текущее в кальк. расчётах» — то, что реально участвует в себестоимости (ручной ввод);
//   • «фактич» — подтягивается: расходы из Кассы за месяц по связанной статье ДДС;
//   • «план» — ручной ввод.
//
// Ответственность файла: маршруты, права, сбор ответа.
// Формулы — только в calculation-engine.js, чтение источников — в calculation-sources.js.
const express = require('express');
const db = require('./db');
const engine = require('./calculation-engine');
const integrations = require('./integrations');

const router = express.Router();
const J = express.json({ limit: '1mb' });

const asNum = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const numOrNull = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : parseInt(v, 10) || null);
const curPeriod = () => new Date().toISOString().slice(0, 7);

// Право менять цифры: администратор или роль «Финансы/Бухгалтерия».
const canEdit = (req) => !!(req.user && (req.user.isAdmin || req.user.isFinance));
const denyEdit = (res) => res.status(403).json({ error: 'Менять калькуляцию может финансовый сотрудник или администратор' });

// Настройки лежат в calc_settings — таблица с июля, там уже есть выпуск.
const K_OUTPUT = 'monthly_units';        // среднемесячное производство, шт (колонка «текущее»)
const K_OUTPUT_PLAN = 'monthly_units_plan'; // план продаж, шт (появится позже)
// Факт производства из SalesDoctor: тянем по кнопке и запоминаем, чтобы не
// дёргать внешний сервис при каждом открытии экрана.
const K_FACT_UNITS = 'output_fact_units';
const K_FACT_NOTE = 'output_fact_note';
const K_FACT_AT = 'output_fact_at';

async function calcSettings() {
  const r = await db.pool.query('SELECT key, value FROM calc_settings');
  const out = {};
  r.rows.forEach((x) => { out[x.key] = x.value; });
  return out;
}
async function setCalcSetting(key, value, userId) {
  await db.pool.query(
    `INSERT INTO calc_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
    [key, String(value), userId || null]);
}

// Два блока листа «Производство» — ровно как в Excel.
const BLOCKS = [
  {
    key: 'production',
    title: 'Производственные затраты',
    total_label: 'Среднемесячные прочие производ. затраты',
  },
  {
    key: 'overhead',
    title: 'Накладные расходы',
    total_label: 'Среднемесячные прочие накладные затраты',
  },
];

// Сбой миграции НЕ должен ронять всю плитку: раньше любая ошибка в схеме
// давала «Internal Server Error» на весь /calculation, включая листы, которые
// с этой таблицей никак не связаны. Пишем ошибку в лог и работаем дальше —
// не хватит какой-то таблицы, отвалится только её экран, а не всё сразу.
router.use(async (req, res, next) => {
  try { await require('./calculation-schema').ensureCalculationSchema(db.pool); }
  catch (e) { console.error('[КАЛЬКУЛЯЦИЯ] схема:', e.message); }
  next();
});

router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('calculation', { settings, user: req.user });
});

// ===========================================================================
// Лист «Производство»
// ===========================================================================
router.get('/api/production', async (req, res) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : curPeriod();
    const settings = await calcSettings();
    const output = asNum(settings[K_OUTPUT]) || 0;
    const outputPlan = numOrNull(settings[K_OUTPUT_PLAN]);

    const rows = (await db.pool.query(
      `SELECT id, kind, name, amount, plan_amount, cash_category_id, sort
       FROM calc_cost_items WHERE status = 'active' ORDER BY kind, sort, id`)).rows;

    // Связи «статья затрат → статьи ДДС Кассы». У одной строки их может быть много.
    const linkRows = (await db.pool.query(
      `SELECT l.item_id, l.category_id, c.code, c.name
       FROM calc_cost_item_categories l
       LEFT JOIN cash_categories c ON c.id = l.category_id
       ORDER BY c.code NULLS LAST`)).rows;
    const catsByItem = new Map();
    linkRows.forEach((x) => {
      if (!catsByItem.has(x.item_id)) catsByItem.set(x.item_id, []);
      catsByItem.get(x.item_id).push({
        id: x.category_id,
        label: (x.code ? x.code + ' · ' : '') + (x.name || 'статья удалена'),
      });
    });

    // «Фактич» — сумма исходящих операций Кассы за месяц по связанным статьям.
    // Один запрос на все статьи сразу.
    const catIds = [...new Set(linkRows.map((r) => r.category_id).filter(Boolean))];
    const factByCat = new Map();
    if (catIds.length) {
      const f = await db.pool.query(
        `SELECT category_id, COALESCE(SUM(amount), 0) AS amount
         FROM cash_transactions
         WHERE tx_type = 'out' AND category_id = ANY($1)
           AND tx_date >= $2::date AND tx_date < ($2::date + INTERVAL '1 month')
         GROUP BY category_id`, [catIds, period + '-01']);
      f.rows.forEach((x) => factByCat.set(Number(x.category_id), Number(x.amount) || 0));
    }

    const blocks = BLOCKS.map((b) => {
      const items = rows.filter((r) => r.kind === b.key).map((r) => {
        const cats = catsByItem.get(r.id) || [];
        return {
          id: r.id,
          name: r.name,
          current: Number(r.amount) || 0,
          // Факт = сумма по всем связанным статьям ДДС. Нет связей — не ноль, а «не связано».
          fact: cats.length ? cats.reduce((acc, c) => acc + (factByCat.get(Number(c.id)) || 0), 0) : null,
          plan: r.plan_amount === null ? null : Number(r.plan_amount),
          categories: cats,
        };
      });
      const sum = (f) => items.reduce((acc, x) => acc + (Number(x[f]) || 0), 0);
      const anyFact = items.some((x) => x.fact !== null);
      const anyPlan = items.some((x) => x.plan !== null);
      // Честность итога «фактич»: он складывает только связанные статьи.
      // Если связаны не все — итог неполный, и это надо показать, иначе цифра
      // читается как «расходы упали», хотя часть статей просто не подключена.
      const linked = items.filter((x) => x.fact !== null).length;
      return {
        ...b,
        items,
        fact_coverage: { linked, total: items.length, full: items.length > 0 && linked === items.length },
        total: { current: sum('current'), fact: anyFact ? sum('fact') : null, plan: anyPlan ? sum('plan') : null },
        per_unit: {
          current: engine.perUnit(sum('current'), output),
          fact: anyFact ? engine.perUnit(sum('fact'), output) : null,
          plan: anyPlan ? engine.perUnit(sum('plan'), outputPlan || output) : null,
        },
      };
    });

    // Статьи ДДС Кассы — для выбора «откуда берём факт».
    // Сортируем по группе, а внутри — по ЧИСЛОВОМУ коду. Обычная сортировка по
    // тексту давала 10, 100, 101, 11, 12 и рвала группы на куски.
    const cats = (await db.pool.query(
      `SELECT id, code, name, group_name FROM cash_categories
       WHERE status = 'active'
       ORDER BY group_name NULLS LAST,
                COALESCE(NULLIF(regexp_replace(code, '[^0-9]', '', 'g'), '')::int, 999999),
                code`)).rows.map((c) => ({
      id: c.id, label: (c.code ? c.code + ' · ' : '') + c.name, group: c.group_name || '—',
    }));

    // ВАЖНО: SalesDoctor здесь НЕ опрашиваем. Он отвечает медленно (постраничная
    // выгрузка заказов), и если ждать его тут, экран не открывается вообще.
    // Факт выпуска подтягивается отдельным запросом /api/sales-fact уже после
    // того, как лист показан.
    res.json({
      period,
      output: {
        current: output,
        // Показываем ранее подтянутую цифру. Обновляется кнопкой, см. /api/sales-fact/refresh.
        fact: numOrNull(settings[K_FACT_UNITS]),
        fact_note: settings[K_FACT_NOTE] || '',
        fact_at: settings[K_FACT_AT] || '',
        plan: outputPlan,
      },
      blocks,
      cash_categories: cats,
      can_edit: canEdit(req),
      no_output_reason: output > 0 ? null : 'Укажите среднемесячное производство — на это число делятся затраты.',
    });
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] производство:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Обновление факта производства из SalesDoctor — ТОЛЬКО по кнопке.
// months = 1: прошлый календарный месяц. months = 3: среднее за три прошлых месяца.
// Внешний сервис медленный, поэтому при обычном открытии листа он не трогается.
router.post('/api/sales-fact/refresh', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const months = Number((req.body || {}).months) === 3 ? 3 : 1;
  try {
    const now = new Date();
    const periods = [];
    for (let i = 1; i <= months; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      periods.push(d.toISOString().slice(0, 7));
    }

    let units = 0, orders = 0, truncated = false;
    const parts = [];
    for (const p of periods) {
      const r = await integrations.getMonthlySalesUnits(p);
      units += r.units; orders += r.orders;
      if (r.truncated) truncated = true;
      parts.push({ period: p, units: r.units, orders: r.orders });
    }
    // Для трёх месяцев нужна СРЕДНЕМЕСЯЧНАЯ величина, а не сумма.
    const value = months === 3 ? units / 3 : units;

    const label = months === 3
      ? 'среднее за 3 месяца (' + periods.slice().reverse().join(', ') + ')'
      : 'за ' + periods[0];
    const note = 'SalesDoctor, ' + label + ' · заказов: ' + orders
      + (truncated ? ' · данные неполные: слишком много заказов' : '');

    await setCalcSetting(K_FACT_UNITS, Math.round(value), req.user.id);
    await setCalcSetting(K_FACT_NOTE, note, req.user.id);
    await setCalcSetting(K_FACT_AT, new Date().toISOString(), req.user.id);
    await db.log(req.user.id, 'calc_sales_fact_refresh', { months, units: Math.round(value), periods });

    res.json({ ok: true, units: Math.round(value), note, truncated, parts });
  } catch (e) {
    res.status(400).json({ error: 'SalesDoctor: ' + e.message });
  }
});

// Набор статей ДДС для строки затрат (может быть несколько)
router.post('/api/costs/:id(\\d+)/categories', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const ids = Array.isArray((req.body || {}).ids)
    ? [...new Set(req.body.ids.map((x) => parseInt(x, 10)).filter(Boolean))] : [];
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM calc_cost_item_categories WHERE item_id = $1', [req.params.id]);
    for (const catId of ids) {
      await client.query(
        'INSERT INTO calc_cost_item_categories (item_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.params.id, catId]);
    }
    // Старую одиночную колонку держим в согласии с набором — для совместимости.
    await client.query('UPDATE calc_cost_items SET cash_category_id = $1, updated_by = $2, updated_at = now() WHERE id = $3',
      [ids.length === 1 ? ids[0] : null, req.user.id, req.params.id]);
    await client.query('COMMIT');
    await db.log(req.user.id, 'calc_cost_categories', { id: Number(req.params.id), count: ids.length });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Среднемесячное производство: «текущее» и «план»
router.post('/api/output', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  if (b.current !== undefined) {
    const v = asNum(b.current);
    if (v < 0) return res.status(400).json({ error: 'Производство не может быть отрицательным' });
    await setCalcSetting(K_OUTPUT, v, req.user.id);
  }
  if (b.plan !== undefined) {
    const v = asNum(b.plan);
    if (v < 0) return res.status(400).json({ error: 'План не может быть отрицательным' });
    await setCalcSetting(K_OUTPUT_PLAN, v, req.user.id);
  }
  await db.log(req.user.id, 'calc_output_set', b);
  res.json({ ok: true });
});

// Добавить статью затрат
router.post('/api/costs', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  const kind = b.kind === 'overhead' ? 'overhead' : 'production';
  const name = String(b.name || '').trim() || 'Новая статья';
  try {
    const next = (await db.pool.query(
      'SELECT COALESCE(MAX(sort), 0) + 10 AS n FROM calc_cost_items WHERE kind = $1', [kind])).rows[0].n;
    const r = await db.pool.query(
      `INSERT INTO calc_cost_items (kind, name, amount, sort, updated_by, updated_at)
       VALUES ($1, $2, 0, $3, $4, now()) RETURNING id`,
      [kind, name, next, req.user.id]);
    await db.log(req.user.id, 'calc_cost_add', { id: r.rows[0].id, kind, name });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Изменить статью: название, «текущее», «план» или связь со статьёй Кассы
router.post('/api/costs/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Название статьи не может быть пустым' });
    vals.push(name); sets.push(`name = $${vals.length}`);
  }
  if (b.current !== undefined) {
    const v = asNum(b.current);
    if (v < 0) return res.status(400).json({ error: 'Сумма не может быть отрицательной' });
    vals.push(v); sets.push(`amount = $${vals.length}`);
  }
  if (b.plan !== undefined) {
    const v = numOrNull(b.plan);
    if (v !== null && v < 0) return res.status(400).json({ error: 'План не может быть отрицательным' });
    vals.push(v); sets.push(`plan_amount = $${vals.length}`);
  }
  if (b.cash_category_id !== undefined) {
    vals.push(intOrNull(b.cash_category_id)); sets.push(`cash_category_id = $${vals.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.user.id); sets.push(`updated_by = $${vals.length}`);
  sets.push('updated_at = now()');
  vals.push(req.params.id);
  try {
    await db.pool.query(`UPDATE calc_cost_items SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Убрать статью. Физически не удаляем — помечаем архивной, чтобы история осталась.
router.delete('/api/costs/:id(\\d+)', async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  try {
    await db.pool.query(
      "UPDATE calc_cost_items SET status = 'archived', updated_by = $1, updated_at = now() WHERE id = $2",
      [req.user.id, req.params.id]);
    await db.log(req.user.id, 'calc_cost_remove', { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Лист «Упаковка»
// ===========================================================================
// Комплект упаковки собирается строками: название и цена вписываются вручную.
// К номенклатуре не привязываемся намеренно: у всех цветных пакетов розницы
// цена одна, и перечислять каждый SKU отдельно смысла нет.
// Стоимость строки = цена × количество. Стоимость комплекта = сумма строк.

router.get('/api/packaging', async (req, res) => {
  try {
    const tpls = (await db.pool.query(
      `SELECT id, name, sort FROM calc_pack_templates WHERE status = 'active' ORDER BY sort, name`)).rows;
    const lines = tpls.length ? (await db.pool.query(
      `SELECT i.id, i.template_id, i.item_id, i.qty, i.sort, i.price,
              COALESCE(NULLIF(i.name, ''), m.name, 'Без названия') AS name
       FROM calc_pack_template_items i
       LEFT JOIN ref_packaging m ON m.id = i.item_id
       WHERE i.template_id = ANY($1) ORDER BY i.template_id, i.sort, i.id`,
      [tpls.map((t) => t.id)])).rows : [];

    const templates = tpls.map((t) => {
      const items = lines.filter((l) => l.template_id === t.id).map((l) => {
        const price = numOrNull(l.price);
        const qty = Number(l.qty) || 0;
        return {
          id: l.id, name: l.name, qty, price,
          line_cost: price === null ? null : price * qty,
        };
      });
      const known = items.filter((x) => x.line_cost !== null);
      return {
        id: t.id, name: t.name, items,
        total: known.reduce((sum, x) => sum + x.line_cost, 0),
        missing_prices: items.length - known.length,
      };
    });

    res.json({ templates, can_edit: canEdit(req) });
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] упаковка:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Комплект: создать / переименовать / убрать
router.post('/api/packaging/template', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const name = String((req.body || {}).name || '').trim() || 'Новый комплект';
  try {
    const next = (await db.pool.query('SELECT COALESCE(MAX(sort),0)+10 AS n FROM calc_pack_templates')).rows[0].n;
    const r = await db.pool.query(
      'INSERT INTO calc_pack_templates (name, sort) VALUES ($1, $2) RETURNING id', [name, next]);
    await db.log(req.user.id, 'calc_pack_template_add', { id: r.rows[0].id, name });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/packaging/template/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Название комплекта не может быть пустым' });
  try {
    await db.pool.query('UPDATE calc_pack_templates SET name = $1 WHERE id = $2', [name, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/api/packaging/template/:id(\\d+)', async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  try {
    // Занятый комплект не убираем: иначе у товара тихо пропала бы упаковка,
    // и себестоимость молча уехала бы вниз. То же правило, что у рецептур.
    const used = (await db.pool.query(
      "SELECT COUNT(*)::int AS n FROM calc_sheet_products WHERE pack_template_id = $1 AND status = 'active'",
      [req.params.id])).rows[0].n;
    if (used > 0) return res.status(409).json({ error: 'Комплект выбран у ' + used + ' товар(ов). Сначала смените упаковку у них.' });
    await db.pool.query("UPDATE calc_pack_templates SET status='archived' WHERE id=$1", [req.params.id]);
    await db.log(req.user.id, 'calc_pack_template_remove', { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Строка комплекта: добавить, изменить, убрать
router.post('/api/packaging/template/:id(\\d+)/line', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  const name = String(b.name || '').trim() || 'Новая строка';
  try {
    const next = (await db.pool.query(
      'SELECT COALESCE(MAX(sort),0)+10 AS n FROM calc_pack_template_items WHERE template_id=$1',
      [req.params.id])).rows[0].n;
    const r = await db.pool.query(
      'INSERT INTO calc_pack_template_items (template_id, name, price, qty, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.params.id, name, numOrNull(b.price), asNum(b.qty) || 1, next]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/packaging/line/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Название строки не может быть пустым' });
    vals.push(name); sets.push(`name = $${vals.length}`);
  }
  if (b.price !== undefined) {
    const price = numOrNull(b.price);
    if (price !== null && price < 0) return res.status(400).json({ error: 'Цена не может быть отрицательной' });
    vals.push(price); sets.push(`price = $${vals.length}`);
  }
  if (b.qty !== undefined) {
    const qty = asNum(b.qty);
    if (qty < 0) return res.status(400).json({ error: 'Количество не может быть отрицательным' });
    vals.push(qty); sets.push(`qty = $${vals.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  try {
    await db.pool.query(`UPDATE calc_pack_template_items SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/api/packaging/line/:id(\\d+)', async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  try {
    await db.pool.query('DELETE FROM calc_pack_template_items WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Лист «Рецептуры» — миксы салатов
// ===========================================================================
// Устроен как «Упаковка»: карточка = рецептура, строки = сырьё в граммах на одну
// упаковку. Отличие одно: цену за кг руками не вводят — она приходит из Закупа
// (последняя принятая приёмка), тот же источник, что и на товарных листах.
// Технологических потерь здесь нет намеренно: они уже сидят в строке «с/с с
// браком» на товарном листе, и держать их в двух местах — путь к двойному счёту.

// Собрать рецептуры с ценами и итогами. Используется и листом «Рецептуры»,
// и товарными листами (там нужен только итог).
async function recipesData() {
  const recipes = (await db.pool.query(
    `SELECT id, name, sort FROM calc_mix_recipes WHERE status = 'active' ORDER BY sort, name`)).rows;
  const lines = recipes.length ? (await db.pool.query(
    `SELECT i.id, i.recipe_id, i.raw_material_id, i.qty_g, i.sort, m.name AS raw_material_name
       FROM calc_mix_items i
       LEFT JOIN ref_raw_materials m ON m.id = i.raw_material_id
      WHERE i.recipe_id = ANY($1) ORDER BY i.recipe_id, i.sort, i.id`,
    [recipes.map((r) => r.id)])).rows : [];
  const prices = await lastRawPrices();
  const manual = await manualRawPrices();

  return recipes.map((r) => {
    const items = lines.filter((l) => l.recipe_id === r.id).map((l) => {
      const info = rawPriceOf(l.raw_material_id, prices, manual);
      const price = info.price;
      const qty = Number(l.qty_g) || 0;
      return {
        id: l.id,
        raw_material_id: l.raw_material_id,
        raw_material_name: l.raw_material_name || '',
        qty_g: qty,
        price_per_kg: price,
        price_at: info.at,
        price_source: info.source,
        // Цены нет в Закупе — строка не превращается в ноль, иначе микс
        // выглядел бы дешевле, чем он есть.
        line_cost: price === null ? null : (qty / 1000) * price,
      };
    });
    const totalG = items.reduce((s, x) => s + x.qty_g, 0);
    const known = items.filter((x) => x.line_cost !== null);
    return {
      id: r.id,
      name: r.name,
      // Доля компонента в миксе: граммы вводит человек, процент считаем сами.
      items: items.map((x) => ({ ...x, pct: totalG > 0 ? (x.qty_g / totalG) * 100 : null })),
      total_g: totalG,
      total: known.reduce((s, x) => s + x.line_cost, 0),
      missing_prices: items.length - known.length,
    };
  });
}

router.get('/api/recipes', async (req, res) => {
  try {
    const rawMats = (await db.pool.query(
      "SELECT id, name FROM ref_raw_materials WHERE status = 'active' ORDER BY name")).rows;
    res.json({ recipes: await recipesData(), raw_materials: rawMats, can_edit: canEdit(req) });
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] рецептуры:', e.message);
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/recipes/recipe', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const name = String((req.body || {}).name || '').trim() || 'Новая рецептура';
  try {
    const next = (await db.pool.query('SELECT COALESCE(MAX(sort),0)+10 AS n FROM calc_mix_recipes')).rows[0].n;
    const r = await db.pool.query('INSERT INTO calc_mix_recipes (name, sort) VALUES ($1,$2) RETURNING id', [name, next]);
    await db.log(req.user.id, 'calc_recipe_add', { id: r.rows[0].id, name });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/recipes/recipe/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Название рецептуры не может быть пустым' });
  try {
    await db.pool.query('UPDATE calc_mix_recipes SET name = $1, updated_by = $2, updated_at = now() WHERE id = $3',
      [name, req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/api/recipes/recipe/:id(\\d+)', async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  try {
    // Занятую рецептуру не убираем: иначе у товара тихо пропала бы вся зелень.
    const used = (await db.pool.query(
      "SELECT COUNT(*)::int AS n FROM calc_sheet_products WHERE recipe_id = $1 AND status = 'active'",
      [req.params.id])).rows[0].n;
    if (used > 0) return res.status(409).json({ error: 'Рецептура стоит у ' + used + ' товар(ов). Сначала смените её у них.' });
    await db.pool.query("UPDATE calc_mix_recipes SET status='archived', updated_by=$1, updated_at=now() WHERE id=$2",
      [req.user.id, req.params.id]);
    await db.log(req.user.id, 'calc_recipe_remove', { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/recipes/recipe/:id(\\d+)/line', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  try {
    const next = (await db.pool.query(
      'SELECT COALESCE(MAX(sort),0)+10 AS n FROM calc_mix_items WHERE recipe_id=$1', [req.params.id])).rows[0].n;
    const r = await db.pool.query(
      'INSERT INTO calc_mix_items (recipe_id, raw_material_id, qty_g, sort) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.params.id, intOrNull((req.body || {}).raw_material_id), asNum((req.body || {}).qty_g), next]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/recipes/line/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.raw_material_id !== undefined) { vals.push(intOrNull(b.raw_material_id)); sets.push(`raw_material_id = $${vals.length}`); }
  if (b.qty_g !== undefined) {
    const qty = asNum(b.qty_g);
    if (qty < 0) return res.status(400).json({ error: 'Граммы не бывают отрицательными' });
    vals.push(qty); sets.push(`qty_g = $${vals.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  try {
    await db.pool.query(`UPDATE calc_mix_items SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/api/recipes/line/:id(\\d+)', async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  try {
    await db.pool.query('DELETE FROM calc_mix_items WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Товарные листы: Рознич. тара, Хорека 250 г, Хорека 500, Салаты, Пучки и горшки
// ===========================================================================
// В Excel это отдельные листы одинаковой структуры: строки — статьи расчёта,
// столбцы — товары. Код один на все листы, отличается только ключ листа.
//
// Что откуда берётся:
//   • Упаковка          — стоимость выбранного комплекта с листа «Упаковка»;
//   • Производ. затраты — «на штуку» с листа «Производство» × доля товара
//                          (у руколы 0,5: с одной операции выходит вдвое больше);
//   • Накладные         — «на штуку» с листа «Производство» × та же доля;
//   • Сырьё и ФОТ       — пока вручную (ФОТ позже подключим к плитке «Персонал»);
//   • брак, цены, ретро, НДС, налог — вручную.
// Все производные цифры считает calculation-engine, в базе их нет.

const SHEETS = {
  retail: 'Рознич. тара',
  horeca250: 'Хорека 250 г',
  horeca500: 'Хорека 500',
  salads: 'Салаты',
  bunches: 'Пучки и горшки',
  culinary: 'Кулинарка',
  dehkan: 'Дехкан хорека',
  cutveg: 'Резанные овощи',
};

// Какой прайс-лист SalesDoctor показывать на листе. Настройка листа,
// а не товара: в рознице все товары смотрят на один и тот же прайс.
const K_SD_PRICE_TYPE = (sheet) => 'sd_price_type_' + sheet;

// Цены из прайс-листа SalesDoctor по нашим товарам. Сопоставляем по штрих-коду:
// он есть и у нас, и в справочнике готовой продукции, который приходит из SD.
// Сами цены попадают в ref_prices при синхронизации — здесь только читаем.
async function sdPricesByBarcode(priceTypeId) {
  if (!priceTypeId) return new Map();
  const r = await db.pool.query(
    `SELECT g.barcode, p.price, p.last_sync_at
       FROM ref_prices p
       JOIN ref_finished_goods g ON g.id = p.product_id
      WHERE p.price_type_id = $1 AND COALESCE(g.barcode, '') <> ''`, [priceTypeId]);
  const m = new Map();
  r.rows.forEach((x) => m.set(String(x.barcode).trim(), {
    price: Number(x.price) || null,
    at: x.last_sync_at ? String(x.last_sync_at).slice(0, 10) : null,
  }));
  return m;
}

// Фонд оплаты труда — та же цифра, что на плитке «Персонал» → «Сотрудники»,
// плашка «ФОТ (оклады, актив.)»: сумма окладов активных сотрудников.
// Считаем тем же запросом, что и там, чтобы цифры не разошлись.
async function payrollFund() {
  const r = await db.pool.query(
    "SELECT COALESCE(SUM(base_salary), 0) AS fund, COUNT(*)::int AS people FROM hr_employees WHERE status = 'active'");
  return { fund: Number(r.rows[0].fund) || 0, people: Number(r.rows[0].people) || 0 };
}

// «На штуку» по блокам листа «Производство» — колонка «текущее», та самая,
// что участвует в себестоимости.
async function perUnitByKind() {
  const settings = await calcSettings();
  const output = asNum(settings[K_OUTPUT]) || 0;
  const r = await db.pool.query(
    `SELECT kind, COALESCE(SUM(amount), 0) AS amount FROM calc_cost_items
      WHERE status = 'active' GROUP BY kind`);
  const byKind = { production: 0, overhead: 0 };
  r.rows.forEach((x) => { byKind[x.kind] = Number(x.amount) || 0; });
  const production = engine.perUnit(byKind.production, output);
  const overhead = engine.perUnit(byKind.overhead, output);
  // ФОТ на единицу = фонд окладов / среднемесячный выпуск.
  const payroll = await payrollFund();
  return {
    output,
    production,
    overhead,
    payroll_fund: payroll.fund,
    payroll_people: payroll.people,
    labor: engine.perUnit(payroll.fund, output),
    // На товарных листах Excel производственные и накладные — ОДНА строка
    // («Производ.затраты / накладные расходы»), поэтому считаем их вместе.
    combined: output > 0 ? (Number(production) || 0) + (Number(overhead) || 0) : null,
  };
}

// Последняя принятая цена по сырью (кг) — из закупок, статус «получено».
// Тот же источник, что и на плитке «Закуп» (динамика цен): один реестр,
// своей копии цены здесь не заводим.
async function lastRawPrices() {
  const r = await db.pool.query(
    `SELECT DISTINCT ON (i.item_id) i.item_id,
            COALESCE(i.fact_price, i.price) AS price,
            to_char(COALESCE(po.received_at::date, po.delivery_date), 'DD.MM.YY') AS at
       FROM purchase_order_items i
       JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
      WHERE i.item_kind = 'raw' AND COALESCE(i.fact_price, i.price) > 0
      ORDER BY i.item_id, COALESCE(po.received_at::date, po.delivery_date) DESC`);
  const byId = new Map();
  r.rows.forEach((x) => byId.set(x.item_id, { price: Number(x.price), at: x.at }));
  return byId;
}

// Ручные цены сырья — запасной вариант там, где в Закупе цены ещё нет.
async function manualRawPrices() {
  const m = new Map();
  try {
    const r = await db.pool.query(
      "SELECT raw_material_id, price, to_char(updated_at, 'DD.MM.YY') AS at FROM calc_raw_manual_prices");
    r.rows.forEach((x) => m.set(x.raw_material_id, { price: Number(x.price), at: x.at }));
  } catch (e) { console.error('calc_raw_manual_prices read:', e.message); }
  return m;
}

// Цена сырья одним правилом для всех экранов: сначала Закуп, потом ручная.
// Ручная НЕ перебивает Закуп — иначе лист годами жил бы на выдуманной цифре,
// хотя приёмки идут и настоящая цена рядом.
function rawPriceOf(rawId, purchaseMap, manualMap) {
  const p = rawId ? purchaseMap.get(rawId) : null;
  if (p) return { price: p.price, at: p.at, source: 'purchase' };
  const m = rawId ? manualMap.get(rawId) : null;
  if (m) return { price: m.price, at: m.at, source: 'manual' };
  return { price: null, at: null, source: 'none' };
}

// Ручная цена: вписать / убрать. Правит тот же, кто правит калькуляцию.
router.post('/api/raw-price/:rawId(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const price = numOrNull((req.body || {}).price);
  if (price === null || !(price > 0)) return res.status(400).json({ error: 'Укажите цену больше нуля' });
  try {
    await db.pool.query(
      `INSERT INTO calc_raw_manual_prices (raw_material_id, price, updated_by, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (raw_material_id) DO UPDATE SET price = $2, updated_by = $3, updated_at = now()`,
      [req.params.rawId, price, req.user.id]);
    await db.log(req.user.id, 'calc_raw_price_manual', { raw_material_id: Number(req.params.rawId), price });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/api/raw-price/:rawId(\\d+)', async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  try {
    await db.pool.query('DELETE FROM calc_raw_manual_prices WHERE raw_material_id = $1', [req.params.rawId]);
    await db.log(req.user.id, 'calc_raw_price_manual_clear', { raw_material_id: Number(req.params.rawId) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Полный расчёт товарного листа. Вынесен из маршрута, потому что этот же объект
// целиком ложится в снимок при утверждении — чтобы утверждённая версия и экран
// показывали ровно одни и те же цифры.
async function sheetPayload(sheet) {
  {
    const base = await perUnitByKind();

    // Комплекты упаковки с листа «Упаковка» — вместе с их стоимостью.
    const tplRows = (await db.pool.query(
      `SELECT t.id, t.name,
              COALESCE(SUM(CASE WHEN i.price IS NULL THEN 0 ELSE i.price * i.qty END), 0) AS total,
              COUNT(i.id) FILTER (WHERE i.price IS NULL) AS missing_prices
         FROM calc_pack_templates t
         LEFT JOIN calc_pack_template_items i ON i.template_id = t.id
        WHERE t.status = 'active'
        GROUP BY t.id, t.name, t.sort
        ORDER BY t.sort, t.name`)).rows;
    const tplById = new Map(tplRows.map((t) => [t.id, t]));

    // Справочник сырья — для выпадашки «Наименование». Цена берётся из
    // Закупа (последняя принятая), а не хранится тут отдельной колонкой.
    const rawMats = (await db.pool.query(
      "SELECT id, name FROM ref_raw_materials WHERE status = 'active' ORDER BY name")).rows;
    const rawPrices = await lastRawPrices();
    const manualRaw = await manualRawPrices();
    // Рецептуры (миксы) с листа «Рецептуры»: у товара может стоять либо одно
    // сырьё с граммажом, либо рецептура. Второе сильнее.
    const recipes = await recipesData();
    const recipeById = new Map(recipes.map((r) => [r.id, r]));

    const rows = (await db.pool.query(
      `SELECT * FROM calc_sheet_products
        WHERE sheet = $1 AND status = 'active' ORDER BY sort, id`, [sheet])).rows;

    // Прайс-листы SalesDoctor и выбранный для этого листа.
    const priceTypes = (await db.pool.query(
      "SELECT id, name FROM ref_price_types WHERE COALESCE(status, 'active') <> 'archived' ORDER BY name")).rows;
    const settingsAll = await calcSettings();
    const sdTypeId = intOrNull(settingsAll[K_SD_PRICE_TYPE(sheet)]);
    const sdPrices = await sdPricesByBarcode(sdTypeId);

    const products = rows.map((p) => {
      const tpl = p.pack_template_id ? tplById.get(p.pack_template_id) : null;
      const factor = p.prod_factor === null ? 1 : Number(p.prod_factor);
      const scale = (v) => (v === null || v === undefined ? null : v * factor);

      // Зелень-сырьё считается так же, как в Excel: граммаж / 1000 × цена за кг.
      // Цена за кг берётся из Закупа по связанной позиции, а если её там ещё
      // нет — из вписанной вручную. Так лист всегда показывает цифру, и при
      // этом видно, откуда она взялась.
      const weight = numOrNull(p.net_weight_g);
      // Цена сырья: Закуп → ручная цена сырья → ручная цена в карточке товара
      // (последняя осталась от прежней схемы, у новых записей её нет).
      const rawInfo = rawPriceOf(p.raw_material_id, rawPrices, manualRaw);
      const legacyPrice = numOrNull(p.raw_price_per_kg);
      const rawPricePerKg = rawInfo.price !== null ? rawInfo.price : legacyPrice;
      const rawPriceSource = rawInfo.price !== null ? rawInfo.source
        : (legacyPrice !== null ? 'manual_product' : 'none');
      // Выбрана рецептура — зелень считается по ней (сумма компонентов микса),
      // граммаж и одиночное сырьё в расчёте не участвуют.
      const recipe = p.recipe_id ? recipeById.get(p.recipe_id) : null;
      // Ни у одного компонента нет цены — это не «ноль», а «неизвестно»:
      // иначе микс выглядел бы бесплатным и занижал себестоимость.
      const recipePriced = recipe ? recipe.items.length - recipe.missing_prices : 0;
      const rawCost = recipe
        ? (recipePriced > 0 ? recipe.total : null)
        : ((weight !== null && rawPricePerKg !== null)
          ? (weight / 1000) * rawPricePerKg
          : numOrNull(p.raw_cost));

      // Себестоимость и ставки общие, отличается только отпускная цена,
      // поэтому считаем один и тот же расчёт дважды — по каждому прайсу.
      // Ставки (ретро, НДС, налог) от прайса не зависят: они из договора.
      const inputs = {
        pack: tpl ? Number(tpl.total) : null,
        raw: rawCost,
        production: scale(base.combined),
        // ФОТ на штуку одинаков для всех товаров листа: доля производственных
        // затрат к нему не применяется — так описал Шох (ФОТ / выпуск).
        labor: base.labor,
        defect_pct: p.defect_pct,
        retro_pct: p.retro_pct,
        vat_pct: p.vat_pct,
        profit_tax_pct: p.profit_tax_pct,
        // Себестоимость = сумма ВСЕХ строк листа, включая ФОТ. В исходном файле
        // ФОТ формально стоял вне с/с, но в строке «Производ.затраты» там была
        // скопирована та же формула ФОТ — то есть труд в себестоимость входил.
        // Решение Шоха: считать сумму всех строк.
      };
      const opts = { components: engine.SKU_SHEET_COMPONENTS };
      const calc = engine.skuEconomics({ ...inputs, price: numOrNull(p.price) }, opts);
      const calc2 = engine.skuEconomics({ ...inputs, price: numOrNull(p.price2) }, opts);
      const sd = sdPrices.get(String(p.barcode || '').trim()) || null;

      const rawMat = p.raw_material_id ? rawMats.find((m) => m.id === p.raw_material_id) : null;

      return {
        id: p.id,
        name: p.name,
        barcode: p.barcode || '',
        pack_template_id: p.pack_template_id,
        pack_template_name: tpl ? tpl.name : '',
        // Комплект выбран, но в нём есть строки без цены — стоимость неполная.
        pack_incomplete: tpl ? Number(tpl.missing_prices) > 0 : false,
        prod_factor: factor,
        raw_material_id: p.raw_material_id,
        raw_material_name: rawMat ? rawMat.name : '',
        recipe_id: p.recipe_id || null,
        recipe_name: recipe ? recipe.name : '',
        recipe_total_g: recipe ? recipe.total_g : null,
        recipe_missing_prices: recipe ? recipe.missing_prices : 0,
        recipe_empty: !!(recipe && !recipe.items.length),
        net_weight_g: weight,
        raw_price_per_kg: rawPricePerKg,
        raw_price_source: rawPriceSource,
        raw_price_at: rawInfo.at,
        raw_cost: rawCost,
        labor_cost: numOrNull(p.labor_cost),
        defect_pct: Number(p.defect_pct) || 0,
        price: numOrNull(p.price),
        price2: numOrNull(p.price2),
        retro_pct: Number(p.retro_pct) || 0,
        vat_pct: Number(p.vat_pct) || 0,
        profit_tax_pct: Number(p.profit_tax_pct) || 0,
        sd_price: sd ? sd.price : null,
        sd_price_at: sd ? sd.at : null,
        calc,
        calc2,
      };
    });

    return {
      sheet,
      sheet_title: SHEETS[sheet],
      base: {
        output: base.output,
        production_overhead_per_unit: base.combined,
        production_per_unit: base.production,
        overhead_per_unit: base.overhead,
        labor_per_unit: base.labor,
        payroll_fund: base.payroll_fund,
        payroll_people: base.payroll_people,
      },
      pack_templates: tplRows.map((t) => ({
        id: t.id, name: t.name, total: Number(t.total),
        missing_prices: Number(t.missing_prices),
      })),
      recipes: recipes.map((r) => ({ id: r.id, name: r.name, total: r.total, total_g: r.total_g })),
      sd_price_types: priceTypes.map((t) => ({ id: t.id, name: t.name })),
      sd_price_type_id: sdTypeId,
      raw_materials: rawMats.map((m) => ({
        id: m.id, name: m.name, price_per_kg: rawPriceOf(m.id, rawPrices, manualRaw).price,
      })),
      products,
      no_output_reason: base.output > 0 ? null
        : 'На листе «Производство» не указан среднемесячный выпуск — затраты на штуку посчитать не из чего.',
    };
  }
}

router.get('/api/sheet/:sheet', async (req, res) => {
  const sheet = String(req.params.sheet || '');
  if (!SHEETS[sheet]) return res.status(404).json({ error: 'Такого листа нет' });
  try {
    const payload = await sheetPayload(sheet);
    payload.can_edit = canEdit(req);
    // Действующее утверждение и расхождение с текущим расчётом.
    payload.approval = await approvalState(sheet, payload);
    payload.approval_reasons = APPROVAL_REASONS;
    res.json(payload);
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] товарный лист:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ===========================================================================
// Утверждение расчёта и история
// ===========================================================================
// Утверждение — это ФОТОГРАФИЯ листа, а не пересчёт. Цены сырья остаются
// живыми (приходят из Закупа), но лист по умолчанию показывает утверждённые
// цифры: иначе себестоимость менялась бы каждый день сама по себе, и сравнить
// август с июлем было бы не с чем.
const APPROVAL_DIFF_PCT = 10; // с какого расхождения предупреждаем

// Причина утверждения. Отвечает на вопрос «зачем утверждаем сейчас» — это
// решение человека. На вопрос «что изменилось» отвечает автоподпись (describeChanges).
// Список держим в коде: причин мало, они стабильны, а править их проще правкой
// строки, чем заводить справочник с отдельным экраном управления.
const APPROVAL_REASONS = [
  { code: 'planned', label: 'Плановое утверждение' },
  { code: 'raw_price', label: 'Изменились цены на сырьё' },
  { code: 'packaging', label: 'Изменилась упаковка' },
  { code: 'factory', label: 'Изменились затраты завода' },
  { code: 'recipe', label: 'Изменили состав или граммаж' },
  { code: 'price', label: 'Пересмотр отпускных цен' },
  { code: 'fix', label: 'Исправление ошибки' },
];
const REASON_LABEL = (code) => (APPROVAL_REASONS.find((r) => r.code === code) || {}).label || '';

// Итоги листа для строки истории: средняя с/с с браком и средняя маржа по прайсу 1.
function sheetTotals(payload) {
  const items = (payload && payload.products) || [];
  const costs = items.map((x) => x.calc && x.calc.cost_defect).filter((v) => v !== null && v !== undefined);
  const margins = items.map((x) => x.calc && x.calc.net_pct).filter((v) => v !== null && v !== undefined);
  const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + Number(v), 0) / arr.length : null);
  return { avg_cost: avg(costs), avg_margin: avg(margins) };
}

// Что изменилось против прошлой версии. Считаем автоматически: человек пишет
// свой комментарий, а «кто именно поехал» система должна найти сама.
function describeChanges(prevPayload, nowPayload) {
  const prev = new Map(((prevPayload && prevPayload.products) || []).map((p) => [p.id, p]));
  const now = (nowPayload && nowPayload.products) || [];
  const added = [], gone = [], moved = [];
  for (const p of now) {
    const was = prev.get(p.id);
    if (!was) { added.push(p.name); continue; }
    const a = was.calc && was.calc.cost_defect, b = p.calc && p.calc.cost_defect;
    if (a === null || a === undefined || !(a > 0) || b === null || b === undefined) continue;
    const diff = ((b - a) / a) * 100;
    if (Math.abs(diff) >= 0.5) moved.push({ name: p.name, diff });
  }
  for (const [id, p] of prev) if (!now.some((x) => x.id === id)) gone.push(p.name);

  const parts = [];
  moved.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  const shown = moved.slice(0, 3).map((m) => m.name + ' ' + (m.diff > 0 ? '+' : '') + Math.round(m.diff) + '%');
  if (shown.length) {
    if (moved.length === now.length && now.length > 1) {
      // Поехали все — значит дело не в конкретном сырье, а в общем: затраты
      // на штуку с листа «Производство» или ФОТ.
      parts.push('все товары (' + now.length + '): ' + shown.join(', ') + (moved.length > 3 ? ' и др.' : ''));
    } else {
      parts.push(shown.join(', ') + (moved.length > 3 ? ' и ещё ' + (moved.length - 3) : ''));
      const same = now.length - moved.length - added.length;
      if (same > 0) parts.push('остальные ' + same + ' без изменений');
    }
  }
  if (added.length) parts.push('добавлен(ы): ' + added.join(', '));
  if (gone.length) parts.push('убран(ы): ' + gone.join(', '));
  if (!parts.length) return 'без изменений в цифрах';
  return parts.join(' · ');
}

async function lastApproval(sheet) {
  return (await db.pool.query(
    `SELECT id, sheet, approved_at, approved_by_name, reason, comment, avg_cost, avg_margin, changes, data
       FROM calc_sheet_approvals WHERE sheet = $1 ORDER BY approved_at DESC, id DESC LIMIT 1`,
    [sheet])).rows[0] || null;
}

// Состояние утверждения для экрана: есть ли действующая версия и насколько
// текущий расчёт от неё ушёл.
async function approvalState(sheet, nowPayload) {
  const last = await lastApproval(sheet);
  if (!last) return { has: false, diff_pct_limit: APPROVAL_DIFF_PCT };
  const now = sheetTotals(nowPayload);
  const wasCost = last.avg_cost === null ? null : Number(last.avg_cost);
  const diff = (wasCost && wasCost > 0 && now.avg_cost !== null) ? ((now.avg_cost - wasCost) / wasCost) * 100 : null;
  return {
    has: true,
    id: last.id,
    approved_at: last.approved_at,
    approved_by_name: last.approved_by_name || '',
    reason: last.reason || '',
    reason_label: REASON_LABEL(last.reason),
    comment: last.comment || '',
    avg_cost: wasCost,
    avg_margin: last.avg_margin === null ? null : Number(last.avg_margin),
    current_avg_cost: now.avg_cost,
    diff_pct: diff,
    diff_pct_limit: APPROVAL_DIFF_PCT,
    // Что изменилось прямо сейчас — тем же кодом, что и подпись в истории.
    changes: describeChanges(last.data, nowPayload),
  };
}

// Список утверждений (без тяжёлого data — он нужен только при открытии версии).
router.get('/api/sheet/:sheet/approvals', async (req, res) => {
  const sheet = String(req.params.sheet || '');
  if (!SHEETS[sheet]) return res.status(404).json({ error: 'Такого листа нет' });
  try {
    const rows = (await db.pool.query(
      `SELECT id, approved_at, approved_by_name, reason, comment, avg_cost, avg_margin, changes
         FROM calc_sheet_approvals WHERE sheet = $1 ORDER BY approved_at DESC, id DESC LIMIT 60`,
      [sheet])).rows;
    const now = await sheetPayload(sheet);
    res.json({
      sheet, sheet_title: SHEETS[sheet], can_edit: canEdit(req),
      reasons: APPROVAL_REASONS,
      items: rows.map((r) => ({
        id: r.id, approved_at: r.approved_at, approved_by_name: r.approved_by_name || '',
        reason: r.reason || '', reason_label: REASON_LABEL(r.reason),
        comment: r.comment || '', changes: r.changes || '',
        avg_cost: r.avg_cost === null ? null : Number(r.avg_cost),
        avg_margin: r.avg_margin === null ? null : Number(r.avg_margin),
      })),
      current: sheetTotals(now),
      approval: await approvalState(sheet, now),
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Открыть утверждённую версию: отдаём снимок как есть, без пересчёта.
router.get('/api/approval/:id(\\d+)', async (req, res) => {
  try {
    const r = (await db.pool.query(
      `SELECT id, sheet, approved_at, approved_by_name, reason, comment, changes, data
         FROM calc_sheet_approvals WHERE id = $1`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Утверждение не найдено' });
    res.json({
      id: r.id, sheet: r.sheet, approved_at: r.approved_at, approved_by_name: r.approved_by_name || '',
      reason: r.reason || '', reason_label: REASON_LABEL(r.reason),
      comment: r.comment || '', changes: r.changes || '',
      data: Object.assign({}, r.data, { can_edit: false }),
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/sheet/:sheet/approve', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const sheet = String(req.params.sheet || '');
  if (!SHEETS[sheet]) return res.status(404).json({ error: 'Такого листа нет' });
  try {
    const reason = String((req.body || {}).reason || '');
    if (!APPROVAL_REASONS.some((r) => r.code === reason)) {
      return res.status(400).json({ error: 'Выберите причину утверждения' });
    }
    const payload = await sheetPayload(sheet);
    if (!payload.products.length) return res.status(400).json({ error: 'На листе нет товаров — утверждать нечего' });
    const totals = sheetTotals(payload);
    const prev = await lastApproval(sheet);
    const changes = prev ? describeChanges(prev.data, payload) : 'первое утверждение листа';
    const r = await db.pool.query(
      `INSERT INTO calc_sheet_approvals
         (sheet, approved_by, approved_by_name, reason, comment, avg_cost, avg_margin, changes, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [sheet, req.user.id, req.user.name || '', reason,
        String((req.body || {}).comment || '').trim().slice(0, 300),
        totals.avg_cost, totals.avg_margin, changes, JSON.stringify(payload)]);
    await db.log(req.user.id, 'calc_sheet_approve', { sheet, id: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id, changes });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/sheet/:sheet/product', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const sheet = String(req.params.sheet || '');
  if (!SHEETS[sheet]) return res.status(404).json({ error: 'Такого листа нет' });
  const name = String((req.body || {}).name || '').trim() || 'Новый товар';
  try {
    const prev = (await db.pool.query(
      `SELECT pack_template_id, defect_pct, retro_pct, vat_pct, profit_tax_pct, sort
         FROM calc_sheet_products WHERE sheet = $1 AND status = 'active'
        ORDER BY sort DESC, id DESC LIMIT 1`, [sheet])).rows[0];
    const d = prev || { pack_template_id: null, defect_pct: 0, retro_pct: 0, vat_pct: 12, profit_tax_pct: 15, sort: 0 };
    const r = await db.pool.query(
      `INSERT INTO calc_sheet_products
         (sheet, name, pack_template_id, defect_pct, retro_pct, vat_pct, profit_tax_pct, sort, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) RETURNING id`,
      [sheet, name, d.pack_template_id, d.defect_pct, d.retro_pct, d.vat_pct, d.profit_tax_pct,
        Number(d.sort || 0) + 10, req.user.id]);
    await db.log(req.user.id, 'calc_sheet_product_add', { sheet, id: r.rows[0].id, name });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Правка одного значения товара. Список полей закрытый: что не перечислено —
// через этот маршрут не меняется.
const SKU_TEXT_FIELDS = ['name', 'barcode'];
const SKU_NUM_FIELDS = ['prod_factor', 'raw_cost', 'net_weight_g', 'raw_price_per_kg', 'labor_cost',
  'defect_pct', 'price', 'price2', 'retro_pct', 'vat_pct', 'profit_tax_pct'];

router.post('/api/sheet-product/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  const sets = [], vals = [];
  try {
    for (const f of SKU_TEXT_FIELDS) {
      if (b[f] === undefined) continue;
      const v = String(b[f]).trim();
      if (f === 'name' && !v) return res.status(400).json({ error: 'Название товара не может быть пустым' });
      vals.push(v); sets.push(`${f} = $${vals.length}`);
    }
    for (const f of SKU_NUM_FIELDS) {
      if (b[f] === undefined) continue;
      const v = numOrNull(b[f]);
      if (v !== null && v < 0) return res.status(400).json({ error: 'Отрицательное значение здесь не бывает' });
      // Доля затрат и проценты в базе NOT NULL — пустыми их оставить нельзя,
      // подставляем разумную единицу или ноль.
      let out = v;
      if (v === null) {
        if (f === 'prod_factor') out = 1;
        else if (['defect_pct', 'retro_pct', 'vat_pct', 'profit_tax_pct'].includes(f)) out = 0;
      }
      vals.push(out); sets.push(`${f} = $${vals.length}`);
    }
    if (b.pack_template_id !== undefined) {
      vals.push(intOrNull(b.pack_template_id)); sets.push(`pack_template_id = $${vals.length}`);
    }
    if (b.raw_material_id !== undefined) {
      vals.push(intOrNull(b.raw_material_id)); sets.push(`raw_material_id = $${vals.length}`);
    }
    if (b.recipe_id !== undefined) {
      vals.push(intOrNull(b.recipe_id)); sets.push(`recipe_id = $${vals.length}`);
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.user.id); sets.push(`updated_by = $${vals.length}`);
    sets.push('updated_at = now()');
    vals.push(req.params.id);
    await db.pool.query(
      `UPDATE calc_sheet_products SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/api/sheet-product/:id(\\d+)', async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  try {
    await db.pool.query(
      "UPDATE calc_sheet_products SET status = 'archived', updated_by = $2, updated_at = now() WHERE id = $1",
      [req.params.id, req.user.id]);
    await db.log(req.user.id, 'calc_sheet_product_remove', { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Применить значение сразу ко всем товарам листа. Ставки, граммаж и комплект
// упаковки в рознице обычно одинаковы, и проставлять их по одному — потеря
// времени. Список полей закрытый: цены и сырьё так менять нельзя.
const SKU_BULK_FIELDS = ['defect_pct', 'retro_pct', 'vat_pct', 'profit_tax_pct', 'net_weight_g', 'pack_template_id'];

router.post('/api/sheet/:sheet/apply-rate', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const sheet = String(req.params.sheet || '');
  if (!SHEETS[sheet]) return res.status(404).json({ error: 'Такого листа нет' });
  const b = req.body || {};
  const field = String(b.field || '');
  if (!SKU_BULK_FIELDS.includes(field)) return res.status(400).json({ error: 'Это поле так менять нельзя' });
  let value = numOrNull(b.value);
  if (value === null || value < 0) return res.status(400).json({ error: 'Укажите значение' });
  if (field === 'net_weight_g' && !(value > 0)) return res.status(400).json({ error: 'Граммаж должен быть больше нуля' });
  if (field === 'pack_template_id') {
    value = intOrNull(b.value);
    const ok = value && (await db.pool.query(
      "SELECT 1 FROM calc_pack_templates WHERE id = $1 AND status = 'active'", [value])).rowCount;
    if (!ok) return res.status(400).json({ error: 'Выберите комплект упаковки' });
  }
  try {
    const r = await db.pool.query(
      `UPDATE calc_sheet_products SET ${field} = $1, updated_by = $2, updated_at = now()
        WHERE sheet = $3 AND status = 'active'`, [value, req.user.id, sheet]);
    await db.log(req.user.id, 'calc_sheet_apply_rate', { sheet, field, value, rows: r.rowCount });
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Какой прайс-лист SalesDoctor показываем в строке «Цена в SD».
router.post('/api/sheet/:sheet/sd-price-type', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const sheet = String(req.params.sheet || '');
  if (!SHEETS[sheet]) return res.status(404).json({ error: 'Такого листа нет' });
  try {
    await setCalcSetting(K_SD_PRICE_TYPE(sheet), intOrNull((req.body || {}).id) || '', req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Обновление цен из SalesDoctor — ТОЛЬКО по кнопке, как счётчик реализации
// на листе «Производство». Выгрузка прайсов идёт постранично и не быстрая,
// поэтому при обычном открытии листа её не трогаем.
router.post('/api/sd-prices/refresh', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  try {
    const started = Date.now();
    const summary = await integrations.syncPrices(req.user.id);
    await db.log(req.user.id, 'calc_sd_prices_refresh', summary || {});
    res.json({ ok: true, summary, took_ms: Date.now() - started });
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] прайсы SD:', e.message);
    res.status(400).json({ error: 'Не удалось обновить цены из SalesDoctor: ' + e.message });
  }
});

module.exports = router;
