// Возврат банка — не выручка (src/cash.js, сверка ERP с CRM 22.09.2026).
const test = require('node:test');
const assert = require('node:assert');
const { looksLikeBankReturn } = require('../src/cash');

test('узнаём возврат платежа по тексту банка', () => {
  assert.ok(looksLikeBankReturn("00634 Qabul qiluvchi ma'lumotlari yozilmaganligi sababli qaytarilmoqda(00098 Оплата за свежую зелень)"));
  assert.ok(looksLikeBankReturn('Возврат платежа по реквизитам'));
  assert.ok(looksLikeBankReturn('Vozvrat sredstv'));
});

test('обычная оплата клиента возвратом не считается', () => {
  assert.ok(!looksLikeBankReturn('00098 Оплата за зелень в ассортименте с-но договора № 90'));
  assert.ok(!looksLikeBankReturn('PAY(160027623) Оплата по договору 34, в том числе НДС 12%'));
  assert.ok(!looksLikeBankReturn(''));
});
