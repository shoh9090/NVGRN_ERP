// complaints.js — мастер подачи претензии клиентом (Этап 3, коммит 1).
// Изолирован от логики заказов: index.js только маршрутизирует сюда сообщения/колбэки.
// Схему создаёт Hub (schema-first). Бот лишь читает справочник tgbot.complaint_dicts
// и пишет в tgbot.complaints / tgbot.complaint_files; байты медиа — в public.files.

let bot = null;
let db = null;
let H = {}; // helpers из index.js: getLang, pointsOfUser, phone9OfUser, getOrders14, mainMenu, notifyClientAgent

// Состояние мастера по chatId. Живёт в памяти — как draftCache у заказов.
const sessions = new Map();

// Реакция агента: ждём текст комментария (chatId -> complaintId).
const agentComment = new Map();
// Типы жалоб, которые агент НЕ закрывает сам — только эскалация Шоху/РОПу.
const CRITICAL_TYPES = new Set(["zhivnost"]);

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
  agp_start:   { ru: "Претензия за клиента.\nВведите название вашей торговой точки (можно часть):", uz: "Mijoz uchun shikoyat.\nSavdo nuqtangiz nomini yozing (qism ham bo‘ladi):" },
  agp_none:    { ru: "Среди ваших точек ничего не нашлось. Попробуйте другое название или /start для отмены.", uz: "Nuqtalaringiz orasidan topilmadi. Boshqa nom yozing yoki /start." },
  agp_pick:    { ru: "Выберите точку:", uz: "Nuqtani tanlang:" },
  agp_noagent: { ru: "У вас не привязан агент в CRM — обратитесь к администратору.", uz: "Sizga CRMda agent biriktirilmagan — administratorga murojaat qiling." },
  pick_point:  { ru: "По какой точке претензия?", uz: "Qaysi nuqta bo‘yicha shikoyat?" },
  pick_order:  { ru: "Выберите заказ, по которому претензия:", uz: "Shikoyat tegishli buyurtmani tanlang:" },
  pick_product:{ ru: "На какой товар жалоба?", uz: "Qaysi mahsulotga shikoyat?" },
  pick_type:   { ru: "Что не так с товаром?", uz: "Mahsulotda nima muammo?" },
  pick_usage:  { ru: "Для чего используете этот продукт?", uz: "Bu mahsulotni nima uchun ishlatasiz?" },
  pick_dish:   { ru: "Каким был финальный вид продукта в блюде?", uz: "Mahsulot taomda qanday ko‘rinishda bo‘ldi?" },
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
  // --- Реакция агента ---
  btn_ag_comment: { ru: "✍️ Комментарий", uz: "✍️ Izoh" },
  react_already:  { ru: "Эта претензия уже в работе или закрыта.", uz: "Bu shikoyat allaqachon ishlovda yoki yopilgan." },
  react_taken:    { ru: (id) => `Вы приняли претензию №${id} в работу. Выберите решение или добавьте комментарий:`, uz: (id) => `№${id} shikoyatni ishga oldingiz. Yechim tanlang yoki izoh qo‘shing:` },
  res_closed:     { ru: (id) => `✅ Претензия №${id} закрыта. Спасибо за работу!`, uz: (id) => `✅ №${id} shikoyat yopildi. Rahmat!` },
  res_escalated:  { ru: (id) => `Решение записано. Претензия №${id} критическая — её разберёт и закроет Шох/РОП.`, uz: (id) => `Yechim yozildi. №${id} shikoyat muhim — uni rahbariyat ko‘rib yopadi.` },
  ag_comment_ask: { ru: "Напишите комментарий к претензии одним сообщением.", uz: "Shikoyatga izohni bitta xabar bilan yozing." },
  ag_comment_saved: { ru: (id) => `✍️ Комментарий к №${id} сохранён.`, uz: (id) => `✍️ №${id} uchun izoh saqlandi.` },
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

// ---------- Справочник назначений продукта (кэш 10 мин) ----------
let _usages = null, _usagesAt = 0;
async function getUsages() {
  if (_usages && Date.now() - _usagesAt < 600000) return _usages;
  const r = await db.query("SELECT code, label_ru FROM tgbot.complaint_dicts WHERE kind='usage' AND active ORDER BY sort_order");
  _usages = r.rows; _usagesAt = Date.now();
  return _usages;
}

// ---------- Справочник «Финальный вид в блюде» (кэш 10 мин) ----------
let _dishes = null, _dishesAt = 0;
async function getDishes() {
  if (_dishes && Date.now() - _dishesAt < 600000) return _dishes;
  const r = await db.query("SELECT code, label_ru FROM tgbot.complaint_dicts WHERE kind='dish_form' AND active ORDER BY sort_order");
  _dishes = r.rows; _dishesAt = Date.now();
  return _dishes;
}

