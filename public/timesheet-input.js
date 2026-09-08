// timesheet-input.js — разбор того, что вписали в ячейку табеля.
//
// Файл один и для браузера, и для тестов: правило «что значит набранное»
// должно быть в одном месте, иначе экран и проверка разойдутся.
//
// Что понимает ячейка:
//   12      — отработано 12 часов
//   12+3    — 12 часов и 3 часа переработки (оплата переработки двойная)
//   +3      — смена по графику плюс 3 переработки
//   7,5     — запятая работает как точка
//   в о б н — выходной, отпуск, больничный, неявка
//   пусто   — снять отметку
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TimesheetInput = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Буквы принимаем и русские, и похожие латинские: на производстве раскладку
  // переключать некогда.
  const MARKS = {
    в: 'off', v: 'off',
    о: 'vacation', o: 'vacation',
    б: 'sick', b: 'sick',
    н: 'absent', нб: 'absent', n: 'absent', nb: 'absent',
  };

  function parseCell(raw, shiftHours) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase().replace(',', '.');
    if (!s) return { mark: null };
    if (MARKS[s]) return { mark: MARKS[s] };

    const m = s.match(/^(\d+(?:\.\d+)?)?\s*(?:\+\s*(\d+(?:\.\d+)?))?$/);
    if (!m || (m[1] === undefined && m[2] === undefined)) {
      return { error: 'Впишите часы, «12+3» с переработкой или букву: в о б н' };
    }
    const hours = m[1] === undefined ? Number(shiftHours) : Number(m[1]);
    if (!(hours > 0)) return { error: 'Часов должно быть больше нуля' };
    if (hours > 24) return { error: 'В сутках не больше 24 часов' };
    const ot = m[2] === undefined ? null : Number(m[2]);
    if (ot !== null && hours + ot > 24) return { error: 'Вместе с переработкой выходит больше суток' };
    return { mark: 'work', hours, overtime_hours: ot };
  }

  return { parseCell, MARKS };
});
