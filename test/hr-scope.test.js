// Доступ по отделу в Кадрах. Ошибка здесь либо отрезает человеку работу,
// либо показывает начальнику смены зарплату всей компании.
const { test } = require('node:test');
const assert = require('node:assert');
const { scopeDept, scopeRuleFor, scopeVerdict, scopeCompanyWrite } = require('../src/hr');

test('ограничения нет — фильтр как попросили', () => {
  assert.strictEqual(scopeDept('3,5', null), '3,5');
  assert.strictEqual(scopeDept('', null), '');
});

test('без фильтра показываем ровно свои отделы', () => {
  assert.strictEqual(scopeDept('', new Set([4])), '4');
  assert.strictEqual(scopeDept('', new Set([4, 7])), '4,7');
});

test('чужой отдел в фильтре отбрасывается', () => {
  // Просил 4 и 9, разрешён только 4 — остаётся 4.
  assert.strictEqual(scopeDept('4,9', new Set([4])), '4');
});

test('только чужие отделы — возвращаемся к своим, а не к «всем»', () => {
  // Подставить чужой id и увидеть чужую зарплату нельзя.
  assert.strictEqual(scopeDept('9', new Set([4])), '4');
});

test('«без отдела» не проходит мимо ограничения', () => {
  assert.strictEqual(scopeDept('__none__', new Set([4])), '4');
});

test('привязок нет ни к одному отделу — пусто, а не всё', () => {
  assert.strictEqual(scopeDept('', new Set()), '-1');
  assert.strictEqual(scopeDept('4', new Set()), '-1');
});

// --- Сторож операций записи -------------------------------------------------
// Фильтры выше решают, что человек ВИДИТ. Ниже — что он может ИЗМЕНИТЬ.
// Производство — отдел 4, Продажи — 9. Начальник производства ведёт только 4.
const PROD = new Set([4]);
const DEPT_OF = { 11: 4, 12: 4, 21: 9, 31: null };   // 31 — сотрудник без отдела
const deptOf = (id) => DEPT_OF[id];

// Сквозная проверка одного запроса: как её делает сторож, но без базы.
function decide(path, body, scope = PROD, extra = []) {
  const rule = scopeRuleFor(path);
  if (!rule) return scopeCompanyWrite(path) ? 'только кадрам' : 'не размечено';
  return scopeVerdict(rule, body, path.match(rule.re), scope, deptOf, extra);
}

test('своего сотрудника править можно', () => {
  assert.strictEqual(decide('/api/payroll/cell', { employee_id: 11 }), null);
  assert.strictEqual(decide('/api/employee/11/status', {}), null);
});

test('чужого — нельзя, даже зная его номер', () => {
  assert.match(decide('/api/payroll/cell', { employee_id: 21 }), /не из вашего отдела/);
  assert.match(decide('/api/employee/21/status', {}), /не из вашего отдела/);
});

test('в списке достаточно одного чужого, чтобы операция не прошла', () => {
  // Массовое увольнение: 11 свой, 21 чужой — не увольняем никого.
  assert.match(decide('/api/employees/bulk', { ids: [11, 21], action: 'fired' }), /не из вашего отдела/);
  assert.strictEqual(decide('/api/employees/bulk', { ids: [11, 12], action: 'fired' }), null);
});

test('сотрудник «без отдела» ограниченному недоступен', () => {
  assert.match(decide('/api/payroll/cell', { employee_id: 31 }), /не из вашего отдела/);
});

test('несуществующий номер сотрудника не проходит', () => {
  assert.match(decide('/api/payroll/cell', { employee_id: 999 }), /не из вашего отдела/);
});

test('своего в чужой отдел не вынести', () => {
  // Групповой перевод: люди свои, а отдел назначения чужой.
  assert.match(decide('/api/employees/bulk', { ids: [11], action: 'transfer', department_id: 9 }), /отдел вам не доступен/);
  // Перевод внутри своей области допустим.
  assert.strictEqual(decide('/api/employees/bulk', { ids: [11], action: 'transfer', department_id: 4 }), null);
  // Смена графика без перевода отдела не задевается.
  assert.strictEqual(decide('/api/employees/bulk', { ids: [11], action: 'transfer', schedule: 'day6h10' }), null);
});

test('карточка без отдела не сохраняется: заводить «в никуда» нельзя', () => {
  assert.match(decide('/api/employee', { full_name: 'Новый' }), /Укажите отдел/);
  assert.strictEqual(decide('/api/employee', { full_name: 'Новый', department_id: 4 }), null);
  assert.match(decide('/api/employee', { full_name: 'Новый', department_id: 9 }), /отдел вам не доступен/);
});

test('правка своей карточки с переносом в чужой отдел не проходит', () => {
  assert.match(decide('/api/employee', { id: 11, department_id: 9 }), /отдел вам не доступен/);
});

test('табель отмечают и утверждают только по своему отделу', () => {
  assert.strictEqual(decide('/api/timesheet/mark-day', { department: '4', date: '2026-09-17' }), null);
  assert.match(decide('/api/timesheet/mark-day', { department: '9', date: '2026-09-17' }), /отдел вам не доступен/);
  assert.match(decide('/api/timesheet/submit', { period: '2026-09', department_id: 9 }), /отдел вам не доступен/);
});

test('строки ведомости и выплат проверяются по их владельцу', () => {
  // extra — сотрудник, найденный по номеру строки в базе.
  assert.strictEqual(decide('/api/payroll/bulk-delete', { ids: [77] }, PROD, [11]), null);
  assert.match(decide('/api/payroll/bulk-delete', { ids: [77] }, PROD, [21]), /не из вашего отдела/);
  assert.match(decide('/api/payouts/55/delete', {}, PROD, [21]), /не из вашего отдела/);
});

test('операции на всю компанию ограниченному закрыты', () => {
  ['/api/employees/import', '/api/cards/statement-import', '/api/department',
    '/api/timesheet/limit', '/api/period-lock'].forEach((p) => {
    assert.strictEqual(decide(p, {}), 'только кадрам', p);
  });
});

test('незнакомый маршрут закрывается, а не открывается', () => {
  // Добавили маршрут и забыли разметить — ограниченный не пройдёт.
  assert.strictEqual(decide('/api/something-new', {}), 'не размечено');
});
