// Подключение к базе данных и базовые помощники.
// Бот использует ту же PostgreSQL, что и Hub, но свою отдельную схему.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SCHEMA = process.env.DB_SCHEMA || "tgbot";

// Пул соединений. ssl нужен для базы на Railway.
// search_path задаём сразу при подключении — без лишних запросов.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  options: `-c search_path=${SCHEMA},public`,
});

// Простой запрос к базе.
async function query(text, params) {
  return pool.query(text, params);
}

// Создаёт схему и таблицы, если их ещё нет. Запускается один раз при старте.
async function migrate() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log(`[БД] Схема "${SCHEMA}" и таблицы готовы.`);
}

// Записать событие в журнал. Сбой логирования не должен ронять бота.
async function logEvent(type, telegramId, payload) {
  try {
    await query(
      `INSERT INTO bot_events (telegram_id, type, payload) VALUES ($1, $2, $3)`,
      [telegramId || null, type, payload ? JSON.stringify(payload) : null]
    );
  } catch (e) {
    console.error("[БД] Не удалось записать событие:", e.message);
  }
}

module.exports = { pool, query, migrate, logEvent, SCHEMA };
