// Полные очистки запрещены на рабочей базе (src/wipe-guard.js, аудит A15).
const test = require('node:test');
const assert = require('node:assert');
const { wipeBlocked } = require('../src/wipe-guard');

test('на Railway очистка запрещена', () => {
  assert.match(wipeBlocked({ RAILWAY_ENVIRONMENT: 'production' }), /отключена на рабочей базе/);
  assert.match(wipeBlocked({ NODE_ENV: 'production' }), /отключена/);
});

test('осознанно разрешить можно только переменной ALLOW_WIPE=1', () => {
  assert.equal(wipeBlocked({ RAILWAY_ENVIRONMENT: 'production', ALLOW_WIPE: '1' }), null);
  assert.match(wipeBlocked({ RAILWAY_ENVIRONMENT: 'production', ALLOW_WIPE: 'true' }), /отключена/);
});

test('на компьютере разработчика — можно', () => {
  assert.equal(wipeBlocked({}), null);
});
