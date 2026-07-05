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
  const ruDate = (d) => d ? String(d).slice(0, 10).split('-').reverse().join('.') : '';

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
  let TAB = 'employees';
  const empFilter = { department: '', schedule: '', status: '', q: '' };
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
      tab('employees', '👥 Сотрудники'),
      tab('salary', '💵 Зарплата'),
      tab('timesheet', '🕒 Табель'),
      tab('payouts', '💳 Выплаты'),
      tab('reports', '📊 Отчёты'),
      tab('departments', '🏢 Отделы'),
    ]));
    main.appendChild(el('div', { id: 'hr-content' }));
  }
  function render() {
    shell();
    if (TAB === 'employees') return renderEmployees();
    if (TAB === 'salary') return renderSalary();
    if (TAB === 'departments') return renderDepartments();
    return renderSoon();
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
    const dSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { empFilter.department = e.target.value; load(); } }, [el('option', { value: '' }, 'Все отделы'), ...DICTS.departments.map((d) => el('option', { value: d.id, selected: String(d.id) === empFilter.department || null }, d.name))]);
    const sSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { empFilter.schedule = e.target.value; load(); } }, [el('option', { value: '' }, 'Все графики'), ...(DICTS.schedules || []).map((s) => el('option', { value: s.code, selected: s.code === empFilter.schedule || null }, s.name))]);
    const stSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { empFilter.status = e.target.value; load(); } }, [{ v: '', t: 'Активные' }, { v: 'fired', t: 'Уволенные' }, { v: 'archived', t: 'Архив' }].map((o) => el('option', { value: o.v, selected: o.v === empFilter.status || null }, o.t)));
    const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО / должности / телефону', value: empFilter.q, oninput: (e) => { empFilter.q = e.target.value; clearTimeout(window.__hrT); window.__hrT = setTimeout(load, 300); } });
    c.appendChild(el('div', { class: 'hr-filters' }, [dSel, sSel, stSel, q]));
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
        kpi('ФОТ (оклады, актив.)', money(d.fot) + ' сум', 'green'),
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
      if (isAdmin) bulk.appendChild(el('button', { class: 'btn-ghost hr-del', onclick: () => doBulk('delete', 'УДАЛИТЬ безвозвратно') }, '🗑 Удалить'));
      bulk.appendChild(el('button', { class: 'btn-ghost', onclick: () => { empSel.clear(); load(); } }, 'Снять'));
      box.appendChild(bulk);
      const selAll = el('input', { type: 'checkbox', class: 'hr-chk' });
      selAll.onclick = (ev) => { const on = ev.target.checked; empSel = new Set(on ? d.items.map((x) => x.id) : []); box.querySelectorAll('.hr-rowchk').forEach((c) => { c.checked = on; }); updBulk(); };
      const head = el('div', { class: 'hr-row head hr-emp' }, [selAll, ...['ФИО', 'Отдел', 'Должность', 'График', 'Оклад/ставка', 'Статус'].map((h) => el('span', {}, h))]);
      box.appendChild(el('div', { class: 'hr-list' }, [head, ...d.items.map((e) => {
        const chk = el('input', { type: 'checkbox', class: 'hr-chk hr-rowchk', onclick: (ev) => { ev.stopPropagation(); if (ev.target.checked) empSel.add(e.id); else empSel.delete(e.id); updBulk(); } });
        return el('div', { class: 'hr-row hr-emp' + (e.status !== 'active' ? ' dim' : '') }, [
          chk,
          el('span', { style: 'font-weight:700; cursor:pointer', onclick: () => openEmp(e) }, e.full_name),
          el('span', { onclick: () => openEmp(e) }, e.department_name || '—'),
          el('span', { onclick: () => openEmp(e) }, e.position || '—'),
          el('span', { class: 'muted' }, SCHED_NAME[e.schedule_type] || '—'),
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

  function openEmp(e) {
    e = e || {};
    const name = finp(e.full_name, { placeholder: 'Фамилия Имя Отчество' });
    const dept = fsel([{ v: '', t: '— отдел —' }, ...DICTS.departments.map((d) => ({ v: d.id, t: d.name }))], e.department_id || '');
    const pos = finp(e.position, { placeholder: 'Должность' });
    const sched = fsel([{ v: '', t: '— график —' }, ...(DICTS.schedules || []).map((s) => ({ v: s.code, t: s.name }))], e.schedule_type || '');
    const hire = finp(e.hire_date ? String(e.hire_date).slice(0, 10) : '', { type: 'date' });
    const base = finp(e.base_salary, { type: 'number', placeholder: 'Оклад / ставка' });
    const off = finp(e.salary_official, { type: 'number', placeholder: 'Официальная часть' });
    const unoff = finp(e.salary_unofficial, { type: 'number', placeholder: 'Неофициальная часть' });
    const phone = finp(e.phone, { placeholder: '998…' });
    const tg = finp(e.telegram_id, { placeholder: 'Telegram ID (если есть)' });
    const comment = finp(e.comment, { placeholder: 'Комментарий' });
    const body = el('div', { class: 'hrf' }, [
      frow('ФИО *', name), frow('Отдел', dept), frow('Должность', pos), frow('Тип графика', sched), frow('Дата приёма', hire),
      el('div', { class: 'hrf-sec' }, 'Зарплата'),
      frow('Оклад / ставка', base), frow('Официальная часть', off), frow('Неофициальная часть', unoff),
      el('div', { class: 'hrf-sec' }, 'Контакты'),
      frow('Телефон', phone), frow('Telegram ID', tg), frow('Комментарий', comment),
    ]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        await post('/employee', { id: e.id, full_name: name.value, department_id: dept.value, position: pos.value, schedule_type: sched.value, hire_date: hire.value, base_salary: base.value, salary_official: off.value, salary_unofficial: unoff.value, phone: phone.value, telegram_id: tg.value, comment: comment.value });
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
    const labels = { fired: 'Уволить', archived: 'В архив', active: 'Вернуть в актив' };
    if (!confirm(labels[st] + ' сотрудника «' + e.full_name + '»?')) return;
    try { await post('/employee/' + e.id + '/status', { status: st }); toast('Готово'); closeModal(); await reloadDicts(); render(); } catch (err) { toast(err.message, true); }
  }

  // ================= ЗАРПЛАТА =================
  const PR_STATUS = { draft: 'Черновик', approved: 'Утверждено', paid: 'Выплачено', cancelled: 'Отменено' };
  const ACCR_FIELDS = [['accr_salary', 'Оклад / фикса'], ['accr_fact', 'Факт по табелю'], ['accr_bonus', 'Бонусы KPI'], ['accr_premium', 'Премия'], ['accr_gsm', 'ГСМ / компенсации'], ['accr_company_debt', 'Долг компании'], ['accr_other', 'Другое начисление']];
  const DED_FIELDS = [['ded_fine', 'Штраф за опоздание'], ['ded_advance_card', 'Аванс на карту'], ['ded_advance_cash', 'Аванс наличными'], ['ded_hold', 'Удержание'], ['ded_emp_debt', 'Долг сотрудника'], ['ded_other', 'Другое удержание']];
  const PAID_FIELDS = [['paid_cash', 'Выплачено наличными'], ['paid_card', 'Выплачено на карту']];
  const salState = { period: '', department: '', status: '', q: '' };
  const curMonth = () => new Date().toISOString().slice(0, 7);
  const monthLabel = (ym) => { const [y, m] = ym.split('-'); return ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'][Number(m)] + ' ' + y; };

  async function renderSalary() {
    const c = $('#hr-content');
    if (!salState.period) salState.period = curMonth();
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Зарплата — ' + monthLabel(salState.period)), el('div', { class: 'hr-sub' }, 'Начисления за месяц. Клик по сотруднику — карточка с формулой. Итоги считаются сами.')]),
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
      const p = new URLSearchParams({ period: salState.period });
      ['department', 'status', 'q'].forEach((k) => { if (salState[k]) p.set(k, salState[k]); });
      let d; try { d = await api('/payroll?' + p.toString()); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
      box.innerHTML = '';
      const s = d.summary;
      box.appendChild(el('div', { class: 'hr-kpis hr-kpis-6' }, [
        kpi('ФОТ (начислено)', money(s.accrued), 'green'), kpi('Бонусы/KPI', money(s.bonus), 'ink'), kpi('Удержания', money(s.deducted), 'muted'),
        kpi('Авансы', money(s.advances), 'muted'), kpi('Выплачено', money(s.paid), 'ink'), kpi('К выплате', money(s.to_pay), 'green'),
      ]));
      box.appendChild(el('div', { class: 'hr-kpis hr-kpis-2', style: 'margin-bottom:14px' }, [kpi('Сотрудников', s.count, 'ink'), kpi('По 1С', money(s.amount_1c), 'muted')]));
      if (!d.items.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Нет сотрудников по фильтру.')); return; }
      const head = el('div', { class: 'hr-row head hr-sal' }, ['ФИО', 'Отдел', 'Дн. п/ф', 'Начислено', 'Удержано', 'Аванс', 'Выплачено', 'К выплате', 'Статус'].map((h) => el('span', {}, h)));
      box.appendChild(el('div', { class: 'hr-list' }, [head, ...d.items.map((r) => el('div', { class: 'hr-row hr-sal', onclick: () => openPayroll(r) }, [
        el('span', { style: 'font-weight:700' }, r.full_name),
        el('span', { class: 'muted' }, r.department_name || '—'),
        el('span', { class: 'tnum' }, (r.plan_days || 0) + '/' + (r.fact_days || 0)),
        el('span', { class: 'tnum' }, money(r.accrued)),
        el('span', { class: 'tnum' }, money(r.deducted)),
        el('span', { class: 'tnum' }, money((Number(r.ded_advance_card) || 0) + (Number(r.ded_advance_cash) || 0))),
        el('span', { class: 'tnum' }, money(r.paid)),
        el('span', { class: 'tnum', style: 'font-weight:800;color:#2e7d32' }, money(r.to_pay)),
        el('span', {}, el('span', { class: 'hr-st hr-pr-' + (r.id ? (r.status || 'draft') : 'none') }, r.id ? PR_STATUS[r.status || 'draft'] : 'нет')),
      ]))]));
    }
  }

  function openPayroll(r) {
    const F = {};
    const inp = (k) => { const i = finp(r[k] != null ? r[k] : '', { type: 'number', placeholder: '0' }); F[k] = i; return i; };
    const dinp = (k) => { const i = finp(r[k] ? String(r[k]).slice(0, 10) : '', { type: 'date' }); F[k] = i; return i; };
    const status = fsel(Object.keys(PR_STATUS).map((k) => ({ v: k, t: PR_STATUS[k] })), r.status || 'draft'); F.status = status;
    const comment = finp(r.comment, { placeholder: 'Комментарий' }); F.comment = comment;
    const amount1c = inp('amount_1c');
    // Итоги (живой пересчёт)
    const totAccr = el('b', {}), totDed = el('b', {}), totPaid = el('b', {}), totPay = el('b', { style: 'color:#2e7d32' }), diff1c = el('b', {});
    const recompute = () => {
      const val = (k) => Number(F[k] && F[k].value) || 0;
      const a = ACCR_FIELDS.reduce((s, [k]) => s + val(k), 0);
      const de = DED_FIELDS.reduce((s, [k]) => s + val(k), 0);
      const pd = PAID_FIELDS.reduce((s, [k]) => s + val(k), 0);
      totAccr.textContent = money(a); totDed.textContent = money(de); totPaid.textContent = money(pd);
      totPay.textContent = money(a - de - pd);
      diff1c.textContent = money((a - de) - val('amount_1c'));
    };
    const block = (title, fields) => el('div', {}, [el('div', { class: 'hrf-sec' }, title), ...fields.map(([k, label]) => { const i = inp(k); i.addEventListener('input', recompute); return frow(label, i); })]);
    const tab = block('Табель', [['plan_days', 'План дней'], ['fact_days', 'Факт дней'], ['plan_hours', 'План часов'], ['fact_hours', 'Факт часов']]);
    const body = el('div', { class: 'hrf' }, [
      el('div', { class: 'hr-note' }, r.full_name + ' · ' + (r.department_name || '—') + ' · ' + monthLabel(salState.period)),
      frow('Статус', status),
      tab,
      block('Начисления', ACCR_FIELDS),
      block('Удержания', DED_FIELDS),
      block('Выплаты', PAID_FIELDS),
      frow('Дата выплаты', dinp('pay_date')),
      frow('Сумма по 1С', (amount1c.addEventListener('input', recompute), amount1c)),
      frow('Комментарий', comment),
      el('div', { class: 'hr-formula' }, [
        el('div', {}, ['Начислено всего: ', totAccr]),
        el('div', {}, ['− Удержано всего: ', totDed]),
        el('div', {}, ['− Выплачено: ', totPaid]),
        el('div', { class: 'hr-formula-main' }, ['= К выплате: ', totPay]),
        el('div', { class: 'muted' }, ['Разница с 1С (начислено−удержано − 1С): ', diff1c]),
      ]),
    ]);
    recompute();
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      const payload = { employee_id: r.emp_id, period: salState.period, status: status.value, pay_date: F.pay_date.value, comment: comment.value };
      [...ACCR_FIELDS, ...DED_FIELDS, ...PAID_FIELDS].forEach(([k]) => { payload[k] = F[k].value; });
      ['plan_days', 'fact_days', 'plan_hours', 'fact_hours', 'amount_1c'].forEach((k) => { payload[k] = F[k].value; });
      try { await post('/payroll', payload); toast('Сохранено'); closeModal(); renderSalary(); } catch (e) { toast(e.message, true); }
    } }, 'Сохранить');
    modal('💵 Начисление — ' + r.full_name, body, [save]);
  }

  // ================= ОТДЕЛЫ =================
  function renderDepartments() {
    const c = $('#hr-content');
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Отделы'), el('div', { class: 'hr-sub' }, 'Справочник отделов — чтобы не было разных написаний одного отдела.')]),
      el('button', { class: 'btn-primary hr-add', onclick: () => openDept(null) }, '+ Отдел'),
    ]));
    if (!DICTS.departments.length) { c.appendChild(el('div', { class: 'hr-empty' }, 'Отделов нет.')); return; }
    const head = el('div', { class: 'hr-row head hr-dept' }, ['Отдел', 'Порядок', ''].map((h) => el('span', {}, h)));
    c.appendChild(el('div', { class: 'hr-list' }, [head, ...DICTS.departments.map((d) => el('div', { class: 'hr-row hr-dept', style: 'cursor:pointer', onclick: () => openDept(d) }, [
      el('span', { style: 'font-weight:700' }, d.name),
      el('span', { class: 'muted' }, String(d.sort_order)),
      el('span', {}, '✏️'),
    ]))]));
  }
  function openDept(d) {
    d = d || {};
    const name = finp(d.name, { placeholder: 'Название отдела' });
    const sort = finp(d.sort_order != null ? d.sort_order : 100, { type: 'number' });
    const body = el('div', { class: 'hrf' }, [frow('Название', name), frow('Порядок', sort)]);
    const save = el('button', { class: 'btn-primary', onclick: async () => { try { await post('/department', { id: d.id, name: name.value, sort_order: sort.value }); toast('Сохранено'); closeModal(); await reloadDicts(); render(); } catch (e) { toast(e.message, true); } } }, 'Сохранить');
    const acts = [save];
    if (d.id) acts.unshift(el('button', { class: 'btn-ghost hrf-warn', onclick: async () => { if (!confirm('Архивировать отдел «' + d.name + '»?')) return; try { await post('/department/' + d.id + '/archive', {}); toast('В архиве'); closeModal(); await reloadDicts(); render(); } catch (e) { toast(e.message, true); } } }, 'В архив'));
    modal(d.id ? 'Отдел' : 'Новый отдел', body, acts);
  }

  boot();
})();
