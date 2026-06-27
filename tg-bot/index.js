// Бот Novagreen. Личность = номер (точки определяются на лету из point_contacts).
// Заказ из черновика, меню, каталог по остаткам, дедуп + доп.заказ, RU/UZ, прогрев кэша.

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const sd = require("./salesdoctor");
const complaints = require("./complaints"); // мастер претензий (Этап 3)

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TG_ID = process.env.ADMIN_TG_ID;
const WINDOW_DAYS = Number(process.env.AVG_WINDOW_DAYS || 14);
const TZ_OFFSET_MS = 5 * 3600 * 1000; // Asia/Tashkent = UTC+5
let botCfg = { times: ["18:00", "21:00", "23:00"], deadline: "00:00", window: WINDOW_DAYS, enabled: true, digestTime: "08:30", digestEnabled: true, signalsEnabled: true, sig1Days: 3, sig2Pct: 40, sig2Win: 7 };

if (!TOKEN) { console.error("[СТАРТ] Нет TELEGRAM_BOT_TOKEN."); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("[СТАРТ] Нет DATABASE_URL."); process.exit(1); }

const isAdmin = (id) => ADMIN_TG_ID && String(id) === String(ADMIN_TG_ID);
const tzNow = () => new Date(Date.now() + TZ_OFFSET_MS);
const tzToday = () => tzNow().toISOString().slice(0, 10);
const tzTomorrow = () => new Date(Date.now() + TZ_OFFSET_MS + 86400000).toISOString().slice(0, 10);
const tzHHMM = () => tzNow().toISOString().slice(11, 16).replace(":", "");
const tzDateAgo = (n) => new Date(Date.now() + TZ_OFFSET_MS - n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
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
const freshStockMap = () => { _cache.delete("stock"); return getStockMap(); };
const getReplacements = () => cached("repls", 300000, async () => {
  const rows = (await db.query("SELECT product_sd_id, replacement_sd_id, replacement_name FROM product_replacements WHERE active")).rows;
  const map = {};
  for (const r of rows) (map[r.product_sd_id] = map[r.product_sd_id] || []).push({ sd: r.replacement_sd_id, name: r.replacement_name });
  return map;
});
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
    const r = await db.query("SELECT * FROM bot_settings WHERE id=1");
    if (r.rows[0]) {
      const s = r.rows[0];
      const times = String(s.reminder_times || "").split(",").map((x) => x.trim()).filter(Boolean);
      const win = Number(s.avg_window_days) || WINDOW_DAYS;
      if (win !== botCfg.window) _cache.delete("orders14");
      botCfg = { times, deadline: s.deadline || "00:00", window: win, enabled: s.enabled !== false,
        digestTime: s.digest_time || "08:30", digestEnabled: s.digest_enabled !== false, signalsEnabled: s.signals_enabled !== false,
        sig1Days: Number(s.signal1_days) || 3, sig2Pct: Number(s.signal2_pct) || 40, sig2Win: Number(s.signal2_window) || 7 };
    }
  } catch (e) { console.warn("[НАСТРОЙКИ]", e.message); }
}

// ---------- Личность по номеру (Вариант Б) ----------
async function phone9OfUser(tgId) { const r = await db.query("SELECT phone9 FROM tg_users WHERE telegram_id=$1", [tgId]); return r.rows[0] && r.rows[0].phone9; }
async function pointsByPhone9(p9) { if (!p9) return []; const r = await db.query(`SELECT sd_id, point_name, firm_name FROM point_contacts WHERE ${PH9("zavsklad_phone")}=$1`, [p9]); return r.rows; }
async function chainsByPhone9(p9) { if (!p9) return []; const r = await db.query(`SELECT inn, firm_name FROM chain_managers WHERE ${PH9("manager_phone")}=$1`, [p9]); return r.rows; }
async function pointsOfUser(tgId) { return pointsByPhone9(await phone9OfUser(tgId)); }

// ---------- Бандл 1: сотрудники, роли, синхронизация ----------
async function getStaff(tgId) {
  const r = await db.query("SELECT role, crm_agent_id, status FROM telegram_staff WHERE telegram_user_id=$1", [tgId]);
  const s = r.rows[0];
  return (s && s.status === "confirmed" && s.role) ? s : null;
}
async function staffByPhone9(p9) {
  if (!p9) return null;
  const r = await db.query("SELECT * FROM telegram_staff WHERE phone_normalized=$1 ORDER BY (status='confirmed') DESC, id DESC LIMIT 1", [p9]);
  return r.rows[0] || null;
}
async function pointsOfAgent(agentSdId) {
  if (!agentSdId) return [];
  const r = await db.query("SELECT sd_id, point_name, firm_name, zavsklad_phone FROM point_contacts WHERE agent_sd_id=$1 AND coalesce(active,'Y')<>'N' ORDER BY point_name", [agentSdId]);
  return r.rows;
}
async function allActivePoints() {
  const r = await db.query("SELECT sd_id, point_name, firm_name, zavsklad_phone FROM point_contacts WHERE coalesce(active,'Y')<>'N' ORDER BY point_name");
  return r.rows;
}
async function syncClientsBot() {
  try {
    const catId = await sd.resolveCategoryId("Horeca"); if (!catId) return 0;
    const clients = (await sd.fetchAll("getClient", {})).filter((c) => c.active === "Y" && c.category && c.category.SD_id === catId);
    for (const c of clients) {
      if (!c.SD_id) continue;
      const agent = (c.agents && c.agents[0] && c.agents[0].id) || null;
      await db.query(`INSERT INTO point_contacts (sd_id, point_name, firm_name, inn, zavsklad_phone, agent_sd_id, active, updated_at, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now(),'bot_sync')
        ON CONFLICT (sd_id) DO UPDATE SET point_name=$2, firm_name=$3, inn=$4, zavsklad_phone=$5, agent_sd_id=$6, active=$7, updated_at=now(), updated_by='bot_sync'`,
        [c.SD_id, c.name || c.SD_id, c.firmName || null, c.inn || null, c.tel || null, agent, c.active || "Y"]);
    }
    await db.query("INSERT INTO salesdoctor_sync_log (sync_type, updated) VALUES ('quick',$1)", [clients.length]).catch(() => {});
    console.log(`[СИНХРОНИЗАЦИЯ] клиентов: ${clients.length}`);
    return clients.length;
  } catch (e) { console.warn("[СИНХРОНИЗАЦИЯ]", e.message); return 0; }
}
const STAFF_MENU = {
  agent: [["👥 Мои клиенты"], ["🚫 Не заказали"], ["📊 Моя сводка"], ["➕ Доп. заказы"], ["📉 Сигналы"]],
  head_of_sales: [["📊 Сводка отдела"], ["👥 По агентам"], ["🚫 Не заказали"], ["➕ Доп. заказы"], ["📉 Сигналы"], ["⚠️ Ошибки", "🔄 Синхронизация"]],
  admin: [["🔄 Синхронизация"], ["👤 Telegram-сотрудники"], ["⚠️ Ошибки"], ["📦 Очередь заказов"], ["⚙️ Настройки"]],
};
const staffMenu = (role) => ({ reply_markup: { keyboard: STAFF_MENU[role] || [], resize_keyboard: true } });
const roleTitle = (role) => role === "admin" ? "админ" : role === "head_of_sales" ? "руководитель продаж" : "торговый агент";

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
  btn_comment: { ru: "✍️ Комментарий", uz: "✍️ Izoh" },
  cmt_ask: { ru: "Напишите комментарий к заказу одним сообщением (до 500 символов). Отмена — /skip.", uz: "Buyurtmaga izoh yozing (500 belgigacha). Bekor qilish — /skip." },
  cmt_saved: { ru: "✍️ Комментарий сохранён. Теперь нажмите «Заказать» / «Подтвердить».", uz: "✍️ Izoh saqlandi. Endi «Buyurtma» / «Tasdiqlash» tugmasini bosing." },
  cmt_skip: { ru: "Окей, без комментария.", uz: "Mayli, izohsiz." },
  cart_stale: { ru: "Корзина устарела — начните заказ заново.", uz: "Savat eskirdi — qaytadan boshlang." },
  none_now: { ru: "Сейчас этих позиций нет в наличии. Попробуйте позже.", uz: "Hozir bu mahsulotlar mavjud emas. Keyinroq urinib ko‘ring." },
  only_avail: { ru: "В наличии только", uz: "Mavjud faqat" },
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
const mainMenu = (lang) => ({ reply_markup: { keyboard: [[{ text: t(lang, "menu_order") }], [{ text: t(lang, "menu_myorder") }], [{ text: complaints.menuText(lang) }]], resize_keyboard: true } });
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
const awaitComment = new Map(); // chatId -> { key, sdId } — ждём текст комментария
function capItemsToStock(items, stock) {
  const capped = [], removed = [], out = [];
  for (const it of items) {
    if (!(it.qty > 0)) continue;
    const avail = stock[it.productSdId] || 0;
    if (avail <= 0) { removed.push(it.name); continue; }
    if (it.qty > avail) { capped.push(`${it.name}: ${avail}`); out.push({ ...it, qty: avail }); }
    else out.push(it);
  }
  return { items: out, capped, removed };
}

