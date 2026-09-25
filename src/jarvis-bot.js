// jarvis-bot.js — внутренний Telegram-бот «Джарвис» (шаг 3, docs/plan-jarvis.md).
// Живёт внутри Hub: Telegram присылает сообщения на защищённый адрес (webhook),
// а раз в 5 минут Джарвис читает Trello и решает, кому пора напомнить.
//
// Что делает:
//   • вход — «Поделиться номером»; пускаем только сотрудников Персонала с учёткой ERP;
//   • упомянули (@) и нет ответа → напоминание, потом нарушение (сроки — в плитке);
//   • утренняя сводка: просрочки и упоминания в Trello + дела «Нужно внести» из ERP;
//   • срок карточки прошёл → через N рабочих дней нарушение;
//   • карточка без движения → одно напоминание;
//   • «✍️ Ответить» — ответ из Telegram ложится комментарием в карточку.
// Пока в правилах не включены напоминания — только читаем Trello и ведём журнал.
// Нарушения пишутся в jarvis_log; штрафы из них — шаг 4.

const crypto = require('crypto');
const trello = require('./trello');
const R = require('./jarvis-rules');
const { ensureJarvisSchema } = require('./jarvis-schema');

let pool = null;
const TICK_MS = 5 * 60 * 1000;
const status = { last_sync: null, last_error: null, boards: 0, cards: 0 };

// ---------- Telegram ----------
const token = () => process.env.INTERNAL_BOT_TOKEN || '';
// Секрет адреса и заголовка берём из самого токена: отдельной переменной не нужно,
// а без токена адрес не угадать.
const secret = () => crypto.createHash('sha256').update('jarvis:' + token()).digest('hex').slice(0, 32);

