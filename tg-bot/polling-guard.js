// polling-guard.js — когда «409 Conflict» от Telegram значит беду, а когда нет.
//
// Два экземпляра бота с одним токеном воюют за обновления, и люди получают
// каждое сообщение дважды — об этом админу надо сказать. Но при каждой выкладке
// 409 бывает законно: Railway поднимает новый контейнер, пока старый ещё держит
// связь, и секунд десять их правда двое. Разбор 03.10.2026: в логах был ровно
// один такой 409 через 8 секунд после деплоя, а тревога ушла как про аварию.
// Сторож, который кричит на каждую выкладку, приучает не читать тревоги.
//
// Правила: молчим первые минуты после старта, молчим на одиночных ошибках,
// обнуляем счёт, если конфликты прекратились, и не повторяем тревогу чаще раза
// в час. Чистая логика без Telegram и базы — проверяется тестом.

function conflictWatch(opts = {}) {
  const GRACE_MS = opts.graceMs || 3 * 60000;     // пересменка при деплое
  const NEED = opts.need || 3;                    // сколько конфликтов подряд — уже не случайность
  const COOL_MS = opts.coolMs || 10 * 60000;      // тишина дольше — счёт сначала
  const REPEAT_MS = opts.repeatMs || 3600000;     // как часто повторять тревогу
  const startedAt = opts.startedAt || Date.now();
  let count = 0, lastAt = 0, warnedAt = 0;
  return function check(message, now) {
    if (!/409|conflict/i.test(String(message || ''))) return false;
    if (now - startedAt < GRACE_MS) return false;
    if (lastAt && now - lastAt > COOL_MS) count = 0;
    lastAt = now;
    count++;
    if (count < NEED) return false;
    if (warnedAt && now - warnedAt < REPEAT_MS) return false;
    warnedAt = now;
    return true;
  };
}

module.exports = { conflictWatch };