async function getPointDraft(sdId, mode) {
  const orders = await getOrders14();
  const mine = orders.filter((o) => o.client && o.client.SD_id === sdId);
  if (!mine.length) return null;
  mine.sort((a, b) => String(b.dateCreate || "").localeCompare(String(a.dateCreate || "")));
  const last = mine[0];
  const meta = { agent: last.agent && last.agent.SD_id, priceType: last.priceType && last.priceType.SD_id, warehouse: (last.store && last.store.SD_id) || (last.warehouse && last.warehouse.SD_id), clientCode: last.client && last.client.code_1C };
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
  const replMap = await getReplacements();
  const items = [], oos = [], repls = [];
  for (const it of raw) {
    const av = stock[it.productSdId] || 0;
    if (av > 0) { items.push({ ...it, qty: Math.min(it.qty, av) }); continue; }
    let replaced = false;
    for (const o of (replMap[it.productSdId] || [])) {
      const ra = stock[o.sd] || 0;
      if (ra > 0) { repls.push({ from: it.name, toSd: o.sd, toName: o.name, qty: Math.max(1, Math.min(Math.round(it.qty), ra)) }); replaced = true; break; }
    }
    if (!replaced) oos.push(it.name);
  }
  return Object.assign({ items, oos, repls }, meta);
}

function buildOrder(sdId, draft, code) {
  return {
    code_1C: code || `TGBOT-${sdId}-${tzToday()}`, status: 1, dateShipment: tzTomorrow(),
    comment: "Заказ оформлен через Telegram-бот" + (draft.comment ? "\nКомментарий клиента: " + draft.comment : ""),
    client: draft.clientCode ? { SD_id: sdId, code_1C: draft.clientCode } : { SD_id: sdId }, agent: { SD_id: draft.agent }, priceType: { SD_id: draft.priceType }, warehouse: { SD_id: draft.warehouse },
    orderProducts: draft.items.filter((it) => it.qty > 0).map((it) => ({ product: { SD_id: it.productSdId }, quantity: Math.max(1, Math.round(it.qty)) })),
  };
}
let lastSetOrder = null;
async function submitOrderObj(order) {
  try {
    console.log("[ЗАКАЗ→SD] REQUEST:", JSON.stringify(order));
    const resp = await sd.setOrder(order);
    console.log("[ЗАКАЗ→SD] RESPONSE:", JSON.stringify(resp));
    lastSetOrder = { req: JSON.stringify(order), resp: JSON.stringify(resp), at: new Date().toISOString() };
    if (resp && resp.status === true) return { ok: true, resp };
    const m = (resp && (resp.error && (resp.error.message || resp.error)) || resp.message || (resp.errors && resp.errors[0] && (resp.errors[0].message || resp.errors[0]))) || "SD отклонил заказ";
    return { ok: false, permanent: true, error: typeof m === "string" ? m : JSON.stringify(m).slice(0, 200) };
  } catch (e) { lastSetOrder = { req: JSON.stringify(order), resp: "ERROR: " + e.message, at: new Date().toISOString() }; return { ok: false, permanent: false, error: e.message }; }
}
const nextDelayMin = (attempts) => attempts <= 1 ? 1 : attempts === 2 ? 5 : attempts === 3 ? 15 : 60;
async function enqueuePending(order, sdId, chatId, isDop, err) {
  await db.query(`INSERT INTO pending_orders (code_1c, client_sd_id, chat_id, payload, status, attempts, last_error, next_attempt_at, is_dop)
    VALUES ($1,$2,$3,$4,'pending',1,$5, now() + interval '1 minute', $6)
    ON CONFLICT (code_1c) DO UPDATE SET payload=$4, last_error=$5, status='pending', updated_at=now()`,
    [order.code_1C, sdId, chatId, JSON.stringify(order), err, !!isDop]);
}
async function createOrderFromDraft(sdId, draft, code, chatId, isDop) {
  if (!draft.items.length) throw new Error("список товаров пуст");
  if (!draft.agent || !draft.priceType || !draft.warehouse) throw new Error("нет агента/прайса/склада — нужен прошлый заказ точки");
  const order = buildOrder(sdId, draft, code);
  const r = await submitOrderObj(order);
  if (r.ok) { _cache.delete("ordersToday"); return { ok: true }; }
  if (r.permanent) { console.error("[ЗАКАЗ] SD отклонил:", r.error); throw new Error(r.error); }
  console.warn("[ЗАКАЗ] SD недоступен — в очередь:", r.error);
  await enqueuePending(order, sdId, chatId, isDop, r.error);
  return { queued: true };
}

