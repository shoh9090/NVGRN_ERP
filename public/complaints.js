// complaints.js — SPA блока «Претензии»: вкладки Дашборд (по умолчанию) + Список.
(function () {
  const $ = (s) => document.querySelector(s);
  const isAdmin = !!(window.HUB_USER && window.HUB_USER.isAdmin);
  const canManage = !!(window.HUB_USER && (window.HUB_USER.canManage || window.HUB_USER.isAdmin));
  const ruDateTime = (s) => { if (!s) return ''; const d = new Date(s); return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  const ruDate = (s) => { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }); };

  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'html') n.innerHTML = v;
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) { if (c == null) continue; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return n;
  };
  const svgEl = (html, attrs) => { const w = el('div', { class: attrs.class || '' }); w.innerHTML = `<svg viewBox="${attrs.vb}" width="100%" ${attrs.style ? 'style="' + attrs.style + '"' : ''}>${html}</svg>`; return w.firstChild; };

  async function api(path, opts = {}) {
    const res = await fetch('/complaints/api' + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
  }
  function toast(msg, isErr) {
    const t = el('div', { class: 'toast' + (isErr ? ' toast-err' : '') }, msg);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
  }
  function modal(title, bodyNode, actions) {
    const root = $('#cmp-modal-root'); root.innerHTML = '';
    const overlay = el('div', { class: 'imp-overlay' });
    const panel = el('div', { class: 'imp-panel pur-modal cmp-modal' }, [
      el('div', { class: 'imp-head' }, [el('h3', {}, title), el('button', { class: 'imp-x', onclick: () => (root.innerHTML = '') }, '✕')]),
      el('div', { class: 'imp-body pur-modal-body' }, [bodyNode]),
      actions && actions.length ? el('div', { class: 'imp-actions' }, actions) : null,
    ]);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) root.innerHTML = ''; });
    root.appendChild(overlay);
    return { close: () => (root.innerHTML = '') };
  }

  const STATUS_CLASS = { new: 'cmp-st-new', agent_reacted: 'cmp-st-agent', in_review: 'cmp-st-review', resolved: 'cmp-st-done' };
  const LINK_CLASS = { field: 'cmp-lk-field', production: 'cmp-lk-prod', packing: 'cmp-lk-pack', fulfillment: 'cmp-lk-ful' };
  const LINK_COLOR = { field: '#2e7d32', production: '#c77800', packing: '#0d5aa7', fulfillment: '#ad1457' };

  let DICTS = null;
  const lbl = (kind, code) => { const a = (DICTS && DICTS[kind]) || []; const f = a.find((x) => x.code === code); return f ? f.label_ru : (code || ''); };
  function monthLabelRu(ym) { const n = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']; const [y, m] = String(ym).split('-').map(Number); return n[(m || 1) - 1] + ' ' + y; }

  let TAB = 'dash';
  const listState = { from: '', to: '', status: '', type: '', link: '', severity: '', q: '', inn: '', point: '', agent: '' };
  let dashMonth = null;
  let dashInn = '';   // выбранный контрагент (ИНН/название)
  let dashPoint = ''; // выбранная точка
  let dashAgent = ''; // выбранный агент
  let NETS = null;    // кэш справочника контрагентов/точек
  async function loadNets() { if (!NETS) { try { NETS = await api('/networks'); } catch (e) { NETS = { networks: [], points: [] }; } } return NETS; }

  // Выпадашка с поиском по первым буквам. items: [{value,label}]; onPick(value).
  function searchSelect(items, currentVal, placeholder, onPick) {
    const cur = items.find((i) => String(i.value) === String(currentVal));
    const inp = el('input', { class: 'cmp-f cmp-ss-inp', placeholder, value: cur ? cur.label : '', autocomplete: 'off' });
    const panel = el('div', { class: 'cmp-ss-panel', style: 'display:none' });
    const wrap = el('div', { class: 'cmp-ss' }, [inp, panel]);
    const renderOpts = (q) => {
      panel.innerHTML = '';
      const qq = (q || '').trim().toLowerCase();
      const list = [{ value: '', label: placeholder }].concat(items).filter((i) => !qq || i.label.toLowerCase().includes(qq));
      if (!list.length) { panel.appendChild(el('div', { class: 'cmp-ss-empty' }, 'Ничего не найдено')); return; }
      list.slice(0, 60).forEach((i) => panel.appendChild(el('div', {
        class: 'cmp-ss-opt' + (String(i.value) === String(currentVal) ? ' on' : ''),
        onmousedown: (e) => { e.preventDefault(); inp.value = i.value ? i.label : ''; panel.style.display = 'none'; onPick(i.value); },
      }, i.label)));
    };
    inp.addEventListener('focus', () => { inp.select(); renderOpts(''); panel.style.display = 'block'; });
    inp.addEventListener('input', () => { renderOpts(inp.value); panel.style.display = 'block'; });
    inp.addEventListener('blur', () => setTimeout(() => { panel.style.display = 'none'; }, 150));
    return wrap;
  }
  const netItems = () => ((NETS && NETS.networks) || []).map((n) => ({ value: n.inn, label: (n.name || n.inn) + ' (' + n.n + ')' }));
  const pointItems = (inn) => ((NETS && NETS.points) || []).filter((p) => !inn || String(p.inn) === String(inn)).map((p) => ({ value: p.point, label: p.point + ' (' + p.n + ')' }));
  const agentItems = () => ((NETS && NETS.agents) || []).map((a) => ({ value: a.id, label: a.name + ' (' + a.n + ')' }));

  // ---------- Каркас с вкладками ----------
  function shell() {
    const main = $('#cmp-main'); main.innerHTML = '';
    const tab = (id, label) => el('button', { class: 'cmp-tab' + (TAB === id ? ' on' : ''), onclick: () => { TAB = id; render(); } }, label);
    const tabs = [tab('dash', '📊 Дашборд'), tab('list', '📋 Список')];
    if (canManage) tabs.push(tab('settings', '⚙️ Справочник'));
    main.appendChild(el('div', { class: 'cmp-tabs' }, tabs));
    main.appendChild(el('div', { id: 'cmp-content' }));
  }
  function render() { shell(); TAB === 'dash' ? renderDashboard() : TAB === 'settings' ? renderSettings() : renderList(); }

  // ================= ДАШБОРД =================
  async function renderDashboard() {
    const c = $('#cmp-content');
    c.innerHTML = '<div class="cmp-loading">Загрузка…</div>';
    await loadNets();
    const qp = new URLSearchParams();
    if (dashMonth) qp.set('month', dashMonth);
    if (dashInn) qp.set('inn', dashInn);
    if (dashPoint) qp.set('point', dashPoint);
    if (dashAgent) qp.set('agent', dashAgent);
    let s;
    try { s = await api('/stats' + (qp.toString() ? '?' + qp.toString() : '')); }
    catch (e) { c.innerHTML = ''; c.appendChild(el('div', { class: 'cmp-empty' }, 'Не удалось загрузить дашборд: ' + e.message)); return; }
    dashMonth = s.month;
    c.innerHTML = '';

    const monthSel = el('select', { class: 'cmp-f', onchange: (e) => { dashMonth = e.target.value; renderDashboard(); } },
      s.monthsAvail.map((m) => el('option', { value: m, selected: m === s.month || null }, monthLabelRu(m))));
    // Фильтр по контрагенту (ИНН) → точке — с поиском по первым буквам.
    const netSel = searchSelect(netItems(), dashInn, 'Все контрагенты', (v) => { dashInn = v; dashPoint = ''; renderDashboard(); });
    const pointSel = searchSelect(pointItems(dashInn), dashPoint, dashInn ? 'Все точки контрагента' : 'Все точки', (v) => { dashPoint = v; renderDashboard(); });
    const agentSel = searchSelect(agentItems(), dashAgent, 'Все агенты', (v) => { dashAgent = v; renderDashboard(); });
    c.appendChild(el('div', { class: 'cmp-dash-top' }, [
      el('div', {}, [el('div', { class: 'cmp-eyebrow' }, 'Контроль качества'), el('h2', { class: 'cmp-h2' }, 'Претензии — где течёт'), el('div', { class: 'cmp-dash-hint' }, 'Кликните по цифре, типу, звену, контрагенту или ячейке — покажу сами претензии')]),
      el('div', { class: 'cmp-month', style: 'flex-wrap:wrap;gap:8px' }, [
        el('span', {}, 'Контрагент:'), netSel, pointSel, agentSel,
        el('span', {}, 'Месяц:'), monthSel,
        (dashInn || dashPoint || dashAgent) ? el('button', { class: 'cmp-f', style: 'cursor:pointer', onclick: () => { dashInn = ''; dashPoint = ''; dashAgent = ''; renderDashboard(); } }, 'Сбросить') : null,
        el('button', { class: 'cmp-f', style: 'cursor:pointer', title: 'Выгрузить отфильтрованные претензии в Excel', onclick: () => { const ep = new URLSearchParams(monthRange(s.month)); if (dashInn) ep.set('inn', dashInn); if (dashPoint) ep.set('point', dashPoint); if (dashAgent) ep.set('agent', dashAgent); window.location = '/complaints/api/export.xlsx?' + ep.toString(); } }, '📥 Excel'),
      ]),
    ]));

    const k = s.kpi;
    const mr = monthRange(s.month);
    const mLabel = monthLabelRu(s.month);
    c.appendChild(el('div', { class: 'cmp-kpis' }, [
      kpi('Всего за месяц', String(k.total), delta(k.totalDelta) + ' к ' + s.prevLabel, false, false,
        () => drill('Все претензии · ' + mLabel, mr)),
      kpi('живность', String(k.zhivnost), 'биоугроза · ' + delta(k.zhivnostDelta), true, false,
        () => drill('Живность · ' + mLabel, Object.assign({ type: 'zhivnost' }, mr))),
      kpi('Главное звено', k.topLink ? lbl('link', k.topLink.code) : '—', k.topLink ? k.topLink.n + ' претензий' : '', false, true,
        k.topLink ? () => drill('Звено: ' + lbl('link', k.topLink.code) + ' · ' + mLabel, Object.assign({ link: k.topLink.code }, mr)) : null),
      kpi('Проблемный продукт', k.topProduct ? k.topProduct.name : '—', k.topProduct ? k.topProduct.n + ' претензий' : '', false, true,
        k.topProduct ? () => drill('Продукт: ' + k.topProduct.name + ' · ' + mLabel, Object.assign({ product: k.topProduct.name }, mr)) : null),
    ]));

    const row1 = el('div', { class: 'cmp-grid cmp-grid-2' });
    row1.appendChild(panel('Матрица: продукт × месяц', 'Чем краснее — тем больше косяков. Видно, где и когда.', heatmap(s.matrix)));
    row1.appendChild(panel('По звеньям', 'Куда указывает тип жалобы.', donutBlock(s.byLink)));
    c.appendChild(row1);

    const row2 = el('div', { class: 'cmp-grid cmp-grid-2' });
    row2.appendChild(panel('Динамика по месяцам', 'Сравнение из месяца в месяц.', trendChart(s.trend, s.month)));
    row2.appendChild(panel('Топ типов жалоб', '«Неположили» — это комплектация, не качество.', typeBars(s.byType)));
    c.appendChild(row2);

    // Разбивка по контрагентам и точкам.
    const row3 = el('div', { class: 'cmp-grid cmp-grid-2' });
    row3.appendChild(panel('По контрагентам', 'Сколько претензий от какого контрагента (по ИНН из SalesDoctor).',
      namedDonut(s.byNetwork, (z) => { dashInn = z.code; dashPoint = ''; renderDashboard(); })));
    row3.appendChild(panel(dashInn ? 'По точкам контрагента' : 'По точкам', 'Из какой торговой точки пришла претензия.',
      namedBars(s.byPoint, (z) => { dashPoint = z.name; renderDashboard(); })));
    c.appendChild(row3);

    c.appendChild(panel('По назначению продукта', 'Для чего использовали продукт, по которому пожаловались.', usageBars(s.byUsage), true));
    c.appendChild(panel('По финальному виду в блюде', 'В каком виде продукт попадал в блюдо.', dishBars(s.byDish), true));
    c.appendChild(panel('По агентам', 'В живой версии — имена из SalesDoctor и скорость реакции.', agentTable(s.byAgent), true));
  }

  function delta(d) { if (d == null) return ''; const up = d > 0; const arr = d === 0 ? '→' : up ? '↑' : '↓'; return `${arr} ${Math.abs(d)}%`; }

  function kpi(lab, num, sub, alert, small, onClick) {
    return el('div', { class: 'cmp-kpi' + (alert ? ' alert' : '') + (onClick ? ' cmp-clk' : ''), onclick: onClick || null }, [
      alert ? el('span', { class: 'cmp-kpi-tag' }, 'критично') : null,
      el('div', { class: 'cmp-kpi-lab' }, lab),
      el('div', { class: 'cmp-kpi-num' + (small ? ' sm' : '') }, num),
      sub ? el('div', { class: 'cmp-kpi-sub' }, sub) : null,
    ]);
  }
  function panel(title, hint, body, full) {
    return el('div', { class: 'cmp-panel' + (full ? ' cmp-full' : '') }, [
      el('h3', {}, title), hint ? el('p', { class: 'cmp-hint' }, hint) : null, body,
    ]);
  }

  // ----- Drill-down: клик по элементу дашборда → модалка с самими претензиями -----
  function monthRange(ym) {
    const [y, m] = String(ym).split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { from: ym + '-01', to: last };
  }
  function drillRow(c, n) {
    return el('div', { class: 'cmp-drill-row', onclick: () => openCard(c.id) }, [
      el('span', { class: 'cmp-drill-n' }, String(n)),
      el('span', { class: 'cmp-drill-dt' }, ruDate(c.created_at)),
      el('span', { class: 'cmp-drill-pr' }, [el('b', {}, c.product_name || '—'), c.product_category ? el('span', { class: 'cmp-cat' }, c.product_category) : null]),
      el('span', { class: 'cmp-drill-ty' }, lbl('type', c.complaint_type) || '—'),
      c.link_code ? el('span', { class: 'cmp-link ' + (LINK_CLASS[c.link_code] || '') }, lbl('link', c.link_code)) : el('span', {}, '—'),
      el('span', { class: 'cmp-drill-pt' }, c.point_name || c.firm_name || '—'),
      c.media_count ? el('span', { class: 'cmp-media' }, '📎 ' + c.media_count) : el('span', {}),
      el('span', { class: 'cmp-badge ' + (STATUS_CLASS[c.status] || '') }, lbl('status', c.status)),
    ]);
  }
  async function drill(title, params) {
    const qs = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => { if (v) qs.set(k, v); });
    let data;
    try { data = await api('/list?' + qs.toString()); } catch (e) { return toast(e.message, true); }
    const items = data.items || [];
    const body = items.length
      ? el('div', { class: 'cmp-drill' }, [
          el('div', { class: 'cmp-drill-sum' }, 'Найдено претензий: ' + items.length),
          el('div', { class: 'cmp-drill-list' }, items.map((c, i) => drillRow(c, i + 1))),
        ])
      : el('div', { class: 'cmp-empty' }, 'Нет претензий по этому срезу.');
    modal(title, body);
  }

  function heatmap(mx) {
    if (!mx || !mx.rows || !mx.rows.length) return el('div', { class: 'cmp-empty' }, 'Нет данных за период.');
    const max = Math.max(1, ...mx.rows.flatMap((r) => r.vals));
    const color = (v) => {
      if (!v) return '#f3f2ea';
      const t = v / max, a = [238, 240, 230], b = [243, 215, 154], cc = [228, 150, 60], d = [192, 57, 43];
      let x, y, k; if (t < 0.5) { k = t / 0.5; x = a; y = b; } else if (t < 0.8) { k = (t - 0.5) / 0.3; x = b; y = cc; } else { k = (t - 0.8) / 0.2; x = cc; y = d; }
      const m = (i) => Math.round(x[i] + (y[i] - x[i]) * k); return `rgb(${m(0)},${m(1)},${m(2)})`;
    };
    const head = el('tr', {}, [el('th', {}, ''), ...mx.months.map((m) => el('th', {}, m.label.split(' ')[0])), el('th', {}, '')]);
    const rows = mx.rows.map((r) => el('tr', {}, [
      el('td', { class: 'cmp-hm-lbl' }, r.product),
      ...r.vals.map((v, j) => el('td', {
        class: 'cmp-hm-cell' + (v ? ' cmp-clk' : ''),
        style: `background:${color(v)};color:${v / max > 0.62 ? '#fff' : '#26331f'}`,
        onclick: v ? () => { const ym = mx.months[j].ym; drill(r.product + ' · ' + monthLabelRu(ym), Object.assign({ product: r.product }, monthRange(ym))); } : null,
      }, v ? String(v) : '')),
      el('td', { class: 'cmp-hm-tot' }, String(r.tot)),
    ]));
    const table = el('table', { class: 'cmp-hm' }, [el('thead', {}, head), el('tbody', {}, rows)]);
    return el('div', {}, [table, el('div', { class: 'cmp-hm-note' }, [el('span', {}, 'меньше'), el('span', { class: 'cmp-scale' }), el('span', {}, 'больше')])]);
  }

  function donutBlock(byLink) {
    if (!byLink || !byLink.length) return el('div', { class: 'cmp-empty' }, 'Нет данных за период.');
    const tot = byLink.reduce((s, x) => s + x.n, 0);
    let ang = -Math.PI / 2; const R = 78, cx = 100, cy = 100, sw = 30; let paths = '';
    byLink.forEach((z) => {
      const a2 = ang + (z.n / tot) * Math.PI * 2;
      const x1 = cx + R * Math.cos(ang), y1 = cy + R * Math.sin(ang), x2 = cx + R * Math.cos(a2), y2 = cy + R * Math.sin(a2);
      const large = (a2 - ang) > Math.PI ? 1 : 0;
      paths += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${LINK_COLOR[z.code] || '#999'}" stroke-width="${sw}"/>`;
      ang = a2;
    });
    paths += `<text x="100" y="96" text-anchor="middle" font-family="Lora,serif" font-size="30" font-weight="600" fill="#163a28">${tot}</text><text x="100" y="116" text-anchor="middle" font-size="11" fill="#7c8579">всего</text>`;
    const donut = svgEl(paths, { vb: '0 0 200 200', style: 'max-height:185px' });
    const leg = el('div', { class: 'cmp-leg' }, byLink.map((z) =>
      el('div', { class: 'cmp-leg-it cmp-clk', onclick: () => drill('Звено: ' + lbl('link', z.code) + ' · ' + monthLabelRu(dashMonth), Object.assign({ link: z.code }, monthRange(dashMonth))) }, [
        el('span', { class: 'cmp-leg-dot', style: 'background:' + (LINK_COLOR[z.code] || '#999') }),
        el('span', { class: 'cmp-leg-nm' }, lbl('link', z.code)),
        el('span', { class: 'cmp-leg-vl' }, String(z.n)),
        el('span', { class: 'cmp-leg-pc' }, Math.round(z.n / tot * 100) + '%'),
      ])));
    return el('div', {}, [donut, leg]);
  }

  // Универсальный пончик по произвольным категориям (сети/точки) с кликом.
  const NAMED_COLORS = ['#163a28', '#8cc63f', '#c77800', '#0d5aa7', '#6a4fb6', '#2e7d32', '#ad1457', '#00838f', '#b25b00', '#5a665c'];
  function namedDonut(items, onClick) {
    if (!items || !items.length) return el('div', { class: 'cmp-empty' }, 'Нет данных за период.');
    const tot = items.reduce((s, x) => s + x.n, 0);
    let ang = -Math.PI / 2; const R = 78, cx = 100, cy = 100, sw = 30; let paths = '';
    items.forEach((z, i) => {
      const a2 = ang + (z.n / tot) * Math.PI * 2;
      const x1 = cx + R * Math.cos(ang), y1 = cy + R * Math.sin(ang), x2 = cx + R * Math.cos(a2), y2 = cy + R * Math.sin(a2);
      const large = (a2 - ang) > Math.PI ? 1 : 0;
      paths += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${NAMED_COLORS[i % NAMED_COLORS.length]}" stroke-width="${sw}"/>`;
      ang = a2;
    });
    paths += `<text x="100" y="96" text-anchor="middle" font-family="Lora,serif" font-size="30" font-weight="600" fill="#163a28">${tot}</text><text x="100" y="116" text-anchor="middle" font-size="11" fill="#7c8579">всего</text>`;
    const donut = svgEl(paths, { vb: '0 0 200 200', style: 'max-height:185px' });
    const leg = el('div', { class: 'cmp-leg' }, items.map((z, i) =>
      el('div', { class: 'cmp-leg-it' + (onClick ? ' cmp-clk' : ''), onclick: onClick ? () => onClick(z) : null }, [
        el('span', { class: 'cmp-leg-dot', style: 'background:' + NAMED_COLORS[i % NAMED_COLORS.length] }),
        el('span', { class: 'cmp-leg-nm', title: z.name }, z.name),
        el('span', { class: 'cmp-leg-vl' }, String(z.n)),
        el('span', { class: 'cmp-leg-pc' }, Math.round(z.n / tot * 100) + '%'),
      ])));
    return el('div', {}, [donut, leg]);
  }
  // Универсальные горизонтальные бары по имени + клик.
  function namedBars(items, onClick) {
    if (!items || !items.length) return el('div', { class: 'cmp-empty' }, 'Нет данных за период.');
    const max = Math.max(...items.map((t) => t.n));
    return el('div', { class: 'cmp-bars' }, items.map((t) =>
      el('div', { class: 'cmp-bar' + (onClick ? ' cmp-clk' : ''), onclick: onClick ? () => onClick(t) : null }, [
        el('span', { class: 'cmp-bar-nm', title: t.name }, t.name),
        el('span', { class: 'cmp-bar-track' }, [el('span', { class: 'cmp-bar-fill', style: `width:${Math.round(t.n / max * 100)}%` })]),
        el('span', { class: 'cmp-bar-vl' }, String(t.n)),
      ])));
  }

  function trendChart(trend, curYm) {
    if (!trend || trend.length < 2) return el('div', { class: 'cmp-empty' }, 'Мало точек для графика (нужно ≥2 месяца).');
    const W = 560, H = 220, pad = 34, maxT = Math.max(1, ...trend.map((t) => t.n));
    const X = (i) => pad + i * ((W - pad * 2) / (trend.length - 1)), Y = (v) => H - pad - (v / maxT) * (H - pad * 2);
    const pts = trend.map((t, i) => [X(i), Y(t.n)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(0) + ' ' + p[1].toFixed(0)).join(' ');
    const area = line + ` L${X(trend.length - 1).toFixed(0)} ${H - pad} L${X(0).toFixed(0)} ${H - pad} Z`;
    let g = `<defs><linearGradient id="cmpg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8cc63f" stop-opacity=".35"/><stop offset="1" stop-color="#8cc63f" stop-opacity="0"/></linearGradient></defs>`;
    g += `<path d="${area}" fill="url(#cmpg)"/><path d="${line}" fill="none" stroke="#163a28" stroke-width="2.5"/>`;
    pts.forEach((p, i) => {
      const cur = trend[i].ym === curYm;
      g += `<circle cx="${p[0]}" cy="${p[1]}" r="${cur ? 5.5 : 4}" fill="${cur ? '#8cc63f' : '#163a28'}" stroke="${cur ? '#163a28' : 'none'}" stroke-width="2"/>`;
      g += `<text x="${p[0]}" y="${p[1] - 12}" text-anchor="middle" font-size="12" font-weight="700" fill="#163a28">${trend[i].n}</text>`;
      g += `<text x="${p[0]}" y="${H - 12}" text-anchor="middle" font-size="10" fill="#7c8579">${monthLabelRu(trend[i].ym).split(' ')[0]}</text>`;
    });
    const step = (W - pad * 2) / (trend.length - 1);
    trend.forEach((t, i) => {
      g += `<rect class="cmp-tr-hot" data-ym="${t.ym}" x="${(X(i) - step / 2).toFixed(0)}" y="0" width="${step.toFixed(0)}" height="${H}" fill="transparent"/>`;
    });
    const node = svgEl(g, { vb: '0 0 560 220' });
    node.querySelectorAll('[data-ym]').forEach((r) => r.addEventListener('click', () => {
      const ym = r.getAttribute('data-ym');
      drill('Месяц: ' + monthLabelRu(ym), monthRange(ym));
    }));
    return node;
  }

  function typeBars(byType) {
    if (!byType || !byType.length) return el('div', { class: 'cmp-empty' }, 'Нет данных за период.');
    const max = Math.max(...byType.map((t) => t.n));
    return el('div', { class: 'cmp-bars' }, byType.map((t) => {
      const name = lbl('type', t.code);
      return el('div', { class: 'cmp-bar cmp-clk', onclick: () => drill('Тип: ' + name + ' · ' + monthLabelRu(dashMonth), Object.assign({ type: t.code }, monthRange(dashMonth))) }, [
        el('span', { class: 'cmp-bar-nm', title: name }, name),
        el('span', { class: 'cmp-bar-track' }, [el('span', { class: 'cmp-bar-fill', style: `width:${Math.round(t.n / max * 100)}%;${t.code === 'nepolozhili' ? 'background:#ad1457' : ''}` })]),
        el('span', { class: 'cmp-bar-vl' }, String(t.n)),
      ]);
    }));
  }

  function usageBars(byUsage) {
    if (!byUsage || !byUsage.length) return el('div', { class: 'cmp-empty' }, 'Пока нет данных — назначение появится, когда клиенты начнут указывать его в боте.');
    const max = Math.max(...byUsage.map((t) => t.n));
    return el('div', { class: 'cmp-bars' }, byUsage.map((t) => {
      const name = lbl('usage', t.code);
      return el('div', { class: 'cmp-bar cmp-clk', onclick: () => drill('Назначение: ' + name + ' · ' + monthLabelRu(dashMonth), Object.assign({ usage: t.code }, monthRange(dashMonth))) }, [
        el('span', { class: 'cmp-bar-nm', title: name }, name),
        el('span', { class: 'cmp-bar-track' }, [el('span', { class: 'cmp-bar-fill', style: `width:${Math.round(t.n / max * 100)}%` })]),
        el('span', { class: 'cmp-bar-vl' }, String(t.n)),
      ]);
    }));
  }

  function dishBars(byDish) {
    if (!byDish || !byDish.length) return el('div', { class: 'cmp-empty' }, 'Пока нет данных — появится, когда клиенты начнут указывать вид в боте.');
    const max = Math.max(...byDish.map((t) => t.n));
    return el('div', { class: 'cmp-bars' }, byDish.map((t) => {
      const name = lbl('dish_form', t.code);
      return el('div', { class: 'cmp-bar cmp-clk', onclick: () => drill('Финальный вид: ' + name + ' · ' + monthLabelRu(dashMonth), Object.assign({ dish: t.code }, monthRange(dashMonth))) }, [
        el('span', { class: 'cmp-bar-nm', title: name }, name),
        el('span', { class: 'cmp-bar-track' }, [el('span', { class: 'cmp-bar-fill', style: `width:${Math.round(t.n / max * 100)}%` })]),
        el('span', { class: 'cmp-bar-vl' }, String(t.n)),
      ]);
    }));
  }

  // Таблица на дашборде показывает имена, а фильтр работает по id агента SD.
  // Если имени нет среди агентов SD (старый импорт) — оставляем поиск по тексту.
  function agentDrillParam(name) {
    const hit = ((NETS && NETS.agents) || []).find((a) => a.name === name);
    return hit ? { agent: hit.id } : { q: name };
  }

  function agentTable(byAgent) {
    if (!byAgent || !byAgent.length) return el('div', { class: 'cmp-empty' }, 'Нет данных за период.');
    const max = Math.max(...byAgent.map((a) => a.n));
    const body = byAgent.map((a) => el('tr', {
      class: a.name && a.name !== '—' ? 'cmp-clk' : null,
      onclick: a.name && a.name !== '—' ? () => drill('Агент: ' + a.name + ' · ' + monthLabelRu(dashMonth), Object.assign(agentDrillParam(a.name), monthRange(dashMonth))) : null,
    }, [
      el('td', {}, a.name),
      el('td', { class: 'n' }, String(a.n)),
      el('td', {}, [el('span', { class: 'cmp-mini-track' }, [el('span', { class: 'cmp-mini-fill', style: `width:${Math.round(a.n / max * 100)}%` })])]),
    ]));
    return el('table', { class: 't cmp-agent-t' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, 'Агент'), el('th', {}, 'Претензий'), el('th', {}, 'Доля')])),
      el('tbody', {}, body),
    ]);
  }

  // ================= СПИСОК =================
  function listFilterBar() {
    const opt = (arr, val, ph) => [el('option', { value: '' }, ph), ...arr.map((x) => el('option', { value: x.code, selected: val === x.code || null }, x.label_ru))];
    const sel = (key, arr, ph) => el('select', { class: 'cmp-f', onchange: (e) => { listState[key] = e.target.value; loadList(); } }, opt(arr, listState[key], ph));
    // Фильтр по контрагенту (ИНН) → точке — с поиском по первым буквам.
    const netSel = searchSelect(netItems(), listState.inn, 'Все контрагенты', (v) => { listState.inn = v; listState.point = ''; loadList(); });
    const ptSel = searchSelect(pointItems(listState.inn), listState.point, listState.inn ? 'Все точки контрагента' : 'Все точки', (v) => { listState.point = v; loadList(); });
    const agSel = searchSelect(agentItems(), listState.agent, 'Все агенты', (v) => { listState.agent = v; loadList(); });
    return el('div', { class: 'cmp-filters' }, [
      // Период — общим компонентом Hub, как в Кассе: один вид на все плитки.
      HubDateRange.create({
        mode: 'range', from: listState.from, to: listState.to,
        onChange: (v) => { listState.from = v.from; listState.to = v.to; loadList(); },
      }),
      netSel, ptSel, agSel,
      sel('status', DICTS.status, 'Все статусы'),
      sel('link', DICTS.link, 'Все звенья'),
      sel('type', DICTS.type, 'Все типы'),
      sel('severity', DICTS.severity, 'Любая степень'),
      el('input', { type: 'search', class: 'cmp-f cmp-search', placeholder: 'Поиск: продукт, точка, агент…', value: listState.q,
        oninput: (e) => { listState.q = e.target.value; clearTimeout(window.__cmpT); window.__cmpT = setTimeout(loadList, 350); } }),
      el('div', { class: 'cmp-f-actions' }, [
        el('a', { class: 'btn-primary cmp-btn', href: '#', onclick: (e) => { e.preventDefault(); exportXlsx(); } }, '⬇ Excel'),
        isAdmin ? el('button', { class: 'btn-ghost cmp-btn', onclick: importDialog }, '📥 Импорт истории') : null,
      ]),
    ]);
  }
  function countsBar(counts) {
    const map = {}; (counts || []).forEach((c) => (map[c.status] = c.n));
    const order = ['new', 'agent_reacted', 'in_review', 'resolved'];
    return el('div', { class: 'cmp-counts' }, order.map((s) =>
      el('span', { class: 'cmp-count ' + STATUS_CLASS[s] }, [lbl('status', s) + ': ', el('b', {}, String(map[s] || 0))])));
  }
  function row(c, n) {
    return el('div', { class: 'cmp-row', onclick: () => openCard(c.id) }, [
      el('div', { class: 'cmp-c cmp-num' }, n != null ? String(n) : ''),
      el('div', { class: 'cmp-c cmp-date' }, ruDate(c.created_at)),
      el('div', { class: 'cmp-c cmp-prod' }, [el('b', {}, c.product_name || '—'), c.product_category ? el('span', { class: 'cmp-cat' }, c.product_category) : null]),
      el('div', { class: 'cmp-c cmp-type' }, lbl('type', c.complaint_type) || '—'),
      el('div', { class: 'cmp-c' }, c.link_code ? el('span', { class: 'cmp-link ' + (LINK_CLASS[c.link_code] || '') }, lbl('link', c.link_code)) : '—'),
      el('div', { class: 'cmp-c cmp-point' }, c.point_name || c.firm_name || '—'),
      el('div', { class: 'cmp-c' }, c.agent_name || '—'),
      el('div', { class: 'cmp-c' }, c.severity ? el('span', { class: 'cmp-sev cmp-sev-' + c.severity }, lbl('severity', c.severity)) : '—'),
      el('div', { class: 'cmp-c' }, c.media_count ? el('span', { class: 'cmp-media' }, '📎 ' + c.media_count) : ''),
      el('div', { class: 'cmp-c' }, el('span', { class: 'cmp-badge ' + (STATUS_CLASS[c.status] || '') }, lbl('status', c.status))),
    ]);
  }
  function renderList() {
    const c = $('#cmp-content'); c.innerHTML = '';
    c.appendChild(el('div', { id: 'cmp-list-wrap' }));
    loadList();
  }
  async function loadList() {
    const wrap = $('#cmp-list-wrap'); if (!wrap) return;
    await loadNets();
    const params = new URLSearchParams();
    for (const k of ['from', 'to', 'status', 'type', 'link', 'severity', 'q', 'inn', 'point', 'agent']) if (listState[k]) params.set(k, listState[k]);
    let data;
    try { data = await api('/list?' + params.toString()); } catch (e) { toast(e.message, true); return; }
    wrap.innerHTML = '';
    wrap.appendChild(listFilterBar());
    wrap.appendChild(countsBar(data.counts));
    const head = el('div', { class: 'cmp-row cmp-head' }, ['#', 'Дата', 'Продукт', 'Тип жалобы', 'Звено', 'Точка', 'Агент', 'Степень', '', 'Статус'].map((h) => el('div', { class: 'cmp-c' }, h)));
    wrap.appendChild(el('div', { class: 'cmp-list' }, [head, ...data.items.map((c, i) => row(c, i + 1))]));
    if (!data.items.length) wrap.appendChild(el('div', { class: 'cmp-empty' }, 'Претензий по фильтру нет. Если база пустая — откройте «Импорт истории» или дождитесь подачи из бота.'));
  }

  async function openCard(id) {
    let d;
    try { d = await api('/one/' + id); } catch (e) { return toast(e.message, true); }
    const c = d.complaint;
    const field = (label, val) => el('div', { class: 'cmp-fld' }, [el('span', { class: 'cmp-fld-l' }, label), el('span', { class: 'cmp-fld-v' }, val || '—')]);
    const media = el('div', { class: 'cmp-media-grid' }, (d.files || []).map((f) => {
      if (!f.url) return el('div', { class: 'cmp-media-x' }, '📎 ' + (f.kind || 'файл'));
      if (f.kind === 'photo') return el('a', { href: f.url, target: '_blank' }, [el('img', { src: f.url, class: 'cmp-thumb' })]);
      return el('video', { src: f.url, class: 'cmp-thumb', controls: true });
    }));
    const left = el('div', { class: 'cmp-card-left' }, [
      field('Дата обращения', ruDateTime(c.created_at)),
      field('Точка', c.point_name || c.firm_name),
      field('Агент', c.agent_name),
      field('Продукт', (c.product_name || '') + (c.product_category ? ' · ' + c.product_category : '')),
      field('Тип жалобы', lbl('type', c.complaint_type)),
      field('Звено', lbl('link', c.link_code)),
      c.product_usage ? field('Назначение', lbl('usage', c.product_usage)) : null,
      c.dish_form ? field('Финальный вид', lbl('dish_form', c.dish_form)) : null,
      field('Дата отгрузки', c.ship_date ? ruDate(c.ship_date) : '—'),
      field('Объём', c.volume_text),
      (c.storage_place || c.storage_temp != null || c.open_hours != null)
        ? field('Хранение', [c.storage_place, c.storage_temp != null ? c.storage_temp + '°C' : null, c.open_hours != null ? c.open_hours + ' ч открыт' : null].filter(Boolean).join(' · ')) : null,
      c.client_comment ? field('Комментарий клиента', c.client_comment) : null,
      c.agent_reacted_at ? field('Реакция агента', ruDateTime(c.agent_reacted_at) + (c.agent_resolution ? ' · ' + lbl('resolution', c.agent_resolution) : '') + (c.agent_comment ? ' · ' + c.agent_comment : '')) : null,
      media.children.length ? el('div', { class: 'cmp-fld' }, [el('span', { class: 'cmp-fld-l' }, 'Медиа'), media]) : null,
    ]);
    const selOf = (kind, cur, ph) => el('select', { class: 'cmp-edit' }, [el('option', { value: '' }, ph), ...(DICTS[kind] || []).map((x) => el('option', { value: x.code, selected: cur === x.code || null }, x.label_ru))]);
    const sevSel = selOf('severity', c.severity, '— степень —');
    const resSel = selOf('resolution', c.resolution, '— решение —');
    const statSel = el('select', { class: 'cmp-edit' }, DICTS.status.map((x) => el('option', { value: x.code, selected: c.status === x.code || null }, x.label_ru)));
    const note = el('textarea', { class: 'cmp-edit cmp-note', rows: 4, placeholder: 'Внутреннее примечание…' }, c.internal_note || '');
    const right = el('div', { class: 'cmp-card-right' }, [
      el('h4', {}, 'Обработка'),
      el('label', {}, 'Степень'), sevSel, el('label', {}, 'Решение'), resSel,
      el('label', {}, 'Статус'), statSel, el('label', {}, 'Примечание'), note,
    ]);
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        await api('/one/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ severity: sevSel.value, resolution: resSel.value, status: statSel.value, internal_note: note.value }) });
        toast('Сохранено'); m.close(); loadList();
      } catch (e) { toast(e.message, true); }
    } }, 'Сохранить');
    const actions = [];
    if (canManage) {
      actions.push(el('button', { class: 'btn-ghost cmp-del-btn', onclick: async () => {
        if (!confirm('Удалить претензию #' + c.id + ' безвозвратно? Фото и видео тоже удалятся.')) return;
        try { await api('/one/' + id + '/delete', { method: 'POST' }); toast('Претензия удалена'); m.close(); loadList(); }
        catch (e) { toast(e.message, true); }
      } }, '🗑 Удалить претензию'));
    }
    actions.push(save);
    const m = modal('Претензия #' + c.id, el('div', { class: 'cmp-card' }, [left, right]), actions);
  }

  function exportXlsx() {
    const p = new URLSearchParams();
    for (const k of ['from', 'to', 'status', 'type', 'link', 'severity', 'q', 'inn', 'point', 'agent']) if (listState[k]) p.set(k, listState[k]);
    window.location = '/complaints/api/export.xlsx' + (p.toString() ? '?' + p.toString() : '');
  }

  function importDialog() {
    const inp = el('input', { type: 'file', accept: '.xlsx,.xls', class: 'cmp-edit' });
    const info = el('div', { class: 'cmp-imp-info' }, 'Загрузите файл с вкладкой «претензии» (например 101.xlsx). Прошлый импорт будет заменён.');
    const out = el('div', { class: 'cmp-imp-out' });
    const go = el('button', { class: 'btn-primary', onclick: async () => {
      if (!inp.files[0]) return toast('Выберите файл', true);
      const fd = new FormData(); fd.append('file', inp.files[0]);
      go.disabled = true; go.textContent = 'Импорт…';
      try {
        const r = await api('/import', { method: 'POST', body: fd });
        out.innerHTML = '';
        out.appendChild(el('div', { class: 'cmp-ok' }, '✅ Загружено строк: ' + r.inserted));
        if (r.unmatchedTypes && r.unmatchedTypes.length) out.appendChild(el('div', { class: 'cmp-warn' }, 'Не распознаны типы: ' + r.unmatchedTypes.join(', ')));
        toast('Импорт завершён'); loadList();
      } catch (e) { toast(e.message, true); }
      go.disabled = false; go.textContent = 'Загрузить';
    } }, 'Загрузить');
    modal('Импорт истории претензий', el('div', { class: 'cmp-imp' }, [info, inp, out]), [go]);
  }

  // ================= СПРАВОЧНИК (настройки) =================
  async function refreshDicts() { try { DICTS = await api('/dicts'); } catch (_) {} }

  async function renderSettings() {
    const c = $('#cmp-content'); c.innerHTML = '<div class="cmp-loading">Загрузка…</div>';
    let data;
    try { data = await api('/dicts/all'); } catch (e) { c.innerHTML = ''; c.appendChild(el('div', { class: 'cmp-empty' }, 'Не удалось загрузить: ' + e.message)); return; }
    const byKind = {}; data.items.forEach((it) => { (byKind[it.kind] = byKind[it.kind] || []).push(it); });
    const links = (byKind.link || []).filter((x) => x.active);
    c.innerHTML = '';
    c.appendChild(el('div', { class: 'cmp-set-intro' }, [
      el('h2', { class: 'cmp-h2' }, 'Справочник претензий'),
      el('p', { class: 'cmp-hint' }, 'Меняйте названия, порядок и доступность пунктов. Бот подхватит изменения за пару минут. Технический код пункта не показываем — он сохраняется, история не ломается.'),
    ]));
    const act = (arr) => (arr || []).filter((x) => x.active);
    c.appendChild(settingsSection('Типы жалоб', 'type', act(byKind.type), links, 'У каждого типа есть «звено» — на чью зону указывает косяк.'));
    c.appendChild(settingsSection('Степень проблемы', 'severity', act(byKind.severity), null));
    c.appendChild(settingsSection('Назначение продукта', 'usage', act(byKind.usage), null, 'Для чего используется продукт. Заполните под себя — список пока пустой.'));
    c.appendChild(settingsSection('Финальный вид в блюде', 'dish_form', act(byKind.dish_form), null, 'Каким был продукт в блюде: цельный лист, нарезка, пюре…'));
  }

  function settingsSection(title, kind, items, links, hint) {
    const list = el('div', { class: 'cmp-set-list' });
    items.sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
    if (!items.length) list.appendChild(el('div', { class: 'cmp-set-empty' }, 'Пока пусто — добавьте первый пункт.'));
    items.forEach((it) => list.appendChild(dictRow(kind, it, links)));
    const addBtn = el('button', { class: 'btn-ghost cmp-btn', onclick: () => {
      const empty = list.querySelector('.cmp-set-empty'); if (empty) empty.remove();
      list.appendChild(dictRow(kind, null, links));
    } }, '+ Добавить пункт');
    return el('div', { class: 'cmp-panel cmp-set-panel' }, [
      el('h3', {}, title), hint ? el('p', { class: 'cmp-hint' }, hint) : null, list, el('div', { class: 'cmp-set-add' }, [addBtn]),
    ]);
  }

  function dictRow(kind, it, links) {
    const isNew = !it;
    const labelInp = el('input', { class: 'cmp-edit cmp-set-lbl', value: it ? it.label_ru : '', placeholder: 'Название пункта' });
    const sortInp = el('input', { class: 'cmp-edit cmp-set-sort', type: 'number', value: it ? it.sort_order : 0, title: 'Порядок' });
    let linkSel = null;
    if (kind === 'type') {
      linkSel = el('select', { class: 'cmp-edit cmp-set-link' }, [
        el('option', { value: '' }, '— звено —'),
        ...(links || []).map((l) => el('option', { value: l.code, selected: (it && it.link_code === l.code) || null }, l.label_ru)),
      ]);
    }
    const row = el('div', { class: 'cmp-set-row' });
    const flash = () => { row.classList.add('saved'); setTimeout(() => row.classList.remove('saved'), 700); };

    // Существующий пункт: правки сохраняются сами при уходе из поля.
    async function autosave() {
      const label = labelInp.value.trim();
      if (!label) return; // пустое имя не сохраняем
      const payload = { label_ru: label, sort_order: parseInt(sortInp.value) || 0 };
      if (kind === 'type') payload.link_code = linkSel.value || null;
      try { await api('/dict/' + it.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); flash(); await refreshDicts(); }
      catch (e) { toast(e.message, true); }
    }
    if (!isNew) {
      labelInp.addEventListener('change', autosave);
      sortInp.addEventListener('change', autosave);
      if (linkSel) linkSel.addEventListener('change', autosave);
    }

    const cells = [labelInp];
    if (linkSel) cells.push(linkSel);
    cells.push(sortInp);

    if (isNew) {
      const addBtn = el('button', { class: 'btn-primary cmp-set-save', onclick: async () => {
        const label = labelInp.value.trim();
        if (!label) return toast('Введите название', true);
        const payload = { kind, label_ru: label, sort_order: parseInt(sortInp.value) || 0 };
        if (kind === 'type') payload.link_code = linkSel.value || null;
        addBtn.disabled = true;
        try { await api('/dict', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); toast('Добавлено'); await refreshDicts(); renderSettings(); }
        catch (e) { toast(e.message, true); addBtn.disabled = false; }
      } }, 'Добавить');
      cells.push(addBtn);
    } else {
      const delBtn = el('button', { class: 'cmp-set-del', title: 'Удалить пункт', onclick: async () => {
        if (!confirm('Удалить пункт «' + it.label_ru + '»?')) return;
        try {
          const r = await api('/dict/' + it.id + '/delete', { method: 'POST' });
          toast(r.soft ? 'Пункт использовался в претензиях — скрыт, история сохранена' : 'Удалено');
          await refreshDicts(); renderSettings();
        } catch (e) { toast(e.message, true); }
      } }, '🗑');
      cells.push(delBtn);
    }
    cells.forEach((x) => row.appendChild(x));
    return row;
  }

  (async function init() {
    try { DICTS = await api('/dicts'); } catch (e) { return toast('Не удалось загрузить справочник: ' + e.message, true); }
    render();
  })();
})();
