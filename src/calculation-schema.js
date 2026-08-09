// calculation-schema.js — схема модуля «Калькуляция себестоимости» (ТЗ раздел 20).
//
// ЖЁСТКИЕ ПРАВИЛА (ТЗ 24, инварианты проекта):
//  • только добавочные операции: CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS;
//  • никаких DROP TABLE / TRUNCATE / удаления пользовательских данных при старте;
//  • старые черновые таблицы (calculation_expense_items, _rates, _channels, _flags)
//    НЕ удаляются: они остаются совместимыми и просто скрыты из нового интерфейса;
//  • все индексы создаются идемпотентно.

const { FORMULA_VERSION } = require('./calculation-engine');

let _ready = false;

async function ensureCalculationSchema(pool) {
  if (_ready) return;
  const q = (sql, p) => pool.query(sql, p);

  // --- Периоды: таблица уже существует, только расширяем (ТЗ 20.4) ---------
  await q(`CREATE TABLE IF NOT EXISTS calculation_periods (
    id SERIAL PRIMARY KEY,
    period TEXT NOT NULL UNIQUE,
    avg_monthly_output NUMERIC NOT NULL DEFAULT 0,
    vat_rate NUMERIC NOT NULL DEFAULT 12,
    profit_tax_rate NUMERIC NOT NULL DEFAULT 15,
    status TEXT NOT NULL DEFAULT 'draft',
    comment TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  // Новые поля периода. avg_monthly_output сохраняем для совместимости, но
  // источником правды он больше не является: выпуск = сумма строк изделий.
  const periodCols = [
    ['actual_status', "TEXT NOT NULL DEFAULT 'draft'"],   // draft | closed | reopened
    ['source_period', 'TEXT'],                             // базовый месяц источников (обычно = period)
    ['retro_rate_default', 'NUMERIC NOT NULL DEFAULT 0'],
    ['waste_reserve_default', 'NUMERIC NOT NULL DEFAULT 0'],
    ['price_round_step_default', 'NUMERIC NOT NULL DEFAULT 500'],
    ['draft_sources_json', 'JSONB'],
    ['created_by', 'INTEGER'],
    ['approved_by', 'INTEGER'],
    ['approved_at', 'TIMESTAMPTZ'],
    ['closed_by', 'INTEGER'],
    ['closed_at', 'TIMESTAMPTZ'],
  ];
  for (const [col, type] of periodCols) {
    await q(`ALTER TABLE calculation_periods ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch((e) => console.error('calc period col ' + col + ':', e.message));
  }

  // --- Изделия (ТЗ 20.1) ---------------------------------------------------
  await q(`CREATE TABLE IF NOT EXISTS calculation_products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    internal_code TEXT DEFAULT '',
    product_family TEXT NOT NULL DEFAULT 'mono',   -- mono | mix | bunch | pot | set | other
    linked_finished_good_id INTEGER,               -- необязательная ссылка на ref_finished_goods
    barcode TEXT DEFAULT '',
    output_unit_id INTEGER,
    output_unit_name TEXT DEFAULT '',              -- подпись выхода: штука, пучок, упаковка...
    net_weight NUMERIC,
    net_weight_unit_id INTEGER,
    -- коммерческие значения по умолчанию
    price NUMERIC,
    price_includes_vat BOOLEAN NOT NULL DEFAULT true,
    vat_rate NUMERIC,
    retro_rate NUMERIC NOT NULL DEFAULT 0,
    profit_tax_rate NUMERIC,
    target_margin_rate NUMERIC,
    price_round_step NUMERIC NOT NULL DEFAULT 500,
    waste_reserve_rate NUMERIC NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',         -- active | archived
    comment TEXT DEFAULT '',
    created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Уникальность названия среди активных изделий, без учёта регистра (ТЗ 12.1).
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_calc_products_name_active
           ON calculation_products (lower(name)) WHERE status = 'active'`).catch((e) => console.error('calc uq name:', e.message));
  // Одно изделие ERP не связывается с двумя активными карточками (ТЗ 12.1).
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_calc_products_linked_active
           ON calculation_products (linked_finished_good_id)
           WHERE status = 'active' AND linked_finished_good_id IS NOT NULL`).catch((e) => console.error('calc uq linked:', e.message));

  // --- Рецептуры (ТЗ 20.2) -------------------------------------------------
  await q(`CREATE TABLE IF NOT EXISTS calculation_recipes (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES calculation_products(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL DEFAULT 1,
    batch_output_qty NUMERIC NOT NULL DEFAULT 1,   -- на сколько единиц введены компоненты
    status TEXT NOT NULL DEFAULT 'draft',          -- draft | approved | archived
    valid_from DATE,
    valid_to DATE,
    formula_version TEXT NOT NULL DEFAULT '${FORMULA_VERSION}',
    comment TEXT DEFAULT '',
    created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by INTEGER, approved_at TIMESTAMPTZ,
    UNIQUE (product_id, version_no)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_recipes_product ON calculation_recipes (product_id, status)`);

  // --- Компоненты рецептуры (ТЗ 20.3) -------------------------------------
  // Внешний ключ на разные таблицы по item_kind не создаётся: существование
  // позиции проверяет сервер в транзакции.
  await q(`CREATE TABLE IF NOT EXISTS calculation_recipe_items (
    id SERIAL PRIMARY KEY,
    recipe_id INTEGER NOT NULL REFERENCES calculation_recipes(id) ON DELETE CASCADE,
    item_kind TEXT NOT NULL,                       -- raw | packaging
    item_id INTEGER NOT NULL,
    qty_net NUMERIC NOT NULL,
    unit_id INTEGER,
    loss_rate NUMERIC NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    comment TEXT DEFAULT ''
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_recipe_items ON calculation_recipe_items (recipe_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_recipe_items_item ON calculation_recipe_items (item_kind, item_id)`);

  // --- Плановый и фактический выпуск по изделиям (ТЗ 20.5) -----------------
  await q(`CREATE TABLE IF NOT EXISTS calculation_period_products (
    id SERIAL PRIMARY KEY,
    period_id INTEGER NOT NULL REFERENCES calculation_periods(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES calculation_products(id) ON DELETE CASCADE,
    planned_output_qty NUMERIC NOT NULL DEFAULT 0,
    actual_output_qty NUMERIC,
    actual_source TEXT NOT NULL DEFAULT 'manual',
    actual_comment TEXT DEFAULT '',
    actual_updated_by INTEGER, actual_updated_at TIMESTAMPTZ,
    UNIQUE (period_id, product_id)
  )`);

  // --- Версии (ТЗ 20.6) ----------------------------------------------------
  await q(`CREATE TABLE IF NOT EXISTS calculation_versions (
    id SERIAL PRIMARY KEY,
    period_id INTEGER NOT NULL REFERENCES calculation_periods(id) ON DELETE CASCADE,
    version_kind TEXT NOT NULL,                    -- approved | actual
    revision_no INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',         -- active | closed | archived
    common_inputs_json JSONB,
    common_sources_json JSONB,                     -- ФОТ, налоги, расходы Кассы и расшифровка
    formula_version TEXT NOT NULL DEFAULT '${FORMULA_VERSION}',
    comment TEXT DEFAULT '',
    created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by INTEGER, approved_at TIMESTAMPTZ,
    closed_by INTEGER, closed_at TIMESTAMPTZ,
    UNIQUE (period_id, version_kind, revision_no)
  )`);
  // Одновременно действующей может быть только одна утверждённая версия (ТЗ 20.6).
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_calc_versions_one_active
           ON calculation_versions (version_kind) WHERE status = 'active' AND version_kind = 'approved'`)
    .catch((e) => console.error('calc uq active version:', e.message));

  // --- Снимки расчёта изделия (ТЗ 20.7) -----------------------------------
  await q(`CREATE TABLE IF NOT EXISTS calculation_snapshots (
    id SERIAL PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES calculation_versions(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES calculation_products(id) ON DELETE CASCADE,
    recipe_id INTEGER,
    inputs_json JSONB,
    sources_json JSONB,
    result_json JSONB,
    formula_version TEXT NOT NULL DEFAULT '${FORMULA_VERSION}',
    created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (version_id, product_id)
  )`);

  // --- Модели (ТЗ 20.8) ---------------------------------------------------
  await q(`CREATE TABLE IF NOT EXISTS calculation_models (
    id SERIAL PRIMARY KEY,
    base_snapshot_id INTEGER,
    product_id INTEGER,                            -- NULL для общего сценария дефицита
    model_type TEXT NOT NULL DEFAULT 'product',    -- product | shortage
    name TEXT NOT NULL,
    inputs_json JSONB,
    result_json JSONB,
    status TEXT NOT NULL DEFAULT 'active',         -- active | archived
    comment TEXT DEFAULT '',
    created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_models_product ON calculation_models (product_id, status)`);

  // --- История изменения закупочных цен для уведомлений (ТЗ 16) -----------
  // Хранит последнюю известную принятую цену позиции, чтобы поймать её изменение.
  await q(`CREATE TABLE IF NOT EXISTS calculation_price_watch (
    item_kind TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    last_price NUMERIC,
    last_price_date DATE,
    last_order_id INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (item_kind, item_id)
  )`);

  _ready = true;
}

module.exports = { ensureCalculationSchema };
