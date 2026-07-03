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
  let cpFilterCat = '';
  let cpFilterQ = '';
  let cpFilterSrc = '';

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
    if (TAB === 'cashflow') return renderReport('cashflow');
    if (TAB === 'pnl') return renderReport('pnl');
    if (TAB === 'wallets') return renderWallets();
    if (TAB === 'dicts') return renderDicts();
    return renderSoon();
  }
  function renderSoon() {
    $('#cash-content').appendChild(el('div', { class: 'cash-soon' }, 'Этот раздел появится на следующем этапе. Пока готов фундамент и справочники.'));
  }

  // Панель периода для отчётов (месяц по умолчанию — текущий).
  function repPeriodBar() {
    const dinp = (k) => el('input', { type: 'date', class: 'cashf-inp cash-filt', value: repState[k], onchange: (e) => { repState[k] = e.target.value; render(); } });
    const preset = (label, from, to) => el('button', { class: 'btn-ghost', onclick: () => { repState.from = from; repState.to = to; render(); } }, label);
    const now = new Date();
    const ym = (y, m) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const mEnd = (y, m) => new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
    return el('div', { class: 'cash-filters' }, [
      el('span', { class: 'cash-flab' }, 'С'), dinp('from'), el('span', { class: 'cash-flab' }, 'по'), dinp('to'),
      preset('Текущий месяц', monthStartStr(), todayStr()),
      preset('Прошлый месяц', ym(now.getFullYear(), now.getMonth() - 1), mEnd(now.getFullYear(), now.getMonth() - 1)),
      preset('Год', ym(now.getFullYear(), 0), todayStr()),
    ]);
  }

  const FLOW_RU = { operating: 'Операционный', investing: 'Инвестиции', financing: 'Финансы' };

  async function renderReport(kind) {
    const c = $('#cash-content');
    if (kind === 'pnl') { c.innerHTML = ''; renderPnl(c); return; }
    c.innerHTML = '<div class="cash-loading">Считаю…</div>';
    if (!repState.from) repState.from = monthStartStr();
    if (!repState.to) repState.to = todayStr();
    let d; try { d = await api('/report?from=' + repState.from + '&to=' + repState.to); } catch (e) { c.innerHTML = ''; c.appendChild(el('div', { class: 'cash-empty' }, 'Ошибка: ' + e.message)); return; }
    c.innerHTML = '';
    renderCashflow(c, d.rows || [], d.groups || []);
  }

  function kpiBar(items) {
    return el('div', { class: 'cash-tot-bar' }, items.map(([label, val, cls]) =>
      el('span', { class: 'cash-kpi' }, [el('span', { class: 'cash-kpi-l' }, label + ': '), el('span', { class: 'cash-' + cls }, money(val))])));
  }

  const CHART_COLORS = ['#163a28', '#8cc63f', '#2e7d32', '#b25b00', '#5b3da8', '#c0392b', '#0d7d8c', '#c77800', '#7c8579', '#3f6a16'];
  function donutChart(items, capTitle) {
    const total = items.reduce((s, i) => s + i.value, 0);
    if (!total) return el('div', { class: 'cash-sub' }, 'Нет данных за период.');
    const size = 200, r = size / 2 - 18, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
    let off = 0;
    const segs = items.map((it) => {
      const len = it.value / total * C;
      const s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="28" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      off += len; return s;
    }).join('');
    const svg = `<svg viewBox="0 0 ${size} ${size}" class="cash-donut"><g>${segs}</g><text x="${cx}" y="${cy - 2}" text-anchor="middle" class="cash-donut-cap">${capTitle || 'Итого'}</text><text x="${cx}" y="${cy + 18}" text-anchor="middle" class="cash-donut-val">${money(total)}</text></svg>`;
    const chart = el('div', { class: 'cash-donut-wrap' }); chart.innerHTML = svg;
    const legend = el('div', { class: 'cash-legend' }, items.map((it) => el('div', { class: 'cash-legend-row' }, [
      el('span', { class: 'cash-legend-dot', style: 'background:' + it.color }),
      el('span', { class: 'cash-legend-l' }, it.label),
      el('span', { class: 'cash-legend-v' }, money(it.value) + ' · ' + Math.round(it.value / total * 100) + '%'),
    ])));
    return el('div', { class: 'cash-chart-card' }, [chart, legend]);
  }

  function renderCashflow(c, rows, groupsOrder) {
    c.appendChild(el('div', { class: 'cash-head' }, [el('div', {}, [
      el('div', { class: 'cash-h2' }, 'Кэш-флоу (ДДС)'),
      el('div', { class: 'cash-sub' }, 'Движение денег по статьям за период. Переводы между счетами (A2A) исключены.'),
    ])]));
    c.appendChild(repPeriodBar());
    const totalIn = rows.reduce((s, r) => s + r.inc, 0);
    const totalOut = rows.reduce((s, r) => s + r.exp, 0);
    c.appendChild(kpiBar([['Поступления', totalIn, 'tot-in'], ['Выбытия', totalOut, 'tot-out'], ['Чистый поток', totalIn - totalOut, (totalIn - totalOut) >= 0 ? 'tot-in' : 'tot-out']]));

    // Разбивка по типу потока
    const flows = { operating: 0, investing: 0, financing: 0 };
    rows.forEach((r) => { if (flows[r.flow_type] != null) flows[r.flow_type] += r.inc - r.exp; });
    c.appendChild(el('div', { class: 'cash-flow-cards' }, Object.keys(flows).map((f) =>
      el('div', { class: 'cash-flow-card' }, [el('div', { class: 'cash-flow-card-l' }, FLOW_RU[f]), el('div', { class: 'cash-flow-card-v ' + (flows[f] >= 0 ? 'cash-tot-in' : 'cash-tot-out') }, money(flows[f]))]))));

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
      block.appendChild(el('div', { class: 'cash-list' }, list.filter((r) => r.inc || r.exp).map((r) => el('div', { class: 'cash-row cash-rep' + (!r.cat_id ? ' unclass' : '') }, [
        el('span', {}, r.code ? (r.code + ' · ' + r.name) : 'без статьи'),
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
    ]))));
    const total = w.reduce((s, x) => s + Number(x.balance || 0), 0);
    c.appendChild(el('div', { class: 'cash-total' }, 'Итого по кошелькам: ' + money(total) + ' сум'));
  }

  // ================= ТРАНЗАКЦИИ =================
  const txState = { from: '', to: '', wallet: '', type: '', q: '', category: '', counterparty: '', classified: '', page: 1, pageSize: 50 };
  const repState = { from: '', to: '' };
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
        ...((window.HUB_USER && window.HUB_USER.isAdmin) ? [el('button', { class: 'btn-ghost cash-add cashf-del', onclick: doWipe }, '🧹 Очистить')] : []),
      ]),
    ]));
    const reload1 = () => { txState.page = 1; loadTx(); };
    const dateInp = (k) => el('input', { type: 'date', class: 'cashf-inp cash-filt', value: txState[k], onchange: (e) => { txState[k] = e.target.value; reload1(); } });
    const walletSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { txState.wallet = e.target.value; reload1(); } }, [el('option', { value: '' }, 'Все кошельки'), ...(DICTS.wallets || []).map((x) => el('option', { value: x.id, selected: String(x.id) === txState.wallet || null }, x.name))]);
    const typeSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { txState.type = e.target.value; reload1(); } }, [{ v: '', t: 'Все типы' }, { v: 'in', t: 'Приходы' }, { v: 'out', t: 'Расходы' }, { v: 'transfer', t: 'Переводы' }].map((o) => el('option', { value: o.v, selected: o.v === txState.type || null }, o.t)));
    const catSel = el('select', { class: 'cashf-inp cash-filt', onchange: (e) => { txState.category = e.target.value; reload1(); } }, [el('option', { value: '' }, 'Все статьи ДДС'), ...(DICTS.categories || []).map((x) => el('option', { value: x.id, selected: String(x.id) === txState.category || null }, x.code + ' · ' + x.name))]);
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
    ['from', 'to', 'wallet', 'type', 'q', 'category', 'counterparty', 'classified'].forEach((k) => { if (txState[k]) p.set(k, txState[k]); });
    p.set('page', txState.page); p.set('pageSize', txState.pageSize);
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

  function openTxForm(type, tx) {
    tx = tx || {};
    const date = finp(tx.tx_date ? String(tx.tx_date).slice(0, 10) : todayStr(), { type: 'date' });
    const amount = finp(tx.amount, { type: 'number', placeholder: 'Сумма' });
    const wallet = fsel((DICTS.wallets || []).map((x) => ({ v: x.id, t: x.name })), tx.wallet_id || '');
    const cat = fsel(catOptions(), tx.category_id || '');
    const purpose = finp(tx.purpose, { placeholder: 'Назначение' });
    const rows = [frow('Дата', date), frow('Сумма', amount)];
    if (!tx.id) rows.push(frow('Кошелёк', wallet));
    // «Из выписки» — исходный текст банка (кто платил/получал), read-only.
    if (tx.payer_name) rows.push(frow('Из выписки', el('div', { class: 'cash-note-info' }, tx.payer_name)));
    rows.push(frow('Статья ДДС', cat), frow('Назначение', purpose));
    const body = el('div', { class: 'cashf' }, rows);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        if (tx.id) await post('/tx/' + tx.id, { tx_date: date.value, amount: amount.value, counterparty_id: tx.counterparty_id || '', category_id: cat.value, purpose: purpose.value });
        else await post('/tx', { tx_type: type, tx_date: date.value, amount: amount.value, wallet_id: wallet.value, category_id: cat.value, purpose: purpose.value });
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
