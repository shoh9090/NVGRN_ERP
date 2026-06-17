// server.js — Hub: ядро-лаунчер (Этап 1)
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-railway-variables';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, 'public')));

// ---------- Аутентификация ----------

function signToken(user) {
  return jwt.sign(
    { id: user.id, login: user.login, name: user.full_name, isAdmin: user.is_admin, roles: user.roles },
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
    `SELECT r.id, r.name, r.is_admin FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
    [user.id]
  );
  const roles = rolesQ.rows;
  const token = signToken({
    id: user.id,
    login: user.login,
    full_name: user.full_name,
    is_admin: roles.some((x) => x.is_admin),
    roles: roles.map((x) => x.name),
  });
  res.cookie('hub_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 });
  await db.log(user.id, 'login');
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie('hub_token');
  res.redirect('/login');
});

// ---------- Лаунчер ----------

app.get('/', requireAuth, async (req, res) => {
  const settings = await db.getSettings();
  let tiles;
  if (req.user.isAdmin) {
    tiles = await db.pool.query('SELECT * FROM tiles WHERE is_visible = TRUE ORDER BY sort_order, id');
  } else {
    tiles = await db.pool.query(
      `SELECT DISTINCT t.* FROM tiles t
       JOIN role_tiles rt ON rt.tile_id = t.id
       JOIN user_roles ur ON ur.role_id = rt.role_id
       WHERE ur.user_id = $1 AND t.is_visible = TRUE
       ORDER BY t.sort_order, t.id`,
      [req.user.id]
    );
  }
  res.render('launcher', { settings, user: req.user, tiles: tiles.rows });
});

// Выдача загруженных файлов (логотип, фон) из базы
app.get('/file/:id', async (req, res) => {
  const r = await db.pool.query('SELECT mime, data FROM files WHERE id = $1', [req.params.id]);
  if (r.rows.length === 0) return res.status(404).end();
  res.set('Content-Type', r.rows[0].mime);
  res.set('Cache-Control', 'public, max-age=3600');
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
    `SELECT u.*, COALESCE(string_agg(r.name, ', ' ORDER BY r.name), '—') AS role_names
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id ORDER BY u.id`
  );
  const roles = await db.pool.query('SELECT * FROM roles ORDER BY id');
  res.render('admin/users', { ...(await adminContext('users')), user: req.user, users: users.rows, roles: roles.rows });
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
  await db.pool.query('DELETE FROM user_roles WHERE user_id = $1', [req.params.id]);
  for (const rid of roleIds) {
    await db.pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, rid]);
  }
  await db.log(req.user.id, 'set_user_roles', req.params.id);
  res.redirect('/admin/users');
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
  const { title, description, icon, url, sort_order } = req.body;
  if (title && url) {
    await db.pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [title.trim(), description || '', icon || '🧩', url.trim(), !!req.body.open_new_tab, parseInt(sort_order) || 100]
    );
    await db.log(req.user.id, 'create_tile', title);
  }
  res.redirect('/admin/tiles');
});

admin.post('/tiles/:id', async (req, res) => {
  const { title, description, icon, url, sort_order } = req.body;
  await db.pool.query(
    `UPDATE tiles SET title=$1, description=$2, icon=$3, url=$4, open_new_tab=$5, sort_order=$6 WHERE id=$7`,
    [title.trim(), description || '', icon || '🧩', url.trim(), !!req.body.open_new_tab, parseInt(sort_order) || 100, req.params.id]
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
