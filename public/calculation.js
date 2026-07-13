// calculation.js — плитка «Калькуляция», вкладка «Справочники» (перезапуск по ТЗ).
// Excel-like таблицы, inline-редактирование, без модалок.
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
  const money2 = (v) => (v == null || v === '' ? '—' : (Number(v) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
  async function api(path, opts) { const r = await fetch('/calculation/api' + path, opts); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Ошибка'); return d; }
  const apiPost = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const apiDel = (path) => api(path, { method: 'DELETE' });
  function toast(msg, err) { const t = el('div', { class: 'calc-toast' + (err ? ' err' : '') }, msg); document.body.appendChild(t); setTimeout(() => t.classList.add('show'), 10); setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600); }

  // Inline-ячейки.
  function editText(val, onSave, extra) { const inp = el('input', Object.assign({ class: 'calc-cell', value: val == null ? '' : val }, extra || {})); inp.addEventListener('change', () => onSave(inp.value)); return inp; }
  function editNum(val, onSave, extra) { return editText(val, onSave, Object.assign({ type: 'number', step: 'any', class: 'calc-cell tnum' }, extra || {})); }
  function editSel(val, options, onSave) { const s = el('select', { class: 'calc-cell' }, options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return el('option', { value: v, selected: String(v) === String(val) || null }, l); })); s.addEventListener('change', () => onSave(s.value)); return s; }
  const iconBtn = (glyph, title, onclick) => el('button', { class: 'calc-icon-btn', title, onclick }, glyph);

  const COST_BLOCKS = ['ФОТ', 'Производство', 'Логистика', 'Общепроизводственные', 'Административные', 'Коммерческие', 'Прочее'];
  const SOURCES = [['manual', 'Ручной ввод'], ['Персонал', 'Персонал'], ['Финансы', 'Финансы'], ['Закуп', 'Закуп'], ['Логистика', 'Логистика'], ['Другое', 'Другое']];
  const TYPE_OPTS = [['fixed', 'Постоянная'], ['variable', 'Переменная']];
  const YESNO = [['true', 'Да'], ['false', 'Нет']];
  const PERIOD_STATUS = [['active', 'Активный'], ['draft', 'Черновик'], ['archived', 'Архив']];
  const statusLabel = (s) => ({ active: 'Активный', draft: 'Черновик', archived: 'Архив' }[s] || s);

  let BOOT = null;
  let PERIOD = '';
  const expFilter = { q: '', block: '' };

  async function boot() {
    try { BOOT = await api('/bootstrap' + (PERIOD ? '?period=' + encodeURIComponent(PERIOD) : '')); }
    catch (e) { $('#calc-main').innerHTML = '<div class="calc-empty">Ошибка загрузки: ' + e.message + '</div>'; return; }
    if (BOOT.period) PERIOD = BOOT.period.period;
    render();
  }
  const reboot = () => boot();

  function render() {
    const main = $('#calc-main'); main.innerHTML = '';
    main.appendChild(el('div', { class: 'calc-topbar' }, [
      el('div', { class: 'calc-title' }, 'Калькуляция'),
      el('div', { class: 'calc-sub' }, 'Справочники — фундамент расчёта. Рецептуры, упаковка и матрица появятся позже, на этих данных.'),
    ]));
    // Вкладки: активна только «Справочники», остальные — «позже».
    main.appendChild(el('div', { class: 'calc-tabs' }, [
      el('button', { class: 'calc-tab on' }, 'Справочники'),
      el('button', { class: 'calc-tab disabled', disabled: true, title: 'Позже' }, 'Рецептуры · позже'),
      el('button', { class: 'calc-tab disabled', disabled: true, title: 'Позже' }, 'Упаковка · позже'),
      el('button', { class: 'calc-tab disabled', disabled: true, title: 'Позже' }, 'Матрица · позже'),
      el('button', { class: 'calc-tab disabled', disabled: true, title: 'Позже' }, 'История · позже'),
    ]));
    const c = el('div', { id: 'calc-content' }); main.appendChild(c);
    renderPeriods(c);
    if (!BOOT.period) { c.appendChild(el('div', { class: 'calc-empty' }, 'Создайте период, чтобы задать статьи затрат, ставки и каналы.')); return; }
    renderExpenses(c);
    renderRates(c);
    renderChannels(c);
  }

  function section(title, subtitle, addBtn) {
    return el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap;margin:20px 0 8px' }, [
      el('div', {}, [el('div', { class: 'calc-h2' }, title), subtitle ? el('div', { class: 'calc-sub' }, subtitle) : null]),
      addBtn || null,
    ]);
  }

  // ===== Периоды =====
  function renderPeriods(c) {
    c.appendChild(section('Периоды калькуляции', 'Активным может быть только один период — он участвует в расчёте.',
      el('button', { class: 'btn-ghost calc-btn', onclick: addPeriod }, '+ Период')));
    const periods = BOOT.periods || [];
    const save = (id, f, v) => apiPost('/periods/' + id, { [f]: v }).then(() => { toast('Сохранено'); reboot(); }).catch((e) => toast(e.message, true));
    const head = el('div', { class: 'calc-row head calc-per' }, ['Период', 'Ср. выпуск, шт', 'НДС %', 'Налог %', 'Статус', 'Комментарий', ''].map((h) => el('span', {}, h)));
    const rows = periods.length ? periods.map((p) => el('div', { class: 'calc-row calc-per' + (p.period === PERIOD ? ' sel' : '') }, [
      el('span', { class: 'calc-per-name', onclick: () => { PERIOD = p.period; boot(); }, title: 'Выбрать период' }, [
        el('b', {}, p.period), p.status === 'active' ? el('span', { class: 'calc-dot' }, '') : null,
      ]),
      editNum(p.avg_monthly_output, (v) => save(p.id, 'avg_monthly_output', v)),
      editNum(p.vat_rate, (v) => save(p.id, 'vat_rate', v)),
      editNum(p.profit_tax_rate, (v) => save(p.id, 'profit_tax_rate', v)),
      editSel(p.status, PERIOD_STATUS, (v) => save(p.id, 'status', v)),
      editText(p.comment, (v) => apiPost('/periods/' + p.id, { comment: v }).then(() => toast('Сохранено')).catch((e) => toast(e.message, true))),
      iconBtn('🗑', 'Удалить период (со всеми статьями/ставками/каналами)', () => { if (confirm('Удалить период ' + p.period + '? Удалятся его статьи, ставки и каналы.')) apiDel('/periods/' + p.id).then(() => { if (PERIOD === p.period) PERIOD = ''; reboot(); }); }),
    ])) : [el('div', { class: 'calc-empty' }, 'Периодов нет. Нажмите «+ Период».')];
    c.appendChild(el('div', { class: 'calc-list' }, [head, ...rows]));
  }

  function addPeriod() {
    const period = prompt('Новый период (формат ГГГГ-ММ), например 2026-08:', '');
    if (!period) return;
    apiPost('/periods', { period: period.trim(), avg_monthly_output: 0 }).then(() => { PERIOD = period.trim(); toast('Создан'); reboot(); }).catch((e) => toast(e.message, true));
  }

  // ===== Статьи затрат =====
  function renderExpenses(c) {
    const pid = BOOT.period.id;
    const output = num(BOOT.period.avg_monthly_output);
    c.appendChild(section('Статьи затрат — период ' + PERIOD, 'Сумма/месяц ÷ среднемесячный выпуск = на 1 изделие. Считаются только строки с «Участвует = Да».',
      el('button', { class: 'btn-ghost calc-btn', onclick: () => addExpense(pid) }, '+ Статья')));
    // Фильтры.
    const blocks = Array.from(new Set((BOOT.expenses || []).map((e) => e.cost_block)));
    c.appendChild(el('div', { class: 'calc-filters' }, [
      el('input', { class: 'calc-cell', placeholder: 'Поиск статьи…', value: expFilter.q, style: 'min-width:170px', oninput: (e) => { expFilter.q = e.target.value; drawExpenses(); } }),
      editSel(expFilter.block, [['', 'Все блоки'], ...blocks.map((b) => [b, b])], (v) => { expFilter.block = v; drawExpenses(); }),
    ]));
    c.appendChild(el('div', { id: 'calc-exp-body' }));
    drawExpenses();

    function drawExpenses() {
      const body = $('#calc-exp-body'); if (!body) return; body.innerHTML = '';
      let list = (BOOT.expenses || []);
      if (expFilter.block) list = list.filter((e) => e.cost_block === expFilter.block);
      if (expFilter.q) list = list.filter((e) => (e.expense_name || '').toLowerCase().includes(expFilter.q.toLowerCase()));
      const save = (id, f, v) => apiPost('/expenses/' + id, { [f]: v }).then(() => { toast('Сохранено'); reboot(); }).catch((er) => toast(er.message, true));
      const perUnit = (amt, include) => {
        if (!include) return el('span', { class: 'muted' }, '—');
        if (!output) return el('span', { class: 'calc-warn' }, 'Нет выпуска');
        return el('span', {}, money2(num(amt) / output));
      };
      const head = el('div', { class: 'calc-row head calc-exp' }, ['Блок', 'Статья', 'Тип', 'Сумма / мес', 'На 1 изд.', 'Участвует', 'Источник', 'Комментарий', ''].map((h) => el('span', {}, h)));
      const rows = list.length ? list.map((e) => el('div', { class: 'calc-row calc-exp' + (e.include_in_calc ? '' : ' dim') }, [
        editSel(e.cost_block, COST_BLOCKS, (v) => save(e.id, 'cost_block', v)),
        editText(e.expense_name, (v) => save(e.id, 'expense_name', v)),
        editSel(e.expense_type, TYPE_OPTS, (v) => save(e.id, 'expense_type', v)),
        editNum(e.amount_month, (v) => save(e.id, 'amount_month', v)),
        el('span', { class: 'tnum calc-ro' }, perUnit(e.amount_month, e.include_in_calc)),
        editSel(String(e.include_in_calc), YESNO, (v) => save(e.id, 'include_in_calc', v)),
        editSel(e.source, SOURCES, (v) => save(e.id, 'source', v)),
        editText(e.comment, (v) => apiPost('/expenses/' + e.id, { comment: v }).catch((er) => toast(er.message, true))),
        iconBtn('🗑', 'Удалить', () => { if (confirm('Удалить статью?')) apiDel('/expenses/' + e.id).then(reboot); }),
      ])) : [el('div', { class: 'calc-empty' }, 'Статей нет. Нажмите «+ Статья».')];
      // Итоги по включённым.
      const totMonth = list.filter((e) => e.include_in_calc).reduce((s, e) => s + num(e.amount_month), 0);
      const foot = el('div', { class: 'calc-row calc-exp foot' }, [
        el('span', { class: 'strong' }, 'Итого (участвуют)'), el('span', {}, ''), el('span', {}, ''),
        el('span', { class: 'tnum strong' }, money(totMonth)),
        el('span', { class: 'tnum strong' }, output ? money2(totMonth / output) : 'Нет выпуска'),
        el('span', {}, ''), el('span', {}, ''), el('span', {}, ''), el('span', {}, ''),
      ]);
      body.appendChild(el('div', { class: 'calc-list' }, [head, ...rows, list.length ? foot : null]));
    }
  }

  function addExpense(pid) {
    apiPost('/expenses', { period_id: pid, cost_block: 'Прочее', expense_name: 'Новая статья', amount_month: 0 }).then(reboot).catch((e) => toast(e.message, true));
  }

  // ===== Ставки =====
  function renderRates(c) {
    const pid = BOOT.period.id;
    c.appendChild(section('Ставки', 'НДС, налог на прибыль, ретро сетей.',
      el('button', { class: 'btn-ghost calc-btn', onclick: () => apiPost('/rates', { period_id: pid, name: 'Новая ставка', rate_percent: 0 }).then(reboot) }, '+ Ставка')));
    const save = (id, f, v) => apiPost('/rates/' + id, { [f]: v }).then(() => toast('Сохранено')).catch((e) => toast(e.message, true));
    const head = el('div', { class: 'calc-row head calc-rate' }, ['Название', 'Значение %', 'Применяется к', 'Активно', 'Комментарий', ''].map((h) => el('span', {}, h)));
    const rows = (BOOT.rates || []).length ? BOOT.rates.map((r) => el('div', { class: 'calc-row calc-rate' + (r.is_active ? '' : ' dim') }, [
      editText(r.name, (v) => save(r.id, 'name', v)),
      editNum(r.rate_percent, (v) => save(r.id, 'rate_percent', v)),
      editText(r.applies_to, (v) => save(r.id, 'applies_to', v)),
      editSel(String(r.is_active), YESNO, (v) => save(r.id, 'is_active', v)),
      editText(r.comment, (v) => save(r.id, 'comment', v)),
      iconBtn('🗑', 'Удалить', () => { if (confirm('Удалить ставку?')) apiDel('/rates/' + r.id).then(reboot); }),
    ])) : [el('div', { class: 'calc-empty' }, 'Ставок нет.')];
    c.appendChild(el('div', { class: 'calc-list' }, [head, ...rows]));
  }

  // ===== Каналы =====
  function renderChannels(c) {
    const pid = BOOT.period.id;
    c.appendChild(section('Условия каналов', 'Канал влияет на ретро, НДС и подтягивание цены из SalesDoctor.',
      el('button', { class: 'btn-ghost calc-btn', onclick: () => apiPost('/channels', { period_id: pid, channel_name: 'Новый канал' }).then(reboot) }, '+ Канал')));
    const save = (id, f, v) => apiPost('/channels/' + id, { [f]: v }).then(() => toast('Сохранено')).catch((e) => toast(e.message, true));
    const head = el('div', { class: 'calc-row head calc-ch' }, ['Канал', 'Ретро %', 'НДС %', 'Цена из SD', 'Активно', 'Комментарий', ''].map((h) => el('span', {}, h)));
    const rows = (BOOT.channels || []).length ? BOOT.channels.map((x) => el('div', { class: 'calc-row calc-ch' + (x.is_active ? '' : ' dim') }, [
      editText(x.channel_name, (v) => save(x.id, 'channel_name', v)),
      editNum(x.retro_rate, (v) => save(x.id, 'retro_rate', v)),
      editNum(x.vat_rate, (v) => save(x.id, 'vat_rate', v)),
      editSel(String(x.price_from_sd), YESNO, (v) => save(x.id, 'price_from_sd', v)),
      editSel(String(x.is_active), YESNO, (v) => save(x.id, 'is_active', v)),
      editText(x.comment, (v) => save(x.id, 'comment', v)),
      iconBtn('🗑', 'Удалить', () => { if (confirm('Удалить канал?')) apiDel('/channels/' + x.id).then(reboot); }),
    ])) : [el('div', { class: 'calc-empty' }, 'Каналов нет.')];
    c.appendChild(el('div', { class: 'calc-list' }, [head, ...rows]));
  }

  boot();
})();
