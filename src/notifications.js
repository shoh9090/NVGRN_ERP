// notifications.js — уведомления (колокольчик, принцип Trello)
const express = require('express');
const db = require('./db');

const router = express.Router();

// Создать уведомление (вызывается из других модулей)
async function notify({ role = null, userId = null, title, body = '', kind = 'info', link = '' }) {
  try {
    await db.pool.query(
      `INSERT INTO notifications (recipient_role, recipient_user_id, title, body, kind, link)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [role, userId, title, body, kind, link]
    );
  } catch (e) {
    console.error('notify error:', e.message);
  }
}

// Список уведомлений текущего пользователя (по роли или персонально)
router.get('/api/notifications', async (req, res) => {
  const roles = (req.user.roles || []).map((r) => String(r).toLowerCase());
  // сопоставление ролей с адресатами уведомлений
  const recipientRoles = [];
  if (req.user.isAdmin) recipientRoles.push('purchaser', 'manager', 'warehouse');
  if (roles.some((r) => /закуп|purchas/.test(r))) recipientRoles.push('purchaser');
  if (roles.some((r) => /руковод|manager|директор/.test(r))) recipientRoles.push('manager');
  if (roles.some((r) => /склад|warehouse|кладов/.test(r))) recipientRoles.push('warehouse');

  const params = [req.user.id];
  let roleClause = 'recipient_user_id = $1';
  if (recipientRoles.length) {
    params.push(recipientRoles);
    roleClause += ` OR recipient_role = ANY($${params.length})`;
  }
  const r = await db.pool.query(
    `SELECT id, title, body, kind, link, is_read, created_at
     FROM notifications WHERE (${roleClause})
     ORDER BY created_at DESC LIMIT 50`,
    params
  );
  const unread = r.rows.filter((x) => !x.is_read).length;
  res.json({ items: r.rows, unread });
});

router.post('/api/notifications/read', express.json(), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => parseInt(x)).filter(Boolean) : [];
  if (ids.length) {
    await db.pool.query('UPDATE notifications SET is_read = TRUE WHERE id = ANY($1)', [ids]);
  } else {
    // прочитать все доступные пользователю — упрощённо помечаем по id из тела
  }
  res.json({ ok: true });
});

router.post('/api/notifications/read-all', async (req, res) => {
  const roles = (req.user.roles || []).map((r) => String(r).toLowerCase());
  const recipientRoles = [];
  if (req.user.isAdmin) recipientRoles.push('purchaser', 'manager', 'warehouse');
  if (roles.some((r) => /закуп|purchas/.test(r))) recipientRoles.push('purchaser');
  if (roles.some((r) => /руковод|manager|директор/.test(r))) recipientRoles.push('manager');
  if (roles.some((r) => /склад|warehouse|кладов/.test(r))) recipientRoles.push('warehouse');
  const params = [req.user.id];
  let roleClause = 'recipient_user_id = $1';
  if (recipientRoles.length) { params.push(recipientRoles); roleClause += ` OR recipient_role = ANY($${params.length})`; }
  await db.pool.query(`UPDATE notifications SET is_read = TRUE WHERE (${roleClause})`, params);
  res.json({ ok: true });
});

module.exports = router;
module.exports.notify = notify;
