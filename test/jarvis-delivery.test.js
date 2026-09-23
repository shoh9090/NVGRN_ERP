// Напоминание, которое не дошло, обязано повториться. Проверяем саму механику:
// отметку «напомнили» ставим только после успешной отправки, а журнал поднимает
// «доставлено», когда сообщение ушло со второй попытки.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'jarvis-bot.js'), 'utf8');

test('отметка «напомнили» ставится только после доставки', () => {
  const i = src.indexOf("step === 'remind'");
  assert.ok(i > 0, 'блок напоминания не найден');
  const block = src.slice(i, i + 1500);
  const mark = block.indexOf('SET reminded_at = now()');
  const send = block.indexOf('await deliver(');
  assert.ok(send > 0 && mark > send, 'отметка ставится раньше отправки — напоминание потеряется');
  assert.ok(block.slice(send, mark).includes('if (ok)'), 'отметка должна стоять под условием «дошло»');
});

test('журнал поднимает «доставлено», если сообщение ушло со второй попытки', () => {
  const i = src.indexOf('async function log(');
  const block = src.slice(i, i + 1200);
  assert.match(block, /UPDATE jarvis_log SET sent = TRUE/);
});

test('ответ в Trello считается реакцией, болтовня с ботом — нет', () => {
  const ins = fs.readFileSync(path.join(__dirname, '..', 'src', 'jarvis-insights.js'), 'utf8');
  const i = ins.indexOf('acted AS (');
  const block = ins.slice(i, ins.indexOf('open_m AS ('));
  assert.match(block, /FROM jarvis_mentions/, 'ответы в карточках Trello не учитываются');
  assert.ok(!/'ai', 'voice'/.test(block), '«привет» боту не должен считаться ответом на задачу');
});
