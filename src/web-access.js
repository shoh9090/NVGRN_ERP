// web-access.js — кто может работать в веб-версии ERP.
//
// В одном списке пользователей теперь и те, кому нужен только Telegram-бот
// (агенты, водители): web_access = false. Им нельзя войти в ERP, даже зная логин.
//
// Сессия хранится в cookie и в базу на каждом запросе не смотрит. Поэтому
// отключённый человек (или тот, у кого сняли веб-доступ) работал со старой
// сессией до её истечения. Держим в памяти список закрытых id и обновляем его
// раз в минуту и сразу после правки пользователя в Админ-панели.
let blocked = new Set();
let pool = null;

async function refresh() {
  if (!pool) return blocked;
  try {
    const r = await pool.query('SELECT id FROM users WHERE is_active = FALSE OR web_access = FALSE');
    blocked = new Set(r.rows.map((x) => Number(x.id)));
  } catch (e) { /* колонки ещё нет (миграция не прошла) — никого не закрываем */ }
  return blocked;
}

function init(p) {
  pool = p;
  refresh();
  setInterval(refresh, 60 * 1000).unref();
}

// Пускать ли сессию. Чистая функция — проверяется тестом.
function sessionAllowed(user, blockedIds = blocked) {
  return !!(user && user.id != null && !blockedIds.has(Number(user.id)));
}

// При входе: пароль уже проверен. Что ответить.
function loginVerdict(userRow) {
  if (userRow && userRow.web_access === false) {
    return 'У этого сотрудника нет доступа к веб-версии ERP — он работает только в Telegram-боте.';
  }
  return null;
}

module.exports = { init, refresh, sessionAllowed, loginVerdict };
