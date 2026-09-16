// user-migration.js — перенос Telegram-сотрудников бота в пользователи ERP.
// План: docs/plan-single-user-list.md (шаги 3–4).
//
// planMigration — чистая функция: по двум спискам решает, кого связать с
// существующим пользователем, кого создать и где конфликт, который человек
// должен решить руками. Шаг 3 только показывает этот план, ничего не пишет.

const WEB_ROLES = new Set(['head_of_sales', 'logistics', 'marketing', 'admin']);

// staff — строки tgbot.telegram_staff; users — строки users;
// names — { agents: {sd_id: имя}, drivers: {sd_id: имя} }.
function planMigration(staff, users, names = { agents: {}, drivers: {} }) {
  const plan = { link: [], create: [], conflicts: [], skipped: 0 };
  const p9 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length > 9 ? d.slice(-9) : d; };
  const active = staff.filter((s) => s.status === 'confirmed');
  plan.skipped = staff.length - active.length;

  // Один номер у двух подтверждённых сотрудников бота — непонятно, кто из них настоящий.
  const byPhone = new Map();
  for (const s of active) { const k = p9(s.phone_normalized); if (k) byPhone.set(k, (byPhone.get(k) || 0) + 1); }
  const usersByPhone = new Map();
  for (const u of users) { const k = p9(u.tg_phone); if (k) usersByPhone.set(k, (usersByPhone.get(k) || []).concat(u)); }

  for (const s of active) {
    const phone = p9(s.phone_normalized);
    const name = (s.role === 'agent' && names.agents[s.crm_agent_id])
      || (s.role === 'expeditor' && names.drivers[s.expeditor_sd_id])
      || [s.telegram_first_name, s.telegram_last_name].filter(Boolean).join(' ')
      || (phone ? '+998' + phone : 'без имени');
    const row = { staff_id: s.id, name, phone, role: s.role, sd_agent_id: s.crm_agent_id || null, sd_expeditor_id: s.expeditor_sd_id || null };

    if (!phone) { plan.conflicts.push({ ...row, why: 'нет телефона — не с чем сопоставить' }); continue; }
    if (byPhone.get(phone) > 1) { plan.conflicts.push({ ...row, why: 'этот номер у нескольких сотрудников бота' }); continue; }
    if (s.role === 'agent' && !s.crm_agent_id) { plan.conflicts.push({ ...row, why: 'агент без привязки к SalesDoctor' }); continue; }
    if (s.role === 'expeditor' && !s.expeditor_sd_id) { plan.conflicts.push({ ...row, why: 'водитель без привязки к SalesDoctor' }); continue; }

    const found = (usersByPhone.get(phone) || []).filter((u) => u.is_active !== false);
    if (found.length > 1) { plan.conflicts.push({ ...row, why: 'этот номер у нескольких пользователей ERP' }); continue; }
    if (found.length === 1) {
      const u = found[0];
      if (u.bot_role && u.bot_role !== s.role) {
        plan.conflicts.push({ ...row, user_id: u.id, user_name: u.full_name, why: `в ERP роль в боте «${u.bot_role}», в боте «${s.role}»` });
        continue;
      }
      plan.link.push({ ...row, user_id: u.id, user_name: u.full_name, web_access: u.web_access !== false });
      continue;
    }
    // Нового создаём без веб-доступа для агентов и водителей; руководителям
    // веб включит админ, если нужен (решение Шоха: опционально).
    plan.create.push({ ...row, web_access: false, suggestLogin: suggestLogin(s, phone), managerRole: WEB_ROLES.has(s.role) });
  }
  return plan;
}

function suggestLogin(s, phone) {
  if (s.role === 'agent' && s.crm_agent_id) return 'agent_' + String(s.crm_agent_id).replace(/\W/g, '');
  if (s.role === 'expeditor' && s.expeditor_sd_id) return 'driver_' + String(s.expeditor_sd_id).replace(/\W/g, '');
  return 'tg_' + phone;
}

module.exports = { planMigration };
