// Связка Telegram-сотрудника бота и пользователя ERP по номеру (src/staff-link.js).
const test = require('node:test');
const assert = require('node:assert');
const { linkStaffChats } = require('../src/staff-link');

test('чат переносится из Telegram-сотрудников в карточку ERP по последним 9 цифрам', async () => {
  let sql = '';
  const n = await linkStaffChats({ query: async (q) => { sql = q; return { rowCount: 1 }; } });
  assert.equal(n, 1);
  assert.match(sql, /UPDATE users u SET tg_chat_id = s\.telegram_chat_id/);
  assert.match(sql, /right\(u\.tg_phone, 9\) = s\.phone_normalized/);
  assert.match(sql, /s\.status = 'confirmed'/);               // только подтверждённые
  assert.match(sql, /IS DISTINCT FROM/);                        // не переписываем без нужды
});
