// calculation.js — плитка «Калькуляция себестоимости».
//
// ПЕРЕСБОРКА ПО ЭТАПАМ (решение Шоха: интерфейс собираем заново, по одному экрану).
// Шаг 1 — «Затраты»: аналог листа «Произодство» из Excel, правится прямо в таблице.
// Дальше по шагам: цены сырья → товары → итоговая таблица.
//
// Ответственность файла: маршруты, права, сбор ответа.
// Формулы — только в calculation-engine.js, чтение источников — в calculation-sources.js.
// Модули calculation-matrix.js и calculation-group-policy.js остаются на диске:
// они понадобятся на шаге «товары», но сейчас из интерфейса не вызываются.
const express = require('express');
const db = require('./db');
const engine = require('./calculation-engine');
const sources = require('./calculation-sources');
const { ensureCalculationSchema } = require('./calculation-schema');

const router = express.Router();
const J = express.json({ limit: '1mb' });

const asNum = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const curPeriod = () => new Date().toISOString().slice(0, 7);

// Право менять цифры: администратор или роль «Финансы/Бухгалтерия».
const canEdit = (req) => !!(req.user && (req.user.isAdmin || req.user.isFinance));
const denyEdit = (res) => res.status(403).json({ error: 'Менять затраты может финансовый сотрудник или администратор' });

// Настройки калькуляции лежат в calc_settings (таблица с июля, там уже есть выпуск).
const K_OUTPUT = 'monthly_units';         // среднемесячный выпуск, шт
const K_FOT_MODE = 'fot_mode';            // hr (из Кадров) | manual (ввожу сам)
const K_FOT_MANUAL = 'fot_manual';        // ручная сумма ФОТ с налогами

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

const BLOCKS = [
  { key: 'production', title: 'Производственные затраты', hint: 'Тратим, чтобы произвести: аренда цеха, электроэнергия, вода.' },
  { key: 'overhead', title: 'Накладные расходы', hint: 'Не привязаны к производству: логистика, маркетинг, банк, администрация.' },
];

router.use(async (req, res, next) => {
  try { await ensureCalculationSchema(db.pool); next(); } catch (e) { next(e); }
});

router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('calculation', { settings, user: req.user });
});

// ===========================================================================
// Экран «Затраты»
// ===========================================================================
router.get('/api/costs', async (req, res) => {
  try {
    const settings = await calcSettings();
    const output = asNum(settings[K_OUTPUT]) || 0;
    const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : curPeriod();

    const rows = (await db.pool.query(
      `SELECT id, kind, name, amount, sort FROM calc_cost_items
       WHERE status = 'active' ORDER BY kind, sort, id`)).rows;

    const blocks = BLOCKS.map((b) => {
      const items = rows.filter((r) => r.kind === b.key).map((r) => ({
        id: r.id,
        name: r.name,
        amount: Number(r.amount) || 0,
        per_unit: engine.perUnit(r.amount, output),
      }));
      const total = items.reduce((sum, x) => sum + x.amount, 0);
      return { ...b, items, total, per_unit: engine.perUnit(total, output) };
    });

    // ФОТ: по умолчанию фактический из «Кадров», но можно ввести вручную.
    const mode = settings[K_FOT_MODE] === 'manual' ? 'manual' : 'hr';
    const hr = await sources.monthlyFot(db.pool, period);
    const manual = asNum(settings[K_FOT_MANUAL]);
    const fotTotal = mode === 'manual' ? manual : hr.total_load;
    const fot = {
      mode, period, manual,
      accrued: hr.accrued, inps: hr.inps, ndfl: hr.ndfl, social: hr.social,
      hr_total: hr.total_load,
      total: fotTotal,
      per_unit: engine.perUnit(fotTotal, output),
      warnings: mode === 'hr' ? hr.warnings : [],
    };

    const blocksPerUnit = blocks.reduce((sum, b) => sum + (b.per_unit || 0), 0);
    const totalPerUnit = output > 0 ? blocksPerUnit + (fot.per_unit || 0) : null;

    res.json({
      output, period, blocks, fot,
      total_per_unit: totalPerUnit,
      can_edit: canEdit(req),
      // Понятное объяснение, почему цифры пустые.
      block_reason: output > 0 ? null : 'Укажите среднемесячный выпуск — без него затраты не на что делить.',
    });
  } catch (e) {
    console.error('[КАЛЬКУЛЯЦИЯ] затраты:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Среднемесячный выпуск
router.post('/api/output', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const v = asNum((req.body || {}).output);
  if (v < 0) return res.status(400).json({ error: 'Выпуск не может быть отрицательным' });
  await setCalcSetting(K_OUTPUT, v, req.user.id);
  await db.log(req.user.id, 'calc_output_set', { output: v });
  res.json({ ok: true });
});

// Настройка ФОТ: откуда берём и ручная сумма
router.post('/api/fot', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  if (b.mode !== undefined) await setCalcSetting(K_FOT_MODE, b.mode === 'manual' ? 'manual' : 'hr', req.user.id);
  if (b.manual !== undefined) {
    const v = asNum(b.manual);
    if (v < 0) return res.status(400).json({ error: 'Сумма ФОТ не может быть отрицательной' });
    await setCalcSetting(K_FOT_MANUAL, v, req.user.id);
  }
  await db.log(req.user.id, 'calc_fot_set', { mode: b.mode, manual: b.manual });
  res.json({ ok: true });
});

// Добавить статью затрат
router.post('/api/costs', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  const kind = b.block === 'overhead' ? 'overhead' : 'production';
  const name = String(b.name || '').trim() || 'Новая статья';
  try {
    const next = (await db.pool.query(
      'SELECT COALESCE(MAX(sort), 0) + 10 AS n FROM calc_cost_items WHERE kind = $1', [kind])).rows[0].n;
    const r = await db.pool.query(
      `INSERT INTO calc_cost_items (kind, name, amount, sort, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
      [kind, name, asNum(b.amount), next, req.user.id]);
    await db.log(req.user.id, 'calc_cost_add', { id: r.rows[0].id, kind, name });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Изменить статью (название или сумму)
router.post('/api/costs/:id(\\d+)', J, async (req, res) => {
  if (!canEdit(req)) return denyEdit(res);
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Название статьи не может быть пустым' });
    vals.push(name); sets.push(`name = $${vals.length}`);
  }
  if (b.amount !== undefined) {
    const amount = asNum(b.amount);
    if (amount < 0) return res.status(400).json({ error: 'Сумма не может быть отрицательной' });
    vals.push(amount); sets.push(`amount = $${vals.length}`);
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

module.exports = router;
