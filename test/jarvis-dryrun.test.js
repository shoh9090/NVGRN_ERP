// Холостой прогон Джарвиса: такт целиком, но база и интернет — поддельные.
//
// Зачем. Проверка синтаксиса видит, что код «написан по правилам», но не
// запускает его. Из-за этого дважды подряд в прод уезжали ошибки, которые
// вылезают только при работе («opts is not defined»), и бот молчал полдня.
// Здесь мы честно вызываем такт: читаем «доски», разбираем «комментарии»,
// шлём «сообщения». Любая ошибка внутри такта оседает в status.last_error —
// его и проверяем.
const test = require('node:test');
const assert = require('node:assert');

const H24 = 86400000;
const CARD = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MEMBER = 'mmmmmmmmmmmmmmmmmmmmmmmm';

// --- поддельный Trello и Telegram ---
function fakeFetch(calls) {
  return async (url) => {
    const u = String(url);
    calls.push(u);
    const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.includes('api.telegram.org')) return json({ ok: true, result: { message_id: 1 } });
    if (u.includes('/organizations/') && u.includes('/boards')) return json([{ id: 'b1', name: 'Доска', url: 'https://trello.com/b/b1' }]);
    if (u.includes('/boards/b1/lists')) return json([{ id: 'l1', name: 'Нужно сделать' }]);
    if (u.includes('/boards/b1/cards')) {
      return json([{
        id: CARD, name: 'Тестовая карточка', due: new Date(Date.now() - 3 * H24).toISOString(),
        dueComplete: false, idMembers: [MEMBER], idList: 'l1',
        dateLastActivity: new Date(Date.now() - 30 * H24).toISOString(),
        shortUrl: 'https://trello.com/c/x', idBoard: 'b1',
      }]);
    }
    if (u.includes('/boards/b1/actions')) {
      return json([{
        id: 'act1', date: new Date(Date.now() - 2 * H24).toISOString(), idMemberCreator: 'other',
        memberCreator: { fullName: 'Коллега' },
        data: { text: '@tester посмотрите, пожалуйста, что тут не так', card: { id: CARD, name: 'Тестовая карточка', shortLink: 'x' }, board: { name: 'Доска' } },
      }]);
    }
    if (u.includes('/cards/')) {
      return json({ id: CARD, name: 'Тестовая карточка', shortUrl: 'https://trello.com/c/x', idBoard: 'b1',
        closed: false, due: new Date(Date.now() - 3 * H24).toISOString(), dueComplete: false, idList: 'l1', idMembers: [MEMBER] });
    }
    return json({});
  };
}

