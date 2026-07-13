// calculation.js — рабочий лист плановой калькуляции.
(function () {
  const $ = (s) => document.querySelector(s);

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children != null) (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  const fmt = (v, max = 2) => {
    if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
    return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: max });
  };
  const money = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '—' : fmt(v, 2) + ' сум');
  const pct = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : fmt(v, 1) + '%');
  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
  const ruDate = (d) => d ? String(d).slice(0, 10).split('-').reverse().join('.') : '';

  async function api(path) {
    const r = await fetch('/calculation/api' + path);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Ошибка загрузки');
    return d;
  }

  async function post(path, body) {
    const r = await fetch('/calculation/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Ошибка сохранения');
    return d;
  }

  function toast(msg, err) {
    const t = el('div', { class: 'calc-toast' + (err ? ' err' : '') }, msg);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 250);
    }, 2800);
  }

  const inp = (val, attrs) => el('input', Object.assign({ class: 'calcf-inp', value: val == null ? '' : String(val) }, attrs || {}));
  const area = (val, attrs) => el('textarea', Object.assign({ class: 'calcf-inp calc-textarea' }, attrs || {}), val == null ? '' : String(val));
  function select(options, value, attrs) {
    return el('select', Object.assign({ class: 'calcf-inp' }, attrs || {}), options.map((o) =>
      el('option', { value: o.v, selected: String(o.v) === String(value || '') || null }, o.t)
    ));
  }

  let TAB = 'recipes';
  let DICTS = { priceTypes: [], products: [], settings: {} };
  let MATERIALS = [];
  let RECIPES = [];
  let CURRENT_ID = null;
  let CURRENT = null;
  let DRAFT = null;
  let recipeQ = '';
  let recipeGroup = '';
  // Взаимозависимые фильтры цен: родительская категория → категория (как в «Справочниках»).
  const priceFilters = { parent: '', category: '', q: '' };
  // Настройка столбцов таблицы цен (как в SD: галочки показать/скрыть). Переиспользуемый паттерн.
  const PRICE_COLS = [
    { key: 'type', label: 'Тип', width: '80px' },
    { key: 'category', label: 'Категория', width: '120px' },
    { key: 'name', label: 'Наименование', width: 'minmax(190px,1.4fr)', always: true },
    { key: 'char', label: 'Характеристика', width: 'minmax(110px,.9fr)' },
    { key: 'calc', label: 'Цена в кальк.', width: '130px', always: true },
    { key: 'last', label: 'Последняя закупка', width: '160px' },
    { key: 'comment', label: 'Комментарий', width: 'minmax(140px,.8fr)' },
  ];
  const priceColsHidden = new Set(JSON.parse(localStorage.getItem('calc_price_cols_hidden') || '[]'));
  let priceColsOpen = false;
  const visiblePriceCols = () => PRICE_COLS.filter((cc) => cc.always || !priceColsHidden.has(cc.key));

  const productLabel = (p) => (p ? ((p.code ? p.code + ' · ' : '') + p.name) : '');
  const materialLabel = (m) => (m ? ((m.code ? m.code + ' · ' : '') + m.name) : '');
  const materialByKey = () => Object.fromEntries(MATERIALS.map((m) => [m.kind + ':' + m.id, m]));
  const productById = () => Object.fromEntries((DICTS.products || []).map((p) => [String(p.id), p]));

  // Живой пересчёт на клиенте — зеркало серверного recipeSummary в src/calculation.js.
  // Нужен, чтобы себестоимость/маржа менялись прямо при вводе, до сохранения.
  function computeLine(it) {
    const kind = it.item_kind === 'packaging' ? 'packaging' : 'raw';
    const m = materialByKey()[kind + ':' + it.item_id] || {};
    const qty = num(it.qty);
    const wasteMult = 1 + num(it.waste_pct) / 100;
    const hasManual = it.manual_price != null && String(it.manual_price).trim() !== '';
    const manual = num(it.manual_price);
    const calcPrice = hasManual ? manual : num(m.calc_price);
    const marketPrice = hasManual ? manual : num(m.market_price || m.last_purchase_price || m.calc_price);
    const baseQty = kind === 'packaging' ? qty : qty / 1000;
    return { calc_price: calcPrice, market_price: marketPrice, calc_cost: baseQty * calcPrice * wasteMult, market_cost: baseQty * marketPrice * wasteMult };
  }
  function computeSummary(draft) {
    const s = DICTS.settings || {};
    const items = (draft.items || []).map(computeLine);
    const itemCalc = items.reduce((a, x) => a + x.calc_cost, 0);
    const itemMarket = items.reduce((a, x) => a + x.market_cost, 0);
    // Постоянные затраты — из группы рецептуры, иначе из общих настроек.
    const grp = (DICTS.groups || []).find((g) => String(g.id) === String(draft.group_id)) || {};
    const perUnit = (gv, sv) => (gv != null && gv !== '' ? num(gv) : num(s[sv]));
    const labor = perUnit(grp.labor_per_unit, 'labor_per_unit') * num(draft.labor_coeff);
    const production = perUnit(grp.production_per_unit, 'production_per_unit') * num(draft.production_coeff);
    const overhead = perUnit(grp.overhead_per_unit, 'overhead_per_unit') * num(draft.overhead_coeff);
    const fixed = labor + production + overhead;
    const wasteMult = 1 + num(draft.waste_pct) / 100;
    const costRaw = itemCalc + fixed;          // с/с без брака
    const costRawMarket = itemMarket + fixed;
    const costCalc = costRaw * wasteMult;      // с/с с браком
    const costMarket = costRawMarket * wasteMult;
    // Цена продажи: ручная либо последняя загруженная из SD (по типу цены).
    const sdPrice = CURRENT && CURRENT.recipe ? num(CURRENT.recipe.sd_sale_price) : 0;
    const salePrice = String(draft.sale_price_override || '').trim() !== '' ? num(draft.sale_price_override) : sdPrice;
    const retro = salePrice * num(draft.retro_pct) / 100;
    const vat = salePrice * num(draft.vat_pct) / 100;
    const profit = salePrice - costCalc - retro - vat;
    const profitTax = Math.max(profit, 0) * num(draft.profit_tax_pct) / 100;
    const netProfit = profit - profitTax;
    return {
      item_calc: itemCalc, item_market: itemMarket, labor, production, overhead, fixed,
      cost_raw: costRaw, cost_raw_market: costRawMarket,
      cost_calc: costCalc, cost_market: costMarket, market_delta: costMarket - costCalc,
      markup_pct: costCalc ? (salePrice - costCalc) / costCalc * 100 : null,
      sale_price: salePrice, retro, vat, profit, profit_tax: profitTax, net_profit: netProfit,
      margin_pct: salePrice ? netProfit / salePrice * 100 : null,
    };
  }

  function findProductByLabel(label) {
    const s = String(label || '').trim().toLowerCase();
    if (!s) return null;
    return (DICTS.products || []).find((p) => productLabel(p).toLowerCase() === s || String(p.name || '').toLowerCase() === s) || null;
  }

  function findMaterialByLabel(kind, label) {
    const s = String(label || '').trim().toLowerCase();
    if (!s) return null;
    return MATERIALS.find((m) => m.kind === kind && (materialLabel(m).toLowerCase() === s || String(m.name || '').toLowerCase() === s)) || null;
  }

  async function boot() {
    // Панели настройки (столбцы цен, строки матрицы) закрываются по клику вне них.
    document.addEventListener('click', (e) => {
      const inWrap = e.target.closest && e.target.closest('.calc-cols-wrap');
      if ((priceColsOpen || matrixCfgOpen) && !inWrap) {
        if (priceColsOpen) priceColsOpen = false;
        if (matrixCfgOpen) matrixCfgOpen = false;
        render();
      }
    });
    try {
      await reloadBase();
      render();
    } catch (e) {
      $('#calc-main').innerHTML = '';
      $('#calc-main').appendChild(el('div', { class: 'calc-empty' }, 'Ошибка загрузки: ' + e.message));
    }
  }

  async function reloadBase() {
    const [dicts, materials, recipes] = await Promise.all([api('/dicts'), api('/materials'), api('/recipes')]);
    DICTS = dicts;
    MATERIALS = materials.items || [];
    RECIPES = recipes.items || [];
  }

  function shell() {
    const main = $('#calc-main');
    main.innerHTML = '';
    const tab = (id, label) => el('button', {
      class: 'calc-tab' + (TAB === id ? ' on' : ''),
      onclick: () => { syncDraftFromDom(); TAB = id; render(); },
    }, label);
    main.appendChild(el('div', { class: 'calc-tabs' }, [
      tab('recipes', 'Рецептуры'),
      tab('matrix', 'Матрица'),
      tab('prices', 'Цены сырья'),
      tab('costs', 'Затраты'),
      tab('settings', 'Настройки'),
    ]));
    main.appendChild(el('div', { id: 'calc-content' }));
  }

  function datalists() {
    return el('div', { class: 'calc-datalists' }, [
      el('datalist', { id: 'calc-products' }, (DICTS.products || []).map((p) => el('option', { value: productLabel(p) }))),
      el('datalist', { id: 'calc-materials-raw' }, MATERIALS.filter((m) => m.kind === 'raw').map((m) => el('option', { value: materialLabel(m) }))),
      el('datalist', { id: 'calc-materials-packaging' }, MATERIALS.filter((m) => m.kind === 'packaging').map((m) => el('option', { value: materialLabel(m) }))),
    ]);
  }

  function render() {
    shell();
    $('#calc-main').appendChild(datalists());
    if (TAB === 'matrix') return renderMatrix();
    if (TAB === 'prices') return renderPrices();
    if (TAB === 'costs') return renderCosts();
    if (TAB === 'settings') return renderSettings();
    return renderRecipes();
  }

  function kpi(label, value, tone) {
    return el('div', { class: 'calc-kpi' }, [
      el('div', { class: 'calc-kpi-l' }, label),
      el('div', { class: 'calc-kpi-v ' + (tone || '') }, String(value)),
    ]);
  }

  function recipeName(row) {
    const r = row.recipe || row || {};
    return r.fg_name || r.product_name || 'Без названия';
  }

  function makeDraft(data) {
    const r = data && data.recipe ? data.recipe : {};
    const pb = productById();
    const product = r.product_id ? pb[String(r.product_id)] : null;
    return {
      id: r.id || null,
      product_id: r.product_id || '',
      group_id: r.group_id || '',
      product_label: product ? productLabel(product) : '',
      product_name: r.product_name || '',
      pack_weight_g: r.pack_weight_g || '',
      pack_unit: r.pack_unit || 'шт',
      sale_price_type_id: r.sale_price_type_id || '',
      sale_price_override: r.sale_price_override == null ? '' : r.sale_price_override,
      retro_pct: r.retro_pct ?? DICTS.settings.retro_pct ?? 0,
      vat_pct: r.vat_pct ?? DICTS.settings.vat_pct ?? 12,
      profit_tax_pct: r.profit_tax_pct ?? DICTS.settings.profit_tax_pct ?? 15,
      waste_pct: r.waste_pct ?? DICTS.settings.waste_pct ?? 3,
      labor_coeff: r.labor_coeff ?? 1,
      production_coeff: r.production_coeff ?? 1,
      overhead_coeff: r.overhead_coeff ?? 1,
      comment: r.comment || '',
      items: ((data && data.items) || []).map((it) => ({ ...it })),
    };
  }

  async function loadRecipe(id) {
    try {
      CURRENT_ID = id;
      CURRENT = await api('/recipe/' + id);
      DRAFT = makeDraft(CURRENT);
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function startNewRecipe() {
    CURRENT_ID = null;
    CURRENT = null;
    DRAFT = makeDraft(null);
    DRAFT.items = [
      { item_kind: 'raw', qty: '', unit: 'г', waste_pct: 0, manual_price: '' },
      { item_kind: 'packaging', qty: '', unit: 'шт', waste_pct: 0, manual_price: '' },
    ];
    render();
  }

  function renderRecipes() {
    const c = $('#calc-content');
    const avgCost = RECIPES.length ? RECIPES.reduce((s, x) => s + num(x.summary.cost_calc), 0) / RECIPES.length : 0;
    const marketUp = RECIPES.filter((x) => num(x.summary.market_delta) > 0.01).length;
    const avgMarginRows = RECIPES.filter((x) => x.summary.margin_pct !== null && x.summary.margin_pct !== undefined);
    const avgMargin = avgMarginRows.length ? avgMarginRows.reduce((s, x) => s + num(x.summary.margin_pct), 0) / avgMarginRows.length : null;

    c.appendChild(el('div', { class: 'calc-head calc-head-tight' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Калькуляция'),
        el('div', { class: 'calc-sub' }, 'Рецептуры, цены сырья, рыночное сравнение и маржа на одном экране.'),
      ]),
      el('button', { class: 'btn-primary calc-add', onclick: startNewRecipe }, '+ Новая рецептура'),
    ]));
    c.appendChild(el('div', { class: 'calc-kpis calc-kpis-compact' }, [
      kpi('Всего рецептур', RECIPES.length, ''),
      kpi('Себестоимость средняя', money(avgCost), 'green'),
      kpi('Рынок дороже', marketUp, marketUp ? 'warn' : ''),
      kpi('Маржа средняя', pct(avgMargin), ''),
    ]));

    const grid = el('div', { class: 'calc-workspace' });
    grid.appendChild(recipeNavigator());
    grid.appendChild(recipeSheet());
    c.appendChild(grid);
  }

  function recipeNavigator() {
    const q = inp(recipeQ, {
      placeholder: 'Найти рецептуру',
      oninput: (e) => { recipeQ = e.target.value; clearTimeout(window.__calcRq); window.__calcRq = setTimeout(render, 180); },
    });
    const grpSel = select([{ v: '', t: 'Все группы' }, ...(DICTS.groups || []).map((g) => ({ v: g.id, t: g.name }))], recipeGroup, {
      onchange: (e) => { recipeGroup = e.target.value; render(); },
    });
    const needle = recipeQ.trim().toLowerCase();
    const rows = RECIPES.filter((x) => (!needle || recipeName(x).toLowerCase().includes(needle))
      && (!recipeGroup || String(x.recipe.group_id || '') === String(recipeGroup)));
    const list = rows.map((x) => {
      const r = x.recipe;
      const s = x.summary || {};
      const delta = num(s.market_delta);
      return el('button', {
        class: 'calc-recipe-card' + (String(CURRENT_ID) === String(r.id) ? ' on' : ''),
        onclick: () => loadRecipe(r.id),
      }, [
        el('span', { class: 'calc-recipe-title' }, recipeName(x)),
        el('span', { class: 'calc-recipe-meta' }, (r.group_name ? r.group_name + ' · ' : '') + (r.fg_code ? r.fg_code + ' · ' : '') + (x.item_count || 0) + ' строк'),
        el('span', { class: 'calc-recipe-numbers' }, [
          el('b', {}, money(s.cost_calc)),
          el('small', { class: delta > 0 ? 'bad' : delta < 0 ? 'good' : '' }, 'рынок ' + money(s.cost_market)),
        ]),
      ]);
    });
    return el('aside', { class: 'calc-nav' }, [
      el('div', { class: 'calc-nav-title' }, 'Рецептуры'),
      q,
      grpSel,
      el('div', { class: 'calc-nav-list' }, list.length ? list : [el('div', { class: 'calc-empty calc-empty-mini' }, 'Пока нет рецептур')]),
    ]);
  }

  function recipeSheet() {
    if (!DRAFT) {
      return el('section', { class: 'calc-sheet calc-empty' }, [
        el('div', { class: 'calc-empty-big' }, 'Выберите рецептуру или создайте новую'),
        el('div', {}, 'После выбора здесь будет один рабочий лист без модалки: параметры, состав и итоги.'),
      ]);
    }
    const s = computeSummary(DRAFT);
    return el('section', { class: 'calc-sheet', oninput: refreshTotals }, [
      sheetToolbar(),
      sheetMeta(),
      sheetSummary(s),
      sheetItems(),
    ]);
  }

  // Пересчёт итогов «на лету» без полной перерисовки (чтобы не терять фокус в поле).
  function refreshTotals() {
    if (!DRAFT || !$('.calc-sheet')) return;
    syncDraftFromDom();
    const strip = $('.calc-summary-strip');
    if (strip) strip.replaceWith(sheetSummary(computeSummary(DRAFT)));
    (DRAFT.items || []).forEach((it, i) => {
      const row = document.querySelector('.calc-item-row[data-index="' + i + '"]');
      if (!row) return;
      const line = computeLine(it);
      const set = (sel, val) => { const n = row.querySelector(sel); if (n) n.textContent = money(val); };
      set('.calc-cell-pc', line.calc_price);
      set('.calc-cell-pm', line.market_price);
      set('.calc-cell-sc', line.calc_cost);
      set('.calc-cell-sm', line.market_cost);
    });
  }

  function sheetToolbar() {
    return el('div', { class: 'calc-sheet-toolbar' }, [
      el('div', {}, [
        el('div', { class: 'calc-h3' }, DRAFT.id ? 'Рецептура #' + DRAFT.id : 'Новая рецептура'),
        el('div', { class: 'calc-sub' }, DRAFT.id ? 'Редактируйте прямо в таблице и сохраните изменения.' : 'Заполните товар и состав, затем сохраните рецептуру.'),
      ]),
      el('div', { class: 'calc-sheet-actions' }, [
        DRAFT.id ? el('button', { class: 'btn-ghost calc-danger', onclick: archiveRecipe }, 'Архив') : null,
        el('button', { class: 'btn-primary calc-save-big', onclick: saveWholeRecipe }, 'Сохранить'),
      ]),
    ]);
  }

  function cell(label, control, cls) {
    return el('label', { class: 'calc-cell ' + (cls || '') }, [el('span', {}, label), control]);
  }

  function sheetMeta() {
    const groups = [{ v: '', t: '— группа —' }, ...(DICTS.groups || []).map((g) => ({ v: g.id, t: g.name }))];
    // Основное — что определяет рецептуру. Цену, ретро и коэффициенты удобнее править в «Матрице».
    const main = el('div', { class: 'calc-meta-grid' }, [
      cell('Товар', inp(DRAFT.product_label, { name: 'product_label', list: 'calc-products', placeholder: 'начните вводить товар' }), 'wide'),
      cell('Название вручную', inp(DRAFT.product_name, { name: 'product_name', placeholder: 'если товара нет в справочнике' }), 'wide'),
      cell('Группа (канал)', select(groups, DRAFT.group_id, { name: 'group_id' })),
      cell('Вес, г', inp(DRAFT.pack_weight_g, { name: 'pack_weight_g', type: 'number', step: '0.1' })),
      cell('Ед.', inp(DRAFT.pack_unit, { name: 'pack_unit' })),
      cell('Потери / брак, %', inp(DRAFT.waste_pct, { name: 'waste_pct', type: 'number', step: '0.1' })),
      cell('Комментарий', area(DRAFT.comment, { name: 'comment', placeholder: 'заметки по рецептуре' }), 'wide'),
    ]);
    // Дополнительно — редко трогаемое (по умолчанию свёрнуто).
    const adv = el('details', { class: 'calc-adv' }, [
      el('summary', {}, 'Дополнительно: цена, ставки, коэффициенты'),
      el('div', { class: 'calc-meta-grid', style: 'margin-top:8px' }, [
        cell('Цена вручную', inp(DRAFT.sale_price_override, { name: 'sale_price_override', type: 'number', step: '0.01', placeholder: 'пусто = из SD' })),
        cell('Ретро %', inp(DRAFT.retro_pct, { name: 'retro_pct', type: 'number', step: '0.1' })),
        cell('НДС %', inp(DRAFT.vat_pct, { name: 'vat_pct', type: 'number', step: '0.1' })),
        cell('Налог на прибыль %', inp(DRAFT.profit_tax_pct, { name: 'profit_tax_pct', type: 'number', step: '0.1' })),
        cell('ФОТ ×', inp(DRAFT.labor_coeff, { name: 'labor_coeff', type: 'number', step: '0.1' })),
        cell('Производство ×', inp(DRAFT.production_coeff, { name: 'production_coeff', type: 'number', step: '0.1' })),
        cell('Накладные ×', inp(DRAFT.overhead_coeff, { name: 'overhead_coeff', type: 'number', step: '0.1' })),
      ]),
    ]);
    return el('div', {}, [main, adv]);
  }

  function sheetSummary(s) {
    const rows = [
      ['Сырьё + упаковка', s.item_calc, s.item_market],
      ['ФОТ', s.labor, s.labor],
      ['Производство', s.production, s.production],
      ['Накладные', s.overhead, s.overhead],
      ['с/с (без брака)', s.cost_raw, s.cost_raw_market],
      ['с/с с браком', s.cost_calc, s.cost_market, 'total'],
      ['Наценка %', s.markup_pct == null ? null : pct(s.markup_pct), s.markup_pct == null ? null : pct(s.markup_pct)],
      ['Цена продажи', s.sale_price, s.sale_price],
      ['Ретро-бонус', s.retro, s.retro],
      ['НДС', s.vat, s.vat],
      ['Прибыль до налога', s.profit, s.profit],
      ['Налог на прибыль', s.profit_tax, s.profit_tax],
      ['Чистая прибыль', s.net_profit, s.net_profit, 'total'],
      ['Чистая маржа (ЧП %)', s.margin_pct == null ? null : pct(s.margin_pct), s.margin_pct == null ? null : pct(s.margin_pct)],
    ];
    return el('div', { class: 'calc-summary-strip' }, [
      kpi('Себестоимость', money(s.cost_calc), 'green'),
      kpi('По рынку', money(s.cost_market), num(s.market_delta) > 0 ? 'warn' : ''),
      kpi('Разница', (num(s.market_delta) > 0 ? '+' : '') + money(s.market_delta), num(s.market_delta) > 0 ? 'warn' : 'green'),
      kpi('Прибыль', money(s.net_profit), num(s.net_profit) < 0 ? 'bad' : 'green'),
      el('div', { class: 'calc-summary-table' }, [
        el('div', { class: 'calc-summary-row head' }, [el('span', {}, 'Статья'), el('span', {}, 'Калькуляция'), el('span', {}, 'Рынок')]),
        ...rows.map((r) => el('div', { class: 'calc-summary-row ' + (r[3] || '') }, [
          el('span', {}, r[0]),
          el('span', { class: 'tnum' }, typeof r[1] === 'string' ? r[1] : money(r[1])),
          el('span', { class: 'tnum muted' }, typeof r[2] === 'string' ? r[2] : money(r[2])),
        ])),
      ]),
    ]);
  }

  function sheetItems() {
    const items = DRAFT.items || [];
    return el('div', { class: 'calc-sheet-items' }, [
      el('div', { class: 'calc-items-head' }, [
        el('div', {}, [
          el('div', { class: 'calc-sec-title' }, 'Состав'),
          el('div', { class: 'calc-sub' }, 'Сырьё в граммах на единицу, упаковка в штуках.'),
        ]),
        el('div', { class: 'calc-head-btns' }, [
          el('button', { class: 'btn-ghost calc-line-add', onclick: () => addItem('raw') }, '+ строка сырья'),
          el('button', { class: 'btn-ghost calc-line-add', onclick: () => addItem('packaging') }, '+ упаковка'),
        ]),
      ]),
      el('div', { class: 'calc-item-table calc-excel-table' }, [
        el('div', { class: 'calc-item-row head' }, [
          el('span', {}, '#'),
          el('span', {}, 'Тип'),
          el('span', {}, 'Сырьё / упаковка'),
          el('span', {}, 'Норма'),
          el('span', {}, 'Ед.'),
          el('span', {}, 'Потери %'),
          el('span', {}, 'Цена кальк.'),
          el('span', {}, 'Рынок'),
          el('span', {}, 'Сумма кальк.'),
          el('span', {}, 'Сумма рынок'),
          el('span', {}, 'Ручная цена'),
          el('span', {}, ''),
        ]),
        ...items.map((it, i) => itemRow(it, i)),
      ]),
    ]);
  }

  function itemMaterialLabel(it) {
    const m = materialByKey()[`${it.item_kind}:${it.item_id}`];
    return it.material_label || materialLabel(m);
  }

  function itemRow(it, i) {
    const kind = it.item_kind === 'packaging' ? 'packaging' : 'raw';
    const line = computeLine(it);
    const kindSel = select([{ v: 'raw', t: 'Сырьё' }, { v: 'packaging', t: 'Упаковка' }], kind, {
      name: 'item_kind',
      onchange: (e) => {
        syncDraftFromDom();
        DRAFT.items[i].item_kind = e.target.value;
        DRAFT.items[i].item_id = '';
        DRAFT.items[i].material_label = '';
        DRAFT.items[i].unit = e.target.value === 'raw' ? 'г' : 'шт';
        render();
      },
    });
    return el('div', { class: 'calc-item-row', 'data-index': i, 'data-item-id': it.item_id || '' }, [
      el('span', { class: 'calc-row-num' }, String(i + 1)),
      kindSel,
      inp(itemMaterialLabel(it), { name: 'material_label', list: 'calc-materials-' + kind, placeholder: 'начните вводить позицию' }),
      inp(it.qty, { name: 'qty', type: 'number', step: '0.001', placeholder: kind === 'raw' ? 'г' : 'шт' }),
      inp(it.unit || (kind === 'raw' ? 'г' : 'шт'), { name: 'unit' }),
      inp(it.waste_pct, { name: 'waste_pct', type: 'number', step: '0.1' }),
      el('span', { class: 'tnum muted calc-cell-pc' }, money(line.calc_price)),
      el('span', { class: 'tnum muted calc-cell-pm' }, money(line.market_price)),
      el('span', { class: 'tnum calc-cell-sc' }, money(line.calc_cost)),
      el('span', { class: 'tnum muted calc-cell-sm' }, money(line.market_cost)),
      inp(it.manual_price, { name: 'manual_price', type: 'number', step: '0.01', placeholder: 'авто' }),
      el('button', { class: 'calc-icon-btn', title: 'Удалить строку', onclick: () => { syncDraftFromDom(); DRAFT.items.splice(i, 1); render(); } }, '×'),
    ]);
  }

  function readRecipeFromDom() {
    const root = $('.calc-sheet');
    if (!root || !DRAFT) return DRAFT;
    // Толерантно: если поле убрано из UI — берём значение из DRAFT.
    const val = (n) => { const e = root.querySelector('[name="' + n + '"]'); return e ? e.value : DRAFT[n]; };
    const productInput = root.querySelector('[name="product_label"]');
    const product = findProductByLabel(productInput && productInput.value);
    return {
      ...DRAFT,
      product_id: product ? product.id : '',
      group_id: val('group_id'),
      product_label: productInput ? productInput.value : DRAFT.product_label,
      product_name: val('product_name'),
      pack_weight_g: val('pack_weight_g'),
      pack_unit: val('pack_unit'),
      sale_price_type_id: val('sale_price_type_id'),
      sale_price_override: val('sale_price_override'),
      retro_pct: val('retro_pct'),
      vat_pct: val('vat_pct'),
      profit_tax_pct: val('profit_tax_pct'),
      waste_pct: val('waste_pct'),
      labor_coeff: val('labor_coeff'),
      production_coeff: val('production_coeff'),
      overhead_coeff: val('overhead_coeff'),
      comment: val('comment'),
      items: readItemsFromDom(),
    };
  }

  function readItemsFromDom() {
    return [...document.querySelectorAll('.calc-item-row[data-index]')].map((row) => {
      const kind = row.querySelector('[name="item_kind"]').value;
      const label = row.querySelector('[name="material_label"]').value;
      const found = findMaterialByLabel(kind, label);
      const prevId = row.getAttribute('data-item-id') || '';
      const prev = prevId ? materialByKey()[kind + ':' + prevId] : null;
      const sameAsPrev = prev && materialLabel(prev) === String(label || '').trim();
      return {
        item_kind: kind,
        item_id: found ? found.id : (sameAsPrev ? prevId : ''),
        material_label: label,
        qty: row.querySelector('[name="qty"]').value,
        unit: row.querySelector('[name="unit"]').value,
        waste_pct: row.querySelector('[name="waste_pct"]').value,
        manual_price: row.querySelector('[name="manual_price"]').value,
      };
    });
  }

  function syncDraftFromDom() {
    if (!DRAFT || !$('.calc-sheet')) return;
    DRAFT = readRecipeFromDom();
  }

  function addItem(kind) {
    syncDraftFromDom();
    if (!DRAFT) startNewRecipe();
    DRAFT.items = DRAFT.items || [];
    DRAFT.items.push({ item_kind: kind, item_id: '', material_label: '', qty: '', unit: kind === 'raw' ? 'г' : 'шт', waste_pct: 0, manual_price: '' });
    render();
  }

  async function saveWholeRecipe() {
    syncDraftFromDom();
    if (!DRAFT) return;
    const productName = String(DRAFT.product_name || '').trim() || (!DRAFT.product_id ? String(DRAFT.product_label || '').trim() : '');
    if (!DRAFT.product_id && !productName) return toast('Выберите товар или напишите название вручную', true);
    const bad = (DRAFT.items || []).filter((it) => String(it.qty || '').trim() && !it.item_id);
    if (bad.length) return toast('В составе есть строки без выбранной позиции из справочника', true);
    try {
      const saved = await post('/recipe', {
        id: DRAFT.id,
        product_id: DRAFT.product_id,
        group_id: DRAFT.group_id,
        product_name: productName,
        pack_weight_g: DRAFT.pack_weight_g,
        pack_unit: DRAFT.pack_unit,
        sale_price_type_id: DRAFT.sale_price_type_id,
        sale_price_override: DRAFT.sale_price_override,
        retro_pct: DRAFT.retro_pct,
        vat_pct: DRAFT.vat_pct,
        profit_tax_pct: DRAFT.profit_tax_pct,
        waste_pct: DRAFT.waste_pct,
        labor_coeff: DRAFT.labor_coeff,
        production_coeff: DRAFT.production_coeff,
        overhead_coeff: DRAFT.overhead_coeff,
        comment: DRAFT.comment,
      });
      const id = saved.id;
      await post('/recipe/' + id + '/items', { items: DRAFT.items });
      toast('Лист калькуляции сохранён');
      await reloadBase();
      await loadRecipe(id);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function archiveRecipe() {
    if (!CURRENT_ID || !confirm('Убрать рецептуру в архив?')) return;
    try {
      await post('/recipe/' + CURRENT_ID + '/archive');
      CURRENT_ID = null;
      CURRENT = null;
      DRAFT = null;
      await reloadBase();
      toast('Рецептура в архиве');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderPrices() {
    const c = $('#calc-content');
    // «Отличие от закупки»: цена в кальк. разошлась с последней закупкой.
    const changed = MATERIALS.filter((m) => m.last_purchase_price != null && Math.abs(num(m.last_purchase_price) - num(m.calc_price)) > 0.01).length;
    c.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Цены сырья и упаковки'),
        el('div', { class: 'calc-sub' }, 'Цена подтягивается из Закупки (последняя закупка). «Цену в кальк.» можно зафиксировать вручную. Наименования и категории — из «Справочников».'),
      ]),
    ]));
    c.appendChild(el('div', { class: 'calc-kpis calc-kpis-compact' }, [
      kpi('Позиций', MATERIALS.length, ''),
      kpi('Отличие от закупки', changed, changed ? 'warn' : ''),
      kpi('Сырьё', MATERIALS.filter((m) => m.kind === 'raw').length, ''),
      kpi('Упаковка', MATERIALS.filter((m) => m.kind === 'packaging').length, ''),
    ]));

    // Каскад: родительская категория → категория (опции категорий зависят от родителя).
    const parents = [...new Set(MATERIALS.map((m) => m.parent_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    const catsFor = (parent) => [...new Set(MATERIALS.filter((m) => !parent || m.parent_name === parent).map((m) => m.category_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    if (priceFilters.category && !catsFor(priceFilters.parent).includes(priceFilters.category)) priceFilters.category = '';
    const parentSel = select([{ v: '', t: 'Все группы' }, ...parents.map((p) => ({ v: p, t: p }))], priceFilters.parent, {
      onchange: (e) => { priceFilters.parent = e.target.value; priceFilters.category = ''; render(); },
    });
    const catSel = select([{ v: '', t: 'Все категории' }, ...catsFor(priceFilters.parent).map((cn) => ({ v: cn, t: cn }))], priceFilters.category, {
      onchange: (e) => { priceFilters.category = e.target.value; render(); },
    });
    const q = inp(priceFilters.q, {
      placeholder: 'Поиск по названию или артикулу',
      oninput: (e) => { priceFilters.q = e.target.value; clearTimeout(window.__calcMq); window.__calcMq = setTimeout(render, 180); },
    });
    // Кнопка настройки столбцов (как в SD) + панель с галочками.
    const colsBtn = el('button', { class: 'btn-ghost calc-cols-btn', title: 'Настроить столбцы', onclick: () => { priceColsOpen = !priceColsOpen; render(); } }, '⚙');
    const colsWrap = el('div', { class: 'calc-cols-wrap' }, [colsBtn]);
    if (priceColsOpen) {
      colsWrap.appendChild(el('div', { class: 'calc-cols-panel' }, PRICE_COLS.filter((cc) => !cc.always).map((cc) =>
        el('label', { class: 'calc-cols-item' }, [
          el('input', { type: 'checkbox', checked: !priceColsHidden.has(cc.key) || null, onchange: (e) => {
            if (e.target.checked) priceColsHidden.delete(cc.key); else priceColsHidden.add(cc.key);
            localStorage.setItem('calc_price_cols_hidden', JSON.stringify([...priceColsHidden]));
            render();
          } }),
          el('span', {}, cc.label),
        ])
      )));
    }
    c.appendChild(el('div', { class: 'calc-filters calc-filters-sticky' }, [
      parentSel, catSel, q, colsWrap,
      el('div', { class: 'calc-price-actions' }, [
        el('button', { class: 'btn-ghost', title: 'Подставить последнюю закупочную цену во все строки (потом сохранить)', onclick: pullAllFromPurchase }, '↺ Взять всё из закупки'),
        el('button', { class: 'btn-primary', onclick: savePricesAll }, '💾 Сохранить'),
      ]),
    ]));

    const needle = priceFilters.q.trim().toLowerCase();
    const rows = MATERIALS.filter((m) => (!priceFilters.parent || m.parent_name === priceFilters.parent)
      && (!priceFilters.category || m.category_name === priceFilters.category)
      && (!needle || (m.name || '').toLowerCase().includes(needle) || (m.code || '').toLowerCase().includes(needle)));
    const cols = visiblePriceCols();
    const gridStyle = 'grid-template-columns:44px ' + cols.map((cc) => cc.width).join(' ');
    const table = el('div', { class: 'calc-price-table calc-excel-table' }, [
      el('div', { class: 'calc-price-row head', style: gridStyle }, [el('span', {}, '#'), ...cols.map((cc) => el('span', {}, cc.label))]),
      ...rows.map((m, i) => priceRow(m, cols, gridStyle, i + 1)),
    ]);
    c.appendChild(rows.length ? table : el('div', { class: 'calc-empty' }, 'Ничего не найдено.'));
  }

  function priceCell(m, key) {
    if (key === 'type') return el('span', {}, m.kind === 'packaging' ? 'Упаковка' : 'Сырьё');
    if (key === 'category') return el('span', { class: 'muted' }, m.category_name || '—');
    if (key === 'name') return el('span', {}, [el('b', {}, m.name || ''), m.code ? el('small', {}, m.code) : null]);
    if (key === 'char') return el('span', { class: 'muted' }, m.characteristics || '—');
    if (key === 'calc') return inp(m.calc_price, { type: 'number', step: '0.01', name: 'calc_price', 'data-orig': m.calc_price == null ? '' : String(m.calc_price) });
    if (key === 'comment') return inp(m.price_comment || '', { name: 'comment', placeholder: 'заметка по цене', 'data-orig': m.price_comment || '' });
    if (key === 'last') {
      const dyn = num(m.last_purchase_price) - num(m.prev_purchase_price);
      const hasDyn = m.last_purchase_price != null && m.prev_purchase_price != null && Math.abs(dyn) > 0.01;
      const dynHint = hasDyn
        ? el('small', { class: dyn > 0 ? 'bad' : 'good', title: 'Динамика к прошлой закупке. Полная история — в разделе Закупки.' },
            (dyn > 0 ? '↑ +' : '↓ −') + money(Math.abs(dyn)))
        : null;
      return el('span', { class: 'tnum muted' }, [
        el('b', {}, money(m.last_purchase_price)),
        el('small', {}, (m.last_source ? m.last_source + ' · ' : '') + (ruDate(m.last_purchase_at) || '—')),
        dynHint,
      ]);
    }
    return el('span', {});
  }

  function priceRow(m, cols, gridStyle, idx) {
    return el('div', {
      class: 'calc-price-row', style: gridStyle,
      'data-kind': m.kind, 'data-id': m.id,
      'data-last': m.last_purchase_price == null ? '' : String(m.last_purchase_price),
      'data-comment': m.price_comment || '',
    }, [el('span', { class: 'calc-row-num' }, String(idx)), ...cols.map((cc) => priceCell(m, cc.key))]);
  }

  // Подставить последнюю закупочную цену во все видимые строки (без сохранения — потом «Сохранить»).
  function pullAllFromPurchase() {
    let n = 0;
    document.querySelectorAll('.calc-price-row[data-id]').forEach((r) => {
      const last = r.getAttribute('data-last');
      const calcEl = r.querySelector('[name="calc_price"]');
      if (last !== '' && calcEl && calcEl.value !== last) { calcEl.value = last; n++; }
    });
    toast(n ? 'Подставлено из закупки: ' + n + '. Проверьте и нажмите «Сохранить».' : 'Нечего подставлять');
  }

  // Одно сохранение на всю страницу: собирает изменённые строки и пишет их.
  async function savePricesAll() {
    const changed = [];
    document.querySelectorAll('.calc-price-row[data-id]').forEach((r) => {
      const calcEl = r.querySelector('[name="calc_price"]');
      const comEl = r.querySelector('[name="comment"]');
      const calcDirty = calcEl && calcEl.value !== calcEl.getAttribute('data-orig');
      const comDirty = comEl && comEl.value !== comEl.getAttribute('data-orig');
      if (!calcDirty && !comDirty) return;
      const last = r.getAttribute('data-last');
      const calcVal = calcEl ? calcEl.value : '';
      changed.push({
        item_kind: r.getAttribute('data-kind'),
        item_id: r.getAttribute('data-id'),
        calc_price: calcVal,
        // market_price = последняя закупка (источник — Закупка); если закупки нет — сама цена.
        market_price: last !== '' ? last : calcVal,
        // если колонка «Комментарий» скрыта — сохраняем прежнее значение, не затираем.
        comment: comEl ? comEl.value : r.getAttribute('data-comment'),
      });
    });
    if (!changed.length) { toast('Нет изменений'); return; }
    try {
      for (const body of changed) await post('/material-price', body);
      toast('Сохранено позиций: ' + changed.length);
      await reloadBase();
      render();
    } catch (e) { toast(e.message, true); }
  }

  // ================= МАТРИЦА КАНАЛА =================
  let matrixGroup = null; // '' = все группы, иначе id группы
  let matrixCfgOpen = false;
  const matrixHidden = new Set(JSON.parse(localStorage.getItem('calc_matrix_hidden') || '[]'));
  const saveMatrixHidden = () => localStorage.setItem('calc_matrix_hidden', JSON.stringify([...matrixHidden]));
  const f0 = (v) => fmt(v, 0);
  const pctStr = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : fmt(v, 0) + '%');
  function priceBlockJS(costCalc, price, retroPct, vatPct, taxPct) {
    const retro = price * retroPct / 100, vat = price * vatPct / 100;
    const profit = price - costCalc - retro - vat;
    const tax = Math.max(profit, 0) * taxPct / 100, net = profit - tax;
    return { retro, vat, profit, profit_tax: tax, net_profit: net, markup_pct: costCalc ? (price - costCalc) / costCalc * 100 : null, margin_pct: price ? net / price * 100 : null };
  }
  const INFO_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="8.25" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="6.4" r="1.15" fill="currentColor"/><rect x="9.05" y="8.7" width="1.9" height="5.6" rx="0.95" fill="currentColor"/></svg>';
  // Клик по ⓘ — поповер с расчётом строки (не подсказка на hover, а «ссылка на расчёт»).
  function showFormula(ev, label, text) {
    ev.stopPropagation();
    document.querySelectorAll('.calc-formula-pop').forEach((n) => n.remove());
    const pop = el('div', { class: 'calc-formula-pop' }, [
      el('div', { class: 'calc-formula-pop-h' }, label),
      el('div', { class: 'calc-formula-pop-b' }, text),
    ]);
    document.body.appendChild(pop);
    const r = ev.currentTarget.getBoundingClientRect();
    pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - pop.offsetWidth - 12)) + 'px';
    const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  // Секции и строки матрицы. edit → редактируемая; comp → считается; text → только показ.
  const MX_SECTIONS = [{ key: 'cost', label: 'Себестоимость' }, { key: 'price', label: 'Цена и прибыль' }];
  const MX_ROWS = [
    { s: 'cost', key: 'grammage', label: 'Граммаж, г', edit: 'grammage', title: 'Вес продукта в упаковке, граммов' },
    { s: 'cost', key: 'raw_name', label: 'Сырьё', text: (m) => m.rawName, title: 'Основное сырьё (зелень) рецептуры' },
    { s: 'cost', key: 'raw_price', label: 'Стоимость зелени, сум/кг', edit: 'rawPrice', title: 'Цена сырья за кг (зафиксирована; берётся из последней закупки)' },
    { s: 'cost', key: 'raw_cost', label: 'Зелень в упаковке', comp: 'raw_cost', title: 'Граммаж/1000 × цена за кг × (1 + отход)' },
    { s: 'cost', key: 'pack_cost', label: 'Упаковка', text: (m) => f0(m.pack_cost), title: 'Стоимость упаковки на единицу (из закупки)' },
    { s: 'cost', key: 'labor', label: 'ФОТ', text: (m) => f0(m.labor), title: 'ФОТ на единицу: фонд оплаты труда (с налогами) из «Персонала» ÷ объём выпуска' },
    { s: 'cost', key: 'production', label: 'Производство', text: (m) => f0(m.production), title: 'Производственные расходы на единицу: аренда, электроэнергия и пр. ÷ объём выпуска' },
    { s: 'cost', key: 'overhead', label: 'Накладные', text: (m) => f0(m.overhead), title: 'Накладные на единицу: логистика, сертификация, банк, маркетинг, кредиты ÷ объём выпуска' },
    { s: 'cost', key: 'cost_raw', label: 'с/с (без брака)', comp: 'cost_raw', title: 'Сырьё + упаковка + ФОТ + производство + накладные' },
    { s: 'cost', key: 'waste', label: '% брака', edit: 'wastePct', title: 'Процент брака/отхода — надбавка на потери' },
    { s: 'cost', key: 'cost_calc', label: 'с/с с браком', comp: 'cost_calc', total: true, title: 'с/с (без брака) × (1 + % брака)' },
    { s: 'price', key: 'a_markup', label: 'Наценка %', comp: 'A.markup_pct', pct: true, title: '(Отгрузочная цена − с/с с браком) ÷ с/с с браком' },
    { s: 'price', key: 'a_ship', label: 'Отгрузочная цена', edit: 'priceA', hl: true, title: 'Цена отгрузки — по ней считается прибыль (если пусто, берётся цена из SD)' },
    { s: 'price', key: 'a_sd', label: 'Цена в SD', text: (m) => (num(m.sdPrice) ? f0(m.sdPrice) : '—'), title: 'Текущая отпускная цена из справочника (SD) — справочно' },
    { s: 'price', key: 'a_retro_pct', label: 'Ретро, %', edit: 'retroA', title: 'Ретро-бонус сети, % от отгрузочной цены' },
    { s: 'price', key: 'a_retro', label: 'Ретро', comp: 'A.retro', title: 'Отгрузочная цена × Ретро %' },
    { s: 'price', key: 'a_vat', label: 'НДС', comp: 'A.vat', title: 'НДС 12% от отгрузочной цены' },
    { s: 'price', key: 'a_profit', label: 'Прибыль', comp: 'A.profit', title: 'Отгрузочная цена − с/с с браком − ретро − НДС' },
    { s: 'price', key: 'a_tax', label: 'Налог на прибыль', comp: 'A.profit_tax', title: 'Налог на прибыль 15% от прибыли' },
    { s: 'price', key: 'a_net', label: 'Чистая прибыль', comp: 'A.net_profit', total: true, title: 'Прибыль − налог на прибыль' },
    { s: 'price', key: 'a_margin', label: 'ЧП %', comp: 'A.margin_pct', pct: true, title: 'Чистая прибыль ÷ отгрузочная цена' },
  ];
  const mxSecHidden = (s) => matrixHidden.has('sec:' + s);
  const mxRowVisible = (row) => !mxSecHidden(row.s) && !matrixHidden.has(row.key);

  function renderMatrix() {
    const c = $('#calc-content');
    const groups = DICTS.groups || [];
    if (matrixGroup === null) matrixGroup = groups.length ? String(groups[0].id) : '';
    // Кнопка-иконка настройки видимых строк (как ⚙ в «Ценах сырья»).
    const cfgBtn = el('button', { class: 'btn-ghost calc-cols-btn', title: 'Показать/скрыть строки', onclick: () => { matrixCfgOpen = !matrixCfgOpen; render(); } }, '⚙');
    const cfgWrap = el('div', { class: 'calc-cols-wrap' }, [cfgBtn]);
    if (matrixCfgOpen) {
      const panel = el('div', { class: 'calc-cols-panel calc-mx-cfg' }, []);
      MX_SECTIONS.forEach((sec) => {
        panel.appendChild(el('label', { class: 'calc-cols-item calc-cols-head' }, [
          el('input', { type: 'checkbox', checked: !mxSecHidden(sec.key) || null, onchange: (e) => {
            if (e.target.checked) matrixHidden.delete('sec:' + sec.key); else matrixHidden.add('sec:' + sec.key);
            saveMatrixHidden(); render();
          } }),
          el('b', {}, sec.label),
        ]));
        MX_ROWS.filter((r) => r.s === sec.key).forEach((r) => panel.appendChild(el('label', { class: 'calc-cols-item calc-cols-sub' }, [
          el('input', { type: 'checkbox', checked: !matrixHidden.has(r.key) || null, onchange: (e) => {
            if (e.target.checked) matrixHidden.delete(r.key); else matrixHidden.add(r.key);
            saveMatrixHidden(); render();
          } }),
          el('span', {}, r.label),
        ])));
      });
      cfgWrap.appendChild(panel);
    }
    c.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Матрица канала'),
        el('div', { class: 'calc-sub' }, 'Каждая группа товаров — своя вкладка. Правьте ячейки прямо в матрице — изменения сразу уходят в рецептуру. «Отгрузочная цена» (зелёная) — по ней считается прибыль; «Цена в SD» — справочно.'),
      ]),
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, [
        cfgWrap,
        el('button', { class: 'btn-primary', onclick: saveMatrixAll }, '💾 Сохранить всё'),
      ]),
    ]));
    // Вкладки-каналы: одна вкладка на группу товаров.
    c.appendChild(el('div', { class: 'calc-mx-tabs' }, groups.length
      ? groups.map((g) => el('button', { class: 'calc-mx-tab' + (String(g.id) === String(matrixGroup) ? ' on' : ''), onclick: () => { matrixGroup = String(g.id); render(); } }, g.name))
      : [el('span', { class: 'calc-sub' }, 'Групп товаров нет — создайте их в «Настройках».')]));
    const box = el('div', { id: 'calc-matrix-box' }); c.appendChild(box);
    box.appendChild(el('div', { class: 'calc-empty' }, 'Считаю…'));
    loadMatrix(box);
  }
  async function loadMatrix(box) {
    let d; try { d = await api('/matrix?group=' + encodeURIComponent(matrixGroup || '')); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'calc-empty' }, 'Ошибка: ' + e.message)); return; }
    box.innerHTML = '';
    if (!d.columns.length) { box.appendChild(el('div', { class: 'calc-empty' }, 'В этой группе пока нет рецептур. Создайте их во вкладке «Рецептуры».')); return; }
    box.appendChild(buildMatrix(d.columns));
  }
  let matrixModels = [];
  function buildMatrix(cols) {
    const models = cols.map((col) => ({
      id: col.id, name: col.name, single_raw: col.single_raw,
      rawName: col.primary_raw ? col.primary_raw.name : '—',
      rawPrice: col.primary_raw ? col.primary_raw.price : 0,
      rawCostFixed: col.raw_cost, pack_cost: col.pack_cost,
      fixed: col.labor + col.production + col.overhead,
      labor: col.labor, production: col.production, overhead: col.overhead,
      wastePct: col.waste_pct, vat: col.vat_pct, tax: col.profit_tax_pct,
      grammage: col.grammage,
      priceA: col.A.price_set ? col.A.sale_price : '', // отгрузочная (ручная), пусто = берём SD
      sdPrice: col.sd_price, // справочно из справочника отпускных цен
      retroA: col.A.retro_pct,
    }));
    matrixModels = models;
    const live = (m) => {
      const rawCost = m.single_raw ? (num(m.grammage) / 1000) * num(m.rawPrice) : m.rawCostFixed;
      const costRaw = rawCost + num(m.pack_cost) + m.fixed;
      const costCalc = costRaw * (1 + num(m.wastePct) / 100);
      const pA = (m.priceA === '' || m.priceA == null) ? num(m.sdPrice) : num(m.priceA);
      return { raw_cost: rawCost, cost_raw: costRaw, cost_calc: costCalc,
        A: priceBlockJS(costCalc, pA, num(m.retroA), m.vat, m.tax) };
    };
    const getVal = (lv, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), lv);
    const rows = MX_ROWS.filter(mxRowVisible);
    const colCells = models.map(() => ({}));
    function refreshCol(ci) {
      const lv = live(models[ci]);
      rows.forEach((row) => {
        if (!row.comp) return;
        const td = colCells[ci][row.key]; if (!td) return;
        const v = getVal(lv, row.comp);
        td.textContent = row.pct ? pctStr(v) : f0(v);
        td.classList.toggle('bad', !row.pct && typeof v === 'number' && v < 0);
      });
    }
    const dispatchSave = (ci, editKey) => {
      const m = models[ci], v = m[editKey];
      if (editKey === 'grammage') return post('/recipe/' + m.id + '/grammage', { qty: v }).then(ok, (e) => err(ci, e));
      if (editKey === 'rawPrice') return post('/recipe/' + m.id + '/item-price', { item_kind: 'raw', manual_price: v }).then(ok, (e) => err(ci, e));
      const map = { wastePct: 'waste_pct', retroA: 'retro_pct', priceA: 'sale_price_override' };
      return post('/recipe/' + m.id + '/pricing', { [map[editKey]]: v }).then(ok, (e) => err(ci, e));
    };
    const ok = () => toast('Сохранено');
    const err = (ci, e) => { toast(e.message, true); loadMatrix($('#calc-matrix-box')); };

    const thead = el('tr', {}, [el('th', { class: 'calc-mx-corner' }, 'Показатель'),
      ...models.map((m) => el('th', {}, el('button', { class: 'calc-mx-sku', title: 'Открыть карточку', onclick: () => { TAB = 'recipes'; render(); loadRecipe(m.id); } }, m.name)))]);
    const body = [];
    MX_SECTIONS.forEach((sec) => {
      if (mxSecHidden(sec.key)) return;
      body.push(el('tr', { class: 'calc-mx-sec' }, [el('td', { colspan: models.length + 1 }, sec.label)]));
      MX_ROWS.filter((r) => r.s === sec.key && mxRowVisible(r)).forEach((row) => {
        const cells = models.map((m, ci) => {
          if (row.edit) {
            const i = el('input', { class: 'calcf-inp calc-mx-inp', type: 'number', step: '0.01', value: m[row.edit] === '' ? '' : m[row.edit],
              placeholder: row.edit === 'priceB' ? 'как A' : (row.edit === 'priceA' ? 'из SD' : ''),
              oninput: (e) => { m[row.edit] = e.target.value; refreshCol(ci); },
              onchange: () => dispatchSave(ci, row.edit) });
            return el('td', {}, i);
          }
          if (row.text) return el('td', { title: row.title || '' }, row.text(m));
          const td = el('td', { class: 'tnum' }, ''); colCells[ci][row.key] = td; return td;
        });
        const labelCell = el('th', { class: 'calc-mx-rowlabel' }, [el('span', {}, row.label),
          row.title ? el('button', { class: 'calc-mx-info', title: 'Как считается', html: INFO_SVG, onclick: (e) => showFormula(e, row.label, row.title) }) : null]);
        body.push(el('tr', { class: (row.total ? 'calc-mx-total' : '') + (row.hl ? ' calc-mx-ship' : '') }, [labelCell, ...cells]));
      });
    });
    models.forEach((_, ci) => refreshCol(ci));
    return el('div', { class: 'calc-mx-wrap' }, el('table', { class: 'calc-mx' }, [el('thead', {}, thead), el('tbody', {}, body)]));
  }
  // «Сохранить всё»: пишет все редактируемые поля всех колонок (страховка к авто-сохранению).
  async function saveMatrixAll() {
    if (!matrixModels.length) { toast('Нет данных'); return; }
    try {
      for (const m of matrixModels) {
        await post('/recipe/' + m.id + '/pricing', { waste_pct: m.wastePct, retro_pct: m.retroA, sale_price_override: m.priceA });
        if (m.rawPrice !== '' && m.rawPrice != null) await post('/recipe/' + m.id + '/item-price', { item_kind: 'raw', manual_price: m.rawPrice });
        if (m.grammage !== '' && m.grammage != null) await post('/recipe/' + m.id + '/grammage', { qty: m.grammage }).catch(() => {});
      }
      toast('Все изменения сохранены');
      loadMatrix($('#calc-matrix-box'));
    } catch (e) { toast(e.message, true); }
  }

  // ================= ЗАТРАТЫ =================
  let costRemoved = [];
  function renderCosts() {
    const c = $('#calc-content');
    c.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Затраты'),
        el('div', { class: 'calc-sub' }, 'Производственные и накладные затраты в месяц ÷ объём = на штуку. ФОТ — из плитки «Персонал». «Применить» обновит постоянные затраты во всех рецептурах без своей группы.'),
      ]),
    ]));
    const box = el('div', { id: 'calc-costs-box' }); c.appendChild(box);
    box.appendChild(el('div', { class: 'calc-empty' }, 'Загружаю…'));
    loadCosts(box);
  }
  async function loadCosts(box) {
    let d; try { d = await api('/costs'); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'calc-empty' }, 'Ошибка: ' + e.message)); return; }
    costRemoved = [];
    buildCosts(box, d);
  }
  function buildCosts(box, d) {
    box.innerHTML = '';
    const rows = { production: [], overhead: [] };
    const vol = inp(d.monthly_units, { type: 'number', step: '1', name: 'monthly_units' });
    const coeff = inp(d.fot_tax_coeff, { type: 'number', step: '0.01', name: 'fot_tax_coeff' });
    const fotTotalTxt = el('b', {}), laborUnit = el('b', {}), prodUnit = el('b', {}), ohUnit = el('b', {}), prodSum = el('b', {}), ohSum = el('b', {});

    function recompute() {
      const v = num(vol.value) || 0, cf = num(coeff.value) || 0;
      const sum = (kind) => rows[kind].reduce((a, r) => a + num(r.amountInp.value), 0);
      const ps = sum('production'), os = sum('overhead'), fotTotal = num(d.fot_base) * cf;
      const per = (x) => (v > 0 ? x / v : 0);
      prodSum.textContent = money(ps); ohSum.textContent = money(os); fotTotalTxt.textContent = money(fotTotal);
      laborUnit.textContent = money(per(fotTotal)); prodUnit.textContent = money(per(ps)); ohUnit.textContent = money(per(os));
    }
    function costRow(kind, item) {
      const nameInp = inp(item ? item.name : '', { placeholder: 'наименование затраты' });
      const amountInp = inp(item && item.amount != null ? item.amount : '', { type: 'number', step: '1', placeholder: 'сумма в месяц', oninput: recompute });
      const rec = { id: item ? item.id : null, nameInp, amountInp };
      const wrap = el('div', { class: 'calc-cost-row' }, [nameInp, amountInp,
        el('button', { class: 'calc-icon-btn', title: 'Удалить', onclick: () => { if (rec.id) costRemoved.push(rec.id); const a = rows[kind]; const i = a.indexOf(rec); if (i >= 0) a.splice(i, 1); wrap.remove(); recompute(); } }, '×')]);
      rows[kind].push(rec);
      return wrap;
    }
    const prodList = el('div', { class: 'calc-cost-list' }, d.production.map((i) => costRow('production', i)));
    const ohList = el('div', { class: 'calc-cost-list' }, d.overhead.map((i) => costRow('overhead', i)));
    const addBtn = (kind, list) => el('button', { class: 'btn-ghost calc-line-add', onclick: () => { list.appendChild(costRow(kind, null)); recompute(); } }, '+ строка');
    vol.addEventListener('input', recompute); coeff.addEventListener('input', recompute);

    box.appendChild(el('div', { class: 'calc-settings-grid' }, [
      el('section', { class: 'calc-settings-card' }, [
        el('div', { class: 'calc-settings-title' }, 'Объём и ФОТ'),
        el('div', { class: 'calc-sub' }, 'ФОТ = сумма окладов активных сотрудников из «Персонала» × коэффициент налогов.'),
        el('label', { class: 'calc-setting-tile' }, [el('span', {}, 'Объём выпуска, шт/мес'), vol]),
        el('label', { class: 'calc-setting-tile' }, [el('span', {}, 'Коэффициент налогов на ФОТ'), coeff]),
        el('label', { class: 'calc-setting-tile' }, [el('span', {}, 'Оклады (' + d.fot_employees + ' чел.)'), el('span', { class: 'tnum' }, money(d.fot_base))]),
        el('label', { class: 'calc-setting-tile' }, [el('span', {}, 'ФОТ с налогами / мес'), el('span', { class: 'tnum' }, fotTotalTxt)]),
        el('label', { class: 'calc-setting-tile' }, [el('span', {}, 'ФОТ на штуку'), el('span', { class: 'tnum good' }, laborUnit)]),
      ]),
      el('section', { class: 'calc-settings-card' }, [
        el('div', { class: 'calc-settings-title' }, 'Производственные затраты'),
        el('div', { class: 'calc-sub' }, 'Аренда, электроэнергия и пр. — в месяц.'),
        prodList, addBtn('production', prodList),
        el('div', { class: 'calc-cost-foot' }, [el('span', {}, 'Сумма / мес: '), prodSum, el('span', {}, ' · на штуку: '), prodUnit]),
      ]),
      el('section', { class: 'calc-settings-card' }, [
        el('div', { class: 'calc-settings-title' }, 'Накладные затраты'),
        el('div', { class: 'calc-sub' }, 'Логистика, сертификация, банк, маркетинг, кредиты и пр. — в месяц.'),
        ohList, addBtn('overhead', ohList),
        el('div', { class: 'calc-cost-foot' }, [el('span', {}, 'Сумма / мес: '), ohSum, el('span', {}, ' · на штуку: '), ohUnit]),
      ]),
    ]));
    box.appendChild(el('div', { style: 'margin-top:12px;display:flex;gap:8px;justify-content:flex-end' }, [
      el('button', { class: 'btn-primary', onclick: saveCosts }, '💾 Сохранить и применить'),
    ]));
    recompute();

    async function saveCosts() {
      try {
        for (const id of costRemoved) await post('/cost-item/' + id + '/archive');
        for (const kind of ['production', 'overhead']) {
          for (const r of rows[kind]) {
            const name = r.nameInp.value.trim();
            if (!name) continue;
            await post('/cost-item', { id: r.id, kind, name, amount: r.amountInp.value });
          }
        }
        await post('/costs/apply', { monthly_units: vol.value, fot_tax_coeff: coeff.value });
        toast('Сохранено и применено к калькуляции');
        await reloadBase();
        const nd = await api('/costs'); costRemoved = []; buildCosts(box, nd);
      } catch (e) { toast(e.message, true); }
    }
  }

  function renderSettings() {
    const c = $('#calc-content');
    const s = DICTS.settings || {};
    const groups = [
      {
        title: 'Проценты по умолчанию',
        hint: 'Подставляются в новые рецептуры, но в каждой рецептуре можно поменять.',
        fields: [
          ['retro_pct', 'Ретро-бонус, %'],
          ['vat_pct', 'НДС, %'],
          ['profit_tax_pct', 'Налог на прибыль, %'],
          ['waste_pct', 'Потери рецептуры, %'],
        ],
      },
    ];
    c.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Настройки'),
        el('div', { class: 'calc-sub' }, 'Проценты по умолчанию и группы товаров. Постоянные затраты (ФОТ/производство/накладные) — во вкладке «Затраты».'),
      ]),
      el('button', { class: 'btn-primary calc-save-settings', onclick: saveSettings }, 'Сохранить настройки'),
    ]));
    const form = el('div', { class: 'calc-settings-grid' }, groups.map((g) => el('section', { class: 'calc-settings-card' }, [
      el('div', { class: 'calc-settings-title' }, g.title),
      el('div', { class: 'calc-sub' }, g.hint),
      ...g.fields.map(([key, label]) => el('label', { class: 'calc-setting-tile' }, [
        el('span', {}, label),
        inp(s[key], { type: 'number', step: '0.01', name: key }),
      ])),
    ])));
    c.appendChild(form);
    c.appendChild(sdPriceCard(s));
    c.appendChild(groupsCard());
  }
  // Настройки → тип цены для «Цена в SD» (товар матчится по названию рецептуры).
  function sdPriceCard(s) {
    const sel = select([{ v: '', t: '— не выбрано —' }, ...(DICTS.priceTypes || []).map((p) => ({ v: p.id, t: p.name }))], s.sd_price_type_id || '', {
      onchange: async (e) => { try { await post('/settings', { sd_price_type_id: e.target.value }); toast('Сохранено'); await reloadBase(); } catch (err) { toast(err.message, true); } },
    });
    return el('section', { class: 'calc-settings-card', style: 'max-width:520px;margin-top:12px' }, [
      el('div', { class: 'calc-settings-title' }, 'Цена из SD'),
      el('div', { class: 'calc-sub' }, 'Прайс-лист, из которого в матрице берётся строка «Цена в SD». Товар подбирается по названию рецептуры автоматически. Обновить сами цены — синхронизацией в «Справочники → Отпускные цены».'),
      el('label', { class: 'calc-setting-tile' }, [el('span', {}, 'Тип цены (прайс-лист)'), sel]),
    ]);
  }

  // Настройки → группы товаров (розница/хорека/…): название + свои постоянные затраты.
  function groupsCard() {
    const list = (DICTS.groups || []).map((g) => {
      const f = {};
      const gi = (key, ph) => { const i = inp(g[key] == null ? '' : g[key], { type: 'number', step: '0.01', placeholder: ph }); f[key] = i; return i; };
      return el('div', { class: 'calc-group-edit' }, [
        el('div', { class: 'calc-group-edit-top' }, [
          inp(g.name, { name: 'g_name', class: 'calcf-inp calc-group-name' }),
          el('button', { class: 'btn-primary calc-mini-save', onclick: (e) => saveGroup(g.id, e.target.closest('.calc-group-edit')) }, 'Сохранить'),
          el('button', { class: 'btn-ghost calc-danger', onclick: () => archiveGroup(g.id, g.name) }, 'Архив'),
        ]),
        el('div', { class: 'calc-group-fx' }, [
          el('label', {}, [el('span', {}, 'ФОТ/ед.'), gi('labor_per_unit', '0')]),
          el('label', {}, [el('span', {}, 'Произв./ед.'), gi('production_per_unit', '0')]),
          el('label', {}, [el('span', {}, 'Накладные/ед.'), gi('overhead_per_unit', '0')]),
          el('label', {}, [el('span', {}, 'План шт/мес'), gi('monthly_units', '0')]),
        ]),
      ]);
    });
    const newName = inp('', { placeholder: 'например, Хорека 250г', class: 'calcf-inp calc-group-name' });
    return el('section', { class: 'calc-settings-card', style: 'max-width:720px;margin-top:12px', id: 'calc-groups-card' }, [
      el('div', { class: 'calc-settings-title' }, 'Группы товаров'),
      el('div', { class: 'calc-sub' }, 'Розница, Хорека и любые свои. У каждой группы свои постоянные затраты — рецептура берёт их из своей группы. Пусто = общие настройки выше.'),
      ...list,
      el('div', { class: 'calc-group-edit-top', style: 'margin-top:8px' }, [
        newName,
        el('button', { class: 'btn-primary calc-mini-save', onclick: () => saveGroup(null, null, newName.value) }, '+ Добавить'),
      ]),
      el('div', { class: 'calc-sub', style: 'margin-top:14px' }, 'Разовая загрузка: 8 листовых рецептур (Латук…Айсберг) в «Розницу» с ценами из вашей таблицы.'),
      el('button', { class: 'btn-ghost calc-line-add', style: 'margin-top:6px', onclick: seedLeafy }, '⬇ Загрузить листовые рецептуры'),
    ]);
  }
  async function seedLeafy() {
    if (!confirm('Создать 8 листовых рецептур в группе «Розница»? Повторно уже созданные пропустит.')) return;
    try {
      const r = await post('/seed-leafy');
      let msg = 'Создано: ' + r.created.length + (r.skipped.length ? ', пропущено (уже есть): ' + r.skipped.length : '');
      if (!r.packFound) msg += '. Упаковка «вак.пакет» не найдена в справочнике!';
      if (r.noGreen && r.noGreen.length) msg += '. Не нашли зелень для: ' + r.noGreen.join(', ');
      alert(msg);
      await reloadBase();
      TAB = 'recipes';
      render();
    } catch (e) { toast(e.message, true); }
  }
  async function saveGroup(id, rowEl, plainName) {
    const body = { id };
    if (rowEl) {
      body.name = rowEl.querySelector('[name="g_name"]').value;
      const nums = rowEl.querySelectorAll('.calc-group-fx input[type="number"]');
      body.labor_per_unit = nums[0] ? nums[0].value : '';
      body.production_per_unit = nums[1] ? nums[1].value : '';
      body.overhead_per_unit = nums[2] ? nums[2].value : '';
      body.monthly_units = nums[3] ? nums[3].value : '';
    } else {
      body.name = plainName;
    }
    if (!String(body.name || '').trim()) return toast('Пустое название', true);
    try { await post('/group', body); toast('Готово'); await reloadBase(); render(); } catch (e) { toast(e.message, true); }
  }
  async function archiveGroup(id, name) {
    if (!confirm('Убрать группу «' + name + '» в архив? Рецептуры останутся, но потеряют группу.')) return;
    try { await post('/group/' + id + '/archive'); toast('В архиве'); await reloadBase(); render(); } catch (e) { toast(e.message, true); }
  }

  async function saveSettings() {
    const form = $('.calc-settings-grid');
    const keys = ['retro_pct', 'vat_pct', 'profit_tax_pct', 'waste_pct'];
    const body = {};
    keys.forEach((key) => { const elx = form.querySelector('[name="' + key + '"]'); if (elx) body[key] = elx.value; });
    try {
      const res = await post('/settings', body);
      DICTS.settings = res.settings || body;
      toast('Настройки сохранены');
      await reloadBase();
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  boot();
})();
