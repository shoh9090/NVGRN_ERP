// conn.js — индикаторы внешних связей в шапке Hub (SalesDoctor, бот HoReCa).
//
// Обе связи рвутся молча: отчёт приходит пустым, и понять, «данных нет» или
// «связь оборвалась», по экрану нельзя. Точка в шапке отвечает на это раньше,
// чем кто-то заметит странные цифры.
//
// Про бота говорим честно «активность», а не «подключён»: Hub видит только
// его журнал событий, а события пишутся, когда с ботом кто-то работает.
// Ночью тишина — это норма, и такой индикатор не должен пугать красным.
(function () {
  const root = document.getElementById('conn-root');
  if (!root) return;

  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };

  const ago = (iso) => {
    if (!iso) return '';
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'только что';
    if (mins < 60) return mins + ' мин. назад';
    const h = Math.floor(mins / 60);
    if (h < 24) return h + ' ч. назад';
    const d = Math.floor(h / 24);
    return d === 1 ? 'вчера' : d + ' дн. назад';
  };

  // Состояние → как показать. Держим текст здесь, а не на сервере: сервер
  // отдаёт факты, а формулировки — дело интерфейса.
  const SD = {
    ok:      { dot: 'ok',   short: 'CRM',  title: 'SalesDoctor отвечает' },
    fail:    { dot: 'bad',  short: 'CRM',  title: 'SalesDoctor не отвечает' },
    unknown: { dot: 'idle', short: 'CRM',  title: 'Связь с SalesDoctor ещё не проверялась' },
  };
  const BOT = {
    ok:      { dot: 'ok',   short: 'Бот', title: 'Бот работает' },
    quiet:   { dot: 'warn', short: 'Бот', title: 'Бот молчит' },
    stale:   { dot: 'bad',  short: 'Бот', title: 'От бота давно нет событий' },
    unknown: { dot: 'idle', short: 'Бот', title: 'Нет данных о боте' },
  };

  const sdBtn = el('button', { class: 'conn-pill', type: 'button' });
  const botBtn = el('button', { class: 'conn-pill', type: 'button' });
  const panel = el('div', { class: 'conn-panel', style: 'display:none' });
  root.appendChild(sdBtn);
  root.appendChild(botBtn);
  root.appendChild(panel);

  let last = null;
  let open = false;

  const outside = (e) => { if (!root.contains(e.target)) toggle(false); };
  function toggle(v) {
    open = v === undefined ? !open : v;
    panel.style.display = open ? '' : 'none';
    if (open) { drawPanel(); document.addEventListener('click', outside); }
    else document.removeEventListener('click', outside);
  }
  sdBtn.onclick = (e) => { e.stopPropagation(); toggle(); };
  botBtn.onclick = (e) => { e.stopPropagation(); toggle(); };

  function pill(btn, cfg) {
    btn.innerHTML = '';
    btn.appendChild(el('span', { class: 'conn-dot ' + cfg.dot }));
    btn.appendChild(el('span', { class: 'conn-pill-t' }, cfg.short));
    btn.title = cfg.title;
  }

  function drawPanel() {
    panel.innerHTML = '';
    if (!last) { panel.appendChild(el('div', { class: 'conn-item conn-item-s' }, 'Проверяю связи…')); return; }

    const sd = last.sd || {};
    const sdCfg = SD[sd.state] || SD.unknown;
    const sdWhen = sd.at ? ago(sd.at) : '';
    panel.appendChild(el('div', { class: 'conn-item' }, [
      el('div', { class: 'conn-item-h' }, [el('span', { class: 'conn-dot ' + sdCfg.dot }), 'SalesDoctor']),
      el('div', { class: 'conn-item-s' },
        sd.state === 'ok' ? (sd.stale ? 'Связь была в порядке — это последняя запись до перезапуска Hub.' : 'Последний обмен прошёл ' + sdWhen + '.')
        : sd.state === 'fail' ? (sd.stale ? 'Связь не работала — это последняя запись до перезапуска Hub.' : 'Последняя попытка ' + sdWhen + ' не удалась.')
        : 'После перезапуска Hub к SalesDoctor ещё не обращались. Состояние станет известно при первой выгрузке.'),
      sd.state === 'fail' && sd.msg ? el('div', { class: 'conn-item-e' }, sd.msg) : null,
    ]));

    const bot = last.bot || {};
    const botCfg = BOT[bot.state] || BOT.unknown;
    panel.appendChild(el('div', { class: 'conn-item' }, [
      el('div', { class: 'conn-item-h' }, [el('span', { class: 'conn-dot ' + botCfg.dot }), 'Бот HoReCa']),
      el('div', { class: 'conn-item-s' },
        bot.last ? 'Последнее событие ' + ago(bot.last) + '.'
          + (bot.state === 'ok' ? ' Бот отвечает клиентам.'
            : bot.state === 'quiet' ? ' Пока тихо — ночью это обычное дело.'
            : ' Событий давно нет: возможно, бот остановлен.')
          : (bot.note || 'Нет данных.')),
      el('div', { class: 'conn-item-s' }, 'Hub видит бота по его журналу событий — они пишутся, когда с ботом кто-то работает.'),
    ]));

    if (window.HUB_USER && HUB_USER.isAdmin) {
      const btn = el('button', { onclick: check }, 'Проверить SalesDoctor');
      panel.appendChild(el('div', { class: 'conn-act' }, [btn]));
      async function check() {
        btn.disabled = true; btn.textContent = 'Проверяю…';
        try {
          const r = await (await fetch('/api/health/sd-check', { method: 'POST' })).json();
          btn.textContent = r.ok ? 'Связь есть' : 'Не удалось';
          await load();
          if (open) drawPanel();
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Проверить SalesDoctor';
        }
      }
    }
  }

  async function load() {
    try {
      const res = await fetch('/api/health/links');
      if (!res.ok) return;
      last = await res.json();
    } catch (e) { return; }
    pill(sdBtn, SD[(last.sd || {}).state] || SD.unknown);
    pill(botBtn, BOT[(last.bot || {}).state] || BOT.unknown);
  }

  pill(sdBtn, SD.unknown);
  pill(botBtn, BOT.unknown);
  load();
  setInterval(load, 120000); // раз в две минуты: состояние меняется редко
})();
