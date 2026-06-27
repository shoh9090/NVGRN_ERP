// complaints.js — SPA блока «Претензии»: вкладки Дашборд (по умолчанию) + Список.
(function () {
  const $ = (s) => document.querySelector(s);
  const isAdmin = !!(window.HUB_USER && window.HUB_USER.isAdmin);
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
  const listState = { from: '', to: '', status: '', type: '', link: '', severity: '', q: '' };
  let dashMonth = null;

  // ---------- Каркас с вкладками ----------
  function shell() {
    const main = $('#cmp-main'); main.innerHTML = '';
    const tab = (id, label) => el('button', { class: 'cmp-tab' + (TAB === id ? ' on' : ''), onclick: () => { TAB = id; render(); } }, label);
    main.appendChild(el('div', { class: 'cmp-tabs' }, [tab('dash', '📊 Дашборд'), tab('list', '📋 Список')]));
    main.appendChild(el('div', { id: 'cmp-content' }));
  }
  function render() { shell(); TAB === 'dash' ? renderDashboard() : renderList(); }

  // ================= ДАШБОРД =================
  async function renderDashboard() {
    const c = $('#cmp-content');
    c.innerHTML = '<div class="cmp-loading">Загрузка…</div>';
    let s;
    try { s = await api('/stats' + (dashMonth ? '?month=' + dashMonth : '')); }
    catch (e) { c.innerHTML = ''; c.appendChild(el('div', { class: 'cmp-empty' }, 'Не удалось загрузить дашборд: ' + e.message)); return; }
    dashMonth = s.month;
    c.innerHTML = '';

    const monthSel = el('select', { class: 'cmp-f', onchange: (e) => { dashMonth = e.target.value; renderDashboard(); } },
      s.monthsAvail.map((m) => el('option', { value: m, selected: m === s.month || null }, monthLabelRu(m))));
    c.appendChild(el('div', { class: 'cmp-dash-top' }, [
      el('div', {}, [el('div', { class: 'cmp-eyebrow' }, 'Контроль качества'), el('h2', { class: 'cmp-h2' }, 'Претензии — где течёт')]),
      el('div', { class: 'cmp-month' }, [el('span', {}, 'Месяц:'), monthSel]),
    ]));

    const k = s.kpi;
    c.appendChild(el('div', { class: 'cmp-kpis' }, [
      kpi('Всего за месяц', String(k.total), delta(k.totalDelta) + ' к ' + s.prevLabel),
      kpi('живность', String(k.zhivnost), 'биоугроза · ' + delta(k.zhivnostDelta), true),
      kpi('Главное звено', k.topLink ? lbl('link', k.topLink.code) : '—', k.topLink ? k.topLink.n + ' претензий' : '', false, true),
      kpi('Проблемный продукт', k.topProduct ? k.topProduct.name : '—', k.topProduct ? k.topProduct.n + ' претензий' : '', false, true),
    ]));

    const row1 = el('div', { class: 'cmp-grid cmp-grid-2' });
    row1.appendChild(panel('Матрица: продукт × месяц', 'Чем краснее — тем больше косяков. Видно, где и когда.', heatmap(s.matrix)));
    row1.appendChild(panel('По звеньям', 'Куда указывает тип жалобы.', donutBlock(s.byLink)));
    c.appendChild(row1);

    const row2 = el('div', { class: 'cmp-grid cmp-grid-2' });
    row2.appendChild(panel('Динамика по месяцам', 'Сравнение из месяца в месяц.', trendChart(s.trend, s.month)));
    row2.appendChild(panel('Топ типов жалоб', '«Неположили» — это комплектация, не качество.', typeBars(s.byType)));
    c.appendChild(row2);

    c.appendChild(panel('По агентам', 'В живой версии — имена из SalesDoctor и скорость реакции.', agentTable(s.byAgent), true));
  }

  function delta(d) { if (d == null) return ''; const up = d > 0; const arr = d === 0 ? '→' : up ? '↑' : '↓'; return `${arr} ${Math.abs(d)}%`; }

  function kpi(lab, num, sub, alert, small) {
    return el('div', { class: 'cmp-kpi' + (alert ? ' alert' : '') }, [
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
      ...r.vals.map((v) => el('td', { class: 'cmp-hm-cell', style: `background:${color(v)};color:${v / max > 0.62 ? '#fff' : '#26331f'}` }, v ? String(v) : '')),
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
      el('div', { class: 'cmp-leg-it' }, [
        el('span', { class: 'cmp-leg-dot', style: 'background:' + (LINK_COLOR[z.code] || '#999') }),
        el('span', { class: 'cmp-leg-nm' }, lbl('link', z.code)),
        el('span', { class: 'cmp-leg-vl' }, String(z.n)),
        el('span', { class: 'cmp-leg-pc' }, Math.round(z.n / tot * 100) + '%'),
      ])));
    return el('div', {}, [donut, leg]);
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
    return svgEl(g, { vb: '0 0 560 220' });
  }

  function typeBars(byType) {
    if (!byType || !byType.length) return el('div', { class: 'cmp-empty' }, 'Нет данных за период.');
    const max = Math.max(...byType.map((t) => t.n));
    return el('div', { class: 'cmp-bars' }, byType.map((t) => {
      const name = lbl('type', t.code);
      return el('div', { class: 'cmp-bar' }, [
        el('span', { class: 'cmp-bar-nm', title: name }, name),
        el('span', { class: 'cmp-bar-track' }, [el('span', { class: 'cmp-bar-fill', style: `width:${Math.round(t.n / max * 100)}%;${t.code === 'nepolozhili' ? 'background:#ad1457' : ''}` })]),
        el('span', { class: 'cmp-bar-vl' }, String(t.n)),
      ]);
    }));
  }

  function agentTable(byAgent) {
    if (!byAgent || !byAgent.length) return el('div', { class: 'cmp-empty' }, 'Нет данных за период.');
    const max = Math.max(...byAgent.map((a) => a.n));
    const body = byAgent.map((a) => el('tr', {}, [
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
    const dateInp = (key) => el('input', { type: 'date', class: 'cmp-f', value: listState[key], onchange: (e) => { listState[key] = e.target.value; loadList(); } });
    return el('div', { class: 'cmp-filters' }, [
      el('div', { class: 'cmp-f-grp' }, [el('label', {}, 'С'), dateInp('from'), el('label', {}, 'по'), dateInp('to')]),
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
  function row(c) {
    return el('div', { class: 'cmp-row', onclick: () => openCard(c.id) }, [
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
    const params = new URLSearchParams();
    for (const k of ['from', 'to', 'status', 'type', 'link', 'severity', 'q']) if (listState[k]) params.set(k, listState[k]);
    let data;
    try { data = await api('/list?' + params.toString()); } catch (e) { toast(e.message, true); return; }
    wrap.innerHTML = '';
    wrap.appendChild(listFilterBar());
    wrap.appendChild(countsBar(data.counts));
    const head = el('div', { class: 'cmp-row cmp-head' }, ['Дата', 'Продукт', 'Тип жалобы', 'Звено', 'Точка', 'Агент', 'Степень', '', 'Статус'].map((h) => el('div', { class: 'cmp-c' }, h)));
    wrap.appendChild(el('div', { class: 'cmp-list' }, [head, ...data.items.map(row)]));
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
    const m = modal('Претензия #' + c.id, el('div', { class: 'cmp-card' }, [left, right]), [save]);
  }

  function exportXlsx() { window.location = '/complaints/api/export.xlsx'; }

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

  (async function init() {
    try { DICTS = await api('/dicts'); } catch (e) { return toast('Не удалось загрузить справочник: ' + e.message, true); }
    render();
  })();
})();