async function tg(method, body) {
  if (!token()) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) console.warn(`[ДЖАРВИС] Telegram ${method}: ${d.description || r.status}`);
    return d.ok ? d.result : null;
  } catch (e) { console.warn(`[ДЖАРВИС] Telegram ${method}: ${e.message}`); return null; }
}
// Файл в Telegram. Номер файла (file_id) привязан к принявшему его боту,
// поэтому фото и видео клиента Джарвис не пересылает ссылкой — отдаёт байтами
// своим токеном (фото из нашей базы, видео скачивается у клиентского бота).
async function sendFile(chatId, kind, buf, name) {
  if (!token()) return false;
  const method = kind === 'photo' ? 'sendPhoto' : kind === 'video_note' ? 'sendVideoNote' : 'sendVideo';
  const field = kind === 'photo' ? 'photo' : kind === 'video_note' ? 'video_note' : 'video';
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append(field, new Blob([buf]), name || 'file');
    const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`,
      { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) console.warn('[ДЖАРВИС] файл:', d.description || r.status);
    return !!d.ok;
  } catch (e) { console.warn('[ДЖАРВИС] файл:', e.message); return false; }
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Модель пишет разметку markdown, а Telegram её не понимает: в чате были видны
// сами звёздочки (замечание Шоха). Переводим в тот HTML, который Telegram знает.
function mdToHtml(text) {
  return esc(text)
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, (m, code) => '<pre>' + code.trim() + '</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,:;!?]|$)/g, '$1<i>$2</i>')
    .replace(/^\s*[-*]\s+/gm, '• ')                 // маркеры списка — точками
    .replace(/^\s*(#{1,6})\s*(.+)$/gm, '<b>$2</b>') // заголовки — просто жирным
    // Модель по инструкции выделяет важное тегами <b>…</b>. После esc() они
    // превращались в текст «&lt;b&gt;» и показывались в чате как теги. Возвращаем
    // обратно — но только этот короткий список, всё остальное остаётся текстом.
    .replace(/&lt;(\/?(?:b|i|u|s|code|pre))&gt;/g, '<$1>');
}

// Telegram не принимает сообщение длиннее 4096 символов: длинный ответ просто
// не доходил, а в журнале стояло «отправлено». Режем по строкам и отвечаем
// честно, дошло ли всё.
async function sendLong(chatId, html, extra = {}) {
  const LIMIT = 3800;
  if (html.length <= LIMIT) return !!(await send(chatId, html, extra));
  const chunks = [];
  let cur = '';
  for (const line of String(html).split('\n')) {
    if (cur && (cur.length + 1 + line.length) > LIMIT) { chunks.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) chunks.push(cur);
  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    const r = await send(chatId, chunks[i], i === chunks.length - 1 ? extra : {});
    if (!r) ok = false;
  }
  return ok;
}
const send = (chatId, html, extra = {}) => tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
// Кнопки внизу — частые вопросы одним нажатием. Они идут МИМО ИИ: читают базу
// напрямую, отвечают мгновенно и ничего не стоят. Решение Шоха: кликать проще,
// чем печатать, а ИИ нужен для того, что кнопкой не выразишь.
const MENU_MY = '📋 Мои карточки';
const MENU_TODO = '📌 Мои дела';
const MENU_PAY = '💰 Моя зарплата';
const MENU_SALES = '📊 Клиенты';
const menu = { reply_markup: { keyboard: [[{ text: MENU_MY }, { text: MENU_TODO }], [{ text: MENU_PAY }]], resize_keyboard: true } };
const menuBoss = { reply_markup: { keyboard: [[{ text: MENU_MY }, { text: MENU_TODO }], [{ text: MENU_PAY }, { text: MENU_SALES }]], resize_keyboard: true } };
// Кнопка «Клиенты» — только руководителю продаж и админу: остальным этот
// разрез не открыт, и в клавиатуре ему делать нечего.
const bossCache = new Map();               // chatId → { boss, at }
async function kb(chatId) {
  const c = bossCache.get(chatId);
  if (c && Date.now() - c.at < 3600000) return c.boss ? menuBoss : menu;
  let boss = false;
  try {
    boss = (await pool.query(
      `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE u.jv_chat_id = $1 AND (r.is_admin = TRUE OR r.bot_role = 'head_of_sales') LIMIT 1`, [chatId])).rows.length > 0;
  } catch (e) { boss = false; }
  bossCache.set(chatId, { boss, at: Date.now() });
  return boss ? menuBoss : menu;
}
const askContact = { reply_markup: { keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } };
// Кнопки под сообщением о карточке: ответить и открыть.
function cardButtons(cardId, url, mentionId) {
  const row = [{ text: '✍️ Ответить', callback_data: mentionId ? 'jm:' + mentionId : 'jc:' + cardId }];
  if (url) row.push({ text: 'Открыть в Trello', url });
  return { reply_markup: { inline_keyboard: [row] } };
}
// Кнопки постановки срока: нажал — Джарвис сам проставит дату в Trello.
function dueButtons(cardId, url) {
  return { reply_markup: { inline_keyboard: [
    [{ text: 'Сегодня', callback_data: `jd:${cardId}:0` }, { text: 'Завтра', callback_data: `jd:${cardId}:1` }],
    [{ text: 'Через 3 дня', callback_data: `jd:${cardId}:3` }, { text: 'Через неделю', callback_data: `jd:${cardId}:7` }],
    [{ text: '📅 Своя дата', callback_data: 'jx:' + cardId }, ...(url ? [{ text: 'Открыть в Trello', url }] : [])],
  ] } };
}

// ---------- Люди ----------
const last9 = (v) => String(v || '').replace(/\D/g, '').slice(-9);
// Кто пишет боту: учётка ERP с этим чатом + её карточка в Персонале.
async function personByChat(chatId) {
  return (await pool.query(
    `SELECT u.id AS user_id, u.full_name AS user_name, e.id AS employee_id, e.full_name, e.trello_member_id, e.trello_username
       FROM users u JOIN hr_employees e ON e.erp_user_id = u.id
      WHERE u.jv_chat_id = $1 AND u.is_active = TRUE AND e.status = 'active' LIMIT 1`, [chatId])).rows[0] || null;
}
// Сотрудники, за которыми следим: связаны с Trello, активны, есть учётка (для чата).
async function trackedPeople() {
  return (await pool.query(
    `SELECT e.id AS employee_id, e.full_name, e.trello_member_id, lower(e.trello_username) AS username, u.jv_chat_id
       FROM hr_employees e LEFT JOIN users u ON u.id = e.erp_user_id AND u.is_active = TRUE
      WHERE e.status = 'active' AND e.trello_member_id IS NOT NULL`)).rows;
}

// Ждём текст ответа: чат → карточка. В памяти: после перезапуска достаточно
// ещё раз нажать «Ответить».
const pending = new Map();

// ---------- Входящие от Telegram ----------
async function handleUpdate(u) {
  if (u.callback_query) return onCallback(u.callback_query);
  const m = u.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const chatId = m.chat.id;

  if (m.contact) return onContact(m);
  const me0 = await personByChat(chatId);
  // Голосовое: расшифровываем и дальше работаем как с обычным текстом.
  // Расшифровку всегда показываем — человек должен видеть, что его услышали.
  if ((m.voice || m.audio) && me0) {
    const rules = await loadRules();
    if (!rules.voice_enabled) return send(chatId, '🎧 Голосовые пока выключены — напишите текстом.', await kb(chatId));
    const stt = require('./stt');
    if (!stt.configured()) return send(chatId, '🎧 Распознавание речи не подключено. Скажите администратору.', await kb(chatId));
    tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    try {
      const text = await stt.voiceToText(token(), m.voice || m.audio, rules.voice_model);
      if (!text) return send(chatId, '🎧 Ничего не расслышал. Попробуйте ещё раз поближе к микрофону.', await kb(chatId));
      await send(chatId, `🎧 Услышал: «${esc(text)}»`);
      await log('voice', me0.employee_id, null, text.slice(0, 300), true, null);
      return handleUpdate({ message: { ...m, voice: undefined, audio: undefined, text } });
    } catch (e) {
      return send(chatId, '🎧 ' + esc(e.message), await kb(chatId));
    }
  }
  const me = me0;
  if (!me) {
    return send(chatId, 'Здравствуйте! Это Джарвис — внутренний помощник Novagreen на основе ИИ, программа, а не человек.\n'
      + 'Чтобы я вас узнал, нажмите «📱 Поделиться номером» внизу.\n\n'
      + 'Salom! Men Jarvis — Novagreen ichki yordamchi dasturiman. Meni tanishim uchun pastdagi tugmani bosing.', askContact);
  }
  const text = String(m.text || '').trim();
  if (text === '/cancel') { pending.delete(chatId); return send(chatId, 'Отменено.', await kb(chatId)); }
  const p = pending.get(chatId);
  if (p && text && !text.startsWith('/') && ![MENU_MY, MENU_TODO, MENU_PAY, MENU_SALES].includes(text)) {
    if (Date.now() > p.until) { pending.delete(chatId); return send(chatId, 'Время вышло — нажмите кнопку ещё раз.', await kb(chatId)); }
    if (p.kind === 'cnote') {
      pending.delete(chatId);
      const r = await require('./jarvis-complaints').addNote(chatId, p.complaintId, text);
      if (r.error) return send(chatId, esc(r.error), await kb(chatId));
      await log('complaint_note', me.employee_id, null, `Претензия №${p.complaintId}: ${text.slice(0, 200)}`, true, null);
      return send(chatId, `✍️ Записал причину по претензии №${p.complaintId}. Спасибо — это то, что потом объясняет цифры.`,
        await kb(chatId));
    }
    if (p.kind === 'due') {
      const due = R.parseDueDate(text, Date.now(), await loadRules());
      if (!due) return send(chatId, 'Не понял дату. Напишите так: 25.09 или 25.09.2026, либо «завтра». /cancel — отмена');
      pending.delete(chatId);
      return applyDue(chatId, me, p, due);
    }
    pending.delete(chatId);
    return postReply(chatId, me, p, text);
  }
  if (text === MENU_MY || text === '/my' || /^мои карточки$/i.test(text)) return myCards(chatId, me);
  if (text === MENU_TODO) return myTodos(chatId, me);
  if (text === MENU_PAY) return mySalary(chatId, me);
  if (/^(\/forget|забудь|начнём заново|boshqadan)$/i.test(text)) {
    await pool.query('DELETE FROM jarvis_chat WHERE chat_id = $1', [chatId]);
    return send(chatId, '🧹 Забыл наш разговор. Начнём с чистого листа.', await kb(chatId));
  }
  if (text === MENU_SALES || /^(клиенты|сводка по клиентам)$/i.test(text)) return salesNow(chatId, me);
  if (/^(\/help|\/start|помощь|что (ты )?(умеешь|можешь)|чем поможешь|nima qila olasan|yordam)\??$/i.test(text)) return sendHelp(chatId, me);
  if (text) {
    const rules = await loadRules();
    if (rules.ai_enabled) return aiAnswer(chatId, me, text, rules);
  }
  return send(chatId, `${esc(me.full_name)}, спросите словами: «мои дела», «мои карточки», «остатки склада».`, await kb(chatId));
}

// «Что ты умеешь» — ответ собираем сами, а не у модели: он одинаковый каждый
// раз, с иконками, и не стоит денег. Список — ровно то, что открыто этой роли.
const TOOL_HELP = {
  moi_dela: ['📋', 'твои дела «Нужно внести» в ERP — что не внесено и куда'],
  moi_kartochki_trello: ['🗂', 'твои карточки Trello: упоминания без ответа и просрочки'],
  moi_narusheniya: ['⚠️', 'что я тебе записал: напоминания и нарушения'],
  moy_tabel: ['🕘', 'твой табель за месяц: дни, часы, отпуска'],
  moya_zarplata: ['💵', 'твоя зарплата за месяц — только твоя, чужие не показываю'],
  ostatki_sklada: ['📦', 'остатки сырья и упаковки на складе'],
  zayavki_zakupa: ['🛒', 'заявки в Закупе: что заказано, что принято'],
  dolg_postavshchikam: ['🤝', 'сколько мы должны поставщикам'],
  ostatki_deneg: ['🏦', 'остатки денег по кассам и счетам'],
  pribyl_za_mesyats: ['💰', 'итоги месяца: выручка, себестоимость, прибыль'],
  prodazhi_za_mesyats: ['📈', 'продажи за месяц и топ товаров'],
  prodazhi_po_tovaram: ['🥬', 'продажи по товарам за любой период («сколько айсберга за прошлую неделю»)'],
  prodazhi_po_klientam: ['👥', 'продажи по клиентам за период'],
  dinamika_klienta: ['📊', 'динамика клиента по неделям — растёт или падает'],
  pretenzii: ['📣', 'претензии за период: сколько, по каким товарам'],
};
async function sendHelp(chatId, me) {
  const user = await erpUser(me.user_id);
  const tools = await require('./ai-tools').toolsFor(user);
  const lines = tools.map((t) => TOOL_HELP[t.name]).filter(Boolean).map(([i, s]) => `${i} ${esc(s)}`);
  return send(chatId, '🤖 Я Джарвис — помощник Novagreen на основе ИИ. Отвечаю по данным ERP, '
    + 'в пределах того, что открыто твоей роли.\n\n<b>Спроси словами, например:</b>\n' + lines.join('\n')
    + '\n\n💬 Пиши как удобно, по-русски или o‘zbekcha. Частое — кнопками внизу.', await kb(chatId));
}

// Кнопка «📊 Клиенты» — та же сводка, что приходит раз в три дня, но по
// требованию. Есть только у админа и руководителя продаж: остальным этот
// разрез не открыт. Каждый блок — отдельным сообщением, чтобы переслать.
async function salesNow(chatId, me) {
  const user = await erpUser(me.user_id);
  const allowed = user.isAdmin || (await pool.query(
    `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.bot_role = 'head_of_sales' LIMIT 1`, [me.user_id])).rows.length > 0;
  if (!allowed) return send(chatId, 'Этот разрез открыт руководителю продаж и администратору.', await kb(chatId));
  tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const rules = await loadRules();
  const groups = await require('./jarvis-insights').clientsByManager(pool, rules);
  if (!groups.length) return send(chatId, '👍 Клиенты не проседают: за две недели заметных падений нет.', await kb(chatId));
  const total = groups.reduce((s, g) => s + g.lines.length, 0);
  await send(chatId, `📊 <b>Клиенты, которые притихли</b> — ${total} шт.\nНиже по менеджерам, можно пересылать.`, await kb(chatId));
  for (const g of groups) {
    await send(chatId, `👤 <b>${esc(g.manager)}</b>\n${g.lines.map((l) => esc(l)).join('\n')}`);
  }
  return log('sales_digest', me.employee_id, null, `По кнопке: менеджеров ${groups.length}, клиентов ${total}`, true, null);
}

// Кнопки: те же данные, что у ИИ-инструментов, но без модели — быстро и бесплатно.
const toolRun = async (name, me, args = {}) => {
  const t = require('./ai-tools').TOOLS.find((x) => x.name === name);
  const user = await erpUser(me.user_id);
  return t.run(args, { user, employee_id: me.employee_id, full_name: me.full_name });
};
async function myTodos(chatId, me) {
  const out = await toolRun('moi_dela', me);
  if (!Array.isArray(out)) return send(chatId, '👍 Дел нет — всё внесено.', await kb(chatId));
  const lines = out.map((i) => `• <b>${esc(i.дело)}</b>\n  ${esc(i.подробно)}`);
  return send(chatId, '<b>Нужно внести:</b>\n' + lines.join('\n'), await kb(chatId));
}
async function mySalary(chatId, me) {
  const r = await toolRun('moya_zarplata', me);
  if (r.итог) return send(chatId, esc(r.итог), await kb(chatId));
  const n = (v) => Number(v || 0).toLocaleString('ru-RU');
  return send(chatId, `<b>Зарплата за ${esc(r.месяц)}</b>\nНачислено: ${n(r.начислено)}\nУдержано: ${n(r.удержано)}`
    + (r.штрафы ? `\nШтрафы: ${n(r.штрафы)}` : '') + `\nВыплачено: ${n(r.выплачено)}`, await kb(chatId));
}

// ---------- Вопрос словами (ИИ) ----------
// Модель не считает и не помнит цифры — она вызывает наши инструменты
// (src/ai-tools.js), а те читают базу с правами роли человека. Чего роль не
// видит в ERP, того нет и в ответе бота.
const SYSTEM = [
  'Ты Джарвис — помощник сотрудников компании Novagreen Foods (Ташкент, производство свежей зелени и салатов).',
  'Отвечай коротко и по-человечески, на языке вопроса: по-русски на русский, o‘zbekcha o‘zbek tiliga.',
  'ГЛАВНОЕ: все цифры бери только из инструментов. Никогда не придумывай и не оценивай числа сам.',
  'Нет инструмента или данных — так и скажи: «таких данных у меня нет».',
  // Живой разговор: «ты тут?», «вернулся?», «спасибо» — это не запрос данных.
  // Переспрашивать в ответ на них — как скрепка из старого Office (замечание Шоха).
  'На короткие человеческие реплики («привет», «ты тут», «вернулся», «спасибо», «ало») отвечай коротко',
  'и по-человечески — одной фразой, с лёгкой иронией. НИКОГДА не переспрашивай про данные в ответ на них.',
  'Переспрашивай только тогда, когда человек явно просит цифры, но не сказал какие или за какой период.',
  'И даже тогда не спрашивай пусто: предложи самый вероятный вариант — «показать за сентябрь?».',
  'Историю разговора используй как контекст, но не притягивай старую тему к новой реплике.',
  'Не пересказывай, каким инструментом воспользовался. Суммы — в сумах, разряды через пробел.',
  'Ты видишь только то, что человеку открыто по его роли в ERP. Чужие зарплаты и закрытые данные не обсуждай.',
  'Спросят, кто ты — отвечай честно: Джарвис, программа-помощник Novagreen на основе ИИ, не человек.',
  'Язык держи по последнему сообщению человека: перешёл на узбекский — переходи и ты, вернулся на русский — возвращайся.',
  'Названия товаров и имена людей пиши так, как они записаны в системе, не переводи их.',
  'Пиши для Telegram: короткие строки, пункты списка начинай с подходящего эмодзи (📦 склад, 💰 деньги,',
  '📋 задачи, 📈 продажи, 👥 клиенты, ⚠️ проблема), между смысловыми блоками — пустая строка.',
  'Таблицы в чате не рисуй — только строки вида «Название — 1 200 шт, 3 400 000 сум».',
  'Никакой разметки звёздочками и решётками: выделяй важное <b>вот так</b>, если нужно.',
  // Характер (решение Шоха, 23.09 и 25.09.2026). Первая редакция запрещала
  // иронию везде, где «деньги, продажи, претензии» — то есть ровно там, где
  // Джарвиса и спрашивают, и он выходил сухим. Различаем не ТЕМУ, а АДРЕСАТА
  // шутки: над ситуацией и цифрами — можно и нужно, над человеком — никогда.
  'Характер: живой, с иронией и самоиронией. Ты умный ехидный коллега, а не справочник.',
  'Сухие отчёты никто не читает: цифры давай точные, а подачу — человеческую.',
  'ПРАВИЛО ОТВЕТА С ЦИФРАМИ: сначала факты (строками, с эмодзи), потом ОДНА строка от себя —',
  'короткий вывод или подначка по ситуации. Без неё ответ выглядит как выгрузка из базы.',
  'Ирония — над ситуацией, цифрами, рынком, погодой, собой. НИКОГДА над человеком,',
  'его работой, зарплатой или ошибками: «Саид опять проспал» — нельзя, «Саид, тут цифры просят объяснений» — можно.',
  'Иногда уместен эмодзи — один-два, не гирлянда. Шаблонных шуток-паразитов («как говорится», «шучу») не надо.',
  'Болтовню и вопросы не по делу не отшивай: пошути и мягко переведи к тому, чем полезен.',
  'Примеры тона в болтовне. «Привет, детка» → «Я вообще-то корпоративный помощник, а не детка 🙂 Чем помочь?».',
  '«Посчитай звёзды на небе» → «Где-то 100–400 миллиардов только в нашей галактике. Но считать я лучше умею ваши продажи и остатки — спрашивайте».',
  '«Ты живой?» → «Программа. Зато не устаю и не ухожу в отпуск».',
  'Примеры тона в работе. Продажи выросли → «📈 Айсберг: 1 576 кг за неделю, +32%. Неделя удалась — теперь бы удержать планку».',
  'Клиент просел → «📉 Mari Wellness: 2,1 млн против 3,4 млн неделей раньше. Минус 38% — это уже не колебание, это разговор.',
  'Стоит позвонить и выяснить, что у них поменялось».',
  'Пусто по вопросу → «Тишина. Либо никто ничего не покупал, либо выгрузка ещё не доехала — второе вероятнее».',
  'СЕРЬЁЗНО, БЕЗ ШУТОК: личные деньги человека (его зарплата, его штраф, его табель), претензия конкретного клиента,',
  'чья-то ошибка или конфликт, плохие новости о здоровье и увольнениях — там спокойно и по делу, без иронии.',
  // Память: разговор помним неделю, но цифры в нём — вчерашние.
  'Ты видишь переписку с этим человеком за последние дни — держи нить разговора,',
  'короткое «ну давай» или «а по второму» понимай как продолжение предыдущего.',
  'ВАЖНО: цифры из прошлых сообщений устарели. Спрашивают снова — бери свежие инструментом, а не из истории.',
  // Память компании — общий мозг: как мы работаем, а не сколько мы продали.
  'Ниже дано то, что компания просила помнить: договорённости и особенности работы. Учитывай это в ответах.',
  'Просят «запомни», объясняют особенность или принимают решение — вызывай инструмент zapomnit.',
  'Цифры и суммы в память НЕ записывай: они устаревают, их всегда берут из базы инструментами.',
  // Интернет (решение Шоха, 23.09.2026): справка — да, источник цифр компании — нет.
  'Если у тебя есть поиск в интернете — пользуйся им, когда спрашивают про рынок, конкурентов, тренды,',
  'чужой опыт или просят оценить идею. Это помогает руководителю проверить мысль, а не гадать.',
  'НО: найденное в интернете — это СПРАВКА. Помечай такие места «🌐 из интернета» и обязательно давай ссылку.',
  'Никогда не смешивай найденное с цифрами компании в одном выводе и не подставляй чужие числа вместо наших.',
  'Нет ссылки — не утверждай. Противоречит нашим данным — скажи об этом прямо, наши данные главнее.',
].join(' ');

// Память разговора: последние сообщения за N дней. Берём с конца и не больше
// разумного объёма — иначе каждый вопрос тащил бы неделю переписки и стоил бы
// втрое дороже. Цифры из старых сообщений считаются устаревшими: если спросят
// снова, модель обязана взять свежие инструментом (об этом сказано в SYSTEM).
const MEMORY_MSGS = 16;
const MEMORY_CHARS = 6000;
async function recallChat(chatId, rules) {
  if (!rules.memory_days) return [];
  const rows = (await pool.query(
    `SELECT role, text FROM jarvis_chat
      WHERE chat_id = $1 AND created_at > now() - ($2 || ' days')::interval
      ORDER BY created_at DESC LIMIT $3`, [chatId, String(rules.memory_days), MEMORY_MSGS])).rows;
  const out = [];
  let size = 0;
  for (const r of rows) {                       // идём от свежих к старым, пока влезает
    size += r.text.length;
    if (size > MEMORY_CHARS) break;
    out.unshift({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.text });
  }
  return out;
}
async function rememberChat(chatId, employeeId, role, text) {
  await pool.query('INSERT INTO jarvis_chat (chat_id, employee_id, role, text) VALUES ($1,$2,$3,$4)',
    [chatId, employeeId, role, String(text).slice(0, 4000)]);
  // Чистим раз в сутки-двое: таблица не должна расти бесконечно.
  if (Math.random() < 0.02) await pool.query("DELETE FROM jarvis_chat WHERE created_at < now() - interval '14 days'");
}

async function aiAnswer(chatId, me, question, rules) {
  const ai = require('./ai');
  const provider = rules.ai_provider === 'openai' ? 'openai' : 'claude';
  if (!ai.hasKey(provider)) {
    return send(chatId, 'ИИ включён, но ключ не задан в Railway. Скажите администратору.');
  }
  tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const user = await erpUser(me.user_id);
  const ctx = { user, employee_id: me.employee_id, full_name: me.full_name };
  const tools = await require('./ai-tools').toolsFor(user);
  const runTool = async (name, args) => {
    const t = tools.find((x) => x.name === name);
    if (!t) return { ошибка: 'Нет такого инструмента или нет прав' };
    try { return await t.run(args || {}, ctx); }
    catch (e) { console.warn('[ДЖАРВИС] инструмент ' + name + ':', e.message); return { ошибка: 'Не удалось получить данные' }; }
  };
  try {
    const started = Date.now();
    const out = await ai.ask(provider, {
      model: rules.ai_model,
      system: SYSTEM + ` Сегодня ${R.localDate(Date.now())}. Спрашивает: ${me.full_name}.

`
        + await require('./ai-tools').memoryBrief(),
      messages: [...(await recallChat(chatId, rules)), { role: 'user', content: question.slice(0, 2000) }],
      tools, runTool,
      web: rules.web_enabled && provider === 'claude',
      onStep: () => tg('sendChatAction', { chat_id: chatId, action: 'typing' }),
    });
    const text = out.text || 'Не понял вопрос. Спросите иначе.';
    // В журнал пишем, дошёл ли ответ на самом деле. Раньше там всегда стояло
    // «отправлено», даже когда Telegram отвечал ошибкой.
    const ok = await sendLong(chatId, mdToHtml(text), await kb(chatId));
    // Запоминаем разговор, чтобы следующее «ну давай» было понятно.
    if (rules.memory_days) {
      await rememberChat(chatId, me.employee_id, 'user', question);
      await rememberChat(chatId, me.employee_id, 'assistant', text);
    }
    await log('ai', me.employee_id, null,
      `${question.slice(0, 200)} → ${text.slice(0, 300)} [${provider}, ${out.used.join(', ') || 'без инструментов'}, ${Math.round((Date.now() - started) / 100) / 10} с]`,
      ok, null);
  } catch (e) {
    await send(chatId, 'Не получилось ответить: ' + esc(e.message));
    await log('ai', me.employee_id, null, `${question.slice(0, 200)} → ошибка: ${e.message}`, false, null);
  }
}

// Права человека в ERP — как у него же на сайте (роли, админ, финансы).
async function erpUser(userId) {
  const r = (await pool.query(
    `SELECT u.id, BOOL_OR(COALESCE(ro.is_admin, FALSE)) AS is_admin, BOOL_OR(COALESCE(ro.is_finance, FALSE)) AS is_finance
       FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles ro ON ro.id = ur.role_id
      WHERE u.id = $1 GROUP BY u.id`, [userId])).rows[0];
  return { id: userId, isAdmin: !!(r && r.is_admin), isFinance: !!(r && r.is_finance) };
}

async function onContact(m) {
  const chatId = m.chat.id;
  // Только свой номер: чужой контакт не даёт войти под чужим именем.
  if (!m.contact.user_id || m.contact.user_id !== m.from.id) {
    return send(chatId, 'Нужен ваш собственный номер — нажмите кнопку «📱 Поделиться номером».', askContact);
  }
  const phone = last9(m.contact.phone_number);
  const rows = phone.length === 9 ? (await pool.query(
    `SELECT u.id, e.full_name FROM users u JOIN hr_employees e ON e.erp_user_id = u.id
      WHERE u.is_active = TRUE AND e.status = 'active' AND right(regexp_replace(COALESCE(u.tg_phone,''), '\\D', '', 'g'), 9) = $1`,
    [phone])).rows : [];
  if (rows.length !== 1) {
    console.warn(`[ДЖАРВИС] вход отклонён: номер …${phone.slice(-4)} ${rows.length ? 'у нескольких' : 'не найден'}`);
    return send(chatId, 'Не нашёл вас среди сотрудников. Попросите администратора проверить телефон '
      + 'в вашей карточке в Персонале (Персонал → сотрудник → Телефон).');
  }
  await pool.query('UPDATE users SET jv_chat_id = NULL WHERE jv_chat_id = $1 AND id <> $2', [chatId, rows[0].id]);
  await pool.query('UPDATE users SET jv_chat_id = $1 WHERE id = $2', [chatId, rows[0].id]);
  return send(chatId, `Готово, ${esc(rows[0].full_name)}!\n\n`
    + '🤖 Я Джарвис — программа-помощник Novagreen на основе ИИ, не человек. '
    + 'Отвечаю по данным ERP и только в пределах ваших прав.\n'
    + 'Напоминаю про карточки Trello и отвечаю на вопросы обычными словами: «мои дела», «остатки склада», «мои карточки».\n\n'
    + '🤖 Men Jarvisman — Novagreen yordamchi dasturi, odam emasman. '
    + 'Savollarga oddiy so‘zlar bilan javob beraman. O‘zbekcha yozing — o‘zbekcha javob beraman.', await kb(chatId));
}

async function onCallback(cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  tg('answerCallbackQuery', { callback_query_id: cq.id });
  if (!chatId) return;
  const me = await personByChat(chatId);
  if (!me) return send(chatId, 'Сначала нажмите «📱 Поделиться номером».', askContact);
  const data = String(cq.data || '');
  let target = null;
  // Претензии: решение руководителя звена и причина (src/jarvis-complaints.js).
  if (data.startsWith('cr:') || data.startsWith('cn:')) {
    const cx = require('./jarvis-complaints');
    const [, idStr, code] = data.split(':');
    const id = parseInt(idStr, 10) || 0;
    if (data.startsWith('cn:')) {
      const who = await cx.ownerByChat(id, chatId);
      if (!who) return send(chatId, 'Причину по претензии пишет руководитель звена.');
      pending.set(chatId, { kind: 'cnote', complaintId: id, until: Date.now() + 30 * 60 * 1000 });
      return send(chatId, `Напишите одним сообщением, в чём причина по претензии №${id} и что сделали. `
        + 'Текст ляжет в карточку претензии в ERP.\n/cancel — отмена', { reply_markup: { force_reply: true } });
    }
    const r = await cx.resolve(chatId, id, code);
    if (r.error) return send(chatId, esc(r.error));
    await log('complaint_resolved', me.employee_id, null, `Претензия №${id}: ${r.label}`, true, `cres:${id}`);
    return send(chatId, `✅ Претензия №${id}: ваше решение — ${esc(r.label)}. Записано в ERP, агенту передано.`);
  }
  if (data.startsWith('jm:')) {
    const mt = (await pool.query('SELECT id, card_id, card_name, card_url FROM jarvis_mentions WHERE id = $1 AND employee_id = $2',
      [parseInt(data.slice(3), 10) || 0, me.employee_id])).rows[0];
    if (mt) target = { cardId: mt.card_id, cardName: mt.card_name, cardUrl: mt.card_url, mentionId: mt.id };
  } else if (data.startsWith('jc:')) {
    const c = await cardInWorkspace(data.slice(3));
    if (c) target = { cardId: c.id, cardName: c.name, cardUrl: c.shortUrl };
  } else if (data.startsWith('jd:') || data.startsWith('jx:')) {
    // Срок: кнопкой на N дней или своей датой.
    const [, cardId, days] = data.split(':');
    const c = await cardInWorkspace(cardId);
    if (!c) return send(chatId, 'Эта карточка не найдена или больше не в рабочем пространстве.');
    const t = { cardId: c.id, cardName: c.name, cardUrl: c.shortUrl };
    if (data.startsWith('jx:')) {
      pending.set(chatId, { ...t, kind: 'due', until: Date.now() + 30 * 60 * 1000 });
      return send(chatId, `Напишите дату для карточки «${esc(c.name)}»: например 25.09 или 25.09.2026.\n/cancel — отмена`,
        { reply_markup: { force_reply: true } });
    }
    return applyDue(chatId, me, t, R.dueInDays(Number(days) || 0, Date.now(), await loadRules()));
  }
  if (!target) return send(chatId, 'Эта карточка не найдена или больше не в рабочем пространстве.');
  pending.set(chatId, { ...target, until: Date.now() + 30 * 60 * 1000 });
  return send(chatId, `Напишите ответ одним сообщением — опубликую его комментарием в карточке «${esc(target.cardName)}».\n/cancel — отмена`,
    { reply_markup: { force_reply: true } });
}

// Карточка — только из контролируемого пространства (не даём писать в чужие доски).
async function cardInWorkspace(cardId) {
  if (!/^[a-f0-9]{24}$/i.test(cardId)) return null;
  const rules = await loadRules();
  if (!rules.workspace_id) return null;
  try {
    const c = await trello.card(cardId);
    if (!c || c.closed) return null;
    const boards = await trello.boards(rules.workspace_id);
    return boards.some((b) => b.id === c.idBoard) ? c : null;
  } catch (e) { return null; }
}

async function postReply(chatId, me, p, text) {
  // Перед самой записью проверяем ещё раз. Между нажатием кнопки и отправкой
  // текста проходит до получаса: карточку могли закрыть, перенести на чужую
  // доску или убрать из пространства — писать в неё уже нельзя.
  if (!await cardInWorkspace(p.cardId)) {
    return send(chatId, 'Эта карточка больше не в рабочем пространстве — ответ не опубликован.', await kb(chatId));
  }
  try {
    await trello.addComment(p.cardId, me.full_name + R.VIA + text.slice(0, 3000));
  } catch (e) {
    return send(chatId, 'Не получилось опубликовать в Trello: ' + esc(e.message) + '\nПопробуйте ещё раз чуть позже.');
  }
  // Ответ закрывает все его упоминания в этой карточке.
  await pool.query(
    `UPDATE jarvis_mentions SET answered_at = now(), answered_via = 'telegram'
      WHERE card_id = $1 AND employee_id = $2 AND answered_at IS NULL`, [p.cardId, me.employee_id]);
  await log('reply', me.employee_id, { id: p.cardId, name: p.cardName, url: p.cardUrl }, text.slice(0, 500), true, null);
  return send(chatId, `✅ Опубликовано в карточке «${esc(p.cardName)}».`, cardButtons(p.cardId, p.cardUrl));
}

// Срок поставлен из бота — сразу в Trello и в журнал.
async function applyDue(chatId, me, target, dueIso) {
  // Как и с ответом: дату человек вводит отдельным шагом, и к этому моменту
  // карточка могла уехать из пространства. Проверяем перед записью.
  if (!await cardInWorkspace(target.cardId)) {
    return send(chatId, 'Эта карточка больше не в рабочем пространстве — срок не поставлен.', await kb(chatId));
  }
  try { await trello.setDue(target.cardId, dueIso); }
  catch (e) { return send(chatId, 'Не получилось поставить срок в Trello: ' + esc(e.message)); }
  await pool.query(
    `INSERT INTO jarvis_cards (card_id, name, url, due, no_due_since, updated_at)
     VALUES ($1,$2,$3,$4,NULL,now())
     ON CONFLICT (card_id) DO UPDATE SET due = $4, no_due_since = NULL, updated_at = now()`,
    [target.cardId, target.cardName, target.cardUrl, dueIso]);
  await log('due_set', me.employee_id, { id: target.cardId, name: target.cardName, url: target.cardUrl },
    'Срок ' + dateRu(dueIso), true, null);
  return send(chatId, `📅 Срок карточки «${esc(target.cardName)}» — ${dateRu(dueIso)}. Напомню, если подойдёт и не будет сделано.`, await kb(chatId));
}

// «Мои карточки»: что ждёт ответа и что просрочено — из последнего чтения Trello.
async function myCards(chatId, me) {
  if (!me.trello_member_id) return send(chatId, 'Ваш Trello ещё не сопоставлен. Попросите администратора: плитка «Джарвис» → «Люди и Trello».', await kb(chatId));
  const open = (await pool.query(
    `SELECT id, card_id, card_name, card_url, author_name, created_at FROM jarvis_mentions
      WHERE employee_id = $1 AND answered_at IS NULL ORDER BY created_at LIMIT 10`, [me.employee_id])).rows;
  const scan = await scanCached();
  const now = Date.now();
  const overdue = scan ? scan.cards.filter((c) => c.idMembers.includes(me.trello_member_id) && isOverdue(c, scan, now)) : [];
  if (!open.length && !overdue.length) return send(chatId, '👍 Всё чисто: упоминаний без ответа и просроченных карточек нет.', await kb(chatId));
  if (open.length) {
    await send(chatId, `<b>Ждут вашего ответа (${open.length}):</b>`);
    for (const m of open) await send(chatId, `💬 «${esc(m.card_name)}» — упомянул(а) ${esc(m.author_name)}`, cardButtons(m.card_id, m.card_url, m.id));
  }
  if (overdue.length) {
    await send(chatId, `<b>Просрочены (${overdue.length}):</b>`);
    for (const c of overdue.slice(0, 10)) await send(chatId, `⏰ «${esc(c.name)}» — срок был ${dateRu(c.due)}`, cardButtons(c.id, c.shortUrl));
  }
}

// ---------- Trello: чтение ----------
async function loadRules() {
  const r = await pool.query("SELECT value FROM settings WHERE key = 'jarvis_rules'");
  let raw = {};
  try { raw = JSON.parse((r.rows[0] && r.rows[0].value) || '{}'); } catch (e) { raw = {}; }
  return R.normalizeRules(raw);
}
const getSetting = async (k) => ((await pool.query('SELECT value FROM settings WHERE key = $1', [k])).rows[0] || {}).value || null;
const setSetting = (k, v) => pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, v]);
const dateRu = (v) => {
  const ms = typeof v === 'number' ? v : Date.parse(v);
  const d = new Date(ms + 5 * 3600000).toISOString();
  return `${d.slice(8, 10)}.${d.slice(5, 7)}`;
};

// Карточки и колонки всех досок пространства (для просрочек и «без движения»).
let _scan = null;
async function scanWorkspace(rules) {
  const boards = await trello.boards(rules.workspace_id);
  const cards = [], listName = new Map(), boardName = new Map();
  for (const b of boards) {
    boardName.set(b.id, b.name);
    for (const l of await trello.lists(b.id)) listName.set(l.id, l.name);
    for (const c of await trello.cards(b.id)) cards.push(c);
  }
  _scan = { at: Date.now(), boards, cards, listName, boardName, doneExtra: rules.done_lists || [] };
  return _scan;
}
async function scanCached() {
  if (_scan && Date.now() - _scan.at < 2 * 60 * 1000) return _scan;
  const rules = await loadRules();
  if (!rules.workspace_id || !trello.configured()) return null;
  try { return await scanWorkspace(rules); } catch (e) { return _scan; }
}
const isDone = (c, scan) => c.dueComplete || R.isDoneList(scan.listName.get(c.idList), scan.doneExtra);
const isOverdue = (c, scan, now) => c.due && !isDone(c, scan) && Date.parse(c.due) < now;

// Новые комментарии → упоминания и ответы. Каждый комментарий по порядку:
// сначала он отвечает на упоминания автора в этой карточке, потом сам кого-то упоминает.
async function syncComments(rules, scan, people) {
  const saved = (await getSetting('jarvis_sync_since')) || new Date(Date.now() - 7 * 86400000).toISOString();
  // Раз в час перечитываем всю недавнюю переписку заново, а не только новое.
  // Правила «чей ход» мы уточняем по ходу дела, и упоминания, попавшие в базу
  // до правки, иначе висели бы вечно: старые комментарии второй раз уже не
  // читаются. Повторное чтение безопасно — записи идемпотентны.
  const deepAt = await getSetting('jarvis_sync_deep');
  const deep = !deepAt || Date.now() - Date.parse(deepAt) > 3600000;
  const since = deep ? new Date(Date.now() - rules.mention_stale_days * 86400000).toISOString() : saved;
  const actions = [];
  for (const b of scan.boards) actions.push(...await trello.comments(b.id, since));
  actions.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const byUser = new Map(people.filter((p) => p.username).map((p) => [p.username, p]));
  const byName = new Map(people.map((p) => [p.full_name, p]));
  let maxDate = saved;
  for (const a of actions) {
    if (a.date > maxDate) maxDate = a.date;
    const d = a.data || {}, card = d.card || {};
    if (!card.id) continue;
    const via = R.viaJarvis(d.text);
    // Ответ из Telegram уже учтён при отправке; автор — не владелец токена, а подписанный.
    const author = via ? byName.get(via.name) : people.find((p) => p.trello_member_id === a.idMemberCreator);
    const authorMember = author ? author.trello_member_id : a.idMemberCreator;
    if (!via) {
      await pool.query(
        `UPDATE jarvis_mentions SET answered_at = $3, answered_via = 'trello'
          WHERE card_id = $1 AND member_id = $2 AND answered_at IS NULL AND created_at < $3`,
        [card.id, a.idMemberCreator, a.date]);
    }
    // «Принято», «hop, tushunarli» — это подтверждение, а не задача упомянутому.
    // Мяч остаётся у того, кто принял: с него спросим срок (см. dueControl).
    if (R.isAck(via ? via.text : d.text)) {
      await pool.query(
        "UPDATE jarvis_mentions SET answered_at = created_at, answered_via = 'ack' WHERE action_id = $1 AND answered_at IS NULL",
        [a.id]);
      if (author && author.employee_id) {
        await pool.query(
          `INSERT INTO jarvis_cards (card_id, name, url, accepted_by, accepted_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,now())
           ON CONFLICT (card_id) DO UPDATE SET accepted_by = $4, accepted_at = $5, updated_at = now()`,
          [card.id, card.name || '', card.shortLink ? 'https://trello.com/c/' + card.shortLink : null,
            author.employee_id, a.date]);
      }
      continue;
    }
    for (const u of R.parseMentions(via ? via.text : d.text)) {
      const p = byUser.get(u);
      if (!p || p.trello_member_id === authorMember) continue;
      // Разговор ушёл дальше: в карточке попросили уже другого человека —
      // значит, старое упоминание больше никого не ждёт (замечание Шоха:
      // «Абдушукур написал Угилой, почему это снова у меня?»).
      await pool.query(
        `UPDATE jarvis_mentions SET answered_at = $3, answered_via = 'moved'
          WHERE card_id = $1 AND answered_at IS NULL AND created_at < $3 AND employee_id <> $2`,
        [card.id, p.employee_id, a.date]);
      await pool.query(
        `INSERT INTO jarvis_mentions (action_id, member_id, employee_id, card_id, card_name, card_url, board_name,
           author_member_id, author_name, text, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (action_id, member_id) DO NOTHING`,
        [a.id, p.trello_member_id, p.employee_id, card.id, card.name || '', card.shortLink ? 'https://trello.com/c/' + card.shortLink : null,
          (d.board && d.board.name) || '', authorMember, via ? via.name : ((a.memberCreator && a.memberCreator.fullName) || ''),
          String((via ? via.text : d.text) || '').slice(0, 500), a.date]);
    }
  }
  await setSetting('jarvis_sync_since', maxDate);
  if (deep) await setSetting('jarvis_sync_deep', new Date().toISOString());
  // Упоминание старше mention_stale_days — протухло. Если за две недели
  // никто о нём не вспомнил, это не задача, а история переписки.
  await pool.query(
    `UPDATE jarvis_mentions SET answered_at = now(), answered_via = 'stale'
      WHERE answered_at IS NULL AND created_at < now() - ($1 || ' days')::interval`,
    [String(rules.mention_stale_days)]);

  // Карточка сделана — ждать ответа больше не от кого: её перенесли в колонку
  // «Сделано/Готово», отметили выполненной или убрали в архив (решение Шоха).
  const waiting = new Set(scan.cards.filter((c) => !isDone(c, scan)).map((c) => c.id));
  const closed = (await pool.query('SELECT DISTINCT card_id FROM jarvis_mentions WHERE answered_at IS NULL')).rows
    .map((r) => r.card_id).filter((id) => !waiting.has(id));
  if (closed.length) {
    await pool.query(`UPDATE jarvis_mentions SET answered_at = now(), answered_via = 'done'
      WHERE answered_at IS NULL AND card_id = ANY($1::text[])`, [closed]);
  }
}

// Одна запись журнала; вернёт false, если такое уже было (dedup_key).
async function log(kind, employeeId, card, text, sent, dedupKey) {
  const r = await pool.query(
    `INSERT INTO jarvis_log (kind, employee_id, card_id, card_name, card_url, text, sent, dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [kind, employeeId, card ? card.id : null, card ? card.name : null, card ? card.url : null, text, !!sent, dedupKey]);
  // Запись уже была, а сообщение дошло только сейчас (в прошлый раз мешал
  // дневной потолок или человек ещё не подключился к боту) — поднимаем отметку
  // «доставлено». Иначе в журнале навсегда оставалось бы «не дошло».
  if (!r.rows.length && sent && dedupKey) {
    await pool.query('UPDATE jarvis_log SET sent = TRUE, created_at = now() WHERE dedup_key = $1 AND sent = FALSE', [dedupKey]);
  }
  return r.rows.length > 0;
}

// Свежая проверка перед отправкой: карточка могла измениться минуту назад —
// поставили срок, отметили выполненной, перенесли в «Сделано». Лучше промолчать,
// чем написать про просрочку, которой уже нет.
async function stillOverdue(card, scan, now) {
  try {
    const f = await trello.card(card.id);
    if (!f || f.closed) return null;
    if (f.dueComplete || !f.due || Date.parse(f.due) >= now) return null;
    if (R.isDoneList(scan.listName.get(f.idList), scan.doneExtra)) return null;
    return f;                                   // всё ещё просрочена, срок — свежий
  } catch (e) { return card; }                  // Trello не ответил — работаем по снимку
}

// ---------- Напоминания ----------
async function remindAll(rules, scan, people, now) {
  const byEmp = new Map(people.map((p) => [p.employee_id, p]));
  const byMember = new Map(people.map((p) => [p.trello_member_id, p]));
  const workNow = R.isWorkTime(now, rules);
  const canSend = rules.reminders_enabled && workNow;
  // Потолок сообщений в день на человека (решение Шоха: «слишком много сообщений»).
  // Нарушения выше потолка — их мало и они важные, остальное ждёт завтра.
  const sentToday = new Map((await pool.query(
    `SELECT employee_id, COUNT(*)::int AS n FROM jarvis_log
      WHERE sent = TRUE AND employee_id IS NOT NULL AND created_at > now() - interval '20 hours'
        AND kind <> 'ai' GROUP BY employee_id`)).rows.map((r) => [r.employee_id, r.n]));
  const overCap = (p) => p && (sentToday.get(p.employee_id) || 0) >= rules.daily_cap;
  const deliver = async (p, html, extra, force) => {
    if (!canSend || !p || !p.jv_chat_id) return false;
    if (!force && overCap(p)) return false;
    const ok = !!(await send(p.jv_chat_id, html, extra));
    if (ok) sentToday.set(p.employee_id, (sentToday.get(p.employee_id) || 0) + 1);
    return ok;
  };

  // 1. Упоминания без ответа.
  // Решаем только в рабочее время и только когда напоминания включены —
  // иначе ночью или «в тихом режиме» всё ушло бы в журнал без отправки.
  if (canSend) {
    const open = (await pool.query('SELECT * FROM jarvis_mentions WHERE answered_at IS NULL AND employee_id IS NOT NULL')).rows;
    for (const m of open) {
      const step = R.mentionStep(m, now, rules);
      if (!step) continue;
      const p = byEmp.get(m.employee_id);
      if (!p) continue; // уволен или отвязан от Trello — не спрашиваем
      const card = { id: m.card_id, name: m.card_name, url: m.card_url };
      const quote = m.text ? `\n«${esc(m.text.slice(0, 300))}»` : '';
      if (step === 'remind') {
        const ok = await deliver(p, `🔔 Вас упомянули в карточке <b>«${esc(m.card_name)}»</b> (${esc(m.board_name)}) — ${esc(m.author_name)}:${quote}\n\nОтвета пока нет.`,
          cardButtons(m.card_id, m.card_url, m.id));
        // Отметку «напомнили» ставим ТОЛЬКО когда сообщение ушло. Раньше она
        // ставилась заранее, и если упёрлись в дневной потолок, человек ещё не
        // подключился к боту или Telegram ответил ошибкой — напоминание
        // считалось сделанным и больше не повторялось никогда. Теперь оно
        // повторится на следующем такте, а в журнале видно «не дошло».
        if (ok) await pool.query('UPDATE jarvis_mentions SET reminded_at = now() WHERE id = $1', [m.id]);
        await log('remind_mention', m.employee_id, card, m.author_name, ok, 'rm:' + m.id);
      } else {
        await pool.query('UPDATE jarvis_mentions SET violation_at = now(), reminded_at = COALESCE(reminded_at, now()) WHERE id = $1', [m.id]);
        const h = rules.mention_violation_h;
        const ok = await deliver(p, `⚠️ Нет ответа ${h} рабочих часов на упоминание в карточке <b>«${esc(m.card_name)}»</b> — `
          + `это нарушение${rules.fines_enabled ? '' : ' (штрафы пока не начисляются)'}.${quote}`, cardButtons(m.card_id, m.card_url, m.id), true);
        await log('violation_mention', m.employee_id, card, `Нет ответа ${h} раб. ч, упомянул(а) ${m.author_name}`, ok, 'vm:' + m.id);
        const author = byMember.get(m.author_member_id);
        if (author && author.employee_id !== m.employee_id) {
          await deliver(author, `⏰ ${esc(p.full_name)} не ответил(а) на ваше упоминание в карточке «${esc(m.card_name)}» за ${h} рабочих часов.`,
            cardButtons(m.card_id, m.card_url));
        }
      }
    }
  }
  if (!canSend) return;

  // 2. Просроченные карточки: нарушение через N рабочих дней; список — в утренней сводке.
  // Чей сейчас ход. В карточке обычно несколько участников, но отвечать должен
  // тот, кого последним попросили: если в карточке есть упоминание без ответа —
  // мяч у него, остальных не дёргаем (замечание Шоха: «какое отношение это
  // имеет ко мне? мяч на стороне Угилой»).
  const ballAt = new Map();
  for (const r of (await pool.query(
    `SELECT card_id, array_agg(DISTINCT employee_id) AS emps FROM jarvis_mentions
      WHERE answered_at IS NULL AND employee_id IS NOT NULL GROUP BY card_id`)).rows) {
    ballAt.set(r.card_id, new Set(r.emps.map(Number)));
  }
  const overdueBy = new Map();
  for (const c of scan.cards) {
    if (!isOverdue(c, scan, now)) continue;
    const ball = ballAt.get(c.id);
    for (const mid of c.idMembers || []) {
      const p = byMember.get(mid);
      if (!p) continue;
      if (ball && !ball.has(p.employee_id)) continue;   // ход не его — молчим
      if (!overdueBy.has(p.employee_id)) overdueBy.set(p.employee_id, []);
      overdueBy.get(p.employee_id).push(c);
      if (R.overdueIsViolation(Date.parse(c.due), now, rules)) {
        const key = `vo:${c.id}:${mid}:${c.due}`;
        const exists = (await pool.query('SELECT 1 FROM jarvis_log WHERE dedup_key = $1', [key])).rows.length;
        const fresh = exists ? null : await stillOverdue(c, scan, now);
        if (!exists && fresh) {
          const ok = await deliver(p, `⚠️ Карточка <b>«${esc(c.name)}»</b> просрочена (срок был ${dateRu(fresh.due)}) — `
            + `это нарушение${rules.fines_enabled ? '' : ' (штрафы пока не начисляются)'}.`, cardButtons(c.id, c.shortUrl), true);
          await log('violation_overdue', p.employee_id, { id: c.id, name: c.name, url: c.shortUrl }, 'Срок был ' + dateRu(c.due), ok, key);
        }
      }
    }
  }
  await dueControl(rules, scan, byMember, byEmp, deliver, now, ballAt);
  await morning(rules, overdueBy, now, scan);
  await salesDigest(rules, now).catch((e) => console.warn('[ДЖАРВИС] сводка продаж:', e.message));
  await weeklyScore(rules, now).catch((e) => console.warn('[ДЖАРВИС] итог недели:', e.message));
  await complaintsTick(rules, now).catch((e) => console.warn('[ДЖАРВИС] претензии:', e.message));
  await logisticsTick(rules, now).catch((e) => console.warn('[ДЖАРВИС] доставка:', e.message));
  await complaintsWeekly(rules, now).catch((e) => console.warn('[ДЖАРВИС] неделя претензий:', e.message));
  await weeklySilent(rules, now).catch((e) => console.warn('[ДЖАРВИС] молчуны:', e.message));

  // 3. Карточки без движения — ОДНО сообщение списком на человека в неделю.
  // Раньше на каждую карточку шло отдельное сообщение: у людей было по три
  // десятка уведомлений за утро, и бот превращался в спам (замечание Шоха).
  const staleMs = rules.stale_days * 86400000;
  const staleBy = new Map();
  for (const c of scan.cards) {
    if (isDone(c, scan) || !(c.idMembers || []).length) continue;
    if (now - Date.parse(c.dateLastActivity) < staleMs) continue;
    if (c.due && Date.parse(c.due) < now) continue;          // про просрочку пишем отдельно
    for (const mid of c.idMembers) {
      const p = byMember.get(mid);
      if (!p) continue;
      if (!staleBy.has(p.employee_id)) staleBy.set(p.employee_id, []);
      staleBy.get(p.employee_id).push(c);
    }
  }
  const week = Math.floor(now / (7 * 86400000));             // раз в неделю, не чаще
  for (const [empId, cards] of staleBy) {
    const key = `stw:${empId}:${week}`;
    if (await seen(key)) continue;
    const p = byEmp.get(empId);
    const list = cards.slice(0, 15).map((c) => `• ${esc(c.name)} — с ${dateRu(c.dateLastActivity)}`).join('\n');
    const ok = await deliver(p, `💤 Без движения больше ${rules.stale_days} дней (${cards.length}):\n${list}\n\n`
      + 'Если карточки уже не нужны — перенесите их в «не актуально», и я о них забуду.', p && p.jv_chat_id ? await kb(p.jv_chat_id) : menu);
    await log('remind_stale', empId, null, `Без движения: ${cards.length} карточек`, ok, key);
  }
}

// ---------- Срок задачи (решение Шоха, 22.09.2026) ----------
// «Задача принята» без даты — это не ответ, а отписка: карточка висит месяцами.
// Поэтому у карточки с исполнителем должен быть срок. Нет срока — Джарвис
// спрашивает его кнопками; не поставили за due_required_h рабочих часов —
// нарушение. Переносы не запрещаем, но считаем: перенос виден в журнале,
// а после moves_alert переносов Джарвис говорит об этом руководителю.
const seen = async (key) => (await pool.query('SELECT 1 FROM jarvis_log WHERE dedup_key = $1', [key])).rows.length > 0;

const ASK_LIMIT = 3;     // столько вопросов про срок одному человеку за полдня
async function dueControl(rules, scan, byMember, byEmp, deliver, now, ballAt) {
  const rows = new Map((await pool.query('SELECT * FROM jarvis_cards')).rows.map((r) => [r.card_id, r]));
  // Старых карточек без срока много — спрашиваем порциями, а не сваливаем всё разом.
  const asked = new Map((await pool.query(
    `SELECT employee_id, count(*)::int AS n FROM jarvis_log
      WHERE kind = 'remind_no_due' AND created_at > now() - interval '12 hours' GROUP BY employee_id`))
    .rows.map((r) => [r.employee_id, r.n]));
  const admins = (await pool.query(
    `SELECT DISTINCT u.jv_chat_id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE r.is_admin = TRUE AND u.is_active = TRUE AND u.jv_chat_id IS NOT NULL`)).rows.map((r) => r.jv_chat_id);
  for (const c of scan.cards) {
    const ball = ballAt && ballAt.get(c.id);
    const row = rows.get(c.id);
    // Спрашиваем срок у того, за кем ход: если в карточке ждут ответа от
    // конкретного человека, остальных участников не трогаем.
    let people = (c.idMembers || []).map((m) => byMember.get(m)).filter(Boolean)
      .filter((p) => !ball || ball.has(p.employee_id));
    // А если кто-то написал «принято» — спрос с него одного: он взял задачу
    // на себя, остальным участникам про срок писать незачем.
    const accepted = row && row.accepted_by ? byEmp.get(Number(row.accepted_by)) : null;
    if (accepted) people = [accepted];
    if (isDone(c, scan) || !people.length) continue;         // без исполнителя это заметка, а не задача
    const card = { id: c.id, name: c.name, url: c.shortUrl };

    if (c.due) {
      const was = row && row.due ? Date.parse(row.due) : null;
      const isNew = Date.parse(c.due);
      const moved = was && isNew > was;                       // срок отодвинули
      const moves = (row ? row.due_moves : 0) + (moved ? 1 : 0);
      await pool.query(
        `INSERT INTO jarvis_cards (card_id, name, url, board_name, due, due_moves, no_due_since, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,now())
         ON CONFLICT (card_id) DO UPDATE SET name=$2, url=$3, board_name=$4, due=$5, due_moves=$6, no_due_since=NULL, updated_at=now()`,
        [c.id, c.name, c.shortUrl, scan.boardName.get(c.idBoard) || '', c.due, moves]);
      if (!moved) continue;
      const key = `dm:${c.id}:${c.due}`;
      if (await seen(key)) continue;
      for (const p of people) {
        await deliver(p, `📅 Срок карточки <b>«${esc(c.name)}»</b> перенесён на ${dateRu(c.due)} (перенос №${moves}).\n`
          + 'Напишите одной строкой причину — она ляжет комментарием в карточку.', cardButtons(c.id, c.shortUrl));
      }
      await log('due_moved', people[0].employee_id, card, `Перенос №${moves}, новый срок ${dateRu(c.due)}`, true, key);
      if (moves >= rules.moves_alert) {
        const akey = `dma:${c.id}:${moves}`;
        if (!(await seen(akey))) {
          for (const chat of admins) {
            await send(chat, `🔁 Карточка <b>«${esc(c.name)}»</b> переносится ${moves}-й раз (${esc(people.map((p) => p.full_name).join(', '))}). Новый срок ${dateRu(c.due)}.`,
              cardButtons(c.id, c.shortUrl));
          }
          await log('due_moved', people[0].employee_id, card, `Сигнал руководителю: ${moves} переносов`, true, akey);
        }
      }
      continue;
    }

    // Срока нет: с какого момента ждём.
    const since = row && row.no_due_since ? row.no_due_since : new Date(now).toISOString();
    await pool.query(
      `INSERT INTO jarvis_cards (card_id, name, url, board_name, due, no_due_since, updated_at)
       VALUES ($1,$2,$3,$4,NULL,$5,now())
       ON CONFLICT (card_id) DO UPDATE SET name=$2, url=$3, board_name=$4, due=NULL, no_due_since=$5, updated_at=now()`,
      [c.id, c.name, c.shortUrl, scan.boardName.get(c.idBoard) || '', since]);
    const hours = R.workHours(R.clockStart(Date.parse(since), rules), now, rules);
    for (const p of people) {
      // Новую карточку не трогаем сразу: человек только завёл её и, может,
      // прямо сейчас ставит срок руками (замечание Шоха). Но если человек
      // только что написал «принято», самое время спросить — сразу.
      if (!accepted && hours < rules.due_ask_after_h) continue;
      const ask = `rd:${c.id}:${p.employee_id}:${since}`;
      if (!(await seen(ask))) {
        const n = asked.get(p.employee_id) || 0;
        if (n >= ASK_LIMIT) continue;                        // остальные спросим следующей порцией
        asked.set(p.employee_id, n + 1);
        const ok = await deliver(p, accepted
          ? `📅 Вы приняли карточку <b>«${esc(c.name)}»</b>. Когда будет готово?`
          : `📅 Карточка <b>«${esc(c.name)}»</b> за вами, но срока нет. Когда сделаете?`,
          dueButtons(c.id, c.shortUrl));
        await log('remind_no_due', p.employee_id, card, 'Спросили срок', ok, ask);
        continue;                                            // нарушение — не в ту же минуту
      }
      if (hours < rules.due_required_h) continue;
      const vkey = `vd:${c.id}:${p.employee_id}:${since}`;
      if (await seen(vkey)) continue;
      const ok = await deliver(p, `⚠️ Карточка <b>«${esc(c.name)}»</b> в работе без срока больше ${rules.due_required_h} рабочих часов — `
        + `это нарушение${rules.fines_enabled ? '' : ' (штрафы пока не начисляются)'}. Поставьте срок:`, dueButtons(c.id, c.shortUrl), true);
      await log('violation_no_due', p.employee_id, card, `Без срока ${Math.round(hours)} раб. ч`, ok, vkey);
    }
  }
}

// ---------- Утренняя сводка ----------
// Раз в рабочее утро каждому, кто в боте: его просрочки и упоминания в Trello
// и дела «Нужно внести» из ERP (те же, что в колокольчике, по правам его роли).
// Нечего сказать — не пишем. Сервер перезапустился днём — «доброе утро» не шлём:
// окно — первые 3 часа рабочего дня.
const morningChecked = new Set();
const hubUrl = (link) => 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN + link;
async function morning(rules, overdueBy, now, scan) {
  const hour = ((now + 5 * 3600000) % 86400000) / 3600000;
  if (hour >= rules.work_from + 3) return;
  const today = R.localDate(now);
  const people = (await pool.query(
    `SELECT u.id, u.jv_chat_id, e.id AS employee_id, e.full_name,
            BOOL_OR(COALESCE(r.is_admin, FALSE)) AS is_admin, BOOL_OR(COALESCE(r.is_finance, FALSE)) AS is_finance
       FROM users u JOIN hr_employees e ON e.erp_user_id = u.id
       LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = TRUE AND e.status = 'active' AND u.jv_chat_id IS NOT NULL
      GROUP BY u.id, e.id`)).rows;
  const { todosFor, refreshTodoState } = require('./todos');
  // Наблюдения считаем один раз на всех, показываем каждому по его правам.
  let insights = [];
  try { insights = await require('./jarvis-insights').collect(pool, rules); }
  catch (e) { console.warn('[НАБЛЮДЕНИЯ]', e.message); }
  const hasTileFor = (p, url) => require('./ai-tools')
    .hasTile({ id: p.id, isAdmin: p.is_admin, isFinance: p.is_finance }, url);
  // Сколько дело уже висит — считаем один раз на такт, не на каждого человека.
  await refreshTodoState(pool).catch((e) => console.warn('[ДЕЛА] состояние:', e.message));
  for (const p of people) {
    const key = `am:${p.employee_id}:${today}`;
    if (morningChecked.has(key)) continue;
    morningChecked.add(key);
    if ((await pool.query('SELECT 1 FROM jarvis_log WHERE dedup_key = $1', [key])).rows.length) continue;
    // Перед утренней сводкой перечитываем просроченные карточки: за ночь их
// могли закрыть или перенести срок, а человек получил бы устаревший список.
    const overdue = [];
    for (const c of (overdueBy.get(p.employee_id) || []).slice(0, 10)) {
      const fresh = scan ? await stillOverdue(c, scan, now) : c;
      if (fresh) overdue.push({ ...c, due: fresh.due || c.due });
    }
    const waiting = (await pool.query(
      'SELECT count(*)::int AS n FROM jarvis_mentions WHERE employee_id = $1 AND answered_at IS NULL', [p.employee_id])).rows[0].n;
    let todos = [];
    try { todos = await todosFor({ id: p.id, isAdmin: p.is_admin, isFinance: p.is_finance }); } catch (e) { todos = []; }
    // Наблюдения: то, о чём человек не спрашивал, но что стоит знать.
    // Показываем только открытые его плиткам и не больше трёх.
    const mine = [];
    for (const n of insights) {
      if (mine.length >= 3) break;
      let ok = false;
      for (const url of n.tiles) if (await hasTileFor(p, url)) { ok = true; break; }
      if (ok) mine.push(n);
    }
    if (!overdue.length && !waiting && !todos.length && !mine.length) continue;
    const name = String(p.full_name).split(/\s+/)[1] || p.full_name;
    const parts = [`☀️ Доброе утро, ${esc(name)}!`];
    if (overdue.length || waiting) {
      parts.push('\n<b>Trello</b>');
      if (overdue.length) {
        parts.push(`⏰ Просрочены (${overdue.length}):`);
        overdue.slice(0, 10).forEach((c) => parts.push(`• ${esc(c.name)} — срок ${dateRu(c.due)}`));
      }
      if (waiting) parts.push(`💬 Ждут вашего ответа: ${waiting}`);
      parts.push(`Список с кнопками — «${MENU_MY}».`);
    }
    if (mine.length) {
      parts.push('\n<b>Обратите внимание</b>');
      mine.forEach((n) => parts.push(`${n.icon} ${esc(n.text)}`));
    }
    if (todos.length) {
      parts.push('\n<b>ERP — нужно внести</b>');
      todos.forEach((t) => {
        parts.push(`• <b>${esc(t.title)}</b>\n  ${esc(t.body)}`);
        // Дело дошло до второго в цепочке: человек должен понимать, почему оно у него.
        if (t.escalated) {
          parts.push(`  ⚠️ Это с ${dateRu(t.escalated.since)} у роли «${esc(t.escalated.prev_role || '—')}», до сих пор не сделано. `
            + 'Поправьте сами или напомните.');
        }
      });
    }
    // Кнопки ведут прямо в окно ERP, где это вносится.
    const buttons = process.env.RAILWAY_PUBLIC_DOMAIN
      ? todos.filter((t) => t.link).slice(0, 4).map((t) => [{ text: '➡️ ' + t.title.slice(0, 40), url: hubUrl(t.link) }]) : [];
    // Сводку пишем живым языком: факты собрала система, а формулировку
    // доверяем модели — цифры она менять не имеет права (jarvis-voice-style).
    const body = await require('./jarvis-voice-style').liven(parts.join('\n'), rules, name);
    const ok = !!(await send(p.jv_chat_id, body, buttons.length ? { reply_markup: { inline_keyboard: buttons } } : menu));
    await log('morning', p.employee_id, null,
      [overdue.length ? 'просрочено ' + overdue.length : '', waiting ? 'ждут ответа ' + waiting : '', mine.length ? 'наблюдений ' + mine.length : '',
        ...todos.map((t) => t.title)].filter(Boolean).join('; '), ok, key);
  }
}

// ---------- Продажи из SalesDoctor ----------
// SD тяжёлый, поэтому ходим в него сами и заранее: ночью — свежие дни, днём —
// по месяцу истории, пока не зальём 24 месяца. Человек в боте всегда получает
// ответ из нашей таблицы, а не ждёт CRM.
async function sdSalesTick() {
  const sd = require('./sd-sales');
  const st = await sd.backfillState();
  if (st.next_month && !st.finished) {                 // заливка истории — по месяцу за такт
    const after = await sd.backfillStep();
    console.log(`[ПРОДАЖИ SD] история: ${after.last_month || '—'}, загружено месяцев ${after.done || 0}${after.error ? ', ошибка: ' + after.error : ''}`);
    return;
  }
  // Ночная догрузка свежих дней: один раз в сутки, в тихие часы.
  const hour = ((Date.now() + 5 * 3600000) % 86400000) / 3600000;
  if (hour < 3 || hour > 6) return;
  const key = 'sd_sales_last_night';
  const last = ((await pool.query('SELECT value FROM settings WHERE key = $1', [key])).rows[0] || {}).value || '';
  const day = R.localDate(Date.now());
  if (last === day) return;
  const r = await sd.syncRecent(4);
  await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2)
                    ON CONFLICT (key) DO UPDATE SET value = $2`, [key, day]);
  console.log(`[ПРОДАЖИ SD] ночью обновлено ${r.from}…${r.to}: строк ${r.rows}`);
}

// ---------- Раз в N дней: клиенты, которые притихли ----------
// Решение Шоха: агентов в Джарвиса не подключаем — у них есть клиентский бот,
// второй стал бы бардаком. Вместо этого РОП получает сводку, разложенную по
// менеджерам: каждый кусок — отдельным сообщением, чтобы переслать его
// менеджеру одним касанием, не переписывая руками.
// ---------- Претензии: итог недели (понедельник) ----------
// Руководителю звена — его звено, РОПу и админу — картина целиком. Сравнение
// с прошлой неделей: разница меньше 10% — шум, о ней не говорим.
const minutesWord = (sec) => {
  if (!sec && sec !== 0) return null;
  const m = Math.round(Number(sec) / 60);
  return m < 60 ? `${m} мин` : `${Math.round(m / 6) / 10} ч`;
};
async function complaintsWeekly(rules, now) {
  if (!rules.complaints_owners || !rules.reminders_enabled) return;
  const local = new Date(now + 5 * 3600000);
  const dow = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
  const hour = (now + 5 * 3600000) % 86400000 / 3600000;
  if (dow !== 1 || hour < rules.work_from || hour >= rules.work_from + 3) return;
  const cx = require('./jarvis-complaints');
  const w = R.weekWindows(now, 'monday');
  const cur = await cx.weekStats(w.from, w.to);
  const prev = await cx.weekStats(w.prev_from, w.prev_to);
  if (!cur.total && !prev.total) return;
  const t = R.trend(cur.total, prev.total);
  const head = `📩 <b>Претензии за неделю</b> (${dateRu(w.from)}–${dateRu(w.to)})`;
  const totalLine = `Всего: ${cur.total}` + (t.pct === null ? ''
    : t.flat ? ` — как и неделю назад (было ${prev.total})`
      : t.up ? ` — на ${t.pct}% больше прошлой недели (было ${prev.total})`
        : ` — на ${Math.abs(t.pct)}% меньше прошлой недели (было ${prev.total})`);

  // Руководителям звеньев — только их звено: чужие цифры им не нужны.
  const owners = await cx.ownersByLink();
  const byChat = new Map();
  for (const o of owners) {
    if (!byChat.has(o.chat_id)) byChat.set(o.chat_id, []);
    byChat.get(o.chat_id).push(o);
  }
  for (const [chat, links] of byChat) {
    const key = `cmpwk:${w.from}:${chat}`;
    if (await seen(key)) continue;
    const lines = [];
    for (const l of links) {
      const c = cur.by.find((x) => x.link === l.code);
      const p = prev.by.find((x) => x.link === l.code);
      const n = c ? c.vsego : 0, was = p ? p.vsego : 0;
      if (!n && !was) continue;
      const tl = R.trend(n, was);
      let line = `• ${esc(l.label_ru)}: ${n}`;
      if (tl.pct !== null && !tl.flat) line += tl.up ? ` (было ${was}, хуже)` : ` (было ${was}, лучше)`;
      if (c && c.zakryto < c.vsego) line += `, не закрыто ${c.vsego - c.zakryto}`;
      lines.push(line);
    }
    if (!lines.length) {
      const ok = await send(chat, `${head}\nПо вашему звену за неделю ни одной претензии. Так и надо.`);
      await log('complaint_week', null, null, 'Звено: пусто', ok, key);
      continue;
    }
    const ok = await send(chat, `${head}\nПо вашему звену:\n${lines.join('\n')}`);
    await log('complaint_week', null, null, 'Звено: ' + lines.length + ' строк', ok, key);
  }

  // РОПу и админам — вся картина: звенья и самые частые типы.
  const chiefs = (await pool.query(
    `SELECT DISTINCT u.jv_chat_id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = TRUE AND u.jv_chat_id IS NOT NULL
        AND (r.is_admin = TRUE OR r.bot_role = 'head_of_sales')`)).rows.map((r) => r.jv_chat_id);
  for (const chat of chiefs) {
    const key = `cmpwkall:${w.from}:${chat}`;
    if (await seen(key)) continue;
    const links = cur.by.map((r) => {
      const react = minutesWord(r.react_sec);
      return `• ${esc(r.label || r.link)}: ${r.vsego}`
        + (r.zakryto < r.vsego ? `, не закрыто ${r.vsego - r.zakryto}` : '')
        + (react ? `, агент реагировал за ${react}` : '');
    });
    const types = cur.types.filter((x) => x.label).map((x) => `• ${esc(x.label)} — ${x.n}`);
    const body = [head, totalLine, '', ...(links.length ? ['По звеньям:', ...links] : []),
      ...(types.length ? ['', 'Чаще всего:', ...types] : [])].join('\n');
    const ok = await send(chat, body);
    await log('complaint_week', null, null, `Сводка руководству: ${cur.total}`, ok, key);
  }
}

// ---------- Доставка: сводка логисту (решение Шоха 24.09.2026) ----------
// Водители остаются в клиентском боте — он напоминает им отметить «Доставлен».
// Логист сотрудник Hub, поэтому его сводку шлёт Джарвис: вечером итог дня,
// утром итог вчерашнего (часть заказов закрывают ночью).
async function logisticsTick(rules, now) {
  if (!rules.logistics_digest || !rules.reminders_enabled) return;
  const hhmm = new Date(now + 5 * 3600000).toISOString().slice(11, 16);
  const morning = hhmm >= '08:00' && hhmm < '08:20';
  const evening = hhmm >= '19:00' && hhmm < '19:20';
  if (!morning && !evening) return;
  const lg = require('./jarvis-logistics');
  const key = `lgd:${lg.localDay(now)}:${morning ? 'am' : 'pm'}`;
  if (await seen(key)) return;
  const chats = await lg.recipients();
  if (!chats.length) return;
  const { text } = await lg.digestFor(now, morning);
  if (!text) return;
  let sent = 0;
  for (const chat of chats) if (await send(chat, text)) sent++;
  await log('logistics_digest', null, null, `Сводка доставки (${morning ? 'утро' : 'вечер'}) — ${sent} чел.`, sent > 0, key);
}

// ---------- Претензии: сторона компании (решение Шоха 24.09.2026) ----------
// Клиент и торговый агент остаются во внешнем боте. Джарвис ведёт тех, кто
// внутри: руководителю звена — карточка и решение, РОПу с админом — эскалация.
// Пока переключатель в плитке выключен, здесь ничего не происходит и всё
// работает по-старому.
async function complaintsTick(rules, now) {
  if (!rules.complaints_owners || !rules.reminders_enabled) return;
  const cx = require('./jarvis-complaints');
  const rows = await cx.openComplaints();
  if (!rows.length) return;
  const work = R.isWorkTime(now, rules);
  // Новые претензии: карточка уходит сразу, даже если руководитель ещё не
  // видел её в вебе. Ночью не дёргаем — утром первое же напоминание догонит.
  for (const c of rows) {
    if (!work) break;
    // Закрытую карточку слать незачем: по ней уже всё решено, а руководителю
    // отдельно уходит короткий итог «агент закрыл сам» (проверка на проде
    // 25.09.2026: по двум закрытым претензиям пришла и карточка, и итог).
    if (c.status === 'resolved') continue;
    const key = `cmpcard:${c.id}`;
    if (await seen(key)) continue;
    const sent = await cx.sendCard(c.id, {});
    await log('complaint_card', null, null, `Претензия №${c.id}: карточка ушла ${sent} чел.`, sent > 0, key);
  }
  if (!work) return;
  // Что сделал агент — руководителю звена для сведения. Само событие
  // происходит во внешнем боте, поэтому ловим его по состоянию претензии,
  // а не по сообщению: так не важно, кто и где нажал кнопку.
  for (const c of rows) {
    const label = async (code) => ((await cx.resolutions()).find((x) => x.code === code) || {}).label_ru || code;
    if (c.status === 'resolved' && String(c.resolved_by || '').includes('Агент')) {
      const key = `cmpdone:${c.id}`;
      if (await seen(key)) continue;
      // Без карточки коротко напоминаем, о чём речь: одно «агент закрыл» без
      // товара и точки руководителю ничего не говорит.
      const about = [c.product_name, c.point_name || c.firm_name].filter(Boolean).map(esc).join(' · ');
      const n = await cx.tell(c.id, `✅ Претензия №${c.id}: агент закрыл сам — ${esc(await label(c.agent_resolution))}.`
        + (about ? `\n${about}` : ''));
      await log('complaint_done', null, null, `Претензия №${c.id}: агент закрыл`, n > 0, key);
    } else if (c.status !== 'resolved' && c.agent_resolution && cx.CRITICAL_TYPES.has(c.complaint_type)) {
      // Критичную агент не закрывает: он принял в работу и предложил решение,
      // а последнее слово за руководителем звена.
      const key = `cmpagres:${c.id}`;
      if (await seen(key)) continue;
      const n = await cx.tell(c.id, `ℹ️ Претензия №${c.id}: агент принял в работу и предлагает — `
        + `${esc(await label(c.agent_resolution))}. Решение за вами (кнопки под карточкой).`);
      await log('complaint_agent', null, null, `Претензия №${c.id}: агент предложил решение`, n > 0, key);
    }
  }
  // Напоминания и эскалация — по рабочим часам из правил.
  const admins = (await pool.query(
    `SELECT DISTINCT u.jv_chat_id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = TRUE AND u.jv_chat_id IS NOT NULL
        AND (r.is_admin = TRUE OR r.bot_role = 'head_of_sales')`)).rows.map((r) => r.jv_chat_id);
  for (const d of cx.dueOwners(rows, now, rules, R)) {
    const key = `cmprem:${d.id}:${d.stage}`;
    if (await seen(key)) continue;
    const sent = await cx.sendCard(d.id, { critical: d.critical, remind: true });
    await log('complaint_remind', null, null, `Претензия №${d.id}: напоминание (${d.stage})`, sent > 0, key);
    if (!d.escalate) continue;
    const c = rows.find((x) => x.id === d.id) || {};
    const point = c.point_name || c.firm_name || c.sd_id || '';
    for (const chat of admins) {
      await send(chat, `⏰ Критичная претензия <b>№${d.id}</b> (${esc(point)}) подана ${cx.sinceText(c.created_at)} — `
        + 'руководитель звена до сих пор не принял решение. Нужен ваш разбор.');
    }
  }
}

// ---------- Итог недели (решение Шоха 24.09.2026) ----------
// Люди должны слышать не только «вы просрочили», но и «это сделано хорошо».
// В пятницу вечером — чем закончили неделю, в понедельник утром — с чем
// стартуем. Каждому по его зоне: продажи РОПу, потери складу, качество
// принятой зелени закупу. Цифры считаем сами, из базы; разницу меньше 10%
// не упоминаем вовсе — иначе похвала превращается в фон и её перестают читать.
async function weekSales(w) {
  const q = async (from, to) => Number((await pool.query(
    'SELECT COALESCE(SUM(amount - returned), 0)::numeric AS s FROM sd_sales WHERE day BETWEEN $1 AND $2',
    [from, to])).rows[0].s);
  const cur = await q(w.from, w.to), prev = await q(w.prev_from, w.prev_to);
  if (!cur && !prev) return null;
  // Кто вырос и кто просел — по объёму в штуках, деньги тут не нужны.
  const byProd = async (from, to) => new Map((await pool.query(
    `SELECT product_name, SUM(qty)::numeric AS q FROM sd_sales WHERE day BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [from, to])).rows.map((r) => [r.product_name, Number(r.q)]));
  const a = await byProd(w.from, w.to), b = await byProd(w.prev_from, w.prev_to);
  const moves = [];
  for (const [name, q] of a) {
    const was = b.get(name) || 0;
    const t = R.trend(q, was);
    if (t.pct !== null && !t.flat) moves.push({ name, pct: t.pct });
  }
  moves.sort((x, y) => y.pct - x.pct);
  return { cur, prev, trend: R.trend(cur, prev), up: moves[0], down: moves[moves.length - 1] };
}

