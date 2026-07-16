// cash.js — SPA модуля «Касса». Этап 1: справочники (просмотр).
(function () {
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'html') n.innerHTML = v;
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) { if (c == null) continue; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return n;
  };
  const money = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
  const ruDate = (s) => { const m = String(s || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? (m[3] + '.' + m[2] + '.' + m[1]) : (s || ''); };
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const monthStartStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01'; };
  async function api(path) {
    const res = await fetch('/cash/api' + path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
  }

  async function post(path, body) {
    const res = await fetch('/cash/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка');
    return data;
  }
  function toast(msg, err) {
    const t = el('div', { class: 'cash-toast' + (err ? ' err' : '') }, msg);
    document.body.appendChild(t); setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
  }
  function closeModal() { $('#cash-modal-root').innerHTML = ''; }
  function modal(title, body, actions) {
    const root = $('#cash-modal-root'); root.innerHTML = '';
    const overlay = el('div', { class: 'cashm-overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } });
    overlay.appendChild(el('div', { class: 'cashm-panel' }, [
      el('div', { class: 'cashm-head' }, [el('h3', {}, title), el('button', { class: 'cashm-x', onclick: closeModal }, '✕')]),
      el('div', { class: 'cashm-body' }, [body]),
      actions && actions.length ? el('div', { class: 'cashm-acts' }, actions) : null,
    ]));
    root.appendChild(overlay);
  }
  async function reload() { try { DICTS = await api('/dicts'); } catch (e) {} render(); }
  async function refreshDicts() { try { DICTS = await api('/dicts'); } catch (e) {} }
  const frow = (label, control) => el('label', { class: 'cashf-row' }, [el('span', {}, label), control]);
  const finp = (val, attrs) => el('input', Object.assign({ class: 'cashf-inp', value: val == null ? '' : String(val) }, attrs || {}));
  // Денежное поле: обычный <input type="number"> молча стирает значение при вводе через запятую
  // (родная раскладка RU/UZ) — .value браузер отдаёт пустой строкой. Поэтому суммы вводим как
  // текст с числовой клавиатурой на мобильном (inputmode: decimal), а запятую сами превращаем в точку.
  const fmoney = (val, attrs) => finp(val, Object.assign({ inputmode: 'decimal', placeholder: '0' }, attrs || {}, { type: 'text' }));
  const moneyVal = (inp) => String(inp.value || '').trim().replace(/\s/g, '').replace(',', '.');
  const fsel = (options, val) => el('select', { class: 'cashf-inp' }, options.map((o) => el('option', { value: o.v, selected: String(o.v) === String(val) || null }, o.t)));
  const catOptions = () => [{ v: '', t: '— статья —' }].concat((DICTS.categories || []).map((c) => ({ v: c.id, t: c.code + ' · ' + c.name })));
  const supOptions = () => [{ v: '', t: '— нет —' }].concat((DICTS.suppliers || []).map((s) => ({ v: s.id, t: s.name })));
  const cpOptions = () => [{ v: '', t: '— контрагент —' }].concat((DICTS.counterparties || []).map((c) => ({ v: c.id, t: c.name })));

  function openWalletForm(w) {
    w = w || {};
    const name = finp(w.name, { placeholder: 'Название' });
    const kind = fsel([{ v: 'bank', t: 'Расчётный счёт' }, { v: 'card', t: 'Карта' }, { v: 'cash', t: 'Наличные' }, { v: 'reserve', t: 'Резерв' }], w.kind || 'bank');
    const acc = finp(w.account_no, { placeholder: 'Номер счёта (необязательно)' });
    const color = finp(w.color || '#163a28', { type: 'color' });
    const sort = finp(w.sort_order != null ? w.sort_order : 100, { type: 'number' });
    const body = el('div', { class: 'cashf' }, [frow('Название', name), frow('Тип', kind), frow('Счёт', acc), frow('Цвет', color), frow('Порядок', sort)]);
    const save = el('button', { class: 'btn-primary', onclick: async () => { try { await post('/wallet', { id: w.id, name: name.value, kind: kind.value, account_no: acc.value, color: color.value, sort_order: sort.value }); toast('Сохранено'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'Сохранить');
    const acts = [save];
    if (w.id) acts.unshift(el('button', { class: 'btn-ghost cashf-arch', onclick: async () => { if (!confirm('Архивировать кошелёк «' + w.name + '»?')) return; try { await post('/wallet/' + w.id + '/archive', {}); toast('В архиве'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'В архив'));
    modal(w.id ? 'Кошелёк' : 'Новый кошелёк', body, acts);
  }

  function openCategoryForm(c) {
    c = c || {};
    const code = finp(c.code, { placeholder: 'Код (напр. 10)' });
    const name = finp(c.name, { placeholder: 'Название' });
    // Текущая группа статьи всегда должна быть в списке — иначе выпадашка сбросится на пустую
    // и при сохранении затрёт группу (статья «переедет» в раздел «—» и потеряется).
    const grpNames = (DICTS.groups || []).map((g) => g.name);
    if (c.group_name && grpNames.indexOf(c.group_name) === -1) grpNames.push(c.group_name);
    const grpOpts = [{ v: '', t: '— группа —' }].concat(grpNames.map((n) => ({ v: n, t: n })));
    const grp = fsel(grpOpts, c.group_name || '');
    const flow = fsel([{ v: 'operating', t: 'Операционный' }, { v: 'investing', t: 'Инвестиции (капекс)' }, { v: 'financing', t: 'Финансы (кредиты/налоги)' }], c.flow_type || 'operating');
    const onlyT = el('input', { type: 'checkbox' }); if (c.only_transfer) onlyT.checked = true;
    const kw = el('textarea', { class: 'cashf-inp', rows: 2, placeholder: 'через запятую: начислен, % банка, комиссия банк' }, c.keywords || '');
    const body = el('div', { class: 'cashf' }, [
      frow('Код', code), frow('Название', name), frow('Группа', grp), frow('Поток (P&L)', flow), frow('Только перечислением ★', onlyT),
      frow('Ключевые слова', kw),
      el('div', { class: 'cash-note-info' }, 'Если в назначении или «от кого» встретится любая из этих фраз — операция сама получит эту статью. Разделяй запятой.'),
    ]);
    // Порядок в списке = код статьи (10, 11, 12…), отдельное поле не нужно.
    const save = el('button', { class: 'btn-primary', onclick: async () => { try { await post('/category', { id: c.id, code: code.value, name: name.value, group_name: grp.value, flow_type: flow.value, only_transfer: onlyT.checked, sort_order: (parseInt(code.value, 10) || 0), keywords: kw.value }); toast('Сохранено'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'Сохранить');
    const acts = [save];
    if (c.id) {
      acts.unshift(el('button', { class: 'btn-ghost cashf-arch', onclick: async () => { if (!confirm('Архивировать статью «' + c.code + ' ' + c.name + '»?')) return; try { await post('/category/' + c.id + '/archive', {}); toast('В архиве'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'В архив'));
      acts.unshift(el('button', { class: 'btn-ghost cashf-del', onclick: async () => { if (!confirm('Удалить статью «' + c.code + ' ' + c.name + '» безвозвратно?')) return; try { await post('/category/' + c.id + '/delete', {}); toast('Удалено'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'Удалить'));
    }
    modal(c.id ? 'Статья ДДС' : 'Новая статья', body, acts);
  }

  function openGroupsManager() {
    const list = el('div', { class: 'cash-grp-list' });
    function rowG(g) {
      g = g || {};
      const name = finp(g.name, { placeholder: 'Название группы' });
      const sort = finp(g.sort_order != null ? g.sort_order : 100, { type: 'number' });
      const save = el('button', { class: 'btn-primary cash-gsave', onclick: async () => { if (!name.value.trim()) return toast('Введите название', true); try { await post('/group', { id: g.id, name: name.value, sort_order: sort.value }); toast('Сохранено'); await refreshDicts(); } catch (e) { toast(e.message, true); } } }, g.id ? '✓' : 'Доб.');
      const cells = [name, sort, save];
      if (g.id) cells.push(el('button', { class: 'cash-gdel', title: 'В архив', onclick: async () => { if (!confirm('Архивировать группу «' + g.name + '»?')) return; try { await post('/group/' + g.id + '/archive', {}); toast('В архиве'); await refreshDicts(); openGroupsManager(); } catch (e) { toast(e.message, true); } } }, '🗑'));
      return el('div', { class: 'cash-grow' }, cells);
    }
    (DICTS.groups || []).forEach((g) => list.appendChild(rowG(g)));
    const add = el('button', { class: 'btn-ghost', onclick: () => list.appendChild(rowG(null)) }, '+ Группа');
    modal('Группы статей', el('div', { class: 'cashf' }, [el('div', { class: 'cash-sub' }, 'Добавляйте и переименовывайте группы — они появятся в выпадашке у статьи.'), list, add]), []);
  }

  function openCpForm(c) {
    c = c || {};
    const name = finp(c.name, { placeholder: 'Название' });
    const inn = finp(c.inn, { placeholder: 'ИНН' });
    const code = finp(c.bank_code, { placeholder: 'Код из выписки (напр. 01071)' });
    const cat = fsel(catOptions(), c.default_category_id || '');
    const comment = finp(c.comment, { placeholder: 'Комментарий' });
    const body = el('div', { class: 'cashf' }, [frow('Название', name), frow('ИНН', inn), frow('Код выписки', code), frow('Статья по умолч.', cat), frow('Комментарий', comment)]);
    const save = el('button', { class: 'btn-primary', onclick: async () => { try { await post('/counterparty', { id: c.id, name: name.value, inn: inn.value, bank_code: code.value, default_category_id: cat.value, linked_supplier_id: c.linked_supplier_id || '', comment: comment.value }); toast('Сохранено'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'Сохранить');
    const acts = [save];
    if (c.id) acts.unshift(el('button', { class: 'btn-ghost cashf-arch', onclick: async () => { if (!confirm('Архивировать контрагента «' + c.name + '»?')) return; try { await post('/counterparty/' + c.id + '/archive', {}); toast('В архиве'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'В архив'));
    modal(c.id ? 'Контрагент' : 'Новый контрагент', body, acts);
  }

  function openContractForm(k) {
    k = k || {};
    const cp = fsel(cpOptions(), k.counterparty_id || '');
    const number = finp(k.number, { placeholder: '№ договора' });
    const subject = finp(k.subject, { placeholder: 'Предмет' });
    const cat = fsel(catOptions(), k.category_id || '');
    const amount = fmoney(k.amount, { placeholder: 'Сумма (необязательно)' });
    const ds = finp(k.date_start ? String(k.date_start).slice(0, 10) : '', { type: 'date' });
    const de = finp(k.date_end ? String(k.date_end).slice(0, 10) : '', { type: 'date' });
    const status = fsel([{ v: 'active', t: 'Действует' }, { v: 'closed', t: 'Закрыт' }], k.status || 'active');
    const body = el('div', { class: 'cashf' }, [frow('Контрагент', cp), frow('Номер', number), frow('Предмет', subject), frow('Статья ДДС', cat), frow('Сумма', amount), frow('С', ds), frow('По', de), frow('Статус', status)]);
    const save = el('button', { class: 'btn-primary', onclick: async () => { try { await post('/contract', { id: k.id, counterparty_id: cp.value, number: number.value, subject: subject.value, category_id: cat.value, amount: moneyVal(amount), date_start: ds.value, date_end: de.value, status: status.value }); toast('Сохранено'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'Сохранить');
    modal(k.id ? 'Договор' : 'Новый договор', body, [save]);
  }

  const addBtn = (label, fn) => el('button', { class: 'btn-primary cash-add', onclick: fn }, label);

  const FLOW_LABEL = { operating: 'операционный', investing: 'инвестиции', financing: 'финансы' };
  let DICTS = null;
  let TAB = 'wallets';
  let SUB = 'categories';
  let cpView = 'main';
  let cpFilterCat = '';
  let cpFilterQ = '';
  let cpFilterSrc = '';
  const triageState = { from: '', to: '', wallet: '' };

  function shell() {
    const main = $('#cash-main'); main.innerHTML = '';
    const tab = (id, label) => el('button', { class: 'cash-tab' + (TAB === id ? ' on' : ''), onclick: () => { TAB = id; render(); } }, label);
    main.appendChild(el('div', { class: 'cash-tabs' }, [
      tab('cashbox', '🪙 Наличная касса'),
      tab('tx', '💸 Транзакции'),
      tab('triage', '🧩 Разбор'),
      tab('cashflow', '📊 Кэш-флоу (ДДС)'),
      tab('pnl', '📈 P&L'),
      tab('wallets', '👛 Кошельки'),
      tab('dicts', '📁 Справочники'),
    ]));
    main.appendChild(el('div', { id: 'cash-content' }));
  }
  function render() {
    shell();
    if (TAB === 'tx') return renderTransactions();
    if (TAB === 'cashbox') return renderCashbox();
    if (TAB === 'triage') return renderTriage();
    if (TAB === 'cashflow') return renderReport('cashflow');
    if (TAB === 'pnl') return renderReport('pnl');
    if (TAB === 'wallets') return renderWallets();
    if (TAB === 'dicts') return renderDicts();
    return renderSoon();
  }
  function renderSoon() {
    $('#cash-content').appendChild(el('div', { class: 'cash-soon' }, 'Этот раздел появится на следующем этапе. Пока готов фундамент и справочники.'));
  }

  // ---------- Умный разбор «Не разобрано» ----------
  async function renderTriage() {
    const c = $('#cash-content'); c.innerHTML = '';
    c.appendChild(el('div', { class: 'cash-head' }, [
      el('div', {}, [el('div', { class: 'cash-h2' }, 'Разбор «Не разобрано»'),
        el('div', { class: 'cash-sub' }, 'Неразобранные операции сгруппированы по контрагенту. Поставь статью и «Разобери» пачкой; «Запомнить» — правило для будущих импортов.')]),
    ]));
    const dinp = (k) => el('input', { type: 'date', class: 'cashf-inp cash-filt', value: triageState[k], onchange: (e) => { triageState[k] = e.target.value; renderTriage(); } });
    const walletSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { triageState.wallet = e.target.value; renderTriage(); } }, [el('option', { value: '' }, 'Все кошельки'), ...(DICTS.wallets || []).map((w) => el('option', { value: w.id, selected: String(w.id) === triageState.wallet || null }, w.name))]);
    c.appendChild(el('div', { class: 'cash-filters' }, [el('span', { class: 'cash-flab' }, 'С'), dinp('from'), el('span', { class: 'cash-flab' }, 'по'), dinp('to'), walletSel]));
    const box = el('div', { id: 'cash-triage-box' }); c.appendChild(box);
    box.appendChild(el('div', { class: 'cash-empty' }, 'Считаю…'));
    let d; try { const p = new URLSearchParams(); ['from', 'to', 'wallet'].forEach((k) => { if (triageState[k]) p.set(k, triageState[k]); }); d = await api('/triage/groups?' + p.toString()); }
    catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'cash-empty' }, 'Ошибка: ' + e.message)); return; }
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'cash-tot-bar' }, [
      el('span', {}, 'Групп: ' + d.groups.length),
      el('span', { class: 'cash-tot-unc' }, 'Не разобрано операций: ' + d.totalCnt),
      el('span', { class: 'cash-tot-net' }, 'На сумму: ' + money(d.totalSum)),
    ]));
    if (!d.groups.length) { box.appendChild(el('div', { class: 'cash-empty' }, 'Всё разобрано 👍')); return; }
    d.groups.forEach((g) => box.appendChild(triageCard(g)));
  }
  function triageCard(g) {
    const cat = fsel(catOptions(), g.default_category_id || '');
    const remember = el('input', { type: 'checkbox', checked: g.cp_id ? true : null, disabled: g.cp_id ? null : true });
    const card = el('div', { class: 'cash-triage-card' }, [
      el('div', { class: 'cash-triage-info' }, [
        el('div', { class: 'cash-triage-name' }, g.name + (g.key_type === 'payer' ? ' · (из выписки)' : '')),
        el('div', { class: 'cash-triage-meta' }, g.cnt + ' операц.' + (g.sum_in ? ' · приход ' + money(g.sum_in) : '') + (g.sum_out ? ' · расход ' + money(g.sum_out) : '')),
        g.sample ? el('div', { class: 'cash-triage-sample' }, '«' + g.sample + '»') : null,
      ]),
      el('div', { class: 'cash-triage-act' }, [
        cat,
        el('label', { class: 'cash-triage-rem', title: g.cp_id ? 'Запомнить статью для этого контрагента (авто на будущее)' : 'Правило доступно только для контрагентов' }, [remember, ' запомнить']),
        el('button', { class: 'btn-primary', onclick: async () => {
          if (!cat.value) return toast('Выберите статью', true);
          try {
            const r = await post('/triage/classify', { cp_id: g.cp_id, payer_name: g.payer_name, category_id: cat.value, remember: !!(g.cp_id && remember.checked), from: triageState.from, to: triageState.to, wallet: triageState.wallet });
            toast('Разобрано: ' + r.applied); card.remove();
          } catch (e) { toast(e.message, true); }
        } }, 'Разобрать'),
      ]),
    ]);
    return card;
  }

  // Панель периода для отчётов (месяц по умолчанию — текущий).
  function repPeriodBar() {
    const dinp = (k) => el('input', { type: 'date', class: 'cashf-inp cash-filt', value: repState[k], onchange: (e) => { repState[k] = e.target.value; render(); } });
    const preset = (label, from, to) => el('button', { class: 'cash-preset', onclick: () => { repState.from = from; repState.to = to; render(); } }, label);
    const now = new Date();
    const ym = (y, m) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const mEnd = (y, m) => new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
    const walletSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { repState.wallet = e.target.value; render(); } }, [
      el('option', { value: '' }, 'Все кошельки'),
      ...(DICTS.wallets || []).map((w) => el('option', { value: w.id, selected: String(w.id) === repState.wallet || null }, w.name)),
    ]);
    return el('div', { class: 'cash-filters' }, [
      el('span', { class: 'cash-flab' }, 'С'), dinp('from'), el('span', { class: 'cash-flab' }, 'по'), dinp('to'),
      preset('Текущий месяц', monthStartStr(), todayStr()),
      preset('Прошлый месяц', ym(now.getFullYear(), now.getMonth() - 1), mEnd(now.getFullYear(), now.getMonth() - 1)),
      preset('Год', ym(now.getFullYear(), 0), todayStr()),
      walletSel,
    ]);
  }

  const FLOW_RU = { operating: 'Операционный', investing: 'Инвестиции', financing: 'Финансы' };

  async function renderReport(kind) {
    const c = $('#cash-content');
    if (kind === 'pnl') { c.innerHTML = ''; renderPnl(c); return; }
    c.innerHTML = '<div class="cash-loading">Считаю…</div>';
    if (!repState.from) repState.from = monthStartStr();
    if (!repState.to) repState.to = todayStr();
    const wq = repState.wallet ? '&wallet=' + repState.wallet : '';
    let d; try { d = await api('/report?from=' + repState.from + '&to=' + repState.to + wq); } catch (e) { c.innerHTML = ''; c.appendChild(el('div', { class: 'cash-empty' }, 'Ошибка: ' + e.message)); return; }
    c.innerHTML = '';
    renderCashflow(c, d.rows || [], d.groups || [], d.a2a || { inc: 0, exp: 0 }, d.internal || [], d.obnal || { received: 0, commission: 0, sent: 0 });
  }

  function kpiBar(items) {
    return el('div', { class: 'cash-tot-bar' }, items.map(([label, val, cls]) =>
      el('span', { class: 'cash-kpi' }, [el('span', { class: 'cash-kpi-l' }, label + ': '), el('span', { class: 'cash-' + cls }, money(val))])));
  }

  // Проваливание из отчёта в транзакции: фильтр по статье за тот же период/кошелёк.
  function drillBase() {
    txState.from = repState.from || monthStartStr();
    txState.to = repState.to || todayStr();
    txState.wallet = repState.wallet || '';
    txState.type = ''; txState.q = ''; txState.counterparty = ''; txState.page = 1;
    txState.category = ''; txState.catgroup = ''; txState.classified = '';
  }
  function drillToTx(r) {
    drillBase();
    if (r.cat_id) txState.category = String(r.cat_id);
    else txState.classified = 'no';
    TAB = 'tx'; render();
  }
  // Клик по группе в легенде пончика → все транзакции этой группы.
  function drillToGroup(label) {
    drillBase();
    if (label === 'Не разобрано') txState.classified = 'no';
    else if (label === 'Прочее') txState.catgroup = '__nogroup__';
    else txState.catgroup = label;
    TAB = 'tx'; render();
  }

  const CHART_COLORS = ['#163a28', '#8cc63f', '#2e7d32', '#b25b00', '#5b3da8', '#c0392b', '#0d7d8c', '#c77800', '#7c8579', '#3f6a16'];
  function donutChart(items, capTitle) {
    const total = items.reduce((s, i) => s + i.value, 0);
    if (!total) return el('div', { class: 'cash-sub' }, 'Нет данных за период.');
    const size = 200, r = size / 2 - 18, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
    let off = 0;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const segs = items.map((it) => {
      const len = it.value / total * C;
      const pct = Math.round(it.value / total * 100);
      const s = `<circle class="cash-seg" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="28" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${esc(it.label)}: ${money(it.value)} · ${pct}%</title></circle>`;
      off += len; return s;
    }).join('');
    const svg = `<svg viewBox="0 0 ${size} ${size}" class="cash-donut"><g>${segs}</g><text x="${cx}" y="${cy - 2}" text-anchor="middle" class="cash-donut-cap">${capTitle || 'Итого'}</text><text x="${cx}" y="${cy + 18}" text-anchor="middle" class="cash-donut-val">${money(total)}</text></svg>`;
    const chart = el('div', { class: 'cash-donut-wrap' }); chart.innerHTML = svg;
    const legend = el('div', { class: 'cash-legend' }, items.map((it) => el('div', { class: 'cash-legend-row cash-legend-click', title: 'Открыть транзакции: ' + it.label, onclick: () => drillToGroup(it.label) }, [
      el('span', { class: 'cash-legend-dot', style: 'background:' + it.color }),
      el('span', { class: 'cash-legend-l' }, it.label + ' →'),
      el('span', { class: 'cash-legend-v' }, money(it.value) + ' · ' + Math.round(it.value / total * 100) + '%'),
    ])));
    return el('div', { class: 'cash-chart-card' }, [chart, legend]);
  }

  function renderCashflow(c, rows, groupsOrder, a2a, internal, obnal) {
    a2a = a2a || { inc: 0, exp: 0 };
    internal = internal || []; obnal = obnal || { received: 0, commission: 0, sent: 0 };
    c.appendChild(el('div', { class: 'cash-head' }, [el('div', {}, [
      el('div', { class: 'cash-h2' }, 'Кэш-флоу (ДДС)'),
      el('div', { class: 'cash-sub' }, 'Движение денег по статьям за период. Переводы между счетами — отдельным блоком «Внутренние перемещения», в поток не входят.'),
    ])]));
    c.appendChild(repPeriodBar());
    const totalIn = rows.reduce((s, r) => s + r.inc, 0);
    const totalOut = rows.reduce((s, r) => s + r.exp, 0);
    c.appendChild(kpiBar([['Поступления', totalIn, 'tot-in'], ['Выбытия', totalOut, 'tot-out'], ['Чистый поток', totalIn - totalOut, (totalIn - totalOut) >= 0 ? 'tot-in' : 'tot-out']]));

    // Разбивка по типу потока + A2A (переводы между счетами)
    const flows = { operating: 0, investing: 0, financing: 0 };
    rows.forEach((r) => { if (flows[r.flow_type] != null) flows[r.flow_type] += r.inc - r.exp; });
    const FLOW_HINT = { operating: 'Основная деятельность: продажи, сырьё, зарплаты, аренда', investing: 'Капвложения: оборудование, стройка', financing: 'Кредиты, проценты, налоги, взносы учредителей' };
    const flowCard = (l, hint, val) => el('div', { class: 'cash-flow-card', title: hint }, [el('div', { class: 'cash-flow-card-l' }, l), el('div', { class: 'cash-flow-card-hint' }, hint), el('div', { class: 'cash-flow-card-v ' + (val >= 0 ? 'cash-tot-in' : 'cash-tot-out') }, money(val))]);
    const obnalCell = (l, val, cls) => el('div', { class: 'cash-obnal-cell' }, [el('div', { class: 'cash-obnal-cell-l' }, l), el('div', { class: 'cash-obnal-cell-v ' + (cls || '') }, money(val))]);
    const a2aNet = (a2a.inc || 0) - (a2a.exp || 0);
    c.appendChild(el('div', { class: 'cash-flow-cards cash-flow-cards-4' }, [
      flowCard('Операционный', FLOW_HINT.operating, flows.operating),
      flowCard('Инвестиции', FLOW_HINT.investing, flows.investing),
      flowCard('Финансы', FLOW_HINT.financing, flows.financing),
      flowCard('Внутренние переводы', 'Перемещения между своими счетами/картами/кассой — не доход и не расход', a2aNet),
    ]));

    // Внутренние перемещения: разбивка по под-категориям (межбанк / обнал / пополнение карты) + детализация обнала.
    if ((internal && internal.length) || obnal.sent) {
      const im = el('div', { class: 'cash-internal' });
      im.appendChild(el('div', { class: 'cash-h3' }, 'Внутренние перемещения'));
      im.appendChild(el('div', { class: 'cash-sub' }, 'Перемещения между своими счетами. В доходы/расходы не входят — по всем кошелькам в сумме гасятся. Реальный расход при получении наличных — только комиссия.'));
      if (internal && internal.length) {
        im.appendChild(el('div', { class: 'cash-internal-rows' }, internal.map((x) => el('div', { class: 'cash-internal-row' }, [
          el('span', { class: 'cash-internal-name' }, (x.code ? x.code + ' ' : '') + x.name),
          el('span', { class: 'cash-internal-val' }, money(x.moved)),
        ]))));
      }
      if (obnal.sent) {
        im.appendChild(el('div', { class: 'cash-obnal' }, [
          el('div', { class: 'cash-obnal-h' }, '💵 Получение наличных за период'),
          el('div', { class: 'cash-obnal-cells' }, [
            obnalCell('Ушло со счёта', obnal.sent, ''),
            obnalCell('Получено в кассу', obnal.received, 'cash-tot-in'),
            obnalCell('Комиссия (расход)', obnal.commission, 'cash-tot-out'),
          ]),
        ]));
      }
      c.appendChild(im);
    }

    // Пончик: структура расходов по группам
    const expByGroup = {};
    rows.forEach((r) => { if (r.exp > 0) { const g = r.group_name || (r.cat_id ? 'Прочее' : 'Не разобрано'); expByGroup[g] = (expByGroup[g] || 0) + r.exp; } });
    const donutItems = Object.entries(expByGroup).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).map((it, i) => ({ ...it, color: CHART_COLORS[i % CHART_COLORS.length] }));
    if (donutItems.length) {
      c.appendChild(el('div', { class: 'cash-h2', style: 'font-size:18px;margin-top:18px' }, 'Куда ушли деньги'));
      c.appendChild(donutChart(donutItems, 'Расходы'));
    }

    // Таблица по группам
    const byGroup = {};
    rows.forEach((r) => { const g = r.group_name || (r.cat_id ? '— прочее —' : '⚠ Не разобрано'); (byGroup[g] = byGroup[g] || []).push(r); });
    const order = [...groupsOrder, '— прочее —', '⚠ Не разобрано'].filter((g, i, a) => a.indexOf(g) === i);
    const present = Object.keys(byGroup).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    present.forEach((g) => {
      const list = byGroup[g];
      const gi = list.reduce((s, r) => s + r.inc, 0), ge = list.reduce((s, r) => s + r.exp, 0);
      const block = el('div', { class: 'cash-grp' });
      block.appendChild(el('div', { class: 'cash-grp-h' }, [g, el('span', { class: 'cash-grp-sum' }, (gi ? ' +' + money(gi) : '') + (ge ? '  −' + money(ge) : ''))]));
      block.appendChild(el('div', { class: 'cash-list' }, list.filter((r) => r.inc || r.exp).map((r) => el('div', { class: 'cash-row cash-rep cash-rep-click' + (!r.cat_id ? ' unclass' : ''), title: 'Открыть транзакции этой статьи', onclick: () => drillToTx(r) }, [
        el('span', {}, (r.code ? (r.code + ' · ' + r.name) : 'без статьи') + ' →'),
        el('span', { class: 'cash-amt-in' }, r.inc ? '+' + money(r.inc) : ''),
        el('span', { class: 'cash-amt-out' }, r.exp ? '−' + money(r.exp) : ''),
      ]))));
      c.appendChild(block);
    });
    if (!rows.length) c.appendChild(el('div', { class: 'cash-empty' }, 'За период нет операций.'));
  }

  function renderPnl(c) {
    c.appendChild(el('div', { class: 'cash-head' }, [el('div', {}, [
      el('div', { class: 'cash-h2' }, 'P&L — прибыль и убытки'),
      el('div', { class: 'cash-sub' }, 'Реальный P&L — не только по деньгам, а с себестоимостью продукции.'),
    ])]));
    c.appendChild(el('div', { class: 'cash-pnl-stub' }, [
      el('div', { class: 'cash-pnl-stub-ic' }, '📈'),
      el('div', { class: 'cash-pnl-stub-h' }, 'Соберётся автоматически'),
      el('div', { class: 'cash-pnl-stub-t' }, 'Честный P&L считается с себестоимостью: сырьё → выход готовой продукции → маржа. Эти данные дадут модули «Производство» и «Склад». Когда они заработают, P&L соберётся сам — из выручки, реальной себестоимости и расходов Кассы.'),
      el('div', { class: 'cash-pnl-stub-t', style: 'margin-top:6px' }, 'Пока пользуйся вкладкой «Кэш-флоу (ДДС)» — там движение реальных денег за период.'),
    ]));
  }

  async function renderWallets() {
    const c = $('#cash-content'); c.innerHTML = '<div class="cash-loading">Загрузка…</div>';
    let data; try { data = await api('/wallets'); } catch (e) { c.innerHTML = ''; c.appendChild(el('div', { class: 'cash-empty' }, 'Ошибка: ' + e.message)); return; }
    c.innerHTML = '';
    c.appendChild(el('div', { class: 'cash-head' }, [
      el('div', {}, [el('div', { class: 'cash-h2' }, 'Кошельки'), el('div', { class: 'cash-sub' }, 'Остаток считается из журнала. Клик — изменить.')]),
      addBtn('+ Кошелёк', () => openWalletForm(null)),
    ]));
    const w = data.wallets || [];
    if (!w.length) { c.appendChild(el('div', { class: 'cash-empty' }, 'Кошельков нет.')); return; }
    const KIND = { bank: 'Расчётный счёт', card: 'Карта', cash: 'Наличные', reserve: 'Резерв' };
    c.appendChild(el('div', { class: 'cash-wallets' }, w.map((x) => el('div', { class: 'cash-wallet', style: 'border-left-color:' + (x.color || '#163a28') + ';cursor:pointer', onclick: () => openWalletForm(x) }, [
      el('div', { class: 'cash-wallet-nm' }, x.name),
      el('div', { class: 'cash-wallet-kind' }, KIND[x.kind] || x.kind),
      el('div', { class: 'cash-wallet-bal' }, money(x.balance) + ' сум'),
      el('a', { class: 'cash-wallet-exp', href: '/cash/api/wallet-export?wallet_id=' + x.id, title: 'Выгрузить операции в Excel (с остатком по строкам)', onclick: (e) => e.stopPropagation() }, '⬇ Excel'),
    ]))));
    const total = w.reduce((s, x) => s + Number(x.balance || 0), 0);
    c.appendChild(el('div', { class: 'cash-total' }, 'Итого по кошелькам: ' + money(total) + ' сум'));
  }

  // ================= ТРАНЗАКЦИИ =================
  const txState = { from: '', to: '', wallet: '', type: '', q: '', category: '', catgroup: '', counterparty: '', classified: '', page: 1, pageSize: 50 };
  const repState = { from: '', to: '', wallet: '' };
  let txSel = new Set();
  async function renderTransactions() {
    const c = $('#cash-content'); c.innerHTML = '';
    if (!txState.from) txState.from = monthStartStr();
    if (!txState.to) txState.to = todayStr();
    c.appendChild(el('div', { class: 'cash-head' }, [
      el('div', {}, [el('div', { class: 'cash-h2' }, 'Транзакции'), el('div', { class: 'cash-sub' }, 'Журнал движения денег. Жёлтым — неразобранные (без статьи).')]),
      el('div', { class: 'cash-tx-btns' }, [
        addBtn('+ Приход', () => openTxForm('in', null)),
        el('button', { class: 'btn-primary cash-add cash-out', onclick: () => openTxForm('out', null) }, '+ Расход'),
        el('button', { class: 'btn-ghost cash-add', onclick: () => openTransferForm(null) }, '↔ Перевод'),
        el('button', { class: 'btn-ghost cash-add', onclick: openMatchTransfers }, '🔗 Найти переводы'),
        el('button', { class: 'btn-ghost cash-add', onclick: openOpeningForm }, '💼 Начальные остатки'),
        el('button', { class: 'btn-ghost cash-add', onclick: openImport }, '📥 Импорт выписки'),
        ...((window.HUB_USER && window.HUB_USER.isAdmin) ? [el('button', { class: 'btn-ghost cash-add cashf-del', onclick: doWipe }, '🧹 Очистить')] : []),
      ]),
    ]));
    const reload1 = () => { txState.page = 1; loadTx(); };
    const dateInp = (k) => el('input', { type: 'date', class: 'cashf-inp cash-filt', value: txState[k], onchange: (e) => { txState[k] = e.target.value; reload1(); } });
    const walletSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { txState.wallet = e.target.value; reload1(); } }, [el('option', { value: '' }, 'Все кошельки'), ...(DICTS.wallets || []).map((x) => el('option', { value: x.id, selected: String(x.id) === txState.wallet || null }, x.name))]);
    const typeSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { txState.type = e.target.value; reload1(); } }, [{ v: '', t: 'Все типы' }, { v: 'in', t: 'Приходы' }, { v: 'out', t: 'Расходы' }, { v: 'transfer', t: 'Переводы' }].map((o) => el('option', { value: o.v, selected: o.v === txState.type || null }, o.t)));
    const catSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { txState.category = e.target.value; txState.catgroup = ''; reload1(); } }, [el('option', { value: '' }, 'Все статьи ДДС'), ...(DICTS.categories || []).map((x) => el('option', { value: x.id, selected: String(x.id) === txState.category || null }, x.code + ' · ' + x.name))]);
    const classSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { txState.classified = e.target.value; reload1(); } }, [{ v: '', t: 'Все' }, { v: 'no', t: 'Не разобрано' }, { v: 'yes', t: 'Разобрано' }].map((o) => el('option', { value: o.v, selected: o.v === txState.classified || null }, o.t)));
    const search = el('input', { type: 'search', class: 'cashf-inp cash-filt cash-filt-q', placeholder: 'Поиск по назначению / от кого…', value: txState.q, oninput: (e) => { txState.q = e.target.value; clearTimeout(window.__cashT); window.__cashT = setTimeout(reload1, 350); } });
    const sizeSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { txState.pageSize = parseInt(e.target.value); txState.page = 1; loadTx(); } }, [10, 20, 50, 100, 200].map((n) => el('option', { value: n, selected: n === txState.pageSize || null }, 'по ' + n)));
    c.appendChild(el('div', { class: 'cash-filters' }, [el('span', { class: 'cash-flab' }, 'С'), dateInp('from'), el('span', { class: 'cash-flab' }, 'по'), dateInp('to'), walletSel, typeSel, catSel, classSel, search, sizeSel]));
    c.appendChild(el('div', { id: 'cash-tx-wrap' }));
    loadTx();
  }
  let txItems = [];
  function updateBulk() {
    const bar = $('#cash-bulk'); if (!bar) return;
    bar.style.display = txSel.size ? 'flex' : 'none';
    const n = bar.querySelector('.cash-bulk-n'); if (n) n.textContent = 'Выбрано: ' + txSel.size;
  }
  async function loadTx() {
    const wrap = $('#cash-tx-wrap'); if (!wrap) return;
    const p = new URLSearchParams();
    ['from', 'to', 'wallet', 'type', 'q', 'category', 'catgroup', 'counterparty', 'classified'].forEach((k) => { if (txState[k]) p.set(k, txState[k]); });
    p.set('page', txState.page); p.set('pageSize', txState.pageSize);
    let data; try { data = await api('/transactions?' + p.toString()); } catch (e) { toast(e.message, true); return; }
    txItems = data.items || []; txSel.clear();
    // Сводка за период/кошелёк: сальдо на начало, приход, расход, сальдо на конец (авторасчёт).
    let sum = null;
    try {
      const sp = new URLSearchParams();
      ['from', 'to', 'wallet'].forEach((k) => { if (txState[k]) sp.set(k, txState[k]); });
      sum = await api('/summary?' + sp.toString());
    } catch (e) { /* сводка не критична для журнала */ }
    wrap.innerHTML = '';
    if (sum) {
      const scard = (label, val, cls, extra) => el('div', { class: 'cash-sum-card' + (cls ? ' ' + cls : '') }, [
        el('div', { class: 'cash-sum-l' }, label),
        el('div', { class: 'cash-sum-v' }, money(val) + ' сум'),
        extra || null,
      ]);
      const reconcileBtn = el('button', { class: 'btn-ghost cash-sum-btn', onclick: () => openReconcileForm() }, '⚖ Сверить остаток');
      wrap.appendChild(el('div', { class: 'cash-summary' }, [
        scard('Сальдо на начало', sum.opening, 'neutral'),
        scard('Приход', sum.inflow, 'in'),
        scard('Расход', sum.outflow, 'out'),
        scard('Сальдо на конец', sum.closing, 'end', reconcileBtn),
      ]));
    }
    if (data.unclassified) wrap.appendChild(el('div', { class: 'cash-tot-bar' }, [
      el('span', { class: 'cash-tot-unc' }, 'Не разобрано: ' + data.unclassified),
    ]));
    const delBtn = el('button', { class: 'btn-ghost cashf-del', onclick: async () => {
      if (!txSel.size) return; if (!confirm('Удалить выбранные операции (' + txSel.size + ')?')) return;
      try { const d = await post('/tx/bulk-delete', { ids: [...txSel] }); toast('Удалено: ' + d.deleted); loadTx(); } catch (e) { toast(e.message, true); }
    } }, 'Удалить выбранные');
    const clr = el('button', { class: 'btn-ghost', onclick: () => { txSel.clear(); loadTx(); } }, 'Снять');
    const catBulk = fsel(catOptions(), '');
    const classifyBtn = el('button', { class: 'btn-primary', onclick: async () => {
      if (!txSel.size) return; if (!catBulk.value) return toast('Выберите статью', true);
      try { const d = await post('/tx/bulk-classify', { ids: [...txSel], category_id: catBulk.value }); toast('Присвоено: ' + d.applied); loadTx(); } catch (e) { toast(e.message, true); }
    } }, 'Присвоить статью');
    wrap.appendChild(el('div', { id: 'cash-bulk', class: 'cash-bulkbar', style: 'display:none' }, [el('span', { class: 'cash-bulk-n' }, ''), catBulk, classifyBtn, delBtn, clr]));
    const selAll = el('input', { type: 'checkbox', class: 'cash-chk' });
    selAll.addEventListener('click', (e) => {
      const on = e.target.checked; txSel.clear(); if (on) txItems.forEach((x) => txSel.add(x.id));
      wrap.querySelectorAll('.row-chk').forEach((c) => { c.checked = on; });
      updateBulk();
    });
    const head = el('div', { class: 'cash-row head cash-tx' }, [selAll, ...['Дата', 'Кошелёк', 'От кого', 'Статья', 'Назначение', 'Приход', 'Расход'].map((h) => el('span', {}, h))]);
    wrap.appendChild(el('div', { class: 'cash-list' }, [head, ...txItems.map(txRow)]));
    if (!txItems.length) wrap.appendChild(el('div', { class: 'cash-empty' }, 'Транзакций нет. Добавьте операцию или импортируйте выписку.'));
    // Пагинация
    const total = data.total || txItems.length;
    const pages = Math.max(1, Math.ceil(total / txState.pageSize));
    if (txState.page > pages) { txState.page = pages; }
    const goto = (pg) => { txState.page = Math.min(pages, Math.max(1, pg)); loadTx(); };
    const from = total ? (txState.page - 1) * txState.pageSize + 1 : 0;
    const to = Math.min(total, txState.page * txState.pageSize);
    const pbtn = (label, pg, dis) => el('button', { class: 'btn-ghost cash-page-btn', disabled: dis || null, onclick: () => goto(pg) }, label);
    wrap.appendChild(el('div', { class: 'cash-pager' }, [
      el('span', { class: 'cash-flab' }, total ? `${from}–${to} из ${total}` : 'Нет записей'),
      el('div', { class: 'cash-page-btns' }, [
        pbtn('« Первая', 1, txState.page <= 1),
        pbtn('‹ Назад', txState.page - 1, txState.page <= 1),
        el('span', { class: 'cash-flab' }, `Стр. ${txState.page} из ${pages}`),
        pbtn('Вперёд ›', txState.page + 1, txState.page >= pages),
        pbtn('Последняя »', pages, txState.page >= pages),
      ]),
    ]));
    updateBulk();
  }
  function txRow(x) {
    const isT = x.tx_type === 'transfer';
    const cls = 'cash-row cash-tx' + (!isT && !x.is_classified ? ' unclass' : '');
    const chk = el('input', { type: 'checkbox', class: 'cash-chk row-chk' });
    chk.checked = txSel.has(x.id);
    chk.addEventListener('click', (e) => { e.stopPropagation(); if (chk.checked) txSel.add(x.id); else txSel.delete(x.id); updateBulk(); });
    const wallet = isT ? ((x.wallet_name || '?') + ' → ' + (x.wallet_to_name || '?') + ' · ↔' + money(x.amount)) : (x.wallet_name || '—');
    return el('div', { class: cls, style: 'cursor:pointer', onclick: () => (isT ? openTransferForm(x) : openTxForm(x.tx_type, x)) }, [
      chk,
      el('span', {}, ruDate(x.tx_date)),
      el('span', {}, [el('span', { class: 'cash-dot', style: 'background:' + (x.wallet_color || '#999') }), ' ' + wallet]),
      el('span', {}, isT ? '— перевод —' : (x.cp_name || x.payer_name || '—')),
      el('span', {}, isT ? '—' : (x.cat_code ? (x.cat_code + ' ' + (x.cat_name || '')) : '—')),
      el('span', { class: 'cash-purpose' }, x.purpose || ''),
      el('span', { class: 'cash-amt-in' }, x.tx_type === 'in' ? ('+' + money(x.amount)) : ''),
      el('span', { class: 'cash-amt-out' }, x.tx_type === 'out' ? ('−' + money(x.amount)) : ''),
    ]);
  }

  // ---------- Наличная касса: построчный Приход/Расход, доллар + курс ЦБ, сальдо на начало/конец ----------
  const cbState = { type: 'in', wallet: '', from: '', to: '', q: '', category: '', classified: '', page: 1, pageSize: 50, lastAddedId: null, selected: {} };

  // Импорт «Наличной кассы» из Excel: предпросмотр → запись.
  function openCashboxImport(walletId) {
    const cashWallets = (DICTS.wallets || []).filter((w) => w.kind === 'cash');
    const wallet = fsel(cashWallets.map((w) => ({ v: w.id, t: w.name })), walletId || (cashWallets[0] && cashWallets[0].id) || '');
    const file = el('input', { type: 'file', accept: '.xlsx,.xls', class: 'cashf-inp' });
    const info = el('div', {});
    const setOpening = el('input', { type: 'checkbox' }); setOpening.checked = true;
    const openingRow = el('label', { class: 'cashf-row', style: 'display:none' }, [el('span', {}, 'Начальный остаток'), el('span', {}, [setOpening, el('span', { class: 'cash-sub cb-open-lbl' }, '')])]);
    let payload = null;
    const body = el('div', { class: 'cashf' }, [
      el('div', { class: 'cash-sub' }, 'Загрузите шаблон «Превью импорта». Приходы «снятие наличных» пропускаются; строки «сум+доллар» разбиваются на две; коды у расходов берутся из файла, приходы — без кодов.'),
      frow('Касса', wallet), frow('Файл', file), openingRow, info,
    ]);
    const commitBtn = el('button', { class: 'btn-primary', style: 'display:none', onclick: async () => {
      if (!payload) return;
      commitBtn.disabled = true; commitBtn.textContent = 'Записываю…';
      try {
        const d = await post('/cashbox/import/commit', { payload, setOpening: setOpening.checked, filename: (file.files[0] && file.files[0].name) || '' });
        toast(`Записано ${d.inserted}, пропущено дублей ${d.skipped}`);
        closeModal(); if (TAB === 'cashbox') renderCashbox();
      } catch (e) { toast(e.message, true); commitBtn.disabled = false; commitBtn.textContent = 'Записать в кассу'; }
    } }, 'Записать в кассу');
    const checkBtn = el('button', { class: 'btn-primary', onclick: async () => {
      if (!wallet.value) return toast('Выберите кассу', true);
      if (!file.files[0]) return toast('Выберите файл', true);
      checkBtn.disabled = true; checkBtn.textContent = 'Проверяю…';
      const fd = new FormData(); fd.append('wallet_id', wallet.value); fd.append('file', file.files[0]);
      try {
        const res = await fetch('/cash/api/cashbox/import/preview', { method: 'POST', body: fd });
        const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Ошибка');
        payload = d.payload; const s = d.summary;
        info.innerHTML = '';
        const line = (t) => el('div', { class: 'cash-imp-sum' }, t);
        info.appendChild(line(`Строк в файле: ${s.fileRows}`));
        info.appendChild(line(`Приходы (без снятий наличных): ${s.inCnt} · Расходы: ${s.outCnt}`));
        info.appendChild(line(`Снятий наличных пропущено: ${s.skippedObnal} · Конверсия: ${s.konv}`));
        info.appendChild(line(`Строк «сум+доллар» разбито на 2: ${s.splitPairs}`));
        info.appendChild(line(`Будет записано строк: ${s.entries}`));
        if (s.badCodes && s.badCodes.length) info.appendChild(el('div', { class: 'cash-imp-sum', style: 'color:#c0392b' }, `Неизвестные коды ДДС: ${s.badCodes.join(', ')} (запишутся без статьи)`));
        if (s.opening && s.openingDate) { openingRow.style.display = ''; openingRow.querySelector('.cb-open-lbl').textContent = ' ' + money(s.opening) + ' сум на ' + ruDate(s.openingDate); }
        commitBtn.style.display = '';
        checkBtn.textContent = 'Проверить снова'; checkBtn.disabled = false;
      } catch (e) { toast(e.message, true); checkBtn.disabled = false; checkBtn.textContent = 'Проверить'; }
    } }, 'Проверить');
    modal('Импорт наличной кассы', body, [checkBtn, commitBtn]);
  }
  // Конверсия валюты внутри кассы: $↔сум, одной операцией, не доход/не расход.
  function openConvertForm(walletId) {
    const cashWallets = (DICTS.wallets || []).filter((w) => w.kind === 'cash');
    const wallet = fsel(cashWallets.map((w) => ({ v: w.id, t: w.name })), walletId || (cashWallets[0] && cashWallets[0].id) || '');
    const date = finp(todayStr(), { type: 'date' });
    const dir = fsel([{ v: 'usd_to_uzs', t: 'Доллары → Сумы' }, { v: 'uzs_to_usd', t: 'Сумы → Доллары' }], 'usd_to_uzs');
    const usd = finp('', { inputmode: 'decimal', placeholder: 'Сколько долларов' });
    const rate = finp('', { inputmode: 'decimal', placeholder: 'курс' });
    const equiv = el('div', { class: 'cash-note-info' }, '');
    function recalc() {
      const u = Number(String(usd.value).replace(',', '.')) || 0;
      const rt = Number(String(rate.value).replace(',', '.')) || 0;
      equiv.textContent = (u && rt) ? ('= ' + money(Math.round(u * rt)) + ' сум' + (dir.value === 'usd_to_uzs' ? ' (получите сумами)' : ' (спишется сумами)')) : '';
    }
    async function refreshRate() {
      if (!String(rate.value).trim()) { try { const r = await api('/fx-rate?date=' + (date.value || todayStr())); if (r.rate) rate.value = r.rate; } catch (e) { /* нет курса */ } }
      recalc();
    }
    usd.oninput = recalc; rate.oninput = recalc; dir.onchange = recalc; date.onchange = refreshRate;
    const body = el('div', { class: 'cashf' }, [
      el('div', { class: 'cash-note-info' }, 'Обмен валют внутри кассы. Не считается доходом/расходом и в ДДС не входит — только меняет сумовую и долларовую часть остатка.'),
      frow('Касса', wallet), frow('Дата', date), frow('Направление', dir),
      frow('Сумма, $', usd), frow('Курс', rate), frow('', equiv),
    ]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        const d = await post('/cashbox/convert', { wallet_id: wallet.value, date: date.value, direction: dir.value, usd: usd.value, rate: rate.value });
        toast('Конверсия проведена: ' + money(d.sumAmt) + ' сум @' + d.rate);
        closeModal(); if (TAB === 'cashbox') renderCashbox();
      } catch (e) { toast(e.message, true); }
    } }, 'Провести конверсию');
    modal('Конверсия валюты', body, [save]);
    refreshRate();
  }

  async function renderCashbox() {
    const c = $('#cash-content'); c.innerHTML = '';
    const cashWallets = (DICTS.wallets || []).filter((w) => w.kind === 'cash');
    if (!cbState.wallet && cashWallets.length) cbState.wallet = String(cashWallets[0].id);
    c.appendChild(el('div', { class: 'cash-head' }, [
      el('div', {}, [el('div', { class: 'cash-h2' }, 'Наличная касса')]),
      el('div', { class: 'cash-tx-btns' }, [
        el('button', { class: 'btn-ghost cash-add', onclick: () => openCashOpeningForm(cbState.wallet) }, '💼 Начальные остатки'),
        el('button', { class: 'btn-ghost cash-add', onclick: () => openConvertForm(cbState.wallet) }, '🔄 Конверсия'),
        el('button', { class: 'btn-ghost cash-add', onclick: () => openCashboxImport(cbState.wallet) }, '📥 Импорт из Excel'),
      ]),
    ]));
    if (!cashWallets.length) { c.appendChild(el('div', { class: 'cash-empty' }, 'Нет ни одного кошелька типа «Наличные». Заведите его на вкладке «Кошельки».')); return; }
    const typeBtn = (v, label) => el('button', { class: 'btn-ghost cash-add' + (cbState.type === v ? ' cb-on' : ''), onclick: () => { cbState.type = v; cbState.selected = {}; cbState.page = 1; renderCashbox(); } }, label);
    const walletSel = el('select', { class: 'cashf-inp', onchange: (e) => { cbState.wallet = e.target.value; cbState.page = 1; renderCashbox(); } },
      cashWallets.map((w) => el('option', { value: w.id, selected: String(w.id) === cbState.wallet || null }, w.name)));
    const fromInp = el('input', { type: 'date', class: 'cashf-inp cash-filt', value: cbState.from, onchange: (e) => { cbState.from = e.target.value; cbState.page = 1; loadCashbox(); } });
    const toInp = el('input', { type: 'date', class: 'cashf-inp cash-filt', value: cbState.to, onchange: (e) => { cbState.to = e.target.value; cbState.page = 1; loadCashbox(); } });
    const catSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { cbState.category = e.target.value; cbState.page = 1; loadCashbox(); } },
      [el('option', { value: '' }, 'Все статьи ДДС')].concat((DICTS.categories || []).map((x) => el('option', { value: x.id, selected: String(x.id) === cbState.category || null }, x.code + ' · ' + x.name))));
    const search = el('input', { type: 'search', class: 'cashf-inp cash-filt cash-filt-q', placeholder: 'Поиск по назначению…', value: cbState.q, oninput: (e) => { cbState.q = e.target.value; cbState.page = 1; clearTimeout(window.__cbQ); window.__cbQ = setTimeout(loadCashbox, 350); } });
    const sizeSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { cbState.pageSize = parseInt(e.target.value); cbState.page = 1; loadCashbox(); } },
      [20, 50, 100, 200, 500].map((n) => el('option', { value: n, selected: n === cbState.pageSize || null }, 'по ' + n)));
    const classSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { cbState.classified = e.target.value; cbState.page = 1; loadCashbox(); } },
      [{ v: '', t: 'Все' }, { v: 'no', t: 'Не разобрано' }, { v: 'yes', t: 'Разобрано' }].map((o) => el('option', { value: o.v, selected: o.v === cbState.classified || null }, o.t)));
    c.appendChild(el('div', { class: 'cash-filters', style: 'margin-bottom:6px' }, [
      typeBtn('in', '➕ Приход'), typeBtn('out', '➖ Расход'),
      el('span', { class: 'cash-flab' }, 'Касса'), walletSel,
    ]));
    c.appendChild(el('div', { class: 'cash-filters', style: 'margin-bottom:0' }, [
      el('span', { class: 'cash-flab' }, 'C'), fromInp, el('span', { class: 'cash-flab' }, 'по'), toInp,
      catSel, classSel, search, sizeSel,
    ]));
    const wrap = el('div', { id: 'cashbox-wrap' }); c.appendChild(wrap);
    loadCashbox();
  }

  async function loadCashbox() {
    const wrap = $('#cashbox-wrap'); if (!wrap) return;
    wrap.innerHTML = '';
    const isIn = cbState.type === 'in';
    let sum, list;
    try {
      const sp = new URLSearchParams(); if (cbState.from) sp.set('from', cbState.from); if (cbState.to) sp.set('to', cbState.to); sp.set('wallet', cbState.wallet); if (cbState.category) sp.set('category', cbState.category); if (cbState.classified) sp.set('classified', cbState.classified); if (cbState.q) sp.set('q', cbState.q);
      sum = await api('/summary?' + sp.toString());
      const tp = new URLSearchParams(); tp.set('wallet', cbState.wallet); tp.set('type', cbState.type); tp.set('pageSize', String(cbState.pageSize || 50)); tp.set('page', String(cbState.page || 1));
      if (cbState.q) tp.set('q', cbState.q);
      if (cbState.category) tp.set('category', cbState.category);
      if (cbState.classified) tp.set('classified', cbState.classified);
      if (cbState.from) tp.set('from', cbState.from); if (cbState.to) tp.set('to', cbState.to);
      list = await api('/transactions?' + tp.toString());
    } catch (e) { toast(e.message, true); return; }

    // Единый ряд: Сальдо на начало · Приход · Расход · Сальдо на конец.
    // У балансов (начало/конец) показываем состав: сумы + доллары, а крупным — общий сум-эквивалент.
    // Крупно — сумы (сумовая часть), отдельной строкой — доллары. Без смешанного сум-эквивалента.
    const usdHtml = (usd) => '<span class="cb-fx-usd' + (Number(usd) < 0 ? ' cb-fx-neg' : '') + '">$ ' + money(usd) + '</span>';
    const openV = el('div', { class: 'cash-sum-v' }, money(sum.opening_uzs || 0) + ' сум');
    const openFx = el('div', { class: 'cash-sum-fx cb-fx-line' }, '');
    const inV = el('div', { class: 'cash-sum-v' }, money(sum.inflow_uzs || 0) + ' сум');
    const inFx = el('div', { class: 'cash-sum-fx cb-fx-line' }, '');
    const outV = el('div', { class: 'cash-sum-v' }, money(sum.outflow_uzs || 0) + ' сум');
    const outFx = el('div', { class: 'cash-sum-fx cb-fx-line' }, '');
    const closeV = el('div', { class: 'cash-sum-v' }, money(sum.closing_uzs || 0) + ' сум');
    const closeFx = el('div', { class: 'cash-sum-fx cb-fx-line' }, '');
    // Обмен замыкает сумовую колонку: конец = начало + приход − расход + обмен.
    const exV = el('div', { class: 'cash-sum-v' }, money(sum.exchange_uzs || 0) + ' сум');
    const cards = [
      el('div', { class: 'cash-sum-card neutral' }, [el('div', { class: 'cash-sum-l' }, 'Сальдо на начало'), openV, openFx]),
      el('div', { class: 'cash-sum-card in' }, [el('div', { class: 'cash-sum-l' }, 'Приход за период'), inV, inFx]),
      el('div', { class: 'cash-sum-card out' }, [el('div', { class: 'cash-sum-l' }, 'Расход за период'), outV, outFx]),
    ];
    if (Number(sum.exchange_uzs)) {
      cards.push(el('div', { class: 'cash-sum-card ex' }, [
        el('div', { class: 'cash-sum-l' }, 'Обмен за период'), exV,
        el('div', { class: 'cash-sum-fx cb-fx-line' }, 'сумы ↔ доллары'),
      ]));
    }
    cards.push(el('div', { class: 'cash-sum-card end' }, [el('div', { class: 'cash-sum-l' }, 'Сальдо на конец'), closeV, closeFx]));
    wrap.appendChild(el('div', { class: 'cash-summary', style: 'margin-bottom:10px' }, cards));
    openFx.innerHTML = usdHtml(sum.opening_usd || 0);
    inFx.innerHTML = usdHtml(sum.inflow_usd || 0);
    outFx.innerHTML = usdHtml(sum.outflow_usd || 0);
    closeFx.innerHTML = usdHtml(sum.closing_usd || 0);
    // Тихое обновление сводки после инлайн-правки (без перерисовки строк — фокус не теряется).
    async function cbUpdateSummary() {
      try {
        const sp = new URLSearchParams(); if (cbState.from) sp.set('from', cbState.from); if (cbState.to) sp.set('to', cbState.to); sp.set('wallet', cbState.wallet); if (cbState.category) sp.set('category', cbState.category); if (cbState.classified) sp.set('classified', cbState.classified); if (cbState.q) sp.set('q', cbState.q);
        const s = await api('/summary?' + sp.toString());
        openV.textContent = money(s.opening_uzs || 0) + ' сум'; inV.textContent = money(s.inflow_uzs || 0) + ' сум';
        outV.textContent = money(s.outflow_uzs || 0) + ' сум'; closeV.textContent = money(s.closing_uzs || 0) + ' сум';
        exV.textContent = money(s.exchange_uzs || 0) + ' сум';
        openFx.innerHTML = usdHtml(s.opening_usd || 0);
        inFx.innerHTML = usdHtml(s.inflow_usd || 0);
        outFx.innerHTML = usdHtml(s.outflow_usd || 0);
        closeFx.innerHTML = usdHtml(s.closing_usd || 0);
      } catch (e) { /* не критично */ }
    }

    // ---- строка ввода (всегда сверху) ----
    const dateInp = el('input', { type: 'date', class: 'cashf-inp', value: todayStr() });
    const purposeInp = el('input', { class: 'cashf-inp cb-purpose-inp', placeholder: isIn ? 'Откуда…' : 'Куда / на что…' });
    const catSel = fsel(catOptions(), '');
    const currSel = el('select', { class: 'cashf-inp' }, [el('option', { value: 'UZS' }, 'сум'), el('option', { value: 'USD' }, '$')]);
    const rateBox = el('span', { class: 'cash-sub cb-rate' }, '—');
    const rateOverride = el('input', { type: 'text', inputmode: 'decimal', class: 'cashf-inp', placeholder: 'курс', style: 'width:90px;display:none' });
    const amtInp = el('input', { type: 'text', inputmode: 'decimal', class: 'cashf-inp', placeholder: '0', style: 'text-align:right' });
    const equivBox = el('span', { class: 'cash-sub cb-equiv' }, '');
    let fetchedRate = null;
    async function refreshRate() {
      if (currSel.value !== 'USD') { rateBox.style.display = ''; rateOverride.style.display = 'none'; recalcEquiv(); return; }
      rateBox.textContent = '…'; rateBox.style.display = ''; rateOverride.style.display = 'none';
      try { const r = await api('/fx-rate?date=' + (dateInp.value || todayStr())); fetchedRate = r.rate; rateBox.textContent = r.rate ? money(r.rate) : 'нет курса'; rateOverride.value = r.rate || ''; }
      catch (e) { fetchedRate = null; rateBox.textContent = 'нет курса'; }
      recalcEquiv();
    }
    function activeRate() { const v = Number(String(rateOverride.value).replace(',', '.')); return v > 0 ? v : fetchedRate; }
    function recalcEquiv() {
      if (currSel.value !== 'USD') { equivBox.textContent = ''; return; }
      const amt = Number(String(amtInp.value).replace(',', '.')) || 0;
      const rate = activeRate();
      equivBox.textContent = (amt && rate) ? ('= ' + money(amt * rate) + ' сум') : '';
    }
    currSel.onchange = () => { rateBox.style.display = currSel.value === 'USD' ? 'inline' : 'none'; rateOverride.style.display = currSel.value === 'USD' ? '' : 'none'; refreshRate(); };
    rateBox.onclick = () => { rateBox.style.display = 'none'; rateOverride.style.display = ''; rateOverride.focus(); };
    rateOverride.oninput = recalcEquiv;
    dateInp.onchange = refreshRate;
    amtInp.oninput = recalcEquiv;
    let saving = false;
    async function trySave() {
      const amtRaw = Number(String(amtInp.value).replace(',', '.'));
      if (!(amtRaw > 0) || saving) return;
      saving = true;
      try {
        const isUsd = currSel.value === 'USD';
        const rate = isUsd ? activeRate() : null;
        if (isUsd && !(rate > 0)) { toast('Нет курса — укажите вручную', true); saving = false; return; }
        const equivAmount = isUsd ? amtRaw * rate : amtRaw;
        const r = await post('/tx', {
          tx_type: cbState.type, tx_date: dateInp.value || todayStr(), wallet_id: cbState.wallet,
          amount: equivAmount, category_id: catSel.value, purpose: purposeInp.value,
          currency: isUsd ? 'USD' : 'UZS', fx_rate: isUsd ? rate : '', fx_amount: isUsd ? amtRaw : '',
        });
        cbState.lastAddedId = r.id || null;
        await loadCashbox();
      } catch (e) { toast(e.message, true); saving = false; }
    }
    // Навигация как в Excel: Enter — на следующую ячейку (Дата→Куда→Код→Валюта→Сумма);
    // на «Сумме» Enter — отправка и снова на «Куда». Стрелки ←/→ — назад/вперёд по ячейкам.
    // Плюс кнопка «＋» — второй способ отправки. Авто-сохранение по паузе убрано.
    async function trySaveNow() { await trySave(); const row = $('#cashbox-wrap .cb-purpose-inp'); if (row) row.focus(); }
    const navFields = [dateInp, purposeInp, catSel, currSel, amtInp];
    function moveBy(cur, dir) {
      const i = navFields.indexOf(cur); if (i < 0) return;
      const ni = i + dir;
      if (ni >= navFields.length) { trySaveNow(); return; }   // после «Суммы» — отправка
      if (ni < 0) return;
      const nx = navFields[ni]; nx.focus(); if (nx.select) { try { nx.select(); } catch (e) {} }
    }
    const atStart = (el2) => { try { return el2.selectionStart === 0 && el2.selectionEnd === 0; } catch (e) { return true; } };
    const atEnd = (el2) => { try { return el2.selectionStart === (el2.value || '').length; } catch (e) { return true; } };
    navFields.forEach((elm) => {
      const isSelect = elm.tagName === 'SELECT';
      const isDate = elm.type === 'date';
      elm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); moveBy(elm, +1); return; }
        if (e.key === 'ArrowRight' && (isSelect || (!isDate && atEnd(elm)))) { e.preventDefault(); moveBy(elm, +1); return; }
        if (e.key === 'ArrowLeft' && (isSelect || (!isDate && atStart(elm)))) { e.preventDefault(); moveBy(elm, -1); return; }
      });
    });
    const addBtn = el('button', { class: 'btn-primary cb-add-btn', title: 'Добавить (или Enter на «Сумме»)', onclick: () => trySaveNow() }, '＋');

    const inputRow = el('div', { class: 'cash-row cash-cb cb-input' }, [
      el('span', {}, ''),
      dateInp, purposeInp, catSel, currSel,
      el('span', {}, [rateBox, rateOverride]),
      el('span', {}, [amtInp, equivBox]),
      el('span', {}, [addBtn]),
    ]);
    const selAll = el('input', { type: 'checkbox', onchange: (e) => {
      (list.items || []).forEach((x) => { if (x.tx_type !== 'transfer') cbState.selected[x.id] = e.target.checked; });
      loadCashbox();
    } });
    const head = el('div', { class: 'cash-row head cash-cb' }, [selAll, ...['Дата', isIn ? 'Откуда' : 'Куда', 'Код', 'Валюта', 'Курс ЦБ', 'Сумма (экв.)', ''].map((h) => el('span', {}, h))]);

    const trashSvg = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="#c0392b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
    const rows = (list.items || []).map((x) => {
      const isNew = cbState.lastAddedId && x.id === cbState.lastAddedId;
      const isPending = x.tx_type === 'transfer' && x.needs_cash_confirm;
      const isTransfer = x.tx_type === 'transfer';
      const fxNote = x.currency === 'USD' ? ('$ ' + money(x.fx_amount)) : (isTransfer ? '—' : 'сум');
      const trash = el('span', { class: 'cb-trash', title: 'Удалить', html: trashSvg, onclick: async (e) => { e.stopPropagation(); if (!confirm('Удалить эту запись? Действие необратимо.')) return; try { await post('/tx/' + x.id + '/delete', {}); delete cbState.selected[x.id]; loadCashbox(); } catch (er) { toast(er.message, true); } } });
      // Переводы (обнал в кассу) не редактируем на месте — только подтверждение и удаление.
      if (isTransfer) {
        const actions = [trash];
        if (isPending) actions.unshift(el('span', { class: 'cb-confirm', onclick: () => openConfirmCash(x) }, '⏳ Подтвердить'));
        return el('div', { class: 'cash-row cash-cb' + (isPending ? ' cb-pending' : '') }, [
          el('span', {}, ''),
          el('span', {}, ruDate(x.tx_date)),
          el('span', { class: 'cash-purpose' }, '⏳ Перевод от ' + (x.wallet_name || '—')),
          el('span', {}, x.cat_code ? (x.cat_code + ' ' + (x.cat_name || '')) : '—'),
          el('span', {}, fxNote),
          el('span', {}, x.currency === 'USD' ? money(x.fx_rate) : '—'),
          el('span', { style: 'text-align:right' }, money(x.amount)),
          el('span', { class: 'cb-actions' }, actions),
        ]);
      }
      // Инлайн-редактирование (как в Excel): меняем на месте, без окна. Сохранение по уходу из поля.
      // Шлём ПОЛНОЕ состояние строки + правку — иначе /api/tx обнулит незаданные поля (статью, назначение).
      const base = { tx_date: String(x.tx_date).slice(0, 10), amount: x.amount, category_id: x.category_id || '', purpose: x.purpose || '', counterparty_id: x.counterparty_id || '', contract_id: x.contract_id || '' };
      const save = async (patch) => { try { await post('/tx/' + x.id, Object.assign({}, base, patch)); await cbUpdateSummary(); } catch (e) { toast(e.message, true); } };
      const cb = el('input', { type: 'checkbox', checked: !!cbState.selected[x.id] || null, onchange: (e) => { cbState.selected[x.id] = e.target.checked; updateBulkBar(); } });
      const dateI = el('input', { type: 'date', class: 'cb-cell', value: String(x.tx_date).slice(0, 10), onchange: (e) => save({ tx_date: e.target.value }) });
      const purI = el('input', { class: 'cb-cell', value: x.purpose || '', placeholder: isIn ? 'Откуда…' : 'Куда…', onchange: (e) => save({ purpose: e.target.value }) });
      const catI = fsel(catOptions(), x.category_id || ''); catI.className = 'cb-cell'; catI.onchange = (e) => save({ category_id: e.target.value });
      const numOf = (i) => Number(String(i.value).replace(/\s/g, '').replace(',', '.')) || 0;
      let valCell, rateCell, amtCell;
      if (x.currency === 'USD') {
        // Долларовая строка: редактируем $, курс и сумму — любое поле пересчитывает остальные.
        valCell = el('input', { class: 'cb-cell', style: 'text-align:right', value: Math.round((Number(x.fx_amount) || 0) * 100) / 100 });
        rateCell = el('input', { class: 'cb-cell', style: 'text-align:right', value: Math.round(Number(x.fx_rate) || 0) });
        amtCell = el('input', { class: 'cb-cell', style: 'text-align:right', value: Math.round(Number(x.amount)) });
        const saveUsd = (which) => {
          let u = numOf(valCell), r = numOf(rateCell), a = numOf(amtCell);
          if (which === 'amt') { if (r > 0) u = Math.round((a / r) * 100) / 100; } else { a = Math.round(u * r); }
          if (!(u > 0) || !(r > 0)) { toast('Укажите $ и курс больше 0', true); return; }
          valCell.value = u; rateCell.value = r; amtCell.value = a;
          save({ currency: 'USD', fx_amount: u, fx_rate: r, amount: a });
        };
        valCell.onchange = () => saveUsd('usd'); rateCell.onchange = () => saveUsd('rate'); amtCell.onchange = () => saveUsd('amt');
      } else {
        valCell = el('span', {}, 'сум');
        rateCell = el('span', {}, '—');
        amtCell = el('input', { class: 'cb-cell', style: 'text-align:right', value: Math.round(Number(x.amount)), onchange: (e) => {
          const v = numOf(e.target);
          if (!(v > 0)) { toast('Сумма должна быть больше 0', true); e.target.value = Math.round(Number(x.amount)); return; }
          save({ amount: v });
        } });
      }
      return el('div', { class: 'cash-row cash-cb' + (isNew ? ' cb-new' : '') }, [
        cb, dateI, purI, catI, valCell, rateCell, amtCell,
        el('span', { class: 'cb-actions' }, [trash]),
      ]);
    });

    // Панель массовых действий (появляется, когда что-то выбрано).
    const bulkCat = fsel(catOptions(), '');
    const bulkBar = el('div', { class: 'cash-bulkbar', id: 'cb-bulkbar', style: 'display:none' }, [
      el('span', { class: 'cash-bulk-count', id: 'cb-bulk-count' }, ''),
      bulkCat,
      el('button', { class: 'btn-primary', onclick: async () => {
        const ids = selectedIds(); if (!ids.length) return toast('Ничего не выбрано', true);
        if (!bulkCat.value) return toast('Выберите статью', true);
        try { const r = await post('/tx/bulk-classify', { ids, category_id: bulkCat.value }); toast('Присвоено: ' + r.applied); cbState.selected = {}; loadCashbox(); } catch (e) { toast(e.message, true); }
      } }, 'Присвоить статью'),
      el('button', { class: 'btn-ghost cash-out', onclick: async () => {
        const ids = selectedIds(); if (!ids.length) return toast('Ничего не выбрано', true);
        if (!confirm('Удалить выбранные записи (' + ids.length + ')? Действие необратимо.')) return;
        try { const r = await post('/tx/bulk-delete', { ids }); toast('Удалено: ' + r.deleted); cbState.selected = {}; loadCashbox(); } catch (e) { toast(e.message, true); }
      } }, 'Удалить выбранные'),
      el('button', { class: 'btn-ghost', onclick: () => { cbState.selected = {}; loadCashbox(); } }, 'Снять'),
    ]);
    wrap.appendChild(bulkBar);
    wrap.appendChild(el('div', { class: 'cb-scroll' }, [el('div', { class: 'cash-list' }, [head, inputRow, ...rows])]));
    if (!rows.length && cbState.page <= 1) wrap.appendChild(el('div', { class: 'cash-empty' }, 'Операций пока нет.'));
    // Пагинация (как в Транзакциях).
    const total = list.total || rows.length;
    const pageSize = list.pageSize || cbState.pageSize || 50;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (cbState.page > pages) { cbState.page = pages; }
    const goTo = (pg) => { cbState.page = Math.min(pages, Math.max(1, pg)); loadCashbox(); };
    const fromN = total ? (cbState.page - 1) * pageSize + 1 : 0;
    const toN = Math.min(total, cbState.page * pageSize);
    const pbtn = (label, pg, dis) => el('button', { class: 'btn-ghost cash-page-btn', disabled: dis || null, onclick: () => goTo(pg) }, label);
    wrap.appendChild(el('div', { class: 'cash-pager' }, [
      el('span', { class: 'cash-flab' }, total ? (fromN + '–' + toN + ' из ' + total) : 'Нет записей'),
      el('div', { class: 'cash-page-btns' }, [
        pbtn('« Первая', 1, cbState.page <= 1),
        pbtn('‹ Назад', cbState.page - 1, cbState.page <= 1),
        el('span', { class: 'cash-flab' }, 'Стр. ' + cbState.page + ' из ' + pages),
        pbtn('Вперёд ›', cbState.page + 1, cbState.page >= pages),
        pbtn('Последняя »', pages, cbState.page >= pages),
      ]),
    ]));
    updateBulkBar();
    refreshRate();
  }

  function selectedIds() { return Object.keys(cbState.selected).filter((k) => cbState.selected[k]).map((k) => parseInt(k, 10)); }
  function updateBulkBar() {
    const bar = $('#cb-bulkbar'), cnt = $('#cb-bulk-count'); if (!bar) return;
    const n = selectedIds().length;
    bar.style.display = n ? 'flex' : 'none';
    if (cnt) cnt.textContent = 'Выбрано: ' + n;
  }

  // Подтверждение факт. суммы прихода по обналичиванию — комиссия (статья 64) считается и
  // списывается сама, как разница между снятой с банка суммой и тем, что реально пересчитали.
  function openConfirmCash(x) {
    const factSum = fmoney('', { placeholder: 'Получено сумами' });
    const factUsd = fmoney('', { placeholder: 'Получено долларами ($)' });
    const rate = fmoney('', { placeholder: 'курс' });
    const note = el('div', { class: 'cash-note-info' }, `Снято с банка: ${money(x.amount)} сум. Укажите, сколько пришло сумами и сколько долларами — доллары лягут в кассу как $. Разница спишется комиссией (статья «64»).`);
    const calc = el('div', { class: 'cash-recon-diff' }, '');
    function recalc() {
      const fs = Number(moneyVal(factSum)) || 0;
      const fu = Number(moneyVal(factUsd)) || 0;
      const rt = Number(moneyVal(rate)) || 0;
      const usdEq = (fu > 0 && rt > 0) ? Math.round(fu * rt) : 0;
      const total = Math.round(fs) + usdEq;
      if (!total) { calc.textContent = ''; calc.className = 'cash-recon-diff'; return; }
      const diff = Number(x.amount) - total;
      let txt = 'Итого получено: ' + money(total) + ' сум' + (usdEq ? ' (в т.ч. $' + fu + ' = ' + money(usdEq) + ')' : '');
      txt += diff > 0 ? ' · комиссия ' + money(diff) + ' (' + (diff / x.amount * 100).toFixed(2) + '%)' : (diff < 0 ? ' · БОЛЬШЕ снятого — проверьте' : ' · без комиссии');
      calc.textContent = txt;
      calc.className = 'cash-recon-diff' + (diff < 0 ? ' warn' : ' ok');
    }
    async function autoRate() {
      if (!String(rate.value).trim() && Number(moneyVal(factUsd)) > 0) { try { const r = await api('/fx-rate?date=' + String(x.tx_date).slice(0, 10)); if (r.rate) rate.value = r.rate; } catch (e) { /* нет курса */ } }
      recalc();
    }
    factSum.oninput = recalc; rate.oninput = recalc; factUsd.oninput = autoRate;
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      const fs = Number(moneyVal(factSum)) || 0, fu = Number(moneyVal(factUsd)) || 0, rt = Number(moneyVal(rate)) || 0;
      if (!(fs > 0) && !(fu > 0)) return toast('Укажите сумму', true);
      try { await post('/tx/' + x.id + '/confirm-cash', { fact_sum: fs, fact_usd: fu, rate: rt }); toast('Подтверждено'); closeModal(); loadCashbox(); }
      catch (e) { toast(e.message, true); }
    } }, 'Подтвердить');
    modal('Факт. приход в кассу', el('div', { class: 'cashf' }, [note, frow('Получено сумами', factSum), frow('Получено $', factUsd), frow('Курс', rate), calc]), [save]);
  }

  // Правка уже сохранённой строки (карандашик) — дата/пояснение/статья/валюта/сумма.
  function openCashboxRowEdit(x) {
    const date = el('input', { type: 'date', class: 'cashf-inp', value: String(x.tx_date).slice(0, 10) });
    const purpose = el('input', { class: 'cashf-inp', value: x.purpose || '', placeholder: 'Пояснение' });
    const cat = fsel(catOptions(), x.category_id || '');
    const curr = el('select', { class: 'cashf-inp' }, [el('option', { value: 'UZS', selected: x.currency !== 'USD' || null }, 'сум'), el('option', { value: 'USD', selected: x.currency === 'USD' || null }, '$')]);
    const rate = fmoney(x.currency === 'USD' ? x.fx_rate : '', { placeholder: 'курс' });
    const amt = fmoney(x.currency === 'USD' ? x.fx_amount : x.amount, { placeholder: '0' });
    const rateRow = frow('Курс ЦБ', rate);
    const toggleCurr = () => { rateRow.style.display = curr.value === 'USD' ? '' : 'none'; };
    curr.onchange = toggleCurr; toggleCurr();
    const body = el('div', { class: 'cashf' }, [frow('Дата', date), frow('Пояснение', purpose), frow('Статья ДДС', cat), frow('Валюта', curr), rateRow, frow('Сумма', amt)]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        const isUsd = curr.value === 'USD';
        const a = Number(moneyVal(amt)) || 0;
        const r = isUsd ? Number(moneyVal(rate)) || 0 : null;
        if (isUsd && !(r > 0)) return toast('Укажите курс', true);
        const equivAmount = isUsd ? a * r : a;
        await post('/tx/' + x.id, {
          tx_date: date.value, purpose: purpose.value, category_id: cat.value,
          amount: equivAmount, currency: isUsd ? 'USD' : 'UZS', fx_rate: isUsd ? r : '', fx_amount: isUsd ? a : '',
        });
        toast('Сохранено'); closeModal(); loadCashbox();
      } catch (e) { toast(e.message, true); }
    } }, 'Сохранить');
    const del = el('button', { class: 'btn-ghost cashf-arch', onclick: async () => { if (!confirm('Удалить эту запись? Действие необратимо.')) return; try { await post('/tx/' + x.id + '/delete', {}); toast('Удалено'); closeModal(); loadCashbox(); } catch (e) { toast(e.message, true); } } }, 'Удалить');
    modal('Изменить запись', body, [del, save]);
  }

  // Начальные остатки наличной кассы — раздельно сумы + доллары (+ курс).
  async function openCashOpeningForm(walletId) {
    let d = { uzs: null, usd: null, rate: null, date: null };
    try { d = await api('/cash-opening?wallet=' + walletId); } catch (e) { /* пусто — заведём заново */ }
    const wname = ((DICTS.wallets || []).find((w) => String(w.id) === String(walletId)) || {}).name || 'Наличная касса';
    const date = el('input', { type: 'date', class: 'cashf-inp', value: d.date || cbState.from || todayStr() });
    const uzs = fmoney(d.uzs != null ? d.uzs : '', { placeholder: '0' });
    const usd = fmoney(d.usd != null ? d.usd : '', { placeholder: '0' });
    const rate = fmoney(d.rate != null ? Math.round(d.rate) : '', { placeholder: 'курс ЦБ (авто, если пусто)' });
    const body = el('div', { class: 'cashf' }, [
      el('div', { class: 'cash-note-info' }, 'Начальный остаток кассы «' + wname + '» на выбранную дату — ставьте первым днём периода (например, 01.06.2026). Сумы и доллары — раздельно. Курс нужен, чтобы привести доллары к сумам; если пусто — подставится курс ЦБ на дату.'),
      frow('Дата остатков', date),
      frow('Остаток в сумах', uzs),
      frow('Остаток в долларах ($)', usd),
      frow('Курс для долларов', rate),
    ]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        await post('/cash-opening', { wallet_id: walletId, date: date.value, uzs: moneyVal(uzs), usd: moneyVal(usd), rate: moneyVal(rate) });
        toast('Начальные остатки сохранены'); closeModal(); loadCashbox();
      } catch (e) { toast(e.message, true); }
    } }, 'Сохранить');
    modal('Начальные остатки — ' + wname, body, [save]);
  }

  function openTxForm(type, tx) {
    tx = tx || {};
    const date = finp(tx.tx_date ? String(tx.tx_date).slice(0, 10) : todayStr(), { type: 'date' });
    const amount = fmoney(tx.amount, { placeholder: 'Сумма' });
    const wallet = fsel((DICTS.wallets || []).map((x) => ({ v: x.id, t: x.name })), tx.wallet_id || '');
    const cat = fsel(catOptions(), tx.category_id || '');
    const purpose = finp(tx.purpose, { placeholder: 'Назначение' });
    const rows = [frow('Дата', date), frow('Сумма', amount)];
    if (!tx.id) rows.push(frow('Кошелёк', wallet));
    // «Из выписки» — исходный текст банка (кто платил/получал), read-only.
    if (tx.payer_name) rows.push(frow('Из выписки', el('div', { class: 'cash-note-info' }, tx.payer_name)));
    rows.push(frow('Статья ДДС', cat), frow('Назначение', purpose));
    // Перевод (межбанк/обнал/пополнение карты) — показываем «Откуда/Куда» по кошелькам.
    const transferIds = new Set((DICTS.categories || []).filter((c) => c.direction_hint === 'transfer').map((c) => String(c.id)));
    const isTransferCat = () => transferIds.has(String(cat.value));
    const walletTo = fsel([{ v: '', t: '— кошелёк-получатель —' }].concat((DICTS.wallets || []).map((x) => ({ v: x.id, t: x.name }))), tx.wallet_to_id || '');
    const fromW = (DICTS.wallets || []).find((x) => String(x.id) === String(tx.wallet_id));
    const a2aRow = el('div', {}, [frow('Откуда', el('div', { class: 'cash-note-info' }, (fromW && fromW.name) || tx.wallet_name || '—')), frow('Куда (кошелёк)', walletTo)]);
    const toggleA2A = () => { a2aRow.style.display = isTransferCat() ? '' : 'none'; };
    cat.onchange = toggleA2A;
    rows.push(a2aRow);
    const body = el('div', { class: 'cashf' }, rows);
    toggleA2A();
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        const isA2A = isTransferCat();
        if (tx.id) await post('/tx/' + tx.id, { tx_date: date.value, amount: moneyVal(amount), counterparty_id: tx.counterparty_id || '', category_id: cat.value, purpose: purpose.value, wallet_to_id: isA2A ? walletTo.value : '' });
        else await post('/tx', { tx_type: type, tx_date: date.value, amount: moneyVal(amount), wallet_id: wallet.value, category_id: cat.value, purpose: purpose.value, wallet_to_id: isA2A ? walletTo.value : '' });
        toast('Сохранено'); closeModal(); loadTx();
      } catch (e) { toast(e.message, true); }
    } }, 'Сохранить');
    const acts = [save];
    if (tx.id) acts.unshift(el('button', { class: 'btn-ghost cashf-arch', onclick: async () => { if (!confirm('Удалить транзакцию?')) return; try { await post('/tx/' + tx.id + '/delete', {}); toast('Удалено'); closeModal(); loadTx(); } catch (e) { toast(e.message, true); } } }, 'Удалить'));
    modal(tx.id ? 'Изменить операцию' : (type === 'in' ? 'Приход' : 'Расход'), body, acts);
  }

  function openTransferForm(tx) {
    tx = tx || {};
    const date = finp(tx.tx_date ? String(tx.tx_date).slice(0, 10) : todayStr(), { type: 'date' });
    const amount = fmoney(tx.amount, { placeholder: 'Сумма' });
    const wopts = (DICTS.wallets || []).map((x) => ({ v: x.id, t: x.name }));
    const from = fsel(wopts, tx.wallet_id || '');
    const to = fsel(wopts, tx.wallet_to_id || '');
    if (tx.id) { from.disabled = true; to.disabled = true; }
    const purpose = finp(tx.purpose, { placeholder: 'Комментарий (необязательно)' });
    const rows = [frow('Дата', date), frow('Сумма', amount), frow('Откуда', from), frow('Куда', to), frow('Комментарий', purpose)];
    // Комиссия/% банка за перевод — только при создании (отдельным расходом со статьёй ДДС).
    const feeAmt = fmoney('', { placeholder: '0 — если комиссии нет' });
    const feeCat = fsel(catOptions(), '');
    if (!tx.id) rows.push(frow('Комиссия / % банка', feeAmt), frow('Статья комиссии', feeCat));
    const body = el('div', { class: 'cashf' }, [...rows, el('div', { class: 'cash-note-info' }, 'Перевод между своими кошельками не считается доходом/расходом. Комиссия банка — реальный расход, укажите её сумму и статью (напр. 62 % банка или 64 % за наличку).')]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        if (tx.id) await post('/tx/' + tx.id, { tx_date: date.value, amount: moneyVal(amount), purpose: purpose.value });
        else await post('/tx', { tx_type: 'transfer', tx_date: date.value, amount: moneyVal(amount), wallet_id: from.value, wallet_to_id: to.value, purpose: purpose.value, fee_amount: moneyVal(feeAmt), fee_category_id: feeCat.value });
        toast('Сохранено'); closeModal(); loadTx();
      } catch (e) { toast(e.message, true); }
    } }, 'Сохранить');
    const acts = [save];
    if (tx.id) acts.unshift(el('button', { class: 'btn-ghost cashf-arch', onclick: async () => { if (!confirm('Удалить перевод?')) return; try { await post('/tx/' + tx.id + '/delete', {}); toast('Удалено'); closeModal(); loadTx(); } catch (e) { toast(e.message, true); } } }, 'Удалить'));
    modal(tx.id ? 'Перевод' : 'Перевод между кошельками', body, acts);
  }

  function openImport() {
    const wallet = fsel([{ v: '', t: '— кошелёк —' }].concat((DICTS.wallets || []).map((x) => ({ v: x.id, t: x.name }))), '');
    const file = el('input', { type: 'file', accept: '.xls,.xlsx,.html,.htm', class: 'cashf-inp' });
    const body = el('div', { class: 'cashf' }, [
      el('div', { class: 'cash-sub' }, 'Выберите кошелёк и файл выписки банка. Загружу транзакции; повторные (дубли) пропущу.'),
      frow('Кошелёк', wallet), frow('Файл', file),
    ]);
    const load = el('button', { class: 'btn-primary', onclick: async () => {
      if (!wallet.value) return toast('Выберите кошелёк', true);
      if (!file.files[0]) return toast('Выберите файл', true);
      load.disabled = true; load.textContent = 'Загружаю…';
      const fd = new FormData(); fd.append('wallet_id', wallet.value); fd.append('file', file.files[0]);
      try {
        const res = await fetch('/cash/api/import/run', { method: 'POST', body: fd });
        const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Ошибка');
        toast(`${d.bank}: загружено ${d.inserted}, пропущено ${d.skipped}` + (d.newcp ? `, новых к-агентов ${d.newcp}` : ''));
        closeModal(); render();
      } catch (e) { toast(e.message, true); load.disabled = false; load.textContent = 'Загрузить'; }
    } }, 'Загрузить');
    modal('Импорт выписки', body, [load]);
  }

  async function doWipe() {
    if (!confirm('Удалить ВСЕ транзакции и загрузки выписок? Справочники (статьи, контрагенты, кошельки) останутся. Действие необратимо.')) return;
    const w = prompt('Для подтверждения введите слово: УДАЛИТЬ');
    if (String(w || '').trim().toUpperCase() !== 'УДАЛИТЬ') return toast('Отменено', true);
    try {
      const d = await post('/transactions/wipe', {});
      toast('Удалено транзакций: ' + d.deleted);
      render();
    } catch (e) { toast(e.message, true); }
  }

  // ---------- Начальные остатки ----------
  async function openOpeningForm() {
    let d; try { d = await api('/opening'); } catch (e) { return toast(e.message, true); }
    const date = finp(d.date || todayStr(), { type: 'date' });
    const inputs = {};
    const list = el('div', { class: 'cashf' }, (d.items || []).map((w) => {
      const inp = fmoney(w.amount != null ? w.amount : '', {});
      inputs[w.wallet_id] = inp;
      return frow(w.name, inp);
    }));
    const body = el('div', { class: 'cashf' }, [
      el('div', { class: 'cash-note-info' }, 'Остаток каждого кошелька на выбранную дату. Можно менять в любой момент — вся история пересчитается сама. Пустое поле = нулевой остаток.'),
      frow('Дата остатков', date),
      list,
    ]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      const balances = {};
      Object.entries(inputs).forEach(([wid, inp]) => { const v = moneyVal(inp); if (v !== '') balances[wid] = Number(v); });
      try { await post('/opening', { date: date.value, balances }); toast('Начальные остатки сохранены'); closeModal(); if (TAB === 'tx') loadTx(); else render(); }
      catch (e) { toast(e.message, true); }
    } }, 'Сохранить');
    modal('Начальные остатки', body, [save]);
  }

  // ---------- Сверка остатка ----------
  async function openReconcileForm() {
    const wsel = fsel([{ v: '', t: '— кошелёк —' }].concat((DICTS.wallets || []).map((w) => ({ v: w.id, t: w.name }))), txState.wallet || '');
    const date = finp(txState.to || todayStr(), { type: 'date' });
    const erpBox = el('div', { class: 'cash-note-info' }, '—');
    const fact = fmoney('', { placeholder: 'Фактический остаток' });
    const diffBox = el('div', { class: 'cash-recon-diff' }, '');
    const comment = finp('', { placeholder: 'Комментарий (необязательно)' });
    let erp = null;
    function recalc() {
      if (erp == null || moneyVal(fact) === '') { diffBox.textContent = ''; diffBox.className = 'cash-recon-diff'; saveBtn.disabled = true; saveBtn.textContent = 'Сверить'; return; }
      const diff = Math.round((Number(moneyVal(fact)) - erp) * 100) / 100;
      if (!diff) { diffBox.textContent = '✅ Остаток совпадает'; diffBox.className = 'cash-recon-diff ok'; saveBtn.disabled = true; saveBtn.textContent = 'Совпадает'; }
      else { diffBox.textContent = 'Разница: ' + (diff > 0 ? '+' : '') + money(diff) + ' сум → будет создана корректировка'; diffBox.className = 'cash-recon-diff warn'; saveBtn.disabled = false; saveBtn.textContent = 'Создать корректировку'; }
    }
    async function refreshErp() {
      if (!wsel.value) { erpBox.textContent = 'Выберите кошелёк'; erp = null; return recalc(); }
      erpBox.textContent = 'Считаю…';
      try { const r = await api('/wallet-balance?wallet_id=' + wsel.value + '&date=' + date.value); erp = Number(r.balance); erpBox.textContent = money(erp) + ' сум'; }
      catch (e) { erpBox.textContent = e.message; erp = null; }
      recalc();
    }
    wsel.onchange = refreshErp; date.onchange = refreshErp; fact.oninput = recalc;
    const saveBtn = el('button', { class: 'btn-primary', onclick: async () => {
      if (!wsel.value) return toast('Выберите кошелёк', true);
      try {
        const r = await post('/reconcile', { wallet_id: wsel.value, date: date.value, fact_amount: moneyVal(fact), comment: comment.value });
        if (r.created) toast('Корректировка создана: ' + money(r.diff)); else toast('Остаток совпадает — корректировка не нужна');
        closeModal(); loadTx();
      } catch (e) { toast(e.message, true); }
    } }, 'Сверить');
    saveBtn.disabled = true;
    const body = el('div', { class: 'cashf' }, [
      el('div', { class: 'cash-note-info' }, 'Сверка по одному кошельку на выбранную дату. Если факт отличается от ERP — одной кнопкой создаётся корректировка (пишется в журнал аудита).'),
      frow('Кошелёк', wsel), frow('Дата', date),
      frow('Остаток по ERP', erpBox), frow('Фактический остаток', fact),
      frow('', diffBox), frow('Комментарий', comment),
    ]);
    modal('Сверить остаток', body, [saveBtn]);
    refreshErp();
  }

  // ---------- Поиск и склейка переводов между своими счетами (A2A) ----------
  // Перевод между кошельками через банк приходит двумя записями (расход у отправителя,
  // приход у получателя — разные выписки). Ищем такие пары и склеиваем в одну «Перевод»,
  // иначе одна из сторон норовит попасть в выручку/расходы и задвоить движение денег.
  async function openMatchTransfers() {
    let d; try { d = await api('/transactions/match-candidates'); } catch (e) { return toast(e.message, true); }
    const pairs = d.pairs || [];
    if (!pairs.length) { modal('Переводы между счетами', el('div', { class: 'cash-empty' }, 'Не нашёл пар «расход на одном кошельке / приход на другом» с одинаковой суммой и близкой датой. Если перевод есть, но не нашёлся — сумма/дата на выписках расходятся, свяжите вручную.'), []); return; }
    const boxes = pairs.map((p) => {
      const cb = el('input', { type: 'checkbox', checked: true });
      const row = el('div', { class: 'cash-match-row' }, [
        cb,
        el('div', { class: 'cash-match-info' }, [
          el('div', { class: 'cash-match-main' }, [
            el('span', {}, p.out_wallet_name + ' →'), el('span', {}, ' ' + p.in_wallet_name),
            el('span', { class: 'cash-match-amt' }, money(p.amount) + ' сум'),
          ]),
          el('div', { class: 'cash-sub' }, String(p.out_date).slice(0, 10) + (p.gap_days > 0 ? ' → ' + String(p.in_date).slice(0, 10) : '') + (p.out_purpose ? ' · ' + p.out_purpose : '')),
        ]),
      ]);
      return { row, cb, p };
    });
    const body = el('div', { class: 'cashf' }, [
      el('div', { class: 'cash-note-info' }, 'Найдены пары «расход/приход» на разных кошельках с одинаковой суммой — похоже на переводы между своими счетами. Отметьте нужные — расход станет переводом, парный приход удалится (деньги уже учтены переводом).'),
      el('div', { class: 'cash-match-list' }, boxes.map((b) => b.row)),
    ]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      const chosen = boxes.filter((b) => b.cb.checked).map((b) => ({ out_id: b.p.out_id, in_id: b.p.in_id }));
      if (!chosen.length) return toast('Ничего не отмечено', true);
      try { const r = await post('/transactions/match-confirm', { pairs: chosen }); toast('Склеено переводов: ' + r.done); closeModal(); loadTx(); }
      catch (e) { toast(e.message, true); }
    } }, 'Склеить отмеченные');
    modal('Переводы между счетами (' + pairs.length + ')', body, [save]);
  }

  function openCpImport() {
    const file = el('input', { type: 'file', accept: '.xls,.xlsx', class: 'cashf-inp' });
    const tpl = el('a', { href: '/cash/api/counterparties/template.xlsx', class: 'cash-link' }, '⬇ Скачать шаблон Excel');
    const body = el('div', { class: 'cashf' }, [
      el('div', { class: 'cash-sub' }, 'Скачайте шаблон, заполните (Название, ИНН, Код статьи ДДС, Комментарий) и загрузите. Совпадающих по ИНН/названию обновлю, новых добавлю. Клиентов из SD не трогаю.'),
      el('div', {}, [tpl]),
      frow('Файл', file),
    ]);
    const load = el('button', { class: 'btn-primary', onclick: async () => {
      if (!file.files[0]) return toast('Выберите файл', true);
      load.disabled = true; load.textContent = 'Загружаю…';
      const fd = new FormData(); fd.append('file', file.files[0]);
      try {
        const res = await fetch('/cash/api/counterparties/import', { method: 'POST', body: fd });
        const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Ошибка');
        let msg = `Добавлено ${d.created}, обновлено ${d.updated}`;
        if (d.badCodes && d.badCodes.length) msg += ` · неизвестные коды: ${d.badCodes.join(', ')}`;
        toast(msg);
        closeModal(); await refreshDicts(); render();
      } catch (e) { toast(e.message, true); load.disabled = false; load.textContent = 'Загрузить'; }
    } }, 'Загрузить');
    modal('Импорт контрагентов', body, [load]);
  }

  function renderDicts() {
    const c = $('#cash-content'); c.innerHTML = '';
    const sub = (id, label) => el('button', { class: 'cash-subtab' + (SUB === id ? ' on' : ''), onclick: () => { SUB = id; renderDicts(); } }, label);
    c.appendChild(el('div', { class: 'cash-subtabs' }, [sub('categories', 'Статьи ДДС'), sub('counterparties', 'Контрагенты'), sub('contracts', 'Договоры')]));
    const box = el('div', { id: 'cash-dicts-box' });
    c.appendChild(box);
    if (SUB === 'categories') return renderCategories(box);
    if (SUB === 'counterparties') return renderCounterparties(box);
    return renderContracts(box);
  }

  function renderCategories(box) {
    const cats = DICTS.categories || [];
    box.appendChild(el('div', { class: 'cash-head' }, [
      el('div', {}, [el('div', { class: 'cash-h2' }, 'Классификатор статей (ДДС)'), el('div', { class: 'cash-sub' }, 'По каждой статье — поток для P&L. ★ — только перечислением. Клик — изменить.')]),
      el('div', { class: 'cash-tx-btns' }, [el('button', { class: 'btn-ghost cash-add', onclick: openGroupsManager }, '⚙ Группы'), addBtn('+ Статья', () => openCategoryForm(null))]),
    ]));
    const groups = {};
    cats.forEach((x) => { (groups[x.group_name || '—'] = groups[x.group_name || '—'] || []).push(x); });
    Object.keys(groups).forEach((g) => {
      const block = el('div', { class: 'cash-grp' });
      block.appendChild(el('div', { class: 'cash-grp-h' }, g));
      block.appendChild(el('div', { class: 'cash-cats' }, groups[g].map((x) => el('div', { class: 'cash-cat', style: 'cursor:pointer', onclick: () => openCategoryForm(x) }, [
        el('span', { class: 'cash-cat-code' }, x.code),
        el('span', {}, [x.name, x.only_transfer ? el('span', { class: 'cash-star' }, ' ★') : null]),
        el('span', { class: 'cash-flow cash-flow-' + x.flow_type }, FLOW_LABEL[x.flow_type] || x.flow_type),
      ]))));
      box.appendChild(block);
    });
  }

  function renderCounterparties(box) {
    const syncBtn = el('button', { class: 'btn-ghost cash-add', onclick: async () => {
      syncBtn.disabled = true; syncBtn.textContent = 'Синхронизирую…';
      try { const d = await post('/sync-clients', {}); toast('Клиенты SD: +' + d.created + ', обновлено ' + d.updated); await refreshDicts(); renderDicts(); }
      catch (e) { toast(e.message, true); syncBtn.disabled = false; syncBtn.textContent = '🔄 Клиенты из SD'; }
    } }, '🔄 Клиенты из SD');
    const syncInfo = DICTS.clientsCount ? ('🟢 Клиентов из SD: ' + DICTS.clientsCount + (DICTS.clientsSyncedAt ? ' · синхр. ' + ruDate(DICTS.clientsSyncedAt) : '')) : '⚪ Клиенты из SD ещё не синхронизированы';
    const headBtns = cpView === 'main'
      ? [el('button', { class: 'btn-ghost cash-add', onclick: () => openCpImport() }, '📥 Импорт'), addBtn('+ Прочий контрагент', () => openCpForm(null))]
      : [syncBtn];
    box.appendChild(el('div', { class: 'cash-head' }, [
      el('div', {}, [el('div', { class: 'cash-h2' }, 'Контрагенты'), el('div', { class: 'cash-sub' }, 'Поставщики берутся из Закупа, прочие (банки/налоги) — здесь. Ключ автоклассификации — ИНН. ' + syncInfo)]),
      el('div', { class: 'cash-tx-btns' }, headBtns),
    ]));
    const chip = (id, label) => el('button', { class: 'cash-subtab' + (cpView === id ? ' on' : ''), onclick: () => { cpView = id; renderDicts(); } }, label);
    box.appendChild(el('div', { class: 'cash-subtabs' }, [chip('main', 'Поставщики и прочие'), chip('clients', 'Покупатели (клиенты из SD)')]));
    if (cpView === 'clients') { renderClients(box); return; }

    // Фильтр по статье ДДС + поиск по названию/ИНН.
    const catSel = el('select', { class: 'cashf-inp cash-filt' }, [
      el('option', { value: '', selected: cpFilterCat === '' || null }, '— все статьи —'),
      el('option', { value: '__none__', selected: cpFilterCat === '__none__' || null }, 'Без статьи'),
      ...(DICTS.categories || []).map((c) => el('option', { value: String(c.id), selected: cpFilterCat === String(c.id) || null }, c.code + ' · ' + c.name)),
    ]);
    catSel.onchange = () => { cpFilterCat = catSel.value; renderDicts(); };
    const q = el('input', { class: 'cashf-inp cash-filt-q', placeholder: 'Поиск по названию или ИНН', value: cpFilterQ });
    q.oninput = () => { cpFilterQ = q.value; };
    q.onchange = () => { cpFilterQ = q.value; renderDicts(); };
    const srcSel = el('select', { class: 'cashf-inp cash-filt' }, [
      el('option', { value: '', selected: cpFilterSrc === '' || null }, 'Все источники'),
      el('option', { value: 'purchase', selected: cpFilterSrc === 'purchase' || null }, 'Из Закупа'),
      el('option', { value: 'cash', selected: cpFilterSrc === 'cash' || null }, 'Прочие (Касса)'),
    ]);
    srcSel.onchange = () => { cpFilterSrc = srcSel.value; renderDicts(); };
    const applyBtn = el('button', { class: 'btn-ghost', onclick: () => { cpFilterQ = q.value; renderDicts(); } }, 'Найти');
    const clearBtn = el('button', { class: 'btn-ghost', onclick: () => { cpFilterCat = ''; cpFilterQ = ''; cpFilterSrc = ''; renderDicts(); } }, 'Сброс');
    box.appendChild(el('div', { class: 'cash-filters' }, [el('span', { class: 'cash-flab' }, 'Статья ДДС:'), catSel, el('span', { class: 'cash-flab' }, 'Источник:'), srcSel, q, applyBtn, clearBtn]));
    const listBox = el('div', {}); box.appendChild(listBox);
    renderSuppliersList(listBox);
  }

  async function renderSuppliersList(box) {
    box.innerHTML = '<div class="cash-loading">Загружаю…</div>';
    let data; try { data = await api('/suppliers-view'); } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'cash-empty' }, 'Ошибка: ' + e.message)); return; }
    const all = [...(data.suppliers || []), ...(data.others || [])];
    const needle = cpFilterQ.trim().toLowerCase();
    const shown = all.filter((x) => {
      if (cpFilterSrc && x.source !== cpFilterSrc) return false;
      if (cpFilterCat === '__none__') { if (x.cat_id) return false; }
      else if (cpFilterCat) { if (String(x.cat_id) !== cpFilterCat) return false; }
      if (needle) { const hay = (String(x.name || '') + ' ' + String(x.inn || '')).toLowerCase(); if (!hay.includes(needle)) return false; }
      return true;
    });
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'cash-sub' }, `Показано: ${shown.length} из ${all.length} · из Закупа: ${(data.suppliers || []).length}, прочие: ${(data.others || []).length}`));
    if (!shown.length) { box.appendChild(el('div', { class: 'cash-empty' }, 'Ничего не найдено.')); return; }
    const head = el('div', { class: 'cash-row head cash-cp' }, ['Название', 'ИНН', 'Статья ДДС', 'Источник'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cash-list' }, [head, ...shown.map((x) => el('div', { class: 'cash-row cash-cp', style: 'cursor:pointer', onclick: () => (x.source === 'cash' ? openCpForm(x) : openSupplierInfo(x)) }, [
      el('span', {}, x.name),
      el('span', {}, x.inn || '—'),
      el('span', {}, x.cat_code ? (x.cat_code + ' ' + (x.cat_name || '')) : '—'),
      el('span', {}, x.source === 'purchase' ? el('span', { class: 'cash-src cash-src-p' }, 'Закуп') : el('span', { class: 'cash-src cash-src-c' }, 'Касса')),
    ]))]));
  }

  function openSupplierInfo(x) {
    const body = el('div', { class: 'cashf' }, [
      el('div', { class: 'cash-note-info' }, 'Это поставщик из раздела «Закуп». Редактируется там же: имя, телефон, сальдо и статья ДДС.'),
      frow('Название', el('div', {}, x.name)),
      frow('ИНН', el('div', {}, x.inn || '—')),
      frow('Статья ДДС', el('div', {}, x.cat_code ? (x.cat_code + ' · ' + (x.cat_name || '')) : '— не задана —')),
    ]);
    const open = el('a', { href: '/purchase', class: 'btn-primary', style: 'text-decoration:none' }, 'Открыть Закуп');
    modal('Поставщик (из Закупа)', body, [open]);
  }

  async function renderClients(box) {
    box.appendChild(el('div', { class: 'cash-sub' }, 'Покупатели подтягиваются из SalesDoctor (кнопка «🔄 Клиенты из SD»). По их ИНН приходы привязываются автоматически.'));
    const q = el('input', { class: 'cashf-inp cash-filt-q', placeholder: 'Поиск по названию, юр.лицу или ИНН', value: cpFilterQ });
    const listBox = el('div', {});
    async function load() {
      listBox.innerHTML = '<div class="cash-loading">Загружаю…</div>';
      let data; try { data = await api('/clients' + (q.value.trim() ? '?q=' + encodeURIComponent(q.value.trim()) : '')); } catch (e) { listBox.innerHTML = ''; listBox.appendChild(el('div', { class: 'cash-empty' }, 'Ошибка: ' + e.message)); return; }
      const items = data.items || [];
      listBox.innerHTML = '';
      if (!items.length) { listBox.appendChild(el('div', { class: 'cash-empty' }, q.value.trim() ? 'Ничего не найдено.' : 'Клиентов нет. Нажмите «🔄 Клиенты из SD».')); return; }
      const head = el('div', { class: 'cash-row head cash-cp' }, ['Название', 'Юр.лицо', 'ИНН', ''].map((h) => el('span', {}, h)));
      listBox.appendChild(el('div', { class: 'cash-list' }, [head, ...items.map((c) => el('div', { class: 'cash-row cash-cp' }, [
        el('span', {}, c.name), el('span', { class: 'muted' }, c.firm_name || '—'), el('span', {}, c.inn || '—'), el('span', {}, ''),
      ]))]));
    }
    q.onchange = () => { cpFilterQ = q.value; load(); };
    const findBtn = el('button', { class: 'btn-ghost', onclick: () => { cpFilterQ = q.value; load(); } }, 'Найти');
    box.appendChild(el('div', { class: 'cash-filters' }, [q, findBtn]));
    box.appendChild(listBox);
    load();
  }

  function renderContracts(box) {
    const list = DICTS.contracts || [];
    box.appendChild(el('div', { class: 'cash-head' }, [
      el('div', {}, [el('div', { class: 'cash-h2' }, 'Договоры' + ' (' + list.length + ')'), el('div', { class: 'cash-sub' }, 'Договор задаёт статью ДДС (приоритетнее дефолтной у контрагента). Клик — изменить.')]),
      addBtn('+ Договор', () => openContractForm(null)),
    ]));
    if (!list.length) { box.appendChild(el('div', { class: 'cash-empty' }, 'Договоров пока нет.')); return; }
    const head = el('div', { class: 'cash-row head cash-ct' }, ['Номер', 'Контрагент', 'Статья', 'Сумма'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cash-list' }, [head, ...list.map((x) => el('div', { class: 'cash-row cash-ct', style: 'cursor:pointer', onclick: () => openContractForm(x) }, [
      el('span', {}, x.number || '—'),
      el('span', {}, x.cp_name || '—'),
      el('span', {}, x.cat_code ? (x.cat_code + ' ' + (x.cat_name || '')) : '—'),
      el('span', {}, x.amount != null ? money(x.amount) : '—'),
    ]))]));
  }

  (async function init() {
    $('#cash-main').innerHTML = '<div class="cash-loading">Загрузка…</div>';
    try { DICTS = await api('/dicts'); } catch (e) { $('#cash-main').innerHTML = '<div class="cash-empty">Не удалось загрузить: ' + e.message + '</div>'; return; }
    render();
  })();
})();
