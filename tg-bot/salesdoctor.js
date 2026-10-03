// Общение с SalesDoctor API V2.
// Все запросы — POST на /api/v2, тип операции задаётся полем method.
// Токен получаем через login и храним в базе, чтобы не логиниться на каждый запрос.

const crypto = require("crypto");
const db = require("./db");

const SD_URL = process.env.SD_API_URL || "https://novagreen.salesdoc.io/api/v2";

// ---- Доступы к SalesDoctor ----
// Главные — свои переменные бота (у него отдельный пользователь SD: вход под
// одной учёткой из двух сервисов может выбивать чужой токен). Если своих нет,
// берём доступы Hub из настроек (пароль зашифрован ключом JWT_SECRET) — лучше
// работать на общей учётке, чем молчать. Молчание и случилось 03.10.2026:
// пароль бота протух, а бот месяц отвечал «заказов нет» вместо «не могу войти».
function hubKey() {
  return crypto.scryptSync(process.env.JWT_SECRET || "", "hub-integrations-salt", 32);
}
function decryptHub(payload) {
  if (!payload) return "";
  const [iv, tag, enc] = String(payload).split(".").map((p) => Buffer.from(p, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", hubKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
let _creds = { at: 0, val: null };
async function creds() {
  if (_creds.val && Date.now() - _creds.at < 300000) return _creds.val;
  const out = { url: SD_URL, login: process.env.SD_LOGIN || "", password: process.env.SD_PASSWORD || "", from: "env" };
  // Своих доступов нет — берём доступы Hub из настроек.
  if ((!out.login || !out.password) && process.env.JWT_SECRET) {
    try {
      const r = await db.query("SELECT key, value FROM public.settings WHERE key IN ('sd_url','sd_login','sd_password_enc')");
      const m = {};
      for (const row of r.rows) m[row.key] = row.value;
      const pw = m.sd_password_enc ? decryptHub(m.sd_password_enc) : "";
      if (m.sd_login && pw) {
        out.login = m.sd_login; out.password = pw; out.from = "hub";
        if (m.sd_url) out.url = String(m.sd_url).replace(/\/+$/, "") + "/api/v2";
      }
    } catch (e) { /* настройки недоступны — остаёмся на переменных окружения */ }
  }
  _creds = { at: Date.now(), val: out };
  return out;
}
const forgetCreds = () => { _creds = { at: 0, val: null }; };

// Сообщить наружу (боту), что вход не удался. Текст уже очищен от секретов.
let alertFn = null;
function onAuthError(fn) { alertFn = fn; }

// SalesDoctor возвращает в ответе на login присланные логин и пароль. Такой
// ответ нельзя класть ни в лог, ни в сообщение админу: пароль утечёт в
// Railway и в Telegram. Оставляем только код и причину.
function safeError(json) {
  const err = (json && json.error) || {};
  const code = err.code || (json && json.status === false ? 401 : "");
  const msg = err.message || (json && json.message) || "ответ без токена";
  return [code ? "код " + code : "", msg].filter(Boolean).join(": ");
}

// Низкоуровневый POST. Возвращает разобранный JSON (или сырой текст, если не JSON).
async function post(body, url) {
  const res = await fetch(url || (await creds()).url, {
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
  const c = await creds();
  if (!c.login || !c.password) {
    throw new Error("Нет доступов к SalesDoctor: ни в настройках Hub, ни в переменных бота.");
  }
  const r = await post({ method: "login", auth: { login: c.login, password: c.password } }, c.url);
  // SalesDoctor отвечает в формате { status: true, result: { userId, token } }.
  const data = (r.json && (r.json.result || r.json.data || r.json)) || {};
  const userId = data.userId || data.userid || data.user_id;
  const token = data.token;
  if (!userId || !token) {
    const why = safeError(r.json);
    // Доступы могли поменять прямо сейчас — перечитаем их на следующей попытке.
    forgetCreds();
    if (alertFn) { try { alertFn(why, c.from); } catch (e) { /* оповещение не критично */ } }
    throw new Error("SalesDoctor не пустил бота (" + why + ")");
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

// Создать/обновить заказ (заявку). orderObj — один заказ.
async function setOrder(orderObj) {
  return call("setOrder", undefined, { order: [orderObj] });
}

module.exports = { login, call, post, getAuth, listFrom, fetchAll, resolveCategoryId, setOrder, SD_URL, creds, onAuthError, safeError };
