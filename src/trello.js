// trello.js — чтение Trello для Джарвиса.
// Ключ и токен — только из переменных окружения Railway (TRELLO_KEY, TRELLO_TOKEN),
// в код и в браузер не попадают. Токен выписан на учётку Шоха и видит все его
// пространства, поэтому Джарвис сам ограничивается одним — выбранным в правилах.

const BASE = 'https://api.trello.com/1';

const configured = () => !!(process.env.TRELLO_KEY && process.env.TRELLO_TOKEN);

async function get(path, params = {}) {
  if (!configured()) throw new Error('В Railway не заданы TRELLO_KEY и TRELLO_TOKEN');
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', process.env.TRELLO_KEY);
  u.searchParams.set('token', process.env.TRELLO_TOKEN);
  let r;
  try { r = await fetch(u, { signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new Error('Trello не ответил: ' + (e.name === 'TimeoutError' ? 'нет ответа 15 секунд' : e.message)); }
  if (!r.ok) {
    // В тексте ответа Trello ключа нет — его можно показать как есть.
    const t = (await r.text().catch(() => '')).slice(0, 160);
    if (r.status === 401) throw new Error('Trello не принял ключ или токен — проверьте TRELLO_KEY и TRELLO_TOKEN в Railway');
    throw new Error(`Trello ответил ${r.status}${t ? ': ' + t : ''}`);
  }
  return r.json();
}

const id = (v) => encodeURIComponent(String(v));

module.exports = {
  configured,
  me: () => get('/members/me', { fields: 'fullName,username' }),
  workspaces: () => get('/members/me/organizations', { fields: 'displayName,name' }),
  boards: (ws) => get(`/organizations/${id(ws)}/boards`, { filter: 'open', fields: 'name,url' }),
  members: (ws) => get(`/organizations/${id(ws)}/members`, { fields: 'fullName,username' }),
};
