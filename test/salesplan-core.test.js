// План продаж (ГП): счётная часть. Здесь проверяется то, на чём цифра плана
// может молча испортиться — границы недели, различие «ноль» и «не заполнено»,
// итоги и раскладка недельной цифры по дням.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/salesplan-core');

test('неделя всегда Пн–Вс, какой бы день ни дали', () => {
  // 14.09.2026 — понедельник (из рабочего файла Шоха).
  assert.strictEqual(core.weekStart('2026-09-14'), '2026-09-14');
  assert.strictEqual(core.weekStart('2026-09-20'), '2026-09-14');   // воскресенье — та же неделя
  assert.strictEqual(core.weekStart('2026-09-21'), '2026-09-21');   // следующий понедельник
  const days = core.weekDays('2026-09-17');
  assert.strictEqual(days.length, 7);
  assert.strictEqual(days[0].day, '2026-09-14');
  assert.strictEqual(days[0].wd, 'Пн');
  assert.strictEqual(days[6].day, '2026-09-20');
  assert.strictEqual(days[6].wd, 'Вс');
  assert.strictEqual(core.weekShift('2026-09-17', -1), '2026-09-07');
  assert.match(core.weekLabel('2026-09-14'), /14 — 20 сентября 2026/);
});

test('день недели считается по дате, а не по номеру колонки', () => {
  // Период может начинаться не с понедельника (месяц, произвольный отрезок).
  assert.strictEqual(core.wdOf('2026-09-01'), 'Вт');
  assert.strictEqual(core.wdOf('2026-09-19'), 'Сб');
  const sept = core.daysBetween('2026-09-01', '2026-09-30');
  assert.strictEqual(sept.length, 30);
  // Перепутанные местами даты — опечатка, а не повод показать пустой отчёт.
  assert.deepStrictEqual(core.daysBetween('2026-09-03', '2026-09-01'), core.daysBetween('2026-09-01', '2026-09-03'));
});

test('ноль и «не заполнено» — разные вещи', () => {
  assert.strictEqual(core.parseQty(''), null);
  assert.strictEqual(core.parseQty(null), null);
  assert.strictEqual(core.parseQty('   '), null);
  assert.strictEqual(core.parseQty('0'), 0);          // решение «ничего не планируем»
  assert.strictEqual(core.parseQty(' 1 250 '), 1250);
  assert.throws(() => core.parseQty('-5'), /отрицательным/);
  assert.throws(() => core.parseQty('2,5'), /целых штуках/);
  assert.throws(() => core.parseQty('много'), /числом/);
});

test('итог пустой строки — «не заполнено», а не ноль', () => {
  const days = core.weekDays('2026-09-14').map((d) => d.day);
  assert.strictEqual(core.rowTotal({}, days).qty, null);
  // Хотя бы один заполненный ноль — это уже заполненная строка с итогом 0.
  assert.strictEqual(core.rowTotal({ '2026-09-14': 0 }, days).qty, 0);
  assert.strictEqual(core.rowTotal({ '2026-09-14': 250, '2026-09-15': 240 }, days).qty, 490);
});

test('итог недели считается из строк — как в образце Excel не считаем', () => {
  // Понедельник розницы из файла «ГП с 14.09.2026 по 20,09,2026.xlsx».
  // Формула файла охватывала только первые 17 строк и давала 1747,
  // а по всем товарным строкам выходит 2327. Итоги берём из строк всегда.
  const mon = [135, 140, 90, 70, 6, 30, 160, 6, 80, 100, 320, 85, 10, 400, 100, 15, 0, 50, 50, 320, 160];
  const day = '2026-09-14';
  const rows = mon.map((q) => ({ cells: { [day]: q }, price: null }));
  const s = core.summarize(rows, [day]);
  assert.strictEqual(s.qty, 2327);
  assert.strictEqual(mon.slice(0, 17).reduce((a, b) => a + b, 0), 1747, 'диапазон формул файла');
  // Цены ни у кого нет — деньги остаются неизвестными, а не нулём.
  assert.strictEqual(s.money, null);
  assert.strictEqual(s.noPrice, rows.length);
});

