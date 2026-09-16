// Перенос Telegram-сотрудников в пользователи ERP — план (src/user-migration.js).
const test = require('node:test');
const assert = require('node:assert');
const { planMigration } = require('../src/user-migration');

const S = (id, role, phone, extra = {}) => ({ id, role, phone_normalized: phone, status: 'confirmed', ...extra });
const names = { agents: { a1: 'Mahmudova Lobar' }, drivers: { d1: 'Абидов Боходир' } };

test('совпал по телефону — связываем, веб у пользователя не трогаем', () => {
  const p = planMigration([S(1, 'logistics', '981230456')],
    [{ id: 10, full_name: 'Bakhodir Abidov', tg_phone: '998981230456', web_access: true }], names);
  assert.equal(p.link.length, 1);
  assert.equal(p.link[0].user_id, 10);
  assert.equal(p.link[0].web_access, true);
});

test('не найден в ERP — создаём без веба, имя и логин из SalesDoctor', () => {
  const p = planMigration([S(2, 'agent', '901112233', { crm_agent_id: 'a1' }), S(3, 'expeditor', '933970300', { expeditor_sd_id: 'd1' })], [], names);
  assert.deepEqual(p.create.map((x) => [x.name, x.suggestLogin, x.web_access]),
    [['Mahmudova Lobar', 'agent_a1', false], ['Абидов Боходир', 'driver_d1', false]]);
});

test('конфликты: нет телефона, один номер у двоих, агент без SD, разные роли', () => {
  const p = planMigration([
    S(1, 'agent', '', { crm_agent_id: 'a1' }),
    S(2, 'expeditor', '977777777', { expeditor_sd_id: 'd1' }), S(3, 'logistics', '977777777'),
    S(4, 'agent', '955555555'),
    S(5, 'head_of_sales', '944444444'),
  ], [{ id: 20, full_name: 'Асилбек', tg_phone: '944444444', bot_role: 'logistics' }], names);
  const why = p.conflicts.map((c) => c.staff_id + ':' + c.why);
  assert.ok(why.some((w) => w.startsWith('1:нет телефона')));
  assert.ok(why.some((w) => w.startsWith('2:этот номер у нескольких сотрудников')));
  assert.ok(why.some((w) => w.startsWith('3:этот номер у нескольких сотрудников')));
  assert.ok(why.some((w) => w.startsWith('4:агент без привязки')));
  assert.ok(why.some((w) => w.startsWith('5:в ERP роль в боте')));
  assert.equal(p.link.length + p.create.length, 0);
});

test('неподтверждённые (заявки, отключённые) не переносим, только считаем', () => {
  const p = planMigration([S(1, 'agent', '911111111', { status: 'new_request' }), S(2, 'agent', '922222222', { status: 'disabled' })], [], names);
  assert.equal(p.skipped, 2);
  assert.equal(p.create.length, 0);
});
