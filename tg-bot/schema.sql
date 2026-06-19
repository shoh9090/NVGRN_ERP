-- Первые таблицы бота. Лежат в отдельной схеме (см. DB_SCHEMA),
-- чтобы не смешиваться с таблицами Hub ERP в той же базе.
-- Имя схемы подставляется кодом, здесь таблицы пишем без префикса.

-- Кто подключился к боту: связь Telegram <-> контрагент в SalesDoctor.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  telegram_id   BIGINT UNIQUE NOT NULL,         -- ID пользователя в Telegram
  crm_client_id TEXT,                            -- номер контрагента в SalesDoctor (заполнится позже)
  name          TEXT,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'client',  -- client / manager / admin
  status        TEXT NOT NULL DEFAULT 'pending', -- pending / active / blocked
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Журнал всех действий и ошибок бота (для контроля и разбора).
CREATE TABLE IF NOT EXISTS bot_events (
  id          BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT,
  type        TEXT NOT NULL,                     -- 'start', 'message', 'error', ...
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_events_created ON bot_events (created_at);

-- Токен доступа к SalesDoctor (одна строка, id всегда = 1).
CREATE TABLE IF NOT EXISTS api_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT,
  token      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Контакты из Hub (плитка «Бот HoReCa»): Hub записывает, бот читает.
CREATE TABLE IF NOT EXISTS point_contacts (
  sd_id          TEXT PRIMARY KEY,
  point_name     TEXT,
  firm_name      TEXT,
  inn            TEXT,
  zavsklad_phone TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     TEXT
);
CREATE TABLE IF NOT EXISTS chain_managers (
  inn           TEXT PRIMARY KEY,
  firm_name     TEXT,
  manager_phone TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);

-- Кто подключился к боту: завсклад точки и менеджер сети.
CREATE TABLE IF NOT EXISTS point_links (
  sd_id       TEXT PRIMARY KEY,
  telegram_id BIGINT,
  chat_id     BIGINT,
  phone       TEXT,
  point_name  TEXT,
  firm_name   TEXT,
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS manager_links (
  inn         TEXT PRIMARY KEY,
  telegram_id BIGINT,
  chat_id     BIGINT,
  phone       TEXT,
  firm_name   TEXT,
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Язык пользователя бота (ru / uz).
CREATE TABLE IF NOT EXISTS user_prefs (
  chat_id    BIGINT PRIMARY KEY,
  lang       TEXT NOT NULL DEFAULT 'ru',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Вариант Б: личность пользователя = его номер; точки определяем на лету из point_contacts.
CREATE TABLE IF NOT EXISTS tg_users (
  telegram_id BIGINT PRIMARY KEY,
  chat_id     BIGINT,
  phone       TEXT,
  phone9      TEXT,
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Бэкфилл из старых привязок, чтобы уже подключённые тестеры не переподключались.
INSERT INTO tg_users (telegram_id, chat_id, phone, phone9)
SELECT DISTINCT ON (telegram_id) telegram_id, chat_id, phone,
       right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),9)
FROM point_links
WHERE telegram_id IS NOT NULL
ORDER BY telegram_id, linked_at DESC NULLS LAST
ON CONFLICT (telegram_id) DO NOTHING;