// Потери склада за неделю в килограммах: подтверждённые списания.
async function weekLosses(w) {
  const q = async (from, to) => Number((await pool.query(
    `SELECT COALESCE(SUM(i.qty), 0)::numeric AS s
       FROM stock_writeoff_items i JOIN stock_writeoffs o ON o.id = i.writeoff_id
      WHERE o.status = 'confirmed' AND o.moved_at BETWEEN $1 AND $2`, [from, to])).rows[0].s);
  const cur = await q(w.from, w.to), prev = await q(w.prev_from, w.prev_to);
  if (!cur && !prev) return null;
  return { cur, prev, trend: R.trend(cur, prev) };
}

// Качество принятой зелени: сколько отхода отметили при приёмке — в процентах
// от принятого веса. В килограммах смысла нет: приняли больше — и отхода больше.
async function weekIntakeWaste(w) {
  const q = async (from, to) => (await pool.query(
    `SELECT COALESCE(SUM(qty) FILTER (WHERE reason = 'receive_waste'), 0)::numeric AS waste,
            COALESCE(SUM(qty) FILTER (WHERE reason = 'receive'), 0)::numeric AS got
       FROM stock_movements WHERE item_kind = 'raw' AND moved_at BETWEEN $1 AND $2`, [from, to])).rows[0];
  const a = await q(w.from, w.to), b = await q(w.prev_from, w.prev_to);
  if (!Number(a.got) && !Number(b.got)) return null;
  const pct = (r) => (Number(r.got) ? (Number(r.waste) / Number(r.got)) * 100 : 0);
  return { cur: pct(a), prev: pct(b), kg: Number(a.waste), trend: R.trend(pct(a), pct(b)) };
}

