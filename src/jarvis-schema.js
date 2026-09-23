// jarvis-schema.js — таблицы внутреннего бота «Джарвис» (шаг 3, docs/plan-jarvis.md).
// Только CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS — данные при старте не трогаем.

async function ensureJarvisSchema(pool) {
  const q = (s) => pool.query(s);
  // Trello человека — в карточке сотрудника (заводит и Персонал, src/hr.js).
  await q('ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS trello_member_id TEXT');
  await q('ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS trello_username TEXT');
  // Чат человека во внутреннем боте. Отдельно от tg_chat_id клиентского бота:
  // написать можно только тому, кто сам открыл этого бота.
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS jv_chat_id BIGINT');

  // Упоминания (@) из комментариев Trello: одна строка = один комментарий × один упомянутый.
  // Ответ — его комментарий в той же карточке позже упоминания или ответ из Telegram.
  await q(`CREATE TABLE IF NOT EXISTS jarvis_mentions (
    id SERIAL PRIMARY KEY,
    action_id TEXT NOT NULL,             -- id комментария в Trello
    member_id TEXT NOT NULL,             -- кого упомянули (Trello)
    employee_id INT,                     -- он же в Персонале
    card_id TEXT NOT NULL,
    card_name TEXT, card_url TEXT, board_name TEXT,
    author_member_id TEXT, author_name TEXT,
    text TEXT,
    created_at TIMESTAMPTZ NOT NULL,     -- когда упомянули
    answered_at TIMESTAMPTZ,
    answered_via TEXT,                   -- trello | telegram | closed
    reminded_at TIMESTAMPTZ,
    violation_at TIMESTAMPTZ,
    UNIQUE (action_id, member_id)
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_jv_mentions_open ON jarvis_mentions (card_id, member_id) WHERE answered_at IS NULL');

  // Карточки в работе: нужен ли срок и сколько раз его переносили.
  // Решение Шоха: у карточки с исполнителем должен быть срок, иначе задача
  // «принята» и висит. Переносы не запрещаем, но считаем.
  await q(`CREATE TABLE IF NOT EXISTS jarvis_cards (
    card_id TEXT PRIMARY KEY,
    name TEXT, url TEXT, board_name TEXT,
    due TIMESTAMPTZ,
    due_moves INT NOT NULL DEFAULT 0,
    no_due_since TIMESTAMPTZ,            -- с какого момента карточка в работе без срока
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Кто написал в карточке «принято/понял»: с него и спрашиваем срок,
  // а не со всех участников (решение по замечанию Шоха, 24.09.2026).
  await q('ALTER TABLE jarvis_cards ADD COLUMN IF NOT EXISTS accepted_by BIGINT');
  await q('ALTER TABLE jarvis_cards ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ');

  // С какого момента висит дело ERP («Нужно внести»). Нужно для цепочки
  // ответственных: не сделал первый — через N рабочих часов подключается второй.
  await q(`CREATE TABLE IF NOT EXISTS jarvis_todo_state (
    key TEXT PRIMARY KEY,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Сколько было в прошлый раз: стало меньше — работа идёт, часы считаем заново.
  await q('ALTER TABLE jarvis_todo_state ADD COLUMN IF NOT EXISTS last_count INT');

  // Переписка с Джарвисом: нужна, чтобы он помнил разговор, а не отвечал
  // каждый раз с чистого листа («ну давай» без контекста — замечание Шоха).
  // Храним неделю, потом чистим: это память разговора, а не архив.
  await q(`CREATE TABLE IF NOT EXISTS jarvis_chat (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    employee_id INT,
    role TEXT NOT NULL,                  -- user | assistant
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_jv_chat ON jarvis_chat (chat_id, created_at DESC)');

  // Память компании: факты и решения, которые Джарвис должен помнить всегда,
  // а не только в рамках одного разговора. Например: «KorzinkaRS — это РЦ сети,
  // мы сменили формат и возим по маркетам» или «зелень не хранится: что приняли,
  // то в тот же день ушло». Это НЕ цифры — цифры всегда берутся инструментами
  // из базы. Здесь только то, что объясняет, как мы работаем.
  await q(`CREATE TABLE IF NOT EXISTS jarvis_memory (
    id SERIAL PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'company',   -- company | person
    employee_id INT,                          -- для личных заметок
    topic TEXT NOT NULL DEFAULT '',           -- о чём: клиенты, склад, продажи…
    fact TEXT NOT NULL,
    source TEXT DEFAULT '',                   -- кто сказал и когда
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_jv_memory ON jarvis_memory (scope, active)');

  // Журнал Джарвиса: каждое напоминание и каждое нарушение — одна запись.
  // dedup_key не даёт отправить одно и то же дважды. Нарушения отсюда
  // потом станут штрафами в Персонале (шаг 4).
  await q(`CREATE TABLE IF NOT EXISTS jarvis_log (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL,                  -- remind_mention | violation_mention | remind_overdue | violation_overdue | remind_stale | reply
    employee_id INT,
    card_id TEXT, card_name TEXT, card_url TEXT,
    text TEXT,
    sent BOOLEAN NOT NULL DEFAULT FALSE, -- дошло ли до человека (нет в боте — не дошло)
    dedup_key TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_jv_log_created ON jarvis_log (created_at DESC)');
}

module.exports = { ensureJarvisSchema };
