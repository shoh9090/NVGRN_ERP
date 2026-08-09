// calculation.js — интерфейс плитки «Калькуляция себестоимости».
//
// ВАЖНО (ТЗ 19.1): здесь НЕТ денежных формул. Любая себестоимость, маржа и
// рекомендуемая цена приходят с сервера (/api/calculate). Браузер только
// показывает цифры и собирает ввод.
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'html') n.innerHTML = v;
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) { if (c == null) continue; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return n;
  };
  // Деньги: на экране до двух знаков, коммерческая цена — без копеек.
  const money = (v, dec = 2) => (v === null || v === undefined || Number.isNaN(Number(v)))
    ? '—' : Number(v).toLocaleString('ru-RU', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const money0 = (v) => (v === null || v === undefined ? '—' : Math.round(Number(v)).toLocaleString('ru-RU'));
  const qty = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 6 }));
  const pct = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + '%');
  const ruDate = (s) => { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString('ru-RU'); };
  const api = async (path, opts) => {
    const r = await fetch('/calculation/api' + path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Ошибка сервера');
    return data;
  };
  const post = (path, body, method = 'POST') => api(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  let toastT = null;
  function toast(msg, bad) {
    const old = $('.calc-toast'); if (old) old.remove();
    const t = el('div', { class: 'calc-toast' + (bad ? ' bad' : '') }, msg);
    document.body.appendChild(t);
    clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3200);
  }

  let BOOT = null;
  let tab = 'products';   // на этапе 2 главное — состав изделий
  const canEdit = () => !!(BOOT && BOOT.rights && BOOT.rights.can_edit);

  // ---------------------------------------------------------------------------
  // Каркас страницы
  // ---------------------------------------------------------------------------
  const TABS = [
    ['matrix', 'Калькуляция'],
    ['products', 'Состав изделий'],
    ['models', 'Модели'],
    ['actual', 'Фактическая'],
    ['history', 'История'],
  ];

  async function boot() {
    const main = $('#calc-main');
    main.appendChild(el('div', { class: 'calc-loading' }, [el('div', { class: 'calc-skel', style: 'width:260px;margin:0 auto' }), el('div', { class: 'calc-skel', style: 'width:420px;margin:8px auto' })]));
    try { BOOT = await api('/bootstrap'); } catch (e) { main.innerHTML = ''; main.appendChild(el('div', { class: 'calc-empty' }, 'Не удалось загрузить: ' + e.message)); return; }
    const badge = $('#calc-mode-badge');
    if (badge) {
      const av = BOOT.active_version;
      badge.textContent = av
        ? 'действующая версия №' + av.revision_no + ' · ' + av.period
        : 'утверждённой версии пока нет';
    }
    render();
  }

  function render() {
    const main = $('#calc-main');
    main.innerHTML = '';
    main.appendChild(el('div', { class: 'calc-tabs' }, TABS.map(([id, label]) =>
      el('button', { class: 'calc-tab' + (tab === id ? ' on' : ''), onclick: () => { tab = id; render(); } }, label))));
    const box = el('div', { id: 'calc-content' });
    main.appendChild(box);
    if (tab === 'products') return viewProducts(box);
    return viewSoon(box, tab);
  }

  // Понятное пустое состояние с одним следующим действием (ТЗ 18).
  function viewSoon(box, which) {
    const texts = {
      matrix: ['Матрица себестоимости', 'Здесь появится привычная таблица: изделия по колонкам, показатели по строкам. Она собирается из состава изделий и данных периода.', 'Сначала соберите изделия'],
      models: ['Модели «что будет, если»', 'Здесь можно будет менять цену сырья, состав и цену продажи, не задевая утверждённый расчёт.', 'Сначала соберите изделия'],
      actual: ['Фактическая калькуляция', 'Здесь будет расчёт по фактическим ценам закупки месяца, фактическому ФОТ и расходам Кассы.', 'Сначала соберите изделия'],
      history: ['История версий', 'Здесь будут утверждённые и закрытые версии со снимками исходных данных и сравнением.', 'Сначала соберите изделия'],
    };
    const [h, t, act] = texts[which] || ['Раздел', '', ''];
    box.appendChild(el('div', { class: 'calc-empty' }, [
      el('div', { class: 'calc-empty-h' }, h),
      el('div', { class: 'calc-empty-t' }, t),
      el('button', { class: 'calc-btn', onclick: () => { tab = 'products'; render(); } }, act),
    ]));
  }

  // ---------------------------------------------------------------------------
  // Вкладка «Состав изделий»
  // ---------------------------------------------------------------------------
  const prodFilter = { q: '', family: '', status: 'active' };
  let PRODUCTS = [];

  async function viewProducts(box) {
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Состав изделий'),
        el('div', { class: 'calc-sub' }, 'Карточки изделий и рецептуры. Сырьё и упаковка берутся из существующей номенклатуры — отдельных справочников здесь нет.'),
      ]),
      canEdit() ? el('button', { class: 'calc-btn primary', onclick: () => openProduct(null) }, '+ Изделие') : null,
    ]));

    const search = el('input', { type: 'search', placeholder: 'Поиск по названию, артикулу, штрих-коду…', value: prodFilter.q,
      oninput: (e) => { prodFilter.q = e.target.value; clearTimeout(window.__calcT); window.__calcT = setTimeout(loadProducts, 300); } });
    const famSel = el('select', { onchange: (e) => { prodFilter.family = e.target.value; loadProducts(); } },
      [el('option', { value: '' }, 'Все виды')].concat((BOOT.families || []).map((f) => el('option', { value: f.v, selected: prodFilter.family === f.v || null }, f.t))));
    const stSel = el('select', { onchange: (e) => { prodFilter.status = e.target.value; loadProducts(); } },
      [['active', 'Активные'], ['archived', 'Архив']].map(([v, t]) => el('option', { value: v, selected: prodFilter.status === v || null }, t)));
    box.appendChild(el('div', { class: 'calc-filters' }, [search, famSel, stSel]));

    const list = el('div', { id: 'calc-prod-list' });
    box.appendChild(list);
    await loadProducts();
  }

  async function loadProducts() {
    const list = $('#calc-prod-list'); if (!list) return;
    list.innerHTML = '';
    list.appendChild(el('div', {}, [el('div', { class: 'calc-skel' }), el('div', { class: 'calc-skel' }), el('div', { class: 'calc-skel' })]));
    const p = new URLSearchParams();
    if (prodFilter.q) p.set('q', prodFilter.q);
    if (prodFilter.family) p.set('family', prodFilter.family);
    p.set('status', prodFilter.status);
    let d; try { d = await api('/products?' + p.toString()); } catch (e) { list.innerHTML = ''; list.appendChild(el('div', { class: 'calc-empty' }, 'Ошибка: ' + e.message)); return; }
    PRODUCTS = d.items || [];
    list.innerHTML = '';
    if (!PRODUCTS.length) {
      list.appendChild(el('div', { class: 'calc-empty' }, [
        el('div', { class: 'calc-empty-h' }, prodFilter.q || prodFilter.family ? 'Ничего не найдено' : 'Изделий пока нет'),
        el('div', { class: 'calc-empty-t' }, prodFilter.q || prodFilter.family
          ? 'Измените условия поиска.'
          : 'Создайте первое изделие: название, вид, единица выхода — потом добавите сырьё и упаковку.'),
        canEdit() && !prodFilter.q ? el('button', { class: 'calc-btn primary', onclick: () => openProduct(null) }, '+ Изделие') : null,
      ]));
      return;
    }
    const famName = (v) => ((BOOT.families || []).find((f) => f.v === v) || {}).t || v;
    const head = ['Изделие', 'Вид', 'Выход', 'Компонентов', 'Сырьё', 'Упаковка', 'Материалы всего', 'Состояние'];
    const thead = el('thead', {}, el('tr', {}, head.map((h, i) =>
      el('th', { class: i >= 4 && i <= 6 ? 'calc-num' : '', style: i >= 4 && i <= 6 ? 'text-align:right' : '' }, h))));
    const tb = el('tbody', {}, PRODUCTS.map((p) => el('tr', { class: 'clickable', onclick: () => openProduct(p.id) }, [
      el('td', {}, [
        el('div', { class: 'calc-strong' }, p.name),
        el('div', { class: 'calc-src' }, [p.internal_code, p.linked_name ? 'ERP: ' + p.linked_name : null].filter(Boolean).join(' · ') || '—'),
      ]),
      el('td', {}, famName(p.product_family)),
      el('td', {}, (p.output_unit_short || p.output_unit_name || '—') + (p.net_weight ? ' · ' + qty(p.net_weight) : '')),
      el('td', { class: 'calc-num' }, String(p.components || 0)),
      el('td', { class: 'calc-num' }, p.components ? money(p.raw_cost) : '—'),
      el('td', { class: 'calc-num' }, p.components ? money(p.packaging_cost) : '—'),
      el('td', { class: 'calc-num calc-strong' }, p.components ? money(p.material_cost) : '—'),
      el('td', {}, statePill(p)),
    ])));
    list.appendChild(el('div', { class: 'calc-table-wrap' }, el('table', { class: 'calc-table' }, [thead, tb])));
    list.appendChild(el('div', { class: 'calc-sub', style: 'margin-top:8px' },
      'Столбцы «Сырьё» и «Упаковка» — стоимость материалов на одну единицу по последним принятым ценам Закупа. ФОТ и накладные добавляются в матрице периода.'));
  }

  function statePill(p) {
    if (p.status === 'archived') return el('span', { class: 'calc-pill plain' }, 'Архив');
    if (!p.components) return el('span', { class: 'calc-pill warn' }, 'Нет рецептуры');
    if (p.missing_prices) return el('span', { class: 'calc-pill bad' }, 'Нет цены: ' + p.missing_prices);
    return el('span', { class: 'calc-pill ok' }, 'Готово');
  }

  // ---------------------------------------------------------------------------
  // Карточка изделия: паспорт + рецептура + предварительный расчёт
  // ---------------------------------------------------------------------------
  let PANEL = null;
  let pickerOpen = null;   // функция закрытия открытого окна выбора номенклатуры
  function closePanel(reload) {
    if (PANEL) { PANEL.remove(); PANEL = null; }
    document.body.style.overflow = '';
    if (reload) loadProducts();
  }
  function openPanel(title, bodyEl, footEls) {
    closePanel(false);
    const panel = el('div', { class: 'calc-panel' }, [
      el('div', { class: 'calc-panel-head' }, [
        el('div', { class: 'calc-panel-title' }, title),
        el('button', { class: 'calc-x', title: 'Закрыть', onclick: () => closePanel(true) }, '×'),
      ]),
      el('div', { class: 'calc-panel-body' }, bodyEl),
      el('div', { class: 'calc-panel-foot' }, footEls || []),
    ]);
    const ov = el('div', { class: 'calc-ov', onclick: (e) => { if (e.target === ov) closePanel(true); } }, panel);
    document.getElementById('calc-modal-root').appendChild(ov);
    document.body.style.overflow = 'hidden';
    PANEL = ov;
    return panel;
  }

  const field = (label, input, hint) => el('div', { class: 'calc-field' }, [
    el('label', {}, [label, input]),
    hint ? el('div', { class: 'calc-hint' }, hint) : null,
  ]);
  const inp = (value, attrs = {}) => el('input', Object.assign({ value: value === null || value === undefined ? '' : String(value) }, attrs));
  const sel = (options, value, attrs = {}) => el('select', attrs, options.map((o) => el('option', { value: o.v, selected: String(o.v) === String(value) || null }, o.t)));

  async function openProduct(id) {
    let data = { product: {}, recipe: null, items: [], families: BOOT.families };
    if (id) {
      try { data = await api('/products/' + id); } catch (e) { return toast(e.message, true); }
    }
    const p = data.product || {};
    const isNew = !id;
    const ro = !canEdit();

    // --- Паспорт изделия (ТЗ 12.1) ---
    const fName = inp(p.name, { placeholder: 'Например: Латук 100 г', disabled: ro || null });
    const fFamily = sel((BOOT.families || []).map((f) => ({ v: f.v, t: f.t })), p.product_family || 'mono', { disabled: ro || null });
    const fCode = inp(p.internal_code, { placeholder: 'необязательно', disabled: ro || null });
    const fBarcode = inp(p.barcode, { placeholder: 'необязательно', disabled: ro || null });
    const fOutUnit = sel([{ v: '', t: '— выберите —' }].concat((BOOT.units || []).map((u) => ({ v: u.id, t: u.short_name + ' · ' + u.name }))), p.output_unit_id || '', { disabled: ro || null });
    const fOutName = inp(p.output_unit_name, { placeholder: 'штука / пучок / упаковка', disabled: ro || null });
    const fWeight = inp(p.net_weight, { type: 'number', step: '0.001', placeholder: 'граммы или кг', disabled: ro || null });
    const fPrice = inp(p.price, { type: 'number', step: '0.01', placeholder: 'цена продажи', disabled: ro || null });
    const fIncl = sel([{ v: 'yes', t: 'Да — цена с НДС' }, { v: 'no', t: 'Нет — НДС сверху' }], p.price_includes_vat === false ? 'no' : 'yes', { disabled: ro || null });
    const fVat = inp(p.vat_rate === null || p.vat_rate === undefined ? BOOT.defaults.vat_rate : p.vat_rate, { type: 'number', step: '0.01', disabled: ro || null });
    const fRetro = inp(p.retro_rate || 0, { type: 'number', step: '0.01', disabled: ro || null });
    const fTax = inp(p.profit_tax_rate === null || p.profit_tax_rate === undefined ? BOOT.defaults.profit_tax_rate : p.profit_tax_rate, { type: 'number', step: '0.01', disabled: ro || null });
    const fTarget = inp(p.target_margin_rate, { type: 'number', step: '0.01', placeholder: 'необязательно', disabled: ro || null });
    const fStep = inp(p.price_round_step === null || p.price_round_step === undefined ? BOOT.defaults.price_round_step : p.price_round_step, { type: 'number', step: '1', disabled: ro || null });
    const fWaste = inp(p.waste_reserve_rate || 0, { type: 'number', step: '0.01', disabled: ro || null });
    const fComment = el('textarea', { rows: 2, placeholder: 'договорные и разовые условия', disabled: ro || null }, p.comment || '');

    const passport = el('div', { class: 'calc-block' }, [
      el('div', { class: 'calc-block-h' }, 'Паспорт изделия'),
      el('div', { class: 'calc-block-b' }, [
        el('div', { class: 'calc-grid' }, [
          field('Название *', fName),
          field('Вид изделия *', fFamily),
          field('Артикул калькулятора', fCode),
          field('Штрих-код', fBarcode),
          field('Единица выхода *', fOutUnit),
          field('Подпись выхода', fOutName, 'как называть единицу в отчётах'),
          field('Вес нетто', fWeight, 'для понятного отображения, рецептуру не заменяет'),
        ]),
        el('div', { class: 'calc-block-h', style: 'background:none;padding:14px 0 8px' }, 'Коммерческие параметры'),
        el('div', { class: 'calc-grid' }, [
          field('Цена продажи', fPrice, 'обязательна для утверждения версии'),
          field('Цена включает НДС', fIncl),
          field('Ставка НДС, %', fVat),
          field('Ретро / бонус, %', fRetro),
          field('Налог на прибыль, %', fTax, 'управленческая оценка, не декларация'),
          field('Целевая чистая маржа, %', fTarget),
          field('Шаг округления цены', fStep, 'по умолчанию 500 сум, вверх'),
          field('Резерв брака, %', fWaste, 'надбавка к себестоимости: 50% = ×1,5'),
        ]),
        el('div', { style: 'margin-top:12px' }, field('Комментарий', fComment)),
      ]),
    ]);

    // --- Рецептура ---
    let rows = (data.items || []).map((x) => ({
      item_kind: x.item_kind, item_id: x.item_id, name: x.name, code: x.code, unit: x.unit,
      qty_net: Number(x.qty_net), loss_rate: Number(x.loss_rate), comment: x.comment || '',
      price: x.price, price_date: x.price_date, price_source: x.price_source, supplier_name: x.supplier_name,
      nomenclature_missing: x.nomenclature_missing,
    }));
    const recipe = data.recipe;
    const fBatch = inp(recipe ? Number(recipe.batch_output_qty) : 1, { type: 'number', step: '0.000001', style: 'max-width:120px', disabled: ro || null });

    const rawBox = el('div');
    const packBox = el('div');
    const calcBox = el('div');

    const recipeBlock = el('div', { class: 'calc-block' }, [
      el('div', { class: 'calc-block-h' }, [
        el('span', {}, 'Рецептура'),
        el('span', { style: 'display:inline-flex;align-items:center;gap:8px;font-weight:400;font-size:12px' }, ['рецептура на', fBatch, 'единиц(ы) выхода']),
      ]),
      el('div', { class: 'calc-block-b' }, [
        el('div', { class: 'calc-recipe-note' }, 'Количество вводится на указанный выход. Сервер сначала приводит каждую строку к одной единице изделия и только потом считает стоимость. Для сырья в кг можно вводить граммы — переключатель единицы в строке.'),
        el('div', { class: 'calc-block-h', style: 'background:none;padding:6px 0' }, [
          el('span', {}, '🥬 Сырьё'),
          ro ? null : el('button', { class: 'calc-btn tiny', onclick: () => addRow('raw') }, '+ добавить сырьё'),
        ]),
        rawBox,
        el('div', { class: 'calc-block-h', style: 'background:none;padding:14px 0 6px' }, [
          el('span', {}, '📦 Упаковка и материалы'),
          ro ? null : el('button', { class: 'calc-btn tiny', onclick: () => addRow('packaging') }, '+ добавить упаковку'),
        ]),
        packBox,
      ]),
    ]);

    const HEAD_COLS = ['Позиция', 'Количество', 'Потери, %', 'С потерями', 'Цена и источник', 'Стоимость', ''];
    function drawRows() {
      for (const [kind, host] of [['raw', rawBox], ['packaging', packBox]]) {
        host.innerHTML = '';
        const list = rows.filter((r) => r.item_kind === kind);
        if (!list.length) {
          host.appendChild(el('div', { class: 'calc-sub', style: 'padding:8px 0;margin:0' },
            kind === 'raw' ? 'Сырьё не добавлено.' : 'Упаковка не добавлена.'));
          continue;
        }
        host.appendChild(el('div', { class: 'calc-rrow head' }, HEAD_COLS.map((h) => el('span', {}, h))));
        list.forEach((r) => host.appendChild(rowEl(r)));
      }
      recalc();
    }

    function rowEl(r) {
      const idx = rows.indexOf(r);
      // Количество: для кг/л разрешаем быстрый ввод в граммах/миллилитрах (ТЗ 13.4).
      const baseUnit = (r.unit || '').toLowerCase();
      const small = baseUnit === 'кг' ? 'г' : baseUnit === 'л' ? 'мл' : null;
      let showUnit = r._show_unit || baseUnit;
      const factor = () => (small && showUnit === small ? 1000 : 1);
      const qtyIn = inp(r.qty_net * factor(), { type: 'number', step: 'any', class: 'calc-num-in', disabled: ro || null,
        oninput: (e) => { r.qty_net = (Number(e.target.value) || 0) / factor(); recalc(); } });
      const unitSel = small
        ? sel([{ v: baseUnit, t: baseUnit }, { v: small, t: small }], showUnit, { disabled: ro || null,
            onchange: (e) => { r._show_unit = e.target.value; drawRows(); } })
        : el('span', { class: 'calc-src', style: 'padding-top:9px;display:block' }, r.unit || '—');
      const lossIn = inp(r.loss_rate, { type: 'number', step: '0.01', class: 'calc-num-in', disabled: ro || null,
        oninput: (e) => { r.loss_rate = Number(e.target.value) || 0; recalc(); } });
      // Количество с потерями и стоимость строки считает СЕРВЕР (ТЗ 19.1):
      // здесь только места под цифры, которые заполнит ответ /api/calculate.
      return el('div', { class: 'calc-rrow', 'data-rowkey': String(idx) }, [
        el('div', {}, [
          el('div', { class: 'calc-rowname' + (r.nomenclature_missing ? ' ' : '') }, r.name || '(не выбрано)'),
          el('div', { class: 'calc-rowcode' }, [r.code, r.unit].filter(Boolean).join(' · ') || ''),
          r.nomenclature_missing ? el('div', { class: 'calc-err-inline' }, 'позиции нет в справочнике') : null,
        ]),
        el('div', { style: 'display:flex;gap:4px;align-items:flex-start' }, [qtyIn, unitSel]),
        lossIn,
        el('div', { class: 'calc-num calc-cell-qty', style: 'padding-top:9px;color:var(--ink-faint)' }, '…'),
        el('div', {}, r.price === null || r.price === undefined
          ? el('span', { class: 'calc-pill bad' }, 'Нет закупочной цены')
          : el('div', {}, [
              el('div', { class: 'calc-num', style: 'text-align:left;font-weight:700' }, money(r.price) + (r.unit ? ' / ' + r.unit : '')),
              el('div', { class: 'calc-src' }, [r.price_source === 'import' ? 'архив' : 'Закуп', ruDate(r.price_date), r.supplier_name].filter(Boolean).join(' · ')),
            ])),
        el('div', { class: 'calc-num calc-strong calc-cell-cost', style: 'padding-top:9px;color:var(--ink-faint)' }, '…'),
        ro ? el('span') : el('button', { class: 'calc-rrow-del', title: 'Убрать строку',
          onclick: () => { rows.splice(idx, 1); drawRows(); } }, '🗑'),
      ]);
    }

    // Добавление позиции: поиск по существующей номенклатуре (ТЗ 13.5 — свободный текст запрещён).
    function addRow(kind) {
      pickNomenclature(kind, (item) => {
        rows.push({ item_kind: kind, item_id: item.id, name: item.name, code: item.code, unit: item.unit,
          qty_net: 0, loss_rate: 0, comment: '', price: item.price, price_date: item.price_date, price_source: item.price_source });
        drawRows();
      });
    }

    // Предварительный расчёт — считает сервер.
    let calcT = null;
    function recalc() {
      clearTimeout(calcT);
      calcT = setTimeout(runCalc, 350);
    }
    async function runCalc() {
      const usable = rows.map((r, i) => ({ r, i })).filter((x) => x.r.item_id && Number(x.r.qty_net) > 0);
      if (!usable.length) {
        calcBox.innerHTML = '';
        calcBox.appendChild(el('div', { class: 'calc-sub', style: 'margin:0' }, 'Добавьте компоненты с количеством — расчёт появится сразу.'));
        return;
      }
      calcBox.innerHTML = '';
      calcBox.appendChild(el('div', { class: 'calc-skel', style: 'width:60%' }));
      try {
        const d = await post('/calculate', {
          period: BOOT.period ? BOOT.period.period : undefined,
          batch_output_qty: Number(fBatch.value) || 1,
          items: usable.map((x) => ({ item_kind: x.r.item_kind, item_id: x.r.item_id, qty_net: x.r.qty_net, loss_rate: x.r.loss_rate })),
          commercial: {
            price: Number(fPrice.value) || 0,
            price_includes_vat: fIncl.value === 'yes',
            vat_rate: Number(fVat.value) || 0,
            retro_rate: Number(fRetro.value) || 0,
            profit_tax_rate: Number(fTax.value) || 0,
            target_margin_rate: fTarget.value === '' ? null : Number(fTarget.value),
            waste_reserve_rate: Number(fWaste.value) || 0,
            price_round_step: Number(fStep.value) || 0,
          },
        });
        fillRowCells(d.result.rows || [], usable);
        drawCalc(d);
      } catch (e) {
        calcBox.innerHTML = '';
        calcBox.appendChild(el('div', { class: 'calc-msg err' }, e.message));
      }
    }

    // Возвращаем серверные цифры в те же строки рецептуры.
    function fillRowCells(serverRows, usable) {
      usable.forEach((x, i) => {
        const sr = serverRows[i]; if (!sr) return;
        const host = rawBox.parentElement ? recipeBlock.querySelector('[data-rowkey="' + x.i + '"]') : null;
        if (!host) return;
        const q = host.querySelector('.calc-cell-qty');
        const c = host.querySelector('.calc-cell-cost');
        if (q) { q.textContent = qty(sr.qty_with_loss); q.style.color = ''; }
        if (c) { c.textContent = sr.cost === null || sr.cost === undefined ? '—' : money(sr.cost); c.style.color = ''; }
      });
    }

    function drawCalc(d) {
      const r = d.result, L = r.layers, C = r.commercial;
      calcBox.innerHTML = '';
      // Сообщения: сначала блокирующие, потом предупреждения.
      const msgs = el('div', { class: 'calc-msgs' });
      (r.errors || []).forEach((x) => msgs.appendChild(el('div', { class: 'calc-msg err' }, '⛔ ' + x.message)));
      (r.warnings || []).forEach((x) => msgs.appendChild(el('div', { class: 'calc-msg warn' }, '⚠️ ' + x.message)));
      ((d.sources && d.sources.warnings) || []).forEach((x) => msgs.appendChild(el('div', { class: 'calc-msg warn' }, '⚠️ ' + x.message)));
      if (msgs.children.length) calcBox.appendChild(msgs);

      const card = (lbl, val, cls, src) => el('div', { class: 'calc-sum-card' + (cls ? ' ' + cls : '') }, [
        el('div', { class: 'calc-sum-lbl' }, lbl),
        el('div', { class: 'calc-sum-val' }, val),
        src ? el('div', { class: 'calc-src' }, src) : null,
      ]);
      calcBox.appendChild(el('div', { class: 'calc-sum' }, [
        card('Сырьё', money(L.raw)),
        card('Упаковка', money(L.packaging)),
        card('ФОТ с налогами', L.fot_per_unit ? money(L.fot_per_unit) : '—', null, 'Персонал · ' + d.period),
        card('Производственные', money(L.production_per_unit), null, 'Касса · ' + d.period),
        card('Административные', money(L.admin_per_unit), null, 'Касса · ' + d.period),
        card('Полная себестоимость', money(L.full_cost), 'accent', 'резерв брака ' + pct(L.waste_reserve_rate)),
      ]));
      calcBox.appendChild(el('div', { class: 'calc-sum', style: 'margin-top:10px' }, [
        card('НДС в цене', money(C.vat), null, C.includes_vat ? 'цена с НДС' : 'НДС сверху'),
        card('Ретро', money(C.retro)),
        card('Прибыль до налога', money(C.profit_before_tax), C.profit_before_tax < 0 ? 'bad' : null),
        card('Налог на прибыль', money(C.profit_tax)),
        card('Чистая прибыль', money(C.net_profit), C.net_profit < 0 ? 'bad' : null),
        card('Чистая маржа', C.net_margin === null ? '—' : pct(C.net_margin), C.net_margin !== null && C.net_margin < 0 ? 'bad' : null),
        card('Рекомендуемая цена', r.recommended && r.recommended.price ? money0(r.recommended.price) : '—', null,
          r.recommended && r.recommended.error ? r.recommended.error : 'цель: сохранить маржу, вверх до ' + money0(r.inputs.commercial.price_round_step)),
      ]));
      const out = d.sources && d.sources.output;
      calcBox.appendChild(el('div', { class: 'calc-sub', style: 'margin-top:10px' },
        'ФОТ и накладные распределены поровну на одну произведённую единицу. Общий выпуск: '
        + (out && out.total ? qty(out.total) + ' ед.' + (out.mode === 'planned' ? ' (план периода)' : out.mode === 'actual' ? ' (факт)' : '') : 'не задан')
        + '. Коэффициенты трудоёмкости по изделиям в этой версии не применяются.'));
    }

    const calcBlock = el('div', { class: 'calc-block' }, [
      el('div', { class: 'calc-block-h' }, 'Предварительный расчёт'),
      el('div', { class: 'calc-block-b' }, calcBox),
    ]);

    // --- Кнопки ---
    const errBox = el('div');
    const save = el('button', { class: 'calc-btn primary', onclick: async () => {
      errBox.innerHTML = '';
      const payload = {
        name: fName.value.trim(), product_family: fFamily.value,
        internal_code: fCode.value, barcode: fBarcode.value,
        output_unit_id: fOutUnit.value || null, output_unit_name: fOutName.value,
        net_weight: fWeight.value === '' ? null : Number(fWeight.value),
        price: fPrice.value === '' ? null : Number(fPrice.value),
        price_includes_vat: fIncl.value === 'yes',
        vat_rate: fVat.value === '' ? null : Number(fVat.value),
        retro_rate: Number(fRetro.value) || 0,
        profit_tax_rate: fTax.value === '' ? null : Number(fTax.value),
        target_margin_rate: fTarget.value === '' ? null : Number(fTarget.value),
        price_round_step: Number(fStep.value) || 0,
        waste_reserve_rate: Number(fWaste.value) || 0,
        comment: fComment.value,
      };
      if (!payload.name) { errBox.appendChild(el('div', { class: 'calc-msg err' }, 'Укажите название изделия')); return; }
      if (!payload.output_unit_id) { errBox.appendChild(el('div', { class: 'calc-msg err' }, 'Выберите единицу выхода')); return; }
      try {
        let pid = id;
        if (isNew) {
          const r = await post('/products', Object.assign({ batch_output_qty: Number(fBatch.value) || 1 }, payload));
          pid = r.id;
        } else {
          await post('/products/' + id, payload, 'PATCH');
        }
        // Сохраняем состав в черновик рецептуры.
        let rid = recipe ? recipe.id : null;
        if (!rid) { const rr = await post('/recipes', { product_id: pid }); rid = rr.id; }
        await post('/recipes/' + rid, {
          batch_output_qty: Number(fBatch.value) || 1,
          items: rows.filter((r) => r.item_id).map((r) => ({ item_kind: r.item_kind, item_id: r.item_id, qty_net: r.qty_net, loss_rate: r.loss_rate, comment: r.comment })),
        }, 'PATCH');
        toast('Сохранено');
        closePanel(true);
      } catch (e) {
        errBox.appendChild(el('div', { class: 'calc-msg err' }, e.message));
      }
    } }, isNew ? 'Создать изделие' : 'Сохранить');

    const foot = [];
    if (!ro) foot.push(save);
    if (!isNew && !ro) {
      foot.unshift(el('button', { class: 'calc-btn', onclick: async () => {
        try { const r = await post('/products/' + id + '/copy', {}); toast('Скопировано'); closePanel(true); openProduct(r.id); }
        catch (e) { toast(e.message, true); }
      } }, '⧉ Копировать'));
      foot.unshift(el('button', { class: 'calc-btn' + (p.status === 'archived' ? '' : ' danger'), onclick: async () => {
        const toArchive = p.status !== 'archived';
        try { await post('/products/' + id, { status: toArchive ? 'archived' : 'active' }, 'PATCH');
          toast(toArchive ? 'Изделие в архиве' : 'Изделие снова активно'); closePanel(true); }
        catch (e) { toast(e.message, true); }
      } }, p.status === 'archived' ? '↩ Вернуть из архива' : '🗄 В архив'));
    }

    openPanel(isNew ? 'Новое изделие' : p.name, [errBox, passport, recipeBlock, calcBlock], foot);
    drawRows();
  }

  // ---------------------------------------------------------------------------
  // Выбор позиции номенклатуры (поиск с 2 символов, задержка ввода)
  // ---------------------------------------------------------------------------
  function pickNomenclature(kind, onPick) {
    const search = inp('', { type: 'search', placeholder: kind === 'raw' ? 'Название или код сырья…' : 'Название или код упаковки…', autofocus: 'autofocus' });
    const listBox = el('div', { style: 'margin-top:10px;min-height:120px' });
    let t = null;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 280); });
    async function run() {
      const q = search.value.trim();
      listBox.innerHTML = '';
      if (q.length < 2) { listBox.appendChild(el('div', { class: 'calc-sub', style: 'margin:0' }, 'Введите минимум 2 символа.')); return; }
      listBox.appendChild(el('div', { class: 'calc-skel' }));
      let d; try { d = await api('/nomenclature?kind=' + kind + '&q=' + encodeURIComponent(q)); }
      catch (e) { listBox.innerHTML = ''; listBox.appendChild(el('div', { class: 'calc-msg err' }, e.message)); return; }
      listBox.innerHTML = '';
      if (!d.items.length) {
        listBox.appendChild(el('div', { class: 'calc-empty' }, [
          el('div', { class: 'calc-empty-t' }, 'Ничего не найдено. Позиции создаются в справочниках номенклатуры, здесь их завести нельзя.'),
        ]));
        return;
      }
      listBox.appendChild(el('div', { class: 'calc-pick-list', style: 'position:static;box-shadow:none' }, d.items.map((it) =>
        el('div', { class: 'calc-pick-item', onclick: () => { onPick(it); close(); } }, [
          el('div', { class: 'calc-pick-nm' }, it.name),
          el('div', { class: 'calc-pick-meta' }, [it.code, it.unit, it.category,
            it.price === null ? '⛔ нет цены' : money(it.price) + ' / ' + it.unit + ' · ' + ruDate(it.price_date)].filter(Boolean).join(' · ')),
        ]))));
    }
    // Отдельная панель ПОВЕРХ карточки изделия. Свой оверлей, PANEL не трогаем —
    // карточка остаётся открытой, введённые данные не теряются (ТЗ 18).
    const close = () => { ov.remove(); pickerOpen = null; };
    const panel = el('div', { class: 'calc-panel', style: 'max-width:560px' }, [
      el('div', { class: 'calc-panel-head' }, [
        el('div', { class: 'calc-panel-title' }, kind === 'raw' ? 'Выбор сырья' : 'Выбор упаковки'),
        el('button', { class: 'calc-x', title: 'Закрыть', onclick: close }, '×'),
      ]),
      el('div', { class: 'calc-panel-body' }, [search, listBox]),
    ]);
    const ov = el('div', { class: 'calc-ov', style: 'z-index:80', onclick: (e) => { if (e.target === ov) close(); } }, panel);
    document.getElementById('calc-modal-root').appendChild(ov);
    pickerOpen = close;
    setTimeout(() => search.focus(), 50);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (pickerOpen) { pickerOpen(); return; }   // сначала закрываем выбор номенклатуры
    if (PANEL) closePanel(true);
  });
  boot();
})();
