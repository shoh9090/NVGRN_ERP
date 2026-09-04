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
  // Полная сумма с разделителями и копейками — везде, кроме дашборда (там компактно).
  const money = (v) => (v == null || v === '' ? '—' : (Number(v) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }));
  const money2 = money;
  // Округлённая полная сумма — только для дашборда (без копеек).
  const moneyR = (v) => (v == null || v === '' ? '—' : Math.round(Number(v) || 0).toLocaleString('ru-RU'));
  // Компактно для сводок: 426.9 млн / 320 тыс — крупные суммы читаются легче.
  const moneyShort = (v) => {
    const n = Math.round(Number(v) || 0);
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' млн';
    if (Math.abs(n) >= 1e4) return Math.round(n / 1e3) + ' тыс';
    return n.toLocaleString('ru-RU');
  };
  const ruDate = (d) => d ? String(d).slice(0, 10).split('-').reverse().join('.') : '';
  // Денежное поле: разряды пробелом при вводе (15 000 000) + запятая как десятичный разделитель (до 2 знаков).
  // Пробелы и точки считаем разделителями тысяч и убираем; запятая — копейки. Раньше запятая стиралась и сумма росла в разы.
  const fmtDigits = (s) => {
    s = String(s == null ? '' : s).replace(/[\s.]/g, '');
    const neg = s.startsWith('-');
    s = s.replace(/[^\d,]/g, '');
    const ci = s.indexOf(',');
    const intRaw = (ci >= 0 ? s.slice(0, ci) : s).replace(/\D/g, '');
    let out = intRaw ? Number(intRaw).toLocaleString('ru-RU') : (ci >= 0 ? '0' : '');
    if (ci >= 0) out += ',' + s.slice(ci + 1).replace(/,/g, '').slice(0, 2);  // храним запятую и до 2 знаков (в т.ч. при наборе)
    return out ? (neg ? '-' : '') + out : (neg ? '-' : '');
  };
  const mval = (i) => {
    const s = String(i.value || '').replace(/[\s.]/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
    return (s === '' || s === '-' || s === '.') ? '' : s;
  };
  function minp(val, attrs) {
    const i = finp((val == null || val === '') ? '' : Number(val).toLocaleString('ru-RU', { maximumFractionDigits: 2 }), Object.assign({ inputmode: 'decimal', placeholder: '0' }, attrs || {}));
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

  // Окно наличных выплат сотрудника (клик по «💵 касса») — с переходом в саму транзакцию (Касса).
  function openCashTxs(txs, title) {
    const list = (txs || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    // «Не учитывать» — исключить выплату из зарплаты (остаётся в Кассе). Напр. выплата за прошлый
    // месяц, который уже внесён импортом. Обратимо кнопкой «Учитывать».
    const toggleHide = async (t, hidden) => {
      try { await post('/salary/cash-hide', { ids: [t.tx_id], hidden }); toast(hidden ? 'Исключено из зарплаты' : 'Снова учитывается'); closeModal(); renderSalary(); }
      catch (e) { toast(e.message, true); }
    };
    const body = el('div', {}, list.length ? list.map((t) => el('div', { style: 'display:flex;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid #eee;align-items:center' + (t.hidden ? ';opacity:.5' : '') }, [
      el('span', { style: 'min-width:88px' }, String(t.date)),
      el('span', { style: 'min-width:70px' }, t.kind === 'advance' ? 'аванс' : 'зарплата'),
      el('span', { class: 'tnum', style: 'min-width:110px;font-weight:700' + (t.hidden ? ';text-decoration:line-through' : '') }, money(t.amount)),
      el('span', { class: 'muted', style: 'flex:1' }, (t.purpose || '') + (t.hidden ? ' · не учитывается' : '')),
      t.hidden
        ? el('button', { class: 'btn-ghost', style: 'font-size:12px;padding:3px 8px', onclick: () => toggleHide(t, false) }, 'Учитывать')
        : el('button', { class: 'btn-ghost', style: 'font-size:12px;padding:3px 8px', title: 'Не учитывать в зарплате (останется в Кассе)', onclick: () => toggleHide(t, true) }, 'Не учитывать'),
      el('a', { href: '/cash#tx=' + t.tx_id, target: '_blank', style: 'font-size:12px;white-space:nowrap;color:var(--forest);font-weight:700' }, 'в Кассе →'),
    ])) : [el('div', { class: 'hr-empty' }, 'Нет наличных выплат за период')]);
    modal(title, body, [el('button', { class: 'btn-primary', onclick: closeModal }, 'Закрыть')]);
  }

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
      tab('settlements', '🧾 Расчёты'),
      tab('events', '🗂 Кадровая история'),
      tab('departments', '🏢 Отделы'),
    ]));
    main.appendChild(el('div', { id: 'hr-content' }));
  }
  function render() {
    shell();
    if (TAB === 'dashboard') return renderDashboard();
    if (TAB === 'employees') return renderEmployees();
    if (TAB === 'salary') return renderSalary();
    if (TAB === 'payouts') return renderPayouts();
    if (TAB === 'settlements') return renderSettlements();
    if (TAB === 'massops') return renderMassOps();
    if (TAB === 'timesheet') return renderTimesheet();
    if (TAB === 'events') return renderEvents();
    if (TAB === 'departments') return renderDepartments();
    return renderSoon();
  }

  // ================= РАСЧЁТЫ С СОТРУДНИКАМИ =================
  // Накопительно за всё время: сколько начислили, сколько выдали и сколько
  // остались должны. Кадры считают помесячно, и этот вопрос задать было негде.
  // Год выбирается отдельно: 2026-й идёт с июня, дальше календарные. Долг на
  // границе года не обнуляется — переходит входящим остатком.
  const setlState = { department: '', q: '', only: '', year: 0, upto: 0 };
  let SETL = null;
  const MON_RU = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const dtRu = (s) => { try { return new Date(s).toLocaleDateString('ru-RU'); } catch (e) { return String(s || ''); } };

  async function renderSettlements() {
    const c = $('#hr-content');
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Расчёты с сотрудниками'),
        el('div', { class: 'hr-sub' }, 'Сколько начислили, сколько выдали и сколько остались должны. Долг на конец года переходит на следующий. Клик по строке — лицевой счёт помесячно.')]),
    ]));
    const bar = el('div', { class: 'hr-filters', id: 'hr-setl-bar' }); c.appendChild(bar);
    const box = el('div', { id: 'hr-setl-box' }); c.appendChild(box);
    await load();

    async function load() {
      const box2 = $('#hr-setl-box');
      box2.innerHTML = '<div class="hr-loading">Считаю по месяцам…</div>';
      const p = new URLSearchParams();
      if (setlState.year) p.set('year', setlState.year);
      if (setlState.upto) p.set('upto', setlState.upto);
      try { SETL = await api('/settlements?' + p.toString()); }
      catch (e) { box2.innerHTML = ''; box2.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
      setlState.year = SETL.year; setlState.upto = SETL.upto;
      drawBar(); draw();
    }

    function drawBar() {
      bar.innerHTML = '';
      const ySel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { setlState.year = Number(e.target.value); setlState.upto = 0; load(); } },
        (SETL.years || []).map((y) => el('option', { value: String(y), selected: y === SETL.year || null }, String(y) + ' год')));
      const months = [];
      for (let m = SETL.first_month; m <= SETL.last_month; m++) months.push(m);
      const mSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { setlState.upto = Number(e.target.value); load(); } },
        months.map((m) => el('option', { value: String(m), selected: m === SETL.upto || null }, MON_RU[m])));
      const dSel = deptMulti(setlState, 'department', draw, true);
      const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО', value: setlState.q,
        oninput: (e) => { setlState.q = e.target.value; clearTimeout(window.__setlT); window.__setlT = setTimeout(draw, 250); } });
      bar.appendChild(el('span', { class: 'hr-flab' }, 'Год:')); bar.appendChild(ySel);
      bar.appendChild(el('span', { class: 'hr-flab' }, 'По состоянию на:')); bar.appendChild(mSel);
      bar.appendChild(dSel); bar.appendChild(q);
    }

    function draw() {
      const box2 = $('#hr-setl-box'); if (!box2) return;
      box2.innerHTML = '';
      const t = SETL.totals || {};
      box2.appendChild(el('div', { class: 'hr-kpis' }, [
        kpi('Долг на начало года', money(t.opening), 'muted'),
        kpi('Начислено за год', money(t.accrued), 'ink'),
        kpi('Выплачено за год', money(t.paid), 'green'),
        kpi('Должны сейчас', money(t.debt), 'red', () => { setlState.only = setlState.only === 'debt' ? '' : 'debt'; draw(); }),
      ]));
      if (t.overpaid > 0.5) {
        box2.appendChild(el('div', { class: 'hr-note' }, [
          'Переплата: ' + money(t.overpaid) + '. ',
          el('a', { href: 'javascript:void(0)', onclick: () => { setlState.only = setlState.only === 'overpaid' ? '' : 'overpaid'; draw(); } }, 'показать'),
        ]));
      }

      box2.appendChild(setlChart(SETL.chart || []));
      box2.appendChild(setlDepts(SETL.by_dept || []));

      const depts = String(setlState.department || '').split(',').filter(Boolean);
      const needle = setlState.q.trim().toLowerCase();
      const items = (SETL.items || []).filter((x) => {
        if (depts.length) {
          const ok = depts.includes(String(x.department_id)) || (depts.includes('__none__') && !x.department_id);
          if (!ok) return false;
        }
        if (needle && !(x.full_name || '').toLowerCase().includes(needle)) return false;
        if (setlState.only === 'debt' && !(x.balance > 0.5)) return false;
        if (setlState.only === 'overpaid' && !(x.balance < -0.5)) return false;
        return true;
      });
      if (setlState.only) {
        box2.appendChild(el('div', { class: 'hr-note' }, [
          setlState.only === 'debt' ? 'Показаны только те, кому должны. ' : 'Показаны только переплаты. ',
          el('a', { href: 'javascript:void(0)', onclick: () => { setlState.only = ''; draw(); } }, 'показать всех'),
        ]));
      }
      if (!items.length) { box2.appendChild(el('div', { class: 'hr-empty' }, 'Никого не найдено.')); return; }

      const head = el('div', { class: 'hr-row head hr-setl' },
        ['#', 'ФИО', 'Отдел', 'На начало', 'Начислено', 'Выплачено', 'Остаток', 'Тянется с'].map((h) => el('span', {}, h)));
      box2.appendChild(el('div', { class: 'hr-list' }, [head, ...items.map((x, i) => el('div', {
        class: 'hr-row hr-setl' + (x.emp_status !== 'active' ? ' dim' : ''),
        style: 'cursor:pointer', onclick: () => openSettlementCard(x),
      }, [
        el('span', { class: 'hr-idx' }, String(i + 1)),
        el('span', { style: 'font-weight:700' }, x.full_name),
        el('span', { class: 'muted' }, x.department_name || '—'),
        el('span', { class: 'tnum muted' }, x.opening ? money(x.opening) : '—'),
        el('span', { class: 'tnum' }, money(x.accrued)),
        el('span', { class: 'tnum' }, money(x.paid)),
        el('span', { class: 'tnum', style: 'font-weight:800;' + (x.balance > 0.5 ? 'color:var(--red)' : (x.balance < -0.5 ? 'color:#8a6d1f' : '')) },
          money(x.balance)),
        el('span', { class: 'muted' }, x.since === 'opening' ? 'с прошлого года' : (x.since ? monthLabel(x.since) : '—')),
      ]))]));
    }
  }

  // График по месяцам: столбики «начислено / выплачено» и линия общего долга.
  // Рисуем своим SVG — как на дашборде Претензий, без внешних библиотек.
  function setlChart(rows) {
    if (!rows.length) return el('div');
    const W = 780, H = 190, padL = 8, padB = 26, padT = 10;
    const innerW = W - padL * 2, innerH = H - padB - padT;
    const maxVal = Math.max(1, ...rows.map((r) => Math.max(r.accrued, r.paid, r.balance)));
    const step = innerW / rows.length;
    const bw = Math.min(26, step / 3);
    const y = (v) => padT + innerH - (v / maxVal) * innerH;
    const parts = [];
    rows.forEach((r, i) => {
      const cx = padL + step * i + step / 2;
      parts.push('<rect x="' + (cx - bw - 2) + '" y="' + y(r.accrued) + '" width="' + bw + '" height="' + (padT + innerH - y(r.accrued)) + '" rx="3" fill="#c8d9bd"></rect>');
      parts.push('<rect x="' + (cx + 2) + '" y="' + y(r.paid) + '" width="' + bw + '" height="' + (padT + innerH - y(r.paid)) + '" rx="3" fill="#8cc63f"></rect>');
      parts.push('<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#7c8a7f">'
        + (MON_RU[Number(r.period.slice(5, 7))] || '').slice(0, 3) + '</text>');
    });
    const pts = rows.map((r, i) => (padL + step * i + step / 2) + ',' + y(r.balance)).join(' ');
    parts.push('<polyline points="' + pts + '" fill="none" stroke="#bf3f28" stroke-width="2"></polyline>');
    rows.forEach((r, i) => parts.push('<circle cx="' + (padL + step * i + step / 2) + '" cy="' + y(r.balance) + '" r="3" fill="#bf3f28"></circle>'));
    return el('div', { class: 'hr-card', style: 'margin-bottom:12px' }, [
      el('div', { class: 'hr-chart-legend' }, [
        el('span', {}, [el('i', { style: 'background:#c8d9bd' }), ' начислено']),
        el('span', {}, [el('i', { style: 'background:#8cc63f' }), ' выплачено']),
        el('span', {}, [el('i', { style: 'background:#bf3f28' }), ' долг на конец месяца']),
      ]),
      el('div', { html: '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:190px">' + parts.join('') + '</svg>' }),
    ]);
  }

  function setlDepts(rows) {
    if (!rows.length) return el('div');
    const max = Math.max(1, ...rows.map((r) => r.debt));
    return el('div', { class: 'hr-card', style: 'margin-bottom:12px' }, [
      el('div', { class: 'hr-card-h' }, 'Долг по отделам'),
      ...rows.filter((r) => r.debt > 0.5 || r.accrued > 0.5).slice(0, 10).map((r) => el('div', { class: 'hr-dbar' }, [
        el('span', { class: 'hr-dbar-n' }, r.name + ' · ' + r.people + ' чел.'),
        el('span', { class: 'hr-dbar-t' }, el('span', { class: 'hr-dbar-f', style: 'width:' + Math.max(2, (r.debt / max) * 100) + '%' })),
        el('span', { class: 'hr-dbar-v' }, money(r.debt)),
      ])),
    ]);
  }


  // Лицевой счёт: помесячно, с накопленным остатком в последнем столбце.
  function openSettlementCard(x) {
    // Первой строкой — что перешло с прошлого года, иначе непонятно, откуда
    // взялся остаток, если в этом году движений почти не было.
    const rows = (x.opening ? [el('tr', { style: 'color:var(--ink-faint)' }, [
      el('td', {}, 'На начало года'),
      el('td', { class: 'tnum' }, '—'), el('td', { class: 'tnum' }, '—'),
      el('td', { class: 'tnum' }, '—'), el('td', { class: 'tnum' }, '—'),
      el('td', { class: 'tnum', style: 'font-weight:800' }, money(x.opening)),
    ])] : []).concat((x.months || []).map((m) => el('tr', {}, [
      el('td', {}, monthLabel(m.period)),
      el('td', { class: 'tnum' }, money(m.accrued)),
      el('td', { class: 'tnum' }, money(m.deducted)),
      el('td', { class: 'tnum' }, money(m.net)),
      el('td', { class: 'tnum' }, money(m.paid)),
      el('td', { class: 'tnum', style: 'font-weight:800;' + (m.balance > 0.5 ? 'color:var(--red)' : '') }, money(m.balance)),
    ])));
    const body = el('div', {}, [
      el('div', { class: 'hr-note' }, x.full_name + ' · ' + (x.department_name || '—')
        + (x.emp_status !== 'active' ? ' · уволен' : '')),
      rows.length ? el('div', { class: 'oe-table-wrap', style: 'max-height:56vh;margin-top:8px' },
        el('table', { class: 'dict-table' }, [
          el('thead', {}, el('tr', {}, ['Месяц', 'Начислено', 'Удержано', 'К выплате', 'Выплачено', 'Остаток']
            .map((h, i) => el('th', { style: i ? 'text-align:right' : '' }, h)))),
          el('tbody', {}, rows),
        ]))
        : el('div', { class: 'hr-empty' }, 'В этом году движений не было.'),
      el('div', { class: 'hr-formula', style: 'margin-top:10px' }, [
        el('div', {}, 'Начислено всего: ' + money(x.accrued)),
        el('div', {}, '− Выплачено всего: ' + money(x.paid)),
        el('div', { class: 'hr-formula-main' }, (x.balance < -0.5 ? '= Переплата: ' : '= Должны: ') + money(Math.abs(x.balance))),
      ]),
    ]);
    modal('Лицевой счёт — ' + x.full_name, body, [el('button', { class: 'btn-primary', onclick: closeModal }, 'Закрыть')]);
  }

  // ================= КАДРОВАЯ ИСТОРИЯ =================
  const EV = {
    hire: { t: 'Приём', c: '#2e7d32' }, fire: { t: 'Увольнение', c: '#c0392b' },
    vacation: { t: 'Отпуск', c: '#0d7d8c' }, sick: { t: 'Больничный', c: '#b25b00' },
    transfer: { t: 'Перемещение', c: '#5b3da8' }, position: { t: 'Смена должности', c: '#163a28' },
    salary: { t: 'Смена оклада', c: '#c77800' }, schedule: { t: 'Смена графика', c: '#3f6a16' }, other: { t: 'Прочее', c: '#7c8579' },
  };
  const evState = { employee: '', department: '', type: '', from: '', to: '', q: '' };
  function evDetail(x) {
    if (x.event_type === 'vacation' || x.event_type === 'sick') return ruDate(x.event_date) + (x.date_to ? ' — ' + ruDate(x.date_to) : '') + (x.comment ? ' · ' + x.comment : '');
    if (x.from_text || x.to_text) return (x.from_text || '—') + ' → ' + (x.to_text || '—') + (x.comment ? ' · ' + x.comment : '');
    return x.comment || '';
  }
  async function renderEvents() {
    const c = $('#hr-content');
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Кадровая история'), el('div', { class: 'hr-sub' }, 'Приём, увольнение, отпуск, больничный, перемещения, смена оклада/должности/графика. Изменения в карточке пишутся сюда сами.')]),
      el('button', { class: 'btn-primary', style: 'align-self:flex-start', onclick: () => openEventForm() }, '+ Событие'),
    ]));
    const typeSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { evState.type = e.target.value; loadEv(); } }, [{ v: '', t: 'Все события' }].concat(Object.keys(EV).map((k) => ({ v: k, t: EV[k].t }))).map((o) => el('option', { value: o.v, selected: o.v === evState.type || null }, o.t)));
    const dSel = deptMulti(evState, 'department', loadEv);
    const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО', value: evState.q, oninput: (e) => { evState.q = e.target.value; clearTimeout(window.__evS); window.__evS = setTimeout(loadEv, 300); } });
    // Период — общим компонентом Hub, как в Кассе, Закупе и Претензиях.
    const period = HubDateRange.create({
      mode: 'range', from: evState.from, to: evState.to,
      onChange: (v) => { evState.from = v.from; evState.to = v.to; loadEv(); },
    });
    c.appendChild(el('div', { class: 'hr-filters' }, [period, typeSel, dSel, q]));
    c.appendChild(el('div', { id: 'hr-ev-box' }));
    loadEv();
  }
  async function loadEv() {
    const box = $('#hr-ev-box'); if (!box) return;
    const sp = new URLSearchParams();
    if (evState.type) sp.set('type', evState.type);
    if (evState.department) sp.set('department', evState.department);
    if (evState.q) sp.set('q', evState.q);
    if (evState.from) sp.set('from', evState.from);
    if (evState.to) sp.set('to', evState.to);
    let d; try { d = await api('/events?' + sp.toString()); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
    box.innerHTML = '';
    const items = d.items || [];
    if (!items.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Событий нет.')); return; }
    const head = el('tr', {}, ['Дата', 'Сотрудник', 'Отдел', 'Событие', 'Детали', ''].map((h) => el('th', { style: 'padding:8px 10px;background:#f2f5f1;text-align:left;white-space:nowrap' }, h)));
    const tb = el('tbody', {}, items.map((x) => el('tr', { style: 'border-bottom:0.5px solid var(--line,#e3e0d4)' }, [
      el('td', { style: 'padding:7px 10px;white-space:nowrap' }, [
        el('div', {}, ruDate(x.event_date)),
        x.created_at ? el('div', { style: 'font-size:11px;color:#9aa295' }, 'внесено ' + ruDate(String(x.created_at).slice(0, 10))) : null,
      ]),
      el('td', { style: 'padding:7px 10px;font-weight:700' }, x.full_name),
      el('td', { style: 'padding:7px 10px;color:#7c8579' }, x.dept_name || '—'),
      el('td', { style: 'padding:7px 10px;white-space:nowrap' }, el('span', { style: 'font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;color:#fff;background:' + ((EV[x.event_type] || EV.other).c) }, (EV[x.event_type] || EV.other).t)),
      el('td', { style: 'padding:7px 10px' }, evDetail(x)),
      el('td', { style: 'padding:7px 10px;text-align:right' }, el('button', { class: 'btn-ghost hr-del', style: 'padding:3px 8px;font-size:12px', title: 'Удалить', onclick: async () => { if (!confirm('Удалить это событие?')) return; try { await post('/events/' + x.id + '/delete', {}); loadEv(); } catch (e) { toast(e.message, true); } } }, '🗑')),
    ])));
    box.appendChild(el('div', { style: 'overflow-x:auto;border:0.5px solid var(--line,#e3e0d4);border-radius:12px;background:#fff' }, el('table', { style: 'border-collapse:collapse;width:100%;font-size:13px' }, [el('thead', {}, head), tb])));
  }
  async function openEventForm(presetEmpId) {
    let emps = [];
    try { emps = (await api('/employees?status=')).items || []; } catch (e) { return toast(e.message, true); }
    const active = emps.filter((e) => e.status !== 'archived');
    const empSel = fsel(active.map((e) => ({ v: e.id, t: e.full_name })), presetEmpId || (active[0] && active[0].id) || '');
    const typeSel = fsel([['transfer', 'Перемещение'], ['salary', 'Изменение оклада'], ['vacation', 'Отпуск'], ['sick', 'Больничный'], ['other', 'Прочее'], ['hire', 'Приём'], ['fire', 'Увольнение']].map(([v, t]) => ({ v, t })), 'transfer');
    const dFrom = finp(new Date().toISOString().slice(0, 10), { type: 'date' });
    const dTo = finp('', { type: 'date' });
    const dToRow = frow('По (для отпуска/больничного)', dTo);
    const deptSel = fsel([{ v: '', t: '— выберите отдел —' }, ...DICTS.departments.map((d) => ({ v: d.id, t: d.name }))], '');
    const deptRow = frow('Куда (отдел)', deptSel);
    // Должность при перемещении (часто меняется) — подставляем текущую, чтобы обновить в карточке.
    const curEmp = () => active.find((e) => String(e.id) === String(empSel.value)) || {};
    const posInp = finp(curEmp().position || '', { placeholder: 'должность' });
    const posRow = frow('Должность (новая)', posInp);
    const schedSel = fsel([{ v: '', t: '— не менять —' }, ...(DICTS.schedules || []).map((s) => ({ v: s.code, t: s.name }))], curEmp().schedule_type || '');
    const schedRow = frow('График (новый)', schedSel);
    const salInp = minp(curEmp().base_salary || '', { placeholder: 'новый оклад' });
    const salRow = frow('Новый оклад', salInp);
    empSel.onchange = () => { posInp.value = curEmp().position || ''; schedSel.value = curEmp().schedule_type || ''; salInp.value = curEmp().base_salary ? Number(curEmp().base_salary).toLocaleString('ru-RU') : ''; };
    const comment = finp('', { placeholder: 'Комментарий' });
    const applyType = () => {
      dToRow.style.display = (typeSel.value === 'vacation' || typeSel.value === 'sick') ? '' : 'none';
      deptRow.style.display = (typeSel.value === 'transfer') ? '' : 'none';
      posRow.style.display = (typeSel.value === 'transfer') ? '' : 'none';
      schedRow.style.display = (typeSel.value === 'transfer') ? '' : 'none';
      salRow.style.display = (typeSel.value === 'salary') ? '' : 'none';
    };
    typeSel.onchange = applyType; applyType();
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      if (!empSel.value) return toast('Выберите сотрудника', true);
      if (typeSel.value === 'transfer' && !deptSel.value) return toast('Выберите отдел, куда переводим', true);
      if (typeSel.value === 'salary' && !(Number(mval(salInp)) > 0)) return toast('Укажите новый оклад', true);
      try {
        const rr = await post('/events', { employee_id: empSel.value, event_type: typeSel.value, event_date: dFrom.value, date_to: (dToRow.style.display !== 'none' ? dTo.value : null) || null, to_department_id: (typeSel.value === 'transfer' ? deptSel.value : null), to_position: (typeSel.value === 'transfer' ? posInp.value : null), to_schedule: (typeSel.value === 'transfer' ? schedSel.value : null), new_salary: (typeSel.value === 'salary' ? mval(salInp) : null), comment: comment.value });
        toast(typeSel.value === 'transfer' ? 'Сотрудник переведён ✅' : (typeSel.value === 'salary' ? 'Оклад изменён ✅' : 'Событие добавлено'));
        // Увольнение/приём меняют и карточку — говорим об этом вслух, чтобы не
        // пришлось идти проверять вкладку «Сотрудники».
        if (rr && rr.status_note) toast(rr.status_note + ' ✅');
        // Смена оклада пересчитывает и уже начисленные месяцы — честно предупреждаем какие.
        if (rr && rr.recalculated && rr.recalculated.length) {
          toast('⚠ Пересчитаны уже начисленные месяцы: ' + rr.recalculated.map(monthLabel).join(', ') + ' — проверьте суммы', true);
        }
        closeModal(); if (TAB === 'events') loadEv();
      } catch (e) { toast(e.message, true); }
    } }, 'Добавить');
    modal('Кадровое событие', el('div', { class: 'hrf' }, [frow('Сотрудник', empSel), frow('Тип', typeSel), deptRow, posRow, schedRow, salRow, frow('Дата (с)', dFrom), dToRow, frow('Комментарий', comment)]), [save]);
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
    const mInp = HubDateRange.create({
      mode: 'month', period: dashState.period,
      onChange: (v) => { dashState.period = v.period || curMonth(); render(); },
    });
    c.appendChild(el('div', { class: 'hr-filters' }, [mInp]));
    const box = el('div', {}); c.appendChild(box);
    box.innerHTML = '<div class="hr-loading">Считаю…</div>';
    let d; try { d = await api('/dashboard?period=' + dashState.period); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
    box.innerHTML = '';
    const t = d.totals;
    // Понятная формула: Начислено − Удержания − Выплачено (с авансами) = К выплате.
    const uderzh = (Number(t.deducted) || 0) - (Number(t.advances) || 0);   // удержания без авансов
    const vyplacheno = (Number(t.paid) || 0) + (Number(t.advances) || 0);    // выплачено вместе с авансами
    box.appendChild(el('div', { class: 'hr-kpis hr-kpis-4' }, [
      kpi('Начислено (ФОТ)', moneyShort(t.accrued), 'green', () => openBreakdown('Начислено', d.emps || [], (r) => r.accrued, dashState.period)),
      kpi('− Удержания', moneyShort(uderzh), 'muted', () => openBreakdown('Удержания', d.emps || [], (r) => (Number(r.deducted) || 0) - (Number(r.advances) || 0), dashState.period)),
      kpi('− Выплачено', moneyShort(vyplacheno), 'ink', () => openBreakdown('Выплачено (с авансами)', d.emps || [], (r) => (Number(r.paid) || 0) + (Number(r.advances) || 0), dashState.period), t.advances ? 'в т.ч. аванс ' + moneyShort(t.advances) : ''),
      // Переплату показываем только если она реальная (не копейки от округления) и есть кому.
      kpi('= К выплате', moneyShort(t.to_pay), 'green',
        (t.overpay >= 1 && (d.overpaid || []).length) ? () => openOverpaid(d.overpaid) : () => openBreakdown('К выплате (остаток)', d.emps || [], (r) => Math.max(0, r.to_pay), dashState.period),
        (t.overpay >= 1 && (d.overpaid || []).length) ? 'переплата ' + moneyShort(t.overpay) + ' · клик' : 'клик'),
    ]));
    box.appendChild(el('div', { class: 'hr-sub', style: 'margin:2px 0 6px' }, 'Начислено − Удержания − Выплачено (с авансами) = К выплате.' + (t.overpay >= 1 ? ' Переплата ' + moneyShort(t.overpay) + ' (кому-то выдали больше — на общий остаток не влияет).' : '') + '  ·  Сотрудников: ' + t.count));
    // Налоги на ФОТ (ручной ввод по видам): ИНПС, НДФЛ, соцналог + итог и % от ФОТ.
    let tax; try { tax = await api('/fot-taxes?period=' + dashState.period); } catch (e) { tax = { inps: 0, ndfl: 0, social: 0 }; }
    const taxInps = minp(tax.inps || '', { placeholder: '0' });
    const taxNdfl = minp(tax.ndfl || '', { placeholder: '0' });
    const taxSoc = minp(tax.social || '', { placeholder: '0' });
    const taxTotEl = el('b', {}); const taxPctEl = el('span', { class: 'muted' });
    const recalcTax = () => {
      const tot = (Number(mval(taxInps)) || 0) + (Number(mval(taxNdfl)) || 0) + (Number(mval(taxSoc)) || 0);
      taxTotEl.textContent = money(tot);
      const fot = Number(t.accrued) || 0;
      taxPctEl.textContent = fot > 0 ? (' · ' + (tot / fot * 100).toFixed(1) + '% от ФОТ') : '';
    };
    [taxInps, taxNdfl, taxSoc].forEach((i) => i.addEventListener('input', recalcTax));
    const taxField = (label, inp) => el('div', { style: 'display:flex;flex-direction:column;gap:3px' }, [el('span', { style: 'font-size:12px;color:#7c8579;font-weight:700' }, label), inp]);
    const taxSave = el('button', { class: 'btn-primary', onclick: async () => {
      try { await post('/fot-taxes', { period: dashState.period, inps: mval(taxInps), ndfl: mval(taxNdfl), social: mval(taxSoc) }); toast('Налоги сохранены ✅'); } catch (e) { toast(e.message, true); }
    } }, 'Сохранить');
    box.appendChild(el('div', { class: 'hr-chart-card', style: 'margin:10px 0;padding:14px 16px' }, [
      el('div', { class: 'hr-h2', style: 'font-size:16px;margin:0 0 8px' }, '🧾 Налоги на ФОТ — ' + monthLabel(dashState.period)),
      el('div', { style: 'display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap' }, [taxField('ИНПС', taxInps), taxField('НДФЛ', taxNdfl), taxField('Соцналог', taxSoc), taxSave]),
      el('div', { style: 'margin-top:10px;font-size:14px' }, ['Итого налогов: ', taxTotEl, taxPctEl]),
    ]));
    recalcTax();
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
      el('span', { class: 'tnum' }, moneyR(x.accrued)),
      el('span', { class: 'tnum', style: 'color:#2e7d32;font-weight:700' }, moneyR(x.to_pay)),
      el('span', { class: 'tnum muted' }, moneyR(x.paid)),
    ]))]));
  }
  // ================= ВЫПЛАТЫ =================
  async function renderPayouts() {
    const c = $('#hr-content');
    if (!payState.period) payState.period = curMonth();
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Выплаты — ' + monthLabel(payState.period)), el('div', { class: 'hr-sub' }, 'Выдача зарплаты: остаток, статусы, частичные и массовые выплаты. Срок — до 10 числа следующего месяца.')]),
      el('div', { class: 'hr-head-btns' }, [
        // Импорт выписки по картам — отмечает, кому и сколько реально ушло на карту.
        el('button', { class: 'btn-ghost', title: 'Загрузить выписку по картам и отметить выплаты', onclick: () => openCardStatementImport(payState.period) }, '🏦 Выписка по картам'),
        el('button', { id: 'hr-lock-btn', class: 'btn-ghost', onclick: openHrPeriodLock }, '🔒 Закрытие месяца'),
      ]),
    ]));
    showHrLockBadge();
    const mInp = HubDateRange.create({
      mode: 'month', period: payState.period,
      onChange: (v) => { payState.period = v.period || curMonth(); render(); },
    });
    const dSel = deptMulti(payState, 'department', load);
    const stSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { payState.status = e.target.value; load(); } }, [{ v: '', t: 'Все статусы' }, { v: 'pending', t: 'Ожидает' }, { v: 'partial', t: 'Частично' }, { v: 'overdue', t: 'Просрочено' }, { v: 'paid', t: 'Оплачено' }, { v: 'no_accrual', t: 'Без начисления' }].map((o) => el('option', { value: o.v, selected: o.v === payState.status || null }, o.t)));
    const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО', value: payState.q, oninput: (e) => { payState.q = e.target.value; clearTimeout(window.__hrP); window.__hrP = setTimeout(load, 300); } });
    const exportBtn = el('button', { class: 'btn-ghost', onclick: () => { const sp = new URLSearchParams({ period: payState.period }); ['department', 'status', 'q'].forEach((k) => { if (payState[k]) sp.set(k, payState[k]); }); window.location = '/hr/api/payouts-export.xlsx?' + sp.toString(); }, title: 'Скачать «К выплате» в Excel (с учётом фильтров)' }, '📥 Excel');
    c.appendChild(el('div', { class: 'hr-filters' }, [mInp, dSel, stSel, q, exportBtn]));
    const box = el('div', {}); c.appendChild(box);
    load();

    async function load() {
      box.innerHTML = '<div class="hr-loading">Считаю…</div>';
      paySel = new Set();
      const p = new URLSearchParams({ period: payState.period });
      ['department', 'status', 'q'].forEach((k) => { if (payState[k]) p.set(k, payState[k]); });
      let d; try { d = await api('/payouts?' + p.toString()); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
      box.innerHTML = '';
      const s = d.summary;
      box.appendChild(el('div', { class: 'hr-kpis hr-kpis-4', style: 'margin-bottom:12px' }, [
        kpi('К выплате (всего)', money(s.net), 'green'), kpi('Выплачено', money(s.paid), 'ink'),
        kpi('Остаток', money(s.remainder), 'green'), kpi('Просрочено', money(s.overdue), 'muted'),
      ]));
      // Наличные выплаты из Кассы без привязки к сотруднику — разбираются здесь.
      const unmatchedBox = cashUnmatchedBlock(d.cash_unmatched);
      if (unmatchedBox) box.appendChild(unmatchedBox);
      const payable = d.items.filter((x) => x.remainder > 0.5);
      const bulk = el('div', { class: 'hr-bulkbar', style: 'display:none' });
      const bulkN = el('span', { class: 'hr-bulk-n' }, '');
      const updBulk = () => { bulk.style.display = paySel.size ? 'flex' : 'none'; const sum = [...paySel].reduce((a, id) => a + ((d.items.find((x) => x.emp_id === id) || {}).remainder || 0), 0); bulkN.textContent = 'Выбрано ' + paySel.size + ' · остаток ' + money2(sum); };
      bulk.appendChild(bulkN);
      bulk.appendChild(el('button', { class: 'btn-primary', onclick: () => openPay([...paySel].map((id) => d.items.find((x) => x.emp_id === id)).filter(Boolean)) }, '💵 Выплатить остаток'));
      bulk.appendChild(el('button', { class: 'btn-ghost', onclick: () => { paySel.clear(); load(); } }, 'Снять'));
      box.appendChild(bulk);
      if (!d.items.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Нет сотрудников по фильтру.')); return; }
      const selAll = el('input', { type: 'checkbox', class: 'hr-chk' });
      selAll.onclick = (ev) => { const on = ev.target.checked; paySel = new Set(on ? payable.map((x) => x.emp_id) : []); box.querySelectorAll('.hr-paychk').forEach((cc) => { if (!cc.disabled) cc.checked = on; }); updBulk(); };
      const head = el('div', { class: 'hr-row head hr-pay' }, [selAll, el('span', {}, 'ФИО'), el('span', {}, 'Отдел'), el('span', {}, 'К выплате'), el('span', {}, 'Выплачено'), el('span', {}, 'Остаток'), el('span', {}, 'Статус'), el('span', {}, '')]);
      box.appendChild(el('div', { class: 'hr-list' }, [head, ...d.items.map((r) => {
        const canPay = r.remainder > 0.5;
        const chk = el('input', { type: 'checkbox', class: 'hr-chk hr-paychk', disabled: !canPay, onclick: (ev) => { ev.stopPropagation(); if (ev.target.checked) paySel.add(r.emp_id); else paySel.delete(r.emp_id); updBulk(); } });
        return el('div', { class: 'hr-row hr-pay', onclick: () => openHistory(r) }, [
          chk,
          el('span', { style: 'font-weight:700' }, r.full_name),
          el('span', { class: 'muted' }, r.department_name || '—'),
          el('span', { class: 'tnum' }, money2(r.net)),
          el('span', { class: 'tnum' }, [
            money2(r.paid),
            (r.payouts && r.payouts.length ? el('div', { style: 'font-size:11px;color:#9aa295;font-weight:400', title: 'Даты выплат — клик по строке' }, ruDate(r.payouts[r.payouts.length - 1].pay_date) + (r.payouts.length > 1 ? ' (+' + (r.payouts.length - 1) + ')' : '')) : null),
          ]),
          el('span', { class: 'tnum', style: 'font-weight:800;color:' + (r.remainder > 0.5 ? '#b25b00' : '#2e7d32') }, money2(r.remainder)),
          el('span', {}, el('span', { class: 'hr-st hr-payst-' + r.status }, PAYOUT_STATUS[r.status] || r.status)),
          el('span', {}, canPay ? el('button', { class: 'btn-ghost', style: 'padding:4px 10px;font-size:12px', onclick: (ev) => { ev.stopPropagation(); openPay([r]); } }, r.paid > 0.5 ? 'Доплатить' : 'Выплатить') : el('span', { class: 'muted', style: 'font-size:12px' }, '✓')),
        ]);
      })]));

      function openHistory(r) {
        const body = el('div', {}, [
          el('div', { class: 'hr-note' }, r.full_name + ' · ' + monthLabel(payState.period)),
          el('div', { style: 'display:flex;gap:16px;margin:8px 0;font-size:13px;flex-wrap:wrap' }, [el('span', {}, 'К выплате: ' + money2(r.net)), el('span', {}, 'Выплачено: ' + money2(r.paid)), el('span', { style: 'font-weight:700' }, 'Остаток: ' + money2(r.remainder))]),
          r.payouts.length ? el('table', { class: 'dict-table' }, [
            el('thead', {}, el('tr', {}, ['Дата', 'Способ', 'Сумма', 'Комментарий', ''].map((h) => el('th', {}, h)))),
            el('tbody', {}, r.payouts.map((x) => el('tr', {}, [
              el('td', {}, ruDate(x.pay_date)),
              el('td', {}, x.method === 'card' ? 'карта' : 'наличные'),
              el('td', { class: 'tnum', style: 'text-align:right;font-weight:700' }, money2(x.amount)),
              el('td', { class: 'muted' }, x.comment || ''),
              // Отмена выплаты: сумма вернётся в «К выплате», расход в Кассе уберётся/уменьшится.
              el('td', { style: 'text-align:right;width:1%' }, el('button', {
                class: 'btn-ghost hr-del', style: 'padding:3px 9px;font-size:12px', title: 'Отменить выплату',
                onclick: () => cancelPayout(x, r),
              }, '↩ Отменить')),
            ])))]) : el('div', { class: 'hr-empty' }, 'Выплат пока нет.'),
        ]);
        const acts = [el('button', { onclick: closeModal }, 'Закрыть')];
        if (r.remainder > 0.5) acts.push(el('button', { class: 'btn-primary', onclick: () => { closeModal(); openPay([r]); } }, r.paid > 0.5 ? 'Доплатить' : 'Выплатить'));
        modal('История выплат — ' + r.full_name, body, acts);
      }

      async function cancelPayout(x, r) {
        const how = x.method === 'card' ? 'на карту' : 'наличными';
        if (!confirm('Отменить выплату ' + money2(x.amount) + ' (' + how + ') от ' + ruDate(x.pay_date) + '?\n\n'
          + 'Сотрудник: ' + r.full_name + '\n'
          + '• Сумма вернётся в «К выплате».\n'
          + (x.method === 'card' ? '• Выплата на карту будет снята.' : '• Расход в Кассе будет удалён (или уменьшен, если в нём есть другие сотрудники).')
          + '\n\nОтменить нельзя. Продолжить?')) return;
        try {
          const res = await post('/payouts/' + x.id + '/delete', {});
          toast('Выплата отменена' + (res.cashNote ? ' · ' + res.cashNote : ''));
          closeModal();
          render();
        } catch (e) { toast(e.message, true); }
      }

      function openPay(list) {
        list = list.filter((x) => x && x.remainder > 0.5);
        if (!list.length) return toast('Нет остатка к выплате', true);
        const single = list.length === 1;
        const totalRem = list.reduce((a, x) => a + x.remainder, 0);
        let method = 'cash';
        const radio = (val, label) => { const rr = el('input', { type: 'radio', name: 'paymethod', value: val }); if (val === method) rr.checked = true; rr.onchange = () => { method = val; }; return el('label', { style: 'display:inline-flex;gap:6px;align-items:center;margin-right:16px;cursor:pointer' }, [rr, label]); };
        const amountInp = single ? minp(Number(list[0].remainder.toFixed(2)), { placeholder: '0' }) : null;
        const dateInp = finp(new Date().toISOString().slice(0, 10), { type: 'date' });
        const commentInp = finp('', { placeholder: 'Комментарий (по желанию)' });
        const rows = [];
        rows.push(frow(single ? 'Сотрудник' : 'Сотрудников', el('div', { class: 'hr-note' }, single ? list[0].full_name : (list.length + ' · остаток ' + money2(totalRem)))));
        if (single) rows.push(frow('Сумма', amountInp));
        rows.push(frow('Способ', el('div', {}, [radio('cash', 'Наличные'), radio('card', 'Карта')])));
        rows.push(frow('Дата', dateInp));
        rows.push(frow('Комментарий', commentInp));
        rows.push(el('div', { class: 'hr-sub' }, (single ? 'Можно указать сумму меньше остатка — будет частичная выплата. ' : 'Каждому проведём его остаток. ') + 'Наличные — расход автоматически сядет в Кассу (АУП/Бухгалтерия/Продажи → «Зарплата офиса», остальные → «ЗП производство»).'));
        const save = el('button', { class: 'btn-primary', onclick: async () => {
          save.disabled = true; save.textContent = 'Провожу…';
          const payload = { period: payState.period, employee_ids: list.map((x) => x.emp_id), method, pay_date: dateInp.value || null, comment: commentInp.value || null };
          if (single && amountInp) payload.amount = mval(amountInp);
          try { const rr = await post('/payouts/pay', payload); toast('Выплачено: ' + rr.count + ' на ' + money2(rr.total)); if (rr.cashNote) toast(rr.cashNote, true); closeModal(); load(); }
          catch (e) { toast(e.message, true); save.disabled = false; save.textContent = 'Выплатить'; }
        } }, 'Выплатить');
        modal(single ? 'Выплата — ' + list[0].full_name : 'Массовая выплата (' + list.length + ')', el('div', { class: 'hrf' }, rows), [save]);
      }
    }
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
        // Выгрузка идёт по текущим фильтрам: отделы не выбраны — значит все отделы.
        el('button', { class: 'btn-ghost', title: 'Скачать список в Excel (с учётом фильтров)', onclick: () => {
          const sp = new URLSearchParams();
          ['department', 'schedule', 'status', 'q'].forEach((k) => { if (empFilter[k]) sp.set(k, empFilter[k]); });
          window.location = '/hr/api/employees-export.xlsx?' + sp.toString();
        } }, '📥 Excel'),
        el('button', { class: 'btn-primary hr-add', onclick: () => openEmp(null) }, '+ Сотрудник'),
      ]),
    ]));
    // Фильтры
    const dSel = deptMulti(empFilter, 'department', load, true);
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
        kpi('ФОТ (оклады, актив.)', money(d.fot), 'green'),
        kpi('Активных', DICTS.counts.active || 0, 'ink'),
        kpi('Уволенных', DICTS.counts.fired || 0, 'muted'),
      ]));
      if (!d.items.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Никого не найдено. Добавьте сотрудника, импортируйте из Excel или измените фильтры.')); return; }
      empSel = new Set();
      // Панель массовых действий
      const bulk = el('div', { id: 'hr-bulk', class: 'hr-bulkbar', style: 'display:none' });
      const bulkN = el('span', { class: 'hr-bulk-n' }, '');
      const updBulk = () => { bulk.style.display = empSel.size ? 'flex' : 'none'; bulkN.textContent = 'Выбрано: ' + empSel.size; };
      async function doBulk(action, confirmMsg, extra) {
        if (!empSel.size) return; if (confirmMsg && !confirm(confirmMsg + ' (' + empSel.size + ')?')) return;
        try { const r = await post('/employees/bulk', Object.assign({ ids: [...empSel], action }, extra || {})); toast('Готово: ' + r.affected); await reloadDicts(); load(); } catch (e) { toast(e.message, true); }
      }
      // Массовое увольнение — обязательно с датой (как и одиночное): от неё зависит начисление
      // за месяц увольнения и запись в кадровой истории.
      function bulkFire() {
        if (!empSel.size) return;
        const date = finp(new Date().toISOString().slice(0, 10), { type: 'date' });
        const body = el('div', { class: 'hrf' }, [
          el('div', { class: 'hr-note' }, 'Увольнение ' + empSel.size + ' сотрудн. Дата — одна на всех.'),
          el('div', { class: 'hr-sub', style: 'margin:4px 0 8px' }, 'Дата попадёт в карточку и в кадровую историю. Месяц увольнения можно будет начислить по факту отработанных дней.'),
          frow('Дата увольнения *', date),
        ]);
        const ok = el('button', { class: 'btn-primary hrf-warn', onclick: async () => {
          if (!date.value) return toast('Укажите дату увольнения', true);
          closeModal();
          await doBulk('fired', null, { fire_date: date.value });
        } }, 'Уволить');
        modal('Массовое увольнение', body, [el('button', { class: 'btn-ghost', onclick: closeModal }, 'Отмена'), ok]);
      }
      bulk.appendChild(bulkN);
      bulk.appendChild(el('button', { class: 'btn-ghost hrf-warn', onclick: () => doBulk('archived', 'В архив') }, 'В архив'));
      bulk.appendChild(el('button', { class: 'btn-ghost hrf-warn', onclick: bulkFire }, 'Уволить'));
      // Удаление стирает карточку вместе с зарплатной историей — предупреждаем прямо в тексте.
      // Сервер не даст удалить тех, у кого есть начисления/выплаты (предложит «Уволить»/«В архив»).
      bulk.appendChild(el('button', { class: 'btn-ghost hr-del', title: 'Только для пустых карточек, заведённых по ошибке',
        onclick: () => doBulk('delete', 'УДАЛИТЬ безвозвратно карточку вместе с начислениями, выплатами и кадровой историей.\nДля работавших сотрудников используйте «Уволить» или «В архив».\n\nПродолжить') }, '🗑 Удалить'));
      // Массовая простановка графика выбранным.
      const schedSel = el('select', { class: 'hrf-inp', style: 'height:32px' }, (DICTS.schedules || []).map((s) => el('option', { value: s.code }, s.name)));
      bulk.appendChild(schedSel);
      bulk.appendChild(el('button', { class: 'btn-primary', onclick: async () => {
        if (!empSel.size) return;
        const nm = (schedSel.options[schedSel.selectedIndex] || {}).text || '';
        if (!confirm('Поставить график «' + nm + '» выбранным (' + empSel.size + ')?')) return;
        try { const r = await post('/employees/set-schedule', { ids: [...empSel], schedule_type: schedSel.value }); toast('График проставлен: ' + r.changed); await reloadDicts(); load(); } catch (e) { toast(e.message, true); }
      } }, '🕒 Поставить график'));
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
  function kpi(label, val, cls, onClick, sub) { return el('div', { class: 'hr-kpi' + (onClick ? ' hr-kpi-click' : ''), onclick: onClick || null, title: onClick ? 'Клик — в разрезе по сотрудникам' : null }, [el('div', { class: 'hr-kpi-l' }, label), el('div', { class: 'hr-kpi-v hr-kpi-' + cls }, String(val)), sub ? el('div', { class: 'hr-kpi-sub' }, sub) : null]); }
  // Разрез KPI по сотрудникам: список ФИО + сумма (по убыванию) + итог.
  function openBreakdown(title, items, fn, period) {
    const list = (items || []).map((r) => ({ name: r.full_name, val: Number(fn(r)) || 0 })).filter((x) => x.val).sort((a, b) => b.val - a.val);
    const total = list.reduce((s, x) => s + x.val, 0);
    const body = el('div', {}, [
      el('div', { class: 'hr-note' }, title + ' · ' + monthLabel(period || salState.period) + ' · ' + list.length + ' чел.'),
      list.length ? el('div', { class: 'oe-table-wrap', style: 'max-height:56vh;margin-top:8px' }, el('table', { class: 'dict-table' }, [
        el('thead', {}, el('tr', {}, [el('th', {}, '#'), el('th', {}, 'ФИО'), el('th', { style: 'text-align:right' }, 'Сумма')])),
        el('tbody', {}, [...list.map((x, i) => el('tr', {}, [el('td', { class: 'muted' }, String(i + 1)), el('td', {}, x.name), el('td', { class: 'tnum', style: 'text-align:right;font-weight:700' }, money(x.val))])),
          el('tr', { style: 'background:#f2f5f1;font-weight:800' }, [el('td', {}, ''), el('td', {}, 'ИТОГО'), el('td', { class: 'tnum', style: 'text-align:right' }, money(total))])]),
      ])) : el('div', { class: 'hr-empty' }, 'Нет данных за период.'),
    ]);
    modal(title + ' — в разрезе', body, [el('button', { class: 'btn-primary', onclick: closeModal }, 'Закрыть')]);
  }
  // Кому переплачено (клик по «переплата» на дашборде).
  function openOverpaid(list) {
    const total = (list || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const body = el('div', {}, [
      el('div', { class: 'hr-note' }, 'Переплачено (выдали больше, чем к выплате) · итого ' + money(total)),
      (list && list.length) ? el('table', { class: 'dict-table', style: 'margin-top:8px' }, [
        el('thead', {}, el('tr', {}, ['ФИО', 'Отдел', 'Переплата'].map((h) => el('th', {}, h)))),
        el('tbody', {}, list.map((x) => el('tr', {}, [el('td', {}, x.name), el('td', { class: 'muted' }, x.dept || '—'), el('td', { class: 'tnum', style: 'text-align:right;font-weight:700;color:#c0392b' }, money(x.amount))]))),
      ]) : el('div', { class: 'hr-empty' }, 'Переплат нет.'),
    ]);
    modal('Кому переплачено', body, [el('button', { class: 'btn-primary', onclick: closeModal }, 'Закрыть')]);
  }
  // Выгрузка ведомости из Зарплаты убрана: выгрузка делается во вкладке «Выплаты» (кнопка Excel).
  // Эндпоинт /api/cards/paysheet.xlsx оставлен рабочим на случай, если понадобится вернуть.

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

  // Импорт банковской ведомости по карте (ASIA ALLIANCE и т.п.): суммы садятся в «Выплачено/Аванс на карту».
  // Сопоставление по номеру карты — сначала загрузи номера карт сотрудников (кнопка «Карты (Excel)»).
  function openCardStatementImport(period) {
    let mode = 'payout';
    const file = el('input', { type: 'file', accept: '.xls,.xlsx', class: 'hrf-inp' });
    const radio = (val, label) => { const r = el('input', { type: 'radio', name: 'cardmode', value: val }); if (val === mode) r.checked = true; r.onchange = () => { mode = val; }; return el('label', { style: 'display:inline-flex;gap:6px;align-items:center;margin-right:16px;cursor:pointer' }, [r, label]); };
    const result = el('div', {});
    const send = async (dry) => {
      if (!file.files[0]) { toast('Выберите файл', true); return null; }
      const fd = new FormData(); fd.append('file', file.files[0]); fd.append('period', period); fd.append('mode', mode); fd.append('dry', dry ? 'true' : 'false');
      const res = await fetch('/hr/api/cards/statement-import', { method: 'POST', body: fd });
      const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Ошибка');
      return d;
    };
    const showPreview = (d) => {
      result.innerHTML = '';
      const rows = (arr, cls) => el('div', { class: 'oe-table-wrap', style: 'max-height:30vh;margin-top:4px' }, el('table', { class: 'dict-table' }, [
        el('thead', {}, el('tr', {}, ['ФИО / карта', 'Сумма'].map((h) => el('th', {}, h)))),
        el('tbody', {}, arr.map((x) => el('tr', { class: cls || '' }, [el('td', {}, (x.name || x.fio || '') + ' · ' + x.card), el('td', { class: 'tnum', style: 'text-align:right;font-weight:700' }, money(x.amount))]))),
      ]));
      result.appendChild(el('div', { class: 'hr-note', style: 'margin-top:8px' }, 'Найдено строк: ' + d.count + ' · совпало по карте: ' + d.matched.length + (d.unmatched.length ? ' · не найдено: ' + d.unmatched.length : '') + ' · сумма: ' + money(d.total)));
      if (d.matched.length) result.appendChild(el('details', { open: true }, [el('summary', {}, 'Сядет в «' + (mode === 'advance' ? 'Аванс' : 'Выплачено') + ' на карту» (' + d.matched.length + ')'), rows(d.matched)]));
      if (d.unmatched.length) result.appendChild(el('details', {}, [el('summary', {}, '⚠ Не нашли по номеру карты (' + d.unmatched.length + ') — проставь им карту в «Карты (Excel)»'), rows(d.unmatched, 'imp-err')]));
    };
    const preview = el('button', { class: 'btn-ghost', onclick: async () => { try { const d = await send(true); if (d) showPreview(d); } catch (e) { toast(e.message, true); } } }, 'Проверить');
    const apply = el('button', { class: 'btn-primary', onclick: async () => {
      apply.disabled = true; apply.textContent = 'Загружаю…';
      try { const d = await send(false); if (d) { toast('Разнесено на карту: ' + d.matched.length + ' на ' + money(d.total)); closeModal(); renderSalary(); } }
      catch (e) { toast(e.message, true); }
      apply.disabled = false; apply.textContent = 'Применить';
    } }, 'Применить');
    const body = el('div', { class: 'hrf' }, [
      el('div', { class: 'hr-sub' }, 'Загрузка банковской ведомости по карте за ' + monthLabel(period) + '. Сопоставляем по номеру карты (у сотрудников должны быть проставлены карты). Перезаписывает сумму за месяц.'),
      el('div', {}, [radio('payout', 'Выплата на карту'), radio('advance', 'Аванс на карту')]),
      frow('Файл', file),
      el('div', { style: 'margin-top:4px' }, preview),
      result,
    ]);
    modal('🏦 Импорт ведомости на карту — ' + monthLabel(period), body, [apply]);
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
    const sched = fsel([{ v: '', t: '— график —' }, ...(DICTS.schedules || []).map((s) => ({ v: s.code, t: s.name }))], e.schedule_type || '');
    const fullMonth = el('input', { type: 'checkbox' });
    if (e.full_month) fullMonth.checked = true;
    const fullMonthRow = frow('Табель', el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer;font-weight:400' }, [fullMonth, el('span', {}, 'Факт = план (полный месяц, без табеля)')]));
    const hire = finp(e.hire_date ? String(e.hire_date).slice(0, 10) : '', { type: 'date' });
    // Дата увольнения — показываем у уволенных (в т.ч. чтобы проставить её задним числом,
    // если увольняли оптом без даты). У активных поле не нужно.
    const fire = finp(e.fire_date ? String(e.fire_date).slice(0, 10) : '', { type: 'date' });
    const fireRow = frow('Дата увольнения', el('div', {}, [fire,
      el('div', { class: 'hr-sub', style: 'margin-top:3px' }, 'По какой день работал. Нужна для начисления за месяц увольнения.')]));
    if (e.status !== 'fired') fireRow.style.display = 'none';
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
      frow('ФИО *', name), frow('Отдел', dept), frow('Должность', pos), frow('График', sched), fullMonthRow, frow('Дата приёма', hire), fireRow,
      el('div', { class: 'hrf-sec' }, 'Зарплата'),
      frow('Оклад / ставка', base), frow('Официальная часть', off), frow('Неофициальная часть', unoff),
      el('div', { class: 'hrf-sec' }, 'Контакты'),
      frow('Телефон', phone), frow('Номер карты', card), frow('Telegram ID', tg), frow('Комментарий', comment),
    ]);
    // Постоянные надбавки/удержания — только у сохранённого сотрудника (нужен id).
    if (e.id) {
      body.appendChild(el('div', { class: 'hrf-sec' }, 'Постоянные надбавки и удержания'));
      body.appendChild(el('div', { class: 'hr-sub', style: 'margin:-4px 0 8px' },
        'Закреплённые суммы подставляются в ведомость каждый месяц автоматически (в пустые ячейки). Ручная правка за месяц всегда главнее.'));
      const recurBox = el('div', { id: 'hr-recur-box' });
      body.appendChild(recurBox);
      loadRecurring(e.id, recurBox);
    }
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        const payload = { id: e.id, full_name: name.value, department_id: dept.value, position: pos.value, schedule_type: sched.value, hire_date: hire.value, base_salary: mval(base), salary_official: mval(off), salary_unofficial: mval(unoff), phone: phone.value, card_number: card.value, telegram_id: tg.value, comment: comment.value, full_month: fullMonth.checked };
        // Дату увольнения шлём только у уволенных — у активных поле скрыто и трогать его нечего.
        if (e.status === 'fired') payload.fire_date = fire.value || null;
        await post('/employee', payload);
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
  // Список постоянных надбавок/удержаний внутри карточки сотрудника.
  async function loadRecurring(empId, box) {
    box.innerHTML = '';
    let d;
    try { d = await api('/employee/' + empId + '/recurring'); }
    catch (err) { box.appendChild(el('div', { class: 'hr-sub' }, 'Ошибка: ' + err.message)); return; }
    const labelOf = (code) => (d.fields.find((f) => f.code === code) || {}).label || code;
    const isDed = (code) => String(code).startsWith('ded_');
    const items = d.items || [];
    if (!items.length) {
      box.appendChild(el('div', { class: 'hr-sub', style: 'padding:6px 0' }, 'Пока не задано.'));
    } else {
      const rows = items.map((r) => el('div', { style: 'display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)' }, [
        el('span', { style: 'flex:1;font-weight:600' + (r.active ? '' : ';opacity:.5;text-decoration:line-through') }, [
          labelOf(r.field),
          r.comment ? el('span', { class: 'hr-sub', style: 'font-weight:400' }, ' · ' + r.comment) : null,
          (r.date_from || r.date_to) ? el('span', { class: 'hr-sub', style: 'font-weight:400' },
            ' · ' + (r.date_from ? 'с ' + monthLabel(r.date_from) : '') + (r.date_to ? ' по ' + monthLabel(r.date_to) : '')) : null,
        ]),
        el('span', { style: 'font-weight:800;white-space:nowrap;color:' + (isDed(r.field) ? '#c0392b' : '#3f6a16') },
          (isDed(r.field) ? '− ' : '+ ') + Number(r.amount).toLocaleString('ru-RU')),
        el('button', { class: 'btn-ghost', style: 'padding:2px 8px', title: 'Изменить', onclick: () => openRecurForm(empId, box, d.fields, r) }, '✎'),
        el('button', { class: 'btn-ghost hrf-warn', style: 'padding:2px 8px', title: 'Удалить', onclick: async () => {
          if (!confirm('Удалить «' + labelOf(r.field) + '» ' + Number(r.amount).toLocaleString('ru-RU') + '?')) return;
          try { await post('/employee/' + empId + '/recurring/' + r.id + '/delete', {}); toast('Удалено'); loadRecurring(empId, box); }
          catch (err) { toast(err.message, true); }
        } }, '🗑'),
      ]));
      rows.forEach((r) => box.appendChild(r));
    }
    box.appendChild(el('button', { class: 'btn-ghost hr-add', style: 'margin-top:8px',
      onclick: () => openRecurForm(empId, box, d.fields, null) }, '+ Добавить постоянную сумму'));
  }
  // Форма одного правила: вид, сумма, период действия, примечание.
  function openRecurForm(empId, box, fields, r) {
    r = r || {};
    const field = fsel(fields.map((f) => ({ v: f.code, t: f.label })), r.field || 'accr_bonus');
    const amount = minp(r.amount, { placeholder: 'сумма в месяц' });
    const from = finp(r.date_from || '', { type: 'month' });
    const to = finp(r.date_to || '', { type: 'month' });
    const comment = finp(r.comment, { placeholder: 'за что (например: доплата за наставничество)' });
    const active = el('input', { type: 'checkbox' }); active.checked = r.active !== false;
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      if (!(Number(mval(amount)) > 0)) return toast('Укажите сумму больше нуля', true);
      try {
        await post('/employee/' + empId + '/recurring', { id: r.id, field: field.value, amount: mval(amount), date_from: from.value, date_to: to.value, comment: comment.value, active: active.checked });
        toast('Сохранено'); closeModal(); loadRecurring(empId, box);
      } catch (err) { toast(err.message, true); }
    } }, 'Сохранить');
    modal(r.id ? 'Изменить постоянную сумму' : 'Постоянная надбавка / удержание', el('div', { class: 'hrf' }, [
      frow('Вид', field), frow('Сумма в месяц *', amount),
      frow('Действует с', from), frow('Действует по', to),
      el('div', { class: 'hr-sub', style: 'margin:-4px 0 6px' }, 'Пусто = бессрочно. Сумма ставится каждый месяц в пустую ячейку ведомости.'),
      frow('Примечание', comment),
      frow('Активно', el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer;font-weight:400' }, [active, el('span', {}, 'подставлять в ведомость')])),
    ]), [el('button', { class: 'btn-ghost', onclick: closeModal }, 'Отмена'), save]);
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
    c.innerHTML = '';
    if (!tsState.period) tsState.period = curMonth();
    c.appendChild(el('div', { class: 'hr-head' }, [
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Табель — ' + monthLabel(tsState.period)), el('div', { class: 'hr-sub' }, 'Часы/дни за месяц. Переработка = факт − план часов (оплата ×2 — механизм расчёта настроим позже). Деньги начислений не затрагиваются.')]),
      el('div', { class: 'hr-head-btns' }, [
        el('button', { class: 'btn-ghost hr-add', onclick: () => openTimesheetImport(tsState.period) }, '📥 Загрузить из Excel'),
      ]),
    ]));
    const mInp = HubDateRange.create({
      mode: 'month', period: tsState.period,
      onChange: (v) => { tsState.period = v.period || curMonth(); render(); },
    });
    const dSel = deptMulti(tsState, 'department', load);
    const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО', value: tsState.q, oninput: (e) => { tsState.q = e.target.value; clearTimeout(window.__hrT); window.__hrT = setTimeout(load, 300); } });
    c.appendChild(el('div', { class: 'hr-filters' }, [mInp, dSel, q]));
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
        // Табель сохраняется целиком — возвращаем прокрутку, чтобы не искать строку заново.
        const sy = window.scrollY;
        try { const rr = await post('/timesheet', { period: tsState.period, rows }); toast('Сохранено: ' + rr.saved); await load(); requestAnimationFrame(() => window.scrollTo(0, sy)); }
        catch (e) { toast(e.message, true); saveBtn.disabled = false; saveBtn.textContent = '💾 Сохранить табель'; }
      }
    }
  }

  // ================= ЗАРПЛАТА =================
  const PR_STATUS = { draft: 'Черновик', accrued: 'Начислено', approved: 'Утверждено', paid: 'Выплачено', cancelled: 'Отменено' };
  // Фикса — справочно, НЕ входит в сумму «начислено». Счётные — ниже.
  // «Долг компании» — удержание (уменьшает К выплате), поэтому он в DED_FIELDS, а не в начислениях.
  const ACCR_FIELDS = [['accr_fact', 'Факт по табелю'], ['accr_bonus', 'Бонусы KPI'], ['accr_premium', 'Премия'], ['accr_gsm', 'ГСМ / компенсации'], ['accr_sick', 'Больничные'], ['accr_vacation', 'Отпускные'], ['accr_mataid', 'Матпомощь'], ['accr_comp_vac', 'Компенсация отпуска'], ['accr_other', 'Другое начисление']];
  // Операции для вкладки «Массовые операции» (поле payroll → подпись).
  const MASS_OPS = [['accr_bonus', 'Бонусы KPI'], ['accr_premium', 'Премия'], ['accr_gsm', 'ГСМ / компенсации'], ['accr_sick', 'Больничные'], ['accr_vacation', 'Отпускные'], ['accr_mataid', 'Матпомощь'], ['accr_comp_vac', 'Компенсация за неисп. отпуск'], ['accr_company_debt', 'Долг компании'], ['accr_other', 'Другое начисление'],
    ['ded_fine', 'Штрафы'], ['ded_hold', 'Удержания'],
    ['ded_advance_cash', 'Аванс наличными'], ['ded_advance_card', 'Аванс на карту']];
  const DED_FIELDS = [['ded_fine', 'Штраф за опоздание'], ['ded_advance_card', 'Аванс на карту'], ['ded_advance_cash', 'Аванс наличными'], ['ded_hold', 'Удержание'], ['accr_company_debt', 'Долг компании'], ['ded_emp_debt', 'Долг сотрудника'], ['ded_other', 'Другое удержание']];
  const PAID_FIELDS = [['paid_cash', 'Выплачено наличными'], ['paid_card', 'Выплачено на карту']];
  const salState = { period: '', department: '', schedule: '', status: '', q: '' };
  let salItems = [];
  let salSel = new Set();
  const payState = { period: '', department: '', status: '', q: '' };
  let paySel = new Set();
  const PAYOUT_STATUS = { pending: 'Ожидает', partial: 'Частично', paid: 'Оплачено', overdue: 'Просрочено', none: 'Нет начисления', no_accrual: 'Выплачено без начисления' };
  const curMonth = () => new Date().toISOString().slice(0, 7);
  const monthLabel = (ym) => { const [y, m] = ym.split('-'); return ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'][Number(m)] + ' ' + y; };

  // Блок «Выплаты из кассы без сотрудника»: наличные расходы по зарплатным статьям, которые
  // система не смогла привязать к сотруднику по ФИО из назначения. Свёрнут по умолчанию,
  // строки можно скрывать (только визуально — Касса и суммы не меняются).
  function cashUnmatchedBlock(list) {
    if (!list || !list.length) return null;
    let showHidden = false;
    const listBox = el('div', { style: 'display:none;margin-top:8px' });
    const cntSpan = el('span', {});
    const rebuild = () => {
      const shown = list.filter((u) => showHidden || !u.hidden);
      const hiddenCnt = list.filter((u) => u.hidden).length;
      listBox.innerHTML = '';
      const bar = el('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:6px' }, []);
      const visIds = list.filter((u) => !u.hidden).map((u) => u.tx_id);
      if (visIds.length) bar.appendChild(el('button', { class: 'btn-ghost', style: 'font-size:12px;padding:3px 9px', onclick: async () => { if (!confirm('Скрыть все показанные (' + visIds.length + ')? Касса и суммы не изменятся.')) return; try { await post('/salary/cash-hide', { ids: visIds, hidden: true }); list.forEach((u) => { if (visIds.includes(u.tx_id)) u.hidden = true; }); rebuild(); } catch (e) { toast(e.message, true); } } }, '🚫 Скрыть все показанные'));
      if (hiddenCnt) bar.appendChild(el('a', { href: 'javascript:void(0)', class: 'muted', style: 'font-size:12px', onclick: () => { showHidden = !showHidden; rebuild(); } }, (showHidden ? '▾ Скрыть скрытые' : '▸ Показать скрытые') + ' (' + hiddenCnt + ')'));
      if (bar.childNodes.length) listBox.appendChild(bar);
      shown.forEach((u) => listBox.appendChild(el('div', { style: 'display:flex;gap:12px;font-size:13px;padding:2px 0;align-items:center' + (u.hidden ? ';opacity:.5' : '') }, [
        el('span', { style: 'min-width:88px' }, String(u.date)),
        el('span', { style: 'min-width:70px' }, u.kind === 'advance' ? 'аванс' : 'зарплата'),
        el('span', { class: 'tnum', style: 'min-width:120px;font-weight:700' }, money(u.amount)),
        el('span', { class: 'muted', style: 'flex:1' }, u.purpose || ''),
        el('span', { style: 'cursor:pointer;opacity:.6', title: u.hidden ? 'Вернуть' : 'Скрыть навсегда', onclick: async () => { try { await post('/salary/cash-hide', { ids: [u.tx_id], hidden: !u.hidden }); u.hidden = !u.hidden; rebuild(); } catch (e) { toast(e.message, true); } } }, u.hidden ? '👁' : '🚫'),
      ])));
      cntSpan.textContent = '⚠ Выплаты из кассы без сотрудника (' + list.filter((u) => !u.hidden).length + ')';
    };
    const arrow = el('span', {}, '▸');
    const head = el('div', { style: 'font-weight:700;color:#b25b00;cursor:pointer;display:flex;gap:6px;align-items:center', onclick: () => {
      const open = listBox.style.display === 'none';
      listBox.style.display = open ? '' : 'none'; arrow.textContent = open ? '▾' : '▸';
    } }, [arrow, cntSpan, el('span', { class: 'muted', style: 'font-weight:400;font-size:12px' }, '— показать')]);
    rebuild();
    return el('div', { style: 'background:#fff3e0;border:1px solid #e6c98a;border-radius:10px;padding:8px 12px;margin-bottom:12px' }, [head, listBox]);
  }

  // ---------- Наведение порядка: откат восстановления + дубли ----------
  // Справочный файл содержит короткие имена («Азиза»), в базе — полные («Мурадова Азиза»),
  // поэтому восстановление могло наплодить дублей. Здесь их видно и можно убрать.
  async function openCleanup() {
    const box = el('div', {});
    const m = modal('🧹 Дубли и откат восстановления', box, [el('button', { class: 'btn-primary', onclick: closeModal }, 'Закрыть')]);
    async function load() {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'hr-sub' }, 'Загружаю…'));
      let rp = { items: [] }, dup = { groups: [] };
      try { rp = await api('/employees/restore-preview'); } catch (e) { /* могло не быть восстановления */ }
      try { dup = await api('/employees/duplicates'); } catch (e) { /* ок */ }
      box.innerHTML = '';

      // 1. Откат последнего восстановления
      box.appendChild(el('div', { class: 'hr-h2', style: 'font-size:16px;margin:0 0 6px' }, 'Последнее восстановление'));
      if (!rp.items || !rp.items.length) {
        box.appendChild(el('div', { class: 'hr-sub', style: 'margin-bottom:12px' }, 'Восстановление не выполнялось или карточек от него не осталось.'));
      } else {
        const safe = rp.items.filter((x) => Number(x.payout_rows) === 0);
        box.appendChild(el('div', { class: 'hr-note' }, 'Создано карточек: ' + rp.items.length + ' · можно удалить: ' + safe.length));
        box.appendChild(el('div', { class: 'hr-sub', style: 'margin:4px 0 8px' }, 'Откат удалит только те, с которыми не работали (нет выплат и начислений за рабочие месяцы).'));
        box.appendChild(el('div', { class: 'oe-table-wrap', style: 'max-height:26vh;margin-bottom:8px' }, el('table', { class: 'dict-table' }, [
          el('thead', {}, el('tr', {}, ['ФИО', 'Отдел', 'Начисл.', 'Выплат'].map((h) => el('th', {}, h)))),
          el('tbody', {}, rp.items.map((x) => el('tr', {}, [
            el('td', {}, x.full_name), el('td', { class: 'muted' }, x.department_name || '—'),
            el('td', { class: 'tnum' }, String(x.payroll_rows)), el('td', { class: 'tnum' }, String(x.payout_rows)),
          ]))),
        ])));
        box.appendChild(el('button', { class: 'btn-ghost hrf-warn', style: 'margin-bottom:14px', onclick: async () => {
          if (!confirm('Отменить восстановление?\n\nБудут удалены карточки, созданные последним «Восстановить» — только те, с которыми не работали.\nОтменить нельзя.')) return;
          try { const r = await post('/employees/undo-restore', {}); toast('Удалено: ' + r.deleted + (r.kept ? ', оставлено (есть данные): ' + r.kept : '')); await reloadDicts(); load(); render(); }
          catch (e) { toast(e.message, true); }
        } }, '↩ Отменить восстановление'));
      }

      // 2. Дубли по ФИО
      box.appendChild(el('div', { class: 'hr-h2', style: 'font-size:16px;margin:10px 0 6px' }, 'Похожие ФИО (возможные дубли)'));
      if (!dup.groups || !dup.groups.length) {
        box.appendChild(el('div', { class: 'hr-sub' }, 'Дублей не нашёл 👍'));
        return;
      }
      box.appendChild(el('div', { class: 'hr-sub', style: 'margin-bottom:8px' }, 'Оставляйте карточку с историей (где больше начислений и выплат), лишнюю — удаляйте.'));
      dup.groups.forEach((grp) => {
        const g = el('div', { style: 'border:1px solid var(--line);border-radius:10px;padding:8px;margin-bottom:8px' });
        grp.forEach((x) => g.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:center;padding:4px 0' }, [
          el('span', { style: 'flex:1;font-weight:600' }, [
            x.full_name,
            el('span', { class: 'hr-sub', style: 'font-weight:400' }, ' · ' + (x.department_name || 'без отдела') + ' · заведён ' + x.created),
          ]),
          el('span', { class: 'hr-sub' }, 'начисл. ' + x.payroll_rows + ' · выплат ' + x.payout_rows),
          el('button', { class: 'btn-ghost hrf-warn', style: 'padding:3px 9px;font-size:12px', onclick: async () => {
            if (!confirm('Удалить карточку «' + x.full_name + '»?\n\nНачислений: ' + x.payroll_rows + ', выплат: ' + x.payout_rows + '.\nУдалить можно только пустой дубль (без выплат и без начислений за рабочие месяцы).')) return;
            try { await post('/employee/' + x.id + '/delete-duplicate', {}); toast('Удалено'); await reloadDicts(); load(); render(); }
            catch (e) { toast(e.message, true); }
          } }, '🗑'),
        ])));
        box.appendChild(g);
      });
    }
    await load();
  }

  // ---------- Закрытие месяца в Кадрах ----------
  // Закрытые месяцы нельзя менять: ни начисления, ни табель, ни выплаты, ни импорт.
  let HR_LOCK = null;
  async function showHrLockBadge() {
    try { const d = await api('/period-lock'); HR_LOCK = d.locked_until || null; } catch (e) { return; }
    const btn = $('#hr-lock-btn');
    if (!btn) return;
    btn.textContent = HR_LOCK ? '🔒 Закрыто по ' + monthLabel(HR_LOCK) : '🔓 Закрытие месяца';
    btn.style.fontWeight = HR_LOCK ? '700' : '';
    btn.title = HR_LOCK ? 'Начисления и выплаты по ' + monthLabel(HR_LOCK) + ' защищены от изменений' : 'Месяцы не закрыты — данные можно менять задним числом';
  }
  function openHrPeriodLock() {
    const monthInp = finp(HR_LOCK || salState.period || curMonth(), { type: 'month' });
    const body = el('div', { class: 'hrf' }, [
      el('div', { class: 'hr-note' }, HR_LOCK ? ('Сейчас закрыто по ' + monthLabel(HR_LOCK) + '. Эти месяцы защищены.') : 'Сейчас ничего не закрыто — данные прошлых месяцев можно менять.'),
      el('div', { class: 'hr-sub', style: 'margin:6px 0 10px' },
        'Закрытие защищает месяц целиком: начисления, табель, выплаты, импорт зарплаты и ведомости на карту. Закрывать после того, как сверили и выплатили.'),
      frow('Закрыть включительно по месяц', monthInp),
    ]);
    const acts = [el('button', { class: 'btn-ghost', onclick: closeModal }, 'Отмена')];
    if (HR_LOCK) {
      acts.push(el('button', { class: 'btn-ghost hrf-warn', onclick: async () => {
        if (!confirm('Открыть все месяцы?\n\nДанные снова можно будет менять задним числом. Обычно это нужно только для исправления ошибки.')) return;
        try { await post('/period-lock', { clear: true }); toast('Замок снят'); closeModal(); render(); } catch (e) { toast(e.message, true); }
      } }, '🔓 Открыть всё'));
    }
    acts.push(el('button', { class: 'btn-primary', onclick: async () => {
      const p = monthInp.value;
      if (!/^\d{4}-\d{2}$/.test(p)) return toast('Укажите месяц', true);
      if (!confirm('Закрыть Кадры по ' + monthLabel(p) + ' включительно?\n\nПосле этого начисления и выплаты этих месяцев нельзя будет изменить, удалить или перезаписать импортом.')) return;
      try { await post('/period-lock', { period: p }); toast('Закрыто по ' + monthLabel(p)); closeModal(); render(); } catch (e) { toast(e.message, true); }
    } }, '🔒 Закрыть'));
    modal('Закрытие месяца — Кадры', body, acts);
  }

  // Мультивыбор отделов: кнопка + панель с галочками. Значение хранится строкой id через запятую
  // («1,5»), поэтому совместимо со старыми фильтрами: пусто = все отделы, '__none__' = без отдела.
  function deptMulti(state, key, onChange, withNone) {
    const opts = (withNone ? [{ id: '__none__', name: 'Без отдела' }] : []).concat(DICTS.departments || []);
    const selected = () => new Set(String(state[key] || '').split(',').filter(Boolean));
    const btn = el('button', { type: 'button', class: 'hrf-inp hr-filt hr-dm-btn' }, '');
    const panel = el('div', { class: 'hr-dm-panel' });
    const wrap = el('div', { class: 'hr-dm' }, [btn, panel]);
    const label = () => {
      const s = selected();
      if (!s.size) return 'Все отделы';
      if (s.size === 1) { const o = opts.find((x) => String(x.id) === [...s][0]); return o ? o.name : '1 отдел'; }
      return 'Отделов: ' + s.size;
    };
    const sync = () => { btn.textContent = label() + ' ▾'; btn.classList.toggle('on', selected().size > 0); };
    const apply = (s) => { state[key] = [...s].join(','); sync(); onChange(); };
    panel.appendChild(el('label', { class: 'hr-dm-item hr-dm-all', onclick: () => { apply(new Set()); build(); } }, 'Все отделы'));
    function build() {
      panel.querySelectorAll('.hr-dm-opt').forEach((n) => n.remove());
      const s = selected();
      opts.forEach((o) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = s.has(String(o.id));
        cb.onchange = () => { const cur = selected(); if (cb.checked) cur.add(String(o.id)); else cur.delete(String(o.id)); apply(cur); };
        panel.appendChild(el('label', { class: 'hr-dm-item hr-dm-opt' }, [cb, el('span', {}, o.name)]));
      });
    }
    build(); sync();
    btn.onclick = (ev) => { ev.stopPropagation(); const open = panel.classList.toggle('open'); if (open) { build(); document.addEventListener('click', close, { once: true }); } };
    function close() { panel.classList.remove('open'); }
    return wrap;
  }

  // Импорт зарплаты из Excel (все листы книги) — перезапись периода, с итогами для сверки.
  function openPayrollImport(period) {
    period = period || curMonth();
    const file = el('input', { type: 'file', accept: '.xlsx,.xls', class: 'hrf-inp' });
    const clear = el('input', { type: 'checkbox' });
    const out = el('div', { style: 'margin-top:10px' });
    const body = el('div', {}, [
      el('div', { class: 'hr-sub', style: 'margin-bottom:8px' }, 'Все листы книги (АУП / произ / смена). Начислено = «Фактич зпл табель»; удержания = штраф + удержание + авансы; выплаты = наличные + карта (парные столбцы суммируются). Строки перезаписываются по сотруднику за ' + monthLabel(period) + '.'),
      el('label', { class: 'hrf-row' }, [el('span', {}, 'Файл'), file]),
      el('label', { style: 'display:flex;gap:8px;align-items:center;margin:8px 0;cursor:pointer;font-size:13px' }, [clear, el('span', {}, 'Очистить ' + monthLabel(period) + ' перед импортом (период = файл 1-в-1)')]),
      out,
    ]);
    const load = el('button', { class: 'btn-primary', onclick: async () => {
      if (!file.files[0]) return toast('Выберите файл', true);
      out.innerHTML = '<div class="hr-sub">Загружаю…</div>';
      const fd = new FormData(); fd.append('period', period); fd.append('file', file.files[0]); fd.append('clearFirst', clear.checked ? 'true' : 'false');
      try {
        const res = await fetch('/hr/api/payroll/import', { method: 'POST', body: fd });
        const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Ошибка');
        const t = d.totals || {};
        out.innerHTML = '';
        out.appendChild(el('div', { style: 'font-weight:700;color:#2e7d32;margin-bottom:6px' }, '✓ Загружено строк: ' + d.imported + (d.notFoundCount ? (' · не найдено по ФИО: ' + d.notFoundCount) : '')));
        out.appendChild(el('div', { style: 'font-size:13px;line-height:1.7' }, [
          el('div', {}, 'Начислено: ' + money(t.accr)),
          el('div', {}, 'Удержано: ' + money(t.ded)),
          el('div', {}, 'Выплачено: ' + money(t.paid)),
          el('div', { style: 'font-weight:700' }, 'К выплате: ' + money(t.to_pay)),
        ]));
        out.appendChild(el('div', { class: 'hr-sub', style: 'margin-top:6px' }, 'Сверь эти итоги с файлом. Если сходится — закрой окно, таблица обновится.'));
        if (d.notFound && d.notFound.length) {
          out.appendChild(el('div', { style: 'margin-top:8px;font-weight:700;color:#b25b00' }, '⚠ Не нашёл по ФИО (' + d.notFoundCount + ') — заведи сотрудника или поправь имя:'));
          out.appendChild(el('div', { style: 'font-size:12.5px;max-height:180px;overflow:auto;margin-top:4px' }, d.notFound.map((n) => el('div', {}, '• ' + n.name + ' — ' + (n.sheet || '') + (n.accr ? (', начислено ' + money(n.accr)) : '')))));
        }
        load.textContent = 'Загрузить ещё';
        renderSalary();
      } catch (e) { out.innerHTML = ''; out.appendChild(el('div', { class: 'hr-empty' }, e.message)); }
    } }, 'Загрузить');
    modal('📊 Импорт зарплаты — ' + monthLabel(period), body, [load]);
  }

  async function renderSalary() {
    const c = $('#hr-content');
    c.innerHTML = '';   // очищаем — иначе при повторных вызовах ведомость дорисовывается сверху (дубли)
    if (!salState.period) salState.period = curMonth();
    const NORM_DEFAULTS = { day5: { d: 22, h: 176 }, day6: { d: 26, h: 208 }, shift22: { d: 15, h: 180 } };
    // Нормы хранятся ПО МЕСЯЦАМ: месяц выбирается прямо в окне, значения подтягиваются
    // сохранённые за него (а не значения по умолчанию) и сохраняются при «Применить».
    async function openFillNorms() {
      let period = salState.period;
      const rows = {};
      const grid = el('div', {});
      const note = el('div', { class: 'hr-sub' }, '');
      const monthInp = el('input', { type: 'month', class: 'hrf-inp', value: period });
      monthInp.onchange = () => { period = monthInp.value || salState.period; fill(); };
      async function fill() {
        grid.innerHTML = ''; note.textContent = 'Загружаю…';
        let d = { norms: {}, saved: false };
        try { d = await api('/norms?period=' + period); } catch (e) { /* покажем дефолт */ }
        note.textContent = d.saved
          ? 'Показаны сохранённые нормы за ' + monthLabel(period) + '.'
          : 'За ' + monthLabel(period) + ' нормы ещё не сохраняли — показаны значения по умолчанию, проверьте их.';
        grid.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 90px 90px;gap:8px;font-size:12px;color:#7c8579;font-weight:700' },
          [el('span', {}, 'График'), el('span', {}, 'План дни'), el('span', {}, 'План часы')]));
        (DICTS.schedules || []).forEach((s) => {
          const cur = (d.norms || {})[s.code] || {};
          const def = NORM_DEFAULTS[s.code] || { d: '', h: '' };
          const pd = minp(cur.plan_days != null ? cur.plan_days : def.d, { placeholder: 'дни' });
          const ph = minp(cur.plan_hours != null ? cur.plan_hours : def.h, { placeholder: 'часы' });
          rows[s.code] = { pd, ph };
          grid.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 90px 90px;gap:8px;align-items:center;margin-top:6px' }, [el('span', {}, s.name), pd, ph]));
        });
      }
      const body = el('div', { class: 'hrf' }, [
        el('div', { class: 'hr-sub', style: 'margin-bottom:8px' }, 'Нормы сохраняются за выбранный месяц и проставляются активным сотрудникам этого графика.'),
        frow('Месяц', monthInp), note, grid,
      ]);
      const save = el('button', { class: 'btn-primary', onclick: async () => {
        const norms = {}; Object.entries(rows).forEach(([c2, io]) => { norms[c2] = { plan_days: mval(io.pd), plan_hours: mval(io.ph) }; });
        try {
          const r = await post('/fill-norms', { period, norms });
          toast('Нормы сохранены за ' + monthLabel(period) + ' · проставлено: ' + r.count + (r.skipped ? ' · уже начислено, не тронуто ' + r.skipped : ''));
          closeModal();
          if (period === salState.period) load({ keep: true });
        } catch (e) { toast(e.message, true); }
      } }, 'Сохранить и применить');
      modal('Нормы по месяцам', body, [save]);
      await fill();
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
      el('div', {}, [el('div', { class: 'hr-h2' }, 'Зарплата — ' + monthLabel(salState.period)), el('div', { class: 'hr-sub' }, 'Заполни нормы и факт, затем нажми «Начислить» — зарплата посчитается по факту и появится. До этого суммы не показываются.')]),
      el('div', { style: 'display:flex;gap:8px;align-self:flex-start;flex-wrap:wrap' }, [
        el('button', { class: 'btn-ghost', onclick: openFillNorms }, '📋 Заполнить нормы'),
        el('button', { class: 'btn-ghost', onclick: openTimesheetImport }, '📥 Импорт табеля'),
        el('button', { class: 'btn-primary', onclick: () => { const ids = salItems.map((x) => x.emp_id); if (!ids.length) return toast('Нет сотрудников', true); if (!confirm('Начислить зарплату по факту всем показанным (' + ids.length + ')? У кого не заполнен факт — пропустятся.')) return; accrueEmps(ids, false); } }, '✅ Начислить всех'),
      ]),
    ]));
    showHrLockBadge();
    const mInp = HubDateRange.create({
      mode: 'month', period: salState.period,
      onChange: (v) => { salState.period = v.period || curMonth(); render(); },
    });
    const dSel = deptMulti(salState, 'department', load);
    // Состояние расчёта — по живым цифрам (не по служебной пометке строки):
    // «К выплате» = мы ещё должны сотруднику, включая частично выплаченных.
    const stSel = el('select', { class: 'hrf-inp hr-filt', onchange: (e) => { salState.status = e.target.value; load(); } }, [
      { v: '', t: 'Все' }, { v: 'accrued', t: 'Начислено' }, { v: 'none', t: 'Без начисления' },
      { v: 'topay', t: 'К выплате' }, { v: 'paid', t: 'Выплачено' },
    ].map((o) => el('option', { value: o.v, selected: o.v === salState.status || null }, o.t)));
    const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО', value: salState.q, oninput: (e) => { salState.q = e.target.value; clearTimeout(window.__hrS); window.__hrS = setTimeout(load, 300); } });
    c.appendChild(el('div', { class: 'hr-filters' }, [mInp, dSel, stSel, q]));
    const box = el('div', { id: 'hr-sal-box' }); c.appendChild(box);
    load();

    async function accrueEmps(empIds, undo) {
      if (!empIds || !empIds.length) return;
      try {
        const r = await post(undo ? '/payroll/unaccrue' : '/payroll/accrue', { period: salState.period, employee_ids: empIds });
        toast(undo ? ('Начисление снято: ' + r.affected)
          : ('Начислено: ' + r.done
            + (r.skipped ? (' · без факта пропущено ' + r.skipped) : '')
            + (r.already ? (' · уже начислено, не тронуто ' + r.already) : '')));
        load({ keep: true });
      } catch (e) { toast(e.message, true); }
    }
    async function factFromPlan(empIds) {
      if (!empIds || !empIds.length) return;
      try { const r = await post('/payroll/fact-from-plan', { period: salState.period, employee_ids: empIds }); toast('Факт = план проставлен: ' + r.affected + (r.already ? ' · уже начислено, не тронуто ' + r.already : '')); load({ keep: true }); }
      catch (e) { toast(e.message, true); }
    }
    // Печать расчётных карточек (6 на A4, 2×3) — только выбранные галочками.
    function printPayslips(emps) {
      if (!emps || !emps.length) return;
      const f = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
      const fn = (n) => (n == null || n === '') ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(n));
      const mo = monthLabel(salState.period);
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      // Строки печатаем только ненулевые — карточка остаётся компактной, но видно всё, что реально есть.
      const line = (label, val, cls) => (Math.round(Number(val) || 0) === 0) ? ''
        : '<div class="row' + (cls ? ' ' + cls : '') + '"><span class="lbl">' + esc(label) + '</span><span>'
          + (cls === 'd' ? '−' : cls === 'g' ? '+' : '') + f(val) + '</span></div>';
      const cards = emps.map((r) => {
        // Начисления — по статьям (оклад по табелю, бонусы, премия, ГСМ, больничные, отпускные и т.д.).
        const accrLines = ACCR_FIELDS.map(([k, label]) => line(label, r[k], 'g')).join('');
        // Удержания — по статьям + аванс наличными из Кассы (он тоже уменьшает выплату).
        const dedLines = DED_FIELDS.map(([k, label]) => line(label, r[k], 'd')).join('')
          + line('Аванс наличными (касса)', r.cash_advance, 'd');
        // Выплачено — обязательно раздельно: на карту и наличными.
        const cashPaid = (Number(r.paid_cash) || 0) + (Number(r.cash_paid) || 0);
        const payLines = line('На карту', r.paid_card) + line('Наличными', cashPaid);
        const hasPay = Math.round((Number(r.paid_card) || 0) + cashPaid) !== 0;
        return '<div class="card">'
          + '<div class="ch"><span class="nm">' + esc(r.full_name) + '</span><span class="mo">' + mo + '</span></div>'
          + '<div class="row"><span class="lbl">Оклад / ставка</span><span>' + f(r.base_salary) + '</span></div>'
          + '<div class="sub">Дни ' + fn(r.plan_days) + '/' + fn(r.fact_days) + ' · Часы ' + fn(r.plan_hours) + '/' + fn(r.fact_hours) + '</div>'
          + (accrLines ? '<div class="sec">Начислено</div>' + accrLines
            + '<div class="row st"><span class="lbl">Итого начислено</span><span>' + f(r.accrued) + '</span></div>' : '')
          + (dedLines ? '<div class="sec">Удержано</div>' + dedLines
            + '<div class="row st"><span class="lbl">Итого удержано</span><span>−' + f(r.deducted) + '</span></div>' : '')
          + (hasPay ? '<div class="sec">Выплачено</div>' + payLines
            + '<div class="row st"><span class="lbl">Итого выплачено</span><span>' + f(r.paid) + '</span></div>' : '')
          + '<div class="tot"><span>К выплате</span><span>' + f(r.to_pay) + '</span></div>'
          + '</div>';
      }).join('');
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>Расчётные листки — ' + mo + '</title><style>'
        + '@page{size:A4;margin:8mm}*{box-sizing:border-box}'
        + 'body{font-family:Arial,sans-serif;margin:0;color:#14241b}'
        + '.sheet{display:grid;grid-template-columns:1fr 1fr;gap:6mm}'
        + '.card{break-inside:avoid;border:0.4mm dashed #999;border-radius:2mm;padding:3mm 3.5mm;min-height:82mm;display:flex;flex-direction:column;gap:.8mm}'
        + '.ch{display:flex;justify-content:space-between;align-items:baseline;border-bottom:0.3mm solid #ccc;padding-bottom:1.2mm;margin-bottom:.6mm}'
        + '.nm{font-size:12pt;font-weight:bold}.mo{font-size:8pt;color:#777}'
        + '.row{display:flex;justify-content:space-between;font-size:9.5pt;gap:2mm}.lbl{color:#777}.sub{font-size:8.5pt;color:#777}'
        + '.sec{font-size:8pt;font-weight:bold;text-transform:uppercase;letter-spacing:.3pt;color:#555;margin-top:1.2mm;border-bottom:0.2mm solid #e2e2e2}'
        + '.st{font-weight:bold;border-top:0.2mm dotted #ccc;padding-top:.5mm}.st .lbl{color:#444}'
        + '.g{color:#2b6a0f}.d{color:#a32d2d}'
        + '.tot{display:flex;justify-content:space-between;align-items:baseline;border-top:0.3mm solid #ccc;padding-top:1.2mm;margin-top:auto}'
        + '.tot span:first-child{font-size:11pt;font-weight:bold}.tot span:last-child{font-size:14pt;font-weight:bold}'
        + '</style></head><body><div class="sheet">' + cards + '</div>'
        + '<scr' + 'ipt>window.onload=function(){window.print()}</scr' + 'ipt></body></html>';
      const w = window.open('', '_blank');
      if (!w) { toast('Разрешите всплывающие окна для печати', true); return; }
      w.document.write(html); w.document.close();
    }

    // Правка ячейки перезагружает ведомость (итоги должны пересчитаться), но раньше страницу
    // отбрасывало наверх и приходилось заново искать строку. Запоминаем прокрутку, выбор
    // сотрудников и ячейку с курсором — и возвращаем всё на место после перерисовки.
    let salRestore = null;
    async function load(opts) {
      const keep = opts && opts.keep;
      const scrollY = keep ? window.scrollY : 0;
      const keepSel = keep ? new Set(salSel) : null;
      box.innerHTML = '<div class="hr-loading">Считаю…</div>';
      salSel = keepSel || new Set();
      const p = new URLSearchParams({ period: salState.period });
      ['department', 'schedule', 'status', 'q'].forEach((k) => { if (salState[k]) p.set(k, salState[k]); });
      let d; try { d = await api('/payroll?' + p.toString()); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'hr-empty' }, 'Ошибка: ' + e.message)); return; }
      box.innerHTML = '';
      if (keep) {
        // Возвращаем позицию и курсор после того, как браузер отрисует новую таблицу.
        requestAnimationFrame(() => {
          window.scrollTo(0, scrollY);
          if (salRestore) {
            const sel = `.hr-cell[data-emp="${salRestore.emp}"][data-field="${salRestore.field}"]`;
            const node = box.querySelector(sel);
            if (node) { node.focus(); if (node.select) node.select(); }
            salRestore = null;
          }
        });
      }
      salItems = d.items || [];
      const s = d.summary;
      const bd = (title, fn) => () => openBreakdown(title, d.items, fn);
      // Авансы плюсуем к «Выплачено»; «Удержания» показываем без авансов — чтобы формула читалась.
      const advOf = (r) => (Number(r.ded_advance_card) || 0) + (Number(r.ded_advance_cash) || 0) + (Number(r.cash_advance) || 0);
      const sAdv = (Number(s.advances) || 0) + (Number(s.cash_advance) || 0);
      const uderzh = (Number(s.deducted) || 0) - sAdv;
      const vyplacheno = (Number(s.paid) || 0) + sAdv;
      box.appendChild(el('div', { class: 'hr-kpis hr-kpis-5' }, [
        kpi('Начислено (ФОТ)', money(s.accrued), 'green', bd('Начислено', (r) => r.accrued)),
        kpi('Бонусы/KPI', money(s.bonus), 'ink', bd('Бонусы/KPI', (r) => r.accr_bonus)),
        kpi('Удержания', money(uderzh), 'muted', bd('Удержания', (r) => (Number(r.deducted) || 0) - advOf(r))),
        kpi('Выплачено', money(vyplacheno), 'ink', bd('Выплачено (с авансами)', (r) => (Number(r.paid) || 0) + advOf(r)), sAdv ? 'в т.ч. аванс ' + money(sAdv) : ''),
        kpi('К выплате', money(s.to_pay), 'green', bd('К выплате', (r) => r.to_pay)),
      ]));
      box.appendChild(el('div', { class: 'hr-kpis hr-kpis-2', style: 'margin-bottom:14px' }, [kpi('Сотрудников', s.count, 'ink')]));
      // Блок «Выплаты из кассы без сотрудника» переехал во вкладку «Выплаты» — это про выдачу
      // денег, а не про расчёт; Зарплату не перегружаем.
      if (!d.items.length) { box.appendChild(el('div', { class: 'hr-empty' }, 'Нет сотрудников по фильтру.')); return; }
      const bulk = el('div', { id: 'hr-sal-bulk', class: 'hr-bulkbar', style: 'display:none' });
      const bulkN = el('span', { class: 'hr-bulk-n' }, '');
      const updBulk = () => { bulk.style.display = salSel.size ? 'flex' : 'none'; bulkN.textContent = 'Выбрано: ' + salSel.size; };
      bulk.appendChild(bulkN);
      const selEmpIds = () => [...salSel];   // salSel хранит emp_id — галочки есть у всех строк, в т.ч. «нет»
      bulk.appendChild(el('button', { onclick: () => { const emps = salItems.filter((x) => salSel.has(x.emp_id)); if (!emps.length) return; printPayslips(emps); } }, '🖨 Печать карточек'));
      bulk.appendChild(el('button', { onclick: () => { const ids = selEmpIds(); if (!ids.length) return; if (!confirm('Проставить факт = план выбранным (' + ids.length + ')? Для тех, кто отработал весь месяц. Нужны заполненные нормы.')) return; factFromPlan(ids); } }, '📋 Факт = план'));
      bulk.appendChild(el('button', { class: 'btn-primary', onclick: () => { const ids = selEmpIds(); if (!ids.length) return; if (!confirm('Начислить зарплату по факту выбранным (' + ids.length + ')? У кого нет факта — пропустятся.')) return; accrueEmps(ids, false); } }, '✅ Начислить выбранных'));
      bulk.appendChild(el('button', { class: 'btn-ghost', onclick: () => { const ids = selEmpIds(); if (!ids.length) return; if (!confirm('Снять начисление у выбранных (' + ids.length + ')? Факт останется, суммы снова скроются.')) return; accrueEmps(ids, true); } }, '↩ Отменить начисление'));
      bulk.appendChild(el('button', { class: 'btn-ghost hr-del', onclick: async () => { const pids = salItems.filter((x) => salSel.has(x.emp_id) && x.id).map((x) => x.id); if (!pids.length) return toast('Нет строк начисления для удаления', true); if (!confirm('Удалить выбранные начисления (' + pids.length + ')? Сотрудники останутся.')) return; try { const rr = await post('/payroll/bulk-delete', { ids: pids }); toast('Удалено: ' + rr.affected); load(); } catch (e) { toast(e.message, true); } } }, '🗑 Удалить начисления'));
      bulk.appendChild(el('button', { class: 'btn-ghost', onclick: () => { salSel.clear(); load(); } }, 'Снять'));
      box.appendChild(bulk);
      const selAll = el('input', { type: 'checkbox', class: 'hr-chk' });
      selAll.onclick = (ev) => { const on = ev.target.checked; salSel = new Set(on ? d.items.map((x) => x.emp_id) : []); box.querySelectorAll('.hr-salchk').forEach((cc) => { cc.checked = on; }); updBulk(); };
      const HEADS = [
        ['ФИО'],
        ['Дн. п/ф', 'Плановые / фактические дни'],
        ['Часы п/ф', 'Плановые / фактические часы'],
        ['Начислено', 'Оклад по табелю (факт)'],
        ['Доп. нач.', 'Бонусы KPI, премия, ГСМ, больничные, отпускные, матпомощь — клик по сумме, чтобы изменить'],
        ['Удержания', 'Штрафы, удержание, долг компании — клик по сумме, чтобы изменить'],
        ['Аванс', 'Выданные авансы: карта + наличные'],
        ['Выплачено', 'Выплаченная зарплата'],
        ['К выплате', 'Итог к выдаче: начислено + доп. − удержания − аванс − выплачено'],
        ['Статус'],
      ];
      const head = el('div', { class: 'hr-row head hr-sal' }, [selAll, el('span', { class: 'hr-idx' }, '#'), ...HEADS.map(([h, t]) => el('span', t ? { title: t } : {}, h))]);
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
              // Окно остаётся открытым, список под ним обновляется без прыжка наверх.
              try { await post('/payroll/cell', { employee_id: r.emp_id, period: salState.period, field: k, value: mval(i) }); load({ keep: true }); }
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
      // Дни/часы показываем как есть, с дробной частью (15,5 не округляем). Формат — русский (запятая), чтобы mval корректно читал ввод.
      const cellNum = (r, field) => {
        const inp = el('input', { class: 'hr-cell', 'data-emp': r.emp_id, 'data-field': field, value: (r[field] == null || r[field] === '') ? '' : Number(r[field]).toLocaleString('ru-RU', { maximumFractionDigits: 2 }), onclick: (ev) => ev.stopPropagation() });
        inp.onchange = async () => {
          salRestore = { emp: r.emp_id, field };   // вернём курсор в эту же ячейку
          try { await post('/payroll/cell', { employee_id: r.emp_id, period: salState.period, field, value: mval(inp) }); load({ keep: true }); }
          catch (e) { toast(e.message, true); }
        };
        return inp;
      };
      const pf = (r, a, b2) => el('span', { class: 'hr-pf' }, [cellNum(r, a), el('span', { class: 'hr-pf-sep' }, '/'), cellNum(r, b2)]);
      box.appendChild(el('div', { class: 'hr-list' }, [head, ...d.items.map((r, i) => {
        const chk = el('input', { type: 'checkbox', class: 'hr-chk hr-salchk', checked: salSel.has(r.emp_id) || null, onclick: (ev) => { ev.stopPropagation(); if (ev.target.checked) salSel.add(r.emp_id); else salSel.delete(r.emp_id); updBulk(); } });
        return el('div', { class: 'hr-row hr-sal', onclick: () => openPayroll(r) }, [
          chk,
          el('span', { class: 'hr-idx' }, String(i + 1)),
          el('span', { style: 'font-weight:700' }, r.full_name),
          pf(r, 'plan_days', 'fact_days'),
          pf(r, 'plan_hours', 'fact_hours'),
          el('span', { class: 'tnum hr-extra', title: 'Начислено: оклад ' + money(r.base_salary || 0) + ' / ' + (Number(r.plan_hours) > 0 ? ((r.plan_hours || 0) + ' ч × ' + (r.fact_hours || 0) + ' факт-ч') : ((r.plan_days || 0) + ' дн × ' + (r.fact_days || 0) + ' факт-дн')) + ' · клик — править вручную', onclick: (ev) => { ev.stopPropagation(); openExtra(r, 'Начислено', [['accr_fact', 'Начислено (ручная правка)']]); } }, money(r.accr_fact)),
          extraCell(r, 'Доп. начисления', EXTRA_ACCR),
          extraCell(r, 'Удержания', EXTRA_DED),
          el('span', { class: 'tnum' }, [money((Number(r.ded_advance_card) || 0) + (Number(r.ded_advance_cash) || 0)), (Number(r.cash_advance) > 0 ? el('div', { style: 'font-size:11px;font-weight:700;color:#2e7d32;margin-top:2px;cursor:pointer;text-decoration:underline', title: 'Показать транзакции', onclick: (ev) => { ev.stopPropagation(); openCashTxs((r.cash_txs || []).filter((t) => t.kind === 'advance'), '💵 Авансы наличными — ' + (r.full_name || '')); } }, '💵 касса ' + money(r.cash_advance)) : null)]),
          el('span', { class: 'tnum' }, [money(r.paid), (Number(r.cash_paid) > 0 ? el('div', { style: 'font-size:11px;font-weight:700;color:#2e7d32;margin-top:2px;cursor:pointer;text-decoration:underline', title: 'Показать транзакции', onclick: (ev) => { ev.stopPropagation(); openCashTxs((r.cash_txs || []).filter((t) => t.kind !== 'advance'), '💵 Зарплата наличными — ' + (r.full_name || '')); } }, '💵 касса ' + money(r.cash_paid)) : null)]),
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
    const mInp = HubDateRange.create({
      mode: 'month', period: massState.period,
      onChange: (v) => { massState.period = v.period || curMonth(); render(); },
    });
    const opSel = fsel(MASS_OPS.map((o) => ({ v: o[0], t: o[1] })), massState.field);
    opSel.classList.add('hr-filt'); opSel.onchange = (e) => { massState.field = e.target.value; load(); };
    const modeSel = fsel([{ v: 'add', t: 'Добавить к текущему' }, { v: 'set', t: 'Заменить' }], massState.mode);
    modeSel.classList.add('hr-filt'); modeSel.onchange = (e) => { massState.mode = e.target.value; };
    const dSel = deptMulti(massState, 'department', load);
    const q = el('input', { class: 'hrf-inp hr-filt hr-filt-q', placeholder: 'Поиск по ФИО', value: massState.q, oninput: (e) => { massState.q = e.target.value; clearTimeout(window.__hrM); window.__hrM = setTimeout(load, 300); } });
    c.appendChild(el('div', { class: 'hr-filters' }, [el('span', { class: 'hr-flab' }, 'Операция:'), opSel, modeSel, mInp, dSel, q]));
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
      // Удержания и авансы «начислить» нельзя — они уменьшают выплату, поэтому
      // подписи у них свои.
      const isDed = field.indexOf('ded_') === 0;
      const actWord = isDed ? 'Внести' : 'Начислить';
      const fillBtn = el('button', { class: 'btn-ghost', onclick: () => { if (fillAll.value === '') return; rowsModel.forEach((m) => { if (m.amountInp) m.amountInp.value = fillAll.value; }); toast('Проставлено всем — не забудьте «' + actWord + '»'); } }, 'Заполнить всем');
      const applyBtn = el('button', { class: 'btn-primary', onclick: apply }, '⚡ ' + actWord);
      box.appendChild(el('div', { class: 'hr-filters', style: 'justify-content:flex-end' }, [el('span', { class: 'hr-flab' }, 'Сумма всем:'), fillAll, fillBtn, applyBtn]));
      const head = el('div', { class: 'hr-row head hr-mass' }, ['#', 'ФИО', 'Отдел', 'Оклад', 'Текущее «' + opLabel + '»', isDed ? 'Сумма' : 'Сумма к начислению'].map((h) => el('span', {}, h)));
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
        if (!confirm((massState.mode === 'set' ? 'Заменить' : actWord) + ' «' + label + '» ' + items.length + ' сотрудникам за ' + monthLabel(massState.period) + '?')) return;
        applyBtn.disabled = true; applyBtn.textContent = 'Сохраняю…';
        try { const rr = await post('/mass-op', { period: massState.period, field, mode: massState.mode, items }); toast('Готово: ' + rr.applied); load(); }
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
