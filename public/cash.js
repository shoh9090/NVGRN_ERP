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
    const grpOpts = [{ v: '', t: '— группа —' }].concat((DICTS.groups || []).map((g) => ({ v: g.name, t: g.name })));
    const grp = fsel(grpOpts, c.group_name || '');
    const flow = fsel([{ v: 'operating', t: 'Операционный' }, { v: 'investing', t: 'Инвестиции (капекс)' }, { v: 'financing', t: 'Финансы (кредиты/налоги)' }], c.flow_type || 'operating');
    const onlyT = el('input', { type: 'checkbox' }); if (c.only_transfer) onlyT.checked = true;
    const sort = finp(c.sort_order != null ? c.sort_order : 0, { type: 'number' });
    const body = el('div', { class: 'cashf' }, [frow('Код', code), frow('Название', name), frow('Группа', grp), frow('Поток (P&L)', flow), frow('Только перечислением ★', onlyT), frow('Порядок', sort)]);
    const save = el('button', { class: 'btn-primary', onclick: async () => { try { await post('/category', { id: c.id, code: code.value, name: name.value, group_name: grp.value, flow_type: flow.value, only_transfer: onlyT.checked, sort_order: sort.value }); toast('Сохранено'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'Сохранить');
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
    const sup = fsel(supOptions(), c.linked_supplier_id || '');
    const comment = finp(c.comment, { placeholder: 'Комментарий' });
    const body = el('div', { class: 'cashf' }, [frow('Название', name), frow('ИНН', inn), frow('Код выписки', code), frow('Статья по умолч.', cat), frow('Поставщик Закупа', sup), frow('Комментарий', comment)]);
    const save = el('button', { class: 'btn-primary', onclick: async () => { try { await post('/counterparty', { id: c.id, name: name.value, inn: inn.value, bank_code: code.value, default_category_id: cat.value, linked_supplier_id: sup.value, comment: comment.value }); toast('Сохранено'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'Сохранить');
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
    const amount = finp(k.amount, { type: 'number', placeholder: 'Сумма (необязательно)' });
    const ds = finp(k.date_start ? String(k.date_start).slice(0, 10) : '', { type: 'date' });
    const de = finp(k.date_end ? String(k.date_end).slice(0, 10) : '', { type: 'date' });
    const status = fsel([{ v: 'active', t: 'Действует' }, { v: 'closed', t: 'Закрыт' }], k.status || 'active');
    const body = el('div', { class: 'cashf' }, [frow('Контрагент', cp), frow('Номер', number), frow('Предмет', subject), frow('Статья ДДС', cat), frow('Сумма', amount), frow('С', ds), frow('По', de), frow('Статус', status)]);
    const save = el('button', { class: 'btn-primary', onclick: async () => { try { await post('/contract', { id: k.id, counterparty_id: cp.value, number: number.value, subject: subject.value, category_id: cat.value, amount: amount.value, date_start: ds.value, date_end: de.value, status: status.value }); toast('Сохранено'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'Сохранить');
    modal(k.id ? 'Договор' : 'Новый договор', body, [save]);
  }

  const addBtn = (label, fn) => el('button', { class: 'btn-primary cash-add', onclick: fn }, label);

  const FLOW_LABEL = { operating: 'операционный', investing: 'инвестиции', financing: 'финансы' };
  let DICTS = null;
  let TAB = 'wallets';
  let SUB = 'categories';
  let cpView = 'main';

  function shell() {
    const main = $('#cash-main'); main.innerHTML = '';
    const tab = (id, label) => el('button', { class: 'cash-tab' + (TAB === id ? ' on' : ''), onclick: () => { TAB = id; render(); } }, label);
    main.appendChild(el('div', { class: 'cash-tabs' }, [
      tab('tx', '💸 Транзакции'),
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
    if (TAB === 'wallets') return renderWallets();
    if (TAB === 'dicts') return renderDicts();
    return renderSoon();
  }
  function renderSoon() {
    $('#cash-content').appendChild(el('div', { class: 'cash-soon' }, 'Этот раздел появится на следующем этапе. Пока готов фундамент и справочники.'));
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
    ]))));
    const total = w.reduce((s, x) => s + Number(x.balance || 0), 0);
    c.appendChild(el('div', { class: 'cash-total' }, 'Итого по кошелькам: ' + money(total) + ' сум'));
  }

  // ================= ТРАНЗАКЦИИ =================
  const txState = { from: '', to: '', wallet: '', type: '', q: '' };
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
        el('button', { class: 'btn-ghost cash-add', onclick: openImport }, '📥 Импорт выписки'),
      ]),
    ]));
    const dateInp = (k) => el('input', { type: 'date', class: 'cashf-inp cash-filt', value: txState[k], onchange: (e) => { txState[k] = e.target.value; loadTx(); } });
    const walletSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { txState.wallet = e.target.value; loadTx(); } }, [el('option', { value: '' }, 'Все кошельки'), ...(DICTS.wallets || []).map((x) => el('option', { value: x.id, selected: String(x.id) === txState.wallet || null }, x.name))]);
    const typeSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { txState.type = e.target.value; loadTx(); } }, [{ v: '', t: 'Все типы' }, { v: 'in', t: 'Приходы' }, { v: 'out', t: 'Расходы' }, { v: 'transfer', t: 'Переводы' }].map((o) => el('option', { value: o.v, selected: o.v === txState.type || null }, o.t)));
    const search = el('input', { type: 'search', class: 'cashf-inp cash-filt cash-filt-q', placeholder: 'Поиск по назначению…', value: txState.q, oninput: (e) => { txState.q = e.target.value; clearTimeout(window.__cashT); window.__cashT = setTimeout(loadTx, 350); } });
    c.appendChild(el('div', { class: 'cash-filters' }, [el('span', { class: 'cash-flab' }, 'С'), dateInp('from'), el('span', { class: 'cash-flab' }, 'по'), dateInp('to'), walletSel, typeSel, search]));
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
    ['from', 'to', 'wallet', 'type', 'q'].forEach((k) => { if (txState[k]) p.set(k, txState[k]); });
    let data; try { data = await api('/transactions?' + p.toString()); } catch (e) { toast(e.message, true); return; }
    txItems = data.items || []; txSel.clear();
    wrap.innerHTML = '';
    const t = data.totals || { in: 0, out: 0 };
    wrap.appendChild(el('div', { class: 'cash-tot-bar' }, [
      el('span', { class: 'cash-tot-in' }, 'Приход: ' + money(t.in)),
      el('span', { class: 'cash-tot-out' }, 'Расход: ' + money(t.out)),
      el('span', { class: 'cash-tot-net' }, 'Сальдо: ' + money(t.in - t.out)),
      data.unclassified ? el('span', { class: 'cash-tot-unc' }, 'Не разобрано: ' + data.unclassified) : null,
    ]));
    const delBtn = el('button', { class: 'btn-ghost cashf-del', onclick: async () => {
      if (!txSel.size) return; if (!confirm('Удалить выбранные операции (' + txSel.size + ')?')) return;
      try { const d = await post('/tx/bulk-delete', { ids: [...txSel] }); toast('Удалено: ' + d.deleted); loadTx(); } catch (e) { toast(e.message, true); }
    } }, 'Удалить выбранные');
    const clr = el('button', { class: 'btn-ghost', onclick: () => { txSel.clear(); loadTx(); } }, 'Снять');
    wrap.appendChild(el('div', { id: 'cash-bulk', class: 'cash-bulkbar', style: 'display:none' }, [el('span', { class: 'cash-bulk-n' }, ''), delBtn, clr]));
    const selAll = el('input', { type: 'checkbox', class: 'cash-chk' });
    selAll.addEventListener('click', (e) => {
      const on = e.target.checked; txSel.clear(); if (on) txItems.forEach((x) => txSel.add(x.id));
      wrap.querySelectorAll('.row-chk').forEach((c) => { c.checked = on; });
      updateBulk();
    });
    const head = el('div', { class: 'cash-row head cash-tx' }, [selAll, ...['Дата', 'Кошелёк', 'От кого', 'Статья', 'Назначение', 'Приход', 'Расход'].map((h) => el('span', {}, h))]);
    wrap.appendChild(el('div', { class: 'cash-list' }, [head, ...txItems.map(txRow)]));
    if (!txItems.length) wrap.appendChild(el('div', { class: 'cash-empty' }, 'Транзакций нет. Добавьте операцию или импортируйте выписку.'));
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

  function openTxForm(type, tx) {
    tx = tx || {};
    const date = finp(tx.tx_date ? String(tx.tx_date).slice(0, 10) : todayStr(), { type: 'date' });
    const amount = finp(tx.amount, { type: 'number', placeholder: 'Сумма' });
    const wallet = fsel((DICTS.wallets || []).map((x) => ({ v: x.id, t: x.name })), tx.wallet_id || '');
    const cp = fsel(cpOptions(), tx.counterparty_id || ''); cp.style.flex = '1';
    const cpWrap = el('div', { style: 'display:flex;gap:6px;align-items:center' }, [cp, el('button', { class: 'btn-ghost', style: 'padding:6px 11px;flex:none', onclick: () => openCpForm(null) }, '＋')]);
    const cat = fsel(catOptions(), tx.category_id || '');
    const purpose = finp(tx.purpose, { placeholder: 'Назначение' });
    const payer = finp(tx.payer_name, { placeholder: 'Кто платит / получает' });
    const rows = [frow('Дата', date), frow('Сумма', amount)];
    if (!tx.id) rows.push(frow('Кошелёк', wallet));
    rows.push(frow('От кого', payer), frow('Контрагент', cpWrap), frow('Статья ДДС', cat), frow('Назначение', purpose));
    const body = el('div', { class: 'cashf' }, rows);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        if (tx.id) await post('/tx/' + tx.id, { tx_date: date.value, amount: amount.value, counterparty_id: cp.value, category_id: cat.value, purpose: purpose.value, payer_name: payer.value });
        else await post('/tx', { tx_type: type, tx_date: date.value, amount: amount.value, wallet_id: wallet.value, counterparty_id: cp.value, category_id: cat.value, purpose: purpose.value, payer_name: payer.value });
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
    const amount = finp(tx.amount, { type: 'number', placeholder: 'Сумма' });
    const wopts = (DICTS.wallets || []).map((x) => ({ v: x.id, t: x.name }));
    const from = fsel(wopts, tx.wallet_id || '');
    const to = fsel(wopts, tx.wallet_to_id || '');
    if (tx.id) { from.disabled = true; to.disabled = true; }
    const purpose = finp(tx.purpose, { placeholder: 'Комментарий (необязательно)' });
    const rows = [frow('Дата', date), frow('Сумма', amount), frow('Откуда', from), frow('Куда', to), frow('Комментарий', purpose)];
    const body = el('div', { class: 'cashf' }, [...rows, el('div', { class: 'cash-note-info' }, 'Перевод между своими кошельками не считается доходом/расходом.')]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        if (tx.id) await post('/tx/' + tx.id, { tx_date: date.value, amount: amount.value, purpose: purpose.value });
        else await post('/tx', { tx_type: 'transfer', tx_date: date.value, amount: amount.value, wallet_id: from.value, wallet_to_id: to.value, purpose: purpose.value });
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
    const list = DICTS.counterparties || [];
    const syncBtn = el('button', { class: 'btn-ghost cash-add', onclick: async () => {
      syncBtn.disabled = true; syncBtn.textContent = 'Синхронизирую…';
      try { const d = await post('/sync-clients', {}); toast('Клиенты SD: +' + d.created + ', обновлено ' + d.updated); await refreshDicts(); renderDicts(); }
      catch (e) { toast(e.message, true); syncBtn.disabled = false; syncBtn.textContent = '🔄 Клиенты из SD'; }
    } }, '🔄 Клиенты из SD');
    const syncInfo = DICTS.clientsCount ? ('🟢 Клиентов из SD: ' + DICTS.clientsCount + (DICTS.clientsSyncedAt ? ' · синхр. ' + ruDate(DICTS.clientsSyncedAt) : '')) : '⚪ Клиенты из SD ещё не синхронизированы';
    box.appendChild(el('div', { class: 'cash-head' }, [
      el('div', {}, [el('div', { class: 'cash-h2' }, 'Контрагенты' + ' (' + list.length + ')'), el('div', { class: 'cash-sub' }, 'Поставщики, аренда, налоги, банк. Ключ автоклассификации — ИНН. ' + syncInfo)]),
      el('div', { class: 'cash-tx-btns' }, [syncBtn, addBtn('+ Контрагент', () => openCpForm(null))]),
    ]));
    const chip = (id, label) => el('button', { class: 'cash-subtab' + (cpView === id ? ' on' : ''), onclick: () => { cpView = id; renderDicts(); } }, label);
    box.appendChild(el('div', { class: 'cash-subtabs' }, [chip('main', 'Поставщики и прочие'), chip('clients', 'Покупатели (клиенты из SD)')]));
    if (cpView === 'clients') { renderClients(box); return; }
    if (!list.length) { box.appendChild(el('div', { class: 'cash-empty' }, 'Пока пусто. Контрагенты появятся при импорте выписки или добавьте вручную.')); return; }
    const head = el('div', { class: 'cash-row head cash-cp' }, ['Название', 'Код / ИНН', 'Статья', 'Комментарий'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cash-list' }, [head, ...list.map((x) => el('div', { class: 'cash-row cash-cp', style: 'cursor:pointer', onclick: () => openCpForm(x) }, [
      el('span', {}, x.name),
      el('span', {}, (x.bank_code || '—') + (x.inn ? ' · ' + x.inn : '')),
      el('span', {}, x.cat_code ? (x.cat_code + ' ' + (x.cat_name || '')) : '—'),
      el('span', {}, x.comment || ''),
    ]))]));
  }

  async function renderClients(box) {
    let data; try { data = await api('/clients'); } catch (e) { box.appendChild(el('div', { class: 'cash-empty' }, 'Ошибка: ' + e.message)); return; }
    const items = data.items || [];
    box.appendChild(el('div', { class: 'cash-sub' }, 'Покупатели подтягиваются из SalesDoctor (кнопка «🔄 Клиенты из SD»). По их ИНН приходы привязываются автоматически.'));
    if (!items.length) { box.appendChild(el('div', { class: 'cash-empty' }, 'Клиентов нет. Нажмите «🔄 Клиенты из SD».')); return; }
    const head = el('div', { class: 'cash-row head cash-cp' }, ['Название', 'ИНН', '', ''].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cash-list' }, [head, ...items.map((c) => el('div', { class: 'cash-row cash-cp' }, [
      el('span', {}, c.name), el('span', {}, c.inn || '—'), el('span', {}, ''), el('span', {}, ''),
    ]))]));
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
