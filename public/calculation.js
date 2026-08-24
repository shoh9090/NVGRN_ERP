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

  // Листы, как внизу в Excel. Готовые открываются, остальные пока недоступны.
  const SHEETS = [
    { key: 'production', title: 'Производство', ready: true },
    { key: 'packaging', title: 'Упаковка', ready: true },
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
        sheet = s.key; load();
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

  load();
  // ---------------------------------------------------------------------------
  // Товарные листы: Рознич. тара, Хорека, Салаты, Пучки
  // ---------------------------------------------------------------------------
  // Строки — статьи расчёта, столбцы — товары: ровно как в Excel.
  // Считает всё сервер, здесь только показ и отправка правок.
  let SKU = null;

  async function loadSku() {
    let d;
    try { d = await api('/sheet/' + sheet); }
    catch (e) {
      const main = $('#calc-main'); main.innerHTML = '';
      main.appendChild(sheetTabs());
      main.appendChild(el('div', { class: 'calc-empty' }, 'Не удалось загрузить: ' + e.message));
      return;
    }
    SKU = d;
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
  function skuRow(label, unit, cells, cls) {
    const p = SKU.products;
    return el('tr', { class: 'calc-sku-r' + (cls ? ' ' + cls : '') }, [
      el('th', { class: 'calc-sku-h' }, el('div', { class: 'calc-sku-lbl' }, label)),
      el('th', { class: 'calc-sku-u' }, unit || ''),
    ].concat(p.map((x) => el('td', {}, cells(x)))));
  }

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

    box.appendChild(el('div', { class: 'calc-sheet-head' }, [
      el('h1', { class: 'calc-h1' }, d.sheet_title),
      el('div', { class: 'calc-sub' }, 'Строки — расчёт, столбцы — товары. Упаковка и затраты на штуку подтягиваются с листов «Упаковка» и «Производство». Серые цифры считает система, белые поля — ваш ввод.'),
    ]));

    if (d.no_output_reason) {
      box.appendChild(el('div', { class: 'calc-msg warn' }, '⚠️ ' + d.no_output_reason));
    }

    if (!d.products.length) {
      box.appendChild(el('div', { class: 'calc-empty' }, [
        el('div', {}, 'Товаров на этом листе пока нет.'),
        canEdit() ? el('button', { class: 'calc-add', onclick: addProduct }, '+ товар') : null,
      ]));
      return box;
    }

    const tplOptions = d.pack_templates;
    const rawOptions = d.raw_materials || [];
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
        class: 'calc-del', title: 'Убрать товар с листа',
        onclick: async () => {
          try { await api('/sheet-product/' + x.id, { method: 'DELETE' }); toast('Товар убран'); await load(); }
          catch (e) { toast(e.message, true); }
        },
      }, '×') : null,
    ])))));

    // --- Строки идут ровно в том же порядке, что на листе «0000_розница» ---
    rows.push(skuRow('Граммаж', 'гр', (x) =>
      cell(x.net_weight_g, (v) => save(x.id, { net_weight_g: v }), { dec: 0, placeholder: 'гр' })));

    rows.push(skuRow('наименование', '', (x) => {
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
    }));

    rows.push(skuRow('Упаковка', 'сум', (x) => [
      auto(x.calc.components.pack),
      x.pack_incomplete ? el('div', { class: 'calc-warn-mini' }, 'в комплекте есть строки без цены') : null,
    ]));

    rows.push(skuRow('Производ.затраты / накладные расходы', 'сум', (x) => [
      auto(x.calc.components.production),
      // Из чего сложилась цифра: оба блока листа «Производство».
      (d.base.production_per_unit !== null && d.base.overhead_per_unit !== null)
        ? el('div', { class: 'calc-src-mini' },
          money(d.base.production_per_unit * x.prod_factor, 0) + ' + '
          + money(d.base.overhead_per_unit * x.prod_factor, 0))
        : null,
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
    rows.push(skuRow('ФОТ', 'сум', () => [
      auto(d.base.labor_per_unit),
      d.base.payroll_fund
        ? el('div', { class: 'calc-src-mini' }, 'из Персонала: ' + money0(d.base.payroll_fund))
        : el('div', { class: 'calc-warn-mini' }, 'в Персонале нет окладов'),
    ]));

    rows.push(skuRow('с\\с', 'сум', (x) => [
      auto(x.calc.cost),
      x.calc.missing ? el('div', { class: 'calc-warn-mini' },
        'нет: ' + (x.calc.missing_keys || []).map((k) => COMP_NAMES[k] || k).join(', ')) : null,
    ], 'calc-sku-sum'));

    rows.push(skuRow('с\\с с браком', 'сум', (x) => [
      pctCell(x.defect_pct, (v) => save(x.id, { defect_pct: v })),
      auto(x.calc.cost_defect),
    ], 'calc-sku-accent'));

    rows.push(el('tr', { class: 'calc-r-gap' },
      el('td', { colspan: String(d.products.length + 2) }, '')));

    rows.push(skuRow('Наценка %', '%', (x) => (x.calc.markup_pct === null ? dash()
      : el('span', {}, money(x.calc.markup_pct, 0) + '%')), 'calc-sku-green'));

    rows.push(skuRow('Цена нов прайс', 'сум', (x) =>
      cell(x.price, (v) => save(x.id, { price: v }), { dec: 0, placeholder: 'цена' }), 'calc-sku-green'));

    rows.push(skuRow('цена прайс2026(korz)', 'сум', (x) =>
      cell(x.price2, (v) => save(x.id, { price2: v }), { dec: 0, placeholder: 'цена' }), 'calc-sku-green'));

    rows.push(skuRow('Ретро бонусы', 'сум', (x) => [
      pctCell(x.retro_pct, (v) => save(x.id, { retro_pct: v })), auto(x.calc.retro),
    ]));

    rows.push(skuRow('НДС', 'сум', (x) => [
      pctCell(x.vat_pct, (v) => save(x.id, { vat_pct: v })), auto(x.calc.vat),
    ]));

    rows.push(skuRow('Прибыль', 'сум', (x) => auto(x.calc.profit)));

    rows.push(skuRow('Налог на прибыль', 'сум', (x) => [
      pctCell(x.profit_tax_pct, (v) => save(x.id, { profit_tax_pct: v })), auto(x.calc.profit_tax),
    ]));

    rows.push(skuRow('Чистая прибыль', 'сум', (x) => auto(x.calc.net_profit), 'calc-sku-accent'));

    rows.push(skuRow('ЧП, %', '%', (x) => (x.calc.net_pct === null ? dash()
      : el('span', { class: x.calc.net_pct < 0 ? 'calc-bad' : '' }, money(x.calc.net_pct, 0) + '%'))));

    box.appendChild(el('div', { class: 'calc-sku-wrap' },
      el('table', { class: 'calc-sku-t' }, el('tbody', {}, rows))));

    if (canEdit()) {
      box.appendChild(el('button', { class: 'calc-add', onclick: addProduct }, '+ товар'));
    }
    box.appendChild(el('div', { class: 'calc-note' },
      'Зелень в упаковке = граммаж × стоимость зелени. Цена за кг берётся из Закупа по выбранному наименованию, а если её там нет — вписывается вручную. Упаковка — из выбранного комплекта на листе «Упаковка». Производственные и накладные затраты на штуку — с листа «Производство», делённые на среднемесячный выпуск'
      + (d.base.output ? ' (' + money0(d.base.output) + ' шт)' : '')
      + '. ФОТ берётся из плитки «Персонал» (фонд окладов активных сотрудников), делённый на тот же выпуск. Показан отдельно и в себестоимость не входит — так же, как в вашем файле.'));
    return box;
  }

  async function addProduct() {
    try { await post('/sheet/' + sheet + '/product', { name: 'Новый товар' }); await load(); }
    catch (e) { toast(e.message, true); }
  }

})();
