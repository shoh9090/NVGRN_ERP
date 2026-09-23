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
    .replace(/^\s*(#{1,6})\s*(.+)$/gm, '<b>$2</b>'); // заголовки — просто жирным
}
const send = (chatId, html, extra = {}) => tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
// Кнопки внизу — частые вопросы одним нажатием. Они идут МИМО ИИ: читают базу
// напрямую, отвечают мгновенно и ничего не стоят. Решение Шоха: кликать проще,
// чем печатать, а ИИ нужен для того, что кнопкой не выразишь.
const MENU_MY = '📋 Мои карточки';
const MENU_TODO = '📌 Мои дела';
const MENU_PAY = '💰 Моя зарплата';
const menu = { reply_markup: { keyboard: [[{ text: MENU_MY }, { text: MENU_TODO }], [{ text: MENU_PAY }]], resize_keyboard: true } };
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
    if (!rules.voice_enabled) return send(chatId, '🎧 Голосовые пока выключены — напишите текстом.', menu);
    const stt = require('./stt');
    if (!stt.configured()) return send(chatId, '🎧 Распознавание речи не подключено. Скажите администратору.', menu);
    tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    try {
      const text = await stt.voiceToText(token(), m.voice || m.audio, rules.voice_model);
      if (!text) return send(chatId, '🎧 Ничего не расслышал. Попробуйте ещё раз поближе к микрофону.', menu);
      await send(chatId, `🎧 Услышал: «${esc(text)}»`);
      await log('voice', me0.employee_id, null, text.slice(0, 300), true, null);
      return handleUpdate({ message: { ...m, voice: undefined, audio: undefined, text } });
    } catch (e) {
      return send(chatId, '🎧 ' + esc(e.message), menu);
    }
  }
  const me = me0;
  if (!me) {
    return send(chatId, 'Здравствуйте! Это Джарвис — внутренний помощник Novagreen на основе ИИ, программа, а не человек.\n'
      + 'Чтобы я вас узнал, нажмите «📱 Поделиться номером» внизу.\n\n'
      + 'Salom! Men Jarvis — Novagreen ichki yordamchi dasturiman. Meni tanishim uchun pastdagi tugmani bosing.', askContact);
  }
  const text = String(m.text || '').trim();
  if (text === '/cancel') { pending.delete(chatId); return send(chatId, 'Отменено.', menu); }
  const p = pending.get(chatId);
  if (p && text && !text.startsWith('/') && ![MENU_MY, MENU_TODO, MENU_PAY].includes(text)) {
    if (Date.now() > p.until) { pending.delete(chatId); return send(chatId, 'Время вышло — нажмите кнопку ещё раз.', menu); }
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
  if (/^(\/help|\/start|помощь|что (ты )?(умеешь|можешь)|чем поможешь|nima qila olasan|yordam)\??$/i.test(text)) return sendHelp(chatId, me);
  if (text) {
    const rules = await loadRules();
    if (rules.ai_enabled) return aiAnswer(chatId, me, text, rules);
  }
  return send(chatId, `${esc(me.full_name)}, спросите словами: «мои дела», «мои карточки», «остатки склада».`, menu);
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
    + '\n\n💬 Пиши как удобно, по-русски или o‘zbekcha. Частое — кнопками внизу.', menu);
}

// Кнопки: те же данные, что у ИИ-инструментов, но без модели — быстро и бесплатно.
const toolRun = async (name, me, args = {}) => {
  const t = require('./ai-tools').TOOLS.find((x) => x.name === name);
  const user = await erpUser(me.user_id);
  return t.run(args, { user, employee_id: me.employee_id, full_name: me.full_name });
};
async function myTodos(chatId, me) {
  const out = await toolRun('moi_dela', me);
  if (!Array.isArray(out)) return send(chatId, '👍 Дел нет — всё внесено.', menu);
  const lines = out.map((i) => `• <b>${esc(i.дело)}</b>\n  ${esc(i.подробно)}`);
  return send(chatId, '<b>Нужно внести:</b>\n' + lines.join('\n'), menu);
}
async function mySalary(chatId, me) {
  const r = await toolRun('moya_zarplata', me);
  if (r.итог) return send(chatId, esc(r.итог), menu);
  const n = (v) => Number(v || 0).toLocaleString('ru-RU');
  return send(chatId, `<b>Зарплата за ${esc(r.месяц)}</b>\nНачислено: ${n(r.начислено)}\nУдержано: ${n(r.удержано)}`
    + (r.штрафы ? `\nШтрафы: ${n(r.штрафы)}` : '') + `\nВыплачено: ${n(r.выплачено)}`, menu);
}

