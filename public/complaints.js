// complaints.js — SPA блока «Претензии»: список, фильтры, карточка, обработка, выгрузка, импорт.
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

  let DICTS = null;
  const lbl = (kind, code) => { const a = (DICTS && DICTS[kind]) || []; const f = a.find((x) => x.code === code); return f ? f.label_ru : (code || ''); };

  const state = { from: '', to: '', status: '', type: '', link: '', severity: '', q: '' };

  function filterBar() {
    const opt = (arr, val, ph) => [el('option', { value: '' }, ph), ...arr.map((x) => el('option', { value: x.code, selected: val === x.code || null }, x.label_ru))];
    const sel = (key, arr, ph) => el('select', { class: 'cmp-f', onchange: (e) => { state[key] = e.target.value; load(); } }, opt(arr, state[key], ph));
    const dateInp = (key) => el('input', { type: 'date', class: 'cmp-f', value: state[key], onchange: (e) => { state[key] = e.target.value; load(); } });
    return el('div', { class: 'cmp-filters' }, [
      el('div', { class: 'cmp-f-grp' }, [el('label', {}, 'С'), dateInp('from'), el('label', {}, 'по'), dateInp('to')]),
      sel('status', DICTS.status, 'Все статусы'),
      sel('link', DICTS.link, 'Все звенья'),
      sel('type', DICTS.type, 'Все типы'),
      sel('severity', DICTS.severity, 'Любая степень'),
      el('input', { type: 'search', class: 'cmp-f cmp-search', placeholder: 'Поиск: продукт, точка, агент…', value: state.q,
        oninput: (e) => { state.q = e.target.value; clearTimeout(window.__cmpT); window.__cmpT = setTimeout(load, 350); } }),
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

  async function load() {
    const main = $('#cmp-main');
    const params = new URLSearchParams();
    for (const k of ['from', 'to', 'status', 'type', 'link', 'severity', 'q']) if (state[k]) params.set(k, state[k]);
    let data;
    try { data = await api('/list?' + params.toString()); } catch (e) { toast(e.message, true); return; }
    main.innerHTML = '';
    main.appendChild(filterBar());
    main.appendChild(countsBar(data.counts));
    const head = el('div', { class: 'cmp-row cmp-head' }, ['Дата', 'Продукт', 'Тип жалобы', 'Звено', 'Точка', 'Агент', 'Степень', '', 'Статус'].map((h) => el('div', { class: 'cmp-c' }, h)));
    const list = el('div', { class: 'cmp-list' }, [head, ...data.items.map(row)]);
    main.appendChild(list);
    if (!data.items.length) main.appendChild(el('div', { class: 'cmp-empty' }, 'Претензий по фильтру нет. Если база пустая — нажмите «Импорт истории» или дождитесь подачи из бота.'));
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
      c.storage_place || c.storage_temp != null || c.open_hours != null
        ? field('Хранение', [c.storage_place, c.storage_temp != null ? c.storage_temp + '°C' : null, c.open_hours != null ? c.open_hours + ' ч открыт' : null].filter(Boolean).join(' · '))
        : null,
      c.client_comment ? field('Комментарий клиента', c.client_comment) : null,
      c.agent_reacted_at ? field('Реакция агента', ruDateTime(c.agent_reacted_at) + (c.agent_resolution ? ' · ' + lbl('resolution', c.agent_resolution) : '') + (c.agent_comment ? ' · ' + c.agent_comment : '')) : null,
      media.children.length ? el('div', { class: 'cmp-fld' }, [el('span', { class: 'cmp-fld-l' }, 'Медиа'), media]) : null,
    ]);

    // Форма обработки
    const selOf = (kind, cur, ph) => el('select', { class: 'cmp-edit', id: 'cmp-' + kind }, [el('option', { value: '' }, ph), ...(DICTS[kind] || []).map((x) => el('option', { value: x.code, selected: cur === x.code || null }, x.label_ru))]);
    const sevSel = selOf('severity', c.severity, '— степень —');
    const resSel = selOf('resolution', c.resolution, '— решение —');
    const statSel = el('select', { class: 'cmp-edit', id: 'cmp-status' }, DICTS.status.map((x) => el('option', { value: x.code, selected: c.status === x.code || null }, x.label_ru)));
    const note = el('textarea', { class: 'cmp-edit cmp-note', rows: 4, placeholder: 'Внутреннее примечание…' }, c.internal_note || '');

    const right = el('div', { class: 'cmp-card-right' }, [
      el('h4', {}, 'Обработка'),
      el('label', {}, 'Степень'), sevSel,
      el('label', {}, 'Решение'), resSel,
      el('label', {}, 'Статус'), statSel,
      el('label', {}, 'Примечание'), note,
    ]);

    const save = el('button', { class: 'btn-primary', onclick: async () => {
      try {
        await api('/one/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          severity: sevSel.value, resolution: resSel.value, status: statSel.value, internal_note: note.value }) });
        toast('Сохранено'); m.close(); load();
      } catch (e) { toast(e.message, true); }
    } }, 'Сохранить');

    const m = modal('Претензия #' + c.id, el('div', { class: 'cmp-card' }, [left, right]), [save]);
  }

  function exportXlsx() {
    const params = new URLSearchParams();
    for (const k of ['from', 'to', 'status', 'type', 'link', 'severity', 'q']) if (state[k]) params.set(k, state[k]);
    window.location = '/complaints/api/export.xlsx';
  }

  function importDialog() {
    const inp = el('input', { type: 'file', accept: '.xlsx,.xls', class: 'cmp-edit' });
    const info = el('div', { class: 'cmp-imp-info' }, 'Загрузите файл с вкладкой «претензии» (например 101.xlsx). Прошлый импорт будет заменён новым.');
    const out = el('div', { class: 'cmp-imp-out' });
    const go = el('button', { class: 'btn-primary', onclick: async () => {
      if (!inp.files[0]) return toast('Выберите файл', true);
      const fd = new FormData(); fd.append('file', inp.files[0]);
      go.disabled = true; go.textContent = 'Импорт…';
      try {
        const r = await api('/import', { method: 'POST', body: fd });
        out.innerHTML = '';
        out.appendChild(el('div', { class: 'cmp-ok' }, '✅ Загружено строк: ' + r.inserted));
        if (r.unmatchedTypes && r.unmatchedTypes.length) out.appendChild(el('div', { class: 'cmp-warn' }, 'Не распознаны типы (записаны как есть): ' + r.unmatchedTypes.join(', ')));
        toast('Импорт завершён'); load();
      } catch (e) { toast(e.message, true); }
      go.disabled = false; go.textContent = 'Загрузить';
    } }, 'Загрузить');
    modal('Импорт истории претензий', el('div', { class: 'cmp-imp' }, [info, inp, out]), [go]);
  }

  (async function init() {
    try { DICTS = await api('/dicts'); } catch (e) { return toast('Не удалось загрузить справочник: ' + e.message, true); }
    load();
  })();
})();
