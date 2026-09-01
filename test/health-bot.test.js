// Пороги «бот работает / молчит / остановлен».
// Смысл проверки: ночью бот молчит законно, и индикатор не должен пугать
// красным. Красное — только когда событий нет уже двое суток.
const test = require('node:test');
const assert = require('node:assert');
const { classifyBot } = require('../src/health');

const NOW = Date.parse('2026-09-01T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test('свежее событие — бот работает', () => {
  assert.equal(classifyBot(hoursAgo(0.5), NOW).state, 'ok');
  assert.equal(classifyBot(hoursAgo(5.9), NOW).state, 'ok');
});

test('ночная тишина — предупреждение, а не поломка', () => {
  assert.equal(classifyBot(hoursAgo(9), NOW).state, 'quiet');
  assert.equal(classifyBot(hoursAgo(47), NOW).state, 'quiet');
});

test('двое суток без событий — похоже, бот остановлен', () => {
  assert.equal(classifyBot(hoursAgo(49), NOW).state, 'stale');
  assert.equal(classifyBot(hoursAgo(24 * 30), NOW).state, 'stale');
});

test('журнал пуст — состояние неизвестно, а не «сломано»', () => {
  const r = classifyBot(null, NOW);
  assert.equal(r.state, 'unknown');
  assert.ok(r.note);
});

test('граница ровно на пороге считается спокойной', () => {
  assert.equal(classifyBot(hoursAgo(6), NOW).state, 'ok');
  assert.equal(classifyBot(hoursAgo(48), NOW).state, 'quiet');
});
