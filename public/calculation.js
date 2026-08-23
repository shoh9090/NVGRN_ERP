// calculation.js — плитка «Калькуляция себестоимости».
//
// Собираем по образцу рабочего Excel: каждый лист Excel = вкладка внизу экрана.
// Сейчас готов лист «Производство». Остальные вкладки появятся по мере сборки.
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
    { key: 'fot', title: 'ФОТ' },
    { key: 'packaging', title: 'Упаковка' },
    { key: 'raw', title: 'Зелень-сырьё' },
    { key: 'retail', title: 'Рознич. тара' },
    { key: 'horeca250', title: 'Хорека 250г' },
    { key: 'horeca500', title: 'Хорека 500' },
    { key: 'salads', title: 'Салаты' },
    { key: 'bunches', title: 'Пучки и горшки' },
  ];
  let sheet = 'production';
  let DATA = null;
  const canEdit = () => !!(DATA && DATA.can_edit);

  // ---------------------------------------------------------------------------
  // Ячейка с суммой: правится на месте, сохраняется при уходе из поля
  // ---------------------------------------------------------------------------
  function cell(value, onSave, opts = {}) {
    if (!canEdit() || !onSave) {
      return el('div', { class: 'calc-cell calc-ro' }, opts.dec === 0 ? money0(value) : money(value));
    }
    const inp = el('input', {
      type: 'text', inputmode: 'numeric', class: 'calc-cell',
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
    if (!canEdit()) return el('div', { class: 'calc-name calc-ro' }, value);
    const inp = el('input', { type: 'text', class: 'calc-name', value: value || '' });
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

    const list = el('div', { class: 'calc-pick-list' });
    const counter = el('div', { class: 'calc-pick-count' }, '');
    const refreshCount = () => { counter.textContent = 'выбрано: ' + selected.size; };

    const draw = (q) => {
      list.innerHTML = '';
      const qq = (q || '').trim().toLowerCase();
      const shown = all.filter((c) => !qq || c.label.toLowerCase().includes(qq));
      if (!shown.length) { list.appendChild(el('div', { class: 'calc-pick-empty' }, 'Ничего не найдено')); return; }
      let lastGroup = null;
      shown.forEach((c) => {
        if (c.group !== lastGroup) {
          lastGroup = c.group;
          const groupIds = shown.filter((x) => x.group === c.group).map((x) => Number(x.id));
          list.appendChild(el('div', { class: 'calc-pick-group' }, [
            el('span', {}, 'Группа ' + (c.group || '—')),
            el('button', {
              class: 'calc-pick-all',
              title: 'Отметить или снять всю группу',
              onclick: (e) => {
                e.stopPropagation();
                const allOn = groupIds.every((id) => selected.has(id));
                groupIds.forEach((id) => (allOn ? selected.delete(id) : selected.add(id)));
                draw(q); refreshCount();
              },
            }, 'вся группа'),
          ]));
        }
        const cb = el('input', { type: 'checkbox', checked: selected.has(Number(c.id)) ? 'checked' : null });
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(Number(c.id)); else selected.delete(Number(c.id));
          refreshCount();
        });
        const row = el('label', { class: 'calc-pick-item' }, [cb, el('span', {}, c.label)]);
        list.appendChild(row);
      });
    };

    const search = el('input', { type: 'search', class: 'calc-pick-search', placeholder: 'Поиск статьи…' });
    search.addEventListener('input', () => draw(search.value));

    const save = el('button', { class: 'calc-pick-save', onclick: async (e) => {
      e.stopPropagation();
      try {
        await post('/costs/' + item.id + '/categories', { ids: [...selected] });
        closeCatPicker();
        await load();
      } catch (err) { toast(err.message, true); }
    } }, 'Сохранить');

    const panel = el('div', { class: 'calc-pick', onclick: (e) => e.stopPropagation() }, [
      el('div', { class: 'calc-pick-head' }, [el('b', {}, item.name), counter]),
      search, list,
      el('div', { class: 'calc-pick-foot' }, [
        el('button', { class: 'calc-pick-clear', onclick: (e) => { e.stopPropagation(); selected.clear(); draw(search.value); refreshCount(); } }, 'Снять все'),
        save,
      ]),
    ]);

    draw(''); refreshCount();
    document.body.appendChild(panel);
    const r = anchor.getBoundingClientRect();
    panel.style.top = Math.min(r.bottom + 6, window.innerHeight - 380) + 'px';
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 360)) + 'px';
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
    main.appendChild(el('div', { class: 'calc-sheet' }, sheet === 'production' ? production() : el('div')));
    main.appendChild(sheetTabs());
  }

  // Вкладки листов — внизу, как в Excel
  function sheetTabs() {
    return el('div', { class: 'calc-tabs' }, SHEETS.map((s) => el('button', {
      class: 'calc-tab' + (sheet === s.key ? ' on' : '') + (s.ready ? '' : ' soon'),
      title: s.ready ? s.title : 'Этот лист ещё не собран',
      onclick: () => {
        if (!s.ready) return toast('Лист «' + s.title + '» ещё не собран — идём по порядку');
        sheet = s.key; render();
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
      el('thead', {}, el('tr', {}, [
        el('th', {}, ''),
        el('th', { class: 'calc-num' }, [el('div', {}, 'текущее в кальк.'), el('div', {}, 'расчётах')]),
        el('th', { class: 'calc-num' }, 'фактич'),
        el('th', {}, 'статьи ДДС Кассы'),
      ])),
      el('tbody', {}, [outputRow(d.output)].concat(
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
    // Заголовок блока
    rows.push(el('tr', { class: 'calc-r-head' }, [
      el('td', { colspan: '4' }, b.title),
    ]));

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

  load();
})();
