// Точка входа бота.
// Шаг 1 — каркас. Шаг 2 — SalesDoctor. Шаг 3 — отчёт /horeca.
// Шаг 5 — онбординг: подключение завскладов и менеджеров сетей по номеру телефона.

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

// Телефоны в CRM записаны по-разному (+998…, 90 123 45 67, 71 241 20 67).
// Сверяем по последним 9 цифрам — формат тогда не мешает.
function normPhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d.length > 9 ? d.slice(-9) : d;
}

const askContact = {
  reply_markup: {
    keyboard: [[{ text: "📱 Поделиться номером", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

// Привязка по номеру: ищем точки (завсклад) и сети (менеджер), сохраняем связи.
async function linkByPhone(chatId, from, phone9, rawPhone) {
  const pts = await db.query(
    "SELECT sd_id, point_name, firm_name, inn, zavsklad_phone FROM point_contacts"
  );
  const myPoints = pts.rows.filter(
    (r) => r.zavsklad_phone && normPhone(r.zavsklad_phone) === phone9
  );
  const mgr = await db.query("SELECT inn, firm_name, manager_phone FROM chain_managers");
  const myChains = mgr.rows.filter(
    (r) => r.manager_phone && normPhone(r.manager_phone) === phone9
  );

  if (!myPoints.length && !myChains.length) {
    await db.logEvent("onboard_nomatch", chatId, { phone: phone9 });
    return (
      "Ваш номер не найден в списке контактов. " +
      "Обратитесь к вашему торговому агенту Novagreen — он добавит вас, и затем повторите /start."
    );
  }

  for (const p of myPoints) {
    await db.query(
      `INSERT INTO point_links (sd_id, telegram_id, chat_id, phone, point_name, firm_name, linked_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (sd_id) DO UPDATE SET telegram_id=$2, chat_id=$3, phone=$4,
         point_name=$5, firm_name=$6, linked_at=now()`,
      [p.sd_id, from.id, chatId, rawPhone, p.point_name, p.firm_name]
    );
  }
  for (const c of myChains) {
    await db.query(
      `INSERT INTO manager_links (inn, telegram_id, chat_id, phone, firm_name, linked_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (inn) DO UPDATE SET telegram_id=$2, chat_id=$3, phone=$4,
         firm_name=$5, linked_at=now()`,
      [c.inn, from.id, chatId, rawPhone, c.firm_name]
    );
  }
  await db.logEvent("onboard_ok", chatId, { points: myPoints.length, chains: myChains.length });

  const parts = [];
  if (myPoints.length === 1) parts.push(`завсклад точки «${myPoints[0].point_name}»`);
  else if (myPoints.length > 1)
    parts.push(`завсклад ${myPoints.length} точек: ${myPoints.map((p) => p.point_name).join(", ")}`);
  if (myChains.length) {
    const inns = myChains.map((c) => c.inn);
    const cnt = pts.rows.filter((r) => inns.includes(r.inn)).length;
    parts.push(`менеджер сети ${myChains.map((c) => c.firm_name).join(", ")} (${cnt} точек)`);
  }
  return "Готово, вы подключены: " + parts.join("; ") + ".\nКогда подойдёт время заказа, я напомню здесь.";
}

// Отчёт: HoReCa-клиенты без заказа на сегодня (заказ сегодня = доставка завтра).
async function buildHorecaReport() {
  const catId = await sd.resolveCategoryId("Horeca");
  if (!catId) throw new Error("В SalesDoctor не найдена категория «Horeca».");

  const allClients = await sd.fetchAll("getClient", {});
  const clients = allClients.filter(
    (c) => c.active === "Y" && c.category && c.category.SD_id === catId
  );

  const d = todayStr();
  const orders = await sd.fetchAll("getOrder", {
    filter: { period: { date: { from: d, to: d } }, status: [1, 2, 3, 4] },
  });
  const orderedIds = new Set(orders.map((o) => o.client && o.client.SD_id).filter(Boolean));

  const notOrdered = clients.filter((c) => !orderedIds.has(c.SD_id));
  const ordered = clients.length - notOrdered.length; // считаем только по HoReCa
  return { total: clients.length, ordered, notOrdered };
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

  // /start — приветствие + просьба поделиться номером для подключения.
  bot.onText(/\/start/, async (msg) => {
    await db.logEvent("start", msg.chat.id, { from: msg.from });
    bot.sendMessage(
      msg.chat.id,
      "Здравствуйте! Это бот Novagreen Foods.\n\n" +
        "Чтобы подключиться, поделитесь своим номером телефона — кнопкой ниже. " +
        "По номеру я найду вашу точку или сеть.",
      askContact
    );
  });

  // Узнать свой Telegram ID.
  bot.onText(/\/whoami/, (msg) => {
    bot.sendMessage(msg.chat.id, "Ваш Telegram ID: " + msg.chat.id);
  });

  // Получили контакт — подключаем.
  bot.on("contact", async (msg) => {
    const chatId = msg.chat.id;
    const contact = msg.contact;
    if (contact.user_id && msg.from && contact.user_id !== msg.from.id) {
      bot.sendMessage(chatId, "Поделитесь, пожалуйста, своим номером (кнопкой), а не чужим контактом.", askContact);
      return;
    }
    const phone9 = normPhone(contact.phone_number);
    if (!phone9) {
      bot.sendMessage(chatId, "Не удалось разобрать номер. Попробуйте ещё раз.", askContact);
      return;
    }
    try {
      const reply = await linkByPhone(chatId, msg.from, phone9, contact.phone_number);
      bot.sendMessage(chatId, reply, { reply_markup: { remove_keyboard: true } });
    } catch (e) {
      console.error("[ОНБОРДИНГ] Ошибка:", e.message);
      bot.sendMessage(chatId, "Произошла ошибка при подключении. Попробуйте позже.");
    }
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

  // Прочие сообщения (не команды, не контакт) — лог + заглушка.
  bot.on("message", async (msg) => {
    if (msg.contact) return; // контакт обрабатывается отдельно
    if (msg.text && msg.text.startsWith("/")) return;
    await db.logEvent("message", msg.chat.id, { text: msg.text });
    bot.sendMessage(msg.chat.id, "Принял. Если нужно подключиться — отправьте /start.");
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
