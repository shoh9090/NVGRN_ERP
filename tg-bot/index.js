// Точка входа бота.
// Шаги 1-3 — каркас, SalesDoctor, отчёт /horeca.
// Шаг 5 — онбординг (подключение по номеру).
// Шаг 6 (Stage 1) — язык RU/UZ + заказ из черновика по кнопке + статус.

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const sd = require("./salesdoctor");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TG_ID = process.env.ADMIN_TG_ID;
const WINDOW_DAYS = Number(process.env.AVG_WINDOW_DAYS || 14); // окно усреднения (позже — в настройках плитки)

if (!TOKEN) { console.error("[СТАРТ] Нет TELEGRAM_BOT_TOKEN."); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("[СТАРТ] Нет DATABASE_URL."); process.exit(1); }

const isAdmin = (id) => ADMIN_TG_ID && String(id) === String(ADMIN_TG_ID);
const todayStr = () => new Date().toISOString().slice(0, 10);
const tomorrowStr = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
function normPhone(v) { const d = String(v || "").replace(/\D/g, ""); return d.length > 9 ? d.slice(-9) : d; }

// ----------------- Языки (RU / UZ) -----------------
const STR = {
  choose_lang: { ru: "Выберите язык / Tilni tanlang:", uz: "Tilni tanlang / Выберите язык:" },
  hello: {
    ru: "Здравствуйте! Это бот Novagreen Foods.\n\nЧтобы подключиться, поделитесь своим номером телефона кнопкой ниже.",
    uz: "Assalomu alaykum! Bu Novagreen Foods boti.\n\nUlanish uchun pastdagi tugma orqali telefon raqamingizni yuboring.",
  },
  share_btn: { ru: "📱 Поделиться номером", uz: "📱 Raqamni yuborish" },
  share_own: { ru: "Поделитесь, пожалуйста, своим номером (кнопкой), а не чужим контактом.", uz: "Iltimos, o‘zingizning raqamingizni (tugma orqali) yuboring." },
  bad_phone: { ru: "Не удалось разобрать номер. Попробуйте ещё раз.", uz: "Raqamni o‘qib bo‘lmadi. Yana urinib ko‘ring." },
  no_match: {
    ru: "Ваш номер не найден в списке. Обратитесь к вашему агенту Novagreen — он добавит вас, затем повторите /start.",
    uz: "Raqamingiz ro‘yxatda topilmadi. Novagreen agentingizga murojaat qiling, so‘ng /start ni qayta bosing.",
  },
  linked: { ru: "Готово, вы подключены: ", uz: "Tayyor, siz ulandingiz: " },
  linked_tail: { ru: "\nКогда подойдёт время заказа, я напомню здесь.", uz: "\nBuyurtma vaqti kelganda shu yerda eslataman." },
  as_zav_one: { ru: (p) => `завсклад точки «${p}»`, uz: (p) => `«${p}» nuqtasi omborchisi` },
  as_zav_many: { ru: (n, l) => `завсклад ${n} точек: ${l}`, uz: (n, l) => `${n} ta nuqta omborchisi: ${l}` },
  as_mgr: { ru: (f, n) => `менеджер сети ${f} (${n} точек)`, uz: (f, n) => `${f} tarmog‘i menejeri (${n} ta nuqta)` },
  not_linked: { ru: "Вы ещё не подключены. Отправьте /start.", uz: "Siz hali ulanmagansiz. /start yuboring." },
  no_history: { ru: (p) => `По точке «${p}» нет истории заказов за период — черновик не из чего собрать.`, uz: (p) => `«${p}» bo‘yicha so‘nggi davrda buyurtma tarixi yo‘q.` },
  draft_title: { ru: (p) => `Заказ на завтра для «${p}». Обычно вы заказываете:`, uz: (p) => `«${p}» uchun ertangi buyurtma. Odatda siz buyurtma qilasiz:` },
  draft_confirm_hint: { ru: "Подтвердить?", uz: "Tasdiqlaysizmi?" },
  btn_confirm: { ru: "✅ Подтвердить", uz: "✅ Tasdiqlash" },
  btn_repeat: { ru: "♻️ Как в прошлый раз", uz: "♻️ O‘tgan safargidek" },
  btn_cancel: { ru: "Не сегодня", uz: "Bugun emas" },
  sending: { ru: "Отправляю заказ…", uz: "Buyurtma yuborilmoqda…" },
  order_ok: { ru: "✅ Заказ оформлен. Доставка завтра.", uz: "✅ Buyurtma rasmiylashtirildi. Yetkazib berish — ertaga." },
  order_err: { ru: (e) => `Не удалось оформить заказ: ${e}\nПопробуйте позже или свяжитесь с агентом.`, uz: (e) => `Buyurtma rasmiylashtirilmadi: ${e}` },
  cancelled: { ru: "Хорошо, сегодня без заказа.", uz: "Yaxshi, bugun buyurtmasiz." },
  myorder_none: { ru: "На сегодня заказа пока нет. Отправьте /zakaz, чтобы оформить.", uz: "Bugun buyurtma yo‘q. Rasmiylashtirish uchun /zakaz yuboring." },
  myorder_head: { ru: "Ваш заказ на сегодня:", uz: "Bugungi buyurtmangiz:" },
  status_names: { ru: { 1: "Новый", 2: "Отправлен", 3: "Доставлен", 4: "Закрыт", 5: "Отменён" }, uz: { 1: "Yangi", 2: "Jo‘natildi", 3: "Yetkazildi", 4: "Yopilgan", 5: "Bekor qilingan" } },
};
function t(lang, key, ...args) {
  const e = STR[key] && (STR[key][lang] || STR[key].ru);
  return typeof e === "function" ? e(...args) : e;
}
async function getLang(chatId) {
  const r = await db.query("SELECT lang FROM user_prefs WHERE chat_id = $1", [chatId]);
  return (r.rows[0] && r.rows[0].lang) || "ru";
}
async function setLang(chatId, lang) {
  await db.query(
    `INSERT INTO user_prefs (chat_id, lang, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (chat_id) DO UPDATE SET lang=$2, updated_at=now()`, [chatId, lang]
  );
}
const askContact = (lang) => ({
  reply_markup: { keyboard: [[{ text: t(lang, "share_btn"), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
});

// ----------------- Подключение по номеру -----------------
async function linkByPhone(chatId, from, phone9, rawPhone, lang) {
  const pts = await db.query("SELECT sd_id, point_name, firm_name, inn, zavsklad_phone FROM point_contacts");
  const myPoints = pts.rows.filter((r) => r.zavsklad_phone && normPhone(r.zavsklad_phone) === phone9);
  const mgr = await db.query("SELECT inn, firm_name, manager_phone FROM chain_managers");
  const myChains = mgr.rows.filter((r) => r.manager_phone && normPhone(r.manager_phone) === phone9);

  if (!myPoints.length && !myChains.length) {
    await db.logEvent("onboard_nomatch", chatId, { phone: phone9 });
    return t(lang, "no_match");
  }
  for (const p of myPoints) {
    await db.query(
      `INSERT INTO point_links (sd_id, telegram_id, chat_id, phone, point_name, firm_name, linked_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (sd_id) DO UPDATE SET telegram_id=$2, chat_id=$3, phone=$4, point_name=$5, firm_name=$6, linked_at=now()`,
      [p.sd_id, from.id, chatId, rawPhone, p.point_name, p.firm_name]
    );
  }
  for (const c of myChains) {
    await db.query(
      `INSERT INTO manager_links (inn, telegram_id, chat_id, phone, firm_name, linked_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (inn) DO UPDATE SET telegram_id=$2, chat_id=$3, phone=$4, firm_name=$5, linked_at=now()`,
      [c.inn, from.id, chatId, rawPhone, c.firm_name]
    );
  }
  await db.logEvent("onboard_ok", chatId, { points: myPoints.length, chains: myChains.length });
  const parts = [];
  if (myPoints.length === 1) parts.push(t(lang, "as_zav_one", myPoints[0].point_name));
  else if (myPoints.length > 1) parts.push(t(lang, "as_zav_many", myPoints.length, myPoints.map((p) => p.point_name).join(", ")));
  if (myChains.length) {
    const inns = myChains.map((c) => c.inn);
    const cnt = pts.rows.filter((r) => inns.includes(r.inn)).length;
    parts.push(t(lang, "as_mgr", myChains.map((c) => c.firm_name).join(", "), cnt));
  }
  return t(lang, "linked") + parts.join("; ") + "." + t(lang, "linked_tail");
}

// ----------------- Черновик заказа из истории -----------------
const draftCache = new Map(); // ключ telegramId|sdId -> draft (живёт между показом и подтверждением)

async function getPointDraft(sdId, mode) {
  const to = todayStr();
  const from = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const orders = await sd.fetchAll("getOrder", { filter: { period: { date: { from, to } }, status: [1, 2, 3, 4] } });
  const mine = orders.filter((o) => o.client && o.client.SD_id === sdId);
  if (!mine.length) return null;
  mine.sort((a, b) => String(b.dateCreate || "").localeCompare(String(a.dateCreate || "")));
  const last = mine[0];
  const meta = {
    agent: last.agent && last.agent.SD_id,
    priceType: last.priceType && last.priceType.SD_id,
    warehouse: (last.store && last.store.SD_id) || (last.warehouse && last.warehouse.SD_id),
  };
  let items;
  if (mode === "repeat") {
    // ровно как в последнем заказе
    items = (last.orderProducts || [])
      .filter((op) => op.product && op.product.SD_id && Number(op.quantity) > 0)
      .map((op) => ({ productSdId: op.product.SD_id, name: op.product.name || op.product.SD_id, qty: Number(op.quantity) }));
  } else {
    // средняя дневная заявка по окну
    const agg = {};
    for (const o of mine) for (const op of (o.orderProducts || [])) {
      const p = op.product || {}; if (!p.SD_id) continue;
      agg[p.SD_id] = agg[p.SD_id] || { name: p.name || p.SD_id, sum: 0 };
      agg[p.SD_id].sum += Number(op.quantity) || 0;
    }
    const days = mine.length;
    items = Object.entries(agg)
      .map(([id, v]) => ({ productSdId: id, name: v.name, qty: Math.round((v.sum / days) * 10) / 10 }))
      .filter((it) => it.qty > 0).sort((a, b) => b.qty - a.qty);
  }
  return Object.assign({ items }, meta);
}

async function createOrderFromDraft(sdId, draft) {
  if (!draft.items.length) throw new Error("пустой список товаров");
  if (!draft.agent || !draft.priceType || !draft.warehouse)
    throw new Error("в истории заказов нет агента/прайса/склада — нужен хотя бы один прошлый заказ");
  const order = {
    code_1C: `TGBOT-${sdId}-${todayStr()}`, // идемпотентность: повтор за день обновит, не задвоит
    status: 1,
    dateShipment: tomorrowStr(),
    comment: "Заказ оформлен через Telegram-бот",
    client: { SD_id: sdId },
    agent: { SD_id: draft.agent },
    priceType: { SD_id: draft.priceType },
    warehouse: { SD_id: draft.warehouse },
    orderProducts: draft.items.map((it) => ({ product: { SD_id: it.productSdId }, quantity: it.qty })),
  };
  const resp = await sd.setOrder(order);
  if (!resp || resp.status !== true) {
    const msg = (resp && resp.error && resp.error.message) || JSON.stringify(resp || {}).slice(0, 300);
    throw new Error(msg);
  }
  return resp;
}

async function sendDraft(bot, chatId, tgId, sdId, pointName, lang, mode) {
  const draft = await getPointDraft(sdId, mode);
  if (!draft || !draft.items.length) { bot.sendMessage(chatId, t(lang, "no_history", pointName)); return; }
  draftCache.set(tgId + "|" + sdId, draft);
  const list = draft.items.map((it) => `• ${it.name}: ${it.qty}`).join("\n");
  bot.sendMessage(chatId, t(lang, "draft_title", pointName) + "\n\n" + list + "\n\n" + t(lang, "draft_confirm_hint"), {
    reply_markup: { inline_keyboard: [[
      { text: t(lang, "btn_confirm"), callback_data: `ord:${sdId}` },
      { text: t(lang, "btn_repeat"), callback_data: `rep:${sdId}` },
    ], [{ text: t(lang, "btn_cancel"), callback_data: `no:${sdId}` }]] },
  });
}

async function main() {
  await db.migrate();
  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log("[СТАРТ] Бот на связи (режим polling).");

  // /start — выбор языка, затем просьба о номере.
  bot.onText(/\/start/, async (msg) => {
    await db.logEvent("start", msg.chat.id, { from: msg.from });
    bot.sendMessage(msg.chat.id, STR.choose_lang.ru, {
      reply_markup: { inline_keyboard: [[
        { text: "Русский", callback_data: "lang:ru" }, { text: "O‘zbekcha", callback_data: "lang:uz" },
      ]] },
    });
  });

  bot.onText(/\/whoami/, (msg) => bot.sendMessage(msg.chat.id, "Ваш Telegram ID: " + msg.chat.id));

  // /zakaz — показать черновик заказа по своим точкам.
  bot.onText(/\/zakaz|\/order|\/заказ/i, async (msg) => {
    const chatId = msg.chat.id;
    const lang = await getLang(chatId);
    const links = await db.query("SELECT sd_id, point_name FROM point_links WHERE telegram_id = $1", [msg.from.id]);
    if (!links.rows.length) { bot.sendMessage(chatId, t(lang, "not_linked")); return; }
    for (const l of links.rows) await sendDraft(bot, chatId, msg.from.id, l.sd_id, l.point_name, lang, "avg");
  });

  // /myorder — заказ на сегодня и его статус.
  bot.onText(/\/myorder|\/status|\/мойзаказ/i, async (msg) => {
    const chatId = msg.chat.id;
    const lang = await getLang(chatId);
    const links = await db.query("SELECT sd_id, point_name FROM point_links WHERE telegram_id = $1", [msg.from.id]);
    if (!links.rows.length) { bot.sendMessage(chatId, t(lang, "not_linked")); return; }
    try {
      const d = todayStr();
      const orders = await sd.fetchAll("getOrder", { filter: { period: { date: { from: d, to: d } }, status: [1, 2, 3, 4, 5] } });
      const lines = [];
      for (const l of links.rows) {
        const mine = orders.filter((o) => o.client && o.client.SD_id === l.sd_id);
        if (!mine.length) { lines.push(`• ${l.point_name}: —`); continue; }
        const o = mine[0];
        const st = (STR.status_names[lang] || STR.status_names.ru)[o.status] || o.status;
        lines.push(`• ${l.point_name}: ${st}`);
      }
      const any = lines.some((x) => !x.endsWith(": —"));
      bot.sendMessage(chatId, any ? t(lang, "myorder_head") + "\n" + lines.join("\n") : t(lang, "myorder_none"));
    } catch (e) {
      bot.sendMessage(chatId, "Ошибка: " + e.message);
    }
  });

  // Контакт — подключаем.
  bot.on("contact", async (msg) => {
    const chatId = msg.chat.id;
    const lang = await getLang(chatId);
    const c = msg.contact;
    if (c.user_id && msg.from && c.user_id !== msg.from.id) { bot.sendMessage(chatId, t(lang, "share_own"), askContact(lang)); return; }
    const phone9 = normPhone(c.phone_number);
    if (!phone9) { bot.sendMessage(chatId, t(lang, "bad_phone"), askContact(lang)); return; }
    try {
      const reply = await linkByPhone(chatId, msg.from, phone9, c.phone_number, lang);
      bot.sendMessage(chatId, reply, { reply_markup: { remove_keyboard: true } });
    } catch (e) {
      console.error("[ОНБОРДИНГ] Ошибка:", e.message);
      bot.sendMessage(chatId, "Ошибка при подключении. Попробуйте позже.");
    }
  });

  // Inline-кнопки: язык / заказ / повтор / отмена.
  bot.on("callback_query", async (q) => {
    const chatId = q.message.chat.id;
    const [act, val] = String(q.data || "").split(":");
    try {
      if (act === "lang") {
        await setLang(chatId, val === "uz" ? "uz" : "ru");
        await bot.answerCallbackQuery(q.id);
        const lang = await getLang(chatId);
        await bot.sendMessage(chatId, t(lang, "hello"), askContact(lang));
        return;
      }
      const lang = await getLang(chatId);
      if (act === "no") {
        await bot.answerCallbackQuery(q.id);
        await bot.editMessageText(t(lang, "cancelled"), { chat_id: chatId, message_id: q.message.message_id });
        return;
      }
      if (act === "rep") { // повторить как в прошлый раз
        await bot.answerCallbackQuery(q.id);
        await sendDraft(bot, chatId, q.from.id, val, "", lang, "repeat");
        return;
      }
      if (act === "ord") {
        await bot.answerCallbackQuery(q.id, { text: t(lang, "sending") });
        const draft = draftCache.get(q.from.id + "|" + val) || (await getPointDraft(val, "avg"));
        if (!draft) { await bot.editMessageText(t(lang, "order_err", "нет данных"), { chat_id: chatId, message_id: q.message.message_id }); return; }
        try {
          await createOrderFromDraft(val, draft);
          await db.logEvent("order_created", chatId, { sdId: val });
          await bot.editMessageText(t(lang, "order_ok"), { chat_id: chatId, message_id: q.message.message_id });
        } catch (e) {
          console.error("[ЗАКАЗ] Ошибка:", e.message);
          await bot.editMessageText(t(lang, "order_err", e.message), { chat_id: chatId, message_id: q.message.message_id });
        }
        return;
      }
      await bot.answerCallbackQuery(q.id);
    } catch (e) {
      console.error("[CALLBACK] Ошибка:", e.message);
      try { await bot.answerCallbackQuery(q.id); } catch (_) {}
    }
  });

  // Отчёт админу: кто из HoReCa сегодня не заказал.
  bot.onText(/\/horeca/, async (msg) => {
    const id = msg.chat.id;
    if (!isAdmin(id)) { bot.sendMessage(id, "Команда только для администратора. Свой ID: /whoami"); return; }
    bot.sendMessage(id, "Считаю HoReCa-клиентов без заказа на сегодня…");
    try {
      const catId = await sd.resolveCategoryId("Horeca");
      if (!catId) throw new Error("В SalesDoctor не найдена категория «Horeca».");
      const allClients = await sd.fetchAll("getClient", {});
      const clients = allClients.filter((c) => c.active === "Y" && c.category && c.category.SD_id === catId);
      const d = todayStr();
      const orders = await sd.fetchAll("getOrder", { filter: { period: { date: { from: d, to: d } }, status: [1, 2, 3, 4] } });
      const orderedIds = new Set(orders.map((o) => o.client && o.client.SD_id).filter(Boolean));
      const notOrdered = clients.filter((c) => !orderedIds.has(c.SD_id));
      const ordered = clients.length - notOrdered.length;
      const lines = notOrdered.slice(0, 50).map((c, i) => `${i + 1}. ${c.name}${c.tel ? " — " + c.tel : ""}`);
      const more = notOrdered.length > 50 ? `\n…и ещё ${notOrdered.length - 50}` : "";
      bot.sendMessage(id, `HoReCa на сегодня:\nВсего активных: ${clients.length}\nУже заказали: ${ordered}\nНе заказали: ${notOrdered.length}\n\n` + (lines.length ? lines.join("\n") + more : "Все заказали."));
    } catch (e) { bot.sendMessage(id, "Не получилось собрать отчёт: " + e.message); }
  });

  // Прочее (не команды, не контакт).
  bot.on("message", async (msg) => {
    if (msg.contact) return;
    if (msg.text && msg.text.startsWith("/")) return;
    const lang = await getLang(msg.chat.id);
    await db.logEvent("message", msg.chat.id, { text: msg.text });
    bot.sendMessage(msg.chat.id, lang === "uz" ? "Qabul qilindi. Ulanish uchun /start." : "Принял. Для подключения — /start.");
  });

  bot.on("polling_error", (err) => { console.error("[Telegram] Ошибка опроса:", err.message); });
}

main().catch((e) => { console.error("[СТАРТ] Критическая ошибка запуска:", e.message); process.exit(1); });
