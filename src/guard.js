// guard.js — защита входа и стандартные заголовки безопасности.
//
// Аудит 17.09.2026: пароль к ERP можно было подбирать без ограничений, а ответы
// отдавались без заголовков, которые защищают от встраивания страницы в чужой
// сайт и от подмены типа файла. Готовые библиотеки не ставим: тут полсотни строк,
// а каждая зависимость — это ещё один повод для сюрприза при сборке.

// ---------------------------------------------------------------------------
// Ограничение попыток входа
// ---------------------------------------------------------------------------
// Считаем НЕУДАЧНЫЕ попытки по паре «IP + логин» и отдельно по IP: подбор пароля
// к одному логину и перебор логинов с одного адреса — разные атаки.
// Удачный вход счётчик обнуляет, чтобы человек, который просто забыл пароль,
// не оставался заблокированным после того, как вспомнил.
const WINDOW_MS = 15 * 60 * 1000;   // окно наблюдения
const MAX_PER_LOGIN = 8;            // попыток на один логин с одного адреса
const MAX_PER_IP = 25;              // попыток со всего адреса (несколько человек за одним NAT)

function createLoginLimiter(opts = {}) {
  const windowMs = opts.windowMs || WINDOW_MS;
  const maxPerLogin = opts.maxPerLogin || MAX_PER_LOGIN;
  const maxPerIp = opts.maxPerIp || MAX_PER_IP;
  const hits = new Map();           // ключ → { n, until }

  const bump = (key, now) => {
    const cur = hits.get(key);
    if (!cur || cur.until <= now) { hits.set(key, { n: 1, until: now + windowMs }); return 1; }
    cur.n += 1;
    return cur.n;
  };
  const count = (key, now) => {
    const cur = hits.get(key);
    return cur && cur.until > now ? cur.n : 0;
  };

  return {
    // Пускать ли попытку входа. Возвращает { ok } или { ok:false, retryAfterSec }.
    check(ip, login, now = Date.now()) {
      if (hits.size > 5000) for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
      const byLogin = count('l:' + ip + '|' + String(login || '').toLowerCase(), now);
      const byIp = count('i:' + ip, now);
      if (byLogin >= maxPerLogin || byIp >= maxPerIp) {
        const cur = hits.get(byLogin >= maxPerLogin ? 'l:' + ip + '|' + String(login || '').toLowerCase() : 'i:' + ip);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((cur.until - now) / 1000)) };
      }
      return { ok: true };
    },
    fail(ip, login, now = Date.now()) {
      bump('l:' + ip + '|' + String(login || '').toLowerCase(), now);
      bump('i:' + ip, now);
    },
    success(ip, login) {
      hits.delete('l:' + ip + '|' + String(login || '').toLowerCase());
      hits.delete('i:' + ip);
    },
    size: () => hits.size,
  };
}

// ---------------------------------------------------------------------------
// Заголовки безопасности
// ---------------------------------------------------------------------------
// Content-Security-Policy сознательно НЕ ставим: в шаблонах есть встроенные
// скрипты и стили, строгая политика сломает экраны. Это отдельная задача.
function securityHeaders(isProd) {
  return function (req, res, next) {
    res.set('X-Content-Type-Options', 'nosniff');          // не угадывать тип файла
    res.set('X-Frame-Options', 'SAMEORIGIN');              // не встраивать ERP в чужой сайт
    res.set('Referrer-Policy', 'same-origin');             // адрес страницы не утекает наружу
    res.set('X-Permitted-Cross-Domain-Policies', 'none');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    // Камера/микрофон/геолокация ERP не нужны — запрещаем на уровне браузера.
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Только по https и только на рабочем сервере: на локальном http сломало бы вход.
    if (isProd) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}

module.exports = { createLoginLimiter, securityHeaders };
