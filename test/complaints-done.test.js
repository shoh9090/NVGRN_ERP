// Решение принято и решение выполнено — разные вещи. «Заменить» — это обещание
// клиенту, а не привезённый товар. Проверяем, что система их не путает.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('решение руководителя переводит в «решение принято», а не закрывает', () => {
  const src = read('src/jarvis-complaints.js');
  const i = src.indexOf('async function resolve(');
  const block = src.slice(i, i + 1500);
  assert.match(block, /status = 'decided'/, 'решение по-прежнему сразу закрывает претензию');
  assert.ok(!/status = 'resolved'/.test(block), 'статус «закрыта» ставится в момент решения');
});

test('после принятого решения руководителя больше не дёргают', () => {
  const src = read('src/jarvis-complaints.js');
  const i = src.indexOf('function dueOwners(');
  const block = src.slice(i, i + 900);
  assert.match(block, /'decided'/, 'напоминания пойдут и по решённым претензиям');
});

test('у претензии есть отметка исполнения, и старые записи её получили', () => {
  const schema = read('src/complaints-schema.js');
  assert.match(schema, /ADD COLUMN IF NOT EXISTS done_at/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS done_by/);
  // История закрывалась одной кнопкой — для неё «решено» и есть «выполнено».
  assert.match(schema, /UPDATE tgbot\.complaints SET done_at = resolved_at/);
});

test('«Закрыта» в вебе ставит отметку выполнения', () => {
  const src = read('src/complaints.js');
  const i = src.indexOf('const setResolved');
  const block = src.slice(i, i + 900);
  assert.match(block, /done_at = CASE WHEN \$5 THEN now\(\)/);
});

test('Джарвис видит решения без исполнения', () => {
  const src = read('src/jarvis-insights.js');
  assert.match(src, /complaintsDecidedNotDone/);
  const i = src.indexOf('async function complaintsDecidedNotDone');
  const block = src.slice(i, i + 800);
  assert.match(block, /status = 'decided'/);
  // Решение, принятое час назад, — не повод для сигнала.
  assert.match(block, /resolved_at < now\(\)/);
});
