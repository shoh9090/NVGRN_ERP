// Водители в боте сверяются с SalesDoctor (src/driver-sync.js).
// SD — источник правды: активный водитель получает доступ к боту, пропавший
// или неактивный — теряет. Людей с другой ролью сверка не трогает.
const test = require('node:test');
const assert = require('node:assert');
const { planDriverStaff, describe } = require('../src/driver-sync');

const E = (sd_id, phone9, active = true, name = 'Водитель ' + sd_id) => ({ sd_id, name, phone9, active });

test('новый активный водитель с телефоном — добавляется в бот', () => {
  const p = planDriverStaff([E('d1', '981230456')], []);
  assert.deepEqual(p.create, [{ sd_id: 'd1', name: 'Водитель d1', phone9: '981230456' }]);
});

test('уже привязан и подтверждён — ничего не делаем', () => {
  const p = planDriverStaff([E('d1', '981230456')], [{ id: 1, role: 'expeditor', status: 'confirmed', expeditor_sd_id: 'd1', phone_normalized: '981230456' }]);
  assert.equal(p.create.length + p.enable.length + p.relink.length + p.disable.length, 0);
});

test('был отключён, в SD снова активен — включаем', () => {
  const p = planDriverStaff([E('d1', '981230456')], [{ id: 1, role: 'expeditor', status: 'disabled', expeditor_sd_id: 'd1' }]);
  assert.deepEqual(p.enable.map((x) => x.id), [1]);
});

test('в SD неактивен — доступ отключаем', () => {
  const p = planDriverStaff([E('d1', '981230456', false)], [{ id: 1, role: 'expeditor', status: 'confirmed', expeditor_sd_id: 'd1' }]);
  assert.deepEqual(p.disable.map((x) => x.id), [1]);
});

test('удалён из SD (его нет в списке) — доступ отключаем', () => {
  const p = planDriverStaff([E('d2', '900000000')], [{ id: 1, role: 'expeditor', status: 'confirmed', expeditor_sd_id: 'd1' }]);
  assert.deepEqual(p.disable.map((x) => x.id), [1]);
});

test('заявка с тем же номером — привязываем, а не заводим второго', () => {
  const p = planDriverStaff([E('d1', '981230456')], [{ id: 5, role: null, status: 'new_request', phone_normalized: '981230456' }]);
  assert.deepEqual(p.relink.map((x) => x.id), [5]);
  assert.equal(p.create.length, 0);
});

test('номер у агента — не трогаем, сообщаем', () => {
  const p = planDriverStaff([E('d1', '981230456')], [{ id: 7, role: 'agent', status: 'confirmed', phone_normalized: '981230456' }]);
  assert.equal(p.relink.length + p.create.length, 0);
  assert.equal(p.conflict[0].id, 7);
});

test('без телефона в SD — не добавляем (бот его не узнает), но сообщаем', () => {
  const p = planDriverStaff([E('d1', '')], []);
  assert.equal(p.create.length, 0);
  assert.equal(p.noPhone[0].sd_id, 'd1');
});

test('агентов и РОПа отключение не касается', () => {
  const p = planDriverStaff([E('d1', '981230456')], [
    { id: 1, role: 'agent', status: 'confirmed', crm_agent_id: 'a1' },
    { id: 2, role: 'head_of_sales', status: 'confirmed' },
  ]);
  assert.equal(p.disable.length, 0);
});

test('сводка по-человечески', () => {
  const t = describe({ total: 10, active: 5, created: 3, enabled: 0, disabled: 2, noPhone: ['Абидов'], conflict: [] });
  assert.match(t, /Водителей в SalesDoctor: 10, активных: 5\./);
  assert.match(t, /добавлено в бот: 3, отключено \(нет среди активных в SD\): 2\./);
  assert.match(t, /Без телефона в SD — бот их не узнает: Абидов\./);
});
