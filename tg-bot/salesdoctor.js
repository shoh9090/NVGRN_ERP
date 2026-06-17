// Общение с SalesDoctor API V2.
// Все запросы — POST на /api/v2, тип операции задаётся полем method.
// Токен получаем через login и храним в базе, чтобы не логиниться на каждый запрос.

const db = require("./db");

const SD_URL = process.env.SD_API_URL || "https://novagreen.salesdoc.io/api/v2";
const SD_LOGIN = process.env.SD_LOGIN;
const SD_PASSWORD = process.env.SD_PASSWORD;

// Низкоуровневый POST. Возвращает разобранный JSON (или сырой текст, если не JSON).
async function post(body) {
  const res = await fetch(SD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

// Вход. Сохраняет userId и token в базу и возвращает их.
async function login() {
  if (!SD_LOGIN || !SD_PASSWORD) {
    throw new Error("Нет SD_LOGIN / SD_PASSWORD в настройках.");
  }
  const r = await post({ method: "login", auth: { login: SD_LOGIN, password: SD_PASSWORD } });
  // SalesDoctor отвечает в формате { status: true, result: { userId, token } }.
  const data = (r.json && (r.json.result || r.json.data || r.json)) || {};
  const userId = data.userId || data.userid || data.user_id;
  const token = data.token;
  if (!userId || !token) {
    throw new Error("Вход не дал userId/token. Ответ: " + JSON.stringify(r.json).slice(0, 600));
  }
  await db.query(
    `INSERT INTO api_tokens (id, user_id, token, updated_at)
       VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET user_id = $1, token = $2, updated_at = now()`,
    [userId, token]
  );
  return { userId, token };
}

// Берём сохранённый токен; если его нет — логинимся.
async function getAuth() {
  const r = await db.query(`SELECT user_id, token FROM api_tokens WHERE id = 1`);
  if (r.rows.length) return { userId: r.rows[0].user_id, token: r.rows[0].token };
  return login();
}

// Похоже ли на ошибку токена (точный формат уточним по логам).
function looksLikeAuthError(r) {
  if (r.status === 401 || r.status === 403) return true;
  const s = JSON.stringify(r.json || "").toLowerCase();
  return s.includes("token") && (s.includes("invalid") || s.includes("expire") || s.includes("auth"));
}

// Универсальный вызов метода. При ошибке токена — один повторный вход и один повтор.
async function call(method, params = {}, data = undefined) {
  let auth = await getAuth();
  const build = () => {
    const body = { method, auth: { userId: auth.userId, token: auth.token } };
    if (params) body.params = params;
    if (data) body.data = data;
    return body;
  };
  let r = await post(build());
  if (looksLikeAuthError(r)) {
    // Повторный login может обнулить старый токен — поэтому делаем его только при необходимости.
    auth = await login();
    r = await post(build());
  }
  return r.json;
}

// Достаёт массив записей из ответа (result лежит под ключом-сущностью: client/order/...).
function listFrom(resp) {
  const res = resp && resp.result;
  if (!res) return [];
  if (Array.isArray(res)) return res;
  for (const k of Object.keys(res)) {
    if (Array.isArray(res[k])) return res[k];
  }
  return [];
}

// Постранично собирает все записи метода.
async function fetchAll(method, params = {}, pageLimit = 200, maxPages = 50) {
  let page = 1;
  let all = [];
  while (page <= maxPages) {
    const resp = await call(method, { ...params, limit: pageLimit, page });
    const chunk = listFrom(resp);
    all = all.concat(chunk);
    const total = resp && resp.pagination && resp.pagination.total;
    if (!chunk.length || (total != null && all.length >= total)) break;
    page++;
  }
  return all;
}

// Находит SD_id категории клиента по названию (без учёта регистра). Результат кэшируется.
let _catCache = null;
async function resolveCategoryId(name) {
  if (!_catCache) {
    _catCache = await fetchAll("getClientCategory", { filter: { include: "all" } });
  }
  const needle = String(name).trim().toLowerCase();
  const exact = _catCache.find((c) => (c.name || "").trim().toLowerCase() === needle);
  const partial = _catCache.find((c) => (c.name || "").toLowerCase().includes(needle));
  const found = exact || partial;
  return found ? found.SD_id : null;
}

module.exports = { login, call, post, getAuth, listFrom, fetchAll, resolveCategoryId, SD_URL };
