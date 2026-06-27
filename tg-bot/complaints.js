// complaints.js — мастер подачи претензии клиентом (Этап 3, коммит 1).
// Изолирован от логики заказов: index.js только маршрутизирует сюда сообщения/колбэки.
// Схему создаёт Hub (schema-first). Бот лишь читает справочник tgbot.complaint_dicts
// и пишет в tgbot.complaints / tgbot.complaint_files; байты медиа — в public.files.

let bot = null;
let db = null;
let H = {}; // helpers из index.js: getLang, pointsOfUser, phone9OfUser, getOrders14, mainMenu, notifyClientAgent

// Состояние мастера по chatId. Живёт в памяти — как draftCache у заказов.
const sessions = new Map();

// Кнопки нижнего меню заказа: при нажатии посреди мастера — выходим из претензии.
const EXIT_TEXTS = new Set(["🛒 Заказать", "🛒 Buyurtma berish", "📦 Мой заказ", "📦 Buyurtmam"]);

function init(helpers) {
  H = helpers;
  bot = helpers.bot;
  db = helpers.db;
}

// ---------- Тексты (RU/UZ) ----------
const STR = {
  menu:        { ru: "📩 Претензия", uz: "📩 Shikoyat" },
  not_client:  { ru: "Похоже, вы не привязаны как клиент. Отправьте /start.", uz: "Siz mijoz sifatida ulanmagansiz. /start yuboring." },
  pick_point:  { ru: "По какой точке претензия?", uz: "Qaysi nuqta bo‘yicha shikoyat?" },
  pick_order:  { ru: "Выберите заказ, по которому претензия:", uz: "Shikoyat tegishli buyurtmani tanlang:" },
  pick_product:{ ru: "На какой товар жалоба?", uz: "Qaysi mahsulotga shikoyat?" },
  pick_type:   { ru: "Что не так с товаром?", uz: "Mahsulotda nima muammo?" },
  no_orders:   { ru: "Не нашёл недавних заказов по этой точке. Обратитесь к вашему агенту Novagreen.", uz: "Bu nuqta bo‘yicha yaqin buyurtmalar topilmadi. Novagreen agentingizga murojaat qiling." },
  no_products: { ru: "В этом заказе нет позиций. Выберите другой заказ через «📩 Претензия».", uz: "Bu buyurtmada mahsulot yo‘q. «📩 Shikoyat» orqali boshqa buyurtmani tanlang." },
  send_media:  { ru: "Пришлите фото или видео проблемы (до 5). Когда закончите — нажмите «Готово».", uz: "Muammoning rasm yoki videosini yuboring (5 tagacha). Tugagach «Tayyor» tugmasini bosing." },
  media_got:   { ru: (n) => `📎 Принято: ${n}/5`, uz: (n) => `📎 Qabul qilindi: ${n}/5` },
  media_max:   { ru: "Достаточно (5). Нажмите «Готово».", uz: "Yetarli (5). «Tayyor» tugmasini bosing." },
  media_need:  { ru: "Нужно хотя бы одно фото или видео.", uz: "Kamida bitta rasm yoki video kerak." },
  media_only:  { ru: "Пришлите фото/видео или нажмите «Готово».", uz: "Rasm/video yuboring yoki «Tayyor» tugmasini bosing." },
  media_err:   { ru: "Не удалось загрузить файл, попробуйте ещё раз.", uz: "Faylni yuklab bo‘lmadi, yana urinib ko‘ring." },
  ask_comment: { ru: "Добавьте комментарий одним сообщением или нажмите «Пропустить».", uz: "Bitta xabar bilan izoh qoldiring yoki «O‘tkazib yuborish» tugmasini bosing." },
  use_buttons: { ru: "Выберите вариант кнопкой выше.", uz: "Yuqoridagi tugma orqali tanlang." },
  thanks:      { ru: (id) => `✅ Спасибо! Претензия №${id} принята. Мы разберёмся.`, uz: (id) => `✅ Rahmat! Shikoyat №${id} qabul qilindi. Ko‘rib chiqamiz.` },
  cancelled:   { ru: "Претензия отменена.", uz: "Shikoyat bekor qilindi." },
  expired:     { ru: "Мастер устарел — начните заново через «📩 Претензия».", uz: "Jarayon eskirdi — «📩 Shikoyat» orqali qaytadan boshlang." },
  save_err:    { ru: "Не удалось сохранить претензию. Попробуйте позже.", uz: "Shikoyatni saqlab bo‘lmadi. Keyinroq urinib ko‘ring." },
  btn_done:    { ru: "✅ Готово", uz: "✅ Tayyor" },
  btn_skip:    { ru: "Пропустить", uz: "O‘tkazib yuborish" },
  btn_cancel:  { ru: "Отмена", uz: "Bekor qilish" },
};
function t(lang, key, ...a) { const e = STR[key] && (STR[key][lang] || STR[key].ru); return typeof e === "function" ? e(...a) : e; }
function menuText(lang) { return STR.menu[lang] || STR.menu.ru; }

