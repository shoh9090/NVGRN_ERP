// Бот Novagreen. Подключение по номеру, заказ из черновика, меню, каталог, кэш.

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const sd = require("./salesdoctor");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TG_ID = process.env.ADMIN_TG_ID;
const WINDOW_DAYS = Number(process.env.AVG_WINDOW_DAYS || 14);

if (!TOKEN) { console.error("[СТАРТ] Нет TELEGRAM_BOT_TOKEN."); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("[СТАРТ] Нет DATABASE_URL."); process.exit(1); }

const isAdmin = (id) => ADMIN_TG_ID && String(id) === String(ADMIN_TG_ID);
const todayStr = () => new Date().toISOString().slice(0, 10);
const tomorrowStr = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
function normPhone(v) { const d = String(v || "").replace(/\D/g, ""); return d.length > 9 ? d.slice(-9) : d; }

// ---------- Кэш (скорость): тяжёлые запросы к SD держим в памяти на время TTL ----------
const _cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val;
  const val = await fn();
  _cache.set(key, { at: Date.now(), val });
  return val;
}
const getCatalog = () => cached("catalog", 3600000, async () => {
  const all = await sd.fetchAll("getProduct", {});
  return all.filter((p) => p.active === "Y" && p.SD_id && p.name)
    .map((p) => ({ SD_id: p.SD_id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
});
const getOrders14 = () => cached("orders14", 600000, () => {
  const to = todayStr(), from = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return sd.fetchAll("getOrder", { filter: { period: { date: { from, to } }, status: [1, 2, 3, 4] } });
});
const getOrdersToday = () => cached("ordersToday", 120000, () => {
  const d = todayStr();
  return sd.fetchAll("getOrder", { filter: { period: { date: { from: d, to: d } }, status: [1, 2, 3, 4, 5] } });
});
const getClientsAll = () => cached("clients", 600000, () => sd.fetchAll("getClient", {}));

// ---------- Языки ----------
const STR = {
  choose_lang: { ru: "Выберите язык / Tilni tanlang:", uz: "Tilni tanlang / Выберите язык:" },
  hello: {
    ru: "Здравствуйте! Это бот Novagreen Foods.\n\nЧтобы подключиться, поделитесь своим номером телефона кнопкой ниже.",
    uz: "Assalomu alaykum! Bu Novagreen Foods boti.\n\nUlanish uchun pastdagi tugma orqali telefon raqamingizni yuboring.",
  },
  share_btn: { ru: "📱 Поделиться номером", uz: "📱 Raqamni yuborish" },
  share_own: { ru: "Поделитесь, пожалуйста, своим номером (кнопкой).", uz: "Iltimos, o‘z raqamingizni (tugma orqali) yuboring." },
  bad_phone: { ru: "Не удалось разобрать номер. Попробуйте ещё раз.", uz: "Raqamni o‘qib bo‘lmadi. Yana urinib ko‘ring." },
  no_match: { ru: "Ваш номер не найден в списке. Обратитесь к вашему агенту Novagreen, затем /start.", uz: "Raqamingiz ro‘yxatda yo‘q. Novagreen agentingizga murojaat qiling, so‘ng /start." },
  linked: { ru: "Готово, вы подключены: ", uz: "Tayyor, ulandingiz: " },
  linked_tail: { ru: "\nИспользуйте меню внизу.", uz: "\nPastdagi menyudan foydalaning." },
  as_zav_one: { ru: (p) => `завсклад точки «${p}»`, uz: (p) => `«${p}» omborchisi` },
  as_zav_many: { ru: (n, l) => `завсклад ${n} точек: ${l}`, uz: (n, l) => `${n} ta nuqta omborchisi: ${l}` },
  as_mgr: { ru: (f, n) => `менеджер сети ${f} (${n} точек)`, uz: (f, n) => `${f} menejeri (${n} ta nuqta)` },
  not_linked: { ru: "Вы ещё не подключены. Отправьте /start.", uz: "Siz ulanmagansiz. /start yuboring." },
  no_history: { ru: (p) => `По точке «${p}» нет истории заказов — черновик не из чего собрать. Соберите вручную: «🆕 Новый заказ».`, uz: (p) => `«${p}» bo‘yicha tarix yo‘q. Qo‘lda yig‘ing: «🆕 Yangi buyurtma».` },
  draft_title: { ru: (p) => `Заказ на завтра для «${p}». Обычно вы заказываете:`, uz: (p) => `«${p}» uchun ertangi buyurtma. Odatda:` },
  draft_confirm_hint: { ru: "Подтвердить?", uz: "Tasdiqlaysizmi?" },
  btn_confirm: { ru: "✅ Подтвердить", uz: "✅ Tasdiqlash" },
  btn_repeat: { ru: "♻️ Как в прошлый раз", uz: "♻️ O‘tgan safargidek" },
  btn_new: { ru: "🆕 Новый заказ", uz: "🆕 Yangi buyurtma" },
  btn_order: { ru: "✅ Оформить", uz: "✅ Rasmiylashtirish" },
  btn_add: { ru: "➕ Добавить позицию", uz: "➕ Mahsulot qo‘shish" },
  btn_back: { ru: "↩ Назад к заказу", uz: "↩ Buyurtmaga qaytish" },
  btn_cancel: { ru: "🔴 Не сегодня", uz: "🔴 Bugun emas" },
  cart_title: { ru: "Соберите заказ кнопками ➖/➕, добавляйте позиции, затем «Оформить»:", uz: "Buyurtmani ➖/➕ bilan yig‘ing, mahsulot qo‘shing, so‘ng «Rasmiylashtirish»:" },
  cat_title: { ru: "Выберите позицию для добавления:", uz: "Qo‘shish uchun mahsulotni tanlang:" },
  sending: { ru: "Отправляю заказ…", uz: "Buyurtma yuborilmoqda…" },
  order_ok: { ru: "✅ Заказ оформлен. Доставка завтра.", uz: "✅ Buyurtma qabul qilindi. Yetkazish — ertaga." },
  order_err: { ru: (e) => `Не удалось оформить заказ: ${e}`, uz: (e) => `Buyurtma rasmiylashtirilmadi: ${e}` },
  cancelled: { ru: "Хорошо, сегодня без заказа.", uz: "Yaxshi, bugun buyurtmasiz." },
  myorder_none: { ru: "На сегодня заказа пока нет.", uz: "Bugun buyurtma yo‘q." },
  myorder_head: { ru: "Ваш заказ на сегодня:", uz: "Bugungi buyurtmangiz:" },
  menu_order: { ru: "🛒 Заказать", uz: "🛒 Buyurtma berish" },
  menu_myorder: { ru: "📦 Мой заказ", uz: "📦 Buyurtmam" },
  status_names: { ru: { 1: "Новый", 2: "Отправлен", 3: "Доставлен", 4: "Закрыт", 5: "Отменён" }, uz: { 1: "Yangi", 2: "Jo‘natildi", 3: "Yetkazildi", 4: "Yopildi", 5: "Bekor qilindi" } },
};
function t(lang, key, ...a) { const e = STR[key] && (STR[key][lang] || STR[key].ru); return typeof e === "function" ? e(...a) : e; }
async function getLang(chatId) { const r = await db.query("SELECT lang FROM user_prefs WHERE chat_id=$1", [chatId]); return (r.rows[0] && r.rows[0].lang) || "ru"; }
async function setLang(chatId, lang) { await db.query(`INSERT INTO user_prefs (chat_id,lang,updated_at) VALUES ($1,$2,now()) ON CONFLICT (chat_id) DO UPDATE SET lang=$2, updated_at=now()`, [chatId, lang]); }
const askContact = (lang) => ({ reply_markup: { keyboard: [[{ text: t(lang, "share_btn"), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
const mainMenu = (lang) => ({ reply_markup: { keyboard: [[{ text: t(lang, "menu_order") }], [{ text: t(lang, "menu_myorder") }]], resize_keyboard: true } });

// ---------- Подключение по номеру ----------
async function linkByPhone(chatId, from, phone9, rawPhone, lang) {
  const pts = await db.query("SELECT sd_id, point_name, firm_name, inn, zavsklad_phone FROM point_contacts");
  const myPoints = pts.rows.filter((r) => r.zavsklad_phone && normPhone(r.zavsklad_phone) === phone9);
  const mgr = await db.query("SELECT inn, firm_name, manager_phone FROM chain_managers");
  const myChains = mgr.rows.filter((r) => r.manager_phone && normPhone(r.manager_phone) === phone9);
  if (!myPoints.length && !myChains.length) { await db.logEvent("onboard_nomatch", chatId, { phone: phone9 }); return { text: t(lang, "no_match"), linked: false }; }
  for (const p of myPoints) await db.query(
    `INSERT INTO point_links (sd_id,telegram_id,chat_id,phone,point_name,firm_name,linked_at) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (sd_id) DO UPDATE SET telegram_id=$2,chat_id=$3,phone=$4,point_name=$5,firm_name=$6,linked_at=now()`,
    [p.sd_id, from.id, chatId, rawPhone, p.point_name, p.firm_name]);
  for (const c of myChains) await db.query(
    `INSERT INTO manager_links (inn,telegram_id,chat_id,phone,firm_name,linked_at) VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (inn) DO UPDATE SET telegram_id=$2,chat_id=$3,phone=$4,firm_name=$5,linked_at=now()`,
    [c.inn, from.id, chatId, rawPhone, c.firm_name]);
  await db.logEvent("onboard_ok", chatId, { points: myPoints.length, chains: myChains.length });
  const parts = [];
  if (myPoints.length === 1) parts.push(t(lang, "as_zav_one", myPoints[0].point_name));
  else if (myPoints.length > 1) parts.push(t(lang, "as_zav_many", myPoints.length, myPoints.map((p) => p.point_name).join(", ")));
  if (myChains.length) { const inns = myChains.map((c) => c.inn); const cnt = pts.rows.filter((r) => inns.includes(r.inn)).length; parts.push(t(lang, "as_mgr", myChains.map((c) => c.firm_name).join(", "), cnt)); }
  return { text: t(lang, "linked") + parts.join("; ") + "." + t(lang, "linked_tail"), linked: true };
}

// ---------- Черновик / каталог / заказ ----------
const draftCache = new Map();

async function getPointDraft(sdId, mode) {
  const orders = await getOrders14();
  const mine = orders.filter((o) => o.client && o.client.SD_id === sdId);
  if (!mine.length) return null;
  mine.sort((a, b) => String(b.dateCreate || "").localeCompare(String(a.dateCreate || "")));
  const last = mine[0];
  const meta = { agent: last.agent && last.agent.SD_id, priceType: last.priceType && last.priceType.SD_id, warehouse: (last.store && last.store.SD_id) || (last.warehouse && last.warehouse.SD_id) };
  let items;
  if (mode === "repeat") {
    items = (last.orderProducts || []).filter((op) => op.product && op.product.SD_id && Number(op.quantity) > 0)
      .map((op) => ({ productSdId: op.product.SD_id, name: op.product.name || op.product.SD_id, qty: Math.max(1, Math.round(Number(op.quantity))) }));
  } else {
    const agg = {};
    for (const o of mine) for (const op of (o.orderProducts || [])) { const p = op.product || {}; if (!p.SD_id) continue; agg[p.SD_id] = agg[p.SD_id] || { name: p.name || p.SD_id, sum: 0 }; agg[p.SD_id].sum += Number(op.quantity) || 0; }
    const days = mine.length;
    items = Object.entries(agg).map(([id, v]) => ({ productSdId: id, name: v.name, qty: Math.round(v.sum / days) })).filter((it) => it.qty >= 1).sort((a, b) => b.qty - a.qty);
  }
  return Object.assign({ items }, meta);
}

async function createOrderFromDraft(sdId, draft) {
  if (!draft.items.length) throw new Error("пустой список товаров");
  if (!draft.agent || !draft.priceType || !draft.warehouse) throw new Error("нет агента/прайса/склада в истории — нужен прошлый заказ точки");
  const order = {
    code_1C: `TGBOT-${sdId}-${todayStr()}`, status: 1, dateShipment: tomorrowStr(),
    comment: "Заказ оформлен через Telegram-бот",
    client: { SD_id: sdId }, agent: { SD_id: draft.agent }, priceType: { SD_id: draft.priceType }, warehouse: { SD_id: draft.warehouse },
    orderProducts: draft.items.map((it) => ({ product: { SD_id: it.productSdId }, quantity: Math.max(1, Math.round(it.qty)) })),
  };
  const resp = await sd.setOrder(order);
  if (!resp || resp.status !== true) throw new Error((resp && resp.error && resp.error.message) || JSON.stringify(resp || {}).slice(0, 300));
  return resp;
}

function draftKeyboard(sdId, lang) {
  return { inline_keyboard: [
    [{ text: t(lang, "btn_confirm"), callback_data: `ord:${sdId}` }],
    [{ text: t(lang, "btn_repeat"), callback_data: `rep:${sdId}` }, { text: t(lang, "btn_new"), callback_data: `new:${sdId}` }],
    [{ text: t(lang, "btn_cancel"), callback_data: `no:${sdId}` }],
  ] };
}
async function sendDraft(bot, chatId, tgId, sdId, pointName, lang, mode) {
  const draft = await getPointDraft(sdId, mode);
  if (!draft || !draft.items.length) { bot.sendMessage(chatId, t(lang, "no_history", pointName || "")); return; }
  draftCache.set(tgId + "|" + sdId, draft);
  const list = draft.items.map((it) => `• ${it.name}: ${it.qty}`).join("\n");
  bot.sendMessage(chatId, t(lang, "draft_title", pointName || "") + "\n\n" + list + "\n\n" + t(lang, "draft_confirm_hint"), { reply_markup: draftKeyboard(sdId, lang) });
}
function renderCart(sdId, cart, lang) {
  const rows = cart.items.map((it, i) => ([
    { text: "➖", callback_data: `dec:${sdId}:${i}` },
    { text: `${it.name}: ${it.qty}`, callback_data: "noop" },
    { text: "➕", callback_data: `inc:${sdId}:${i}` },
  ]));
  rows.push([{ text: t(lang, "btn_add"), callback_data: `add:${sdId}` }]);
  rows.push([{ text: t(lang, "btn_order"), callback_data: `done:${sdId}` }, { text: t(lang, "btn_cancel"), callback_data: `no:${sdId}` }]);
  const lines = cart.items.length ? cart.items.map((it) => `• ${it.name}: ${it.qty}`).join("\n") : "—";
  return { text: t(lang, "cart_title") + "\n\n" + lines, reply_markup: { inline_keyboard: rows } };
}
function renderCatalog(sdId, page, lang, catalog) {
  const PER = 8;
  const pages = Math.max(1, Math.ceil(catalog.length / PER));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = catalog.slice(p * PER, p * PER + PER).map((pr, j) => [{ text: pr.name, callback_data: `padd:${sdId}:${p * PER + j}` }]);
  const nav = [];
  if (p > 0) nav.push({ text: "◀", callback_data: `cat:${sdId}:${p - 1}` });
  nav.push({ text: `${p + 1}/${pages}`, callback_data: "noop" });
  if (p < pages - 1) nav.push({ text: "▶", callback_data: `cat:${sdId}:${p + 1}` });
  rows.push(nav);
  rows.push([{ text: t(lang, "btn_back"), callback_data: `back:${sdId}` }]);
  return { text: t(lang, "cat_title"), reply_markup: { inline_keyboard: rows } };
}

async function main() {
  await db.migrate();
  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log("[СТАРТ] Бот на связи (режим polling).");
  bot.setMyCommands([
    { command: "zakaz", description: "Оформить заказ" },
    { command: "myorder", description: "Мой заказ и статус" },
    { command: "menu", description: "Меню" },
    { command: "start", description: "Старт / язык" },
  ]).catch(() => {});

  async function doZakaz(chatId, fromId, lang) {
    const links = await db.query("SELECT sd_id, point_name FROM point_links WHERE telegram_id=$1", [fromId]);
    if (!links.rows.length) { bot.sendMessage(chatId, t(lang, "not_linked")); return; }
    bot.sendChatAction(chatId, "typing");
    for (const l of links.rows) await sendDraft(bot, chatId, fromId, l.sd_id, l.point_name, lang, "avg");
  }
  async function doMyOrder(chatId, fromId, lang) {
    const links = await db.query("SELECT sd_id, point_name FROM point_links WHERE telegram_id=$1", [fromId]);
    if (!links.rows.length) { bot.sendMessage(chatId, t(lang, "not_linked")); return; }
    bot.sendChatAction(chatId, "typing");
    try {
      const orders = await getOrdersToday();
      const lines = links.rows.map((l) => {
        const mine = orders.filter((o) => o.client && o.client.SD_id === l.sd_id);
        if (!mine.length) return `• ${l.point_name}: —`;
        const st = (STR.status_names[lang] || STR.status_names.ru)[mine[0].status] || mine[0].status;
        return `• ${l.point_name}: ${st}`;
      });
      const any = lines.some((x) => !x.endsWith(": —"));
      bot.sendMessage(chatId, any ? t(lang, "myorder_head") + "\n" + lines.join("\n") : t(lang, "myorder_none"));
    } catch (e) { bot.sendMessage(chatId, "Ошибка: " + e.message); }
  }

  bot.onText(/\/start/, async (msg) => {
    await db.logEvent("start", msg.chat.id, { from: msg.from });
    bot.sendMessage(msg.chat.id, STR.choose_lang.ru, { reply_markup: { inline_keyboard: [[{ text: "Русский", callback_data: "lang:ru" }, { text: "O‘zbekcha", callback_data: "lang:uz" }]] } });
  });
  bot.onText(/\/whoami/, (msg) => bot.sendMessage(msg.chat.id, "Ваш Telegram ID: " + msg.chat.id));
  bot.onText(/\/menu/, async (msg) => { const lang = await getLang(msg.chat.id); bot.sendMessage(msg.chat.id, lang === "uz" ? "Menyu:" : "Меню:", mainMenu(lang)); });
  bot.onText(/\/zakaz|\/order|\/заказ/i, async (msg) => doZakaz(msg.chat.id, msg.from.id, await getLang(msg.chat.id)));
  bot.onText(/\/myorder|\/status|\/мойзаказ/i, async (msg) => doMyOrder(msg.chat.id, msg.from.id, await getLang(msg.chat.id)));

  bot.on("contact", async (msg) => {
    const chatId = msg.chat.id; const lang = await getLang(chatId); const c = msg.contact;
    if (c.user_id && msg.from && c.user_id !== msg.from.id) { bot.sendMessage(chatId, t(lang, "share_own"), askContact(lang)); return; }
    const phone9 = normPhone(c.phone_number);
    if (!phone9) { bot.sendMessage(chatId, t(lang, "bad_phone"), askContact(lang)); return; }
    try {
      const res = await linkByPhone(chatId, msg.from, phone9, c.phone_number, lang);
      bot.sendMessage(chatId, res.text, res.linked ? mainMenu(lang) : { reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error("[ОНБОРДИНГ]", e.message); bot.sendMessage(chatId, "Ошибка при подключении."); }
  });

  bot.on("callback_query", async (q) => {
    const chatId = q.message.chat.id;
    const [act, val] = String(q.data || "").split(":");
    try {
      if (act === "lang") { await setLang(chatId, val === "uz" ? "uz" : "ru"); await bot.answerCallbackQuery(q.id); const lang = await getLang(chatId); await bot.sendMessage(chatId, t(lang, "hello"), askContact(lang)); return; }
      const lang = await getLang(chatId);
      if (act === "noop") { await bot.answerCallbackQuery(q.id); return; }
      if (act === "no") { await bot.answerCallbackQuery(q.id); await bot.editMessageText(t(lang, "cancelled"), { chat_id: chatId, message_id: q.message.message_id }); return; }
      if (act === "rep") { await bot.answerCallbackQuery(q.id); bot.sendChatAction(chatId, "typing"); await sendDraft(bot, chatId, q.from.id, val, "", lang, "repeat"); return; }
      if (act === "new") {
        await bot.answerCallbackQuery(q.id); bot.sendChatAction(chatId, "typing");
        const base = draftCache.get(q.from.id + "|" + val) || (await getPointDraft(val, "avg"));
        const cart = base ? { items: base.items.map((it) => ({ ...it })), agent: base.agent, priceType: base.priceType, warehouse: base.warehouse } : null;
        if (!cart) { await bot.sendMessage(chatId, t(lang, "no_history", "")); return; }
        draftCache.set(q.from.id + "|" + val, cart);
        const v = renderCart(val, cart, lang);
        await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "inc" || act === "dec") {
        await bot.answerCallbackQuery(q.id);
        const idx = Number(String(q.data).split(":")[2]); const cart = draftCache.get(q.from.id + "|" + val);
        if (!cart || !cart.items[idx]) return;
        cart.items[idx].qty = Math.max(0, cart.items[idx].qty + (act === "inc" ? 1 : -1));
        const v = renderCart(val, cart, lang);
        try { await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup }); } catch (_) {}
        return;
      }
      if (act === "add") {
        await bot.answerCallbackQuery(q.id); bot.sendChatAction(chatId, "typing");
        const catalog = await getCatalog();
        const v = renderCatalog(val, 0, lang, catalog);
        await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "cat") {
        await bot.answerCallbackQuery(q.id);
        const page = Number(String(q.data).split(":")[2]) || 0; const catalog = await getCatalog();
        const v = renderCatalog(val, page, lang, catalog);
        try { await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup }); } catch (_) {}
        return;
      }
      if (act === "padd") {
        await bot.answerCallbackQuery(q.id);
        const idx = Number(String(q.data).split(":")[2]); const catalog = await getCatalog(); const prod = catalog[idx];
        const cart = draftCache.get(q.from.id + "|" + val);
        if (cart && prod) { const ex = cart.items.find((it) => it.productSdId === prod.SD_id); if (ex) ex.qty += 1; else cart.items.push({ productSdId: prod.SD_id, name: prod.name, qty: 1 }); }
        const v = renderCart(val, cart || { items: [] }, lang);
        await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "back") {
        await bot.answerCallbackQuery(q.id);
        const cart = draftCache.get(q.from.id + "|" + val) || { items: [] };
        const v = renderCart(val, cart, lang);
        await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "done" || act === "ord") {
        await bot.answerCallbackQuery(q.id, { text: t(lang, "sending") }); bot.sendChatAction(chatId, "typing");
        let draft = draftCache.get(q.from.id + "|" + val) || (await getPointDraft(val, "avg"));
        if (act === "done" && draft) draft = { items: draft.items.filter((it) => it.qty > 0), agent: draft.agent, priceType: draft.priceType, warehouse: draft.warehouse };
        if (!draft) { await bot.editMessageText(t(lang, "order_err", "нет данных"), { chat_id: chatId, message_id: q.message.message_id }); return; }
        try {
          await createOrderFromDraft(val, draft);
          await db.logEvent("order_created", chatId, { sdId: val, mode: act });
          _cache.delete("ordersToday"); // чтобы /myorder сразу увидел заказ
          await bot.editMessageText(t(lang, "order_ok"), { chat_id: chatId, message_id: q.message.message_id });
        } catch (e) { console.error("[ЗАКАЗ]", e.message); await bot.editMessageText(t(lang, "order_err", e.message), { chat_id: chatId, message_id: q.message.message_id }); }
        return;
      }
      await bot.answerCallbackQuery(q.id);
    } catch (e) { console.error("[CALLBACK]", e.message); try { await bot.answerCallbackQuery(q.id); } catch (_) {} }
  });

  bot.onText(/\/horeca/, async (msg) => {
    const id = msg.chat.id;
    if (!isAdmin(id)) { bot.sendMessage(id, "Команда только для администратора. Свой ID: /whoami"); return; }
    bot.sendMessage(id, "Считаю HoReCa без заказа на сегодня…"); bot.sendChatAction(id, "typing");
    try {
      const catId = await sd.resolveCategoryId("Horeca"); if (!catId) throw new Error("нет категории «Horeca»");
      const clients = (await getClientsAll()).filter((c) => c.active === "Y" && c.category && c.category.SD_id === catId);
      const orders = await getOrdersToday();
      const orderedIds = new Set(orders.filter((o) => o.status !== 5).map((o) => o.client && o.client.SD_id).filter(Boolean));
      const notOrdered = clients.filter((c) => !orderedIds.has(c.SD_id));
      const ordered = clients.length - notOrdered.length;
      const lines = notOrdered.slice(0, 50).map((c, i) => `${i + 1}. ${c.name}${c.tel ? " — " + c.tel : ""}`);
      const more = notOrdered.length > 50 ? `\n…и ещё ${notOrdered.length - 50}` : "";
      bot.sendMessage(id, `HoReCa на сегодня:\nВсего активных: ${clients.length}\nУже заказали: ${ordered}\nНе заказали: ${notOrdered.length}\n\n` + (lines.length ? lines.join("\n") + more : "Все заказали."));
    } catch (e) { bot.sendMessage(id, "Ошибка отчёта: " + e.message); }
  });

  bot.on("message", async (msg) => {
    if (msg.contact || (msg.text && msg.text.startsWith("/"))) return;
    const chatId = msg.chat.id; const lang = await getLang(chatId); const txt = (msg.text || "").trim();
    if (txt === STR.menu_order.ru || txt === STR.menu_order.uz) return doZakaz(chatId, msg.from.id, lang);
    if (txt === STR.menu_myorder.ru || txt === STR.menu_myorder.uz) return doMyOrder(chatId, msg.from.id, lang);
    await db.logEvent("message", chatId, { text: msg.text });
    bot.sendMessage(chatId, lang === "uz" ? "Menyudan foydalaning yoki /start." : "Воспользуйтесь меню внизу или /start.", mainMenu(lang));
  });

  bot.on("polling_error", (err) => console.error("[Telegram] Ошибка опроса:", err.message));
}

main().catch((e) => { console.error("[СТАРТ] Критическая ошибка запуска:", e.message); process.exit(1); });