// ---------- Вопрос словами (ИИ) ----------
// Модель не считает и не помнит цифры — она вызывает наши инструменты
// (src/ai-tools.js), а те читают базу с правами роли человека. Чего роль не
// видит в ERP, того нет и в ответе бота.
const SYSTEM = [
  'Ты Джарвис — помощник сотрудников компании Novagreen Foods (Ташкент, производство свежей зелени и салатов).',
  'Отвечай коротко и по-человечески, на языке вопроса: по-русски на русский, o‘zbekcha o‘zbek tiliga.',
  'ГЛАВНОЕ: все цифры бери только из инструментов. Никогда не придумывай и не оценивай числа сам.',
  'Нет инструмента или данных — так и скажи: «таких данных у меня нет». Не уверен, о чём вопрос — переспроси.',
  'Не пересказывай, каким инструментом воспользовался. Суммы — в сумах, разряды через пробел.',
  'Ты видишь только то, что человеку открыто по его роли в ERP. Чужие зарплаты и закрытые данные не обсуждай.',
  'Спросят, кто ты — отвечай честно: Джарвис, программа-помощник Novagreen на основе ИИ, не человек.',
  'Язык держи по последнему сообщению человека: перешёл на узбекский — переходи и ты, вернулся на русский — возвращайся.',
  'Названия товаров и имена людей пиши так, как они записаны в системе, не переводи их.',
  'Пиши для Telegram: короткие строки, пункты списка начинай с подходящего эмодзи (📦 склад, 💰 деньги,',
  '📋 задачи, 📈 продажи, 👥 клиенты, ⚠️ проблема), между смысловыми блоками — пустая строка.',
  'Таблицы в чате не рисуй — только строки вида «Название — 1 200 шт, 3 400 000 сум».',
  'Никакой разметки звёздочками и решётками: выделяй важное <b>вот так</b>, если нужно.',
  // Характер (решение Шоха, 23.09.2026): живой и с лёгкой иронией, а не
  // казённый автоответчик. Но ирония — только в болтовне.
  'Характер: живой, дружелюбный, с лёгкой самоиронией. Отвечай коротко, как нормальный коллега, а не инструкция.',
  'Иногда уместен эмодзи — один, не гирлянда.',
  'Болтовню и вопросы не по делу не отшивай: пошути и мягко переведи к тому, чем полезен.',
  'Примеры тона. «Привет, детка» → «Я вообще-то корпоративный помощник, а не детка 🙂 Чем помочь?».',
  '«Посчитай звёзды на небе» → «Где-то 100–400 миллиардов только в нашей галактике. Но считать я лучше умею ваши продажи и остатки — спрашивайте».',
  '«Ты живой?» → «Программа. Зато не устаю и не ухожу в отпуск».',
  'ГРАНИЦЫ ИРОНИИ: там, где деньги, зарплата, нарушения, штрафы, претензии клиентов и чужие ошибки —',
  'никаких шуток, отвечай спокойно и по делу. Никогда не подшучивай над человеком, его работой или его результатами.',
  'Плохие новости (упал спрос, просрочка, нет данных) подавай прямо и без сарказма.',
].join(' ');

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
      model: rules.ai_model, system: SYSTEM + ` Сегодня ${R.localDate(Date.now())}. Спрашивает: ${me.full_name}.`,
      messages: [{ role: 'user', content: question.slice(0, 2000) }],
      tools, runTool,
      onStep: () => tg('sendChatAction', { chat_id: chatId, action: 'typing' }),
    });
    const text = out.text || 'Не понял вопрос. Спросите иначе.';
    await send(chatId, mdToHtml(text), menu);
    await log('ai', me.employee_id, null,
      `${question.slice(0, 200)} → ${text.slice(0, 300)} [${provider}, ${out.used.join(', ') || 'без инструментов'}, ${Math.round((Date.now() - started) / 100) / 10} с]`,
      true, null);
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
    + 'Savollarga oddiy so‘zlar bilan javob beraman. O‘zbekcha yozing — o‘zbekcha javob beraman.', menu);
}

