// Точка входа бота. Шаг 1 — каркас:
//  1) проверяет настройки,
//  2) подключается к базе и заводит таблицы,
//  3) выходит на связь в Telegram и умеет здороваться.
// Логику заказов и SalesDoctor добавим на следующих шагах.

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Без этих двух настроек запускаться нельзя — говорим об этом понятно.
if (!TOKEN) {
  console.error("[СТАРТ] Нет TELEGRAM_BOT_TOKEN. Добавь его в настройки (Railway → Variables).");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("[СТАРТ] Нет DATABASE_URL. Добавь подключение к базе (Railway → Variables).");
  process.exit(1);
}

async function main() {
  // 1. Подготовить базу.
  await db.migrate();

  // 2. Запустить бота. Пока режим polling — самый простой, без настройки адресов.
  //    Позже переключим на webhook.
  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log("[СТАРТ] Бот на связи (режим polling).");

  // Команда /start — первое касание клиента.
  bot.onText(/\/start/, async (msg) => {
    const id = msg.chat.id;
    await db.logEvent("start", id, { from: msg.from });
    bot.sendMessage(
      id,
      "Здравствуйте! Это бот Novagreen Foods.\n\n" +
        "Пока я на этапе настройки и умею только поздороваться. " +
        "Скоро здесь появятся напоминания и оформление заказов."
    );
  });

  // Любое другое сообщение — логируем и отвечаем заглушкой.
  bot.on("message", async (msg) => {
    if (msg.text && msg.text.startsWith("/start")) return; // уже обработано выше
    const id = msg.chat.id;
    await db.logEvent("message", id, { text: msg.text });
    bot.sendMessage(id, "Принял. Полноценные функции появятся на следующих шагах.");
  });

  // Ошибки опроса Telegram — в журнал и в консоль, без падения.
  bot.on("polling_error", (err) => {
    console.error("[Telegram] Ошибка опроса:", err.message);
    db.logEvent("error", null, { where: "polling", message: err.message });
  });
}

main().catch((e) => {
  console.error("[СТАРТ] Критическая ошибка запуска:", e.message);
  process.exit(1);
});
