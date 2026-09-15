// link-owners.js — руководители звеньев: кому бот лично пишет о претензии.
//
// Кто отвечает за звено (поле, производство, фасовка, логистика), задаёт админ
// в Hub: Претензии → Справочник → «Кто отвечает за звено» — это роль ERP
// (tgbot.complaint_dicts.owner_role_id). Людей этой роли бот находит среди
// пользователей Hub, которые подключились к боту (users.tg_chat_id).
//
// Договорённость с Шохом:
//   • простую претензию решает агент, а руководитель звена «в теме» — ему
//     приходит карточка для сведения и итог, когда агент решил;
//   • критичную решает руководитель — кнопками под карточкой.
// В обоих случаях руководитель может дописать причину — она ляжет в карточку.
//
// Все запросы терпят отсутствие колонок Hub (бот мог подняться раньше):
// тогда просто никому не пишем, претензия сохраняется как обычно.

// Текст карточки для руководителя. Отдельно от отправки — чтобы проверять тестом.
function formatCard(c, critical) {
  const head = critical
    ? `🚨 Критичная претензия №${c.id} — нужно ваше решение`
    : `📩 Претензия №${c.id} — для сведения (решает агент)`;
  const point = [c.point_name, c.firm_name && c.firm_name !== c.point_name ? `(${c.firm_name})` : null].filter(Boolean).join(' ');
  const lines = [head, ''];
  if (c.link_label) lines.push(`Звено: ${c.link_label}`);
  if (point) lines.push(`Точка: ${point}`);
  if (c.product_name) lines.push(`Товар: ${c.product_name}${c.ship_date ? ` · отгрузка ${fmtDate(c.ship_date)}` : ''}`);
  if (c.type_label) lines.push(`Тип: ${c.type_label}`);
  if (c.client_comment) lines.push(`Комментарий клиента: ${c.client_comment}`);
  if (c.agent) lines.push(`Агент: ${c.agent}`);
  if (critical) lines.push('', 'Выберите решение — оно ляжет в карточку претензии в ERP и уйдёт агенту.');
  return lines.join('\n');
}

function fmtDate(d) {
  const s = typeof d === 'string' ? d : new Date(d).toISOString();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
}

// Кнопки под карточкой. У критичной — решения из справочника; причину можно
// дописать и к простой: руководитель «в теме» и может знать, откуда проблема.
function ownerKeyboard(id, critical, resolutions) {
  const rows = critical ? (resolutions || []).map((r) => [{ text: r.label_ru, callback_data: `cmpl:ores:${id}:${r.code}` }]) : [];
  rows.push([{ text: '✍️ Написать причину', callback_data: `cmpl:onote:${id}` }]);
  return { inline_keyboard: rows };
}

module.exports = function linkOwners({ db, bot }) {
  // Люди роли, отвечающей за звено этой претензии, подключённые к боту.
  async function ownersOf(complaintId) {
    try {
      const r = await db.query(
        `SELECT DISTINCT u.id AS user_id, u.full_name, u.tg_chat_id AS chat_id
           FROM tgbot.complaints c
           JOIN tgbot.complaint_dicts d ON d.kind = 'link' AND d.code = c.link_code
           JOIN public.user_roles ur ON ur.role_id = d.owner_role_id
           JOIN public.users u ON u.id = ur.user_id
          WHERE c.id = $1 AND u.is_active
            AND COALESCE(u.tg_phone, '') <> '' AND u.tg_chat_id IS NOT NULL`, [complaintId]);
      return r.rows;
    } catch (e) {
      return [];
    }
  }

  // Нажавший кнопку — один из руководителей этого звена? Возвращает его или null.
  async function ownerByChat(complaintId, chatId) {
    const list = await ownersOf(complaintId);
    return list.find((o) => String(o.chat_id) === String(chatId)) || null;
  }

  async function loadCard(complaintId) {
    const c = (await db.query(
      `SELECT c.id, c.sd_id, c.point_name, c.firm_name, c.product_name, c.ship_date, c.client_comment,
              c.complaint_type, c.link_code, c.agent_name, c.agent_sd_id,
              (SELECT label_ru FROM tgbot.complaint_dicts WHERE kind = 'type' AND code = c.complaint_type LIMIT 1) AS type_label,
              (SELECT label_ru FROM tgbot.complaint_dicts WHERE kind = 'link' AND code = c.link_code LIMIT 1) AS link_label
         FROM tgbot.complaints c WHERE c.id = $1`, [complaintId])).rows[0];
    if (!c) return null;
    // Агента показываем именем из SalesDoctor, как в Hub; нет в справочнике — как записан.
    try {
      const a = c.agent_sd_id ? (await db.query('SELECT sd_agent_name FROM tgbot.crm_agents WHERE sd_agent_id = $1 LIMIT 1', [c.agent_sd_id])).rows[0] : null;
      c.agent = (a && a.sd_agent_name) || c.agent_name || null;
    } catch (e) { c.agent = c.agent_name || null; }
    const files = (await db.query(
      `SELECT kind, tg_file_id FROM tgbot.complaint_files
        WHERE complaint_id = $1 AND tg_file_id IS NOT NULL ORDER BY id`, [complaintId])).rows;
    return { c, files };
  }

  // Фото и видео — одним альбомом, «кружки» — отдельно (в альбом Telegram их не берёт).
  async function sendMedia(chatId, files) {
    const album = files.filter((f) => f.kind === 'photo' || f.kind === 'video').slice(0, 10)
      .map((f) => ({ type: f.kind, media: f.tg_file_id }));
    if (album.length === 1) {
      if (album[0].type === 'photo') await bot.sendPhoto(chatId, album[0].media);
      else await bot.sendVideo(chatId, album[0].media);
    } else if (album.length > 1) {
      await bot.sendMediaGroup(chatId, album);
    }
    for (const f of files.filter((x) => x.kind === 'video_note')) await bot.sendVideoNote(chatId, f.tg_file_id);
  }

  // Карточка новой претензии всем руководителям звена. Возвращает, скольким ушла.
  async function sendCard(complaintId, { critical, resolutions }) {
    const owners = await ownersOf(complaintId);
    if (!owners.length) return 0;
    const card = await loadCard(complaintId);
    if (!card) return 0;
    const text = formatCard(card.c, critical);
    const kb = ownerKeyboard(complaintId, critical, resolutions);
    let sent = 0;
    for (const o of owners) {
      // Медиа не должно мешать главному: не ушло фото — текст с кнопками всё равно отправляем.
      try { await sendMedia(o.chat_id, card.files); } catch (e) { console.warn('[ЗВЕНО медиа]', e.message); }
      try { await bot.sendMessage(o.chat_id, text, { reply_markup: kb }); sent++; } catch (e) { console.warn('[ЗВЕНО карточка]', e.message); }
    }
    return sent;
  }

  // Короткое сообщение руководителям звена («агент решил», «уже решил такой-то»).
  async function tell(complaintId, text, exceptChatId) {
    const owners = await ownersOf(complaintId);
    for (const o of owners) {
      if (exceptChatId && String(o.chat_id) === String(exceptChatId)) continue;
      await bot.sendMessage(o.chat_id, text).catch((e) => console.warn('[ЗВЕНО сообщение]', e.message));
    }
    return owners.length;
  }

  return { ownersOf, ownerByChat, loadCard, sendCard, tell };
};

module.exports.formatCard = formatCard;
module.exports.ownerKeyboard = ownerKeyboard;
