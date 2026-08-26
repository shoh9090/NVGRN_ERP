// calculation.js — плитка «Калькуляция себестоимости».
//
// Собираем по образцу рабочего Excel: каждый лист Excel = вкладка внизу экрана.
// Готовы: «Производство», «Упаковка» и товарные листы (строки — расчёт,
// столбцы — товары).
//
// Денежных формул здесь НЕТ: суммы, «среднее на шт» и итоги приходят с сервера.
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
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
  const money = (v, dec = 2) => (v === null || v === undefined || Number.isNaN(Number(v)))
    ? '' : Number(v).toLocaleString('ru-RU', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const money0 = (v) => (v === null || v === undefined ? '' : Math.round(Number(v)).toLocaleString('ru-RU'));

  const api = async (path, opts) => {
    const r = await fetch('/calculation/api' + path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Ошибка сервера');
    return data;
  };
  const post = (path, body, method = 'POST') => api(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });

  let toastTimer = null;
  function toast(message, bad) {
    const old = $('.calc-toast'); if (old) old.remove();
    const t = el('div', { class: 'calc-toast' + (bad ? ' bad' : '') }, message);
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 3000);
  }

  // ---------------------------------------------------------------------------
  // Модалка и меню «⋯». Общие: пригодятся и утверждению расчёта.
  // ---------------------------------------------------------------------------
  function calcModal(title, bodyNode, actions) {
    const overlay = el('div', { class: 'calc-overlay' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); };
    function esc(e) { if (e.key === 'Escape') close(); }
    overlay.appendChild(el('div', { class: 'calc-panel' }, [
      el('div', { class: 'calc-panel-h' }, title),
      el('div', { class: 'calc-panel-b' }, bodyNode),
      el('div', { class: 'calc-panel-a' }, actions),
    ]));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(overlay);
    return { close };
  }

  // Выпадающее меню у кнопки «⋯». items: [{ label, danger, onClick }].
  // Крестик удаления стоял вплотную к полю штрих-кода — попасть по нему случайно
  // было слишком легко, поэтому опасное действие спрятано за два клика.
  function dotsMenu(btn, items) {
    const old = $('.calc-menu'); if (old) old.remove();
    const box = el('div', { class: 'calc-menu' }, items.map((it) => el('div', {
      class: 'calc-menu-it' + (it.danger ? ' danger' : ''),
      onclick: () => { box.remove(); it.onClick(); },
    }, it.label)));
    const r = btn.getBoundingClientRect();
    box.style.top = (r.bottom + window.scrollY + 4) + 'px';
    box.style.left = Math.max(8, r.right + window.scrollX - 180) + 'px';
    document.body.appendChild(box);
    setTimeout(() => {
      const off = (e) => { if (!box.contains(e.target)) { box.remove(); document.removeEventListener('click', off); } };
      document.addEventListener('click', off);
    }, 0);
  }

  // Листы, как внизу в Excel. Готовые открываются, остальные пока недоступны.
  const SHEETS = [
    { key: 'production', title: 'Производство', ready: true },
    { key: 'packaging', title: 'Упаковка', ready: true },
    { key: 'recipes', title: 'Рецептуры', ready: true },
    { key: 'retail', title: 'Рознич. тара', ready: true },
    { key: 'horeca250', title: 'Хорека 250г', ready: true },
    { key: 'horeca500', title: 'Хорека 500', ready: true },
    { key: 'salads', title: 'Салаты', ready: true },
    { key: 'bunches', title: 'Пучки и горшки', ready: true },
  ];
  // Товарные листы устроены одинаково, поэтому у них общий загрузчик и общий вид.
  const SKU_SHEETS = ['retail', 'horeca250', 'horeca500', 'salads', 'bunches'];
  let sheet = 'production';
  let DATA = null;
  const canEdit = () => !!(DATA && DATA.can_edit);

  // ---------------------------------------------------------------------------
  // Ячейка с суммой: правится на месте, сохраняется при уходе из поля
  // ---------------------------------------------------------------------------
  function cell(value, onSave, opts = {}) {
    if (!canEdit() || !onSave) {
      return el('div', { class: 'calc-cell calc-ro' + (opts.cls ? ' ' + opts.cls : '') },
        opts.dec === 0 ? money0(value) : money(value));
    }
    const inp = el('input', {
      type: 'text', inputmode: 'numeric', class: 'calc-cell' + (opts.cls ? ' ' + opts.cls : ''),
      value: opts.dec === 0 ? money0(value) : money(value),
      placeholder: opts.placeholder || '',
    });
    const clean = () => {
      const raw = String(inp.value).replace(/[^\d.,-]/g, '').replace(',', '.').trim();
      return raw === '' ? null : (Number(raw) || 0);
    };
    inp.addEventListener('focus', () => {
      const v = clean();
      inp.value = v === null ? '' : String(v);
      inp.select();
    });
    inp.addEventListener('blur', async () => {
      const v = clean();
      const was = value === null || value === undefined ? null : Number(value);
      inp.value = v === null ? '' : (opts.dec === 0 ? money0(v) : money(v));
      if (v === was) return;
      try { await onSave(v); await load(); } catch (e) { toast(e.message, true); }
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    return inp;
  }

  function nameCell(value, onSave) {
    if (!canEdit()) return el('div', { class: 'calc-name calc-ro', title: value || '' }, value);
    // Подсказка с полным названием — на случай, если поле уже текста.
    const inp = el('input', { type: 'text', class: 'calc-name', value: value || '', title: value || '' });
    inp.addEventListener('input', () => { inp.title = inp.value; });
    inp.addEventListener('blur', async () => {
      const v = inp.value.trim();
      if (!v) { inp.value = value; return; }
      if (v === value) return;
      try { await onSave(v); } catch (e) { toast(e.message, true); inp.value = value; }
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    return inp;
  }

  // Выбор НЕСКОЛЬКИХ статей ДДС Кассы: «фактич» = сумма по всем выбранным.
  // Пример: административные расходы — это статьи 41–48, но не 40.
  function cashPicker(item) {
    const chips = (item.categories || []).map((c) => el('span', { class: 'calc-chip', title: c.label }, c.label));
    if (!canEdit()) {
      return el('div', { class: 'calc-chips' }, chips.length ? chips : el('span', { class: 'calc-src-cell' }, '—'));
    }
    const btn = el('button', {
      class: 'calc-pick-btn',
      title: 'Выбрать статьи ДДС, из которых складывается факт',
      onclick: (e) => { e.stopPropagation(); openCatPicker(item, btn); },
    }, chips.length ? ('статей: ' + chips.length) : 'выбрать статьи');
    return el('div', { class: 'calc-chips' }, chips.concat([btn]));
  }

  // Панель выбора: список статей с галочками, поиск, выбор группой.
  let pickerEl = null;
  function closeCatPicker() { if (pickerEl) { pickerEl.remove(); pickerEl = null; } }
  document.addEventListener('click', () => closeCatPicker());

  function openCatPicker(item, anchor) {
    closeCatPicker();
    const selected = new Set((item.categories || []).map((c) => Number(c.id)));
    const all = DATA.cash_categories || [];

    // Группируем статьи по группам ДДС. Сервер отдаёт их уже отсортированными,
    // здесь только собираем в разделы, которые можно свернуть и раскрыть.
    const groups = [];
    const byName = new Map();
    all.forEach((c) => {
      const key = c.group || '—';
      if (!byName.has(key)) { const g = { name: key, items: [] }; byName.set(key, g); groups.push(g); }
      byName.get(key).items.push(c);
    });

    // По умолчанию раскрыты только группы, где уже что-то выбрано.
    const open = new Set(groups.filter((g) => g.items.some((c) => selected.has(Number(c.id)))).map((g) => g.name));

    const list = el('div', { class: 'calc-pick-list' });
    const counter = el('div', { class: 'calc-pick-count' }, '');
    const refreshCount = () => { counter.textContent = 'выбрано: ' + selected.size; };

    const draw = (q) => {
      list.innerHTML = '';
      const qq = (q || '').trim().toLowerCase();
      let shownAny = false;

      groups.forEach((g) => {
        const items = qq ? g.items.filter((c) => c.label.toLowerCase().includes(qq)) : g.items;
        if (!items.length) return;
        shownAny = true;
        const ids = items.map((c) => Number(c.id));
        const picked = ids.filter((id) => selected.has(id)).length;
        // При поиске раскрываем всё, чтобы найденное было видно сразу.
        const isOpen = qq ? true : open.has(g.name);

        const head = el('div', { class: 'calc-pick-group' + (isOpen ? ' open' : ''), onclick: (e) => {
          e.stopPropagation();
          if (qq) return;                       // при поиске сворачивать нечего
          if (open.has(g.name)) open.delete(g.name); else open.add(g.name);
          draw(q);
        } }, [
          el('span', { class: 'calc-pick-caret' }, isOpen ? '▾' : '▸'),
          el('span', { class: 'calc-pick-gname' }, g.name),
          picked ? el('span', { class: 'calc-pick-badge' }, String(picked)) : null,
          el('span', { class: 'calc-pick-gcount' }, items.length + ' шт'),
          el('button', {
            class: 'calc-pick-all',
            title: 'Отметить или снять всю группу',
            onclick: (e) => {
              e.stopPropagation();
              const allOn = ids.every((id) => selected.has(id));
              ids.forEach((id) => (allOn ? selected.delete(id) : selected.add(id)));
              open.add(g.name);
              draw(q); refreshCount();
            },
          }, ids.every((id) => selected.has(id)) ? 'снять группу' : 'вся группа'),
        ]);
        list.appendChild(head);

        if (!isOpen) return;
        const box = el('div', { class: 'calc-pick-items' });
        items.forEach((c) => {
          const cb = el('input', { type: 'checkbox', checked: selected.has(Number(c.id)) ? 'checked' : null });
          cb.addEventListener('change', (e) => {
            e.stopPropagation();
            if (cb.checked) selected.add(Number(c.id)); else selected.delete(Number(c.id));
            refreshCount();
            // Обновляем только счётчик группы, список не перерисовываем —
            // иначе слетает фокус и прокрутка.
            const badge = head.querySelector('.calc-pick-badge');
            const n = ids.filter((id) => selected.has(id)).length;
            if (badge) badge.textContent = String(n);
            else if (n) head.insertBefore(el('span', { class: 'calc-pick-badge' }, String(n)), head.children[2]);
          });
          box.appendChild(el('label', { class: 'calc-pick-item', onclick: (e) => e.stopPropagation() }, [cb, el('span', {}, c.label)]));
        });
        list.appendChild(box);
      });

      if (!shownAny) list.appendChild(el('div', { class: 'calc-pick-empty' }, 'Ничего не найдено'));
    };

    const search = el('input', { type: 'search', class: 'calc-pick-search', placeholder: 'Поиск статьи по названию или коду…' });
    search.addEventListener('input', () => draw(search.value));
    search.addEventListener('click', (e) => e.stopPropagation());

    const save = el('button', { class: 'calc-pick-save', onclick: async (e) => {
      e.stopPropagation();
      try {
        await post('/costs/' + item.id + '/categories', { ids: [...selected] });
        closeCatPicker();
        await load();
      } catch (err) { toast(err.message, true); }
    } }, 'Сохранить');

    const panel = el('div', { class: 'calc-pick', onclick: (e) => e.stopPropagation() }, [
      el('div', { class: 'calc-pick-head' }, [
        el('div', {}, [
          el('b', {}, item.name),
          el('div', { class: 'calc-pick-sub' }, 'Отметьте статьи ДДС — «фактич» сложится из них'),
        ]),
        counter,
      ]),
      search,
      list,
      el('div', { class: 'calc-pick-foot' }, [
        el('button', { class: 'calc-pick-clear', onclick: (e) => { e.stopPropagation(); selected.clear(); draw(search.value); refreshCount(); } }, 'Снять все'),
        el('div', { style: 'display:flex;gap:8px' }, [
          el('button', { class: 'calc-pick-cancel', onclick: (e) => { e.stopPropagation(); closeCatPicker(); } }, 'Отмена'),
          save,
        ]),
      ]),
    ]);

    draw(''); refreshCount();
    document.body.appendChild(panel);

    // Ставим панель рядом с кнопкой, но не даём вылезти за экран.
    const r = anchor.getBoundingClientRect();
    const h = Math.min(panel.offsetHeight || 480, window.innerHeight - 24);
    panel.style.top = Math.max(12, Math.min(r.bottom + 6, window.innerHeight - h - 12)) + 'px';
    panel.style.left = Math.max(12, Math.min(r.left, window.innerWidth - panel.offsetWidth - 12)) + 'px';
    pickerEl = panel;
    setTimeout(() => search.focus(), 40);
  }

  // ---------------------------------------------------------------------------
  function showLoading() {
    const main = $('#calc-main');
    if (main.querySelector('.calc-t')) return;   // уже что-то показано — не мигаем
    main.innerHTML = '';
    main.appendChild(el('div', { class: 'calc-loading' }, [
      el('div', { class: 'calc-skel', style: 'width:220px' }),
      el('div', { class: 'calc-skel', style: 'width:100%' }),
      el('div', { class: 'calc-skel', style: 'width:100%' }),
      el('div', { class: 'calc-skel', style: 'width:70%' }),
    ]));
  }

  async function load() {
    showLoading();
    if (sheet === 'packaging') return loadPackaging();
    if (sheet === 'recipes') return loadRecipes();
    if (SKU_SHEETS.includes(sheet)) return loadSku();
    let d;
    try { d = await api('/production?period=' + (DATA ? DATA.period : '')); }
    catch (e) {
      const main = $('#calc-main'); main.innerHTML = '';
      main.appendChild(el('div', { class: 'calc-empty' }, 'Не удалось загрузить: ' + e.message));
      return;
    }
    DATA = d;
    render();
  }

  // Факт производства обновляется ТОЛЬКО по кнопке: SalesDoctor отвечает
  // медленно, и дёргать его при каждом открытии экрана незачем.
  let factLoading = false;
  async function refreshFact(months) {
    if (factLoading) return;
    factLoading = true;
    const cell = $('#calc-fact-output');
    if (cell) { cell.textContent = 'спрашиваем SalesDoctor…'; cell.classList.add('calc-dim'); }
    try {
      const r = await post('/sales-fact/refresh', { months });
      toast(months === 3 ? 'Обновлено: среднее за 3 месяца' : 'Обновлено за прошлый месяц');
      if (r.truncated) toast('Данные неполные: слишком много заказов', true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      factLoading = false;
      await load();
    }
  }

  function render() {
    const main = $('#calc-main');
    main.innerHTML = '';
    main.appendChild(sheetTabs());              // вкладки листов — сверху
    const body = sheet === 'packaging' ? packagingSheet()
      : sheet === 'recipes' ? recipesSheet()
        : SKU_SHEETS.includes(sheet) ? skuSheet() : production();
    main.appendChild(el('div', { class: 'calc-sheet' }, body));
  }

  // Вкладки листов — внизу, как в Excel
  function sheetTabs() {
    return el('div', { class: 'calc-tabs' }, SHEETS.map((s) => el('button', {
      class: 'calc-tab' + (sheet === s.key ? ' on' : '') + (s.ready ? '' : ' soon'),
      title: s.ready ? s.title : 'Этот лист ещё не собран',
      onclick: () => {
        if (!s.ready) return toast('Лист «' + s.title + '» ещё не собран — идём по порядку');
        sheet = s.key; skuMode = 'approved'; load();
      },
    }, s.title)));
  }

  // ---------------------------------------------------------------------------
  // Лист «Производство»
  // ---------------------------------------------------------------------------
  function production() {
    const d = DATA;
    const box = el('div');

    // Заголовок листа — фирменный вид Hub (Lora), как на остальных плитках.
    box.appendChild(el('div', { class: 'calc-sheet-head' }, [
      el('h1', { class: 'calc-h1' }, 'Производство'),
      el('div', { class: 'calc-sub' }, 'Выпуск и затраты за месяц. «Текущее» участвует в себестоимости, «фактич» подтягивается сам, «план» — ваш ориентир.'),
    ]));

    box.appendChild(el('table', { class: 'calc-t' }, [
      el('colgroup', {}, [
        el('col', { class: 'c-name' }), el('col', { class: 'c-num' }),
        el('col', { class: 'c-num' }), el('col', { class: 'c-src' }),
      ]),
      el('tbody', {}, [colsRow(false), outputRow(d.output), gapRow()].concat(
        ...d.blocks.map((b) => blockRows(b))
      )),
    ]));

    if (d.no_output_reason) {
      box.appendChild(el('div', { class: 'calc-msg warn' }, '⚠️ ' + d.no_output_reason));
    }
    box.appendChild(el('div', { class: 'calc-note' },
      'Колонка «текущее» участвует в себестоимости. «Фактич» подтягивается из Кассы за месяц по связанной статье ДДС — свяжите статью в последнем столбце. «План» вводится вручную.'));
    return box;
  }

  // Заголовки колонок повторяются в каждом блоке: так не приходится
  // возвращаться взглядом наверх, чтобы понять, что это за цифра.
  function colsRow(withCats) {
    return el('tr', { class: 'calc-r-cols' }, [
      el('td', {}, ''),
      el('td', { class: 'calc-num' }, [el('div', {}, 'текущее в кальк.'), el('div', {}, 'расчётах')]),
      el('td', { class: 'calc-num' }, 'фактич'),
      el('td', {}, withCats === false ? '' : 'статьи ДДС Кассы'),
    ]);
  }
  const gapRow = () => el('tr', { class: 'calc-r-gap' }, el('td', { colspan: '4' }, ''));

  function outputRow(o) {
    // Кнопки обновления факта. SalesDoctor медленный, поэтому только по нажатию.
    const btn = (label, icon, months, hint) => el('button', {
      class: 'calc-fact-btn', title: hint,
      onclick: () => refreshFact(months),
    }, [el('span', { class: 'calc-fact-ico' }, icon), label]);

    const factCell = el('div', { class: 'calc-fact-wrap' }, [
      el('div', { id: 'calc-fact-output', class: 'calc-cell calc-ro', title: o.fact_note || '' },
        o.fact === null || o.fact === undefined ? '—' : money0(o.fact)),
      canEdit() ? el('div', { class: 'calc-fact-btns' }, [
        btn('месяц', '↻', 1, 'Взять из SalesDoctor за прошлый календарный месяц'),
        btn('3 мес', '∑', 3, 'Среднее за три прошлых месяца по данным SalesDoctor'),
      ]) : null,
      o.fact_note ? el('div', { class: 'calc-fact-note' }, o.fact_note) : null,
    ]);

    return el('tr', { class: 'calc-r-output' }, [
      el('td', {}, [
        el('div', { class: 'calc-name calc-ro calc-b' }, 'Среднемесячное производство'),
        el('div', { class: 'calc-unit' }, 'шт'),
      ]),
      el('td', {}, cell(o.current, (v) => post('/output', { current: v }), { dec: 0 })),
      el('td', {}, factCell),
      el('td', {}, ''),
    ]);
  }

  function blockRows(b) {
    const rows = [];
    // Заголовок блока и сразу под ним — названия колонок
    rows.push(el('tr', { class: 'calc-r-head' }, [
      el('td', { colspan: '4' }, b.title),
    ]));
    rows.push(colsRow());

    b.items.forEach((item) => rows.push(el('tr', {}, [
      el('td', {}, nameCell(item.name, (v) => post('/costs/' + item.id, { name: v }))),
      el('td', {}, cell(item.current, (v) => post('/costs/' + item.id, { current: v }))),
      el('td', {}, el('div', { class: 'calc-cell calc-ro' + (item.fact === null ? ' calc-dim' : '') },
        item.fact === null ? 'не связано' : money(item.fact))),
      el('td', {}, el('div', { class: 'calc-src-wrap' }, [
        cashPicker(item),
        canEdit() ? el('button', {
          class: 'calc-del', title: 'Убрать статью',
          onclick: async () => {
            try { await api('/costs/' + item.id, { method: 'DELETE' }); toast('Статья убрана'); await load(); }
            catch (e) { toast(e.message, true); }
          },
        }, '×') : null,
      ])),
    ])));

    if (canEdit()) {
      rows.push(el('tr', { class: 'calc-r-add' }, [
        el('td', { colspan: '4' }, el('button', {
          class: 'calc-add',
          onclick: async () => {
            try { await post('/costs', { kind: b.key, name: 'Новая статья' }); await load(); }
            catch (e) { toast(e.message, true); }
          },
        }, '+ добавить статью')),
      ]));
    }

    // Итог блока и «Среднее на шт» — две строки, как в Excel
    // «Фактич» может быть неполным: подписываем, сколько статей связано с Кассой.
    const cov = b.fact_coverage || { linked: 0, total: 0, full: false };
    const factNote = (value) => (value === null || value === undefined) ? ''
      : (cov.full ? money(value)
        : el('div', {}, [
            el('div', {}, money(value)),
            el('div', { class: 'calc-partial', title: 'Остальные статьи не связаны со статьёй ДДС Кассы' },
              'учтено ' + cov.linked + ' из ' + cov.total),
          ]));

    rows.push(el('tr', { class: 'calc-r-total' }, [
      el('td', {}, b.total_label),
      el('td', { class: 'calc-num' }, money(b.total.current)),
      el('td', { class: 'calc-num' }, factNote(b.total.fact)),
      el('td', {}, ''),
    ]));
    rows.push(el('tr', { class: 'calc-r-per' }, [
      el('td', {}, 'Среднее на шт'),
      el('td', { class: 'calc-num' }, b.per_unit.current === null ? '—' : money(b.per_unit.current)),
      el('td', { class: 'calc-num' }, b.per_unit.fact === null ? '' : factNote(b.per_unit.fact)),
      el('td', {}, ''),
    ]));
    rows.push(el('tr', { class: 'calc-r-gap' }, el('td', { colspan: '4' }, '')));
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Лист «Упаковка»: комплекты, строки вписываются вручную
  // ---------------------------------------------------------------------------
  let PACK = null;

  async function loadPackaging() {
    let d;
    try { d = await api('/packaging'); }
    catch (e) {
      const main = $('#calc-main'); main.innerHTML = '';
      main.appendChild(sheetTabs());
      main.appendChild(el('div', { class: 'calc-empty' }, 'Не удалось загрузить: ' + e.message));
      return;
    }
    PACK = d;
    DATA = { can_edit: d.can_edit };   // права нужны общим помощникам ячеек
    render();
  }

  function packagingSheet() {
    const box = el('div');
    box.appendChild(el('div', { class: 'calc-sheet-head' }, [
      el('h1', { class: 'calc-h1' }, 'Упаковка'),
      el('div', { class: 'calc-sub' }, 'Комплект — это то, во что упакован один товар. Строки вписываются вручную: название и цена. Привязка к конкретной позиции склада не нужна: у всех цветных пакетов розницы цена одна.'),
    ]));

    const tpls = (PACK && PACK.templates) || [];
    const cards = tpls.map((t) => templateCard(t));
    if (!cards.length) {
      cards.push(el('div', { class: 'calc-tpl-empty-all' },
        'Комплектов пока нет. Добавьте первый — например «вак.пакет розница».'));
    }

    box.appendChild(el('div', { class: 'calc-pack-block' }, [
      el('div', { class: 'calc-r-head-solo' }, [
        el('span', {}, 'Комплекты упаковки'),
        canEdit() ? el('button', { class: 'calc-add', onclick: async () => {
          try { await post('/packaging/template', { name: 'Новый комплект' }); await loadPackaging(); }
          catch (e) { toast(e.message, true); }
        } }, '+ комплект') : null,
      ]),
      el('div', { class: 'calc-tpls' }, cards),
    ]));
    return box;
  }

  function templateCard(t) {
    const lines = t.items.map((line) => el('div', { class: 'calc-tpl-line' }, [
      canEdit()
        ? nameCell(line.name, (v) => post('/packaging/line/' + line.id, { name: v }))
        : el('div', { class: 'calc-tpl-nm' }, line.name),
      cell(line.price, (v) => post('/packaging/line/' + line.id, { price: v }), { placeholder: 'цена' }),
      cell(line.qty, (v) => post('/packaging/line/' + line.id, { qty: v }), { dec: 2 }),
      el('div', { class: 'calc-tpl-cost' },
        line.line_cost === null ? el('span', { class: 'calc-dim' }, 'впишите цену') : money(line.line_cost)),
      canEdit() ? el('button', {
        class: 'calc-del', title: 'Убрать строку',
        onclick: async () => {
          try { await api('/packaging/line/' + line.id, { method: 'DELETE' }); await loadPackaging(); }
          catch (e) { toast(e.message, true); }
        },
      }, '×') : null,
    ]));

    if (!lines.length) lines.push(el('div', { class: 'calc-tpl-empty' }, 'Пусто — добавьте строку'));

    return el('div', { class: 'calc-tpl' }, [
      el('div', { class: 'calc-tpl-head' }, [
        canEdit()
          ? nameCell(t.name, (v) => post('/packaging/template/' + t.id, { name: v }))
          : el('div', { class: 'calc-name calc-ro' }, t.name),
        canEdit() ? el('button', {
          class: 'calc-del', title: 'Убрать комплект',
          onclick: async () => {
            try { await api('/packaging/template/' + t.id, { method: 'DELETE' }); toast('Комплект убран'); await loadPackaging(); }
            catch (e) { toast(e.message, true); }
          },
        }, '×') : null,
      ]),
      el('div', { class: 'calc-tpl-cols' }, [
        el('span', {}, 'что входит'), el('span', {}, 'цена'), el('span', {}, 'кол-во'),
        el('span', {}, 'стоимость'), el('span', {}, ''),
      ]),
      el('div', {}, lines),
      canEdit() ? el('button', { class: 'calc-tpl-add', onclick: async () => {
        try { await post('/packaging/template/' + t.id + '/line', { name: 'Новая строка', qty: 1 }); await loadPackaging(); }
        catch (e) { toast(e.message, true); }
      } }, '+ строка') : null,
      el('div', { class: 'calc-tpl-total' }, [
        el('span', {}, 'Стоимость комплекта'),
        el('b', {}, money(t.total)),
      ]),
      t.missing_prices
        ? el('div', { class: 'calc-partial' }, 'строк без цены: ' + t.missing_prices + ' — в сумму не вошли')
        : null,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Лист «Рецептуры»: миксы салатов
  // ---------------------------------------------------------------------------
  // Устроен как «Упаковка», отличие одно: цену за кг руками не вводят — она
  // приходит из Закупа. Человек вписывает граммы, процент считаем сами.
  let RCP = null;

  async function loadRecipes() {
    let d;
    try { d = await api('/recipes'); }
    catch (e) {
      const main = $('#calc-main'); main.innerHTML = '';
      main.appendChild(sheetTabs());
      main.appendChild(el('div', { class: 'calc-empty' }, 'Не удалось загрузить: ' + e.message));
      return;
    }
    RCP = d;
    DATA = { can_edit: d.can_edit };
    render();
  }

  function recipesSheet() {
    const box = el('div');
    box.appendChild(el('div', { class: 'calc-sheet-head' }, [
      el('div', { class: 'calc-sheet-top' }, [
        el('h1', { class: 'calc-h1' }, 'Рецептуры'),
        canEdit() ? el('button', { class: 'calc-add', onclick: async () => {
          try { await post('/recipes/recipe', { name: 'Новая рецептура' }); await loadRecipes(); }
          catch (e) { toast(e.message, true); }
        } }, '+ рецептура') : null,
      ]),
      el('div', { class: 'calc-sub' }, 'Состав микса на одну упаковку: выбираете сырьё и вписываете граммы. Долю в процентах и стоимость считает система, цена за кг приходит из Закупа. Готовую рецептуру выбирайте в строке «Рецептура» на товарном листе.'),
    ]));

    const list = (RCP && RCP.recipes) || [];
    const cards = list.map((r) => recipeCard(r));
    if (!cards.length) {
      cards.push(el('div', { class: 'calc-tpl-empty-all' },
        'Рецептур пока нет. Добавьте первую — например «Цезарь микс».'));
    }
    box.appendChild(el('div', { class: 'calc-tpls' }, cards));
    return box;
  }

  function recipeCard(r) {
    const raws = (RCP && RCP.raw_materials) || [];
    const lines = r.items.map((line) => {
      const sel = el('select', { class: 'calc-sel' }, [el('option', { value: '' }, '— сырьё —')]
        .concat(raws.map((m) => {
          const o = el('option', { value: String(m.id) }, m.name);
          if (Number(line.raw_material_id) === m.id) o.setAttribute('selected', 'selected');
          return o;
        })));
      sel.addEventListener('change', async () => {
        try { await post('/recipes/line/' + line.id, { raw_material_id: sel.value || null }); await loadRecipes(); }
        catch (e) { toast(e.message, true); }
      });
      return el('div', { class: 'calc-rcp-line' }, [
        canEdit() ? sel : el('div', { class: 'calc-tpl-nm' }, line.raw_material_name || '—'),
        cell(line.qty_g, (v) => post('/recipes/line/' + line.id, { qty_g: v }), { dec: 0, placeholder: 'гр' }),
        el('div', { class: 'calc-tpl-cost calc-dim' }, line.pct === null ? '—' : money(line.pct, 0) + '%'),
        el('div', { class: 'calc-tpl-cost' }, line.price_per_kg === null
          ? el('span', { class: 'calc-warn-mini' }, 'нет цены')
          : el('span', {}, [money0(line.price_per_kg),
            el('div', { class: 'calc-src-mini' }, 'из Закупа' + (line.price_at ? ' · ' + line.price_at : ''))])),
        el('div', { class: 'calc-tpl-cost' }, line.line_cost === null ? el('span', { class: 'calc-dim' }, '—') : money(line.line_cost)),
        canEdit() ? el('button', {
          class: 'calc-del', title: 'Убрать компонент',
          onclick: async () => {
            try { await api('/recipes/line/' + line.id, { method: 'DELETE' }); await loadRecipes(); }
            catch (e) { toast(e.message, true); }
          },
        }, '×') : null,
      ]);
    });
    if (!lines.length) lines.push(el('div', { class: 'calc-tpl-empty' }, 'Пусто — добавьте сырьё'));

    return el('div', { class: 'calc-tpl' }, [
      el('div', { class: 'calc-tpl-head' }, [
        canEdit()
          ? nameCell(r.name, (v) => post('/recipes/recipe/' + r.id, { name: v }))
          : el('div', { class: 'calc-name calc-ro' }, r.name),
        canEdit() ? el('button', {
          class: 'calc-dots', title: 'Действия с рецептурой', 'aria-label': 'Действия с рецептурой',
          onclick: (e) => {
            e.stopPropagation();
            dotsMenu(e.currentTarget, [{ label: 'Убрать рецептуру', danger: true, onClick: () => confirmRemoveRecipe(r) }]);
          },
        }, '⋯') : null,
      ]),
      el('div', { class: 'calc-rcp-cols' }, [
        el('span', {}, 'сырьё'), el('span', {}, 'гр'), el('span', {}, 'доля'),
        el('span', {}, 'цена/кг'), el('span', {}, 'стоимость'), el('span', {}, ''),
      ]),
      el('div', {}, lines),
      canEdit() ? el('button', { class: 'calc-tpl-add', onclick: async () => {
        try { await post('/recipes/recipe/' + r.id + '/line', { qty_g: 0 }); await loadRecipes(); }
        catch (e) { toast(e.message, true); }
      } }, '+ сырьё') : null,
      el('div', { class: 'calc-tpl-total' }, [
        el('span', {}, 'Зелень на упаковку · ' + money(r.total_g, 0) + ' гр'),
        el('b', {}, money(r.total)),
      ]),
      r.missing_prices
        ? el('div', { class: 'calc-partial' }, 'компонентов без цены: ' + r.missing_prices + ' — в сумму не вошли')
        : null,
    ]);
  }

  function confirmRemoveRecipe(r) {
    const body = el('div', {}, [
      el('div', { class: 'calc-modal-facts' }, r.items.length
        ? (money(r.total_g, 0) + ' гр · компонентов: ' + r.items.length + ' · ' + money(r.total) + ' сум')
        : 'состав пустой'),
      el('p', { class: 'calc-modal-note' },
        'Рецептура уходит в архив. Если она стоит у какого-то товара, система не даст её убрать — сначала смените рецептуру там.'),
    ]);
    const ok = el('button', { class: 'calc-btn danger', onclick: async () => {
      ok.disabled = true;
      try { await api('/recipes/recipe/' + r.id, { method: 'DELETE' }); m.close(); toast('Рецептура убрана'); await loadRecipes(); }
      catch (e) { toast(e.message, true); ok.disabled = false; }
    } }, 'Убрать рецептуру');
    const m = calcModal('Убрать рецептуру «' + r.name + '»?', body, [
      el('button', { class: 'calc-btn', onclick: () => m.close() }, 'Отмена'), ok,
    ]);
  }

  load();
  // ---------------------------------------------------------------------------
  // Товарные листы: Рознич. тара, Хорека, Салаты, Пучки
  // ---------------------------------------------------------------------------
  // Строки — статьи расчёта, столбцы — товары: ровно как в Excel.
  // Считает всё сервер, здесь только показ и отправка правок.
  let SKU = null;

  // Лист открывается в утверждённом виде: цифры не меняются сами, пока их не
  // утвердят заново. «Текущий» показывает пересчёт по сегодняшним ценам.
  let skuMode = 'approved';   // approved | current
  let SKU_SNAP = null;        // мета открытого снимка (когда смотрим утверждённое)

  async function loadSku() {
    let d;
    try { d = await api('/sheet/' + sheet); }
    catch (e) {
      const main = $('#calc-main'); main.innerHTML = '';
      main.appendChild(sheetTabs());
      main.appendChild(el('div', { class: 'calc-empty' }, 'Не удалось загрузить: ' + e.message));
      return;
    }
    let snap = null;
    if (skuMode === 'approved' && d.approval && d.approval.has) {
      try {
        const s = await api('/approval/' + d.approval.id);
        snap = { id: s.id, approved_at: s.approved_at, approved_by_name: s.approved_by_name, comment: s.comment };
        // Снимок самодостаточен, но заголовок листа и состояние утверждения
        // берём свежие — они про «сейчас», а не про момент утверждения.
        d = Object.assign({}, s.data, { can_edit: false, approval: d.approval, sheet_title: d.sheet_title });
      } catch (e) { snap = null; }   // снимок не открылся — покажем текущий расчёт
    }
    SKU = d; SKU_SNAP = snap;
    DATA = { can_edit: d.can_edit };
    render();
  }

  const save = (id, patch) => post('/sheet-product/' + id, patch);

  // Ставка в процентах внутри ячейки товара: у мангольда брак 20%, у остальных 50%,
  // поэтому ставка живёт у каждого товара, а не одна на строку.
  function pctCell(value, onSave) {
    if (!canEdit()) return el('span', { class: 'calc-rate' }, money(value, 0) + '%');
    const inp = el('input', { type: 'text', inputmode: 'decimal', class: 'calc-rate-inp', value: money(value, 0) });
    const clean = () => {
      const raw = String(inp.value).replace(/[^\d.,-]/g, '').replace(',', '.').trim();
      return raw === '' ? 0 : (Number(raw) || 0);
    };
    inp.addEventListener('focus', () => { inp.value = String(clean()); inp.select(); });
    inp.addEventListener('blur', async () => {
      const v = clean();
      inp.value = money(v, 0);
      if (v === Number(value)) return;
      try { await onSave(v); await load(); } catch (e) { toast(e.message, true); }
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    return el('span', { class: 'calc-rate' }, [inp, '%']);
  }

  // Строка листа. cells — функция, которая по товару возвращает содержимое ячейки.
  // «Ед.изм.» — отдельная колонка (как в Excel Шоха: Компоненты | ед.изм | товары…),
  // а не подпись под названием строки.
  // Подсказки к строкам: наводишь мышку — видно, что это за цифра и откуда.
  // Держим их одним списком рядом, а не размазанными по коду: так проще
  // держать объяснение и формулу в согласии друг с другом.
  // Пишем словами, понятными не только бухгалтеру.
  const ROW_HINTS = {
    'Граммаж': 'Сколько граммов зелени кладём в одну упаковку. Вводится вручную.',
    'наименование': 'Какая именно зелень. Выберите позицию из справочника — тогда цена за килограмм подтянется из Закупа сама.',
    'Стоимость зелени': 'Сколько стоит килограмм этой зелени. Берётся из последней приёмки в Закупе. Если там цены ещё нет — впишите руками.',
    'зелень в упаковке': 'Во сколько обходится зелень в одной упаковке. Считается: граммаж ÷ 1000 × цена за килограмм.',
    'Рецептура': 'Микс из нескольких видов зелени. Собирается на листе «Рецептуры». Если рецептура выбрана, зелень считается по ней, а граммаж и одиночное сырьё в расчёте не участвуют.',
    'Тип упаковки': 'Во что упакован товар. Сами комплекты собираются на листе «Упаковка».',
    'Упаковка': 'Во сколько обходится упаковка одной штуки — сумма всех строк выбранного комплекта с листа «Упаковка».',
    'Производ.затраты / накладные расходы': 'Доля общих расходов завода на одну штуку. С листа «Производство»: производственные затраты на штуку плюс накладные на штуку. Если товара с одной операции выходит больше обычного, поставьте долю меньше единицы.',
    'ФОТ': 'Зарплата на одну штуку. Фонд окладов активных сотрудников из плитки «Персонал» делится на среднемесячное производство.',
    'с\\с': 'Себестоимость одной штуки — сумма всех строк выше: зелень, упаковка, производственные с накладными и ФОТ.',
    'с\\с с браком': 'Себестоимость с запасом на брак и потери: себестоимость × (1 + процент брака). Процент правится прямо в ячейке.',
    'Наценка %': 'На сколько процентов отпускная цена выше себестоимости с браком.',
    'Прайс 1 · Цена нов прайс': 'Первый прайс-лист. Цена вводится вручную. Ниже — что из неё получается: наценка, ретро-бонусы, НДС, прибыль и налог.',
    'Прайс 2 (КАМ)': 'Второй прайс-лист. Цена вводится вручную. Расчёт такой же, как по первому прайсу, — отличается только цена.',
    'Ретро бонусы': 'Сколько возвращаем сети по договору: цена × процент ретро-бонуса. Процент правится в ячейке.',
    'НДС': 'Налог на добавленную стоимость: цена × ставка. Ставка правится в ячейке.',
    'Прибыль': 'Что остаётся до налога: цена минус себестоимость с браком, минус ретро-бонусы, минус НДС.',
    'Налог на прибыль': 'Прибыль × ставка налога. Если прибыли нет, налога тоже нет.',
    'Чистая прибыль': 'Что остаётся в итоге: прибыль минус налог на прибыль.',
    'ЧП, %': 'Какую долю от отпускной цены составляет чистая прибыль.',
  };

  // Подсказки с настоящими числами товара — то же объяснение, но подставленное.
  const num = (v, dec) => (v === null || v === undefined ? '?' : money(v, dec === undefined ? 2 : dec));
  const CELL_HINTS = {
    'зелень в упаковке': (x) => (x.net_weight_g && x.raw_price_per_kg
      ? num(x.net_weight_g, 0) + ' г ÷ 1000 × ' + num(x.raw_price_per_kg, 0) + ' = ' + num(x.calc.components.raw)
      : 'Укажите граммаж и стоимость зелени'),
    'Стоимость зелени': (x) => (x.raw_price_source === 'purchase'
      ? 'Последняя принятая цена в Закупе' + (x.raw_price_at ? ' от ' + x.raw_price_at : '')
      : (x.raw_material_id ? 'В Закупе по этой позиции цены пока нет — цифра вписана вручную'
        : 'Наименование не выбрано — цифра вписана вручную')),
    'Упаковка': (x) => (x.pack_template_name
      ? 'Комплект «' + x.pack_template_name + '» с листа «Упаковка»'
      : 'Комплект не выбран'),
    'Производ.затраты / накладные расходы': (x, d) => {
      if (d.base.production_per_unit === null || d.base.overhead_per_unit === null) return 'Нет данных листа «Производство»';
      const sum = d.base.production_per_unit + d.base.overhead_per_unit;
      const base = 'производственные ' + num(d.base.production_per_unit) + ' + накладные '
        + num(d.base.overhead_per_unit) + ' = ' + num(sum);
      return x.prod_factor === 1 ? base : base + ', × доля ' + num(x.prod_factor) + ' = ' + num(sum * x.prod_factor);
    },
    'ФОТ': (x, d) => (d.base.payroll_fund
      ? 'фонд окладов ' + num(d.base.payroll_fund, 0) + ' ÷ ' + num(d.base.output, 0) + ' шт = ' + num(d.base.labor_per_unit)
      : 'В Персонале нет окладов активных сотрудников'),
    'с\\с': (x) => {
      const c = x.calc.components;
      const parts = [];
      if (c.raw !== null) parts.push('зелень ' + num(c.raw));
      if (c.pack !== null) parts.push('упаковка ' + num(c.pack));
      if (c.production !== null) parts.push('производ. ' + num(c.production));
      if (c.labor !== null) parts.push('ФОТ ' + num(c.labor));
      return parts.length ? parts.join(' + ') + ' = ' + num(x.calc.cost) : 'Нечего складывать';
    },
    'с\\с с браком': (x) => num(x.calc.cost) + ' × (1 + ' + num(x.defect_pct, 0) + '%) = ' + num(x.calc.cost_defect),
    'Наценка %': (x) => (x.calc.markup_pct === null ? 'Нужны цена и себестоимость'
      : num(x.price, 0) + ' ÷ ' + num(x.calc.cost_defect) + ' − 1 = ' + num(x.calc.markup_pct, 0) + '%'),
    'Ретро бонусы': (x) => num(x.price, 0) + ' × ' + num(x.retro_pct, 0) + '% = ' + num(x.calc.retro),
    'НДС': (x) => num(x.price, 0) + ' × ' + num(x.vat_pct, 0) + '% = ' + num(x.calc.vat),
    'Прибыль': (x) => (x.calc.profit === null ? 'Нужны цена и себестоимость'
      : num(x.price, 0) + ' − ' + num(x.calc.cost_defect) + ' − ' + num(x.calc.retro)
        + ' − ' + num(x.calc.vat) + ' = ' + num(x.calc.profit)),
    'Налог на прибыль': (x) => (x.calc.profit_tax === null ? 'Нужна прибыль'
      : num(x.calc.profit) + ' × ' + num(x.profit_tax_pct, 0) + '% = ' + num(x.calc.profit_tax)),
    'Чистая прибыль': (x) => (x.calc.net_profit === null ? 'Нужна прибыль'
      : num(x.calc.profit) + ' − ' + num(x.calc.profit_tax) + ' = ' + num(x.calc.net_profit)),
    'ЧП, %': (x) => (x.calc.net_pct === null ? 'Нужны прибыль и цена'
      : num(x.calc.net_profit) + ' ÷ ' + num(x.price, 0) + ' = ' + num(x.calc.net_pct, 0) + '%'),
  };

  // unitExtra — кнопка «всем» в колонке «ед.изм» (одна на строку, а не в каждом товаре).
  function skuRow(label, unit, cells, cls, unitExtra) {
    const p = SKU.products;
    const hint = ROW_HINTS[label] || '';
    const cellHint = CELL_HINTS[label];
    return el('tr', { class: 'calc-sku-r' + (cls ? ' ' + cls : '') }, [
      el('th', { class: 'calc-sku-h', 'data-hint': hint },
        el('div', { class: 'calc-sku-lbl' + (hint ? ' calc-has-hint' : '') }, label)),
      el('th', { class: 'calc-sku-u', 'data-hint': unitExtra ? null : hint }, [unit || '', unitExtra || null]),
    ].concat(p.map((x) => {
      // У ячейки — та же подсказка, но с настоящими числами этого товара.
      // Общее объяснение идёт первой строкой, расчёт — второй.
      let t = hint;
      if (cellHint) {
        let calc = '';
        try { calc = cellHint(x, SKU); } catch (e) { calc = ''; }
        if (calc) t = hint ? hint + '\n\n' + calc : calc;
      }
      return el('td', { 'data-hint': t }, cells(x));
    })));
  }

  // Кнопка «всем» в колонке «ед.изм»: спрашивает одно значение и проставляет его
  // всем товарам листа. У ставок такая же кнопка стоит в самой ячейке (там она
  // копирует значение товара), здесь же ячейки нет — поэтому спрашиваем в окне.
  function allRowBtn(field, title, buildControl, readValue) {
    if (!canEdit()) return null;
    return el('button', {
      class: 'calc-rate-all calc-all-row', title: 'Проставить одно значение всем товарам листа',
      onclick: (e) => {
        e.stopPropagation();
        const ctl = buildControl();
        const ok = el('button', { class: 'calc-btn primary', onclick: async () => {
          const v = readValue(ctl);
          if (v === null) { toast('Укажите значение', true); return; }
          ok.disabled = true;
          try {
            const r = await post('/sheet/' + sheet + '/apply-rate', { field, value: v });
            m.close(); toast('Проставлено товарам: ' + r.updated); await load();
          } catch (err) { toast(err.message, true); ok.disabled = false; }
        } }, 'Проставить всем');
        const m = calcModal(title, el('div', {}, [
          el('p', { class: 'calc-modal-note', style: 'margin:0 0 11px' },
            'Значение получат все товары листа «' + SKU.sheet_title + '» (' + SKU.products.length + ' шт). Прежние значения заменятся.'),
          ctl,
        ]), [el('button', { class: 'calc-btn', onclick: () => m.close() }, 'Отмена'), ok]);
      },
    }, 'всем');
  }
  const numCtl = (placeholder) => el('input', { type: 'number', step: 'any', min: '0', class: 'calc-modal-inp', placeholder });
  const readNum = (c) => (c.value.trim() === '' ? null : Number(c.value));

  // Понятные названия компонентов себестоимости — для подсказки «чего не хватает».
  const COMP_NAMES = {
    pack: 'упаковки', raw: 'сырья', production: 'производ. затрат',
    overhead: 'накладных', labor: 'ФОТ',
  };
  const dash = () => el('span', { class: 'calc-dim' }, '—');
  const auto = (v, dec) => (v === null || v === undefined ? dash() : el('span', {}, money(v, dec === undefined ? 2 : dec)));

  function skuSheet() {
    const d = SKU;
    const box = el('div');

    // Кнопка «+ товар» — вверху, рядом с заголовком: лист длинный, и тянуться
    // за ней в самый низ было неудобно.
    box.appendChild(el('div', { class: 'calc-sheet-head' }, [
      el('div', { class: 'calc-sheet-top' }, [
        el('h1', { class: 'calc-h1' }, d.sheet_title),
        canEdit() ? el('button', { class: 'calc-add', onclick: addProduct }, '+ товар') : null,
      ]),
      el('div', { class: 'calc-sub' }, 'Строки — расчёт, столбцы — товары. Упаковка и затраты на штуку подтягиваются с листов «Упаковка» и «Производство». Серые цифры считает система, белые поля — ваш ввод.'),
    ]));

    box.appendChild(approvalBar(d));

    if (d.no_output_reason) {
      box.appendChild(el('div', { class: 'calc-msg warn' }, '⚠️ ' + d.no_output_reason));
    }

    if (!d.products.length) {
      box.appendChild(el('div', { class: 'calc-empty' },
        el('div', {}, canEdit() ? 'Товаров на этом листе пока нет — добавьте кнопкой «+ товар» вверху.' : 'Товаров на этом листе пока нет.')));
      return box;
    }

    const tplOptions = d.pack_templates;
    const rawOptions = d.raw_materials || [];
    const recipeOptions = d.recipes || [];
    const rows = [];

    // --- шапка: название и штрих-код товара ---
    rows.push(el('tr', { class: 'calc-sku-head' }, [
      el('th', { class: 'calc-sku-h' }, el('div', { class: 'calc-sku-lbl' }, 'Компоненты')),
      el('th', { class: 'calc-sku-u' }, 'ед.изм'),
    ].concat(d.products.map((x) => el('th', {}, [
      canEdit() ? nameCell(x.name, (v) => save(x.id, { name: v }))
        : el('div', { class: 'calc-name calc-ro' }, x.name),
      canEdit() ? el('input', {
        type: 'text', class: 'calc-bar', value: x.barcode, placeholder: 'штрих-код',
        onblur: async (e) => {
          if (e.target.value.trim() === x.barcode) return;
          try { await save(x.id, { barcode: e.target.value }); } catch (err) { toast(err.message, true); }
        },
      }) : el('div', { class: 'calc-bar calc-ro' }, x.barcode || ''),
      canEdit() ? el('button', {
        class: 'calc-dots', title: 'Действия с товаром', 'aria-label': 'Действия с товаром',
        onclick: (e) => {
          e.stopPropagation();
          dotsMenu(e.currentTarget, [{ label: 'Убрать с листа', danger: true, onClick: () => confirmRemoveProduct(x, d) }]);
        },
      }, '⋯') : null,
    ])))));

    // --- Строки идут ровно в том же порядке, что на листе «0000_розница» ---
    rows.push(skuRow('Граммаж', 'гр', (x) => el('div', {}, [
      cell(x.net_weight_g, (v) => save(x.id, { net_weight_g: v }), { dec: 0, placeholder: 'гр' }),
      // Сверка с рецептурой: расхождение почти всегда означает опечатку в граммах.
      (x.recipe_id && x.net_weight_g && x.recipe_total_g && Math.abs(x.recipe_total_g - x.net_weight_g) > 1)
        ? el('div', { class: 'calc-warn-mini' }, 'рецептура даёт ' + money(x.recipe_total_g, 0) + ' гр')
        : null,
    ]), null, allRowBtn('net_weight_g', 'Граммаж всем товарам листа', () => numCtl('гр'), readNum)));

    // Рецептура (микс) вместо одного сырья. Не выбрана — лист работает по-старому.
    rows.push(skuRow('Рецептура', '', (x) => {
      if (!canEdit()) return el('span', {}, x.recipe_name || '—');
      const sel = el('select', { class: 'calc-sel' }, [el('option', { value: '' }, '— одно сырьё —')]
        .concat(recipeOptions.map((r) => {
          const o = el('option', { value: String(r.id) }, r.name);
          if (Number(x.recipe_id) === r.id) o.setAttribute('selected', 'selected');
          return o;
        })));
      sel.addEventListener('change', async () => {
        try { await save(x.id, { recipe_id: sel.value || null }); await load(); }
        catch (e) { toast(e.message, true); }
      });
      return el('div', {}, [
        sel,
        x.recipe_empty ? el('div', { class: 'calc-warn-mini' }, 'в рецептуре нет сырья') : null,
        x.recipe_missing_prices ? el('div', { class: 'calc-warn-mini' }, 'в рецептуре есть сырьё без цены') : null,
      ]);
    }));

    rows.push(skuRow('наименование', '', (x) => {
      if (x.recipe_id) return el('span', { class: 'calc-dim' }, 'по рецептуре');
      if (!canEdit()) return el('span', {}, x.raw_material_name || '—');
      const sel = el('select', { class: 'calc-sel' }, [el('option', { value: '' }, '— не выбрано —')]
        .concat(rawOptions.map((m) => {
          const o = el('option', { value: String(m.id) }, m.name);
          if (Number(x.raw_material_id) === m.id) o.setAttribute('selected', 'selected');
          return o;
        })));
      sel.addEventListener('change', async () => {
        try { await save(x.id, { raw_material_id: sel.value || null }); await load(); }
        catch (e) { toast(e.message, true); }
      });
      return sel;
    }));

    // Цена за кг: из Закупа, если позиция связана и цена там есть. Иначе
    // вписывается вручную — тогда поле открыто для ввода.
    rows.push(skuRow('Стоимость зелени', 'сум/кг', (x) => {
      if (x.recipe_id) return el('span', { class: 'calc-dim' }, 'по рецептуре');
      if (x.raw_price_source === 'purchase') {
        return el('div', {}, [
          el('div', {}, money0(x.raw_price_per_kg)),
          el('div', { class: 'calc-src-mini' }, 'из Закупа'),
        ]);
      }
      return el('div', {}, [
        cell(x.raw_price_per_kg, (v) => save(x.id, { raw_price_per_kg: v }), { dec: 0, placeholder: 'цена/кг' }),
        x.raw_material_id ? el('div', { class: 'calc-src-mini' }, 'в Закупе цены нет') : null,
      ]);
    }));

    rows.push(skuRow('зелень в упаковке', 'сум', (x) => auto(x.calc.components.raw)));

    rows.push(skuRow('Тип упаковки', '', (x) => {
      if (!canEdit()) return el('span', {}, x.pack_template_name || '—');
      const sel = el('select', { class: 'calc-sel' }, [el('option', { value: '' }, '— не выбран —')]
        .concat(tplOptions.map((t) => {
          const o = el('option', { value: String(t.id) }, t.name);
          if (Number(x.pack_template_id) === t.id) o.setAttribute('selected', 'selected');
          return o;
        })));
      sel.addEventListener('change', async () => {
        try { await save(x.id, { pack_template_id: sel.value || null }); await load(); }
        catch (e) { toast(e.message, true); }
      });
      return sel;
    }, null, allRowBtn('pack_template_id', 'Комплект упаковки всем товарам листа',
      () => el('select', { class: 'calc-modal-inp' }, [el('option', { value: '' }, '— выберите комплект —')]
        .concat(tplOptions.map((t) => el('option', { value: String(t.id) }, t.name)))),
      (c) => (c.value ? Number(c.value) : null))));

    rows.push(skuRow('Упаковка', 'сум', (x) => [
      auto(x.calc.components.pack),
      x.pack_incomplete ? el('div', { class: 'calc-warn-mini' }, 'в комплекте есть строки без цены') : null,
    ]));

    rows.push(skuRow('Производ.затраты / накладные расходы', 'сум', (x) => [
      // Готовая цифра с листа «Производство»: «среднее на шт» по обоим блокам.
      // Расшифровку слагаемых не показываем — она есть на самом листе.
      auto(x.calc.components.production),
      // Доля нужна руколе: с одной операции выходит вдвое больше упаковок,
      // поэтому на штуку приходится половина затрат. У Латука доля 0.
      canEdit() ? el('div', { class: 'calc-factor' }, [
        el('span', { class: 'calc-dim' }, 'доля '),
        cell(x.prod_factor, (v) => save(x.id, { prod_factor: v }), { cls: 'calc-rate-inp' }),
      ]) : (x.prod_factor === 1 ? null : el('div', { class: 'calc-factor' }, 'доля ' + money(x.prod_factor))),
    ]));

    // ФОТ приходит из плитки «Персонал»: фонд окладов активных сотрудников,
    // делённый на среднемесячный выпуск. Руками не вводится.
    // В себестоимость НЕ входит — так в файле Шоха: с/с = зелень в упаковке
    // + упаковка + производ.затраты (сумма ячеек E6;E8;E9).
    rows.push(skuRow('ФОТ', 'сум', () => (d.base.payroll_fund
      ? auto(d.base.labor_per_unit)
      : el('div', { class: 'calc-warn-mini' }, 'в Персонале нет окладов'))));

    rows.push(skuRow('с\\с', 'сум', (x) => [
      auto(x.calc.cost),
      x.calc.missing ? el('div', { class: 'calc-warn-mini' },
        'нет: ' + (x.calc.missing_keys || []).map((k) => COMP_NAMES[k] || k).join(', ')) : null,
    ], 'calc-sku-sum'));

    rows.push(skuRow('с\\с с браком', 'сум', (x) => [
      pctCell(x.defect_pct, (v) => save(x.id, { defect_pct: v })),
      auto(x.calc.cost_defect),
    ], 'calc-sku-accent', allRowBtn('defect_pct', 'Процент брака всем товарам листа', () => numCtl('%'), readNum)));

    rows.push(el('tr', { class: 'calc-r-gap' },
      el('td', { colspan: String(d.products.length + 2) }, '')));

    // --- Цена в SalesDoctor: для сверки, в расчёте не участвует -----------
    rows.push(sdPriceRow(d));

    // --- Два прайса: каждый своей сворачиваемой группой, как в Excel ------
    // Себестоимость и ставки общие, поэтому наценка, прибыль и налог у каждого
    // прайса получаются свои — их и показываем внутри его группы.
    rows.push(...priceGroup(d, {
      key: 'p1',
      title: 'Прайс 1 · Цена нов прайс',
      priceField: 'price',
      value: (x) => x.price,
      calc: (x) => x.calc,
    }));
    rows.push(...priceGroup(d, {
      key: 'p2',
      title: 'Прайс 2 (КАМ)',
      priceField: 'price2',
      value: (x) => x.price2,
      calc: (x) => x.calc2,
    }));

    box.appendChild(el('div', { class: 'calc-sku-wrap' },
      el('table', { class: 'calc-sku-t' }, el('tbody', {}, rows))));

    box.appendChild(el('div', { class: 'calc-note' },
      'Зелень в упаковке = граммаж × стоимость зелени. Цена за кг берётся из Закупа по выбранному наименованию, а если её там нет — вписывается вручную. Упаковка — из выбранного комплекта на листе «Упаковка». Производственные и накладные затраты на штуку — с листа «Производство», делённые на среднемесячный выпуск'
      + (d.base.output ? ' (' + money0(d.base.output) + ' шт)' : '')
      + '. ФОТ берётся из плитки «Персонал» (фонд окладов активных сотрудников), делённый на тот же выпуск. Показан отдельно и в себестоимость не входит — так же, как в вашем файле.'));
    return box;
  }

  // ---------------------------------------------------------------------------
  // Утверждение расчёта: панель, окно утверждения, история
  // ---------------------------------------------------------------------------
  const dtRu = (s) => { try { return new Date(s).toLocaleDateString('ru-RU'); } catch (e) { return String(s || ''); } };
  const signPct = (v) => (v === null || v === undefined ? '' : (v > 0 ? '+' : '') + money(v, 0) + '%');

  // Панель под заголовком листа: где мы сейчас (утверждённое/текущее), насколько
  // текущий расчёт ушёл от утверждённого, и кнопки «Утвердить» / «История».
  function approvalBar(d) {
    if (SKU_SNAP && SKU_SNAP.old) return el('div');   // смотрим старую версию — панель ни к чему
    const a = d.approval || { has: false };
    const wrap = el('div', { class: 'calc-appr' });

    if (a.has) {
      const tabs = el('div', { class: 'calc-appr-modes' }, [
        el('button', { class: 'calc-appr-mode' + (skuMode === 'approved' ? ' on' : ''),
          onclick: () => { if (skuMode !== 'approved') { skuMode = 'approved'; loadSku(); } } }, 'Утверждённый'),
        el('button', { class: 'calc-appr-mode' + (skuMode === 'current' ? ' on' : ''),
          onclick: () => { if (skuMode !== 'current') { skuMode = 'current'; loadSku(); } } }, 'Текущий'),
      ]);
      wrap.appendChild(tabs);
      wrap.appendChild(el('div', { class: 'calc-appr-info' }, skuMode === 'approved'
        ? ('утверждён ' + dtRu(a.approved_at) + (a.approved_by_name ? ' · ' + a.approved_by_name : '')
          + (SKU_SNAP && SKU_SNAP.comment ? ' · «' + SKU_SNAP.comment + '»' : ''))
        : 'пересчёт по сегодняшним ценам · в утверждённую версию не попадает'));
    } else {
      wrap.appendChild(el('div', { class: 'calc-appr-info' }, 'Расчёт ещё ни разу не утверждали'));
    }

    const btns = el('div', { class: 'calc-appr-btns' }, [
      el('button', { class: 'calc-tbtn', onclick: openApprovalHistory }, 'История'),
      canEditUser() ? el('button', { class: 'calc-tbtn primary', onclick: () => openApprove(d) }, '✓ Утвердить') : null,
    ]);
    wrap.appendChild(btns);

    const rows = [wrap];
    // Плашка расхождения. Порог 10%: у зелени цены скачут, дёргать по мелочи незачем.
    if (a.has && a.diff_pct !== null && a.diff_pct !== undefined && Math.abs(a.diff_pct) >= (a.diff_pct_limit || 10)) {
      rows.push(el('div', { class: 'calc-appr-warn' }, [
        el('b', {}, 'Текущий расчёт разошёлся с утверждённым: с/с ' + signPct(a.diff_pct)),
        a.changes ? el('div', {}, a.changes) : null,
      ]));
    }
    return el('div', {}, rows);
  }

  // Право менять цифры берём у пользователя, а не у листа: в утверждённом виде
  // лист открыт только на чтение, но «Утвердить» и «История» должны работать.
  const canEditUser = () => !!(window.HUB_USER && (window.HUB_USER.isAdmin || window.HUB_USER.isFinance));

  function openApprove(d) {
    const cmt = el('input', { type: 'text', class: 'calc-modal-inp', maxlength: '300',
      placeholder: 'например: прайс на сентябрь' });
    const a = d.approval || { has: false };
    const body = el('div', {}, [
      el('div', { class: 'calc-modal-facts' }, 'Товаров на листе: ' + d.products.length
        + (a.has && a.diff_pct !== null && a.diff_pct !== undefined ? ' · с/с к прошлой версии ' + signPct(a.diff_pct) : '')),
      el('p', { class: 'calc-modal-note' },
        'Сохраним снимок листа целиком: все цифры, включая цену из SalesDoctor. Он не изменится, что бы дальше ни случилось с ценами в Закупе.'),
      el('div', { style: 'margin-top:12px' }, [
        el('div', { class: 'calc-modal-lbl' }, 'Комментарий (необязательно)'),
        cmt,
      ]),
    ]);
    const ok = el('button', { class: 'calc-btn primary', onclick: async () => {
      ok.disabled = true;
      try {
        const r = await post('/sheet/' + sheet + '/approve', { comment: cmt.value });
        m.close(); toast('Расчёт утверждён');
        skuMode = 'approved';
        await loadSku();
        if (r.changes) toast(r.changes);
      } catch (e) { toast(e.message, true); ok.disabled = false; }
    } }, 'Утвердить');
    const m = calcModal('Утвердить расчёт листа «' + d.sheet_title + '»', body, [
      el('button', { class: 'calc-btn', onclick: () => m.close() }, 'Отмена'), ok,
    ]);
  }

  async function openApprovalHistory() {
    let h;
    try { h = await api('/sheet/' + sheet + '/approvals'); }
    catch (e) { return toast(e.message, true); }

    const rows = [];
    const a = h.approval || { has: false };
    // Текущий расчёт — всегда первой строкой: видно, есть ли расхождение.
    rows.push(el('div', { class: 'calc-hist-now' + (a.has && a.diff_pct !== null && Math.abs(a.diff_pct) >= (a.diff_pct_limit || 10) ? ' warn' : '') }, [
      el('div', { class: 'calc-hist-l1' }, [
        el('b', {}, 'Текущий расчёт · не утверждён'),
        el('span', {}, (h.current.avg_cost === null ? '—' : 'с/с ' + money0(h.current.avg_cost))
          + (a.has && a.diff_pct !== null && a.diff_pct !== undefined ? ' · ' + signPct(a.diff_pct) + ' к последнему' : '')),
      ]),
      a.has && a.changes ? el('div', { class: 'calc-hist-ch' }, a.changes) : null,
    ]));

    if (!h.items.length) {
      rows.push(el('div', { class: 'calc-tpl-empty' }, 'Утверждений пока нет. Нажмите «Утвердить», чтобы зафиксировать первый расчёт.'));
    }
    h.items.forEach((it, i) => {
      rows.push(el('div', { class: 'calc-hist-it' }, [
        el('div', { class: 'calc-hist-l1' }, [
          el('b', {}, dtRu(it.approved_at) + (i === 0 ? '' : '')),
          el('span', {}, (it.avg_cost === null ? '—' : 'с/с ' + money0(it.avg_cost))
            + (it.avg_margin === null ? '' : ' · маржа ' + money(it.avg_margin, 0) + '%')),
        ]),
        i === 0 ? el('span', { class: 'calc-hist-badge' }, 'действующий') : null,
        el('div', { class: 'calc-hist-who' }, (it.approved_by_name || '—') + (it.comment ? ' · «' + it.comment + '»' : '')),
        it.changes ? el('div', { class: 'calc-hist-ch' }, it.changes) : null,
        el('button', { class: 'calc-tbtn small', onclick: async () => {
          m.close();
          await openSnapshot(it.id);
        } }, 'Открыть лист на эту дату'),
      ]));
    });

    const m = calcModal('История утверждений · ' + h.sheet_title,
      el('div', { class: 'calc-hist' }, rows),
      [el('button', { class: 'calc-btn', onclick: () => m.close() }, 'Закрыть')]);
  }

  // Открыть старую версию: показываем снимок как есть, без пересчёта.
  async function openSnapshot(id) {
    let s;
    try { s = await api('/approval/' + id); }
    catch (e) { return toast(e.message, true); }
    SKU = Object.assign({}, s.data, { can_edit: false, approval: { has: false } });
    SKU_SNAP = { id: s.id, approved_at: s.approved_at, approved_by_name: s.approved_by_name, comment: s.comment, old: true };
    DATA = { can_edit: false };
    const main = $('#calc-main'); main.innerHTML = '';
    main.appendChild(sheetTabs());
    const back = el('div', { class: 'calc-appr-warn' }, [
      el('b', {}, 'Утверждение от ' + dtRu(s.approved_at)
        + (s.approved_by_name ? ' · ' + s.approved_by_name : '') + (s.comment ? ' · «' + s.comment + '»' : '')),
      el('div', {}, 'Это снимок: цифры такие, какими были в тот день. Правка недоступна.'),
      el('button', { class: 'calc-tbtn small', style: 'margin-top:8px', onclick: () => { skuMode = 'approved'; loadSku(); } }, '← Вернуться к листу'),
    ]);
    const body = skuSheet();
    main.appendChild(el('div', { class: 'calc-sheet' }, [back, body]));
  }

  // Подтверждение перед тем, как убрать товар с листа. Показываем, что именно
  // теряем: по названию легко перепутать соседние столбцы, по цифрам — нет.
  function confirmRemoveProduct(x, d) {
    const facts = [];
    if (x.net_weight_g) facts.push('граммаж ' + money0(x.net_weight_g) + ' гр');
    if (x.raw_material_name) facts.push('сырьё «' + x.raw_material_name + '»');
    if (x.pack_template_name) facts.push('упаковка «' + x.pack_template_name + '»');
    if (x.price) facts.push('прайс 1 — ' + money0(x.price));
    if (x.price2) facts.push('прайс 2 — ' + money0(x.price2));
    const body = el('div', {}, [
      facts.length ? el('div', { class: 'calc-modal-facts' }, facts.join(' · ')) : null,
      el('p', { class: 'calc-modal-note' },
        'Товар уходит в архив: введённые цифры сохраняются, но расчёт по нему на листе больше не показывается.'),
    ]);
    const ok = el('button', { class: 'calc-btn danger', onclick: async () => {
      ok.disabled = true;
      try {
        await api('/sheet-product/' + x.id, { method: 'DELETE' });
        m.close(); toast('Товар убран с листа'); await load();
      } catch (e) { toast(e.message, true); ok.disabled = false; }
    } }, 'Убрать с листа');
    const m = calcModal('Убрать «' + x.name + '» с листа «' + d.sheet_title + '»?', body, [
      el('button', { class: 'calc-btn', onclick: () => m.close() }, 'Отмена'), ok,
    ]);
  }

  async function addProduct() {
    try { await post('/sheet/' + sheet + '/product', { name: 'Новый товар' }); await load(); }
    catch (e) { toast(e.message, true); }
  }



  // ---------------------------------------------------------------------------
  // Прайсы: каждая цена — своя сворачиваемая группа
  // ---------------------------------------------------------------------------
  // Себестоимость и ставки у прайсов общие, отличается только отпускная цена.
  // Поэтому наценка, прибыль, налог и чистая прибыль у каждого прайса свои —
  // их и показываем внутри его группы, как группировку строк в Excel.
  // Свёрнутая группа оставляет главное: цену и чистую прибыль.
  const openGroups = { p1: true, p2: false };

  function priceGroup(d, g) {
    const open = openGroups[g.key];
    const out = [];

    // Шапка группы: стрелка, название, цена и — когда свёрнута — итог
    out.push(el('tr', { class: 'calc-sku-r calc-grp' + (open ? ' on' : '') }, [
      el('th', { class: 'calc-sku-h', 'data-hint': ROW_HINTS[g.title] || '' },
        el('button', {
          class: 'calc-grp-btn',
          onclick: () => { openGroups[g.key] = !openGroups[g.key]; render(); },
          title: open ? 'Свернуть расчёт по этому прайсу' : 'Развернуть расчёт по этому прайсу',
        }, [el('span', { class: 'calc-grp-arrow' }, open ? '▾' : '▸'), g.title])),
      el('th', { class: 'calc-sku-u' }, 'сум'),
    ].concat(d.products.map((x) => el('td', { 'data-hint': GROUP_HINT }, [
      cell(g.value(x), (v) => save(x.id, { [g.priceField]: v }), { dec: 0, placeholder: 'цена' }),
      open ? null : el('div', { class: 'calc-grp-mini' },
        g.calc(x).net_profit === null ? 'нет расчёта'
          : 'ЧП ' + money(g.calc(x).net_profit) + ' · ' + money(g.calc(x).net_pct, 0) + '%'),
    ])))));

    if (!open) return out;

    const sub = (label, unit, cells, cls) => {
      const r = skuRow(label, unit, cells, 'calc-grp-row' + (cls ? ' ' + cls : ''));
      return r;
    };

    out.push(sub('Наценка %', '%', (x) => (g.calc(x).markup_pct === null ? dash()
      : el('span', {}, money(g.calc(x).markup_pct, 0) + '%')), 'calc-sku-green'));

    out.push(sub('Ретро бонусы', 'сум', (x) => [
      rateCell(x, 'retro_pct', x.retro_pct), auto(g.calc(x).retro),
    ]));

    out.push(sub('НДС', 'сум', (x) => [
      rateCell(x, 'vat_pct', x.vat_pct), auto(g.calc(x).vat),
    ]));

    out.push(sub('Прибыль', 'сум', (x) => auto(g.calc(x).profit)));

    out.push(sub('Налог на прибыль', 'сум', (x) => [
      rateCell(x, 'profit_tax_pct', x.profit_tax_pct), auto(g.calc(x).profit_tax),
    ]));

    out.push(sub('Чистая прибыль', 'сум', (x) => auto(g.calc(x).net_profit), 'calc-sku-accent'));

    out.push(sub('ЧП, %', '%', (x) => (g.calc(x).net_pct === null ? dash()
      : el('span', { class: g.calc(x).net_pct < 0 ? 'calc-bad' : '' }, money(g.calc(x).net_pct, 0) + '%'))));

    return out;
  }

  const GROUP_HINT = 'Отпускная цена по этому прайс-листу. Вводится вручную. '
    + 'Ниже — что из неё получается: наценка, ретро-бонусы, НДС, прибыль и налог.';

  // Ставка с кнопкой «поставить такую же всем товарам листа».
  // Ретро, НДС и налог в рознице обычно одинаковы, и проставлять их по одному —
  // потеря времени. Ставка у товара своя, кнопка лишь копирует её остальным.
  function rateCell(x, field, value) {
    const inp = pctCell(value, (v) => save(x.id, { [field]: v }));
    if (!canEdit()) return inp;
    const btn = el('button', {
      class: 'calc-rate-all',
      title: 'Поставить эту ставку всем товарам листа',
      onclick: async (e) => {
        e.stopPropagation();
        try {
          const r = await post('/sheet/' + sheet + '/apply-rate', { field, value });
          toast('Ставка проставлена: товаров ' + r.updated);
          await load();
        } catch (err) { toast(err.message, true); }
      },
    }, 'всем');
    return el('span', { class: 'calc-rate-wrap' }, [inp, btn]);
  }

  // ---------------------------------------------------------------------------
  // Строка «Цена в SalesDoctor»
  // ---------------------------------------------------------------------------
  // Только для сверки: в себестоимости и прибыли не участвует. Обновляется по
  // кнопке, а не при каждом открытии листа — выгрузка прайсов из SD идёт
  // постранично и не быстрая, ровно как со счётчиком реализации.
  function sdPriceRow(d) {
    const types = d.sd_price_types || [];
    const head = el('th', { class: 'calc-sku-h', 'data-hint': SD_HINT }, [
      el('div', { class: 'calc-sku-lbl calc-has-hint' }, 'Цена в SalesDoctor'),
      canEdit() ? el('div', { class: 'calc-sd-tools' }, [
        (() => {
          const sel = el('select', { class: 'calc-sel calc-sd-sel' },
            [el('option', { value: '' }, types.length ? '— прайс-лист —' : 'прайс-листов нет')]
              .concat(types.map((t) => {
                const o = el('option', { value: String(t.id) }, t.name);
                if (Number(d.sd_price_type_id) === t.id) o.setAttribute('selected', 'selected');
                return o;
              })));
          sel.addEventListener('change', async () => {
            try { await post('/sheet/' + sheet + '/sd-price-type', { id: sel.value || null }); await load(); }
            catch (e) { toast(e.message, true); }
          });
          return sel;
        })(),
        el('button', {
          class: 'calc-fact-btn', title: 'Заново выгрузить прайс-листы из SalesDoctor',
          onclick: refreshSdPrices,
        }, [el('span', { class: 'calc-fact-ico' }, '↻'), 'обновить']),
      ]) : null,
    ]);

    return el('tr', { class: 'calc-sku-r calc-sd-row' }, [
      head, el('th', { class: 'calc-sku-u', 'data-hint': SD_HINT }, 'сум'),
    ].concat(d.products.map((x) => el('td', { 'data-hint': sdCellHint(x, d) },
      x.sd_price === null || x.sd_price === undefined
        ? el('span', { class: 'calc-dim' }, '—')
        : el('span', {}, money0(x.sd_price))))));
  }

  const SD_HINT = 'Отпускная цена из прайс-листа SalesDoctor. Показана для сверки: '
    + 'в себестоимость и прибыль не входит. Товары сопоставляются по штрих-коду. '
    + 'Обновляется кнопкой, а не сама, — выгрузка прайсов из SalesDoctor не быстрая.';

  function sdCellHint(x, d) {
    if (!d.sd_price_type_id) return SD_HINT + '\n\nВыберите прайс-лист слева.';
    if (x.sd_price === null || x.sd_price === undefined) {
      return SD_HINT + '\n\n' + (x.barcode
        ? 'В этом прайс-листе нет цены по штрих-коду ' + x.barcode
        : 'У товара не заполнен штрих-код — сопоставить не с чем');
    }
    return SD_HINT + '\n\nШтрих-код ' + x.barcode
      + (x.sd_price_at ? ', выгружено ' + x.sd_price_at : '');
  }

  async function refreshSdPrices() {
    toast('Выгружаем прайс-листы из SalesDoctor…');
    try {
      await post('/sd-prices/refresh', {});
      toast('Цены обновлены');
      await load();
    } catch (e) { toast(e.message, true); }
  }

  // ---------------------------------------------------------------------------
  // Подсказка при наведении
  // ---------------------------------------------------------------------------
  // Своя, а не встроенная в браузер, по двум причинам:
  //  • встроенная появляется через секунду, её легко не дождаться;
  //  • в ячейке с полем ввода или выпадашкой браузер показывает подсказку
  //    поля, а подсказка самой ячейки не видна вообще.
  // Ищем ближайшего родителя с data-hint, поэтому наведение на поле внутри
  // ячейки тоже показывает объяснение этой ячейки.
  let hintBox = null;
  let hintFor = null;

  function hideHint() {
    if (hintBox) { hintBox.remove(); hintBox = null; }
    hintFor = null;
  }

  function showHint(host) {
    const text = host.getAttribute('data-hint');
    if (!text) return hideHint();
    if (hintFor === host) return;
    hideHint();
    hintFor = host;

    hintBox = el('div', { class: 'calc-hint' });
    // Пустая строка разделяет объяснение и расчёт — показываем их абзацами.
    text.split('\n\n').forEach((part, i) => {
      hintBox.appendChild(el('div', { class: i ? 'calc-hint-calc' : 'calc-hint-text' }, part));
    });
    document.body.appendChild(hintBox);

    const r = host.getBoundingClientRect();
    const b = hintBox.getBoundingClientRect();
    const gap = 8;
    // Снизу, если там есть место, иначе сверху. По горизонтали не вылезаем за экран.
    let top = r.bottom + gap;
    if (top + b.height > window.innerHeight - 8) top = Math.max(8, r.top - b.height - gap);
    let left = r.left;
    if (left + b.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - b.width - 8);
    hintBox.style.top = top + 'px';
    hintBox.style.left = left + 'px';
  }

  document.addEventListener('mouseover', (e) => {
    const host = e.target.closest ? e.target.closest('[data-hint]') : null;
    if (host) showHint(host); else hideHint();
  });
  document.addEventListener('mouseleave', hideHint, true);
  window.addEventListener('scroll', hideHint, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHint(); });

})();
