// calculation.js — planned costing by recipes.
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
  const money = (v) => fmt(v, 2) + (v === null || v === undefined || v === '' ? '' : ' сум');
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

  function modal(title, body, acts) {
    const root = $('#calc-modal-root');
    const ov = el('div', { class: 'calcm-overlay', onclick: (e) => { if (e.target === ov) close(); } });
    const panel = el('div', { class: 'calcm-panel' }, [
      el('div', { class: 'calcm-head' }, [
        el('h3', {}, title),
        el('button', { class: 'calcm-x', onclick: () => close() }, '×'),
      ]),
      el('div', { class: 'calcm-body' }, body),
      acts && acts.length ? el('div', { class: 'calcm-acts' }, acts) : null,
    ]);
    ov.appendChild(panel);
    root.appendChild(ov);
    function close() { ov.remove(); }
    ov._close = close;
    return { close };
  }

  const closeModal = () => {
    const root = $('#calc-modal-root');
    if (root.lastChild && root.lastChild._close) root.lastChild._close();
  };

  const inp = (val, attrs) => el('input', Object.assign({ class: 'calcf-inp', value: val == null ? '' : String(val) }, attrs || {}));
  const area = (val, attrs) => el('textarea', Object.assign({ class: 'calcf-inp calc-textarea' }, attrs || {}), val == null ? '' : String(val));
  const frow = (label, ctrl) => el('label', { class: 'calcf-row' }, [el('span', {}, label), ctrl]);

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
  let recipeQ = '';
  let materialQ = '';
  let materialKind = '';

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
      onclick: () => { TAB = id; render(); },
    }, label);
    main.appendChild(el('div', { class: 'calc-tabs' }, [
      tab('recipes', 'Рецептуры'),
      tab('prices', 'Цены сырья'),
      tab('settings', 'Настройки'),
    ]));
    main.appendChild(el('div', { id: 'calc-content' }));
  }

  function render() {
    shell();
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
    const r = row.recipe || row;
    return r.fg_name || r.product_name || 'Без названия';
  }

  function renderRecipes() {
    const c = $('#calc-content');
    const avgCost = RECIPES.length ? RECIPES.reduce((s, x) => s + num(x.summary.cost_calc), 0) / RECIPES.length : 0;
    const marketUp = RECIPES.filter((x) => num(x.summary.market_delta) > 0.01).length;
    const avgMarginRows = RECIPES.filter((x) => x.summary.margin_pct !== null && x.summary.margin_pct !== undefined);
    const avgMargin = avgMarginRows.length ? avgMarginRows.reduce((s, x) => s + num(x.summary.margin_pct), 0) / avgMarginRows.length : null;

    c.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Плановая калькуляция'),
        el('div', { class: 'calc-sub' }, 'Собираем себестоимость из рецептуры, цены калькуляции и текущего рынка.'),
      ]),
      el('button', { class: 'btn-primary calc-add', onclick: () => openRecipeModal(null) }, '+ Рецептура'),
    ]));
    c.appendChild(el('div', { class: 'calc-kpis' }, [
      kpi('Рецептур', RECIPES.length, ''),
      kpi('Средняя себестоимость', money(avgCost), 'green'),
      kpi('Рынок выше калькуляции', marketUp, marketUp ? 'warn' : ''),
      kpi('Средняя чистая маржа', pct(avgMargin), ''),
    ]));

    const q = inp(recipeQ, {
      placeholder: 'Поиск по готовой продукции',
      oninput: (e) => { recipeQ = e.target.value; clearTimeout(window.__calcRq); window.__calcRq = setTimeout(render, 180); },
    });
    c.appendChild(el('div', { class: 'calc-filters' }, [q]));

    const grid = el('div', { class: 'calc-layout' });
    grid.appendChild(recipeList());
    grid.appendChild(recipeEditor());
    c.appendChild(grid);
  }

  function recipeList() {
    const needle = recipeQ.trim().toLowerCase();
    const rows = RECIPES.filter((x) => !needle || recipeName(x).toLowerCase().includes(needle));
    if (!rows.length) {
      return el('div', { class: 'calc-empty calc-side' }, 'Пока нет рецептур. Добавьте первую и соберите состав.');
    }
    const head = el('div', { class: 'calc-row calc-recipe-row head' }, [
      el('span', {}, 'Товар'),
      el('span', {}, 'Себестоимость'),
      el('span', {}, 'Рынок'),
      el('span', {}, 'Маржа'),
    ]);
    const body = rows.map((x) => {
      const r = x.recipe;
      const s = x.summary || {};
      const delta = num(s.market_delta);
      return el('div', {
        class: 'calc-row calc-recipe-row' + (String(CURRENT_ID) === String(r.id) ? ' on' : ''),
        onclick: () => loadRecipe(r.id),
      }, [
        el('span', {}, [
          el('b', {}, recipeName(x)),
          el('small', {}, (r.fg_code ? r.fg_code + ' · ' : '') + (x.item_count || 0) + ' поз.'),
        ]),
        el('span', { class: 'tnum' }, money(s.cost_calc)),
        el('span', { class: 'tnum ' + (delta > 0 ? 'bad' : delta < 0 ? 'good' : '') }, money(s.cost_market)),
        el('span', { class: 'tnum' }, pct(s.margin_pct)),
      ]);
    });
    return el('div', { class: 'calc-list calc-side' }, [head, ...body]);
  }

  async function loadRecipe(id) {
    try {
      CURRENT_ID = id;
      CURRENT = await api('/recipe/' + id);
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function recipeEditor() {
    if (!CURRENT) {
      return el('div', { class: 'calc-panel calc-empty' }, [
        el('div', { class: 'calc-empty-big' }, 'Выберите рецептуру'),
        el('div', {}, 'Здесь будет состав, себестоимость, сравнение с рынком и маржа.'),
      ]);
    }
    const r = CURRENT.recipe;
    const s = CURRENT.summary || {};
    const panel = el('div', { class: 'calc-panel' });
    panel.appendChild(el('div', { class: 'calc-editor-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h3' }, recipeName(r)),
        el('div', { class: 'calc-sub' }, (r.price_type_name || 'Без типа цены') + (r.sd_sale_price ? ' · цена из SD ' + money(r.sd_sale_price) : '')),
      ]),
      el('div', { class: 'calc-editor-actions' }, [
        el('button', { class: 'btn-ghost', onclick: () => openRecipeModal(r) }, 'Параметры'),
        el('button', { class: 'btn-ghost calc-danger', onclick: archiveRecipe }, 'В архив'),
      ]),
    ]));
    panel.appendChild(el('div', { class: 'calc-kpis calc-kpis-3' }, [
      kpi('Себестоимость в калькуляции', money(s.cost_calc), 'green'),
      kpi('Если взять рынок сейчас', money(s.cost_market), num(s.market_delta) > 0 ? 'warn' : ''),
      kpi('Разница', (num(s.market_delta) > 0 ? '+' : '') + money(s.market_delta), num(s.market_delta) > 0 ? 'warn' : 'green'),
      kpi('Цена продажи', money(s.sale_price), ''),
      kpi('Чистая прибыль', money(s.net_profit), num(s.net_profit) < 0 ? 'bad' : 'green'),
      kpi('Чистая маржа', pct(s.margin_pct), ''),
    ]));
    panel.appendChild(costBreakdown(s));
    panel.appendChild(itemsEditor());
    return panel;
  }

  function costBreakdown(s) {
    const rows = [
      ['Сырьё и упаковка', s.item_calc, s.item_market],
      ['ФОТ', s.labor, s.labor],
      ['Производство', s.production, s.production],
      ['Накладные', s.overhead, s.overhead],
      ['Ретро-бонус', s.retro, s.retro],
      ['НДС', s.vat, s.vat],
      ['Налог на прибыль', s.profit_tax, s.profit_tax],
    ];
    return el('div', { class: 'calc-break' }, [
      el('div', { class: 'calc-sec-title' }, 'Разбор суммы'),
      ...rows.map((r) => el('div', { class: 'calc-break-row' }, [
        el('span', {}, r[0]),
        el('span', { class: 'tnum' }, money(r[1])),
        el('span', { class: 'tnum muted' }, money(r[2])),
      ])),
    ]);
  }

  function itemsEditor() {
    const items = CURRENT.items || [];
    return el('div', { class: 'calc-items' }, [
      el('div', { class: 'calc-items-head' }, [
        el('div', { class: 'calc-sec-title' }, 'Состав рецептуры'),
        el('div', { class: 'calc-head-btns' }, [
          el('button', { class: 'btn-ghost', onclick: () => addItem('raw') }, '+ Сырьё'),
          el('button', { class: 'btn-ghost', onclick: () => addItem('packaging') }, '+ Упаковка'),
          el('button', { class: 'btn-primary', onclick: saveItems }, 'Сохранить состав'),
        ]),
      ]),
      items.length ? el('div', { class: 'calc-item-table' }, [
        el('div', { class: 'calc-item-row head' }, [
          el('span', {}, 'Тип'), el('span', {}, 'Позиция'), el('span', {}, 'Кол-во'), el('span', {}, 'Ед.'), el('span', {}, 'Потери %'), el('span', {}, 'Цена вручную'), el('span', {}, 'Сумма'), el('span', {}, ''),
        ]),
        ...items.map((it, i) => itemRow(it, i)),
      ]) : el('div', { class: 'calc-empty calc-empty-soft' }, 'Состав пока пустой. Добавьте сырьё и упаковку.'),
    ]);
  }

  function itemRow(it, i) {
    const kind = it.item_kind === 'packaging' ? 'packaging' : 'raw';
    const kindSel = select([{ v: 'raw', t: 'Сырьё' }, { v: 'packaging', t: 'Упаковка' }], kind, {
      name: 'item_kind',
      onchange: (e) => {
        CURRENT.items = readItemsFromDom();
        CURRENT.items[i].item_kind = e.target.value;
        CURRENT.items[i].item_id = '';
        render();
      },
    });
    const matSel = materialSelect(kind, it.item_id);
    matSel.setAttribute('name', 'item_id');
    return el('div', { class: 'calc-item-row', 'data-index': i }, [
      kindSel,
      matSel,
      inp(it.qty, { name: 'qty', type: 'number', step: '0.001', placeholder: kind === 'raw' ? 'г' : 'шт' }),
      inp(it.unit || (kind === 'raw' ? 'г' : 'шт'), { name: 'unit' }),
      inp(it.waste_pct, { name: 'waste_pct', type: 'number', step: '0.1' }),
      inp(it.manual_price, { name: 'manual_price', type: 'number', step: '0.01', placeholder: 'авто' }),
      el('span', { class: 'tnum muted' }, money(it.calc_cost)),
      el('button', { class: 'calc-icon-btn', title: 'Удалить', onclick: () => { CURRENT.items = readItemsFromDom(); CURRENT.items.splice(i, 1); render(); } }, '×'),
    ]);
  }

  function materialSelect(kind, value) {
    const list = MATERIALS.filter((m) => m.kind === kind);
    return select([
      { v: '', t: '— выберите —' },
      ...list.map((m) => ({ v: m.id, t: (m.code ? m.code + ' · ' : '') + m.name })),
    ], value);
  }

  function readItemsFromDom() {
    return [...document.querySelectorAll('.calc-item-row[data-index]')].map((row) => ({
      item_kind: row.querySelector('[name="item_kind"]').value,
      item_id: row.querySelector('[name="item_id"]').value,
      qty: row.querySelector('[name="qty"]').value,
      unit: row.querySelector('[name="unit"]').value,
      waste_pct: row.querySelector('[name="waste_pct"]').value,
      manual_price: row.querySelector('[name="manual_price"]').value,
    }));
  }

  function addItem(kind) {
    CURRENT.items = readItemsFromDom();
    CURRENT.items.push({ item_kind: kind, item_id: '', qty: '', unit: kind === 'raw' ? 'г' : 'шт', waste_pct: 0, manual_price: '' });
    render();
  }

  async function saveItems() {
    if (!CURRENT_ID) return;
    try {
      await post('/recipe/' + CURRENT_ID + '/items', { items: readItemsFromDom() });
      toast('Состав сохранён');
      await reloadBase();
      CURRENT = await api('/recipe/' + CURRENT_ID);
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function openRecipeModal(recipe) {
    recipe = recipe || {};
    const product = select([
      { v: '', t: '— товар из справочника —' },
      ...DICTS.products.map((p) => ({ v: p.id, t: (p.code ? p.code + ' · ' : '') + p.name })),
    ], recipe.product_id || '');
    const productName = inp(recipe.product_name || '', { placeholder: 'или название вручную' });
    const priceType = select([
      { v: '', t: '— тип цены —' },
      ...DICTS.priceTypes.map((p) => ({ v: p.id, t: p.name })),
    ], recipe.sale_price_type_id || '');
    const weight = inp(recipe.pack_weight_g, { type: 'number', step: '0.1', placeholder: 'например 250' });
    const unit = inp(recipe.pack_unit || 'шт');
    const saleOverride = inp(recipe.sale_price_override, { type: 'number', step: '0.01', placeholder: 'если цена не из SD' });
    const retro = inp(recipe.retro_pct ?? DICTS.settings.retro_pct, { type: 'number', step: '0.1' });
    const vat = inp(recipe.vat_pct ?? DICTS.settings.vat_pct, { type: 'number', step: '0.1' });
    const profitTax = inp(recipe.profit_tax_pct ?? DICTS.settings.profit_tax_pct, { type: 'number', step: '0.1' });
    const waste = inp(recipe.waste_pct ?? DICTS.settings.waste_pct, { type: 'number', step: '0.1' });
    const laborCoeff = inp(recipe.labor_coeff ?? 1, { type: 'number', step: '0.1' });
    const prodCoeff = inp(recipe.production_coeff ?? 1, { type: 'number', step: '0.1' });
    const overheadCoeff = inp(recipe.overhead_coeff ?? 1, { type: 'number', step: '0.1' });
    const comment = area(recipe.comment || '', { placeholder: 'Комментарий' });
    const body = el('div', { class: 'calcf' }, [
      frow('Готовый товар', product),
      frow('Название вручную', productName),
      frow('Вес упаковки, г', weight),
      frow('Единица', unit),
      frow('Тип цены продажи', priceType),
      frow('Цена вручную', saleOverride),
      el('div', { class: 'calcf-sec' }, 'Проценты'),
      frow('Ретро-бонус %', retro),
      frow('НДС %', vat),
      frow('Налог на прибыль %', profitTax),
      frow('Потери по рецептуре %', waste),
      el('div', { class: 'calcf-sec' }, 'Коэффициенты расходов'),
      frow('ФОТ, коэффициент', laborCoeff),
      frow('Производство, коэффициент', prodCoeff),
      frow('Накладные, коэффициент', overheadCoeff),
      frow('Комментарий', comment),
    ]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        const res = await post('/recipe', {
          id: recipe.id,
          product_id: product.value,
          product_name: productName.value,
          pack_weight_g: weight.value,
          pack_unit: unit.value,
          sale_price_type_id: priceType.value,
          sale_price_override: saleOverride.value,
          retro_pct: retro.value,
          vat_pct: vat.value,
          profit_tax_pct: profitTax.value,
          waste_pct: waste.value,
          labor_coeff: laborCoeff.value,
          production_coeff: prodCoeff.value,
          overhead_coeff: overheadCoeff.value,
          comment: comment.value,
        });
        CURRENT_ID = res.id;
        toast('Рецептура сохранена');
        closeModal();
        await reloadBase();
        CURRENT = await api('/recipe/' + CURRENT_ID);
        render();
      } catch (e) {
        toast(e.message, true);
      }
    } }, 'Сохранить');
    modal(recipe.id ? 'Параметры рецептуры' : 'Новая рецептура', body, [save]);
  }

  async function archiveRecipe() {
    if (!CURRENT_ID || !confirm('Убрать рецептуру в архив?')) return;
    try {
      await post('/recipe/' + CURRENT_ID + '/archive');
      CURRENT_ID = null;
      CURRENT = null;
      await reloadBase();
      toast('Рецептура в архиве');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderPrices() {
    const c = $('#calc-content');
    const changed = MATERIALS.filter((m) => Math.abs(num(m.market_price) - num(m.calc_price)) > 0.01).length;
    c.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Цены сырья и упаковки'),
        el('div', { class: 'calc-sub' }, 'Цена калькуляции фиксируется отдельно, рынок можно обновлять по закупу или вручную.'),
      ]),
    ]));
    c.appendChild(el('div', { class: 'calc-kpis' }, [
      kpi('Позиций', MATERIALS.length, ''),
      kpi('Есть отличие рынка', changed, changed ? 'warn' : ''),
      kpi('Сырьё', MATERIALS.filter((m) => m.kind === 'raw').length, ''),
      kpi('Упаковка', MATERIALS.filter((m) => m.kind === 'packaging').length, ''),
    ]));
    const kind = select([
      { v: '', t: 'Все типы' },
      { v: 'raw', t: 'Сырьё' },
      { v: 'packaging', t: 'Упаковка' },
    ], materialKind, { onchange: (e) => { materialKind = e.target.value; render(); } });
    const q = inp(materialQ, {
      placeholder: 'Поиск по названию или артикулу',
      oninput: (e) => { materialQ = e.target.value; clearTimeout(window.__calcMq); window.__calcMq = setTimeout(render, 180); },
    });
    c.appendChild(el('div', { class: 'calc-filters' }, [kind, q]));

    const needle = materialQ.trim().toLowerCase();
    const rows = MATERIALS.filter((m) => (!materialKind || m.kind === materialKind) && (!needle || (m.name || '').toLowerCase().includes(needle) || (m.code || '').toLowerCase().includes(needle)));
    const table = el('div', { class: 'calc-price-table' }, [
      el('div', { class: 'calc-price-row head' }, [
        el('span', {}, 'Тип'), el('span', {}, 'Позиция'), el('span', {}, 'Цена калькуляции'), el('span', {}, 'Рынок сейчас'), el('span', {}, 'Последняя закупка'), el('span', {}, 'Разница'), el('span', {}, 'Комментарий'), el('span', {}, ''),
      ]),
      ...rows.map(priceRow),
    ]);
    c.appendChild(rows.length ? table : el('div', { class: 'calc-empty' }, 'Ничего не найдено.'));
  }

  function priceRow(m) {
    const calc = inp(m.calc_price, { type: 'number', step: '0.01', name: 'calc_price' });
    const market = inp(m.market_price, { type: 'number', step: '0.01', name: 'market_price' });
    const comment = inp(m.price_comment || '', { name: 'comment', placeholder: 'почему цена отличается' });
    const delta = num(m.market_price) - num(m.calc_price);
    const row = el('div', { class: 'calc-price-row' }, [
      el('span', {}, m.kind === 'packaging' ? 'Упаковка' : 'Сырьё'),
      el('span', {}, [
        el('b', {}, m.name || ''),
        el('small', {}, (m.code || '') + (m.category_name ? ' · ' + m.category_name : '')),
      ]),
      calc,
      market,
      el('span', { class: 'tnum muted' }, [
        el('b', {}, money(m.last_purchase_price)),
        el('small', {}, (m.last_source ? m.last_source + ' · ' : '') + ruDate(m.last_purchase_at)),
      ]),
      el('span', { class: 'tnum ' + (delta > 0 ? 'bad' : delta < 0 ? 'good' : '') }, (delta > 0 ? '+' : '') + money(delta)),
      comment,
      el('div', { class: 'calc-row-actions' }, [
        el('button', { class: 'btn-ghost', onclick: () => { calc.value = market.value; savePrice(m, row); } }, 'Принять'),
        el('button', { class: 'btn-primary', onclick: () => savePrice(m, row) }, 'Сохранить'),
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
        market_price: row.querySelector('[name="market_price"]').value,
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
    c.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Настройки калькуляции'),
        el('div', { class: 'calc-sub' }, 'Временные коэффициенты для плановой себестоимости. Позже сюда подтянем ФОТ и производство напрямую.'),
      ]),
    ]));
    const fields = [
      ['monthly_units', 'План выпуска в месяц, шт', 'Для ориентира и будущего распределения расходов'],
      ['labor_per_unit', 'ФОТ на единицу, сум', 'Сейчас вручную, позже свяжем с плиткой “Персонал”'],
      ['production_per_unit', 'Производственные расходы на единицу, сум', 'Электричество, вода, расходники и прочее'],
      ['overhead_per_unit', 'Накладные на единицу, сум', 'Административные и общие расходы'],
      ['retro_pct', 'Ретро-бонус по умолчанию, %', 'Подставляется в новую рецептуру'],
      ['vat_pct', 'НДС по умолчанию, %', 'Подставляется в новую рецептуру'],
      ['profit_tax_pct', 'Налог на прибыль, %', 'Считается только если прибыль положительная'],
      ['waste_pct', 'Потери по рецептуре, %', 'Общий процент сверху после состава'],
    ];
    const form = el('div', { class: 'calc-settings' }, fields.map(([key, label, hint]) => {
      const control = inp(s[key], { type: 'number', step: '0.01', name: key });
      return el('label', { class: 'calc-setting-row' }, [
        el('span', {}, [el('b', {}, label), el('small', {}, hint)]),
        control,
      ]);
    }));
    const save = el('button', { class: 'btn-primary calc-save-settings', onclick: async () => {
      const body = {};
      fields.forEach(([key]) => { body[key] = form.querySelector('[name="' + key + '"]').value; });
      try {
        const res = await post('/settings', body);
        DICTS.settings = res.settings || body;
        toast('Настройки сохранены');
        await reloadBase();
        render();
      } catch (e) {
        toast(e.message, true);
      }
    } }, 'Сохранить настройки');
    c.appendChild(form);
    c.appendChild(save);
  }

  boot();
})();
