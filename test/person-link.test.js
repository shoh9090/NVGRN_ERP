// Сотрудник Персонала ↔ пользователь ERP (src/person-link.js).
const test = require('node:test');
const assert = require('node:assert');
const { planPhoneLinks } = require('../src/person-link');

test('связываем по последним 9 цифрам телефона, формат номера не важен', () => {
  const plan = planPhoneLinks(
    [{ id: 1, phone: '+998 (90) 123-45-67', erp_user_id: null }, { id: 2, phone: '', erp_user_id: null }],
    [{ id: 10, tg_phone: '901234567' }]);
  assert.deepStrictEqual(plan, [{ employee_id: 1, user_id: 10 }]);
});

test('номер у двоих сотрудников или двоих учёток — не угадываем', () => {
  assert.deepStrictEqual(planPhoneLinks(
    [{ id: 1, phone: '901234567' }, { id: 2, phone: '998901234567' }], [{ id: 10, tg_phone: '901234567' }]), []);
  assert.deepStrictEqual(planPhoneLinks(
    [{ id: 1, phone: '901234567' }], [{ id: 10, tg_phone: '901234567' }, { id: 11, tg_phone: '+998901234567' }]), []);
});

test('уже связанных не трогаем — ни сотрудника, ни учётку', () => {
  assert.deepStrictEqual(planPhoneLinks(
    [{ id: 1, phone: '901234567', erp_user_id: 5 }], [{ id: 10, tg_phone: '901234567' }]), []);
  assert.deepStrictEqual(planPhoneLinks(
    [{ id: 1, phone: '901234567', erp_user_id: null }, { id: 2, phone: '977777777', erp_user_id: 10 }],
    [{ id: 10, tg_phone: '901234567' }]), []);
});
