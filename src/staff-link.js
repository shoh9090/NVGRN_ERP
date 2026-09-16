// staff-link.js — один человек в двух списках: Telegram-сотрудники бота
// (плитка «Бот HoReCa») и пользователи ERP (Админ-панель → Пользователи).
//
// Бот узнаёт сотрудника по номеру: сперва ищет среди Telegram-сотрудников и,
// найдя, дальше не смотрит. Поэтому у того же человека в карточке ERP чат с
// ботом оставался пустым («ждём в боте»), хотя он давно подключён — и личные
// сообщения по претензиям ему бы не ушли.
//
// Здесь связываем по номеру телефона: подключён к боту в одном списке — чат
// проставляется и во втором. Запускается при открытии списка пользователей
// и в фоне вместе со сверкой водителей.
async function linkStaffChats(pool) {
  const r = await pool.query(
    `UPDATE users u SET tg_chat_id = s.telegram_chat_id
       FROM tgbot.telegram_staff s
      WHERE s.status = 'confirmed' AND s.telegram_chat_id IS NOT NULL
        AND COALESCE(s.phone_normalized, '') <> ''
        AND COALESCE(u.tg_phone, '') <> '' AND right(u.tg_phone, 9) = s.phone_normalized
        AND u.tg_chat_id IS DISTINCT FROM s.telegram_chat_id`);
  return r.rowCount || 0;
}

module.exports = { linkStaffChats };
