// jarvis-complaints.js — претензии на стороне сотрудников компании.
//
// Граница проведена по человеку, а не по операции (решение Шоха 24.09.2026):
//   • клиент и торговый агент живут во внешнем боте — там их заказы и точки:
//     подача претензии, «Принял в работу», решение агента остаются там;
//   • руководитель звена, РОП и админ — сотрудники Hub с учётками и ролями,
//     их ведёт Джарвис: карточка, решение, причина, напоминания.
//
// Почему переносим: в tg-bot/link-owners.js стояла вторая копия механизма
// Джарвиса — свои рабочие часы, своя лестница сроков, свой журнал. Две копии
// одного механизма неизбежно расходятся: поменяли часы в плитке, а претензии
// живут по старым.
//
// Пока правило complaints_owners выключено, модуль молчит и всё работает
// по-старому — переключатель в плитке «Джарвис».

const db = require('./db');
const pool = db.pool;

// Типы, которые агент не закрывает сам (тот же список, что в боте).
const CRITICAL_TYPES = new Set(['zhivnost']);

// Люди роли, отвечающей за звено этой претензии, подключённые к Джарвису.
// Отличие от внешнего бота: смотрим jv_chat_id — свой бот, свои чаты.
async function ownersOf(complaintId) {
  try {
    const r = await pool.query(
      `SELECT DISTINCT u.id AS user_id, u.full_name, u.jv_chat_id AS chat_id
         FROM tgbot.complaints c
         JOIN tgbot.complaint_dicts d ON d.kind = 'link' AND d.code = c.link_code
         JOIN public.user_roles ur ON ur.role_id = d.owner_role_id
         JOIN public.users u ON u.id = ur.user_id
        WHERE c.id = $1 AND u.is_active AND u.jv_chat_id IS NOT NULL`, [complaintId]);
    return r.rows;
  } catch (e) { return []; }
}

// Нажавший кнопку — действительно руководитель этого звена? Карточку могли
// переслать, а решение по претензии — это деньги и отношения с клиентом.
async function ownerByChat(complaintId, chatId) {
  const list = await ownersOf(complaintId);
  return list.find((o) => String(o.chat_id) === String(chatId)) || null;
}

async function resolutions() {
  return (await pool.query(
    "SELECT code, label_ru FROM tgbot.complaint_dicts WHERE kind = 'resolution' AND active ORDER BY sort_order")).rows;
}

