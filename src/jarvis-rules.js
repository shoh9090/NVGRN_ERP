// jarvis-rules.js — правила Джарвиса и сопоставление людей с Trello.
// Чистые функции без базы и сети — проверяются тестом (test/jarvis-rules.test.js).
//
// Правила хранятся одной записью settings.jarvis_rules (JSON): их правит админ
// в плитке «Джарвис», читают напоминания и штрафы. Всё, чего нет в записи,
// берётся из DEFAULTS — решения Шоха, сентябрь 2026 (docs/plan-jarvis.md).

const DEFAULTS = {
  workspace_id: '',          // рабочее пространство Trello, которое контролируем целиком
  workspace_name: '',
  work_from: 9,              // рабочие часы (Ташкент): вне их не пишем и часы не считаем
  work_to: 20,
  work_days: [1, 2, 3, 4, 5], // 1 = пн … 7 = вс
  mention_remind_h: 4,       // упомянули @ и нет ответа: напоминание через N рабочих часов
  mention_violation_h: 10,   // …и нарушение через N рабочих часов
  overdue_violation_days: 1, // срок карточки прошёл: нарушение через N рабочих дней
  stale_days: 7,             // карточка без движения: одно напоминание, без штрафа
  fine_mention: 0,           // штраф за неответ на упоминание, сум
  fine_overdue: 0,           // штраф за просроченную карточку, сум
  fines_enabled: false,      // штрафы включаются после недели одних напоминаний
  reminders_enabled: false,  // бот пишет людям; выключено — только читает Trello и ведёт журнал
  enabled_at: '',            // когда включили: часы по старым упоминаниям идут с этого момента
};

const num = (v, def, min, max) => {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

// Приводит сохранённое/присланное к правилам, которым можно доверять:
// числа в разумных пределах, «нарушение» не раньше «напоминания», часы с < по.
function normalizeRules(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS };
  out.workspace_id = String(r.workspace_id || '').trim();
  out.workspace_name = out.workspace_id ? String(r.workspace_name || '').trim() : '';
  out.work_from = Math.round(num(r.work_from, DEFAULTS.work_from, 0, 23));
  out.work_to = Math.round(num(r.work_to, DEFAULTS.work_to, 1, 24));
  if (out.work_to <= out.work_from) { out.work_from = DEFAULTS.work_from; out.work_to = DEFAULTS.work_to; }
  const days = Array.isArray(r.work_days)
    ? [...new Set(r.work_days.map(Number).filter((d) => d >= 1 && d <= 7))].sort()
    : DEFAULTS.work_days.slice();
  out.work_days = days.length ? days : DEFAULTS.work_days.slice();
  out.mention_remind_h = num(r.mention_remind_h, DEFAULTS.mention_remind_h, 0.5, 100);
  out.mention_violation_h = Math.max(out.mention_remind_h,
    num(r.mention_violation_h, DEFAULTS.mention_violation_h, 0.5, 200));
  out.overdue_violation_days = Math.round(num(r.overdue_violation_days, DEFAULTS.overdue_violation_days, 0, 30));
  out.stale_days = Math.round(num(r.stale_days, DEFAULTS.stale_days, 1, 90));
  out.fine_mention = Math.round(num(r.fine_mention, 0, 0, 100000000));
  out.fine_overdue = Math.round(num(r.fine_overdue, 0, 0, 100000000));
  out.fines_enabled = r.fines_enabled === true || r.fines_enabled === 'true';
  out.reminders_enabled = r.reminders_enabled === true || r.reminders_enabled === 'true';
  out.enabled_at = out.reminders_enabled && !Number.isNaN(Date.parse(r.enabled_at)) ? String(r.enabled_at) : '';
  return out;
}

// ---- Рабочее время (Ташкент, UTC+5) ----
const TZ = 5 * 3600000, HOUR = 3600000, DAY = 86400000;
const isoDay = (localMs) => ((new Date(localMs).getUTCDay() + 6) % 7) + 1; // 1 = пн … 7 = вс

// Сколько рабочих часов между двумя моментами: считаем только рабочие дни
// и часы с work_from до work_to. Ночь и выходные не в счёт.
function workHours(fromMs, toMs, r) {
  if (!(toMs > fromMs)) return 0;
  const a0 = fromMs + TZ, b0 = toMs + TZ;
  let total = 0, n = 0;
  for (let d = Math.floor(a0 / DAY) * DAY; d < b0 && n < 800; d += DAY, n++) {
    if (!r.work_days.includes(isoDay(d))) continue;
    const a = Math.max(a0, d + r.work_from * HOUR), b = Math.min(b0, d + r.work_to * HOUR);
    if (b > a) total += b - a;
  }
  return total / HOUR;
}
function isWorkTime(ms, r) {
  const l = ms + TZ;
  const h = (l % DAY) / HOUR;
  return r.work_days.includes(isoDay(l)) && h >= r.work_from && h < r.work_to;
}
// Дата по Ташкенту «2026-09-22» — ключ «утреннее напоминание уже было сегодня».
const localDate = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);

// С какого момента считать часы: старое упоминание до включения Джарвиса —
// с момента включения, иначе все вчерашние сразу стали бы нарушениями.
function clockStart(ms, r) {
  const on = r.enabled_at ? Date.parse(r.enabled_at) : 0;
  return Math.max(ms, on || 0);
}

