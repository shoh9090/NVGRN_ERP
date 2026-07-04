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
let botCfg = { times: ["18:00", "21:00", "23:00"], deadline: "00:00", window: WINDOW_DAYS, enabled: true, digestTime: "08:30", digestEnabled: true, signalsEnabled: true, sig1Days: 3, sig2Pct: 40, sig2Win: 7, orderAlerts: true, quietFrom: "22:00", quietTo: "08:00", lostFreq: "weekly", deliveryRemindTimes: ["21:00", "22:00"], deliveryRemindEnabled: true };

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

// Сравнение состава заказа (снимок ↔ текущий): что урезали / убрали / добавили.
function diffOrderItems(prev, now) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const pm = new Map(arr(prev).map((x) => [String(x.sd), x]));
  const nm = new Map(arr(now).map((x) => [String(x.sd), x]));
  const lines = [];
  for (const [sd, p] of pm) {
    const n = nm.get(sd);
    if (!n) { lines.push(`• ${p.name}: убрана (было ${p.qty})`); continue; }
    if (Number(n.qty) !== Number(p.qty)) { const d = Number(n.qty) - Number(p.qty); lines.push(`• ${p.name}: ${p.qty} → ${n.qty} (${d > 0 ? "+" : ""}${d})`); }
  }
  for (const [sd, n] of nm) { if (!pm.has(sd)) lines.push(`• ${n.name}: добавлена (${n.qty})`); }
  return lines;
}

// Упущенные продажи: только уменьшения/удаления позиций (склад не дал товар). Сумма = (было−стало)×цена.
function computeLost(prev, now) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const nm = new Map(arr(now).map((x) => [String(x.sd), x]));
  const out = [];
  for (const p of arr(prev)) {
    const before = Number(p.qty) || 0;
    const n = nm.get(String(p.sd));
    const after = n ? (Number(n.qty) || 0) : 0;
    if (after < before) {
      const lost = before - after, price = Number(p.price) || 0;
      out.push({ sd: String(p.sd), name: p.name, before, after, lost, price, amount: lost * price });
    }
  }
  return out;
}

// Тихий час: в окне quietFrom..quietTo оповещения об изменениях заказов не шлём.
function inQuietHours(cfg) {
  const from = cfg.quietFrom, to = cfg.quietTo;
  if (!from || !to || from === to) return false;
  const now = new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(11, 16);
  return from < to ? (now >= from && now < to) : (now >= from || now < to);
}

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
  const map = {}, names = {}, byWh = {};
  for (const w of whs) {
    // Остаток нужен по конкретному складу: заказ уходит на один склад, а не на «сумму всех».
    const whId = w.SD_id || (w.warehouse && w.warehouse.SD_id) || (w.store && w.store.SD_id) || null;
    for (const p of (w.products || [])) {
      if (!p.SD_id) continue;
      const q = Number(p.quantity) || 0;
      map[p.SD_id] = (map[p.SD_id] || 0) + q;
      names[p.SD_id] = p.name || p.SD_id;
      if (whId) { (byWh[whId] = byWh[whId] || {})[p.SD_id] = (byWh[whId][p.SD_id] || 0) + q; }
    }
  }
  const catalog = Object.keys(map).filter((id) => map[id] > 0)
    .map((id) => ({ SD_id: id, name: names[id], qty: map[id] })).sort((a, b) => a.name.localeCompare(b.name));
  return { map, catalog, byWh, names };
});
const getCatalog = async () => (await getStockData()).catalog;
const getStockMap = async () => (await getStockData()).map;
const freshStockMap = () => { _cache.delete("stock"); return getStockMap(); };
// Остаток по складу заказа. Если склад не распознан — падаем на суммарный (старое поведение, без регресса).
const getWhStock = async (whId) => { const d = await getStockData(); return (whId && d.byWh[whId]) ? d.byWh[whId] : d.map; };
const freshWhStock = (whId) => { _cache.delete("stock"); return getWhStock(whId); };

// Единый прайс-тип для всех заказов HoReCa через бота (SalesDoctor).
// «Новый прайс 2026 / Продажа» = d0_16. Меняется через env без правки кода.
const HORECA_PRICE_TYPE = process.env.SD_HORECA_PRICETYPE || "d0_16";
// Карта цен прайса: SalesDoctor не применяет прайс-тип сам при setOrder — цену в каждую
// позицию бот проставляет вручную (как агентское приложение). Ключ — SD_id товара.
const getPriceMap = () => cached("pricemap:" + HORECA_PRICE_TYPE, 600000, async () => {
  const rows = await sd.fetchAll("getPrice", { priceType: { SD_id: HORECA_PRICE_TYPE } });
  const m = {};
  for (const p of rows) { const id = p.product && p.product.SD_id; if (id) m[id] = Number(p.price) || 0; }
  return m;
});
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
// Отгруженные, но не отмеченные «Доставлен» (статус 2, дата доставки dateDocument ≤ сегодня).
async function undeliveredShipped() {
  const today = tzToday();
  const orders = await getOrders14();
  return orders.filter((o) => Number(o.status) === 2 && String(o.dateDocument || o.dateShipment || "").slice(0, 10) <= today);
}
const ordLine = (o, i) => `${i + 1}. ${o.code_1C || o.SD_id} — ${(o.client && (o.client.clientName || o.client.SD_id)) || "?"}`;
async function reloadCfg() {
  try {
    const r = await db.query("SELECT * FROM bot_settings WHERE id=1");
    if (r.rows[0]) {
      const s = r.rows[0];
      const times = String(s.reminder_times || "").split(",").map((x) => x.trim()).filter(Boolean);
      const win = Number(s.avg_window_days) || WINDOW_DAYS;
      if (win !== botCfg.window) _cache.delete("orders14");
      const delivTimes = String(s.delivery_remind_times || "21:00,22:00").split(",").map((x) => x.trim()).filter(Boolean);
      botCfg = { times, deadline: s.deadline || "00:00", window: win, enabled: s.enabled !== false,
        digestTime: s.digest_time || "08:30", digestEnabled: s.digest_enabled !== false, signalsEnabled: s.signals_enabled !== false,
        sig1Days: Number(s.signal1_days) || 3, sig2Pct: Number(s.signal2_pct) || 40, sig2Win: Number(s.signal2_window) || 7,
        orderAlerts: s.order_alerts_enabled !== false, quietFrom: s.quiet_from || "22:00", quietTo: s.quiet_to || "08:00", lostFreq: s.lost_summary_freq || "weekly",
        deliveryRemindTimes: delivTimes, deliveryRemindEnabled: s.delivery_remind_enabled !== false };
    }
  } catch (e) { console.warn("[НАСТРОЙКИ]", e.message); }
}

