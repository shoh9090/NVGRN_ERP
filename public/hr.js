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
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Сотрудники'), el('div', { class: 'hr-sub' }, 'Единый справочник. Клик — карточка. Сотрудников не удаляем — только увольняем/в архив.')]),
      el('button', { class: 'btn-primary hr-add', onclick: () => openEmp(null) }, '+ Сотрудник'),
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
      if (!d.items.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Никого не найдено. Добавьте сотрудника или измените фильтры.')); return; }
      const head = el('div', { class: 'hr-row head hr-emp' }, ['ФИО', 'Отдел', 'Должность', 'График', 'Оклад/ставка', 'Статус'].map((h) => el('span', {}, h)));
      box.appendChild(el('div', { class: 'hr-list' }, [head, ...d.items.map((e) => el('div', { class: 'hr-row hr-emp' + (e.status !== 'active' ? ' dim' : ''), onclick: () => openEmp(e) }, [
        el('span', { style: 'font-weight:700' }, e.full_name),
        el('span', {}, e.department_name || '—'),
        el('span', {}, e.position || '—'),
        el('span', { class: 'muted' }, SCHED_NAME[e.schedule_type] || '—'),
        el('span', { class: 'tnum' }, money(e.base_salary)),
        el('span', {}, el('span', { class: 'hr-st hr-st-' + e.status }, STATUS_NAME[e.status] || e.status)),
      ]))]));
    }
  }
  function kpi(label, val, cls) { return el('div', { class: 'hr-kpi' }, [el('div', { class: 'hr-kpi-l' }, label), el('div', { class: 'hr-kpi-v hr-kpi-' + cls }, String(val))]); }

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
