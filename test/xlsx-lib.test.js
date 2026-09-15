// Библиотека чтения и выгрузки Excel (xlsx / SheetJS).
//
// Версия 0.18.5 из общего каталога npm была уязвима: подмена свойств объектов
// при разборе файла и зависание на специально испорченном файле. Исправлено
// в 0.19.3 и 0.20.2, но в npm исправленных версий нет — SheetJS раздаёт их со
// своего сайта (package.json: https://cdn.sheetjs.com/...).
//
// Проверяем: версия не уязвимая, и всё, чем пользуются модули Hub (импорт
// выписок, претензий, прайсов, выгрузки в Excel), работает как раньше.
const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');

test('версия не ниже исправленной (0.20.2)', () => {
  const [a, b, c] = String(XLSX.version).split('.').map(Number);
  assert.ok(a > 0 || b > 20 || (b === 20 && c >= 2), 'уязвимая версия xlsx: ' + XLSX.version);
});

test('выгрузка и чтение .xlsx — строки, числа, даты по-русски', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Поставщик', 'Сумма', 'Дата'],
    ['Akrom', 212497000, '18.08.2026'],
    ['Боходир Ока', 273190900.5, '23.08.2026'],
  ]), 'Взаиморасчёты');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const back = XLSX.read(buf, { type: 'buffer' });
  assert.deepEqual(back.SheetNames, ['Взаиморасчёты']);
  const rows = XLSX.utils.sheet_to_json(back.Sheets['Взаиморасчёты']);
  assert.deepEqual(rows[1], { 'Поставщик': 'Боходир Ока', 'Сумма': 273190900.5, 'Дата': '23.08.2026' });
});

test('старый формат .xls (импорт выписок и истории принимает его)', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ 'Товар': 'Руккола 500 гр', 'Цена': 30000 }]), 'Лист1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
  const rows = XLSX.utils.sheet_to_json(XLSX.read(buf, { type: 'buffer' }).Sheets['Лист1']);
  assert.deepEqual(rows, [{ 'Товар': 'Руккола 500 гр', 'Цена': 30000 }]);
});

test('csv и массивы строк (header: 1) — как читают импорты', () => {
  const wb = XLSX.read('Код;Наименование\n101;Шпинат\n', { type: 'string', FS: ';' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  assert.deepEqual(aoa, [['Код', 'Наименование'], [101, 'Шпинат']]);
});

test('файл с ловушкой __proto__ в заголовке не портит объекты программы', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['__proto__', 'x'], ['{"polluted":1}', 1]]), 'S');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  XLSX.utils.sheet_to_json(XLSX.read(buf, { type: 'buffer' }).Sheets.S);
  assert.equal({}.polluted, undefined);
});
