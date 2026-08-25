// notifications.js — уведомления (колокольчик, принцип Trello)
const express = require('express');
const db = require('./db');
const { ensureObligationReminders } = require('./obligation-reminders');

const router = express.Router();

// Генерация напоминаний о платежах — не чаще раза в ~минуту (колокольчик опрашивает часто).
let lastReminderRun = 0;
async function refreshReminders() {
  if (Date.now() - lastReminderRun < 55000) return;
  lastReminderRun = Date.now();
  await ensureObligationReminders();
}

// Создать уведомление (вызывается из других модулей).
// tile — url плитки ('/cash', '/stock', '/purchase'): уведомление увидят все, у кого есть
// доступ к этой плитке. Это надёжнее адресации по названию роли: роли называют по-разному,
// а права в системе и так раздаются плитками.
async function notify({ role = null, userId = null, tile = null, title, body = '', kind = 'info', link = '' }) {
  try {
    await db.pool.query(
      `INSERT INTO notifications (recipient_role, recipient_user_id, tile_url, title, body, kind, link)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [role, userId, tile, title, body, kind, link]
    );
  } catch (e) {
    console.error('notify error:', e.message);
  }
}

// Плитки, доступные пользователю (админу — все). По ним решаем, что показывать в колокольчике.
async function userTiles(user) {
  if (!user) return [];
  if (user.isAdmin) return (await db.pool.query('SELECT url FROM tiles')).rows.map((r) => r.url);
  const r = await db.pool.query(
    `SELECT DISTINCT t.url FROM tiles t
       JOIN role_tiles rt ON rt.tile_id = t.id
       JOIN user_roles ur ON ur.role_id = rt.role_id
      WHERE ur.user_id = $1`, [user.id]);
  return r.rows.map((x) => x.url);
}

// Список уведомлений текущего пользователя (по роли или персонально)
router.get('/api/notifications', async (req, res) => {
  await refreshReminders();
  const roles = (req.user.roles || []).map((r) => String(r).toLowerCase());
  // сопоставление ролей с адресатами уведомлений
  const recipientRoles = [];
  if (req.user.isAdmin) recipientRoles.push('purchaser', 'manager', 'warehouse', 'finance');
  if (req.user.isFinance) recipientRoles.push('finance');
  if (roles.some((r) => /закуп|purchas/.test(r))) recipientRoles.push('purchaser');
  if (roles.some((r) => /руковод|manager|директор/.test(r))) recipientRoles.push('manager');
  if (roles.some((r) => /склад|warehouse|кладов/.test(r))) recipientRoles.push('warehouse');
  if (roles.some((r) => /финанс|бухгалт|finance/.test(r))) recipientRoles.push('finance');

  const params = [req.user.id];
  let roleClause = 'recipient_user_id = $1';
  if (recipientRoles.length) {
    params.push(recipientRoles);
    roleClause += ` OR recipient_role = ANY($${params.length})`;
  }
  // Уведомления с указанной плиткой видит тот, у кого есть доступ к этой плитке.
  const tiles = await userTiles(req.user);
  if (tiles.length) {
    params.push(tiles);
    roleClause += ` OR tile_url = ANY($${params.length})`;
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
  if (req.user.isAdmin) recipientRoles.push('purchaser', 'manager', 'warehouse', 'finance');
  if (req.user.isFinance) recipientRoles.push('finance');
  if (roles.some((r) => /закуп|purchas/.test(r))) recipientRoles.push('purchaser');
  if (roles.some((r) => /руковод|manager|директор/.test(r))) recipientRoles.push('manager');
  if (roles.some((r) => /склад|warehouse|кладов/.test(r))) recipientRoles.push('warehouse');
  if (roles.some((r) => /финанс|бухгалт|finance/.test(r))) recipientRoles.push('finance');
  const params = [req.user.id];
  let roleClause = 'recipient_user_id = $1';
  if (recipientRoles.length) { params.push(recipientRoles); roleClause += ` OR recipient_role = ANY($${params.length})`; }
  await db.pool.query(`UPDATE notifications SET is_read = TRUE WHERE (${roleClause})`, params);
  res.json({ ok: true });
});

module.exports = router;
module.exports.notify = notify;
