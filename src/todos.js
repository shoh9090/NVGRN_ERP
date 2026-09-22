// todos.js — «Нужно внести»: дела для ответственных людей в колокольчике.
//
// Шох: «давай сделаем так, чтобы ответственный человек, который не внёс, открывал
// ERP и мог сразу внести». Уведомления колокольчика — это события («прочитал —
// исчезло»). Дело ведёт себя иначе: висит, пока его не сделали, и пропадает само,
// как только данные внесены. Поэтому дела не хранятся — считаются на лету из тех
// же таблиц, что и отчёты.
//
// Каждый видит только дела своих плиток (админ — все). Ссылка дела открывает окно,
// где это вносится сразу, а не просто плитку.
const express = require('express');
const db = require('./db');
const router = express.Router();

const DAYS_BACK = 120;   // старше — уже не «сегодняшняя» работа, в отчётах давно закрыто

async function hasTile(user, url) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (url === '/cash' && user.isFinance) return true;
  const r = await db.pool.query(
    `SELECT 1 FROM tiles t JOIN role_tiles rt ON rt.tile_id = t.id
       JOIN user_roles ur ON ur.role_id = rt.role_id
      WHERE ur.user_id = $1 AND t.url = $2 LIMIT 1`, [user.id, url]);
  return r.rows.length > 0;
}

// Принятые позиции Закупа без цены: из-за них сырьё в P&L и долг поставщику
// занижены (считаются как факт × цена, а цена 0).
async function noPriceItems(pool) {
  return (await pool.query(
    `SELECT i.id, i.order_id, po.number, to_char(po.delivery_date, 'YYYY-MM-DD') AS delivery_date,
            c.name AS supplier_name, i.item_kind, COALESCE(rm.name, pk.name) AS item_name,
            COALESCE(u1.short_name, u2.short_name) AS unit, i.fact_qty
       FROM purchase_order_items i
       JOIN purchase_orders po ON po.id = i.order_id
       JOIN ref_counterparties c ON c.id = po.supplier_id
       LEFT JOIN ref_raw_materials rm ON i.item_kind = 'raw' AND rm.id = i.item_id
       LEFT JOIN ref_packaging pk ON i.item_kind = 'packaging' AND pk.id = i.item_id
       LEFT JOIN ref_units u1 ON u1.id = rm.unit_id
       LEFT JOIN ref_units u2 ON u2.id = pk.unit_id
      WHERE po.status = 'received' AND COALESCE(i.fact_qty, 0) > 0 AND COALESCE(i.price, 0) = 0
        AND po.delivery_date >= CURRENT_DATE - $1::int
      ORDER BY po.delivery_date DESC, po.number, i.id`, [DAYS_BACK])).rows;
}

// Позиции склада, у которых вообще нет цены: пришли не через Закуп — начальным
// остатком или плюсом при инвентаризации. Шох: «даже если через начальный
// остаток — это задача закупщика: ставить цены с НДС». Без цены склад оценивает
// их выдачи и списания нулём.
async function stockNoPriceItems(pool) {
  return (await pool.query(
    `WITH moved AS (
       SELECT item_kind, item_id, SUM(qty) FILTER (WHERE qty > 0) AS qty_in,
              to_char(MIN(moved_at), 'YYYY-MM-DD') AS first_at
         FROM stock_movements
        WHERE moved_at >= CURRENT_DATE - $1::int OR reason = 'opening'
        GROUP BY item_kind, item_id),
     priced AS (
       SELECT DISTINCT item_kind, item_id FROM stock_movements
        WHERE qty > 0 AND COALESCE(price, 0) > 0)
     SELECT m.item_kind, m.item_id, COALESCE(rm.name, pk.name) AS item_name,
            COALESCE(u1.short_name, u2.short_name) AS unit, m.qty_in, m.first_at
       FROM moved m
       LEFT JOIN priced p ON p.item_kind = m.item_kind AND p.item_id = m.item_id
       LEFT JOIN ref_raw_materials rm ON m.item_kind = 'raw' AND rm.id = m.item_id
       LEFT JOIN ref_packaging pk ON m.item_kind = 'packaging' AND pk.id = m.item_id
       LEFT JOIN ref_units u1 ON u1.id = rm.unit_id
       LEFT JOIN ref_units u2 ON u2.id = pk.unit_id
      WHERE p.item_id IS NULL AND COALESCE(m.qty_in, 0) > 0
        AND NOT COALESCE(rm.is_waste, false)            -- отход бесплатный по определению
      ORDER BY item_name`, [DAYS_BACK])).rows;
}

