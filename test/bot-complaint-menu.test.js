// Претензии в клиентском боте: кнопка «Претензия» и клавиатура после мастера
// (tg-bot/complaints.js). Разбор 03.10.2026: агент нажимал «📩 Претензия» и
// получал «вы не привязаны как клиент», а после мастера за клиента у него
// оставалось клиентское меню — выглядело как потеря доступа.
const test = require('node:test');
const assert = require('node:assert');
const complaints = require('../tg-bot/complaints');

const CLIENT_KB = { reply_markup: { keyboard: [['🛒 Заказать']] } };
const AGENT_KB = { reply_markup: { keyboard: [['👥 Мои клиенты']] } };

// Бот-протез: запоминает, что отправили и с какой клавиатурой.
function fakeBot() {
  const sent = [];
  return { sent, sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); } };
}

function setup(staff) {
  const bot = fakeBot();
  complaints.init({
    bot, db: { query: async () => ({ rows: [] }) },
    getLang: async () => 'ru',
    staffOf: async () => staff,
    menuFor: async () => (staff ? AGENT_KB : CLIENT_KB),
    mainMenu: () => CLIENT_KB,
    pointsOfUser: async () => [],
    pointsOfAgent: async () => [],
    phone9OfUser: async () => '901234567',
    getOrders14: async () => [],
  });
  return bot;
}

const msg = (text) => ({ chat: { id: 10, type: 'private' }, from: { id: 77 }, text });

test('агент жмёт «Претензия» — открывается мастер за клиента, а не отказ', async () => {
  const bot = setup({ role: 'agent', crm_agent_id: 'a1' });
  assert.equal(await complaints.onMessage(msg('📩 Претензия')), true);
  const last = bot.sent[bot.sent.length - 1];
  assert.match(last.text, /название вашей торговой точки/);
  assert.doesNotMatch(last.text, /не привязаны как клиент/);
});

test('другой сотрудник получает своё меню, а не клиентский мастер', async () => {
  const bot = setup({ role: 'logistics' });
  assert.equal(await complaints.onMessage(msg('📩 Претензия')), true);
  const last = bot.sent[bot.sent.length - 1];
  assert.match(last.text, /для клиентов/);
  assert.deepEqual(last.opts, AGENT_KB);           // меню роли, не клиентское
});

test('клиенту без точек — прежний понятный отказ', async () => {
  const bot = setup(null);
  assert.equal(await complaints.onMessage(msg('📩 Претензия')), true);
  assert.match(bot.sent[bot.sent.length - 1].text, /не привязаны как клиент/);
});

test('мастер не возвращает клиентскую клавиатуру сотруднику', () => {
  // Правило держим и проверкой кода: один забытый H.mainMenu(lang) снова
  // отнимет у агента его меню, а заметно это станет только в чате.
  const src = require('fs').readFileSync(require('path').join(__dirname, '../tg-bot/complaints.js'), 'utf8');
  assert.equal(/H\.mainMenu\s*\(/.test(src.replace(/\/\/.*$/gm, '')), false);
});

// ---- Почему претензию принять нельзя (отказ объясняет себя) ----
const NOW = Date.parse('2026-10-03T12:00:00+05:00');

test('агенту называем дату последней отгрузки и срок', () => {
  const txt = complaints.noOrdersText('ru', { byAgent: true, last: '2026-09-28', now: NOW });
  assert.match(txt, /Последняя отгрузка: 28\.09 \(5 дн\. назад\)/);
  assert.match(txt, new RegExp(`не старше ${complaints.FRESH_DAYS} дн`));
  assert.match(txt, /SalesDoctor/);                       // агенту — где проверить
  assert.doesNotMatch(txt, /Обратитесь к вашему агенту/);  // агент и есть агент
});

test('клиенту — тот же разбор, но с выходом на агента', () => {
  const txt = complaints.noOrdersText('ru', { byAgent: false, last: '2026-09-28', now: NOW });
  assert.match(txt, /свяжитесь с вашим агентом/i);
  assert.doesNotMatch(txt, /SalesDoctor/);
});

test('отгрузок вообще не нашлось — говорим прямо, без выдуманных дат', () => {
  const txt = complaints.noOrdersText('ru', { byAgent: true, last: null, now: NOW });
  assert.match(txt, /Отгрузок по этой точке не нашёл/);
  assert.doesNotMatch(txt, /\d{2}\.\d{2}/);               // даты нет — и выдумывать нечего
});

test('узбекский вариант тоже объясняет причину', () => {
  const txt = complaints.noOrdersText('uz', { byAgent: true, last: '2026-09-28', now: NOW });
  assert.match(txt, /Oxirgi yetkazib berish: 28\.09/);
  assert.match(txt, /shikoyat berib bo‘lmaydi/i);
});

// ---- Сбой CRM не должен выглядеть как «заказов нет» ----
const sd = require('../tg-bot/salesdoctor');

test('ответ SalesDoctor об отказе входа не выносит наружу логин и пароль', () => {
  // SD эхом возвращает присланные креды — в лог и в Telegram они попасть не должны.
  const json = { status: false, result: { login: 'tgbot_sales', password: 'СЕКРЕТНЫЙ' },
    error: { code: 401, message: 'Invalid login/password' } };
  const txt = sd.safeError(json);
  assert.match(txt, /401/);
  assert.match(txt, /Invalid login\/password/);
  assert.doesNotMatch(txt, /СЕКРЕТНЫЙ/);
  assert.doesNotMatch(txt, /tgbot_sales/);
});

test('CRM не ответила — мастер так и говорит, а не «отгрузок нет»', async () => {
  const bot = fakeBot();
  complaints.init({
    bot, db: { query: async () => ({ rows: [] }) },
    getLang: async () => 'ru',
    staffOf: async () => null,
    menuFor: async () => CLIENT_KB,
    pointsOfUser: async () => [{ sd_id: 'd5_1883', point_name: 'Sezam_ garden' }],
    phone9OfUser: async () => '901234567',
    getOrders14: async () => { throw new Error('SalesDoctor не пустил бота (код 401)'); },
  });
  await complaints.onMessage(msg('📩 Претензия'));
  const last = bot.sent[bot.sent.length - 1];
  assert.match(last.text, /связаться с CRM/i);
  assert.doesNotMatch(last.text, /подать нельзя/);
});
