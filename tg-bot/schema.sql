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

-- Настройки напоминаний (РОП меняет в плитке; бот читает отсюда).
CREATE TABLE IF NOT EXISTS bot_settings (
  id              INT PRIMARY KEY DEFAULT 1,
  reminder_times  TEXT NOT NULL DEFAULT '18:00,21:00,23:00',
  deadline        TEXT NOT NULL DEFAULT '00:00',
  avg_window_days INT NOT NULL DEFAULT 14,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT
);
INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- «Не сегодня»: глушим напоминания по точке до конца дня.
CREATE TABLE IF NOT EXISTS reminder_skips (
  sd_id TEXT NOT NULL,
  rdate DATE NOT NULL,
  PRIMARY KEY (sd_id, rdate)
);
-- Чтобы не слать одно и то же напоминание дважды в один слот.
CREATE TABLE IF NOT EXISTS reminder_log (
  sd_id   TEXT NOT NULL,
  rdate   DATE NOT NULL,
  slot    TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sd_id, rdate, slot)
);

-- ===== Бандл 1: сотрудники, роли, синхронизация из SalesDoctor =====

-- Агенты, подтянутые из SalesDoctor (getAgent). У агентов в SD телефона нет.
CREATE TABLE IF NOT EXISTS crm_agents (
  sd_agent_id    TEXT PRIMARY KEY,
  sd_agent_code  TEXT,
  sd_agent_name  TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Telegram-сотрудники (агент / РОП / админ). Связка номер -> агент -> роль.
CREATE TABLE IF NOT EXISTS telegram_staff (
  id                  SERIAL PRIMARY KEY,
  telegram_user_id    BIGINT UNIQUE,
  telegram_chat_id    BIGINT,
  telegram_username   TEXT,
  telegram_first_name TEXT,
  telegram_last_name  TEXT,
  phone_original      TEXT,
  phone_normalized    TEXT,
  crm_agent_id        TEXT,
  role                TEXT,                         -- agent / head_of_sales / admin
  status              TEXT NOT NULL DEFAULT 'new_request',
  confirmed_by        TEXT,
  confirmed_at        TIMESTAMPTZ,
  disabled_at         TIMESTAMPTZ,
  comment             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_phone ON telegram_staff(phone_normalized);

-- Живая синхронизация: к точке добавляем агента, активность, дату последнего заказа.
ALTER TABLE point_contacts ADD COLUMN IF NOT EXISTS agent_sd_id     TEXT;
ALTER TABLE point_contacts ADD COLUMN IF NOT EXISTS active          TEXT;
ALTER TABLE point_contacts ADD COLUMN IF NOT EXISTS last_order_date DATE;

-- Лог синхронизации с SalesDoctor.
CREATE TABLE IF NOT EXISTS salesdoctor_sync_log (
  id         SERIAL PRIMARY KEY,
  sync_type  TEXT,            -- full / quick / manual / agents
  created    INT DEFAULT 0,
  updated    INT DEFAULT 0,
  conflicts  INT DEFAULT 0,
  error      TEXT,
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Бандл 2 (шаг 1): журнал уведомлений =====
CREATE TABLE IF NOT EXISTS notification_log (
  id             SERIAL PRIMARY KEY,
  kind           TEXT,
  dedup_key      TEXT UNIQUE,
  target_chat_id BIGINT,
  target_role    TEXT,
  sd_id          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Бандл 2 (шаг 2): журнал сигналов по клиентам =====
CREATE TABLE IF NOT EXISTS client_signals_log (
  id          SERIAL PRIMARY KEY,
  sd_id       TEXT,
  signal_type TEXT,
  sig_date    DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sd_id, signal_type, sig_date)
);

-- ===== Бандл 3 (шаг 2): очередь заказов с ретраями =====
CREATE TABLE IF NOT EXISTS pending_orders (
  id              SERIAL PRIMARY KEY,
  code_1c         TEXT UNIQUE,
  client_sd_id    TEXT,
  chat_id         BIGINT,
  payload         JSONB,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending / done / failed
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_stuck  BOOLEAN NOT NULL DEFAULT false,
  is_dop          BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_due ON pending_orders(status, next_attempt_at);

-- ===== Бандл 3 (шаг 3): замены товара =====
CREATE TABLE IF NOT EXISTS product_replacements (
  id                SERIAL PRIMARY KEY,
  product_sd_id     TEXT,
  product_name      TEXT,
  replacement_sd_id TEXT,
  replacement_name  TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_sd_id, replacement_sd_id)
);

-- ===== Слежение за изменениями НОВЫХ заказов (завсклад правит состав при сборке) =====
-- Снимок состава каждого нового заказа; сравниваем при опросе и шлём агенту/РОПу что изменилось.
CREATE TABLE IF NOT EXISTS order_snapshots (
  sd_id       TEXT PRIMARY KEY,
  code_1c     TEXT,
  agent_sd_id TEXT,
  client_name TEXT,
  items       JSONB NOT NULL DEFAULT '[]',   -- [{sd, name, qty, price}]
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Реестр упущенных продаж: каждое урезание/удаление позиции в новом заказе (нет на складе).
-- Бот пишет, Hub читает (дашборд в плитке «Бот HoReCa»).
CREATE TABLE IF NOT EXISTS lost_sales (
  id            BIGSERIAL PRIMARY KEY,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  order_sd_id   TEXT,
  order_code    TEXT,
  client_sd_id  TEXT,
  client_name   TEXT,
  agent_sd_id   TEXT,
  product_sd_id TEXT,
  product_name  TEXT,
  qty_before    NUMERIC,
  qty_after     NUMERIC,
  qty_lost      NUMERIC,
  price         NUMERIC,
  amount_lost   NUMERIC,
  reason        TEXT NOT NULL DEFAULT 'stock'
);
CREATE INDEX IF NOT EXISTS idx_lost_sales_detected ON lost_sales (detected_at);
CREATE INDEX IF NOT EXISTS idx_lost_sales_agent ON lost_sales (agent_sd_id);
CREATE INDEX IF NOT EXISTS idx_lost_sales_product ON lost_sales (product_name);