async function loadCard(complaintId) {
  const c = (await pool.query(
    `SELECT c.id, c.sd_id, c.created_at, c.status, c.point_name, c.firm_name, c.product_name, c.ship_date,
            c.client_comment, c.complaint_type, c.link_code, c.agent_name, c.agent_sd_id, c.internal_note,
            (SELECT label_ru FROM tgbot.complaint_dicts WHERE kind = 'type' AND code = c.complaint_type LIMIT 1) AS type_label,
            (SELECT label_ru FROM tgbot.complaint_dicts WHERE kind = 'link' AND code = c.link_code LIMIT 1) AS link_label
       FROM tgbot.complaints c WHERE c.id = $1`, [complaintId])).rows[0];
  if (!c) return null;
  // Агента показываем именем из SalesDoctor, как в Hub; нет в справочнике — как записан.
  try {
    const a = c.agent_sd_id
      ? (await pool.query('SELECT sd_agent_name FROM tgbot.crm_agents WHERE sd_agent_id = $1 LIMIT 1', [c.agent_sd_id])).rows[0]
      : null;
    c.agent = (a && a.sd_agent_name) || c.agent_name || null;
  } catch (e) { c.agent = c.agent_name || null; }
  const files = (await pool.query(
    'SELECT kind, tg_file_id, file_ref FROM tgbot.complaint_files WHERE complaint_id = $1 ORDER BY id',
    [complaintId])).rows;
  return { c, files };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDate = (d) => {
  const s = typeof d === 'string' ? d : new Date(d).toISOString();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
};
// «17.09 в 18:40» по Ташкенту — когда претензию подали.
const sinceText = (createdAt) => {
  const t = new Date(new Date(createdAt).getTime() + 5 * 3600000).toISOString();
  return `${t.slice(8, 10)}.${t.slice(5, 7)} в ${t.slice(11, 16)}`;
};

function formatCard(c, critical) {
  const head = critical
    ? `🚨 <b>Критичная претензия №${c.id}</b> — нужно ваше решение`
    : `📩 <b>Претензия №${c.id}</b> — для сведения (решает агент)`;
  const point = [c.point_name, c.firm_name && c.firm_name !== c.point_name ? `(${c.firm_name})` : null].filter(Boolean).join(' ');
  const lines = [head, ''];
  if (c.link_label) lines.push(`Звено: ${esc(c.link_label)}`);
  if (point) lines.push(`Точка: ${esc(point)}`);
  if (c.product_name) lines.push(`Товар: ${esc(c.product_name)}${c.ship_date ? ` · отгрузка ${fmtDate(c.ship_date)}` : ''}`);
  if (c.type_label) lines.push(`Тип: ${esc(c.type_label)}`);
  if (c.client_comment) lines.push(`Комментарий клиента: ${esc(c.client_comment)}`);
  if (c.agent) lines.push(`Агент: ${esc(c.agent)}`);
  if (critical) lines.push('', 'Выберите решение — оно ляжет в карточку претензии в ERP и уйдёт агенту.');
  return lines.join('\n');
}

// Кнопки: у критичной — решения из справочника, причину можно дописать к любой.
function ownerKeyboard(id, critical, res) {
  const rows = critical ? (res || []).map((r) => [{ text: r.label_ru, callback_data: `cr:${id}:${r.code}` }]) : [];
  rows.push([{ text: '✍️ Написать причину', callback_data: `cn:${id}` }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Медиа. Номер файла в Telegram привязан к боту, который его принял, поэтому
// чужой ролик Джарвис переслать не может — только отдать байтами своим токеном.
// Фото лежат в нашей базе, видео держит Telegram клиентского бота (tg-files.js).
async function mediaBytes(f) {
  if (f.kind === 'photo' && f.file_ref) {
    const row = (await pool.query('SELECT data, name FROM files WHERE id = $1', [f.file_ref])).rows[0];
    if (row && row.data && row.data.length) return { buf: row.data, name: row.name || 'photo.jpg' };
  }
  if (f.tg_file_id) {
    const tf = require('./tg-files');
    if (!tf.hasToken()) return null;
    return { buf: await tf.download(f.tg_file_id), name: f.kind === 'photo' ? 'photo.jpg' : 'video.mp4' };
  }
  return null;
}

async function sendMedia(chatId, files) {
  const bot = require('./jarvis-bot');
  for (const f of files.slice(0, 5)) {
    try {
      const m = await mediaBytes(f);
      if (m) await bot.sendFile(chatId, f.kind, m.buf, m.name);
    } catch (e) { console.warn('[ПРЕТЕНЗИИ медиа]', e.message); }
  }
}

// Карточка руководителям звена. remind — повтор: медиа второй раз не шлём.
async function sendCard(complaintId, { critical, remind } = {}) {
  const bot = require('./jarvis-bot');
  const owners = await ownersOf(complaintId);
  if (!owners.length) return 0;
  const card = await loadCard(complaintId);
  if (!card) return 0;
  const crit = critical === undefined ? CRITICAL_TYPES.has(card.c.complaint_type) : critical;
  let text = formatCard(card.c, crit);
  if (remind) {
    text = `⏰ Напоминание: претензия №${complaintId} подана ${sinceText(card.c.created_at)}, `
      + `${crit ? 'решения' : 'причины'} от вас пока нет.\n\n` + text;
    if (!crit) text += '\n\nНапишите, в чём причина и что сделали, — кнопкой ниже.';
  }
  const kb = ownerKeyboard(complaintId, crit, await resolutions());
  let sent = 0;
  for (const o of owners) {
    // Медиа не должно мешать главному: не ушло фото — текст с кнопками всё равно отправляем.
    if (!remind) await sendMedia(o.chat_id, card.files);
    if (await bot.send(o.chat_id, text, kb)) sent++;
  }
  return sent;
}

// Короткое сообщение руководителям звена («агент закрыл сам», «уже решил такой-то»).
async function tell(complaintId, text, exceptChatId) {
  const bot = require('./jarvis-bot');
  const owners = await ownersOf(complaintId);
  for (const o of owners) {
    if (exceptChatId && String(o.chat_id) === String(exceptChatId)) continue;
    await bot.send(o.chat_id, text);
  }
  return owners.length;
}

// Решение руководителя. Кто нажал первым — тот и решил.
async function resolve(chatId, complaintId, code) {
  const who = await ownerByChat(complaintId, chatId);
  if (!who) return { error: 'Это решение принимает руководитель звена.' };
  const label = ((await resolutions()).find((r) => r.code === code) || {}).label_ru || code;
  const upd = await pool.query(
    `UPDATE tgbot.complaints SET resolution = $1, status = 'resolved', resolved_at = now(),
            resolved_by = $2, updated_at = now()
      WHERE id = $3 AND status <> 'resolved' RETURNING sd_id`, [code, who.full_name, complaintId]);
  if (!upd.rowCount) {
    const c = (await pool.query('SELECT resolved_by FROM tgbot.complaints WHERE id = $1', [complaintId])).rows[0];
    return { error: c ? `Уже закрыта${c.resolved_by ? ': ' + c.resolved_by : ''}.` : 'Претензия не найдена.' };
  }
  await tell(complaintId, `✅ По претензии №${complaintId} решение принял(а) ${esc(who.full_name)}: ${esc(label)}.`, chatId);
  // Агенту точки — во внешний бот: он живёт там, вместе с клиентом.
  const sdId = upd.rows[0].sd_id;
  if (sdId) {
    await notifyAgent(sdId, `✅ Претензия №${complaintId} ({name}): ${who.full_name} принял(а) решение — ${label}. Свяжитесь с клиентом.`)
      .catch((e) => console.warn('[ПРЕТЕНЗИИ агенту]', e.message));
  }
  return { ok: true, label, who: who.full_name };
}

// Причина от руководителя дописывается в карточку с именем и датой — как в боте.
async function addNote(chatId, complaintId, text) {
  const who = await ownerByChat(complaintId, chatId);
  if (!who) return { error: 'Причину пишет руководитель звена.' };
  const stamp = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  const line = `${who.full_name} (${stamp}): ${String(text).slice(0, 1000)}`;
  await pool.query(
    `UPDATE tgbot.complaints
        SET internal_note = CASE WHEN COALESCE(internal_note, '') = '' THEN $1
                                 ELSE internal_note || chr(10) || $1 END,
            updated_at = now()
      WHERE id = $2`, [line, complaintId]);
  return { ok: true, who: who.full_name };
}

// Сообщение агенту точки уходит ЧЕРЕЗ ВНЕШНИЙ бот: агент подключён к нему,
// у Джарвиса его чата нет. Токен клиентского бота уже есть в ERP (tg-files.js).
async function notifyAgent(sdId, template) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return false;
  const row = (await pool.query(
    `SELECT s.telegram_chat_id AS chat_id, p.point_name, p.firm_name
       FROM tgbot.point_contacts p
       JOIN tgbot.telegram_staff s ON s.crm_agent_id = p.agent_sd_id AND s.role = 'agent'
      WHERE p.sd_id = $1 AND s.status = 'confirmed' AND s.telegram_chat_id IS NOT NULL
      ORDER BY s.id DESC LIMIT 1`, [sdId])).rows[0];
  if (!row) return false;
  const text = template.replace('{name}', row.point_name || row.firm_name || sdId);
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: row.chat_id, text }), signal: AbortSignal.timeout(15000),
  });
  const d = await resp.json().catch(() => ({}));
  return !!d.ok;
}