function draftKeyboard(sdId, lang) {
  return { inline_keyboard: [
    [{ text: t(lang, "btn_confirm"), callback_data: `ord:${sdId}` }],
    [{ text: t(lang, "btn_repeat"), callback_data: `rep:${sdId}` }, { text: t(lang, "btn_new"), callback_data: `new:${sdId}` }],
    [{ text: t(lang, "btn_comment"), callback_data: `cmt:${sdId}` }],
    [{ text: t(lang, "btn_cancel"), callback_data: `no:${sdId}` }],
  ] };
}
function draftMessage(sdId, draft, lang) {
  const list = draft.items.length ? draft.items.map((it) => `• ${it.name}: ${it.qty}`).join("\n") : "—";
  let text = t(lang, "draft_title", draft.pointName || "") + "\n\n" + list;
  if (draft.oos && draft.oos.length) text += "\n\n" + t(lang, "oos_note", draft.oos.join(", "));
  if (draft.repls && draft.repls.length) text += "\n\n🔁 Нет в наличии, но можно заменить:\n" + draft.repls.map((r) => `• ${r.from} → ${r.toName}`).join("\n");
  text += "\n\n" + t(lang, "confirm_hint");
  const base = draftKeyboard(sdId, lang).inline_keyboard;
  const replRows = (draft.repls || []).map((r, i) => [{ text: `🔁 Заменить на «${r.toName}»`, callback_data: `repl:${sdId}:${i}` }]);
  return { text, reply_markup: { inline_keyboard: [base[0], ...replRows, ...base.slice(1)] } };
}
async function sendDraft(bot, chatId, tgId, sdId, pointName, lang, mode) {
  const draft = await getPointDraft(sdId, mode);
  if (!draft) { bot.sendMessage(chatId, t(lang, "no_history", pointName || "")); return; }
  if (!draft.items.length && !(draft.repls && draft.repls.length)) {
    bot.sendMessage(chatId, t(lang, "all_oos", (draft.oos || []).join(", ") || "—"), { reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_new"), callback_data: `new:${sdId}` }]] } });
    return;
  }
  draft.pointName = pointName;
  draftCache.set(tgId + "|" + sdId, draft);
  const m = draftMessage(sdId, draft, lang);
  bot.sendMessage(chatId, m.text, { reply_markup: m.reply_markup });
}
function renderCart(sdId, cart, lang) {
  const rows = cart.items.map((it, i) => ([
    { text: "➖", callback_data: `dec:${sdId}:${i}` },
    { text: `${it.name}: ${it.qty}`, callback_data: "noop" },
    { text: "➕", callback_data: `inc:${sdId}:${i}` },
  ]));
  rows.push([{ text: t(lang, "btn_add"), callback_data: `add:${sdId}` }, { text: t(lang, "btn_comment"), callback_data: `cmt:${sdId}` }]);
  rows.push([{ text: t(lang, "btn_order"), callback_data: `done:${sdId}` }, { text: t(lang, "btn_cancel"), callback_data: `no:${sdId}` }]);
  const lines = cart.items.length ? cart.items.map((it) => `• ${it.name}: ${it.qty}`).join("\n") : "—";
  const cmt = cart.comment ? "\n\n✍️ " + cart.comment : "";
  return { text: t(lang, "cart_title") + "\n\n" + lines + cmt, reply_markup: { inline_keyboard: rows } };
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

  // Мастер претензий: отдаём ему нужные помощники бота (логику заказов он не трогает).
  complaints.init({ bot, db, getLang, pointsOfUser, phone9OfUser, getOrders14, mainMenu, notifyClientAgent, notifyAgentReact, notifyManagers });

  // Прогрев кэша: каталог/остатки и история всегда «горячие», чтобы «Добавить» открывалось мгновенно.
  const warmStock = async () => { try { _cache.delete("stock"); await getStockData(); } catch (e) { console.warn("[ПРОГРЕВ stock]", e.message); } };
  getHorecaProdCat().catch(() => {});
  warmStock(); getOrders14().catch(() => {});
  setInterval(warmStock, 240000); // каждые 4 мин (TTL 5 мин)
  syncClientsBot(); // живая синхронизация клиентов/агентов из SD
  setInterval(syncClientsBot, 45 * 60 * 1000);
  notifyNewlyConfirmed(); // проактивное «вы подтверждены»
  setInterval(notifyNewlyConfirmed, 60000);
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
      const logSkip = (sdId, reason) => db.logEvent("reminder_skip", u.chat_id, { sd_id: sdId, reason, date, slot }).catch(() => {});
      for (const pt of points) {
        const nm = pt.point_name || pt.firm_name || "";
        if (ordered.has(pt.sd_id)) { await logSkip(pt.sd_id, "CLIENT_ALREADY_ORDERED"); continue; }
        const sk = await db.query("SELECT 1 FROM reminder_skips WHERE sd_id=$1 AND rdate=$2", [pt.sd_id, date]);
        if (sk.rows.length) { await logSkip(pt.sd_id, "CLIENT_CLICKED_NOT_TODAY"); continue; }
        const lg = await db.query("SELECT 1 FROM reminder_log WHERE sd_id=$1 AND rdate=$2 AND slot=$3", [pt.sd_id, date, slot]);
        if (lg.rows.length) continue; // уже слали в этот слот
        // Не шлём тупиковые напоминания: нет истории или нечего предложить из наличия.
        const draft = await getPointDraft(pt.sd_id, "avg");
        if (!draft) { await logSkip(pt.sd_id, "NO_ORDER_HISTORY"); continue; }
        if (!draft.items.length) { await logSkip(pt.sd_id, "NO_AVAILABLE_PRODUCTS"); continue; }
        try {
          await bot.sendMessage(u.chat_id, t(lang, "reminder_lead"));
          await sendDraft(bot, u.chat_id, u.telegram_id, pt.sd_id, nm, lang, "avg");
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
  setInterval(agentDailyTick, 60000); // сводка агентам + сигналы (раз в день в digestTime)

  bot.onText(/\/digestnow/, async (msg) => {
    if (!isAdmin(msg.chat.id)) { bot.sendMessage(msg.chat.id, "Только админ."); return; }
    bot.sendMessage(msg.chat.id, "Шлю сводки агентам и считаю сигналы…");
    try { await runAgentDigests(); const n = await runSignals(); bot.sendMessage(msg.chat.id, `Готово. Сигналов отправлено: ${n}.`); }
    catch (e) { bot.sendMessage(msg.chat.id, "Ошибка: " + e.message); }
  });

  // ---- Бандл 3 (шаг 2): очередь заказов с ретраями ----
  async function retryPending() {
    try {
      const rows = (await db.query("SELECT * FROM pending_orders WHERE status='pending' AND next_attempt_at <= now() ORDER BY id LIMIT 20")).rows;
      for (const row of rows) {
        const order = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        const r = await submitOrderObj(order);
        if (r.ok) {
          await db.query("UPDATE pending_orders SET status='done', updated_at=now() WHERE id=$1", [row.id]);
          _cache.delete("ordersToday");
          if (row.chat_id) bot.sendMessage(row.chat_id, "✅ Ваш заказ оформлен.").catch(() => {});
          if (row.is_dop) notifyClientAgent(row.client_sd_id, `➕ Доп.заказ через бот\nКлиент: {name}\n(оформлен из очереди)`, row.code_1c).catch(() => {});
          continue;
        }
        const attempts = row.attempts + 1;
        if (r.permanent || attempts >= 10) {
          await db.query("UPDATE pending_orders SET status='failed', attempts=$2, last_error=$3, updated_at=now() WHERE id=$1", [row.id, attempts, r.error]);
          if (row.chat_id) bot.sendMessage(row.chat_id, "⚠️ Не удалось оформить заказ автоматически. Свяжитесь с вашим агентом Novagreen.").catch(() => {});
          notifyClientAgent(row.client_sd_id, `⚠️ Заказ клиента {name} не оформлен: ${r.error}`, "fail:" + row.code_1c).catch(() => {});
          continue;
        }
        const delay = nextDelayMin(attempts);
        await db.query("UPDATE pending_orders SET attempts=$2, last_error=$3, next_attempt_at = now() + make_interval(mins => $4), updated_at=now() WHERE id=$1", [row.id, attempts, r.error, delay]);
        if (attempts >= 3 && !row.notified_stuck) {
          await db.query("UPDATE pending_orders SET notified_stuck=true WHERE id=$1", [row.id]);
          notifyClientAgent(row.client_sd_id, `⏳ Заказ клиента {name} пока не уходит в SD (попыток: ${attempts}). Бот продолжает пытаться.`, "stuck:" + row.code_1c).catch(() => {});
        }
        await new Promise((rr) => setTimeout(rr, 60));
      }
    } catch (e) { console.error("[ОЧЕРЕДЬ]", e.message); }
  }
  setInterval(retryPending, 60000);

  bot.onText(/\/queue/, async (msg) => {
    if (!isAdmin(msg.chat.id)) { bot.sendMessage(msg.chat.id, "Только админ."); return; }
    const rows = (await db.query("SELECT status, count(*) c FROM pending_orders GROUP BY status")).rows;
    const pend = (await db.query("SELECT code_1c, attempts, last_error FROM pending_orders WHERE status='pending' ORDER BY next_attempt_at LIMIT 15")).rows;
    let txt = "Очередь заказов:\n" + (rows.length ? rows.map((r) => `${r.status}: ${r.c}`).join("\n") : "пусто");
    if (pend.length) txt += "\n\nОжидают:\n" + pend.map((pp) => `• ${pp.code_1c} (попыток ${pp.attempts})${pp.last_error ? " — " + String(pp.last_error).slice(0, 60) : ""}`).join("\n");
    bot.sendMessage(msg.chat.id, txt);
  });
  bot.onText(/\/retrynow/, async (msg) => {
    if (!isAdmin(msg.chat.id)) { bot.sendMessage(msg.chat.id, "Только админ."); return; }
    await db.query("UPDATE pending_orders SET next_attempt_at = now() WHERE status='pending'");
    await retryPending();
    bot.sendMessage(msg.chat.id, "Очередь обработана.");
  });

  // Последний запрос/ответ setOrder — для отправки разработчику SD
  bot.onText(/\/lastreq/, async (msg) => {
    if (!isAdmin(msg.chat.id)) { bot.sendMessage(msg.chat.id, "Только админ."); return; }
    if (!lastSetOrder) { bot.sendMessage(msg.chat.id, "Заказов после перезапуска ещё не было. Оформите тестовый заказ и снова дайте /lastreq."); return; }
    await bot.sendMessage(msg.chat.id, "🟢 setOrder REQUEST (" + lastSetOrder.at + "):");
    await bot.sendMessage(msg.chat.id, lastSetOrder.req);
    await bot.sendMessage(msg.chat.id, "🔵 SD RESPONSE:");
    await bot.sendMessage(msg.chat.id, lastSetOrder.resp);
  });

  // Диагностика: чьё юр.лицо у точки в SD (только чтение)
  bot.onText(/\/clientinfo (.+)/, async (msg, m) => {
    if (!isAdmin(msg.chat.id)) { bot.sendMessage(msg.chat.id, "Только админ."); return; }
    const qstr = String((m && m[1]) || "").trim().toLowerCase();
    if (!qstr) { bot.sendMessage(msg.chat.id, "Укажите часть названия: /clientinfo benedict"); return; }
    bot.sendChatAction(msg.chat.id, "typing");
    try {
      const clients = await getClientsAll();
      const hits = clients.filter((c) => String(c.name || "").toLowerCase().includes(qstr) || String(c.firmName || "").toLowerCase().includes(qstr)).slice(0, 12);
      if (!hits.length) { bot.sendMessage(msg.chat.id, "Ничего не найдено."); return; }
      const lines = hits.map((c) => `SD_id: ${c.SD_id}\n  точка: ${c.name || "—"}\n  юр.лицо: ${c.firmName || "— ПУСТО —"}\n  ИНН: ${c.inn || "—"} · активен: ${c.active}\n  агент: ${(c.agents && c.agents[0] && c.agents[0].id) || "—"}`);
      bot.sendMessage(msg.chat.id, `Найдено ${hits.length}:\n\n` + lines.join("\n\n"));
    } catch (e) { bot.sendMessage(msg.chat.id, "Ошибка: " + e.message); }
  });

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

  async function handleStaffText(chatId, tgId, stf, txt) {
    const soon = () => bot.sendMessage(chatId, "🔜 Скоро — в следующем обновлении.");
    if (txt === "🚫 Не заказали") {
      bot.sendChatAction(chatId, "typing");
      const pts = stf.role === "agent" ? await pointsOfAgent(stf.crm_agent_id) : await allActivePoints();
      const orders = await getOrdersToday();
      const ordered = new Set(orders.filter((o) => o.status !== 5).map((o) => o.client && o.client.SD_id).filter(Boolean));
      const no = pts.filter((pt) => !ordered.has(pt.sd_id));
      if (!no.length) return bot.sendMessage(chatId, "Все клиенты уже заказали на сегодня. 👍");
      const lines = no.slice(0, 60).map((pt, i) => `${i + 1}. ${pt.point_name || pt.firm_name || pt.sd_id}${pt.zavsklad_phone ? " — " + pt.zavsklad_phone : ""}`);
      return bot.sendMessage(chatId, `Не заказали на сегодня (${no.length}):\n` + lines.join("\n"));
    }
    if (stf.role === "agent") {
      if (txt === "👥 Мои клиенты") {
        const pts = await pointsOfAgent(stf.crm_agent_id);
        if (!pts.length) return bot.sendMessage(chatId, "За вами пока не закреплено точек. Проверьте синхронизацию в Hub.");
        const lines = pts.slice(0, 80).map((pt, i) => `${i + 1}. ${pt.point_name || pt.firm_name || pt.sd_id}`);
        return bot.sendMessage(chatId, `Ваши клиенты (${pts.length}):\n` + lines.join("\n"));
      }
      return soon();
    }
    if (stf.role === "head_of_sales") {
      if (txt === "👥 По агентам") return bot.sendMessage(chatId, "Дашборд по агентам: Hub → плитка «Бот HoReCa» → «Аналитика АКБ/ОКБ».");
      if (txt === "🔄 Синхронизация") { bot.sendMessage(chatId, "Запускаю синхронизацию…"); const n = await syncClientsBot(); return bot.sendMessage(chatId, `Готово. Клиентов обновлено: ${n}.`); }
      return soon();
    }
    if (stf.role === "admin") {
      if (txt === "👤 Telegram-сотрудники") return bot.sendMessage(chatId, "Управление сотрудниками: Hub → плитка «Бот HoReCa» → «Telegram-агенты».");
      if (txt === "🔄 Синхронизация") { bot.sendMessage(chatId, "Запускаю синхронизацию…"); const n = await syncClientsBot(); return bot.sendMessage(chatId, `Готово. Клиентов обновлено: ${n}.`); }
      return soon();
    }
    return bot.sendMessage(chatId, `Меню (${roleTitle(stf.role)}):`, staffMenu(stf.role));
  }

  // --- Бандл 2 (шаг 1): уведомления ---
  async function resolveAgentChat(agentSd) {
    let chatId = null, role = null;
    if (agentSd) {
      const a = (await db.query("SELECT telegram_chat_id FROM telegram_staff WHERE crm_agent_id=$1 AND role='agent' AND status='confirmed' AND telegram_chat_id IS NOT NULL ORDER BY id DESC LIMIT 1", [agentSd])).rows[0];
      if (a) { chatId = a.telegram_chat_id; role = "agent"; }
    }
    if (!chatId) {
      const h = (await db.query("SELECT telegram_chat_id FROM telegram_staff WHERE role='head_of_sales' AND status='confirmed' AND telegram_chat_id IS NOT NULL ORDER BY id DESC LIMIT 1")).rows[0];
      if (h) { chatId = h.telegram_chat_id; role = "head_of_sales"; }
    }
    if (!chatId && ADMIN_TG_ID) { chatId = ADMIN_TG_ID; role = "admin"; }
    return { chatId, role };
  }
  const rolePrefix = (role) => role === "agent" ? "" : (role === "head_of_sales" ? "(агент не привязан — вам как РОП)\n" : "(агент/РОП не привязаны — вам как админу)\n");
  async function notifyAgentBySd(agentSd, text) {
    const { chatId, role } = await resolveAgentChat(agentSd);
    if (!chatId) return false;
    try { await bot.sendMessage(chatId, rolePrefix(role) + text); return true; } catch (e) { console.warn("[УВЕД-АГ]", e.message); return false; }
  }
  async function notifyClientAgent(sdId, bodyText, dedupKey) {
    try {
      if (dedupKey) { const seen = await db.query("SELECT 1 FROM notification_log WHERE dedup_key=$1", [dedupKey]); if (seen.rows.length) return false; }
      const pc = (await db.query("SELECT agent_sd_id, point_name, firm_name FROM point_contacts WHERE sd_id=$1", [sdId])).rows[0] || {};
      const { chatId, role } = await resolveAgentChat(pc.agent_sd_id);
      if (!chatId) return false;
      const name = pc.point_name || pc.firm_name || sdId;
      await bot.sendMessage(chatId, rolePrefix(role) + bodyText.replace("{name}", name));
      await db.query("INSERT INTO notification_log (kind, dedup_key, target_chat_id, target_role, sd_id) VALUES ('dop_order',$1,$2,$3,$4) ON CONFLICT (dedup_key) DO NOTHING", [dedupKey || null, chatId, role, sdId]);
      return true;
    } catch (e) { console.warn("[УВЕД-АГЕНТ]", e.message); return false; }
  }
  // Уведомление агенту о претензии с кнопкой «Принял в работу» (для мастера претензий).
  async function notifyAgentReact(sdId, bodyText, complaintId) {
    try {
      const pc = (await db.query("SELECT agent_sd_id, point_name, firm_name FROM point_contacts WHERE sd_id=$1", [sdId])).rows[0] || {};
      const { chatId, role } = await resolveAgentChat(pc.agent_sd_id);
      if (!chatId) return false;
      const name = pc.point_name || pc.firm_name || sdId;
      const kb = { inline_keyboard: [[{ text: "✅ Принял в работу", callback_data: "cmpl:react:" + complaintId }]] };
      await bot.sendMessage(chatId, rolePrefix(role) + bodyText.replace("{name}", name), { reply_markup: kb });
      return true;
    } catch (e) { console.warn("[УВЕД-РЕАКЦ]", e.message); return false; }
  }
  // Эскалация критической претензии — всем подтверждённым РОПам и админу.
  async function notifyManagers(text) {
    const seen = new Set();
    try {
      const rops = (await db.query("SELECT telegram_chat_id FROM telegram_staff WHERE role='head_of_sales' AND status='confirmed' AND telegram_chat_id IS NOT NULL")).rows;
      for (const r of rops) { const c = r.telegram_chat_id; if (c && !seen.has(String(c))) { seen.add(String(c)); bot.sendMessage(c, text).catch(() => {}); } }
    } catch (e) { console.warn("[ЭСКАЛАЦИЯ]", e.message); }
    if (ADMIN_TG_ID && !seen.has(String(ADMIN_TG_ID))) bot.sendMessage(ADMIN_TG_ID, text).catch(() => {});
  }
  // --- Бандл 2 (шаг 2): сводка агенту + сигналы ---
  async function buildDigest(crmAgentId) {
    if (!crmAgentId) return null;
    const pts = await pointsOfAgent(crmAgentId);
    if (!pts.length) return null;
    const today = tzToday();
    const deliv = (await getOrders14()).filter((o) => String(o.dateShipment || "").slice(0, 10) === today && o.status !== 5);
    const ptSet = new Set(pts.map((p) => p.sd_id));
    const agentOrders = deliv.filter((o) => o.client && ptSet.has(o.client.SD_id));
    const orderedSet = new Set(agentOrders.map((o) => o.client.SD_id));
    const skipSet = new Set((await db.query("SELECT sd_id FROM reminder_skips WHERE rdate=$1", [today])).rows.map((r) => r.sd_id));
    const not = pts.filter((p) => !orderedSet.has(p.sd_id));
    const notToday = pts.filter((p) => skipSet.has(p.sd_id) && !orderedSet.has(p.sd_id));
    const dop = Math.max(0, agentOrders.length - orderedSet.size);
    const notList = not.slice(0, 40).map((p, i) => `${i + 1}. ${p.point_name || p.firm_name || p.sd_id}${p.zavsklad_phone ? " — " + p.zavsklad_phone : ""}`);
    const text = `📋 Сводка на ${today}\nВаших точек: ${pts.length}\n✅ Заказали (доставка сегодня): ${orderedSet.size}\n🚫 Не заказали: ${not.length}\n🔕 «Не сегодня»: ${notToday.length}\n➕ Доп.заказы: ${dop}` + (notList.length ? `\n\nНе заказали:\n` + notList.join("\n") : "");
    const keyboard = { inline_keyboard: [[{ text: "🚫 Не заказали", callback_data: "dg:not" }, { text: "👥 Мои клиенты", callback_data: "dg:clients" }], [{ text: "🔄 Обновить", callback_data: "dg:refresh" }]] };
    return { text, keyboard };
  }
  async function sendOneDigest(chatId, crmAgentId) {
    const d = await buildDigest(crmAgentId);
    if (d) await bot.sendMessage(chatId, d.text, { reply_markup: d.keyboard });
  }
  async function runAgentDigests() {
    const agents = (await db.query("SELECT crm_agent_id, telegram_chat_id FROM telegram_staff WHERE role='agent' AND status='confirmed' AND telegram_chat_id IS NOT NULL AND crm_agent_id IS NOT NULL")).rows;
    for (const ag of agents) {
      try { await sendOneDigest(ag.telegram_chat_id, ag.crm_agent_id); } catch (e) { console.warn("[СВОДКА→]", e.message); }
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  async function runSignals() {
    const today = tzToday(); const d7 = tzDateAgo(7), d14 = tzDateAgo(14);
    const all = await getOrders14();
    const byClient = {};
    for (const o of all) {
      const cid = o.client && o.client.SD_id; if (!cid) continue;
      const dc = String(o.dateCreate || "").slice(0, 10); if (!dc) continue;
      const sum = Number(o.totalSummaAfterDiscount || o.totalSumma || 0);
      const c = byClient[cid] || (byClient[cid] = { last: "", w1: 0, w2: 0 });
      if (dc > c.last) c.last = dc;
      if (dc >= d7) c.w1 += sum; else if (dc >= d14) c.w2 += sum;
    }
    const pts = (await db.query("SELECT sd_id, point_name, firm_name, agent_sd_id FROM point_contacts WHERE coalesce(active,'Y')<>'N'")).rows;
    const perAgent = {};
    for (const p of pts) {
      const c = byClient[p.sd_id]; if (!c || !c.last) continue;
      const daysSince = daysBetween(c.last, today);
      const name = p.point_name || p.firm_name || p.sd_id;
      let sig = null, txt = null;
      if (daysSince >= botCfg.sig1Days) { sig = "no_orders"; txt = `🔕 ${name}: нет заказов ${daysSince} дн.`; }
      else if (c.w2 > 0 && c.w1 <= c.w2 * (1 - botCfg.sig2Pct / 100)) { sig = "sum_drop"; const pct = Math.round((1 - c.w1 / c.w2) * 100); txt = `📉 ${name}: сумма ↓${pct}% за неделю`; }
      if (!sig) continue;
      const ins = await db.query("INSERT INTO client_signals_log (sd_id, signal_type, sig_date) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id", [p.sd_id, sig, today]);
      if (!ins.rowCount) continue;
      (perAgent[p.agent_sd_id || "_none"] = perAgent[p.agent_sd_id || "_none"] || []).push(txt);
    }
    let total = 0;
    for (const [agentSd, lines] of Object.entries(perAgent)) {
      if (!lines.length) continue;
      await notifyAgentBySd(agentSd === "_none" ? null : agentSd, "⚠️ Сигналы по клиентам:\n" + lines.join("\n"));
      total += lines.length;
      await new Promise((r) => setTimeout(r, 120));
    }
    return total;
  }
  let lastAgentDay = "";
  async function agentDailyTick() {
    try {
      await reloadCfg();
      if (!botCfg.digestEnabled && !botCfg.signalsEnabled) return;
      const hhmm = tzNow().toISOString().slice(11, 16);
      if (hhmm !== (botCfg.digestTime || "08:30")) return;
      const today = tzToday();
      if (lastAgentDay === today) return;
      lastAgentDay = today;
      if (botCfg.digestEnabled) await runAgentDigests();
      if (botCfg.signalsEnabled) { const n = await runSignals(); console.log(`[СИГНАЛЫ] отправлено ${n}`); }
    } catch (e) { console.error("[ДЕНЬ-АГЕНТ]", e.message); }
  }

  async function notifyNewlyConfirmed() {
    try {
      const rows = (await db.query("SELECT id, role, telegram_chat_id FROM telegram_staff WHERE status='confirmed' AND role IS NOT NULL AND telegram_chat_id IS NOT NULL")).rows;
      for (const st of rows) {
        const key = `confirm:${st.id}`;
        const seen = await db.query("SELECT 1 FROM notification_log WHERE dedup_key=$1", [key]);
        if (seen.rows.length) continue;
        try {
          await bot.sendMessage(st.telegram_chat_id, `✅ Вам открыт доступ как ${roleTitle(st.role)}. Меню ниже.`, staffMenu(st.role));
          await db.query("INSERT INTO notification_log (kind, dedup_key, target_chat_id, target_role) VALUES ('confirm',$1,$2,$3) ON CONFLICT (dedup_key) DO NOTHING", [key, st.telegram_chat_id, st.role]);
        } catch (e) { console.warn("[ПОДТВ→]", e.message); }
        await new Promise((r) => setTimeout(r, 80));
      }
    } catch (e) { console.warn("[ПОДТВ]", e.message); }
  }

  bot.onText(/\/start/, async (msg) => {
    await db.logEvent("start", msg.chat.id, { from: msg.from });
    bot.sendMessage(msg.chat.id, STR.choose_lang.ru, { reply_markup: { inline_keyboard: [[{ text: "Русский", callback_data: "lang:ru" }, { text: "O‘zbekcha", callback_data: "lang:uz" }]] } });
  });
  bot.onText(/\/whoami/, (msg) => bot.sendMessage(msg.chat.id, "Ваш Telegram ID: " + msg.chat.id));
  bot.onText(/\/menu/, async (msg) => {
    const stf = await getStaff(msg.from.id);
    if (stf) { bot.sendMessage(msg.chat.id, `Меню (${roleTitle(stf.role)}):`, staffMenu(stf.role)); return; }
    const lang = await getLang(msg.chat.id);
    bot.sendMessage(msg.chat.id, lang === "uz" ? "Menyu:" : "Меню:", mainMenu(lang));
  });
  bot.onText(/\/zakaz|\/order|\/заказ/i, async (msg) => doZakaz(msg.chat.id, msg.from.id, await getLang(msg.chat.id)));
  bot.onText(/\/myorder|\/status|\/мойзаказ/i, async (msg) => doMyOrder(msg.chat.id, msg.from.id, await getLang(msg.chat.id)));

  bot.on("contact", async (msg) => {
    const chatId = msg.chat.id; const lang = await getLang(chatId); const c = msg.contact;
    if (c.user_id && msg.from && c.user_id !== msg.from.id) { bot.sendMessage(chatId, t(lang, "share_own"), askContact(lang)); return; }
    const phone9 = normPhone(c.phone_number);
    if (!phone9) { bot.sendMessage(chatId, t(lang, "bad_phone"), askContact(lang)); return; }
    try {
      // 1) Подтверждённый сотрудник — авторизуем и показываем внутреннее меню.
      const stf = await staffByPhone9(phone9);
      if (stf && stf.status === "confirmed" && stf.role) {
        await db.query(`UPDATE telegram_staff SET telegram_user_id=$1, telegram_chat_id=$2, telegram_username=$3, telegram_first_name=$4, telegram_last_name=$5, phone_original=COALESCE(phone_original,$6), updated_at=now() WHERE id=$7`,
          [msg.from.id, chatId, msg.from.username || null, msg.from.first_name || null, msg.from.last_name || null, c.phone_number, stf.id]);
        await db.logEvent("staff_auth", chatId, { role: stf.role });
        bot.sendMessage(chatId, `Здравствуйте! Вы подключены как ${roleTitle(stf.role)}.`, staffMenu(stf.role));
        await db.query("INSERT INTO notification_log (kind, dedup_key, target_chat_id, target_role) VALUES ('confirm',$1,$2,$3) ON CONFLICT (dedup_key) DO NOTHING", [`confirm:${stf.id}`, chatId, stf.role]).catch(() => {});
        return;
      }
      // 2) Клиент?
      const res = await onboard(chatId, msg.from, phone9, c.phone_number, lang);
      if (res.linked) { bot.sendMessage(chatId, res.text, mainMenu(lang)); return; }
      // 3) Неизвестный — создаём заявку сотрудника (админ подтвердит, если это сотрудник).
      await db.query(`INSERT INTO telegram_staff (telegram_user_id, telegram_chat_id, telegram_username, telegram_first_name, telegram_last_name, phone_original, phone_normalized, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'new_request')
        ON CONFLICT (telegram_user_id) DO UPDATE SET telegram_chat_id=$2, telegram_username=$3, telegram_first_name=$4, telegram_last_name=$5, phone_original=$6, phone_normalized=$7, updated_at=now()`,
        [msg.from.id, chatId, msg.from.username || null, msg.from.first_name || null, msg.from.last_name || null, c.phone_number, phone9]);
      await db.logEvent("staff_request", chatId, { phone: phone9 });
      bot.sendMessage(chatId, "Ваш номер пока не найден.\nЕсли вы клиент — обратитесь к вашему агенту Novagreen.\nЕсли вы сотрудник — заявка на доступ отправлена администратору.", { reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error("[ОНБОРДИНГ]", e.message); bot.sendMessage(chatId, "Ошибка при подключении."); }
  });

  bot.on("callback_query", async (q) => {
    const chatId = q.message.chat.id;
    const [act, val] = String(q.data || "").split(":");
    const key = q.from.id + "|" + val;
    try {
      if (await complaints.onCallback(q)) return; // колбэки мастера претензий (cmpl:*)
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
        const cart = { items: base.items.map((it) => ({ ...it })), agent: base.agent, priceType: base.priceType, warehouse: base.warehouse, clientCode: base.clientCode };
        draftCache.set(key, cart);
        const v = renderCart(val, cart, lang);
        await bot.editMessageText(v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "dop") {
        await bot.answerCallbackQuery(q.id); bot.sendChatAction(chatId, "typing");
        const orders = await freshOrdersToday();
        const o = orders.find((x) => x.client && x.client.SD_id === val && x.status !== 5);
        let meta = o ? { agent: o.agent && o.agent.SD_id, priceType: o.priceType && o.priceType.SD_id, warehouse: (o.store && o.store.SD_id) || (o.warehouse && o.warehouse.SD_id), clientCode: o.client && o.client.code_1C } : null;
        if (!meta || !meta.agent) { const d = await getPointDraft(val, "avg"); if (d) meta = { agent: d.agent, priceType: d.priceType, warehouse: d.warehouse, clientCode: d.clientCode }; }
        const cart = { items: [], agent: meta && meta.agent, priceType: meta && meta.priceType, warehouse: meta && meta.warehouse, clientCode: meta && meta.clientCode, code: `TGBOT-${val}-${tzToday()}-${tzHHMM()}` };
        draftCache.set(key, cart);
        const v = renderCart(val, cart, lang);
        await bot.editMessageText(t(lang, "dop_title") + "\n\n" + v.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: v.reply_markup });
        return;
      }
      if (act === "repl") {
        await bot.answerCallbackQuery(q.id);
        const idx = Number(String(q.data).split(":")[2]);
        const draft = draftCache.get(key);
        if (!draft || !draft.repls || !draft.repls[idx]) return;
        const r = draft.repls[idx];
        const ex = draft.items.find((x) => x.productSdId === r.toSd);
        if (ex) ex.qty += r.qty; else draft.items.push({ productSdId: r.toSd, name: r.toName, qty: r.qty });
        draft.repls.splice(idx, 1);
        const m = draftMessage(val, draft, lang);
        try { await bot.editMessageText(m.text, { chat_id: chatId, message_id: q.message.message_id, reply_markup: m.reply_markup }); } catch (_) {}
        return;
      }
      if (act === "cmt") {
        await bot.answerCallbackQuery(q.id);
        awaitComment.set(chatId, { key, sdId: val });
        await bot.sendMessage(chatId, t(lang, "cmt_ask"));
        return;
      }
      if (act === "inc" || act === "dec") {
        const idx = Number(String(q.data).split(":")[2]); const cart = draftCache.get(key);
        if (!cart || !cart.items[idx]) { await bot.answerCallbackQuery(q.id); return; }
        if (act === "inc") {
          const avail = (await getStockMap())[cart.items[idx].productSdId] || 0;
          if (cart.items[idx].qty + 1 > avail) { await bot.answerCallbackQuery(q.id, { text: `${t(lang, "only_avail") || "В наличии только"} ${avail}` }); return; }
          cart.items[idx].qty += 1;
        } else {
          cart.items[idx].qty = Math.max(0, cart.items[idx].qty - 1);
        }
        await bot.answerCallbackQuery(q.id);
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
      if (act === "dg") {
        await bot.answerCallbackQuery(q.id);
        const stf = await getStaff(q.from.id);
        if (!stf) return;
        const sub = String(q.data).split(":")[1];
        if (sub === "not") return handleStaffText(chatId, q.from.id, stf, "🚫 Не заказали");
        if (sub === "clients") return handleStaffText(chatId, q.from.id, stf, "👥 Мои клиенты");
        if (sub === "refresh") { bot.sendChatAction(chatId, "typing"); return sendOneDigest(chatId, stf.crm_agent_id); }
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
        if (cart && prod) {
          const avail = (await getStockMap())[prod.SD_id] || 0;
          const ex = cart.items.find((it) => it.productSdId === prod.SD_id);
          if (ex) { if (ex.qty + 1 <= avail) ex.qty += 1; }
          else if (avail >= 1) cart.items.push({ productSdId: prod.SD_id, name: prod.name, qty: 1 });
        }
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
        if (act === "done" && draft) draft = { items: draft.items.filter((it) => it.qty > 0), agent: draft.agent, priceType: draft.priceType, warehouse: draft.warehouse, code: draft.code, comment: draft.comment };
        if (!draft) { await bot.editMessageText(t(lang, "order_err", "нет данных"), { chat_id: chatId, message_id: q.message.message_id }); return; }
        if (!draft.items.length) { await bot.editMessageText(t(lang, "empty_cart"), { chat_id: chatId, message_id: q.message.message_id }); return; }
        try {
          const cap = capItemsToStock(draft.items, await freshStockMap());
          draft.items = cap.items;
          if (!draft.items.length) { await bot.editMessageText(t(lang, "none_now"), { chat_id: chatId, message_id: q.message.message_id }); return; }
          const res = await createOrderFromDraft(val, draft, draft.code, chatId, !!draft.code);
          await db.logEvent("order_created", chatId, { sdId: val, mode: act, dop: !!draft.code, queued: !!res.queued });
          if (res.queued) {
            await bot.editMessageText("✅ Заказ принят. Отправляем в систему — подтверждение придёт автоматически.", { chat_id: chatId, message_id: q.message.message_id });
          } else {
            let okText = t(lang, "order_ok");
            if (cap.capped.length || cap.removed.length) {
              okText += "\n\n⚠️ Скорректировано по остаткам:";
              if (cap.capped.length) okText += "\n• " + cap.capped.join("\n• ");
              if (cap.removed.length) okText += "\nУбрано (нет в наличии): " + cap.removed.join(", ");
            }
            await bot.editMessageText(okText, { chat_id: chatId, message_id: q.message.message_id });
            if (draft.code) {
              const n = draft.items.filter((it) => it.qty > 0).length;
              notifyClientAgent(val, `➕ Доп.заказ через бот\nКлиент: {name}\nПозиций: ${n} · ${tzHHMM()}`, draft.code).catch(() => {});
            }
          }
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
    const chatId = msg.chat.id; const txt = (msg.text || "").trim();
    if (await complaints.onMessage(msg)) return; // мастер претензий перехватывает свои сообщения/медиа
    const pend = awaitComment.get(chatId);
    if (pend && !msg.contact) {
      awaitComment.delete(chatId);
      const lang0 = await getLang(chatId);
      if (txt === "/skip" || txt === "/cancel") { await bot.sendMessage(chatId, t(lang0, "cmt_skip")); return; }
      const cart = draftCache.get(pend.key);
      if (cart) { cart.comment = txt.slice(0, 500); await bot.sendMessage(chatId, t(lang0, "cmt_saved")); }
      else { await bot.sendMessage(chatId, t(lang0, "cart_stale")); }
      return;
    }
    if (msg.contact || (msg.text && msg.text.startsWith("/"))) return;
    const stf = await getStaff(msg.from.id);
    if (stf) return handleStaffText(chatId, msg.from.id, stf, txt);
    const lang = await getLang(chatId);
    if (txt === STR.menu_order.ru || txt === STR.menu_order.uz) return doZakaz(chatId, msg.from.id, lang);
    if (txt === STR.menu_myorder.ru || txt === STR.menu_myorder.uz) return doMyOrder(chatId, msg.from.id, lang);
    await db.logEvent("message", chatId, { text: msg.text });
    bot.sendMessage(chatId, lang === "uz" ? "Menyudan foydalaning yoki /start." : "Воспользуйтесь меню внизу или /start.", mainMenu(lang));
  });

  bot.on("polling_error", (err) => console.error("[Telegram] Ошибка опроса:", err.message));
}

main().catch((e) => { console.error("[СТАРТ] Критическая ошибка запуска:", e.message); process.exit(1); });
