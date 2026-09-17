// Руководители звеньев получают претензию лично (tg-bot/link-owners.js).
// Проверяем текст карточки, кнопки, кому уходит и что сбой не роняет бота.
const test = require('node:test');
const assert = require('node:assert');
const linkOwners = require('../tg-bot/link-owners');
const { formatCard, ownerKeyboard } = linkOwners;

const CARD = {
  id: 42, point_name: 'Resto', firm_name: 'Resto LLC', product_name: 'Руккола 500 гр', ship_date: '2026-09-14',
  type_label: 'Переросший', link_label: 'Поле · сырьё', client_comment: 'Листья жёсткие', agent: 'Khayrullaev Said',
};

test('простая претензия — для сведения, без кнопок решения', () => {
  const t = formatCard(CARD, false);
  assert.match(t, /Претензия №42 — для сведения \(решает агент\)/);
  assert.match(t, /Звено: Поле · сырьё/);
  assert.match(t, /Точка: Resto \(Resto LLC\)/);
  assert.match(t, /отгрузка 14\.09\.2026/);
  assert.doesNotMatch(t, /Выберите решение/);
  const kb = ownerKeyboard(42, false, [{ code: 'replace', label_ru: 'Замена' }]);
  assert.equal(kb.inline_keyboard.length, 1);                       // только «Написать причину»
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'cmpl:onote:42');
});

test('критичная — нужно решение, кнопки из справочника', () => {
  assert.match(formatCard(CARD, true), /Критичная претензия №42 — нужно ваше решение/);
  const kb = ownerKeyboard(42, true, [{ code: 'replace', label_ru: 'Замена' }, { code: 'refund', label_ru: 'Возврат' }]);
  assert.deepEqual(kb.inline_keyboard.map((r) => r[0].callback_data), ['cmpl:ores:42:replace', 'cmpl:ores:42:refund', 'cmpl:onote:42']);
  // Telegram не принимает callback_data длиннее 64 байт.
  kb.inline_keyboard.forEach((r) => assert.ok(Buffer.byteLength(r[0].callback_data) <= 64));
});

test('точка без фирмы и без лишних скобок', () => {
  assert.match(formatCard({ id: 1, point_name: 'Safia', firm_name: 'Safia' }, false), /Точка: Safia$/m);
});

function fakeDb(owners, { fail } = {}) {
  return {
    async query(sql) {
      if (fail) throw new Error('column "tg_chat_id" does not exist');
      if (/FROM tgbot\.complaints c\s+JOIN tgbot\.complaint_dicts/.test(sql)) return { rows: owners };
      if (/FROM tgbot\.complaints c WHERE c\.id/.test(sql)) return { rows: [{ ...CARD, agent_sd_id: null, agent_name: 'Said' }] };
      if (/complaint_files/.test(sql)) return { rows: [{ kind: 'photo', tg_file_id: 'F1' }, { kind: 'photo', tg_file_id: 'F2' }, { kind: 'video_note', tg_file_id: 'V1' }] };
      return { rows: [] };
    },
  };
}
function fakeBot() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chat, text, opts) => { sent.push({ m: 'text', chat, text, opts }); },
    sendMediaGroup: async (chat, album) => { sent.push({ m: 'album', chat, album }); },
    sendPhoto: async (chat) => { sent.push({ m: 'photo', chat }); },
    sendVideo: async (chat) => { sent.push({ m: 'video', chat }); },
    sendVideoNote: async (chat) => { sent.push({ m: 'note', chat }); },
  };
}

test('карточка уходит каждому руководителю звена: сначала фото, потом текст с кнопками', async () => {
  const bot = fakeBot();
  const lo = linkOwners({ db: fakeDb([{ chat_id: 111, full_name: 'Анвар' }, { chat_id: 222, full_name: 'Бахром' }]), bot });
  const n = await lo.sendCard(42, { critical: true, resolutions: [{ code: 'replace', label_ru: 'Замена' }] });
  assert.equal(n, 2);
  const to111 = bot.sent.filter((x) => x.chat === 111).map((x) => x.m);
  assert.deepEqual(to111, ['album', 'note', 'text']);
  const card = bot.sent.find((x) => x.chat === 111 && x.m === 'text');
  assert.equal(card.opts.reply_markup.inline_keyboard[0][0].callback_data, 'cmpl:ores:42:replace');
});

test('никто не назначен или ошибка базы — никому не пишем и не падаем', async () => {
  const bot = fakeBot();
  assert.equal(await linkOwners({ db: fakeDb([]), bot }).sendCard(42, { critical: false }), 0);
  assert.equal(await linkOwners({ db: fakeDb([], { fail: true }), bot }).sendCard(42, { critical: false }), 0);
  assert.equal(bot.sent.length, 0);
});

test('нажать кнопку может только руководитель этого звена', async () => {
  const lo = linkOwners({ db: fakeDb([{ chat_id: 111, full_name: 'Анвар' }]), bot: fakeBot() });
  assert.equal((await lo.ownerByChat(42, 111)).full_name, 'Анвар');
  assert.equal(await lo.ownerByChat(42, 999), null);
});

test('«уже решил такой-то» — всем, кроме того, кто решил', async () => {
  const bot = fakeBot();
  const lo = linkOwners({ db: fakeDb([{ chat_id: 111 }, { chat_id: 222 }]), bot });
  await lo.tell(42, 'решено', 111);
  assert.deepEqual(bot.sent.map((x) => x.chat), [222]);
});

test('напоминания: критичная — 4 ч руководителю, сутки — ещё и РОПу; простая без причины — через сутки', () => {
  const { dueReminders } = linkOwners;
  const NOW = Date.parse('2026-09-17T12:00:00Z');
  const ago = (h) => new Date(NOW - h * 3600000).toISOString();
  const crit = new Set(['zhivnost']);
  const due = dueReminders([
    { id: 1, created_at: ago(2), complaint_type: 'zhivnost', status: 'new' },               // рано
    { id: 2, created_at: ago(5), complaint_type: 'zhivnost', status: 'agent_reacted' },     // 4 ч
    { id: 3, created_at: ago(30), complaint_type: 'zhivnost', status: 'new' },              // сутки + эскалация
    { id: 4, created_at: ago(30), complaint_type: 'zhivnost', status: 'resolved' },         // решена — молчим
    { id: 5, created_at: ago(25), complaint_type: 'vlazhnost', internal_note: '' },         // простая без причины
    { id: 6, created_at: ago(25), complaint_type: 'vlazhnost', internal_note: 'Комолиддин: сушка' }, // причина есть
    { id: 7, created_at: ago(10), complaint_type: 'vlazhnost', internal_note: null },       // простая, рано
  ], NOW, crit);
  assert.deepEqual(due.map((d) => [d.id, d.stage, d.escalate]), [[2, 'crit4', false], [3, 'crit24', true], [5, 'simple24', false]]);
});

test('напоминание: сверху «нет ответа N ч», без повторной отправки видео', async () => {
  const bot = fakeBot();
  const lo = linkOwners({ db: fakeDb([{ chat_id: 111 }]), bot });
  await lo.sendCard(42, { critical: false, remindHours: 26.4 });
  assert.deepEqual(bot.sent.map((x) => x.m), ['text']);
  assert.match(bot.sent[0].text, /^⏰ Напоминание: по претензии №42 нет причины уже 26 ч\.\n\n/);
  assert.match(bot.sent[0].text, /Напишите, в чём причина и что сделали/);
});