// Товары, которые продавались в прошлом и текущем месяце, но не нашли себе пары
// в Калькуляции (ни по коду SD, ни по штрих-коду, ни по названию).
async function unmatchedSold(pool) {
  const now = new Date(Date.now() + 5 * 3600000);
  const cur = now.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const rows = (await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)',
    [['pnl_sku_' + prev, 'pnl_sku_' + cur]])).rows;
  const sold = new Map();
  for (const r of rows) {
    let list = [];
    try { list = JSON.parse(r.value) || []; } catch (e) { list = []; }
    for (const [sd, qty, name] of list) {
      const cur2 = sold.get(String(sd)) || [String(sd), 0, name];
      cur2[1] += Number(qty) || 0;
      sold.set(String(sd), cur2);
    }
  }
  if (!sold.size) return [];
  const products = (await pool.query(
    `SELECT id, name, barcode, sd_product_id, finished_good_id FROM calc_sheet_products WHERE status = 'active'`)).rows
    .map((p) => ({ ...p, cost: 0 }));
  const goods = (await pool.query(
    "SELECT id, name, barcode, sd_sd_id FROM ref_finished_goods WHERE COALESCE(sd_sd_id, '') <> ''")).rows;
  const { linkProducts } = require('./cash-pnl');
  const { costBySd } = linkProducts(products, [...sold.values()], goods);
  return [...sold.values()]
    .filter(([sd, qty]) => qty > 0 && !costBySd.has(sd))
    .map(([sd, qty, name]) => ({ sd_id: sd, name: name || sd, units: Math.round(qty) }))
    .sort((a, b) => b.units - a.units);
}

// Поступления, похожие на возврат банка, но стоящие как «Выручка от продаж».
// Возврат нашего же платежа — не выручка: 20 млн 16.09.2026 развели ERP и CRM.
async function returnsAsSales(pool) {
  return (await pool.query(
    `SELECT t.id, to_char(t.tx_date, 'YYYY-MM-DD') AS d, t.amount, t.purpose
       FROM cash_transactions t JOIN cash_categories c ON c.id = t.category_id
      WHERE t.tx_type = 'in' AND c.code = '200' AND t.tx_date >= CURRENT_DATE - $1::int
        AND (t.purpose ~* 'qaytar|возврат|возвращ|vozvrat|refund')
      ORDER BY t.tx_date DESC`, [DAYS_BACK])).rows;
}

// Операции Кассы без статьи — пока не разнесены, P&L и Кэш-флоу неполные.
async function unclassified(pool) {
  return (await pool.query(
    `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0) AS amount
       FROM cash_transactions
      WHERE category_id IS NULL AND tx_type IN ('in', 'out') AND source <> 'opening'
        AND tx_date >= CURRENT_DATE - $1::int`, [DAYS_BACK])).rows[0];
}

const mln = (v) => (Math.round((Number(v) || 0) / 1e5) / 10).toLocaleString('ru-RU') + ' млн';

// Какие бывают дела и в какой плитке вносятся. Ответственную роль за каждое
// назначают в плитке «Джарвис» → «Кто вносит» (решение Шоха: цены вносит
// закупщик, Кассу разносит бухгалтер — пусть Джарвис пишет им, а не всем подряд).
const TODO_KINDS = [
  { key: 'noprice', title: 'Цены (с НДС) на принятое и на складе', tile: '/purchase' },
  { key: 'calc', title: 'Товары из продаж без пары в Калькуляции', tile: '/calculation' },
  { key: 'loss', title: 'Убыточные позиции в Калькуляции', tile: '/calculation' },
  { key: 'unclassified', title: 'Операции Кассы без статьи', tile: '/cash' },
  { key: 'returns_as_sales', title: 'Возврат банка, учтённый как выручка', tile: '/cash' },
];

// Цепочка ответственных: { ключ дела: [{ role, after_h }] } — кто первый и кто
// подхватывает, если через after_h рабочих часов дело так и висит.
// Решение Шоха: карточки в Калькуляции заводит маркетолог, не сделал за день —
// то же дело видит бухгалтерия: «сказали вчера, не сделано — проверьте сами
// или напомните». Пусто — как раньше, всем, у кого есть доступ к плитке.
async function todoOwners() {
  try {
    const r = await db.pool.query("SELECT value FROM settings WHERE key = 'jarvis_rules'");
    const o = JSON.parse((r.rows[0] && r.rows[0].value) || '{}').owners || {};
    return require('./jarvis-rules').normalizeRules({ owners: o }).owners;
  } catch (e) { return {}; }
}

