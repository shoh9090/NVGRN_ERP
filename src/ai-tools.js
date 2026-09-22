// ai-tools.js — что Джарвис умеет посмотреть в ERP, отвечая на вопрос словами.
//
// Каждый инструмент — это запрос к нашей базе, а НЕ рассуждение модели.
// У инструмента есть плитка: нет доступа к плитке — инструмент человеку не
// даётся вовсе, модель о нём даже не знает. Права те же, что на экране:
// РОП не видит закупочных цен ни в ERP, ни в боте.
//
// Личные инструменты (свои дела, своя зарплата) есть у всех — но показывают
// только данные самого спрашивающего.

const db = require('./db');

const money = (v) => Math.round(Number(v) || 0);
const EMPTY = { type: 'object', properties: {}, additionalProperties: false };

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

const period = (v) => (/^\d{4}-\d{2}$/.test(String(v || '')) ? String(v) : new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7));

const TOOLS = [
  {
    name: 'moi_dela',
    tile: null,
    description: 'Дела «Нужно внести», которые числятся за этим человеком в ERP: что он ещё не внёс и где это вносится.',
    schema: EMPTY,
    run: async (args, ctx) => {
      const items = await require('./todos').todosFor(ctx.user);
      return items.length ? items.map((i) => ({ дело: i.title, подробно: i.body, сколько: i.count }))
        : { итог: 'Дел нет — всё внесено' };
    },
  },
  {
    name: 'moi_kartochki_trello',
    tile: null,
    description: 'Карточки Trello этого человека: упоминания без ответа и просроченные сроки.',
    schema: EMPTY,
    run: async (args, ctx) => {
      if (!ctx.employee_id) return { итог: 'Человек не найден в Персонале' };
      const open = (await db.pool.query(
        `SELECT card_name, author_name, to_char(created_at, 'DD.MM') AS когда FROM jarvis_mentions
          WHERE employee_id = $1 AND answered_at IS NULL ORDER BY created_at LIMIT 20`, [ctx.employee_id])).rows;
      return { упоминания_без_ответа: open.length,
        список: open.map((m) => ({ карточка: m.card_name, упомянул: m.author_name, когда: m.когда })) };
    },
  },
  {
    name: 'ostatki_sklada',
    tile: '/stock',
    description: 'Остатки сырья и упаковки на складе (в единицах учёта). Можно искать по названию.',
    schema: { type: 'object', properties: { поиск: { type: 'string', description: 'часть названия, например «айсберг»' } }, additionalProperties: false },
    run: async (args) => {
      const q = String(args['поиск'] || '').trim();
      const p = [], w = ['COALESCE(mv.balance, 0) <> 0'];
      if (q) { p.push('%' + q + '%'); w.push(`m.name ILIKE $${p.length}`); }
      const rows = (await db.pool.query(
        `WITH mv AS (SELECT item_kind, item_id, SUM(qty) AS balance FROM stock_movements GROUP BY item_kind, item_id),
              m AS (SELECT 'raw' AS kind, id, name, unit_id FROM ref_raw_materials
                    UNION ALL SELECT 'packaging', id, name, unit_id FROM ref_packaging)
         SELECT m.name AS название, COALESCE(mv.balance, 0) AS остаток, u.short_name AS единица
           FROM m LEFT JOIN mv ON mv.item_kind = m.kind AND mv.item_id = m.id
           LEFT JOIN ref_units u ON u.id = m.unit_id
          WHERE ${w.join(' AND ')} ORDER BY m.name LIMIT 60`, p)).rows;
      return rows.length ? rows.map((r) => ({ ...r, остаток: Number(r.остаток) })) : { итог: 'Ничего не нашлось' };
    },
  },
  {
    name: 'dolg_postavshchikam',
    tile: '/purchase',
    description: 'Сколько мы должны поставщикам: список по убыванию долга и общая сумма, в сумах.',
    schema: { type: 'object', properties: { сколько: { type: 'number', description: 'сколько строк вернуть, по умолчанию 10' } }, additionalProperties: false },
    run: async (args) => {
      const rows = await require('./purchase-finance').supplierBalances({});
      const debt = rows.filter((r) => Number(r.balance) > 0).sort((a, b) => Number(b.balance) - Number(a.balance));
      const n = Math.min(Math.max(parseInt(args['сколько'], 10) || 10, 1), 30);
      return {
        всего_долг: money(debt.reduce((s, r) => s + Number(r.balance), 0)),
        поставщиков: debt.length,
        список: debt.slice(0, n).map((r) => ({ поставщик: r.name, долг: money(r.balance) })),
      };
    },
  },
  {
    name: 'ostatki_deneg',
    tile: '/cash',
    description: 'Остатки по кошелькам и счетам компании (Касса), в сумах.',
    schema: EMPTY,
    run: async () => {
      const w = await require('./cash').walletBalances();
      return { кошельки: w.map((x) => ({ название: x.name, остаток: money(x.balance != null ? x.balance : x.uzs) })),
        итого: money(w.reduce((s, x) => s + Number(x.balance != null ? x.balance : x.uzs || 0), 0)) };
    },
  },
  {
    name: 'prodazhi_za_mesyats',
    tile: '/cash',
    description: 'Продажи за месяц из SalesDoctor: выручка, количество единиц и топ товаров. Месяц в виде 2026-09.',
    schema: { type: 'object', properties: { месяц: { type: 'string', description: 'например 2026-09' } }, additionalProperties: false },
    run: async (args) => {
      const per = period(args['месяц']);
      const rows = (await db.pool.query('SELECT key, value FROM settings WHERE key = ANY($1)',
        [['pnl_sales_' + per, 'pnl_units_' + per, 'pnl_sku_' + per]])).rows;
      const by = new Map(rows.map((r) => [r.key, r.value]));
      let sku = [];
      try { sku = JSON.parse(by.get('pnl_sku_' + per) || '[]') || []; } catch (e) { sku = []; }
      const top = sku.map(([, qty, name]) => ({ товар: name, штук: Math.round(Number(qty) || 0) }))
        .sort((a, b) => b.штук - a.штук).slice(0, 10);
      const sales = Number(by.get('pnl_sales_' + per)) || 0;
      if (!sales && !top.length) return { месяц: per, итог: 'За этот месяц продажи из SalesDoctor ещё не подтянуты' };
      return { месяц: per, выручка: money(sales), единиц: Math.round(Number(by.get('pnl_units_' + per)) || 0), топ_товаров: top };
    },
  },
  {
    name: 'moya_zarplata',
    tile: null,
    description: 'Зарплата САМОГО спрашивающего за месяц: начислено, удержано, выплачено. Чужие зарплаты этот инструмент не показывает.',
    schema: { type: 'object', properties: { месяц: { type: 'string', description: 'например 2026-09' } }, additionalProperties: false },
    run: async (args, ctx) => {
      if (!ctx.employee_id) return { итог: 'Человек не найден в Персонале' };
      const per = period(args['месяц']);
      const r = (await db.pool.query(
        `SELECT * FROM hr_payroll WHERE employee_id = $1 AND period = $2`, [ctx.employee_id, per])).rows[0];
      if (!r || !r.accrued_at) return { месяц: per, итог: 'За этот месяц зарплата ещё не начислена' };
      const f = require('./hr-fields');
      const sum = (list) => list.reduce((s, k) => s + (Number(r[k]) || 0), 0);
      return {
        месяц: per,
        начислено: money(sum(f.ACCR_FIELDS)),
        удержано: money(sum(f.DED_SUM)),
        штрафы: money(r.ded_fine),
        выплачено: money((Number(r.paid_cash) || 0) + (Number(r.paid_card) || 0)),
      };
    },
  },
];

// Инструменты, доступные конкретному человеку.
async function toolsFor(user) {
  const out = [];
  for (const t of TOOLS) {
    if (t.tile && !(await hasTile(user, t.tile))) continue;
    out.push(t);
  }
  return out;
}

module.exports = { TOOLS, toolsFor, hasTile };
