// purchase.js — блок «Закуп»: заявки, приёмка, поставщики, взаиморасчёты
(function () {
  const $ = (s) => document.querySelector(s);
  const fmt = new Intl.NumberFormat('ru-RU');
  const fmtMoney = (v) => fmt.format(Math.round(Number(v) || 0));
  const dt = (s) => (s ? new Date(s).toLocaleDateString('ru-RU') : '—');

  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'html') n.innerHTML = v;
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c === null || c === undefined) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };

  async function api(path, opts = {}) {
    const res = await fetch('/purchase/api' + path, opts);
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
    const root = $('#pur-modal-root');
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

  const statusPill = (s) => {
    const map = {
      draft: ['Черновик', 'st-draft'], ordered: ['Заказано', 'st-ordered'],
      received: ['Принято', 'st-received'], cancelled: ['Отменено', 'st-cancelled'],
    };
    const [label, cls] = map[s] || [s, ''];
    return el('span', { class: 'status-pill ' + cls }, label);
  };
  const payIcon = (p) => (p === 'наличка' ? '💵 наличка' : '🏦 перечисление');

  // ================= ЗАЯВКИ =================
  async function viewOrders() {
    const main = $('#pur-main');
    main.innerHTML = '';
    const toolbar = el('div', { class: 'pur-toolbar' }, [
      el('h2', {}, 'Заявки на закуп'),
      el('div', { class: 'pur-toolbar-right' }, [
        el('select', {
          id: 'ord-status',
          onchange: () => loadOrders(),
        }, [
          el('option', { value: 'all' }, 'Все статусы'),
          el('option', { value: 'draft' }, 'Черновики'),
          el('option', { value: 'ordered' }, 'Заказано'),
          el('option', { value: 'received' }, 'Принято'),
          el('option', { value: 'cancelled' }, 'Отменено'),
        ]),
        el('input', { id: 'ord-q', placeholder: 'Поиск: номер, поставщик...', oninput: debounce(loadOrders, 300) }),
        el('button', { class: 'btn-primary', onclick: () => openOrderEditor(null) }, '+ Новая заявка'),
      ]),
    ]);
    main.appendChild(toolbar);
    main.appendChild(el('div', { id: 'ord-list', class: 'pur-content' }));
    await loadOrders();
  }

  async function loadOrders() {
    const box = $('#ord-list');
    const status = $('#ord-status') ? $('#ord-status').value : 'all';
    const q = $('#ord-q') ? $('#ord-q').value.trim() : '';
    const params = new URLSearchParams({ status });
    if (q) params.set('q', q);
    const data = await api('/orders?' + params.toString());
    box.innerHTML = '';
    if (!data.items.length) {
      box.appendChild(el('p', { class: 'dict-empty' }, 'Заявок пока нет. Нажмите «+ Новая заявка».'));
      return;
    }
    const table = el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['№', 'Дата', 'Поставщик', 'Позиций', 'Сумма', 'Оплата', 'Статус'].map((h, i) =>
        el('th', { style: i === 4 ? 'text-align:right' : '' }, h)))),
      el('tbody', {}, data.items.map((o) =>
        el('tr', { onclick: () => openOrderCard(o.id) }, [
          el('td', { style: 'font-weight:800' }, o.number),
          el('td', {}, dt(o.received_at || o.created_at)),
          el('td', {}, o.supplier_name),
          el('td', {}, String(o.positions)),
          el('td', { class: 'tnum', style: 'text-align:right;font-weight:700' }, fmtMoney(o.total)),
          el('td', {}, payIcon(o.payment_type)),
          el('td', {}, statusPill(o.status)),
        ])
      )),
    ]);
    box.appendChild(table);
  }

  // --- редактор заявки (создание/черновик) ---
  async function openOrderEditor(orderId) {
    let order = null;
    let items = [];
    if (orderId) {
      const d = await api('/orders/' + orderId);
      order = d.order;
      items = d.items;
    }
    const suppliers = (await api('/suppliers')).items;

    const supSel = el('select', { id: 'oe-supplier', disabled: !!orderId }, [
      el('option', { value: '' }, '— выберите поставщика —'),
      ...suppliers.map((s) => el('option', { value: s.id }, s.name)),
    ]);
    if (order) supSel.value = order.supplier_id;

    const paySel = el('select', { id: 'oe-pay' }, [
      el('option', { value: 'перечисление' }, '🏦 Перечисление'),
      el('option', { value: 'наличка' }, '💵 Наличка'),
    ]);
    if (order) paySel.value = order.payment_type;

    const search = el('input', { placeholder: 'Поиск по номенклатуре...', oninput: debounce(renderRows, 250) });
    const comment = el('input', { id: 'oe-comment', placeholder: 'Комментарий (необязательно)' });
    if (order) comment.value = order.comment || '';

    const tableWrap = el('div', { class: 'oe-table-wrap' });
    const totalBox = el('div', { class: 'oe-total' }, 'Итого: 0');

    // qty/price введённые пользователем: ключ kind:id
    const entered = {};
    for (const it of items) entered[it.item_kind + ':' + it.item_id] = { qty: Number(it.qty), price: Number(it.price) };

    let mats = [];
    async function loadMats() {
      const sid = supSel.value || 0;
      mats = (await api('/materials?supplier_id=' + sid)).items;
      renderRows();
    }

    function recalcTotal() {
      let sum = 0;
      for (const v of Object.values(entered)) sum += (v.qty || 0) * (v.price || 0);
      totalBox.textContent = 'Итого: ' + fmtMoney(sum) + ' сум';
    }

    function renderRows() {
      const q = search.value.trim().toLowerCase();
      tableWrap.innerHTML = '';
      const filtered = mats.filter((m) => !q || m.name.toLowerCase().includes(q) || String(m.code || '').toLowerCase().includes(q));
      const rows = filtered.map((m) => {
        const key = m.kind + ':' + m.id;
        const e = entered[key] || { qty: '', price: m.supplier_price != null ? Number(m.supplier_price) : (m.any_price != null ? Number(m.any_price) : '') };
        const qtyIn = el('input', {
          type: 'number', step: 'any', min: '0', class: 'oe-num', value: e.qty || '',
          oninput: (ev) => {
            const v = Number(ev.target.value);
            if (v > 0) entered[key] = { qty: v, price: Number(priceIn.value) || 0 };
            else delete entered[key];
            recalcTotal();
          },
        });
        const priceIn = el('input', {
          type: 'number', step: 'any', min: '0', class: 'oe-num', value: e.price === '' ? '' : e.price,
          oninput: (ev) => {
            if (entered[key]) { entered[key].price = Number(ev.target.value) || 0; recalcTotal(); }
          },
        });
        return el('tr', { class: entered[key] ? 'oe-row-on' : '' }, [
          el('td', { class: 'tnum' }, m.code || ''),
          el('td', { style: 'font-weight:600' }, m.name + (m.kind === 'packaging' ? ' 📦' : '')),
          el('td', {}, m.unit || ''),
          el('td', {}, qtyIn),
          el('td', {}, priceIn),
          el('td', { class: 'muted', style: 'font-size:12px' }, m.supplier_price != null ? 'был: ' + fmtMoney(m.supplier_price) : ''),
        ]);
      });
      tableWrap.appendChild(el('table', { class: 'dict-table oe-table' }, [
        el('thead', {}, el('tr', {}, ['Артикул', 'Наименование', 'Ед.', 'Кол-во', 'Цена', 'Прошлая цена'].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows),
      ]));
      recalcTotal();
    }

    supSel.addEventListener('change', loadMats);

    const body = el('div', {}, [
      el('div', { class: 'oe-head form-row' }, [
        el('label', { style: 'flex:2 1 220px' }, ['Поставщик', supSel]),
        el('label', { style: 'flex:1 1 160px' }, ['Тип платежа', paySel]),
        el('label', { style: 'flex:2 1 200px' }, ['Комментарий', comment]),
      ]),
      el('div', { class: 'form-row', style: 'margin:10px 0' }, [search]),
      tableWrap,
      totalBox,
    ]);

    const m = modal(orderId ? 'Заявка ' + order.number : 'Новая заявка на закуп', body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          if (!supSel.value) return toast('Выберите поставщика', true);
          const payload = {
            supplier_id: supSel.value,
            payment_type: paySel.value,
            comment: comment.value,
            items: Object.entries(entered).map(([k, v]) => {
              const [kind, id] = k.split(':');
              return { item_kind: kind, item_id: id, qty: v.qty, price: v.price };
            }),
          };
          ev.target.disabled = true;
          try {
            if (orderId) {
              await api('/orders/' + orderId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
              toast('Заявка сохранена');
            } else {
              const r = await api('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
              toast('Создана заявка ' + r.number);
            }
            m.close();
            loadOrders();
          } catch (e) {
            toast(e.message, true);
            ev.target.disabled = false;
          }
        },
      }, orderId ? 'Сохранить' : 'Создать заявку'),
    ]);

    if (order) await loadMats();
  }

  // --- карточка заявки ---
  async function openOrderCard(id) {
    const d = await api('/orders/' + id);
    const o = d.order;
    const sum = d.items.reduce((s, i) => s + Number(i.fact_qty ?? i.qty) * Number(i.fact_price ?? i.price), 0);

    const table = el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Артикул', 'Наименование', 'Кол-во', 'Цена', 'Сумма'].map((h) => el('th', {}, h)))),
      el('tbody', {}, d.items.map((i) => {
        const q = Number(i.fact_qty ?? i.qty);
        const p = Number(i.fact_price ?? i.price);
        return el('tr', {}, [
          el('td', { class: 'tnum' }, i.item_code || ''),
          el('td', {}, i.item_name + (i.item_kind === 'packaging' ? ' 📦' : '')),
          el('td', { class: 'tnum' }, fmt.format(q) + ' ' + (i.unit || '')),
          el('td', { class: 'tnum' }, fmtMoney(p)),
          el('td', { class: 'tnum', style: 'font-weight:700' }, fmtMoney(q * p)),
        ]);
      })),
    ]);

    const body = el('div', {}, [
      el('div', { class: 'pur-card-meta' }, [
        el('span', {}, '🤝 ' + o.supplier_name),
        el('span', {}, payIcon(o.payment_type)),
        statusPill(o.status),
        el('span', { class: 'muted' }, 'создана ' + dt(o.created_at) + (o.received_at ? ' · принята ' + dt(o.received_at) : '')),
      ]),
      o.comment ? el('p', { class: 'muted' }, '💬 ' + o.comment) : null,
      table,
      el('div', { class: 'oe-total' }, 'Итого: ' + fmtMoney(sum) + ' сум'),
    ]);

    const actions = [el('button', { onclick: () => m.close() }, 'Закрыть')];
    if (o.status === 'draft') {
      actions.push(el('button', { onclick: () => { m.close(); openOrderEditor(id); } }, '✏️ Редактировать'));
      actions.push(el('button', {
        onclick: async () => {
          await api('/orders/' + id + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'order' }) });
          toast('Заявка переведена в «Заказано»');
          m.close(); loadOrders();
        },
      }, '📨 Заказать'));
    }
    if (o.status === 'draft' || o.status === 'ordered') {
      actions.push(el('button', { class: 'btn-primary', onclick: () => { m.close(); openReceive(id); } }, '📥 Принять'));
      actions.push(el('button', {
        class: 'btn-danger-link',
        onclick: async () => {
          if (!confirm('Отменить заявку ' + o.number + '?')) return;
          await api('/orders/' + id + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }) });
          toast('Заявка отменена');
          m.close(); loadOrders();
        },
      }, 'Отменить'));
    }
    const m = modal('Заявка ' + o.number, body, actions);
  }

  // --- приёмка ---
  async function openReceive(id) {
    const d = await api('/orders/' + id);
    const inputs = {};
    const table = el('table', { class: 'dict-table oe-table' }, [
      el('thead', {}, el('tr', {}, ['Наименование', 'Заказано', 'Факт кол-во', 'Факт цена'].map((h) => el('th', {}, h)))),
      el('tbody', {}, d.items.map((i) => {
        const fq = el('input', { type: 'number', step: 'any', min: '0', class: 'oe-num', value: Number(i.qty) });
        const fp = el('input', { type: 'number', step: 'any', min: '0', class: 'oe-num', value: Number(i.price) });
        inputs[i.id] = { fq, fp };
        return el('tr', {}, [
          el('td', { style: 'font-weight:600' }, i.item_name),
          el('td', { class: 'tnum' }, fmt.format(Number(i.qty)) + ' ' + (i.unit || '') + ' × ' + fmtMoney(i.price)),
          el('td', {}, fq),
          el('td', {}, fp),
        ]);
      })),
    ]);
    const body = el('div', {}, [
      el('p', { class: 'muted' }, 'Проверьте фактически привезённое количество и цены. Поставьте 0, если позицию не привезли. После подтверждения поставка попадёт в долг поставщика и в историю цен.'),
      table,
    ]);
    const m = modal('📥 Приёмка — ' + d.order.number + ' · ' + d.order.supplier_name, body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            await api('/orders/' + id + '/receive', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ items: Object.entries(inputs).map(([iid, v]) => ({ id: iid, fact_qty: v.fq.value, fact_price: v.fp.value })) }),
            });
            toast('Поставка принята ✅');
            m.close(); loadOrders();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        },
      }, 'Подтвердить приёмку'),
    ]);
  }

  // ================= ПОСТАВЩИКИ =================
  async function viewSuppliers() {
    const main = $('#pur-main');
    main.innerHTML = '';
    main.appendChild(el('div', { class: 'pur-toolbar' }, [
      el('h2', {}, 'Поставщики'),
      el('div', { class: 'pur-toolbar-right' }, [
        el('input', { id: 'sup-q', placeholder: 'Поиск...', oninput: debounce(loadSuppliers, 300) }),
        el('a', { class: 'pur-link-btn', href: '/dictionaries#counterparties', target: '_blank', title: 'Импорт из Excel выполняется в справочнике контрагентов' }, 'Импорт Excel'),
        el('button', { class: 'btn-primary', onclick: () => openSupplierEdit(null) }, '+ Поставщик'),
      ]),
    ]));
    main.appendChild(el('div', { id: 'sup-list', class: 'pur-content' }));
    await loadSuppliers();
  }

  async function loadSuppliers() {
    const q = $('#sup-q') ? $('#sup-q').value.trim() : '';
    const data = await api('/suppliers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const box = $('#sup-list');
    box.innerHTML = '';
    if (!data.items.length) {
      box.appendChild(el('p', { class: 'dict-empty' }, 'Поставщиков нет. Добавьте вручную или загрузите через «Импорт Excel».'));
      return;
    }
    box.appendChild(el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Имя', 'Фирма', 'Телефон', 'Что возит', 'Сальдо'].map((h, i) =>
        el('th', { style: i === 4 ? 'text-align:right' : '' }, h)))),
      el('tbody', {}, data.items.map((s) =>
        el('tr', { onclick: () => openStatement(s.id) }, [
          el('td', { style: 'font-weight:700' }, s.name),
          el('td', {}, s.legal_name || ''),
          el('td', { class: 'tnum' }, s.phone || ''),
          el('td', { class: 'muted', style: 'max-width:280px' }, (s.supplies || '').slice(0, 60)),
          el('td', { class: 'tnum', style: 'text-align:right;font-weight:800;color:' + (Number(s.balance) > 0 ? 'var(--red)' : '#3f6a16') },
            fmtMoney(s.balance)),
        ])
      )),
    ]));
  }

  function openSupplierEdit(sup) {
    const f = {};
    const fields = [
      ['name', 'Имя поставщика *'], ['legal_name', 'Наименование фирмы'], ['phone', 'Телефон'],
      ['inn', 'ИНН'], ['supplies', 'Какое сырьё возит'], ['opening_balance', 'Стартовый долг, сум'],
    ];
    const body = el('div', { class: 'form-col', style: 'max-width:100%' }, fields.map(([k, label]) => {
      f[k] = el('input', { type: k === 'opening_balance' ? 'number' : 'text', value: sup ? (sup[k] ?? '') : '' });
      return el('label', {}, [label, f[k]]);
    }));
    const m = modal(sup ? '✏️ ' + sup.name : '+ Новый поставщик', body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          ev.target.disabled = true;
          const payload = {};
          for (const k of Object.keys(f)) payload[k] = f[k].value;
          try {
            if (sup) await api('/suppliers/' + sup.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            else await api('/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            toast('Сохранено');
            m.close();
            loadSuppliers();
            if (currentTab === 'settlements') loadSettlements();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        },
      }, 'Сохранить'),
    ]);
  }

  // ================= ВЗАИМОРАСЧЁТЫ =================
  async function viewSettlements() {
    const main = $('#pur-main');
    main.innerHTML = '';
    main.appendChild(el('div', { class: 'pur-toolbar' }, [
      el('h2', {}, 'Взаиморасчёты'),
      el('div', { class: 'pur-toolbar-right' }, [
        el('input', { id: 'set-q', placeholder: 'Поиск...', oninput: debounce(loadSettlements, 300) }),
        el('button', { class: 'btn-primary', onclick: () => openPayment(null) }, '+ Оплата'),
      ]),
    ]));
    main.appendChild(el('div', { id: 'set-totals', class: 'pur-kpis' }));
    main.appendChild(el('div', { id: 'set-list', class: 'pur-content' }));
    await loadSettlements();
  }

  async function loadSettlements() {
    const q = $('#set-q') ? $('#set-q').value.trim() : '';
    const data = await api('/suppliers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const items = data.items;
    const totalDebt = items.reduce((s, x) => s + Math.max(0, Number(x.balance)), 0);
    const totalDelivered = items.reduce((s, x) => s + Number(x.delivered), 0);
    const totalPaid = items.reduce((s, x) => s + Number(x.paid), 0);
    const kpis = $('#set-totals');
    kpis.innerHTML = '';
    [['Мы должны (TOTAL)', totalDebt, 'var(--red)'], ['Поставлено всего', totalDelivered, 'var(--ink)'], ['Оплачено всего', totalPaid, '#3f6a16']]
      .forEach(([label, v, color]) => kpis.appendChild(el('div', { class: 'pur-kpi' }, [
        el('div', { class: 'pur-kpi-label' }, label),
        el('div', { class: 'pur-kpi-val tnum', style: 'color:' + color }, fmtMoney(v) + ' сум'),
      ])));

    const box = $('#set-list');
    box.innerHTML = '';
    box.appendChild(el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Поставщик', 'Старт. долг', 'Поставлено', 'Оплачено', 'Сальдо'].map((h, i) =>
        el('th', { style: i > 0 ? 'text-align:right' : '' }, h)))),
      el('tbody', {}, items.map((s) =>
        el('tr', { onclick: () => openStatement(s.id) }, [
          el('td', { style: 'font-weight:700' }, s.name),
          el('td', { class: 'tnum', style: 'text-align:right' }, fmtMoney(s.opening_balance)),
          el('td', { class: 'tnum', style: 'text-align:right' }, fmtMoney(s.delivered)),
          el('td', { class: 'tnum', style: 'text-align:right' }, fmtMoney(s.paid)),
          el('td', { class: 'tnum', style: 'text-align:right;font-weight:800;color:' + (Number(s.balance) > 0 ? 'var(--red)' : '#3f6a16') }, fmtMoney(s.balance)),
        ])
      )),
    ]));
  }

  // карточка-выписка поставщика
  async function openStatement(id) {
    const d = await api('/suppliers/' + id + '/statement');
    const s = d.supplier;
    const delivered = d.orders.reduce((x, o) => x + Number(o.total), 0);
    const paid = d.payments.reduce((x, p) => x + Number(p.amount), 0);
    const balance = Number(s.opening_balance) + delivered - paid;

    const itemsByOrder = {};
    for (const i of d.items) (itemsByOrder[i.order_id] = itemsByOrder[i.order_id] || []).push(i);

    const ordersBlock = el('div', {}, [
      el('h3', { class: 'pur-sub' }, '📥 Поставки'),
      d.orders.length ? el('div', {}, d.orders.map((o) =>
        el('details', { class: 'pur-details' }, [
          el('summary', {}, `${o.number} · ${dt(o.received_at)} · ${fmtMoney(o.total)} сум · ${payIcon(o.payment_type)}`),
          el('table', { class: 'dict-table' }, [
            el('tbody', {}, (itemsByOrder[o.id] || []).map((i) =>
              el('tr', {}, [
                el('td', {}, i.item_name),
                el('td', { class: 'tnum' }, fmt.format(Number(i.qty)) + ' ' + (i.unit || '')),
                el('td', { class: 'tnum' }, fmtMoney(i.price)),
                el('td', { class: 'tnum', style: 'font-weight:700' }, fmtMoney(Number(i.qty) * Number(i.price))),
              ])
            )),
          ]),
        ])
      )) : el('p', { class: 'muted' }, 'Поставок ещё не было.'),
    ]);

    const paymentsBlock = el('div', {}, [
      el('h3', { class: 'pur-sub' }, '💳 Оплаты'),
      d.payments.length ? el('table', { class: 'dict-table' }, [
        el('tbody', {}, d.payments.map((p) =>
          el('tr', {}, [
            el('td', {}, dt(p.paid_at)),
            el('td', {}, payIcon(p.payment_type)),
            el('td', { class: 'muted' }, p.comment || ''),
            el('td', { class: 'tnum', style: 'text-align:right;font-weight:700;color:#3f6a16' }, fmtMoney(p.amount)),
          ])
        )),
      ]) : el('p', { class: 'muted' }, 'Оплат ещё не было.'),
    ]);

    const body = el('div', {}, [
      el('div', { class: 'pur-kpis' }, [
        ['Старт. долг', s.opening_balance], ['Поставлено', delivered], ['Оплачено', paid], ['Сальдо', balance],
      ].map(([label, v], idx) => el('div', { class: 'pur-kpi' }, [
        el('div', { class: 'pur-kpi-label' }, label),
        el('div', { class: 'pur-kpi-val tnum', style: idx === 3 ? 'color:' + (balance > 0 ? 'var(--red)' : '#3f6a16') : '' }, fmtMoney(v)),
      ]))),
      el('p', { class: 'muted' }, [s.legal_name, s.inn ? 'ИНН ' + s.inn : '', s.phone].filter(Boolean).join(' · ')),
      ordersBlock,
      paymentsBlock,
    ]);
    const m = modal('🤝 ' + s.name, body, [
      el('button', { onclick: () => { m.close(); openSupplierEdit(s); } }, '✏️ Изменить'),
      el('button', { class: 'btn-primary', onclick: () => { m.close(); openPayment(s); } }, '+ Оплата'),
      el('button', { onclick: () => m.close() }, 'Закрыть'),
    ]);
  }

  async function openPayment(presetSupplier) {
    const suppliers = (await api('/suppliers')).items;
    const supSel = el('select', {}, suppliers.map((s) => el('option', { value: s.id }, s.name + ' (сальдо: ' + fmtMoney(s.balance) + ')')));
    if (presetSupplier) supSel.value = presetSupplier.id;
    const amount = el('input', { type: 'number', step: 'any', min: '0', placeholder: '0' });
    const pay = el('select', {}, [
      el('option', { value: 'перечисление' }, '🏦 Перечисление'),
      el('option', { value: 'наличка' }, '💵 Наличка'),
    ]);
    const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const comment = el('input', { placeholder: 'Комментарий (необязательно)' });
    const body = el('div', { class: 'form-col', style: 'max-width:100%' }, [
      el('label', {}, ['Поставщик', supSel]),
      el('label', {}, ['Сумма, сум *', amount]),
      el('label', {}, ['Тип платежа', pay]),
      el('label', {}, ['Дата', date]),
      el('label', {}, ['Комментарий', comment]),
    ]);
    const m = modal('💳 Внести оплату поставщику', body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            await api('/payments', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ supplier_id: supSel.value, amount: amount.value, payment_type: pay.value, paid_at: date.value, comment: comment.value }),
            });
            toast('Оплата записана ✅');
            m.close();
            if (currentTab === 'settlements') loadSettlements(); else loadSuppliers();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        },
      }, 'Записать оплату'),
    ]);
  }

  // ================= Каркас =================
  let currentTab = 'orders';
  function debounce(fn, ms) {
    let t;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.pur-tab').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    if (tab === 'suppliers') viewSuppliers();
    else if (tab === 'settlements') viewSettlements();
    else viewOrders();
  }

  window.addEventListener('hashchange', () => switchTab(location.hash.slice(1) || 'orders'));
  switchTab(location.hash.slice(1) || 'orders');
})();
