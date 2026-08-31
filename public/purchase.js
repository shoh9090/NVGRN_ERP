// purchase.js — блок «Закуп»: заявки, приёмка, поставщики, взаиморасчёты
(function () {
  const $ = (s) => document.querySelector(s);
  const fmt = new Intl.NumberFormat('ru-RU');
  const fmtMoney = (v) => fmt.format(Math.round(Number(v) || 0));
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

  // opts.wide — окно во всю ширину экрана (для широких таблиц, чтобы не листать вбок).
  function modal(title, bodyNode, actions, opts) {
    const root = $('#pur-modal-root');
    root.innerHTML = '';
    const overlay = el('div', { class: 'imp-overlay' });
    const panel = el('div', { class: 'imp-panel pur-modal' + ((opts && opts.wide) ? ' pur-modal-wide' : '') }, [
      el('div', { class: 'imp-head' }, [el('h3', {}, title)]),
      el('div', { class: 'imp-body pur-modal-body' }, [bodyNode]),
      el('div', { class: 'imp-actions' }, actions),
    ]);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) root.innerHTML = ''; });
    root.appendChild(overlay);
    return { close: () => (root.innerHTML = '') };
  }

  // Кто и когда отменил заявку (+ причина). Показываем подсказкой на статусе и строкой в карточке.
  function cancelNote(o) {
    if (!o || o.status !== 'cancelled' || !o.cancelled_at) return '';
    return 'Отменил: ' + (o.cancelled_by || '—') + ' · ' + dt(o.cancelled_at)
      + (o.cancel_reason ? '\nПричина: ' + o.cancel_reason : '');
  }
  const statusPill = (s, o) => {
    const map = {
      draft: ['Черновик', 'st-draft'], ordered: ['Заказано', 'st-ordered'],
      received: ['Принято', 'st-received'], cancelled: ['Отменено', 'st-cancelled'],
    };
    const [label, cls] = map[s] || [s, ''];
    return el('span', { class: 'status-pill ' + cls, title: cancelNote(o) || null }, label);
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
        // Период — общим компонентом Hub, как в Кассе и Претензиях.
        HubDateRange.create({
          mode: 'range', from: ordPeriod.from, to: ordPeriod.to,
          onChange: (v) => { ordPeriod.from = v.from; ordPeriod.to = v.to; loadOrders(); },
        }),
        el('input', { id: 'ord-q', placeholder: 'Поиск: номер, поставщик...', oninput: debounce(loadOrders, 300) }),
        el('button', { class: 'btn-primary', onclick: () => openOrderEditor(null) }, '+ Новая заявка'),
        ...((typeof HUB_USER !== 'undefined' && (HUB_USER.isAdmin || HUB_USER.buyerEdit)) ? [el('button', { style: 'color:#c0392b', title: 'Удалить все заявки за всё время', onclick: clearAllOrders }, '🧹 Очистить все заявки')] : []),
      ]),
    ]);
    main.appendChild(toolbar);
    await ensureOpts();
    const ordPc = el('select', { id: 'ord-pc', onchange: loadOrders }, [
      el('option', { value: '' }, 'Все родит. категории'),
      ...FOPTS.parents.map((p) => el('option', { value: p.id }, p.name)),
    ]);
    const ordSup = el('select', { id: 'ord-sup', onchange: loadOrders }, [
      el('option', { value: '' }, 'Все поставщики'),
      ...FOPTS.suppliers.map((sp) => el('option', { value: sp.id }, sp.name)),
    ]);
    ORD_ITEMS = new Set();
    const ordItems = itemMultiSelect(FOPTS.items, ORD_ITEMS, loadOrders);
    const reset = el('button', { onclick: () => { ordPc.value=''; ordSup.value=''; ORD_ITEMS.clear(); $('#ord-q').value=''; viewOrders(); } }, 'Сбросить');
    main.appendChild(el('div', { class: 'pur-filters' }, [
      el('label', {}, ['Родит. категория', ordPc]),
      el('label', {}, ['Поставщик', ordSup]),
      el('label', {}, ['Товары (мультивыбор)', ordItems]),
      reset,
    ]));
    main.appendChild(el('div', { id: 'ord-list', class: 'pur-content' }));
    await loadOrders();
  }

  async function clearAllOrders() {
    if (!confirm('Удалить ВСЕ заявки за всё время?\n\n• Склад сырья и остатки — останутся.\n• Стартовые долги поставщиков — останутся.\n• Оплаты поставщикам — сохранятся (отвяжутся от заявок).\n\nОтменить нельзя. Продолжить?')) return;
    if (!confirm('Точно удаляем все заявки безвозвратно?')) return;
    try {
      const r = await api('/orders/clear-all', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      toast('Удалено заявок: ' + r.deleted);
      viewOrders();
    } catch (e) { toast(e.message, true); }
  }

  // Период заявок: по умолчанию пусто — показываем все, как было раньше.
  // Пустой период не должен внезапно прятать половину заявок у того, кто
  // просто открыл вкладку.
  const ordPeriod = { from: '', to: '' };

  async function loadOrders() {
    const box = $('#ord-list');
    const status = $('#ord-status') ? $('#ord-status').value : 'all';
    const q = $('#ord-q') ? $('#ord-q').value.trim() : '';
    const params = new URLSearchParams({ status });
    if (q) params.set('q', q);
    if ($('#ord-pc') && $('#ord-pc').value) params.set('parent_category_id', $('#ord-pc').value);
    if ($('#ord-sup') && $('#ord-sup').value) params.set('supplier_id', $('#ord-sup').value);
    if (ORD_ITEMS && ORD_ITEMS.size) params.set('item_ids', [...ORD_ITEMS].join(','));
    if (ordPeriod.from) params.set('from', ordPeriod.from);
    if (ordPeriod.to) params.set('to', ordPeriod.to);
    const data = await api('/orders?' + params.toString());
    box.innerHTML = '';
    // Итог по отобранным заявкам: сколько их и на какую сумму. Считается на
    // сервере по всей выборке, а не по показанным строкам — список обрезан
    // тремястами, и сумма по нему вводила бы в заблуждение.
    if (data.totals) {
      box.appendChild(el('div', { class: 'pur-ord-total' }, [
        el('span', {}, [el('b', {}, String(data.totals.orders)), ' заявок на сумму ',
          el('b', {}, Math.round(data.totals.total).toLocaleString('ru-RU')), ' сум']),
        (ordPeriod.from || ordPeriod.to)
          ? el('span', { class: 'pur-ord-total-p' }, 'за выбранный период')
          : el('span', { class: 'pur-ord-total-p' }, 'за всё время — выберите период кнопкой выше'),
        data.truncated ? el('span', { class: 'pur-ord-total-w' }, 'в списке показаны первые 300') : null,
      ]));
    }
    if (!data.items.length) {
      box.appendChild(el('p', { class: 'dict-empty' },
        (ordPeriod.from || ordPeriod.to) ? 'За выбранный период заявок нет.' : 'Заявок пока нет. Нажмите «+ Новая заявка».'));
      return;
    }
    const rnum = 'text-align:right';
    const table = el('table', { class: 'dict-table pur-orders' }, [
      el('thead', {}, el('tr', {}, [
        ['№', ''], ['Дата пост.', ''], ['Поставщик', ''], ['Сумма', rnum], ['Оплата', ''],
        ['Срок опл.', ''], ['Оплачено', rnum], ['Остаток', rnum], ['Статус оплаты', ''], ['Заявка', ''],
      ].map(([h, st]) => el('th', { style: st }, h)))),
      el('tbody', {}, data.items.map((o) =>
        el('tr', { onclick: () => openOrderCard(o.id) }, [
          el('td', { style: 'font-weight:800' }, o.number),
          el('td', {}, o.delivery_date ? dt(o.delivery_date) : dt(o.created_at)),
          el('td', {}, o.supplier_name),
          el('td', { class: 'tnum', style: rnum + ';font-weight:700' }, fmtMoney(o.total)),
          el('td', {}, [payIcon(o.payment_type), ' ', el('span', { class: 'muted' }, condLabel(o.pay_condition, o.defer_days))]),
          el('td', { class: 'muted' }, o.due_date ? dt(o.due_date) : '—'),
          el('td', { class: 'tnum', style: rnum }, o.paid ? fmtMoney(o.paid) : '—'),
          el('td', { class: 'tnum', style: rnum + (o.remainder > 0 ? ';color:#c0392b;font-weight:700' : '') }, o.remainder > 0 ? fmtMoney(o.remainder) : '—'),
          el('td', {}, payStatusPill(o.pay_status)),
          el('td', {}, statusPill(o.status, o)),
        ])
      )),
    ]);
    box.appendChild(table);
  }
  const condLabel = (c, d) => ({ prepay: 'Предоплата', on_fact: 'По факту', defer: 'Отсрочка' + (d ? ' ' + d + 'д' : '') }[c] || '—');
  function payStatusPill(s) {
    const cls = {
      'Оплачено': 'st-received', 'Просрочено': 'st-cancelled', 'Не оплачено': 'st-ordered',
      'Частично оплачено': 'st-ordered', 'Переплата / аванс': 'st-received',
      'Ожидает поставки': 'st-draft', 'Ожидает предоплаты': 'st-ordered',
    }[s] || 'st-draft';
    return el('span', { class: 'status-pill ' + cls }, s || '—');
  }

  // --- редактор заявки (создание/черновик) ---
  async function openOrderEditor(orderId, presetSupplierId) {
    let order = null;
    let items = [];
    if (orderId) {
      const d = await api('/orders/' + orderId);
      order = d.order;
      items = d.items;
    }
    await ensureOpts();
    const suppliers = (await api('/suppliers')).items;

    // П4: обязательный фильтр — сначала родительская категория, потом поставщики этой категории
    const pcSel = el('select', { id: 'oe-pc', disabled: !!orderId }, [
      el('option', { value: '' }, '— категория —'),
      ...FOPTS.parents.map((p) => el('option', { value: p.id }, p.name)),
    ]);
    const supSel = el('select', { id: 'oe-supplier', disabled: !!orderId }, []);

    function fillSuppliers() {
      const pc = pcSel.value;
      supSel.innerHTML = '';
      supSel.appendChild(el('option', { value: '' }, '— выберите поставщика —'));
      let list = suppliers;
      if (pc) {
        // поставщики выбранной категории + те, у кого категория ещё не задана (чтобы старые не пропадали)
        list = suppliers.filter((s) => String(s.parent_category_id) === String(pc) || !s.parent_category_id);
      }
      list.forEach((s) => supSel.appendChild(el('option', { value: s.id }, s.name + (!s.parent_category_id ? ' ⚠️' : ''))));
    }
    fillSuppliers();
    pcSel.addEventListener('change', () => { fillSuppliers(); supSel.value = ''; loadMats(); });

    // при редактировании/preset — выставить категорию по поставщику
    if (order || presetSupplierId) {
      const sid = order ? order.supplier_id : presetSupplierId;
      const sup = suppliers.find((s) => String(s.id) === String(sid));
      if (sup && sup.parent_category_id) { pcSel.value = sup.parent_category_id; fillSuppliers(); }
      supSel.value = sid;
    }

    const paySel = el('select', { id: 'oe-pay' }, [
      el('option', { value: 'перечисление' }, '🏦 Перечисление'),
      el('option', { value: 'наличка' }, '💵 Наличка'),
    ]);
    if (order) paySel.value = order.payment_type;
    // Условие оплаты + дни отсрочки (отсрочка показывается только для условия «Отсрочка»).
    const condSel = el('select', { id: 'oe-cond' }, [
      el('option', { value: 'prepay' }, 'Предоплата'),
      el('option', { value: 'on_fact' }, 'По факту поставки'),
      el('option', { value: 'defer' }, 'Отсрочка'),
    ]);
    condSel.value = order ? (order.pay_condition || 'on_fact') : 'on_fact';
    const deferIn = el('input', { id: 'oe-defer', type: 'number', min: '1', step: '1', placeholder: 'дней', style: 'width:80px', value: order && order.defer_days ? order.defer_days : '' });
    const deferWrap = el('label', { style: 'flex:1 1 110px' }, ['Отсрочка, дней', deferIn]);
    const toggleDefer = () => { deferWrap.style.display = condSel.value === 'defer' ? '' : 'none'; };
    condSel.addEventListener('change', toggleDefer);
    // Автоподстановка условий из карточки поставщика (только для новой заявки, не перетирая ручной выбор).
    const applySupplierDefaults = () => {
      if (order) return;
      const s = suppliers.find((x) => String(x.id) === String(supSel.value));
      if (!s) return;
      if (s.def_payment_type) paySel.value = s.def_payment_type;
      if (s.def_pay_condition) condSel.value = s.def_pay_condition;
      if (s.def_defer_days) deferIn.value = s.def_defer_days;
      toggleDefer();
    };
    supSel.addEventListener('change', applySupplierDefaults);
    toggleDefer();

    const dateIn = el('input', { id: 'oe-date', type: 'date' });
    if (order && order.delivery_date) dateIn.value = String(order.delivery_date).slice(0, 10);
    else dateIn.value = new Date().toISOString().slice(0, 10);
    const windows = ['08:00–10:00','10:00–12:00','12:00–14:00','14:00–16:00','16:00–18:00','18:00–20:00'];
    const winSel = el('select', { id: 'oe-window' }, [el('option', { value: '' }, '— окно —'), ...windows.map((w) => el('option', { value: w }, w))]);
    if (order && order.delivery_window) winSel.value = order.delivery_window;

    const search = el('input', { placeholder: 'Поиск по прикреплённым товарам...', oninput: debounce(renderRows, 250) });
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
      if (!supSel.value) {
        tableWrap.appendChild(el('p', { class: 'dict-empty' }, 'Выберите категорию и поставщика — появятся его прикреплённые товары.'));
        return;
      }
      // П5: только прикреплённые к поставщику товары
      let filtered = mats.filter((m) => m.attached || entered[m.kind + ':' + m.id]);
      if (q) filtered = filtered.filter((m) => m.name.toLowerCase().includes(q) || String(m.code || '').toLowerCase().includes(q));
      if (!filtered.length) {
        tableWrap.appendChild(el('div', { class: 'dict-empty' }, [
          el('p', {}, 'У этого поставщика нет прикреплённых товаров.'),
          el('p', { class: 'muted' }, 'Чтобы заказать — сначала прикрепите товар в карточке поставщика (вкладка «Поставщики» → 📎 Товары поставщика).'),
        ]));
        return;
      }
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
        const priceTouched = !!entered[key];
        const priceIn = el('input', {
          type: 'number', step: 'any', min: '0',
          class: 'oe-num' + (priceTouched ? '' : ' oe-ghost'),
          value: e.price === '' ? '' : e.price,
          oninput: (ev) => {
            ev.target.classList.remove('oe-ghost');
            if (entered[key]) { entered[key].price = Number(ev.target.value) || 0; recalcTotal(); }
          },
        });
        return el('tr', { class: entered[key] ? 'oe-row-on' : '' }, [
          el('td', { class: 'tnum' }, m.code || ''),
          el('td', { style: 'font-weight:600' }, m.name + (m.kind === 'packaging' ? ' 📦' : '')),
          el('td', {}, m.unit || ''),
          el('td', { class: 'tnum muted' }, m.stock > 0 ? fmt.format(Number(m.stock)) : '—'),
          el('td', {}, qtyIn),
          el('td', {}, priceIn),
        ]);
      });
      tableWrap.appendChild(el('table', { class: 'dict-table oe-table' }, [
        el('thead', {}, el('tr', {}, ['Артикул', 'Наименование', 'Ед.', 'Остаток*', 'Кол-во', 'Цена'].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows),
      ]));
      recalcTotal();
    }

    supSel.addEventListener('change', loadMats);

    const body = el('div', {}, [
      el('div', { class: 'oe-head form-row' }, [
        el('label', { style: 'flex:1 1 150px' }, ['Родит. категория', pcSel]),
        el('label', { style: 'flex:2 1 180px' }, ['Поставщик', supSel]),
        el('label', { style: 'flex:1 1 140px' }, ['📅 Дата поставки', dateIn]),
        el('label', { style: 'flex:1 1 150px' }, ['🕐 Время поставки на склад', winSel]),
        el('label', { style: 'flex:1 1 130px' }, ['Тип оплаты', paySel]),
        el('label', { style: 'flex:1 1 150px' }, ['Условие оплаты', condSel]),
        deferWrap,
        el('label', { style: 'flex:1 1 160px' }, ['Комментарий', comment]),
      ]),
      el('div', { class: 'form-row', style: 'margin:10px 0' }, [search]),
      tableWrap,
      el('p', { class: 'muted', style: 'margin:6px 0 0;font-size:11.5px' }, '* Остаток = принятые приходы; расход производства подключится с блоком «Склад сырья». Серая цена — последняя цена закупа: не меняли — останется она.'),
      totalBox,
    ]);

    const m = modal(orderId ? 'Заявка ' + order.number : 'Новая заявка на закуп', body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          // Валидация обязательных полей (ТЗ разд. 2.4) — понятные сообщения.
          if (!pcSel.value) return toast('Укажите родительскую категорию', true);
          if (!supSel.value) return toast('Выберите поставщика', true);
          if (!dateIn.value) return toast('Укажите дату поставки', true);
          if (!winSel.value) return toast('Укажите время поставки на склад', true);
          if (!paySel.value) return toast('Выберите тип оплаты', true);
          if (!condSel.value) return toast('Выберите условие оплаты', true);
          if (condSel.value === 'defer' && !(parseInt(deferIn.value, 10) > 0)) return toast('Укажите количество дней отсрочки', true);
          const posItems = Object.entries(entered).map(([k, v]) => { const [kind, id] = k.split(':'); return { item_kind: kind, item_id: id, qty: v.qty, price: v.price }; });
          if (!posItems.length) return toast('Добавьте хотя бы одну позицию', true);
          if (posItems.some((it) => !(Number(it.qty) > 0))) return toast('Укажите количество по каждой позиции', true);
          if (posItems.some((it) => !(Number(it.price) > 0))) return toast('Укажите цену по каждой позиции', true);
          const payload = {
            supplier_id: supSel.value,
            payment_type: paySel.value,
            pay_condition: condSel.value,
            defer_days: condSel.value === 'defer' ? parseInt(deferIn.value, 10) : 0,
            delivery_date: dateIn.value || null,
            delivery_window: winSel.value || '',
            comment: comment.value,
            items: posItems,
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

    if (!suppliers.length) {
      body.insertBefore(
        el('div', { class: 'error' }, 'Поставщиков пока нет. Добавьте их на вкладке «Поставщики» (кнопка «+ Поставщик» или «📥 Импорт Excel») — и возвращайтесь к заявке.'),
        body.firstChild
      );
    }
    await loadMats(); // номенклатура видна сразу, без ожидания выбора поставщика
  }

  // --- карточка заявки ---
  async function openOrderCard(id) {
    const d = await api('/orders/' + id);
    const o = d.order;
    // Принято → количество из факт-приёмки (0 если не принято), цена всегда из заявки. Черновик/заказ → план.
    const rcvd = o.status === 'received';
    const qtyOf = (i) => (rcvd ? (Number(i.fact_qty) || 0) : Number(i.qty));
    const priceOf = (i) => Number(i.price);
    const sum = d.items.reduce((s, i) => s + qtyOf(i) * priceOf(i), 0);

    let table;
    if (rcvd) {
      table = el('table', { class: 'dict-table' }, [
        el('thead', {}, el('tr', {}, ['Товар', 'Принято', 'Цена', 'Сумма'].map((h) => el('th', {}, h)))),
        el('tbody', {}, d.items.map((i) => {
          const p = priceOf(i), acc = Number(i.fact_qty) || 0;
          return el('tr', {}, [
            el('td', {}, i.item_name + (i.item_kind === 'packaging' ? ' 📦' : '')),
            el('td', { class: 'tnum' }, fmt.format(acc) + ' ' + (i.unit || '')),
            el('td', { class: 'tnum' }, fmtMoney(p)),
            el('td', { class: 'tnum', style: 'font-weight:700' }, fmtMoney(acc * p)),
          ]);
        })),
      ]);
    } else {
      table = el('table', { class: 'dict-table' }, [
        el('thead', {}, el('tr', {}, ['Артикул', 'Наименование', 'Кол-во', 'Цена', 'Сумма'].map((h) => el('th', {}, h)))),
        el('tbody', {}, d.items.map((i) => {
          const q = qtyOf(i), p = priceOf(i);
          return el('tr', {}, [
            el('td', { class: 'tnum' }, i.item_code || ''),
            el('td', {}, i.item_name + (i.item_kind === 'packaging' ? ' 📦' : '')),
            el('td', { class: 'tnum' }, fmt.format(q) + ' ' + (i.unit || '')),
            el('td', { class: 'tnum' }, fmtMoney(p)),
            el('td', { class: 'tnum', style: 'font-weight:700' }, fmtMoney(q * p)),
          ]);
        })),
      ]);
    }

    const body = el('div', {}, [
      el('div', { class: 'pur-card-meta' }, [
        el('span', {}, '🤝 ' + o.supplier_name),
        el('span', {}, payIcon(o.payment_type)),
        statusPill(o.status, o),
        el('span', { class: 'muted' }, 'создана ' + dt(o.created_at) + (o.received_at ? ' · принята ' + dt(o.received_at) : '')),
      ]),
      // След отмены — прямо в карточке, чтобы не искать по журналу, кто её отменил.
      o.status === 'cancelled' && o.cancelled_at
        ? el('p', { style: 'color:#c0392b;font-weight:600;margin:6px 0' },
            '❌ Отменил: ' + (o.cancelled_by || '—') + ' · ' + dt(o.cancelled_at)
            + (o.cancel_reason ? ' · причина: ' + o.cancel_reason : ''))
        : null,
      o.comment ? el('p', { class: 'muted' }, '💬 ' + o.comment) : null,
      table,
      el('div', { class: 'oe-total' }, (rcvd ? 'Долг: ' : 'Итого: ') + fmtMoney(sum) + ' сум'),
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
      actions.push(el('button', {
        class: 'btn-danger-link',
        title: 'Заявка останется в системе со статусом «Отменено» — видно, кто и почему отменил',
        onclick: () => { m.close(); openCancelOrder(id, o.number); },
      }, '❌ Отменить заявку'));
    }
    // Отменили по ошибке — можно вернуть в черновик (заявка никуда не удалялась).
    if (o.status === 'cancelled') {
      actions.push(el('button', {
        onclick: async () => {
          if (!confirm('Вернуть заявку ' + o.number + ' в черновики?')) return;
          try {
            await api('/orders/' + id + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reopen' }) });
            toast('Заявка возвращена в черновики');
            m.close(); loadOrders();
          } catch (e) { toast(e.message, true); }
        },
      }, '↩️ Вернуть в черновик'));
    }
    if (window.HUB_USER && (window.HUB_USER.isAdmin || window.HUB_USER.buyerEdit)) {
      actions.push(el('button', {
        class: 'btn-danger-link',
        onclick: async () => {
          if (!confirm('Удалить заявку ' + o.number + ' навсегда? Это действие нельзя отменить.')) return;
          try {
            let res = await fetch('/purchase/api/orders/' + id, { method: 'DELETE' });
            let data = await res.json().catch(() => ({}));
            if (res.status === 409 && data.error === 'received') {
              if (!confirm(data.message + '\n\nВсё равно удалить?')) return;
              res = await fetch('/purchase/api/orders/' + id + '?force=1', { method: 'DELETE' });
              data = await res.json().catch(() => ({}));
            }
            if (!res.ok) throw new Error(data.error || 'Ошибка удаления');
            toast('Заявка удалена');
            m.close();
            loadOrders();
          } catch (e) { toast(e.message, true); }
        },
      }, '🗑 Удалить'));
    }
    // Правка для сверки/переноса (поставщик/кол-во/цена) — админу всегда, закупщику пока включён тумблер.
    if (window.HUB_USER && (window.HUB_USER.isAdmin || window.HUB_USER.buyerEdit)) {
      actions.push(el('button', { onclick: () => { m.close(); openReconcileEditor(id); } }, '✏️ Изменить (перенос)'));
    }
    const m = modal('Заявка ' + o.number, body, actions);
  }

  // Отмена заявки. Заменяет удаление тем, у кого нет прав удалять: заявка остаётся в системе,
  // но с пометкой «Отменено» и следом — кто, когда и почему. Причина необязательна.
  function openCancelOrder(id, number) {
    const reason = el('textarea', { rows: 3, style: 'width:100%', placeholder: 'Например: ошиблись поставщиком / заявка-дубль / поставка не состоялась' });
    const body = el('div', {}, [
      el('p', {}, 'Заявка ' + number + ' получит статус «Отменено». Она останется в списке и в истории — в суммы и долги поставщику не пойдёт.'),
      el('label', { style: 'display:block;margin-top:10px' }, [
        el('div', { class: 'muted', style: 'margin-bottom:4px' }, 'Причина отмены (необязательно)'),
        reason,
      ]),
    ]);
    const ok = el('button', { class: 'btn-danger-link', onclick: async () => {
      ok.disabled = true;
      try {
        await api('/orders/' + id + '/status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', reason: reason.value.trim() }),
        });
        toast('Заявка отменена');
        m2.close(); loadOrders();
      } catch (e) { toast(e.message, true); ok.disabled = false; }
    } }, '❌ Отменить заявку');
    const m2 = modal('Отмена заявки ' + number, body, [el('button', { onclick: () => m2.close() }, 'Назад'), ok]);
  }

  // Правка заявки для сверки/переноса: поставщик + по позициям кол-во/цена. Приёмку не трогает.
  async function openReconcileEditor(id) {
    const d = await api('/orders/' + id);
    const o = d.order;
    const rcvd = o.status === 'received';
    const suppliers = (await api('/suppliers')).items || [];
    const supSel = el('select', {}, suppliers.map((s) => el('option', { value: s.id, selected: String(s.id) === String(o.supplier_id) || null }, s.name)));
    const rowInputs = [];
    const delIds = new Set();       // id существующих позиций, помеченных на удаление
    const tbody = el('tbody', {});
    function renderExisting() {
      tbody.innerHTML = ''; rowInputs.length = 0;
      d.items.forEach((i) => {
        const deleted = delIds.has(i.id);
        const qtyIn = el('input', { type: 'number', step: 'any', min: '0', value: Number(i.qty), style: 'width:90px;text-align:right', disabled: deleted || null });
        const priceIn = el('input', { type: 'number', step: 'any', min: '0', value: Number(i.price), style: 'width:100px;text-align:right', disabled: deleted || null });
        rowInputs.push({ id: i.id, qtyIn, priceIn });
        const delBtn = el('a', { href: 'javascript:void(0)', title: deleted ? 'Вернуть товар' : 'Убрать товар из заявки', style: 'color:' + (deleted ? '#3f6a16' : '#c0392b') + ';font-weight:700;text-decoration:none', onclick: (e) => { e.preventDefault(); if (deleted) delIds.delete(i.id); else delIds.add(i.id); renderExisting(); } }, deleted ? '↩' : '✕');
        tbody.appendChild(el('tr', { style: deleted ? 'opacity:.45;text-decoration:line-through' : '' }, [
          el('td', {}, i.item_name + (i.item_kind === 'packaging' ? ' 📦' : '')),
          el('td', { class: 'tnum' }, qtyIn),
          el('td', { class: 'tnum' }, priceIn),
          el('td', { class: 'tnum muted' }, rcvd ? ('принято ' + fmt.format(Number(i.fact_qty) || 0) + ' ' + (i.unit || '')) : '—'),
          el('td', { style: 'text-align:center;width:1%' }, delBtn),
        ]));
      });
    }
    renderExisting();
    const table = el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Товар', 'Кол-во (заявка)', 'Цена', 'Приёмка', ''].map((h) => el('th', {}, h)))),
      tbody,
    ]);

    // --- Добавление нового товара ---
    const added = [];               // {kind, id, name, qty, price}
    const addedBody = el('tbody', {});
    function renderAdded() {
      addedBody.innerHTML = '';
      added.forEach((a, idx) => addedBody.appendChild(el('tr', {}, [
        el('td', {}, '➕ ' + a.name),
        el('td', { class: 'tnum' }, fmt.format(a.qty)),
        el('td', { class: 'tnum' }, fmtMoney(a.price)),
        el('td', {}, ''),
        el('td', { style: 'text-align:center;width:1%' }, el('a', { href: 'javascript:void(0)', title: 'Убрать', style: 'color:#c0392b;font-weight:700;text-decoration:none', onclick: (e) => { e.preventDefault(); added.splice(idx, 1); renderAdded(); } }, '✕')),
      ])));
    }
    let mats = [];
    const matSel = el('select', { style: 'min-width:220px' });
    async function loadMats() {
      mats = (await api('/materials?supplier_id=' + (supSel.value || 0))).items || [];
      matSel.innerHTML = '';
      matSel.appendChild(el('option', { value: '' }, '— выбрать товар —'));
      mats.forEach((mm) => matSel.appendChild(el('option', { value: mm.kind + ':' + mm.id }, mm.name + (mm.kind === 'packaging' ? ' 📦' : '') + (mm.unit ? ' (' + mm.unit + ')' : ''))));
    }
    const addQty = el('input', { type: 'number', step: 'any', min: '0', placeholder: 'кол-во', style: 'width:90px;text-align:right' });
    const addPrice = el('input', { type: 'number', step: 'any', min: '0', placeholder: 'цена', style: 'width:100px;text-align:right' });
    const addBtn = el('button', { onclick: () => {
      if (!matSel.value) { toast('Выберите товар', true); return; }
      const qty = Number(addQty.value), price = Number(addPrice.value);
      if (!(qty > 0)) { toast('Укажите количество', true); return; }
      const [kind, mid] = matSel.value.split(':');
      const mm = mats.find((x) => x.kind === kind && String(x.id) === String(mid));
      added.push({ kind, id: mid, name: mm ? mm.name : ('#' + mid), qty, price: price || 0 });
      addQty.value = ''; addPrice.value = ''; matSel.value = '';
      renderAdded();
    } }, '＋ Добавить товар');
    supSel.onchange = loadMats;
    await loadMats();
    const addTable = el('table', { class: 'dict-table' }, [addedBody]);
    const addRow = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px' }, [matSel, addQty, addPrice, addBtn]);

    const body = el('div', { class: 'form-col' }, [
      el('div', { class: 'muted', style: 'font-size:12px' }, 'Правка для сверки с данными закупщика (перенос). Меняются поставщик, количество и цена; можно убрать товар из заявки (✕) или добавить новый. Приёмка кладовщика и склад НЕ меняются — это только про заявку и долг.'),
      el('label', {}, ['Поставщик', supSel]),
      el('div', { style: 'overflow-x:auto' }, table),
      el('div', { style: 'margin-top:10px;font-weight:700' }, '➕ Добавить товар'),
      addTable,
      addRow,
    ]);
    const m = modal('✏️ Изменить заявку ' + o.number, body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', { class: 'btn-primary', onclick: async (ev) => {
        ev.target.disabled = true;
        const items = rowInputs.filter((r) => !delIds.has(r.id)).map((r) => ({ id: r.id, qty: r.qtyIn.value, price: r.priceIn.value }));
        const add_items = added.map((a) => ({ item_kind: a.kind, item_id: a.id, qty: a.qty, price: a.price }));
        try {
          await api('/orders/' + id + '/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier_id: supSel.value, items, delete_ids: [...delIds], add_items }) });
          toast('Заявка изменена ✅'); m.close(); loadOrders();
        } catch (e) { toast(e.message, true); ev.target.disabled = false; }
      } }, 'Сохранить'),
    ]);
  }

  // приёмка перенесена в блок «Склад сырья» — закупщик заявку только создаёт

  // ================= ПОСТАВЩИКИ =================
  async function viewSuppliers() {
    const main = $('#pur-main');
    main.innerHTML = '';
    await ensureOpts();
    main.appendChild(el('div', { class: 'pur-toolbar' }, [
      el('h2', {}, 'Поставщики'),
      el('div', { class: 'pur-toolbar-right' }, [
        el('input', { id: 'sup-q', placeholder: 'Поиск...', oninput: debounce(loadSuppliers, 300) }),
        el('button', { onclick: () => $('#sup-import-file').click(), title: 'Файл со списком поставщиков или вкладкой TOTAL' }, '📥 Импорт Excel'),
        (() => { const f = el('input', { id: 'sup-import-file', type: 'file', accept: '.xlsx,.xls,.csv', style: 'display:none', onchange: (e) => { if (e.target.files[0]) importSuppliers(e.target.files[0]); e.target.value = ''; } }); return f; })(),
        ...((typeof HUB_USER !== 'undefined' && HUB_USER.isAdmin) ? [
          el('button', { onclick: () => $('#sup-bal-file').click(), title: 'Проставить стартовые остатки (долги) существующим поставщикам из Excel' }, '💰 Импорт остатков'),
          (() => { const f = el('input', { id: 'sup-bal-file', type: 'file', accept: '.xlsx,.xls,.csv', style: 'display:none', onchange: (e) => { if (e.target.files[0]) importSupplierBalances(e.target.files[0]); e.target.value = ''; } }); return f; })(),
        ] : []),
        el('button', { class: 'btn-primary', onclick: () => openSupplierEdit(null) }, '+ Поставщик'),
      ]),
    ]));
    const pcSel = el('select', { id: 'sup-pc', onchange: loadSuppliers }, [
      el('option', { value: '' }, 'Все родительские категории'),
      ...FOPTS.parents.map((p) => el('option', { value: p.id }, p.name)),
    ]);
    main.appendChild(el('div', { class: 'pur-filters' }, [el('label', {}, ['Родительская категория', pcSel])]));
    main.appendChild(el('div', { id: 'sup-list', class: 'pur-content' }));
    await loadSuppliers();
  }

  async function loadSuppliers() {
    const p = new URLSearchParams();
    if ($('#sup-q') && $('#sup-q').value.trim()) p.set('q', $('#sup-q').value.trim());
    if ($('#sup-pc') && $('#sup-pc').value) p.set('parent_category_id', $('#sup-pc').value);
    const data = await api('/suppliers' + (p.toString() ? '?' + p.toString() : ''));
    const box = $('#sup-list');
    box.innerHTML = '';
    if (!data.items.length) {
      box.appendChild(el('p', { class: 'dict-empty' }, 'Поставщиков нет. Добавьте вручную или загрузите через «Импорт Excel».'));
      return;
    }
    const canDel = typeof HUB_USER !== 'undefined' && (HUB_USER.isAdmin || HUB_USER.buyerEdit);
    box.appendChild(el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Имя', 'Категория', 'Статья ДДС', 'Фирма', 'Телефон', 'Товары', 'Сальдо', ''].map((h, i) =>
        el('th', { style: i === 6 ? 'text-align:right' : '' }, h)))),
      el('tbody', {}, data.items.map((s) =>
        el('tr', { onclick: () => openStatement(s.id) }, [
          el('td', { style: 'font-weight:700' }, s.name),
          el('td', {}, pcBadge(s.parent_category_name, s.parent_category_color)),
          el('td', { class: 'muted', title: s.cash_cat_name || '' },
            s.cash_cat_code ? s.cash_cat_code + ' · ' + (s.cash_cat_name || '') : '—'),
          el('td', {}, s.legal_name || ''),
          el('td', { class: 'tnum' }, s.phone || ''),
          el('td', { class: 'muted' }, s.attached_count > 0 ? '📎 ' + s.attached_count : ((s.supplies || '').slice(0, 40) || '—')),
          el('td', { class: 'tnum', style: 'text-align:right;font-weight:800;color:' + (Number(s.balance) > 0 ? 'var(--red)' : '#3f6a16') },
            fmtMoney(s.balance)),
          el('td', { style: 'text-align:right;white-space:nowrap' }, canDel
            ? el('button', { class: 'inv-mini', title: 'Удалить поставщика', style: 'color:#c0392b', onclick: (e) => { e.stopPropagation(); deleteSupplier(s); } }, '🗑')
            : ''),
        ])
      )),
    ]));
  }


  async function deleteSupplier(s) {
    if (!confirm(`Удалить поставщика «${s.name}»?\n\nМожно удалить только если у него нет заявок и оплат. Отменить нельзя.`)) return;
    try {
      await api('/suppliers/' + s.id, { method: 'DELETE' });
      toast('Поставщик удалён');
      FOPTS = null;
      loadSuppliers();
    } catch (e) { toast(e.message, true); }
  }

  // импорт поставщиков (файл 4 / TOTAL) — мастер с предпросмотром, не выходя из закупа
  async function importSuppliers(file) {
    const fd = new FormData();
    fd.append('file', file);
    let preview;
    try {
      const res = await fetch('/api/refs/counterparties/import/preview', { method: 'POST', body: fd });
      preview = await res.json();
      if (!res.ok) throw new Error(preview.error || 'Ошибка чтения файла');
    } catch (e) { return toast(e.message, true); }

    const counts = { create: 0, update: 0, skip: 0 };
    for (const r of preview.rows) counts[r.action]++;
    const table = el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['', 'Имя', 'ИНН', 'Примечание'].map((h) => el('th', {}, h)))),
      el('tbody', {}, preview.rows.map((r) =>
        el('tr', { class: r.error ? 'imp-err' : r.action === 'update' ? 'imp-upd' : '' }, [
          el('td', {}, r.error ? '✖' : r.action === 'update' ? '↻' : '+'),
          el('td', {}, r.values.name || ''),
          el('td', { class: 'tnum' }, r.values.inn || ''),
          el('td', { class: 'muted' }, r.error || r.note || (r.values.opening_balance != null ? 'долг: ' + fmtMoney(r.values.opening_balance) : '')),
        ])
      )),
    ]);
    const body = el('div', {}, [
      el('p', { class: 'muted' }, `Лист «${preview.sheet}»: новых ${counts.create} · обновится ${counts.update} · пропустится ${counts.skip}. В базу ничего не запишется, пока вы не подтвердите.`),
      el('div', { class: 'oe-table-wrap' }, [table]),
    ]);
    const m = modal('📥 Предпросмотр импорта поставщиков', body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            const res = await fetch('/api/refs/counterparties/import/commit', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rows: preview.rows }),
            });
            const r = await res.json();
            if (!res.ok) throw new Error(r.error || 'Ошибка импорта');
            toast(`Импорт: создано ${r.created}, обновлено ${r.updated}, пропущено ${r.skipped}`);
            m.close();
            loadSuppliers();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        },
      }, `Загрузить ${counts.create + counts.update} строк`),
    ]);
  }

  // Импорт стартовых остатков (долгов): сопоставляем строки файла с существующими
  // поставщиками и проставляем opening_balance. Не создаёт новых — только обновляет.
  async function importSupplierBalances(file) {
    const fd = new FormData();
    fd.append('file', file);
    let preview;
    try {
      const res = await fetch('/purchase/api/suppliers/opening-import-preview', { method: 'POST', body: fd });
      preview = await res.json();
      if (!res.ok) throw new Error(preview.error || 'Ошибка чтения файла');
    } catch (e) { return toast(e.message, true); }

    const items = preview.items || [];
    const matched = items.filter((r) => r.matched_id);
    const unmatched = items.filter((r) => !r.matched_id);
    const sumMatched = matched.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    const table = el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['', 'Из файла', 'Фирма', 'Поставщик в системе', 'Совпало по', 'Остаток → долг'].map((h, i) =>
        el('th', { style: i === 5 ? 'text-align:right' : '' }, h)))),
      el('tbody', {}, items.map((r) =>
        el('tr', { class: r.matched_id ? '' : 'imp-err' }, [
          el('td', {}, r.matched_id ? '↻' : '✖'),
          el('td', { style: 'font-weight:600' }, r.name || ''),
          el('td', { class: 'muted' }, r.legal || ''),
          el('td', {}, r.matched_id ? r.matched_name : el('span', { class: 'muted' }, 'не найден')),
          el('td', { class: 'muted' }, r.match_by || '—'),
          el('td', { class: 'tnum', style: 'text-align:right;font-weight:700' }, fmtMoney(r.amount)),
        ])
      )),
    ]);
    const body = el('div', {}, [
      el('p', { class: 'muted' }, `Совпало с поставщиками: ${matched.length} · не найдено: ${unmatched.length}. Сумма к проставлению: ${fmtMoney(sumMatched)}. Обновятся только найденные (стартовый долг). В базу ничего не пишется, пока не подтвердите.`),
      unmatched.length ? el('p', { style: 'color:var(--red)' }, '⚠ Не найденные строки будут пропущены — их можно завести вручную или поправить имя в файле и загрузить снова.') : null,
      el('div', { class: 'oe-table-wrap' }, [table]),
    ]);
    const m = modal('💰 Предпросмотр импорта остатков', body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          if (!matched.length) return toast('Нет ни одного совпадения — нечего проставлять', true);
          if (!confirm(`Проставить стартовый долг ${matched.length} поставщикам на сумму ${fmtMoney(sumMatched)}?\n\nЭто перезапишет их текущий «Стартовый долг».`)) return;
          ev.target.disabled = true;
          try {
            const fd2 = new FormData();
            fd2.append('file', file);
            const res = await fetch('/purchase/api/suppliers/opening-import-commit', { method: 'POST', body: fd2 });
            const r = await res.json();
            if (!res.ok) throw new Error(r.error || 'Ошибка импорта');
            toast(`Проставлено: ${r.applied}, пропущено: ${r.skipped}`);
            m.close();
            loadSuppliers();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        },
      }, `Проставить ${matched.length}`),
    ]);
  }

  // Банковские оплаты, которые не привязались ни к одному поставщику: видно всё, что «висит»,
  // и в один клик привязывается. При привязке система запоминает реквизит — дальше автоматом.
  async function openBankUnmatched() {
    const box = el('div', {});
    const info = el('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Загружаю…');
    const search = el('input', { placeholder: '🔍 назначение, плательщик, ИНН…', style: 'width:100%;margin-bottom:8px' });
    const m = modal('🔗 Неразобранные оплаты', el('div', {}, [
      el('p', { class: 'muted', style: 'font-size:13px' },
        'Оплаты поставщикам с банковских счетов (с 07.08.2026) по статьям «Сырьё (зелень)» и «Упаковка», которым не нашёлся поставщик. Комиссии банка, зарплата, налоги и переводы между своими счетами сюда не попадают.'),
      search, info, box,
    ]), [el('button', { onclick: () => m.close() }, 'Закрыть')], { wide: true });
    let suppliers = [];
    try { suppliers = (await api('/suppliers')).items || []; } catch (e) { /* покажем ошибку ниже */ }
    async function load() {
      box.innerHTML = ''; info.textContent = 'Загружаю…';
      let d;
      try { d = await api('/bank-unmatched' + (search.value.trim() ? '?q=' + encodeURIComponent(search.value.trim()) : '')); }
      catch (e) { info.textContent = 'Ошибка: ' + e.message; return; }
      info.textContent = 'Не привязано: ' + d.count + ' оплат на ' + fmtMoney(d.total) + ' сум'
        + (d.count > d.items.length ? ' · показаны первые ' + d.items.length : '');
      if (!d.items.length) { box.appendChild(el('p', { class: 'dict-empty' }, 'Все банковские оплаты привязаны 👍')); return; }
      box.appendChild(el('div', { class: 'oe-table-wrap', style: 'max-height:52vh' }, el('table', { class: 'dict-table' }, [
        // Колонку с кнопкой закрепляем справа — иначе при длинных назначениях она уезжает
        // за край таблицы и до неё не докрутить.
        el('thead', {}, el('tr', {}, ['Дата', 'Сумма', 'Плательщик / ИНН', 'Назначение', 'Статья', ''].map((h, i) =>
          el('th', { style: (i === 1 ? 'text-align:right;' : '') + (i === 5 ? 'position:sticky;right:0;background:#f2f5f1;z-index:2' : '') }, h)))),
        el('tbody', {}, d.items.map((x) => el('tr', {}, [
          el('td', { style: 'white-space:nowrap' }, dt(x.paid_at)),
          el('td', { class: 'tnum', style: 'text-align:right;font-weight:700;white-space:nowrap' }, fmtMoney(x.amount)),
          el('td', { style: 'min-width:170px' }, [
            el('div', {}, x.payer_name || '—'),
            x.payer_inn ? el('div', { class: 'muted', style: 'font-size:12px' }, 'ИНН ' + x.payer_inn) : null,
          ]),
          el('td', { class: 'muted', style: 'font-size:12px' }, x.purpose || ''),
          el('td', { class: 'muted', style: 'font-size:12px;white-space:nowrap' }, x.cat_code ? x.cat_code + ' · ' + x.cat_name : '—'),
          el('td', { style: 'text-align:right;white-space:nowrap;position:sticky;right:0;background:#fff;box-shadow:-6px 0 6px -6px rgba(0,0,0,.18)' },
            el('button', { class: 'btn-primary', style: 'padding:4px 10px;font-size:12px', onclick: () => openBind(x, suppliers, load) }, 'Привязать')),
        ]))),
      ])));
    }
    search.oninput = debounce(load, 350);
    await load();
  }

  const BANK_KEY_LABELS = { inn: 'Доп. ИНН', account: 'Расчётный счёт', name: 'Имя плательщика', keyword: 'Слово в назначении', tx: 'Разовая привязка' };
  // Список реквизитов поставщика внутри его карточки: добавить/удалить.
  async function loadBankKeys(supId, box) {
    box.innerHTML = '';
    let d;
    try { d = await api('/suppliers/' + supId + '/bank-keys'); }
    catch (e) { box.appendChild(el('div', { class: 'muted' }, 'Ошибка: ' + e.message)); return; }
    const items = (d.items || []).filter((k) => k.key_type !== 'tx');
    const txCount = (d.items || []).length - items.length;
    if (!items.length) box.appendChild(el('div', { class: 'muted', style: 'font-size:13px;padding:4px 0' }, 'Пока не задано.'));
    items.forEach((k) => box.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--line)' }, [
      el('span', { class: 'muted', style: 'font-size:12px;min-width:130px' }, BANK_KEY_LABELS[k.key_type] || k.key_type),
      el('span', { style: 'flex:1;font-weight:600' }, k.key_value),
      el('button', { style: 'color:#c0392b;padding:2px 8px', title: 'Удалить', onclick: async () => {
        if (!confirm('Удалить реквизит «' + k.key_value + '»? Оплаты по нему перестанут привязываться автоматически.')) return;
        try { await api('/suppliers/' + supId + '/bank-keys/' + k.id + '/delete', { method: 'POST' }); toast('Удалено'); loadBankKeys(supId, box); }
        catch (e) { toast(e.message, true); }
      } }, '✕'),
    ])));
    if (txCount) box.appendChild(el('div', { class: 'muted', style: 'font-size:12px;padding:4px 0' }, 'Плюс разовых привязок оплат: ' + txCount));
    const typeSel = el('select', { style: 'min-width:150px' },
      [['inn', 'Доп. ИНН'], ['account', 'Расчётный счёт'], ['name', 'Имя плательщика'], ['keyword', 'Слово в назначении']]
        .map(([v, t]) => el('option', { value: v }, t)));
    const valInp = el('input', { placeholder: 'значение', style: 'flex:1' });
    const addBtn = el('button', { onclick: async () => {
      if (!valInp.value.trim()) return toast('Укажите значение', true);
      try {
        await api('/suppliers/' + supId + '/bank-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key_type: typeSel.value, key_value: valInp.value.trim() }) });
        toast('Добавлено'); valInp.value = ''; loadBankKeys(supId, box);
      } catch (e) { toast(e.message, true); }
    } }, '+ Добавить');
    box.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap' }, [typeSel, valInp, addBtn]));
  }

  // Привязка одной оплаты: выбираем поставщика и решаем, что запомнить на будущее.
  function openBind(tx, suppliers, after) {
    const supSel = el('select', {}, [el('option', { value: '' }, '— выберите поставщика —'),
      ...suppliers.map((s) => el('option', { value: s.id }, s.name + (s.legal_name ? ' · ' + s.legal_name : '')))]);
    const opts = [];
    if (tx.payer_inn) opts.push(['inn', 'Запомнить ИНН ' + tx.payer_inn + ' — все оплаты с этим ИНН будут привязываться сами']);
    if (tx.payer_name) opts.push(['name', 'Запомнить плательщика «' + tx.payer_name + '» — по точному совпадению имени']);
    opts.push(['tx', 'Только эту оплату (ничего не запоминать)']);
    let remember = opts[0][0];
    const radios = opts.map(([v, label]) => {
      const r = el('input', { type: 'radio', name: 'bindrem', value: v });
      if (v === remember) r.checked = true;
      r.onchange = () => { remember = v; };
      return el('label', { style: 'display:flex;gap:8px;align-items:flex-start;margin:6px 0;cursor:pointer;font-size:13px' }, [r, el('span', {}, label)]);
    });
    const body = el('div', {}, [
      el('div', { style: 'margin-bottom:10px;padding:8px 10px;background:rgba(140,198,63,.14);border-radius:8px;font-size:13px' },
        dt(tx.paid_at) + ' · ' + fmtMoney(tx.amount) + ' сум' + (tx.purpose ? ' · ' + tx.purpose : '')),
      el('label', {}, ['Поставщик', supSel]),
      el('div', { style: 'margin-top:10px;font-weight:700;font-size:13px' }, 'Что запомнить:'),
      ...radios,
    ]);
    // Модалка в Закупе одна на экран, поэтому «Отмена»/успех возвращают список неразобранных.
    const mm = modal('Привязать оплату к поставщику', body, [
      el('button', { onclick: () => { mm.close(); openBankUnmatched(); } }, 'Отмена'),
      el('button', { class: 'btn-primary', onclick: async () => {
        if (!supSel.value) return toast('Выберите поставщика', true);
        try {
          const r = await api('/bank-unmatched/bind', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tx_id: tx.id, supplier_id: supSel.value, remember }) });
          toast(r.remembered === 'tx' ? 'Оплата привязана' : 'Привязано, реквизит запомнен — дальше автоматически');
          mm.close();
          openBankUnmatched();
          if (currentTab === 'settlements') loadSettlements();
        } catch (e) { toast(e.message, true); }
      } }, 'Привязать'),
    ]);
  }

  async function openSupplierEdit(sup) {
    await ensureOpts();
    const f = {};
    const fields = [
      ['name', 'Имя поставщика *'], ['legal_name', 'Наименование фирмы'], ['phone', 'Телефон'],
      ['inn', 'ИНН'], ['opening_balance', 'Стартовый долг, сум'],
    ];
    const rows = fields.map(([k, label]) => {
      f[k] = el('input', { type: k === 'opening_balance' ? 'number' : 'text', value: sup ? (sup[k] ?? '') : '' });
      return el('label', {}, [label, f[k]]);
    });
    // родительская категория
    const pcSel = el('select', {}, [
      el('option', { value: '' }, '— не указана —'),
      ...FOPTS.parents.map((p) => el('option', { value: p.id }, p.name)),
    ]);
    if (sup && sup.parent_category_id) pcSel.value = sup.parent_category_id;
    f['parent_category_id'] = pcSel;
    rows.push(el('label', {}, ['Родительская категория', pcSel]));
    // статья ДДС (классификатор Кассы) — для автоклассификации расходов по этому поставщику
    const ccList = FOPTS.cashCats || [];
    const ccSel = el('select', {}, [
      el('option', { value: '' }, '— не задана —'),
      ...ccList.map((c) => el('option', { value: c.id }, `${c.code} · ${c.name}`)),
    ]);
    // Если у поставщика сохранена статья, которой нет в списке (архивная/иная группа) —
    // добавляем её опцией из данных карточки, чтобы значение не «терялось».
    if (sup && sup.cash_category_id && !ccList.some((c) => String(c.id) === String(sup.cash_category_id))) {
      ccSel.appendChild(el('option', { value: sup.cash_category_id }, (sup.cash_cat_code ? sup.cash_cat_code + ' · ' : '') + (sup.cash_cat_name || ('статья #' + sup.cash_category_id))));
    }
    if (sup && sup.cash_category_id) ccSel.value = String(sup.cash_category_id);
    f['cash_category_id'] = ccSel;
    // Автоподстановка статьи по родительской категории (только если ещё не задана вручную):
    // «Свежая зелень» → 10 «Сырьё (зелень)», «Упаковка» → 11 «Упаковка».
    const suggestCcByParent = () => {
      if (ccSel.value) return; // не перетираем выбранное
      const pOpt = pcSel.options[pcSel.selectedIndex];
      const pName = (pOpt ? pOpt.textContent : '').toLowerCase();
      let code = null;
      if (/зелен|сырь/.test(pName)) code = '10';
      else if (/упаков/.test(pName)) code = '11';
      if (code) { const c = ccList.find((x) => String(x.code) === code); if (c) ccSel.value = String(c.id); }
    };
    pcSel.addEventListener('change', suggestCcByParent);
    if (!(sup && sup.cash_category_id)) suggestCcByParent();
    // Условия оплаты по умолчанию — подставляются в новую заявку после выбора поставщика.
    const dPay = el('select', {}, [el('option', { value: '' }, '— не задан —'), el('option', { value: 'перечисление' }, '🏦 Перечисление'), el('option', { value: 'наличка' }, '💵 Наличка')]);
    if (sup && sup.def_payment_type) dPay.value = sup.def_payment_type;
    f['def_payment_type'] = dPay;
    const dCond = el('select', {}, [el('option', { value: '' }, '— не задано —'), el('option', { value: 'prepay' }, 'Предоплата'), el('option', { value: 'on_fact' }, 'По факту'), el('option', { value: 'defer' }, 'Отсрочка')]);
    if (sup && sup.def_pay_condition) dCond.value = sup.def_pay_condition;
    f['def_pay_condition'] = dCond;
    const dDefer = el('input', { type: 'number', min: '0', step: '1', placeholder: 'дней', value: sup && sup.def_defer_days ? sup.def_defer_days : '' });
    f['def_defer_days'] = dDefer;
    rows.push(el('div', { class: 'form-row', style: 'gap:8px' }, [
      el('label', { style: 'flex:1 1 130px' }, ['Оплата по умолч.', dPay]),
      el('label', { style: 'flex:1 1 130px' }, ['Условие по умолч.', dCond]),
      el('label', { style: 'flex:1 1 90px' }, ['Отсрочка, дн.', dDefer]),
    ]));
    rows.push(el('label', {}, [
      'Статья ДДС (Касса)',
      ccSel,
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:2px' },
        ccList.length ? 'Расходы этому поставщику в Кассе будут авто-классифицироваться по этой статье.' : 'Откройте плитку «Касса» хотя бы раз, чтобы появились статьи ДДС.'),
    ]));
    const body = el('div', { class: 'form-col', style: 'max-width:100%' }, rows);
    // Реквизиты для авто-привязки банковских оплат — только у сохранённого поставщика (нужен id).
    if (sup && sup.id) {
      body.appendChild(el('div', { style: 'margin-top:14px;font-weight:800;border-top:1px solid var(--line);padding-top:10px' }, 'Реквизиты для авто-привязки оплат'));
      body.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px' },
        'Основной ИНН из поля выше работает всегда. Здесь — дополнительные: другой ИНН, расчётный счёт, имя плательщика или слово из назначения (для оплат на карту).'));
      const keysBox = el('div');
      body.appendChild(keysBox);
      loadBankKeys(sup.id, keysBox);
    }
    const m = modal(sup ? '✏️ ' + sup.name : '+ Новый поставщик', body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          ev.target.disabled = true;
          const payload = {};
          for (const k of Object.keys(f)) payload[k] = f[k].value;
          try {
            let createdId = null;
            if (sup) {
              await api('/suppliers/' + sup.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            } else {
              const r = await api('/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
              createdId = r.id;
            }
            toast('Сохранено');
            FOPTS = null; // обновить кэш опций фильтров
            m.close();
            loadSuppliers();
            if (currentTab === 'settlements') loadSettlements();
            if (createdId) {
              // сразу предлагаем прикрепить номенклатуру нового поставщика
              openAttach({ id: createdId, name: payload.name });
            }
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        },
      }, 'Сохранить'),
    ]);
  }


  // прикрепление товаров к поставщику
  async function openAttach(sup) {
    const mats = (await api('/materials?supplier_id=' + sup.id)).items;
    const checked = new Set(mats.filter((m) => m.attached).map((m) => m.kind + ':' + m.id));
    const search = el('input', { placeholder: 'Поиск...', oninput: debounce(render, 200) });
    const wrap = el('div', { class: 'oe-table-wrap' });
    function render() {
      const q = search.value.trim().toLowerCase();
      wrap.innerHTML = '';
      const rows = mats
        .filter((m) => !q || m.name.toLowerCase().includes(q) || String(m.code || '').toLowerCase().includes(q))
        .map((m) => {
          const key = m.kind + ':' + m.id;
          const cb = el('input', {
            type: 'checkbox',
            onchange: (e) => { if (e.target.checked) checked.add(key); else checked.delete(key); },
          });
          cb.checked = checked.has(key);
          return el('tr', {}, [
            el('td', { style: 'width:34px' }, cb),
            el('td', { class: 'tnum' }, m.code || ''),
            el('td', { style: 'font-weight:600' }, m.name + (m.kind === 'packaging' ? ' 📦' : '')),
            el('td', {}, m.unit || ''),
          ]);
        });
      wrap.appendChild(el('table', { class: 'dict-table' }, [el('tbody', {}, rows)]));
    }
    render();
    const body = el('div', {}, [
      el('p', { class: 'muted' }, 'Отметьте номенклатуру, которую возит этот поставщик — она будет выпадать в заявке первой. При приёмках список пополняется автоматически.'),
      el('div', { class: 'form-row', style: 'margin-bottom:10px' }, [search]),
      wrap,
    ]);
    const m = modal('📎 Товары поставщика — ' + sup.name, body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            await api('/suppliers/' + sup.id + '/materials', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ items: [...checked].map((k) => { const [kind, id] = k.split(':'); return { item_kind: kind, item_id: id }; }) }),
            });
            toast('Привязка сохранена (' + checked.size + ')');
            m.close();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        },
      }, 'Сохранить'),
    ]);
  }

  // ================= ВЗАИМОРАСЧЁТЫ =================
  // --- Период: готовые интервалы + «Выбрать дату» ---
  const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  // Дату собираем из локальных частей (не через toISOString) — иначе Ташкент даёт минус день.
  function isoDate(y, m, d) { return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
  function dayShift(n) { const t = new Date(); const x = new Date(t.getFullYear(), t.getMonth(), t.getDate() - n); return isoDate(x.getFullYear(), x.getMonth(), x.getDate()); }
  function todayStr() { return dayShift(0); }
  function monthStartStr() { const t = new Date(); return isoDate(t.getFullYear(), t.getMonth(), 1); }
  function rangePresets() {
    const t = new Date();
    const prevEnd = new Date(t.getFullYear(), t.getMonth(), 0); // последний день прошлого месяца
    return [
      ['Сегодня', dayShift(0), dayShift(0)],
      ['Вчера', dayShift(1), dayShift(1)],
      ['Последние 7 дней', dayShift(6), dayShift(0)],
      ['Последние 30 дней', dayShift(29), dayShift(0)],
      ['Этот месяц', monthStartStr(), dayShift(0)],
      ['Прошлый месяц', isoDate(prevEnd.getFullYear(), prevEnd.getMonth(), 1), isoDate(prevEnd.getFullYear(), prevEnd.getMonth(), prevEnd.getDate())],
      ['Этот год', isoDate(t.getFullYear(), 0, 1), dayShift(0)],
      ['Всё время', '', ''],
    ];
  }
  function rangeLabel(from, to) {
    const hit = rangePresets().find((p) => p[1] === (from || '') && p[2] === (to || ''));
    if (hit) return hit[0];
    const short = (s) => { if (!s) return '…'; const p = s.split('-'); return Number(p[2]) + ' ' + MON_SHORT[Number(p[1]) - 1]; };
    return short(from) + ' – ' + short(to);
  }
  // Кнопка с выпадающим списком периодов. onChange вызывается после выбора.
  function periodPicker(state, onChange) {
    const btn = el('button', { class: 'pur-tbtn pur-range-btn' }, '🗓 ' + rangeLabel(state.from, state.to));
    const pop = el('div', { class: 'pur-range-pop' });
    const wrap = el('div', { class: 'pur-range' }, [btn, pop]);
    let open = false;
    const outside = (e) => { if (!wrap.contains(e.target)) toggle(false); };
    function toggle(v) {
      open = v === undefined ? !open : v;
      pop.classList.toggle('open', open);
      if (open) document.addEventListener('click', outside);
      else document.removeEventListener('click', outside);
    }
    function apply(from, to) {
      state.from = from; state.to = to;
      btn.textContent = '🗓 ' + rangeLabel(from, to);
      toggle(false);
      onChange();
    }
    btn.onclick = (e) => { e.stopPropagation(); toggle(); };
    rangePresets().forEach(([label, f, t2]) => {
      const on = (state.from || '') === f && (state.to || '') === t2;
      pop.appendChild(el('div', { class: 'pur-range-it' + (on ? ' on' : ''), onclick: () => apply(f, t2) }, label));
    });
    // «Выбрать дату» — раскрывает ручной интервал.
    const custom = el('div', { class: 'pur-range-custom' });
    const fIn = el('input', { type: 'date', value: state.from || '' });
    const tIn = el('input', { type: 'date', value: state.to || '' });
    custom.appendChild(el('div', { class: 'pur-range-row' }, [el('span', {}, 'с'), fIn]));
    custom.appendChild(el('div', { class: 'pur-range-row' }, [el('span', {}, 'по'), tIn]));
    custom.appendChild(el('div', { class: 'pur-range-row' }, [
      el('button', { class: 'btn-primary', onclick: () => { if (fIn.value || tIn.value) apply(fIn.value, tIn.value); } }, 'ОК'),
      el('button', { class: 'btn-ghost', onclick: () => toggle(false) }, 'Отменить'),
    ]));
    const custHead = el('div', { class: 'pur-range-it pur-range-more', onclick: () => custom.classList.toggle('open') }, 'Выбрать дату');
    pop.appendChild(custHead);
    pop.appendChild(custom);
    return wrap;
  }

  // Период по умолчанию — с начала месяца по сегодня (движение за текущий месяц).
  const setState = { q: '', pc: '', status: '', from: monthStartStr(), to: todayStr() };
  let setHidden = []; try { setHidden = JSON.parse(localStorage.getItem('pur_set_cols') || '[]'); } catch (e) { setHidden = []; }

  function settlementCols(period) {
    const c = [
      { id: 'name', label: 'Поставщик', get: (s) => s.name, txt: 1, lock: 1 },
      { id: 'inn', label: 'ИНН', get: (s) => s.inn || '—', txt: 1 },
      { id: 'category', label: 'Категория', get: (s) => s.parent_category_name || '—', txt: 1 },
    ];
    if (period) c.push(
      { id: 'balance_start', label: 'Баланс на начало', get: (s) => s.balance_start, num: 1 },
      { id: 'delivered_period', label: 'Поставлено (период)', get: (s) => s.delivered_period, num: 1 },
      { id: 'paid_period', label: 'Оплачено (период)', get: (s) => s.paid_period, num: 1 },
      { id: 'balance_end', label: 'Баланс на конец', get: (s) => s.balance_end, num: 1, bal: 1 });
    else c.push(
      { id: 'opening', label: 'Стартовый долг', get: (s) => s.opening_balance, num: 1 },
      { id: 'delivered', label: 'Поставлено', get: (s) => s.delivered, num: 1 },
      { id: 'paid', label: 'Оплачено', get: (s) => s.paid, num: 1 },
      { id: 'balance', label: 'Сальдо', get: (s) => s.balance, num: 1, bal: 1 });
    c.push(
      { id: 'overdue', label: 'Просрочено', get: (s) => s.overdue || 0, num: 1, warn: 1 },
      { id: 'nearest_due', label: 'Ближайший срок', get: (s) => (s.nearest_due ? dt(s.nearest_due) : '—'), txt: 1 });
    return c;
  }

  async function viewSettlements() {
    const main = $('#pur-main');
    main.innerHTML = '';
    main.appendChild(el('div', { class: 'pur-toolbar' }, [
      el('h2', {}, 'Взаиморасчёты'),
      el('div', { class: 'pur-toolbar-right' }, [
        el('button', { class: 'pur-tbtn', onclick: openColsMenu, title: 'Показать/скрыть столбцы' }, '⚙ Столбцы'),
        el('button', { class: 'pur-tbtn', onclick: openBankUnmatched, title: 'Банковские оплаты, не привязанные к поставщику' }, '🔗 Неразобранные оплаты'),
        el('a', { class: 'pur-tbtn', href: '#', onclick: (e) => { e.preventDefault(); exportSettlements(); } }, '⬇ Excel'),
        el('button', { class: 'btn-primary', onclick: () => openPayment(null) }, '+ Оплата'),
      ]),
    ]));
    await ensureOpts();
    const pcSel = el('select', { onchange: (e) => { setState.pc = e.target.value; loadSettlements(); } }, [
      el('option', { value: '' }, 'Все категории'), ...FOPTS.parents.map((p) => el('option', { value: p.id, selected: setState.pc === String(p.id) || null }, p.name)),
    ]);
    const stSel = el('select', { onchange: (e) => { setState.status = e.target.value; loadSettlements(); } },
      [['', 'Все'], ['debt', 'Только с долгом'], ['overdue', 'Только просроченные'], ['advance', 'Только авансы']].map(([v, t]) => el('option', { value: v, selected: setState.status === v || null }, t)));
    const qIn = el('input', { placeholder: 'Поиск поставщика…', value: setState.q, oninput: debounce((e) => { setState.q = e.target.value; loadSettlements(); }, 300) });
    main.appendChild(el('div', { class: 'pur-filters' }, [
      el('label', {}, ['Категория', pcSel]),
      el('label', {}, ['Статус', stSel]),
      // Не <label>: внутри пикера есть поля дат, и клик по пункту списка уводил бы фокус в них.
      el('div', { class: 'pur-fld' }, [el('span', {}, 'Период'), periodPicker(setState, loadSettlements)]),
      el('label', { style: 'flex:1 1 180px' }, ['Поиск', qIn]),
    ]));
    main.appendChild(el('div', { id: 'set-list', class: 'pur-content', style: 'overflow-x:auto' }));
    await loadSettlements();
  }

  // Блок «Подотчёт снабженца» убран из Взаиморасчётов: наличные выдачи ведутся в Кассе,
  // а здесь он только путал (остаток уходил в минус из-за неполных данных).
  // Расчёт pfin.supplyAdvance() и эндпоинт /api/supply-advance оставлены рабочими.

  async function loadSettlements() {
    const p = new URLSearchParams();
    for (const [k, v] of [['q', setState.q], ['parent_category_id', setState.pc], ['status', setState.status], ['from', setState.from], ['to', setState.to]]) if (v) p.set(k, v);
    const data = await api('/settlements' + (p.toString() ? '?' + p.toString() : ''));
    const items = data.items || [];
    const cols = settlementCols(data.period).filter((c) => c.lock || !setHidden.includes(c.id));
    const box = $('#set-list'); box.innerHTML = '';
    const head = el('tr', {}, cols.map((c) => el('th', { style: c.num ? 'text-align:right' : '' }, c.label)));
    const body = items.map((s) => el('tr', { onclick: () => openStatement(s.id), style: 'cursor:pointer' }, cols.map((c) => {
      if (c.num) {
        const v = Number(c.get(s)) || 0;
        const color = c.bal ? (v > 0 ? 'var(--red)' : v < 0 ? '#3f6a16' : '') : (c.warn && v > 0 ? 'var(--red)' : '');
        return el('td', { class: 'tnum', style: 'text-align:right;' + (c.bal ? 'font-weight:800;' : '') + (color ? 'color:' + color : '') }, fmtMoney(v));
      }
      return el('td', { style: c.id === 'name' ? 'font-weight:700' : '' }, c.get(s));
    })));
    // Итоговая строка.
    const foot = el('tr', { style: 'background:#f2f5f1;font-weight:800' }, cols.map((c, i) => {
      if (i === 0) return el('td', {}, 'ИТОГО (' + items.length + ')');
      if (!c.num) return el('td', {}, '');
      const sum = items.reduce((a, s) => a + (Number(c.get(s)) || 0), 0);
      const color = c.bal ? (sum > 0 ? 'var(--red)' : '#3f6a16') : (c.warn && sum > 0 ? 'var(--red)' : '');
      return el('td', { class: 'tnum', style: 'text-align:right;' + (color ? 'color:' + color : '') }, fmtMoney(sum));
    }));
    box.appendChild(el('table', { class: 'dict-table' }, [el('thead', {}, head), el('tbody', {}, [...body, foot])]));
  }

  function openColsMenu() {
    const all = settlementCols(!!(setState.from || setState.to));
    const body = el('div', { class: 'form-col' }, all.filter((c) => !c.lock).map((c) => {
      const cb = el('input', { type: 'checkbox' }); cb.checked = !setHidden.includes(c.id);
      cb.onchange = () => { setHidden = cb.checked ? setHidden.filter((x) => x !== c.id) : [...setHidden, c.id]; localStorage.setItem('pur_set_cols', JSON.stringify(setHidden)); loadSettlements(); };
      return el('label', { class: 'check' }, [cb, ' ' + c.label]);
    }));
    const m = modal('⚙ Столбцы', body, [el('button', { class: 'btn-primary', onclick: () => m.close() }, 'Готово')]);
  }
  function exportSettlements() {
    const cols = settlementCols(!!(setState.from || setState.to)).filter((c) => c.lock || !setHidden.includes(c.id)).map((c) => c.id);
    const p = new URLSearchParams();
    for (const [k, v] of [['q', setState.q], ['parent_category_id', setState.pc], ['status', setState.status], ['from', setState.from], ['to', setState.to]]) if (v) p.set(k, v);
    p.set('cols', cols.join(','));
    window.location = '/purchase/api/settlements-export.xlsx?' + p.toString();
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
          el('summary', {}, [
            `${o.number} · ${dt(o.received_at)} · ${fmtMoney(o.fact_total || o.total)} сум · оплачено ${fmtMoney(o.paid)} · `,
            el('b', { style: 'color:' + (o.remainder > 0 ? '#c0392b' : '#3f6a16') }, o.remainder > 0 ? 'остаток ' + fmtMoney(o.remainder) : 'закрыто'),
            ' · ', payStatusPill(o.pay_status),
            o.due_date ? el('span', { class: 'muted' }, ' · срок ' + dt(o.due_date)) : null,
            o.remainder > 0 ? el('a', { href: 'javascript:void(0)', style: 'margin-left:8px;font-weight:700', onclick: (e) => { e.preventDefault(); m.close(); openPayment(s, o.id); } }, '💳 оплатить') : null,
          ]),
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
            el('td', { class: 'muted' }, (p.comment || '') + (p.currency === 'USD' && Number(p.fx_amount) > 0 ? ' · $' + fmtMoney(p.fx_amount) + ' @ ' + fmtMoney(p.fx_rate) : '')),
            el('td', { class: 'tnum', style: 'text-align:right;font-weight:700;color:#3f6a16' }, fmtMoney(p.amount)),
            // Удалить можно только ручную оплату (не из выписки) — админ или роль «Правка заявок».
            el('td', { style: 'text-align:right;width:1%' },
              (!p.from_statement && (HUB_USER.isAdmin || HUB_USER.buyerEdit))
                ? el('a', { href: 'javascript:void(0)', title: 'Удалить оплату', style: 'color:#c0392b;font-weight:700;text-decoration:none', onclick: async (e) => {
                    e.preventDefault();
                    if (!confirm('Удалить оплату ' + fmtMoney(p.amount) + ' сум (' + p.payment_type + ') от ' + dt(p.paid_at) + '?')) return;
                    try { await api('/payments/' + p.id + '/delete', { method: 'POST' }); m.close(); openStatement(id); } catch (err) { alert(err.message); }
                  } }, '✕')
                : ''),
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
      el('button', { onclick: () => { m.close(); openAttach(s); } }, '📎 Товары поставщика'),
      el('button', { onclick: () => { m.close(); openOrderEditor(null, s.id); } }, '🧾 Новая заявка'),
      el('button', { class: 'btn-primary', onclick: () => { m.close(); openPayment(s); } }, '+ Оплата'),
      el('button', { onclick: () => m.close() }, 'Закрыть'),
    ]);
  }


  async function openPayment(presetSupplier, presetOrderId) {
    const suppliers = (await api('/suppliers')).items;
    const supSel = el('select', {}, suppliers.map((s) => el('option', { value: s.id }, s.name + ' (сальдо: ' + fmtMoney(s.balance) + ')')));
    if (presetSupplier) supSel.value = presetSupplier.id;
    const amount = el('input', { type: 'number', step: 'any', min: '0', placeholder: '0' });
    const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const comment = el('input', { placeholder: 'Комментарий (необязательно)' });
    // Режим разнесения оплаты: по заявке / общая по долгам (FIFO) / аванс.
    const modeSel = el('select', {}, [
      el('option', { value: 'order' }, '🎯 По конкретной заявке'),
      el('option', { value: 'fifo' }, '🧮 Общая — авторазнос по долгам (старые/просрочка первыми)'),
      el('option', { value: 'advance' }, '💰 Аванс поставщику (без заявки)'),
    ]);
    const orderSel = el('select', {}, []);
    const orderRow = el('label', {}, ['Заявка', orderSel]);
    let openOrders = [];
    // Валюта оплаты: сум (по умолчанию) или доллары. При USD сумма в сумах = $ × курс (ЦБ или вручную).
    const curSel = el('select', {}, [el('option', { value: 'UZS' }, 'сум'), el('option', { value: 'USD' }, 'доллары ($)')]);
    const usdInp = el('input', { type: 'number', step: 'any', min: '0', placeholder: 'сумма в $' });
    const rateInp = el('input', { type: 'number', step: 'any', min: '0', placeholder: 'курс сум/$' });
    const usdRow = el('label', {}, ['Сумма, $', usdInp]);
    const rateRow = el('label', {}, ['Курс сум/$', rateInp]);
    const eqNote = el('div', { class: 'muted', style: 'font-size:12px' }, '');
    const isUsd = () => curSel.value === 'USD';
    function recalcUsd() {
      const u = Number(usdInp.value) || 0, r = Number(rateInp.value) || 0;
      eqNote.textContent = (u > 0 && r > 0) ? ('= ' + fmtMoney(Math.round(u * r)) + ' сум по курсу ' + r) : '';
      if (u > 0 && r > 0) amount.value = Math.round(u * r);
    }
    async function applyCur() {
      const usd = isUsd();
      usdRow.style.display = rateRow.style.display = eqNote.style.display = usd ? '' : 'none';
      amount.readOnly = usd;
      if (usd) { if (!rateInp.value) { try { const fr = await api('/fx-rate'); if (fr && fr.rate) rateInp.value = fr.rate; } catch (e) { /* курс введут вручную */ } } recalcUsd(); }
      else syncAmount();
    }
    // Сумма к оплате по заявке = её остаток по факту (кол-во приёмки × цена заявки − уже оплачено). Только для сум.
    function syncAmount() {
      if (isUsd() || modeSel.value !== 'order') return;
      const o = openOrders.find((x) => String(x.id) === String(orderSel.value));
      if (o) amount.value = Math.max(0, Math.round(Number(o.remainder) || 0));
    }
    curSel.onchange = applyCur; usdInp.oninput = recalcUsd; rateInp.oninput = recalcUsd;
    async function loadOpenOrders() {
      orderSel.innerHTML = '';
      if (!supSel.value) { openOrders = []; return; }
      const { items } = await api('/suppliers/' + supSel.value + '/open-orders');
      openOrders = items || [];
      if (!openOrders.length) { orderSel.appendChild(el('option', { value: '' }, '— нет открытых заявок —')); return; }
      openOrders.forEach((o) => orderSel.appendChild(el('option', { value: o.id }, `${o.number} · остаток ${fmtMoney(o.remainder)} · срок ${o.due_date ? dt(o.due_date) : '—'} · ${o.pay_status}`)));
      if (presetOrderId) orderSel.value = presetOrderId;
      syncAmount();
    }
    const toggleMode = () => { orderRow.style.display = modeSel.value === 'order' ? '' : 'none'; syncAmount(); };
    modeSel.addEventListener('change', toggleMode);
    orderSel.addEventListener('change', syncAmount);
    supSel.addEventListener('change', loadOpenOrders);
    const body = el('div', { class: 'form-col', style: 'max-width:100%' }, [
      el('label', {}, ['Поставщик', supSel]),
      el('label', {}, ['Как разнести', modeSel]),
      orderRow,
      el('label', {}, ['Валюта', curSel]),
      usdRow, rateRow,
      el('label', {}, ['Сумма, сум *', amount]),
      eqNote,
      el('label', {}, ['Дата', date]),
      el('label', {}, ['Комментарий', comment]),
      el('div', { class: 'muted', style: 'font-size:12px' }, 'Сумма подставляется по факту (кол-во приёмки × цена заявки − оплачено), можно изменить. Валюта: сум или $ (по курсу — сам подставит ЦБ, можно ввести вручную). Оплата — наличными; перечисления подтягиваются из выписки банка.'),
    ]);
    if (presetOrderId) modeSel.value = 'order';
    toggleMode();
    await loadOpenOrders();
    applyCur();
    const m = modal('💳 Внести оплату поставщику', body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          if (isUsd() && !(Number(usdInp.value) > 0 && Number(rateInp.value) > 0)) return toast('Укажите сумму в $ и курс', true);
          if (!(Number(amount.value) > 0)) return toast('Укажите сумму больше нуля', true);
          if (modeSel.value === 'order' && !orderSel.value) return toast('Выберите заявку (или смените режим на «общая»/«аванс»)', true);
          ev.target.disabled = true;
          const payload = { supplier_id: supSel.value, amount: amount.value, payment_type: 'наличка', paid_at: date.value, comment: comment.value, currency: curSel.value, fx_rate: isUsd() ? rateInp.value : '', fx_amount: isUsd() ? usdInp.value : '' };
          if (modeSel.value === 'order') payload.order_id = orderSel.value;
          else if (modeSel.value === 'fifo') payload.distribute = 'fifo';
          try {
            await api('/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            toast('Оплата записана ✅');
            m.close();
            if (currentTab === 'settlements') loadSettlements(); else loadSuppliers();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        },
      }, 'Записать оплату'),
    ]);
  }


  // ================= ДИНАМИКА ЦЕН =================
  async function viewPrices() {
    const main = $('#pur-main');
    main.innerHTML = '';
    const opts = await api('/filter-options');
    main.appendChild(el('div', { class: 'pur-toolbar' }, [
      el('h2', {}, 'Динамика цен закупа'),
      el('div', { class: 'pur-toolbar-right' }, [
        el('input', { id: 'pr-q', placeholder: 'Поиск по товару...', oninput: debounce(reloadPrices, 300) }),
        el('button', { id: 'pr-last-btn', class: 'btn-primary', title: 'Актуальный прайс: последняя цена по каждому товару',
          onclick: () => { priceMode = 'last'; const b = $('#pr-mode-btn'); if (b) b.textContent = '📊 Матрица цен'; reloadPrices(); } }, '💰 Последние цены'),
        el('button', { id: 'pr-mode-btn', onclick: togglePriceMode }, '📊 Матрица цен'),
        (window.HUB_USER && window.HUB_USER.isAdmin)
          ? el('button', { onclick: () => $('#pr-import-file').click(), title: 'Импорт истории закупочных цен из Excel' }, '📥 Импорт истории')
          : null,
        (window.HUB_USER && window.HUB_USER.isAdmin)
          ? (() => { const f = el('input', { id: 'pr-import-file', type: 'file', accept: '.xlsx,.xls', style: 'display:none', onchange: (e) => { if (e.target.files[0]) importPriceHistory(e.target.files[0]); e.target.value = ''; } }); return f; })()
          : null,
      ]),
    ]));
    const supSel = el('select', { id: 'pr-supplier', onchange: reloadPrices }, [
      el('option', { value: '' }, 'Все поставщики'),
      ...opts.suppliers.map((s) => el('option', { value: s.id }, s.name)),
    ]);
    const catSel = el('select', { id: 'pr-category', onchange: reloadPrices }, [
      el('option', { value: '' }, 'Все категории'),
      ...opts.categories.map((c) => el('option', { value: c.id }, (c.branch === 'Упаковка' ? '📦 ' : '🌿 ') + c.name)),
    ]);
    const fromIn = el('input', { id: 'pr-from', type: 'date', onchange: reloadPrices });
    const toIn = el('input', { id: 'pr-to', type: 'date', onchange: reloadPrices });
    const resetBtn = el('button', {
      onclick: () => { supSel.value = ''; catSel.value = ''; fromIn.value = ''; toIn.value = ''; $('#pr-q').value = ''; reloadPrices(); },
    }, 'Сбросить');
    main.appendChild(el('div', { class: 'pur-filters' }, [
      el('label', {}, ['Поставщик', supSel]),
      el('label', {}, ['Категория', catSel]),
      el('label', {}, ['Период с', fromIn]),
      el('label', {}, ['по', toIn]),
      resetBtn,
    ]));
    main.appendChild(el('div', { id: 'pr-list', class: 'pur-content' }));
    await reloadPrices();
  }

  function trendArrow(last, prev) {
    if (prev == null || last == null) return el('span', {}, '');
    const l = Number(last); const p = Number(prev);
    if (l > p) return el('span', { style: 'color:var(--red);font-weight:800', title: 'дороже прошлой закупки' }, '↑');
    if (l < p) return el('span', { style: 'color:#3f6a16;font-weight:800', title: 'дешевле прошлой закупки' }, '↓');
    return el('span', { class: 'muted' }, '＝');
  }

  let priceMode = 'summary'; // summary | matrix
  function togglePriceMode() {
    priceMode = priceMode === 'summary' ? 'matrix' : 'summary';
    const btn = $('#pr-mode-btn');
    if (btn) btn.textContent = priceMode === 'summary' ? '📊 Матрица цен' : '📋 Сводка';
    reloadPrices();
  }
  function reloadPrices() {
    if (priceMode === 'last') loadLastPrices();
    else if (priceMode === 'matrix') loadPriceMatrix();
    else loadPriceList();
  }

  // Бейдж вердикта по цене относительно последних 12 месяцев.
  const VERDICT_STYLE = {
    best: 'background:#e8f5e9;color:#2e7d32', good: 'background:#f1f8e9;color:#3f6a16',
    high: 'background:#fff3e0;color:#b25b00', worst: 'background:#fdecea;color:#c0392b',
    single: 'background:#f1f4ee;color:#7c8579', none: 'background:#f1f4ee;color:#7c8579',
  };
  const verdictBadge = (it) => el('span', {
    style: 'font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;white-space:nowrap;' + (VERDICT_STYLE[it.verdict] || VERDICT_STYLE.none),
    title: it.y_buys ? `За год: мин ${fmtMoney(it.y_min)} · сред ${fmtMoney(it.y_avg)} · макс ${fmtMoney(it.y_max)} (закупок: ${it.y_buys})` : 'Нет закупок за последние 12 месяцев',
  }, (it.verdict === 'best' ? '🟢 ' : it.verdict === 'worst' ? '🔴 ' : '') + it.verdict_text);

  // «Последние цены» — актуальный прайс: последняя цена по каждому товару + дата обновления.
  async function loadLastPrices() {
    const p = new URLSearchParams();
    if ($('#pr-q') && $('#pr-q').value.trim()) p.set('q', $('#pr-q').value.trim());
    const data = await api('/last-prices' + (p.toString() ? '?' + p.toString() : ''));
    const box = $('#pr-list');
    box.innerHTML = '';
    if (!data.items.length) {
      box.appendChild(el('p', { class: 'dict-empty' }, 'Пока нет ни одной принятой закупки — цен нет.'));
      return;
    }
    box.appendChild(el('p', { class: 'muted', style: 'margin:0 0 10px' },
      'Актуальный прайс: последняя цена по каждому товару. Клик по строке — история цен и оценка: лучшая цена за год или самая высокая.'));
    box.appendChild(el('table', { class: 'dict-table pur-lastprice' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Наименование'), el('th', {}, 'Ед.изм'),
        el('th', { style: 'text-align:right' }, 'Цена за ед-цу'),
        el('th', {}, 'Последнее обновление цен'), el('th', {}, 'Оценка за год'),
      ])),
      el('tbody', {}, data.items.map((it) => el('tr', { style: 'cursor:pointer', title: 'Открыть историю цен', onclick: () => openPriceHistory(it) }, [
        el('td', { style: 'font-weight:700' }, it.name + (it.kind === 'packaging' ? ' 📦' : '')),
        el('td', {}, it.unit || ''),
        el('td', { class: 'tnum', style: 'text-align:right;font-weight:800' }, fmtMoney(it.last_price)),
        el('td', { class: 'muted' }, it.last_at ? dt(it.last_at) : '—'),
        el('td', {}, verdictBadge(it)),
      ]))),
    ]));
  }

  async function loadPriceMatrix() {
    const p = new URLSearchParams();
    if ($('#pr-q') && $('#pr-q').value.trim()) p.set('q', $('#pr-q').value.trim());
    if ($('#pr-category') && $('#pr-category').value) p.set('category_id', $('#pr-category').value);
    const data = await api('/price-matrix' + (p.toString() ? '?' + p.toString() : ''));
    const box = $('#pr-list');
    box.innerHTML = '';
    if (!data.items.length) {
      box.appendChild(el('p', { class: 'dict-empty' }, 'Нет данных. Загрузите историю цен кнопкой «📥 Импорт истории» или дождитесь приёмок.'));
      return;
    }
    const fmtD = (s) => { const d = new Date(s); return String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0') + '.' + String(d.getFullYear()).slice(2); };
    const headCells = [el('th', { class: 'pm-sticky' }, 'Артикул'), el('th', { class: 'pm-sticky2' }, 'Наименование')];
    for (const d of data.dates) headCells.push(el('th', { style: 'text-align:right;white-space:nowrap' }, fmtD(d)));
    const bodyRows = data.items.map((it) => {
      const cells = [
        el('td', { class: 'tnum pm-sticky', title: it.characteristics || '' }, it.code || ''),
        el('td', { class: 'pm-sticky2', style: 'font-weight:600;cursor:pointer', title: it.characteristics || 'нажмите — график цен', onclick: () => openPriceHistory(it) }, it.name + (it.kind === 'packaging' ? ' 📦' : '')),
      ];
      let prev = null;
      for (const d of data.dates) {
        const v = it.prices[d];
        if (v == null) { cells.push(el('td', { class: 'muted', style: 'text-align:right' }, '·')); continue; }
        let cls = 'tnum'; let color = '';
        if (prev != null) { if (v > prev) color = 'color:var(--red)'; else if (v < prev) color = 'color:#3f6a16'; }
        prev = v;
        cells.push(el('td', { class: cls, style: 'text-align:right;' + color }, fmtMoney(v)));
      }
      return el('tr', {}, cells);
    });
    const table = el('table', { class: 'dict-table pm-table' }, [
      el('thead', {}, el('tr', {}, headCells)),
      el('tbody', {}, bodyRows),
    ]);
    box.appendChild(el('p', { class: 'muted', style: 'margin:0 0 8px' }, 'Цены по датам (как в Excel). Зелёным — дешевле предыдущей, красным — дороже. Клик по названию — график. Наведите на артикул — характеристика.'));
    box.appendChild(el('div', { class: 'pm-scroll' }, [table]));
  }

  async function loadPriceList() {
    const p = new URLSearchParams();
    const q = $('#pr-q') ? $('#pr-q').value.trim() : '';
    if (q) p.set('q', q);
    if ($('#pr-supplier') && $('#pr-supplier').value) p.set('supplier_id', $('#pr-supplier').value);
    if ($('#pr-category') && $('#pr-category').value) p.set('category_id', $('#pr-category').value);
    if ($('#pr-from') && $('#pr-from').value) p.set('from', $('#pr-from').value);
    if ($('#pr-to') && $('#pr-to').value) p.set('to', $('#pr-to').value);
    const data = await api('/price-list' + (p.toString() ? '?' + p.toString() : ''));
    const box = $('#pr-list');
    box.innerHTML = '';
    if (!data.items.length) {
      box.appendChild(el('p', { class: 'dict-empty' }, 'Нет данных по выбранным фильтрам. Сбросьте фильтры или дождитесь принятых поставок.'));
      return;
    }
    box.appendChild(el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Артикул', 'Наименование', 'Последняя', '', 'Мин', 'Макс', 'Средняя', 'Закупок'].map((h, i) =>
        el('th', { style: i >= 2 ? 'text-align:right' : '' }, h)))),
      el('tbody', {}, data.items.map((m) =>
        el('tr', { onclick: () => openPriceHistory(m) }, [
          el('td', { class: 'tnum', title: m.characteristics || '' }, m.code || ''),
          el('td', { style: 'font-weight:700', title: m.characteristics || '' }, m.name + (m.kind === 'packaging' ? ' 📦' : '')),
          el('td', { class: 'tnum', style: 'text-align:right;font-weight:800' }, fmtMoney(m.last_price)),
          el('td', { style: 'text-align:center;width:30px' }, trendArrow(m.last_price, m.prev_price)),
          el('td', { class: 'tnum muted', style: 'text-align:right' }, fmtMoney(m.min_price)),
          el('td', { class: 'tnum muted', style: 'text-align:right' }, fmtMoney(m.max_price)),
          el('td', { class: 'tnum muted', style: 'text-align:right' }, fmtMoney(m.avg_price)),
          el('td', { class: 'tnum muted', style: 'text-align:right' }, String(m.buys)),
        ])
      )),
    ]));
  }


  // импорт истории закупочных цен (вариант А) — с предпросмотром
  async function importPriceHistory(file) {
    const fd = new FormData();
    fd.append('file', file);
    let pv;
    try {
      const res = await fetch('/purchase/api/price-history/import-preview', { method: 'POST', body: fd });
      pv = await res.json();
      if (!res.ok) throw new Error(pv.error || 'Ошибка чтения файла');
    } catch (e) { return toast(e.message, true); }

    const sampleTable = el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Артикул', 'Наименование', 'Статус'].map((h) => el('th', {}, h)))),
      el('tbody', {}, (pv.sample || []).map((r) =>
        el('tr', { class: /не найден/.test(r.status) ? 'imp-err' : '' }, [
          el('td', { class: 'tnum' }, r.code),
          el('td', {}, r.name),
          el('td', { class: 'muted' }, r.status),
        ])
      )),
    ]);
    const body = el('div', {}, [
      el('p', {}, [
        'Найдено столбцов с датами: ', el('b', {}, String(pv.dates)),
        '. Товаров распознано по артикулу: ', el('b', {}, String(pv.matched)),
        pv.unmatched ? ', не найдено: ' + pv.unmatched : '',
        '. Всего точек цен к загрузке: ', el('b', {}, String(pv.points)), '.',
      ]),
      el('p', { class: 'muted' }, 'Это архив цен: он не влияет на долги и взаиморасчёты, только показывается на графике рядом с живыми приёмками. Повторный импорт обновит цены за те же даты, не создавая дублей.'),
      el('div', { class: 'oe-table-wrap', style: 'max-height:34vh' }, [sampleTable]),
    ]);
    const m = modal('📥 Импорт истории цен', body, [
      el('button', { onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (ev) => {
          if (!pv.points) return toast('Нет точек для импорта — проверьте, что артикулы из файла есть в справочнике', true);
          ev.target.disabled = true;
          ev.target.textContent = 'Загружаю...';
          try {
            const fd2 = new FormData();
            fd2.append('file', file);
            const res = await fetch('/purchase/api/price-history/import-commit', { method: 'POST', body: fd2 });
            const r = await res.json();
            if (!res.ok) throw new Error(r.error || 'Ошибка импорта');
            toast('Импортировано точек: ' + r.saved);
            m.close();
            loadPriceList();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; ev.target.textContent = 'Загрузить'; }
        },
      }, `Загрузить ${pv.points} точек`),
    ]);
  }

  // график истории: простая SVG-линия + таблица всех закупок
  async function openPriceHistory(mat) {
    const data = await api('/price-history?kind=' + mat.kind + '&id=' + mat.id);
    const rows = data.items;
    let chart = null;
    if (rows.length >= 2) {
      const W = 820, H = 200, P = 36;
      const prices = rows.map((r) => Number(r.price));
      const times = rows.map((r) => new Date(r.d).getTime());
      const min = Math.min(...prices), max = Math.max(...prices);
      const tMin = Math.min(...times), tMax = Math.max(...times);
      const span = max - min || 1;
      const tSpan = tMax - tMin || 1;
      const x = (t) => P + ((t - tMin) * (W - 2 * P)) / tSpan;
      const y = (v) => H - P - ((v - min) * (H - 2 * P)) / span;
      const pts = rows.map((r) => x(new Date(r.d).getTime()) + ',' + y(Number(r.price))).join(' ');
      const dots = rows.map((r) => {
        const isLive = r.source === 'live';
        const color = isLive ? 'var(--lime-d)' : '#b9b09a';
        const sup = isLive ? (r.supplier_name || '') : 'архив';
        return `<circle cx="${x(new Date(r.d).getTime())}" cy="${y(Number(r.price))}" r="4.5" fill="${color}" stroke="#fff" stroke-width="1.5"><title>${fmtMoney(r.price)} сум · ${dt(r.d)}${sup ? ' · ' + sup : ''}</title></circle>`;
      }).join('');
      chart = el('div', {
        class: 'pur-chart',
        html: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <text x="4" y="${y(max) + 4}" font-size="11" fill="var(--ink-faint)">${fmtMoney(max)}</text>
          <text x="4" y="${y(min) + 4}" font-size="11" fill="var(--ink-faint)">${fmtMoney(min)}</text>
          <text x="${P}" y="${H - 8}" font-size="10" fill="var(--ink-faint)">${dt(rows[0].d)}</text>
          <text x="${W - P - 50}" y="${H - 8}" font-size="10" fill="var(--ink-faint)">${dt(rows[rows.length - 1].d)}</text>
          <polyline points="${pts}" fill="none" stroke="var(--lime-d)" stroke-width="2.5" stroke-linejoin="round"/>
          ${dots}
        </svg>`,
      });
    }
    const legend = el('div', { class: 'pur-legend' }, [
      el('span', {}, [el('i', { class: 'dot-live' }), ' живые приёмки']),
      el('span', {}, [el('i', { class: 'dot-arch' }), ' архив (импорт)']),
    ]);
    const table = el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Дата', 'Источник', 'Поставщик/заявка', 'Кол-во', 'Цена'].map((h, i) =>
        el('th', { style: i >= 3 ? 'text-align:right' : '' }, h)))),
      el('tbody', {}, [...rows].reverse().map((r) =>
        el('tr', {}, [
          el('td', {}, dt(r.d)),
          el('td', {}, r.source === 'live' ? '🟢 приёмка' : '◽ архив'),
          el('td', {}, r.source === 'live' ? (r.supplier_name || '') + (r.number ? ' · ' + r.number : '') : '—'),
          el('td', { class: 'tnum', style: 'text-align:right' }, r.qty != null ? fmt.format(Number(r.qty)) : '—'),
          el('td', { class: 'tnum', style: 'text-align:right;font-weight:700' }, fmtMoney(r.price)),
        ])
      )),
    ]);
    const body = el('div', {}, [
      // Оценка последней цены за 12 месяцев (когда открыли из «Последних цен»).
      mat.verdict_text ? el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#fbfaf5;border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:10px' }, [
        el('span', { style: 'font-weight:800' }, 'Последняя цена: ' + fmtMoney(mat.last_price) + ' сум/' + (mat.unit || 'ед.')),
        verdictBadge(mat),
        mat.y_buys ? el('span', { class: 'muted', style: 'font-size:12px' },
          `за год: мин ${fmtMoney(mat.y_min)} · сред ${fmtMoney(mat.y_avg)} · макс ${fmtMoney(mat.y_max)} · закупок ${mat.y_buys}`) : null,
      ]) : null,
      rows.length < 2 ? el('p', { class: 'muted' }, 'Точек пока мало для графика — нужны минимум две закупки/цены.') : null,
      chart,
      legend,
      el('div', { class: 'oe-table-wrap', style: 'max-height:38vh' }, [table]),
    ]);
    const m = modal('📈 ' + (mat.code ? mat.code + ' · ' : '') + mat.name + ' — история цен', body, [el('button', { onclick: () => m.close() }, 'Закрыть')]);
  }


  // ================= СПЕЦИФИКАЦИИ =================
  async function viewSpecs() {
    const main = $('#pur-main');
    main.innerHTML = '';
    main.appendChild(el('div', { class: 'pur-toolbar' }, [
      el('h2', {}, 'Спецификации на продукт'),
      el('div', { class: 'pur-toolbar-right' }, [
        el('input', { id: 'spec-q', placeholder: 'Поиск продукта...', oninput: debounce(loadSpecProducts, 300) }),
      ]),
    ]));
    main.appendChild(el('p', { class: 'muted', style: 'margin:0 0 12px' }, 'Физические параметры с коридором — что кладовщик проверяет при приёмке. Меняются в любой момент; в приёмку подтягиваются автоматически.'));
    main.appendChild(el('div', { id: 'spec-list', class: 'pur-content' }));
    await loadSpecProducts();
  }

  async function loadSpecProducts() {
    const q = $('#spec-q') ? $('#spec-q').value.trim() : '';
    const data = await api('/spec-products' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const box = $('#spec-list');
    box.innerHTML = '';
    box.appendChild(el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, ['Артикул', 'Продукт', 'Параметров', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, data.items.map((m) =>
        el('tr', { onclick: () => openSpecEditor(m) }, [
          el('td', { class: 'tnum muted' }, m.code || ''),
          el('td', { style: 'font-weight:600' }, m.name + (m.kind === 'packaging' ? ' 📦' : '')),
          el('td', { class: 'tnum' }, m.param_count ? String(m.param_count) : '—'),
          el('td', { style: 'text-align:right' }, el('button', {}, m.param_count ? 'Изменить' : '+ Задать')),
        ])
      )),
    ]));
  }

  async function openSpecEditor(m) {
    const data = await api('/spec?kind=' + m.kind + '&id=' + m.id);
    let params = data.params.slice();
    const listWrap = el('div', {});
    function render() {
      listWrap.innerHTML = '';
      params.forEach((p, idx) => {
        const nameIn = el('input', { value: p.name || '', placeholder: 'Параметр (Размер листа)', oninput: (e) => p.name = e.target.value });
        const typeSel = el('select', { onchange: (e) => { p.ptype = e.target.value; render(); } }, [
          el('option', { value: 'range' }, 'Числовой коридор'),
          el('option', { value: 'quality' }, 'Качественный (✓/✗)'),
        ]);
        typeSel.value = p.ptype || 'range';
        const fields = [el('div', { class: 'spec-row-name' }, [nameIn]), el('div', {}, [typeSel])];
        if ((p.ptype || 'range') === 'range') {
          fields.push(el('input', { type: 'number', step: 'any', value: p.min_val ?? '', placeholder: 'от', class: 'spec-num', oninput: (e) => p.min_val = e.target.value }));
          fields.push(el('input', { type: 'number', step: 'any', value: p.max_val ?? '', placeholder: 'до', class: 'spec-num', oninput: (e) => p.max_val = e.target.value }));
          fields.push(el('input', { value: p.unit || '', placeholder: 'ед (см, г)', class: 'spec-unit', oninput: (e) => p.unit = e.target.value }));
        } else {
          fields.push(el('input', { value: p.target || '', placeholder: 'эталон (насыщенно-зелёный)', class: 'spec-target', oninput: (e) => p.target = e.target.value }));
        }
        fields.push(el('button', { class: 'spec-del', onclick: () => { params.splice(idx, 1); render(); } }, '✕'));
        listWrap.appendChild(el('div', { class: 'spec-row' }, fields));
      });
    }
    render();
    const body = el('div', {}, [
      el('p', { class: 'muted' }, m.name + (m.code ? ' (' + m.code + ')' : '')),
      listWrap,
      el('button', { class: 'spec-add', onclick: () => { params.push({ name: '', ptype: 'range', min_val: '', max_val: '', unit: '', target: '' }); render(); } }, '+ Добавить параметр'),
    ]);
    const mm = modal('📋 Спецификация — ' + m.name, body, [
      el('button', { onclick: () => mm.close() }, 'Отмена'),
      el('button', { class: 'btn-primary', onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          await api('/spec', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_kind: m.kind, item_id: m.id, params }) });
          toast('Спецификация сохранена');
          mm.close();
          loadSpecProducts();
        } catch (e) { toast(e.message, true); ev.target.disabled = false; }
      } }, 'Сохранить'),
    ]);
  }

  // ================= Каркас =================
  let currentTab = 'orders';
  let FOPTS = null;
  let ORD_ITEMS = new Set(); // кэш filter-options (поставщики, категории, родительские категории, товары)
  async function ensureOpts() { if (!FOPTS) FOPTS = await api('/filter-options'); return FOPTS; }
  function pcBadge(name, color) {
    if (!name) return el('span', { class: 'muted' }, '—');
    return el('span', { class: 'pc-badge', style: 'background:' + (color || '#999') + '22;color:' + (color || '#555') + ';border:1px solid ' + (color || '#999') + '55' }, name);
  }
  // мультиселект товаров (выпадающий список с чекбоксами)
  function itemMultiSelect(items, selectedSet, onChange) {
    const box = el('div', { class: 'pur-multi' });
    const btn = el('button', { class: 'pur-multi-btn', type: 'button' }, 'Товары: все');
    const panel = el('div', { class: 'pur-multi-panel', style: 'display:none' });
    const search = el('input', { placeholder: 'поиск товара...', oninput: () => renderOpts() });
    panel.appendChild(search);
    const list = el('div', { class: 'pur-multi-list' });
    panel.appendChild(list);
    function label() {
      btn.textContent = selectedSet.size ? 'Товаров: ' + selectedSet.size : 'Товары: все';
    }
    function renderOpts() {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      items.filter((it) => !q || it.name.toLowerCase().includes(q) || String(it.code || '').toLowerCase().includes(q))
        .slice(0, 200)
        .forEach((it) => {
          const cb = el('input', { type: 'checkbox' });
          cb.checked = selectedSet.has(it.id);
          cb.addEventListener('change', () => { if (cb.checked) selectedSet.add(it.id); else selectedSet.delete(it.id); label(); onChange(); });
          list.appendChild(el('label', { class: 'pur-multi-item' }, [cb, ' ', (it.code ? it.code + ' · ' : '') + it.name]));
        });
    }
    btn.addEventListener('click', () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; renderOpts(); });
    document.addEventListener('click', (e) => { if (!box.contains(e.target)) panel.style.display = 'none'; });
    box.appendChild(btn); box.appendChild(panel);
    label();
    return box;
  }

  function debounce(fn, ms) {
    let t;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  // ================= АКТ СВЕРКИ =================
  const ORG = 'Novagreen Foods';
  const actState = { supplier: '', from: '', to: '' };
  let lastActData = null;
  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ruD = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('.') : '');
  function actHtml(d) {
    const money = (v) => fmtMoney(Math.round(Number(v) || 0));
    const closing = Number(d.closing) || 0;
    const favor = closing > 0.5 ? '«' + ORG + '» должно поставщику' : closing < -0.5 ? 'в пользу «' + ORG + '» (переплата)' : 'взаиморасчёты закрыты';
    const rowsHtml = (d.rows || []).map((r) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e3e0d4">${ruD(r.date)}</td><td style="padding:6px 10px;border-bottom:1px solid #e3e0d4">${escHtml(r.doc)}</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #e3e0d4">${r.delivery ? money(r.delivery) : '—'}</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #e3e0d4">${r.payment ? money(r.payment) : '—'}</td></tr>`).join('');
    return `<div style="max-width:760px;margin:0 auto;font-family:Manrope,Arial,sans-serif;color:#14241b;font-size:13px;background:#fff;padding:20px;border:1px solid #e3e0d4;border-radius:10px">
      <div style="text-align:center;margin-bottom:14px"><div style="font-size:18px;font-weight:700">Акт сверки взаиморасчётов</div><div style="color:#7c8579">г. Ташкент · по состоянию на ${ruD(d.to || d.today)}</div></div>
      <div style="margin-bottom:12px;line-height:1.6">Между <b>«${ORG}»</b> и поставщиком <b>«${escHtml(d.supplier.name)}»</b>${d.supplier.inn ? ' (ИНН ' + escHtml(d.supplier.inn) + ')' : ''} за период с ${ruD(d.from)} по ${ruD(d.to)}.</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#f2f5f1"><th style="padding:8px 10px;text-align:left">Дата</th><th style="padding:8px 10px;text-align:left">Документ</th><th style="padding:8px 10px;text-align:right">Поставка</th><th style="padding:8px 10px;text-align:right">Оплата</th></tr></thead>
        <tbody>
          <tr style="color:#7c8579"><td colspan="4" style="padding:6px 10px;border-bottom:1px solid #e3e0d4">Долг на начало периода — ${money(d.opening)} сум</td></tr>
          ${rowsHtml || '<tr><td colspan="4" style="padding:10px;text-align:center;color:#7c8579">Операций за период нет</td></tr>'}
        </tbody>
        <tfoot><tr style="background:#f2f5f1;font-weight:700"><td colspan="2" style="padding:8px 10px">Обороты за период</td><td style="padding:8px 10px;text-align:right">${money(d.delivered)}</td><td style="padding:8px 10px;text-align:right">${money(d.paid)}</td></tr></tfoot>
      </table>
      <div style="margin-top:14px;padding:10px 14px;background:#eef4e9;border-radius:8px;display:flex;justify-content:space-between;font-weight:700"><span>Общий долг</span><span>${money(Math.abs(closing))} сум · ${favor}</span></div>
      <div style="display:flex;gap:40px;margin-top:28px"><div style="flex:1"><div style="border-bottom:1px solid #14241b;height:26px"></div><div style="color:#7c8579;margin-top:4px">«${ORG}»</div></div><div style="flex:1"><div style="border-bottom:1px solid #14241b;height:26px"></div><div style="color:#7c8579;margin-top:4px">«${escHtml(d.supplier.name)}»</div></div></div>
    </div>`;
  }
  async function loadAct() {
    const box = $('#act-body'); if (!box) return;
    box.innerHTML = '<p class="muted">Считаю…</p>';
    const p = new URLSearchParams(); p.set('supplier_id', actState.supplier); if (actState.from) p.set('from', actState.from); if (actState.to) p.set('to', actState.to);
    try { const d = await api('/act?' + p.toString()); lastActData = d; box.innerHTML = actHtml(d); }
    catch (e) { lastActData = null; box.innerHTML = '<p class="muted">Ошибка: ' + escHtml(e.message) + '</p>'; }
  }
  function printAct() {
    if (!lastActData) return toast('Сначала выберите поставщика и период', true);
    const w = window.open('', '_blank');
    if (!w) return toast('Разрешите всплывающие окна для печати', true);
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Акт сверки — ' + escHtml(lastActData.supplier.name) + '</title></head><body style="margin:0;padding:16px;background:#fff">' + actHtml(lastActData) + '<' + 'script>window.onload=function(){window.print();}<' + '/script></body></html>');
    w.document.close();
  }
  async function viewAct() {
    const main = $('#pur-main'); main.innerHTML = '';
    const suppliers = (await api('/suppliers')).items || [];
    if (!actState.supplier && suppliers.length) actState.supplier = String(suppliers[0].id);
    const now = new Date();
    if (!actState.from) actState.from = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
    if (!actState.to) actState.to = now.toISOString().slice(0, 10);
    const supSel = el('select', { onchange: (e) => { actState.supplier = e.target.value; loadAct(); } }, suppliers.map((s) => el('option', { value: s.id, selected: String(s.id) === actState.supplier || null }, s.name)));
    const fromIn = el('input', { type: 'date', value: actState.from, onchange: (e) => { actState.from = e.target.value; loadAct(); } });
    const toIn = el('input', { type: 'date', value: actState.to, onchange: (e) => { actState.to = e.target.value; loadAct(); } });
    main.appendChild(el('div', { class: 'pur-toolbar' }, [
      el('h2', {}, 'Акт сверки'),
      el('div', { class: 'pur-toolbar-right' }, [el('button', { class: 'btn-primary', onclick: printAct }, '🖨 Печать')]),
    ]));
    main.appendChild(el('div', { class: 'pur-filters' }, [
      el('label', {}, ['Поставщик', supSel]), el('label', {}, ['Период с', fromIn]), el('label', {}, ['по', toIn]),
    ]));
    main.appendChild(el('div', { id: 'act-body', class: 'pur-content', style: 'margin-top:10px' }));
    if (actState.supplier) loadAct();
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.pur-tab').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    if (tab === 'suppliers') viewSuppliers();
    else if (tab === 'settlements') viewSettlements();
    else if (tab === 'act') viewAct();
    else if (tab === 'prices') viewPrices();
    else if (tab === 'specs') viewSpecs();
    else viewOrders();
  }

  window.addEventListener('hashchange', () => switchTab(location.hash.slice(1) || 'orders'));
  switchTab(location.hash.slice(1) || 'orders');
})();
