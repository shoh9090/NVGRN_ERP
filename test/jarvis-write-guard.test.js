// Запись в Trello из бота — это действие от имени человека. Проверяем, что
// перед самой записью право проверяется ещё раз, а повтор одного и того же
// сообщения от Telegram не выполняет действие дважды.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'jarvis-bot.js'), 'utf8');
const bodyOf = (name) => {
  const i = src.indexOf('async function ' + name + '(');
  assert.ok(i > 0, 'функция ' + name + ' не найдена');
  return src.slice(i, i + 900);
};

test('ответ в карточку: право проверяется перед записью, а не только при нажатии кнопки', () => {
  const b = bodyOf('postReply');
  const check = b.indexOf('cardInWorkspace');
  const write = b.indexOf('trello.addComment');
  assert.ok(check > 0, 'перед публикацией нет проверки пространства');
  assert.ok(check < write, 'проверка идёт после записи — поздно');
});

test('срок карточки: то же самое перед изменением', () => {
  const b = bodyOf('applyDue');
  const check = b.indexOf('cardInWorkspace');
  const write = b.indexOf('trello.setDue');
  assert.ok(check > 0 && check < write, 'срок ставится без повторной проверки');
});

test('повторная доставка одного сообщения не выполняет действие дважды', () => {
  const i = src.indexOf('function webhook(');
  const b = src.slice(i, i + 700);
  assert.match(b, /firstTime\(/, 'повторы update_id не отсекаются');
});
