// hr.js — модуль «Персонал» (SPA). Этап 1: сотрудники + отделы.
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
  // Компактно для сводок: 426.9 млн / 320 тыс — крупные суммы читаются легче.
  const moneyShort = (v) => {
    const n = Math.round(Number(v) || 0);
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' млн';
    if (Math.abs(n) >= 1e4) return Math.round(n / 1e3) + ' тыс';
    return n.toLocaleString('ru-RU');
  };
  const ruDate = (d) => d ? String(d).slice(0, 10).split('-').reverse().join('.') : '';
  // Денежное поле с разделителями разрядов прямо при вводе (15 000 000).
  const fmtDigits = (s) => { const neg = /^-/.test(String(s).replace(/[^\d-]/g, '')); const d = String(s).replace(/[^\d]/g, ''); return d ? (neg ? '-' : '') + Number(d).toLocaleString('ru-RU') : ''; };
  const mval = (i) => { const d = String(i.value || '').replace(/[^\d-]/g, ''); return d === '' || d === '-' ? '' : d; };
  function minp(val, attrs) {
    const i = finp((val == null || val === '') ? '' : Number(val).toLocaleString('ru-RU'), Object.assign({ inputmode: 'numeric', placeholder: '0' }, attrs || {}));
    i.addEventListener('input', () => { i.value = fmtDigits(i.value); });
    return i;
  }

  async function api(path) { const r = await fetch('/hr/api' + path); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Ошибка'); return d; }
  async function post(path, body) { const r = await fetch('/hr/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Ошибка'); return d; }
  function toast(msg, err) { const t = el('div', { class: 'hr-toast' + (err ? ' err' : '') }, msg); document.body.appendChild(t); setTimeout(() => t.classList.add('show'), 10); setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200); }
  function modal(title, body, acts) {
    const root = $('#hr-modal-root');
    const ov = el('div', { class: 'hrm-overlay', onclick: (e) => { if (e.target === ov) close(); } });
    const panel = el('div', { class: 'hrm-panel' }, [
      el('div', { class: 'hrm-head' }, [el('h3', {}, title), el('button', { class: 'hrm-x', onclick: () => close() }, '✕')]),
      el('div', { class: 'hrm-body' }, body),
      acts && acts.length ? el('div', { class: 'hrm-acts' }, acts) : null,
    ]);
    ov.appendChild(panel); root.appendChild(ov);
    function close() { ov.remove(); }
    ov._close = close; return { close };
  }
  const closeModal = () => { const r = $('#hr-modal-root'); if (r.lastChild && r.lastChild._close) r.lastChild._close(); };

  const frow = (label, ctrl) => el('label', { class: 'hrf-row' }, [el('span', {}, label), ctrl]);
  const finp = (val, attrs) => el('input', Object.assign({ class: 'hrf-inp', value: val == null ? '' : String(val) }, attrs || {}));
  const fsel = (opts, val) => el('select', { class: 'hrf-inp' }, opts.map((o) => el('option', { value: o.v, selected: String(o.v) === String(val) || null }, o.t)));

  let DICTS = { departments: [], schedules: [], statuses: [] };
  let TAB = 'dashboard';
  const empFilter = { department: '', schedule: '', status: 'active', q: '' };
  let empSel = new Set();
  const isAdmin = !!(window.HUB_USER && window.HUB_USER.isAdmin);

  const SCHED_NAME = {};
  const STATUS_NAME = { active: 'Активен', fired: 'Уволен', archived: 'Архив' };

  async function boot() {
    try { DICTS = await api('/dicts'); } catch (e) { $('#hr-main').innerHTML = '<div class="hr-empty">Ошибка загрузки: ' + e.message + '</div>'; return; }
    (DICTS.schedules || []).forEach((s) => { SCHED_NAME[s.code] = s.name; });
    render();
  }
  async function reloadDicts() { try { DICTS = await api('/dicts'); (DICTS.schedules || []).forEach((s) => { SCHED_NAME[s.code] = s.name; }); } catch (e) {} }

  function shell() {
    const main = $('#hr-main'); main.innerHTML = '';
    const tab = (id, label) => el('button', { class: 'hr-tab' + (TAB === id ? ' on' : ''), onclick: () => { TAB = id; render(); } }, label);
    main.appendChild(el('div', { class: 'hr-tabs' }, [
      tab('dashboard', '📊 Дашборд'),
      tab('employees', '👥 Сотрудники'),
      tab('salary', '💵 Зарплата'),
      tab('massops', '⚡ Массовые операции'),
      tab('payouts', '💳 Выплаты'),
      tab('departments', '🏢 Отделы'),
    ]));
    main.appendChild(el('div', { id: 'hr-content' }));
  }
  function render() {
    shell();
    if (TAB === 'dashboard') return renderDashboard();
    if (TAB === 'employees') return renderEmployees();
    if (TAB === 'salary') return renderSalary();
    if (TAB === 'massops') return renderMassOps();
    if (TAB === 'timesheet') return renderTimesheet();
    if (TAB === 'departments') return renderDepartments();
    return renderSoon();
  }

  // ================= ДАШБОРД =================
  const HR_COLORS = ['#163a28', '#8cc63f', '#2e7d32', '#b25b00', '#5b3da8', '#c0392b', '#0d7d8c', '#c77800', '#7c8579', '#3f6a16'];
  const dashState = { period: '' };
  function donut(items, cap, onClick) {
    const total = items.reduce((s, i) => s + i.value, 0);
    if (!total) return el('div', { class: 'hr-sub' }, 'Нет данных.');
    const size = 200, r = size / 2 - 18, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r; let off = 0;
    const segs = items.map((it) => { const len = it.value / total * C; const pct = Math.round(it.value / total * 100); const s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="28" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${it.label}: ${money(it.value)} · ${pct}%</title></circle>`; off += len; return s; }).join('');
    const wrap = el('div', { class: 'hr-donut-wrap' }); wrap.innerHTML = `<svg viewBox="0 0 ${size} ${size}" class="hr-donut"><g>${segs}</g><text x="${cx}" y="${cy - 2}" text-anchor="middle" class="hr-donut-cap">${cap || ''}</text><text x="${cx}" y="${cy + 18}" text-anchor="middle" class="hr-donut-val">${moneyShort(total)}</text></svg>`;
    const legend = el('div', { class: 'hr-legend' }, items.map((it) => el('div', { class: 'hr-legend-row' + (onClick ? ' hr-legend-click' : ''), title: onClick ? 'Открыть: ' + it.label : '', onclick: onClick ? () => onClick(it) : null }, [el('span', { class: 'hr-legend-dot', style: 'background:' + it.color }), el('span', {}, it.label + (onClick ? ' →' : '')), el('span', { class: 'hr-legend-v' }, money(it.value) + ' · ' + Math.round(it.value / total * 100) + '%')])));
    return el('div', { class: 'hr-chart-card' }, [wrap, legend]);
  }
  function drillDept(name) { salState.period = dashState.period; salState.department = String((DICTS.departments.find((dd) => dd.name === name) || {}).id || ''); salState.status = ''; salState.q = ''; TAB = 'salary'; render(); }
  async function renderDashboard() {
    const c = $('#hr-content');
    if (!dashState.period) dashState.period = curMonth();
    c.appendChild(el('div', { class: 'hr-head' }, [el('div', {}, [el('div', { class: 'hr-h2' }, 'Дашборд — ' + monthLabel(dashState.period)), el('div', { class: 'hr-sub' }, 'ФОТ и персонал за месяц.')])]));
    const mInp = el('input', { type: 'month', class: 'hrf-inp hr-filt', value: dashState.period, onchange: (e) => { dashState.period = e.target.value || curMonth(); render(); } });
    c.appendChild(el('div', { class: 'hr-filters' }, [el('span', { class: 'hr-flab' }, 'Месяц:'), mInp]));
    const box = el('div', {}); c.appendChild(box);
    box.innerHTML = '<div class="hr-loading">Считаю…</div>';
    let d; try { d = await api('/dashboard?period=' + dashState.period); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
    box.innerHTML = '';
    const t = d.totals;
    box.appendChild(el('div', { class: 'hr-kpis hr-kpis-4' }, [
      kpi('ФОТ (начислено)', moneyShort(t.accrued), 'green'), kpi('К выплате', moneyShort(t.to_pay), 'green'),
      kpi('Выплачено', moneyShort(t.paid), 'ink'), kpi('Сотрудников', t.count, 'ink'),
    ]));
    if (!d.byDept.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Нет данных за месяц.')); return; }
    const items = d.byDept.filter((x) => x.accrued > 0).map((x, i) => ({ label: x.name, value: x.accrued, color: HR_COLORS[i % HR_COLORS.length] }));
    box.appendChild(el('div', { class: 'hr-h2', style: 'font-size:18px;margin:16px 0 4px' }, 'ФОТ по отделам'));
    if (items.length) box.appendChild(donut(items, 'ФОТ', (it) => drillDept(it.label)));
    // Таблица по отделам
    box.appendChild(el('div', { class: 'hr-h2', style: 'font-size:18px;margin:18px 0 4px' }, 'Отделы'));
    const head = el('div', { class: 'hr-row head hr-dash' }, ['#', 'Отдел', 'Человек', 'ФОТ', 'К выплате', 'Выплачено'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'hr-list' }, [head, ...d.byDept.map((x, i) => el('div', { class: 'hr-row hr-dash', title: 'Открыть зарплату отдела', onclick: () => drillDept(x.name) }, [
      el('span', { class: 'hr-idx' }, String(i + 1)),
      el('span', { style: 'font-weight:700' }, x.name + ' →'),
      el('span', { class: 'tnum' }, x.count),
      el('span', { class: 'tnum' }, money(x.accrued)),
      el('span', { class: 'tnum', style: 'color:#2e7d32;font-weight:700' }, money(x.to_pay)),
      el('span', { class: 'tnum muted' }, money(x.paid)),
    ]))]));
  }
  function renderSoon() {
    $('#hr-content').appendChild(el('div', { class: 'hr-soon' }, [
      el('div', { style: 'font-size:40px' }, '🔜'),
      el('div', { class: 'hr-soon-h' }, 'Скоро'),
      el('div', { class: 'hr-soon-t' }, 'Этот раздел появится на следующем этапе. Сейчас готов фундамент — сотрудники и отделы.'),
    ]));
  }

  // ================= СОТРУДНИКИ =================
  async function renderEmployees() {
    const c = $('#hr-content');
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Сотрудники'), el('div', { class: 'hr-sub' }, 'Единый справочник. Клик — карточка. Галочками — массовые действия.')]),
      el('div', { class: 'hr-head-btns' }, [
        el('button', { class: 'btn-ghost hr-add', onclick: () => openEmpImport() }, '📥 Импорт'),
        el('button', { class: 'btn-primary hr-add', onclick: () => openEmp(null) }, '+ Сотрудник'),
      ]),
    ]));
    // Фильтры
    const dSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { empFilter.department = e.target.value; load(); } }, [el('option', { value: '' }, 'Все отделы'), el('option', { value: '__none__', selected: empFilter.department === '__none__' || null }, 'Без отдела'), ...DICTS.departments.map((d) => el('option', { value: d.id, selected: String(d.id) === empFilter.department || null }, d.name))]);
    const stSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { empFilter.status = e.target.value; load(); } }, [{ v: 'active', t: 'Активные' }, { v: 'fired', t: 'Уволенные' }, { v: 'archived', t: 'Архив' }, { v: '', t: 'Все (кроме архива)' }].map((o) => el('option', { value: o.v, selected: o.v === empFilter.status || null }, o.t)));
    const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО / должности / телефону', value: empFilter.q, oninput: (e) => { empFilter.q = e.target.value; clearTimeout(window.__hrT); window.__hrT = setTimeout(load, 300); } });
    c.appendChild(el('div', { class: 'hr-filters' }, [dSel, stSel, q]));
    const box = el('div', { id: 'hr-emp-box' }); c.appendChild(box);
    load();

    async function load() {
      box.innerHTML = '<div class="hr-loading">Загружаю…</div>';
      const p = new URLSearchParams();
      ['department', 'schedule', 'status', 'q'].forEach((k) => { if (empFilter[k]) p.set(k, empFilter[k]); });
      let d; try { d = await api('/employees?' + p.toString()); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
      box.innerHTML = '';
      // Сводки
      box.appendChild(el('div', { class: 'hr-kpis' }, [
        kpi('Показано', d.items.length, 'ink'),
        kpi('ФОТ (оклады, актив.)', moneyShort(d.fot), 'green'),
        kpi('Активных', DICTS.counts.active || 0, 'ink'),
        kpi('Уволенных', DICTS.counts.fired || 0, 'muted'),
      ]));
      if (!d.items.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Никого не найдено. Добавьте сотрудника, импортируйте из Excel или измените фильтры.')); return; }
      empSel = new Set();
      // Панель массовых действий
      const bulk = el('div', { id: 'hr-bulk', class: 'hr-bulkbar', style: 'display:none' });
      const bulkN = el('span', { class: 'hr-bulk-n' }, '');
      const updBulk = () => { bulk.style.display = empSel.size ? 'flex' : 'none'; bulkN.textContent = 'Выбрано: ' + empSel.size; };
      async function doBulk(action, confirmMsg) {
        if (!empSel.size) return; if (confirmMsg && !confirm(confirmMsg + ' (' + empSel.size + ')?')) return;
        try { const r = await post('/employees/bulk', { ids: [...empSel], action }); toast('Готово: ' + r.affected); await reloadDicts(); load(); } catch (e) { toast(e.message, true); }
      }
      bulk.appendChild(bulkN);
      bulk.appendChild(el('button', { class: 'btn-ghost hrf-warn', onclick: () => doBulk('archived', 'В архив') }, 'В архив'));
      bulk.appendChild(el('button', { class: 'btn-ghost hrf-warn', onclick: () => doBulk('fired', 'Уволить') }, 'Уволить'));
      bulk.appendChild(el('button', { class: 'btn-ghost hr-del', onclick: () => doBulk('delete', 'УДАЛИТЬ безвозвратно') }, '🗑 Удалить'));
      bulk.appendChild(el('button', { class: 'btn-ghost', onclick: () => { empSel.clear(); load(); } }, 'Снять'));
      box.appendChild(bulk);
      const selAll = el('input', { type: 'checkbox', class: 'hr-chk' });
      selAll.onclick = (ev) => { const on = ev.target.checked; empSel = new Set(on ? d.items.map((x) => x.id) : []); box.querySelectorAll('.hr-rowchk').forEach((c) => { c.checked = on; }); updBulk(); };
      const head = el('div', { class: 'hr-row head hr-emp' }, [selAll, el('span', {}, '#'), ...['ФИО', 'Отдел', 'Должность', 'Оклад/ставка', 'Статус'].map((h) => el('span', {}, h))]);
      box.appendChild(el('div', { class: 'hr-list' }, [head, ...d.items.map((e, i) => {
        const chk = el('input', { type: 'checkbox', class: 'hr-chk hr-rowchk', onclick: (ev) => { ev.stopPropagation(); if (ev.target.checked) empSel.add(e.id); else empSel.delete(e.id); updBulk(); } });
        return el('div', { class: 'hr-row hr-emp' + (e.status !== 'active' ? ' dim' : '') }, [
          chk,
          el('span', { class: 'hr-idx' }, String(i + 1)),
          el('span', { style: 'font-weight:700; cursor:pointer', onclick: () => openEmp(e) }, e.full_name),
          el('span', { onclick: () => openEmp(e) }, e.department_name || '—'),
          el('span', { onclick: () => openEmp(e) }, e.position || '—'),
          el('span', { class: 'tnum' }, money(e.base_salary)),
          el('span', {}, el('span', { class: 'hr-st hr-st-' + e.status }, STATUS_NAME[e.status] || e.status)),
        ]);
      })]));
    }
  }
  function kpi(label, val, cls) { return el('div', { class: 'hr-kpi' }, [el('div', { class: 'hr-kpi-l' }, label), el('div', { class: 'hr-kpi-v hr-kpi-' + cls }, String(val))]); }

  function openEmpImport() {
    const file = el('input', { type: 'file', accept: '.xls,.xlsx', class: 'hrf-inp' });
    const tpl = el('a', { href: '/hr/api/employees/template.xlsx', class: 'hr-link' }, '⬇ Скачать шаблон Excel');
    const body = el('div', { class: 'hrf' }, [
      el('div', { class: 'hr-sub' }, 'Скачайте шаблон, заполните (ФИО, Отдел, Должность, График, Оклад, Официальная, Неофициальная, Телефон) и загрузите. Отделы найдутся по названию или создадутся.'),
      el('div', {}, tpl),
      frow('Файл', file),
    ]);
    const load = el('button', { class: 'btn-primary', onclick: async () => {
      if (!file.files[0]) return toast('Выберите файл', true);
      load.disabled = true; load.textContent = 'Загружаю…';
      const fd = new FormData(); fd.append('file', file.files[0]);
      try {
        const res = await fetch('/hr/api/employees/import', { method: 'POST', body: fd });
        const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Ошибка');
        toast('Добавлено сотрудников: ' + d.created);
        closeModal(); await reloadDicts(); render();
      } catch (e) { toast(e.message, true); load.disabled = false; load.textContent = 'Загрузить'; }
    } }, 'Загрузить');
    modal('Импорт сотрудников', body, [load]);
  }

  // Массовая загрузка номеров карт: шаблон уже со списком сотрудников, заполнить только карту.
  function openCardImport() {
    const file = el('input', { type: 'file', accept: '.xls,.xlsx', class: 'hrf-inp' });
    const tpl = el('a', { href: '/hr/api/cards/template.xlsx', class: 'hr-link' }, '⬇ Скачать шаблон (уже со списком сотрудников)');
    const body = el('div', { class: 'hrf' }, [
      el('div', { class: 'hr-sub' }, 'Скачайте шаблон — в нём уже все сотрудники. Впишите номер карты в колонку «Номер карты» и загрузите. Сопоставляем по ФИО, пустые строки пропускаем.'),
      el('div', {}, tpl),
      frow('Файл', file),
    ]);
    const load = el('button', { class: 'btn-primary', onclick: async () => {
      if (!file.files[0]) return toast('Выберите файл', true);
      load.disabled = true; load.textContent = 'Загружаю…';
      const fd = new FormData(); fd.append('file', file.files[0]);
      try {
        const res = await fetch('/hr/api/cards/import', { method: 'POST', body: fd });
        const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Ошибка');
        let msg = 'Обновлено карт: ' + d.updated;
        if (d.notFoundCount) msg += '. Не нашли по ФИО: ' + d.notFoundCount + (d.notFound.length ? ' (' + d.notFound.join(', ') + ')' : '');
        alert(msg);
        closeModal(); await reloadDicts(); render();
      } catch (e) { toast(e.message, true); load.disabled = false; load.textContent = 'Загрузить'; }
    } }, 'Загрузить');
    modal('Загрузка номеров карт', body, [load]);
  }

  // Загрузка табеля из Excel за период (табель начальника производства).
  function openTimesheetImport(period) {
    const file = el('input', { type: 'file', accept: '.xls,.xlsx', class: 'hrf-inp' });
    const tpl = el('a', { href: '/hr/api/timesheet/template.xlsx?period=' + period, class: 'hr-link' }, '⬇ Скачать шаблон за ' + monthLabel(period));
    const body = el('div', { class: 'hrf' }, [
      el('div', { class: 'hr-sub' }, 'Шаблон уже со списком сотрудников и текущими значениями. Заполните План/Факт дней и часов, загрузите. Сопоставляем по ФИО; пишем только дни/часы, деньги не трогаем.'),
      el('div', {}, tpl),
      frow('Файл', file),
    ]);
    const load = el('button', { class: 'btn-primary', onclick: async () => {
      if (!file.files[0]) return toast('Выберите файл', true);
      load.disabled = true; load.textContent = 'Загружаю…';
      const fd = new FormData(); fd.append('file', file.files[0]); fd.append('period', period);
      try {
        const res = await fetch('/hr/api/timesheet/import', { method: 'POST', body: fd });
        const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Ошибка');
        let msg = 'Обновлено строк табеля: ' + d.updated;
        if (d.notFoundCount) msg += '. Не нашли по ФИО: ' + d.notFoundCount + (d.notFound.length ? ' (' + d.notFound.join(', ') + ')' : '');
        alert(msg);
        closeModal(); renderTimesheet();
      } catch (e) { toast(e.message, true); load.disabled = false; load.textContent = 'Загрузить'; }
    } }, 'Загрузить');
    modal('Загрузка табеля — ' + monthLabel(period), body, [load]);
  }

  function openEmp(e) {
    e = e || {};
    const name = finp(e.full_name, { placeholder: 'Фамилия Имя Отчество' });
    const dept = fsel([{ v: '', t: '— отдел —' }, ...DICTS.departments.map((d) => ({ v: d.id, t: d.name }))], e.department_id || '');
    const pos = finp(e.position, { placeholder: 'Должность' });
    const hire = finp(e.hire_date ? String(e.hire_date).slice(0, 10) : '', { type: 'date' });
    const base = minp(e.base_salary, { placeholder: 'Оклад / ставка' });
    const off = minp(e.salary_official, { placeholder: 'Официальная часть' });
    const unoff = minp(e.salary_unofficial, { placeholder: 'Неофициальная часть' });
    // Оклад = официальная + неофициальная (пересчитывается автоматически при правке частей).
    const recalcBase = () => { base.value = fmtDigits(String((Number(mval(off)) || 0) + (Number(mval(unoff)) || 0))); };
    off.addEventListener('input', recalcBase);
    unoff.addEventListener('input', recalcBase);
    const phone = finp(e.phone, { placeholder: '998…' });
    const card = finp(e.card_number, { placeholder: 'Номер пластиковой карты' });
    const tg = finp(e.telegram_id, { placeholder: 'Telegram ID (если есть)' });
    const comment = finp(e.comment, { placeholder: 'Комментарий' });
    const body = el('div', { class: 'hrf' }, [
      frow('ФИО *', name), frow('Отдел', dept), frow('Должность', pos), frow('Дата приёма', hire),
      el('div', { class: 'hrf-sec' }, 'Зарплата'),
      frow('Оклад / ставка', base), frow('Официальная часть', off), frow('Неофициальная часть', unoff),
      el('div', { class: 'hrf-sec' }, 'Контакты'),
      frow('Телефон', phone), frow('Номер карты', card), frow('Telegram ID', tg), frow('Комментарий', comment),
    ]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        await post('/employee', { id: e.id, full_name: name.value, department_id: dept.value, position: pos.value, schedule_type: e.schedule_type || '', hire_date: hire.value, base_salary: mval(base), salary_official: mval(off), salary_unofficial: mval(unoff), phone: phone.value, card_number: card.value, telegram_id: tg.value, comment: comment.value });
        toast('Сохранено'); closeModal(); await reloadDicts(); render();
      } catch (err) { toast(err.message, true); }
    } }, 'Сохранить');
    const acts = [save];
    if (e.id) {
      if (e.status === 'active') acts.unshift(el('button', { class: 'btn-ghost hrf-warn', onclick: () => changeStatus(e, 'fired') }, 'Уволить'));
      if (e.status !== 'archived') acts.unshift(el('button', { class: 'btn-ghost', onclick: () => changeStatus(e, 'archived') }, 'В архив'));
      if (e.status !== 'active') acts.unshift(el('button', { class: 'btn-ghost', onclick: () => changeStatus(e, 'active') }, 'Вернуть в актив'));
    }
    modal(e.id ? '✏️ ' + e.full_name : '+ Новый сотрудник', body, acts);
  }
  async function changeStatus(e, st) {
    if (st === 'fired') return openFireForm(e);
    const labels = { archived: 'В архив', active: 'Вернуть в актив' };
    if (!confirm(labels[st] + ' сотрудника «' + e.full_name + '»?')) return;
    try { await post('/employee/' + e.id + '/status', { status: st }); toast('Готово'); closeModal(); await reloadDicts(); render(); } catch (err) { toast(err.message, true); }
  }
  // Увольнение — всегда с датой (обязательно).
  function openFireForm(e) {
    const date = finp(e.fire_date ? String(e.fire_date).slice(0, 10) : new Date().toISOString().slice(0, 10), { type: 'date' });
    const body = el('div', { class: 'hrf' }, [
      el('div', { class: 'hr-sub', style: 'margin-bottom:6px' }, 'Увольнение «' + e.full_name + '». Укажите дату увольнения.'),
      frow('Дата увольнения *', date),
    ]);
    const ok = el('button', { class: 'btn-primary hrf-warn', onclick: async () => {
      if (!date.value) return toast('Укажите дату увольнения', true);
      try { await post('/employee/' + e.id + '/status', { status: 'fired', fire_date: date.value }); toast('Уволен ' + date.value); $('#hr-modal-root').innerHTML = ''; await reloadDicts(); render(); }
      catch (err) { toast(err.message, true); }
    } }, 'Уволить');
    modal('Увольнение — ' + e.full_name, body, [el('button', { class: 'btn-ghost', onclick: closeModal }, 'Отмена'), ok]);
  }

  // ================= ТАБЕЛЬ =================
  const tsState = { period: '', department: '', schedule: '', q: '' };
  async function renderTimesheet() {
    const c = $('#hr-content');
    if (!tsState.period) tsState.period = curMonth();
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Табель — ' + monthLabel(tsState.period)), el('div', { class: 'hr-sub' }, 'Часы/дни за месяц. Переработка = факт − план часов (оплата ×2 — механизм расчёта настроим позже). Деньги начислений не затрагиваются.')]),
      el('div', { class: 'hr-head-btns' }, [
        el('button', { class: 'btn-ghost hr-add', onclick: () => openTimesheetImport(tsState.period) }, '📥 Загрузить из Excel'),
      ]),
    ]));
    const mInp = el('input', { type: 'month', class: 'hrf-inp hr-filt', value: tsState.period, onchange: (e) => { tsState.period = e.target.value || curMonth(); load(); } });
    const dSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { tsState.department = e.target.value; load(); } }, [el('option', { value: '' }, 'Все отделы'), ...DICTS.departments.map((d) => el('option', { value: d.id, selected: String(d.id) === tsState.department || null }, d.name))]);
    const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО', value: tsState.q, oninput: (e) => { tsState.q = e.target.value; clearTimeout(window.__hrT); window.__hrT = setTimeout(load, 300); } });
    c.appendChild(el('div', { class: 'hr-filters' }, [el('span', { class: 'hr-flab' }, 'Месяц:'), mInp, dSel, q]));
    const box = el('div', { id: 'hr-ts-box' }); c.appendChild(box);
    load();

    async function load() {
      box.innerHTML = '<div class="hr-loading">Загружаю…</div>';
      const p = new URLSearchParams({ period: tsState.period });
      ['department', 'schedule', 'q'].forEach((k) => { if (tsState[k]) p.set(k, tsState[k]); });
      let d; try { d = await api('/payroll?' + p.toString()); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
      box.innerHTML = '';
      if (!d.items.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Нет сотрудников по фильтру.')); return; }
      const rowsModel = d.items.map((r) => ({ employee_id: r.emp_id, inputs: {} }));
      // Быстрое заполнение плана дней всем сразу.
      const planAll = el('input', { class: 'hrf-inp hr-filt', type: 'number', min: '0', style: 'width:90px', placeholder: 'напр. 26' });
      const fillBtn = el('button', { class: 'btn-ghost', onclick: () => { const v = planAll.value; if (v === '') return; rowsModel.forEach((m) => { m.inputs.plan_days.value = v; }); toast('План проставлен всем — не забудьте сохранить'); } }, 'Заполнить план');
      const saveBtn = el('button', { class: 'btn-primary', onclick: save }, '💾 Сохранить табель');
      box.appendChild(el('div', { class: 'hr-filters', style: 'justify-content:flex-end' }, [el('span', { class: 'hr-flab' }, 'План дней всем:'), planAll, fillBtn, saveBtn]));
      const numIn = (m, key, val) => { const i = el('input', { class: 'hrf-inp hr-ts-inp', type: 'number', min: '0', step: key.indexOf('hours') >= 0 ? '0.5' : '1', value: val == null ? '' : String(val) }); m.inputs[key] = i; return i; };
      const nH = (v) => String(Math.round((Number(v) || 0) * 10) / 10);
      const head = el('div', { class: 'hr-row head hr-ts' }, ['#', 'ФИО', 'Отдел', 'План дн.', 'Факт дн.', 'План ч.', 'Факт ч.', 'Стандарт ч.', 'Переработка ч.'].map((h) => el('span', {}, h)));
      box.appendChild(el('div', { class: 'hr-list' }, [head, ...d.items.map((r, i) => {
        const m = rowsModel[i];
        const ph = numIn(m, 'plan_hours', r.plan_hours), fh = numIn(m, 'fact_hours', r.fact_hours);
        const std = el('span', { class: 'tnum muted' }, '—'), ot = el('span', { class: 'tnum' }, '—');
        const recompute = () => {
          const p = Number(ph.value) || 0, f = Number(fh.value) || 0;
          if (!f) { std.textContent = '—'; ot.textContent = '—'; ot.style.color = ''; return; }
          const over = p > 0 ? Math.max(0, f - p) : 0;
          std.textContent = nH(f - over);
          ot.textContent = over ? '+' + nH(over) : '—';
          ot.style.color = over ? '#b25b00' : '';
        };
        ph.addEventListener('input', recompute); fh.addEventListener('input', recompute);
        const row = el('div', { class: 'hr-row hr-ts' }, [
          el('span', { class: 'hr-idx' }, String(i + 1)),
          el('span', { style: 'font-weight:700' }, r.full_name),
          el('span', { class: 'muted' }, r.department_name || '—'),
          numIn(m, 'plan_days', r.plan_days), numIn(m, 'fact_days', r.fact_days),
          ph, fh, std, ot,
        ]);
        recompute();
        return row;
      })]));

      async function save() {
        const rows = rowsModel.map((m) => ({ employee_id: m.employee_id, plan_days: m.inputs.plan_days.value, fact_days: m.inputs.fact_days.value, plan_hours: m.inputs.plan_hours.value, fact_hours: m.inputs.fact_hours.value }));
        saveBtn.disabled = true; saveBtn.textContent = 'Сохраняю…';
        try { const rr = await post('/timesheet', { period: tsState.period, rows }); toast('Сохранено: ' + rr.saved); load(); }
        catch (e) { toast(e.message, true); saveBtn.disabled = false; saveBtn.textContent = '💾 Сохранить табель'; }
      }
    }
  }

  // ================= ЗАРПЛАТА =================
  const PR_STATUS = { draft: 'Черновик', approved: 'Утверждено', paid: 'Выплачено', cancelled: 'Отменено' };
  // Фикса — справочно, НЕ входит в сумму «начислено». Счётные — ниже.
  const ACCR_FIELDS = [['accr_fact', 'Факт по табелю'], ['accr_bonus', 'Бонусы KPI'], ['accr_premium', 'Премия'], ['accr_gsm', 'ГСМ / компенсации'], ['accr_sick', 'Больничные'], ['accr_vacation', 'Отпускные'], ['accr_mataid', 'Матпомощь'], ['accr_comp_vac', 'Компенсация отпуска'], ['accr_company_debt', 'Долг компании'], ['accr_other', 'Другое начисление']];
  // Операции для вкладки «Массовые операции» (поле payroll → подпись).
  const MASS_OPS = [['accr_bonus', 'Бонусы KPI'], ['accr_premium', 'Премия'], ['accr_gsm', 'ГСМ / компенсации'], ['accr_sick', 'Больничные'], ['accr_vacation', 'Отпускные'], ['accr_mataid', 'Матпомощь'], ['accr_comp_vac', 'Компенсация за неисп. отпуск'], ['accr_company_debt', 'Долг компании'], ['accr_other', 'Другое начисление'],
    ['ded_fine', 'Штрафы'], ['ded_hold', 'Удержания']];
  const DED_FIELDS = [['ded_fine', 'Штраф за опоздание'], ['ded_advance_card', 'Аванс на карту'], ['ded_advance_cash', 'Аванс наличными'], ['ded_hold', 'Удержание'], ['ded_emp_debt', 'Долг сотрудника'], ['ded_other', 'Другое удержание']];
  const PAID_FIELDS = [['paid_cash', 'Выплачено наличными'], ['paid_card', 'Выплачено на карту']];
  const salState = { period: '', department: '', schedule: '', status: '', q: '' };
  let salSel = new Set();
  const curMonth = () => new Date().toISOString().slice(0, 7);
  const monthLabel = (ym) => { const [y, m] = ym.split('-'); return ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'][Number(m)] + ' ' + y; };

  async function renderSalary() {
    const c = $('#hr-content');
    if (!salState.period) salState.period = curMonth();
    const NORM_DEFAULTS = { production: { d: 26, h: 208 }, office: { d: 22, h: 176 }, shift: { d: 15, h: 180 } };
    function openFillNorms() {
      const rows = {};
      const body = el('div', { class: 'hrf' }, [
        el('div', { class: 'hr-sub' }, 'Плановые нормы на месяц по графикам. Проставятся всем активным сотрудникам графика; начисление пересчитается (у офиса — сразу оклад, у почасовых — после табеля).'),
        el('div', { style: 'display:grid;grid-template-columns:1fr 90px 90px;gap:8px;font-size:12px;color:#7c8579;font-weight:700' }, [el('span', {}, 'График'), el('span', {}, 'План дни'), el('span', {}, 'План часы')]),
        ...(DICTS.schedules || []).map((s) => {
          const def = NORM_DEFAULTS[s.code] || { d: '', h: '' };
          const pd = minp(def.d, { placeholder: 'дни' }); const ph = minp(def.h, { placeholder: 'часы' });
          rows[s.code] = { pd, ph };
          return el('div', { style: 'display:grid;grid-template-columns:1fr 90px 90px;gap:8px;align-items:center' }, [el('span', {}, s.name), pd, ph]);
        }),
      ]);
      const save = el('button', { class: 'btn-primary', onclick: async () => {
        const norms = {}; Object.entries(rows).forEach(([c2, io]) => { norms[c2] = { plan_days: mval(io.pd), plan_hours: mval(io.ph) }; });
        try { const r = await post('/fill-norms', { period: salState.period, norms }); toast('Нормы проставлены: ' + r.count); closeModal(); load(); } catch (e) { toast(e.message, true); }
      } }, 'Применить');
      modal('Заполнить нормы — ' + monthLabel(salState.period), body, [save]);
    }
    function openTimesheetImport() {
      const file = el('input', { type: 'file', accept: '.xlsx,.xls', class: 'hrf-inp' });
      const info = el('div', {});
      const body = el('div', { class: 'hrf' }, [
        el('div', { class: 'hr-sub' }, 'Табель производства (2 строки на сотрудника: факт-часы и переработка). Разнесётся по ФИО за ' + monthLabel(salState.period) + '; начисление посчитается по формуле.'),
        el('label', { class: 'hrf-row' }, [el('span', {}, 'Файл'), file]), info,
      ]);
      const load2 = el('button', { class: 'btn-primary', onclick: async () => {
        if (!file.files[0]) return toast('Выберите файл', true);
        load2.disabled = true; load2.textContent = 'Загружаю…';
        const fd = new FormData(); fd.append('period', salState.period); fd.append('file', file.files[0]);
        try {
          const r = await fetch('/hr/api/timesheet-import', { method: 'POST', body: fd });
          const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Ошибка');
          toast('Разнесено: ' + d.updated + (d.unmatched.length ? (', не найдено ' + d.unmatched.length) : ''));
          load();
          if (d.unmatched && d.unmatched.length) {
            info.innerHTML = '';
            info.appendChild(el('div', { style: 'color:#b25b00;font-weight:700;margin-top:8px' }, 'Не нашлись в справочнике (' + d.unmatched.length + ') — впиши точнее или добавь сотрудника:'));
            d.unmatched.forEach((u) => info.appendChild(el('div', { class: 'hr-sub', style: 'margin:0' }, u.fio + ' — ' + u.fact_hours + 'ч')));
            load2.textContent = 'Готово'; load2.disabled = false;
          } else { closeModal(); }
        } catch (e) { toast(e.message, true); load2.disabled = false; load2.textContent = 'Загрузить'; }
      } }, 'Загрузить');
      modal('Импорт табеля — ' + monthLabel(salState.period), body, [load2]);
    }
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Зарплата — ' + monthLabel(salState.period)), el('div', { class: 'hr-sub' }, 'Оклад считается сам по табелю. Клик по сотруднику — карточка. Итоги считаются сами.')]),
      el('div', { style: 'display:flex;gap:8px;align-self:flex-start' }, [
        el('button', { class: 'btn-primary', onclick: openFillNorms }, '📋 Заполнить нормы'),
        el('button', { class: 'btn-ghost', onclick: openTimesheetImport }, '📥 Импорт табеля'),
        el('button', { class: 'btn-ghost', onclick: () => openCardImport() }, '💳 Карты (Excel)'),
      ]),
    ]));
    const mInp = el('input', { type: 'month', class: 'hrf-inp hr-filt', value: salState.period, onchange: (e) => { salState.period = e.target.value || curMonth(); load(); } });
    const dSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { salState.department = e.target.value; load(); } }, [el('option', { value: '' }, 'Все отделы'), ...DICTS.departments.map((d) => el('option', { value: d.id, selected: String(d.id) === salState.department || null }, d.name))]);
    const stSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { salState.status = e.target.value; load(); } }, [{ v: '', t: 'Все статусы' }, { v: 'none', t: 'Без начисления' }, { v: 'draft', t: 'Черновик' }, { v: 'approved', t: 'Утверждено' }, { v: 'paid', t: 'Выплачено' }].map((o) => el('option', { value: o.v, selected: o.v === salState.status || null }, o.t)));
    const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО', value: salState.q, oninput: (e) => { salState.q = e.target.value; clearTimeout(window.__hrS); window.__hrS = setTimeout(load, 300); } });
    c.appendChild(el('div', { class: 'hr-filters' }, [el('span', { class: 'hr-flab' }, 'Месяц:'), mInp, dSel, stSel, q]));
    const box = el('div', { id: 'hr-sal-box' }); c.appendChild(box);
    load();

    async function load() {
      box.innerHTML = '<div class="hr-loading">Считаю…</div>';
      salSel = new Set();
      const p = new URLSearchParams({ period: salState.period });
      ['department', 'schedule', 'status', 'q'].forEach((k) => { if (salState[k]) p.set(k, salState[k]); });
      let d; try { d = await api('/payroll?' + p.toString()); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
      box.innerHTML = '';
      const s = d.summary;
      box.appendChild(el('div', { class: 'hr-kpis hr-kpis-6' }, [
        kpi('ФОТ (начислено)', moneyShort(s.accrued), 'green'), kpi('Бонусы/KPI', moneyShort(s.bonus), 'ink'), kpi('Удержания', moneyShort(s.deducted), 'muted'),
        kpi('Авансы', moneyShort(s.advances), 'muted'), kpi('Выплачено', moneyShort(s.paid), 'ink'), kpi('К выплате', moneyShort(s.to_pay), 'green'),
      ]));
      box.appendChild(el('div', { class: 'hr-kpis hr-kpis-2', style: 'margin-bottom:14px' }, [kpi('Сотрудников', s.count, 'ink')]));
      // Выплаты из кассы без сотрудника — по умолчанию свёрнуто; можно скрывать строки (навсегда, только визуально).
      if (d.cash_unmatched && d.cash_unmatched.length) {
        let showHidden = false;
        const listBox = el('div', { style: 'display:none;margin-top:8px' });
        const cntSpan = el('span', {});
        const rebuild = () => {
          const shown = d.cash_unmatched.filter((u) => showHidden || !u.hidden);
          const hiddenCnt = d.cash_unmatched.filter((u) => u.hidden).length;
          listBox.innerHTML = '';
          const bar = el('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:6px' }, []);
          const visIds = d.cash_unmatched.filter((u) => !u.hidden).map((u) => u.tx_id);
          if (visIds.length) bar.appendChild(el('button', { class: 'btn-ghost', style: 'font-size:12px;padding:3px 9px', onclick: async () => { if (!confirm('Скрыть все показанные (' + visIds.length + ')? Касса и суммы не изменятся.')) return; try { await post('/salary/cash-hide', { ids: visIds, hidden: true }); d.cash_unmatched.forEach((u) => { if (visIds.includes(u.tx_id)) u.hidden = true; }); rebuild(); } catch (e) { toast(e.message, true); } } }, '🚫 Скрыть все показанные'));
          if (hiddenCnt) bar.appendChild(el('a', { href: 'javascript:void(0)', class: 'muted', style: 'font-size:12px', onclick: () => { showHidden = !showHidden; rebuild(); } }, (showHidden ? '▾ Скрыть скрытые' : '▸ Показать скрытые') + ' (' + hiddenCnt + ')'));
          if (bar.childNodes.length) listBox.appendChild(bar);
          shown.forEach((u) => listBox.appendChild(el('div', { style: 'display:flex;gap:12px;font-size:13px;padding:2px 0;align-items:center' + (u.hidden ? ';opacity:.5' : '') }, [
            el('span', { style: 'min-width:88px' }, String(u.date)),
            el('span', { style: 'min-width:70px' }, u.kind === 'advance' ? 'аванс' : 'зарплата'),
            el('span', { class: 'tnum', style: 'min-width:120px;font-weight:700' }, money(u.amount)),
            el('span', { class: 'muted', style: 'flex:1' }, u.purpose || ''),
            el('span', { style: 'cursor:pointer;opacity:.6', title: u.hidden ? 'Вернуть' : 'Скрыть навсегда', onclick: async () => { try { await post('/salary/cash-hide', { ids: [u.tx_id], hidden: !u.hidden }); u.hidden = !u.hidden; rebuild(); } catch (e) { toast(e.message, true); } } }, u.hidden ? '👁' : '🚫'),
          ])));
          const visCnt = d.cash_unmatched.filter((u) => !u.hidden).length;
          cntSpan.textContent = '⚠ Выплаты из кассы без сотрудника (' + visCnt + ')';
        };
        const arrow = el('span', {}, '▸');
        const head2 = el('div', { style: 'font-weight:700;color:#b25b00;cursor:pointer;display:flex;gap:6px;align-items:center', onclick: () => {
          const open = listBox.style.display === 'none';
          listBox.style.display = open ? '' : 'none'; arrow.textContent = open ? '▾' : '▸';
        } }, [arrow, cntSpan, el('span', { class: 'muted', style: 'font-weight:400;font-size:12px' }, '— показать')]);
        rebuild();
        box.appendChild(el('div', { style: 'background:#fff3e0;border:1px solid #e6c98a;border-radius:10px;padding:8px 12px;margin-bottom:12px' }, [head2, listBox]));
      }
      if (!d.items.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Нет сотрудников по фильтру.')); return; }
      const bulk = el('div', { id: 'hr-sal-bulk', class: 'hr-bulkbar', style: 'display:none' });
      const bulkN = el('span', { class: 'hr-bulk-n' }, '');
      const updBulk = () => { bulk.style.display = salSel.size ? 'flex' : 'none'; bulkN.textContent = 'Выбрано начислений: ' + salSel.size; };
      bulk.appendChild(bulkN);
      bulk.appendChild(el('button', { class: 'btn-ghost hr-del', onclick: async () => { if (!salSel.size) return; if (!confirm('Удалить выбранные начисления (' + salSel.size + ')? Сотрудники останутся.')) return; try { const rr = await post('/payroll/bulk-delete', { ids: [...salSel] }); toast('Удалено: ' + rr.affected); load(); } catch (e) { toast(e.message, true); } } }, '🗑 Удалить начисления'));
      bulk.appendChild(el('button', { class: 'btn-ghost', onclick: () => { salSel.clear(); load(); } }, 'Снять'));
      box.appendChild(bulk);
      const withId = d.items.filter((x) => x.id);
      const selAll = el('input', { type: 'checkbox', class: 'hr-chk' });
      selAll.onclick = (ev) => { const on = ev.target.checked; salSel = new Set(on ? withId.map((x) => x.id) : []); box.querySelectorAll('.hr-salchk').forEach((cc) => { cc.checked = on; }); updBulk(); };
      const head = el('div', { class: 'hr-row head hr-sal' }, [selAll, el('span', {}, '#'), ...['ФИО', 'Отдел', 'Дн. п/ф', 'Часы п/ф', 'Начислено', 'Доп. нач.', 'Удержано', 'Доп. удерж.', 'Аванс', 'Выплачено', 'К выплате', 'Статус'].map((h) => el('span', {}, h))]);
      // Доп. начисления/удержания: колонка — сумма, клик — компактное окно с полями (правится там).
      const EXTRA_ACCR = ACCR_FIELDS.filter(([k]) => k !== 'accr_fact');
      const EXTRA_DED = DED_FIELDS.filter(([k]) => k !== 'ded_advance_card' && k !== 'ded_advance_cash');
      const sumOf = (r, fields) => fields.reduce((s, [k]) => s + (Number(r[k]) || 0), 0);
      function openExtra(r, title, fields) {
        const body = el('div', { class: 'hrf' }, [
          el('div', { class: 'hr-note' }, r.full_name + ' · ' + monthLabel(salState.period)),
          ...fields.map(([k, label]) => {
            const i = minp(r[k] == null ? '' : Math.round(Number(r[k])), { placeholder: '0' });
            i.onchange = async () => {
              try { await post('/payroll/cell', { employee_id: r.emp_id, period: salState.period, field: k, value: mval(i) }); load(); }
              catch (e) { toast(e.message, true); }
            };
            return frow(label, i);
          }),
          el('div', { class: 'hr-sub', style: 'margin:6px 0 0' }, 'Меняется сразу — итоги пересчитаются.'),
        ]);
        modal(title + ' — ' + r.full_name, body, [el('button', { class: 'btn-primary', onclick: closeModal }, 'Готово')]);
      }
      const extraCell = (r, title, fields) => el('span', { class: 'tnum hr-extra', title: 'Клик — изменить', onclick: (ev) => { ev.stopPropagation(); openExtra(r, title, fields); } }, money(sumOf(r, fields)));
      // Правка прямо в строке: дни/часы меняются на месте, оклад пересчитывается сам.
      const cellNum = (r, field) => {
        const inp = el('input', { class: 'hr-cell', value: r[field] == null ? '' : String(Math.round(Number(r[field]))), onclick: (ev) => ev.stopPropagation() });
        inp.onchange = async () => {
          try { await post('/payroll/cell', { employee_id: r.emp_id, period: salState.period, field, value: mval(inp) }); load(); }
          catch (e) { toast(e.message, true); }
        };
        return inp;
      };
      const pf = (r, a, b2) => el('span', { class: 'hr-pf' }, [cellNum(r, a), el('span', { class: 'hr-pf-sep' }, '/'), cellNum(r, b2)]);
      box.appendChild(el('div', { class: 'hr-list' }, [head, ...d.items.map((r, i) => {
        const chk = r.id ? el('input', { type: 'checkbox', class: 'hr-chk hr-salchk', onclick: (ev) => { ev.stopPropagation(); if (ev.target.checked) salSel.add(r.id); else salSel.delete(r.id); updBulk(); } }) : el('span', {});
        return el('div', { class: 'hr-row hr-sal', onclick: () => openPayroll(r) }, [
          chk,
          el('span', { class: 'hr-idx' }, String(i + 1)),
          el('span', { style: 'font-weight:700' }, r.full_name),
          el('span', { class: 'muted' }, r.department_name || '—'),
          pf(r, 'plan_days', 'fact_days'),
          pf(r, 'plan_hours', 'fact_hours'),
          el('span', { class: 'tnum' }, money(r.accrued)),
          extraCell(r, 'Доп. начисления', EXTRA_ACCR),
          el('span', { class: 'tnum' }, money(r.deducted)),
          extraCell(r, 'Доп. удержания', EXTRA_DED),
          el('span', { class: 'tnum' }, [money((Number(r.ded_advance_card) || 0) + (Number(r.ded_advance_cash) || 0)), (Number(r.cash_advance) > 0 ? el('div', { style: 'font-size:11px;font-weight:700;color:#2e7d32;margin-top:2px' }, '💵 касса ' + money(r.cash_advance)) : null)]),
          el('span', { class: 'tnum' }, [money(r.paid), (Number(r.cash_paid) > 0 ? el('div', { style: 'font-size:11px;font-weight:700;color:#2e7d32;margin-top:2px' }, '💵 касса ' + money(r.cash_paid)) : null)]),
          el('span', { class: 'tnum', style: 'font-weight:800;color:#2e7d32' }, money(r.to_pay)),
          el('span', {}, el('span', { class: 'hr-st hr-pr-' + (r.id ? (r.status || 'draft') : 'none') }, r.id ? PR_STATUS[r.status || 'draft'] : 'нет')),
        ]);
      })]));
    }
  }

  function openPayroll(r) {
    const F = {};
    const inp = (k) => { const i = minp(r[k] != null ? r[k] : '', { placeholder: '0' }); F[k] = i; return i; };
    const dinp = (k) => { const i = finp(r[k] ? String(r[k]).slice(0, 10) : '', { type: 'date' }); F[k] = i; return i; };
    const status = fsel(Object.keys(PR_STATUS).map((k) => ({ v: k, t: PR_STATUS[k] })), r.status || 'draft'); F.status = status;
    const comment = finp(r.comment, { placeholder: 'Комментарий' }); F.comment = comment;
    // Итоги (живой пересчёт)
    const totAccr = el('b', {}), totDed = el('b', {}), totPaid = el('b', {}), totPay = el('b', { style: 'color:#2e7d32' });
    const recompute = () => {
      const val = (k) => (F[k] ? Number(mval(F[k])) : 0) || 0;
      const a = ACCR_FIELDS.reduce((s, [k]) => s + val(k), 0);
      const de = DED_FIELDS.reduce((s, [k]) => s + val(k), 0);
      const pd = PAID_FIELDS.reduce((s, [k]) => s + val(k), 0);
      totAccr.textContent = money(a); totDed.textContent = money(de); totPaid.textContent = money(pd);
      totPay.textContent = money(a - de - pd);
    };
    const block = (title, fields) => el('div', {}, [el('div', { class: 'hrf-sec' }, title), ...fields.map(([k, label]) => { const i = inp(k); i.addEventListener('input', recompute); return frow(label, i); })]);
    const tab = block('Табель', [['plan_days', 'План дней'], ['fact_days', 'Факт дней'], ['plan_hours', 'План часов'], ['fact_hours', 'Факт часов']]);
    // Оклад тянем из карточки сотрудника («Фикса»), а не из поля начисления — меняется у сотрудника.
    const fixa = el('div', { class: 'hr-note', style: 'font-weight:800' }, money(r.base_salary || 0) + ' сум');
    const body = el('div', { class: 'hrf' }, [
      el('div', { class: 'hr-note' }, r.full_name + ' · ' + (r.department_name || '—') + ' · ' + monthLabel(salState.period)),
      frow('Статус', status),
      frow('Оклад (фикса)', fixa),
      tab,
      block('Начисления (входят в сумму)', ACCR_FIELDS),
      block('Удержания', DED_FIELDS),
      block('Выплаты', PAID_FIELDS),
      frow('Дата выплаты', dinp('pay_date')),
      frow('Комментарий', comment),
      el('div', { class: 'hr-formula' }, [
        el('div', {}, ['Начислено всего: ', totAccr]),
        el('div', {}, ['− Удержано всего: ', totDed]),
        el('div', {}, ['− Выплачено: ', totPaid]),
        el('div', { class: 'hr-formula-main' }, ['= К выплате: ', totPay]),
      ]),
    ]);
    recompute();
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      // Оклад (фикса) синхронизируем из карточки сотрудника; 1С не трогаем — сохраняем как было.
      const payload = { employee_id: r.emp_id, period: salState.period, status: status.value, pay_date: F.pay_date.value, comment: comment.value, accr_salary: r.base_salary || '' };
      [...ACCR_FIELDS, ...DED_FIELDS, ...PAID_FIELDS].forEach(([k]) => { payload[k] = mval(F[k]); });
      ['plan_days', 'fact_days', 'plan_hours', 'fact_hours'].forEach((k) => { payload[k] = mval(F[k]); });
      payload.amount_1c = r.amount_1c || '';
      try { await post('/payroll', payload); toast('Сохранено'); closeModal(); renderSalary(); } catch (e) { toast(e.message, true); }
    } }, 'Сохранить');
    modal('💵 Начисление — ' + r.full_name, body, [save]);
  }

  // ================= МАССОВЫЕ ОПЕРАЦИИ =================
  const massState = { period: '', field: 'accr_bonus', mode: 'add', department: '', schedule: '', q: '' };
  async function renderMassOps() {
    const c = $('#hr-content');
    if (!massState.period) massState.period = curMonth();
    const opLabel = (MASS_OPS.find((o) => o[0] === massState.field) || ['', ''])[1];
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Массовые операции — ' + monthLabel(massState.period)),
        el('div', { class: 'hr-sub' }, 'Выбери операцию и период, отметь сотрудников, впиши суммы — начислит всем разом. Попадает в расчёт зарплаты за месяц.')]),
    ]));
    const mInp = el('input', { type: 'month', class: 'hrf-inp hr-filt', value: massState.period, onchange: (e) => { massState.period = e.target.value || curMonth(); load(); } });
    const opSel = fsel(MASS_OPS.map((o) => ({ v: o[0], t: o[1] })), massState.field);
    opSel.classList.add('hr-filt'); opSel.onchange = (e) => { massState.field = e.target.value; load(); };
    const modeSel = fsel([{ v: 'add', t: 'Добавить к текущему' }, { v: 'set', t: 'Заменить' }], massState.mode);
    modeSel.classList.add('hr-filt'); modeSel.onchange = (e) => { massState.mode = e.target.value; };
    const dSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { massState.department = e.target.value; load(); } }, [el('option', { value: '' }, 'Все отделы'), ...DICTS.departments.map((d) => el('option', { value: d.id, selected: String(d.id) === massState.department || null }, d.name))]);
    const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО', value: massState.q, oninput: (e) => { massState.q = e.target.value; clearTimeout(window.__hrM); window.__hrM = setTimeout(load, 300); } });
    c.appendChild(el('div', { class: 'hr-filters' }, [el('span', { class: 'hr-flab' }, 'Операция:'), opSel, modeSel, el('span', { class: 'hr-flab' }, 'Месяц:'), mInp, dSel, q]));
    const box = el('div', { id: 'hr-mass-box' }); c.appendChild(box);
    load();

    async function load() {
      box.innerHTML = '<div class="hr-loading">Загружаю…</div>';
      const p = new URLSearchParams({ period: massState.period });
      ['department', 'schedule', 'q'].forEach((k) => { if (massState[k]) p.set(k, massState[k]); });
      let d; try { d = await api('/payroll?' + p.toString()); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
      box.innerHTML = '';
      if (!d.items.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Нет сотрудников по фильтру.')); return; }
      const field = massState.field;
      const rowsModel = d.items.map((r) => ({ employee_id: r.emp_id }));
      const fillAll = el('input', { class: 'hrf-inp hr-filt', type: 'number', style: 'width:120px', placeholder: 'сумма' });
      const fillBtn = el('button', { class: 'btn-ghost', onclick: () => { if (fillAll.value === '') return; rowsModel.forEach((m) => { if (m.amountInp) m.amountInp.value = fillAll.value; }); toast('Проставлено всем — не забудьте «Начислить»'); } }, 'Заполнить всем');
      const applyBtn = el('button', { class: 'btn-primary', onclick: apply }, '⚡ Начислить');
      box.appendChild(el('div', { class: 'hr-filters', style: 'justify-content:flex-end' }, [el('span', { class: 'hr-flab' }, 'Сумма всем:'), fillAll, fillBtn, applyBtn]));
      const head = el('div', { class: 'hr-row head hr-mass' }, ['#', 'ФИО', 'Отдел', 'Оклад', 'Текущее «' + opLabel + '»', 'Сумма к начислению'].map((h) => el('span', {}, h)));
      box.appendChild(el('div', { class: 'hr-list' }, [head, ...d.items.map((r, i) => {
        const m = rowsModel[i];
        const inpAmt = el('input', { class: 'hrf-inp hr-mass-inp', type: 'number', step: '1', placeholder: '0' });
        m.amountInp = inpAmt;
        return el('div', { class: 'hr-row hr-mass' }, [
          el('span', { class: 'hr-idx' }, String(i + 1)),
          el('span', { style: 'font-weight:700' }, r.full_name),
          el('span', { class: 'muted' }, r.department_name || '—'),
          el('span', { class: 'tnum muted' }, money(r.base_salary)),
          el('span', { class: 'tnum muted' }, r[field] ? money(r[field]) : '—'),
          el('span', {}, inpAmt),
        ]);
      })]));

      async function apply() {
        const items = rowsModel.map((m) => ({ employee_id: m.employee_id, amount: m.amountInp.value })).filter((x) => String(x.amount).trim() !== '' && Number(x.amount));
        if (!items.length) return toast('Впишите суммы хотя бы одному сотруднику', true);
        const label = (MASS_OPS.find((o) => o[0] === field) || ['', ''])[1];
        if (!confirm((massState.mode === 'set' ? 'Заменить' : 'Начислить') + ' «' + label + '» ' + items.length + ' сотрудникам за ' + monthLabel(massState.period) + '?')) return;
        applyBtn.disabled = true; applyBtn.textContent = 'Начисляю…';
        try { const rr = await post('/mass-op', { period: massState.period, field, mode: massState.mode, items }); toast('Начислено: ' + rr.applied); load(); }
        catch (e) { toast(e.message, true); applyBtn.disabled = false; }
      }
    }
  }

  // ================= ОТДЕЛЫ =================
  function renderDepartments() {
    const c = $('#hr-content');
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Отделы'), el('div', { class: 'hr-sub' }, 'Справочник отделов — чтобы не было разных написаний одного отдела.')]),
      el('button', { class: 'btn-primary hr-add', onclick: () => openDept(null) }, '+ Отдел'),
    ]));
    if (!DICTS.departments.length) { c.appendChild(el('div', { class: 'hr-empty' }, 'Отделов нет.')); return; }
    const head = el('div', { class: 'hr-row head hr-dept' }, ['#', 'Отдел', 'Сотрудников', 'Порядок', ''].map((h) => el('span', {}, h)));
    c.appendChild(el('div', { class: 'hr-list' }, [head, ...DICTS.departments.map((d, i) => el('div', { class: 'hr-row hr-dept', style: 'cursor:pointer', onclick: () => openDept(d) }, [
      el('span', { class: 'hr-idx' }, String(i + 1)),
      el('span', { style: 'font-weight:700' }, d.name),
      el('span', { class: 'tnum hr-dept-cnt', title: 'Показать сотрудников этого отдела', onclick: (ev) => { ev.stopPropagation(); empFilter.department = String(d.id); empFilter.status = 'active'; empFilter.q = ''; TAB = 'employees'; render(); } }, String(d.emp_count || 0) + ' →'),
      el('span', { class: 'muted' }, String(d.sort_order)),
      el('span', {}, '✏️'),
    ]))]));
  }
  function openDept(d) {
    d = d || {};
    const name = finp(d.name, { placeholder: 'Название отдела' });
    const sort = finp(d.sort_order != null ? d.sort_order : 100, { type: 'number' });
    const body = el('div', { class: 'hrf' }, [frow('Название', name), frow('Порядок', sort),
      d.id ? el('div', { class: 'hr-sub' }, 'Сотрудников в отделе: ' + (d.emp_count || 0)) : null]);
    const save = el('button', { class: 'btn-primary', onclick: async () => { try { await post('/department', { id: d.id, name: name.value, sort_order: sort.value }); toast('Сохранено'); closeModal(); await reloadDicts(); render(); } catch (e) { toast(e.message, true); } } }, 'Сохранить');
    const acts = [save];
    if (d.id) acts.unshift(el('button', { class: 'btn-ghost hrf-warn', onclick: () => archiveDept(d) }, 'В архив'));
    modal(d.id ? 'Отдел' : 'Новый отдел', body, acts);
  }
  // Архивация отдела: если есть сотрудники — сначала перенести их в другой отдел (или «без отдела»).
  async function archiveDept(d) {
    const cnt = d.emp_count || 0;
    if (!cnt) {
      if (!confirm('Архивировать отдел «' + d.name + '»?')) return;
      try { await post('/department/' + d.id + '/archive', {}); toast('В архиве'); $('#hr-modal-root').innerHTML = ''; await reloadDicts(); render(); } catch (e) { toast(e.message, true); }
      return;
    }
    const others = DICTS.departments.filter((x) => x.id !== d.id);
    const sel = fsel([{ v: '', t: '— Без отдела —' }, ...others.map((x) => ({ v: x.id, t: x.name }))], '');
    const body = el('div', { class: 'hrf' }, [
      el('div', { class: 'hr-sub', style: 'margin-bottom:6px' }, 'В отделе «' + d.name + '» ' + cnt + ' сотр. Их нельзя оставить без отдела «в никуда» — выбери, куда перенести.'),
      frow('Перенести в', sel),
    ]);
    const ok = el('button', { class: 'btn-primary hrf-warn', onclick: async () => {
      try { const r = await post('/department/' + d.id + '/archive', { move_to: sel.value }); toast('Перенесено ' + r.moved + ' · отдел в архиве'); $('#hr-modal-root').innerHTML = ''; await reloadDicts(); render(); }
      catch (e) { toast(e.message, true); }
    } }, 'Перенести и архивировать');
    modal('Архивация отдела — ' + d.name, body, [el('button', { class: 'btn-ghost', onclick: closeModal }, 'Отмена'), ok]);
  }

  boot();
})();