// Деньги в сводке — крупными мазками: точность до сума тут не нужна,
// нужна картина недели.
const money = (v) => {
  const n = Math.round(Number(v) || 0);
  return n >= 10000000 ? (Math.round(n / 100000) / 10).toLocaleString('ru-RU') + ' млн сум'
    : n.toLocaleString('ru-RU') + ' сум';
};
const kg = (v) => (Math.round(Number(v) * 10) / 10).toLocaleString('ru-RU') + ' кг';
const pct1 = (v) => (Math.round(Number(v) * 10) / 10).toLocaleString('ru-RU') + '%';
const znak = (t) => (t.up ? '+' : '') + t.pct + '%';

async function weeklyScore(rules, now) {
  if (!rules.reminders_enabled) return;
  const local = new Date(now + 5 * 3600000);
  const dow = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
  const hour = (now + 5 * 3600000) % 86400000 / 3600000;
  let mode = null;
  if (dow === 5 && hour >= 17 && hour < 20) mode = 'friday';
  if (dow === 1 && hour >= rules.work_from && hour < rules.work_from + 3) mode = 'monday';
  if (!mode) return;
  const w = R.weekWindows(now, mode);
  const key0 = `wk:${mode}:${w.from}`;
  const sales = await weekSales(w).catch(() => null);
  const losses = await weekLosses(w).catch(() => null);
  const intake = await weekIntakeWaste(w).catch(() => null);
  if (!sales && !losses && !intake) return;

  const people = (await pool.query(
    `SELECT u.id, u.jv_chat_id, e.id AS employee_id, e.full_name,
            BOOL_OR(COALESCE(r.is_admin, FALSE)) AS is_admin, BOOL_OR(COALESCE(r.is_finance, FALSE)) AS is_finance
       FROM users u JOIN hr_employees e ON e.erp_user_id = u.id
       LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = TRUE AND e.status = 'active' AND u.jv_chat_id IS NOT NULL
      GROUP BY u.id, e.id`)).rows;
  const tiles = require('./ai-tools');
  const head = mode === 'friday'
    ? `🏁 <b>Итог недели</b> (${dateRu(w.from)}–${dateRu(w.to)})`
    : `🚀 <b>Прошлая неделя</b> (${dateRu(w.from)}–${dateRu(w.to)})`;

  for (const p of people) {
    const key = `${key0}:${p.employee_id}`;
    if (await seen(key)) continue;
    const u = { id: p.id, isAdmin: p.is_admin, isFinance: p.is_finance };
    const lines = [];
    if (sales && (await tiles.hasTile(u, '/cash') || await tiles.hasTile(u, '/tgbot'))) {
      const t = sales.trend;
      lines.push(`📈 Продажи: ${money(sales.cur)}` + (t.pct === null ? ''
        : t.flat ? ` — как и неделю назад (${znak(t)})` : ` — ${znak(t)} к прошлой неделе`));
      if (sales.up) lines.push(`   ▲ ${esc(sales.up.name)}: +${sales.up.pct}%`);
      if (sales.down && sales.down.pct < 0) lines.push(`   ▼ ${esc(sales.down.name)}: ${sales.down.pct}%`);
    }
    if (losses && await tiles.hasTile(u, '/stock')) {
      const t = losses.trend;
      lines.push(`🗑 Списано со склада: ${kg(losses.cur)}` + (t.pct === null ? ''
        : t.flat ? ' — ровно как неделю назад' : t.up ? ` — на ${t.pct}% больше прошлой недели` : ` — на ${Math.abs(t.pct)}% меньше прошлой недели`));
    }
    if (intake && await tiles.hasTile(u, '/purchase')) {
      const t = intake.trend;
      lines.push(`🥬 Отход при приёмке: ${pct1(intake.cur)} от принятого (${kg(intake.kg)})`
        + (t.pct === null || t.flat ? '' : t.up ? ` — хуже прошлой недели на ${t.pct}%` : ` — лучше прошлой недели на ${Math.abs(t.pct)}%`));
    }
    if (!lines.length) continue;
    const name = String(p.full_name).split(/\s+/)[1] || p.full_name;
    const tail = mode === 'friday'
      ? 'Хороших выходных. В понедельник посчитаем заново — цифры помнят всё.'
      : 'Поехали. К пятнице сверимся.';
    const ok = await send(p.jv_chat_id, `${head}\n${esc(name)}, вот как оно:\n\n${lines.join('\n')}\n\n${tail}`,
      await kb(p.jv_chat_id));
    await log('week_score', p.employee_id, null, lines.join(' · ').slice(0, 400), !!ok, key);
  }
}

