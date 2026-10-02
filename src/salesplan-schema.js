// salesplan-schema.js — схема плитки «План продаж» (ГП: готовая продукция).
//
// ЖЁСТКИЕ ПРАВИЛА (CLAUDE.md, инварианты проекта):
//  • только добавочные операции: CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS;
//  • никаких DROP TABLE / TRUNCATE при старте;
//  • индексы — идемпотентно.
//
// Устройство (решения Шоха 02.10.2026):
//  • единица плана — ОДИН ДЕНЬ. Неделя, месяц и квартал — это виды одного и
//    того же набора дней, а не отдельные таблицы с отдельными цифрами. Иначе
//    на один месяц появятся две цифры (месячная и сумма недель) и они разойдутся;
//  • деньги считаются по ПРАЙС-ЛИСТУ SalesDoctor, который отдел продаж выбирает
//    сам на строке. Один товар можно положить в сетку дважды с разными прайсами —
//    так и получается «по какому прайсу какое количество», без новой сущности;
//  • пустая клетка и ноль — разные вещи. Нет записи = не заполнено, запись со
//    значением 0 = «запланировали ноль». В образце Excel это видно: у части
//    товаров семь нолей (в списке, но не планируем), а у «Набора для маставы»
//    нули и пустое воскресенье.

let _ready = false;

// Направления из рабочего файла. sd_trade — как это же направление называется
// в SalesDoctor: это КАТЕГОРИЯ товара (ref_categories), «Horeca» и «Розница».
// Поле «Направление торговли» не подошло — там бренд (Novagreen, NOVAGREEN VEG,
// Novagreen STM), проверено на живой базе 03.10.2026.
const CHANNELS = [
  { code: 'horeca', name: 'HoReCa', sd_trade: 'Horeca', sort_order: 10 },
  { code: 'retail', name: 'Розница', sd_trade: 'Розница', sort_order: 20 },
];

async function ensureSalesPlanSchema(pool) {
  if (_ready) return;
  const q = (sql, p) => pool.query(sql, p);

  // --- Направления -----------------------------------------------------------
  // Справочник в БД, а не список в коде: появится «Опт» или маркетплейс —
  // добавляется строкой, без передеплоя (правило проекта).
  await q(`CREATE TABLE IF NOT EXISTS sales_plan_channels (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sd_trade TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT TRUE
  )`);
  // Прайс-лист направления: цена берётся им для всех товаров сразу. Иначе РОП
  // выбирал бы прайс сорок раз подряд, хотя у направления он один и тот же.
  await q('ALTER TABLE sales_plan_channels ADD COLUMN IF NOT EXISTS default_price_type_id INTEGER')
    .catch((e) => console.error('[ПЛАН ПРОДАЖ] прайс направления:', e.message));
  for (const c of CHANNELS) {
    await q(
      `INSERT INTO sales_plan_channels (code, name, sd_trade, sort_order)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, sd_trade = EXCLUDED.sd_trade`,
      [c.code, c.name, c.sd_trade, c.sort_order]
    ).catch((e) => console.error('[ПЛАН ПРОДАЖ] направление ' + c.code + ':', e.message));
  }

  // --- Строки сетки ---------------------------------------------------------
  // Строка живёт постоянно, а не создаётся на каждую неделю: «что мы вообще
  // планируем продавать в этом направлении по этому прайсу». Товар — только из
  // ref_finished_goods (идентичность приходит из SalesDoctor), названием строки
  // товар не задаётся.
  await q(`CREATE TABLE IF NOT EXISTS sales_plan_rows (
    id SERIAL PRIMARY KEY,
    channel TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES ref_finished_goods(id) ON DELETE CASCADE,
    price_type_id INTEGER,                        -- прайс-лист SD (ref_price_types); NULL — прайс ещё не выбран
    sort_order INTEGER NOT NULL DEFAULT 100,
    note TEXT NOT NULL DEFAULT '',                -- «под заказом» и прочие договорённости: комментарий, а не поле-статус
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Один товар в одном направлении по одному прайсу — одна строка. COALESCE,
  // потому что в уникальном индексе два NULL считаются разными значениями.
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_plan_row
           ON sales_plan_rows (channel, product_id, COALESCE(price_type_id, 0))`)
    .catch((e) => console.error('[ПЛАН ПРОДАЖ] уникальность строки:', e.message));
  await q(`CREATE INDEX IF NOT EXISTS idx_sales_plan_rows_ch
           ON sales_plan_rows (channel, sort_order, id)`);

  // --- Клетки плана ---------------------------------------------------------
  // source — откуда цифра: руками, из факта, копией недели или импортом.
  // Нужно не для отчёта, а чтобы в подсказке клетки было видно, чья это цифра:
  // «мы так решили» и «так было в прошлый раз» — разные основания.
  await q(`CREATE TABLE IF NOT EXISTS sales_plan_cells (
    row_id INTEGER NOT NULL REFERENCES sales_plan_rows(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    qty NUMERIC NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',        -- manual | fact | copy | import
    updated_by INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (row_id, day)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_sales_plan_cells_day ON sales_plan_cells (day)`);

  _ready = true;
}

module.exports = { ensureSalesPlanSchema, CHANNELS };
// Для тестов: сброс флага «схема готова».
module.exports._reset = () => { _ready = false; };
