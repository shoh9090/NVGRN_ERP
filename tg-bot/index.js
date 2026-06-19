// Бот Novagreen. Личность = номер (точки определяются на лету из point_contacts).
// Заказ из черновика, меню, каталог по остаткам, дедуп + доп.заказ, RU/UZ, прогрев кэша.

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const sd = require("./salesdoctor");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TG_ID = process.env.ADMIN_TG_ID;
const WINDOW_DAYS = Number(process.env.AVG_WINDOW_DAYS || 14);
const TZ_OFFSET_MS = 5 * 3600 * 1000; // Asia/Tashkent = UTC+5
let botCfg = { times: ["18:00", "21:00", "23:00"], deadline: "00:00", window: WINDOW_DAYS, enabled: true };

if (!TOKEN) { console.error("[СТАРТ] Нет TELEGRAM_BOT_TOKEN."); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("[СТАРТ] Нет DATABASE_URL."); process.exit(1); }

const isAdmin = (id) => ADMIN_TG_ID && String(id) === String(ADMIN_TG_ID);
const tzNow = () => new Date(Date.now() + TZ_OFFSET_MS);
const tzToday = () => tzNow().toISOString().slice(0, 10);
const tzTomorrow = () => new Date(Date.now() + TZ_OFFSET_MS + 86400000).toISOString().slice(0, 10);
const tzHHMM = () => tzNow().toISOString().slice(11, 16).replace(":", "");
function normPhone(v) { const d = String(v || "").replace(/\D/g, ""); return d.length > 9 ? d.slice(-9) : d; }
const PH9 = (col) => `right(regexp_replace(coalesce(${col},''),'[^0-9]','','g'),9)`;

// ---------- Кэш ----------
const _cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val;
  const val = await fn();
  _cache.set(key, { at: Date.now(), val });
  return val;
}
const getHorecaProdCat = () => cached("prodcat_horeca", 3600000, async () => {
  const cats = await sd.fetchAll("getProductCategory", {});
  const h = cats.find((c) => String(c.name || "").trim().toLowerCase() === "horeca");
  if (!h) console.warn("[КАТАЛОГ] Товарная категория «Horeca» не найдена — каталог будет общим.");
  return h ? h.SD_id : null;
});
const getStockData = () => cached("stock", 300000, async () => {
  const catId = await getHorecaProdCat();
  const whs = await sd.fetchAll("getStock", catId ? { category: { SD_id: catId } } : {});
  const map = {}, names = {};
  for (const w of whs) for (const p of (w.products || [])) {
    if (!p.SD_id) continue;
    map[p.SD_id] = (map[p.SD_id] || 0) + (Number(p.quantity) || 0);
    names[p.SD_id] = p.name || p.SD_id;
  }
  const catalog = Object.keys(map).filter((id) => map[id] > 0)
    .map((id) => ({ SD_id: id, name: names[id], qty: map[id] })).sort((a, b) => a.name.localeCompare(b.name));
  return { map, catalog };
});
const getCatalog = async () => (await getStockData()).catalog;
const getStockMap = async () => (await getStockData()).map;
const getOrders14 = () => cached("orders14", 600000, () => {
  const to = tzToday(), from = new Date(Date.now() + TZ_OFFSET_MS - botCfg.window * 86400000).toISOString().slice(0, 10);
  return sd.fetchAll("getOrder", { filter: { period: { date: { from, to } }, status: [1, 2, 3, 4] } });
});
const getOrdersToday = () => cached("ordersToday", 120000, () => {
  const d = tzToday();
  return sd.fetchAll("getOrder", { filter: { period: { date: { from: d, to: d } }, status: [1, 2, 3, 4, 5] } });
});
const freshOrdersToday = () => { _cache.delete("ordersToday"); return getOrdersToday(); };
const getClientsAll = () => cached("clients", 600000, () => sd.fetchAll("getClient", {}));
async function reloadCfg() {
  try {
    const r = await db.query("SELECT reminder_times, deadline, avg_window_days, enabled FROM bot_settings WHERE id=1");
    if (r.rows[0]) {
      const s = r.rows[0];
      const times = String(s.reminder_times || "").split(",").map((x) => x.trim()).filter(Boolean);
      const win = Number(s.avg_window_days) || WINDOW_DAYS;
      if (win !== botCfg.window) _cache.delete("orders14");
      botCfg = { times, deadline: s.deadline || "00:00", window: win, enabled: s.enabled !== false };
    }
  } catch (e) { console.warn("[НАСТРОЙКИ]", e.message); }
}