// ---------- Личность по номеру (Вариант Б) ----------
async function phone9OfUser(tgId) { const r = await db.query("SELECT phone9 FROM tg_users WHERE telegram_id=$1", [tgId]); return r.rows[0] && r.rows[0].phone9; }
async function pointsByPhone9(p9) { if (!p9) return []; const r = await db.query(`SELECT sd_id, point_name, firm_name FROM point_contacts WHERE ${PH9("zavsklad_phone")}=$1`, [p9]); return r.rows; }
async function chainsByPhone9(p9) { if (!p9) return []; const r = await db.query(`SELECT inn, firm_name FROM chain_managers WHERE ${PH9("manager_phone")}=$1`, [p9]); return r.rows; }
async function pointsOfUser(tgId) { return pointsByPhone9(await phone9OfUser(tgId)); }
// Авторизован ли пользователь как клиент: его номер привязан к точке ИЛИ к сети (менеджер).
async function isClientUser(tgId) {
  const p9 = await phone9OfUser(tgId);
  if (!p9) return false;
  if ((await pointsByPhone9(p9)).length) return true;
  return (await chainsByPhone9(p9)).length > 0;
}

// ---------- Бандл 1: сотрудники, роли, синхронизация ----------
async function getStaff(tgId) {
  const r = await db.query("SELECT role, crm_agent_id, expeditor_sd_id, status FROM telegram_staff WHERE telegram_user_id=$1", [tgId]);
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
// Синхронизация экспедиторов (водителей) из SD — для автопривязки и напоминаний о доставке.
async function syncExpeditorsBot() {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS crm_expeditors (sd_id TEXT PRIMARY KEY, code TEXT, name TEXT, phone_normalized TEXT, is_active BOOLEAN NOT NULL DEFAULT true, last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch(() => {});
    const exps = await sd.fetchAll("getExpeditor", {});
    for (const e of exps) {
      if (!e.SD_id) continue;
      await db.query(`INSERT INTO crm_expeditors (sd_id, code, name, phone_normalized, is_active, last_synced_at)
        VALUES ($1,$2,$3,$4,$5,now())
        ON CONFLICT (sd_id) DO UPDATE SET code=$2, name=$3, phone_normalized=$4, is_active=$5, last_synced_at=now()`,
        [e.SD_id, e.code_1C || null, e.name || e.SD_id, normPhone(e.tel), e.active === "Y"]);
    }
    console.log(`[ЭКСПЕДИТОРЫ] синхронизировано: ${exps.length}`);
    return exps.length;
  } catch (e) { console.warn("[ЭКСПЕДИТОРЫ]", e.message); return 0; }
}
const STAFF_MENU = {
  agent: [["👥 Мои клиенты"], ["🚫 Не заказали"], ["📩 Претензия за клиента"], ["📊 Моя сводка"], ["➕ Доп. заказы"], ["📉 Сигналы"]],
  head_of_sales: [["📊 Сводка отдела"], ["👥 По агентам"], ["🚫 Не заказали"], ["➕ Доп. заказы"], ["📉 Сигналы"], ["⚠️ Ошибки", "🔄 Синхронизация"]],
  logistics: [["🚚 Доставки сегодня"], ["📊 По экспедиторам"], ["⚙️ Напоминания"]],
  expeditor: [["🚚 Мои доставки"]],
  marketing: [["📊 Маркетинг"]],
  admin: [["🔄 Синхронизация"], ["👤 Telegram-сотрудники"], ["⚠️ Ошибки"], ["📦 Очередь заказов"], ["⚙️ Настройки"]],
};
const staffMenu = (role) => ({ reply_markup: { keyboard: STAFF_MENU[role] || [], resize_keyboard: true } });
const ROLE_TITLES = { admin: "админ", head_of_sales: "руководитель продаж", logistics: "логистика", expeditor: "экспедитор (водитель)", marketing: "маркетинг", agent: "торговый агент" };
const roleTitle = (role) => ROLE_TITLES[role] || "торговый агент";

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
  // Прайс-тип — единый для всей HoReCa (см. HORECA_PRICE_TYPE), не копируем из заказов.
  const meta = { agent: last.agent && last.agent.SD_id, priceType: HORECA_PRICE_TYPE, warehouse: (last.store && last.store.SD_id) || (last.warehouse && last.warehouse.SD_id), clientCode: last.client && last.client.code_1C };
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
  const stock = await getWhStock(meta.warehouse);
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
    client: draft.clientCode ? { SD_id: sdId, code_1C: draft.clientCode } : { SD_id: sdId }, agent: { SD_id: draft.agent }, priceType: { SD_id: draft.priceType || HORECA_PRICE_TYPE }, warehouse: { SD_id: draft.warehouse },
    orderProducts: draft.items.filter((it) => it.qty > 0).map((it) => {
      const op = { product: { SD_id: it.productSdId }, quantity: Math.max(1, Math.round(it.qty)) };
      if (it.price != null && it.price > 0) op.price = it.price; // цена из прайса d0_16 (SD сам её не проставляет)
      return op;
    }),
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
    // Разбираем нехватку остатков: SD возвращает по каждой проблемной позиции «Доступно: N».
    const shortages = {};
    const failed = resp && resp.result && Array.isArray(resp.result.failed) ? resp.result.failed : [];
    for (const f of failed) {
      const pid = f && f.data && f.data.product && f.data.product.SD_id;
      const emsg = String((f && f.error) || "");
      if (pid && /недостаточно|доступно/i.test(emsg)) {
        const mm = emsg.match(/Доступно:\s*(\d+)/i);
        shortages[pid] = mm ? Number(mm[1]) : 0;
      }
    }
    const m = (resp && (resp.error && (resp.error.message || resp.error)) || resp.message || (resp.errors && resp.errors[0] && (resp.errors[0].message || resp.errors[0]))) || "SD отклонил заказ";
    return { ok: false, permanent: true, error: typeof m === "string" ? m : JSON.stringify(m).slice(0, 200), shortages };
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
  if (!draft.agent || !draft.warehouse) throw new Error("нет агента/склада — нужен прошлый заказ точки");
  // Проставляем цену из прайса d0_16 в каждую позицию (SD сам её при setOrder не считает).
  let priceMap = {}; try { priceMap = await getPriceMap(); } catch (e) { console.warn("[ПРАЙС]", e.message); }
  let items = draft.items.filter((it) => it.qty > 0).map((it) => ({ ...it, price: priceMap[it.productSdId] != null ? priceMap[it.productSdId] : it.price }));
  const removedBySd = [], cappedBySd = [];
  // SD-заказ атомарный: одна позиция без остатка валит весь заказ. Поэтому при отказе
  // по остаткам подрезаем/убираем проблемные позиции по данным SD и повторяем.
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = buildOrder(sdId, { ...draft, items }, code);
    const r = await submitOrderObj(order);
    if (r.ok) { _cache.delete("ordersToday"); return { ok: true, removedBySd, cappedBySd }; }
    if (!r.permanent) {
      console.warn("[ЗАКАЗ] SD недоступен — в очередь:", r.error);
      await enqueuePending(order, sdId, chatId, isDop, r.error);
      return { queued: true, removedBySd, cappedBySd };
    }
    const short = r.shortages || {};
    if (Object.keys(short).length) {
      const next = [];
      for (const it of items) {
        if (it.productSdId in short) {
          const av = short[it.productSdId];
          if (av >= 1) { cappedBySd.push(`${it.name}: ${av}`); next.push({ ...it, qty: av }); }
          else removedBySd.push(it.name);
        } else next.push(it);
      }
      items = next;
      if (!items.length) throw new Error("ни одной позиции нет в наличии на складе");
      console.warn("[ЗАКАЗ] нехватка остатков — корректирую и повторяю:", r.error);
      continue;
    }
    console.error("[ЗАКАЗ] SD отклонил:", r.error);
    throw new Error(r.error);
  }
  throw new Error("не удалось оформить даже после корректировки остатков");
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
  complaints.init({ bot, db, getLang, pointsOfUser, phone9OfUser, pointsOfAgent, getOrders14, mainMenu, notifyClientAgent, notifyAgentReact, notifyManagers });

  // Прогрев кэша: каталог/остатки и история всегда «горячие», чтобы «Добавить» открывалось мгновенно.
  const warmStock = async () => { try { _cache.delete("stock"); await getStockData(); } catch (e) { console.warn("[ПРОГРЕВ stock]", e.message); } };
  getHorecaProdCat().catch(() => {});
  warmStock(); getOrders14().catch(() => {});
  setInterval(warmStock, 240000); // каждые 4 мин (TTL 5 мин)
  syncClientsBot(); // живая синхронизация клиентов/агентов из SD
  setInterval(syncClientsBot, 45 * 60 * 1000);
  syncExpeditorsBot(); // экспедиторы (водители) из SD
  setInterval(syncExpeditorsBot, 60 * 60 * 1000);
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
    // «Надёжные» точки (заказывали вчера) не спамим весь вечер — только один раз в последний слот.
    const yday = tzDateAgo(1);
    const reliable = new Set((await getOrders14()).filter((o) => o.status !== 5 && o.client && String(o.dateCreate || "").slice(0, 10) >= yday).map((o) => o.client.SD_id).filter(Boolean));
    const times = botCfg.times || [];
    const isLastSlot = !times.includes(slot) || slot === times[times.length - 1];
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
        // Надёжная точка (заказывала вчера) — пропускаем ранние слоты, дёргаем только в последний.
        if (reliable.has(pt.sd_id) && !isLastSlot) { await logSkip(pt.sd_id, "RELIABLE_EARLY_SLOT"); continue; }
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

  // ===== Напоминание водителям о недоставленных заказах (в 21:00/22:00, настраивается) =====
  async function deliveryReminderTick() {
    try {
      await reloadCfg();
      if (!botCfg.deliveryRemindEnabled || !(botCfg.deliveryRemindTimes || []).length) return;
      const hhmm = tzNow().toISOString().slice(11, 16);
      if (!botCfg.deliveryRemindTimes.includes(hhmm)) return;
      _cache.delete("orders14");
      const undel = await undeliveredShipped();
      const byExp = {};
      for (const o of undel) { const ex = o.expeditor && o.expeditor.SD_id; if (!ex) continue; (byExp[ex] = byExp[ex] || []).push(o); }
      let sent = 0;
      for (const [expSd, list] of Object.entries(byExp)) {
        const st = (await db.query("SELECT telegram_chat_id FROM telegram_staff WHERE role='expeditor' AND status='confirmed' AND expeditor_sd_id=$1 AND telegram_chat_id IS NOT NULL ORDER BY id DESC LIMIT 1", [expSd])).rows[0];
        if (!st || !st.telegram_chat_id) continue;
        const key = `deliv:${expSd}:${tzToday()}:${hhmm}`;
        const seen = await db.query("SELECT 1 FROM notification_log WHERE dedup_key=$1", [key]);
        if (seen.rows.length) continue;
        const lines = list.slice(0, 30).map(ordLine);
        const text = `🚚 Напоминание по доставке\nУ вас ${list.length} заказ(ов) со статусом «Отгружен», не отмечены «Доставлен»:\n\n${lines.join("\n")}\n\nЕсли доставили — отметьте «Доставлен» в приложении SalesDoctor. Неоформленная вовремя доставка — ваша ответственность.`;
        await bot.sendMessage(st.telegram_chat_id, text).catch(() => {});
        await db.query("INSERT INTO notification_log (kind, dedup_key, target_chat_id) VALUES ('delivery_remind',$1,$2) ON CONFLICT (dedup_key) DO NOTHING", [key, st.telegram_chat_id]).catch(() => {});
        sent++;
      }
      if (sent) console.log(`[ДОСТАВКА] Напоминаний водителям (${hhmm}): ${sent}`);
    } catch (e) { console.error("[ДОСТАВКА]", e.message); }
  }
  setInterval(deliveryReminderTick, 60000);

  // ===== Сводка упущенных продаж РОПу и админу (ежедневно/еженедельно) =====
  let lastLostDay = "";
  async function sendLostSummary(days) {
    const rows = (await db.query(
      `SELECT product_name, sum(amount_lost)::numeric amt, sum(qty_lost)::numeric qty, count(*)::int c
       FROM lost_sales WHERE detected_at >= now() - make_interval(days => $1)
       GROUP BY product_name ORDER BY amt DESC NULLS LAST LIMIT 10`, [days])).rows;
    const tot = (await db.query(
      `SELECT coalesce(sum(amount_lost),0)::numeric amt, count(*)::int c
       FROM lost_sales WHERE detected_at >= now() - make_interval(days => $1)`, [days])).rows[0];
    if (!Number(tot.c)) return; // упущенного не было — не шлём
    const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("ru-RU");
    let text = `📉 Упущенные продажи ${days === 7 ? "за неделю" : "за сутки"}\nВсего упущено: ${fmt(tot.amt)} сум · позиций: ${tot.c}\n\nЧаще не хватало:\n`;
    text += rows.map((r) => `• ${r.product_name}: ${fmt(r.amt)} сум (${fmt(r.qty)})`).join("\n");
    text += `\n\nПодробно — в Hub → «Бот HoReCa» → «Упущенные продажи».`;
    await notifyByKind('lost_sales', text.slice(0, 3900));
  }
  async function lostSummaryTick() {
    try {
      await reloadCfg();
      if (botCfg.lostFreq === "off") return;
      const hhmm = tzNow().toISOString().slice(11, 16);
      if (hhmm !== (botCfg.digestTime || "08:30")) return; // в то же время, что и дайджест
      if (botCfg.lostFreq === "weekly" && new Date(Date.now() + TZ_OFFSET_MS).getUTCDay() !== 1) return; // еженедельно — по понедельникам
      const today = tzToday();
      if (lastLostDay === today) return;
      lastLostDay = today;
      await sendLostSummary(botCfg.lostFreq === "weekly" ? 7 : 1);
    } catch (e) { console.error("[УПУЩЕНО-СВОДКА]", e.message); }
  }
  setInterval(lostSummaryTick, 60000);

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

  // ===== Слежение за изменениями НОВЫХ заказов (status=1) =====
  async function saveOrderSnapshot(o, id, items) {
    const clientName = (o.client && (o.client.clientName || o.client.clientLegalName)) || null;
    await db.query(
      `INSERT INTO order_snapshots (sd_id, code_1c, agent_sd_id, client_name, items, seen_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (sd_id) DO UPDATE SET code_1c=$2, agent_sd_id=$3, client_name=$4, items=$5, seen_at=now()`,
      [String(id), o.code_1C || null, (o.agent && o.agent.SD_id) || null, clientName, JSON.stringify(items)]
    );
  }
  async function notifyOrderChange(o, diff) {
    if (!botCfg.orderAlerts || inQuietHours(botCfg)) return; // выключено или тихий час — push не шлём (данные в реестре остаются)
    const clientName = (o.client && (o.client.clientName || o.client.clientLegalName)) || (o.client && o.client.SD_id) || "—";
    const text = `⚠️ Изменён новый заказ ${o.code_1C || o.SD_id}\nКлиент: ${clientName}\nПравки состава (склад):\n` + diff.join("\n");
    const agentSd = o.agent && o.agent.SD_id;
    if (agentSd) {
      const a = (await db.query("SELECT telegram_chat_id FROM telegram_staff WHERE crm_agent_id=$1 AND role='agent' AND status='confirmed' AND telegram_chat_id IS NOT NULL ORDER BY id DESC LIMIT 1", [agentSd])).rows[0];
      if (a) bot.sendMessage(a.telegram_chat_id, text).catch(() => {});
    }
    await notifyByKind('order_change', text); // по подпискам (роли настраиваются в Hub)
  }
  async function recordLostSales(o, prevItems, nowItems) {
    const lost = computeLost(prevItems, nowItems);
    if (!lost.length) return;
    const clientName = (o.client && (o.client.clientName || o.client.clientLegalName)) || null;
    for (const L of lost) {
      await db.query(
        `INSERT INTO lost_sales (order_sd_id, order_code, client_sd_id, client_name, agent_sd_id,
           product_sd_id, product_name, qty_before, qty_after, qty_lost, price, amount_lost, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'stock')`,
        [o.SD_id || null, o.code_1C || null, (o.client && o.client.SD_id) || null, clientName,
         (o.agent && o.agent.SD_id) || null, L.sd, L.name, L.before, L.after, L.lost, L.price, L.amount]
      ).catch((e) => console.warn("[УПУЩЕНО]", e.message));
    }
  }
  async function watchOrderChanges() {
    try {
      const from = tzDateAgo(5), to = tzToday();
      const orders = await sd.fetchAll("getOrder", { filter: { status: [1], period: { date: { from, to } } } });
      for (const o of orders) {
        const id = o.SD_id || o.code_1C; if (!id) continue;
        const items = (o.orderProducts || []).filter((p) => p.product && p.product.SD_id)
          .map((p) => ({ sd: String(p.product.SD_id), name: p.product.name || p.product.SD_id, qty: Number(p.quantity) || 0, price: Number(p.price) || 0 }));
        const prev = (await db.query("SELECT items FROM order_snapshots WHERE sd_id=$1", [String(id)])).rows[0];
        if (!prev) { await saveOrderSnapshot(o, id, items); continue; } // первый раз — базовый снимок, без оповещения
        const diff = diffOrderItems(prev.items, items);
        if (diff.length) await notifyOrderChange(o, diff);
        await recordLostSales(o, prev.items, items); // упущенные продажи в реестр
        await saveOrderSnapshot(o, id, items);
      }
      await db.query("DELETE FROM order_snapshots WHERE seen_at < now() - interval '10 days'").catch(() => {});
    } catch (e) { console.error("[СЛЕЖКА-ЗАКАЗЫ]", e.message); }
  }
  watchOrderChanges(); // базовые снимки при старте
  setInterval(watchOrderChanges, 5 * 60 * 1000); // каждые 5 минут

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

  // Диагностика логистики: экспедиторы SD (с телефонами) + отгруженные заказы (какое поле = дата доставки).
  bot.onText(/\/logdiag/, async (msg) => {
    if (!isAdmin(msg.chat.id)) { bot.sendMessage(msg.chat.id, "Только админ."); return; }
    bot.sendChatAction(msg.chat.id, "typing");
    try {
      const exps = await sd.fetchAll("getExpeditor", {});
      const el = exps.slice(0, 25).map((e) => `${e.SD_id} | ${e.name || "?"} | тел: ${e.tel || "—"} | ${e.active}`);
      await bot.sendMessage(msg.chat.id, `Экспедиторы в SD (${exps.length}):\n` + (el.join("\n") || "—").slice(0, 3500));
      const from = tzDateAgo(3), to = tzToday();
      const orders = await sd.fetchAll("getOrder", { filter: { status: [2], period: { date: { from, to } } } });
      const ol = orders.slice(0, 12).map((o) => `${o.code_1C || o.SD_id} | ${(o.client && (o.client.clientName || o.client.SD_id)) || "?"} | эксп: ${(o.expeditor && o.expeditor.SD_id) || "—"} | dDoc ${o.dateDocument || "—"} | consig ${o.consigDate || "—"} | dCreate ${o.dateCreate || "—"}`);
      await bot.sendMessage(msg.chat.id, `Отгруженные (статус 2) за 3 дня: ${orders.length}\n\n` + (ol.join("\n") || "—").slice(0, 3500));
    } catch (e) { bot.sendMessage(msg.chat.id, "Ошибка: " + e.message); }
  });

  // Диагностика прайсов: список прайс-типов SD + реальные цены текущего прайса бота.
  bot.onText(/\/prices/, async (msg) => {
    if (!isAdmin(msg.chat.id)) { bot.sendMessage(msg.chat.id, "Только админ."); return; }
    bot.sendChatAction(msg.chat.id, "typing");
    try {
      const types = await sd.fetchAll("getPriceType", {});
      const tlines = types.map((t) => `${t.SD_id}${t.CS_id ? " (" + t.CS_id + ")" : ""} — ${t.name || "?"}`);
      await bot.sendMessage(msg.chat.id, `Прайс-типы в SD (${types.length}):\n` + tlines.join("\n").slice(0, 3500));
      const names = ((await getStockData()) || {}).names || {};
      const prices = await sd.fetchAll("getPrice", { priceType: { SD_id: HORECA_PRICE_TYPE } });
      const cur = types.find((t) => t.SD_id === HORECA_PRICE_TYPE);
      const plines = prices.slice(0, 40).map((p) => `• ${names[p.product && p.product.SD_id] || (p.product && p.product.SD_id)}: ${Number(p.price || 0).toLocaleString("ru-RU")}`);
      await bot.sendMessage(msg.chat.id, `Текущий прайс бота: ${HORECA_PRICE_TYPE}${cur ? " («" + cur.name + "»)" : ""}\nПозиций с ценой: ${prices.length}\n\n` + (plines.join("\n") || "— цен нет —").slice(0, 3500));
    } catch (e) { bot.sendMessage(msg.chat.id, "Ошибка: " + e.message); }
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
      if (txt === "📩 Претензия за клиента") return complaints.startForAgent(chatId, tgId, await getLang(chatId), stf.crm_agent_id);
      if (txt === "👥 Мои клиенты") {
        const pts = await pointsOfAgent(stf.crm_agent_id);
        if (!pts.length) return bot.sendMessage(chatId, "За вами пока не закреплено точек. Проверьте синхронизацию в Hub.");
        const lines = pts.slice(0, 80).map((pt, i) => `${i + 1}. ${pt.point_name || pt.firm_name || pt.sd_id}`);
        return bot.sendMessage(chatId, `Ваши клиенты (${pts.length}):\n` + lines.join("\n"));
      }
      return soon();
    }
    if (stf.role === "head_of_sales") {
      const send = async (fn) => { bot.sendChatAction(chatId, "typing"); try { return await bot.sendMessage(chatId, await fn()); } catch (e) { return bot.sendMessage(chatId, "Ошибка: " + e.message); } };
      if (txt === "📊 Сводка отдела") return send(deptSummary);
      if (txt === "👥 По агентам") return send(deptByAgents);
      if (txt === "📉 Сигналы") return send(deptSignals);
      if (txt === "🔄 Синхронизация") { bot.sendMessage(chatId, "Запускаю синхронизацию…"); const n = await syncClientsBot(); return bot.sendMessage(chatId, `Готово. Клиентов обновлено: ${n}.`); }
      return soon();
    }
    if (stf.role === "admin") {
      if (txt === "👤 Telegram-сотрудники") return bot.sendMessage(chatId, "Управление сотрудниками: Hub → плитка «Телеграм-бот: ассистент продаж» → «Telegram-сотрудники».");
      if (txt === "🔄 Синхронизация") { bot.sendMessage(chatId, "Запускаю синхронизацию…"); const n = await syncClientsBot(); return bot.sendMessage(chatId, `Готово. Клиентов обновлено: ${n}.`); }
      return soon();
    }
    if (stf.role === "expeditor") {
      if (txt === "🚚 Мои доставки") {
        bot.sendChatAction(chatId, "typing"); _cache.delete("orders14");
        const mine = (await undeliveredShipped()).filter((o) => o.expeditor && o.expeditor.SD_id === stf.expeditor_sd_id);
        if (!mine.length) return bot.sendMessage(chatId, "✅ У вас нет незакрытых доставок. Отлично!");
        return bot.sendMessage(chatId, `🚚 Ваши недоставленные заказы (${mine.length}):\n\n${mine.slice(0, 40).map(ordLine).join("\n")}\n\nОтметьте «Доставлен» в приложении SalesDoctor.`);
      }
      return soon();
    }
    if (stf.role === "logistics") {
      if (txt === "⚙️ Напоминания") {
        await reloadCfg();
        const st = botCfg.deliveryRemindEnabled ? "включены" : "выключены";
        return bot.sendMessage(chatId, `⏰ Напоминания водителям: ${st}\nВремя: ${(botCfg.deliveryRemindTimes || []).join(", ") || "—"}\n\nИзменить время/вкл-выкл — в Hub → плитка «Телеграм-бот: ассистент продаж» → ⚙️ Настройки → блок «Напоминания водителям о доставке».`);
      }
      if (txt === "🚚 Доставки сегодня" || txt === "📊 По экспедиторам") {
        bot.sendChatAction(chatId, "typing"); _cache.delete("orders14");
        const undel = await undeliveredShipped();
        if (!undel.length) return bot.sendMessage(chatId, "✅ Все отгруженные заказы отмечены «Доставлен».");
        const nameOf = {}; (await db.query("SELECT sd_id, name FROM crm_expeditors")).rows.forEach((e) => { nameOf[e.sd_id] = e.name; });
        const byExp = {};
        for (const o of undel) { const ex = (o.expeditor && o.expeditor.SD_id) || "—"; (byExp[ex] = byExp[ex] || []).push(o); }
        const blocks = Object.entries(byExp).sort((a, b) => b[1].length - a[1].length)
          .map(([ex, list]) => `👤 ${nameOf[ex] || (ex === "—" ? "без экспедитора" : ex)} — ${list.length}\n` + list.slice(0, 15).map(ordLine).join("\n"));
        return bot.sendMessage(chatId, `🚚 Отгружено, но не «Доставлен» (${undel.length}):\n\n` + blocks.join("\n\n"));
      }
      return soon();
    }
    if (stf.role === "marketing") return soon();
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
  // Рассылка по подпискам: кто из ролей подписан на данный тип оповещения (настраивается в Hub).
  async function notifyByKind(kind, text) {
    const seen = new Set();
    try {
      await db.query("CREATE TABLE IF NOT EXISTS notif_subs (kind TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (kind, role))").catch(() => {});
      const rows = (await db.query(
        `SELECT DISTINCT s.telegram_chat_id FROM telegram_staff s
         JOIN notif_subs ns ON ns.role = s.role
         WHERE ns.kind=$1 AND s.status='confirmed' AND s.telegram_chat_id IS NOT NULL`, [kind])).rows;
      for (const r of rows) { const c = r.telegram_chat_id; if (c && !seen.has(String(c))) { seen.add(String(c)); bot.sendMessage(c, text).catch(() => {}); } }
      const admOn = (await db.query("SELECT 1 FROM notif_subs WHERE kind=$1 AND role='admin'", [kind])).rows.length;
      if (admOn && ADMIN_TG_ID && !seen.has(String(ADMIN_TG_ID))) bot.sendMessage(ADMIN_TG_ID, text).catch(() => {});
    } catch (e) { console.warn("[ОПОВЕЩ]", e.message); }
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

  // ===== Аналитика для РОПа (меню head_of_sales) =====
  async function agentNamesMap() {
    const r = await db.query("SELECT crm_agent_id, telegram_first_name, telegram_last_name FROM telegram_staff WHERE role='agent' AND crm_agent_id IS NOT NULL");
    const m = {};
    for (const x of r.rows) {
      if (!x.crm_agent_id) continue;
      const nm = [x.telegram_first_name, x.telegram_last_name].filter(Boolean).join(" ");
      m[String(x.crm_agent_id)] = nm || ("Агент " + x.crm_agent_id);
    }
    return m;
  }
  const agentLabel = (names, a) => (a === "_none" ? "(без агента)" : (names[String(a)] || ("Агент " + a)));

  // 📊 Сводка отдела на сегодня
  async function deptSummary() {
    const today = tzToday();
    const pts = (await db.query("SELECT sd_id, agent_sd_id FROM point_contacts WHERE coalesce(active,'Y')<>'N'")).rows;
    const ptSet = new Set(pts.map((p) => p.sd_id));
    const live = (await getOrdersToday()).filter((o) => o.status !== 5 && o.client && o.client.SD_id && ptSet.has(o.client.SD_id));
    const ordered = new Set(live.map((o) => o.client.SD_id));
    const dop = Math.max(0, live.length - ordered.size);
    const skip = new Set((await db.query("SELECT sd_id FROM reminder_skips WHERE rdate=$1", [today])).rows.map((r) => r.sd_id));
    const notOrdered = pts.filter((p) => !ordered.has(p.sd_id));
    const notToday = notOrdered.filter((p) => skip.has(p.sd_id)).length;
    const names = await agentNamesMap();
    const byAgent = {};
    for (const p of notOrdered) { const a = p.agent_sd_id || "_none"; byAgent[a] = (byAgent[a] || 0) + 1; }
    const lines = Object.entries(byAgent).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([a, n]) => `• ${agentLabel(names, a)} — ${n}`);
    let text = `📊 Сводка отдела · ${today}\nТочек всего: ${pts.length}\n✅ Заказали: ${ordered.size}\n🚫 Не заказали: ${notOrdered.length}\n➕ Доп.заказы: ${dop}\n🔕 «Не сегодня»: ${notToday}`;
    if (lines.length) text += `\n\nНе заказали по агентам:\n` + lines.join("\n");
    return text.slice(0, 3900);
  }

  // 👥 По агентам: ОКБ / АКБ(14д) / заказали / не заказали
  async function deptByAgents() {
    const today = tzToday();
    const pts = (await db.query("SELECT sd_id, agent_sd_id FROM point_contacts WHERE coalesce(active,'Y')<>'N'")).rows;
    const ordered14 = new Set((await getOrders14()).filter((o) => o.status !== 5 && o.client).map((o) => o.client.SD_id));
    const orderedToday = new Set((await getOrdersToday()).filter((o) => o.status !== 5 && o.client).map((o) => o.client.SD_id));
    const names = await agentNamesMap();
    const agg = {};
    for (const p of pts) {
      const a = p.agent_sd_id || "_none";
      const x = agg[a] || (agg[a] = { okb: 0, akb: 0, ord: 0 });
      x.okb++;
      if (ordered14.has(p.sd_id)) x.akb++;
      if (orderedToday.has(p.sd_id)) x.ord++;
    }
    const rows = Object.entries(agg).map(([a, x]) => ({ name: agentLabel(names, a), okb: x.okb, akb: x.akb, ord: x.ord, not: x.okb - x.ord }));
    rows.sort((a, b) => b.not - a.not || b.okb - a.okb);
    let text = `👥 По агентам · ${today}`;
    text += rows.slice(0, 40).map((r) => {
      const pct = r.okb ? Math.round(r.akb / r.okb * 100) : 0;
      return `\n\n👤 ${r.name}\n   точек: ${r.okb} · актив: ${r.akb} (${pct}%) · сегодня: ${r.ord}✅ / ${r.not}🚫`;
    }).join("");
    text += `\n\nактив = заказывали за 14 дней.`;
    return text.slice(0, 3900);
  }

  // 📉 Сигналы по отделу (снимок, без записи в журнал)
  async function deptSignals() {
    const today = tzToday(); const d7 = tzDateAgo(7), d14 = tzDateAgo(14);
    const byClient = {};
    for (const o of await getOrders14()) {
      const cid = o.client && o.client.SD_id; if (!cid) continue;
      const dc = String(o.dateCreate || "").slice(0, 10); if (!dc) continue;
      const sum = Number(o.totalSummaAfterDiscount || o.totalSumma || 0);
      const c = byClient[cid] || (byClient[cid] = { last: "", w1: 0, w2: 0 });
      if (dc > c.last) c.last = dc;
      if (dc >= d7) c.w1 += sum; else if (dc >= d14) c.w2 += sum;
    }
    const pts = (await db.query("SELECT sd_id, point_name, firm_name, agent_sd_id FROM point_contacts WHERE coalesce(active,'Y')<>'N'")).rows;
    const names = await agentNamesMap();
    const byAgent = {};
    for (const p of pts) {
      const c = byClient[p.sd_id]; if (!c || !c.last) continue;
      const daysSince = daysBetween(c.last, today);
      const nm = p.point_name || p.firm_name || p.sd_id;
      let txt = null;
      if (daysSince >= botCfg.sig1Days) txt = `🔕 ${nm}: нет заказов ${daysSince} дн.`;
      else if (c.w2 > 0 && c.w1 <= c.w2 * (1 - botCfg.sig2Pct / 100)) { const pct = Math.round((1 - c.w1 / c.w2) * 100); txt = `📉 ${nm}: сумма ↓${pct}% за неделю`; }
      if (!txt) continue;
      const a = p.agent_sd_id || "_none";
      (byAgent[a] = byAgent[a] || []).push(txt);
    }
    const keys = Object.keys(byAgent);
    if (!keys.length) return "📉 Сигналов по отделу нет. Всё ровно. 👍";
    let text = `📉 Сигналы по отделу · ${today}`;
    for (const a of keys) text += `\n\n${agentLabel(names, a)}:\n` + byAgent[a].slice(0, 15).join("\n");
    return text.slice(0, 3900);
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
    if (!(await isClientUser(msg.from.id))) { bot.sendMessage(msg.chat.id, lang === "uz" ? "Botdan foydalanish uchun raqamingizni yuboring yoki agentingizga murojaat qiling." : "Чтобы пользоваться ботом, поделитесь номером или обратитесь к вашему агенту.", askContact(lang)); return; }
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
      // 3) Неизвестный номер — доступ ЗАКРЫТ. Никаких самозаявок: чужой не должен попадать
      //    в очередь на подтверждение и тем более видеть клиентскую базу. Сотрудников заводит
      //    администратор вручную (Hub → «Телеграм-сотрудники»), там же он назначает роль и агента.
      await db.logEvent("access_denied", chatId, { phone: phone9 });
      // Уведомим админа один раз на номер (информационно, без создания доступа).
      try {
        const key = "denied:" + phone9;
        const seen = await db.query("SELECT 1 FROM notification_log WHERE dedup_key=$1", [key]);
        if (!seen.rows.length && ADMIN_TG_ID) {
          await bot.sendMessage(ADMIN_TG_ID, `⛔ Неизвестный номер пытался подключиться к боту:\nТел: ${c.phone_number}\nИмя: ${msg.from.first_name || ""} ${msg.from.last_name || ""}\nЮзер: @${msg.from.username || "—"}\n\nЕсли это наш сотрудник — добавьте его вручную в Hub → «Телеграм-сотрудники» (там назначьте роль и агента). Иначе — игнорируйте.`).catch(() => {});
          await db.query("INSERT INTO notification_log (kind, dedup_key, target_chat_id) VALUES ('access_denied',$1,$2) ON CONFLICT (dedup_key) DO NOTHING", [key, ADMIN_TG_ID]).catch(() => {});
        }
      } catch (e) { /* уведомление не критично */ }
      bot.sendMessage(chatId, "Ваш номер не зарегистрирован в системе Novagreen — доступ закрыт.\n\n• Клиенты оформляют заказы через своего агента.\n• Сотрудникам — обратитесь к администратору Novagreen.", { reply_markup: { remove_keyboard: true } });
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
        let meta = o ? { agent: o.agent && o.agent.SD_id, priceType: HORECA_PRICE_TYPE, warehouse: (o.store && o.store.SD_id) || (o.warehouse && o.warehouse.SD_id), clientCode: o.client && o.client.code_1C } : null;
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
          const cap = capItemsToStock(draft.items, await freshWhStock(draft.warehouse));
          draft.items = cap.items;
          if (!draft.items.length) { await bot.editMessageText(t(lang, "none_now"), { chat_id: chatId, message_id: q.message.message_id }); return; }
          const res = await createOrderFromDraft(val, draft, draft.code, chatId, !!draft.code);
          await db.logEvent("order_created", chatId, { sdId: val, mode: act, dop: !!draft.code, queued: !!res.queued });
          // Позиции, скорректированные нами (по нашей карте) и самим SD (при повторе).
          const capped = [...cap.capped, ...(res.cappedBySd || [])];
          const removed = [...cap.removed, ...(res.removedBySd || [])];
          if (res.queued) {
            let qText = "✅ Заказ принят. Отправляем в систему — подтверждение придёт автоматически.";
            if (capped.length || removed.length) {
              qText += "\n\n⚠️ Скорректировано по остаткам:";
              if (capped.length) qText += "\n• " + capped.join("\n• ");
              if (removed.length) qText += "\nУбрано (нет в наличии): " + removed.join(", ");
            }
            await bot.editMessageText(qText, { chat_id: chatId, message_id: q.message.message_id });
          } else {
            let okText = t(lang, "order_ok");
            if (capped.length || removed.length) {
              okText += "\n\n⚠️ Скорректировано по остаткам:";
              if (capped.length) okText += "\n• " + capped.join("\n• ");
              if (removed.length) okText += "\nУбрано (нет в наличии): " + removed.join(", ");
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
    // Не сотрудник и не привязанный клиент/сеть — доступа к меню и данным нет.
    if (!(await isClientUser(msg.from.id))) {
      return bot.sendMessage(chatId, lang === "uz"
        ? "Botdan foydalanish uchun pastdagi tugma bilan raqamingizni yuboring. Raqamingiz Novagreen bazasida bo‘lmasa — agentingizga murojaat qiling."
        : "Чтобы пользоваться ботом, поделитесь номером телефона кнопкой ниже. Если вашего номера нет в базе Novagreen — обратитесь к вашему агенту.", askContact(lang));
    }
    if (txt === STR.menu_order.ru || txt === STR.menu_order.uz) return doZakaz(chatId, msg.from.id, lang);
    if (txt === STR.menu_myorder.ru || txt === STR.menu_myorder.uz) return doMyOrder(chatId, msg.from.id, lang);
    await db.logEvent("message", chatId, { text: msg.text });
    bot.sendMessage(chatId, lang === "uz" ? "Menyudan foydalaning yoki /start." : "Воспользуйтесь меню внизу или /start.", mainMenu(lang));
  });

  bot.on("polling_error", (err) => console.error("[Telegram] Ошибка опроса:", err.message));
}

main().catch((e) => { console.error("[СТАРТ] Критическая ошибка запуска:", e.message); process.exit(1); });
