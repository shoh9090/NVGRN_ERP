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
  mention_stale_days: 14,    // упоминание старше — протухло, ответа уже никто не ждёт
  due_ask_after_h: 3,        // сколько рабочих часов не трогать новую карточку без срока
  daily_cap: 8,              // потолок сообщений Джарвиса одному человеку в день
  due_required_h: 4,         // карточка в работе без срока: столько рабочих часов на срок
  moves_alert: 3,            // столько переносов срока — сигнал руководителю
  fine_mention: 0,           // штраф за неответ на упоминание, сум
  fine_overdue: 0,           // штраф за просроченную карточку, сум
  fines_enabled: false,      // штрафы включаются после недели одних напоминаний
  owners: {},                // кто вносит: дело ERP → роль (см. src/todos.js, TODO_KINDS)
  reminders_enabled: false,  // бот пишет людям; выключено — только читает Trello и ведёт журнал
  ai_enabled: false,         // можно ли спрашивать Джарвиса словами
  ai_provider: 'claude',     // claude | openai — ключ берётся из Railway
  done_lists: [],            // свои колонки Trello, которые тоже считаются закрытыми
  mute_clients: [],          // клиенты, о которых не напоминать (сменили формат работы, закрылись)
  sales_digest_days: 3,      // как часто РОП получает сводку по притихшим клиентам (0 — не слать)
  ai_model: '',              // пусто = модель поставщика по умолчанию
  memory_days: 7,            // сколько дней Джарвис помнит разговор (0 — без памяти)
  web_enabled: false,        // ищет ли Джарвис в интернете (только Claude: поиск у него встроенный)
  voice_enabled: true,       // можно ли слать голосовые (нужен ключ OPENAI_API_KEY)
  voice_model: 'whisper-1',  // чем распознаём речь
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
  out.mention_stale_days = Math.round(num(r.mention_stale_days, DEFAULTS.mention_stale_days, 1, 180));
  out.due_ask_after_h = num(r.due_ask_after_h, DEFAULTS.due_ask_after_h, 0, 100);
  out.daily_cap = Math.round(num(r.daily_cap, DEFAULTS.daily_cap, 1, 50));
  out.sales_digest_days = Math.round(num(r.sales_digest_days, DEFAULTS.sales_digest_days, 0, 30));
  // Спрашивать срок раньше, чем ждём его постановки, — бессмысленно.
  out.due_required_h = Math.max(out.due_ask_after_h,
    num(r.due_required_h, DEFAULTS.due_required_h, 0.5, 100));
  out.moves_alert = Math.round(num(r.moves_alert, DEFAULTS.moves_alert, 1, 20));
  out.fine_mention = Math.round(num(r.fine_mention, 0, 0, 100000000));
  out.fine_overdue = Math.round(num(r.fine_overdue, 0, 0, 100000000));
  out.fines_enabled = r.fines_enabled === true || r.fines_enabled === 'true';
  out.reminders_enabled = r.reminders_enabled === true || r.reminders_enabled === 'true';
  // Кто вносит: ключ дела → цепочка [{ role, after_h }]. Первый берётся сразу
  // (after_h = 0), следующий подключается, когда дело провисело свои рабочие часы.
  // Одно число вместо списка — старая запись с одним ответственным.
  out.owners = {};
  for (const [k, v] of Object.entries((r.owners && typeof r.owners === 'object') ? r.owners : {})) {
    if (!/^[a-z_]{2,30}$/.test(k)) continue;
    const raw = Array.isArray(v) ? v : [{ role: v, after_h: 0 }];
    const steps = [];
    for (const s of raw) {
      const role = parseInt(s && s.role !== undefined ? s.role : s, 10);
      if (!(role > 0) || steps.some((x) => x.role === role)) continue;
      steps.push({ role, after_h: steps.length === 0 ? 0 : num(s && s.after_h, 8, 0, 400) });
    }
    steps.sort((a, b) => a.after_h - b.after_h);
    if (steps.length) { steps[0].after_h = 0; out.owners[k] = steps; }
  }
  out.enabled_at = out.reminders_enabled && !Number.isNaN(Date.parse(r.enabled_at)) ? String(r.enabled_at) : '';
  out.ai_enabled = r.ai_enabled === true || r.ai_enabled === 'true';
  out.ai_provider = r.ai_provider === 'openai' ? 'openai' : 'claude';
  out.ai_model = String(r.ai_model || '').trim().slice(0, 60);
  out.memory_days = Math.round(num(r.memory_days, DEFAULTS.memory_days, 0, 30));
  out.web_enabled = r.web_enabled === true || r.web_enabled === 'true';
  out.voice_enabled = r.voice_enabled === undefined ? true : (r.voice_enabled === true || r.voice_enabled === 'true');
  out.voice_model = String(r.voice_model || '').trim().slice(0, 60) || DEFAULTS.voice_model;
  // Свои названия колонок, которые тоже считаются закрытыми.
  out.done_lists = (Array.isArray(r.done_lists) ? r.done_lists : String(r.done_lists || '').split(','))
    .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 30);
  // «R019_KorzinkaRS перестал брать» — верно по цифрам, но это смена формата
  // работы (решение Шоха, 23.09.2026). Такие клиенты просто выключаются.
  out.mute_clients = (Array.isArray(r.mute_clients) ? r.mute_clients : String(r.mute_clients || '').split(','))
    .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 50);
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

