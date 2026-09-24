// Претензии на стороне компании: кого и когда дёргает Джарвис.
// Граница (решение Шоха 24.09.2026): клиент и торговый агент — во внешнем боте,
// руководитель звена и РОП — у Джарвиса.
const test = require('node:test');
const assert = require('node:assert');

const cx = require('../src/jarvis-complaints');
const R = require('../src/jarvis-rules');

const rules = R.normalizeRules({ work_from: 9, work_to: 20, work_days: [1, 2, 3, 4, 5, 6, 7] });
// Момент отсчёта — рабочий день, чтобы часы считались, а не стояли.
const T = (h) => Date.parse('2026-09-24T05:00:00Z') + h * 3600000;   // 10:00 Ташкента + h

const claim = (over) => ({
  id: 1, created_at: new Date(T(0)).toISOString(), status: 'new',
  complaint_type: 'gryaz', internal_note: null, point_name: 'Точка', sd_id: 'c1', ...over,
});

test('критичная без решения: сначала напоминание, потом РОП и админ', () => {
  const crit = claim({ complaint_type: 'zhivnost' });
  assert.deepStrictEqual(cx.dueOwners([crit], T(0.5), rules, R), [], 'полчаса — ещё рано кого-то дёргать');
  const soon = cx.dueOwners([crit], T(1.5), rules, R);
  assert.strictEqual(soon.length, 1);
  assert.strictEqual(soon[0].stage, 'crit');
  assert.strictEqual(soon[0].escalate, false, 'первое напоминание — только руководителю');
  const late = cx.dueOwners([crit], T(4), rules, R);
  assert.strictEqual(late[0].stage, 'crit_esc');
  assert.strictEqual(late[0].escalate, true, 'через три часа подключаем РОПа и админа');
});

test('простая: напоминаем только о причине и только один раз', () => {
  const simple = claim({});
  assert.deepStrictEqual(cx.dueOwners([simple], T(1), rules, R), [], 'простую сначала решает агент');
  const due = cx.dueOwners([simple], T(4), rules, R);
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].stage, 'simple');
  assert.strictEqual(due[0].escalate, false, 'простую наверх не эскалируем');
  // Причина записана — вопрос закрыт.
  assert.deepStrictEqual(cx.dueOwners([claim({ internal_note: 'Перегрев в машине' })], T(9), rules, R), []);
});

test('закрытую претензию не напоминаем — иначе людей приучают не читать', () => {
  assert.deepStrictEqual(cx.dueOwners([claim({ status: 'resolved' })], T(9), rules, R), []);
  assert.deepStrictEqual(cx.dueOwners([claim({ complaint_type: 'zhivnost', status: 'resolved' })], T(9), rules, R), []);
});

test('ночью часы не идут: претензия в 19:50 к утру ждёт минуты, а не всю ночь', () => {
  const evening = claim({ created_at: new Date(Date.parse('2026-09-24T14:50:00Z')).toISOString() }); // 19:50 Ташкента
  const morning = Date.parse('2026-09-25T04:10:00Z');                                                // 9:10 следующего дня
  const due = cx.dueOwners([{ ...evening, complaint_type: 'zhivnost' }], morning, rules, R);
  assert.deepStrictEqual(due, [], 'рабочего часа ещё не набежало — будить некого');
});

test('карточка критичной зовёт к решению, простая — для сведения', () => {
  const c = { id: 7, point_name: 'Mari Wellness', product_name: 'Айсберг 500 гр', type_label: 'Живность', link_label: 'Поле' };
  const crit = cx.formatCard(c, true);
  assert.match(crit, /Критичная претензия №7/);
  assert.match(crit, /Выберите решение/);
  const simple = cx.formatCard(c, false);
  assert.match(simple, /для сведения \(решает агент\)/);
  assert.ok(!/Выберите решение/.test(simple), 'у простой решения не спрашиваем — её закрывает агент');
});

test('кнопки решения — только у критичной, причину можно дописать к любой', () => {
  const res = [{ code: 'zamena', label_ru: 'Замена' }, { code: 'vozvrat', label_ru: 'Возврат' }];
  const crit = cx.ownerKeyboard(7, true, res).reply_markup.inline_keyboard;
  assert.strictEqual(crit.length, 3, 'два решения и причина');
  assert.strictEqual(crit[0][0].callback_data, 'cr:7:zamena');
  const simple = cx.ownerKeyboard(7, false, res).reply_markup.inline_keyboard;
  assert.strictEqual(simple.length, 1);
  assert.strictEqual(simple[0][0].callback_data, 'cn:7');
});

test('переключатель претензий выключен по умолчанию, сроки не переворачиваются', () => {
  assert.strictEqual(R.normalizeRules({}).complaints_owners, false);
  const r = R.normalizeRules({ complaints_owners: true, complaint_crit_h: 2, complaint_crit_esc_h: 1 });
  assert.strictEqual(r.complaints_owners, true);
  assert.strictEqual(r.complaint_crit_esc_h, 2, 'эскалация не может быть раньше первого напоминания');
});
