// hub-staff.js — сотрудники из ERP, которых бот узнаёт по телефону.
//
// Это не telegram_staff (агенты, РОП, логистика — их заводят в плитке бота),
// а пользователи Hub: у них в Админ-панели → Пользователи указан «Телефон
// (Telegram)». Номер внёс админ — значит, доступ выдан, заявка не нужна.
//
// Когда сотрудник делится номером, бот запоминает его чат в карточке
// пользователя (public.users.tg_chat_id): иначе бот не может написать первым.
// Отсюда же бот узнаёт, кому слать претензии по звену (роль ERP звена).
//
// Все запросы терпят отсутствие колонок: бот может подняться раньше, чем Hub
// успеет добавить их в базу, — тогда он просто ведёт себя как раньше.
// Роли руководителей, которые задаются в ERP. Агенты и водители — только в плитке бота.
const MANAGER_ROLES = new Set(['head_of_sales', 'logistics', 'marketing', 'admin']);

module.exports = function hubStaff(db) {
  const USER_SQL = `
    SELECT u.id, u.full_name, u.tg_chat_id,
           -- Роль в боте — из ролей ERP. Если их несколько, берём старшую.
           (SELECT r2.bot_role FROM public.user_roles ur2 JOIN public.roles r2 ON r2.id = ur2.role_id
             WHERE ur2.user_id = u.id AND r2.bot_role IS NOT NULL
             ORDER BY CASE r2.bot_role WHEN 'admin' THEN 1 WHEN 'head_of_sales' THEN 2 WHEN 'logistics' THEN 3 ELSE 4 END
             LIMIT 1) AS bot_role,
           COALESCE(string_agg(r.name, ', ' ORDER BY r.name), '') AS roles
      FROM public.users u
      LEFT JOIN public.user_roles ur ON ur.user_id = u.id
      LEFT JOIN public.roles r ON r.id = ur.role_id
     WHERE u.is_active AND COALESCE(u.tg_phone, '') <> '' AND %WHERE%
     GROUP BY u.id
     LIMIT 1`;

  async function one(where, params) {
    try {
      const r = await db.query(USER_SQL.replace('%WHERE%', where), params);
      return r.rows[0] || null;
    } catch (e) {
      return null;
    }
  }

  return {
    // По последним 9 цифрам — так бот сравнивает номера везде.
    byPhone9: (phone9) => (phone9 ? one('right(u.tg_phone, 9) = $1', [String(phone9)]) : Promise.resolve(null)),
    byChat: (chatId) => (chatId ? one('u.tg_chat_id = $1', [chatId]) : Promise.resolve(null)),
    // Чаты руководителей с этой «Ролью в боте» (подключённые к боту).
    async chatsByRole(role) {
      try {
        const r = await db.query(
          `SELECT DISTINCT u.tg_chat_id AS chat_id FROM public.users u
            WHERE u.is_active AND u.tg_chat_id IS NOT NULL AND COALESCE(u.tg_phone, '') <> ''
              AND EXISTS (SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
                           WHERE ur.user_id = u.id AND r.bot_role = $1)`, [role]);
        return r.rows.map((x) => x.chat_id);
      } catch (e) { return []; }
    },
    async rememberChat(userId, chatId) {
      try { await db.query('UPDATE public.users SET tg_chat_id = $1 WHERE id = $2', [chatId, userId]); return true; }
      catch (e) { return false; }
    },
  };
};
module.exports.MANAGER_ROLES = MANAGER_ROLES;