// С какого момента дело висит: нужно, чтобы понять, пора ли подключать
// следующего в цепочке. Появилось — запомнили, сделали — забыли.
async function todoState() {
  try {
    return new Map((await db.pool.query('SELECT key, first_seen FROM jarvis_todo_state')).rows
      .map((r) => [r.key, r.first_seen]));
  } catch (e) { return new Map(); }
}
// Пересчёт «с какого момента»: зовётся раз в такт Джарвисом, не на каждого человека.
// Решение Шоха: подключать второго, только если работа ВСТАЛА. Пока число
// уменьшается (36 → 31 → 24), часы считаются заново и никто никого не дёргает.
// Дело сделано полностью — строка удаляется.
async function refreshTodoState(pool) {
  const items = await computeTodos(TODO_KINDS.map((k) => k.key));
  const byKey = new Map(items.map((i) => [i.key, i]));
  for (const k of TODO_KINDS) {
    const it = byKey.get(k.key);
    if (!it) { await pool.query('DELETE FROM jarvis_todo_state WHERE key = $1', [k.key]); continue; }
    const n = Number(it.count) || 0;
    await pool.query(
      `INSERT INTO jarvis_todo_state (key, first_seen, last_count) VALUES ($1, now(), $2)
       ON CONFLICT (key) DO UPDATE SET
         first_seen = CASE WHEN $2 < COALESCE(jarvis_todo_state.last_count, $2) THEN now() ELSE jarvis_todo_state.first_seen END,
         last_count = $2`, [k.key, n]);
  }
  return items;
}

// Дела человека. user: { id, isAdmin, isFinance } — как req.user.
// Тем же списком пользуется утренняя сводка Джарвиса в Telegram (src/jarvis-bot.js).
async function todosFor(user) {
  const owners = await todoOwners();
  const state = await todoState();
  const myRoles = user && user.id
    ? (await db.pool.query('SELECT role_id FROM user_roles WHERE user_id = $1', [user.id])).rows.map((x) => Number(x.role_id))
    : [];
  const roleName = new Map((await db.pool.query('SELECT id, name FROM roles')).rows.map((r) => [Number(r.id), r.name]));
  const rules = require('./jarvis-rules').normalizeRules(await jarvisRulesRaw());
  const now = Date.now();
  // Чьё это дело сейчас: первый в цепочке — сразу, следующие — когда дело
  // провисело свои рабочие часы. Назначена цепочка — дело только у неё
  // (даже у админа: иначе Шоху приходят чужие напоминания).
  const mine = (key) => {
    const steps = owners[key] || [];
    if (!steps.length) return { ok: null };                  // решает доступ к плитке
    const since = state.get(key) ? Date.parse(state.get(key)) : now;
    const hours = require('./jarvis-rules').workHours(since, now, rules);
    const active = steps.filter((s) => hours >= s.after_h);
    const at = active.findIndex((s) => myRoles.includes(s.role));
    if (at < 0) return { ok: false };
    const prev = at > 0 ? steps[at - 1] : null;
    return { ok: true, escalated: at > 0, since, prev_role: prev ? roleName.get(prev.role) : null };
  };
  const meta = {};
  const allowed = async (key, tile) => {
    const m = mine(key);
    if (m.ok === null) return hasTile(user, tile);
    if (m.ok) meta[key] = m;
    return m.ok;
  };
  const items = (await computeTodos(TODO_KINDS.map((k) => k.key), allowed));
  items.forEach((i) => { if (meta[i.key] && meta[i.key].escalated) i.escalated = meta[i.key]; });
  return items;
}

async function jarvisRulesRaw() {
  try {
    const r = await db.pool.query("SELECT value FROM settings WHERE key = 'jarvis_rules'");
    return JSON.parse((r.rows[0] && r.rows[0].value) || '{}');
  } catch (e) { return {}; }
}