// --- поддельная база: отвечает тем, что в этом месте ждёт код ---
const RULES = JSON.stringify({
  workspace_id: 'ws1', workspace_name: 'NVGRN', reminders_enabled: true,
  work_from: 0, work_to: 24, work_days: [1, 2, 3, 4, 5, 6, 7],   // чтобы прогон шёл в любое время
});
function fakePool(log) {
  const person = {
    employee_id: 1, id: 1, full_name: 'Тестов Тест', trello_member_id: MEMBER,
    username: 'tester', jv_chat_id: 111, is_admin: true, is_finance: true,
  };
  const query = async (sql, params) => {
    const q = String(sql);
    log.push(q.replace(/\s+/g, ' ').trim().slice(0, 80));
    if (q.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
    if (q.includes("FROM settings")) {
      const key = (params || [])[0];
      if (q.includes("'jarvis_rules'") || key === 'jarvis_rules') return { rows: [{ value: RULES }] };
      return { rows: [] };
    }
    if (q.includes('FROM hr_employees')) return { rows: [person] };
    if (q.includes('FROM users u JOIN hr_employees')) return { rows: [person] };
    if (q.includes('FROM jarvis_mentions')) {
      if (q.startsWith('UPDATE')) return { rows: [] };
      if (q.includes('count(*)')) return { rows: [{ n: 1 }] };
      if (q.includes('array_agg')) return { rows: [{ card_id: CARD, emps: [1] }] };
      if (q.includes('DISTINCT card_id')) return { rows: [{ card_id: CARD }] };
      return { rows: [{
        id: 7, card_id: CARD, card_name: 'Тестовая карточка', card_url: 'https://trello.com/c/x',
        board_name: 'Доска', employee_id: 1, member_id: MEMBER, author_member_id: 'other',
        author_name: 'Коллега', text: 'посмотрите, пожалуйста', created_at: new Date(Date.now() - 2 * H24).toISOString(),
        answered_at: null, reminded_at: null, violation_at: null,
      }] };
    }
    if (q.includes('FROM jarvis_cards')) return { rows: [] };
    if (q.includes('FROM jarvis_log')) return { rows: [] };
    if (q.includes('INTO jarvis_log')) return { rows: [{ id: 1 }] };
    return { rows: [] };
  };
  return { query, connect: async () => ({ query, release() {} }) };
}

test('холостой прогон: такт Джарвиса проходит целиком без ошибок', async () => {
  const realFetch = global.fetch;
  const realToken = process.env.INTERNAL_BOT_TOKEN;
  const realTrelloKey = process.env.TRELLO_KEY;
  const realTrelloTok = process.env.TRELLO_TOKEN;
  const realWarn = console.warn;
  const warnings = [];
  try {
    const calls = [], sql = [];
    global.fetch = fakeFetch(calls);
    process.env.INTERNAL_BOT_TOKEN = '123:test';
    process.env.TRELLO_KEY = 'k';
    process.env.TRELLO_TOKEN = 't';
    console.warn = (...a) => warnings.push(a.join(' '));

    const bot = require('../src/jarvis-bot');
    bot.__setPool(fakePool(sql));
    await bot.tick();

    assert.strictEqual(bot.status.last_error, null,
      'такт упал на живом прогоне: ' + bot.status.last_error);
    assert.ok(calls.some((u) => u.includes('/boards/b1/cards')), 'карточки Trello не читались — прогон ничего не проверил');
    assert.ok(calls.some((u) => u.includes('api.telegram.org')), 'ни одного сообщения не ушло — путь напоминаний не проверен');
    // Ошибки времени выполнения внутри такта ловятся и пишутся в лог —
    // из-за этого бот «работает», но молчит. Такие тоже валим.
    const bad = warnings.filter((w) => /is not defined|is not a function|Cannot read|before initialization/.test(w));
    assert.deepStrictEqual(bad, [], 'ошибки во время прогона: ' + bad.join(' | '));
  } finally {
    global.fetch = realFetch;
    console.warn = realWarn;
    process.env.INTERNAL_BOT_TOKEN = realToken || '';
    process.env.TRELLO_KEY = realTrelloKey || '';
    process.env.TRELLO_TOKEN = realTrelloTok || '';
  }
});

// Тот же холостой прогон для разговора с моделью. Ошибка «opts is not defined»
// жила именно здесь, в ветке поиска в интернете, и рушила ВСЕ ответы бота.
test('холостой прогон: ответ модели с инструментом и поиском в интернете', async () => {
  const realFetch = global.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  try {
    let step = 0;
    const bodies = [];
    global.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      step++;
      const data = step === 1
        ? { content: [{ type: 'tool_use', id: 'u1', name: 'ostatki_sklada', input: {} }], stop_reason: 'tool_use', usage: {} }
        : { content: [{ type: 'text', text: 'На складе пусто.' }], stop_reason: 'end_turn', usage: {} };
      return { ok: true, status: 200, json: async () => data };
    };
    process.env.ANTHROPIC_API_KEY = 'test';
    const ai = require('../src/ai');
    const used = [];
    const r = await ai.ask('claude', {
      model: 'claude-sonnet-5', system: 'тест', messages: [{ role: 'user', content: 'что на складе?' }],
      tools: [{ name: 'ostatki_sklada', description: 'остатки', schema: { type: 'object', properties: {} } }],
      runTool: async (name) => { used.push(name); return { rows: [] }; },
      web: true,
    });
    assert.strictEqual(r.text, 'На складе пусто.');
    assert.deepStrictEqual(used, ['ostatki_sklada'], 'инструмент не вызвался — цифры пришли бы из головы модели');
    assert.ok((bodies[0].tools || []).some((t) => t.type === 'web_search_20260209'),
      'поиск в интернете включён, но модели про него не сказали');
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
  }
});