// ---------- Справочник решений (для реакции агента; кэш 10 мин) ----------
let _resolutions = null, _resolutionsAt = 0;
async function getResolutions() {
  if (_resolutions && Date.now() - _resolutionsAt < 600000) return _resolutions;
  const r = await db.query("SELECT code, label_ru FROM tgbot.complaint_dicts WHERE kind='resolution' AND active ORDER BY sort_order");
  _resolutions = r.rows; _resolutionsAt = Date.now();
  return _resolutions;
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

// Старт мастера для АГЕНТА (оформляет претензию за клиента по своей точке).
async function startForAgent(chatId, tgId, lang, agentCrmId) {
  if (!agentCrmId) { await bot.sendMessage(chatId, t(lang, "agp_noagent")); return; }
  let phone9 = null;
  try { phone9 = await H.phone9OfUser(tgId); } catch (_) {}
  sessions.set(chatId, { byAgent: true, agentCrmId, tgId, phone9, media: [], stage: "agent_point_search", source: "agent" });
  await bot.sendMessage(chatId, t(lang, "agp_start"));
}
async function searchAgentPoints(agentCrmId, q) {
  const pts = await H.pointsOfAgent(agentCrmId);
  const needle = String(q).trim().toLowerCase();
  return pts.filter((p) => String(p.point_name || p.firm_name || p.sd_id || "").toLowerCase().includes(needle)).slice(0, 8);
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
  // Ультрафреш: счёт-фактуры (заказы) доступны только за последние 3 дня, максимум 3.
  const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const top = orders.filter((o) => String(o.dateShipment || o.dateCreate || "").slice(0, 10) >= cutoff).slice(0, 3);
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

async function askUsage(chatId, s, lang, page) {
  const items = await getUsages();
  const PER = 8;
  const pages = Math.max(1, Math.ceil(items.length / PER));
  const p = Math.min(Math.max(0, page || 0), pages - 1);
  const rows = items.slice(p * PER, p * PER + PER).map((u) => [{ text: u.label_ru, callback_data: `cmpl:u:${u.code}` }]);
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: "◀", callback_data: `cmpl:up:${p - 1}` });
    nav.push({ text: `${p + 1}/${pages}`, callback_data: "cmpl:noop" });
    if (p < pages - 1) nav.push({ text: "▶", callback_data: `cmpl:up:${p + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: t(lang, "btn_skip"), callback_data: "cmpl:uskip" }]);
  rows.push(cancelRow(lang));
  s.stage = "usage";
  await bot.sendMessage(chatId, t(lang, "pick_usage"), { reply_markup: { inline_keyboard: rows } });
}

async function askDish(chatId, s, lang, page) {
  const items = await getDishes();
  const PER = 8;
  const pages = Math.max(1, Math.ceil(items.length / PER));
  const p = Math.min(Math.max(0, page || 0), pages - 1);
  const rows = items.slice(p * PER, p * PER + PER).map((d) => [{ text: d.label_ru, callback_data: `cmpl:d:${d.code}` }]);
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: "◀", callback_data: `cmpl:dp:${p - 1}` });
    nav.push({ text: `${p + 1}/${pages}`, callback_data: "cmpl:noop" });
    if (p < pages - 1) nav.push({ text: "▶", callback_data: `cmpl:dp:${p + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: t(lang, "btn_skip"), callback_data: "cmpl:dskip" }]);
  rows.push(cancelRow(lang));
  s.stage = "dish";
  await bot.sendMessage(chatId, t(lang, "pick_dish"), { reply_markup: { inline_keyboard: rows } });
}