// Сами дела. keys — какие считать; allowed — фильтр доступа (без него считаем всё).
async function computeTodos(keys, allowed) {
  const want = (k) => keys.includes(k);
  const can = async (k, tile) => (allowed ? allowed(k, tile) : true);
  const items = [];
  const safe = async (fn) => { try { await fn(); } catch (e) { console.warn('[ДЕЛА]', e.message); } };

  await safe(async () => {
    if (!want('noprice') || !(await can('noprice', '/purchase'))) return;
    const rows = await noPriceItems(db.pool);
    const stock = await stockNoPriceItems(db.pool);
    if (!rows.length && !stock.length) return;
    const parts = [];
    if (rows.length) {
      const orders = new Set(rows.map((r) => r.order_id));
      parts.push(`${rows.length} поз. в ${orders.size} принятых заявках — сырьё в P&L и долг поставщику занижены`);
    }
    if (stock.length) {
      parts.push(`${stock.length} поз. на складе без цены (${stock.slice(0, 3).map((r) => r.item_name).join(', ')}${stock.length > 3 ? '…' : ''})`);
    }
    items.push({
      key: 'noprice', title: `Внести цены (с НДС): ${rows.length + stock.length} поз.`,
      body: parts.join('; ') + '.',
      link: '/purchase#noprice', count: rows.length + stock.length,
    });
  });

  await safe(async () => {
    if (!want('calc') || !(await can('calc', '/calculation'))) return;
    const rows = await unmatchedSold(db.pool);
    if (!rows.length) return;
    items.push({
      key: 'calc', title: `Калькуляция: ${rows.length} товаров из продаж без пары`,
      body: 'Продаются, но в Калькуляции их нет: ' + rows.slice(0, 3).map((r) => r.name).join(', ') + (rows.length > 3 ? '…' : '')
        + '. Привяжите к товару Калькуляции.',
      link: '/calculation#missing', count: rows.length,
    });
  });

  // Убыточные позиции: цена ниже себестоимости. Считает Калькуляция
  // (summaryProducts) — своей формулы здесь нет, иначе цифры разойдутся с экраном.
  await safe(async () => {
    if (!want('loss') || !(await can('loss', '/calculation'))) return;
    const { products } = await require('./calculation').summaryProducts(false);
    const bad = products.filter((p) => p.negative)
      .sort((a, b) => (a.net_profit || 0) - (b.net_profit || 0));
    if (!bad.length) return;
    items.push({
      key: 'loss', title: `Калькуляция: ${bad.length} позиций в минусе`,
      body: 'Продаём дешевле себестоимости: ' + bad.slice(0, 3).map((p) => p.name).join(', ')
        + (bad.length > 3 ? '…' : '') + '. Поднять цену или пересчитать себестоимость.',
      link: '/calculation#summary', count: bad.length,
    });
  });

  await safe(async () => {
    if (!want('returns_as_sales') || !(await can('returns_as_sales', '/cash'))) return;
    const rows = await returnsAsSales(db.pool);
    if (!rows.length) return;
    items.push({
      key: 'returns_as_sales', title: `Касса: ${rows.length} поступлений похожи на возврат банка, а стоят как выручка`,
      body: 'Возврат нашего же платежа — не выручка, из-за него ERP расходится с CRM. Поставьте им статью того платежа, который вернулся.',
      link: '/cash#tx=' + rows[0].id, count: rows.length,
      items: rows.map((r) => `${r.d.split('-').reverse().join('.')} · ${mln(r.amount)} · ${String(r.purpose || '').slice(0, 90)}`),
    });
  });

  await safe(async () => {
    if (!want('unclassified') || !(await can('unclassified', '/cash'))) return;
    const u = await unclassified(db.pool);
    if (!u || !u.cnt) return;
    items.push({
      key: 'unclassified', title: `Касса: ${u.cnt} операций без статьи`,
      body: `На ${mln(u.amount)}. Пока они не разнесены, P&L и Кэш-флоу неполные.`,
      link: '/cash#triage', count: u.cnt,
    });
  });

  return items;
}

router.get('/api/todos', async (req, res) => {
  // Дела меняются, как только их сделали — браузер не должен показывать старый список.
  res.set('Cache-Control', 'no-store');
  res.json({ items: await todosFor(req.user) });
});

module.exports = router;
module.exports.todosFor = todosFor;
module.exports.refreshTodoState = refreshTodoState;
module.exports.TODO_KINDS = TODO_KINDS;
module.exports.noPriceItems = noPriceItems;
module.exports.stockNoPriceItems = stockNoPriceItems;
module.exports.unmatchedSold = unmatchedSold;