// Что пора сделать с упоминанием без ответа: 'violation' | 'remind' | null.
function mentionStep(m, nowMs, r) {
  if (m.answered_at) return null;
  const h = workHours(clockStart(Date.parse(m.created_at), r), nowMs, r);
  if (!m.violation_at && h >= r.mention_violation_h) return 'violation';
  if (!m.reminded_at && !m.violation_at && h >= r.mention_remind_h) return 'remind';
  return null;
}
// Просроченная карточка стала нарушением: прошло N рабочих дней после срока.
function overdueIsViolation(dueMs, nowMs, r) {
  const need = r.overdue_violation_days * (r.work_to - r.work_from);
  return nowMs > dueMs && workHours(clockStart(dueMs, r), nowMs, r) >= need;
}

// @логины из текста комментария. @card/@board — «всем», их не считаем:
// упоминание — это когда ждут ответа от конкретного человека.
function parseMentions(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(^|[^a-z0-9_])@([a-z0-9_]{3,})/gi)) {
    const u = m[2].toLowerCase();
    if (u !== 'card' && u !== 'board') out.add(u);
  }
  return [...out];
}
// Колонка «Готово» — карточки в ней не просрочены и не «забыты».
const isDoneList = (name) => /готов|выполн|сделан|закрыт|архив|done|complete|finished/i.test(String(name || ''));
// Ответ, отправленный из Telegram, лежит в Trello от учётки владельца токена
// с подписью «Имя (через Джарвис): …» — узнаём его, чтобы не приписать владельцу.
const VIA = ' (через Джарвис): ';
function viaJarvis(text) {
  const t = String(text || '');
  const i = t.indexOf(VIA);
  return i > 0 && i < 80 ? { name: t.slice(0, i), text: t.slice(i + VIA.length) } : null;
}

// ---- Сопоставление людей с Trello ----
// В Trello имена чаще латиницей («Abdushukur Karimov», логин abdushukur90),
// в Персонале — кириллицей. Сводим оба к латинице и сравниваем по словам.
// Система только ПРЕДЛАГАЕТ пару — подтверждает человек.
const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ў: 'o', қ: 'k', ғ: 'g', ҳ: 'h',
};
function toLatin(s) {
  const low = String(s || '').toLowerCase();
  let out = '';
  for (const ch of low) out += CYR[ch] !== undefined ? CYR[ch] : ch;
  return out
    .replace(/[ʻʼ'`’‘]/g, '')        // o'g'li, G'ulom
    .replace(/kh/g, 'h').replace(/x/g, 'h').replace(/zh/g, 'j').replace(/dj/g, 'j')
    .replace(/q/g, 'k').replace(/w/g, 'v').replace(/iy\b/g, 'i');
}
// Слова имени: латиница, от 3 букв (инициалы и «оглы» не в счёт).
const SKIP = new Set(['ogli', 'oglu', 'kizi', 'ugli']);
function nameWords(s) {
  const words = toLatin(s).replace(/[^a-z]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !SKIP.has(w));
  return [...new Set(words)]; // «Abdushukur747 @abdushukur» — одно слово, а не два
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
// Одно слово похоже на другое: совпало или отличается одной буквой
// (Шахобиддин/Shakhobiddin/Shahobiddin, Камоллиддин/Kamoliddin) или короткая форма
// полного имени (Lobar/Лобархон). Мурадов/Мурадова тоже «похожи» — поэтому
// совпадение по одному слову только подсказка, пару не подставляем.
const wordLike = (a, b) => a === b
  || (Math.min(a.length, b.length) >= 5 && lev(a, b) <= 1)
  || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

// Сколько слов меньшего имени нашлись в большем. 0 — не похожи.
function nameMatch(a, b) {
  const wa = nameWords(a), wb = nameWords(b);
  if (!wa.length || !wb.length) return { hits: 0, full: false };
  const [small, big] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const hits = small.filter((w) => big.some((x) => wordLike(w, x))).length;
  return { hits, full: hits === small.length && small.length >= 2 };
}

// Для каждого участника Trello — кого из сотрудников предложить.
// members: [{ id, fullName, username }]; employees: [{ id, full_name, status, trello_member_id }].
// Предложение только однозначное: два одинаково похожих сотрудника — не угадываем.
// Уже связанные пары не предлагаем заново.
function suggestPairs(members, employees) {
  const linked = new Map();
  for (const e of employees) if (e.trello_member_id) linked.set(String(e.trello_member_id), e);
  const free = employees.filter((e) => !e.trello_member_id && e.status !== 'archived');
  return members.map((m) => {
    const own = linked.get(String(m.id));
    if (own) return { member_id: m.id, linked_employee_id: own.id, suggestion: null };
    const label = [m.fullName, String(m.username || '').replace(/[0-9_.-]+/g, ' ')].join(' ');
    let best = [], bestHits = 0;
    for (const e of free) {
      const r = nameMatch(label, e.full_name);
      if (!r.hits) continue;
      if (r.hits > bestHits) { best = [{ e, r }]; bestHits = r.hits; }
      else if (r.hits === bestHits) best.push({ e, r });
    }
    if (best.length !== 1) {
      return { member_id: m.id, linked_employee_id: null, suggestion: null, ambiguous: best.length > 1 };
    }
    const { e, r } = best[0];
    return {
      member_id: m.id, linked_employee_id: null,
      suggestion: { employee_id: e.id, strength: r.full ? 'full' : 'partial' },
    };
  });
}

module.exports = {
  DEFAULTS, normalizeRules, toLatin, nameWords, nameMatch, suggestPairs,
  workHours, isWorkTime, localDate, clockStart, mentionStep, overdueIsViolation,
  parseMentions, isDoneList, viaJarvis, VIA,
};
