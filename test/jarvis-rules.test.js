// Правила Джарвиса и сопоставление людей с Trello (src/jarvis-rules.js).
const test = require('node:test');
const assert = require('node:assert');
const { normalizeRules, DEFAULTS, nameMatch, suggestPairs } = require('../src/jarvis-rules');

test('пустые правила = решения Шоха по умолчанию, штрафы выключены', () => {
  const r = normalizeRules(null);
  assert.deepStrictEqual(r, DEFAULTS);
  assert.strictEqual(r.fines_enabled, false);
  assert.strictEqual(r.mention_remind_h, 4);
  assert.strictEqual(r.mention_violation_h, 10);
});

test('нарушение не раньше напоминания, часы с < по, дни без мусора', () => {
  const r = normalizeRules({ mention_remind_h: 6, mention_violation_h: 2, work_from: 20, work_to: 9, work_days: [7, 1, 1, 9, 'x'] });
  assert.strictEqual(r.mention_violation_h, 6);
  assert.deepStrictEqual([r.work_from, r.work_to], [9, 20]);
  assert.deepStrictEqual(r.work_days, [1, 7]);
  assert.deepStrictEqual(normalizeRules({ work_days: [] }).work_days, DEFAULTS.work_days);
});

test('суммы штрафов — целые и не отрицательные; флаг штрафов только явный', () => {
  const r = normalizeRules({ fine_mention: '50000.7', fine_overdue: -5, fines_enabled: 'yes' });
  assert.strictEqual(r.fine_mention, 50001);
  assert.strictEqual(r.fine_overdue, 0);
  assert.strictEqual(r.fines_enabled, false);
  assert.strictEqual(normalizeRules({ fines_enabled: true }).fines_enabled, true);
});

test('кириллица в Персонале ↔ латиница в Trello', () => {
  assert.deepStrictEqual(nameMatch('Shakhobiddin Muradov', 'Мурадов Шахобиддин'), { hits: 2, full: true });
  assert.deepStrictEqual(nameMatch("Abdushukur G'ulomov", 'Гуломов Абдушукур Азизович'), { hits: 2, full: true });
  assert.deepStrictEqual(nameMatch('Lola Xidayeva', 'Хидаева Лола'), { hits: 2, full: true });
  assert.strictEqual(nameMatch('Aziza', 'Мурадова Азиза').hits, 1);
  assert.strictEqual(nameMatch('Bobur Karimov', 'Азиза Мурадова').hits, 0);
  // живые случаи из Trello Novagreen, 22.09.2026
  assert.deepStrictEqual(nameMatch('Mahmudova Lobar lobarchic', 'Махмудова Лобархон'), { hits: 2, full: true });
  assert.deepStrictEqual(nameMatch('Abdushukur747 abdushukur', 'Каримов Абдушукур'), { hits: 1, full: false });
  assert.deepStrictEqual(nameMatch('Kamoliddin Nasrullayev', 'Насруллаев Камоллиддин'), { hits: 2, full: true });
  assert.deepStrictEqual(nameMatch('Shakhobiddin Muradov', 'Мурадова Азиза'), { hits: 1, full: false });
});

test('предлагаем только однозначную пару, уволенных тоже узнаём, связанных не трогаем', () => {
  const emps = [
    { id: 1, full_name: 'Мурадов Шахобиддин', status: 'active' },
    { id: 2, full_name: 'Каримова Азиза', status: 'active' },
    { id: 3, full_name: 'Мурадова Азиза', status: 'active' },
    { id: 4, full_name: 'Хидаева Лола', status: 'fired' },
    { id: 5, full_name: 'Уже Связанный', status: 'active', trello_member_id: 'm9' },
  ];
  const out = suggestPairs([
    { id: 'm1', fullName: 'Shakhobiddin Muradov', username: 'shoh90' },
    { id: 'm2', fullName: 'Aziza', username: 'aziza' },
    { id: 'm3', fullName: 'Lola', username: 'lola_xidayeva' },
    { id: 'm9', fullName: 'X', username: 'x' },
    { id: 'm4', fullName: 'Nobody Here', username: 'nobody' },
  ], emps);
  assert.deepStrictEqual(out[0].suggestion, { employee_id: 1, strength: 'full' });
  assert.strictEqual(out[1].suggestion, null);
  assert.strictEqual(out[1].ambiguous, true);
  assert.deepStrictEqual(out[2].suggestion, { employee_id: 4, strength: 'full' });
  assert.strictEqual(out[3].linked_employee_id, 5);
  assert.strictEqual(out[4].suggestion, null);
  assert.strictEqual(out[4].ambiguous, false);
});