// Переходы между шагами: назначение и финальный вид показываем, только если справочники не пусты.
async function gotoAfterProduct(chatId, s, lang) {
  if ((await getUsages()).length) return askUsage(chatId, s, lang, 0);
  return gotoAfterUsage(chatId, s, lang);
}
async function gotoAfterUsage(chatId, s, lang) {
  if ((await getDishes()).length) return askDish(chatId, s, lang, 0);
  return askType(chatId, s, lang, 0);
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
       VALUES ($16,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'new') RETURNING id`,
      [s.point.sd_id, s.point.point_name || pc.point_name || null, s.point.firm_name || pc.firm_name || null,
       pc.agent_sd_id || null, agentName, s.tgId, s.phone9 || null,
       (s.order && s.order.code_1C) || null, ship, s.product.qty ? String(s.product.qty) : null,
       s.product.sdId || null, s.product.name || null, s.type.code, s.type.link || null, s.client_comment || null,
       s.source || 'client_bot']
    );
    const id = ins.rows[0].id;
    // Назначение продукта пишем отдельно и мягко: если Hub ещё не добавил колонку — претензия всё равно сохранится.
    if (s.usage) {
      try { await db.query("UPDATE tgbot.complaints SET product_usage = $1 WHERE id = $2", [s.usage, id]); }
      catch (e) { console.warn("[ПРЕТЕНЗИЯ usage]", e.message); }
    }
    if (s.dishForm) {
      try { await db.query("UPDATE tgbot.complaints SET dish_form = $1 WHERE id = $2", [s.dishForm, id]); }
      catch (e) { console.warn("[ПРЕТЕНЗИЯ dish]", e.message); }
    }
    for (const m of s.media) {
      await db.query("INSERT INTO tgbot.complaint_files (complaint_id, kind, file_ref, tg_file_id) VALUES ($1,$2,$3,$4)", [id, m.kind, m.fileRef, m.tgFileId]);
    }
    await db.logEvent("complaint_created", chatId, { id, type: s.type.code, sd_id: s.point.sd_id });
    sessions.delete(chatId);
    await bot.sendMessage(chatId, t(lang, "thanks", id), H.mainMenu(lang));
    // Уведомляем агента точки с кнопкой «Принял в работу». Нет агента — уйдёт РОПу/админу.
    const note = `📩 Новая претензия №${id}\nКлиент: {name}\nТовар: ${s.product.name}\nТип: ${s.type.label}`
      + (s.client_comment ? `\nКомментарий: ${s.client_comment}` : "");
    H.notifyAgentReact(s.point.sd_id, note, id).catch((e) => console.warn("[ПРЕТЕНЗИЯ notify]", e.message));
  } catch (e) {
    console.error("[ПРЕТЕНЗИЯ save]", e.message);
    sessions.delete(chatId);
    await bot.sendMessage(chatId, t(lang, "save_err"), H.mainMenu(lang));
  }
}

// ---------- Реакция агента ----------
async function agentResolveKb(id, lang) {
  const res = await getResolutions();
  const rows = res.map((r) => [{ text: r.label_ru, callback_data: `cmpl:ares:${id}:${r.code}` }]);
  rows.push([{ text: t(lang, "btn_ag_comment"), callback_data: `cmpl:acmt:${id}` }]);
  return { inline_keyboard: rows };
}

// «Принял в работу» → статус agent_reacted, показываем выбор решения.
async function agentReact(q, id, lang) {
  const chatId = q.message.chat.id;
  const c = (await db.query("SELECT status FROM tgbot.complaints WHERE id=$1", [id])).rows[0];
  await bot.answerCallbackQuery(q.id);
  if (!c) { await bot.sendMessage(chatId, "Претензия не найдена."); return true; }
  if (c.status !== "new") { await bot.sendMessage(chatId, t(lang, "react_already")); return true; }
  await db.query("UPDATE tgbot.complaints SET status='agent_reacted', agent_reacted_at=now(), agent_tg_id=$1, updated_at=now() WHERE id=$2 AND status='new'", [q.from.id, id]);
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
  await bot.sendMessage(chatId, t(lang, "react_taken", id), { reply_markup: await agentResolveKb(id, lang) });
  return true;
}

// Агент выбрал решение: простую закрываем, критическую эскалируем Шоху/РОПу.
async function agentResolve(q, id, code, lang) {
  const chatId = q.message.chat.id;
  const c = (await db.query("SELECT complaint_type, point_name, firm_name FROM tgbot.complaints WHERE id=$1", [id])).rows[0];
  await bot.answerCallbackQuery(q.id);
  if (!c) { await bot.sendMessage(chatId, "Претензия не найдена."); return true; }
  await db.query("UPDATE tgbot.complaints SET agent_resolution=$1, updated_at=now() WHERE id=$2", [code, id]);
  const resLabel = ((await getResolutions()).find((r) => r.code === code) || {}).label_ru || code;
  if (CRITICAL_TYPES.has(c.complaint_type)) {
    const point = c.point_name || c.firm_name || "";
    await H.notifyManagers(`🚨 Критическая претензия №${id}\nТочка: ${point}\nАгент принял в работу, предложил решение: ${resLabel}.\nНужен ваш разбор и закрытие в Hub.`);
    await bot.editMessageText(t(lang, "res_escalated", id), { chat_id: chatId, message_id: q.message.message_id }).catch(() => bot.sendMessage(chatId, t(lang, "res_escalated", id)));
  } else {
    await db.query("UPDATE tgbot.complaints SET status='resolved', resolved_at=now(), resolved_by=$1, updated_at=now() WHERE id=$2", ["Агент (бот)", id]);
    await bot.editMessageText(t(lang, "res_closed", id), { chat_id: chatId, message_id: q.message.message_id }).catch(() => bot.sendMessage(chatId, t(lang, "res_closed", id)));
  }
  return true;
}

async function agentAskComment(q, id, lang) {
  const chatId = q.message.chat.id;
  agentComment.set(chatId, id);
  await bot.answerCallbackQuery(q.id);
  await bot.sendMessage(chatId, t(lang, "ag_comment_ask"));
  return true;
}

// ---------- Маршрутизация из index.js ----------
// Возвращает true, если сообщение «съедено» мастером (тогда index.js не обрабатывает дальше).
async function onMessage(msg) {
  if (!msg || msg.contact) return false;
  const chatId = msg.chat.id;
  const txt = (msg.text || "").trim();
  const lang = await H.getLang(chatId);

  // Комментарий агента к претензии (агентский поток, вне клиентского мастера).
  if (agentComment.has(chatId) && txt && !txt.startsWith("/")) {
    const id = agentComment.get(chatId); agentComment.delete(chatId);
    try { await db.query("UPDATE tgbot.complaints SET agent_comment=$1, updated_at=now() WHERE id=$2", [txt.slice(0, 1000), id]); await bot.sendMessage(chatId, t(lang, "ag_comment_saved", id)); }
    catch (e) { console.warn("[ПРЕТЕНЗИЯ ag_comment]", e.message); }
    return true;
  }

  const isMenu = txt === STR.menu.ru || txt === STR.menu.uz;

  // Выход из мастера по командам или кнопкам меню заказа — пусть index.js их обработает.
  if (sessions.has(chatId) && !isMenu && (txt.startsWith("/") || EXIT_TEXTS.has(txt))) {
    sessions.delete(chatId);
    return false;
  }
  if (isMenu) { await start(chatId, msg.from.id, lang); return true; }

  const s = sessions.get(chatId);
  if (!s) return false;

  if (s.stage === "agent_point_search") {
    if (txt) {
      const found = await searchAgentPoints(s.agentCrmId, txt);
      if (!found.length) { await bot.sendMessage(chatId, t(lang, "agp_none")); return true; }
      s.points = found; s.stage = "point";
      const rows = found.map((p, i) => [{ text: p.point_name || p.firm_name || p.sd_id, callback_data: `cmpl:pt:${i}` }]);
      rows.push(cancelRow(lang));
      await bot.sendMessage(chatId, t(lang, "agp_pick"), { reply_markup: { inline_keyboard: rows } });
    }
    return true;
  }
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
    // Реакция агента — не зависит от клиентской сессии (работает по complaintId из колбэка).
    if (step === "react") return agentReact(q, arg, lang);
    if (step === "ares")  return agentResolve(q, arg, parts[3], lang);
    if (step === "acmt")  return agentAskComment(q, arg, lang);
    if (!s) { await bot.answerCallbackQuery(q.id, { text: t(lang, "expired") }); return true; }

    if (step === "pt") { await bot.answerCallbackQuery(q.id); s.point = s.points[Number(arg)]; if (!s.point) { sessions.delete(chatId); return true; } await askOrder(chatId, s, lang); return true; }
    if (step === "o")  { await bot.answerCallbackQuery(q.id); s.order = s.orders[Number(arg)]; if (!s.order) return true; await askProduct(chatId, s, lang); return true; }
    if (step === "p")  {
      await bot.answerCallbackQuery(q.id);
      const op = s.products[Number(arg)]; if (!op) return true;
      s.product = { sdId: op.product.SD_id, name: op.product.name || op.product.SD_id, qty: Number(op.quantity) || 0 };
      await gotoAfterProduct(chatId, s, lang);
      return true;
    }
    if (step === "up") { await bot.answerCallbackQuery(q.id); await askUsage(chatId, s, lang, Number(arg) || 0); return true; }
    if (step === "u")  { await bot.answerCallbackQuery(q.id); s.usage = arg; await gotoAfterUsage(chatId, s, lang); return true; }
    if (step === "uskip") { await bot.answerCallbackQuery(q.id); s.usage = null; await gotoAfterUsage(chatId, s, lang); return true; }
    if (step === "dp") { await bot.answerCallbackQuery(q.id); await askDish(chatId, s, lang, Number(arg) || 0); return true; }
    if (step === "d")  { await bot.answerCallbackQuery(q.id); s.dishForm = arg; await askType(chatId, s, lang, 0); return true; }
    if (step === "dskip") { await bot.answerCallbackQuery(q.id); s.dishForm = null; await askType(chatId, s, lang, 0); return true; }
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

module.exports = { init, onMessage, onCallback, menuText, startForAgent, isActive: (chatId) => sessions.has(chatId) };
