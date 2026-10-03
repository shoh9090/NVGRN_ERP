// cache.js — короткая память бота о данных SalesDoctor.
//
// Главное правило: ПУСТОЙ ответ — не данные. Разбор 03.10.2026: токен бота
// перестал действовать после смены пароля, SalesDoctor какое-то время отдавал
// пустые списки, и бот запомнил «заказов нет» на полный срок кэша. Часами:
// напоминания клиентам не уходили, претензию подать было нельзя, а человек
// видел «отгрузок по этой точке нет». Поэтому пустой результат живёт минуту —
// ошибиться на минуту дешевле, чем молчать полдня.

const EMPTY_TTL = 60000;

// Пусто — это пустой список или снимок остатков с пустым каталогом.
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0
  : !!(v && Array.isArray(v.catalog) && v.catalog.length === 0));

// now() подменяется в тесте, чтобы не ждать реальных минут.
function createCache(now = Date.now) {
  const store = new Map();
  async function cached(key, ttlMs, fn) {
    const hit = store.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.val;
    const val = await fn();
    store.set(key, { at: now(), val, ttl: isEmpty(val) ? Math.min(ttlMs, EMPTY_TTL) : ttlMs });
    return val;
  }
  cached.forget = (key) => store.delete(key);
  cached.size = () => store.size;
  return cached;
}

module.exports = { createCache, isEmpty, EMPTY_TTL };
