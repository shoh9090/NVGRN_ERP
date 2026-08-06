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
  let stripStart = null; // ISO даты первого дня полоски (null = авто: selDate - 3)

  async function wipeStock(after) {
    if (!confirm('ПОЛНАЯ очистка склада. Будут БЕЗВОЗВРАТНО удалены:\n\n• все остатки и вся история движений;\n• все передачи в производство;\n• все приёмки сбросятся в «Ожидается» (факт очистится).\n\nСправочники сырья/упаковки и заявки останутся. Продолжить?')) return;
    const word = prompt('Это нельзя отменить.\nВведите слово ОЧИСТИТЬ (заглавными) для подтверждения:');
    if (!word) return;
    try {
      await api('/wipe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: word }) });
      toast('Склад полностью очищен');
      if (typeof after === 'function') after(); else viewReceiving();
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

    // Панель навигации по датам: прыжок к любой дате + перелистывание недель.
    const shiftStrip = (days) => {
      const b = new Date(stripStart || (() => { const t = new Date(selDate); t.setDate(t.getDate() - 3); return t.toISOString().slice(0, 10); })());
      b.setDate(b.getDate() + days);
      stripStart = b.toISOString().slice(0, 10);
      viewReceiving();
    };
    const jump = el('input', { type: 'date', class: 'stk-datejump', value: selDate, onchange: (e) => { if (e.target.value) { selDate = e.target.value; stripStart = null; viewReceiving(); } } });
    main.appendChild(el('div', { class: 'stk-datenav' }, [
      el('button', { class: 'stk-nav-btn', title: 'Предыдущая неделя', onclick: () => shiftStrip(-7) }, '‹'),
      el('button', { class: 'stk-nav-btn', title: 'Следующая неделя', onclick: () => shiftStrip(7) }, '›'),
      el('button', { class: 'stk-nav-btn', title: 'К сегодняшнему дню', onclick: () => { selDate = todayISO(); stripStart = null; viewReceiving(); } }, 'Сегодня'),
      el('label', { class: 'stk-datejump-lbl' }, ['Перейти к дате:', jump]),
    ]));

    // Календарь-полоска: 14 дней от stripStart (по умолчанию — выбранная дата минус 3).
    const calMap = {};
    for (const d of cal.days) calMap[d.d] = d;
    const strip = el('div', { class: 'stk-calendar' });
    const base = stripStart ? new Date(stripStart) : (() => { const t = new Date(selDate); t.setDate(t.getDate() - 3); return t; })();
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

  // Окно «Бесплатный отход?» при закрытии приёмки. Спрашивает Да/Нет, при «Да» —
  // кол-во по каждому сырью (в ед. товара). Возвращает массив {order_item_id, qty}
  // (пустой — отхода нет) либо null (отмена — приёмку не сохраняем).
  function askWasteModal(rawLines) {
    return new Promise((resolve) => {
      const qtyInputs = {};
      const listWrap = el('div', { style: 'display:none;margin-top:14px' },
        rawLines.map((i) => {
          const inp = el('input', { type: 'number', step: 'any', min: '0', class: 'stk-fact', style: 'width:120px', placeholder: '0' });
          qtyInputs[i.id] = inp;
          return el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' }, [
            el('span', { style: 'flex:1;font-weight:600' }, i.item_name),
            inp, el('span', { class: 'muted' }, i.unit || ''),
          ]);
        }));
      const done = (val) => { overlay.remove(); resolve(val); };
      const finish = () => {
        const arr = Object.entries(qtyInputs)
          .map(([oid, inp]) => ({ order_item_id: oid, qty: Number(inp.value) }))
          .filter((w) => w.qty > 0);
        done(arr);
      };
      const noBtn = el('button', { onclick: () => done([]) }, 'Нет, отхода нет');
      const saveBtn = el('button', { class: 'btn-primary', style: 'display:none', onclick: finish }, '💾 Записать отход');
      const yesBtn = el('button', { class: 'btn-primary', onclick: () => {
        listWrap.style.display = ''; yesBtn.style.display = 'none'; noBtn.textContent = 'Отмена'; noBtn.onclick = () => done([]); saveBtn.style.display = '';
      } }, 'Да');
      const panel = el('div', { class: 'imp-panel pur-modal', style: 'max-width:520px' }, [
        el('div', { class: 'imp-head' }, [el('h3', {}, '♻️ Бесплатный отход?')]),
        el('div', { class: 'imp-body pur-modal-body' }, [
          el('p', { style: 'font-size:16px' }, 'Есть ли бесплатный отход по этой поставке?'),
          el('p', { class: 'muted', style: 'font-size:13px' }, 'Отход попадёт на склад бесплатно (во взаиморасчётах его нет).'),
          listWrap,
        ]),
        el('div', { class: 'imp-actions' }, [noBtn, yesBtn, saveBtn]),
      ]);
      const overlay = el('div', { class: 'imp-overlay', style: 'z-index:10000' }, [panel]);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); }); // клик мимо = отмена
      document.body.appendChild(overlay);
    });
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

    let wasteData; // кэш ответа про отход (чтобы не спрашивать снова при повторной отправке)
    async function save(override) {
      // П2: мягкая проверка превышения плана
      const over = Object.values(inputs).filter((v) => Number(v.inp.value) > v.plan);
      if (over.length && !override && !confirm('По ' + over.length + ' позиц. факт больше плана. Привезли с запасом — принять как есть?')) return;
      // Окно отхода — только по сырью и только если что-то приняли (факт > 0).
      if (wasteData === undefined) {
        const raws = d.items.filter((i) => i.item_kind === 'raw' && Number(inputs[i.id] && inputs[i.id].inp.value) > 0);
        wasteData = raws.length ? await askWasteModal(raws) : [];
        if (wasteData === null) { wasteData = undefined; return; } // отмена — приёмку не сохраняем
      }
      const items = Object.entries(inputs).map(([iid, v]) => ({ id: iid, fact_qty: v.inp.value === '' ? 0 : Number(v.inp.value) }));
      const checks = Object.values(checkState);
      const payload = {
        items, checks, waste: wasteData,
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

  let issPc = '', issCat = '', issAvail = false;
  async function viewIssue() {
    const main = $('#stk-main');
    main.innerHTML = '';
    const data = await api('/available');
    main.appendChild(el('div', { class: 'stk-head' }, [el('div', { class: 'stk-today' }, 'Остатки и передача в производство')]));

    const zoneSel = el('select', { class: 'stk-zone' }, data.zones.map((z) => el('option', { value: z }, z)));
    const entered = {};
    const search = el('input', { placeholder: '🔍 Найти сырьё...', value: '', oninput: () => renderRows() });
    // Каскадные фильтры: родит.категория → категория, и «только доступные».
    const pcSel = el('select', {}, [el('option', { value: '' }, 'Все родит. категории'), ...(data.parents || []).map((p) => el('option', { value: p.id, selected: String(p.id) === issPc || null }, p.name))]);
    const catSel = el('select', {});
    function fillCats() {
      catSel.innerHTML = '';
      catSel.appendChild(el('option', { value: '' }, 'Все категории'));
      (data.categories || []).filter((c) => !issPc || String(c.parent_id) === String(issPc)).forEach((c) => catSel.appendChild(el('option', { value: c.id, selected: String(c.id) === issCat || null }, c.name)));
    }
    fillCats();
    pcSel.onchange = () => { issPc = pcSel.value; issCat = ''; fillCats(); renderRows(); };
    catSel.onchange = () => { issCat = catSel.value; renderRows(); };
    const availChk = el('input', { type: 'checkbox' }); availChk.checked = issAvail;
    availChk.onchange = () => { issAvail = availChk.checked; renderRows(); };
    const wrap = el('div', { class: 'pur-content' });
    const sendBtn = el('button', { class: 'btn-primary stk-open', onclick: doSend }, '📤 Передать в производство');

    function refreshBtn() {
      const any = Object.keys(entered).length > 0;
      sendBtn.disabled = !any;
    }
    function renderRows() {
      const q = search.value.trim().toLowerCase();
      wrap.innerHTML = '';
      const filtered = data.items.filter((m) => {
        if (issPc && String(m.pc_id) !== String(issPc)) return false;
        if (issCat && String(m.category_id) !== String(issCat)) return false;
        if (issAvail && !(Number(m.available) > 0)) return false;
        if (q && !(m.name.toLowerCase().includes(q) || String(m.code || '').toLowerCase().includes(q))) return false;
        return true;
      });
      const cnt = $('#iss-count'); if (cnt) cnt.textContent = 'Позиций: ' + filtered.length;
      const rows = filtered.map((m) => {
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
      el('label', {}, ['Родит. категория', pcSel]),
      el('label', {}, ['Категория', catSel]),
      el('label', { class: 'stk-check' }, [availChk, ' Только доступные']),
      el('label', { style: 'flex:1' }, ['Поиск', search]),
      el('span', { id: 'iss-count', class: 'muted', style: 'align-self:center;font-size:13px' }, ''),
    ]));
    main.appendChild(wrap);
    renderRows();
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
                ? el('button', { class: 'btn-primary', style: 'margin-right:6px', title: 'Заглушка производства: подтвердить получение и списать сырьё со склада', onclick: async () => {
                    if (!confirm('Подтвердить получение производством? Сырьё окончательно спишется со склада.')) return;
                    try { await api('/issue/' + it.id + '/confirm', { method: 'POST' }); toast('Передача подтверждена — сырьё списано ✅'); viewIssue(); }
                    catch (e) { toast(e.message, true); }
                  } }, '✅ Подтвердить')
                : null,
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
  let invPc = '', invCat = '';
  let invDate = null; // выбранная дата остатка (null = сегодня)
  let invData = null;
  let invCount = false; // режим быстрого пересчёта (инвентаризация одним экраном)
  let invCountComment = '';
  let invPositive = false; // галочка: только позиции с положительным остатком
  // Настройка столбцов таблицы остатков (как в SD): показать/скрыть.
  const stkColsHidden = new Set(JSON.parse(localStorage.getItem('stk_inv_cols_hidden') || '["opening","today_in","today_out"]'));
  const saveStkCols = () => localStorage.setItem('stk_inv_cols_hidden', JSON.stringify([...stkColsHidden]));
  let stkColsPanel = null, stkColsWrap = null;
  const STK_COLS = [
    { key: 'num', label: '#', always: true, get: (m, i) => String(i + 1), cls: 'tnum muted' },
    { key: 'code', label: 'Артикул', get: (m) => m.code || '', cls: 'tnum muted' },
    { key: 'name', label: 'Наименование', always: true, node: (m) => el('td', { style: 'font-weight:600' }, [
      m.name + (m.kind === 'packaging' ? ' 📦' : ''),
      m.is_waste ? el('span', { style: 'margin-left:6px;font-size:11px;font-weight:700;color:#8a6d0a;background:rgba(240,200,40,.18);padding:1px 6px;border-radius:6px;vertical-align:middle' }, '♻ отход') : null,
    ]) },
    { key: 'char', label: 'Характеристика', node: (m) => el('td', { class: 'muted', style: 'max-width:320px' }, m.characteristics || '—') },
    { key: 'opening', label: 'Перв. остаток', align: 'right', node: (m) => el('td', { class: 'tnum muted', style: 'text-align:right' }, Number(m.opening_balance) !== 0 ? fmtQty(m.opening_balance) : '—') },
    { key: 'balance', label: 'Остаток', always: true, align: 'right', node: (m) => { const bal = Number(m.balance); return el('td', { class: 'tnum', style: 'text-align:right;font-weight:800;color:' + (bal > 0 ? '#3f6a16' : bal < 0 ? 'var(--red)' : 'var(--ink-faint)') }, fmtQty(bal)); } },
    { key: 'reserved', label: 'В передаче', align: 'right', node: (m) => el('td', { class: 'tnum', style: 'text-align:right;color:var(--amber-d,#b9770a)' }, Number(m.reserved) ? fmtQty(m.reserved) : '—') },
    { key: 'today_in', label: 'Приход сег.', align: 'right', node: (m) => el('td', { class: 'tnum muted', style: 'text-align:right' }, Number(m.today_in) ? '+' + fmtQty(m.today_in) : '—') },
    { key: 'today_out', label: 'Передано сег.', align: 'right', node: (m) => el('td', { class: 'tnum muted', style: 'text-align:right' }, Number(m.today_out) ? '−' + fmtQty(m.today_out) : '—') },
    { key: 'unit', label: 'Ед.', get: (m) => m.unit || '' },
    { key: 'actions', label: '', always: true, align: 'right', node: (m) => el('td', { style: 'text-align:right;white-space:nowrap' }, [
      // Корректировку прячем при просмотре прошлой даты — править можно только текущий остаток.
      ...(invDate && invDate < todayISO() ? [] : [el('button', { class: 'inv-mini', title: 'Корректировка (инвентаризация)', onclick: () => openAdjust(m) }, '✏️')]),
      el('button', { class: 'inv-mini', style: 'margin-left:4px', title: 'История корректировок', onclick: () => openInvLog(m) }, '🕘'),
    ]) },
  ];
  const visibleStkCols = () => STK_COLS.filter((c) => c.always || !stkColsHidden.has(c.key));
  async function viewInventory() {
    const main = $('#stk-main');
    main.innerHTML = '';
    if (!invDate) invDate = todayISO();
    const isPast = invDate < todayISO();
    invData = await api('/inventory?date=' + invDate);
    const data = invData;
    // Выбор даты: остаток показывается на конец выбранного дня.
    const dateInp = el('input', { type: 'date', class: 'stk-datejump', value: invDate, max: todayISO(),
      onchange: (e) => { if (e.target.value) { invDate = e.target.value; invCount = false; viewInventory(); } } });
    const todayBtn = el('button', { class: 'inv-mini', title: 'Вернуться к сегодня', style: 'margin-left:6px',
      onclick: () => { if (invDate !== todayISO()) { invDate = todayISO(); viewInventory(); } } }, 'Сегодня');
    main.appendChild(el('div', { class: 'stk-head' }, [
      el('div', {}, [
        el('div', { class: 'stk-today' }, isPast ? ('Остатки на конец дня — ' + ruDate(invDate)) : 'Резюме склада — остатки для инвентаризации'),
        el('div', { class: 'stk-counts' }, [el('span', { id: 'inv-count' }, 'Позиций: ' + data.items.length)]),
      ]),
      el('div', { class: 'stk-datenav', style: 'display:flex;align-items:center;gap:4px' }, [
        el('label', { class: 'stk-datejump-lbl' }, ['Остаток на дату:', dateInp]), todayBtn,
        ...((typeof HUB_USER !== 'undefined' && HUB_USER.isAdmin) ? [
          el('button', { style: 'color:#c0392b;margin-left:12px', title: 'Полностью очистить остатки и всю историю склада', onclick: () => wipeStock(viewInventory) }, '🧹 Очистить весь склад'),
        ] : []),
      ]),
    ]));
    if (isPast) main.appendChild(el('div', { class: 'stk-past-note', style: 'margin:6px 0;padding:8px 12px;background:rgba(140,198,63,.14);border-radius:8px;font-size:14px' },
      '🕓 Показан остаток на конец ' + ruDate(invDate) + '. Пересчёт и корректировки доступны только на сегодня — нажмите «Сегодня».'));

    // Задача 1: фильтр по родительской категории + категории (каскад)
    const pcSel = el('select', { id: 'inv-pc' }, [
      el('option', { value: '' }, 'Все родит. категории'),
      ...data.parents.map((p) => el('option', { value: p.id }, p.name)),
    ]);
    const catSel = el('select', { id: 'inv-cat' }, []);
    function fillCats() {
      catSel.innerHTML = '';
      catSel.appendChild(el('option', { value: '' }, 'Все категории'));
      data.categories
        .filter((c) => !invPc || String(c.parent_id) === String(invPc))
        .forEach((c) => catSel.appendChild(el('option', { value: c.id }, c.name)));
    }
    fillCats();
    pcSel.addEventListener('change', () => { invPc = pcSel.value; invCat = ''; fillCats(); render(); });
    catSel.addEventListener('change', () => { invCat = catSel.value; render(); });

    const stockSel = el('select', { onchange: (e) => { invFilter = e.target.value; render(); } }, [
      el('option', { value: 'all' }, 'Все позиции'),
      el('option', { value: 'instock' }, '🟢 В наличии'),
      el('option', { value: 'nomove' }, '⚪ Пусто'),
    ]);
    stockSel.value = invFilter;

    // Кнопка настройки столбцов (⚙) с выпадающей панелью галочек.
    stkColsPanel = null;
    stkColsWrap = el('div', { class: 'stk-cols-wrap' }, [
      el('button', { class: 'inv-mini stk-cols-btn', title: 'Показать/скрыть столбцы', onclick: () => toggleStkCols() }, '⚙ Столбцы'),
    ]);
    function toggleStkCols() {
      if (stkColsPanel) { stkColsPanel.remove(); stkColsPanel = null; return; }
      stkColsPanel = el('div', { class: 'stk-cols-panel' }, STK_COLS.filter((c) => !c.always && c.label).map((c) =>
        el('label', { class: 'stk-cols-item' }, [
          el('input', { type: 'checkbox', checked: !stkColsHidden.has(c.key) || null, onchange: (e) => {
            if (e.target.checked) stkColsHidden.delete(c.key); else stkColsHidden.add(c.key);
            saveStkCols(); render();
          } }),
          el('span', {}, c.label),
        ])));
      stkColsWrap.appendChild(stkColsPanel);
    }

    const posChk = el('input', { type: 'checkbox' }); posChk.checked = invPositive;
    posChk.onchange = () => { invPositive = posChk.checked; render(); };
    main.appendChild(el('div', { class: 'pur-filters' }, [
      el('label', {}, ['Родит. категория', pcSel]),
      el('label', {}, ['Категория сырья', catSel]),
      el('label', {}, ['Наличие', stockSel]),
      el('label', { class: 'stk-check' }, [posChk, ' Только с остатком']),
      el('label', { style: 'flex:1' }, ['Поиск', el('input', { id: 'inv-q', placeholder: '🔍 артикул, наименование...', oninput: () => render() })]),
      el('div', { style: 'align-self:flex-end;padding-bottom:2px' }, [stkColsWrap]),
    ]));

    // Панель быстрого пересчёта: вкл/выкл режим, комментарий, «Провести».
    const countRefs = {}; // key → { input, deltaCell, balance, m }
    const toolbar = el('div', { class: 'stk-count-bar' });
    function buildToolbar() {
      toolbar.innerHTML = '';
      if (isPast) return; // на прошлую дату пересчёт недоступен
      if (!invCount) {
        toolbar.appendChild(el('button', { class: 'btn-primary', onclick: () => { invCount = true; render(); buildToolbar(); } }, '📋 Начать пересчёт'));
        toolbar.appendChild(el('span', { class: 'muted', style: 'font-size:13px;align-self:center' }, 'Введёте фактические остатки списком, система запишет расхождения одним действием.'));
      } else {
        const cInp = el('input', { placeholder: 'Причина пересчёта (напр. Инвентаризация ' + ruDate(todayISO()) + ')', value: invCountComment, style: 'min-width:280px;flex:1', oninput: (e) => { invCountComment = e.target.value; } });
        toolbar.appendChild(el('label', { style: 'flex:1' }, ['Комментарий', cInp]));
        toolbar.appendChild(el('button', { class: 'btn-primary', onclick: doCount }, '✅ Провести пересчёт'));
        toolbar.appendChild(el('button', { onclick: () => { invCount = false; render(); buildToolbar(); } }, 'Отмена'));
      }
    }
    buildToolbar();
    main.appendChild(toolbar);
    const box = el('div', { class: 'pur-content' });
    main.appendChild(box);

    function doCount() {
      if (!invCountComment.trim()) return toast('Укажите причину пересчёта', true);
      const changed = Object.values(countRefs)
        .filter((r) => r.input.value !== '' && !Number.isNaN(Number(r.input.value)))
        .map((r) => ({ item_kind: r.m.kind, item_id: r.m.id, factual: Number(r.input.value), balance: r.balance, name: r.m.name, unit: r.m.unit }))
        .filter((r) => Math.abs(r.factual - r.balance) > 1e-9);
      if (!changed.length) return toast('Расхождений нет — всё совпадает', true);
      const body = el('div', {}, [
        el('p', { style: 'font-size:15px' }, 'Будут записаны расхождения по ' + changed.length + ' позиц.:'),
        el('table', { class: 'dict-table' }, [
          el('thead', {}, el('tr', {}, ['Наименование', 'Было', 'Стало', 'Δ'].map((h) => el('th', {}, h)))),
          el('tbody', {}, changed.map((r) => {
            const d = r.factual - r.balance;
            return el('tr', {}, [
              el('td', { style: 'font-weight:600' }, r.name),
              el('td', { class: 'tnum muted' }, fmtQty(r.balance)),
              el('td', { class: 'tnum', style: 'font-weight:700' }, fmtQty(r.factual)),
              el('td', { class: 'tnum', style: 'color:' + (d >= 0 ? '#3f6a16' : 'var(--red)') }, (d > 0 ? '+' : '') + fmtQty(d)),
            ]);
          })),
        ]),
      ]);
      const cm = modal('Подтвердите пересчёт', body, [
        el('button', { onclick: () => cm.close() }, 'Отмена'),
        el('button', { class: 'btn-primary', onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            const r = await api('/inventory/adjust-bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ comment: invCountComment, items: changed.map((x) => ({ item_kind: x.item_kind, item_id: x.item_id, factual: x.factual })) }) });
            toast('Пересчёт проведён: ' + r.applied + ' позиц.');
            cm.close(); invCount = false; invCountComment = ''; viewInventory();
          } catch (e) { toast(e.message, true); ev.target.disabled = false; }
        } }, 'Провести'),
      ]);
    }

    function render() {
      const q = ($('#inv-q') ? $('#inv-q').value.trim().toLowerCase() : '');
      let items = invData.items.slice();
      if (invPc) items = items.filter((m) => String(m.pc_id) === String(invPc));
      if (invCat) items = items.filter((m) => String(m.category_id) === String(invCat));
      if (invFilter === 'instock') items = items.filter((m) => Number(m.balance) !== 0);
      else if (invFilter === 'nomove') items = items.filter((m) => Number(m.balance) === 0);
      if (invPositive) items = items.filter((m) => Number(m.balance) > 0);
      if (q) items = items.filter((m) => m.name.toLowerCase().includes(q) || String(m.code || '').toLowerCase().includes(q));
      if ($('#inv-count')) $('#inv-count').textContent = 'Позиций: ' + items.length;
      box.innerHTML = '';
      if (!items.length) { box.appendChild(el('p', { class: 'dict-empty' }, 'Нет позиций по фильтру.')); return; }
      for (const k in countRefs) delete countRefs[k];

      if (invCount) {
        // Режим быстрого пересчёта: факт по каждой позиции + живая дельта.
        const showChar = !stkColsHidden.has('char');
        const heads = ['#', 'Артикул', 'Наименование', showChar ? 'Характеристика' : null, 'Остаток (было)', 'Факт (пересчёт)', 'Δ', 'Ед.'].filter(Boolean);
        box.appendChild(el('table', { class: 'dict-table' }, [
          el('thead', {}, el('tr', {}, heads.map((h) => el('th', { style: /Остаток|Факт|Δ/.test(h) ? 'text-align:right' : '' }, h)))),
          el('tbody', {}, items.map((m, idx) => {
            const bal = Number(m.balance);
            const key = m.kind + ':' + m.id;
            const deltaCell = el('td', { class: 'tnum', style: 'text-align:right;font-weight:700' }, '—');
            const input = el('input', { type: 'number', step: 'any', class: 'stk-fact', value: bal,
              oninput: () => {
                const d = Number(input.value) - bal;
                if (input.value === '' || Number.isNaN(Number(input.value))) { deltaCell.textContent = '—'; deltaCell.style.color = ''; return; }
                deltaCell.textContent = (d > 0 ? '+' : '') + fmtQty(d);
                deltaCell.style.color = d === 0 ? 'var(--ink-faint)' : d > 0 ? '#3f6a16' : 'var(--red)';
              } });
            countRefs[key] = { input, deltaCell, balance: bal, m };
            return el('tr', { title: m.characteristics || '' }, [
              el('td', { class: 'tnum muted' }, String(idx + 1)),
              el('td', { class: 'tnum muted' }, m.code || ''),
              el('td', { style: 'font-weight:600' }, m.name + (m.kind === 'packaging' ? ' 📦' : '')),
              showChar ? el('td', { class: 'muted', style: 'max-width:320px' }, m.characteristics || '—') : null,
              el('td', { class: 'tnum muted', style: 'text-align:right' }, fmtQty(bal)),
              el('td', { style: 'text-align:right' }, input),
              deltaCell,
              el('td', {}, m.unit || ''),
            ].filter(Boolean));
          })),
        ]));
        return;
      }

      const cols = visibleStkCols();
      box.appendChild(el('table', { class: 'dict-table' }, [
        el('thead', {}, el('tr', {}, cols.map((c) => el('th', { style: c.align === 'right' ? 'text-align:right' : '' }, c.label)))),
        el('tbody', {}, items.map((m, idx) => el('tr', { title: m.characteristics || '' },
          cols.map((c) => c.node ? c.node(m, idx) : el('td', { class: c.cls || '', style: c.align === 'right' ? 'text-align:right' : '' }, c.get(m, idx)))))),
      ]));
    }
    render();
  }

  // задать первоначальный остаток (один раз)
  function openOpening(m) {
    const qty = el('input', { type: 'number', step: 'any', class: 'stk-fact', placeholder: '0' });
    const comment = el('input', { placeholder: 'Комментарий (необязательно)' });
    const body = el('div', { class: 'form-col', style: 'max-width:100%' }, [
      el('p', { class: 'muted' }, 'Первоначальный остаток вносится один раз — это стартовое количество на складе на момент запуска. Дальше остаток считается автоматически.'),
      el('label', {}, ['Стартовое количество, ' + (m.unit || 'ед.'), qty]),
      el('label', {}, ['Комментарий', comment]),
    ]);
    const mm = modal('➕ Первоначальный остаток — ' + m.name, body, [
      el('button', { onclick: () => mm.close() }, 'Отмена'),
      el('button', { class: 'btn-primary', onclick: async (ev) => {
        if (qty.value === '' || isNaN(Number(qty.value))) return toast('Укажите количество', true);
        ev.target.disabled = true;
        try {
          await api('/inventory/opening', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_kind: m.kind, item_id: m.id, qty: Number(qty.value), comment: comment.value }) });
          toast('Первоначальный остаток задан'); mm.close(); viewInventory();
        } catch (e) { toast(e.message, true); ev.target.disabled = false; }
      } }, 'Сохранить'),
    ]);
  }

  // корректировка (инвентаризация)
  function openAdjust(m) {
    const factual = el('input', { type: 'number', step: 'any', class: 'stk-fact', value: Number(m.balance) });
    const comment = el('input', { placeholder: 'Причина: пересчёт, усушка, бой...' });
    const body = el('div', { class: 'form-col', style: 'max-width:100%' }, [
      el('p', { class: 'muted' }, 'В системе сейчас: ' + fmtQty(m.balance) + ' ' + (m.unit || '') + '. Введите фактический остаток по пересчёту — система запишет разницу и сохранит след (кто, когда, причина).'),
      el('label', {}, ['Фактический остаток, ' + (m.unit || 'ед.'), factual]),
      el('label', {}, ['Причина корректировки *', comment]),
    ]);
    const mm = modal('✏️ Корректировка — ' + m.name, body, [
      el('button', { onclick: () => mm.close() }, 'Отмена'),
      el('button', { class: 'btn-primary', onclick: async (ev) => {
        if (factual.value === '' || isNaN(Number(factual.value))) return toast('Укажите фактический остаток', true);
        if (!comment.value.trim()) return toast('Укажите причину корректировки', true);
        ev.target.disabled = true;
        try {
          const r = await api('/inventory/adjust', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_kind: m.kind, item_id: m.id, factual: Number(factual.value), comment: comment.value }) });
          toast(r.note || ('Остаток скорректирован (Δ' + fmtQty(r.delta) + ')')); mm.close(); viewInventory();
        } catch (e) { toast(e.message, true); ev.target.disabled = false; }
      } }, 'Сохранить'),
    ]);
  }

  // история корректировок (логи кто/что/когда)
  async function openInvLog(m) {
    const d = await api('/inventory/log/' + m.kind + '/' + m.id);
    const reasonL = { opening: 'Первонач. остаток', adjust: 'Корректировка' };
    const body = el('div', {}, [
      d.items.length
        ? el('table', { class: 'dict-table' }, [
            el('thead', {}, el('tr', {}, ['Дата', 'Операция', 'Кол-во', 'Кто', 'Комментарий'].map((h) => el('th', {}, h)))),
            el('tbody', {}, d.items.map((r) =>
              el('tr', {}, [
                el('td', {}, new Date(r.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })),
                el('td', {}, reasonL[r.reason] || r.reason),
                el('td', { class: 'tnum', style: 'color:' + (Number(r.qty) >= 0 ? '#3f6a16' : 'var(--red)') }, (Number(r.qty) > 0 ? '+' : '') + fmtQty(r.qty)),
                el('td', {}, r.user_name || '—'),
                el('td', { class: 'muted' }, r.comment || ''),
              ])
            )),
          ])
        : el('p', { class: 'muted' }, 'Корректировок ещё не было.'),
    ]);
    const mm = modal('🕘 История — ' + m.name, body, [el('button', { onclick: () => mm.close() }, 'Закрыть')]);
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
  // Панель столбцов закрывается по клику вне неё.
  document.addEventListener('mousedown', (e) => {
    if (stkColsPanel && stkColsWrap && !stkColsWrap.contains(e.target)) { stkColsPanel.remove(); stkColsPanel = null; }
  });
  switchTab(location.hash.slice(1) || 'receiving');
})();
