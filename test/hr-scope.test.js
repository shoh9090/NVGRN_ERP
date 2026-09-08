// Доступ по отделу в Кадрах. Ошибка здесь либо отрезает человеку работу,
// либо показывает начальнику смены зарплату всей компании.
const { test } = require('node:test');
const assert = require('node:assert');
const { scopeDept } = require('../src/hr');

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
