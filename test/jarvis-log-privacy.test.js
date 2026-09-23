// Журнал Джарвиса виден всем, у кого есть плитка. Значит, содержание личных
// разговоров с ботом (там бывает зарплата) в него попадать не должно.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'jarvis.js'), 'utf8');
const block = src.slice(src.indexOf("router.get('/api/log'"));

test('содержание разговоров с ботом прячется от посторонних', () => {
  assert.match(block, /PRIVATE = new Set\(\['ai', 'voice'\]\)/, 'личные виды записей не выделены');
  assert.match(block, /isAdmin/, 'админ должен видеть всё, остальные — нет');
  assert.match(block, /личный разговор/, 'вместо текста должна остаться заглушка');
});

test('id пользователя из журнала наружу не отдаётся', () => {
  assert.match(block, /const \{ erp_user_id, \.\.\.row \} = r/, 'служебное поле связи уходит в ответ');
});