async function salesDigest(rules, now) {
  if (!rules.reminders_enabled || !rules.sales_digest_days || !R.isWorkTime(now, rules)) return;
  const hour = (now + 5 * 3600000) % 86400000 / 3600000;
  if (hour >= rules.work_from + 3) return;
  const bucket = Math.floor((now + 5 * 3600000) / (rules.sales_digest_days * 86400000));
  const key = `sales:${bucket}`;
  if (await seen(key)) return;
  const groups = await require('./jarvis-insights').clientsByManager(pool, rules);
  if (!groups.length) return;
  // Кому: роль с «Руководитель продаж» в боте (Админ-панель → Роли), плюс админы.
  const chats = (await pool.query(
    `SELECT DISTINCT u.jv_chat_id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = TRUE AND u.jv_chat_id IS NOT NULL
        AND (r.bot_role = 'head_of_sales' OR r.is_admin = TRUE)`)).rows.map((r) => r.jv_chat_id);
  if (!chats.length) return;
  const total = groups.reduce((s, g) => s + g.lines.length, 0);
  for (const chat of chats) {
    await send(chat, `📊 <b>Клиенты, которые притихли</b> — ${total} шт. за ${rules.sales_digest_days} дн.\n`
      + 'Дальше — по менеджерам. Любое сообщение можно переслать менеджеру как есть.', await kb(chat));
    for (const g of groups) {
      await send(chat, `👤 <b>${esc(g.manager)}</b>\n${g.lines.map((l) => esc(l)).join('\n')}\n\n`
        + 'Что с ними? Если ушли по-хорошему — скажите, я перестану напоминать.');
    }
  }
  await log('sales_digest', null, null, `Менеджеров ${groups.length}, клиентов ${total}`, true, key);
}

