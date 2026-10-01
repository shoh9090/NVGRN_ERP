// salesplan.js — экран плитки «План продаж» (ГП): недельная сетка спроса.
//
// Главное в поведении: пустая клетка и ноль — разные вещи. Пусто значит «не
// заполнено», 0 значит «решили ничего не планировать». Поэтому ноль не
// подставляется сам никогда, а итог по пустой строке — тире, а не 0.
//
// Период — только общим компонентом HubDateRange (режим week). Своих полей
// с датами здесь нет: этого требует единый интерфейс Hub.
(function () {
  const $ = (s) => document.querySelector(s);
  const canEdit = !!(window.HUB_USER && (window.HUB_USER.canEdit || window.HUB_USER.isAdmin));

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
    for (const c of [].concat(children)) { if (c == null) continue; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return n;
  };
  const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU'));
  const money = (n) => (n === null || n === undefined ? '—' : Math.round(Number(n)).toLocaleString('ru-RU') + ' сум');

  async function api(path, opts = {}) {
    const res = await fetch('/salesplan/api' + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
  }
  const jpost = (path, body) => api(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  function toast(msg, isErr) {
    const t = el('div', { class: 'toast' + (isErr ? ' toast-err' : '') }, msg);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4500);
  }
  function modal(title, bodyNode, actions) {
    const root = $('#spl-modal-root'); root.innerHTML = '';
    const close = () => (root.innerHTML = '');
    const overlay = el('div', { class: 'imp-overlay' });
    overlay.appendChild(el('div', { class: 'imp-panel pur-modal' }, [
      el('div', { class: 'imp-head' }, [el('h3', {}, title), el('button', { class: 'imp-x', onclick: close }, '✕')]),
      el('div', { class: 'imp-body pur-modal-body' }, [bodyNode]),
      actions && actions.length ? el('div', { class: 'imp-actions' }, actions) : null,
    ]));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    root.appendChild(overlay);
    return { close };
  }

  // ---------- состояние ----------
  const state = { from: '', to: '' };
  let META = null;
  let DATA = null;
  let drBtn = null;

  const todayIso = () => new Date().toLocaleDateString('sv-SE');      // ГГГГ-ММ-ДД в местной зоне
  const weekOf = (d) => window.HubDateRange.weekOf(d);
  const weekShift = (d, w) => window.HubDateRange.weekShift(d, w);

  // ---------- загрузка ----------
  async function load() {
    const content = $('#spl-content');
    content.innerHTML = '<div class="spl-empty">Загружаю…</div>';
    try {
      if (!META) META = await api('/meta');
      DATA = await api('/plan?from=' + state.from);
      renderGrid();
    } catch (e) {
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'spl-empty' }, 'Не получилось загрузить план: ' + e.message));
    }
  }

  function setWeek(from) {
    const [a, b] = weekOf(from);
    state.from = a; state.to = b;
    if (drBtn) drBtn.setPeriod({ from: a, to: b });
    load();
  }

  // ---------- строка фильтров ----------
  function bar() {
    drBtn = window.HubDateRange.create({
      mode: 'week', from: state.from, to: state.to,
      onChange: (v) => { state.from = v.from; state.to = v.to; load(); },
    });
    const right = el('div', { class: 'spl-right', style: 'margin-left:auto;display:flex;gap:8px;flex-wrap:wrap' }, [
      canEdit ? el('button', { class: 'pur-tbtn', onclick: copyDialog }, '⧉ Копировать неделю') : null,
      canEdit ? el('button', { class: 'pur-tbtn', onclick: factDialog }, '📈 Заполнить из факта') : null,
      el('a', { class: 'pur-tbtn', href: '/salesplan/api/export.xlsx?from=' + state.from }, '⬇ Excel'),
    ].filter(Boolean));
    return el('div', { class: 'hub-bar' }, [
      el('button', { class: 'spl-nav', title: 'Предыдущая неделя', onclick: () => setWeek(weekShift(state.from, -1)[0]) }, '‹'),
      drBtn,
      el('button', { class: 'spl-nav', title: 'Следующая неделя', onclick: () => setWeek(weekShift(state.from, 1)[0]) }, '›'),
      el('button', { class: 'pur-tbtn', onclick: () => setWeek(todayIso()) }, 'Текущая неделя'),
      right,
    ]);
  }

  // ---------- сетка ----------
  function renderGrid() {
    const content = $('#spl-content');
    content.innerHTML = '';
    const days = DATA.days;

    const total = DATA.totals;
    content.appendChild(el('p', { class: 'spl-hint' }, [
      el('b', {}, 'Неделя ' + DATA.week_label + ': '),
      fmt(total.qty) + ' шт, ' + money(total.money),
      total.noPrice ? el('span', { class: 'spl-nop' }, '  ·  без прайса: ' + total.noPrice + ' поз.') : null,
      el('span', {}, '  ·  пусто = не заполнено, 0 = запланировали ноль'),
    ]));

    for (const ch of DATA.channels) {
      const head = el('div', { class: 'spl-card-head' }, [
        el('h3', {}, ch.name),
        el('span', { class: 'spl-sum' }, fmt(ch.totals.qty) + ' шт'),
        el('span', { class: 'spl-note' }, money(ch.totals.money)),
        el('div', { class: 'spl-right' }, [
          canEdit ? el('button', { class: 'pur-tbtn', onclick: () => addRowsDialog(ch.code, ch.name) }, '+ Товары') : null,
        ].filter(Boolean)),
      ]);

      const thead = el('thead', {}, el('tr', {}, [
        el('th', { class: 'spl-prod' }, 'Товар'),
        el('th', { class: 'spl-price' }, 'Прайс-лист'),
      ].concat(days.map((d) => el('th', { class: 'spl-cell' + (d.wd === 'Сб' || d.wd === 'Вс' ? ' spl-we' : '') },
        [el('div', {}, d.wd), el('div', { class: 'spl-note' }, d.day.slice(8, 10) + '.' + d.day.slice(5, 7))])))
        .concat([
          el('th', { class: 'spl-tot' }, 'Итого, шт'),
          el('th', { class: 'spl-money' }, 'Итого, сум'),
          el('th', {}, ''),
        ])));

      const tbody = el('tbody', {});
      if (!ch.rows.length) {
        tbody.appendChild(el('tr', {}, el('td', { class: 'spl-empty', colspan: days.length + 5 },
          'Товаров пока нет. ' + (canEdit ? 'Нажмите «+ Товары» или «Заполнить из факта».' : ''))));
      }
      ch.rows.forEach((r, i) => tbody.appendChild(rowNode(r, days, ch, i)));

      const tfoot = el('tfoot', {}, el('tr', { class: 'spl-foot' }, [
        el('td', { class: 'spl-prod' }, 'Итого ' + ch.name),
        el('td', {}, ''),
      ].concat(days.map((d) => el('td', { class: 'spl-cell', 'data-ch-day': ch.code + '|' + d.day }, fmt(ch.totals.byDay[d.day].qty))))
        .concat([
          el('td', { class: 'spl-tot', 'data-ch-tot': ch.code }, fmt(ch.totals.qty)),
          el('td', { class: 'spl-money', 'data-ch-money': ch.code }, money(ch.totals.money)),
          el('td', {}, ''),
        ])));

      content.appendChild(el('div', { class: 'spl-card' }, [
        head, el('div', { class: 'spl-wrap' }, el('table', { class: 'spl-tbl' }, [thead, tbody, tfoot])),
      ]));
    }
  }

  function rowNode(r, days, ch) {
    const tr = el('tr', { 'data-row': r.id });
    tr.appendChild(el('td', { class: 'spl-prod' }, [
      el('div', {}, r.product_name),
      r.note ? el('div', { class: 'spl-note' }, r.note) : null,
    ].filter(Boolean)));

    // Прайс-лист — выбор отдела продаж: по какому прайсу пойдёт это количество.
    const pb = el('button', {
      class: 'spl-pricebtn' + (r.price === null ? ' spl-none' : ''),
      title: r.price === null ? 'Цена не определена — деньги по этой строке не считаются' : 'Сменить прайс-лист',
      onclick: canEdit ? () => priceDialog(r) : null,
    }, r.price_type_name || 'выбрать прайс');
    // Цена и факт — отдельной строкой под названием прайса: в одну строку они
    // не помещались и цена обрезалась на середине («23 00» вместо «23 000»).
    const sub = [];
    if (r.price !== null) sub.push(fmt(r.price) + ' сум');
    if (r.fact_price) sub.push('факт ≈ ' + fmt(r.fact_price));
    tr.appendChild(el('td', { class: 'spl-price' }, [pb,
      sub.length ? el('div', { class: 'spl-note' }, sub.join(' · ')) : null].filter(Boolean)));

    for (const d of days) {
      const v = r.cells[d.day];
      const inp = el('input', {
        class: 'spl-inp', inputmode: 'numeric', autocomplete: 'off',
        'data-row': r.id, 'data-day': d.day,
        value: v === undefined ? '' : String(v),
        readonly: !canEdit,
        title: r.src[d.day] ? srcLabel(r.src[d.day]) : '',
      });
      paintInp(inp, v, r.src[d.day]);
      if (canEdit) {
        inp.addEventListener('focus', () => inp.select());
        inp.addEventListener('change', () => saveCell(inp, r, ch));
        inp.addEventListener('keydown', (e) => keyNav(e, inp));
      }
      tr.appendChild(el('td', { class: 'spl-cell' + (d.wd === 'Сб' || d.wd === 'Вс' ? ' spl-we' : '') }, inp));
    }

    // Итог недели по строке можно ввести одним числом — разложится по дням.
    const tot = el('input', {
      class: 'spl-inp spl-tot', style: 'width:70px', inputmode: 'numeric', autocomplete: 'off',
      value: r.total === null ? '' : String(r.total), readonly: !canEdit,
      title: canEdit ? 'Можно ввести количество на неделю — разложу по дням в пропорции фактических продаж' : '',
    });
    if (canEdit) {
      tot.addEventListener('focus', () => tot.select());
      tot.addEventListener('change', () => spreadRow(tot, r, ch));
      tot.addEventListener('keydown', (e) => { if (e.key === 'Enter') tot.blur(); });
    }
    tr.appendChild(el('td', { class: 'spl-tot', 'data-tot': r.id }, tot));
    tr.appendChild(el('td', { class: 'spl-money', 'data-money': r.id }, money(r.money)));
    tr.appendChild(el('td', {}, canEdit
      ? el('button', { class: 'spl-x', title: 'Убрать товар из сетки (цифры останутся)', onclick: () => hideRow(r, ch) }, '✕')
      : ''));
    return tr;
  }

  const srcLabel = (s) => ({
    manual: 'введено вручную', fact: 'взято из факта продаж', copy: 'скопировано с другой недели',
    spread: 'разложено по дням из недельной цифры', import: 'из импорта',
  }[s] || '');

  function paintInp(inp, v, src) {
    inp.classList.toggle('spl-zero', v === 0);
    inp.classList.toggle('spl-auto', !!src && src !== 'manual');
  }

  // ---------- правка клетки ----------
  async function saveCell(inp, r, ch) {
    const raw = inp.value.trim();
    inp.classList.add('spl-saving'); inp.classList.remove('spl-err');
    try {
      const out = await jpost('/cell', { row_id: r.id, day: inp.dataset.day, qty: raw === '' ? null : raw });
      if (out.qty === null) { delete r.cells[inp.dataset.day]; delete r.src[inp.dataset.day]; inp.value = ''; }
      else { r.cells[inp.dataset.day] = out.qty; r.src[inp.dataset.day] = 'manual'; inp.value = String(out.qty); }
      inp.title = srcLabel(r.src[inp.dataset.day]);
      paintInp(inp, r.cells[inp.dataset.day], r.src[inp.dataset.day]);
      recalc(ch);
    } catch (e) {
      inp.classList.add('spl-err');
      toast(e.message, true);
    } finally { inp.classList.remove('spl-saving'); }
  }

  async function spreadRow(inp, r, ch) {
    const raw = inp.value.trim();
    if (raw === '') { inp.value = r.total === null ? '' : String(r.total); return; }
    if (Number(raw) === Number(r.total)) return;        // не трогали — не переписываем дни
    inp.classList.add('spl-saving');
    try {
      const out = await jpost('/spread', { row_id: r.id, week: state.from, total: raw });
      for (const [day, qty] of Object.entries(out.days)) {
        r.cells[day] = qty; r.src[day] = 'spread';
        const cell = document.querySelector('.spl-inp[data-row="' + r.id + '"][data-day="' + day + '"]');
        if (cell) { cell.value = String(qty); cell.title = srcLabel('spread'); paintInp(cell, qty, 'spread'); }
      }
      recalc(ch);
      toast(out.basis === 'fact'
        ? 'Разложил по дням в пропорции фактических продаж за 8 недель — поправьте вручную, где надо'
        : 'Факта по этому товару нет, разложил ровно по дням — это не профиль спроса, поправьте вручную');
    } catch (e) {
      inp.value = r.total === null ? '' : String(r.total);
      toast(e.message, true);
    } finally { inp.classList.remove('spl-saving'); }
  }

  // Пересчёт итогов на экране: без перезагрузки, чтобы ввод не прерывался.
  function recalc(ch) {
    const days = DATA.days.map((d) => d.day);
    let qty = null, money_ = null;
    const byDay = {};
    for (const d of days) byDay[d] = { qty: null, money: null };
    for (const r of ch.rows) {
      let rq = null;
      for (const d of days) {
        const v = r.cells[d];
        if (v === undefined || v === null) continue;
        rq = (rq || 0) + v;
        byDay[d].qty = (byDay[d].qty || 0) + v;
        qty = (qty || 0) + v;
        if (r.price !== null) {
          byDay[d].money = (byDay[d].money || 0) + v * r.price;
          money_ = (money_ || 0) + v * r.price;
        }
      }
      r.total = rq;
      r.money = rq !== null && r.price !== null ? rq * r.price : null;
      const tot = document.querySelector('[data-tot="' + r.id + '"] .spl-inp');
      if (tot && document.activeElement !== tot) tot.value = rq === null ? '' : String(rq);
      const m = document.querySelector('[data-money="' + r.id + '"]');
      if (m) m.textContent = money(r.money);
    }
    ch.totals = { byDay, qty, money: money_, noPrice: ch.rows.filter((r) => r.price === null).length };
    for (const d of days) {
      const c = document.querySelector('[data-ch-day="' + ch.code + '|' + d + '"]');
      if (c) c.textContent = fmt(byDay[d].qty);
    }
    const t = document.querySelector('[data-ch-tot="' + ch.code + '"]');
    if (t) t.textContent = fmt(qty);
    const mm = document.querySelector('[data-ch-money="' + ch.code + '"]');
    if (mm) mm.textContent = money(money_);
    // Общий итог недели в подсказке сверху — считаем по всем направлениям.
    let aq = null, am = null, np = 0;
    for (const c of DATA.channels) {
      if (c.totals.qty !== null) aq = (aq || 0) + c.totals.qty;
      if (c.totals.money !== null) am = (am || 0) + c.totals.money;
      np += c.totals.noPrice || 0;
    }
    DATA.totals = { qty: aq, money: am, noPrice: np };
    const hint = document.querySelector('.spl-hint');
    if (hint) {
      hint.innerHTML = '';
      hint.appendChild(el('b', {}, 'Неделя ' + DATA.week_label + ': '));
      hint.appendChild(document.createTextNode(fmt(aq) + ' шт, ' + money(am)));
      if (np) hint.appendChild(el('span', { class: 'spl-nop' }, '  ·  без прайса: ' + np + ' поз.'));
      hint.appendChild(el('span', {}, '  ·  пусто = не заполнено, 0 = запланировали ноль'));
    }
  }

  // Enter и стрелки — как в Excel: вниз по колонке, вверх, влево-вправо.
  function keyNav(e, inp) {
    const go = (dRow, dCol) => {
      const tr = inp.closest('tr');
      const tbody = tr.parentNode;
      const rows = [...tbody.querySelectorAll('tr')];
      const cells = [...tr.querySelectorAll('.spl-inp[data-day]')];
      const col = cells.indexOf(inp);
      let target = null;
      if (dCol) target = cells[col + dCol];
      else {
        const ri = rows.indexOf(tr);
        const nr = rows[ri + dRow];
        if (nr) target = nr.querySelectorAll('.spl-inp[data-day]')[col];
      }
      if (target) { e.preventDefault(); target.focus(); }
    };
    if (e.key === 'Enter' || e.key === 'ArrowDown') go(1, 0);
    else if (e.key === 'ArrowUp') go(-1, 0);
    else if (e.key === 'ArrowLeft' && inp.selectionStart === 0) go(0, -1);
    else if (e.key === 'ArrowRight' && inp.selectionStart === inp.value.length) go(0, 1);
  }

  // ---------- окна ----------
  function priceDialog(r) {
    const body = el('div', {}, el('div', { class: 'spl-empty' }, 'Загружаю прайсы…'));
    const m = modal('Прайс-лист: ' + r.product_name, body);
    api('/prices/' + r.product_id).then((d) => {
      body.innerHTML = '';
      body.appendChild(el('p', { class: 'spl-hint' }, 'По какому прайсу пойдёт это количество. '
        + (r.fact_price ? 'Фактическая средняя цена продажи за 4 недели ≈ ' + fmt(r.fact_price) + ' сум.' : 'Факта продаж за 4 недели нет.')));
      const list = el('div', { class: 'spl-plist' });
      for (const p of d.items) {
        list.appendChild(el('button', { class: p.id === r.price_type_id ? 'on' : '', onclick: async () => {
          try {
            await jpost('/row/' + r.id, { price_type_id: p.id });
            m.close(); load();
          } catch (e) { toast(e.message, true); }
        } }, [
          el('span', {}, p.name),
          p.price === null ? el('span', { class: 'spl-pnone' }, 'нет цены') : el('span', { class: 'spl-pval' }, fmt(p.price) + ' сум'),
        ]));
      }
      if (!d.items.length) list.appendChild(el('div', { class: 'spl-empty' }, 'Прайс-листы из SalesDoctor ещё не загружены'));
      body.appendChild(list);

      const note = el('input', { value: r.note || '', placeholder: 'Примечание к строке, например «под заказом»', style: 'width:100%;margin-top:12px' });
      body.appendChild(note);
      body.appendChild(el('div', { class: 'imp-actions', style: 'margin-top:10px' }, [
        el('button', { class: 'pur-tbtn', onclick: async () => {
          try { await jpost('/row/' + r.id, { note: note.value }); m.close(); load(); }
          catch (e) { toast(e.message, true); }
        } }, 'Сохранить примечание'),
      ]));
    }).catch((e) => { body.innerHTML = ''; body.appendChild(el('div', { class: 'spl-empty' }, e.message)); });
  }

  function addRowsDialog(channel, channelName) {
    const chan = (META.channels || []).find((c) => c.code === channel) || {};
    const inGrid = new Set();
    for (const ch of DATA.channels) if (ch.code === channel) for (const r of ch.rows) inGrid.add(r.product_id);
    // Сначала товары, у которых направление торговли из SD совпало с этим
    // направлением: обычно именно их и добавляют.
    const sameTrade = (p) => String(p.trade_direction || '').trim().toLowerCase()
      === String(chan.sd_trade || '').trim().toLowerCase();
    const all = (META.products || []).filter((p) => !inGrid.has(p.id))
      .sort((a, b) => (sameTrade(b) - sameTrade(a)) || a.name.localeCompare(b.name, 'ru'));

    const search = el('input', { placeholder: 'Поиск по названию', style: 'width:100%;margin-bottom:10px' });
    const list = el('div', { class: 'spl-pick' });
    const picked = new Set();
    const paint = () => {
      list.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      const shown = all.filter((p) => !q || p.name.toLowerCase().includes(q));
      if (!shown.length) list.appendChild(el('div', { class: 'spl-empty' }, 'Ничего не найдено'));
      for (const p of shown.slice(0, 400)) {
        const cb = el('input', { type: 'checkbox', checked: picked.has(p.id) });
        cb.addEventListener('change', () => { cb.checked ? picked.add(p.id) : picked.delete(p.id); });
        list.appendChild(el('label', {}, [cb, el('span', {}, p.name),
          el('span', { class: 'spl-tr' }, p.trade_direction || 'направление в SD не указано')]));
      }
    };
    search.addEventListener('input', paint);
    paint();

    const body = el('div', {}, [
      el('p', { class: 'spl-hint' }, 'Товары берутся из справочника готовой продукции (приходит из SalesDoctor). '
        + 'Сверху — те, у кого направление торговли в SD совпадает с «' + channelName + '».'),
      search, list,
    ]);
    const m = modal('Добавить товары: ' + channelName, body, [
      el('button', { class: 'pur-tbtn', onclick: async () => {
        if (!picked.size) return toast('Отметьте хотя бы один товар', true);
        try {
          const out = await jpost('/rows', { channel, product_ids: [...picked] });
          m.close();
          toast('Добавлено строк: ' + out.added + (out.exists ? ', уже были: ' + out.exists : ''));
          load();
        } catch (e) { toast(e.message, true); }
      } }, 'Добавить'),
    ]);
  }

  function copyDialog() {
    const src = weekShift(state.from, -1)[0];
    const over = el('input', { type: 'checkbox' });
    const body = el('div', {}, [
      el('p', { class: 'spl-hint' }, 'Скопирую план с недели ' + window.HubDateRange.labelWeek(src)
        + ' на ' + window.HubDateRange.labelWeek(state.from) + ' — по дням недели: понедельник в понедельник.'),
      el('label', { style: 'display:flex;gap:8px;align-items:center' }, [over, el('span', {}, 'Перезаписать клетки, которые уже заполнены')]),
    ]);
    const m = modal('Копировать прошлую неделю', body, [
      el('button', { class: 'pur-tbtn', onclick: async () => {
        try {
          const out = await jpost('/copy', { from: src, to: state.from, overwrite: over.checked });
          m.close(); toast('Перенесено клеток: ' + out.cells); load();
        } catch (e) { toast(e.message, true); }
      } }, 'Копировать'),
    ]);
  }

  function factDialog() {
    const src = weekShift(state.from, -1)[0];
    const body = el('div', {}, [
      el('p', { class: 'spl-hint' }, 'Возьму фактические отгрузки недели ' + window.HubDateRange.labelWeek(src)
        + ' из SalesDoctor и положу их в план этой недели по тем же дням недели. '
        + 'Уже заполненные клетки не трогаю. Направление определяю по «Направлению торговли» товара в SD.'),
    ]);
    const m = modal('Заполнить из факта', body, [
      el('button', { class: 'pur-tbtn', onclick: async () => {
        try {
          const out = await jpost('/fill-fact', { from: src, to: state.from });
          m.close();
          let msg = 'Заполнено клеток: ' + out.cells + ', строк: ' + out.rows;
          if (out.note) msg = out.note;
          if (out.skipped_total) msg += '. Не определилось направление у ' + out.skipped_total + ' товаров: ' + out.skipped.join(', ');
          toast(msg, !out.cells);
          load();
        } catch (e) { toast(e.message, true); }
      } }, 'Заполнить'),
    ]);
  }

  async function hideRow(r, ch) {
    if (!confirm('Убрать «' + r.product_name + '» из сетки? Введённые цифры останутся в истории.')) return;
    try { await jpost('/row/' + r.id + '/delete', {}); load(); }
    catch (e) { toast(e.message, true); }
  }

  // ---------- старт ----------
  const [a, b] = weekOf(todayIso());
  state.from = a; state.to = b;
  const main = $('#spl-main');
  main.appendChild(el('div', { id: 'spl-bar' }));
  main.appendChild(el('div', { id: 'spl-content' }));
  $('#spl-bar').appendChild(bar());
  load();
})();
