// hr-fields.js — состав полей расчётной ведомости Персонала.
//
// Вынесено из src/hr.js, чтобы «Начислено» считалось ОДНИМ списком полей и в
// Персонале, и в Калькуляции (ТЗ калькуляции 8.5, 19.3). Если список разойдётся,
// ФОТ в себестоимости перестанет совпадать с ФОТ на странице Кадров.
//
// ВАЖНО: accr_salary (Фикса) — базовая ставка, она НЕ входит в сумму «начислено».
// «Долг компании» (accr_company_debt) в итоге работает как удержание.

const ACCR_EXTRA = ['accr_sick', 'accr_vacation', 'accr_mataid', 'accr_comp_vac']; // больничные/отпускные/матпомощь/компенсация

// Все колонки начислений (для вставки/обновления строки ведомости).
const ACCR_ALL = ['accr_salary', 'accr_fact', 'accr_bonus', 'accr_premium', 'accr_gsm', 'accr_company_debt', 'accr_other', ...ACCR_EXTRA];

// Счётные начисления = то, что складывается в «Начислено».
const ACCR_FIELDS = ['accr_fact', 'accr_bonus', 'accr_premium', 'accr_gsm', 'accr_other', ...ACCR_EXTRA];

const DED = ['ded_fine', 'ded_advance_card', 'ded_advance_cash', 'ded_hold', 'ded_emp_debt', 'ded_other'];
const DED_SUM = [...DED, 'accr_company_debt'];
const PAID = ['paid_cash', 'paid_card'];

module.exports = { ACCR_EXTRA, ACCR_ALL, ACCR_FIELDS, DED, DED_SUM, PAID };
