// Решение руководителя звена по критичной претензии (tg-bot/complaints.js).
// Проверяем через настоящий обработчик кнопки: кто может решать, что пишется
// в карточку, кто получает итог и что второе нажатие ничего не перезаписывает.
const test = require('node:test');
const assert = require('node:assert');

function setup({ owners = [{ chat_id: 111, full_name: 'Комолиддин' }, { chat_id: 222, full_name: 'Бахром' }], alreadyResolvedBy = null } = {}) {
  // Модуль держит состояние в себе — берём свежую копию на каждый тест.
  delete require.cache[require.resolve('../tg-bot/complaints')];
  const complaints = require('../tg-bot/complaints');
  const log = { sql: [], sent: [], answers: [], agent: [] };
  const db = {
    async query(sql, params) {
      log.sql.push({ sql, params });
      if (/JOIN tgbot\.complaint_dicts d ON d\.kind = 'link'/.test(sql)) return { rows: owners };
      if (/kind='resolution'/.test(sql)) return { rows: [{ code: 'replace', label_ru: 'Замена' }] };
      if (/^\s*UPDATE tgbot\.complaints SET resolution/.test(sql)) {
        return alreadyResolvedBy ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ sd_id: 'SD7' }] };
      }
      if (/SELECT resolved_by FROM tgbot\.complaints/.test(sql)) return { rows: [{ resolved_by: alreadyResolvedBy }] };
      if (/internal_note = concat_ws/.test(sql)) return { rowCount: 1, rows: [] };
      return { rows: [] };
    },
  };
  const bot = {
    answerCallbackQuery: async (id, opts) => { log.answers.push(opts || {}); },
    editMessageReplyMarkup: async () => {},
    sendMessage: async (chat, text) => { log.sent.push({ chat, text }); },
  };
  complaints.init({
    bot, db, getLang: async () => 'ru', mainMenu: () => ({}),
    notifyClientAgent: async (sdId, text, key) => { log.agent.push({ sdId, text, key }); return true; },
  });
  const press = (fromId, data) => complaints.onCallback({ id: 'q1', from: { id: fromId }, data, message: { chat: { id: fromId }, message_id: 5 } });
  return { complaints, log, press };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test('руководитель звена решает: запись в карточку, итог коллегам и агенту', async () => {
  const { log, press } = setup();
  await press(111, 'cmpl:ores:42:replace');
  await tick();
  const upd = log.sql.find((x) => /SET resolution/.test(x.sql));
  assert.deepEqual(upd.params, ['replace', 'Комолиддин', '42']);
  assert.match(upd.sql, /status <> 'resolved'/);                       // не перезаписываем закрытую
  assert.ok(log.sent.some((m) => m.chat === 111 && /ваше решение — Замена/.test(m.text)));
  assert.ok(log.sent.some((m) => m.chat === 222 && /решение принял Комолиддин: Замена/.test(m.text)));
  assert.ok(!log.sent.some((m) => m.chat === 111 && /решение принял/.test(m.text))); // себе «уже решил» не шлём
  assert.equal(log.agent.length, 1);
  assert.equal(log.agent[0].sdId, 'SD7');
  assert.match(log.agent[0].text, /Свяжитесь с клиентом/);
  assert.equal(log.agent[0].key, 'cmpres:42');
});

test('чужой человек нажать не может — ничего не пишется', async () => {
  const { log, press } = setup();
  await press(999, 'cmpl:ores:42:replace');
  assert.ok(!log.sql.some((x) => /SET resolution/.test(x.sql)));
  assert.ok(log.answers.some((a) => a.show_alert && /руководитель звена/.test(a.text)));
  assert.equal(log.agent.length, 0);
});

test('уже решено другим — второе нажатие ничего не меняет и говорит, кто решил', async () => {
  const { log, press } = setup({ alreadyResolvedBy: 'Бахром' });
  await press(111, 'cmpl:ores:42:replace');
  assert.ok(log.answers.some((a) => /Уже закрыта: Бахром/.test(a.text)));
  assert.equal(log.agent.length, 0);
});

test('причина от руководителя ложится во внутреннюю заметку с именем', async () => {
  const { complaints, log, press } = setup();
  await press(111, 'cmpl:onote:42');
  const eaten = await complaints.onMessage({ chat: { id: 111 }, from: { id: 111 }, text: 'Поставщик сдал переросшую партию' });
  assert.equal(eaten, true);
  const note = log.sql.find((x) => /internal_note = concat_ws/.test(x.sql));
  assert.match(note.params[0], /^Комолиддин \(\d{2}\.\d{2}\.\d{4}\): Поставщик сдал переросшую партию$/);
  assert.equal(note.params[1], '42');
});
