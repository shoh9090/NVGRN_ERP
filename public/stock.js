// stock.js — SPA склада сырья: рабочее место кладовщика (3 вкладки)
(function () {
  const $ = (s) => document.querySelector(s);
  const fmt = new Intl.NumberFormat('ru-RU');
  const fmtQty = (v) => fmt.format(Math.round((Number(v) || 0) * 100) / 100);
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const ruDate = (s) => { if (!s) return ''; const d = new Date(s); return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); };

  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'html') n.innerHTML = v;
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c === null || c === undefined) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };

  async function api(path, opts = {}) {
    const res = await fetch('/stock/api' + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
  }
  function toast(msg, isErr) {
    const t = el('div', { class: 'toast' + (isErr ? ' toast-err' : '') }, msg);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
  }
  function modal(title, bodyNode, actions) {
    const root = $('#stk-modal-root');
    root.innerHTML = '';
    const overlay = el('div', { class: 'imp-overlay' });
    const panel = el('div', { class: 'imp-panel pur-modal' }, [
      el('div', { class: 'imp-head' }, [el('h3', {}, title)]),
      el('div', { class: 'imp-body pur-modal-body' }, [bodyNode]),
      el('div', { class: 'imp-actions' }, actions),
    ]);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) root.innerHTML = ''; });
    root.appendChild(overlay);
    return { close: () => (root.innerHTML = '') };
  }

  const RSTATUS = {
    pending: ['Ожидается', 'st-ordered'],
    received: ['Принято', 'st-received'],
    partial: ['Частично', 'st-draft'],
    not_arrived: ['Не приехало', 'st-cancelled'],
  };
  function rPill(s) { const [l, c] = RSTATUS[s] || [s, '']; return el('span', { class: 'status-pill ' + c }, l); }

  let selDate = todayISO();

  // ================= ВКЛАДКА 1: ПРИЁМКА СЕГОДНЯ =================
  async function viewReceiving() {
    const main = $('#stk-main');
    main.innerHTML = '';
    const cal = await api('/calendar');
    const data = await api('/receipts?date=' + selDate);

    // шапка с датой и счётчиками — крупно
    const head = el('div', { class: 'stk-head' }, [
      el('div', {}, [
        el('div', { class: 'stk-today' }, selDate === todayISO() ? 'Сегодня, ' + ruDate(selDate) : ruDate(selDate)),
        el('div', { class: 'stk-counts' }, [
          el('span', {}, '📦 Ожидается: ' + data.total),
          el('span', { style: 'color:#3f6a16' }, '✅ Принято: ' + data.done),
          el('span', { style: 'color:var(--amber-d,#b9770a)' }, '⏳ Осталось: ' + data.left),
        ]),
      ]),
    ]);

    // простой календарь-полоска: 14 дней вокруг сегодня
    const calMap = {};
    for (const d of cal.days) calMap[d.d] = d;
    const strip = el('div', { class: 'stk-calendar' });
    const base = new Date();
    base.setDate(base.getDate() - 3);
    for (let i = 0; i < 14; i++) {
      const d = new Date(base); d.setDate(base.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const info = calMap[iso];
      const cell = el('button', {
        class: 'stk-cal-cell' + (iso === selDate ? ' active' : '') + (iso === todayISO() ? ' today' : ''),
        onclick: () => { selDate = iso; viewReceiving(); },
      }, [
        el('span', { class: 'stk-cal-dow' }, d.toLocaleDateString('ru-RU', { weekday: 'short' })),
        el('span', { class: 'stk-cal-day' }, String(d.getDate())),
        info ? el('span', { class: 'stk-cal-badge' + (info.pending ? '' : ' done') }, String(info.total)) : el('span', { class: 'stk-cal-badge empty' }, ''),
      ]);
      strip.appendChild(cell);
    }

    main.appendChild(head);
    main.appendChild(strip);

    const list = el('div', { class: 'pur-content', style: 'margin-top:14px' });
    if (!data.items.length) {
      list.appendChild(el('p', { class: 'dict-empty' }, 'На эту дату заявок нет. Закупщик ещё не создавал поставок на этот день.'));
    } else {
      list.appendChild(el('table', { class: 'dict-table stk-big' }, [
        el('thead', {}, el('tr', {}, ['Поставщик', 'Позиций', 'Статус', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, data.items.map((r) =>
          el('tr', {}, [
            el('td', { style: 'font-weight:700;font-size:16px' }, r.supplier_name),
            el('td', {}, String(r.positions)),
            el('td', {}, rPill(r.receipt_status)),
            el('td', { style: 'text-align:right' }, el('button', { class: 'btn-primary stk-open', onclick: () => openReceipt(r.id) }, 'Открыть')),
          ])
        )),
      ]));
    }
    main.appendChild(list);
  }

  async function openReceipt(id) {
    const d = await api('/receipt/' + id);
    const inputs = {};
    const table = el('table', { class: 'dict-table stk-big' }, [
      el('thead', {}, el('tr', {}, ['Сырьё / материал', 'План', 'Факт', 'Ед.'].map((h) => el('th', {}, h)))),
      el('tbody', {}, d.items.map((i) => {
        const inp = el('input', { type: 'number', step: 'any', min: '0', class: 'stk-fact', value: i.fact_qty != null ? Number(i.fact_qty) : '' });
        inputs[i.id] = { inp, plan: Number(i.plan_qty) };
        return el('tr', {}, [
          el('td', { style: 'font-weight:600;font-size:16px' }, i.item_name),
          el('td', { class: 'tnum', style: 'font-size:16px' }, fmtQty(i.plan_qty)),
          el('td', {}, inp),
          el('td', {}, i.unit || ''),
        ]);
      })),
    ]);
    const body = el('div', {}, [
      el('p', { class: 'muted', style: 'font-size:15px' }, 'Поставщик: ' + d.order.supplier_name + ' · заявка ' + d.order.number),
      table,
    ]);
    const fillAll = () => { for (const k in inputs) inputs[k].inp.value = inputs[k].plan; };
    const zeroAll = () => { for (const k in inputs) inputs[k].inp.value = 0; };
    const save = async (ev) => {
      ev.target.disabled = true;
      try {
        const items = Object.entries(inputs).map(([id, v]) => ({ id, fact_qty: v.inp.value === '' ? 0 : Number(v.inp.value) }));
        const r = await api('/receipt/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
        toast('Приёмка сохранена. Закупщик уведомлён ✅');
        m.close();
        viewReceiving();
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    };
    const m = modal('📥 Приёмка — ' + d.order.supplier_name, body, [
      el('button', { onclick: () => m.close() }, 'Закрыть без сохранения'),
      el('button', { onclick: zeroAll }, '🚫 Не приехало'),
      el('button', { onclick: fillAll }, '✅ Принято полностью'),
      el('button', { class: 'btn-primary', onclick: save }, '💾 Сохранить приёмку'),
    ]);
  }

  // ================= ВКЛАДКА 2: ПЕРЕДАЧА В ПРОИЗВОДСТВО =================
  async function viewIssue() {
    const main = $('#stk-main');
    main.innerHTML = '';
    const data = await api('/available');
    main.appendChild(el('div', { class: 'stk-head' }, [el('div', { class: 'stk-today' }, 'Передача сырья в производство')]));

    const zoneSel = el('select', { class: 'stk-zone' }, data.zones.map((z) => el('option', { value: z }, z)));
    const entered = {};
    const search = el('input', { placeholder: '🔍 Найти сырьё...', oninput: () => renderRows() });
    const wrap = el('div', { class: 'pur-content' });
    function renderRows() {
      const q = search.value.trim().toLowerCase();
      wrap.innerHTML = '';
      const rows = data.items.filter((m) => !q || m.name.toLowerCase().includes(q) || String(m.code || '').toLowerCase().includes(q)).map((m) => {
        const key = m.kind + ':' + m.id;
        const inp = el('input', {
          type: 'number', step: 'any', min: '0', class: 'stk-fact', value: entered[key] || '',
          oninput: (e) => { const v = Number(e.target.value); if (v > 0) entered[key] = v; else delete entered[key]; },
        });
        return el('tr', {}, [
          el('td', { style: 'font-weight:600;font-size:16px' }, m.name + (m.kind === 'packaging' ? ' 📦' : '')),
          el('td', { class: 'tnum', style: 'font-size:16px;color:#3f6a16' }, fmtQty(m.balance)),
          el('td', {}, inp),
          el('td', {}, m.unit || ''),
        ]);
      });
      wrap.appendChild(el('table', { class: 'dict-table stk-big' }, [
        el('thead', {}, el('tr', {}, ['Сырьё', 'Остаток', 'Передать', 'Ед.'].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows),
      ]));
    }
    renderRows();
    main.appendChild(el('div', { class: 'pur-filters' }, [
      el('label', {}, ['Куда передать', zoneSel]),
      el('label', { style: 'flex:1' }, ['Поиск', search]),
    ]));
    main.appendChild(wrap);
    main.appendChild(el('div', { style: 'margin-top:14px;text-align:right' }, [
      el('button', {
        class: 'btn-primary stk-open',
        onclick: async (ev) => {
          const items = Object.entries(entered).map(([k, v]) => { const [kind, id] = k.split(':'); return { item_kind: kind, item_id: id, qty: v }; });
          if (!items.length) return toast('Укажите количество хотя бы по одной позиции', true);
          ev.target.disabled = true;
          try {
            await api('/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ area: zoneSel.value, items }) });
            toast('Передано в производство ✅');
            viewIssue();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        },
      }, '📤 Передать в производство'),
    ]));
  }

  // ================= ВКЛАДКА 3: ИТОГИ ДНЯ =================
  async function viewSummary() {
    const main = $('#stk-main');
    main.innerHTML = '';
    const d = await api('/day-summary?date=' + selDate);
    main.appendChild(el('div', { class: 'stk-head' }, [el('div', { class: 'stk-today' }, 'Итоги дня — ' + ruDate(d.date))]));

    const kpis = el('div', { class: 'pur-kpis' });
    [['Сегодня приехало', fmtQty(d.arrived), '#3f6a16'],
     ['Передано в производство', fmtQty(d.issued), 'var(--ink)'],
     ['Остаток на складе', fmtQty(d.balance), 'var(--ink)'],
     ['Проблемные поставки', String(d.problemsCount), d.problemsCount ? 'var(--red)' : '#3f6a16'],
     ['Не приехало', String(d.notArrived), d.notArrived ? 'var(--red)' : '#3f6a16']]
      .forEach(([label, v, color]) => kpis.appendChild(el('div', { class: 'pur-kpi' }, [
        el('div', { class: 'pur-kpi-label' }, label),
        el('div', { class: 'pur-kpi-val tnum', style: 'color:' + color }, v),
      ])));
    main.appendChild(kpis);

    const box = el('div', { class: 'pur-content' });
    box.appendChild(el('h3', { class: 'pur-sub', style: 'margin:14px' }, 'Проблемы за день'));
    if (!d.problems.length) {
      box.appendChild(el('p', { class: 'dict-empty' }, 'Проблем нет — все поставки приняты полностью 👍'));
    } else {
      box.appendChild(el('table', { class: 'dict-table' }, [
        el('thead', {}, el('tr', {}, ['Поставщик', 'Заявка', 'План', 'Факт', 'Статус'].map((h) => el('th', {}, h)))),
        el('tbody', {}, d.problems.map((p) =>
          el('tr', {}, [
            el('td', { style: 'font-weight:600' }, p.supplier_name),
            el('td', { class: 'tnum' }, p.number),
            el('td', { class: 'tnum' }, fmtQty(p.plan)),
            el('td', { class: 'tnum' }, fmtQty(p.fact)),
            el('td', {}, rPill(p.receipt_status)),
          ])
        )),
      ]));
    }
    main.appendChild(box);
  }

  // ================= Каркас =================
  function switchTab(tab) {
    document.querySelectorAll('.pur-tab').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    if (tab === 'issue') viewIssue();
    else if (tab === 'summary') viewSummary();
    else viewReceiving();
  }
  window.addEventListener('hashchange', () => switchTab(location.hash.slice(1) || 'receiving'));
  switchTab(location.hash.slice(1) || 'receiving');
})();
