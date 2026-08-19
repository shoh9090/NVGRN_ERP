// server.js — Hub: ядро-лаунчер (Этап 1)
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./src/db');
const { decideFileAccess } = require('./src/file-access');

const app = express();
const PORT = process.env.PORT || 3000;
// P0.2: в production не запускаемся с запасным/слабым JWT_SECRET (им же шифруются пароли интеграций).
const JWT_FALLBACK = 'change-me-in-railway-variables';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
if (IS_PROD && (!process.env.JWT_SECRET || process.env.JWT_SECRET === JWT_FALLBACK || process.env.JWT_SECRET.length < 16)) {
  console.error('[FATAL] Не задан надёжный JWT_SECRET (production). Приложение остановлено. Задайте длинную случайную строку в переменных окружения.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || JWT_FALLBACK;
// За обратным прокси Railway (TLS завершается на прокси) — доверяем X-Forwarded-* для secure-cookie.
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Версия статики: меняется при каждом деплое, поэтому браузер сам подхватывает новые
// js/css и не нужно жать Ctrl+Shift+R. В шаблонах адреса пишем как /static/x.js?v=<%= V %>.
const ASSET_V = process.env.RAILWAY_GIT_COMMIT_SHA
  ? String(process.env.RAILWAY_GIT_COMMIT_SHA).slice(0, 8)
  : String(Date.now());
app.locals.V = ASSET_V;
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// ---------- Аутентификация ----------

function signToken(user) {
  return jwt.sign(
    { id: user.id, login: user.login, name: user.full_name, isAdmin: user.is_admin, isFinance: user.is_finance || false, roles: user.roles },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

async function loadUser(req, res, next) {
  const token = req.cookies.hub_token;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      res.clearCookie('hub_token');
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).send('Доступ только для администратора');
  next();
}

app.use(loadUser);

app.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  const settings = await db.getSettings();
  res.render('login', { settings, error: null });
});

app.post('/login', async (req, res) => {
  const settings = await db.getSettings();
  const { login, password } = req.body;
  const r = await db.pool.query('SELECT * FROM users WHERE login = $1 AND is_active = TRUE', [login]);
  if (r.rows.length === 0) {
    return res.render('login', { settings, error: 'Неверный логин или пароль' });
  }
  const user = r.rows[0];
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) {
    return res.render('login', { settings, error: 'Неверный логин или пароль' });
  }
  const rolesQ = await db.pool.query(
    `SELECT r.id, r.name, r.is_admin, r.is_finance FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
    [user.id]
  );
  const roles = rolesQ.rows;
  const token = signToken({
    id: user.id,
    login: user.login,
    full_name: user.full_name,
    is_admin: roles.some((x) => x.is_admin),
    is_finance: roles.some((x) => x.is_finance),
    roles: roles.map((x) => x.name),
  });
  // secure: req.secure — на https (Railway) кука только по https; на локальном http вход не ломается.
  res.cookie('hub_token', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 12 * 3600 * 1000 });
  await db.log(user.id, 'login');
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie('hub_token');
  res.redirect('/login');
});

// ---------- Лаунчер ----------

// Группировка плиток по разделам. Порядок разделов — заданный, остальное по алфавиту, «Прочее» в конце.
const SECTION_ORDER = ['HoReCa', 'Склад и закуп', 'Финансы', 'Справочники и настройки'];
function groupTiles(rows) {
  const map = new Map();
  for (const t of rows) {
    const sec = (t.section && t.section.trim()) || 'Прочее';
    if (!map.has(sec)) map.set(sec, []);
    map.get(sec).push(t);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a === 'Прочее') return 1;
    if (b === 'Прочее') return -1;
    const ia = SECTION_ORDER.indexOf(a), ib = SECTION_ORDER.indexOf(b);
    const wa = ia === -1 ? 900 : ia, wb = ib === -1 ? 900 : ib;
    return wa !== wb ? wa - wb : a.localeCompare(b, 'ru');
  });
  return keys.map((k) => ({ section: k, tiles: map.get(k) }));
}

app.get('/', requireAuth, async (req, res) => {
  const settings = await db.getSettings();
  let tiles;
  if (req.user.isAdmin) {
    tiles = await db.pool.query('SELECT * FROM tiles WHERE is_visible = TRUE ORDER BY sort_order, id');
  } else {
    const q = await db.pool.query(
      `SELECT DISTINCT t.* FROM tiles t
       JOIN role_tiles rt ON rt.tile_id = t.id
       JOIN user_roles ur ON ur.role_id = rt.role_id
       WHERE ur.user_id = $1 AND t.is_visible = TRUE
       ORDER BY t.sort_order, t.id`,
      [req.user.id]
    );
    let rows = q.rows;
    // Роль «Финансы/Бухгалтерия» всегда видит плитку «Касса» (она ведёт Кассу/Обязательства).
    if (req.user.isFinance && !rows.some((t) => t.url === '/cash')) {
      const ct = await db.pool.query("SELECT * FROM tiles WHERE url = '/cash' AND is_visible = TRUE LIMIT 1");
      if (ct.rows.length) { rows = rows.concat(ct.rows[0]); rows.sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id)); }
    }
    tiles = { rows };
  }
  res.render('launcher', { settings, user: req.user, tiles: tiles.rows, groups: groupTiles(tiles.rows) });
});

// Проверка доступа пользователя к плитке по URL (роль → плитка).
async function userHasTileAccess(userId, url) {
  const r = await db.pool.query(
    `SELECT 1 FROM tiles t
     JOIN role_tiles rt ON rt.tile_id = t.id
     JOIN user_roles ur ON ur.role_id = rt.role_id
     WHERE ur.user_id = $1 AND t.url = $2 LIMIT 1`, [userId, url]);
  return r.rows.length > 0;
}

// Выдача файлов из базы с контролем доступа (P0.1: закрываем анонимный перебор /file/:id).
// В спорных случаях — 404 (не раскрываем существование чужого файла).
app.get('/file/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(404).end();
  const settings = await db.getSettings();
  const isPublicAsset = String(id) === String(settings.logo_file_id) || String(id) === String(settings.bg_file_id);
  let isComplaintMedia = false;
  if (!isPublicAsset && req.user) {
    try {
      const c = await db.pool.query('SELECT 1 FROM tgbot.complaint_files WHERE file_ref = $1 LIMIT 1', [id]);
      isComplaintMedia = c.rows.length > 0;
    } catch (e) { /* схемы претензий может не быть — тогда это не медиа претензии */ }
  }
  const hasComplaintsTile = (isComplaintMedia && req.user && !req.user.isAdmin)
    ? await userHasTileAccess(req.user.id, '/complaints') : false;
  const decision = decideFileAccess({
    isPublicAsset, hasUser: !!req.user, isComplaintMedia,
    isAdmin: !!(req.user && req.user.isAdmin), hasComplaintsTile,
  });
  if (decision === 'deny') return res.status(404).end();
  const r = await db.pool.query('SELECT mime, data FROM files WHERE id = $1', [id]);
  if (r.rows.length === 0) return res.status(404).end();
  res.set('Content-Type', r.rows[0].mime);
  res.set('Cache-Control', isPublicAsset ? 'public, max-age=3600' : 'private, no-store');
  res.send(r.rows[0].data);
});

// Смена собственного пароля
app.post('/me/password', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.redirect('/?msg=short');
  const hash = await bcrypt.hash(password, 10);
  await db.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  await db.log(req.user.id, 'change_own_password');
  res.redirect('/');
});

// ---------- Бот HoReCa (контакты для Telegram-бота) ----------

// Подключаем плитку безопасно: если с ней что-то не так — лаунчер всё равно работает.
try {
  app.use('/tgbot', require('./src/tgbot'));
} catch (e) {
  console.error('[tgbot] Плитка не загрузилась, Hub работает без неё:', e.message);
}

// ---------- Админ-панель ----------

const admin = express.Router();
admin.use(requireAuth, requireAdmin);

async function adminContext(section) {
  const settings = await db.getSettings();
  return { settings, section };
}

// Пользователи
admin.get('/users', async (req, res) => {
  const users = await db.pool.query(
    `SELECT u.*, COALESCE(string_agg(r.name, ', ' ORDER BY r.name), '—') AS role_names,
            COALESCE(array_agg(r.id) FILTER (WHERE r.id IS NOT NULL), '{}') AS role_ids,
            BOOL_OR(COALESCE(r.is_admin, FALSE)) AS is_admin
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id ORDER BY u.id`
  );
  const roles = await db.pool.query('SELECT * FROM roles ORDER BY id');
  res.render('admin/users', { ...(await adminContext('users')), user: req.user, users: users.rows, roles: roles.rows, msg: req.query.msg || '' });
});

admin.post('/users', async (req, res) => {
  const { login, full_name, password } = req.body;
  let roleIds = req.body.role_ids || [];
  if (!Array.isArray(roleIds)) roleIds = [roleIds];
  if (!login || !full_name || !password) return res.redirect('/admin/users');
  const hash = await bcrypt.hash(password, 10);
  try {
    const ins = await db.pool.query(
      'INSERT INTO users (login, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [login.trim(), full_name.trim(), hash]
    );
    for (const rid of roleIds) {
      await db.pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ins.rows[0].id, rid]);
    }
    await db.log(req.user.id, 'create_user', login);
  } catch (e) {
    console.error(e.message);
  }
  res.redirect('/admin/users');
});

admin.post('/users/:id/toggle', async (req, res) => {
  await db.pool.query('UPDATE users SET is_active = NOT is_active WHERE id = $1', [req.params.id]);
  await db.log(req.user.id, 'toggle_user', req.params.id);
  res.redirect('/admin/users');
});

// Удаление пользователя (физическое). Роли снимаются каскадом; ссылки created_by в других
// таблицах — просто числа (не ломаются). Защита: нельзя удалить себя и последнего администратора.
admin.post('/users/:id/delete', async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.user.id) return res.redirect('/admin/users?msg=self_delete');
  const isAdmin = (await db.pool.query(
    'SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.is_admin = TRUE LIMIT 1',
    [targetId])).rows.length > 0;
  if (isAdmin) {
    const others = (await db.pool.query(
      `SELECT COUNT(DISTINCT ur.user_id)::int AS n FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
       WHERE r.is_admin = TRUE AND u.is_active = TRUE AND ur.user_id <> $1`, [targetId])).rows[0].n;
    if (others === 0) return res.redirect('/admin/users?msg=last_admin');
  }
  const info = (await db.pool.query('SELECT login FROM users WHERE id = $1', [targetId])).rows[0];
  if (!info) return res.redirect('/admin/users');
  await db.pool.query('DELETE FROM users WHERE id = $1', [targetId]);
  await db.log(req.user.id, 'delete_user', `${targetId} (${info.login})`);
  res.redirect('/admin/users?msg=user_deleted');
});

admin.post('/users/:id/password', async (req, res) => {
  const { password } = req.body;
  if (password && password.length >= 6) {
    const hash = await bcrypt.hash(password, 10);
    await db.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    await db.log(req.user.id, 'reset_password', req.params.id);
  }
  res.redirect('/admin/users');
});

admin.post('/users/:id/roles', async (req, res) => {
  let roleIds = req.body.role_ids || [];
  if (!Array.isArray(roleIds)) roleIds = [roleIds];
  roleIds = roleIds.map((x) => parseInt(x, 10)).filter(Boolean);
  const targetId = parseInt(req.params.id, 10);
  // Кто из выбранных ролей даёт админ-доступ.
  const adminRoles = (await db.pool.query('SELECT id, name FROM roles WHERE is_admin = TRUE')).rows;
  const adminIds = adminRoles.map((r) => r.id);
  const willBeAdmin = roleIds.some((id) => adminIds.includes(id));
  // Защита от потери доступа: нельзя снять админ-права с себя и нельзя убрать последнего админа.
  if (!willBeAdmin) {
    const wasAdmin = (await db.pool.query(
      'SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.is_admin = TRUE LIMIT 1',
      [targetId])).rows.length > 0;
    if (wasAdmin) {
      if (targetId === req.user.id) return res.redirect('/admin/users?msg=self_admin');
      const others = (await db.pool.query(
        `SELECT COUNT(DISTINCT ur.user_id)::int AS n FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
         WHERE r.is_admin = TRUE AND u.is_active = TRUE AND ur.user_id <> $1`, [targetId])).rows[0].n;
      if (others === 0) return res.redirect('/admin/users?msg=last_admin');
    }
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [targetId]);
    for (const rid of roleIds) {
      await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [targetId, rid]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
  await db.log(req.user.id, 'set_user_roles', `user=${targetId} roles=[${roleIds.join(',')}]${willBeAdmin ? ' (АДМИН-ДОСТУП)' : ''}`);
  res.redirect('/admin/users?msg=roles_saved');
});

// Роли
admin.get('/roles', async (req, res) => {
  const roles = await db.pool.query(
    `SELECT r.*, COALESCE(string_agg(t.title, ', ' ORDER BY t.title), '—') AS tile_names
     FROM roles r
     LEFT JOIN role_tiles rt ON rt.role_id = r.id
     LEFT JOIN tiles t ON t.id = rt.tile_id
     GROUP BY r.id ORDER BY r.id`
  );
  const tiles = await db.pool.query('SELECT * FROM tiles ORDER BY sort_order, id');
  const roleTiles = await db.pool.query('SELECT * FROM role_tiles');
  res.render('admin/roles', {
    ...(await adminContext('roles')),
    user: req.user,
    roles: roles.rows,
    tiles: tiles.rows,
    roleTiles: roleTiles.rows,
  });
});

admin.post('/roles', async (req, res) => {
  const { name } = req.body;
  if (name && name.trim()) {
    try {
      await db.pool.query('INSERT INTO roles (name) VALUES ($1)', [name.trim()]);
      await db.log(req.user.id, 'create_role', name);
    } catch (e) {
      console.error(e.message);
    }
  }
  res.redirect('/admin/roles');
});

// Переключение флага «Финансы/Бухгалтерия» у роли.
admin.post('/roles/:id/finance', async (req, res) => {
  const on = !!req.body.is_finance;
  const r = await db.pool.query('SELECT is_admin FROM roles WHERE id = $1', [req.params.id]);
  if (!r.rows.length || r.rows[0].is_admin) return res.redirect('/admin/roles'); // админ-роль не трогаем
  await db.pool.query('UPDATE roles SET is_finance = $1 WHERE id = $2', [on, req.params.id]);
  await db.log(req.user.id, 'set_role_finance', `${req.params.id} = ${on}`);
  res.redirect('/admin/roles');
});

admin.post('/roles/:id/tiles', async (req, res) => {
  let tileIds = req.body.tile_ids || [];
  if (!Array.isArray(tileIds)) tileIds = [tileIds];
  await db.pool.query('DELETE FROM role_tiles WHERE role_id = $1', [req.params.id]);
  for (const tid of tileIds) {
    await db.pool.query('INSERT INTO role_tiles (role_id, tile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, tid]);
  }
  await db.log(req.user.id, 'set_role_tiles', req.params.id);
  res.redirect('/admin/roles');
});

admin.post('/roles/:id/delete', async (req, res) => {
  const r = await db.pool.query('SELECT is_admin FROM roles WHERE id = $1', [req.params.id]);
  if (r.rows.length && !r.rows[0].is_admin) {
    await db.pool.query('DELETE FROM roles WHERE id = $1', [req.params.id]);
    await db.log(req.user.id, 'delete_role', req.params.id);
  }
  res.redirect('/admin/roles');
});

// Плитки
admin.get('/tiles', async (req, res) => {
  const tiles = await db.pool.query('SELECT * FROM tiles ORDER BY sort_order, id');
  res.render('admin/tiles', { ...(await adminContext('tiles')), user: req.user, tiles: tiles.rows });
});

admin.post('/tiles', async (req, res) => {
  const { title, description, icon, url, sort_order, section } = req.body;
  if (title && url) {
    await db.pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order, section)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [title.trim(), description || '', icon || '🧩', url.trim(), !!req.body.open_new_tab, parseInt(sort_order) || 100, (section || '').trim() || null]
    );
    await db.log(req.user.id, 'create_tile', title);
  }
  res.redirect('/admin/tiles');
});

admin.post('/tiles/:id', async (req, res) => {
  const { title, description, icon, url, sort_order, section } = req.body;
  await db.pool.query(
    `UPDATE tiles SET title=$1, description=$2, icon=$3, url=$4, open_new_tab=$5, sort_order=$6, section=$7 WHERE id=$8`,
    [title.trim(), description || '', icon || '🧩', url.trim(), !!req.body.open_new_tab, parseInt(sort_order) || 100, (section || '').trim() || null, req.params.id]
  );
  await db.log(req.user.id, 'update_tile', req.params.id);
  res.redirect('/admin/tiles');
});

admin.post('/tiles/:id/toggle', async (req, res) => {
  await db.pool.query('UPDATE tiles SET is_visible = NOT is_visible WHERE id = $1', [req.params.id]);
  res.redirect('/admin/tiles');
});

admin.post('/tiles/:id/delete', async (req, res) => {
  await db.pool.query('DELETE FROM tiles WHERE id = $1', [req.params.id]);
  await db.log(req.user.id, 'delete_tile', req.params.id);
  res.redirect('/admin/tiles');
});

// Оформление
admin.get('/appearance', async (req, res) => {
  res.render('admin/appearance', { ...(await adminContext('appearance')), user: req.user });
});

admin.post('/appearance', upload.fields([{ name: 'logo' }, { name: 'bg' }]), async (req, res) => {
  const { company_name, brand_color, bg_dim } = req.body;
  if (company_name) await db.setSetting('company_name', company_name.trim());
  if (brand_color) await db.setSetting('brand_color', brand_color);
  if (bg_dim !== undefined) await db.setSetting('bg_dim', String(Math.min(85, Math.max(0, parseInt(bg_dim) || 0))));

  async function saveFile(field, settingKey) {
    const f = req.files && req.files[field] && req.files[field][0];
    if (!f) return;
    if (!f.mimetype.startsWith('image/')) return;
    const ins = await db.pool.query(
      'INSERT INTO files (name, mime, data) VALUES ($1, $2, $3) RETURNING id',
      [f.originalname, f.mimetype, f.buffer]
    );
    await db.setSetting(settingKey, String(ins.rows[0].id));
  }
  await saveFile('logo', 'logo_file_id');
  await saveFile('bg', 'bg_file_id');

  if (req.body.remove_bg) await db.setSetting('bg_file_id', '');
  if (req.body.remove_logo) await db.setSetting('logo_file_id', '');

  await db.log(req.user.id, 'update_appearance');
  res.redirect('/admin/appearance');
});

// Интеграции
const integrations = require('./src/integrations');

admin.get('/integrations', async (req, res) => {
  const sd = await integrations.getSdConfig();
  sd.password = undefined; // пароль в интерфейс не отдаём
  res.render('admin/integrations', {
    ...(await adminContext('integrations')),
    user: req.user,
    sd,
    message: req.query.msg || '',
    messageType: req.query.t || 'ok',
  });
});

admin.post('/integrations/sd', async (req, res) => {
  await integrations.saveSdConfig(req.body);
  await db.log(req.user.id, 'sd_config_save');
  res.redirect('/admin/integrations?msg=' + encodeURIComponent('Настройки сохранены'));
});

admin.get('/integrations/sd/diag', async (req, res) => {
  try {
    const out = await integrations.diagSD();
    res.type('text/plain; charset=utf-8').send(JSON.stringify(out, null, 2));
  } catch (e) {
    res.type('text/plain; charset=utf-8').status(400).send('Ошибка диагностики: ' + e.message);
  }
});

// Проба режима контрагента (двухуровневая модель SD): включён ли и что отдаёт getContragent.
admin.get('/integrations/sd/contragent', async (req, res) => {
  try {
    const out = await integrations.probeContragent();
    res.type('text/plain; charset=utf-8').send(
      (out.enabled ? '✅ Режим «Контрагент» ВКЛЮЧЁН. Пример getContragent:\n\n' : '⚠️ Режим «Контрагент» ВЫКЛЮЧЕН (обычный сервер) или метод недоступен:\n' + (out.error || '') + '\n\n')
      + JSON.stringify(out.sample || {}, null, 2));
  } catch (e) {
    res.type('text/plain; charset=utf-8').status(400).send('Ошибка пробы: ' + e.message);
  }
});

admin.post('/integrations/sd/test', async (req, res) => {
  try {
    await integrations.saveSdConfig(req.body); // сохраняем то, что в форме, и сразу проверяем
    const auth = await integrations.testConnection();
    res.redirect('/admin/integrations?msg=' + encodeURIComponent('Подключение успешно (userId: ' + auth.userId + ')'));
  } catch (e) {
    res.redirect('/admin/integrations?t=error&msg=' + encodeURIComponent(e.message));
  }
});

// Обслуживание: полная очистка справочников (для повторной загрузки данных)
admin.post('/maintenance/wipe-dictionaries', async (req, res) => {
  if ((req.body.confirm || '').trim().toUpperCase() !== 'ОЧИСТИТЬ') {
    return res.redirect('/admin/integrations?t=error&msg=' + encodeURIComponent('Очистка не выполнена: введите слово ОЧИСТИТЬ для подтверждения'));
  }
  try {
    await db.pool.query(`TRUNCATE ref_prices, ref_raw_materials, ref_finished_goods, ref_packaging,
      ref_counterparties, ref_warehouses, ref_production_areas, ref_cultures, ref_categories,
      ref_units, ref_price_types RESTART IDENTITY CASCADE`);
    await db.seed(); // восстановить базовые единицы, категории с кодами и культуры
    await db.log(req.user.id, 'maintenance_wipe_dictionaries');
    res.redirect('/admin/integrations?msg=' + encodeURIComponent('Справочники очищены. Базовые категории, культуры и единицы восстановлены — можно загружать данные заново.'));
  } catch (e) {
    res.redirect('/admin/integrations?t=error&msg=' + encodeURIComponent('Ошибка очистки: ' + e.message));
  }
});

app.use('/admin', admin);

// ---------- Блок «Справочники» (отдельный модуль ядра) ----------
// Доступ: администратор — всегда; сотрудник — если его роли назначена плитка с адресом /dictionaries

async function requireDictAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.isAdmin) return next();
  const r = await db.pool.query(
    `SELECT 1 FROM tiles t
     JOIN role_tiles rt ON rt.tile_id = t.id
     JOIN user_roles ur ON ur.role_id = rt.role_id
     WHERE ur.user_id = $1 AND t.url IN ('/dictionaries', '/purchase') LIMIT 1`,
    [req.user.id]
  );
  if (r.rows.length === 0) return res.status(403).send('Нет доступа к справочникам. Обратитесь к администратору.');
  next();
}

async function requirePurchaseAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.isAdmin) return next();
  const r = await db.pool.query(
    `SELECT 1 FROM tiles t
     JOIN role_tiles rt ON rt.tile_id = t.id
     JOIN user_roles ur ON ur.role_id = rt.role_id
     WHERE ur.user_id = $1 AND t.url = '/purchase' LIMIT 1`,
    [req.user.id]
  );
  if (r.rows.length === 0) return res.status(403).send('Нет доступа к блоку «Закуп». Обратитесь к администратору.');
  next();
}

// Блок «Закуп»: страница и JSON API
const purchaseRouter = require('./src/purchase');
app.use('/purchase', requirePurchaseAccess, purchaseRouter);

// Блок «Склад сырья»
async function requireStockAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.isAdmin) return next();
  const r = await db.pool.query(
    `SELECT 1 FROM tiles t
     JOIN role_tiles rt ON rt.tile_id = t.id
     JOIN user_roles ur ON ur.role_id = rt.role_id
     WHERE ur.user_id = $1 AND t.url = '/stock' LIMIT 1`,
    [req.user.id]
  );
  if (r.rows.length === 0) return res.status(403).send('Нет доступа к блоку «Склад сырья». Обратитесь к администратору.');
  next();
}
// Фоновая проверка: передачи, не подтверждённые производством > 30 мин → уведомление + статус overdue
async function checkOverdueIssues() {
  try {
    const { notify } = require('./src/notifications');
    const r = await db.pool.query(
      `SELECT pi.id, pi.area FROM production_issues pi
       WHERE pi.status = 'pending' AND pi.created_at < now() - INTERVAL '30 minutes'`
    );
    for (const row of r.rows) {
      await db.pool.query("UPDATE production_issues SET status='overdue' WHERE id=$1", [row.id]);
      const items = await db.pool.query(
        `SELECT COALESCE(rm.name,pk.name) AS name, COALESCE(rm.code,pk.code) AS code, pii.qty
         FROM production_issue_items pii
         LEFT JOIN ref_raw_materials rm ON pii.item_kind='raw' AND rm.id=pii.item_id
         LEFT JOIN ref_packaging pk ON pii.item_kind='packaging' AND pk.id=pii.item_id
         WHERE pii.issue_id=$1`, [row.id]);
      const body = items.rows.map((x) => `${x.name} ${x.code || ''} — ${x.qty}`).join('; ');
      for (const role of ['warehouse', 'manager']) {
        await notify({ role, title: 'Передача не подтверждена производством', body: `${row.area}: ${body}`, kind: 'warning', link: '/stock#issue' });
      }
    }
  } catch (e) { console.error('overdue check:', e.message); }
}
setInterval(checkOverdueIssues, 5 * 60 * 1000); // каждые 5 минут

const stockRouter = require('./src/stock');
app.use('/stock', requireStockAccess, stockRouter);

// Блок «Претензии» — жалобы клиентов, разбор, статистика
async function requireComplaintsAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.isAdmin) return next();
  const r = await db.pool.query(
    `SELECT 1 FROM tiles t
     JOIN role_tiles rt ON rt.tile_id = t.id
     JOIN user_roles ur ON ur.role_id = rt.role_id
     WHERE ur.user_id = $1 AND t.url = '/complaints' LIMIT 1`,
    [req.user.id]
  );
  if (r.rows.length === 0) return res.status(403).send('Нет доступа к блоку «Претензии». Обратитесь к администратору.');
  next();
}
const complaintsRouter = require('./src/complaints');
app.use('/complaints', requireComplaintsAccess, complaintsRouter);

// Блок «Касса» — единый журнал транзакций, ДДС/P&L, остатки кошельков
async function requireCashAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  // Админ и роль «Финансы/Бухгалтерия» имеют доступ к Кассе (и Обязательствам) без отдельной плитки.
  if (req.user.isAdmin || req.user.isFinance) return next();
  const r = await db.pool.query(
    `SELECT 1 FROM tiles t
     JOIN role_tiles rt ON rt.tile_id = t.id
     JOIN user_roles ur ON ur.role_id = rt.role_id
     WHERE ur.user_id = $1 AND t.url = '/cash' LIMIT 1`,
    [req.user.id]
  );
  if (r.rows.length === 0) return res.status(403).send('Нет доступа к блоку «Касса». Обратитесь к администратору.');
  next();
}
const cashRouter = require('./src/cash');
app.use('/cash', requireCashAccess, cashRouter);

// Блок «Калькуляция» — плановая себестоимость по рецептурам, цены сырья, маржа
async function requireCalculationAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.isAdmin) return next();
  const r = await db.pool.query(
    `SELECT 1 FROM tiles t
     JOIN role_tiles rt ON rt.tile_id = t.id
     JOIN user_roles ur ON ur.role_id = rt.role_id
     WHERE ur.user_id = $1 AND t.url = '/calculation' LIMIT 1`,
    [req.user.id]
  );
  if (r.rows.length === 0) return res.status(403).send('Нет доступа к блоку «Калькуляция». Обратитесь к администратору.');
  next();
}
app.use('/calculation', requireCalculationAccess, require('./src/calculation'));

// Старый модуль /costing удалён по ТЗ (перезапуск). Любой старый URL — редирект на /calculation.
app.all(/^\/costing(\/.*)?$/, (req, res) => res.redirect('/calculation'));

// Блок «Персонал» — сотрудники, зарплата, табель
async function requireHrAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.isAdmin) return next();
  const r = await db.pool.query(
    `SELECT 1 FROM tiles t
     JOIN role_tiles rt ON rt.tile_id = t.id
     JOIN user_roles ur ON ur.role_id = rt.role_id
     WHERE ur.user_id = $1 AND t.url = '/hr' LIMIT 1`,
    [req.user.id]
  );
  if (r.rows.length === 0) return res.status(403).send('Нет доступа к блоку «Персонал». Обратитесь к администратору.');
  next();
}
app.use('/hr', requireHrAccess, require('./src/hr'));

// Уведомления (колокольчик) — для всех авторизованных
const notificationsRouter = require('./src/notifications');
app.use('/', requireAuth, notificationsRouter);

const dict = express.Router();
dict.use(requireDictAccess);

dict.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('dictionaries_spa', { settings, user: req.user });
});

app.use('/dictionaries', dict);

// JSON API справочников (раздел 18 ТЗ) — те же права доступа, что и у модуля
const refsRouter = require('./src/refs');
app.use('/api/refs', requireDictAccess, refsRouter);

// Синхронизация готовой продукции с SalesDoctor
app.post('/api/sd/sync/finished-goods', requireDictAccess, async (req, res) => {
  try {
    const result = await integrations.syncFinishedGoods(req.user.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Синхронизация прайс-листов и цен с SalesDoctor
app.post('/api/sd/sync/prices', requireDictAccess, async (req, res) => {
  try {
    const result = await integrations.syncPrices(req.user.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Отпускные цены: матрица товары × прайс-листы (как «Прайс-лист» в SD)
app.get('/api/prices/matrix', requireDictAccess, async (req, res) => {
  const q = (req.query.q || '').trim();
  const catId = parseInt(req.query.category_id) || null;

  const types = await db.pool.query(
    "SELECT id, name, payment_type FROM ref_price_types WHERE status = 'active' ORDER BY name"
  );

  const params = [];
  let where = "g.status = 'active'";
  if (q) {
    params.push('%' + q + '%');
    where += ` AND (g.name ILIKE $${params.length} OR g.barcode ILIKE $${params.length} OR g.code ILIKE $${params.length})`;
  }
  if (catId) {
    params.push(catId);
    where += ` AND g.category_id = $${params.length}`;
  }
  const goods = await db.pool.query(
    `SELECT g.id, g.name, g.barcode, c.name AS category_name
     FROM ref_finished_goods g
     LEFT JOIN ref_categories c ON c.id = g.category_id
     WHERE ${where} ORDER BY g.name`,
    params
  );
  const prices = await db.pool.query('SELECT price_type_id, product_id, price FROM ref_prices');
  const priceMap = {};
  for (const p of prices.rows) {
    (priceMap[p.product_id] = priceMap[p.product_id] || {})[p.price_type_id] = Number(p.price);
  }
  const items = goods.rows.map((g) => ({ ...g, prices: priceMap[g.id] || {} }));
  res.json({ types: types.rows, items });
});

// Отпускные цены: товары с ценой по выбранному прайс-листу
app.get('/api/prices', requireDictAccess, async (req, res) => {
  const typeId = parseInt(req.query.price_type_id);
  if (!typeId) return res.json({ items: [] });
  const q = (req.query.q || '').trim();
  const params = [typeId];
  let qSQL = '';
  if (q) {
    params.push('%' + q + '%');
    qSQL = ` AND (g.name ILIKE $2 OR g.barcode ILIKE $2 OR g.code ILIKE $2)`;
  }
  const rows = await db.pool.query(
    `SELECT g.id, g.name, g.code, g.barcode, c.name AS category_name, p.price, p.last_sync_at
     FROM ref_prices p
     JOIN ref_finished_goods g ON g.id = p.product_id
     LEFT JOIN ref_categories c ON c.id = g.category_id
     WHERE p.price_type_id = $1 AND g.status = 'active'${qSQL}
     ORDER BY g.name`,
    params
  );
  res.json({ items: rows.rows });
});

app.get('/admin', (req, res) => res.redirect('/admin/users'));

// Здоровье сервиса (для Railway)
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- Запуск ----------
(async () => {
  try {
    await db.migrate();
    await db.seed();
    await db.migrateLegacyDicts();
    app.listen(PORT, () => console.log(`Hub запущен на порту ${PORT}`));
  } catch (e) {
    console.error('Ошибка запуска:', e);
    process.exit(1);
  }
})();
