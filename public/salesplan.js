// salesplan.js — экран плитки «План продаж» (ГП): недельная сетка спроса.
//
// Сетка полная сразу, как в Excel: все товары направления уже стоят строками,
// РОП только вбивает количества по столбцам. Строка в базе заводится сама, в
// момент первой введённой цифры — «добавить товар» отдельным действием не нужно.
//
// Пустая клетка и ноль — разные вещи. Пусто значит «не заполнено», 0 значит
// «решили ничего не планировать». Ноль не подставляется сам никогда, а итог по
// пустой строке — тире, а не 0.
//
// Период — только общим компонентом HubDateRange (режим week). Своих полей
// с датами здесь нет: этого требует единый интерфейс Hub.
(function () {
  const $ = (s) => document.querySelector(s);
  const canEdit = !!(window.HUB_USER && window.HUB_USER.canEdit);

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

  const todayIso = () => new Date().toLocaleDateString('sv-SE');
  const weekOf = (d) => window.HubDateRange.weekOf(d);
  const weekShift = (d, w) => window.HubDateRange.weekShift(d, w);
  // Строки в базе может ещё не быть: сетка показывает весь ассортимент
  // направления, а запись заводится в момент первой введённой цифры.
  const ref = (ch, r) => (r.id ? { row_id: r.id } : { channel: ch.code, product_id: r.product_id });

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
      total.noPrice ? el('span', { class: 'spl-nop' }, '  ·  без цены: ' + total.noPrice + ' поз.') : null,
      el('span', {}, canEdit ? '  ·  пусто = не заполнено, 0 = запланировали ноль'
        : '  ·  только просмотр: менять план может руководитель отдела продаж'),
    ]));

    for (const ch of DATA.channels) {
      const head = el('div', { class: 'spl-card-head' }, [
        el('h3', {}, ch.name),
        el('span', { class: 'spl-sum' }, fmt(ch.totals.qty) + ' шт'),
        el('span', { class: 'spl-note' }, money(ch.totals.money)),
        el('div', { class: 'spl-right' }, [
          el('button', {
            class: 'spl-pricebtn' + (ch.default_price_type_id ? '' : ' spl-none'),
            title: 'Прайс-лист всего направления',
            onclick: canEdit ? () => channelPriceDialog(ch) : null,
          }, 'Прайс: ' + (ch.default_price_type_name || 'не выбран')),
          canEdit ? el('button', { class: 'pur-tbtn', onclick: () => addRowsDialog(ch) }, '+ Товар') : null,
        ].filter(Boolean)),
      ]);

      const thead = el('thead', {}, el('tr', {}, [
        el('th', { class: 'spl-prod' }, 'Товар'),
      ].concat(days.map((d) => el('th', { class: 'spl-cell' + (d.wd === 'Сб' || d.wd === 'Вс' ? ' spl-we' : '') },
        [el('div', {}, d.wd), el('div', { class: 'spl-note' }, d.day.slice(8, 10) + '.' + d.day.slice(5, 7))])))
        .concat([
          el('th', { class: 'spl-tot' }, 'Итого, шт'),
          el('th', { class: 'spl-money' }, 'Итого, сум'),
        ])));

      const tbody = el('tbody', {});
      if (!ch.rows.length) {
        tbody.appendChild(el('tr', {}, el('td', { class: 'spl-empty', colspan: days.length + 3 },
          'Нет товаров с направлением «' + ch.name + '» в справочнике готовой продукции. '
          + 'Направление приходит из SalesDoctor; добавить товар вручную — кнопкой «+ Товар».')));
      }
      ch.rows.forEach((r) => tbody.appendChild(rowNode(r, days, ch)));

      const tfoot = el('tfoot', {}, el('tr', { class: 'spl-foot' }, [
        el('td', { class: 'spl-prod' }, 'Итого ' + ch.name),
      ].concat(days.map((d) => el('td', { class: 'spl-cell', 'data-ch-day': ch.code + '|' + d.day }, fmt(ch.totals.byDay[d.day].qty))))
        .concat([
          el('td', { class: 'spl-tot', 'data-ch-tot': ch.code }, fmt(ch.totals.qty)),
          el('td', { class: 'spl-money', 'data-ch-money': ch.code }, money(ch.totals.money)),
        ])));

      content.appendChild(el('div', { class: 'spl-card' }, [
        head, el('div', { class: 'spl-wrap' }, el('table', { class: 'spl-tbl' }, [thead, tbody, tfoot])),
      ]));
    }
  }

  function rowNode(r, days, ch) {
    const tr = el('tr', { 'data-prod': ch.code + '|' + r.product_id });
    // Цена и прайс — в подсказке под названием: колонка «прайс-лист» съедала
    // половину экрана, а нужна она редко (прайс задан у всего направления).
    const sub = [];
    if (r.price !== null) sub.push(fmt(r.price) + ' сум');
    else sub.push('нет цены');
    if (r.price_own && r.price_type_name) sub.push('прайс: ' + r.price_type_name);
    if (r.note) sub.push(r.note);
    const nameCell = el('td', { class: 'spl-prod' }, [
      el('div', {}, r.product_name),
      el('button', {
        class: 'spl-sub' + (r.price === null ? ' spl-nop' : ''),
        title: canEdit ? 'Прайс и примечание для этого товара' : 'Цена по прайсу направления',
        onclick: canEdit ? () => priceDialog(r, ch) : null,
      }, sub.join(' · ')),
    ]);
    tr.appendChild(nameCell);

    for (const d of days) {
      const v = r.cells[d.day];
      const inp = el('input', {
        class: 'spl-inp', inputmode: 'numeric', autocomplete: 'off',
        'data-prod': r.product_id, 'data-day': d.day,
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
    tr.appendChild(el('td', { class: 'spl-tot', 'data-tot': r.product_id }, tot));
    tr.appendChild(el('td', { class: 'spl-money', 'data-money': r.product_id }, money(r.money)));
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
      const out = await jpost('/cell', Object.assign(ref(ch, r), { day: inp.dataset.day, qty: raw === '' ? null : raw }));
      r.id = out.row_id;
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
      const out = await jpost('/spread', Object.assign(ref(ch, r), { week: state.from, total: raw }));
      r.id = out.row_id;
      for (const [day, qty] of Object.entries(out.days)) {
        r.cells[day] = qty; r.src[day] = 'spread';
        const cell = inp.closest('tr').querySelector('.spl-inp[data-day="' + day + '"]');
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
    const card = document.querySelector('[data-ch-tot="' + ch.code + '"]').closest('.spl-card');
    let qty = null, money_ = null, noPrice = 0;
    const byDay = {};
    for (const d of days) byDay[d] = { qty: null, money: null };
    for (const r of ch.rows) {
      if (r.price === null) noPrice++;
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
      const tot = card.querySelector('[data-tot="' + r.product_id + '"] .spl-inp');
      if (tot && document.activeElement !== tot) tot.value = rq === null ? '' : String(rq);
      const m = card.querySelector('[data-money="' + r.product_id + '"]');
      if (m) m.textContent = money(r.money);
    }
    ch.totals = { byDay, qty, money: money_, noPrice };
    for (const d of days) {
      const c = document.querySelector('[data-ch-day="' + ch.code + '|' + d + '"]');
      if (c) c.textContent = fmt(byDay[d].qty);
    }
    document.querySelector('[data-ch-tot="' + ch.code + '"]').textContent = fmt(qty);
    document.querySelector('[data-ch-money="' + ch.code + '"]').textContent = money(money_);
    card.querySelector('.spl-sum').textContent = fmt(qty) + ' шт';

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
      if (np) hint.appendChild(el('span', { class: 'spl-nop' }, '  ·  без цены: ' + np + ' поз.'));
      hint.appendChild(el('span', {}, '  ·  пусто = не заполнено, 0 = запланировали ноль'));
    }
  }

  // Enter и стрелки — как в Excel: вниз по колонке, вверх, влево-вправо.
  function keyNav(e, inp) {
    const go = (dRow, dCol) => {
      const tr = inp.closest('tr');
      const rows = [...tr.parentNode.querySelectorAll('tr')];
      const cells = [...tr.querySelectorAll('.spl-inp[data-day]')];
      const col = cells.indexOf(inp);
      let target = null;
      if (dCol) target = cells[col + dCol];
      else {
        const nr = rows[rows.indexOf(tr) + dRow];
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
  function priceDialog(r, ch) {
    const body = el('div', {}, el('div', { class: 'spl-empty' }, 'Загружаю прайсы…'));
    const m = modal('Товар: ' + r.product_name, body);
    api('/prices/' + r.product_id).then((d) => {
      body.innerHTML = '';
      body.appendChild(el('p', { class: 'spl-hint' }, 'Прайс только для этого товара — у всего направления он задаётся кнопкой «Прайс» в шапке. '
        + (r.fact_price ? 'Фактическая средняя цена продажи за 4 недели ≈ ' + fmt(r.fact_price) + ' сум.' : 'Факта продаж за 4 недели нет.')));
      const list = el('div', { class: 'spl-plist' });
      for (const p of d.items) {
        list.appendChild(el('button', { class: p.id === r.price_type_id ? 'on' : '', onclick: async () => {
          try { await jpost('/row-price', Object.assign(ref(ch, r), { price_type_id: p.id })); m.close(); load(); }
          catch (e) { toast(e.message, true); }
        } }, [
          el('span', {}, p.name),
          p.price === null ? el('span', { class: 'spl-pnone' }, 'нет цены') : el('span', { class: 'spl-pval' }, fmt(p.price) + ' сум'),
        ]));
      }
      if (!d.items.length) list.appendChild(el('div', { class: 'spl-empty' }, 'Прайс-листы из SalesDoctor ещё не загружены'));
      body.appendChild(list);

      const note = el('input', { value: r.note || '', placeholder: 'Примечание, например «под заказом»', style: 'width:100%;margin-top:12px' });
      body.appendChild(note);
      body.appendChild(el('div', { class: 'imp-actions', style: 'margin-top:10px' }, [
        el('button', { class: 'pur-tbtn', onclick: async () => {
          try { await jpost('/row-note', Object.assign(ref(ch, r), { note: note.value })); m.close(); load(); }
          catch (e) { toast(e.message, true); }
        } }, 'Сохранить примечание'),
      ]));
    }).catch((e) => { body.innerHTML = ''; body.appendChild(el('div', { class: 'spl-empty' }, e.message)); });
  }

  // Прайс всего направления: один выбор на весь список товаров.
  function channelPriceDialog(ch) {
    const body = el('div', {}, el('div', { class: 'spl-empty' }, 'Загружаю прайсы…'));
    const m = modal('Прайс-лист направления: ' + ch.name, body);
    const anyProduct = (ch.rows[0] && ch.rows[0].product_id) || 0;
    api('/prices/' + anyProduct).then((d) => {
      body.innerHTML = '';
      body.appendChild(el('p', { class: 'spl-hint' }, 'По этому прайсу считаются деньги всего направления. '
        + 'Цены в списке — для «' + ((ch.rows[0] && ch.rows[0].product_name) || 'товара') + '», для примера.'));
      const list = el('div', { class: 'spl-plist' });
      for (const p of d.items) {
        list.appendChild(el('button', { class: p.id === ch.default_price_type_id ? 'on' : '', onclick: async () => {
          try { await jpost('/channel-price', { channel: ch.code, price_type_id: p.id }); m.close(); load(); }
          catch (e) { toast(e.message, true); }
        } }, [
          el('span', {}, p.name),
          p.price === null ? el('span', { class: 'spl-pnone' }, 'нет цены') : el('span', { class: 'spl-pval' }, fmt(p.price) + ' сум'),
        ]));
      }
      if (!d.items.length) list.appendChild(el('div', { class: 'spl-empty' }, 'Прайс-листы из SalesDoctor ещё не загружены'));
      body.appendChild(list);
    }).catch((e) => { body.innerHTML = ''; body.appendChild(el('div', { class: 'spl-empty' }, e.message)); });
  }

  // Товар, у которого направление в SD не проставлено или другое.
  function addRowsDialog(ch) {
    const inGrid = new Set(ch.rows.map((r) => r.product_id));
    const search = el('input', { placeholder: 'Поиск по названию', style: 'width:100%;margin-bottom:10px' });
    const list = el('div', { class: 'spl-pick' });
    const picked = new Set();
    let ALL = null;
    const paint = () => {
      list.innerHTML = '';
      if (!ALL) { list.appendChild(el('div', { class: 'spl-empty' }, 'Загружаю справочник…')); return; }
      const q = search.value.trim().toLowerCase();
      const shown = ALL.filter((p) => !inGrid.has(p.id) && (!q || p.name.toLowerCase().includes(q)));
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
    api('/goods').then((d) => { ALL = d.items; paint(); }).catch(() => { ALL = []; paint(); });

    const body = el('div', {}, [
      el('p', { class: 'spl-hint' }, 'Сетка и так показывает все товары направления «' + ch.name
        + '» из справочника. Сюда добавляют те, у кого направление в SalesDoctor не проставлено или другое.'),
      search, list,
    ]);
    const m = modal('Добавить товар: ' + ch.name, body, [
      el('button', { class: 'pur-tbtn', onclick: async () => {
        if (!picked.size) return toast('Отметьте хотя бы один товар', true);
        try {
          await jpost('/rows', { channel: ch.code, product_ids: [...picked] });
          m.close(); load();
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
        + 'Уже заполненные клетки не трогаю.'),
    ]);
    const m = modal('Заполнить из факта', body, [
      el('button', { class: 'pur-tbtn', onclick: async () => {
        try {
          const out = await jpost('/fill-fact', { from: src, to: state.from });
          m.close();
          let msg = out.note || ('Заполнено клеток: ' + out.cells + ', товаров: ' + out.rows);
          if (out.skipped_total) msg += '. Не определилось направление у ' + out.skipped_total + ' товаров: ' + out.skipped.join(', ');
          toast(msg, !out.cells);
          load();
        } catch (e) { toast(e.message, true); }
      } }, 'Заполнить'),
    ]);
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
