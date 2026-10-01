// J06: «последние 30 дней», потом «пришли Excel» — должен прийти тот же период.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { TOOLS } = require('../src/ai-tools');

const team = TOOLS.find((t) => t.name === 'kto_ne_otvechaet');
const excel = TOOLS.find((t) => t.name === 'otchet_excel');

test('файл берёт период последнего отчёта, а не текущий месяц', async () => {
  const realQuery = db.pool.query;
  const bot = require('../src/jarvis-bot');
  const report = require('../src/jarvis-report');
  const realSend = bot.sendFile;
  const realWb = report.workbook;
  let used = null;
  db.pool.query = async () => ({ rows: [] });
  report.workbook = async (opts) => { used = opts; return { buf: Buffer.from('x'), name: 'test.xlsx' }; };
  bot.sendFile = async () => true;
  const ctx = { user: { id: 1, isAdmin: true }, employee_id: 1, chatId: 777 };
  try {
    // Человек попросил «за последние 30 дней» — инструмент запомнил отрезок.
    const r1 = await team.run({ days: 30, department: 'Производство' }, ctx);
    const from = r1.период.с, to = r1.период.по;
    assert.ok(from && to);
    // Следом «пришли Excel» без параметров.
    const r2 = await excel.run({}, ctx);
    assert.strictEqual(used.from, from, 'период сохранён');
    assert.strictEqual(used.to, to);
    assert.strictEqual(used.department, 'Производство', 'фильтр отдела тоже сохранён');
    assert.match(r2.итог, /отправлен/);
  } finally { db.pool.query = realQuery; bot.sendFile = realSend; report.workbook = realWb; }
});

test('«файл отправлен» не говорится, когда отправка не удалась', async () => {
  const realQuery = db.pool.query;
  const bot = require('../src/jarvis-bot');
  const report = require('../src/jarvis-report');
  const realSend = bot.sendFile;
  const realWb = report.workbook;
  db.pool.query = async () => ({ rows: [] });
  report.workbook = async () => ({ buf: Buffer.from('x'), name: 'test.xlsx' });
  bot.sendFile = async () => false;
  try {
    const r = await excel.run({ month: '2026-09' }, { user: { id: 1, isAdmin: true }, chatId: 777 });
    assert.ok(!/отправлен в чат/.test(r.итог), 'ложного успеха быть не должно');
    assert.match(r.итог, /не принял|не получилось/i);
  } finally { db.pool.query = realQuery; bot.sendFile = realSend; report.workbook = realWb; }
});
