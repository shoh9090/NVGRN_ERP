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
      if (/FROM tgbot\.complaints c WHERE c\.id/.test(sql)) return { rows: [{ ...CARD, created_at: '2026-09-16T18:30:00Z', agent_sd_id: null, agent_name: 'Said' }] };
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

test('рабочие часы: ночь не считается', () => {
  const { workHours } = linkOwners;
  // 17.09 19:50 Ташкента (14:50 UTC) → 18.09 09:10 Ташкента (04:10 UTC) = 10 + 10 минут
  const h = workHours(Date.parse('2026-09-17T14:50:00Z'), Date.parse('2026-09-18T04:10:00Z'));
  assert.ok(Math.abs(h - 20 / 60) < 1e-9);
  assert.equal(workHours(Date.parse('2026-09-17T05:00:00Z'), Date.parse('2026-09-17T07:00:00Z')), 2);
});

test('напоминания: агент 30 мин/2 ч, критичная 1 ч/3 ч, простая 3 ч/рабочий день', () => {
  const { dueReminders } = linkOwners;
  const NOW = Date.parse('2026-09-17T12:00:00Z');                // 17:00 Ташкента, с 9:00 прошло 8 рабочих часов
  const ago = (h) => new Date(NOW - h * 3600000).toISOString(); // в пределах одного дня — рабочие = обычные
  const crit = new Set(['zhivnost']);
  const due = dueReminders([
    { id: 1, created_at: ago(0.2), complaint_type: 'zhivnost', status: 'new' },               // рано всем
    { id: 2, created_at: ago(1.5), complaint_type: 'zhivnost', status: 'agent_reacted' },     // звено 1 ч
    { id: 3, created_at: ago(4), complaint_type: 'zhivnost', status: 'new' },                 // агент 2 ч + звено 3 ч
    { id: 4, created_at: ago(5), complaint_type: 'zhivnost', status: 'resolved' },            // решена — молчим
    { id: 5, created_at: ago(3.5), complaint_type: 'vlazhnost', status: 'agent_reacted', internal_note: '' },
    { id: 6, created_at: ago(5), complaint_type: 'vlazhnost', status: 'agent_reacted', internal_note: 'Комолиддин: сушка' },
    { id: 7, created_at: ago(0.7), complaint_type: 'vlazhnost', status: 'new', internal_note: null }, // агент 30 мин
  ], NOW, crit);
  assert.deepEqual(due.map((d) => [d.id, d.who, d.stage, d.escalate]), [
    [2, 'owner', 'crit1', false],
    [3, 'agent', 'ag2', true], [3, 'owner', 'crit3', true],
    [5, 'owner', 'simple3', false],
    [7, 'agent', 'ag30', false],
  ]);
});

test('напоминание: сверху «подана тогда-то», без повторной отправки видео', async () => {
  const bot = fakeBot();
  const lo = linkOwners({ db: fakeDb([{ chat_id: 111 }]), bot });
  await lo.sendCard(42, { critical: false, remind: true });
  assert.deepEqual(bot.sent.map((x) => x.m), ['text']);
  assert.match(bot.sent[0].text, /^⏰ Напоминание: претензия №42 подана 16\.09 в 23:30, причины от вас пока нет\.\n\n/);
  assert.match(bot.sent[0].text, /Напишите, в чём причина и что сделали/);
});
