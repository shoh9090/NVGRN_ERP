// jarvis.js — плитка «Джарвис»: правила внутреннего бота и люди ↔ Trello.
// Шаг 2 плана (docs/plan-jarvis.md). Здесь только НАСТРОЙКА: что контролируем,
// какие сроки, какие штрафы и кто есть кто в Trello. Сами напоминания и штрафы —
// следующие шаги, они читают правила отсюда (loadRules).
//
// Где что живёт (правило «каждая вещь в одном месте»):
//   правила                 — settings.jarvis_rules (одна JSON-запись);
//   Trello человека          — в его карточке Персонала (hr_employees.trello_*);
//   права                   — роли ERP, как везде.
// Менять правила и пары может только админ: в правилах суммы штрафов.

const express = require('express');
const db = require('./db');
const trello = require('./trello');
const R = require('./jarvis-rules');

const router = express.Router();
const J = express.json();

let _ready = false;
async function ensureSchema() {
  if (_ready) return;
  // Trello — поле человека, поэтому лежит в карточке сотрудника, а не в своей таблице.
  // Те же колонки заводит и Персонал (src/hr.js) — кто откроется первым.
  await db.pool.query('ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS trello_member_id TEXT');
  await db.pool.query('ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS trello_username TEXT');
  _ready = true;
}

async function loadRules() {
  const r = await db.pool.query("SELECT value FROM settings WHERE key = 'jarvis_rules'");
  let raw = {};
  try { raw = JSON.parse((r.rows[0] && r.rows[0].value) || '{}'); } catch (e) { raw = {}; }
  return R.normalizeRules(raw);
}

const onlyAdmin = (req, res) => {
  if (req.user && req.user.isAdmin) return false;
  res.status(403).json({ error: 'Правила Джарвиса меняет только администратор' });
  return true;
};

// Бот для сотрудников: проверяем, что токен в Railway живой, и узнаём его имя.
// Токен в ответ и в текст ошибки не попадает.
async function botInfo() {
  const token = process.env.INTERNAL_BOT_TOKEN;
  if (!token) return { configured: false };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) return { configured: true, ok: false, error: r.status === 401 ? 'Telegram не принял токен — проверьте INTERNAL_BOT_TOKEN' : 'Telegram ответил ' + r.status };
    return { configured: true, ok: true, username: d.result.username, name: d.result.first_name };
  } catch (e) {
    return { configured: true, ok: false, error: 'Telegram не ответил' };
  }
}

// ---------- Страница ----------
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('jarvis', { settings, user: req.user });
});

