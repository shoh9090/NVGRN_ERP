// stock.js — SPA склада сырья
(function () {
  const $ = (s) => document.querySelector(s);
  const fmt = new Intl.NumberFormat('ru-RU');
  const fmtMoney = (v) => fmt.format(Math.round(Number(v) || 0));
  const fmtQty = (v) => fmt.format(Math.round((Number(v) || 0) * 100) / 100);
  const dt = (s) => (s ? new Date(s).toLocaleDateString('ru-RU') : '—');

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
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
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

  function pcBadge(name, color) {
    if (!name) return el('span', { class: 'muted' }, '—');
    return el('span', { class: 'pc-badge', style: 'background:' + (color || '#999') + '22;color:' + (color || '#555') + ';border:1px solid ' + (color || '#999') + '55' }, name);
  }
  function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

  let FOPTS = null;
  async function ensureOpts() { if (!FOPTS) FOPTS = await api('/filter-options'); return FOPTS; }

  async function view() {
    const main = $('#stk-main');
    main.innerHTML = '';
    await ensureOpts();
    main.appendChild(el('div', { class: 'pur-toolbar' }, [
      el('h2', {}, 'Остатки сырья и упаковки'),
      el('div', { class: 'pur-toolbar-right' }, [
        el('input', { id: 'stk-q', placeholder: 'Поиск: артикул, наименование...', oninput: debounce(load, 300) }),
      ]),
    ]));
    const pcSel = el('select', { id: 'stk-pc', onchange: load }, [
      el('option', { value: '' }, 'Все родит. категории'),
      ...FOPTS.parents.map((p) => el('option', { value: p.id }, p.name)),
    ]);
    const catSel = el('select', { id: 'stk-cat', onchange: load }, [
      el('option', { value: '' }, 'Все категории'),
      ...FOPTS.categories.map((c) => el('option', { value: c.id }, c.name)),
    ]);
    const onlyStock = el('label', { class: 'stk-check' }, [
      el('input', { id: 'stk-only', type: 'checkbox', onchange: load }), ' только с остатком',
    ]);
    main.appendChild(el('div', { class: 'pur-filters' }, [
      el('label', {}, ['Родит. категория', pcSel]),
      el('label', {}, ['Категория', catSel]),
      onlyStock,
    ]));
    main.appendChild(el('div', { id: 'stk-kpis', class: 'pur-kpis' }));
    main.appendChild(el('div', { id: 'stk-list', class: 'pur-content' }));
    await load();
  }

  async function load() {
    const p = new URLSearchParams();
    if ($('#stk-q') && $('#stk-q').value.trim()) p.set('q', $('#stk-q').value.trim());
    if ($('#stk-pc') && $('#stk-pc').value) p.set('parent_category_id', $('#stk-pc').value);
    if ($('#stk-cat') && $('#stk-cat').value) p.set('category_id', $('#stk-cat').value);
    if ($('#stk-only') && $('#stk-only').checked) p.set('only_stock', '1');
    const data = await api('/balances' + (p.toString() ? '?' + p.toString() : ''));

    const kpis = $('#stk-kpis');
    kpis.innerHTML = '';
    [['Позиций с остатком', String(data.positions), 'var(--ink)'],
     ['Оценка запаса', fmtMoney(data.totalValue) + ' сум', '#3f6a16']]
      .forEach(([label, v, color]) => kpis.appendChild(el('div', { class: 'pur-kpi' }, [
        el('div', { class: 'pur-kpi-label' }, label),
        el('div', { class: 'pur-kpi-val tnum', style: 'color:' + color }, v),
      ])));

    const box = $('#stk-list');
    box.innerHTML = '';
    if (!data.items.length) {
      box.appendChild(el('p', { class: 'dict-empty' }, 'Нет позиций. Остатки появляются после приёмок в блоке «Закуп».'));
      return;
    }
    box.appendChild(el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Артикул', 'Наименование', 'Категория', 'Ед.', 'Приход', 'Расход', 'Остаток', 'Оценка'].map((h, i) =>
        el('th', { style: i >= 4 ? 'text-align:right' : '' }, h)))),
      el('tbody', {}, data.items.map((m) => {
        const bal = Number(m.balance);
        return el('tr', { onclick: () => openCard(m) }, [
          el('td', { class: 'tnum', title: m.characteristics || '' }, m.code || ''),
          el('td', { style: 'font-weight:600', title: m.characteristics || '' }, m.name + (m.kind === 'packaging' ? ' 📦' : '')),
          el('td', {}, pcBadge(m.pc_name, m.pc_color)),
          el('td', {}, m.unit || ''),
          el('td', { class: 'tnum muted', style: 'text-align:right' }, fmtQty(m.total_in)),
          el('td', { class: 'tnum muted', style: 'text-align:right' }, fmtQty(m.total_out)),
          el('td', { class: 'tnum', style: 'text-align:right;font-weight:800;color:' + (bal > 0 ? '#3f6a16' : bal < 0 ? 'var(--red)' : 'var(--ink-faint)') }, fmtQty(bal)),
          el('td', { class: 'tnum muted', style: 'text-align:right' }, m.value ? fmtMoney(m.value) : '—'),
        ]);
      })),
    ]));
  }

  // карточка позиции: движения + действия
  async function openCard(m) {
    const data = await api('/movements?kind=' + m.kind + '&id=' + m.id);
    const reasonLabel = { receive: '📥 приёмка', writeoff: '📤 списание', adjust: '⚖️ корректировка', return: '↩️ возврат' };
    const table = el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Дата', 'Операция', 'Источник', 'Кол-во', 'Цена'].map((h, i) =>
        el('th', { style: i >= 3 ? 'text-align:right' : '' }, h)))),
      el('tbody', {}, data.items.map((mv) =>
        el('tr', {}, [
          el('td', {}, dt(mv.moved_at)),
          el('td', {}, reasonLabel[mv.reason] || mv.reason),
          el('td', { class: 'muted' }, mv.order_number ? mv.order_number + (mv.supplier_name ? ' · ' + mv.supplier_name : '') : (mv.comment || '—')),
          el('td', { class: 'tnum', style: 'text-align:right;font-weight:700;color:' + (Number(mv.qty) >= 0 ? '#3f6a16' : 'var(--red)') }, (Number(mv.qty) > 0 ? '+' : '') + fmtQty(mv.qty)),
          el('td', { class: 'tnum muted', style: 'text-align:right' }, mv.price ? fmtMoney(mv.price) : '—'),
        ])
      )),
    ]);
    const balance = data.items.reduce((s, mv) => s + Number(mv.qty), 0);
    const body = el('div', {}, [
      el('div', { class: 'pur-kpis' }, [
        el('div', { class: 'pur-kpi' }, [
          el('div', { class: 'pur-kpi-label' }, 'Текущий остаток'),
          el('div', { class: 'pur-kpi-val tnum', style: 'color:' + (balance > 0 ? '#3f6a16' : 'var(--red)') }, fmtQty(balance) + ' ' + (m.unit || '')),
        ]),
      ]),
      m.characteristics ? el('p', { class: 'muted' }, m.characteristics) : null,
      el('h3', { class: 'pur-sub' }, 'Движения'),
      data.items.length ? el('div', { class: 'oe-table-wrap', style: 'max-height:42vh' }, [table]) : el('p', { class: 'muted' }, 'Движений ещё не было.'),
    ]);
    const m2 = modal('📦 ' + (m.code ? m.code + ' · ' : '') + m.name, body, [
      el('button', { onclick: () => { m2.close(); openMovement(m, 'writeoff'); } }, '📤 Списать'),
      el('button', { onclick: () => { m2.close(); openMovement(m, 'adjust'); } }, '⚖️ Инвентаризация'),
      el('button', { onclick: () => m2.close() }, 'Закрыть'),
    ]);
  }

  // списание / корректировка
  function openMovement(m, reason) {
    const qty = el('input', { type: 'number', step: 'any', min: reason === 'adjust' ? null : '0', placeholder: '0' });
    const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const comment = el('input', { placeholder: reason === 'writeoff' ? 'Причина списания (в производство, брак...)' : 'Комментарий' });
    const hint = reason === 'adjust'
      ? 'Введите ФАКТИЧЕСКИЙ остаток по инвентаризации — система сама посчитает корректировку.'
      : 'Введите количество для списания — оно уменьшит остаток.';
    const body = el('div', { class: 'form-col', style: 'max-width:100%' }, [
      el('p', { class: 'muted' }, hint),
      el('label', {}, [reason === 'adjust' ? 'Фактический остаток, ' + (m.unit || 'ед.') : 'Количество, ' + (m.unit || 'ед.'), qty]),
      el('label', {}, ['Дата', date]),
      el('label', {}, ['Комментарий', comment]),
    ]);
    const mm = modal((reason === 'writeoff' ? '📤 Списание — ' : '⚖️ Инвентаризация — ') + m.name, body, [
      el('button', { onclick: () => mm.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          if (qty.value === '' || isNaN(Number(qty.value))) return toast('Укажите количество', true);
          ev.target.disabled = true;
          try {
            await api('/movement', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ item_kind: m.kind, item_id: m.id, reason, qty: Number(qty.value), moved_at: date.value, comment: comment.value }),
            });
            toast(reason === 'writeoff' ? 'Списание проведено' : 'Остаток скорректирован');
            mm.close();
            load();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        },
      }, reason === 'writeoff' ? 'Списать' : 'Сохранить остаток'),
    ]);
  }

  view();
})();
