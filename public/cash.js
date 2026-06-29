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
    const grp = finp(c.group_name, { placeholder: 'Группа' });
    const flow = fsel([{ v: 'operating', t: 'Операционный' }, { v: 'investing', t: 'Инвестиции (капекс)' }, { v: 'financing', t: 'Финансы (кредиты/налоги)' }], c.flow_type || 'operating');
    const onlyT = el('input', { type: 'checkbox' }); if (c.only_transfer) onlyT.checked = true;
    const sort = finp(c.sort_order != null ? c.sort_order : 0, { type: 'number' });
    const body = el('div', { class: 'cashf' }, [frow('Код', code), frow('Название', name), frow('Группа', grp), frow('Поток (P&L)', flow), frow('Только перечислением ★', onlyT), frow('Порядок', sort)]);
    const save = el('button', { class: 'btn-primary', onclick: async () => { try { await post('/category', { id: c.id, code: code.value, name: name.value, group_name: grp.value, flow_type: flow.value, only_transfer: onlyT.checked, sort_order: sort.value }); toast('Сохранено'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'Сохранить');
    const acts = [save];
    if (c.id) acts.unshift(el('button', { class: 'btn-ghost cashf-arch', onclick: async () => { if (!confirm('Архивировать статью «' + c.code + ' ' + c.name + '»?')) return; try { await post('/category/' + c.id + '/archive', {}); toast('В архиве'); closeModal(); reload(); } catch (e) { toast(e.message, true); } } }, 'В архив'));
    modal(c.id ? 'Статья ДДС' : 'Новая статья', body, acts);
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
    if (TAB === 'wallets') return renderWallets();
    if (TAB === 'dicts') return renderDicts();
    return renderSoon();
  }
  function renderSoon() {
    $('#cash-content').appendChild(el('div', { class: 'cash-soon' }, 'Этот раздел появится на следующем этапе. Пока готов фундамент и справочники.'));
  }

  function renderWallets() {
    const c = $('#cash-content'); c.innerHTML = '';
    c.appendChild(el('div', { class: 'cash-head' }, [
      el('div', {}, [el('div', { class: 'cash-h2' }, 'Кошельки'), el('div', { class: 'cash-sub' }, 'Счета и кассы. Остаток считается из журнала транзакций (Этап 2). Клик — изменить.')]),
      addBtn('+ Кошелёк', () => openWalletForm(null)),
    ]));
    const w = (DICTS.wallets || []);
    if (!w.length) { c.appendChild(el('div', { class: 'cash-empty' }, 'Кошельков нет.')); return; }
    const KIND = { bank: 'Расчётный счёт', card: 'Карта', cash: 'Наличные', reserve: 'Резерв' };
    c.appendChild(el('div', { class: 'cash-wallets' }, w.map((x) => el('div', { class: 'cash-wallet', style: 'border-left-color:' + (x.color || '#163a28') + ';cursor:pointer', onclick: () => openWalletForm(x) }, [
      el('div', { class: 'cash-wallet-nm' }, x.name),
      el('div', { class: 'cash-wallet-kind' }, KIND[x.kind] || x.kind),
      el('div', { class: 'cash-wallet-bal' }, money(0) + ' сум'),
    ]))));
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
      addBtn('+ Статья', () => openCategoryForm(null)),
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
    box.appendChild(el('div', { class: 'cash-head' }, [
      el('div', {}, [el('div', { class: 'cash-h2' }, 'Контрагенты' + ' (' + list.length + ')'), el('div', { class: 'cash-sub' }, 'Поставщики, аренда, налоги, банк. Код из выписки — ключ автоклассификации. Клик — изменить.')]),
      addBtn('+ Контрагент', () => openCpForm(null)),
    ]));
    if (!list.length) { box.appendChild(el('div', { class: 'cash-empty' }, 'Пока пусто. Контрагенты появятся при импорте выписки (Этап 3) или добавьте вручную.')); return; }
    const head = el('div', { class: 'cash-row head cash-cp' }, ['Название', 'Код / ИНН', 'Статья', 'Комментарий'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cash-list' }, [head, ...list.map((x) => el('div', { class: 'cash-row cash-cp', style: 'cursor:pointer', onclick: () => openCpForm(x) }, [
      el('span', {}, x.name),
      el('span', {}, (x.bank_code || '—') + (x.inn ? ' · ' + x.inn : '')),
      el('span', {}, x.cat_code ? (x.cat_code + ' ' + (x.cat_name || '')) : '—'),
      el('span', {}, x.comment || ''),
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
