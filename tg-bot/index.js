// Точка входа бота.
// Шаг 1 — каркас (база + приветствие).
// Шаг 2 — вход в SalesDoctor + диагностический прогон (по флагу SD_PROBE).

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const sd = require("./salesdoctor");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("[СТАРТ] Нет TELEGRAM_BOT_TOKEN. Добавь его в Railway → Variables.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("[СТАРТ] Нет DATABASE_URL. Добавь подключение к базе.");
  process.exit(1);
}

// Достаёт первую запись из ответа, не зная заранее точной структуры.
function firstRecord(resp) {
  if (!resp) return resp;
  if (Array.isArray(resp)) return resp[0];
  if (resp.data) return Array.isArray(resp.data) ? resp.data[0] : resp.data;
  if (resp.result) return Array.isArray(resp.result) ? resp.result[0] : resp.result;
  return resp;
}

// Разовый диагностический прогон: показывает реальные поля клиента и заказа.
async function runProbe() {
  console.log("[ДИАГ] Пробный запрос в SalesDoctor...");
  try {
    const auth = await sd.login();
    console.log("[ДИАГ] Вход выполнен. userId:", auth.userId);

    const clients = await sd.call("getClient", { limit: 2, page: 1, filter: { active: "Y" } });
    console.log("[ДИАГ] getClient — ответ (обрезано):", JSON.stringify(clients).slice(0, 1500));
    console.log("[ДИАГ] getClient — первая запись целиком:");
    console.log(JSON.stringify(firstRecord(clients), null, 2));

    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const orders = await sd.call("getOrder", {
      limit: 3,
      page: 1,
      filter: { period: { date: { from: fmt(from), to: fmt(now) } } },
    });
    console.log("[ДИАГ] getOrder — ответ (обрезано):", JSON.stringify(orders).slice(0, 1500));
    console.log("[ДИАГ] getOrder — первая запись целиком:");
    console.log(JSON.stringify(firstRecord(orders), null, 2));
  } catch (e) {
    console.error("[ДИАГ] Ошибка пробы:", e.message);
  }
}

async function main() {
  await db.migrate();

  if (process.env.SD_PROBE) {
    await runProbe();
  }

  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log("[СТАРТ] Бот на связи (режим polling).");

  bot.onText(/\/start/, async (msg) => {
    const id = msg.chat.id;
    await db.logEvent("start", id, { from: msg.from });
    bot.sendMessage(
      id,
      "Здравствуйте! Это бот Novagreen Foods.\n\n" +
        "Пока я на этапе настройки. Скоро здесь появятся напоминания и оформление заказов."
    );
  });

  // Подсказка: узнать свой Telegram ID (понадобится для роли админа позже).
  bot.onText(/\/whoami/, (msg) => {
    bot.sendMessage(msg.chat.id, "Ваш Telegram ID: " + msg.chat.id);
  });

  bot.on("message", async (msg) => {
    if (msg.text && (msg.text.startsWith("/start") || msg.text.startsWith("/whoami"))) return;
    const id = msg.chat.id;
    await db.logEvent("message", id, { text: msg.text });
    bot.sendMessage(id, "Принял. Полноценные функции появятся на следующих шагах.");
  });

  bot.on("polling_error", (err) => {
    console.error("[Telegram] Ошибка опроса:", err.message);
    db.logEvent("error", null, { where: "polling", message: err.message });
  });
}

main().catch((e) => {
  console.error("[СТАРТ] Критическая ошибка запуска:", e.message);
  process.exit(1);
});
