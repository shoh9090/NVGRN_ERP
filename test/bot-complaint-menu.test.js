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
