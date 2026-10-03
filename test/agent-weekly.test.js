// Недельный список «кого обзвонить» торговому агенту (src/agent-weekly.js).
const test = require('node:test');
const assert = require('node:assert');
const W = require('../src/agent-weekly');

// Время по Ташкенту (UTC+5) → миллисекунды.
const at = (iso, hhmm) => Date.parse(`${iso}T${hhmm}:00+05:00`);
// 02.10.2026 — пятница, 05.10.2026 — понедельник, 06.10.2026 — вторник.

test('расписание: пятница и понедельник, с нужного часа и три часа после', () => {
  assert.equal(W.dueKind(at('2026-10-02', '08:30'), '08:30'), 'friday');
  assert.equal(W.dueKind(at('2026-10-05', '08:30'), '08:30'), 'monday');
  // Сервис перезапустился и поднялся позже — сводка всё равно уйдёт.
  assert.equal(W.dueKind(at('2026-10-02', '10:15'), '08:30'), 'friday');
  // До времени и после окна — молчим.
  assert.equal(W.dueKind(at('2026-10-02', '08:29'), '08:30'), null);
  assert.equal(W.dueKind(at('2026-10-02', '11:31'), '08:30'), null);
  // Остальные дни недели — не наши.
  assert.equal(W.dueKind(at('2026-10-06', '08:30'), '08:30'), null);
  assert.equal(W.dueKind(at('2026-10-03', '08:30'), '08:30'), null);
});

test('отставшая выгрузка продаж: список не считаем', () => {
  assert.equal(W.dataFresh('2026-10-01', '2026-10-02'), true);
  assert.equal(W.dataFresh('2026-09-30', '2026-10-02'), true);
  assert.equal(W.dataFresh('2026-09-28', '2026-10-02'), false);   // четыре дня тишины — данные неполные
  assert.equal(W.dataFresh(null, '2026-10-02'), false);
});

const R = (o) => Object.assign({ agent_sd: 'a1', agent_name: 'Азизов', client_sd: 'c', client_name: 'Клиент', usual: 3000000, now_s: 1000000, days: 8 }, o);

test('разделение «просел» и «пропал», разовый клиент в «пропал» не идёт', () => {
  const g = W.groupByAgent([
    R({ client_sd: 'c1', client_name: 'Benedict', now_s: 1200000, usual: 3400000 }),
    R({ client_sd: 'c2', client_name: 'Kofe House', now_s: 0, usual: 2100000, days: 6 }),
    R({ client_sd: 'c3', client_name: 'Разовый', now_s: 0, usual: 900000, days: 2 }),
  ]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].drops.map((x) => x.name), ['Benedict']);
  assert.deepEqual(g[0].gone.map((x) => x.name), ['Kofe House']);
});

test('каждому агенту — только его клиенты, вперёд тот, у кого их больше', () => {
  const g = W.groupByAgent([
    R({ agent_sd: 'a1', agent_name: 'Азизов', client_sd: 'c1', client_name: 'Первый' }),
    R({ agent_sd: 'a2', agent_name: 'Бахтиёров', client_sd: 'c2', client_name: 'Второй' }),
    R({ agent_sd: 'a2', agent_name: 'Бахтиёров', client_sd: 'c3', client_name: 'Третий' }),
  ]);
  assert.deepEqual(g.map((x) => x.agent_sd), ['a2', 'a1']);
  assert.deepEqual(g[0].drops.map((x) => x.name), ['Второй', 'Третий']);
});

test('клиент из списка исключений РОПа молчит и у агента', () => {
  const g = W.groupByAgent([
    R({ client_sd: 'c1', client_name: 'Yandex_lavka' }),
    R({ client_sd: 'c2', client_name: 'Benedict' }),
  ], ['yandex']);
  assert.deepEqual(g[0].drops.map((x) => x.name), ['Benedict']);
});

test('строка без агента в список не попадает: слать её некому', () => {
  assert.deepEqual(W.groupByAgent([R({ agent_sd: null })]), []);
});

test('текст: пятница — «до выходных», понедельник — «начать неделю», цифры на месте', () => {
  const g = W.groupByAgent([
    R({ client_sd: 'c1', client_name: 'Benedict', now_s: 1200000, usual: 3400000 }),
    R({ client_sd: 'c2', client_name: 'Kofe House', now_s: 0, usual: 2100000, days: 6 }),
  ])[0];
  const fri = W.formatMessage(g, { kind: 'friday', from: '2026-09-25', to: '2026-10-01' });
  assert.match(fri, /Кого обзвонить до выходных/);
  assert.match(fri, /Неделя 25\.09–01\.10/);
  assert.match(fri, /🚫 Kofe House — неделю тишины, обычно 2\s100\s000 в неделю/);
  assert.match(fri, /📉 Benedict — 1\s200\s000 за неделю, обычно 3\s400\s000 \(меньше на 65%\)/);
  const mon = W.formatMessage(g, { kind: 'monday', from: '2026-09-28', to: '2026-10-04' });
  assert.match(mon, /С кого начать неделю/);
});

test('длинный список обрезается, хвост посчитан; пустому агенту не пишем', () => {
  const rows = [];
  for (let i = 0; i < W.MAX_LINES + 3; i++) rows.push(R({ client_sd: 'c' + i, client_name: 'Клиент ' + i, usual: 3000000 + i, now_s: 100000 }));
  const text = W.formatMessage(W.groupByAgent(rows)[0], { kind: 'friday', from: '2026-09-25', to: '2026-10-01' });
  assert.match(text, /…и ещё 3/);
  assert.equal(W.formatMessage({ agent_sd: 'a1', drops: [], gone: [] }, { kind: 'friday', from: '2026-09-25', to: '2026-10-01' }), null);
});
