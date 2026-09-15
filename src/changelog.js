// changelog.js — журнал изменений ERP для админа.
//
// Зачем: ERP дописывают несколько человек (и их агенты), выкладка идёт сама
// при каждом пуше. Админу нужно видеть, что поменялось, когда и кто сделал —
// без похода в GitHub. В шапке у админа иконка: светится — есть изменения,
// которых он ещё не видел; не светится — ничего нового.
//
// Откуда берём:
//   • коммиты из GitHub (репозиторий открытый) — раз в 15 минут в фоне, в
//     таблицу change_log. Экран читает только таблицу, GitHub не ждёт;
//   • что реально выложено — Railway при запуске передаёт номер коммита
//     (RAILWAY_GIT_COMMIT_SHA): отмечаем его «выложен в …». Если GitHub
//     недоступен, журнал хотя бы покажет выкладки.
// Без ключа GitHub даёт 60 запросов в час с адреса; можно положить
// GITHUB_TOKEN в переменные Railway, тогда лимит не мешает.
const express = require('express');
const db = require('./db');

const router = express.Router();
const REPO = process.env.GITHUB_REPO || 'shoh9090/NVGRN_ERP';
const SYNC_MS = 15 * 60 * 1000;
const state = { lastSync: null, error: null };

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.pool.query(`CREATE TABLE IF NOT EXISTS change_log (
        sha          TEXT PRIMARY KEY,
        committed_at TIMESTAMPTZ NOT NULL,
        author       TEXT,
        title        TEXT NOT NULL,
        body         TEXT,
        url          TEXT,
        deployed_at  TIMESTAMPTZ
      )`);
      await db.pool.query('CREATE INDEX IF NOT EXISTS idx_change_log_time ON change_log (committed_at DESC)');
      // Когда админ последний раз открывал журнал — по нему гаснет иконка.
      await db.pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS changes_seen_at TIMESTAMPTZ');
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// Коммит GitHub → строка журнала. Слияния веток пропускаем: это не изменение,
// а склейка, и в журнале она только шумит. Строка «Co-Authored-By» — служебная.
function fromGithub(c) {
  const msg = String((c.commit && c.commit.message) || '');
  const lines = msg.split('\n');
  const title = (lines[0] || '').trim();
  if (!title || /^Merge (branch|pull request|remote-tracking)/i.test(title)) return null;
  const body = lines.slice(1).filter((l) => !/^Co-Authored-By:/i.test(l)).join('\n').trim();
  const a = (c.commit && c.commit.author) || {};
  return {
    sha: c.sha,
    committed_at: a.date || (c.commit && c.commit.committer && c.commit.committer.date),
    author: a.name || (c.author && c.author.login) || null,
    title: title.slice(0, 300),
    body: body.slice(0, 4000) || null,
    url: c.html_url || null,
  };
}

async function syncFromGithub() {
  await ensureSchema();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'nvgrn-hub' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits?sha=main&per_page=100`,
      { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      throw new Error(res.status === 403 || res.status === 429
        ? 'GitHub ограничил запросы без ключа. Добавьте GITHUB_TOKEN в переменные Railway.'
        : `GitHub ответил ${res.status}`);
    }
    const list = (await res.json()).map(fromGithub).filter(Boolean);
    for (const x of list) {
      await db.pool.query(
        `INSERT INTO change_log (sha, committed_at, author, title, body, url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sha) DO UPDATE SET author = EXCLUDED.author, title = EXCLUDED.title,
           body = EXCLUDED.body, url = EXCLUDED.url, committed_at = EXCLUDED.committed_at`,
        [x.sha, x.committed_at, x.author, x.title, x.body, x.url]);
    }
    state.lastSync = new Date().toISOString();
    state.error = null;
    return list.length;
  } catch (e) {
    state.error = e.name === 'TimeoutError' ? 'GitHub не ответил за 20 секунд' : e.message;
    return 0;
  }
}

// Отмечаем, что этот коммит сейчас выложен. Сообщение коммита Railway тоже
// передаёт — пригодится, если GitHub недоступен и коммита в журнале ещё нет.
async function markDeployed() {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (!sha) return;
  await ensureSchema();
  const msg = String(process.env.RAILWAY_GIT_COMMIT_MESSAGE || '').split('\n');
  await db.pool.query(
    `INSERT INTO change_log (sha, committed_at, author, title, body, deployed_at)
     VALUES ($1, now(), $2, $3, $4, now())
     ON CONFLICT (sha) DO UPDATE SET deployed_at = COALESCE(change_log.deployed_at, now())`,
    [sha, process.env.RAILWAY_GIT_AUTHOR || null, (msg[0] || 'Выкладка').slice(0, 300),
      msg.slice(1).filter((l) => !/^Co-Authored-By:/i.test(l)).join('\n').trim() || null]);
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Журнал изменений доступен только администратору' });
  next();
}

// Светится ли иконка: есть изменения новее, чем админ последний раз смотрел.
router.get('/api/changes/status', requireAdmin, async (req, res) => {
  try {
    await ensureSchema();
    const r = await db.pool.query(
      `SELECT count(*)::int AS n FROM change_log
        WHERE committed_at > COALESCE((SELECT changes_seen_at FROM users WHERE id = $1), '-infinity')`, [req.user.id]);
    res.json({ unseen: r.rows[0].n });
  } catch (e) { res.json({ unseen: 0 }); }
});

router.get('/api/changes', requireAdmin, async (req, res) => {
  await ensureSchema();
  const seen = (await db.pool.query('SELECT changes_seen_at FROM users WHERE id = $1', [req.user.id])).rows[0];
  const items = (await db.pool.query(
    `SELECT sha, to_char(committed_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD"T"HH24:MI') AS at,
            author, title, body, url,
            to_char(deployed_at AT TIME ZONE 'Asia/Tashkent', 'DD.MM HH24:MI') AS deployed,
            committed_at > COALESCE($1::timestamptz, '-infinity') AS is_new
       FROM change_log ORDER BY committed_at DESC LIMIT 150`, [seen ? seen.changes_seen_at : null])).rows;
  res.json({
    items,
    running: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    lastSync: state.lastSync,
    error: state.error,
  });
});

router.post('/api/changes/seen', requireAdmin, async (req, res) => {
  await ensureSchema();
  await db.pool.query('UPDATE users SET changes_seen_at = now() WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
});

// Фон: отметка выкладки при старте и сверка с GitHub раз в 15 минут.
// Первый запрос — через минуту после старта, чтобы не мешать запуску.
// Таймеры не держат процесс (unref) — тесты и остановка не зависают.
if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    markDeployed().catch((e) => console.warn('[ЖУРНАЛ выкладка]', e.message));
    syncFromGithub();
    setInterval(syncFromGithub, SYNC_MS).unref();
  }, 60 * 1000).unref();
}

module.exports = router;
module.exports.fromGithub = fromGithub;