// ---------- Раз в неделю: кто не отвечает ----------
// Просьба Шоха: «пошевелить» тех, кто не реагирует вообще. Человеку — лично и
// с подначкой (текст пишет модель, цифры наши), руководителю — сухим списком.
// Раз в неделю, в понедельник утром: чаще это уже травля, а не напоминание.
async function weeklySilent(rules, now) {
  if (!rules.reminders_enabled || !R.isWorkTime(now, rules)) return;
  const local = new Date(now + 5 * 3600000);
  if (local.getUTCDay() !== 1) return;                      // только понедельник
  const hour = (now + 5 * 3600000) % 86400000 / 3600000;
  if (hour >= rules.work_from + 3) return;
  const week = Math.floor(now / (7 * 86400000));
  const people = await require('./jarvis-insights').silentPeople(pool, 7);
  if (!people.length) return;
  const liven = require('./jarvis-voice-style').liven;

  for (const p of people.filter((x) => x.in_bot)) {
    const key = `sil:${p.employee_id}:${week}`;
    if (await seen(key)) continue;
    const chat = ((await pool.query(
      'SELECT u.jv_chat_id FROM users u JOIN hr_employees e ON e.erp_user_id = u.id WHERE e.id = $1',
      [p.employee_id])).rows[0] || {}).jv_chat_id;
    if (!chat) continue;
    const name = String(p.full_name).split(/\s+/)[1] || p.full_name;
    const facts = `За неделю я написал тебе ${p.reminds} раз, а ответа не было ни разу.\n`
      + (p.open_mentions ? `Упоминаний без ответа в Trello: ${p.open_mentions}.\n` : '')
      + 'Нажми «📋 Мои карточки» — там всё, что ждёт тебя, и кнопка «Ответить».';
    const ok = !!(await send(chat, await liven(facts, rules, name), await kb(chat)));
    await log('remind_silent', p.employee_id, null, `Напоминаний ${p.reminds}, ответов 0`, ok, key);
  }

  // Руководителям — общий список, без иронии: это разговор про людей.
  const bossKey = `silboss:${week}`;
  if (await seen(bossKey)) return;
  const bosses = (await pool.query(
    `SELECT DISTINCT u.jv_chat_id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE r.is_admin = TRUE AND u.is_active = TRUE AND u.jv_chat_id IS NOT NULL`)).rows.map((r) => r.jv_chat_id);
  if (!bosses.length) return;
  const lines = people.map((p) => `• ${esc(p.full_name)} — ${p.reminds} напоминаний, ответов 0`
    + (p.open_mentions ? `, упоминаний без ответа ${p.open_mentions}` : '')
    + (p.in_bot ? '' : ' (бота не открыл)'));
  for (const chat of bosses) {
    await send(chat, `🙊 <b>За неделю не отреагировали ни разу:</b>\n${lines.join('\n')}\n\n`
      + 'Каждому я написал лично. Кто не открыл бота — ему я писать не могу, это только через вас.', await kb(chat));
  }
  await log('remind_silent', null, null, `Сводка руководителю: ${people.length} чел.`, true, bossKey);
}

