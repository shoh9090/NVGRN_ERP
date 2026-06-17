// Подключение к базе данных и базовые помощники.
// Бот использует ту же PostgreSQL, что и Hub, но свою отдельную схему.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SCHEMA = process.env.DB_SCHEMA || "tgbot";

// Пул соединений. ssl нужен для подключения к базе на Railway.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Каждое соединение работает внутри нашей схемы.
pool.on("connect", (client) => {
  client.query(`SET search_path TO "${SCHEMA}", public`);
});

// Простой запрос к базе.
async function query(text, params) {
  return pool.query(text, params);
}

// Создаёт схему и таблицы, если их ещё нет. Запускается один раз при старте.
async function migrate() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await pool.query(`SET search_path TO "${SCHEMA}", public`);
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log(`[БД] Схема "${SCHEMA}" и таблицы готовы.`);
}

// Записать событие в журнал. Ошибки логирования не должны ронять бота.
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
