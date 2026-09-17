// driver-sync.js — водители (экспедиторы) в боте сверяются с SalesDoctor.
//
// Зачем водители в боте: они забывают переключить заказ из «Отгружен» в
// «Доставлен», и бот напоминает им об этом (deliveryReminderTick в боте).
// Напоминание уходит только тем, кто есть в Telegram-сотрудниках с ролью
// «экспедитор» и привязкой к водителю SD.
//
// Раньше каждого водителя админ добавлял руками, а уволенный в SD оставался в
// боте. Теперь SalesDoctor — источник правды:
//   • активный водитель SD с телефоном → подтверждённый сотрудник бота
//     (когда он откроет бота и поделится номером, бот его узнает);
//   • неактивный или пропавший из SD → доступ к боту выключается.
// Не удаляем, а выключаем: история напоминаний и доставок остаётся.
// Человека с другой ролью (агент, РОП) не трогаем — одна роль на человека.

// Чистая функция: что сделать с сотрудниками бота по списку водителей SD.
// exps  — [{ sd_id, name, phone9, active }] (всё, что вернул SD);
// staff — строки telegram_staff [{ id, role, status, expeditor_sd_id, phone_normalized }].
// kind — кого сверяем: водителей (по умолчанию) или агентов. Логика одна,
// различаются роль и поле привязки к SalesDoctor.
const KINDS = {
  expeditor: { role: 'expeditor', link: 'expeditor_sd_id' },
  agent: { role: 'agent', link: 'crm_agent_id' },
};
function planDriverStaff(exps, staff, kind = 'expeditor') {
  const { role, link } = KINDS[kind];
  const plan = { create: [], enable: [], relink: [], disable: [], noPhone: [], conflict: [] };
  const activeIds = new Set(exps.filter((e) => e.active).map((e) => e.sd_id));
  const taken = new Set(); // строки, которые уже получили действие, — чтобы не привязать одну к двум водителям

  for (const e of exps) {
    if (!e.active) continue;
    const byLink = staff.find((s) => s[link] === e.sd_id && s.role === role);
    if (byLink) {
      taken.add(byLink.id);
      if (byLink.status !== 'confirmed') plan.enable.push({ id: byLink.id, sd_id: e.sd_id, name: e.name });
      continue;
    }
    if (!e.phone9) { plan.noPhone.push({ sd_id: e.sd_id, name: e.name }); continue; }
    const byPhone = staff.find((s) => s.phone_normalized === e.phone9 && !taken.has(s.id));
    if (byPhone) {
      const free = !byPhone.role || byPhone.role === role || byPhone.status === 'new_request';
      if (free) { taken.add(byPhone.id); plan.relink.push({ id: byPhone.id, sd_id: e.sd_id, name: e.name }); }
      else plan.conflict.push({ id: byPhone.id, sd_id: e.sd_id, name: e.name, role: byPhone.role });
      continue;
    }
    plan.create.push({ sd_id: e.sd_id, name: e.name, phone9: e.phone9 });
  }

  for (const s of staff) {
    if (s.role !== role || !s[link] || taken.has(s.id)) continue;
    if (!activeIds.has(s[link]) && s.status === 'confirmed') plan.disable.push({ id: s.id, sd_id: s[link] });
  }
  return plan;
}

// Применить к базе. Возвращает сводку для сообщения админу.
async function applyDriverStaff(pool, exps, kind = 'expeditor') {
  const { role, link } = KINDS[kind];
  const other = kind === 'agent' ? 'expeditor_sd_id' : 'crm_agent_id';
  const who = kind === 'agent' ? 'агент' : 'водитель';
  const staff = (await pool.query(
    `SELECT id, role, status, expeditor_sd_id, crm_agent_id, phone_normalized FROM tgbot.telegram_staff`)).rows;
  const plan = planDriverStaff(exps, staff, kind);
  for (const x of plan.create) {
    await pool.query(
      `INSERT INTO tgbot.telegram_staff (phone_normalized, role, ${link}, status, confirmed_by, confirmed_at, comment)
       VALUES ($1, $3, $2, 'confirmed', 'SalesDoctor', now(), $4)`,
      [x.phone9, x.sd_id, role, `Добавлен автоматически: активный ${who} в SalesDoctor`]);
  }
  for (const x of plan.enable.concat(plan.relink)) {
    await pool.query(
      `UPDATE tgbot.telegram_staff SET role='${role}', ${link}=$1, ${other}=NULL, status='confirmed',
         confirmed_by=COALESCE(confirmed_by, 'SalesDoctor'), confirmed_at=COALESCE(confirmed_at, now()),
         disabled_at=NULL, updated_at=now() WHERE id=$2`, [x.sd_id, x.id]);
  }
  for (const x of plan.disable) {
    await pool.query(
      `UPDATE tgbot.telegram_staff SET status='disabled', disabled_at=now(), updated_at=now(),
         comment=$2 WHERE id=$1`, [x.id, `Отключён автоматически: ${who} нет среди активных в SalesDoctor`]);
  }
  return {
    total: exps.length,
    active: exps.filter((e) => e.active).length,
    created: plan.create.length,
    enabled: plan.enable.length + plan.relink.length,
    disabled: plan.disable.length,
    noPhone: plan.noPhone.map((x) => x.name),
    conflict: plan.conflict.map((x) => x.name),
  };
}

// Сводка по-человечески — для сообщения после кнопки «Загрузить экспедиторов».
function describe(r, kind = 'expeditor') {
  const parts = [`${kind === 'agent' ? 'Агентов' : 'Водителей'} в SalesDoctor: ${r.total}, активных: ${r.active}.`];
  const acts = [];
  if (r.created) acts.push(`добавлено в бот: ${r.created}`);
  if (r.enabled) acts.push(`включено: ${r.enabled}`);
  if (r.disabled) acts.push(`отключено (нет среди активных в SD): ${r.disabled}`);
  parts.push(acts.length ? acts.join(', ') + '.' : 'Изменений в боте нет.');
  if (r.noPhone.length) parts.push(`Без телефона в SD — бот их не узнает: ${r.noPhone.join(', ')}.`);
  if (r.conflict.length) parts.push(`Номер уже занят сотрудником с другой ролью: ${r.conflict.join(', ')}.`);
  return parts.join(' ');
}

module.exports = { planDriverStaff, applyDriverStaff, describe };
