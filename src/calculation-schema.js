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

  // --- Группы калькуляции --------------------------------------------------
  // Это рабочие «листы» как в исходном Excel: Розница, HoReCa 250 г,
  // HoReCa 500 г и т. п. Общие коммерческие условия и упаковка задаются здесь
  // один раз, а не повторяются в каждой карточке изделия.
  await q(`CREATE TABLE IF NOT EXISTS calculation_groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT UNIQUE,
    price_includes_vat BOOLEAN NOT NULL DEFAULT true,
    vat_rate NUMERIC NOT NULL DEFAULT 12,
    retro_rate NUMERIC NOT NULL DEFAULT 0,
    profit_tax_rate NUMERIC NOT NULL DEFAULT 15,
    waste_reserve_rate NUMERIC NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active',
    comment TEXT DEFAULT '',
    created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_calc_groups_name_active
           ON calculation_groups (lower(name)) WHERE status = 'active'`)
    .catch((e) => console.error('calc uq group name:', e.message));

  // Стартовые рабочие вкладки взяты из фактической структуры Excel. Это не
  // массив-справочник в коде: после первого запуска записи живут и правятся в БД.
  await q(`INSERT INTO calculation_groups
           (name, code, price_includes_vat, vat_rate, retro_rate, profit_tax_rate, waste_reserve_rate, sort_order)
           VALUES
             ('Розница', 'retail', true, 12, 21, 15, 50, 10),
             ('HoReCa 250 г', 'horeca_250', true, 12, 0, 15, 50, 20),
             ('HoReCa 500 г', 'horeca_500', true, 12, 0, 15, 35, 30)
           ON CONFLICT DO NOTHING`);

  // Комплект упаковки группы: только существующие позиции ref_packaging.
  // Количество хранится на одну готовую единицу.
  await q(`CREATE TABLE IF NOT EXISTS calculation_group_packaging (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES calculation_groups(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL,
    qty NUMERIC NOT NULL DEFAULT 1,
    unit_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    comment TEXT DEFAULT '',
    UNIQUE (group_id, item_id)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_group_packaging_group
           ON calculation_group_packaging (group_id, sort_order, id)`);

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
  // Старые карточки остаются читаемыми. Группу пользователь назначает при
  // следующем редактировании; опасный автоматический выбор по названию не делаем.
  await q(`ALTER TABLE calculation_products ADD COLUMN IF NOT EXISTS group_id INTEGER`)
    .catch((e) => console.error('calc product group_id:', e.message));
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_products_group ON calculation_products (group_id, status)`);
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

  // --- Статьи затрат (экран «Затраты», аналог листа «Произодство» в Excel) ---
  // ВНИМАНИЕ: таблица calc_cost_items существует в базе с июля (прежняя версия
  // модуля) и содержит рабочие данные Шоха. Колонки там называются kind и sort.
  // Используем их КАК ЕСТЬ: переименование потеряло бы связь с существующими
  // строками, а CREATE TABLE IF NOT EXISTS с другими именами молча ничего не
  // создаёт — именно на этом расчёт и падал.
  await q(`CREATE TABLE IF NOT EXISTS calc_cost_items (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL,                          -- production (производственные) | overhead (накладные)
    name TEXT NOT NULL,
    amount NUMERIC NOT NULL DEFAULT 0,           -- сумма в месяц
    sort INT NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active',       -- active | archived
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Поля, которых в старой таблице нет. Только добавление колонок.
  // plan_amount — колонка «план» из Excel; cash_category_id — связь со статьёй
  // ДДС Кассы, чтобы колонка «фактич» заполнялась сама, а не переписывалась руками.
  for (const [col, type] of [
    ['comment', "TEXT DEFAULT ''"], ['updated_by', 'INTEGER'], ['updated_at', 'TIMESTAMPTZ'],
    ['plan_amount', 'NUMERIC'], ['cash_category_id', 'INTEGER'],
  ]) {
    await q(`ALTER TABLE calc_cost_items ADD COLUMN IF NOT EXISTS ${col} ${type}`)
      .catch((e) => console.error('calc_cost_items ' + col + ':', e.message));
  }
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_cost_items ON calc_cost_items (kind, sort, id)`);

  // Настройки калькуляции тоже живут с июля в calc_settings — там уже лежит
  // среднемесячный выпуск. Свою таблицу ради этого не заводим.
  await q(`CREATE TABLE IF NOT EXISTS calc_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by INT
  )`);
  await q(`INSERT INTO calc_settings (key, value) VALUES ('monthly_units', '55000') ON CONFLICT (key) DO NOTHING`);

  // Связь статьи затрат с НЕСКОЛЬКИМИ статьями ДДС Кассы.
  // Пример из жизни: административные расходы — это статьи 41–48, но не 40.
  // Одной колонки cash_category_id для этого мало, поэтому отдельная таблица.
  await q(`CREATE TABLE IF NOT EXISTS calc_cost_item_categories (
    item_id INTEGER NOT NULL REFERENCES calc_cost_items(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL,
    PRIMARY KEY (item_id, category_id)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_cost_item_cat ON calc_cost_item_categories (item_id)`);
  // Разовый перенос уже выбранных одиночных связей в новую таблицу.
  await q(`INSERT INTO calc_cost_item_categories (item_id, category_id)
           SELECT id, cash_category_id FROM calc_cost_items
            WHERE cash_category_id IS NOT NULL
           ON CONFLICT DO NOTHING`).catch((e) => console.error('calc cost cats migrate:', e.message));

  // Первое наполнение статьями из Excel — только если таблица пустая.
  // В рабочей базе строки уже есть, поэтому сид не сработает и ничего не затрёт.
  const has = await q('SELECT count(*)::int AS n FROM calc_cost_items');
  if (!Number(has.rows[0].n)) {
    await q(`INSERT INTO calc_cost_items (kind, name, amount, sort) VALUES
      ('production', 'Аренда', 11480800, 10),
      ('production', 'Электроэнергия и пр.', 4500000, 20),
      ('overhead', 'Сертификация и лаборатория', 1000000, 10),
      ('overhead', 'Логистика', 3500000, 20),
      ('overhead', 'Закупки для производства', 3000000, 30),
      ('overhead', 'Банковские услуги', 1300000, 40),
      ('overhead', 'Административные расходы', 7000000, 50),
      ('overhead', 'Маркетинг', 1200000, 60),
      ('overhead', 'Кредиты', 5227156, 70),
      ('overhead', 'Прочие (вода, канализация)', 312000, 80)`);
  }

  // --- Лист «Упаковка» -----------------------------------------------------
  // Обе таблицы существуют с июля, поэтому создаём их той же структурой и
  // только ДОБАВЛЯЕМ недостающие колонки — иначе CREATE IF NOT EXISTS молча
  // ничего не сделает, а запросы упадут (эту ошибку уже проходили).

  // таб1 в Excel: цены упаковочных материалов.
  // calc_price — цена в калькуляции (ручная), market_price — из Закупа.
  await q(`CREATE TABLE IF NOT EXISTS calc_material_prices (
    item_kind TEXT NOT NULL,
    item_id INT NOT NULL,
    calc_price NUMERIC,
    market_price NUMERIC,
    market_price_at DATE,
    comment TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by INT,
    PRIMARY KEY (item_kind, item_id)
  )`);
  // Как из цены закупки получается стоимость на одну упаковку.
  // В Excel это было спрятано в формуле (цена/1000*10) — выносим в явные поля.
  for (const [col, type] of [
    ['pack_basis', "TEXT NOT NULL DEFAULT 'piece'"],   // piece — цена за штуку | kg — цена за килограмм
    ['pack_consumption', 'NUMERIC NOT NULL DEFAULT 1'], // штук или граммов на одну упаковку
  ]) {
    await q(`ALTER TABLE calc_material_prices ADD COLUMN IF NOT EXISTS ${col} ${type}`)
      .catch((e) => console.error('calc_material_prices ' + col + ':', e.message));
  }

  // таб2 в Excel: комплекты упаковки (вак.пакет, хорека, бокс лагмана…).
  await q(`CREATE TABLE IF NOT EXISTS calc_pack_templates (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`ALTER TABLE calc_pack_templates ADD COLUMN IF NOT EXISTS sort INT NOT NULL DEFAULT 100`)
    .catch((e) => console.error('calc_pack_templates sort:', e.message));
  await q(`CREATE TABLE IF NOT EXISTS calc_pack_template_items (
    id SERIAL PRIMARY KEY,
    template_id INT NOT NULL REFERENCES calc_pack_templates(id) ON DELETE CASCADE,
    item_id INT,
    by_name BOOLEAN NOT NULL DEFAULT false,
    qty NUMERIC NOT NULL DEFAULT 1,
    sort INT NOT NULL DEFAULT 100
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_calc_pack_items ON calc_pack_template_items (template_id, sort, id)`);

  _ready = true;
}

module.exports = { ensureCalculationSchema };