// ---- Кому пора напомнить ----
// Чистая функция: по списку открытых претензий и правилам говорит, кому что
// слать. Считаем в РАБОЧИХ часах из правил Джарвиса (плитка), а не по
// константам в коде — раньше у бота были свои 9:00–20:00, и поменять их можно
// было только правкой файла.
//   критичная без решения руководителя: напомнить, потом сказать РОПу и админу;
//   простая без причины: напомнить один раз — агент её и так закроет.
// Претензия закрыта или причина записана — не трогаем: напоминать о сделанном
// значит приучать людей не читать сообщения.
function dueOwners(rows, nowMs, rules, R) {
  const out = [];
  for (const c of rows) {
    if (c.status === 'resolved') continue;
    const hours = R.workHours(R.clockStart(new Date(c.created_at).getTime(), rules), nowMs, rules);
    if (CRITICAL_TYPES.has(c.complaint_type)) {
      if (hours >= rules.complaint_crit_esc_h) out.push({ id: c.id, stage: 'crit_esc', critical: true, escalate: true, hours });
      else if (hours >= rules.complaint_crit_h) out.push({ id: c.id, stage: 'crit', critical: true, escalate: false, hours });
    } else {
      if (String(c.internal_note || '').trim()) continue;
      if (hours >= rules.complaint_simple_h) out.push({ id: c.id, stage: 'simple', critical: false, escalate: false, hours });
    }
  }
  return out;
}

