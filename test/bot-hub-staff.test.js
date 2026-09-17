// Бот узнаёт сотрудника ERP по телефону (tg-bot/hub-staff.js).
// Главное, что проверяем: сравнение по последним 9 цифрам и то, что при
// ошибке базы (Hub ещё не добавил колонку) бот не падает, а ведёт себя как раньше.
const test = require('node:test');
const assert = require('node:assert');
const hubStaff = require('../tg-bot/hub-staff');

function fakeDb(rows, fail) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (fail) throw new Error('column "tg_chat_id" does not exist');
      return { rows };
    },
  };
}

test('находит по последним 9 цифрам', async () => {
  const db = fakeDb([{ id: 7, full_name: 'Анвар', roles: 'Закупщик' }]);
  const u = await hubStaff(db).byPhone9('901234567');
  assert.equal(u.full_name, 'Анвар');
  assert.match(db.calls[0].sql, /right\(u\.tg_phone, 9\) = \$1/);
  assert.match(db.calls[0].sql, /u\.is_active/);
  assert.deepEqual(db.calls[0].params, ['901234567']);
});

test('неизвестный номер — null', async () => {
  assert.equal(await hubStaff(fakeDb([])).byPhone9('900000000'), null);
});

test('пустой номер — в базу не ходим', async () => {
  const db = fakeDb([{ id: 1 }]);
  assert.equal(await hubStaff(db).byPhone9(''), null);
  assert.equal(db.calls.length, 0);
});

test('ошибка базы не роняет бота', async () => {
  const s = hubStaff(fakeDb([], true));
  assert.equal(await s.byPhone9('901234567'), null);
  assert.equal(await s.byChat(123), null);
  assert.equal(await s.rememberChat(1, 123), false);
});

test('запоминает чат в карточке пользователя', async () => {
  const db = fakeDb([]);
  assert.equal(await hubStaff(db).rememberChat(7, 555), true);
  assert.match(db.calls[0].sql, /UPDATE public\.users SET tg_chat_id = \$1 WHERE id = \$2/);
  assert.deepEqual(db.calls[0].params, [555, 7]);
});

test('руководители из ERP по «Роли в боте»: только активные, подключённые, с телефоном', async () => {
  const db = fakeDb([{ chat_id: 111 }, { chat_id: 222 }]);
  const chats = await hubStaff(db).chatsByRole('logistics');
  assert.deepEqual(chats, [111, 222]);
  assert.match(db.calls[0].sql, /r\.bot_role = \$1/);   // роль в боте — из ролей ERP
  assert.match(db.calls[0].sql, /u\.is_active/);
  assert.match(db.calls[0].sql, /tg_chat_id IS NOT NULL/);
  assert.deepEqual(db.calls[0].params, ['logistics']);
  assert.deepEqual(await hubStaff(fakeDb([], true)).chatsByRole('logistics'), []);   // сбой базы — никому, но не падаем
});

test('роли руководителей в ERP — без агента и водителя (они только в плитке бота)', () => {
  const { MANAGER_ROLES } = hubStaff;
  for (const r of ['head_of_sales', 'logistics', 'marketing', 'admin']) assert.ok(MANAGER_ROLES.has(r), r);
  assert.ok(!MANAGER_ROLES.has('agent'));
  assert.ok(!MANAGER_ROLES.has('expeditor'));
});
