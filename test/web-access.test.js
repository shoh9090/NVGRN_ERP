// Доступ в веб-версию ERP (src/web-access.js).
const test = require('node:test');
const assert = require('node:assert');
const { sessionAllowed, loginVerdict } = require('../src/web-access');

test('обычный пользователь проходит', () => {
  assert.equal(sessionAllowed({ id: 5 }, new Set([7])), true);
});

test('отключённый или без веб-доступа — старая сессия больше не пускает', () => {
  assert.equal(sessionAllowed({ id: 7 }, new Set([7])), false);
  assert.equal(sessionAllowed({ id: '7' }, new Set([7])), false);   // id из cookie может прийти строкой
});

test('без пользователя — не пускаем', () => {
  assert.equal(sessionAllowed(null, new Set()), false);
});

test('при входе: «только бот» получает понятный отказ, остальные — нет', () => {
  assert.match(loginVerdict({ web_access: false }), /только в Telegram-боте/);
  assert.equal(loginVerdict({ web_access: true }), null);
  assert.equal(loginVerdict({}), null);                              // до миграции поля нет — пускаем как раньше
});
