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
  const priceFilters = { parent: '', category: '', kind: '', q: '' };

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
      tab('prices', 'Цены сырья'),
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
    if (TAB === 'prices') return renderPrices();
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
    const priceTypes = [{ v: '', t: '— тип цены —' }, ...(DICTS.priceTypes || []).map((p) => ({ v: p.id, t: p.name }))];
    const groups = [{ v: '', t: '— группа —' }, ...(DICTS.groups || []).map((g) => ({ v: g.id, t: g.name }))];
    return el('div', { class: 'calc-meta-grid' }, [
      cell('Товар', inp(DRAFT.product_label, { name: 'product_label', list: 'calc-products', placeholder: 'начните вводить товар' }), 'wide'),
      cell('Название вручную', inp(DRAFT.product_name, { name: 'product_name', placeholder: 'если товара нет в справочнике' }), 'wide'),
      cell('Группа', select(groups, DRAFT.group_id, { name: 'group_id' })),
      cell('Тип цены', select(priceTypes, DRAFT.sale_price_type_id, { name: 'sale_price_type_id' })),
      cell('Цена вручную', inp(DRAFT.sale_price_override, { name: 'sale_price_override', type: 'number', step: '0.01', placeholder: 'если не из SD' })),
      cell('Вес, г', inp(DRAFT.pack_weight_g, { name: 'pack_weight_g', type: 'number', step: '0.1' })),
      cell('Ед.', inp(DRAFT.pack_unit, { name: 'pack_unit' })),
      cell('Потери %', inp(DRAFT.waste_pct, { name: 'waste_pct', type: 'number', step: '0.1' })),
      cell('Ретро %', inp(DRAFT.retro_pct, { name: 'retro_pct', type: 'number', step: '0.1' })),
      cell('НДС %', inp(DRAFT.vat_pct, { name: 'vat_pct', type: 'number', step: '0.1' })),
      cell('Налог %', inp(DRAFT.profit_tax_pct, { name: 'profit_tax_pct', type: 'number', step: '0.1' })),
      cell('ФОТ x', inp(DRAFT.labor_coeff, { name: 'labor_coeff', type: 'number', step: '0.1' })),
      cell('Производство x', inp(DRAFT.production_coeff, { name: 'production_coeff', type: 'number', step: '0.1' })),
      cell('Накладные x', inp(DRAFT.overhead_coeff, { name: 'overhead_coeff', type: 'number', step: '0.1' })),
      cell('Комментарий', area(DRAFT.comment, { name: 'comment', placeholder: 'заметки по рецептуре' }), 'wide'),
    ]);
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
    const productInput = root.querySelector('[name="product_label"]');
    const product = findProductByLabel(productInput && productInput.value);
    return {
      ...DRAFT,
      product_id: product ? product.id : '',
      group_id: root.querySelector('[name="group_id"]') ? root.querySelector('[name="group_id"]').value : DRAFT.group_id,
      product_label: productInput ? productInput.value : '',
      product_name: root.querySelector('[name="product_name"]').value,
      pack_weight_g: root.querySelector('[name="pack_weight_g"]').value,
      pack_unit: root.querySelector('[name="pack_unit"]').value,
      sale_price_type_id: root.querySelector('[name="sale_price_type_id"]').value,
      sale_price_override: root.querySelector('[name="sale_price_override"]').value,
      retro_pct: root.querySelector('[name="retro_pct"]').value,
      vat_pct: root.querySelector('[name="vat_pct"]').value,
      profit_tax_pct: root.querySelector('[name="profit_tax_pct"]').value,
      waste_pct: root.querySelector('[name="waste_pct"]').value,
      labor_coeff: root.querySelector('[name="labor_coeff"]').value,
      production_coeff: root.querySelector('[name="production_coeff"]').value,
      overhead_coeff: root.querySelector('[name="overhead_coeff"]').value,
      comment: root.querySelector('[name="comment"]').value,
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
    const kindSel = select([
      { v: '', t: 'Все типы' }, { v: 'raw', t: 'Сырьё' }, { v: 'packaging', t: 'Упаковка' },
    ], priceFilters.kind, { onchange: (e) => { priceFilters.kind = e.target.value; render(); } });
    const q = inp(priceFilters.q, {
      placeholder: 'Поиск по названию или артикулу',
      oninput: (e) => { priceFilters.q = e.target.value; clearTimeout(window.__calcMq); window.__calcMq = setTimeout(render, 180); },
    });
    c.appendChild(el('div', { class: 'calc-filters calc-filters-sticky' }, [parentSel, catSel, kindSel, q]));

    const needle = priceFilters.q.trim().toLowerCase();
    const rows = MATERIALS.filter((m) => (!priceFilters.kind || m.kind === priceFilters.kind)
      && (!priceFilters.parent || m.parent_name === priceFilters.parent)
      && (!priceFilters.category || m.category_name === priceFilters.category)
      && (!needle || (m.name || '').toLowerCase().includes(needle) || (m.code || '').toLowerCase().includes(needle)));
    const table = el('div', { class: 'calc-price-table calc-excel-table' }, [
      el('div', { class: 'calc-price-row head' }, [
        el('span', {}, 'Тип'), el('span', {}, 'Категория'), el('span', {}, 'Наименование'), el('span', {}, 'Характеристика'),
        el('span', {}, 'Цена в кальк.'), el('span', {}, 'Последняя закупка'), el('span', {}, 'Комментарий'), el('span', {}, ''),
      ]),
      ...rows.map(priceRow),
    ]);
    c.appendChild(rows.length ? table : el('div', { class: 'calc-empty' }, 'Ничего не найдено.'));
  }

  function priceRow(m) {
    const calc = inp(m.calc_price, { type: 'number', step: '0.01', name: 'calc_price' });
    const comment = inp(m.price_comment || '', { name: 'comment', placeholder: 'заметка по цене' });
    // Δ-подсказка: как изменилась закупочная цена относительно предыдущей закупки.
    const dyn = num(m.last_purchase_price) - num(m.prev_purchase_price);
    const hasDyn = m.last_purchase_price != null && m.prev_purchase_price != null && Math.abs(dyn) > 0.01;
    const dynHint = hasDyn
      ? el('small', { class: dyn > 0 ? 'bad' : 'good', title: 'Динамика к прошлой закупке. Полная история — в разделе Закупки.' },
          (dyn > 0 ? '↑ +' : '↓ −') + money(Math.abs(dyn)))
      : null;
    const row = el('div', { class: 'calc-price-row' }, [
      el('span', {}, m.kind === 'packaging' ? 'Упаковка' : 'Сырьё'),
      el('span', { class: 'muted' }, m.category_name || '—'),
      el('span', {}, [el('b', {}, m.name || ''), m.code ? el('small', {}, m.code) : null]),
      el('span', { class: 'muted' }, m.characteristics || '—'),
      calc,
      el('span', { class: 'tnum muted' }, [
        el('b', {}, money(m.last_purchase_price)),
        el('small', {}, (m.last_source ? m.last_source + ' · ' : '') + (ruDate(m.last_purchase_at) || '—')),
        dynHint,
      ]),
      comment,
      el('div', { class: 'calc-row-actions' }, [
        m.last_purchase_price != null ? el('button', { class: 'calc-accept-btn', title: 'Поставить цену из последней закупки', onclick: () => { calc.value = m.last_purchase_price; savePrice(m, row); } }, 'Взять из закупки') : null,
        el('button', { class: 'btn-primary calc-mini-save', onclick: () => savePrice(m, row) }, 'Сохранить'),
      ]),
    ]);
    return row;
  }

  async function savePrice(m, row) {
    try {
      await post('/material-price', {
        item_kind: m.kind,
        item_id: m.id,
        calc_price: row.querySelector('[name="calc_price"]').value,
        // market_price оставляем = последней закупке (источник цены — Закупка).
        market_price: m.last_purchase_price != null ? m.last_purchase_price : row.querySelector('[name="calc_price"]').value,
        comment: row.querySelector('[name="comment"]').value,
      });
      toast('Цена сохранена');
      await reloadBase();
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderSettings() {
    const c = $('#calc-content');
    const s = DICTS.settings || {};
    const groups = [
      {
        title: 'План и расходы на единицу',
        hint: 'Эти суммы попадают в каждую рецептуру через коэффициенты.',
        fields: [
          ['monthly_units', 'План выпуска, шт/мес'],
          ['labor_per_unit', 'ФОТ на единицу, сум'],
          ['production_per_unit', 'Производство на единицу, сум'],
          ['overhead_per_unit', 'Накладные на единицу, сум'],
        ],
      },
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
        el('div', { class: 'calc-sub' }, 'Минимальный набор коэффициентов. ФОТ и производство позже подтянем из своих плиток.'),
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
    c.appendChild(groupsCard());
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
    const keys = ['monthly_units', 'labor_per_unit', 'production_per_unit', 'overhead_per_unit', 'retro_pct', 'vat_pct', 'profit_tax_pct', 'waste_pct'];
    const body = {};
    keys.forEach((key) => { body[key] = form.querySelector('[name="' + key + '"]').value; });
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
