// Точка входа бота.
// Шаг 1 — каркас. Шаг 2 — вход в SalesDoctor + проба.
// Шаг 3 — первый отчёт (Фаза 1): кто из HoReCa сегодня не заказал.

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const sd = require("./salesdoctor");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TG_ID = process.env.ADMIN_TG_ID;

if (!TOKEN) {
  console.error("[СТАРТ] Нет TELEGRAM_BOT_TOKEN. Добавь его в Railway → Variables.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("[СТАРТ] Нет DATABASE_URL. Добавь подключение к базе.");
  process.exit(1);
}

const isAdmin = (id) => ADMIN_TG_ID && String(id) === String(ADMIN_TG_ID);
const todayStr = () => new Date().toISOString().slice(0, 10);

// Отчёт: HoReCa-клиенты без заказа на сегодня (заказ сегодня = доставка завтра).
async function buildHorecaReport() {
  const catId = await sd.resolveCategoryId("Horeca");
  if (!catId) throw new Error("В SalesDoctor не найдена категория «Horeca».");

  // Активные клиенты категории HoReCa.
  const allClients = await sd.fetchAll("getClient", {});
  const clients = allClients.filter(
    (c) => c.active === "Y" && c.category && c.category.SD_id === catId
  );

  // Все сегодняшние заказы, кроме отменённых (5).
  const d = todayStr();
  const orders = await sd.fetchAll("getOrder", {
    filter: { period: { date: { from: d, to: d } }, status: [1, 2, 3, 4] },
  });
  const orderedIds = new Set(
    orders.map((o) => o.client && o.client.SD_id).filter(Boolean)
  );

  const notOrdered = clients.filter((c) => !orderedIds.has(c.SD_id));
  return { total: clients.length, ordered: orderedIds.size, notOrdered };
}

function formatReport(r) {
  const lines = r.notOrdered
    .slice(0, 50)
    .map((c, i) => `${i + 1}. ${c.name}${c.tel ? " — " + c.tel : ""}`);
  const more = r.notOrdered.length > 50 ? `\n…и ещё ${r.notOrdered.length - 50}` : "";
  const head =
    `HoReCa на сегодня:\n` +
    `Всего активных: ${r.total}\n` +
    `Уже заказали: ${r.ordered}\n` +
    `Не заказали: ${r.notOrdered.length}\n\n`;
  return head + (lines.length ? lines.join("\n") + more : "Все заказали.");
}

async function main() {
  await db.migrate();

  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log("[СТАРТ] Бот на связи (режим polling).");

  bot.onText(/\/start/, async (msg) => {
    await db.logEvent("start", msg.chat.id, { from: msg.from });
    bot.sendMessage(
      msg.chat.id,
      "Здравствуйте! Это бот Novagreen Foods.\n\n" +
        "Пока я на этапе настройки. Скоро здесь появятся напоминания и оформление заказов."
    );
  });

  // Узнать свой Telegram ID (нужно для назначения админа).
  bot.onText(/\/whoami/, (msg) => {
    bot.sendMessage(msg.chat.id, "Ваш Telegram ID: " + msg.chat.id);
  });

  // Отчёт для администратора: кто из HoReCa сегодня не заказал.
  bot.onText(/\/horeca/, async (msg) => {
    const id = msg.chat.id;
    if (!isAdmin(id)) {
      bot.sendMessage(id, "Команда доступна только администратору. Узнать свой ID: /whoami");
      return;
    }
    bot.sendMessage(id, "Считаю HoReCa-клиентов без заказа на сегодня…");
    try {
      const r = await buildHorecaReport();
      bot.sendMessage(id, formatReport(r));
      await db.logEvent("report_horeca", id, {
        total: r.total,
        ordered: r.ordered,
        notOrdered: r.notOrdered.length,
      });
    } catch (e) {
      console.error("[ОТЧЁТ] Ошибка:", e.message);
      bot.sendMessage(id, "Не получилось собрать отчёт: " + e.message);
    }
  });

  // Прочие сообщения (не команды) — лог + заглушка.
  bot.on("message", async (msg) => {
    if (msg.text && msg.text.startsWith("/")) return;
    await db.logEvent("message", msg.chat.id, { text: msg.text });
    bot.sendMessage(msg.chat.id, "Принял. Полноценные функции появятся на следующих шагах.");
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
