// db.js — подключение к PostgreSQL, миграции и стартовые данные
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  is_admin BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS tiles (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  icon TEXT DEFAULT '🧩',
  url TEXT NOT NULL,
  open_new_tab BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 100,
  is_visible BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS role_tiles (
  role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
  tile_id INTEGER REFERENCES tiles(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, tile_id)
);

-- Общие справочники ядра (раздел 4 ТЗ)
CREATE TABLE IF NOT EXISTS counterparties (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  inn TEXT DEFAULT '',
  note TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS units (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  short_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  unit_id INTEGER REFERENCES units(id),
  note TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT TRUE
);

-- ===== Блок «Закуп» =====
CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL,
  status TEXT DEFAULT 'draft', -- draft | ordered | received | cancelled
  payment_type TEXT DEFAULT 'перечисление', -- перечисление | наличка
  delivery_date DATE,
  delivery_window TEXT DEFAULT '',
  receipt_status TEXT DEFAULT 'pending', -- pending | received | partial | not_arrived | rejected
  temperature TEXT DEFAULT '',
  receipt_comment TEXT DEFAULT '',
  receipt_reason TEXT DEFAULT '',
  comment TEXT DEFAULT '',
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  ordered_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  received_by INTEGER
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL, -- raw | packaging
  item_id INTEGER NOT NULL,
  qty NUMERIC DEFAULT 0,
  price NUMERIC DEFAULT 0,
  fact_qty NUMERIC,
  fact_price NUMERIC
);

CREATE TABLE IF NOT EXISTS supplier_materials (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER NOT NULL,
  item_kind TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  UNIQUE (supplier_id, item_kind, item_id)
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER NOT NULL,
  amount NUMERIC NOT NULL,
  payment_type TEXT DEFAULT 'перечисление',
  paid_at DATE DEFAULT CURRENT_DATE,
  comment TEXT DEFAULT '',
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Спецификации на продукт (физические параметры, правятся в любой момент)
CREATE TABLE IF NOT EXISTS specifications (
  id SERIAL PRIMARY KEY,
  item_kind TEXT NOT NULL DEFAULT 'raw',
  item_id INTEGER NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by INTEGER,
  UNIQUE (item_kind, item_id)
);
CREATE TABLE IF NOT EXISTS specification_params (
  id SERIAL PRIMARY KEY,
  spec_id INTEGER REFERENCES specifications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,           -- «Размер листа», «Масса кочана», «Цвет»
  ptype TEXT NOT NULL DEFAULT 'range', -- range (числовой коридор) | quality (качественный ✓/✗)
  min_val NUMERIC,
  max_val NUMERIC,
  unit TEXT DEFAULT '',         -- см, г, ...
  target TEXT DEFAULT '',       -- для качественного: «насыщенно-зелёный», «не вялый»
  sort_order INTEGER DEFAULT 0
);

-- Результаты проверки спецификации при приёмке
CREATE TABLE IF NOT EXISTS receipt_param_checks (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL,
  item_id INTEGER,              -- позиция заявки (purchase_order_items.id)
  param_name TEXT NOT NULL,
  ptype TEXT,
  measured TEXT DEFAULT '',     -- замер кладовщика (число или текст)
  passed BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Справочник причин (брак, недопоставка, отклонение спеки)
CREATE TABLE IF NOT EXISTS reject_reasons (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT DEFAULT 'receipt', -- receipt | spec | issue
  sort_order INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active'
);

-- Уведомления (колокольчик, принцип Trello)
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  recipient_role TEXT,          -- кому по роли: purchaser | manager | warehouse | NULL=всем
  recipient_user_id INTEGER,    -- либо конкретному пользователю
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  kind TEXT DEFAULT 'info',     -- info | success | warning
  link TEXT DEFAULT '',
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications (is_read, created_at DESC);
-- Ключ дедупликации: не создавать одно и то же напоминание повторно
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedup_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_dedup ON notifications (dedup_key) WHERE dedup_key IS NOT NULL;

-- Передача сырья в производство
CREATE TABLE IF NOT EXISTS production_issues (
  id SERIAL PRIMARY KEY,
  area TEXT NOT NULL,           -- производственная зона
  status TEXT DEFAULT 'pending', -- pending | accepted | accepted_diff | rejected | overdue | cancelled
  issued_at DATE DEFAULT CURRENT_DATE,
  comment TEXT DEFAULT '',
  reject_reason TEXT DEFAULT '',
  confirmed_at TIMESTAMPTZ,
  confirmed_by INTEGER,
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_issue_items (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES production_issues(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL DEFAULT 'raw',
  item_id INTEGER NOT NULL,
  qty NUMERIC NOT NULL,         -- сколько указал склад
  fact_qty NUMERIC,             -- сколько принято производством
  diff_comment TEXT DEFAULT ''  -- комментарий к расхождению
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  item_kind TEXT NOT NULL DEFAULT 'raw',   -- raw | packaging
  item_id INTEGER NOT NULL,
  qty NUMERIC NOT NULL,                     -- + приход, - расход
  direction TEXT NOT NULL,                  -- in | out | adjust
  reason TEXT NOT NULL,                     -- receive | writeoff | adjust | return
  price NUMERIC,                            -- цена прихода (для оценки запаса)
  ref_type TEXT,                            -- purchase_order | manual
  ref_id INTEGER,
  comment TEXT DEFAULT '',
  moved_at DATE DEFAULT CURRENT_DATE,
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_mov_item ON stock_movements (item_kind, item_id);

CREATE TABLE IF NOT EXISTS price_history_import (
  id SERIAL PRIMARY KEY,
  item_kind TEXT NOT NULL DEFAULT 'raw',
  item_id INTEGER NOT NULL,
  price_date DATE NOT NULL,
  price NUMERIC NOT NULL,
  source TEXT DEFAULT 'import',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (item_kind, item_id, price_date, source)
);

-- Журнал действий (минимальный, расширяется на Этапе 5)
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

// Однократное слияние дублей единиц измерения (Штука/Штук/шт. → шт)
async function mergeDuplicateUnits() {
  const { normalizeUnit } = require('./units-util');
  const units = await pool.query('SELECT id, name, short_name FROM ref_units ORDER BY id');
  const keep = {}; // нормализованный ключ → id
  for (const u of units.rows) {
    const key = normalizeUnit(u.short_name || u.name);
    if (!key) continue;
    if (!(key in keep)) {
      keep[key] = u.id;
      // приводим короткое имя к каноничному виду
      if ((u.short_name || '').toLowerCase() !== key) {
        await pool.query('UPDATE ref_units SET short_name = $1 WHERE id = $2', [key, u.id]);
      }
    } else {
      const target = keep[key];
      for (const tbl of ['ref_raw_materials', 'ref_finished_goods', 'ref_packaging']) {
        await pool.query(`UPDATE ${tbl} SET unit_id = $1 WHERE unit_id = $2`, [target, u.id]).catch(() => {});
      }
      await pool.query('DELETE FROM ref_units WHERE id = $1', [u.id]);
      console.log(`[units] дубль «${u.short_name || u.name}» слит с «${key}»`);
    }
  }
}

async function migrate() {
  await pool.query(MIGRATIONS);
  // Таблицы модуля «Справочники» (генерируются из схем ТЗ)
  const { allCreateSQL, allAlterSQL } = require('./refs-config');
  await pool.query(allCreateSQL());
  await pool.query(allAlterSQL());
  // миграции колонок блока закупа/склада (для уже существующих баз)
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_date DATE").catch(()=>{});
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS receipt_status TEXT DEFAULT 'pending'").catch(()=>{});
  await pool.query("ALTER TABLE production_issues ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'").catch(()=>{});
  await pool.query("ALTER TABLE production_issues ADD COLUMN IF NOT EXISTS reject_reason TEXT DEFAULT ''").catch(()=>{});
  await pool.query("ALTER TABLE production_issues ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ").catch(()=>{});
  await pool.query("ALTER TABLE production_issues ADD COLUMN IF NOT EXISTS confirmed_by INTEGER").catch(()=>{});
  await pool.query("ALTER TABLE production_issue_items ADD COLUMN IF NOT EXISTS fact_qty NUMERIC").catch(()=>{});
  await pool.query("ALTER TABLE production_issue_items ADD COLUMN IF NOT EXISTS diff_comment TEXT DEFAULT ''").catch(()=>{});
  // Отход-подноменклатура: бесплатная парная карточка сырья, создаётся автоматически при приёмке.
  // is_waste — это карточка отхода; waste_of_id — на какой основной товар она ссылается.
  await pool.query("ALTER TABLE ref_raw_materials ADD COLUMN IF NOT EXISTS is_waste BOOLEAN NOT NULL DEFAULT false").catch(()=>{});
  await pool.query("ALTER TABLE ref_raw_materials ADD COLUMN IF NOT EXISTS waste_of_id INTEGER").catch(()=>{});
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_window TEXT DEFAULT ''").catch(()=>{});
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS temperature TEXT DEFAULT ''").catch(()=>{});
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS receipt_comment TEXT DEFAULT ''").catch(()=>{});
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS receipt_reason TEXT DEFAULT ''").catch(()=>{});
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_window TEXT DEFAULT ''").catch(()=>{});
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS temperature TEXT DEFAULT ''").catch(()=>{});
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS receipt_comment TEXT DEFAULT ''").catch(()=>{});
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS receipt_reason TEXT DEFAULT ''").catch(()=>{});
  // Условия оплаты на уровне заявки (ТЗ «Закуп»): условие + дни отсрочки. payment_type уже есть.
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS pay_condition TEXT DEFAULT 'on_fact'").catch(()=>{}); // prepay | on_fact | defer
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS defer_days INTEGER DEFAULT 0").catch(()=>{});
  // Условия оплаты по умолчанию в карточке поставщика (подставляются в новую заявку).
  await pool.query("ALTER TABLE ref_counterparties ADD COLUMN IF NOT EXISTS def_payment_type TEXT").catch(()=>{});
  await pool.query("ALTER TABLE ref_counterparties ADD COLUMN IF NOT EXISTS def_pay_condition TEXT").catch(()=>{});
  await pool.query("ALTER TABLE ref_counterparties ADD COLUMN IF NOT EXISTS def_defer_days INTEGER").catch(()=>{});
  // Привязка оплаты поставщику к конкретной заявке (иначе аванс). Для взаиморасчётов по заявкам.
  await pool.query("ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS order_id INTEGER").catch(()=>{});
  // Связь оплаты поставщику с денежной операцией Кассы (Обязательства, Этап 3) — против двойного учёта.
  await pool.query("ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS cash_transaction_id INTEGER").catch(()=>{});
  // Оплата в валюте: amount всегда хранит сум-эквивалент (взаиморасчёты в сумах), а currency/fx_rate/fx_amount —
  // для отображения (в чём и по какому курсу платили). По умолчанию сумы.
  await pool.query("ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'UZS'").catch(()=>{});
  await pool.query("ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS fx_rate NUMERIC").catch(()=>{});
  await pool.query("ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS fx_amount NUMERIC").catch(()=>{});

  // ===== Обязательства: банковские кредиты и займы (Касса → Обязательства, Этап 2) =====
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_obligations (
    id SERIAL PRIMARY KEY,
    obligation_type TEXT NOT NULL DEFAULT 'bank_loan',   -- bank_loan | concept_loan | investment_loan | founder_loan | other_loan
    creditor_name TEXT NOT NULL,
    counterparty_id INTEGER,
    agreement_number TEXT DEFAULT '',
    agreement_date DATE,
    date_start DATE,
    date_end DATE,
    currency TEXT NOT NULL DEFAULT 'UZS',
    principal_limit NUMERIC DEFAULT 0,
    principal_received NUMERIC DEFAULT 0,
    annual_rate NUMERIC DEFAULT 0,
    repayment_scheme TEXT DEFAULT 'annuity',             -- annuity | differentiated | equal_principal | bullet | interest_only | custom
    first_payment_date DATE,
    payment_day INTEGER,
    grace_period_months INTEGER DEFAULT 0,
    wallet_id INTEGER,
    status TEXT NOT NULL DEFAULT 'draft',                -- draft | active | closed | overdue | restructured | cancelled
    comment TEXT DEFAULT '',
    created_by INTEGER, created_at TIMESTAMPTZ DEFAULT now(),
    updated_by INTEGER, updated_at TIMESTAMPTZ DEFAULT now()
  )`).catch((e)=>console.error('fin_obl:', e.message));
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_obligation_tranches (
    id SERIAL PRIMARY KEY,
    obligation_id INTEGER REFERENCES finance_obligations(id) ON DELETE CASCADE,
    tranche_no INTEGER DEFAULT 1,
    received_date DATE,
    amount NUMERIC DEFAULT 0,
    currency TEXT DEFAULT 'UZS',
    due_date DATE,
    cash_transaction_id INTEGER,
    status TEXT DEFAULT 'received',
    created_at TIMESTAMPTZ DEFAULT now()
  )`).catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_obligation_schedule (
    id SERIAL PRIMARY KEY,
    obligation_id INTEGER REFERENCES finance_obligations(id) ON DELETE CASCADE,
    tranche_id INTEGER,
    version_no INTEGER DEFAULT 1,
    installment_no INTEGER,
    due_date DATE,
    opening_principal NUMERIC DEFAULT 0,
    principal_due NUMERIC DEFAULT 0,
    interest_due NUMERIC DEFAULT 0,
    fee_due NUMERIC DEFAULT 0,
    total_due NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'planned',                       -- planned | soon | today | partial | paid | overdue | rescheduled | cancelled
    rescheduled_from_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
  )`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fos_obl ON finance_obligation_schedule(obligation_id, version_no)`).catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_obligation_payment_links (
    id SERIAL PRIMARY KEY,
    schedule_id INTEGER,
    obligation_id INTEGER,
    cash_transaction_id INTEGER,
    payment_date DATE,
    principal_paid NUMERIC DEFAULT 0,
    interest_paid NUMERIC DEFAULT 0,
    fee_paid NUMERIC DEFAULT 0,
    created_by INTEGER, created_at TIMESTAMPTZ DEFAULT now(),
    reversed_at TIMESTAMPTZ, reversed_by INTEGER, reversal_reason TEXT
  )`).catch(()=>{});
  // Валютные обязательства (лизинг в $): базовый курс оприходования долга (для курсовой разницы),
  // и по каждому платежу — сколько сум реально ушло из выписки и по какому курсу.
  await pool.query("ALTER TABLE finance_obligations ADD COLUMN IF NOT EXISTS base_fx_rate NUMERIC").catch(()=>{});
  await pool.query("ALTER TABLE finance_obligation_payment_links ADD COLUMN IF NOT EXISTS amount_uzs NUMERIC").catch(()=>{});
  await pool.query("ALTER TABLE finance_obligation_payment_links ADD COLUMN IF NOT EXISTS fx_rate NUMERIC").catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_obligation_schedule_imports (
    id SERIAL PRIMARY KEY,
    obligation_id INTEGER,
    version_no INTEGER,
    source_file_id INTEGER,
    source_filename TEXT,
    source_file_hash TEXT,
    source_sheet TEXT,
    column_mapping_json JSONB,
    validation_summary_json JSONB,
    status TEXT DEFAULT 'preview',                       -- preview | confirmed | rejected | superseded
    imported_by INTEGER, imported_at TIMESTAMPTZ DEFAULT now(),
    confirmed_by INTEGER, confirmed_at TIMESTAMPTZ
  )`).catch(()=>{});
  // Возмещение затрат подотчётным лицам (не займы/кредиты) — простой список: кому вернуть за траты из кармана.
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_reimbursements (
    id SERIAL PRIMARY KEY,
    reim_date DATE,
    person TEXT NOT NULL,                                -- подотчётное лицо (кто потратил свои деньги)
    amount NUMERIC DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'UZS',                -- UZS | USD
    purpose TEXT,                                        -- назначение расхода (на что/кому потрачено)
    comment TEXT,
    fx_rate NUMERIC,                                    -- курс сум/$ на момент траты (для USD): база в долларах, но знаем сумму в сумах
    status TEXT NOT NULL DEFAULT 'pending',              -- pending (не возмещено) | reimbursed (возмещено)
    reimbursed_date DATE,
    created_by INTEGER, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
  )`).catch((e) => console.error('fin_reimb:', e.message));
  await pool.query('ALTER TABLE finance_reimbursements ADD COLUMN IF NOT EXISTS fx_rate NUMERIC').catch(() => {});
  // Разовая загрузка обязательств (Хикматов/Хабибуллаев/прочие) — идемпотентно, потом можно удалить.
  await require('./seed-obligations')(pool).catch((e) => console.error('[seed-obligations]', e.message));
  // Подотчёт закупщика (общий котёл): in = выдано под отчёт, out = потрачено наличными по заявкам.
  // Касса остаётся отдельным контуром — авто-проводок в Кассу нет (по решению).
  await pool.query(`CREATE TABLE IF NOT EXISTS purchaser_accountable (
    id SERIAL PRIMARY KEY,
    direction TEXT NOT NULL,          -- in | out
    amount NUMERIC NOT NULL,
    order_id INTEGER,
    comment TEXT DEFAULT '',
    created_by INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
  )`).catch(()=>{});

  // сид справочника причин (один раз)
  const rcReasons = await pool.query('SELECT COUNT(*)::int AS n FROM reject_reasons');
  if (rcReasons.rows[0].n === 0) {
    const seed = [
      ['Не приехала машина', 'receipt'], ['Опоздание поставки', 'receipt'],
      ['Брак (гниль, повреждения)', 'receipt'], ['Пересорт', 'receipt'],
      ['Недовес', 'receipt'], ['Несоответствие спецификации', 'spec'],
      ['Размер вне коридора', 'spec'], ['Цвет/вид не соответствует', 'spec'],
      ['Другое', 'receipt'],
    ];
    let i = 0;
    for (const [name, scope] of seed) {
      await pool.query('INSERT INTO reject_reasons (name, scope, sort_order) VALUES ($1,$2,$3)', [name, scope, i++]);
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ref_prices (
      id SERIAL PRIMARY KEY,
      price_type_id INTEGER REFERENCES ref_price_types(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES ref_finished_goods(id) ON DELETE CASCADE,
      price NUMERIC DEFAULT 0,
      last_sync_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (price_type_id, product_id)
    );
  `);
}

// Перенос данных из старых простых справочников в новые таблицы (однократно)
async function migrateLegacyDicts() {
  await mergeDuplicateUnits();
  const u = await pool.query('SELECT count(*)::int AS n FROM ref_units');
  if (u.rows[0].n === 0) {
    await pool.query(
      `INSERT INTO ref_units (name, short_name)
       SELECT name, short_name FROM units
       ON CONFLICT DO NOTHING`
    ).catch((e) => console.error('legacy units:', e.message));
  }
  const c = await pool.query('SELECT count(*)::int AS n FROM ref_counterparties');
  if (c.rows[0].n === 0) {
    await pool.query(
      `INSERT INTO ref_counterparties (name, inn, role_client)
       SELECT name, inn, TRUE FROM counterparties`
    ).catch((e) => console.error('legacy counterparties:', e.message));
  }
  const p = await pool.query('SELECT count(*)::int AS n FROM ref_finished_goods');
  if (p.rows[0].n === 0) {
    await pool.query(
      `INSERT INTO ref_finished_goods (name, unit_id)
       SELECT p.name, ru.id FROM products p
       LEFT JOIN units lu ON lu.id = p.unit_id
       LEFT JOIN ref_units ru ON lower(ru.short_name) = lower(lu.short_name)`
    ).catch((e) => console.error('legacy products:', e.message));
  }
}

async function seed() {
  const bcrypt = require('bcryptjs');

  // Настройки по умолчанию
  const defaults = {
    company_name: process.env.COMPANY_NAME || 'Novagreen Hub',
    brand_color: '#2E7D32',
    bg_dim: '45',
    logo_file_id: '',
    bg_file_id: '',
  };
  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }

  // Роль администратора
  // Роль «Финансы/Бухгалтерия»: ведёт Кассу и Обязательства (без полного админа).
  await pool.query("ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_finance BOOLEAN DEFAULT FALSE").catch(() => {});
  {
    const fin = await pool.query("SELECT id FROM roles WHERE is_finance = TRUE LIMIT 1");
    let finId = fin.rows[0] && fin.rows[0].id;
    if (!finId) {
      const ins = await pool.query("INSERT INTO roles (name, is_admin, is_finance) VALUES ('Финансы/Бухгалтерия', FALSE, TRUE) ON CONFLICT (name) DO UPDATE SET is_finance=TRUE RETURNING id").catch(() => null);
      finId = ins && ins.rows[0] && ins.rows[0].id;
    }
    // Даём роли доступ к плитке «Касса» (обязательства — внутри неё).
    if (finId) await pool.query(
      `INSERT INTO role_tiles (role_id, tile_id) SELECT $1, id FROM tiles WHERE url='/cash' ON CONFLICT DO NOTHING`, [finId]).catch(() => {});
  }

  // Роль «Правка заявок»: временный доступ править заявки (поставщик/кол-во/цена) для сверки/переноса.
  // Отмечаешь галочкой у человека в админ-панели → у него появляется кнопка «Изменить»; снимаешь → пропадает.
  await pool.query("INSERT INTO roles (name, is_admin) VALUES ('Правка заявок', FALSE) ON CONFLICT (name) DO NOTHING").catch(() => {});

  let r = await pool.query("SELECT id FROM roles WHERE is_admin = TRUE LIMIT 1");
  let adminRoleId;
  if (r.rows.length === 0) {
    r = await pool.query(
      "INSERT INTO roles (name, is_admin) VALUES ('Администратор', TRUE) RETURNING id"
    );
    adminRoleId = r.rows[0].id;
  } else {
    adminRoleId = r.rows[0].id;
  }

  // Первый администратор (P0.2: не создаём с публично известным паролем admin/admin123).
  // Создаём ТОЛЬКО если заданы переменные окружения ADMIN_LOGIN и ADMIN_PASSWORD.
  const u = await pool.query('SELECT id FROM users LIMIT 1');
  if (u.rows.length === 0) {
    const login = process.env.ADMIN_LOGIN;
    const password = process.env.ADMIN_PASSWORD;
    if (login && password && password.length >= 8) {
      const hash = await bcrypt.hash(password, 10);
      const ins = await pool.query(
        "INSERT INTO users (login, full_name, password_hash) VALUES ($1, 'Администратор', $2) RETURNING id",
        [login, hash]
      );
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ins.rows[0].id, adminRoleId]);
      console.log(`[seed] Создан администратор «${login}» из переменных окружения. Смените пароль после первого входа.`);
    } else {
      console.warn('[seed] Пользователей нет, но ADMIN_LOGIN/ADMIN_PASSWORD (>=8 симв.) не заданы — администратор НЕ создан. Задайте их в переменных окружения и перезапустите.');
    }
  }

  // Базовые единицы измерения
  const un = await pool.query('SELECT id FROM units LIMIT 1');
  if (un.rows.length === 0) {
    await pool.query(
      "INSERT INTO units (name, short_name) VALUES ('Килограмм','кг'),('Штука','шт'),('Упаковка','упак'),('Литр','л')"
    );
  }

  // Культуры: перенос из старого текстового поля cultura → справочник ref_cultures (однократно)
  try {
    const hasOld = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='ref_raw_materials' AND column_name='cultura'"
    );
    if (hasOld.rows.length) {
      const texts = await pool.query(
        "SELECT DISTINCT trim(cultura) AS c FROM ref_raw_materials WHERE cultura IS NOT NULL AND trim(cultura) <> ''"
      );
      for (const row of texts.rows) {
        const ex = await pool.query('SELECT id FROM ref_cultures WHERE lower(name)=lower($1) LIMIT 1', [row.c]);
        const cid = ex.rows.length ? ex.rows[0].id
          : (await pool.query('INSERT INTO ref_cultures (name) VALUES ($1) RETURNING id', [row.c])).rows[0].id;
        await pool.query(
          'UPDATE ref_raw_materials SET cultura_id = $1 WHERE lower(trim(cultura)) = lower($2) AND cultura_id IS NULL',
          [cid, row.c]
        );
      }
    }
  } catch (e) { console.error('cultura migrate:', e.message); }

  // Стартовые культуры по категориям (ТЗ, раздел 12)
  const cultSeed = [
    ['Baby Leaf', ['Руккола', 'Шпинат', 'Мангольд']],
    ['Кочанные', ['Романо', 'Айсберг']],
    ['Пучковые / свежая зелень', ['Укроп', 'Кинза']],
    ['Овощи', ['Морковь', 'Баклажан']],
    ['Packaging / упаковка', ['Пакет', 'Короб', 'Этикетка', 'Плёнка']],
  ];
  // выполняется после сида категорий ниже — поэтому категории создаём раньше культур

  // Категории сырья с кодами для артикулов (ТЗ «Номенклатура сырья», раздел 5)
  const rawCats = [
    ['BL', 'Baby Leaf'], ['HD', 'Кочанные'], ['LF', 'Листовые'],
    ['HB', 'Пучковые / свежая зелень'], ['VG', 'Овощи'], ['MG', 'Микрозелень'],
    ['PK', 'Packaging / упаковка'],
  ];
  for (const [code, name] of rawCats) {
    const ex = await pool.query(
      "SELECT id, code FROM ref_categories WHERE kind = 'категория' AND (upper(code) = $1 OR lower(name) = lower($2)) LIMIT 1",
      [code, name]
    );
    if (ex.rows.length) {
      if (!ex.rows[0].code) await pool.query('UPDATE ref_categories SET code = $1 WHERE id = $2', [code, ex.rows[0].id]);
    } else {
      await pool.query("INSERT INTO ref_categories (name, kind, code) VALUES ($1, 'категория', $2)", [name, code]);
    }
  }

  // ветка «родителя» для категорий сырья: зелень / упаковка
  await pool.query(`UPDATE ref_categories SET branch = 'Упаковка'
    WHERE kind = 'категория' AND COALESCE(branch,'') = '' AND (upper(code) IN ('PK','LAB') OR lower(name) LIKE '%пакет%' OR lower(name) LIKE '%стикер%' OR lower(name) LIKE '%контейнер%' OR lower(name) LIKE '%упаков%')`).catch(()=>{});
  await pool.query(`UPDATE ref_categories SET branch = 'Свежая зелень'
    WHERE kind = 'категория' AND COALESCE(branch,'') = '' AND (sd_sd_id IS NULL OR sd_sd_id = '') AND upper(code) <> ''`).catch(()=>{});

  // Бэкафилл склада: перенос ранее принятых приёмок в журнал движений (однократно)
  try {
    await pool.query(`
      INSERT INTO stock_movements (item_kind, item_id, qty, direction, reason, price, ref_type, ref_id, moved_at, created_by)
      SELECT i.item_kind, i.item_id, i.fact_qty, 'in', 'receive', COALESCE(i.fact_price, i.price),
             'purchase_order', po.id, po.received_at::date, po.received_by
      FROM purchase_order_items i
      JOIN purchase_orders po ON po.id = i.order_id AND po.status = 'received'
      WHERE COALESCE(i.fact_qty, 0) > 0
        AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.ref_type = 'purchase_order' AND sm.ref_id = po.id)
    `);
  } catch (e) { console.error('stock backfill:', e.message); }

  // ШАГ 3/4: родительские категории как справочник + привязка категорий и поставщиков
  try {
    // стартовые родительские категории (имя, цвет, код-префикс)
    const parents = [
      ['Свежая зелень', '#3f8f3f', 'G'],
      ['Упаковка', '#c98a2b', 'P'],
    ];
    const pidByName = {};
    for (const [name, color, prefix] of parents) {
      const ex = await pool.query('SELECT id FROM ref_parent_categories WHERE lower(name)=lower($1) LIMIT 1', [name]);
      if (ex.rows.length) {
        pidByName[name] = ex.rows[0].id;
        await pool.query('UPDATE ref_parent_categories SET color=COALESCE(NULLIF(color,$1),$2), code_prefix=COALESCE(NULLIF(code_prefix,$3),$4) WHERE id=$5', ['', color, '', prefix, ex.rows[0].id]).catch(()=>{});
      } else {
        const r = await pool.query("INSERT INTO ref_parent_categories (name, color, code_prefix, status) VALUES ($1,$2,$3,'active') RETURNING id", [name, color, prefix]);
        pidByName[name] = r.rows[0].id;
      }
    }
    // категории сырья: текстовый branch → parent_id
    for (const [name, pid] of Object.entries(pidByName)) {
      await pool.query("UPDATE ref_categories SET parent_id=$1 WHERE kind='категория' AND lower(COALESCE(branch,''))=lower($2) AND parent_id IS NULL", [pid, name]).catch(()=>{});
    }
    // поставщики: по supplier_type проставим родительскую категорию, где пусто
    await pool.query("UPDATE ref_counterparties SET parent_category_id=$1 WHERE role_supplier=TRUE AND parent_category_id IS NULL AND lower(COALESCE(supplier_type,'')) LIKE '%упаков%'", [pidByName['Упаковка']]).catch(()=>{});
    await pool.query("UPDATE ref_counterparties SET parent_category_id=$1 WHERE role_supplier=TRUE AND parent_category_id IS NULL AND lower(COALESCE(supplier_type,'')) LIKE '%сырь%'", [pidByName['Свежая зелень']]).catch(()=>{});
  } catch (e) { console.error('parent_categories migrate:', e.message); }

  for (const [catName, cults] of cultSeed) {
    const cat = await pool.query("SELECT id FROM ref_categories WHERE kind='категория' AND lower(name)=lower($1) LIMIT 1", [catName]);
    if (!cat.rows.length) continue;
    for (const cu of cults) {
      const ex = await pool.query('SELECT id, category_id FROM ref_cultures WHERE lower(name)=lower($1) LIMIT 1', [cu]);
      if (ex.rows.length) {
        if (!ex.rows[0].category_id) await pool.query('UPDATE ref_cultures SET category_id=$1 WHERE id=$2', [cat.rows[0].id, ex.rows[0].id]);
      } else {
        await pool.query('INSERT INTO ref_cultures (name, category_id) VALUES ($1,$2)', [cu, cat.rows[0].id]);
      }
    }
  }

  // Группировка плиток по разделам на лаунчере: колонка для раздела.
  await pool.query("ALTER TABLE tiles ADD COLUMN IF NOT EXISTS section TEXT");

  // Плитка «Справочники» — внутренний модуль ядра
  const dt = await pool.query("SELECT id FROM tiles WHERE url = '/dictionaries' LIMIT 1");
  if (dt.rows.length === 0) {
    await pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ('Справочники', 'Контрагенты, номенклатура, единицы', '📚', '/dictionaries', FALSE, 90)`
    );
  }

  // Плитка «Телеграм-бот: ассистент продаж»
  const bt = await pool.query("SELECT id FROM tiles WHERE url = '/tgbot' LIMIT 1");
  if (bt.rows.length === 0) {
    await pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ('Телеграм-бот: ассистент продаж', 'Заказы, претензии, напоминания и отчёты для отдела продаж', '🤖', '/tgbot', FALSE, 80)`
    );
  }
  // Переименование старой плитки «Бот HoReCa» → новое имя, классический значок.
  await pool.query(
    `UPDATE tiles SET title='Телеграм-бот: ассистент продаж',
        description='Заказы, претензии, напоминания и отчёты для отдела продаж',
        icon='🤖'
     WHERE url='/tgbot' AND (title='Бот HoReCa' OR icon='/static/img/tgbot-icon.svg')`
  );

  // Плитка «Закуп» — модуль ядра
  const pt = await pool.query("SELECT id FROM tiles WHERE url = '/purchase' LIMIT 1");
  if (pt.rows.length === 0) {
    await pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ('Закуп', 'Заявки, приёмка, взаиморасчёты с поставщиками', '🛒', '/purchase', FALSE, 20)`
    );
  }

  // Плитка «Склад сырья» — модуль ядра
  const wt = await pool.query("SELECT id FROM tiles WHERE url = '/stock' LIMIT 1");
  if (wt.rows.length === 0) {
    await pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ('Склад сырья', 'Остатки сырья и упаковки, приходы, списания, инвентаризация', '📦', '/stock', FALSE, 30)`
    );
  }

  // Плитка «Претензии» — жалобы клиентов, разбор, статистика
  const cmt = await pool.query("SELECT id FROM tiles WHERE url = '/complaints' LIMIT 1");
  if (cmt.rows.length === 0) {
    await pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ('Претензии', 'Жалобы клиентов: разбор, решения, статистика', '📩', '/complaints', FALSE, 40)`
    );
  }

  // Плитка «Касса» — денежный модуль
  const csht = await pool.query("SELECT id FROM tiles WHERE url = '/cash' LIMIT 1");
  if (csht.rows.length === 0) {
    await pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ('Касса', 'Деньги, кэш-флоу (ДДС), P&L, остатки кошельков', '💸', '/cash', FALSE, 50)`
    );
  }

  // Плитка «Калькуляция» — перезапуск по ТЗ: справочники → позже рецептуры/упаковка/матрица
  const calct = await pool.query("SELECT id FROM tiles WHERE url = '/calculation' LIMIT 1");
  if (calct.rows.length === 0) {
    await pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ('Калькуляция', 'Периоды, статьи затрат, ставки и каналы — фундамент калькуляции', '🧮', '/calculation', FALSE, 52)`
    );
  }
  await pool.query("UPDATE tiles SET description='Периоды, статьи затрат, ставки и каналы — фундамент калькуляции' WHERE url='/calculation'").catch(() => {});

  // Старый модуль «Калькуляция себестоимости» (/costing) снят: скрываем его плитку из лаунчпада.
  // ВАЖНО (P0.3): НЕ выполняем DROP TABLE при старте приложения. Таблицы costing_* уже удалены
  // ранее разово; если где-то остались — они просто не используются (осиротевшие, безвредны).
  // Их окончательное удаление, если понадобится, делается отдельной разовой миграцией, не на старте.
  await pool.query("DELETE FROM role_tiles WHERE tile_id IN (SELECT id FROM tiles WHERE url='/costing')").catch(() => {});
  await pool.query("DELETE FROM tiles WHERE url='/costing'").catch(() => {});

  // Плитка «Персонал» — сотрудники, зарплата, табель
  const hrt = await pool.query("SELECT id FROM tiles WHERE url = '/hr' LIMIT 1");
  if (hrt.rows.length === 0) {
    await pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ('Персонал', 'Сотрудники, зарплата, табель и выплаты', '👥', '/hr', FALSE, 55)`
    );
  }
  // Форсируем видимость (на случай старой скрытой строки).
  await pool.query("UPDATE tiles SET is_visible = TRUE WHERE url = '/hr' AND is_visible IS DISTINCT FROM TRUE").catch(() => {});
  console.log('[SEED] Плитка /hr обеспечена');

  // Первая плитка — Счета-фактуры (адрес меняется в админке)
  const t = await pool.query('SELECT id FROM tiles LIMIT 1');
  if (t.rows.length === 0) {
    const ins = await pool.query(
      `INSERT INTO tiles (title, description, icon, url, sort_order)
       VALUES ('Счета-фактуры', 'Распознавание и учёт счетов-фактур', '🧾', 'https://example.up.railway.app', 10)
       RETURNING id`
    );
    await pool.query('INSERT INTO role_tiles (role_id, tile_id) VALUES ($1, $2)', [
      adminRoleId,
      ins.rows[0].id,
    ]);
  }

  // Разделы плиток для группировки на лаунчере (не перетираем ручные правки админа).
  const tileSections = [
    ['/complaints', 'HoReCa'],
    ['/tgbot', 'HoReCa'],
    ['/purchase', 'Склад и закуп'],
    ['/stock', 'Склад и закуп'],
    ['/dictionaries', 'Справочники и настройки'],
    ['/cash', 'Финансы'],
    ['/calculation', 'Финансы'],
    ['/hr', 'Финансы'],
  ];
  for (const [u, sec] of tileSections) {
    await pool.query("UPDATE tiles SET section = $1 WHERE url = $2 AND (section IS NULL OR section = '')", [sec, u]);
  }
}

async function getSettings() {
  const r = await pool.query('SELECT key, value FROM settings');
  const s = {};
  for (const row of r.rows) s[row.key] = row.value;
  return s;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, value]
  );
}

async function log(userId, action, details = '') {
  try {
    await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [
      userId,
      action,
      details,
    ]);
  } catch (e) {
    console.error('audit_log error', e.message);
  }
}

module.exports = { pool, migrate, migrateLegacyDicts, seed, getSettings, setSetting, log };
