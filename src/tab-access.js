// tab-access.js — доступ по ВКЛАДКАМ внутри плитки.
//
// До этого доступ в Hub был только на уровне плитки: либо человек видит
// «Калькуляцию» целиком, либо не видит вовсе. Продажнику нужна одна вкладка
// «Песочница», а себестоимость по всей компании ему видеть незачем.
//
// Правила, на которых всё держится:
//  1. Ничего не отмечено у роли — доступны ВСЕ вкладки плитки. Так работали
//     все роли до появления этого механизма, и так они продолжают работать,
//     пока никто не полез настраивать. Ни у кого ничего не отвалится само.
//  2. Отмечена хотя бы одна вкладка — видны только отмеченные.
//  3. У человека может быть несколько ролей. Права складываются: если хоть
//     одна роль даёт плитку без ограничения по вкладкам — доступны все.
//     Иначе — объединение отмеченных вкладок.
//  4. Админ видит всё и никогда не ограничивается.
//  5. Проверка идёт В ДВУХ местах: вкладка не рисуется на экране (удобство)
//     и сервер отклоняет запрос к её данным (собственно защита). Одного
//     первого мало — адрес можно набрать руками.
//
// Плитка попадает сюда только когда её вкладки РЕАЛЬНО проверяются на сервере.
// Иначе в настройках роли были бы галочки, которые ничего не значат, — это
// хуже, чем их отсутствие: администратор считал бы, что закрыл доступ.

// Реестр вкладок. Ключ — адрес плитки, как в таблице tiles.
const TAB_REGISTRY = {
  '/calculation': [
    { code: 'summary', name: 'Сводка' },
    { code: 'sandbox', name: 'Песочница' },
    { code: 'production', name: 'Производство' },
    { code: 'packaging', name: 'Упаковка' },
    { code: 'recipes', name: 'Рецептуры' },
    { code: 'retail', name: 'Рознич. тара' },
    { code: 'horeca250', name: 'Хорека 250 г' },
    { code: 'horeca500', name: 'Хорека 500' },
    { code: 'salads', name: 'Салаты' },
    { code: 'bunches', name: 'Пучки и горшки' },
    { code: 'culinary', name: 'Кулинарка' },
    { code: 'cutveg', name: 'Резаные овощи' },
  ],
};

async function ensureTabSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS tile_tabs (
    id SERIAL PRIMARY KEY,
    tile_url TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    sort INTEGER DEFAULT 100,
    UNIQUE (tile_url, code)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS role_tile_tabs (
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    tab_id INTEGER REFERENCES tile_tabs(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, tab_id)
  )`);

  // Сид идемпотентный: переименование вкладки в коде подхватится, а
  // расставленные галочки не потеряются — id вкладки не меняется.
  for (const [url, tabs] of Object.entries(TAB_REGISTRY)) {
    for (let i = 0; i < tabs.length; i++) {
      await pool.query(
        `INSERT INTO tile_tabs (tile_url, code, name, sort) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tile_url, code) DO UPDATE SET name = $3, sort = $4`,
        [url, tabs[i].code, tabs[i].name, (i + 1) * 10]);
    }
  }
}

// Какие вкладки плитки доступны пользователю.
// null — все (ограничения нет). Set кодов — только они.
async function allowedTabs(pool, user, tileUrl) {
  if (!user) return new Set();
  if (user.isAdmin) return null;
  if (!TAB_REGISTRY[tileUrl]) return null;   // плитка ещё не заведена — не ограничиваем

  // Роли этого человека, которые дают саму плитку.
  const roles = (await pool.query(
    `SELECT DISTINCT ur.role_id
       FROM user_roles ur
       JOIN role_tiles rt ON rt.role_id = ur.role_id
       JOIN tiles t ON t.id = rt.tile_id
      WHERE ur.user_id = $1 AND t.url = $2`, [user.id, tileUrl])).rows.map((x) => x.role_id);
  if (!roles.length) return new Set();       // плитки нет вовсе — и вкладок нет

  const rows = (await pool.query(
    `SELECT rtt.role_id, tt.code
       FROM role_tile_tabs rtt
       JOIN tile_tabs tt ON tt.id = rtt.tab_id
      WHERE rtt.role_id = ANY($1) AND tt.tile_url = $2`, [roles, tileUrl])).rows;

  // Хоть одна роль без отметок — значит по ней доступны все вкладки.
  const restricted = new Set(rows.map((x) => x.role_id));
  if (roles.some((id) => !restricted.has(id))) return null;
  return new Set(rows.map((x) => x.code));
}

const tabAllowed = (allowed, code) => allowed === null || (!!code && allowed.has(code));

// Middleware: закрывает маршруты плитки по вкладке. tabOf(req) возвращает код
// вкладки или null, если маршрут общий для всей плитки (тогда пропускаем —
// такие маршруты защищены своими проверками прав).
function requireTab(pool, tileUrl, tabOf) {
  return async function (req, res, next) {
    try {
      // tabOf может ходить в базу (например, чтобы узнать лист товара по id),
      // поэтому ждём результат в любом случае.
      const code = await tabOf(req);
      if (!code) return next();
      const allowed = await allowedTabs(pool, req.user, tileUrl);
      if (tabAllowed(allowed, code)) return next();
      const name = (TAB_REGISTRY[tileUrl] || []).find((t) => t.code === code);
      return res.status(403).json({
        error: 'Нет доступа к вкладке «' + (name ? name.name : code) + '». Обратитесь к администратору.',
      });
    } catch (e) {
      // Сбой проверки не должен ронять плитку целиком — но и пускать нельзя.
      console.error('[ДОСТУП ПО ВКЛАДКАМ]', e.message);
      return res.status(403).json({ error: 'Не удалось проверить доступ к вкладке' });
    }
  };
}

module.exports = { TAB_REGISTRY, ensureTabSchema, allowedTabs, tabAllowed, requireTab };
