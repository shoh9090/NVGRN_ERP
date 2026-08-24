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

router.use(async (req, res, next) => {
  try { await require('./calculation-schema').ensureCalculationSchema(db.pool); next(); } catch (e) { next(e); }
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
};

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
  return {
    output,
    production,
    overhead,
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
            COALESCE(po.received_at::date, po.delivery_date) AS at
       FROM purchase_order_items i
       JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
      WHERE i.item_kind = 'raw' AND COALESCE(i.fact_price, i.price) > 0
      ORDER BY i.item_id, COALESCE(po.received_at::date, po.delivery_date) DESC`);
  const byId = new Map();
  r.rows.forEach((x) => byId.set(x.item_id, { price: Number(x.price), at: x.at }));
  return byId;
}

router.get('/api/sheet/:sheet', async (req, res) => {
  const sheet = String(req.params.sheet || '');
  if (!SHEETS[sheet]) return res.status(404).json({ error: 'Такого листа нет' });
  try {
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

    const rows = (await db.pool.query(
      `SELECT * FROM calc_sheet_products
        WHERE sheet = $1 AND status = 'active' ORDER BY sort, id`, [sheet])).rows;

    const products = rows.map((p) => {
      const tpl = p.pack_template_id ? tplById.get(p.pack_template_id) : null;
      const factor = p.prod_factor === null ? 1 : Number(p.prod_factor);
      const scale = (v) => (v === null || v === undefined ? null : v * factor);

      // Зелень-сырьё считается так же, как в Excel: граммаж / 1000 × цена за кг.
      // Цена за кг берётся из Закупа по связанной позиции, а если её там ещё
      // нет — из вписанной вручную. Так лист всегда показывает цифру, и при
      // этом видно, откуда она взялась.
      const weight = numOrNull(p.net_weight_g);
      const rawInfo = p.raw_material_id ? rawPrices.get(p.raw_material_id) : null;
      const purchasePrice = rawInfo ? rawInfo.price : null;
      const manualPrice = numOrNull(p.raw_price_per_kg);
      const rawPricePerKg = purchasePrice !== null ? purchasePrice : manualPrice;
      const rawPriceSource = purchasePrice !== null ? 'purchase'
        : (manualPrice !== null ? 'manual' : 'none');
      const rawCost = (weight !== null && rawPricePerKg !== null)
        ? (weight / 1000) * rawPricePerKg
        : numOrNull(p.raw_cost);

      const calc = engine.skuEconomics({
        pack: tpl ? Number(tpl.total) : null,
        raw: rawCost,
        production: scale(base.combined),
        labor: numOrNull(p.labor_cost),
        defect_pct: p.defect_pct,
        price: numOrNull(p.price),
        retro_pct: p.retro_pct,
        vat_pct: p.vat_pct,
        profit_tax_pct: p.profit_tax_pct,
      }, { components: ['pack', 'raw', 'production'] });

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
        net_weight_g: weight,
        raw_price_per_kg: rawPricePerKg,
        raw_price_source: rawPriceSource,
        raw_price_at: rawInfo ? rawInfo.at : null,
        raw_cost: rawCost,
        labor_cost: numOrNull(p.labor_cost),
        defect_pct: Number(p.defect_pct) || 0,
        price: numOrNull(p.price),
        price2: numOrNull(p.price2),
        retro_pct: Number(p.retro_pct) || 0,
        vat_pct: Number(p.vat_pct) || 0,
        profit_tax_pct: Number(p.profit_tax_pct) || 0,
        calc,
      };
    });

    res.json({
      sheet,
      sheet_title: SHEETS[sheet],
      base: {
        output: base.output,
        production_overhead_per_unit: base.combined,
      },
      pack_templates: tplRows.map((t) => ({
        id: t.id, name: t.name, total: Number(t.total),
        missing_prices: Number(t.missing_prices),
      })),
      raw_materials: rawMats.map((m) => ({
        id: m.id, name: m.name, price_per_kg: rawPrices.has(m.id) ? rawPrices.get(m.id).price : null,
      })),
      products,
      can_edit: canEdit(req),
      no_output_reason: base.output > 0 ? null
        : 'На листе «Производство» не указан среднемесячный выпуск — затраты на штуку посчитать не из чего.',
    });
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] товарный лист:', e.message);
    res.status(400).json({ error: e.message });
  }
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

module.exports = router;