test('деньги считаются только там, где есть цена', () => {
  const days = ['2026-09-14', '2026-09-15'];
  const rows = [
    { cells: { '2026-09-14': 10, '2026-09-15': 5 }, price: 12000 },
    { cells: { '2026-09-14': 100 }, price: null },           // прайс не выбран
  ];
  const s = core.summarize(rows, days);
  assert.strictEqual(s.qty, 115);
  assert.strictEqual(s.money, 15 * 12000);                   // 100 шт без цены в деньги не попали
  assert.strictEqual(s.byDay['2026-09-14'].qty, 110);
  assert.strictEqual(s.byDay['2026-09-14'].money, 10 * 12000);
  assert.strictEqual(s.noPrice, 1);
});

test('профиль дня недели: пятница крупнее понедельника', () => {
  const fact = [
    { day: '2026-09-14', qty: 10 },   // Пн
    { day: '2026-09-18', qty: 30 },   // Пт
    { day: '2026-09-20', qty: 10 },   // Вс
  ];
  const p = core.weekdayProfile(fact);
  assert.ok(p[4] > p[0], 'пятница должна быть крупнее понедельника');
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // Нет факта — профиля нет. Равномерность не выдаём за профиль спроса.
  assert.strictEqual(core.weekdayProfile([]), null);
  assert.strictEqual(core.weekdayProfile([{ day: '2026-09-14', qty: 0 }]), null);
});

test('раскладка недельной цифры по дням не теряет и не добавляет штук', () => {
  const p = core.weekdayProfile([
    { day: '2026-09-14', qty: 10 }, { day: '2026-09-15', qty: 10 }, { day: '2026-09-16', qty: 10 },
    { day: '2026-09-17', qty: 10 }, { day: '2026-09-18', qty: 30 }, { day: '2026-09-19', qty: 5 },
    { day: '2026-09-20', qty: 25 },
  ]);
  const parts = core.spreadWeek(100, p);
  assert.strictEqual(parts.reduce((a, b) => a + b, 0), 100);
  assert.ok(parts.every((x) => Number.isInteger(x) && x >= 0));
  assert.ok(parts[4] > parts[5], 'пятница больше субботы — так в факте');
  // Без профиля — ровно по дням, но сумма всё равно сходится.
  const even = core.spreadWeek(10, null);
  assert.strictEqual(even.reduce((a, b) => a + b, 0), 10);
});

test('направление товара берётся из «Направления торговли» SalesDoctor', () => {
  const chans = [{ code: 'horeca', name: 'HoReCa', sd_trade: 'Horeca' }, { code: 'retail', name: 'Розница', sd_trade: 'Розница' }];
  assert.strictEqual(core.channelOf('Horeca', chans), 'horeca');
  assert.strictEqual(core.channelOf(' horeca ', chans), 'horeca');   // регистр и пробелы не мешают
  assert.strictEqual(core.channelOf('Розница', chans), 'retail');
  assert.strictEqual(core.channelOf('HoReCa', chans), 'horeca');     // совпадение по нашему названию
  // Не проставлено или незнакомое — не угадываем: товар добавляется руками.
  assert.strictEqual(core.channelOf('', chans), null);
  assert.strictEqual(core.channelOf('Опт', chans), null);
});

test('менять план продаж может только РОП и админ', () => {
  const { canEditPlan } = require('../src/salesplan');
  assert.strictEqual(canEditPlan({ isAdmin: true, roles: [] }), true);
  assert.strictEqual(canEditPlan({ isAdmin: false, roles: ['Руководитель продаж'] }), true);
  assert.strictEqual(canEditPlan({ isAdmin: false, roles: ['роп'] }), true);
  // Плитка у человека есть (иначе страница не открылась бы), но план — не его.
  assert.strictEqual(canEditPlan({ isAdmin: false, roles: ['Склад'] }), false);
  assert.strictEqual(canEditPlan({ isAdmin: false, roles: ['Торговый агент'] }), false);
  assert.strictEqual(canEditPlan(null), false);
});
