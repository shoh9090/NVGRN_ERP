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
const today = () => new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
const day = (v, def) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : def);

// Джарвис должен пересказывать уже собранный P&L, а не выбирать из него свои
// строки. cogs.fact — это только контроль складских выдач; в прибыль входит
// единая итоговая себестоимость cogs_total (сырьё из Закупа + упаковка).
function pnlAnswer(p, per) {
  const n = (v) => (v === null || v === undefined ? null : money(v));
  return {
    месяц: per,
    выручка: n(p.revenue && p.revenue.total),
    себестоимость: n(p.cogs_total),
    операционные_расходы: n(p.opex && p.opex.total),
    валовая_прибыль: n(p.gross_profit),
    операционная_прибыль: n(p.operating_profit),
    чистая_прибыль: n(p.net_profit),
    маржа_валовая_процент: p.gross_margin_pct === null ? null : Math.round(p.gross_margin_pct),
    примечание: p.net_profit === null ? 'Прибыль не считается: не хватает данных за месяц' : undefined,
  };
}

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
    schema: { type: 'object', properties: { query: { type: 'string', description: 'часть названия, например «айсберг»' } }, additionalProperties: false },
    run: async (args) => {
      const q = String(args.query || '').trim();
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
    schema: { type: 'object', properties: { limit: { type: 'number', description: 'сколько строк вернуть, по умолчанию 10' } }, additionalProperties: false },
    run: async (args) => {
      const rows = await require('./purchase-finance').supplierBalances({});
      const debt = rows.filter((r) => Number(r.balance) > 0).sort((a, b) => Number(b.balance) - Number(a.balance));
      const n = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
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
    schema: { type: 'object', properties: { month: { type: 'string', description: 'месяц в виде 2026-09' } }, additionalProperties: false },
    run: async (args) => {
      const per = period(args.month);
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
    name: 'prodazhi_po_klientam',
    tile: ['/cash', '/tgbot'],
    description: 'Продажи по клиентам за период из нашей копии SalesDoctor: кто сколько взял, в штуках и сумах. Даты в виде 2026-09-01.',
    schema: { type: 'object', properties: {
      from: { type: 'string', description: 'с какой даты' },
      to: { type: 'string', description: 'по какую дату' },
      client: { type: 'string', description: 'часть названия клиента, если нужен один' },
      limit: { type: 'number', description: 'сколько клиентов вернуть, по умолчанию 10' },
    }, additionalProperties: false },
    run: async (args) => {
      const sd = require('./sd-sales');
      const cov = await sd.coverage();
      const to = day(args.to, cov.last_day || today());
      const from = day(args.from, to.slice(0, 8) + '01');
      const p = [from, to];
      let w = '';
      if (String(args.client || '').trim()) { p.push('%' + String(args.client).trim() + '%'); w = ` AND client_name ILIKE $${p.length}`; }
      const n = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
      const rows = (await db.pool.query(
        `SELECT client_name AS клиент, SUM(qty)::numeric AS штук, SUM(amount - returned)::numeric AS сумма
           FROM sd_sales WHERE day BETWEEN $1 AND $2${w}
          GROUP BY client_name ORDER BY 3 DESC LIMIT ${n}`, p)).rows;
      if (!rows.length) {
        return { период: `${from} — ${to}`, итог: cov.days ? 'Продаж за этот период нет'
          : 'Продажи из SalesDoctor ещё не выгружены — идёт первичная заливка' };
      }
      return { период: `${from} — ${to}`, выгружено_по: cov.last_day,
        клиенты: rows.map((r) => ({ клиент: r.клиент, штук: Math.round(Number(r.штук)), сумма: money(r.сумма) })) };
    },
  },
  {
    name: 'dinamika_klienta',
    tile: ['/cash', '/tgbot'],
    description: 'Как менялись закупки клиента по неделям или месяцам: растёт или падает. Нужен кусок названия клиента.',
    schema: { type: 'object', properties: {
      client: { type: 'string', description: 'часть названия клиента, например «korzinka»' },
      weeks: { type: 'number', description: 'сколько недель назад смотреть, по умолчанию 8' },
    }, additionalProperties: false },
    run: async (args) => {
      const q = String(args.client || '').trim();
      if (!q) return { итог: 'Не указан клиент' };
      const weeks = Math.min(Math.max(parseInt(args.weeks, 10) || 8, 2), 52);
      const rows = (await db.pool.query(
        `SELECT to_char(date_trunc('week', day), 'DD.MM') AS неделя,
                SUM(qty)::numeric AS штук, SUM(amount - returned)::numeric AS сумма
           FROM sd_sales
          WHERE client_name ILIKE $1 AND day > CURRENT_DATE - ($2 * 7)::int
          GROUP BY date_trunc('week', day) ORDER BY date_trunc('week', day)`, ['%' + q + '%', weeks])).rows;
      if (!rows.length) return { клиент: q, итог: 'По этому клиенту продаж в выгрузке нет' };
      return { клиент: q, по_неделям: rows.map((r) => ({ неделя: r.неделя, штук: Math.round(Number(r.штук)), сумма: money(r.сумма) })) };
    },
  },
  {
    name: 'pribyl_za_mesyats',
    tile: '/cash',
    description: 'Итоги месяца из P&L: выручка, себестоимость, операционные расходы, валовая и чистая прибыль. Месяц в виде 2026-09.',
    schema: { type: 'object', properties: { month: { type: 'string', description: 'месяц в виде 2026-09' } }, additionalProperties: false },
    run: async (args) => {
      const per = period(args.month);
      const p = await require('./cash-pnl').buildPnl(db.pool, per);
      return pnlAnswer(p, per);
    },
  },
  {
    name: 'pretenzii',
    tile: '/complaints',
    description: 'Претензии клиентов за период: сколько всего, сколько не закрыто, по каким товарам и типам, топ точек. Даты в виде 2026-09-01.',
    schema: { type: 'object', properties: {
      from: { type: 'string', description: 'с какой даты, 2026-09-01' },
      to: { type: 'string', description: 'по какую дату, 2026-09-30' },
    }, additionalProperties: false },
    run: async (args) => {
      const d = (v, def) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : def);
      const to = d(args.to, new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10));
      const from = d(args.from, to.slice(0, 8) + '01');
      const rows = (await db.pool.query(
        `SELECT c.complaint_type, c.product_name, c.point_name, c.status, c.link_code,
                COALESCE(t.label_ru, c.complaint_type) AS тип
           FROM tgbot.complaints c
           LEFT JOIN tgbot.complaint_dicts t ON t.kind = 'type' AND t.code = c.complaint_type
          WHERE c.created_at::date BETWEEN $1 AND $2`, [from, to])).rows;
      if (!rows.length) return { период: `${from} — ${to}`, итог: 'Претензий за этот период нет' };
      const top = (field) => {
        const m = new Map();
        rows.forEach((r) => { const k = r[field] || '—'; m.set(k, (m.get(k) || 0) + 1); });
        return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => ({ что: k, сколько: n }));
      };
      return {
        период: `${from} — ${to}`,
        всего: rows.length,
        не_закрыто: rows.filter((r) => r.status !== 'resolved').length,
        по_типам: top('тип'),
        по_товарам: top('product_name'),
        по_точкам: top('point_name'),
      };
    },
  },
  {
    name: 'zayavki_zakupa',
    tile: '/purchase',
    description: 'Заявки в Закупе: что заказано и ещё не принято, ближайшие поставки, сколько принято за последние дни.',
    schema: { type: 'object', properties: { days: { type: 'number', description: 'за сколько дней смотреть приёмки, по умолчанию 7' } }, additionalProperties: false },
    run: async (args) => {
      const days = Math.min(Math.max(parseInt(args.days, 10) || 7, 1), 60);
      const open = (await db.pool.query(
        `SELECT po.number, c.name AS поставщик, to_char(po.delivery_date, 'DD.MM') AS поставка,
                COALESCE(SUM(i.qty * i.price), 0) AS сумма
           FROM purchase_orders po JOIN ref_counterparties c ON c.id = po.supplier_id
           LEFT JOIN purchase_order_items i ON i.order_id = po.id
          WHERE po.status = 'ordered'
          GROUP BY po.id, c.name ORDER BY po.delivery_date LIMIT 20`)).rows;
      const got = (await db.pool.query(
        `SELECT COUNT(DISTINCT po.id)::int AS заявок, COALESCE(SUM(i.fact_qty * i.price), 0) AS сумма
           FROM purchase_orders po JOIN purchase_order_items i ON i.order_id = po.id
          WHERE po.status = 'received' AND po.delivery_date >= CURRENT_DATE - $1::int`, [days])).rows[0];
      return {
        заказано_ждём_приёмки: open.map((r) => ({ ...r, сумма: money(r.сумма) })),
        принято_за_дней: days,
        принято_заявок: got.заявок,
        принято_на_сумму: money(got.сумма),
      };
    },
  },
  {
    name: 'moy_tabel',
    tile: null,
    description: 'Табель САМОГО спрашивающего за месяц: сколько отработано дней и часов, отпуска и больничные.',
    schema: { type: 'object', properties: { month: { type: 'string', description: 'месяц в виде 2026-09' } }, additionalProperties: false },
    run: async (args, ctx) => {
      if (!ctx.employee_id) return { итог: 'Человек не найден в Персонале' };
      const per = period(args.month);
      const rows = (await db.pool.query(
        `SELECT mark, COUNT(*)::int AS дней, COALESCE(SUM(hours), 0) AS часов
           FROM hr_timesheet WHERE employee_id = $1 AND to_char(work_date, 'YYYY-MM') = $2
          GROUP BY mark`, [ctx.employee_id, per])).rows;
      if (!rows.length) return { месяц: per, итог: 'За этот месяц отметок в табеле нет' };
      const NAME = { work: 'работал', off: 'выходной', vacation: 'отпуск', sick: 'больничный', absent: 'прогул' };
      return { месяц: per, строки: rows.map((r) => ({ что: NAME[r.mark] || r.mark, дней: r.дней, часов: Number(r.часов) })) };
    },
  },
  {
    name: 'moi_narusheniya',
    tile: null,
    description: 'Что Джарвис записал САМОМУ спрашивающему: напоминания и нарушения по Trello за период.',
    schema: { type: 'object', properties: { days: { type: 'number', description: 'за сколько дней, по умолчанию 30' } }, additionalProperties: false },
    run: async (args, ctx) => {
      if (!ctx.employee_id) return { итог: 'Человек не найден в Персонале' };
      const days = Math.min(Math.max(parseInt(args.days, 10) || 30, 1), 180);
      const rows = (await db.pool.query(
        `SELECT kind, card_name, text, to_char(created_at, 'DD.MM') AS когда FROM jarvis_log
          WHERE employee_id = $1 AND created_at > now() - ($2 || ' days')::interval
            AND kind IN ('violation_mention', 'violation_overdue', 'violation_no_due', 'remind_mention', 'remind_no_due')
          ORDER BY created_at DESC LIMIT 30`, [ctx.employee_id, String(days)])).rows;
      const NAME = { violation_mention: 'нарушение: не ответил', violation_overdue: 'нарушение: просрочка',
        violation_no_due: 'нарушение: нет срока', remind_mention: 'напоминание об упоминании', remind_no_due: 'спросили срок' };
      return {
        за_дней: days,
        нарушений: rows.filter((r) => r.kind.startsWith('violation')).length,
        напоминаний: rows.filter((r) => r.kind.startsWith('remind')).length,
        список: rows.map((r) => ({ что: NAME[r.kind] || r.kind, карточка: r.card_name, когда: r.когда })),
        примечание: 'Штрафы пока не начисляются',
      };
    },
  },
  {
    name: 'moya_zarplata',
    tile: null,
    description: 'Зарплата САМОГО спрашивающего за месяц: начислено, удержано, выплачено. Чужие зарплаты этот инструмент не показывает.',
    schema: { type: 'object', properties: { month: { type: 'string', description: 'месяц в виде 2026-09' } }, additionalProperties: false },
    run: async (args, ctx) => {
      if (!ctx.employee_id) return { итог: 'Человек не найден в Персонале' };
      const per = period(args.month);
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
    // У инструмента может быть несколько плиток: продажи по клиентам нужны и
    // финансам (Касса), и РОПу (Бот HoReCa) — достаточно любой из них.
    const tiles = t.tile ? [].concat(t.tile) : [];
    if (tiles.length) {
      let ok = false;
      for (const url of tiles) if (await hasTile(user, url)) { ok = true; break; }
      if (!ok) continue;
    }
    out.push(t);
  }
  return out;
}

module.exports = { TOOLS, toolsFor, hasTile, pnlAnswer };