async function onCallback(cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  tg('answerCallbackQuery', { callback_query_id: cq.id });
  if (!chatId) return;
  const me = await personByChat(chatId);
  if (!me) return send(chatId, 'Сначала нажмите «📱 Поделиться номером».', askContact);
  const data = String(cq.data || '');
  let target = null;
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
  try { await trello.setDue(target.cardId, dueIso); }
  catch (e) { return send(chatId, 'Не получилось поставить срок в Trello: ' + esc(e.message)); }
  await pool.query(
    `INSERT INTO jarvis_cards (card_id, name, url, due, no_due_since, updated_at)
     VALUES ($1,$2,$3,$4,NULL,now())
     ON CONFLICT (card_id) DO UPDATE SET due = $4, no_due_since = NULL, updated_at = now()`,
    [target.cardId, target.cardName, target.cardUrl, dueIso]);
  await log('due_set', me.employee_id, { id: target.cardId, name: target.cardName, url: target.cardUrl },
    'Срок ' + dateRu(dueIso), true, null);
  return send(chatId, `📅 Срок карточки «${esc(target.cardName)}» — ${dateRu(dueIso)}. Напомню, если подойдёт и не будет сделано.`, menu);
}

// «Мои карточки»: что ждёт ответа и что просрочено — из последнего чтения Trello.
async function myCards(chatId, me) {
  if (!me.trello_member_id) return send(chatId, 'Ваш Trello ещё не сопоставлен. Попросите администратора: плитка «Джарвис» → «Люди и Trello».', menu);
  const open = (await pool.query(
    `SELECT id, card_id, card_name, card_url, author_name, created_at FROM jarvis_mentions
      WHERE employee_id = $1 AND answered_at IS NULL ORDER BY created_at LIMIT 10`, [me.employee_id])).rows;
  const scan = await scanCached();
  const now = Date.now();
  const overdue = scan ? scan.cards.filter((c) => c.idMembers.includes(me.trello_member_id) && isOverdue(c, scan, now)) : [];
  if (!open.length && !overdue.length) return send(chatId, '👍 Всё чисто: упоминаний без ответа и просроченных карточек нет.', menu);
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
  if (_scan && Date.now() - _scan.at < TICK_MS * 2) return _scan;
  const rules = await loadRules();
  if (!rules.workspace_id || !trello.configured()) return null;
  try { return await scanWorkspace(rules); } catch (e) { return _scan; }
}
const isDone = (c, scan) => c.dueComplete || R.isDoneList(scan.listName.get(c.idList), scan.doneExtra);
const isOverdue = (c, scan, now) => c.due && !isDone(c, scan) && Date.parse(c.due) < now;

