// J05: результат инструмента не должен приходить модели оборванным посередине,
// а сбой источника не должен выглядеть как «всё хорошо, данных нет».
const test = require('node:test');
const assert = require('node:assert');
const { packResult } = require('../src/ai');

test('длинный результат остаётся корректным JSON, итоги не теряются', () => {
  const big = {
    период: { с: '2026-09-01', по: '2026-09-30' },
    итого: { обращений: 1234, ответили_сами: 900 },
    по_людям: Array.from({ length: 3000 }, (_, i) => ({ сотрудник: 'Сотрудник ' + i, отдел: 'Производство', обращений: i })),
  };
  const packed = packResult(big);
  const parsed = JSON.parse(packed);                       // падение здесь = обрыв JSON
  assert.strictEqual(parsed.итого.обращений, 1234, 'итоги обязаны пережить сокращение');
  assert.deepStrictEqual(parsed.период, big.период);
  assert.ok(parsed.по_людям.length < 3000, 'длинный список сокращается');
  assert.strictEqual(parsed.по_людям_всего, 3000, 'сказано, сколько было на самом деле');
  assert.match(parsed.часть_данных, /Полный список/);
});

test('короткий результат не трогаем', () => {
  const small = { итого: { штук: 10 }, товары: [{ товар: 'Айсберг', штук: 10 }] };
  assert.deepStrictEqual(JSON.parse(packResult(small)), small);
});

test('совсем неподъёмный результат объясняется словами, а не обрывком', () => {
  const huge = { текст: 'я'.repeat(200000) };
  const parsed = JSON.parse(packResult(huge));
  assert.match(parsed.статус, /слишком большой/);
  assert.match(parsed.пояснение, /Excel|сузьте|Сузьте/);
});