// ---- Шаг 3: рабочие часы, упоминания, просрочки ----
const { workHours, isWorkTime, mentionStep, overdueIsViolation, parseMentions, isDoneList, viaJarvis, VIA } = require('../src/jarvis-rules');
// Ташкент = UTC+5: «2026-09-22 10:00» по Ташкенту = 05:00 UTC. 22.09.2026 — вторник.
const T = (s) => Date.parse(s + ':00+05:00');
const RULES = normalizeRules({ work_days: [1, 2, 3, 4, 5, 6] });

test('рабочие часы: ночь и воскресенье не считаются', () => {
  assert.strictEqual(workHours(T('2026-09-22T10:00'), T('2026-09-22T14:00'), RULES), 4);
  // вечер вторника 18:00 → утро среды 11:00 = 2 ч вечером + 2 ч утром
  assert.strictEqual(workHours(T('2026-09-22T18:00'), T('2026-09-23T11:00'), RULES), 4);
  // суббота 19:00 → понедельник 10:00: 1 ч в субботу, воскресенье мимо, 1 ч в понедельник
  assert.strictEqual(workHours(T('2026-09-26T19:00'), T('2026-09-28T10:00'), RULES), 2);
  assert.strictEqual(isWorkTime(T('2026-09-27T12:00'), RULES), false); // воскресенье
  assert.strictEqual(isWorkTime(T('2026-09-22T08:59'), RULES), false);
  assert.strictEqual(isWorkTime(T('2026-09-22T09:00'), RULES), true);
});

test('упоминание: через 4 раб. ч напоминание, через 10 — нарушение, ответ закрывает', () => {
  const m = { created_at: new Date(T('2026-09-22T10:00')).toISOString() };
  assert.strictEqual(mentionStep(m, T('2026-09-22T13:00'), RULES), null);
  assert.strictEqual(mentionStep(m, T('2026-09-22T14:00'), RULES), 'remind');
  assert.strictEqual(mentionStep({ ...m, reminded_at: 'x' }, T('2026-09-22T19:00'), RULES), null);
  assert.strictEqual(mentionStep({ ...m, reminded_at: 'x' }, T('2026-09-23T10:00'), RULES), 'violation');
  assert.strictEqual(mentionStep({ ...m, answered_at: 'x' }, T('2026-09-25T10:00'), RULES), null);
});

test('старые упоминания считаются с момента включения, а не задним числом', () => {
  const on = normalizeRules({ ...RULES, reminders_enabled: true, enabled_at: new Date(T('2026-09-23T09:00')).toISOString() });
  const old = { created_at: new Date(T('2026-09-15T10:00')).toISOString() };
  assert.strictEqual(mentionStep(old, T('2026-09-23T12:00'), on), null);
  assert.strictEqual(mentionStep(old, T('2026-09-23T13:00'), on), 'remind');
  assert.strictEqual(normalizeRules({ enabled_at: '2026-09-23' }).enabled_at, ''); // выключено — даты нет
});

test('просрочка: нарушение через 1 рабочий день после срока', () => {
  const due = T('2026-09-22T12:00');
  assert.strictEqual(overdueIsViolation(due, T('2026-09-23T11:00'), RULES), false);
  assert.strictEqual(overdueIsViolation(due, T('2026-09-23T12:00'), RULES), true);
});

test('упоминания из текста, колонка «Готово», ответ из Telegram', () => {
  assert.deepStrictEqual(parseMentions('@Abdushukur7472 проверь, cc @lobarchic и @card, почта a@b.uz'), ['abdushukur7472', 'lobarchic']);
  assert.ok(isDoneList('✅ Готово'));
  assert.ok(isDoneList('Done'));
  assert.ok(isDoneList('Сделано'));   // решение Шоха: карточка в этой колонке — закрыта
  assert.ok(!isDoneList('В работе'));
  assert.deepStrictEqual(viaJarvis('Каримов Абдушукур' + VIA + 'привезли, @asilramm'), { name: 'Каримов Абдушукур', text: 'привезли, @asilramm' });
  assert.strictEqual(viaJarvis('обычный комментарий'), null);
});
