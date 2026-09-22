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