// ---------- Личность по номеру (Вариант Б) ----------
async function phone9OfUser(tgId) { const r = await db.query("SELECT phone9 FROM tg_users WHERE telegram_id=$1", [tgId]); return r.rows[0] && r.rows[0].phone9; }
async function pointsByPhone9(p9) { if (!p9) return []; const r = await db.query(`SELECT sd_id, point_name, firm_name FROM point_contacts WHERE ${PH9("zavsklad_phone")}=$1`, [p9]); return r.rows; }
async function chainsByPhone9(p9) { if (!p9) return []; const r = await db.query(`SELECT inn, firm_name FROM chain_managers WHERE ${PH9("manager_phone")}=$1`, [p9]); return r.rows; }
async function pointsOfUser(tgId) { return pointsByPhone9(await phone9OfUser(tgId)); }

// ---------- Языки ----------
const STR = {
  choose_lang: { ru: "Выберите язык / Tilni tanlang:", uz: "Tilni tanlang / Выберите язык:" },
  hello: { ru: "Здравствуйте! Это бот Novagreen Foods.\n\nЧтобы подключиться, поделитесь своим номером телефона кнопкой ниже.", uz: "Assalomu alaykum! Bu Novagreen Foods boti.\n\nUlanish uchun pastdagi tugma orqali raqamingizni yuboring." },
  share_btn: { ru: "📱 Поделиться номером", uz: "📱 Raqamni yuborish" },
  share_own: { ru: "Поделитесь, пожалуйста, своим номером (кнопкой).", uz: "Iltimos, o‘z raqamingizni (tugma orqali) yuboring." },
  bad_phone: { ru: "Не удалось разобрать номер. Попробуйте ещё раз.", uz: "Raqamni o‘qib bo‘lmadi. Yana urinib ko‘ring." },
  no_match: { ru: "Ваш номер не найден в списке. Обратитесь к вашему агенту Novagreen, затем /start.", uz: "Raqamingiz ro‘yxatda yo‘q. Novagreen agentingizga murojaat qiling, so‘ng /start." },
  welcome: { ru: (n) => `Спасибо, что подключились к нашему чат-боту, «${n}». Рады, что вы с нами!`, uz: (n) => `Chat-botimizga ulanganingiz uchun rahmat, «${n}». Siz bilan ekanimizdan xursandmiz!` },
  not_linked: { ru: "Вы ещё не подключены. Отправьте /start.", uz: "Siz ulanmagansiz. /start yuboring." },
  no_history: { ru: (p) => `По точке «${p}» нет истории — соберите заказ вручную: «🆕 Новый заказ».`, uz: (p) => `«${p}» bo‘yicha tarix yo‘q. Qo‘lda yig‘ing: «🆕 Yangi buyurtma».` },
  all_oos: { ru: (l) => `Сегодня ваших обычных позиций нет в наличии: ${l}.\nМожно собрать вручную:`, uz: (l) => `Bugun odatdagi mahsulotlar yo‘q: ${l}.\nQo‘lda yig‘ish mumkin:` },
  draft_title: { ru: (p) => `Заказ на завтра для «${p}». Обычно вы заказываете:`, uz: (p) => `«${p}» uchun ertangi buyurtma. Odatda:` },
  oos_note: { ru: (l) => `⚠️ Сегодня нет в наличии: ${l}`, uz: (l) => `⚠️ Bugun mavjud emas: ${l}` },
  confirm_hint: { ru: "Подтвердить?", uz: "Tasdiqlaysizmi?" },
  already_ordered: { ru: (p) => `На сегодня по точке «${p}» заказ уже есть:`, uz: (p) => `«${p}» uchun bugun buyurtma allaqachon bor:` },
  btn_dop: { ru: "➕ Дополнительный заказ", uz: "➕ Qo‘shimcha buyurtma" },
  dop_title: { ru: "Дополнительный заказ. Добавьте позиции:", uz: "Qo‘shimcha buyurtma. Mahsulot qo‘shing:" },
  btn_confirm: { ru: "✅ Подтвердить", uz: "✅ Tasdiqlash" },
  btn_repeat: { ru: "♻️ Как в прошлый раз", uz: "♻️ O‘tgan safargidek" },
  btn_new: { ru: "🆕 Новый заказ", uz: "🆕 Yangi buyurtma" },
  btn_order: { ru: "✅ Оформить", uz: "✅ Rasmiylashtirish" },
  btn_add: { ru: "➕ Добавить позицию", uz: "➕ Mahsulot qo‘shish" },
  btn_back: { ru: "↩ Назад к заказу", uz: "↩ Buyurtmaga qaytish" },
  btn_cancel: { ru: "🔴 Не сегодня", uz: "🔴 Bugun emas" },
  cart_title: { ru: "Соберите заказ: ➖/➕, «➕ Добавить позицию», затем «Оформить».", uz: "Buyurtmani yig‘ing: ➖/➕, «➕ Mahsulot qo‘shish», so‘ng «Rasmiylashtirish»." },
  cat_title: { ru: "Выберите позицию (показаны только в наличии):", uz: "Mahsulotni tanlang (faqat mavjudlari):" },
  empty_cart: { ru: "Корзина пуста — добавьте позиции.", uz: "Savat bo‘sh — mahsulot qo‘shing." },
  sending: { ru: "Отправляю…", uz: "Yuborilmoqda…" },
  order_ok: { ru: "Спасибо за сотрудничество с нами! 🌿\nВаш заказ принят и будет доставлен завтра.\nЕсли есть вопросы — свяжитесь с вашим менеджером.", uz: "Hamkorligingiz uchun rahmat! 🌿\nBuyurtmangiz qabul qilindi va ertaga yetkaziladi.\nSavollaringiz bo‘lsa — menejeringizga murojaat qiling." },
  order_err: { ru: (e) => `Не удалось оформить заказ: ${e}`, uz: (e) => `Buyurtma rasmiylashtirilmadi: ${e}` },
  cancelled: { ru: "Хорошо, сегодня без заказа.", uz: "Yaxshi, bugun buyurtmasiz." },
  myorder_none: { ru: "На сегодня заказа пока нет.", uz: "Bugun buyurtma yo‘q." },
  myorder_head: { ru: "Ваш заказ на сегодня:", uz: "Bugungi buyurtmangiz:" },
  menu_order: { ru: "🛒 Заказать", uz: "🛒 Buyurtma berish" },
  menu_myorder: { ru: "📦 Мой заказ", uz: "📦 Buyurtmam" },
  reminder_lead: { ru: "🔔 Напоминание: вы ещё не оформили заказ на завтра.", uz: "🔔 Eslatma: ertangi buyurtmani hali bermadingiz." },
  status_names: { ru: { 1: "Новый", 2: "Отправлен", 3: "Доставлен", 4: "Закрыт", 5: "Отменён" }, uz: { 1: "Yangi", 2: "Jo‘natildi", 3: "Yetkazildi", 4: "Yopildi", 5: "Bekor qilindi" } },
};
function t(lang, key, ...a) { const e = STR[key] && (STR[key][lang] || STR[key].ru); return typeof e === "function" ? e(...a) : e; }
async function getLang(chatId) { const r = await db.query("SELECT lang FROM user_prefs WHERE chat_id=$1", [chatId]); return (r.rows[0] && r.rows[0].lang) || "ru"; }
async function setLang(chatId, lang) { await db.query(`INSERT INTO user_prefs (chat_id,lang,updated_at) VALUES ($1,$2,now()) ON CONFLICT (chat_id) DO UPDATE SET lang=$2, updated_at=now()`, [chatId, lang]); }
const askContact = (lang) => ({ reply_markup: { keyboard: [[{ text: t(lang, "share_btn"), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
const mainMenu = (lang) => ({ reply_markup: { keyboard: [[{ text: t(lang, "menu_order") }], [{ text: t(lang, "menu_myorder") }]], resize_keyboard: true } });
const statusName = (s, lang) => (STR.status_names[lang] || STR.status_names.ru)[s] || s;

// ---------- Онбординг (Вариант Б): запоминаем номер, точки выводим на лету ----------
async function onboard(chatId, from, phone9, rawPhone, lang) {
  await db.query(`INSERT INTO tg_users (telegram_id,chat_id,phone,phone9,linked_at) VALUES ($1,$2,$3,$4,now())
    ON CONFLICT (telegram_id) DO UPDATE SET chat_id=$2, phone=$3, phone9=$4, linked_at=now()`, [from.id, chatId, rawPhone, phone9]);
  const points = await pointsByPhone9(phone9);
  const chains = await chainsByPhone9(phone9);
  if (!points.length && !chains.length) { await db.logEvent("onboard_nomatch", chatId, { phone: phone9 }); return { text: t(lang, "no_match"), linked: false }; }
  await db.logEvent("onboard_ok", chatId, { points: points.length, chains: chains.length });
  const name = (points[0] && (points[0].point_name || points[0].firm_name)) || (chains[0] && chains[0].firm_name) || "Novagreen";
  return { text: t(lang, "welcome", name), linked: true };
}

// ---------- Черновик / остатки / заказ ----------
const draftCache = new Map();

async function getPointDraft(sdId, mode) {
  const orders = await getOrders14();
  const mine = orders.filter((o) => o.client && o.client.SD_id === sdId);
  if (!mine.length) return null;
  mine.sort((a, b) => String(b.dateCreate || "").localeCompare(String(a.dateCreate || "")));
  const last = mine[0];
  const meta = { agent: last.agent && last.agent.SD_id, priceType: last.priceType && last.priceType.SD_id, warehouse: (last.store && last.store.SD_id) || (last.warehouse && last.warehouse.SD_id) };
  let raw;
  if (mode === "repeat") {
    raw = (last.orderProducts || []).filter((op) => op.product && op.product.SD_id && Number(op.quantity) > 0)
      .map((op) => ({ productSdId: op.product.SD_id, name: op.product.name || op.product.SD_id, qty: Math.max(1, Math.round(Number(op.quantity))) }));
  } else {
    const agg = {};
    for (const o of mine) for (const op of (o.orderProducts || [])) { const p = op.product || {}; if (!p.SD_id) continue; agg[p.SD_id] = agg[p.SD_id] || { name: p.name || p.SD_id, sum: 0 }; agg[p.SD_id].sum += Number(op.quantity) || 0; }
    const days = mine.length;
    raw = Object.entries(agg).map(([id, v]) => ({ productSdId: id, name: v.name, qty: Math.round(v.sum / days) })).filter((it) => it.qty >= 1).sort((a, b) => b.qty - a.qty);
  }
  const stock = await getStockMap();
  const items = [], oos = [];
  for (const it of raw) { if ((stock[it.productSdId] || 0) > 0) items.push(it); else oos.push(it.name); }
  return Object.assign({ items, oos }, meta);
}

async function createOrderFromDraft(sdId, draft, code) {
  if (!draft.items.length) throw new Error("список товаров пуст");
  if (!draft.agent || !draft.priceType || !draft.warehouse) throw new Error("нет агента/прайса/склада — нужен прошлый заказ точки");
  const order = {
    code_1C: code || `TGBOT-${sdId}-${tzToday()}`, status: 1, dateShipment: tzTomorrow(),
    comment: "Заказ оформлен через Telegram-бот",
    client: { SD_id: sdId }, agent: { SD_id: draft.agent }, priceType: { SD_id: draft.priceType }, warehouse: { SD_id: draft.warehouse },
    orderProducts: draft.items.filter((it) => it.qty > 0).map((it) => ({ product: { SD_id: it.productSdId }, quantity: Math.max(1, Math.round(it.qty)) })),
  };
  const resp = await sd.setOrder(order);
  if (!resp || resp.status !== true) {
    console.error("[ЗАКАЗ] Ответ SD:", JSON.stringify(resp));
    const m = (resp && (resp.error && (resp.error.message || resp.error)) || resp.message || (resp.errors && resp.errors[0] && (resp.errors[0].message || resp.errors[0]))) || "SD отклонил заказ";
    throw new Error(typeof m === "string" ? m : JSON.stringify(m).slice(0, 200));
  }
  _cache.delete("ordersToday");
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
  if (!draft) { bot.sendMessage(chatId, t(lang, "no_history", pointName || "")); return; }
  if (!draft.items.length) {
    bot.sendMessage(chatId, t(lang, "all_oos", (draft.oos || []).join(", ") || "—"), { reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_new"), callback_data: `new:${sdId}` }]] } });
    return;
  }
  draftCache.set(tgId + "|" + sdId, draft);
  const list = draft.items.map((it) => `• ${it.name}: ${it.qty}`).join("\n");
  let text = t(lang, "draft_title", pointName || "") + "\n\n" + list;
  if (draft.oos && draft.oos.length) text += "\n\n" + t(lang, "oos_note", draft.oos.join(", "));
  text += "\n\n" + t(lang, "confirm_hint");
  bot.sendMessage(chatId, text, { reply_markup: draftKeyboard(sdId, lang) });
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
const orderItemsText = (o) => (o.orderProducts || []).map((op) => `• ${(op.product && op.product.name) || "?"}: ${op.quantity}`).join("\n") || "—";

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

  // Прогрев кэша: каталог/остатки и история всегда «горячие», чтобы «Добавить» открывалось мгновенно.
  const warmStock = async () => { try { _cache.delete("stock"); await getStockData(); } catch (e) { console.warn("[ПРОГРЕВ stock]", e.message); } };
  getHorecaProdCat().catch(() => {});
  warmStock(); getOrders14().catch(() => {});
  setInterval(warmStock, 240000); // каждые 4 мин (TTL 5 мин)
  setInterval(() => { _cache.delete("orders14"); getOrders14().catch(() => {}); }, 540000); // каждые 9 мин

  // ---- Планировщик напоминаний (времена берём из настроек плитки) ----
  await reloadCfg();
  let lastSlot = "";
  async function runReminderPass(slot) {
    const orders = await freshOrdersToday();
    const ordered = new Set(orders.filter((o) => o.status !== 5).map((o) => o.client && o.client.SD_id).filter(Boolean));
    const date = tzToday();
    const users = (await db.query("SELECT telegram_id, chat_id, phone9 FROM tg_users WHERE chat_id IS NOT NULL AND coalesce(phone9,'') <> ''")).rows;
    let sent = 0;
    for (const u of users) {
      const points = await pointsByPhone9(u.phone9);
      if (!points.length) continue;
      const lang = await getLang(u.chat_id);
      for (const pt of points) {
        if (ordered.has(pt.sd_id)) continue;
        const sk = await db.query("SELECT 1 FROM reminder_skips WHERE sd_id=$1 AND rdate=$2", [pt.sd_id, date]);
        if (sk.rows.length) continue;
        const lg = await db.query("SELECT 1 FROM reminder_log WHERE sd_id=$1 AND rdate=$2 AND slot=$3", [pt.sd_id, date, slot]);
        if (lg.rows.length) continue;
        try {
          await bot.sendMessage(u.chat_id, t(lang, "reminder_lead"));
          await sendDraft(bot, u.chat_id, u.telegram_id, pt.sd_id, pt.point_name || pt.firm_name || "", lang, "avg");
          await db.query("INSERT INTO reminder_log (sd_id,rdate,slot) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [pt.sd_id, date, slot]);
          sent++;
        } catch (e) { console.warn("[НАПОМИНАНИЕ→]", u.chat_id, e.message); }
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    return sent;
  }
  async function schedulerTick() {
    try {
      await reloadCfg();
      if (!botCfg.enabled || !botCfg.times.length) return;
      const hhmm = tzNow().toISOString().slice(11, 16);
      if (botCfg.deadline && botCfg.deadline !== "00:00" && hhmm >= botCfg.deadline) return;
      if (!botCfg.times.includes(hhmm)) return;
      const slotKey = tzToday() + " " + hhmm;
      if (lastSlot === slotKey) return;
      lastSlot = slotKey;
      const n = await runReminderPass(hhmm);
      console.log(`[НАПОМИНАНИЕ] Слот ${hhmm}: отправлено ${n}.`);
    } catch (e) { console.error("[ПЛАНИРОВЩИК]", e.message); }
  }
  setInterval(schedulerTick, 60000);

  bot.onText(/\/remindnow/, async (msg) => {
    if (!isAdmin(msg.chat.id)) { bot.sendMessage(msg.chat.id, "Только админ."); return; }
    bot.sendMessage(msg.chat.id, "Запускаю рассылку напоминаний…");
    try { const n = await runReminderPass("manual-" + tzHHMM()); bot.sendMessage(msg.chat.id, `Готово, отправлено: ${n}.`); }
    catch (e) { bot.sendMessage(msg.chat.id, "Ошибка: " + e.message); }
  });

  async function doZakaz(chatId, fromId, lang) {
    const points = await pointsOfUser(fromId);
    if (!points.length) { bot.sendMessage(chatId, t(lang, "not_linked")); return; }
    bot.sendChatAction(chatId, "typing");
    const orders = await freshOrdersToday();
    for (const l of points) {
      const name = l.point_name || l.firm_name || "";
      const existing = orders.filter((o) => o.client && o.client.SD_id === l.sd_id && o.status !== 5);
      if (existing.length) {
        bot.sendMessage(chatId, t(lang, "already_ordered", name) + "\n\n" + orderItemsText(existing[0]), {
          reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_dop"), callback_data: `dop:${l.sd_id}` }], [{ text: t(lang, "btn_cancel"), callback_data: `no:${l.sd_id}` }]] },
        });
      } else {
        await sendDraft(bot, chatId, fromId, l.sd_id, name, lang, "avg");
      }
    }
  }
  async function doMyOrder(chatId, fromId, lang) {
    const points = await pointsOfUser(fromId);
    if (!points.length) { bot.sendMessage(chatId, t(lang, "not_linked")); return; }
    bot.sendChatAction(chatId, "typing");
    try {
      const orders = await getOrdersToday();
      const blocks = [];
      for (const l of points) {
        const name = l.point_name || l.firm_name || "";
        const mine = orders.filter((o) => o.client && o.client.SD_id === l.sd_id);
        if (!mine.length) continue;
        for (const o of mine) blocks.push(`📍 ${name} — ${statusName(o.status, lang)}\n${orderItemsText(o)}`);
      }
      bot.sendMessage(chatId, blocks.length ? t(lang, "myorder_head") + "\n\n" + blocks.join("\n\n") : t(lang, "myorder_none"));
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
      const res = await onboard(chatId, msg.from, phone9, c.phone_number, lang);
      bot.sendMessage(chatId, res.text, res.linked ? mainMenu(lang) : { reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error("[ОНБОРДИНГ]", e.message); bot.sendMessage(chatId, "Ошибка при подключении."); }
  });

  bot.on("callback_query", async (q) => {
    const chatId = q.message.chat.id;
    const [act, val] = String(q.data || "").split(":");
    const key = q.from.id + "|" + val;
    try {
      if (act === "lang") { await setLang(chatId, val === "uz" ? "uz" : "ru"); await bot.answerCallbackQuery(q.id); const lang = await getLang(chatId); await bot.sendMessage(chatId, t(lang, "hello"), askContact(lang)); return; }
      const lang = await getLang(chatId);
      if (act === "noop") { await bot.answerCallbackQuery(q.id); return; }
      if (act === "no") {
        await bot.answerCallbackQuery(q.id);
        try { await db.query("INSERT INTO reminder_skips (sd_id,rdate) VALUES ($1,$2) ON CONFLICT DO NOTHING", [val, tzToday()]); } catch (_) {}
        await bot.editMessageText(t(lang, "cancelled"), { chat_id: chatId, message_id: q.message.message_id });
        return;
      }
      if (act === "rep") { await bot.answerCallbackQuery(q.id); bot.sendChatAction(chatId, "typing"); await sendDraft(bot, chatId, q.from.id, val, "", lang, "repeat"); return; }
      if (act === "new") {
        await bot.answerCallbackQuery(q.id); bot.sendChatAction(chatId, "typing");
        const base = draftCache.get(key) || (await getPointDraft(val, "avg"));
        if (!base) { await bot.sendMessage(chatId, t(lang, "no_history", "")); return; }
        const cart = { items: base.items.map((it) => ({ ...it })), agent: base.agent, priceType: base.priceType, warehouse: base.warehouse };
        draftCache.set(key, cart);
        const v = renderCart(val, cart, lang);
        await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "dop") {
        await bot.answerCallbackQuery(q.id); bot.sendChatAction(chatId, "typing");
        const orders = await freshOrdersToday();
        const o = orders.find((x) => x.client && x.client.SD_id === val && x.status !== 5);
        let meta = o ? { agent: o.agent && o.agent.SD_id, priceType: o.priceType && o.priceType.SD_id, warehouse: (o.store && o.store.SD_id) || (o.warehouse && o.warehouse.SD_id) } : null;
        if (!meta || !meta.agent) { const d = await getPointDraft(val, "avg"); if (d) meta = { agent: d.agent, priceType: d.priceType, warehouse: d.warehouse }; }
        const cart = { items: [], agent: meta && meta.agent, priceType: meta && meta.priceType, warehouse: meta && meta.warehouse, code: `TGBOT-${val}-${tzToday()}-${tzHHMM()}` };
        draftCache.set(key, cart);
        const v = renderCart(val, cart, lang);
        await bot.editMessageText(t(lang, "dop_title") + "\n\n" + v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "inc" || act === "dec") {
        await bot.answerCallbackQuery(q.id);
        const idx = Number(String(q.data).split(":")[2]); const cart = draftCache.get(key);
        if (!cart || !cart.items[idx]) return;
        cart.items[idx].qty = Math.max(0, cart.items[idx].qty + (act === "inc" ? 1 : -1));
        const v = renderCart(val, cart, lang);
        try { await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup }); } catch (_) {}
        return;
      }
      if (act === "add") {
        await bot.answerCallbackQuery(q.id); bot.sendChatAction(chatId, "typing");
        const v = renderCatalog(val, 0, lang, await getCatalog());
        await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "cat") {
        await bot.answerCallbackQuery(q.id);
        const page = Number(String(q.data).split(":")[2]) || 0;
        const v = renderCatalog(val, page, lang, await getCatalog());
        try { await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup }); } catch (_) {}
        return;
      }
      if (act === "padd") {
        await bot.answerCallbackQuery(q.id);
        const idx = Number(String(q.data).split(":")[2]); const catalog = await getCatalog(); const prod = catalog[idx];
        const cart = draftCache.get(key);
        if (cart && prod) { const ex = cart.items.find((it) => it.productSdId === prod.SD_id); if (ex) ex.qty += 1; else cart.items.push({ productSdId: prod.SD_id, name: prod.name, qty: 1 }); }
        const v = renderCart(val, cart || { items: [] }, lang);
        await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "back") {
        await bot.answerCallbackQuery(q.id);
        const v = renderCart(val, draftCache.get(key) || { items: [] }, lang);
        await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "done" || act === "ord") {
        await bot.answerCallbackQuery(q.id, { text: t(lang, "sending") }); bot.sendChatAction(chatId, "typing");
        let draft = draftCache.get(key) || (await getPointDraft(val, "avg"));
        if (act === "done" && draft) draft = { items: draft.items.filter((it) => it.qty > 0), agent: draft.agent, priceType: draft.priceType, warehouse: draft.warehouse, code: draft.code };
        if (!draft) { await bot.editMessageText(t(lang, "order_err", "нет данных"), { chat_id: chatId, message_id: q.message.message_id }); return; }
        if (!draft.items.length) { await bot.editMessageText(t(lang, "empty_cart"), { chat_id: chatId, message_id: q.message.message_id }); return; }
        try {
          await createOrderFromDraft(val, draft, draft.code);
          await db.logEvent("order_created", chatId, { sdId: val, mode: act, dop: !!draft.code });
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
