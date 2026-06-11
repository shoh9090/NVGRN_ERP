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

-- Журнал действий (минимальный, расширяется на Этапе 5)
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

async function migrate() {
  await pool.query(MIGRATIONS);
  // Таблицы модуля «Справочники» (генерируются из схем ТЗ)
  const { allCreateSQL, allAlterSQL } = require('./refs-config');
  await pool.query(allCreateSQL());
  await pool.query(allAlterSQL());
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

  // Первый администратор
  const u = await pool.query('SELECT id FROM users LIMIT 1');
  if (u.rows.length === 0) {
    const login = process.env.ADMIN_LOGIN || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(password, 10);
    const ins = await pool.query(
      "INSERT INTO users (login, full_name, password_hash) VALUES ($1, 'Администратор', $2) RETURNING id",
      [login, hash]
    );
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [
      ins.rows[0].id,
      adminRoleId,
    ]);
    console.log(`[seed] Создан администратор: ${login} / ${password} — смените пароль после первого входа!`);
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

  // Плитка «Справочники» — внутренний модуль ядра
  const dt = await pool.query("SELECT id FROM tiles WHERE url = '/dictionaries' LIMIT 1");
  if (dt.rows.length === 0) {
    await pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ('Справочники', 'Контрагенты, номенклатура, единицы', '📚', '/dictionaries', FALSE, 90)`
    );
  }

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