// ---------- Справочник типов (кэш 10 мин) ----------
let _types = null, _typesAt = 0;
async function getTypes() {
  if (_types && Date.now() - _typesAt < 600000) return _types;
  const r = await db.query("SELECT code, label_ru, link_code FROM tgbot.complaint_dicts WHERE kind='type' AND active ORDER BY sort_order");
  _types = r.rows; _typesAt = Date.now();
  return _types;
}

// ---------- Клавиатуры/хелперы ----------
const cancelRow = (lang) => [{ text: t(lang, "btn_cancel"), callback_data: "cmpl:cancel" }];
const doneKb = (lang) => ({ reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_done"), callback_data: "cmpl:done" }], cancelRow(lang)] } });
function fmtD(d) { const s = String(d || "").slice(0, 10); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}.${m[2]}` : (s || "—"); }
function extractMedia(msg) {
  if (msg.photo && msg.photo.length) return { kind: "photo", fileId: msg.photo[msg.photo.length - 1].file_id };
  if (msg.video) return { kind: "video", fileId: msg.video.file_id };
  if (msg.video_note) return { kind: "video_note", fileId: msg.video_note.file_id };
  return null;
}

// Скачать медиа из Telegram и положить байты в public.files; вернуть id записи.
async function saveTgMedia(fileId, kind) {
  const link = await bot.getFileLink(fileId);
  const resp = await fetch(link);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  const mime = kind === "photo" ? "image/jpeg" : "video/mp4";
  const ext = kind === "photo" ? "jpg" : "mp4";
  const ins = await db.query(
    "INSERT INTO public.files (name, mime, data) VALUES ($1, $2, $3) RETURNING id",
    [`complaint_${Date.now()}.${ext}`, mime, buf]
  );
  return ins.rows[0].id;
}

// ---------- Шаги мастера ----------
async function start(chatId, tgId, lang) {
  const points = await H.pointsOfUser(tgId);
  if (!points.length) { await bot.sendMessage(chatId, t(lang, "not_client")); return; }
  const phone9 = await H.phone9OfUser(tgId);
  const s = { tgId, phone9, points, media: [], stage: "point" };
  sessions.set(chatId, s);
  if (points.length === 1) { s.point = points[0]; await askOrder(chatId, s, lang); }
  else await askPoint(chatId, s, lang);
}

async function askPoint(chatId, s, lang) {
  s.stage = "point";
  const rows = s.points.map((p, i) => [{ text: p.point_name || p.firm_name || p.sd_id, callback_data: `cmpl:pt:${i}` }]);
  rows.push(cancelRow(lang));
  await bot.sendMessage(chatId, t(lang, "pick_point"), { reply_markup: { inline_keyboard: rows } });
}

async function askOrder(chatId, s, lang) {
  let orders = [];
  try { orders = (await H.getOrders14()).filter((o) => o.client && o.client.SD_id === s.point.sd_id); }
  catch (e) { console.warn("[ПРЕТЕНЗИЯ orders]", e.message); }
  orders.sort((a, b) => String(b.dateCreate || "").localeCompare(String(a.dateCreate || "")));
  const top = orders.slice(0, 8);
  if (!top.length) { await bot.sendMessage(chatId, t(lang, "no_orders"), H.mainMenu(lang)); sessions.delete(chatId); return; }
  s.orders = top; s.stage = "order";
  const rows = top.map((o, i) => [{ text: `📅 ${fmtD(o.dateShipment || o.dateCreate)} · ${(o.orderProducts || []).filter((x) => x.product).length} поз.`, callback_data: `cmpl:o:${i}` }]);
  rows.push(cancelRow(lang));
  await bot.sendMessage(chatId, t(lang, "pick_order"), { reply_markup: { inline_keyboard: rows } });
}

async function askProduct(chatId, s, lang) {
  const prods = (s.order.orderProducts || []).filter((op) => op.product && op.product.SD_id && Number(op.quantity) > 0);
  if (!prods.length) { await bot.sendMessage(chatId, t(lang, "no_products"), H.mainMenu(lang)); sessions.delete(chatId); return; }
  s.products = prods; s.stage = "product";
  const rows = prods.map((op, i) => [{ text: `${op.product.name || op.product.SD_id} · ${Number(op.quantity)}`, callback_data: `cmpl:p:${i}` }]);
  rows.push(cancelRow(lang));
  await bot.sendMessage(chatId, t(lang, "pick_product"), { reply_markup: { inline_keyboard: rows } });
}

async function askType(chatId, s, lang, page) {
  const types = await getTypes();
  const PER = 8;
  const pages = Math.max(1, Math.ceil(types.length / PER));
  const p = Math.min(Math.max(0, page || 0), pages - 1);
  const rows = types.slice(p * PER, p * PER + PER).map((ty) => [{ text: ty.label_ru, callback_data: `cmpl:t:${ty.code}` }]);
  const nav = [];
  if (p > 0) nav.push({ text: "◀", callback_data: `cmpl:tp:${p - 1}` });
  nav.push({ text: `${p + 1}/${pages}`, callback_data: "cmpl:noop" });
  if (p < pages - 1) nav.push({ text: "▶", callback_data: `cmpl:tp:${p + 1}` });
  rows.push(nav);
  rows.push(cancelRow(lang));
  s.stage = "type";
  await bot.sendMessage(chatId, t(lang, "pick_type"), { reply_markup: { inline_keyboard: rows } });
}

async function askMedia(chatId, s, lang) {
  s.stage = "media"; s.media = [];
  await bot.sendMessage(chatId, t(lang, "send_media"), doneKb(lang));
}

async function acceptMedia(chatId, s, m, lang) {
  if (s.media.length >= 5) { await bot.sendMessage(chatId, t(lang, "media_max"), doneKb(lang)); return; }
  try {
    const fileRef = await saveTgMedia(m.fileId, m.kind);
    s.media.push({ kind: m.kind, tgFileId: m.fileId, fileRef });
  } catch (e) { console.warn("[ПРЕТЕНЗИЯ media]", e.message); await bot.sendMessage(chatId, t(lang, "media_err")); return; }
  await bot.sendMessage(chatId, t(lang, "media_got", s.media.length), doneKb(lang));
}

async function askComment(chatId, s, lang) {
  s.stage = "comment";
  await bot.sendMessage(chatId, t(lang, "ask_comment"), { reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_skip"), callback_data: "cmpl:skip" }]] } });
}

async function finalize(chatId, s, lang) {
  try {
    const pc = (await db.query("SELECT point_name, firm_name, agent_sd_id FROM point_contacts WHERE sd_id=$1", [s.point.sd_id])).rows[0] || {};
    let agentName = null;
    if (pc.agent_sd_id) {
      const a = (await db.query("SELECT telegram_first_name, telegram_last_name FROM telegram_staff WHERE crm_agent_id=$1 ORDER BY (status='confirmed') DESC, id DESC LIMIT 1", [pc.agent_sd_id])).rows[0];
      if (a) agentName = [a.telegram_first_name, a.telegram_last_name].filter(Boolean).join(" ") || null;
    }
    const ship = s.order && s.order.dateShipment ? String(s.order.dateShipment).slice(0, 10) : null;
    const ins = await db.query(
      `INSERT INTO tgbot.complaints
         (source, sd_id, point_name, firm_name, agent_sd_id, agent_name, reporter_tg_id, reporter_phone,
          order_code, ship_date, volume_text, product_sd_id, product_name, complaint_type, link_code, client_comment, status)
       VALUES ('client_bot',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'new') RETURNING id`,
      [s.point.sd_id, s.point.point_name || pc.point_name || null, s.point.firm_name || pc.firm_name || null,
       pc.agent_sd_id || null, agentName, s.tgId, s.phone9 || null,
       (s.order && s.order.code_1C) || null, ship, s.product.qty ? String(s.product.qty) : null,
       s.product.sdId || null, s.product.name || null, s.type.code, s.type.link || null, s.client_comment || null]
    );
    const id = ins.rows[0].id;
    for (const m of s.media) {
      await db.query("INSERT INTO tgbot.complaint_files (complaint_id, kind, file_ref, tg_file_id) VALUES ($1,$2,$3,$4)", [id, m.kind, m.fileRef, m.tgFileId]);
    }
    await db.logEvent("complaint_created", chatId, { id, type: s.type.code, sd_id: s.point.sd_id });
    sessions.delete(chatId);
    await bot.sendMessage(chatId, t(lang, "thanks", id), H.mainMenu(lang));
    // Коммит 2: здесь добавим уведомление агенту (H.notifyClientAgent).
  } catch (e) {
    console.error("[ПРЕТЕНЗИЯ save]", e.message);
    sessions.delete(chatId);
    await bot.sendMessage(chatId, t(lang, "save_err"), H.mainMenu(lang));
  }
}

// ---------- Маршрутизация из index.js ----------
// Возвращает true, если сообщение «съедено» мастером (тогда index.js не обрабатывает дальше).
async function onMessage(msg) {
  if (!msg || msg.contact) return false;
  const chatId = msg.chat.id;
  const txt = (msg.text || "").trim();
  const lang = await H.getLang(chatId);
  const isMenu = txt === STR.menu.ru || txt === STR.menu.uz;

  // Выход из мастера по командам или кнопкам меню заказа — пусть index.js их обработает.
  if (sessions.has(chatId) && !isMenu && (txt.startsWith("/") || EXIT_TEXTS.has(txt))) {
    sessions.delete(chatId);
    return false;
  }
  if (isMenu) { await start(chatId, msg.from.id, lang); return true; }

  const s = sessions.get(chatId);
  if (!s) return false;

  if (s.stage === "media") {
    const m = extractMedia(msg);
    if (m) { await acceptMedia(chatId, s, m, lang); return true; }
    await bot.sendMessage(chatId, t(lang, "media_only"));
    return true;
  }
  if (s.stage === "comment") {
    if (txt) { s.client_comment = txt.slice(0, 1000); await finalize(chatId, s, lang); }
    return true;
  }
  // point/order/product/type — ждём нажатия кнопки
  await bot.sendMessage(chatId, t(lang, "use_buttons"));
  return true;
}

// Возвращает true, если колбэк наш (cmpl:*).
async function onCallback(q) {
  const data = String(q.data || "");
  if (!data.startsWith("cmpl:")) return false;
  const parts = data.split(":");
  const step = parts[1], arg = parts[2];
  const chatId = q.message.chat.id;
  const lang = await H.getLang(chatId);
  const s = sessions.get(chatId);
  try {
    if (step === "noop") { await bot.answerCallbackQuery(q.id); return true; }
    if (step === "cancel") { sessions.delete(chatId); await bot.answerCallbackQuery(q.id); await bot.sendMessage(chatId, t(lang, "cancelled"), H.mainMenu(lang)); return true; }
    if (!s) { await bot.answerCallbackQuery(q.id, { text: t(lang, "expired") }); return true; }

    if (step === "pt") { await bot.answerCallbackQuery(q.id); s.point = s.points[Number(arg)]; if (!s.point) { sessions.delete(chatId); return true; } await askOrder(chatId, s, lang); return true; }
    if (step === "o")  { await bot.answerCallbackQuery(q.id); s.order = s.orders[Number(arg)]; if (!s.order) return true; await askProduct(chatId, s, lang); return true; }
    if (step === "p")  {
      await bot.answerCallbackQuery(q.id);
      const op = s.products[Number(arg)]; if (!op) return true;
      s.product = { sdId: op.product.SD_id, name: op.product.name || op.product.SD_id, qty: Number(op.quantity) || 0 };
      await askType(chatId, s, lang, 0); return true;
    }
    if (step === "tp") { await bot.answerCallbackQuery(q.id); await askType(chatId, s, lang, Number(arg) || 0); return true; }
    if (step === "t")  {
      await bot.answerCallbackQuery(q.id);
      const ty = (await getTypes()).find((x) => x.code === arg); if (!ty) return true;
      s.type = { code: ty.code, label: ty.label_ru, link: ty.link_code };
      await askMedia(chatId, s, lang); return true;
    }
    if (step === "done") {
      if (!s.media.length) { await bot.answerCallbackQuery(q.id, { text: t(lang, "media_need"), show_alert: true }); return true; }
      await bot.answerCallbackQuery(q.id); await askComment(chatId, s, lang); return true;
    }
    if (step === "skip") { await bot.answerCallbackQuery(q.id); await finalize(chatId, s, lang); return true; }

    await bot.answerCallbackQuery(q.id);
    return true;
  } catch (e) {
    console.error("[ПРЕТЕНЗИЯ cb]", e.message);
    try { await bot.answerCallbackQuery(q.id); } catch (_) {}
    return true;
  }
}

module.exports = { init, onMessage, onCallback, menuText, isActive: (chatId) => sessions.has(chatId) };
