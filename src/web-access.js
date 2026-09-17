// web-access.js — кто может работать в веб-версии ERP и с какими правами.
//
// В одном списке пользователей и те, кому нужен только Telegram-бот
// (web_access = false): им нельзя войти в ERP, даже зная логин.
//
// Сессия хранится в cookie (JWT на 12 часов) и в базу на каждом запросе не смотрит.
// Раньше из-за этого права в cookie жили до конца сессии: удалённый пользователь,
// снятая роль администратора/финансов или сменённый пароль не действовали до
// 12 часов (аудит A02). Теперь держим в памяти актуальный снимок пользователей
// и их ролей, обновляем раз в минуту и сразу после правки в Админ-панели,
// и на каждом запросе берём права из снимка, а не из cookie.
const crypto = require('crypto');

let live = null;   // Map id → { active, web, pv, isAdmin, isFinance, roles }; null — ещё не загрузили
let pool = null;

// Отпечаток пароля: меняется при смене пароля, сам пароль/хеш в cookie не попадает.
function passwordVersion(hash) {
  return hash ? crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 12) : null;
}

async function refresh() {
  if (!pool) return live;
  const q = (webCol) => pool.query(
    `SELECT u.id, u.is_active, ${webCol} AS web, u.password_hash,
            COALESCE(bool_or(r.is_admin), false) AS is_admin,
            COALESCE(bool_or(r.is_finance), false) AS is_finance,
            COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      GROUP BY u.id`);
  try {
    let r;
    try { r = await q('COALESCE(u.web_access, TRUE)'); }
    catch (e) { r = await q('TRUE'); }                 // колонки web_access ещё нет (миграция не прошла)
    const m = new Map();
    for (const x of r.rows) {
      m.set(Number(x.id), {
        active: x.is_active !== false, web: x.web !== false, pv: passwordVersion(x.password_hash),
        isAdmin: !!x.is_admin, isFinance: !!x.is_finance, roles: x.roles || [],
      });
    }
    live = m;
  } catch (e) { /* база недоступна — оставляем прошлый снимок */ }
  return live;
}

function init(p) {
  pool = p;
  refresh();
  setInterval(refresh, 60 * 1000).unref();
}

// Пользователь из cookie → пользователь с актуальными правами, или null, если сессию
// пускать нельзя. Чистая функция — проверяется тестом.
function liveUser(tokenUser, liveMap = live) {
  if (!tokenUser || tokenUser.id == null) return null;
  if (!liveMap) return tokenUser;                      // снимок ещё не загружен (первые секунды после старта)
  const u = liveMap.get(Number(tokenUser.id));
  if (!u) return null;                                 // пользователя удалили
  if (!u.active || !u.web) return null;                // отключён или только бот
  if (tokenUser.pv && tokenUser.pv !== u.pv) return null; // пароль сменили после входа
  return { ...tokenUser, isAdmin: u.isAdmin, isFinance: u.isFinance, roles: u.roles };
}

// При входе: пароль уже проверен. Что ответить.
function loginVerdict(userRow) {
  if (userRow && userRow.web_access === false) {
    return 'У этого сотрудника нет доступа к веб-версии ERP — он работает только в Telegram-боте.';
  }
  return null;
}

module.exports = { init, refresh, liveUser, loginVerdict, passwordVersion };
