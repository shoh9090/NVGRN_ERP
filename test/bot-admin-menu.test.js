// Меню админа в боте: кнопки всех ролей (tg-bot/admin-menu.js).
const test = require('node:test');
const assert = require('node:assert');
const m = require('../tg-bot/admin-menu');

test('в меню админа есть кнопки РОПа, логистики, агента и водителя', () => {
  const all = m.ADMIN_MENU.flat();
  for (const b of ['📊 Сводка отдела', '📋 Итог дня', '🚚 Доставки сегодня', '👥 Мои клиенты', '🚚 Мои доставки', m.SWITCH]) {
    assert.ok(all.includes(b), 'нет кнопки ' + b);
  }
  // Каждая кнопка, кроме админских и «Не заказали» (она общая), знает свою роль.
  const own = new Set(['🚫 Не заказали', m.SWITCH, '🔄 Синхронизация', '👤 Telegram-сотрудники']);
  all.filter((b) => !own.has(b)).forEach((b) => assert.ok(m.ROUTE[b], 'кнопка без роли: ' + b));
});

test('кнопки агента и водителя привязаны к человеку', () => {
  m.BOUND.forEach((b) => assert.ok(['agent', 'expeditor'].includes(m.ROUTE[b]), b));
});

test('список «за кого смотреть» — нажатие разбирается обратно', () => {
  const kb = m.pickerKeyboard('expeditor', [{ id: 'd0_27', name: 'Абидов' }, { id: 'd0_31', name: 'Джураев' }], '🚚 Мои доставки');
  assert.equal(kb.inline_keyboard.length, 2);
  const pick = m.parsePick(kb.inline_keyboard[1][0].callback_data);
  assert.deepEqual(pick, { kind: 'expeditor', button: '🚚 Мои доставки', id: 'd0_31' });
});

test('подделанное нажатие не проходит: чужая роль у кнопки или мусор', () => {
  const idxAgent = m.BOUND.indexOf('👥 Мои клиенты');
  assert.equal(m.parsePick(`admas:expeditor:${idxAgent}:x`), null); // кнопка агента, а роль водителя
  assert.equal(m.parsePick('admas:agent:99:x'), null);
  assert.equal(m.parsePick('cmpl:ores:1:x'), null);
});

test('слишком длинный id в кнопку не кладём — Telegram не принял бы всю клавиатуру', () => {
  const kb = m.pickerKeyboard('agent', [{ id: 'x'.repeat(80), name: 'Длинный' }, { id: 'a1', name: 'Норм' }], '👥 Мои клиенты');
  assert.deepEqual(kb.inline_keyboard.map((r) => r[0].text), ['Норм']);
});
