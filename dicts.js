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

  async function wipeStock() {
    const word = prompt('Полная зачистка склада для тестов: остатки, движения, приёмки, передачи будут удалены.\nВведите слово ОЧИСТИТЬ для подтверждения:');
    if (!word) return;
    try {
      await api('/wipe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: word }) });
      toast('Склад очищен');
      viewReceiving();
    } catch (e) { toast(e.message, true); }
  }

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
            el('td', { style: 'text-align:right' }, [
              el('button', { class: 'btn-primary stk-open', onclick: () => openReceipt(r.id) }, r.receipt_status === 'pending' ? 'Открыть' : 'Изменить'),
              (window.HUB_USER && window.HUB_USER.isAdmin && r.receipt_status !== 'pending')
                ? el('button', { class: 'stk-rollback', onclick: async (e) => {
                    e.stopPropagation();
                    if (!confirm('Откатить приёмку ' + r.number + '? Приход вернётся со склада, заявка станет «Ожидается».')) return;
                    try { await api('/receipt/' + r.id + '/cancel', { method: 'POST' }); toast('Приёмка откачена'); viewReceiving(); }
                    catch (err) { toast(err.message, true); }
                  } }, '↩ Откат')
                : null,
            ]),
          ])
        )),
      ]));
    }
    main.appendChild(list);
  }

  async function openReceipt(id) {
    const d = await api('/receipt/' + id);
    const reasons = (await api('/reasons?scope=receipt')).items.concat((await api('/reasons?scope=spec')).items);
    const inputs = {};
    const checkState = {}; // ключ item_id|param → {passed, measured}

    // строки позиций: факт + параметры спеки
    const rowsNodes = [];
    d.items.forEach((i) => {
      const inp = el('input', { type: 'number', step: 'any', min: '0', class: 'stk-fact', value: i.fact_qty != null ? Number(i.fact_qty) : '' });
      const overHint = el('span', { class: 'stk-over', style: 'display:none' }, '');
      inp.addEventListener('input', () => {
        const v = Number(inp.value), pl = Number(i.plan_qty);
        if (v > pl) { inp.classList.add('over'); overHint.style.display = ''; overHint.textContent = '+' + fmtQty(v - pl) + ' сверх плана'; }
        else { inp.classList.remove('over'); overHint.style.display = 'none'; }
      });
      inputs[i.id] = { inp, plan: Number(i.plan_qty) };
      rowsNodes.push(el('tr', {}, [
        el('td', { style: 'font-weight:600;font-size:16px' }, i.item_name + (i.item_code ? ' (' + i.item_code + ')' : '')),
        el('td', { class: 'tnum', style: 'font-size:16px' }, fmtQty(i.plan_qty)),
        el('td', {}, [inp, overHint]),
        el('td', {}, i.unit || ''),
      ]));
      // параметры спеки этой позиции
      if (i.spec_params && i.spec_params.length) {
        const specCell = el('td', { colspan: '4', class: 'stk-spec-cell' });
        const wrap = el('div', { class: 'stk-spec-wrap' });
        wrap.appendChild(el('div', { class: 'stk-spec-title' }, '📋 Проверка по спецификации:'));
        i.spec_params.forEach((p) => {
          const key = i.id + '|' + p.name;
          checkState[key] = { item_id: i.id, param_name: p.name, ptype: p.ptype, passed: true, measured: '' };
          if (p.ptype === 'range') {
            const norm = (p.min_val != null ? 'от ' + p.min_val : '') + (p.max_val != null ? ' до ' + p.max_val : '') + (p.unit ? ' ' + p.unit : '');
            const verdict = el('span', { class: 'stk-spec-verdict' }, '');
            const meas = el('input', { type: 'number', step: 'any', class: 'stk-spec-meas', placeholder: 'замер',
              oninput: (e) => {
                const v = Number(e.target.value);
                checkState[key].measured = e.target.value;
                let ok = true;
                if (e.target.value === '') { verdict.textContent = ''; checkState[key].passed = true; return; }
                if (p.min_val != null && v < Number(p.min_val)) ok = false;
                if (p.max_val != null && v > Number(p.max_val)) ok = false;
                checkState[key].passed = ok;
                verdict.textContent = ok ? '✓ в норме' : '✗ вне коридора';
                verdict.className = 'stk-spec-verdict ' + (ok ? 'ok' : 'bad');
              } });
            wrap.appendChild(el('div', { class: 'stk-spec-row' }, [
              el('span', { class: 'stk-spec-name' }, p.name + ' (' + norm + ')'), meas, verdict,
            ]));
          } else {
            // качественный ✓/✗
            const yes = el('button', { type: 'button', class: 'stk-spec-btn ok active' }, '✓');
            const no = el('button', { type: 'button', class: 'stk-spec-btn bad' }, '✗');
            yes.onclick = () => { checkState[key].passed = true; yes.classList.add('active'); no.classList.remove('active'); };
            no.onclick = () => { checkState[key].passed = false; no.classList.add('active'); yes.classList.remove('active'); };
            wrap.appendChild(el('div', { class: 'stk-spec-row' }, [
              el('span', { class: 'stk-spec-name' }, p.name + (p.target ? ' (' + p.target + ')' : '')),
              el('span', { class: 'stk-spec-btns' }, [yes, no]),
            ]));
          }
        });
        specCell.appendChild(wrap);
        rowsNodes.push(el('tr', {}, [specCell]));
      }
    });

    const table = el('table', { class: 'dict-table stk-big' }, [
      el('thead', {}, el('tr', {}, ['Сырьё / материал', 'План', 'Факт', 'Ед.'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rowsNodes),
    ]);

    const tempIn = el('input', { type: 'text', class: 'stk-fact', placeholder: '°C', style: 'width:90px' });
    const commentIn = el('input', { type: 'text', placeholder: 'Комментарий к приёмке' });
    const reasonSel = el('select', {}, [el('option', { value: '' }, '— причина (если расхождение) —'), ...reasons.map((r) => el('option', { value: r.name }, r.name))]);

    const body = el('div', {}, [
      el('p', { class: 'muted', style: 'font-size:15px' }, 'Поставщик: ' + d.order.supplier_name + ' · заявка ' + d.order.number + (d.order.delivery_window ? ' · окно ' + d.order.delivery_window : '')),
      el('div', { class: 'pur-filters' }, [
        el('label', {}, ['🌡 Температура сырья', tempIn]),
        el('label', { style: 'flex:1' }, ['Причина расхождения', reasonSel]),
      ]),
      el('div', { class: 'form-row', style: 'margin-bottom:10px' }, [commentIn]),
      table,
    ]);

    const fillAll = () => { for (const k in inputs) inputs[k].inp.value = inputs[k].plan; };
    const zeroAll = () => { for (const k in inputs) inputs[k].inp.value = 0; };

    async function save(override) {
      // П2: мягкая проверка превышения плана
      const over = Object.values(inputs).filter((v) => Number(v.inp.value) > v.plan);
      if (over.length && !override && !confirm('По ' + over.length + ' позиц. факт больше плана. Привезли с запасом — принять как есть?')) return;
      const items = Object.entries(inputs).map(([iid, v]) => ({ id: iid, fact_qty: v.inp.value === '' ? 0 : Number(v.inp.value) }));
      const checks = Object.values(checkState);
      const payload = {
        items, checks,
        temperature: tempIn.value, comment: commentIn.value, reason: reasonSel.value,
        override_spec: !!override,
      };
      let res = await fetch('/stock/api/receipt/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      let data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.error === 'spec_failed') {
        if (window.HUB_USER && window.HUB_USER.isAdmin) {
          if (confirm(data.message + '\n\nПринять с отклонением от спецификации под вашу ответственность?')) {
            return save(true);
          }
          return;
        }
        toast(data.message, true);
        return;
      }
      if (!res.ok) { toast(data.error || 'Ошибка', true); return; }
      toast('Приёмка сохранена. Закупщик уведомлён ✅');
      m.close();
      viewReceiving();
    }

    const actions = [
      el('button', { onclick: () => m.close() }, 'Закрыть'),
      el('button', { onclick: zeroAll }, '🚫 Не приехало'),
      el('button', { onclick: fillAll }, '✅ Принято полностью'),
      el('button', { class: 'btn-primary', onclick: () => save(false) }, '💾 Сохранить приёмку'),
    ];
    const m = modal('📥 Приёмка — ' + d.order.supplier_name, body, actions);
  }

  // ================= ВКЛАДКА 2: ОСТАТКИ И ПЕРЕДАЧА В ПРОИЗВОДСТВО =================
  const ISTATUS = {
    pending: ['Ожидает подтверждения', 'st-ordered'],
    accepted: ['Принято', 'st-received'],
    accepted_diff: ['Принято с расхождением', 'st-draft'],
    rejected: ['Отклонено', 'st-cancelled'],
    overdue: ['Просрочено', 'st-cancelled'],
    cancelled: ['Отменено', 'st-cancelled'],
  };
  function iPill(s) { const [l, c] = ISTATUS[s] || [s, '']; return el('span', { class: 'status-pill ' + c }, l); }

  async function viewIssue() {
    const main = $('#stk-main');
    main.innerHTML = '';
    const data = await api('/available');
    main.appendChild(el('div', { class: 'stk-head' }, [el('div', { class: 'stk-today' }, 'Остатки и передача в производство')]));

    const zoneSel = el('select', { class: 'stk-zone' }, data.zones.map((z) => el('option', { value: z }, z)));
    const entered = {};
    const search = el('input', { placeholder: '🔍 Найти сырьё...', oninput: () => renderRows() });
    const wrap = el('div', { class: 'pur-content' });
    const sendBtn = el('button', { class: 'btn-primary stk-open', onclick: doSend }, '📤 Передать в производство');

    function refreshBtn() {
      const any = Object.keys(entered).length > 0;
      sendBtn.disabled = !any;
    }
    function renderRows() {
      const q = search.value.trim().toLowerCase();
      wrap.innerHTML = '';
      const rows = data.items.filter((m) => !q || m.name.toLowerCase().includes(q) || String(m.code || '').toLowerCase().includes(q)).map((m) => {
        const key = m.kind + ':' + m.id;
        const avail = Number(m.available);
        const inp = el('input', {
          type: 'number', step: 'any', min: '0', class: 'stk-fact', value: entered[key] ? entered[key].qty : '',
          oninput: (e) => {
            let v = Number(e.target.value);
            if (v > avail) { e.target.value = avail; v = avail; toast('Доступно к передаче: ' + fmtQty(avail), true); }
            if (v > 0) entered[key] = { item_kind: m.kind, item_id: m.id, qty: v, name: m.name, code: m.code, unit: m.unit };
            else delete entered[key];
            refreshBtn();
          },
        });
        return el('tr', {}, [
          el('td', { style: 'font-weight:600;font-size:15px' }, m.name + (m.kind === 'packaging' ? ' 📦' : '')),
          el('td', { class: 'tnum muted' }, m.code || ''),
          el('td', { class: 'tnum' }, fmtQty(m.balance)),
          el('td', { class: 'tnum', style: 'color:var(--amber-d,#b9770a)' }, Number(m.in_transit) ? fmtQty(m.in_transit) : '—'),
          el('td', { class: 'tnum', style: 'font-weight:700;color:#3f6a16' }, fmtQty(avail)),
          el('td', {}, inp),
          el('td', {}, m.unit || ''),
        ]);
      });
      wrap.appendChild(el('table', { class: 'dict-table stk-big' }, [
        el('thead', {}, el('tr', {}, ['Наименование', 'Артикул', 'Остаток общий', 'В передаче', 'Доступно', 'Передать', 'Ед.'].map((h, i) =>
          el('th', { style: i >= 2 && i <= 4 ? 'text-align:right' : '' }, h)))),
        el('tbody', {}, rows),
      ]));
    }
    renderRows();
    refreshBtn();

    function doSend() {
      const list = Object.values(entered);
      if (!list.length) return toast('Укажите количество', true);
      // окно подтверждения
      const body = el('div', {}, [
        el('p', { style: 'font-size:15px' }, 'Вы передаёте в ' + zoneSel.value + ':'),
        el('table', { class: 'dict-table' }, [el('tbody', {}, list.map((it) =>
          el('tr', {}, [
            el('td', { style: 'font-weight:600' }, it.name + (it.code ? ' (' + it.code + ')' : '')),
            el('td', { class: 'tnum', style: 'text-align:right;font-weight:700' }, fmtQty(it.qty) + ' ' + (it.unit || '')),
          ])
        ))]),
        el('p', { class: 'muted', style: 'margin-top:10px' }, 'Сырьё перейдёт в статус «в передаче». Окончательно спишется со склада только после подтверждения производством.'),
      ]);
      const cm = modal('Подтвердите передачу', body, [
        el('button', { onclick: () => cm.close() }, 'Отмена'),
        el('button', {
          class: 'btn-primary',
          onclick: async (ev) => {
            ev.target.disabled = true;
            try {
              await api('/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ area: zoneSel.value, items: list.map((x) => ({ item_kind: x.item_kind, item_id: x.item_id, qty: x.qty })) }) });
              toast('Передача создана. Ожидает подтверждения производства ✅');
              cm.close();
              viewIssue();
            } catch (e) { toast(e.message, true); ev.target.disabled = false; }
          },
        }, 'Подтвердить передачу'),
      ]);
    }

    main.appendChild(el('div', { class: 'pur-filters' }, [
      el('label', {}, ['Куда передать', zoneSel]),
      el('label', { style: 'flex:1' }, ['Поиск', search]),
    ]));
    main.appendChild(wrap);
    main.appendChild(el('div', { style: 'margin-top:14px;text-align:right' }, [sendBtn]));

    // история передач со статусами
    const issues = await api('/issues');
    if (issues.items.length) {
      const hist = el('div', { class: 'pur-content', style: 'margin-top:18px' });
      const histHead = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin:14px' }, [
        el('h3', { class: 'pur-sub', style: 'margin:0' }, 'Мои передачи'),
        (window.HUB_USER && window.HUB_USER.isAdmin)
          ? el('button', { class: 'btn-danger-link', onclick: async () => {
              if (!confirm('Удалить ВСЕ передачи навсегда? Это действие для очистки тестовых данных. Подтверждённые списания вернутся на склад.')) return;
              try { await api('/issues/wipe', { method: 'POST' }); toast('Все передачи удалены'); viewIssue(); }
              catch (e) { toast(e.message, true); }
            } }, '🗑 Очистить все передачи')
          : null,
      ]);
      hist.appendChild(histHead);
      hist.appendChild(el('table', { class: 'dict-table' }, [
        el('thead', {}, el('tr', {}, ['Дата', 'Зона', 'Позиций', 'Передано', 'Принято', 'Статус', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, issues.items.map((it) =>
          el('tr', {}, [
            el('td', {}, ruDate(it.issued_at)),
            el('td', {}, it.area),
            el('td', { class: 'tnum' }, String(it.positions)),
            el('td', { class: 'tnum' }, fmtQty(it.total_qty)),
            el('td', { class: 'tnum' }, it.status === 'pending' ? '—' : fmtQty(it.total_fact)),
            el('td', {}, iPill(it.status)),
            el('td', { style: 'text-align:right;white-space:nowrap' }, [
              it.status === 'pending'
                ? el('button', { onclick: async () => {
                    if (!confirm('Отменить передачу?')) return;
                    try { await api('/issue/' + it.id + '/cancel', { method: 'POST' }); toast('Передача отменена'); viewIssue(); }
                    catch (e) { toast(e.message, true); }
                  } }, 'Отменить')
                : null,
              (window.HUB_USER && window.HUB_USER.isAdmin)
                ? el('button', { class: 'btn-danger-link', style: 'margin-left:6px', title: 'Удалить запись (админ)', onclick: async () => {
                    if (!confirm('Удалить передачу №' + it.id + ' навсегда? Если была подтверждена — списание вернётся на склад.')) return;
                    try { await api('/issue/' + it.id, { method: 'DELETE' }); toast('Передача удалена'); viewIssue(); }
                    catch (e) { toast(e.message, true); }
                  } }, '🗑')
                : null,
            ]),
          ])
        )),
      ]));
      main.appendChild(hist);
    }
  }

  // ================= ВКЛАДКА 3: ИТОГИ ДНЯ =================
  async function viewSummary() {
    const main = $('#stk-main');
    main.innerHTML = '';
    const d = await api('/day-summary?date=' + selDate);
    main.appendChild(el('div', { class: 'stk-head' }, [el('div', { class: 'stk-today' }, 'Итоги дня — ' + ruDate(d.date))]));

    const kpis = el('div', { class: 'pur-kpis' });
    [['Сегодня приехало', fmtQty(d.arrived), '#3f6a16'],
     ['Передано (подтверждено)', fmtQty(d.issued), 'var(--ink)'],
     ['В передаче (ждёт цех)', fmtQty(d.inTransit || 0), 'var(--amber-d,#b9770a)'],
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


  // ================= ВКЛАДКА: РЕЗЮМЕ / ОСТАТКИ (инвентаризация) =================
  let invFilter = 'all'; // all | instock | nomove
  async function viewInventory() {
    const main = $('#stk-main');
    main.innerHTML = '';
    const data = await api('/inventory');
    main.appendChild(el('div', { class: 'stk-head' }, [
      el('div', {}, [
        el('div', { class: 'stk-today' }, 'Резюме склада — остатки для инвентаризации'),
        el('div', { class: 'stk-counts' }, [el('span', {}, 'Позиций всего: ' + data.items.length)]),
      ]),
    ]));

    const filterWrap = el('div', { class: 'pur-filters' }, [
      el('label', {}, ['Показать', (() => {
        const sel = el('select', { onchange: (e) => { invFilter = e.target.value; render(); } }, [
          el('option', { value: 'all' }, 'Все позиции'),
          el('option', { value: 'instock' }, '🟢 В наличии (есть остаток)'),
          el('option', { value: 'nomove' }, '⚪ Пусто (нулевой остаток)'),
        ]);
        sel.value = invFilter;
        return sel;
      })()]),
      el('label', { style: 'flex:1' }, ['Поиск', el('input', { id: 'inv-q', placeholder: '🔍 артикул, наименование...', oninput: () => render() })]),
    ]);
    main.appendChild(filterWrap);
    const box = el('div', { class: 'pur-content' });
    main.appendChild(box);

    function render() {
      const q = ($('#inv-q') ? $('#inv-q').value.trim().toLowerCase() : '');
      let items = data.items.slice();
      if (invFilter === 'instock') items = items.filter((m) => Number(m.balance) !== 0);
      else if (invFilter === 'nomove') items = items.filter((m) => Number(m.balance) === 0);
      if (q) items = items.filter((m) => m.name.toLowerCase().includes(q) || String(m.code || '').toLowerCase().includes(q));
      box.innerHTML = '';
      if (!items.length) { box.appendChild(el('p', { class: 'dict-empty' }, 'Нет позиций по фильтру.')); return; }
      box.appendChild(el('table', { class: 'dict-table' }, [
        el('thead', {}, el('tr', {}, ['Артикул', 'Наименование', 'Остаток', 'В передаче', 'Приход сегодня', 'Передано сегодня', 'Ед.'].map((h, i) =>
          el('th', { style: i >= 2 && i <= 5 ? 'text-align:right' : '' }, h)))),
        el('tbody', {}, items.map((m) => {
          const bal = Number(m.balance);
          return el('tr', { title: m.characteristics || '' }, [
            el('td', { class: 'tnum muted' }, m.code || ''),
            el('td', { style: 'font-weight:600' }, m.name + (m.kind === 'packaging' ? ' 📦' : '')),
            el('td', { class: 'tnum', style: 'text-align:right;font-weight:800;color:' + (bal > 0 ? '#3f6a16' : bal < 0 ? 'var(--red)' : 'var(--ink-faint)') }, fmtQty(bal)),
            el('td', { class: 'tnum', style: 'text-align:right;color:var(--amber-d,#b9770a)' }, Number(m.reserved) ? fmtQty(m.reserved) : '—'),
            el('td', { class: 'tnum muted', style: 'text-align:right' }, Number(m.today_in) ? '+' + fmtQty(m.today_in) : '—'),
            el('td', { class: 'tnum muted', style: 'text-align:right' }, Number(m.today_out) ? '−' + fmtQty(m.today_out) : '—'),
            el('td', {}, m.unit || ''),
          ]);
        })),
      ]));
    }
    render();
  }

  // ================= Каркас =================
  function switchTab(tab) {
    document.querySelectorAll('.pur-tab').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    if (tab === 'issue') viewIssue();
    else if (tab === 'inventory') viewInventory();
    else if (tab === 'summary') viewSummary();
    else viewReceiving();
  }
  window.addEventListener('hashchange', () => switchTab(location.hash.slice(1) || 'receiving'));
  switchTab(location.hash.slice(1) || 'receiving');
})();
