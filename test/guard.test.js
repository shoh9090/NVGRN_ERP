// Защита входа: подбор пароля останавливается (src/guard.js).
const test = require('node:test');
const assert = require('node:assert');
const { createLoginLimiter, securityHeaders } = require('../src/guard');

test('после 8 неудач вход с этого адреса временно закрыт', () => {
  const lim = createLoginLimiter();
  const t = 1000;
  for (let i = 0; i < 7; i++) { assert.ok(lim.check('1.1.1.1', 'admin', t).ok); lim.fail('1.1.1.1', 'admin', t); }
  assert.ok(lim.check('1.1.1.1', 'admin', t).ok, '8-я попытка ещё разрешена');
  lim.fail('1.1.1.1', 'admin', t);
  const g = lim.check('1.1.1.1', 'admin', t);
  assert.strictEqual(g.ok, false);
  assert.ok(g.retryAfterSec > 0 && g.retryAfterSec <= 15 * 60);
});

test('другой логин и другой адрес не страдают', () => {
  const lim = createLoginLimiter();
  for (let i = 0; i < 8; i++) lim.fail('1.1.1.1', 'admin', 1000);
  assert.ok(lim.check('1.1.1.1', 'buh', 1000).ok);      // другой логин с того же адреса
  assert.ok(lim.check('2.2.2.2', 'admin', 1000).ok);    // тот же логин с другого адреса
});

test('перебор логинов с одного адреса тоже останавливается', () => {
  const lim = createLoginLimiter();
  for (let i = 0; i < 25; i++) lim.fail('1.1.1.1', 'user' + i, 1000);
  assert.strictEqual(lim.check('1.1.1.1', 'ещё-один', 1000).ok, false);
});

test('окно проходит — счётчик обнуляется; удачный вход тоже сбрасывает', () => {
  const lim = createLoginLimiter();
  for (let i = 0; i < 8; i++) lim.fail('1.1.1.1', 'admin', 1000);
  assert.strictEqual(lim.check('1.1.1.1', 'admin', 1000).ok, false);
  assert.ok(lim.check('1.1.1.1', 'admin', 1000 + 16 * 60 * 1000).ok, 'через 16 минут снова можно');

  const lim2 = createLoginLimiter();
  for (let i = 0; i < 5; i++) lim2.fail('3.3.3.3', 'admin', 1000);
  lim2.success('3.3.3.3', 'admin');
  assert.ok(lim2.check('3.3.3.3', 'admin', 1000).ok);
});

test('заголовки: на рабочем сервере добавляется https-политика, на локальном нет', () => {
  const run = (isProd) => { const h = {}; securityHeaders(isProd)({}, { set: (k, v) => { h[k] = v; } }, () => {}); return h; };
  const prod = run(true), dev = run(false);
  assert.strictEqual(prod['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(prod['X-Frame-Options'], 'SAMEORIGIN');
  assert.ok(prod['Strict-Transport-Security'].includes('max-age='));
  assert.strictEqual(dev['Strict-Transport-Security'], undefined);
});