// Новые комментарии → упоминания и ответы. Каждый комментарий по порядку:
// сначала он отвечает на упоминания автора в этой карточке, потом сам кого-то упоминает.
async function syncComments(rules, scan, people) {
  const since = (await getSetting('jarvis_sync_since')) || new Date(Date.now() - 7 * 86400000).toISOString();
  const actions = [];
  for (const b of scan.boards) actions.push(...await trello.comments(b.id, since));
  actions.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const byUser = new Map(people.filter((p) => p.username).map((p) => [p.username, p]));
  const byName = new Map(people.map((p) => [p.full_name, p]));
  let maxDate = since;
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
    for (const u of R.parseMentions(via ? via.text : d.text)) {
      const p = byUser.get(u);
      if (!p || p.trello_member_id === authorMember) continue;
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
  const overdueBy = new Map();
  for (const c of scan.cards) {
    if (!isOverdue(c, scan, now)) continue;
    for (const mid of c.idMembers || []) {
      const p = byMember.get(mid);
      if (!p) continue;
      if (!overdueBy.has(p.employee_id)) overdueBy.set(p.employee_id, []);
      overdueBy.get(p.employee_id).push(c);
      if (R.overdueIsViolation(Date.parse(c.due), now, rules)) {
        const key = `vo:${c.id}:${mid}:${c.due}`;
        const exists = (await pool.query('SELECT 1 FROM jarvis_log WHERE dedup_key = $1', [key])).rows.length;
        if (!exists) {
          const ok = await deliver(p, `⚠️ Карточка <b>«${esc(c.name)}»</b> просрочена (срок был ${dateRu(c.due)}) — `
            + `это нарушение${rules.fines_enabled ? '' : ' (штрафы пока не начисляются)'}.`, cardButtons(c.id, c.shortUrl), true);
          await log('violation_overdue', p.employee_id, { id: c.id, name: c.name, url: c.shortUrl }, 'Срок был ' + dateRu(c.due), ok, key);
        }
      }
    }
  }
  await dueControl(rules, scan, byMember, deliver, now);
  await morning(rules, overdueBy, now);
  await salesDigest(rules, now).catch((e) => console.warn('[ДЖАРВИС] сводка продаж:', e.message));
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
      + 'Если карточки уже не нужны — перенесите их в «не актуально», и я о них забуду.', menu);
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
async function dueControl(rules, scan, byMember, deliver, now) {
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
    const people = (c.idMembers || []).map((m) => byMember.get(m)).filter(Boolean);
    if (isDone(c, scan) || !people.length) continue;         // без исполнителя это заметка, а не задача
    const card = { id: c.id, name: c.name, url: c.shortUrl };
    const row = rows.get(c.id);

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
      // прямо сейчас ставит срок руками (замечание Шоха).
      if (hours < rules.due_ask_after_h) continue;
      const ask = `rd:${c.id}:${p.employee_id}:${since}`;
      if (!(await seen(ask))) {
        const n = asked.get(p.employee_id) || 0;
        if (n >= ASK_LIMIT) continue;                        // остальные спросим следующей порцией
        asked.set(p.employee_id, n + 1);
        const ok = await deliver(p, `📅 Карточка <b>«${esc(c.name)}»</b> за вами, но срока нет. Когда сделаете?`,
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
async function morning(rules, overdueBy, now) {
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
    const overdue = overdueBy.get(p.employee_id) || [];
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
      + 'Дальше — по менеджерам. Любое сообщение можно переслать менеджеру как есть.', menu);
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
    const ok = !!(await send(chat, await liven(facts, rules, name), menu));
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
      + 'Каждому я написал лично. Кто не открыл бота — ему я писать не могу, это только через вас.', menu);
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
      if (!rules.workspace_id || !trello.configured()) return;
      const people = await trackedPeople();
      const scan = await scanWorkspace(rules);
      await syncComments(rules, scan, people);
      await remindAll(rules, scan, people, Date.now());
      await sdSalesTick().catch((e) => console.warn('[ПРОДАЖИ SD]', e.message));
      Object.assign(status, { last_sync: new Date().toISOString(), last_error: null, boards: scan.boards.length, cards: scan.cards.length });
    } finally { await client.query('SELECT pg_advisory_unlock(772031)').catch(() => {}); }
  } catch (e) {
    status.last_error = e.message;
    console.warn('[ДЖАРВИС] такт:', e.message);
  } finally { client.release(); _running = false; }
}

// ---------- Запуск ----------
async function start(p) {
  pool = p;
  try { await ensureJarvisSchema(pool); } catch (e) { console.warn('[ДЖАРВИС] схема:', e.message); return; }
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

// Express-обработчик адреса, на который Telegram присылает сообщения.
function webhook(req, res) {
  if (!token() || req.params.secret !== secret() || req.get('X-Telegram-Bot-Api-Secret-Token') !== secret()) {
    return res.status(404).end();
  }
  res.sendStatus(200); // Telegram ждёт быстрый ответ; обработка — следом
  if (pool) handleUpdate(req.body || {}).catch((e) => console.warn('[ДЖАРВИС] сообщение:', e.message));
}

module.exports = { start, webhook, tick, status };
// Ту же инструкцию использует проверка ИИ в плитке — правило одно на оба входа.
module.exports.SYSTEM = SYSTEM;