// ---------- Такт ----------
let _running = false;
async function tick() {
  if (_running || !pool) return;
  _running = true;
  // Во время выкладки два экземпляра Hub живут одновременно — такт делает только один.
  const client = await pool.connect().catch(() => null);
  if (!client) { _running = false; return; }
  try {
    const got = (await client.query('SELECT pg_try_advisory_lock(772031) AS ok')).rows[0].ok;
    if (!got) return;
    try {
      const rules = await loadRules();
      // Продажи из SalesDoctor — независимый источник, и обновляются первыми.
      // Раньше они стояли в конце такта, после Trello: не настроен Trello или
      // он ответил ошибкой — и Джарвис молча отвечал по вчерашним продажам.
      await sdSalesTick().catch((e) => console.warn('[ПРОДАЖИ SD]', e.message));
      if (!rules.workspace_id || !trello.configured()) return;
      const people = await trackedPeople();
      const scan = await scanWorkspace(rules);
      await syncComments(rules, scan, people);
      await remindAll(rules, scan, people, Date.now());
      Object.assign(status, { last_sync: new Date().toISOString(), last_error: null, boards: scan.boards.length, cards: scan.cards.length });
    } finally { await client.query('SELECT pg_advisory_unlock(772031)').catch(() => {}); }
  } catch (e) {
    status.last_error = e.message;
    console.warn('[ДЖАРВИС] такт:', e.message);
  } finally { client.release(); _running = false; }
}

