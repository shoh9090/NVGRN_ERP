// person-link.js — один человек в одном месте: сотрудник Персонала ↔ пользователь ERP.
//
// Решение Шоха (сентябрь 2026): человек заводится ОДИН раз — в Персонале (ФИО,
// отдел, телефон, Trello). Вход в ERP выдаётся из той же карточки кнопкой
// «Выдать доступ»; бот узнаёт человека по телефону, будущий Джарвис берёт права
// из роли пользователя, штрафы и бонусы идут в зарплату сотрудника.
// Связь — hr_employees.erp_user_id (одна учётка на одного сотрудника).
// Телефон ведётся в карточке сотрудника и сам переносится в users.tg_phone,
// по которому работают боты.

const last9 = (v) => String(v || '').replace(/\D/g, '').slice(-9);

// Пары «сотрудник ↔ пользователь» по последним 9 цифрам телефона. Чистая функция.
// Берём только однозначные: номер встречается у одного сотрудника и одного
// пользователя, и ни тот, ни другой ещё ни с кем не связан.
function planPhoneLinks(employees, users) {
  const empBy = new Map();
  for (const e of employees) {
    const p = last9(e.phone);
    if (p.length < 9) continue;
    empBy.set(p, empBy.has(p) ? null : e);         // null — номер у двоих, не угадываем
  }
  const linkedUsers = new Set(employees.filter((e) => e.erp_user_id).map((e) => Number(e.erp_user_id)));
  const userBy = new Map();
  for (const u of users) {
    const p = last9(u.tg_phone);
    if (p.length < 9) continue;
    userBy.set(p, userBy.has(p) ? null : u);
  }
  const out = [];
  for (const [p, e] of empBy) {
    const u = userBy.get(p);
    if (!e || !u || e.erp_user_id || linkedUsers.has(Number(u.id))) continue;
    out.push({ employee_id: e.id, user_id: u.id });
  }
  return out;
}

// Связать по телефону тех, кого можно связать однозначно. Только заполняет
// пустые связи — чужие решения не меняет. Возвращает, сколько связано.
async function autoLinkByPhone(pool) {
  const employees = (await pool.query(
    "SELECT id, phone, erp_user_id FROM hr_employees WHERE status <> 'archived'")).rows;
  const users = (await pool.query(
    "SELECT id, tg_phone FROM users WHERE COALESCE(tg_phone, '') <> ''")).rows;
  let n = 0;
  for (const l of planPhoneLinks(employees, users)) {
    const r = await pool.query(
      `UPDATE hr_employees SET erp_user_id = $1
        WHERE id = $2 AND erp_user_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM hr_employees WHERE erp_user_id = $1)`, [l.user_id, l.employee_id]);
    n += r.rowCount;
  }
  return n;
}

// Телефон сотрудника → телефон его учётки (по нему бот узнаёт человека).
// Не перезаписываем, если этот номер уже у другого пользователя.
async function syncUserPhone(pool, employeeId) {
  const e = (await pool.query('SELECT phone, erp_user_id FROM hr_employees WHERE id = $1', [employeeId])).rows[0];
  if (!e || !e.erp_user_id) return { ok: true, skipped: 'нет учётки' };
  const digits = String(e.phone || '').replace(/\D/g, '');
  if (digits && digits.length < 9) return { ok: false, note: 'Телефон короче 9 цифр — в бот не перенесён' };
  if (digits) {
    const taken = (await pool.query(
      `SELECT full_name FROM users WHERE id <> $1 AND COALESCE(tg_phone, '') <> ''
          AND right(tg_phone, 9) = right($2, 9) LIMIT 1`, [e.erp_user_id, digits])).rows[0];
    if (taken) return { ok: false, note: `Этот номер уже у пользователя «${taken.full_name}» — в бот не перенесён` };
  }
  await pool.query('UPDATE users SET tg_phone = $1 WHERE id = $2', [digits || null, e.erp_user_id]);
  return { ok: true };
}

// При ПРИВЯЗКЕ учётки к сотруднику номера могли быть заведены раньше по-разному.
// Молча перезаписать номер учётки нельзя: бот знает человека именно по нему и
// перестанет узнавать. Поэтому: у сотрудника номера нет — берём из учётки; у
// учётки нет — берём из карточки; оба есть и разные — ничего не трогаем и
// просим выбрать верный. Совпадают — всё хорошо.
async function reconcileOnLink(pool, employeeId) {
  const r = (await pool.query(
    `SELECT e.phone, u.id AS user_id, u.tg_phone FROM hr_employees e JOIN users u ON u.id = e.erp_user_id
      WHERE e.id = $1`, [employeeId])).rows[0];
  if (!r) return { ok: true };
  const ep = last9(r.phone), up = last9(r.tg_phone);
  if (ep && up && ep !== up) {
    const fmt = (d) => '+998 ' + d;
    return { ok: false, note: `Номера разные: в карточке ${fmt(ep)}, в учётке ${fmt(up)} (по нему бот узнаёт человека). Впишите в карточку верный и сохраните.` };
  }
  if (!ep && up) {
    await pool.query('UPDATE hr_employees SET phone = $1 WHERE id = $2', [r.tg_phone, employeeId]);
    return { ok: true };
  }
  return syncUserPhone(pool, employeeId);
}

module.exports = { last9, planPhoneLinks, autoLinkByPhone, syncUserPhone, reconcileOnLink };
