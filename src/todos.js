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

// Операции Кассы без статьи — пока не разнесены, P&L и Кэш-флоу неполные.
async function unclassified(pool) {
  return (await pool.query(
    `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0) AS amount
       FROM cash_transactions
      WHERE category_id IS NULL AND tx_type IN ('in', 'out') AND source <> 'opening'
        AND tx_date >= CURRENT_DATE - $1::int`, [DAYS_BACK])).rows[0];
}

const mln = (v) => (Math.round((Number(v) || 0) / 1e5) / 10).toLocaleString('ru-RU') + ' млн';

router.get('/api/todos', async (req, res) => {
  const items = [];
  const safe = async (fn) => { try { await fn(); } catch (e) { console.warn('[ДЕЛА]', e.message); } };

  await safe(async () => {
    if (!(await hasTile(req.user, '/purchase'))) return;
    const rows = await noPriceItems(db.pool);
    if (!rows.length) return;
    const orders = new Set(rows.map((r) => r.order_id));
    const sup = [...new Set(rows.map((r) => r.supplier_name))].slice(0, 3).join(', ');
    items.push({
      key: 'noprice', title: `Внести цены в Закупе: ${rows.length} поз. без цены`,
      body: `${orders.size} принятых заявок (${sup}${orders.size > 3 ? '…' : ''}). Пока цены нет, сырьё в P&L и долг поставщику занижены.`,
      link: '/purchase#noprice', count: rows.length,
    });
  });

  await safe(async () => {
    if (!(await hasTile(req.user, '/calculation'))) return;
    const rows = await unmatchedSold(db.pool);
    if (!rows.length) return;
    items.push({
      key: 'calc', title: `Калькуляция: ${rows.length} товаров из продаж без пары`,
      body: 'Продаются, но в Калькуляции их нет: ' + rows.slice(0, 3).map((r) => r.name).join(', ') + (rows.length > 3 ? '…' : '')
        + '. Привяжите к товару Калькуляции.',
      link: '/calculation#missing', count: rows.length,
    });
  });

  await safe(async () => {
    if (!(await hasTile(req.user, '/cash'))) return;
    const u = await unclassified(db.pool);
    if (!u || !u.cnt) return;
    items.push({
      key: 'unclassified', title: `Касса: ${u.cnt} операций без статьи`,
      body: `На ${mln(u.amount)}. Пока они не разнесены, P&L и Кэш-флоу неполные.`,
      link: '/cash#triage', count: u.cnt,
    });
  });

  res.json({ items });
});

module.exports = router;
module.exports.noPriceItems = noPriceItems;
module.exports.unmatchedSold = unmatchedSold;
