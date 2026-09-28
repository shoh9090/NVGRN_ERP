// Сверка с CRM не должна спотыкаться о наши же отправки. У оплаты, которую ERP
// посадила, номер в CRM записан прямо в нашей транзакции — значит она учтена.
// Если считать её «чужой», страховка «за этот день в CRM уже есть оплата на
// такую же сумму» блокирует соседние оплаты: 28.09.2026 три клиента заплатили
// по 3 000 000, первую провели — и две оставшиеся зависли на «Проверьте».
const { test } = require('node:test');
const assert = require('node:assert');
const { crmMinusOurs } = require('../src/cash');

const crm = [
  { sd_id: 'e9_69017', amount: 3000000, client_sd: 'y6_2118' },   // наша отправка
  { sd_id: 'e9_69100', amount: 3000000, client_sd: 'k1_9999' },   // внесли руками
  { sd_id: 'e9_69200', amount: 450000, client_sd: 'm2_1111' },
];

test('наши отправки из сверки убираются', () => {
  const rows = [{ sd_payment_id: 'e9_69017' }, { sd_payment_id: null }];
  const left = crmMinusOurs(crm, rows).map((x) => x.sd_id);
  assert.deepStrictEqual(left, ['e9_69100', 'e9_69200']);
});

test('чужие записи остаются — страховка против ручного ввода должна работать', () => {
  const rows = [{ sd_payment_id: 'e9_69017' }];
  const left = crmMinusOurs(crm, rows);
  assert.ok(left.some((x) => x.sd_id === 'e9_69100'),
    'оплату, внесённую в CRM руками, выкидывать нельзя — иначе посадим дубль');
});

test('ничего не отправляли — список CRM не меняется', () => {
  assert.strictEqual(crmMinusOurs(crm, [{ sd_payment_id: null }]).length, 3);
  assert.strictEqual(crmMinusOurs(crm, []).length, 3);
});

test('пустые входные данные не роняют сверку', () => {
  assert.deepStrictEqual(crmMinusOurs(null, null), []);
  assert.deepStrictEqual(crmMinusOurs([], [{ sd_payment_id: 'x' }]), []);
});
