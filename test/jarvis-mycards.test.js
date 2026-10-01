// J07: кнопка «Мои карточки» и вопрос словами должны давать одинаковые факты.
// Проверяем, что оба берут один сбор и что лимит показа не меняет счётчики.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

test('инструмент ИИ отвечает теми же данными, что и кнопка', async () => {
  const bot = require('../src/jarvis-bot');
  const { TOOLS } = require('../src/ai-tools');
  const tool = TOOLS.find((t) => t.name === 'moi_kartochki_trello');

  const realQuery = db.pool.query;
  const realData = bot.myCardsData;
  db.pool.query = async (q) => (/FROM hr_employees/.test(String(q))
    ? { rows: [{ employee_id: 5, trello_member_id: 'm1' }] } : { rows: [] });
  // Подменяем общий сбор: 25 упоминаний и 3 просрочки, показываем по 10.
  bot.myCardsData = async (me, limit) => ({
    trello_сопоставлен: true,
    снимок_trello: '2026-10-01T12:00:00.000Z',
    упоминаний_без_ответа: 25,
    просрочено_карточек: 3,
    упоминания: Array.from({ length: Math.min(limit, 25) }, (_, i) => ({
      card_name: 'Карточка ' + i, card_url: 'https://trello.com/c/' + i, author_name: 'Шох',
      created_at: '2026-09-15T06:00:00Z', muted_at: i === 0 ? '2026-09-29T06:00:00Z' : null })),
    просрочки: [{ name: 'Просроченная', shortUrl: 'https://trello.com/c/x', due: '2026-09-20T06:00:00Z' }],
  });
  try {
    const r = await tool.run({}, { employee_id: 5 });
    assert.strictEqual(r.упоминаний_без_ответа, 25, 'полный счётчик не режется лимитом показа');
    assert.strictEqual(r.просрочено_карточек, 3, 'просрочки инструмент теперь тоже знает');
    assert.strictEqual(r.ждут_ответа.length, 10, 'в ответ идёт короткий список');
    assert.match(r.показано, /10 из 25/);
    assert.ok(r.ждут_ответа[0].ссылка, 'есть ссылка на карточку');
    assert.strictEqual(r.ждут_ответа[0].напоминать_перестали, true, 'видно, что бот замолчал');
  } finally { db.pool.query = realQuery; bot.myCardsData = realData; }
});
