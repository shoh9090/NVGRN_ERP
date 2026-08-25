// obligation-reminders.js — генерирует напоминания о платежах по обязательствам
// в общий колокольчик (таблица notifications). Адресат — роль 'finance' (её видят
// админ и роль «Финансы/Бухгалтерия»). Идемпотентно: на каждый платёж графика —
// не более одного «скоро» и одного «просрочено» (dedup_key). Когда платёж погашен —
// связанные напоминания помечаются прочитанными, чтобы бейдж не «висел».
const db = require('./db');

const DUE_SOON_DAYS = 3; // за сколько дней предупреждать

const ruDate = (d) => { try { return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return String(d); } };
const fmtMoney = (v, cur) => (cur === 'USD'
  ? '$' + Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
  : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' сум');

// Остаток по каждому платежу графика активных обязательств, у которых срок близко/прошёл.
const REMAINING_SQL = `
  WITH paid AS (
    SELECT schedule_id, SUM(COALESCE(principal_paid,0)+COALESCE(interest_paid,0)+COALESCE(fee_paid,0)) AS paid
    FROM finance_obligation_payment_links
    WHERE reversed_at IS NULL AND schedule_id IS NOT NULL
    GROUP BY schedule_id
  )
  SELECT s.id, s.due_date, s.total_due, o.creditor_name, o.currency,
         (s.due_date < CURRENT_DATE) AS is_overdue,
         (s.due_date - CURRENT_DATE) AS days_left,
         (COALESCE(s.total_due,0) - COALESCE(p.paid,0)) AS remaining
  FROM finance_obligation_schedule s
  JOIN finance_obligations o ON o.id = s.obligation_id
  LEFT JOIN paid p ON p.schedule_id = s.id
  WHERE o.status = 'active'
    AND COALESCE(s.status,'planned') NOT IN ('paid','cancelled')
    AND s.due_date IS NOT NULL
    AND s.due_date <= CURRENT_DATE + ($1::int || ' days')::interval
`;

async function ensureObligationReminders(pool = db.pool) {
  try {
    const { rows } = await pool.query(REMAINING_SQL, [DUE_SOON_DAYS]);
    for (const r of rows) {
      const remaining = Number(r.remaining);
      if (remaining <= 0.01) continue;
      const amount = fmtMoney(remaining, r.currency);
      let dedup, title, body, kind;
      if (r.is_overdue) {
        dedup = 'obl_overdue:' + r.id;
        kind = 'warning';
        title = 'Просрочен платёж: ' + r.creditor_name;
        body = 'Срок ' + ruDate(r.due_date) + ' прошёл. Остаток ' + amount + '. Оплатите через Кассу → Обязательства.';
      } else {
        dedup = 'obl_due:' + r.id;
        kind = 'info';
        const dl = Number(r.days_left);
        const when = dl <= 0 ? 'сегодня' : ('через ' + dl + ' дн. (' + ruDate(r.due_date) + ')');
        title = 'Скоро платёж: ' + r.creditor_name;
        body = when + ' — ' + amount + '. Касса → Обязательства.';
      }
      // Адресуем плиткой «Касса»: напоминание увидят все, у кого есть к ней доступ.
      // recipient_role оставляем для совместимости со старыми записями.
      await pool.query(
        `INSERT INTO notifications (recipient_role, tile_url, title, body, kind, link, dedup_key)
         VALUES ('finance', '/cash', $1, $2, $3, '/cash', $4)
         ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`,
        [title, body, kind, dedup]
      );
    }
    // Погашенные/отменённые платежи — снимаем «непрочитанность» связанных напоминаний.
    await pool.query(`
      UPDATE notifications n SET is_read = TRUE
      WHERE n.is_read = FALSE
        AND n.dedup_key ~ '^obl_(due|overdue):[0-9]+$'
        AND NOT EXISTS (
          WITH paid AS (
            SELECT schedule_id, SUM(COALESCE(principal_paid,0)+COALESCE(interest_paid,0)+COALESCE(fee_paid,0)) AS paid
            FROM finance_obligation_payment_links
            WHERE reversed_at IS NULL AND schedule_id IS NOT NULL
            GROUP BY schedule_id
          )
          SELECT 1 FROM finance_obligation_schedule s
          LEFT JOIN paid p ON p.schedule_id = s.id
          WHERE s.id::text = split_part(n.dedup_key, ':', 2)
            AND COALESCE(s.status,'planned') NOT IN ('paid','cancelled')
            AND (COALESCE(s.total_due,0) - COALESCE(p.paid,0)) > 0.01
        )
    `);
  } catch (e) {
    console.error('obligation-reminders:', e.message);
  }
}

module.exports = { ensureObligationReminders };