// Открытые претензии из бота за последние трое суток: старую историю пачкой
// не будим — она уже разобрана в вебе.
async function openComplaints() {
  try {
    return (await pool.query(
      `SELECT id, created_at, status, complaint_type, internal_note, point_name, firm_name, sd_id,
              agent_resolution, resolution, resolved_by
         FROM tgbot.complaints
        WHERE source IN ('client_bot', 'agent') AND link_code IS NOT NULL
          AND created_at > now() - interval '3 days'
        ORDER BY id`)).rows;
  } catch (e) { return []; }
}

// ---- Недельная сводка ----
// Что было за неделю: по звеньям, с чем сравнивать и как быстро реагировал
// агент. Считаем по дате подачи претензии: неделя, в которую её подали.
async function weekStats(from, to) {
  const by = (await pool.query(
    `SELECT COALESCE(NULLIF(c.link_code, ''), 'other') AS link,
            (SELECT label_ru FROM tgbot.complaint_dicts WHERE kind = 'link' AND code = c.link_code LIMIT 1) AS label,
            COUNT(*)::int AS vsego,
            COUNT(*) FILTER (WHERE c.status = 'resolved')::int AS zakryto,
            AVG(EXTRACT(EPOCH FROM (c.agent_reacted_at - c.created_at)))
              FILTER (WHERE c.agent_reacted_at IS NOT NULL) AS react_sec
       FROM tgbot.complaints c
      WHERE c.created_at >= $1::date AND c.created_at < ($2::date + 1)
      GROUP BY 1, 2 ORDER BY 3 DESC`, [from, to])).rows;
  const types = (await pool.query(
    `SELECT (SELECT label_ru FROM tgbot.complaint_dicts WHERE kind = 'type' AND code = c.complaint_type LIMIT 1) AS label,
            COUNT(*)::int AS n
       FROM tgbot.complaints c
      WHERE c.created_at >= $1::date AND c.created_at < ($2::date + 1)
      GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, [from, to])).rows;
  const total = by.reduce((a, r) => a + r.vsego, 0);
  return { by, types, total };
}

// Руководители звеньев, подключённые к Джарвису: кому какое звено показывать.
async function ownersByLink() {
  try {
    return (await pool.query(
      `SELECT d.code, d.label_ru, u.jv_chat_id AS chat_id, u.full_name
         FROM tgbot.complaint_dicts d
         JOIN public.user_roles ur ON ur.role_id = d.owner_role_id
         JOIN public.users u ON u.id = ur.user_id AND u.is_active = TRUE
        WHERE d.kind = 'link' AND d.active AND u.jv_chat_id IS NOT NULL`)).rows;
  } catch (e) { return []; }
}

module.exports = {
  CRITICAL_TYPES, ownersOf, ownerByChat, loadCard, sendCard, tell, resolve, addNote, notifyAgent,
  formatCard, ownerKeyboard, sinceText, resolutions, dueOwners, openComplaints, weekStats, ownersByLink,
};