// Состояние: подключения + правила + список пространств для выбора.
router.get('/api/state', async (req, res) => {
  try {
    const rules = await loadRules();
    const out = { rules, can_edit: !!req.user.isAdmin, bot: await botInfo(), trello: { configured: trello.configured() } };
    if (out.trello.configured) {
      try {
        const me = await trello.me();
        out.trello.ok = true;
        out.trello.me = me.fullName || me.username;
        out.trello.workspaces = (await trello.workspaces())
          .map((w) => ({ id: w.id, name: w.displayName || w.name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        if (rules.workspace_id) {
          out.trello.boards = (await trello.boards(rules.workspace_id))
            .map((b) => ({ name: b.name, url: b.url }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        }
      } catch (e) { out.trello.ok = false; out.trello.error = e.message; }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/rules', J, async (req, res) => {
  if (onlyAdmin(req, res)) return;
  try {
    const b = req.body || {};
    const rules = R.normalizeRules({ ...(await loadRules()), ...b });
    // Пространство — только из тех, что реально видит токен, и с его настоящим именем.
    if (rules.workspace_id) {
      const ws = (await trello.workspaces()).find((w) => w.id === rules.workspace_id);
      if (!ws) return res.status(400).json({ error: 'Такого пространства Trello нет среди доступных' });
      rules.workspace_name = ws.displayName || ws.name;
    }
    await db.setSetting('jarvis_rules', JSON.stringify(rules));
    await db.log(req.user.id, 'jarvis_rules', JSON.stringify({
      ws: rules.workspace_name, fines: rules.fines_enabled, fm: rules.fine_mention, fo: rules.fine_overdue }));
    res.json({ ok: true, rules });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Люди ↔ Trello ----------
async function employeesForMatch() {
  await ensureSchema();
  return (await db.pool.query(
    `SELECT e.id, e.full_name, e.status, e.position, e.trello_member_id, e.trello_username,
            d.name AS department_name, (u.tg_chat_id IS NOT NULL) AS in_bot, (u.id IS NOT NULL) AS has_erp
       FROM hr_employees e
       LEFT JOIN hr_departments d ON d.id = e.department_id
       LEFT JOIN users u ON u.id = e.erp_user_id
      WHERE e.status <> 'archived'
      ORDER BY e.full_name`)).rows;
}

router.get('/api/people', async (req, res) => {
  try {
    const rules = await loadRules();
    if (!rules.workspace_id) return res.json({ need_workspace: true });
    const members = (await trello.members(rules.workspace_id))
      .map((m) => ({ id: m.id, fullName: m.fullName || m.username, username: m.username }));
    const emps = await employeesForMatch();
    const byId = new Map(emps.map((e) => [e.id, e]));
    const pairs = R.suggestPairs(members, emps);
    const memberIds = new Set(members.map((m) => m.id));
    const rows = members.map((m, i) => {
      const p = pairs[i];
      const pick = (id) => { const e = byId.get(id); return e ? { id: e.id, full_name: e.full_name, status: e.status, department_name: e.department_name, position: e.position, in_bot: e.in_bot } : null; };
      return {
        ...m,
        linked: p.linked_employee_id ? pick(p.linked_employee_id) : null,
        suggestion: p.suggestion ? { ...pick(p.suggestion.employee_id), strength: p.suggestion.strength } : null,
        ambiguous: !!p.ambiguous,
      };
    }).sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
    // Связь, которая больше не ведёт в пространство (человека убрали из Trello).
    const lost = emps.filter((e) => e.trello_member_id && !memberIds.has(e.trello_member_id))
      .map((e) => ({ id: e.id, full_name: e.full_name, trello_username: e.trello_username }));
    const without = emps.filter((e) => e.status === 'active' && !e.trello_member_id)
      .map((e) => ({ id: e.id, full_name: e.full_name, department_name: e.department_name, position: e.position }));
    res.json({
      workspace_name: rules.workspace_name, members: rows, lost, without,
      employees: emps.map((e) => ({ id: e.id, full_name: e.full_name, status: e.status, department_name: e.department_name })),
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/people/link', J, async (req, res) => {
  if (onlyAdmin(req, res)) return;
  try {
    await ensureSchema();
    const { member_id } = req.body || {};
    const empId = parseInt((req.body || {}).employee_id, 10);
    const rules = await loadRules();
    if (!rules.workspace_id) return res.status(400).json({ error: 'Сначала выберите пространство Trello' });
    const m = (await trello.members(rules.workspace_id)).find((x) => x.id === member_id);
    if (!m) return res.status(400).json({ error: 'Этого человека нет в пространстве Trello' });
    const e = (await db.pool.query('SELECT id, full_name FROM hr_employees WHERE id = $1', [empId])).rows[0];
    if (!e) return res.status(404).json({ error: 'Сотрудник не найден' });
    // Один Trello — один сотрудник: если был привязан к другому, переносим.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE hr_employees SET trello_member_id = NULL, trello_username = NULL WHERE trello_member_id = $1 AND id <> $2', [m.id, e.id]);
      await client.query('UPDATE hr_employees SET trello_member_id = $1, trello_username = $2, updated_at = now() WHERE id = $3', [m.id, m.username, e.id]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
    finally { client.release(); }
    await db.log(req.user.id, 'jarvis_trello_link', `${e.full_name} ↔ @${m.username}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/people/unlink', J, async (req, res) => {
  if (onlyAdmin(req, res)) return;
  try {
    await ensureSchema();
    const empId = parseInt((req.body || {}).employee_id, 10);
    const e = (await db.pool.query('SELECT full_name, trello_username FROM hr_employees WHERE id = $1', [empId])).rows[0];
    if (!e) return res.status(404).json({ error: 'Сотрудник не найден' });
    await db.pool.query('UPDATE hr_employees SET trello_member_id = NULL, trello_username = NULL, updated_at = now() WHERE id = $1', [empId]);
    await db.log(req.user.id, 'jarvis_trello_unlink', `${e.full_name} ↔ @${e.trello_username || '—'}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
module.exports.loadRules = loadRules;
