// Тесты правил сервиса источников калькуляции (ТЗ 8.5, 8.6).
// Здесь проверяется то, что не требует базы: раскладка расходов Кассы по блокам
// и состав полей «Начислено» — две вещи, где ошибка сразу искажает себестоимость.
const { test } = require('node:test');
const assert = require('node:assert');
const { BUCKET_BY_GROUP } = require('../src/calculation-sources');
const { ACCR_FIELDS, ACCR_ALL, DED_SUM } = require('../src/hr-fields');

test('расходы Кассы: сырьё (группа 1) не берётся второй раз', () => {
  assert.strictEqual(BUCKET_BY_GROUP[1].bucket, null);
  assert.match(BUCKET_BY_GROUP[1].reason, /рецептур/i);
});

test('расходы Кассы: капвложения (группа 7) не входят в себестоимость единицы', () => {
  assert.strictEqual(BUCKET_BY_GROUP[7].bucket, null);
  assert.match(BUCKET_BY_GROUP[7].reason, /капитальн/i);
});

test('расходы Кассы: группы 2–6 попадают в свои блоки', () => {
  assert.strictEqual(BUCKET_BY_GROUP[2].bucket, 'production');
  assert.strictEqual(BUCKET_BY_GROUP[3].bucket, 'commercial');
  assert.strictEqual(BUCKET_BY_GROUP[4].bucket, 'admin');
  assert.strictEqual(BUCKET_BY_GROUP[5].bucket, 'logistics');
  assert.strictEqual(BUCKET_BY_GROUP[6].bucket, 'finance');
});

test('расходы Кассы: «прочее» (группа 8) идёт в накладные, а не теряется', () => {
  assert.strictEqual(BUCKET_BY_GROUP[8].bucket, 'admin');
});

test('ФОТ: «Фикса» (accr_salary) не входит в сумму начислено', () => {
  // Ловушка: accr_salary — это базовая ставка, а не начисление за месяц.
  assert.ok(ACCR_ALL.includes('accr_salary'), 'колонка существует в ведомости');
  assert.ok(!ACCR_FIELDS.includes('accr_salary'), 'но в «Начислено» её быть не должно');
});

test('ФОТ: «долг компании» считается удержанием, а не начислением', () => {
  assert.ok(!ACCR_FIELDS.includes('accr_company_debt'));
  assert.ok(DED_SUM.includes('accr_company_debt'));
});

test('ФОТ: больничные, отпускные, матпомощь и компенсация входят в начислено', () => {
  for (const f of ['accr_sick', 'accr_vacation', 'accr_mataid', 'accr_comp_vac']) {
    assert.ok(ACCR_FIELDS.includes(f), 'ожидалось поле ' + f);
  }
});
