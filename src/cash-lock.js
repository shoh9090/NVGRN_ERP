// cash-lock.js — замок закрытого периода Кассы для других модулей (HR и т. п.).
//
// Касса хранит одну дату «закрыто по … включительно» (settings.cash_locked_until).
// Сама Касса проверяет её у себя (lockError в cash.js), но деньги в Кассу пишут и
// другие плитки — например, выплаты зарплаты наличными из HR. Раньше они замок
// Кассы не проверяли, и закрытый август можно было изменить через HR (аудит A04).

async function cashLockedUntil(pool) {
  const r = await pool.query("SELECT value FROM settings WHERE key = 'cash_locked_until'");
  const v = r.rows[0] && String(r.rows[0].value);
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// Текст ошибки, если хоть одна дата попадает в закрытый период Кассы, иначе null.
function lockErrorFor(lock, dates) {
  if (!lock) return null;
  for (const d of dates) {
    if (d && String(d).slice(0, 10) <= lock) {
      return `Касса закрыта по ${lock.split('-').reverse().join('.')} — денежные операции за закрытые месяцы менять нельзя. Откройте месяц в Кассе, если правка действительно нужна.`;
    }
  }
  return null;
}

async function cashLockError(pool, ...dates) {
  return lockErrorFor(await cashLockedUntil(pool), dates);
}

module.exports = { cashLockedUntil, cashLockError, lockErrorFor };
