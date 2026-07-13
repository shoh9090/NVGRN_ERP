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
  async function api(path) { const r = await fetch('/costing/api' + path); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Ошибка'); return d; }
  function toast(msg, err) { const t = el('div', { class: 'cst-toast' + (err ? ' err' : '') }, msg); document.body.appendChild(t); setTimeout(() => t.classList.add('show'), 10); setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000); }

  let BOOT = null;
  let TAB = 'matrix';
  let PERIOD = '';
  let recSel = null;

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
        el('button', { class: 'btn-ghost cst-btn', onclick: () => toast('Пересчёт будет на Этапе 3') }, 'Пересчитать'),
        el('button', { class: 'btn-ghost cst-btn', onclick: () => toast('Фиксация — Этап 5') }, 'Зафиксировать'),
        el('button', { class: 'btn-ghost cst-btn', onclick: () => toast('Экспорт — Этап 5') }, 'Экспорт Excel'),
      ]),
    ]));
    const tab = (id, label) => el('button', { class: 'cst-tab' + (TAB === id ? ' on' : ''), onclick: () => { TAB = id; render(); } }, label);
    main.appendChild(el('div', { class: 'cst-tabs' }, [
      tab('matrix', 'Матрица себестоимости'),
      tab('recipes', 'Рецептуры'),
      tab('packaging', 'Упаковка'),
      tab('settings', 'Настройки расчёта'),
    ]));
    main.appendChild(el('div', { id: 'cst-content' }));
  }

  function render() {
    shell();
    if (TAB === 'recipes') return renderRecipes();
    if (TAB === 'settings') return renderSettings();
    if (TAB === 'packaging') return renderSoon('Упаковка', 'Спецификации упаковки в виде таблицы — Этап 4.');
    return renderMatrix();
  }

  function renderSoon(title, text) {
    $('#cst-content').appendChild(el('div', { class: 'cst-soon' }, [
      el('div', { class: 'cst-soon-h' }, title), el('div', { class: 'cst-soon-t' }, text),
    ]));
  }

  function renderMatrix() {
    const c = $('#cst-content');
    c.appendChild(el('div', { class: 'cst-head' }, [el('div', { class: 'cst-h2' }, 'Матрица себестоимости'),
      el('div', { class: 'cst-sub' }, 'Одна строка = один SKU. Расчёт по формулам, цвет маржи, бейджи-источники — Этап 3. Каркас и данные готовы.')]));
    c.appendChild(el('div', { class: 'cst-kpis' }, [
      kpi('Рецептур перенесено', BOOT.recipeCount || 0),
      kpi('Период', PERIOD || '—'),
      kpi('Каналов', (BOOT.channels || []).length),
      kpi('Средний выпуск, шт', BOOT.period ? money(BOOT.period.avg_monthly_output) : '—'),
    ]));
    renderSoon('Матрица — на подходе', 'Здесь появится Excel-таблица: SKU × (сырьё · упаковка · ФОТ · производство · накладные · с/с · с отходом · цена SD · ретро · НДС · прибыль · налог · ЧП · маржа). Формулы уже выверены по Excel.');
  }

  // ===== Рецептуры: список + компоненты выбранной =====
  async function renderRecipes() {
    const c = $('#cst-content');
    c.appendChild(el('div', { class: 'cst-head' }, [el('div', { class: 'cst-h2' }, 'Рецептуры'),
      el('div', { class: 'cst-sub' }, 'Сверху — рецептуры (SKU), снизу — компоненты выбранной. Inline-редактирование и версии — Этап 2. Данные перенесены из текущего модуля.')]));
    const box = el('div', { id: 'cst-rec-box' }); c.appendChild(box);
    box.appendChild(el('div', { class: 'cst-loading' }, 'Загружаю…'));
    let d; try { d = await api('/recipes'); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'cst-empty' }, 'Ошибка: ' + e.message)); return; }
    box.innerHTML = '';
    if (!d.items.length) { box.appendChild(el('div', { class: 'cst-empty' }, 'Рецептур нет.')); return; }
    if (recSel == null) recSel = d.items[0].id;
    const head = el('div', { class: 'cst-row head cst-rec' }, ['#', 'SKU', 'Канал / группа', 'Граммаж', 'Отход %', 'Версия', 'Статус', 'Компонентов'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cst-list' }, [head, ...d.items.map((r, i) => el('div', { class: 'cst-row cst-rec' + (String(r.id) === String(recSel) ? ' sel' : '') + (r.status !== 'active' ? ' dim' : ''), onclick: () => { recSel = r.id; renderRecipes(); } }, [
      el('span', { class: 'cst-idx' }, String(i + 1)),
      el('span', { style: 'font-weight:700' }, r.finished_good_name),
      el('span', { class: 'muted' }, (r.channel || r.group_name || '—')),
      el('span', { class: 'tnum' }, num(r.gram_weight) ? money(r.gram_weight) : '—'),
      el('span', { class: 'tnum' }, num(r.sku_waste_rate) ? r.sku_waste_rate + '%' : '—'),
      el('span', { class: 'muted' }, r.version || 'v1'),
      el('span', {}, el('span', { class: 'cst-st cst-st-' + r.status }, statusLabel(r.status))),
      el('span', { class: 'tnum' }, String(r.comp_count || 0)),
    ]))]));
    // Компоненты выбранной рецептуры.
    const compBox = el('div', { id: 'cst-comp-box', style: 'margin-top:16px' }); box.appendChild(compBox);
    loadComponents(compBox, recSel);
  }
  async function loadComponents(box, recipeId) {
    box.appendChild(el('div', { class: 'cst-loading' }, 'Компоненты…'));
    let d; try { d = await api('/recipe/' + recipeId + '/components'); } catch (e) { box.innerHTML = ''; return; }
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'cst-sub', style: 'margin-bottom:6px;font-weight:800' }, 'Компоненты выбранной рецептуры'));
    if (!d.items.length) { box.appendChild(el('div', { class: 'cst-empty' }, 'Компонентов нет.')); return; }
    const head = el('div', { class: 'cst-row head cst-comp' }, ['#', 'Тип', 'Компонент', 'Кол-во', 'Ед.', 'Доля %', 'Отход %', 'Цена (ручн.)'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cst-list' }, [head, ...d.items.map((c, i) => el('div', { class: 'cst-row cst-comp' }, [
      el('span', { class: 'cst-idx' }, String(i + 1)),
      el('span', {}, c.component_type === 'packaging' ? 'Упаковка' : c.component_type === 'other' ? 'Прочее' : 'Сырьё'),
      el('span', { style: 'font-weight:600' }, c.component_name || ('#' + c.component_id)),
      el('span', { class: 'tnum' }, money(c.qty)),
      el('span', {}, c.unit || ''),
      el('span', { class: 'tnum muted' }, num(c.share_percent) ? c.share_percent + '%' : '—'),
      el('span', { class: 'tnum muted' }, num(c.waste_rate) ? c.waste_rate + '%' : '—'),
      el('span', { class: 'tnum muted' }, c.manual_price != null ? money(c.manual_price) : '—'),
    ]))]));
  }

  // ===== Настройки расчёта: период + статьи затрат + каналы =====
  function renderSettings() {
    const c = $('#cst-content');
    c.appendChild(el('div', { class: 'cst-head' }, [el('div', { class: 'cst-h2' }, 'Настройки расчёта'),
      el('div', { class: 'cst-sub' }, 'Параметры периода, статьи производственных и накладных затрат, условия каналов. Inline-правка — Этап 4. Данные перенесены.')]));
    const p = BOOT.period;
    if (!p) { c.appendChild(el('div', { class: 'cst-empty' }, 'Нет периода.')); return; }
    c.appendChild(el('div', { class: 'cst-kpis' }, [
      kpi('Период', p.period),
      kpi('Средний выпуск, шт', money(p.avg_monthly_output)),
      kpi('ФОТ с налогами / мес', money(p.payroll_with_taxes)),
      kpi('НДС / Налог', p.vat_rate + '% / ' + p.profit_tax_rate + '%'),
    ]));
    const exp = BOOT.expenses || [];
    const grp = (g) => exp.filter((e) => e.expense_group === g);
    const expTable = (title, list) => {
      const sum = list.reduce((s, x) => s + num(x.amount), 0);
      return el('div', { style: 'margin-top:12px' }, [
        el('div', { class: 'cst-sub', style: 'font-weight:800' }, title + ' · всего ' + money(sum) + ' · на шт ' + money(sum / (num(p.avg_monthly_output) || 1))),
        el('div', { class: 'cst-list' }, [
          el('div', { class: 'cst-row head cst-exp' }, ['Статья', 'Сумма / мес'].map((h) => el('span', {}, h))),
          ...list.map((e) => el('div', { class: 'cst-row cst-exp' }, [el('span', {}, e.expense_name), el('span', { class: 'tnum' }, money(e.amount))])),
        ]),
      ]);
    };
    c.appendChild(expTable('Производственные (прямые)', grp('production')));
    c.appendChild(expTable('Накладные (косвенные) — вкл. аренду/электро', grp('overhead')));
    // Каналы.
    const ch = BOOT.channels || [];
    c.appendChild(el('div', { style: 'margin-top:12px' }, [
      el('div', { class: 'cst-sub', style: 'font-weight:800' }, 'Условия каналов'),
      el('div', { class: 'cst-list' }, [
        el('div', { class: 'cst-row head cst-ch' }, ['Канал', 'Ретро %', 'НДС %', 'Налог %'].map((h) => el('span', {}, h))),
        ...ch.map((x) => el('div', { class: 'cst-row cst-ch' }, [el('span', { style: 'font-weight:700' }, x.channel), el('span', { class: 'tnum' }, x.retro_rate + '%'), el('span', { class: 'tnum' }, x.vat_rate + '%'), el('span', { class: 'tnum' }, x.profit_tax_rate + '%')])),
      ]),
    ]));
  }

  function kpi(label, value) { return el('div', { class: 'cst-kpi' }, [el('div', { class: 'cst-kpi-l' }, label), el('div', { class: 'cst-kpi-v' }, String(value))]); }
  const statusLabel = (s) => ({ draft: 'Черновик', active: 'Активна', archived: 'Архив' }[s] || s);

  boot();
})();
