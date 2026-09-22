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
