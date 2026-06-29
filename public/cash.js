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
    c.appendChild(el('div', {}, [el('div', { class: 'cash-h2' }, 'Кошельки'), el('div', { class: 'cash-sub' }, 'Счета и кассы. Остаток считается из журнала транзакций (появится на Этапе 2).')]));
    const w = (DICTS.wallets || []);
    if (!w.length) { c.appendChild(el('div', { class: 'cash-empty' }, 'Кошельков нет.')); return; }
    const KIND = { bank: 'Расчётный счёт', card: 'Карта', cash: 'Наличные', reserve: 'Резерв' };
    c.appendChild(el('div', { class: 'cash-wallets' }, w.map((x) => el('div', { class: 'cash-wallet', style: 'border-left-color:' + (x.color || '#163a28') }, [
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
    box.appendChild(el('div', {}, [el('div', { class: 'cash-h2' }, 'Классификатор статей (ДДС)'), el('div', { class: 'cash-sub' }, 'По каждой статье — поток для P&L. ★ — только перечислением.')]));
    const groups = {};
    cats.forEach((x) => { (groups[x.group_name || '—'] = groups[x.group_name || '—'] || []).push(x); });
    Object.keys(groups).forEach((g) => {
      const block = el('div', { class: 'cash-grp' });
      block.appendChild(el('div', { class: 'cash-grp-h' }, g));
      block.appendChild(el('div', { class: 'cash-cats' }, groups[g].map((x) => el('div', { class: 'cash-cat' }, [
        el('span', { class: 'cash-cat-code' }, x.code),
        el('span', {}, [x.name, x.only_transfer ? el('span', { class: 'cash-star' }, ' ★') : null]),
        el('span', { class: 'cash-flow cash-flow-' + x.flow_type }, FLOW_LABEL[x.flow_type] || x.flow_type),
      ]))));
      box.appendChild(block);
    });
  }

  function renderCounterparties(box) {
    const list = DICTS.counterparties || [];
    box.appendChild(el('div', {}, [el('div', { class: 'cash-h2' }, 'Контрагенты' + ' (' + list.length + ')'), el('div', { class: 'cash-sub' }, 'Единый справочник: поставщики, аренда, налоги, банк. Код из выписки — ключ автоклассификации.')]));
    if (!list.length) { box.appendChild(el('div', { class: 'cash-empty' }, 'Пока пусто. Контрагенты появятся при импорте выписки (Этап 3) или вручную.')); return; }
    const head = el('div', { class: 'cash-row head cash-cp' }, ['Название', 'Код / ИНН', 'Статья', 'Комментарий'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cash-list' }, [head, ...list.map((x) => el('div', { class: 'cash-row cash-cp' }, [
      el('span', {}, x.name),
      el('span', {}, (x.bank_code || '—') + (x.inn ? ' · ' + x.inn : '')),
      el('span', {}, x.cat_code ? (x.cat_code + ' ' + (x.cat_name || '')) : '—'),
      el('span', {}, x.comment || ''),
    ]))]));
  }

  function renderContracts(box) {
    const list = DICTS.contracts || [];
    box.appendChild(el('div', {}, [el('div', { class: 'cash-h2' }, 'Договоры' + ' (' + list.length + ')'), el('div', { class: 'cash-sub' }, 'Договор задаёт статью ДДС (приоритетнее дефолтной у контрагента).')]));
    if (!list.length) { box.appendChild(el('div', { class: 'cash-empty' }, 'Договоров пока нет.')); return; }
    const head = el('div', { class: 'cash-row head cash-ct' }, ['Номер', 'Контрагент', 'Статья', 'Сумма'].map((h) => el('span', {}, h)));
    box.appendChild(el('div', { class: 'cash-list' }, [head, ...list.map((x) => el('div', { class: 'cash-row cash-ct' }, [
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
