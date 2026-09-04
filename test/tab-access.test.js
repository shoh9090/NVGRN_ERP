// Доступ по вкладкам внутри плитки. Ошибка здесь либо отрезает людям работу,
// либо наоборот показывает продажнику себестоимость всей компании, поэтому
// правила проверяем поштучно.
const { test } = require('node:test');
const assert = require('node:assert');
const { allowedTabs, tabAllowed } = require('../src/tab-access');

// Подставной pool: первый запрос — роли, дающие плитку, второй — отметки вкладок.
function fakePool(roleIds, tabRows) {
  let n = 0;
  return {
    query: async () => {
      n++;
      if (n === 1) return { rows: roleIds.map((id) => ({ role_id: id })) };
      return { rows: tabRows };
    },
  };
}
const user = { id: 7, isAdmin: false };

test('админ не ограничивается никогда', async () => {
  const got = await allowedTabs(fakePool([], []), { id: 1, isAdmin: true }, '/calculation');
  assert.strictEqual(got, null);
});

test('плитки нет вовсе — нет и вкладок', async () => {
  const got = await allowedTabs(fakePool([], []), user, '/calculation');
  assert.strictEqual(got.size, 0);
});

test('ничего не отмечено — доступны все вкладки', async () => {
  // Так работали все роли до появления механизма: пока никто не настраивал,
  // ничего не должно отвалиться.
  const got = await allowedTabs(fakePool([3], []), user, '/calculation');
  assert.strictEqual(got, null);
});

test('отмечены вкладки — видны только они', async () => {
  const got = await allowedTabs(fakePool([3], [
    { role_id: 3, code: 'sandbox' },
  ]), user, '/calculation');
  assert.deepStrictEqual([...got], ['sandbox']);
});

test('две роли с отметками — права складываются', async () => {
  const got = await allowedTabs(fakePool([3, 4], [
    { role_id: 3, code: 'sandbox' },
    { role_id: 4, code: 'summary' },
  ]), user, '/calculation');
  assert.deepStrictEqual([...got].sort(), ['sandbox', 'summary']);
});

test('одна роль без ограничений перебивает вторую с отметками', async () => {
  // Иначе человек, которому дали вторую роль «на посмотреть», внезапно потерял
  // бы доступ к вкладкам, которые у него были.
  const got = await allowedTabs(fakePool([3, 4], [
    { role_id: 3, code: 'sandbox' },
  ]), user, '/calculation');
  assert.strictEqual(got, null);
});

test('плитка не заведена в реестре — не ограничиваем', async () => {
  const got = await allowedTabs(fakePool([3], []), user, '/purchase');
  assert.strictEqual(got, null);
});

test('проверка кода вкладки', () => {
  assert.strictEqual(tabAllowed(null, 'anything'), true);
  assert.strictEqual(tabAllowed(new Set(['sandbox']), 'sandbox'), true);
  assert.strictEqual(tabAllowed(new Set(['sandbox']), 'retail'), false);
  // Пустой код — не «разрешено по умолчанию».
  assert.strictEqual(tabAllowed(new Set(['sandbox']), ''), false);
});

// Соответствие «адрес → вкладка» для Калькуляции. Промах здесь означал бы,
// что данные закрытого листа отдаются в обход настроек доступа.
const { calcTabOf } = require('../src/calculation');
// Для правки товара по id функция спрашивает лист у базы, поэтому она async.
const at = (p) => calcTabOf({ path: p });

test('адреса песочницы закрыты песочницей', async () => {
  assert.strictEqual(await at('/api/sandbox'), 'sandbox');
  assert.strictEqual(await at('/api/sandbox/calc'), 'sandbox');
  assert.strictEqual(await at('/api/sandbox/export.xlsx'), 'sandbox');
  assert.strictEqual(await at('/api/sandbox/min-margin'), 'sandbox');
});

test('товарный лист закрыт своим кодом, а не соседним', async () => {
  assert.strictEqual(await at('/api/sheet/salads'), 'salads');
  assert.strictEqual(await at('/api/sheet/retail/export.xlsx'), 'retail');
  assert.strictEqual(await at('/api/sheet/horeca250/approve'), 'horeca250');
});

test('несуществующий лист не превращается в код вкладки', async () => {
  assert.strictEqual(await at('/api/sheet/hack'), null);
});

test('сводка, производство, упаковка и рецептуры — каждая своя', async () => {
  assert.strictEqual(await at('/api/summary'), 'summary');
  assert.strictEqual(await at('/api/summary-export.xlsx'), 'summary');
  assert.strictEqual(await at('/api/price-export.xlsx'), 'summary');
  assert.strictEqual(await at('/api/production'), 'production');
  assert.strictEqual(await at('/api/output'), 'production');
  assert.strictEqual(await at('/api/costs/12'), 'production');
  assert.strictEqual(await at('/api/packaging/template/3'), 'packaging');
  assert.strictEqual(await at('/api/recipes/recipe/5'), 'recipes');
});

test('общие для плитки адреса вкладкой не закрываются', async () => {
  assert.strictEqual(await at('/'), null);
  assert.strictEqual(await at('/api/raw-price/8'), null);
  assert.strictEqual(await at('/api/approval/41'), null);
});
