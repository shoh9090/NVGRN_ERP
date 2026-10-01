// J08: кнопки в боте должны соответствовать роли, а их нажатие — давать тот же
// ответ, что и вопрос словами.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'jarvis-bot.js'), 'utf8');

test('у руководителя есть кнопки команды и товара, у рядового — нет', () => {
  assert.match(src, /const menuBoss = [\s\S]*MENU_TEAM[\s\S]*MENU_GOODS/, 'руководителю доступны обе');
  const plain = src.match(/const menu = \{[\s\S]*?\};/)[0];
  assert.ok(!/MENU_TEAM|MENU_GOODS/.test(plain), 'рядовому сотруднику эти кнопки не нужны');
  assert.match(src, /const menuGoods = [\s\S]*MENU_GOODS/, 'Закупу и Складу — кнопка товара');
});

test('кнопка «Отчёт по команде» задаёт тот же вопрос, что человек словами', () => {
  const i = src.indexOf('text === MENU_TEAM');
  const block = src.slice(i, i + 600);
  assert.match(block, /aiAnswer\(/, 'идёт через обычный разговорный путь');
  assert.match(block, /кто отвечает на карточки/, 'формулировка та же, что у человека');
  assert.match(block, /ai_enabled/, 'если вопросы словами выключены — честно говорим, а не молчим');
});

test('инструкция требует называть период и предлагать доступное вместо отказа', () => {
  assert.match(src, /Всегда называй период/);
  assert.match(src, /предложи ближайшее доступное/);
  assert.match(src, /Не отправляй человека к разработчикам без следующего шага/);
  assert.match(src, /Узбекский и русский вопрос понимай одинаково/);
});
