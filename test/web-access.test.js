// Доступ в веб-версию ERP и актуальные права сессии (src/web-access.js, аудит A02).
const test = require('node:test');
const assert = require('node:assert');
const { liveUser, loginVerdict, passwordVersion } = require('../src/web-access');

const PV = passwordVersion('hash-1');
const live = new Map([
  [5, { active: true, web: true, pv: PV, isAdmin: false, isFinance: false, roles: ['Склад'] }],
  [7, { active: false, web: true, pv: PV, isAdmin: false, isFinance: false, roles: [] }],
  [8, { active: true, web: false, pv: PV, isAdmin: false, isFinance: false, roles: [] }],
]);

test('права берутся из базы, а не из cookie: сняли админа — он больше не админ', () => {
  const u = liveUser({ id: 5, isAdmin: true, isFinance: true, roles: ['Админ'], pv: PV }, live);
  assert.equal(u.isAdmin, false);
  assert.equal(u.isFinance, false);
  assert.deepEqual(u.roles, ['Склад']);
  assert.equal(liveUser({ id: '5', pv: PV }, live).id, '5');              // id из cookie может прийти строкой
});

test('удалён, отключён или только бот — сессия не пускает', () => {
  assert.equal(liveUser({ id: 99, isAdmin: true }, live), null);
  assert.equal(liveUser({ id: 7 }, live), null);
  assert.equal(liveUser({ id: 8 }, live), null);
  assert.equal(liveUser(null, live), null);
});

test('пароль сменили после входа — старая сессия не пускает', () => {
  assert.equal(liveUser({ id: 5, pv: passwordVersion('старый-хеш') }, live), null);
  assert.ok(liveUser({ id: 5 }, live));                                   // старые cookie без отпечатка — до истечения
});

test('снимок ещё не загружен — пускаем по cookie, как раньше', () => {
  assert.equal(liveUser({ id: 5, isAdmin: true }, null).isAdmin, true);
});

test('при входе: «только бот» получает понятный отказ, остальные — нет', () => {
  assert.match(loginVerdict({ web_access: false }), /только в Telegram-боте/);
  assert.equal(loginVerdict({ web_access: true }), null);
  assert.equal(loginVerdict({}), null);
});
