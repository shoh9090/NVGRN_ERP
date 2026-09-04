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
const XLSX = require('xlsx');
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
// Нижняя граница маржи: ниже неё скидку давать нельзя. Цифра компании, а не
// сценария, поэтому живёт в настройках и переживает перезагрузку страницы.
const K_MIN_MARGIN = 'min_margin_pct';
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
        purchase_price: info.purchase_price,
        purchase_at: info.purchase_at,
        price_diff_pct: info.diff_pct,
        price_stale: info.diff_pct !== null && Math.abs(info.diff_pct) >= RAW_PRICE_DIFF_PCT,
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
  cutveg: 'Резаные овощи',
};

// Какой прайс-лист SalesDoctor показывать на листе. Настройка листа,
// а не товара: в рознице все товары смотрят на один и тот же прайс.
const K_SD_PRICE_TYPE = (sheet) => 'sd_price_type_' + sheet;

// Цены из прайс-листа SalesDoctor по нашим товарам. Сопоставляем по штрих-коду:
// он есть и у нас, и в справочнике готовой продукции, который приходит из SD.
// Сами цены попадают в ref_prices при синхронизации — здесь только читаем.
async function sdPricesByBarcode(priceTypeId) {
  const out = { byBarcode: new Map(), byGood: new Map(), bySdId: new Map() };
  if (!priceTypeId) return out;
  const r = await db.pool.query(
    `SELECT g.id AS good_id, g.barcode, COALESCE(g.sd_sd_id, '') AS sd_id, p.price,
            to_char(p.last_sync_at, 'DD.MM.YYYY') AS last_sync_at
       FROM ref_prices p
       JOIN ref_finished_goods g ON g.id = p.product_id
      WHERE p.price_type_id = $1`, [priceTypeId]);
  r.rows.forEach((x) => {
    const v = {
      price: Number(x.price) || null,
      // Дату форматирует база: Postgres отдаёт timestamp объектом Date, и
      // обрезка его строки давала «Wed Aug 20» вместо нормальной даты.
      at: x.last_sync_at || null,
    };
    // Id из СД надёжнее штрихкода, поэтому храним обе карты: сначала ищем по
    // вписанному id, а штрихкод остаётся запасным вариантом.
    out.byGood.set(Number(x.good_id), v);
    const sd = String(x.sd_id || '').trim();
    if (sd) out.bySdId.set(sd, v);
    const bc = String(x.barcode || '').trim();
    if (bc) out.byBarcode.set(bc, v);
  });
  return out;
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
    // ниже дата уходит на экран, поэтому приводим её к тексту сразу
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

// Цена сырья одним правилом для всех экранов. Вписанная руками ПЕРЕБИВАЕТ
// Закуп: цена последней приёмки бывает старой, разовой или от другого
// поставщика, и считать по ней неправильно. Чтобы ручная не забылась, рядом
// всегда видно цену из Закупа и насколько она разошлась.
const RAW_PRICE_DIFF_PCT = 10;   // с какого расхождения подсвечиваем

function rawPriceOf(rawId, purchaseMap, manualMap) {
  const p = rawId ? purchaseMap.get(rawId) : null;
  const m = rawId ? manualMap.get(rawId) : null;
  const base = {
    purchase_price: p ? p.price : null,
    purchase_at: p ? p.at : null,
  };
  if (m) {
    const diff = (p && p.price > 0) ? ((m.price - p.price) / p.price) * 100 : null;
    return { ...base, price: m.price, at: m.at, source: 'manual', diff_pct: diff };
  }
  if (p) return { ...base, price: p.price, at: p.at, source: 'purchase', diff_pct: null };
  return { ...base, price: null, at: null, source: 'none', diff_pct: null };
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
      // Сначала по вписанному id из СД, затем по штрихкоду.
      const sdId = String(p.sd_product_id || '').trim();
      const sd = (sdId ? sdPrices.bySdId.get(sdId) : null)
        || (p.finished_good_id ? sdPrices.byGood.get(Number(p.finished_good_id)) : null)
        || sdPrices.byBarcode.get(String(p.barcode || '').trim()) || null;

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
        // Средняя цена за кг самого микса: итог рецептуры ÷ её вес. Нужна, чтобы
        // строка «Стоимость зелени» показывала цифру в своих единицах (сум/кг),
        // а не пустое «по рецептуре» — иначе непонятно, дорогой микс или нет.
        recipe_price_per_kg: (recipe && recipe.total_g > 0 && rawCost !== null)
          ? rawCost / (recipe.total_g / 1000) : null,
        recipe_missing_prices: recipe ? recipe.missing_prices : 0,
        recipe_empty: !!(recipe && !recipe.items.length),
        net_weight_g: weight,
        raw_price_per_kg: rawPricePerKg,
        raw_price_source: rawPriceSource,
        raw_price_at: rawInfo.at,
        // Цена из Закупа показывается рядом даже когда считаем по ручной —
        // чтобы вписанная цифра не забылась и было видно расхождение.
        raw_purchase_price: rawInfo.purchase_price,
        raw_purchase_at: rawInfo.purchase_at,
        raw_price_diff_pct: rawInfo.diff_pct,
        raw_price_stale: rawInfo.diff_pct !== null && Math.abs(rawInfo.diff_pct) >= RAW_PRICE_DIFF_PCT,
        raw_cost: rawCost,
        labor_cost: numOrNull(p.labor_cost),
        defect_pct: Number(p.defect_pct) || 0,
        price: numOrNull(p.price),
        price2: numOrNull(p.price2),
        retro_pct: Number(p.retro_pct) || 0,
        vat_pct: Number(p.vat_pct) || 0,
        profit_tax_pct: Number(p.profit_tax_pct) || 0,
        sd_product_id: p.sd_product_id || '',
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

// ===========================================================================
// Сводка: все товары со всех листов одним списком
// ===========================================================================
// Ничего нового не считает — собирает то, что уже посчитано для каждого листа,
// и сортирует по марже: худшие сверху. Смысл в том, чтобы «где горит» было
// видно за пять секунд, а не после просмотра семи вкладок.
// Порог «маржа низкая» до тех пор, пока Шох не назовёт целевую по направлениям.
const SUMMARY_LOW_MARGIN = 10;
// С какого расхождения считаем, что расчётная цена разошлась с прайсом СД.
const SD_DIFF_PCT = 1;

// Собрать снимок «цена/себестоимость по товару» из последнего утверждения —
// чтобы показать, насколько текущий расчёт от него ушёл.
async function approvedCostMap() {
  const m = new Map();
  const rows = (await db.pool.query(
    `SELECT DISTINCT ON (sheet) sheet, approved_at, data
       FROM calc_sheet_approvals ORDER BY sheet, approved_at DESC, id DESC`)).rows;
  const at = new Map();
  rows.forEach((r) => {
    at.set(r.sheet, r.approved_at);
    ((r.data && r.data.products) || []).forEach((p) => {
      const c = p.calc || {};
      m.set(p.id, { cost_defect: c.cost_defect === undefined ? null : c.cost_defect });
    });
  });
  return { byProduct: m, atBySheet: at };
}

router.get('/api/summary', async (req, res) => {
  const approved = String(req.query.mode || '') === 'approved';
  try {
    const snaps = await approvedCostMap();
    const products = [];
    const noApproval = [];

    for (const key of Object.keys(SHEETS)) {
      const got = await sheetData(key, approved);
      if (!got) { noApproval.push(SHEETS[key]); continue; }
      for (const p of (got.data.products || [])) {
        const c = p.calc || {};
        const comp = c.components || {};
        const price = c.price === undefined ? null : c.price;
        const sdPrice = p.sd_price === undefined ? null : p.sd_price;
        // Расхождение с прайсом СД: посчитали одно, а продаём по другому.
        const sdDiff = (price > 0 && sdPrice > 0) ? ((sdPrice - price) / price) * 100 : null;
        const was = snaps.byProduct.get(p.id);
        const wasCost = was ? was.cost_defect : null;
        const delta = (wasCost > 0 && c.cost_defect !== undefined && c.cost_defect !== null)
          ? ((c.cost_defect - wasCost) / wasCost) * 100 : null;
        products.push({
          id: p.id, name: p.name, barcode: p.barcode || '',
          sheet: key, sheet_title: SHEETS[key],
          approved_at: got.at || snaps.atBySheet.get(key) || null,
          cost: c.cost === undefined ? null : c.cost,
          cost_defect: c.cost_defect === undefined ? null : c.cost_defect,
          defect_pct: p.defect_pct,
          price,
          markup_pct: c.markup_pct === undefined ? null : c.markup_pct,
          net_profit: c.net_profit === undefined ? null : c.net_profit,
          net_pct: c.net_pct === undefined ? null : c.net_pct,
          missing_keys: c.missing_keys || [],
          sd_price: sdPrice, sd_diff_pct: sdDiff,
          delta_pct: delta,
          components: {
            raw: comp.raw === undefined ? null : comp.raw,
            pack: comp.pack === undefined ? null : comp.pack,
            production: comp.production === undefined ? null : comp.production,
            labor: comp.labor === undefined ? null : comp.labor,
          },
          // Объёмы продаж появятся, когда товары свяжут с СД по id. Пока не
          // выдумываем: null честнее нуля, который читался бы как «не продавали».
          sold: null, earned: null,
        });
      }
    }

    // Признаки для плиток-фильтров. Считаем один раз здесь, чтобы экран и
    // счётчик всегда говорили одно и то же.
    products.forEach((x) => {
      x.not_ready = (x.missing_keys || []).length > 0 || !(x.price > 0);
      x.negative = x.net_profit !== null && x.net_profit < 0;
      x.low_margin = !x.not_ready && x.net_pct !== null && x.net_pct < SUMMARY_LOW_MARGIN && !x.negative;
      x.sd_diff = x.sd_diff_pct !== null && Math.abs(x.sd_diff_pct) >= SD_DIFF_PCT;
    });

    // Разрез по направлениям: те же товары, свёрнутые до одной строки на лист.
    const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
    const sheets = [];
    for (const key of Object.keys(SHEETS)) {
      const list = products.filter((x) => x.sheet === key);
      if (!list.length) continue;
      const ready = list.filter((x) => !x.not_ready);
      const sum = (f) => list.reduce((s, x) => s + (Number(x.components[f]) || 0), 0);
      sheets.push({
        sheet: key, title: SHEETS[key],
        count: list.length, ready: ready.length,
        not_ready: list.length - ready.length,
        negative: list.filter((x) => x.negative).length,
        avg_cost: avg(ready.map((x) => x.cost_defect).filter((v) => v !== null)),
        avg_margin: avg(ready.map((x) => x.net_pct).filter((v) => v !== null)),
        delta_pct: avg(list.map((x) => x.delta_pct).filter((v) => v !== null)),
        approved_at: snaps.atBySheet.get(key) || null,
        components: { raw: sum('raw'), pack: sum('pack'), production: sum('production'), labor: sum('labor') },
        sold: null, earned: null,
      });
    }

    res.json({
      mode: approved ? 'approved' : 'current',
      low_margin_pct: SUMMARY_LOW_MARGIN,
      products, sheets, no_approval: noApproval,
      flags: {
        negative: products.filter((x) => x.negative).length,
        low_margin: products.filter((x) => x.low_margin).length,
        sd_diff: products.filter((x) => x.sd_diff).length,
        not_ready: products.filter((x) => x.not_ready).length,
      },
    });
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] сводка:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ===========================================================================
// Песочница: «а что если»
// ===========================================================================
// Черновик поверх утверждённого расчёта. НИЧЕГО не сохраняет и ничего не
// меняет: покрутил цены и объёмы, посмотрел, закрыл. Поэтому здесь нет ни
// одной операции записи — только чтение и счёт.
//
// Отправная точка — утверждённая версия листа: она стабильна, вчера и сегодня
// одинаковая. Если лист ещё ни разу не утверждали, берём текущий расчёт и
// честно об этом пишем.
const PRICE_LISTS = [
  { code: 'price', label: 'Прайс 1' },
  { code: 'price2', label: 'Прайс 2 (КАМ)' },
  { code: 'sd', label: 'Цена в SalesDoctor' },
];

async function sandboxSource(sheet, approved) {
  if (approved) {
    const last = await lastApproval(sheet);
    if (last) return { data: last.data, at: last.approved_at, approved: true };
  }
  return { data: await sheetPayload(sheet), at: null, approved: false };
}

// Товары листа в том виде, в каком их считает песочница. Себестоимость берём
// уже посчитанную (снимок или лист) — заново не пересчитываем, иначе цифры
// разошлись бы с листом.
function sandboxItems(sheet, got) {
  const output = (got.data && got.data.base && got.data.base.output) || null;
  return ((got.data && got.data.products) || []).map((p) => {
    const c = (p.calc && p.calc.components) || {};
    const n = (v) => (v === undefined ? null : v);
    return {
      id: p.id, name: p.name, sheet, sheet_title: SHEETS[sheet],
      approved: !!got.approved, approved_at: got.at,
      output,
      components: { pack: n(c.pack), raw: n(c.raw), production: n(c.production), labor: n(c.labor) },
      defect_pct: Number(p.defect_pct) || 0,
      retro_pct: Number(p.retro_pct) || 0,
      vat_pct: Number(p.vat_pct) || 0,
      profit_tax_pct: Number(p.profit_tax_pct) || 0,
      price: n(p.price), price2: n(p.price2), sd_price: n(p.sd_price),
    };
  });
}

// Каталог для выбора товара. Собирается по всем листам сразу — продажник не
// обязан помнить, на каком листе лежит Айсберг.
router.get('/api/sandbox', async (req, res) => {
  const approved = String(req.query.mode || 'approved') !== 'current';
  try {
    const items = [];
    const notApproved = [];
    for (const key of Object.keys(SHEETS)) {
      const got = await sandboxSource(key, approved);
      if (approved && !got.approved) notApproved.push(SHEETS[key]);
      items.push(...sandboxItems(key, got));
    }
    const base = await perUnitByKind();
    const settings = await calcSettings();
    res.json({
      mode: approved ? 'approved' : 'current',
      price_lists: PRICE_LISTS,
      output_now: base.output,
      min_margin_pct: numOrNull(settings[K_MIN_MARGIN]),
      can_edit: canEdit(req),
      not_approved: notApproved,
      items,
    });
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] песочница:', e.message);
    res.status(400).json({ error: e.message });
  }
});

const PRICE_FIELD = { price: 'price', price2: 'price2', sd: 'sd_price' };

// Нижняя граница маржи. Меняет тот же, кто правит калькуляцию: цифра общая
// для компании, а не личная настройка продажника.
router.post('/api/sandbox/min-margin', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const raw = (req.body || {}).pct;
  const pct = (raw === null || raw === undefined || raw === '') ? null : numOrNull(raw);
  if (pct !== null && (pct < 0 || pct >= 100)) {
    return res.status(400).json({ error: 'Маржа должна быть от 0 до 100%' });
  }
  try {
    await setCalcSetting(K_MIN_MARGIN, pct === null ? '' : pct, req.user.id);
    await db.log(req.user.id, 'calc_min_margin_set', { pct });
    res.json({ ok: true, min_margin_pct: pct });
  } catch (e) { res.status(400).json({ error: e.message }); }
});


// Умножение, которое не превращает «неизвестно» в ноль.
const mul = (v, k) => (v === null || v === undefined ? null : v * k);

// Вердикт словами. Смысл не в «да/нет», а в том, ЧТО предложить клиенту
// взамен: какой объём вернёт прежние деньги и до какой цены можно опуститься.
const sumRu = (v) => Math.round(v).toLocaleString('ru-RU');
function sandboxVerdict(lines, delta, minMargin) {
  if (!lines.length) return null;
  if (lines.some((x) => x.now.incomplete)) {
    return { level: 'warn', text: 'В сценарии есть позиции с незаполненной себестоимостью — вывод по ним делать не из чего.' };
  }
  const below = lines.filter((x) => x.below_min);
  if (below.length) {
    return {
      level: 'bad',
      text: 'Маржа ниже минимальной (' + minMargin + '%): ' + below.map((x) => x.name).join(', ')
        + '. Такую скидку давать нельзя, даже если объём её окупает.',
    };
  }
  if (delta === null) return null;
  if (delta >= 0) {
    return {
      level: 'good',
      text: delta > 0
        ? 'Скидка окупается: вклад вырастет на ' + sumRu(delta) + ' сум.'
        : 'Вклад не изменится — сделка равнозначна прежней.',
    };
  }
  // Не окупается: советуем по позиции, которая теряет больше всех.
  const worst = lines.filter((x) => x.delta_total !== null && x.delta_total < 0)
    .sort((a, b) => a.delta_total - b.delta_total)[0];
  const parts = ['Скидка не окупается: не хватает ' + sumRu(-delta) + ' сум.'];
  if (worst) {
    const how = [];
    if (worst.need_qty !== null) how.push('объём ' + sumRu(worst.need_qty) + ' вместо ' + sumRu(worst.qty_new));
    if (worst.price_floor !== null && worst.max_discount_pct !== null && worst.max_discount_pct < 0) {
      how.push('или цена не ниже ' + sumRu(worst.price_floor)
        + ' (скидка не больше ' + Math.floor(-worst.max_discount_pct) + '%)');
    }
    if (how.length) parts.push('По «' + worst.name + '» нужен ' + how.join(', ') + '.');
  }
  return { level: 'bad', text: parts.join(' ') };
}

// Весь сценарий одной функцией: её же берёт выгрузка в Excel, чтобы файл и
// экран не могли показать разные цифры.
async function sandboxScenario(b) {
  const approved = String(b.mode || 'approved') !== 'current';
  const field = PRICE_FIELD[String(b.price_list || 'price')] || 'price';
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 50) : [];
  const outputNew = asNum(b.output_new);
  {
    const settings = await calcSettings();
    const minMargin = numOrNull(settings[K_MIN_MARGIN]);
    // Тянем только те листы, товары с которых реально в сценарии.
    const wanted = new Set(lines.map((l) => String(l.sheet || '')).filter((s) => SHEETS[s]));
    const byId = new Map();
    for (const key of wanted) {
      const got = await sandboxSource(key, approved);
      sandboxItems(key, got).forEach((it) => byId.set(it.id, it));
    }

    const opts = { components: engine.SKU_SHEET_COMPONENTS };
    const out = [];
    for (const l of lines) {
      const it = byId.get(Number(l.product_id));
      if (!it) continue;
      const basePrice = numOrNull(it[field]);
      const newPrice = l.price_new === undefined || l.price_new === null || l.price_new === ''
        ? basePrice : numOrNull(l.price_new);
      const qty = Math.max(0, asNum(l.qty));
      const qtyNew = l.qty_new === undefined || l.qty_new === null || l.qty_new === ''
        ? qty : Math.max(0, asNum(l.qty_new));

      const common = {
        ...it.components,
        defect_pct: it.defect_pct, retro_pct: it.retro_pct,
        vat_pct: it.vat_pct, profit_tax_pct: it.profit_tax_pct,
      };
      // Рычаг общего выпуска. Постоянные расходы за месяц те же — меняется
      // только то, на сколько штук они делятся, поэтому «на штуку» просто
      // масштабируется. Переменные (сырьё, упаковка) от выпуска не зависят.
      const scaled = outputNew > 0 && it.output > 0
        ? { ...common, production: mul(common.production, it.output / outputNew),
          labor: mul(common.labor, it.output / outputNew) }
        : common;

      const was = engine.sandboxLine({ ...common, price: basePrice }, opts);
      const now = engine.sandboxLine({ ...scaled, price: newPrice }, opts);

      const wasTotal = was.contribution === null ? null : was.contribution * qty;
      const nowTotal = now.contribution === null ? null : now.contribution * qtyNew;
      // Цена, при которой на новом объёме вклад вернётся к прежнему.
      // var_cost — только сырьё и упаковка с браком: ретро и НДС считаются от
      // цены и в обратной формуле участвуют коэффициентом, а не слагаемым.
      const floor = (wasTotal !== null && qtyNew > 0 && !now.incomplete)
        ? engine.priceForContribution(wasTotal / qtyNew, now.var_cost, it.retro_pct, it.vat_pct) : null;
      out.push({
        product_id: it.id, name: it.name, sheet: it.sheet, sheet_title: it.sheet_title,
        approved: it.approved, approved_at: it.approved_at,
        qty, qty_new: qtyNew,
        price: basePrice, price_new: newPrice,
        discount_pct: (basePrice > 0 && newPrice !== null) ? ((newPrice - basePrice) / basePrice) * 100 : null,
        was, now,
        was_total: wasTotal, now_total: nowTotal,
        delta_total: (wasTotal === null || nowTotal === null) ? null : nowTotal - wasTotal,
        // Сколько нужно продать по новой цене, чтобы вернуть прежний вклад.
        need_qty: (wasTotal !== null && now.contribution > 0) ? wasTotal / now.contribution : null,
        price_floor: floor,
        max_discount_pct: (floor !== null && basePrice > 0) ? ((floor - basePrice) / basePrice) * 100 : null,
        below_min: minMargin !== null && now.net_pct !== null && now.net_pct < minMargin,
      });
    }

    const sum = (f) => {
      const vals = out.map((x) => x[f]).filter((v) => v !== null && v !== undefined);
      return vals.length ? vals.reduce((s, v) => s + v, 0) : null;
    };
    const wasSum = sum('was_total');
    const nowSum = sum('now_total');
    const delta = (wasSum === null || nowSum === null) ? null : nowSum - wasSum;
    return {
      mode: approved ? 'approved' : 'current',
      price_list: String(b.price_list || 'price'),
      min_margin_pct: minMargin,
      output_new: outputNew || null,
      lines: out,
      totals: {
        was: wasSum, now: nowSum, delta,
        incomplete: out.some((x) => x.was.incomplete || x.now.incomplete),
        below_min: out.filter((x) => x.below_min).map((x) => x.name),
      },
      verdict: sandboxVerdict(out, delta, minMargin),
    };
  }
}

router.post('/api/sandbox/calc', J, async (req, res) => {
  try {
    res.json(await sandboxScenario(req.body || {}));
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] песочница-расчёт:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Сценарий в Excel. Сам сценарий нигде не хранится, поэтому показать его
// Шоху можно только файлом — отправляем POST'ом те же данные, что на экране.
router.post('/api/sandbox/export.xlsx', J, async (req, res) => {
  try {
    const s = await sandboxScenario(req.body || {});
    const listName = (PRICE_LISTS.find((p) => p.code === s.price_list) || {}).label || s.price_list;

    const aoa = [
      ['ПЕСОЧНИЦА — черновой расчёт «а что если»'],
      ['Составлен', new Date().toLocaleString('ru-RU')],
      ['Основа', s.mode === 'approved' ? 'утверждённые расчёты листов' : 'текущий расчёт (цены сегодняшние)'],
      ['Прайс', listName],
      ['Выпуск завода, шт/мес', s.output_new ? ('изменён на ' + s.output_new) : 'без изменений'],
      ['Минимальная маржа, %', s.min_margin_pct === null ? 'не задана' : s.min_margin_pct],
      [],
      ['Товар', 'Направление', 'Объём было', 'Объём стало', 'Цена было', 'Цена стало', 'Скидка, %',
        'Маржа было, %', 'Маржа стало, %', 'Вклад с ед. было', 'Вклад с ед. стало',
        'Вклад всего было', 'Вклад всего стало', 'Разница', 'Предельная цена', 'Нужный объём'],
    ];
    s.lines.forEach((x) => aoa.push([
      x.name, x.sheet_title, rnd(x.qty), rnd(x.qty_new), rnd(x.price), rnd(x.price_new),
      pct(x.discount_pct), pct(x.was.net_pct), pct(x.now.net_pct),
      rnd(x.was.contribution), rnd(x.now.contribution),
      rnd(x.was_total), rnd(x.now_total), rnd(x.delta_total),
      rnd(x.price_floor), rnd(x.need_qty),
    ]));
    const t = s.totals || {};
    aoa.push([]);
    aoa.push(['ИТОГО', '', '', '', '', '', '', '', '', '', '', rnd(t.was), rnd(t.now), rnd(t.delta)]);
    if (s.verdict) { aoa.push([]); aoa.push(['Вывод', s.verdict.text]); }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 30 }, { wch: 18 }].concat(new Array(14).fill({ wch: 15 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Сценарий');

    // Второй лист — из чего складывается цена по каждой позиции. Доли считаются
    // от цены, поэтому строки вместе с маржой дают ровно 100%.
    const parts = [['Товар', 'Статья', 'Было, сум', 'Было, %', 'Стало, сум', 'Стало, %']];
    s.lines.forEach((x) => {
      const wasBy = new Map((x.was.parts || []).map((p) => [p.key, p]));
      (x.now.parts || []).forEach((p) => {
        const w = wasBy.get(p.key);
        parts.push([x.name, p.label, w ? rnd(w.value) : '', w ? pct(w.pct) : '', rnd(p.value), pct(p.pct)]);
      });
      parts.push([]);
    });
    const ws2 = XLSX.utils.aoa_to_sheet(parts);
    ws2['!cols'] = [{ wch: 30 }, { wch: 24 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Структура цены');

    xlsxSend(res, wb, 'sandbox.xlsx');
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] песочница-выгрузка:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ===========================================================================
// Выгрузка в Excel
// ===========================================================================
// Файлов два, и путать их нельзя:
//   • ПРАЙС — штрихкод, наименование, цены. Себестоимости НЕТ, его можно
//     отдавать агентам и клиентам;
//   • КАЛЬКУЛЯЦИЯ — все строки листа, включая себестоимость и маржу. Только
//     для внутреннего пользования.
const xlsxSend = (res, wb, filename) => {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
};
const rnd = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '' : Math.round(Number(v)));
const pct = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '' : Math.round(Number(v) * 10) / 10);
const dateRu = (v) => { try { return v ? new Date(v).toLocaleDateString('ru-RU') : ''; } catch (e) { return ''; } };

// Данные листа: текущий расчёт или последний утверждённый снимок.
async function sheetData(sheet, approved) {
  if (!approved) return { data: await sheetPayload(sheet), at: null };
  const last = await lastApproval(sheet);
  return last ? { data: last.data, at: last.approved_at } : null;
}

// ПРАЙС по всем листам — без единой цифры себестоимости.
router.get('/api/price-export.xlsx', async (req, res) => {
  const approved = String(req.query.mode || '') === 'approved';
  try {
    const aoa = [['Направление', 'Штрихкод', 'Наименование', 'Прайс 1', 'Прайс 2 (КАМ)', 'Цена в SalesDoctor', 'Утверждено']];
    for (const key of Object.keys(SHEETS)) {
      const got = await sheetData(key, approved);
      if (!got) continue;
      for (const p of (got.data.products || [])) {
        aoa.push([SHEETS[key], p.barcode || '', p.name || '',
          rnd(p.price), rnd(p.price2), rnd(p.sd_price), dateRu(got.at)]);
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 18 }, { wch: 16 }, { wch: 30 }, { wch: 13 }, { wch: 15 }, { wch: 18 }, { wch: 13 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Прайс');
    xlsxSend(res, wb, `prays_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) { res.status(400).send('Ошибка выгрузки: ' + e.message); }
});

// СВОДКА — то же, что на экране: себестоимость, цена, маржа. Внутренний файл.
router.get('/api/summary-export.xlsx', async (req, res) => {
  const approved = String(req.query.mode || '') === 'approved';
  try {
    const aoa = [['Товар', 'Штрихкод', 'Направление', 'с/с', 'Брак, %', 'с/с с браком',
      'Цена', 'Наценка, %', 'Прибыль', 'Маржа, %']];
    const rows = [];
    for (const key of Object.keys(SHEETS)) {
      const got = await sheetData(key, approved);
      if (!got) continue;
      for (const p of (got.data.products || [])) {
        const c = p.calc || {};
        rows.push({ np: c.net_pct === undefined ? null : c.net_pct, r: [p.name || '', p.barcode || '', SHEETS[key],
          rnd(c.cost), pct(p.defect_pct), rnd(c.cost_defect), rnd(c.price),
          pct(c.markup_pct), rnd(c.net_profit), pct(c.net_pct)] });
      }
    }
    // Порядок как на экране: сначала то, где расчёт не готов, потом худшая маржа.
    rows.sort((a, b) => {
      const an = a.np === null, bn = b.np === null;
      if (an !== bn) return an ? -1 : 1;
      return (a.np || 0) - (b.np || 0);
    });
    rows.forEach((x) => aoa.push(x.r));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 30 }, { wch: 16 }, { wch: 18 }, { wch: 12 }, { wch: 9 }, { wch: 14 },
      { wch: 12 }, { wch: 11 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Сводка');
    xlsxSend(res, wb, `svodka_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) { res.status(400).send('Ошибка выгрузки: ' + e.message); }
});

// КАЛЬКУЛЯЦИЯ одного листа — строки расчёта, столбцы товары, как на экране.
router.get('/api/sheet/:sheet/export.xlsx', async (req, res) => {
  const sheet = String(req.params.sheet || '');
  if (!SHEETS[sheet]) return res.status(404).send('Такого листа нет');
  const approved = String(req.query.mode || '') === 'approved';
  try {
    const got = await sheetData(sheet, approved);
    if (!got) return res.status(400).send('Этот лист ещё не утверждали');
    const d = got.data;
    const P = d.products || [];
    const line = (label, unit, fn) => [label, unit, ...P.map(fn)];
    const c = (p) => p.calc || {};
    const c2 = (p) => p.calc2 || {};

    const aoa = [
      ['Лист', SHEETS[sheet], ...P.map((p) => p.name || '')],
      ['Штрихкод', '', ...P.map((p) => p.barcode || '')],
      line('Граммаж', 'гр', (p) => rnd(p.net_weight_g)),
      line('Рецептура', '', (p) => p.recipe_name || ''),
      line('Наименование сырья', '', (p) => (p.recipe_id ? 'по рецептуре' : (p.raw_material_name || ''))),
      line('Стоимость зелени', 'сум/кг', (p) => rnd(p.recipe_id ? p.recipe_price_per_kg : p.raw_price_per_kg)),
      line('Зелень в упаковке', 'сум', (p) => rnd(c(p).components ? c(p).components.raw : null)),
      line('Тип упаковки', '', (p) => p.pack_template_name || ''),
      line('Упаковка', 'сум', (p) => rnd(c(p).components ? c(p).components.pack : null)),
      line('Производ. затраты / накладные', 'сум', (p) => rnd(c(p).components ? c(p).components.production : null)),
      line('Доля затрат', '', (p) => p.prod_factor),
      line('ФОТ', 'сум', (p) => rnd(c(p).components ? c(p).components.labor : null)),
      line('с/с', 'сум', (p) => rnd(c(p).cost)),
      line('Брак', '%', (p) => pct(p.defect_pct)),
      line('с/с с браком', 'сум', (p) => rnd(c(p).cost_defect)),
      line('Цена в SalesDoctor', 'сум', (p) => rnd(p.sd_price)),
    ];
    // Два прайса — одинаковыми блоками, как на экране.
    [['Прайс 1', c], ['Прайс 2 (КАМ)', c2]].forEach(([title, calc]) => {
      aoa.push([title, 'сум', ...P.map((p) => rnd(calc(p).price))]);
      aoa.push(line('  Наценка', '%', (p) => pct(calc(p).markup_pct)));
      aoa.push(line('  Ретро бонусы', 'сум', (p) => rnd(calc(p).retro)));
      aoa.push(line('  НДС', 'сум', (p) => rnd(calc(p).vat)));
      aoa.push(line('  Прибыль', 'сум', (p) => rnd(calc(p).profit)));
      aoa.push(line('  Налог на прибыль', 'сум', (p) => rnd(calc(p).profit_tax)));
      aoa.push(line('  Чистая прибыль', 'сум', (p) => rnd(calc(p).net_profit)));
      aoa.push(line('  ЧП', '%', (p) => pct(calc(p).net_pct)));
    });
    if (approved && got.at) aoa.push([], ['Утверждено', dateRu(got.at)]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 30 }, { wch: 8 }, ...P.map(() => ({ wch: 15 }))];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, SHEETS[sheet].slice(0, 28));
    xlsxSend(res, wb, `kalkulyaciya_${sheet}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) { res.status(400).send('Ошибка выгрузки: ' + e.message); }
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
const SKU_TEXT_FIELDS = ['name', 'barcode', 'sd_product_id'];
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
    if (b.finished_good_id !== undefined) {
      vals.push(intOrNull(b.finished_good_id)); sets.push(`finished_good_id = $${vals.length}`);
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
