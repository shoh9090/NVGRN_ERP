// calculation.js — экран «Затраты» плитки «Калькуляция себестоимости».
//
// Собираем заново, по одному экрану. Сейчас здесь только затраты — как лист
// «Произодство» в Excel: строки правятся прямо в таблице, итог считается сразу.
//
// Денежных формул здесь НЕТ: суммы и «на штуку» приходят с сервера.
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
    ? '—' : Number(v).toLocaleString('ru-RU', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const money0 = (v) => (v === null || v === undefined ? '—' : Math.round(Number(v)).toLocaleString('ru-RU'));
  const monthRu = (ym) => {
    const names = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    const [y, m] = String(ym || '').split('-').map(Number);
    return names[(m || 1) - 1] + ' ' + y;
  };

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

  let DATA = null;
  const canEdit = () => !!(DATA && DATA.can_edit);

  // Поле суммы: сохраняем при уходе из поля, а не на каждую цифру.
  function amountInput(value, onSave) {
    const inp = el('input', {
      type: 'text', inputmode: 'numeric', class: 'calc-amount',
      value: value ? Number(value).toLocaleString('ru-RU') : '',
      disabled: canEdit() ? null : true,
    });
    const clean = () => Number(String(inp.value).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
    inp.addEventListener('focus', () => { inp.value = String(clean() || ''); inp.select(); });
    inp.addEventListener('blur', async () => {
      const v = clean();
      inp.value = v ? v.toLocaleString('ru-RU') : '';
      if (v === Number(value)) return;      // ничего не менялось
      try { await onSave(v); await load(); } catch (e) { toast(e.message, true); }
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    return inp;
  }

  function nameInput(value, onSave) {
    const inp = el('input', { type: 'text', class: 'calc-name-in', value: value || '', disabled: canEdit() ? null : true });
    inp.addEventListener('blur', async () => {
      const v = inp.value.trim();
      if (!v) { inp.value = value; return; }
      if (v === value) return;
      try { await onSave(v); } catch (e) { toast(e.message, true); inp.value = value; }
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    return inp;
  }

  // ---------------------------------------------------------------------------
  // Отрисовка
  // ---------------------------------------------------------------------------
  async function load() {
    let d;
    try { d = await api('/costs'); } catch (e) { return renderError(e.message); }
    DATA = d;
    render();
  }

  function renderError(message) {
    const main = $('#calc-main');
    main.innerHTML = '';
    main.appendChild(el('div', { class: 'calc-empty' }, 'Не удалось загрузить: ' + message));
  }

  function render() {
    const d = DATA;
    const main = $('#calc-main');
    main.innerHTML = '';

    main.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h1' }, 'Затраты'),
        el('div', { class: 'calc-sub' }, 'Сколько тратим в месяц и сколько из этого приходится на одну единицу продукции. Правьте суммы прямо в таблице.'),
      ]),
    ]));

    // --- Выпуск: главный знаменатель ---
    const outInp = amountInput(d.output, (v) => post('/output', { output: v }));
    outInp.classList.add('calc-output-in');
    main.appendChild(el('div', { class: 'calc-output' }, [
      el('div', {}, [
        el('div', { class: 'calc-output-lbl' }, 'Среднемесячный выпуск'),
        el('div', { class: 'calc-hint' }, 'Сколько единиц продукции выпускаем за месяц. На это число делятся все затраты.'),
      ]),
      el('div', { class: 'calc-output-val' }, [outInp, el('span', { class: 'calc-unit' }, 'шт')]),
    ]));

    if (d.block_reason) {
      main.appendChild(el('div', { class: 'calc-msg warn' }, '⚠️ ' + d.block_reason));
    }

    // --- Блоки затрат ---
    (d.blocks || []).forEach((b) => main.appendChild(costBlock(b)));

    // --- ФОТ ---
    main.appendChild(fotBlock(d.fot));

    // --- Итог ---
    main.appendChild(el('div', { class: 'calc-total' }, [
      el('div', {}, [
        el('div', { class: 'calc-total-lbl' }, 'Затрат на одну единицу'),
        el('div', { class: 'calc-hint' }, 'Производственные + накладные + ФОТ. Дальше к этому добавится стоимость сырья и упаковки.'),
      ]),
      el('div', { class: 'calc-total-val' }, d.total_per_unit === null ? '—' : money(d.total_per_unit) + ' сум'),
    ]));

    main.appendChild(el('div', { class: 'calc-next' }, [
      el('b', {}, 'Что дальше. '),
      'Следующим шагом добавим цены сырья и упаковки, потом сами товары — и получится полная себестоимость.',
    ]));
  }

  function costBlock(b) {
    const rows = b.items.map((item) => el('tr', {}, [
      el('td', {}, nameInput(item.name, (v) => post('/costs/' + item.id, { name: v }))),
      el('td', { class: 'calc-num' }, amountInput(item.amount, (v) => post('/costs/' + item.id, { amount: v }))),
      el('td', { class: 'calc-num calc-per' }, item.per_unit === null ? '—' : money(item.per_unit)),
      el('td', { class: 'calc-act' }, canEdit() ? el('button', {
        class: 'calc-del', title: 'Убрать статью',
        onclick: async () => {
          try { await api('/costs/' + item.id, { method: 'DELETE' }); toast('Статья убрана'); await load(); }
          catch (e) { toast(e.message, true); }
        },
      }, '×') : null),
    ]));

    if (!rows.length) {
      rows.push(el('tr', {}, el('td', { colspan: '4', class: 'calc-empty-row' }, 'Статей пока нет.')));
    }

    return el('div', { class: 'calc-block' }, [
      el('div', { class: 'calc-block-h' }, [
        el('div', {}, [
          el('div', { class: 'calc-block-t' }, b.title),
          el('div', { class: 'calc-hint' }, b.hint),
        ]),
      ]),
      el('table', { class: 'calc-t' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'Статья'),
          el('th', { class: 'calc-num' }, 'Сумма в месяц'),
          el('th', { class: 'calc-num' }, 'На единицу'),
          el('th', {}, ''),
        ])),
        el('tbody', {}, rows),
        el('tfoot', {}, el('tr', {}, [
          el('td', {}, 'Итого'),
          el('td', { class: 'calc-num' }, money0(b.total)),
          el('td', { class: 'calc-num' }, b.per_unit === null ? '—' : money(b.per_unit)),
          el('td', {}, ''),
        ])),
      ]),
      canEdit() ? el('div', { class: 'calc-block-f' }, el('button', {
        class: 'calc-add',
        onclick: async () => {
          try { await post('/costs', { block: b.key, name: 'Новая статья', amount: 0 }); await load(); }
          catch (e) { toast(e.message, true); }
        },
      }, '+ Добавить статью')) : null,
    ]);
  }

  function fotBlock(f) {
    const fromHr = f.mode === 'hr';
    const rows = [];

    if (fromHr) {
      // Все части налога показываем отдельно — ничего не прячем в итоге.
      [['Начислено', f.accrued], ['ИНПС', f.inps], ['НДФЛ', f.ndfl], ['Соцналог', f.social]]
        .forEach(([name, value]) => rows.push(el('tr', {}, [
          el('td', {}, name),
          el('td', { class: 'calc-num' }, money0(value)),
          el('td', { class: 'calc-num calc-per' }, ''),
          el('td', {}, ''),
        ])));
    } else {
      rows.push(el('tr', {}, [
        el('td', {}, 'ФОТ с налогами (введён вручную)'),
        el('td', { class: 'calc-num' }, amountInput(f.manual, (v) => post('/fot', { manual: v }))),
        el('td', { class: 'calc-num calc-per' }, ''),
        el('td', {}, ''),
      ]));
    }

    const switcher = canEdit() ? el('div', { class: 'calc-switch' }, [
      el('button', {
        class: 'calc-sw' + (fromHr ? ' on' : ''),
        onclick: async () => { try { await post('/fot', { mode: 'hr' }); await load(); } catch (e) { toast(e.message, true); } },
      }, 'Из Кадров'),
      el('button', {
        class: 'calc-sw' + (fromHr ? '' : ' on'),
        onclick: async () => { try { await post('/fot', { mode: 'manual' }); await load(); } catch (e) { toast(e.message, true); } },
      }, 'Ввести вручную'),
    ]) : null;

    return el('div', { class: 'calc-block' }, [
      el('div', { class: 'calc-block-h' }, [
        el('div', {}, [
          el('div', { class: 'calc-block-t' }, 'Фонд оплаты труда'),
          el('div', { class: 'calc-hint' }, fromHr
            ? 'Фактические начисления и налоги за ' + monthRu(f.period) + ' из плитки «Кадры».'
            : 'Сумма введена вручную. Кадры показывают за ' + monthRu(f.period) + ': ' + money0(f.hr_total) + ' сум.'),
        ]),
        switcher,
      ]),
      el('table', { class: 'calc-t' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'Статья'),
          el('th', { class: 'calc-num' }, 'Сумма в месяц'),
          el('th', { class: 'calc-num' }, 'На единицу'),
          el('th', {}, ''),
        ])),
        el('tbody', {}, rows),
        el('tfoot', {}, el('tr', {}, [
          el('td', {}, 'ФОТ с налогами'),
          el('td', { class: 'calc-num' }, money0(f.total)),
          el('td', { class: 'calc-num' }, f.per_unit === null ? '—' : money(f.per_unit)),
          el('td', {}, ''),
        ])),
      ]),
      (f.warnings || []).length
        ? el('div', { class: 'calc-block-f' }, f.warnings.map((w) => el('div', { class: 'calc-msg warn' }, '⚠️ ' + w.message)))
        : null,
    ]);
  }

  load();
})();
