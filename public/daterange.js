// daterange.js — единый выбор периода для всего Hub.
//
// Зачем общий компонент: в Кассе на вкладке «Кэш-флоу» период выбирался
// двумя полями с датами и тремя кнопками-пресетами, а в «P&L» — полем
// «месяц». Разные плитки выглядели и вели себя по-разному, хотя задача одна.
//
// Устройство как в SalesDoctor: кнопка показывает выбранный период, по
// нажатию открывается панель с готовыми вариантами (сегодня, вчера, 7 дней,
// этот месяц, прошлый месяц…) и произвольным диапазоном с кнопкой «ОК».
// Готовый вариант применяется сразу — это самый частый случай; произвольный
// диапазон ждёт «ОК», чтобы отчёт не пересчитывался на каждую полудату.
//
// Два режима:
//   range — произвольный отрезок дат (Кэш-флоу, Транзакции, Взаиморасчёты);
//   month — целый месяц (P&L, Калькуляция): там расчёт помесячный, и
//           произвольный отрезок сломал бы себестоимость и реализацию.
(function () {
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTHS_N = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

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

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => new Date();
  const shift = (d, days) => { const x = new Date(d); x.setDate(x.getDate() + days); return x; };
  const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
  const monthEnd = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);

  // Подпись на кнопке. Целый месяц пишем словом — так короче и понятнее,
  // чем «1 авг — 31 авг».
  function labelRange(from, to) {
    if (!from || !to) return 'Выберите период';
    const a = new Date(from), b = new Date(to);
    const whole = a.getDate() === 1 && iso(b) === iso(monthEnd(a))
      && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    if (whole) return MONTHS_N[a.getMonth()] + ' ' + a.getFullYear();
    if (iso(a) === iso(b)) return a.getDate() + ' ' + MONTHS[a.getMonth()] + ' ' + a.getFullYear();
    const sameYear = a.getFullYear() === b.getFullYear();
    return a.getDate() + ' ' + MONTHS[a.getMonth()] + (sameYear ? '' : ' ' + a.getFullYear())
      + ' — ' + b.getDate() + ' ' + MONTHS[b.getMonth()] + ' ' + b.getFullYear();
  }
  const labelMonth = (period) => {
    const [y, m] = String(period || '').split('-').map(Number);
    return MONTHS_N[(m || 1) - 1] + ' ' + y;
  };

  // Готовые варианты. Каждый — функция, чтобы «сегодня» не застревало
  // на дате открытия страницы.
  function rangePresets() {
    const t = today();
    const prev = addMonths(monthStart(t), -1);
    return [
      ['Сегодня', () => [iso(t), iso(t)]],
      ['Вчера', () => [iso(shift(t, -1)), iso(shift(t, -1))]],
      ['Последние 7 дней', () => [iso(shift(t, -6)), iso(t)]],
      ['Последние 30 дней', () => [iso(shift(t, -29)), iso(t)]],
      ['Этот месяц', () => [iso(monthStart(t)), iso(t)]],
      ['Прошлый месяц', () => [iso(prev), iso(monthEnd(prev))]],
      ['Этот год', () => [iso(new Date(t.getFullYear(), 0, 1)), iso(t)]],
    ];
  }
  function monthPresets() {
    const t = today();
    return [
      ['Этот месяц', () => iso(monthStart(t)).slice(0, 7)],
      ['Прошлый месяц', () => iso(addMonths(monthStart(t), -1)).slice(0, 7)],
      ['Позапрошлый', () => iso(addMonths(monthStart(t), -2)).slice(0, 7)],
    ];
  }

  let openPanel = null;
  function closePanel() { if (openPanel) { openPanel.remove(); openPanel = null; } }
  document.addEventListener('click', (e) => {
    if (openPanel && !openPanel.contains(e.target) && !e.target.closest('.hub-dr-btn')) closePanel();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  function create(opts) {
    const o = opts || {};
    const mode = o.mode === 'month' ? 'month' : 'range';
    const state = mode === 'month'
      ? { period: o.period || iso(monthStart(today())).slice(0, 7) }
      : { from: o.from || iso(monthStart(today())), to: o.to || iso(today()) };

    const btn = el('button', { class: 'hub-dr-btn', type: 'button' }, [
      el('span', { class: 'hub-dr-ico' }, '📅'),
      el('span', { class: 'hub-dr-label' },
        mode === 'month' ? labelMonth(state.period) : labelRange(state.from, state.to)),
      el('span', { class: 'hub-dr-caret' }, '▾'),
    ]);

    const relabel = () => {
      btn.querySelector('.hub-dr-label').textContent =
        mode === 'month' ? labelMonth(state.period) : labelRange(state.from, state.to);
    };
    const apply = () => { relabel(); closePanel(); if (o.onChange) o.onChange({ ...state }); };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openPanel) { closePanel(); return; }
      const panel = el('div', { class: 'hub-dr-panel' });

      const presets = mode === 'month' ? monthPresets() : rangePresets();
      presets.forEach(([label, calc]) => {
        panel.appendChild(el('button', {
          class: 'hub-dr-item', type: 'button',
          onclick: () => {
            if (mode === 'month') state.period = calc();
            else { const [f, t] = calc(); state.from = f; state.to = t; }
            apply();
          },
        }, label));
      });

      panel.appendChild(el('div', { class: 'hub-dr-sep' }));
      panel.appendChild(el('div', { class: 'hub-dr-custom-t' },
        mode === 'month' ? 'Другой месяц' : 'Выбрать даты'));

      if (mode === 'month') {
        const inp = el('input', { type: 'month', class: 'hub-dr-inp', value: state.period });
        panel.appendChild(el('div', { class: 'hub-dr-custom' }, inp));
        panel.appendChild(el('div', { class: 'hub-dr-actions' }, [
          el('button', { class: 'hub-dr-ok', type: 'button', onclick: () => { state.period = inp.value || state.period; apply(); } }, 'ОК'),
          el('button', { class: 'hub-dr-cancel', type: 'button', onclick: closePanel }, 'Отменить'),
        ]));
      } else {
        const f = el('input', { type: 'date', class: 'hub-dr-inp', value: state.from });
        const t2 = el('input', { type: 'date', class: 'hub-dr-inp', value: state.to });
        panel.appendChild(el('div', { class: 'hub-dr-custom' }, [
          el('label', {}, ['с', f]), el('label', {}, ['по', t2]),
        ]));
        panel.appendChild(el('div', { class: 'hub-dr-actions' }, [
          el('button', {
            class: 'hub-dr-ok', type: 'button',
            onclick: () => {
              let a = f.value || state.from, b = t2.value || state.to;
              // Перепутанные местами даты молча меняем — это опечатка,
              // а не повод показать пустой отчёт.
              if (a > b) { const tmp = a; a = b; b = tmp; }
              state.from = a; state.to = b; apply();
            },
          }, 'ОК'),
          el('button', { class: 'hub-dr-cancel', type: 'button', onclick: closePanel }, 'Отменить'),
        ]));
      }

      document.body.appendChild(panel);
      openPanel = panel;
      const r = btn.getBoundingClientRect();
      const pb = panel.getBoundingClientRect();
      let top = r.bottom + 6;
      if (top + pb.height > window.innerHeight - 8) top = Math.max(8, r.top - pb.height - 6);
      let left = r.left;
      if (left + pb.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pb.width - 8);
      panel.style.top = top + 'px';
      panel.style.left = left + 'px';
    });

    btn.setPeriod = (v) => {
      if (mode === 'month') state.period = v.period || state.period;
      else { state.from = v.from || state.from; state.to = v.to || state.to; }
      relabel();
    };
    return btn;
  }

  window.HubDateRange = { create, labelRange, labelMonth };
})();