// ---- Итог недели (решение Шоха 24.09.2026) ----
// В пятницу вечером — чем закончили неделю, в понедельник утром — с чем
// стартуем. Сравниваем одинаковые отрезки: в пятницу эту неделю с той же
// частью прошлой (понедельник–пятница против понедельника–пятницы), иначе
// неполная неделя всегда «хуже» полной.
function weekWindows(nowMs, mode) {
  const d = new Date(nowMs + 5 * 3600000);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();          // пн = 1
  const D = 86400000;
  if (mode === 'monday') {
    const to = day0 - dow * D;                                   // прошлое воскресенье
    const from = to - 6 * D;
    return { from: iso(from), to: iso(to), prev_from: iso(from - 7 * D), prev_to: iso(to - 7 * D) };
  }
  const from = day0 - (dow - 1) * D;                             // понедельник этой недели
  return { from: iso(from), to: iso(day0), prev_from: iso(from - 7 * D), prev_to: iso(day0 - 7 * D) };
}

// Насколько изменилось. Разницу меньше 10% не объявляем ни победой, ни
// провалом: это шум, а от еженедельной похвалы ни за что люди глохнут.
function trend(cur, prev, minPct = 10) {
  const c = Number(cur) || 0, p = Number(prev) || 0;
  if (!p) return { pct: null, flat: true, up: c > 0 };
  const pct = Math.round(((c - p) / p) * 100);
  return { pct, flat: Math.abs(pct) < minPct, up: pct >= 0 };
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
// «Принято», «hop, vazifa tushunarli», «ок» — это подтверждение, а не вопрос.
// Тот, кого в таком комментарии упомянули, никому ничего не должен: мяч
// остаётся у того, кто задачу принял, — с него Джарвис и спросит срок
// (случай Шоха: «Абдушукур пишет, что задача принята, но нам же мало этого»).
// Цифры в тексте — признак содержательного ответа (дата, сумма), это не отписка.
const ACK = new Set([
  'ок', 'окей', 'ok', 'okey', 'okay', 'хорошо', 'ладно', 'понял', 'поняла', 'понятно',
  'принято', 'принял', 'приняла', 'принимаю', 'договорились', 'ага', 'да', 'есть',
  'сделаю', 'сделаем', 'выполню', 'спасибо', 'рахмат',
  'hop', 'xop', 'hup', 'mayli', 'yaxshi', 'zor', 'boladi', 'bladi', 'tayyor',
  'tushunarli', 'tushundim', 'tushunarlik', 'albatta', 'qilaman', 'qilamiz',
  'bajaraman', 'bajaramiz', 'rahmat', 'ha',
]);
function isAck(text) {
  const raw = String(text || '').replace(/@[a-z0-9_]+/gi, ' ').trim();
  if (!raw || raw.length > 60) return false;
  if (/[?？]/.test(raw) || /\d/.test(raw)) return false;
  const words = raw.toLowerCase().replace(/[’'`‘ʻ]/g, '').split(/[^\p{L}]+/u).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  return words.some((w) => ACK.has(w));
}

// Колонка, в которой карточка считается закрытой: не просрочена и ответа не ждёт.
// Кроме «сделано» это и «не актуально», «отменено», «заморожено» — работа по ним
// не ведётся, дёргать людей не за что (случай Шоха: карточки 2025 года из
// колонки «не актуально» приходили как просроченные).
// extra — дополнительные названия колонок из правил плитки.
function isDoneList(name, extra) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return false;
  if (/готов|выполн|сделан|закрыт|архив|не\s*актуал|неактуал|отмен|заморож|отложен|done|complete|finished|cancel/i.test(s)) return true;
  return Array.isArray(extra) && extra.some((x) => String(x || '').trim().toLowerCase() === s);
}
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

// Срок с кнопки бота: конец рабочего дня через N дней по Ташкенту.
function dueInDays(days, nowMs, r) {
  const l = nowMs + TZ;
  const day = Math.floor(l / DAY) * DAY + Math.round(days) * DAY;
  return new Date(day + r.work_to * HOUR - TZ).toISOString();
}
// Дата словами или цифрами: «сегодня», «завтра», «25.09», «25.09.2026», «25/09».
// Год не указан, а дата уже прошла — значит, следующий год.
function parseDueDate(text, nowMs, r) {
  const t = String(text || '').trim().toLowerCase();
  if (/^сегодня$/.test(t)) return dueInDays(0, nowMs, r);
  if (/^завтра$/.test(t)) return dueInDays(1, nowMs, r);
  if (/^послезавтра$/.test(t)) return dueInDays(2, nowMs, r);
  const m = t.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/);
  if (!m) return null;
  const d = +m[1], mo = +m[2];
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  const nowY = new Date(nowMs + TZ).getUTCFullYear();
  let y = m[3] ? +m[3] : nowY;
  if (y < 100) y += 2000;
  const at = Date.UTC(y, mo - 1, d) + r.work_to * HOUR - TZ;
  if (!m[3] && at < nowMs) return new Date(Date.UTC(y + 1, mo - 1, d) + r.work_to * HOUR - TZ).toISOString();
  return new Date(at).toISOString();
}

module.exports = {
  DEFAULTS, normalizeRules, toLatin, nameWords, nameMatch, suggestPairs, dueInDays, parseDueDate,
  workHours, isWorkTime, localDate, clockStart, mentionStep, overdueIsViolation,
  parseMentions, isAck, isDoneList, viaJarvis, VIA, weekWindows, trend,
};