// ---------- Запуск ----------
// Интернет Джарвису включил Шох (24.09.2026): найденное там — справка со
// ссылкой, с нашими цифрами она не смешивается. Правила уже лежат в базе с
// выключенным поиском, поэтому включаем его один раз, по флагу. Выключит
// переключателем в плитке — обратно само не включится.
async function webOnOnce() {
  if ((await pool.query("SELECT 1 FROM settings WHERE key = 'jarvis_web_on_v1'")).rows.length) return;
  const raw = JSON.parse((await getSetting('jarvis_rules')) || '{}');
  raw.web_enabled = true;
  await setSetting('jarvis_rules', JSON.stringify(raw));
  await setSetting('jarvis_web_on_v1', '1');
  console.log('[ДЖАРВИС] поиск в интернете включён');
}

async function start(p) {
  pool = p;
  try { await ensureJarvisSchema(pool); } catch (e) { console.warn('[ДЖАРВИС] схема:', e.message); return; }
  await webOnOnce().catch((e) => console.warn('[ДЖАРВИС] интернет:', e.message));
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (token() && domain) {
    const ok = await tg('setWebhook', {
      url: `https://${domain}/tg/jarvis/${secret()}`, secret_token: secret(),
      allowed_updates: ['message', 'callback_query'],
    });
    console.log(ok ? '[ДЖАРВИС] бот подключён' : '[ДЖАРВИС] не удалось подключить бота');
  }
  setTimeout(tick, 60 * 1000);
  setInterval(tick, TICK_MS);
}

// Номера уже обработанных сообщений. Telegram изредка присылает одно и то же
// обновление дважды — например, если сеть оборвалась до нашего ответа. Второй
// раз публиковать комментарий в карточке или ставить срок нельзя.
const seenUpdates = new Set();
function firstTime(id) {
  if (id === undefined || id === null) return true;
  if (seenUpdates.has(id)) return false;
  seenUpdates.add(id);
  // Держим в памяти последнюю тысячу — этого с запасом хватает на повторы.
  if (seenUpdates.size > 1000) {
    for (const v of seenUpdates) { seenUpdates.delete(v); if (seenUpdates.size <= 800) break; }
  }
  return true;
}

// Express-обработчик адреса, на который Telegram присылает сообщения.
function webhook(req, res) {
  if (!token() || req.params.secret !== secret() || req.get('X-Telegram-Bot-Api-Secret-Token') !== secret()) {
    return res.status(404).end();
  }
  res.sendStatus(200); // Telegram ждёт быстрый ответ; обработка — следом
  if (!firstTime((req.body || {}).update_id)) return;
  if (pool) handleUpdate(req.body || {}).catch((e) => console.warn('[ДЖАРВИС] сообщение:', e.message));
}

module.exports = { start, webhook, tick, status, send, sendFile };
// Холостой прогон (test/jarvis-dryrun.test.js) гоняет такт целиком на
// поддельной базе и поддельных ответах Trello и Telegram. Так ловятся ошибки,
// которые видны только при запуске («opts is not defined»): проверка синтаксиса
// их пропускает, а люди потом полдня не получают напоминаний.
module.exports.__setPool = (p) => { pool = p; };
// Ту же инструкцию использует проверка ИИ в плитке — правило одно на оба входа.
module.exports.SYSTEM = SYSTEM;
