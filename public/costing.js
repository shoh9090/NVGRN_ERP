// costing.js — «Калькуляция себестоимости» (ребилд по ТЗ). Этап 1: каркас + перенос данных.
(function () {
  const $ = (s) => document.querySelector(s);
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    if (children != null) (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null) return; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  const money = (v) => (v == null || v === '' ? '—' : Math.round(Number(v) || 0).toLocaleString('ru-RU'));
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
  async function api(path, opts) { const r = await fetch('/costing/api' + path, opts); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Ошибка'); return d; }
  const apiPost = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const apiDel = (path) => api(path, { method: 'DELETE' });
  // Inline-ячейки: сохраняют одно поле при потере фокуса/изменении.
  function editText(val, onSave, extra) { const inp = el('input', Object.assign({ class: 'cstf-inp cst-cell', value: val == null ? '' : val }, extra || {})); inp.addEventListener('change', () => onSave(inp.value)); inp.addEventListener('click', (e) => e.stopPropagation()); return inp; }
  function editNum(val, onSave, extra) { return editText(val, (v) => onSave(v), Object.assign({ type: 'number', step: 'any', class: 'cstf-inp cst-cell tnum' }, extra || {})); }
  function editSel(val, options, onSave) { const s = el('select', { class: 'cstf-inp cst-cell' }, options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return el('option', { value: v, selected: String(v) === String(val) || null }, l); })); s.addEventListener('change', () => onSave(s.value)); s.addEventListener('click', (e) => e.stopPropagation()); return s; }
  function toast(msg, err) { const t = el('div', { class: 'cst-toast' + (err ? ' err' : '') }, msg); document.body.appendChild(t); setTimeout(() => t.classList.add('show'), 10); setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000); }

  let BOOT = null;
  let TAB = 'matrix';
  let PERIOD = '';
  let recSel = null;
  let REFS = null;
  async function refs() { if (!REFS) REFS = await api('/refs'); return REFS; }
  let PTYPES = null;
  async function ptypes() { if (!PTYPES) PTYPES = (await api('/price-types').catch(() => ({ items: [] }))).items; return PTYPES; }

  async function boot() {
    try { BOOT = await api('/bootstrap' + (PERIOD ? '?period=' + PERIOD : '')); }
    catch (e) { $('#cst-main').innerHTML = '<div class="cst-empty">Ошибка загрузки: ' + e.message + '</div>'; return; }
    if (!PERIOD && BOOT.period) PERIOD = BOOT.period.period;
    render();
  }

  function shell() {
    const main = $('#cst-main'); main.innerHTML = '';
    // Верхняя панель: период, тип, действия.
    const periods = BOOT.periods || [];
    const pSel = el('select', { class: 'cstf-inp cst-top-sel', onchange: (e) => { PERIOD = e.target.value; boot(); } },
      (periods.length ? periods : [{ period: PERIOD || '—' }]).map((p) => el('option', { value: p.period, selected: p.period === PERIOD || null }, p.period)));
    const typeSel = el('select', { class: 'cstf-inp cst-top-sel' }, [el('option', {}, 'Плановая')]);
    main.appendChild(el('div', { class: 'cst-topbar' }, [
      el('div', { class: 'cst-title' }, 'Калькуляция себестоимости'),
      el('div', { class: 'cst-top-ctrls' }, [
        el('span', { class: 'cst-flab' }, 'Период:'), pSel,
        el('span', { class: 'cst-flab' }, 'Тип:'), typeSel,
        el('button', { class: 'btn-ghost cst-btn', onclick: () => { TAB = 'matrix'; render(); toast('Пересчитано'); } }, 'Пересчитать'),
        el('button', { class: 'btn-ghost cst-btn', onclick: fixSnapshot }, 'Зафиксировать'),
        el('button', { class: 'btn-ghost cst-btn', onclick: () => { window.location = '/costing/api/export.xlsx' + (PERIOD ? '?period=' + PERIOD : ''); } }, 'Экспорт Excel'),
      ]),
    ]));
    const tab = (id, label) => el('button', { class: 'cst-tab' + (TAB === id ? ' on' : ''), onclick: () => { TAB = id; render(); } }, label);
    main.appendChild(el('div', { class: 'cst-tabs' }, [
      tab('matrix', 'Матрица себестоимости'),
      tab('recipes', 'Рецептуры'),
      tab('packaging', 'Упаковка'),
      tab('settings', 'Настройки расчёта'),
      tab('history', 'История'),
    ]));
    main.appendChild(el('div', { id: 'cst-content' }));
  }

  function render() {
    shell();
    if (TAB === 'recipes') return renderRecipes();
    if (TAB === 'settings') return renderSettings();
    if (TAB === 'packaging') return renderPackaging();
    if (TAB === 'history') return renderHistory();
    return renderMatrix();
  }

  function renderSoon(title, text) {
    $('#cst-content').appendChild(el('div', { class: 'cst-soon' }, [
      el('div', { class: 'cst-soon-h' }, title), el('div', { class: 'cst-soon-t' }, text),
    ]));
  }

  // ===== Матрица: развёрнутый вид (SKU в столбцах, показатели в строках) =====
  let MX = null;            // сырые строки расчёта
  let mxSel = null;         // выбранный SKU (детализация)
  const mxFilter = { q: '', channel: '', status: 'active' };
  const marginClass = (r) => (r.sd_price == null ? '' : (num(r.margin) < 0 ? 'mx-bad' : num(r.margin) < 10 ? 'mx-warn' : 'mx-good'));
  const sdCell = (r) => {
    if (r.sd_state === 'ok') return { text: money(r.sd_price), cls: '' };
    if (r.sd_state === 'no_price') return { text: 'Нет цены в SD', cls: 'mx-cell-bad' };
    return { text: 'Не привязан к SD', cls: 'mx-cell-warn' };
  };

  async function renderMatrix() {
    const c = $('#cst-content');
    c.appendChild(el('div', { class: 'cst-head' }, [el('div', { class: 'cst-h2' }, 'Матрица себестоимости'),
      el('div', { class: 'cst-sub' }, 'Столбцы — SKU, строки — показатели по группам. Клик по названию SKU раскрывает состав снизу. Цвет — по чистой марже.')]));
    const box = el('div', {}); c.appendChild(box);
    box.appendChild(el('div', { class: 'cst-loading' }, 'Считаю…'));
    let d; try { d = await api('/matrix' + (PERIOD ? '?period=' + PERIOD : '')); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'cst-empty' }, 'Ошибка: ' + e.message)); return; }
    MX = d.rows || [];
    box.innerHTML = '';
    if (!MX.length) { box.appendChild(el('div', { class: 'cst-empty' }, 'Нет рецептур для расчёта.')); return; }
    // KPI.
    const priced = MX.filter((r) => r.sd_price != null);
    const avgMargin = priced.length ? priced.reduce((s, r) => s + (num(r.margin) || 0), 0) / priced.length : null;
    box.appendChild(el('div', { class: 'cst-kpis' }, [
      kpi('SKU в расчёте', MX.length),
      kpi('Средняя маржа', avgMargin == null ? '—' : avgMargin.toFixed(1) + '%'),
      kpi('Без цены компонента', MX.filter((r) => r.no_price).length),
      kpi('Без цены SD', MX.filter((r) => r.sd_price == null).length),
    ]));
    // Фильтры.
    const channels = Array.from(new Set(MX.map((r) => r.channel).filter(Boolean)));
    box.appendChild(el('div', { class: 'cst-filters' }, [
      editText(mxFilter.q, () => {}, { placeholder: 'Поиск SKU…', class: 'cstf-inp', style: 'min-width:170px', oninput: (e) => { mxFilter.q = e.target.value; drawMatrix(); } }),
      editSel(mxFilter.channel, [['', 'Все каналы'], ...channels.map((x) => [x, x])], (v) => { mxFilter.channel = v; drawMatrix(); }),
      editSel(mxFilter.status, [['active', 'Активные'], ['all', 'Все (кроме архива)'], ['draft', 'Черновики']], (v) => { mxFilter.status = v; drawMatrix(); }),
    ]));
    box.appendChild(el('div', { id: 'cst-mx-body' }));
    box.appendChild(el('div', { class: 'cst-legend' }, [lg('mx-good', 'маржа >10%'), lg('mx-warn', '0–10%'), lg('mx-bad', '<0'), lg('mx-cell-warn', 'не привязан к SD'), lg('mx-cell-bad', 'нет цены')]));
    box.appendChild(el('div', { id: 'cst-mx-detail', style: 'margin-top:16px' }));
    drawMatrix();
  }

  function filteredSkus() {
    return MX.filter((r) => {
      if (mxFilter.status === 'active' && r.status !== 'active') return false;
      if (mxFilter.status === 'draft' && r.status !== 'draft') return false;
      if (mxFilter.channel && r.channel !== mxFilter.channel) return false;
      if (mxFilter.q && !(r.name || '').toLowerCase().includes(mxFilter.q.toLowerCase())) return false;
      return true;
    });
  }

  function drawMatrix() {
    const body = $('#cst-mx-body'); if (!body) return; body.innerHTML = '';
    const skus = filteredSkus();
    if (!skus.length) { body.appendChild(el('div', { class: 'cst-empty' }, 'Ничего не найдено по фильтру.')); return; }
    const m = (fn, opt) => ({ fn, opt: opt || {} });
    const groups = [
      ['Основные данные', [
        ['Канал', m((r) => r.channel || '—', { txt: 1 })],
        ['Вес, г', m((r) => r.gram_weight ? money(r.gram_weight) : '—')],
        ['Статус', m((r) => statusLabel(r.status), { txt: 1 })],
      ]],
      ['Цена продажи', [
        ['Цена SD', m((r) => sdCell(r), { cell: 1 })],
        ['НДС (' + (skus[0] ? skus[0].vat_rate : 12) + '%)', m((r) => r.sd_price == null ? '—' : money(r.vat))],
        ['Ретро', m((r) => r.sd_price == null ? '—' : money(r.retro))],
      ]],
      ['Сырьё', [['Стоимость сырья', m((r) => money(r.raw), { bad: (r) => r.no_price })]]],
      ['Упаковка', [['Стоимость упаковки', m((r) => money(r.pack))]]],
      ['Производство', [['Производственные', m((r) => money(r.production))]]],
      ['ФОТ', [['ФОТ', m((r) => money(r.labor))]]],
      ['Логистика', [['Логистика', m((r) => money(r.logistics))]]],
      ['Накладные', [['Общепроизводственные', m((r) => money(r.overhead))]]],
      ['Итоговая себестоимость', [
        ['Полная себестоимость', m((r) => money(r.base), { strong: 1 })],
        ['Отход', m((r) => r.waste_rate ? r.waste_rate + '%' : '—', { txt: 1 })],
        ['С/с с отходом', m((r) => money(r.cost_with_waste), { strong: 1 })],
      ]],
      ['Прибыль / маржа', [
        ['Валовая прибыль', m((r) => r.profit == null ? '—' : money(r.profit))],
        ['Налог на прибыль', m((r) => r.tax == null ? '—' : money(r.tax))],
        ['Чистая прибыль', m((r) => r.net == null ? '—' : money(r.net), { strong: 1 })],
        ['Маржа %', m((r) => r.margin == null ? '—' : r.margin.toFixed(1) + '%', { margin: 1 })],
      ]],
    ];
    const table = el('table', { class: 'cst-tx' });
    const headTr = el('tr', {}, [el('th', { class: 'tx-ind' }, 'Показатель'),
      ...skus.map((r) => el('th', {
        class: 'tx-sku' + (String(r.id) === String(mxSel) ? ' sel' : ''), title: 'Открыть состав',
        onclick: () => { mxSel = (String(mxSel) === String(r.id) ? null : r.id); drawMatrix(); drawDetail(); },
      }, [el('div', { class: 'tx-sku-name' }, r.name), el('div', { class: 'tx-sku-ch' }, r.channel || '—')])),
    ]);
    const bodyRows = [];
    for (const [gname, inds] of groups) {
      bodyRows.push(el('tr', { class: 'tx-grp' }, [el('td', { class: 'tx-ind' }, gname), ...skus.map(() => el('td', {}, ''))]));
      for (const [label, def] of inds) {
        bodyRows.push(el('tr', {}, [el('td', { class: 'tx-ind' }, label), ...skus.map((r) => {
          const v = def.fn(r); const o = def.opt;
          let cls = 'tnum';
          if (o.txt) cls = 'tx-txt';
          if (o.strong) cls += ' strong';
          if (o.margin) cls += ' ' + marginClass(r);
          if (o.bad && o.bad(r)) cls += ' mx-bad';
          if (o.cell) return el('td', { class: 'tnum ' + (v.cls || '') }, v.text);
          return el('td', { class: cls }, v);
        })]));
      }
    }
    table.appendChild(el('thead', {}, headTr));
    table.appendChild(el('tbody', {}, bodyRows));
    body.appendChild(el('div', { class: 'cst-mx-wrap' }, table));
    drawDetail();
  }

  function drawDetail() {
    const box = $('#cst-mx-detail'); if (!box) return; box.innerHTML = '';
    if (mxSel == null) return;
    const r = MX.find((x) => String(x.id) === String(mxSel)); if (!r) return;
    const rawItems = (r.items || []).filter((i) => i.type !== 'packaging');
    const packItems = (r.items || []).filter((i) => i.type === 'packaging');
    const itemsTable = (title, list, cols) => el('div', { style: 'margin-top:10px' }, [
      el('div', { class: 'cst-sub', style: 'font-weight:800;margin-bottom:5px' }, title),
      list.length ? el('div', { class: 'cst-mx-wrap' }, el('table', { class: 'cst-tx' }, [
        el('thead', {}, el('tr', {}, cols.map((h, i) => el('th', { class: i === 0 ? 'tx-ind' : 'tnum' }, h)))),
        el('tbody', {}, list.map((it) => el('tr', {}, [
          el('td', { class: 'tx-ind' }, it.name || '—'),
          el('td', { class: 'tnum' }, money(it.qty) + ' ' + (it.unit || '')),
          el('td', { class: 'tnum' }, it.price != null ? money(it.price) : '—'),
          el('td', { class: 'tnum' }, it.waste_rate ? it.waste_rate + '%' : '—'),
          el('td', { class: 'tnum strong' + (it.source === 'Нет цены' ? ' mx-bad' : '') }, money(it.cost)),
        ]))),
      ])) : el('div', { class: 'cst-empty' }, 'Нет позиций.'),
    ]);
    box.appendChild(el('div', { class: 'cst-detail' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' }, [
        el('div', { class: 'cst-h2', style: 'font-size:18px' }, 'Состав: ' + r.name),
        iconBtn('✕', 'Закрыть', () => { mxSel = null; drawMatrix(); }),
      ]),
      itemsTable('Сырьё', rawItems, ['Ингредиент', 'Кол-во', 'Цена/ед', 'Отход', 'Стоимость']),
      itemsTable('Упаковка', packItems, ['Материал', 'Кол-во', 'Цена/ед', 'Отход', 'Стоимость']),
      el('div', { class: 'cst-detail-tot' }, [
        totCell('Сырьё', money(r.raw)), totCell('Упаковка', money(r.pack)), totCell('ФОТ', money(r.labor)),
        totCell('Производство', money(r.production)), totCell('Логистика', money(r.logistics)), totCell('Накладные', money(r.overhead)),
        totCell('Полная с/с', money(r.cost_with_waste), 'strong'),
        totCell('Цена SD', r.sd_price == null ? '—' : money(r.sd_price)),
        totCell('Чистая прибыль', r.net == null ? '—' : money(r.net), 'strong'),
        totCell('Маржа', r.margin == null ? '—' : r.margin.toFixed(1) + '%', marginClass(r)),
      ]),
    ]));
  }
  function totCell(label, val, cls) { return el('div', { class: 'cst-tot' }, [el('div', { class: 'cst-kpi-l' }, label), el('div', { class: 'cst-tot-v ' + (cls || '') }, String(val))]); }
  function lg(cls, text) { return el('span', { class: 'cst-lg' }, [el('span', { class: 'cst-lg-dot ' + cls }), text]); }

  // ===== Рецептуры: список (inline) + компоненты выбранной =====
  const TYPE_OPTS = [['raw', 'Сырьё'], ['packaging', 'Упаковка'], ['other', 'Прочее']];
  const STATUS_OPTS = [['draft', 'Черновик'], ['active', 'Активна'], ['archived', 'Архив']];
  async function renderRecipes() {
    const c = $('#cst-content');
    c.appendChild(el('div', { class: 'cst-head' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' }, [
        el('div', {}, [el('div', { class: 'cst-h2' }, 'Рецептуры'),
          el('div', { class: 'cst-sub' }, 'Сверху — рецептуры (SKU), снизу — компоненты выбранной. Правьте прямо в ячейках; изменения сохраняются сразу.')]),
        el('button', { class: 'btn-ghost cst-btn', onclick: addRecipe }, '+ Добавить SKU'),
      ]),
    ]));
    await refs().catch(() => {});
    const box = el('div', { id: 'cst-rec-box' }); c.appendChild(box);
    box.appendChild(el('div', { class: 'cst-loading' }, 'Загружаю…'));
    let d; try { d = await api('/recipes'); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'cst-empty' }, 'Ошибка: ' + e.message)); return; }
    box.innerHTML = '';
    if (!d.items.length) { box.appendChild(el('div', { class: 'cst-empty' }, 'Рецептур нет. Нажмите «+ Добавить SKU».')); return; }
    if (recSel == null || !d.items.some((r) => String(r.id) === String(recSel))) recSel = d.items[0].id;
    const chOpts = ['', ...((REFS && REFS.channels) || [])];
    const save = (id, field, v) => apiPost('/recipe/' + id, { [field]: v }).then(() => toast('Сохранено')).catch((e) => toast(e.message, true));
    const head = el('div', { class: 'cst-row head cst-rec' }, ['#', 'SKU', 'Канал', 'Граммаж', 'Отход %', 'Версия', 'Статус', 'Действия'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cst-list' }, [head, ...d.items.map((r, i) => el('div', {
      class: 'cst-row cst-rec' + (String(r.id) === String(recSel) ? ' sel' : '') + (r.status === 'archived' ? ' dim' : ''),
      onclick: () => { recSel = r.id; renderRecipes(); },
    }, [
      el('span', { class: 'cst-idx' }, String(i + 1)),
      editText(r.finished_good_name, (v) => save(r.id, 'finished_good_name', v)),
      editSel(r.channel || '', chOpts.map((x) => [x, x || '—']), (v) => save(r.id, 'channel', v)),
      editNum(r.gram_weight, (v) => save(r.id, 'gram_weight', v)),
      editNum(r.sku_waste_rate, (v) => save(r.id, 'sku_waste_rate', v)),
      editText(r.version, (v) => save(r.id, 'version', v), { class: 'cstf-inp cst-cell', style: 'width:64px' }),
      editSel(r.status, STATUS_OPTS, (v) => save(r.id, 'status', v).then(() => renderRecipes())),
      el('span', { class: 'cst-acts' }, [
        iconBtn('⧉', 'Дублировать', (e) => { e.stopPropagation(); apiPost('/recipe/' + r.id + '/duplicate').then((x) => { recSel = x.id; toast('Скопировано'); renderRecipes(); }); }),
        iconBtn('🗑', 'Архивировать/удалить', (e) => { e.stopPropagation(); if (!confirm('Убрать рецептуру «' + r.finished_good_name + '»?')) return; apiDel('/recipe/' + r.id).then(() => { toast('Убрано'); renderRecipes(); }); }),
      ]),
    ]))]));
    const compBox = el('div', { id: 'cst-comp-box', style: 'margin-top:18px' }); box.appendChild(compBox);
    loadComponents(compBox, recSel);
  }

  function addRecipe() {
    const name = prompt('Название нового SKU:'); if (!name) return;
    apiPost('/recipe', { finished_good_name: name }).then((x) => { recSel = x.id; toast('Создано'); renderRecipes(); }).catch((e) => toast(e.message, true));
  }

  async function loadComponents(box, recipeId) {
    box.appendChild(el('div', { class: 'cst-loading' }, 'Компоненты…'));
    let d; try { d = await api('/recipe/' + recipeId + '/components'); } catch (e) { box.innerHTML = ''; return; }
    box.innerHTML = '';
    box.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:10px;flex-wrap:wrap' }, [
      el('div', { class: 'cst-sub', style: 'font-weight:800' }, 'Компоненты выбранной рецептуры'),
      el('button', { class: 'btn-ghost cst-btn', onclick: () => addComponent(recipeId) }, '+ Компонент'),
    ]));
    const save = (id, field, v) => apiPost('/component/' + id, { [field]: v }).then(() => toast('Сохранено')).catch((e) => toast(e.message, true));
    const head = el('div', { class: 'cst-row head cst-comp' }, ['#', 'Тип', 'Компонент', 'Кол-во', 'Ед.', 'Доля %', 'Отход %', 'Цена/ед'].map((h) => el('span', {}, h)));
    const rowsUi = d.items.length ? d.items.map((c, i) => {
      const list = ((REFS && REFS.items) || []).filter((x) => x.kind === (c.component_type === 'packaging' ? 'packaging' : 'raw'));
      const opts = [['', '— выбрать —'], ...list.map((x) => [x.kind + ':' + x.id, x.name])];
      const cur = c.component_id ? (c.component_type === 'packaging' ? 'packaging' : 'raw') + ':' + c.component_id : '';
      const ref = list.find((x) => (x.kind + ':' + x.id) === cur);
      const price = c.manual_price != null ? c.manual_price : (ref ? ref.price : null);
      return el('div', { class: 'cst-row cst-comp' }, [
        el('span', { class: 'cst-idx' }, String(i + 1)),
        editSel(c.component_type || 'raw', TYPE_OPTS, (v) => save(c.id, 'component_type', v).then(() => loadComponents(box, recipeId))),
        editSel(cur, opts, (v) => { const [k, id] = v.split(':'); const it = list.find((x) => String(x.id) === id); apiPost('/component/' + c.id, { component_id: id || null, component_name: it ? it.name : c.component_name, unit: it ? it.unit : c.unit }).then(() => { toast('Сохранено'); loadComponents(box, recipeId); }); }),
        editNum(c.qty, (v) => save(c.id, 'qty', v)),
        editText(c.unit, (v) => save(c.id, 'unit', v), { class: 'cstf-inp cst-cell', style: 'width:52px' }),
        editNum(c.share_percent, (v) => save(c.id, 'share_percent', v)),
        editNum(c.waste_rate, (v) => save(c.id, 'waste_rate', v)),
        el('span', { class: 'cst-price-cell' }, [
          editNum(c.manual_price, (v) => save(c.id, 'manual_price', v === '' ? null : v), { placeholder: ref && ref.price != null ? money(ref.price) : '', title: 'Пусто = цена из Закупа' }),
          iconBtn('🗑', 'Удалить', () => { if (confirm('Удалить компонент?')) apiDel('/component/' + c.id).then(() => loadComponents(box, recipeId)); }),
        ]),
      ]);
    }) : [el('div', { class: 'cst-empty' }, 'Компонентов нет.')];
    box.appendChild(el('div', { class: 'cst-list' }, [head, ...rowsUi]));
  }

  function addComponent(recipeId) {
    apiPost('/recipe/' + recipeId + '/component', { component_type: 'raw', unit: 'г' })
      .then(() => { toast('Добавлено'); const box = $('#cst-comp-box'); if (box) loadComponents(box, recipeId); })
      .catch((e) => toast(e.message, true));
  }

  function iconBtn(glyph, title, onclick) { return el('button', { class: 'cst-icon-btn', title, onclick }, glyph); }

  // ===== Настройки расчёта: период + статьи затрат + каналы (inline) =====
  async function renderSettings() {
    const c = $('#cst-content');
    c.appendChild(el('div', { class: 'cst-head' }, [el('div', { class: 'cst-h2' }, 'Настройки расчёта'),
      el('div', { class: 'cst-sub' }, 'Параметры периода, статьи затрат (прямые/накладные) и условия каналов. Правьте прямо в ячейках — матрица пересчитается.')]));
    const p = BOOT.period;
    if (!p) { c.appendChild(el('div', { class: 'cst-empty' }, 'Нет периода.')); return; }
    await ptypes().catch(() => {});
    const savP = (field, v) => apiPost('/period/' + p.id, { [field]: v }).then(() => { toast('Сохранено'); }).catch((e) => toast(e.message, true));
    // Параметры периода.
    const paramRow = (label, field, val, suffix) => el('div', { class: 'cst-param' }, [
      el('div', { class: 'cst-kpi-l' }, label),
      el('div', { style: 'display:flex;align-items:center;gap:5px' }, [editNum(val, (v) => savP(field, v), { style: 'max-width:140px' }), suffix ? el('span', { class: 'muted' }, suffix) : null]),
    ]);
    c.appendChild(el('div', { class: 'cst-params' }, [
      el('div', { class: 'cst-param' }, [el('div', { class: 'cst-kpi-l' }, 'Период'), el('div', { class: 'cst-kpi-v' }, p.period)]),
      paramRow('Средний выпуск, шт', 'avg_monthly_output', p.avg_monthly_output),
      el('div', { class: 'cst-param' }, [
        el('div', { class: 'cst-kpi-l' }, 'ФОТ с налогами / мес'),
        el('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap' }, [
          editNum(p.payroll_with_taxes, (v) => savP('payroll_with_taxes', v), { style: 'max-width:150px' }),
          el('button', { class: 'cst-icon-btn', title: 'Пересчитать из окладов Персонала', onclick: payrollFromHr }, '↺ из Персонала'),
        ]),
      ]),
      paramRow('НДС %', 'vat_rate', p.vat_rate, '%'),
      paramRow('Налог на прибыль %', 'profit_tax_rate', p.profit_tax_rate, '%'),
    ]));
    // Статьи затрат.
    const exp = BOOT.expenses || [];
    c.appendChild(expTable('Производственные (прямые)', exp.filter((e) => e.expense_group === 'production'), 'production', p));
    c.appendChild(expTable('Логистика', exp.filter((e) => e.expense_group === 'logistics'), 'logistics', p));
    c.appendChild(expTable('Накладные (косвенные) — вкл. аренду/электро', exp.filter((e) => e.expense_group === 'overhead'), 'overhead', p));
    // Каналы.
    c.appendChild(renderChannels());
  }

  function expTable(title, list, group, p) {
    const sum = list.reduce((s, x) => s + num(x.amount), 0);
    const perUnit = sum / (num(p.avg_monthly_output) || 1);
    const save = (id, field, v) => apiPost('/expense-item/' + id, { [field]: v }).then(() => { toast('Сохранено'); reboot(); }).catch((e) => toast(e.message, true));
    return el('div', { style: 'margin-top:14px' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px' }, [
        el('div', { class: 'cst-sub', style: 'font-weight:800' }, title + ' · всего ' + money(sum) + ' · на шт ' + money(perUnit)),
        el('button', { class: 'btn-ghost cst-btn', onclick: () => addExpense(group) }, '+ Статья'),
      ]),
      el('div', { class: 'cst-list' }, [
        el('div', { class: 'cst-row head cst-exp' }, [el('span', {}, 'Статья'), el('span', {}, 'Сумма / мес')]),
        ...(list.length ? list.map((e) => el('div', { class: 'cst-row cst-exp' }, [
          editText(e.expense_name, (v) => save(e.id, 'expense_name', v)),
          el('span', { class: 'cst-price-cell' }, [
            editNum(e.amount, (v) => save(e.id, 'amount', v)),
            iconBtn('🗑', 'Удалить', () => { if (confirm('Удалить статью?')) apiDel('/expense-item/' + e.id).then(reboot); }),
          ]),
        ])) : [el('div', { class: 'cst-empty' }, 'Статей нет.')]),
      ]),
    ]);
  }

  function renderChannels() {
    const ch = BOOT.channels || [];
    const pt = PTYPES || [];
    const ptOpts = [['', '— тип цены SD —'], ...pt.map((x) => [String(x.id), x.name])];
    const save = (id, field, v) => apiPost('/channel/' + id, { [field]: v }).then(() => { toast('Сохранено'); }).catch((e) => toast(e.message, true));
    return el('div', { style: 'margin-top:14px' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px' }, [
        el('div', { class: 'cst-sub', style: 'font-weight:800' }, 'Условия каналов'),
        el('button', { class: 'btn-ghost cst-btn', onclick: addChannel }, '+ Канал'),
      ]),
      el('div', { class: 'cst-list' }, [
        el('div', { class: 'cst-row head cst-ch2' }, ['Канал', 'Ретро %', 'НДС %', 'Налог %', 'Тип цены SD', ''].map((h) => el('span', {}, h))),
        ...ch.map((x) => el('div', { class: 'cst-row cst-ch2' }, [
          editText(x.channel, (v) => { save(x.id, 'channel', v).then(reboot); }),
          editNum(x.retro_rate, (v) => save(x.id, 'retro_rate', v)),
          editNum(x.vat_rate, (v) => save(x.id, 'vat_rate', v)),
          editNum(x.profit_tax_rate, (v) => save(x.id, 'profit_tax_rate', v)),
          editSel(x.sd_price_type_id == null ? '' : String(x.sd_price_type_id), ptOpts, (v) => save(x.id, 'sd_price_type_id', v || null)),
          iconBtn('🗑', 'Удалить', () => { if (confirm('Удалить канал?')) apiDel('/channel/' + x.id).then(reboot); }),
        ])),
      ]),
    ]);
  }

  async function reboot() { await boot(); }
  function payrollFromHr() {
    if (!BOOT.period) return;
    apiPost('/period/' + BOOT.period.id + '/payroll-from-hr').then((d) => { toast('ФОТ обновлён: ' + money(d.payroll_with_taxes)); reboot(); }).catch((e) => toast(e.message, true));
  }
  function addExpense(group) {
    if (!BOOT.period) return;
    const label = { production: 'производственной', logistics: 'логистической', overhead: 'накладной' }[group] || 'накладной';
    const name = prompt('Название ' + label + ' статьи:'); if (!name) return;
    apiPost('/expense', { period_id: BOOT.period.id, expense_group: group, expense_name: name, amount: 0 }).then(reboot).catch((e) => toast(e.message, true));
  }
  function addChannel() {
    const name = prompt('Название канала:'); if (!name) return;
    apiPost('/channel', { channel: name }).then(reboot).catch((e) => toast(e.message, true));
  }

  // ===== Упаковка: каталог с ценой (последний Закуп + ручная) =====
  async function renderPackaging() {
    const c = $('#cst-content');
    c.appendChild(el('div', { class: 'cst-head' }, [el('div', { class: 'cst-h2' }, 'Упаковка'),
      el('div', { class: 'cst-sub' }, 'Каталог упаковки с ценой за единицу. «Ручная цена» переопределяет Закуп и сразу учитывается в матрице и рецептурах. Пусто = берётся последний Закуп.')]));
    const box = el('div', {}); c.appendChild(box);
    box.appendChild(el('div', { class: 'cst-loading' }, 'Загружаю…'));
    let d; try { d = await api('/packaging'); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'cst-empty' }, 'Ошибка: ' + e.message)); return; }
    box.innerHTML = '';
    if (!d.items.length) { box.appendChild(el('div', { class: 'cst-empty' }, 'Упаковки в справочнике нет.')); return; }
    const save = (id, v) => apiPost('/packaging/' + id + '/price', { calc_price: v === '' ? null : v }).then(() => toast('Сохранено')).catch((e) => toast(e.message, true));
    const head = el('div', { class: 'cst-row head cst-pk' }, ['#', 'Упаковка', 'Размер', 'Ед.', 'Закуп (посл.)', 'Ручная цена'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cst-list' }, [head, ...d.items.map((m, i) => el('div', { class: 'cst-row cst-pk' }, [
      el('span', { class: 'cst-idx' }, String(i + 1)),
      el('span', { style: 'font-weight:600' }, m.name),
      el('span', { class: 'muted' }, m.size || '—'),
      el('span', {}, m.unit || 'шт'),
      el('span', { class: 'tnum muted' }, m.last_price != null ? money(m.last_price) : '—'),
      editNum(m.manual_price, (v) => save(m.id, v), { placeholder: m.last_price != null ? money(m.last_price) : '' }),
    ]))]));
  }

  // ===== История: снапшоты (фиксация) + сравнение с текущим =====
  function fixSnapshot() {
    const name = prompt('Название снимка расчёта:', (PERIOD || '') + ' · ' + new Date().toISOString().slice(0, 10));
    if (name == null) return;
    apiPost('/snapshot', { period: PERIOD, name }).then(() => { toast('Зафиксировано'); TAB = 'history'; snapSel = null; render(); }).catch((e) => toast(e.message, true));
  }
  let snapSel = null;
  async function renderHistory() {
    const c = $('#cst-content');
    c.appendChild(el('div', { class: 'cst-head' }, [el('div', { class: 'cst-h2' }, 'История'),
      el('div', { class: 'cst-sub' }, 'Зафиксированные снимки расчёта. Откройте снимок — увидите его цифры и Δ к текущему расчёту (по названию и каналу).')]));
    const box = el('div', {}); c.appendChild(box);
    box.appendChild(el('div', { class: 'cst-loading' }, 'Загружаю…'));
    let d; try { d = await api('/snapshots'); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'cst-empty' }, 'Ошибка: ' + e.message)); return; }
    box.innerHTML = '';
    if (!d.items.length) { box.appendChild(el('div', { class: 'cst-empty' }, 'Снимков нет. Нажмите «Зафиксировать» вверху, чтобы сохранить текущий расчёт.')); return; }
    const head = el('div', { class: 'cst-row head cst-snap' }, ['Снимок', 'Период', 'SKU', 'Ср. маржа', 'Создан', ''].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cst-list' }, [head, ...d.items.map((s) => el('div', {
      class: 'cst-row cst-snap' + (String(s.id) === String(snapSel) ? ' sel' : ''), onclick: () => { snapSel = s.id; renderHistory(); },
    }, [
      el('span', { style: 'font-weight:700' }, s.snapshot_name),
      el('span', { class: 'muted' }, s.period || '—'),
      el('span', { class: 'tnum' }, String(s.n || 0)),
      el('span', { class: 'tnum' }, s.avg_margin == null ? '—' : (Math.round(s.avg_margin * 10) / 10) + '%'),
      el('span', { class: 'muted' }, (s.created_at || '').slice(0, 10)),
      iconBtn('🗑', 'Удалить снимок', (e) => { e.stopPropagation(); if (confirm('Удалить снимок «' + s.snapshot_name + '»?')) apiDel('/snapshot/' + s.id).then(() => { if (String(snapSel) === String(s.id)) snapSel = null; renderHistory(); }); }),
    ]))]));
    if (snapSel == null) snapSel = d.items[0].id;
    const detail = el('div', { id: 'cst-snap-detail', style: 'margin-top:18px' }); box.appendChild(detail);
    loadSnapshot(detail, snapSel);
  }
  async function loadSnapshot(box, id) {
    box.appendChild(el('div', { class: 'cst-loading' }, 'Снимок…'));
    let d; try { d = await api('/snapshot/' + id); } catch (e) { box.innerHTML = ''; return; }
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'cst-sub', style: 'font-weight:800;margin-bottom:6px' }, 'Снимок «' + (d.meta ? d.meta.snapshot_name : '') + '» · Δ — изменение к текущему расчёту'));
    const cols = ['SKU', 'Канал', 'С/с (снимок)', 'ЧП (снимок)', 'Маржа (снимок)', 'С/с сейчас', 'Маржа сейчас', 'Δ маржи'];
    const table = el('table', { class: 'cst-mx' });
    const thead = el('thead', {}, el('tr', {}, cols.map((h, i) => el('th', { class: i < 2 ? 'lft' : '' }, h))));
    const tb = el('tbody', {}, d.rows.map((r) => {
      const dMargin = (r.live_margin != null && r.net_margin != null) ? num(r.live_margin) - num(r.net_margin) : null;
      const dCls = dMargin == null ? 'muted' : dMargin < -0.05 ? 'mx-bad' : dMargin > 0.05 ? 'mx-good' : 'muted';
      return el('tr', {}, [
        el('td', { class: 'lft', style: 'font-weight:700' }, r.sku_name),
        el('td', { class: 'lft muted' }, r.channel || '—'),
        el('td', { class: 'tnum' }, money(r.cost_with_waste)),
        el('td', { class: 'tnum' }, r.net_profit == null ? '—' : money(r.net_profit)),
        el('td', { class: 'tnum' }, r.net_margin == null ? '—' : (Math.round(r.net_margin * 10) / 10) + '%'),
        el('td', { class: 'tnum' }, r.live_cost == null ? '—' : money(r.live_cost)),
        el('td', { class: 'tnum' }, r.live_margin == null ? '—' : (Math.round(r.live_margin * 10) / 10) + '%'),
        el('td', { class: 'tnum ' + dCls }, dMargin == null ? '—' : (dMargin > 0 ? '+' : '') + (Math.round(dMargin * 10) / 10) + ' пп'),
      ]);
    }));
    table.appendChild(thead); table.appendChild(tb);
    box.appendChild(el('div', { class: 'cst-mx-wrap' }, table));
  }

  function kpi(label, value) { return el('div', { class: 'cst-kpi' }, [el('div', { class: 'cst-kpi-l' }, label), el('div', { class: 'cst-kpi-v' }, String(value))]); }
  const statusLabel = (s) => ({ draft: 'Черновик', active: 'Активна', archived: 'Архив' }[s] || s);

  boot();
})();
