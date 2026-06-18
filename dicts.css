// dicts.js — одностраничный интерфейс модуля «Справочники»
// Левая панель справочников → живая таблица → боковая карточка записи.

(function () {
  const state = {
    meta: null,
    type: null,
    items: [],
    total: 0,
    page: 1,
    q: '',
    status: 'active',
    sort: 'name',
    order: 'asc',
    refOptions: {}, // кэш вариантов для ref-полей
    editing: null, // запись в карточке (null = закрыто, {} = новая)
    filters: {}, // значения фильтров полей (f_*)
    navOpen: {}, // раскрытые ветки меню
    extraQuery: '', // доп. параметры списка от пункта меню (например origin=local)
    selected: new Set(), // отмеченные галочками записи
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  };

  async function api(path, opts = {}) {
    const res = await fetch('/api/refs' + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
  }

  function toast(msg, isError) {
    const t = el('div', { class: 'toast' + (isError ? ' toast-err' : '') }, msg);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 3500);
  }

  function fieldsOf(typeKey) {
    return state.meta.types[typeKey].fields;
  }

  function listCols(typeKey) {
    return fieldsOf(typeKey).filter((f) => f.listCol);
  }

  async function refOpts(refType, refQuery) {
    const key = refType + '|' + (refQuery || '');
    if (state.refOptions[key]) return state.refOptions[key];
    const data = await api(`/${refType}?limit=1000&status=active&sort=name` + (refQuery ? '&' + refQuery : ''));
    state.refOptions[key] = data.items.map((i) => ({ id: i.id, name: i.name }));
    return state.refOptions[key];
  }

  function refName(refType, id) {
    if (!id) return '';
    for (const [key, opts] of Object.entries(state.refOptions)) {
      if (!key.startsWith(refType + '|')) continue;
      const f = opts.find((o) => o.id === id);
      if (f) return f.name;
    }
    return '#' + id;
  }

  // ---------- Левая панель ----------
  function renderNav() {
    const nav = $('#dict-nav');
    nav.innerHTML = '';
    const search = el('input', {
      class: 'nav-search',
      placeholder: 'Поиск справочника...',
      oninput: (e) => {
        const q = e.target.value.toLowerCase();
        nav.querySelectorAll('.nav-item').forEach((item) => {
          item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      },
    });
    nav.appendChild(search);
    const tree = state.meta.navTree || [];
    for (const g of state.meta.groups) {
      const items = Object.entries(state.meta.types).filter(([, t]) => t.group === g.key && !t.hidden);
      const branches = tree.filter((b) => b.group === g.key);
      if (!items.length && !branches.length && g.key !== 'nomenclature') continue;
      nav.appendChild(el('div', { class: 'nav-group' }, g.label));

      // раскрывающиеся ветки (Сырьё и материалы)
      for (const b of branches) {
        const childKeys = b.children.map((c) => c.type);
        const isInside = childKeys.includes(state.type);
        const open = isInside || state.navOpen[b.title];
        const parent = el('a', {
          class: 'nav-item nav-parent' + (open ? ' open' : ''),
          href: 'javascript:void(0)',
          onclick: () => { state.navOpen[b.title] = !open; renderNav(); },
        }, [
          el('span', { class: 'nav-icon' }, b.icon + ' '), b.title,
          el('span', { class: 'nav-arrow' }, open ? '▾' : '▸'),
        ]);
        nav.appendChild(parent);
        if (open) {
          for (const c of b.children) {
            const t = state.meta.types[c.type];
            if (!t) continue;
            nav.appendChild(el('a', {
              class: 'nav-item nav-child' + (c.type === state.type ? ' active' : ''),
              href: '#' + c.type,
            }, [el('span', { class: 'nav-icon' }, t.icon + ' '), c.label || t.label]));
          }
        }
      }

      for (const [key, t] of items) {
        nav.appendChild(
          el('a', {
            class: 'nav-item' + (key === state.type ? ' active' : ''),
            href: '#' + key,
          }, [el('span', { class: 'nav-icon' }, t.icon + ' '), t.label])
        );
      }
      if (g.key === 'nomenclature') {
        nav.appendChild(
          el('a', {
            class: 'nav-item' + (state.type === 'prices' ? ' active' : ''),
            href: '#prices',
          }, [el('span', { class: 'nav-icon' }, '💰 '), 'Отпускные цены'])
        );
      }
    }
  }

  // ---------- Таблица ----------
  async function loadList() {
    const params = new URLSearchParams({
      page: state.page,
      status: state.status,
      sort: state.sort,
      order: state.order,
    });
    if (state.q) params.set('q', state.q);
    for (const [k, v] of Object.entries(state.filters)) {
      if (v !== '' && v !== null && v !== undefined) params.set('f_' + k, v);
    }
    const extra = state.extraQuery ? '&' + state.extraQuery : '';
    const data = await api(`/${state.type}?` + params.toString() + extra);
    state.items = data.items;
    state.total = data.total;
    // подгружаем имена для ref-колонок
    for (const f of fieldsOf(state.type)) {
      if (f.type === 'ref') {
        await refOpts(f.ref, '');
        if (f.refQuery) await refOpts(f.ref, f.refQuery);
      }
    }
    renderTable();
  }

  function cellValue(f, row) {
    const v = row[f.key];
    if (f.type === 'bool') return v ? '✓' : '';
    if (f.type === 'color') { const sp = el('span', { style: 'display:inline-block;width:16px;height:16px;border-radius:4px;vertical-align:middle;border:1px solid #0002;background:' + (v || '#ccc') }); return sp; }
    if (f.type === 'ref') return refName(f.ref, v);
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function renderTable() {
    const t = state.meta.types[state.type];
    $('#dict-title').textContent = t.icon + ' ' + t.label;
    $('#dict-count').textContent = state.total + ' зап.';

    const cols = listCols(state.type);
    const ro = state.meta.types[state.type] && state.meta.types[state.type].readonly;
    const headCheck = el('input', {
      type: 'checkbox',
      onclick: (e) => {
        e.stopPropagation();
        if (e.target.checked) state.items.forEach((r) => state.selected.add(r.id));
        else state.items.forEach((r) => state.selected.delete(r.id));
        renderTable();
      },
    });
    headCheck.checked = state.items.length > 0 && state.items.every((r) => state.selected.has(r.id));
    const thead = el('tr', {}, [
      ro ? null : el('th', { style: 'width:34px' }, headCheck),
      ...cols.map((f) =>
        el(
          'th',
          {
            class: 'sortable' + (state.sort === f.key ? ' sorted' : ''),
            onclick: () => {
              if (state.sort === f.key) state.order = state.order === 'asc' ? 'desc' : 'asc';
              else {
                state.sort = f.key;
                state.order = 'asc';
              }
              loadList();
            },
          },
          f.label + (state.sort === f.key ? (state.order === 'asc' ? ' ↑' : ' ↓') : '')
        )
      ),
      el('th', {}, 'Статус'),
    ]);

    const rows = state.items.map((row) => {
      const cb = el('input', {
        type: 'checkbox',
        onclick: (e) => {
          e.stopPropagation();
          if (e.target.checked) state.selected.add(row.id);
          else state.selected.delete(row.id);
          renderBulkBar();
        },
      });
      cb.checked = state.selected.has(row.id);
      return el(
        'tr',
        {
          class: row.status === 'archived' ? 'row-archived' : '',
          ondblclick: () => openCard(row),
          onclick: () => openCard(row),
        },
        [
          ro ? null : el('td', { onclick: (e) => e.stopPropagation() }, cb),
          ...cols.map((f) => el('td', {}, cellValue(f, row))),
          el('td', {}, el('span', { class: 'status-pill status-' + row.status }, row.status === 'active' ? 'Активный' : 'Архив')),
        ]
      );
    });

    renderBulkBar();
    const table = el('table', { class: 'dict-table' }, [el('thead', {}, thead), el('tbody', {}, rows)]);
    const wrap = $('#dict-table-wrap');
    wrap.innerHTML = '';
    if (!state.items.length) {
      wrap.appendChild(el('p', { class: 'dict-empty' }, 'Записей нет. Нажмите «Создать», чтобы добавить первую.'));
    } else {
      wrap.appendChild(table);
    }

    // пагинация
    const pages = Math.max(1, Math.ceil(state.total / 100));
    const pag = $('#dict-pagination');
    pag.innerHTML = '';
    if (pages > 1) {
      pag.appendChild(
        el('button', { onclick: () => { if (state.page > 1) { state.page--; loadList(); } } }, '←')
      );
      pag.appendChild(el('span', {}, ` стр. ${state.page} из ${pages} `));
      pag.appendChild(
        el('button', { onclick: () => { if (state.page < pages) { state.page++; loadList(); } } }, '→')
      );
    }
  }


  // ---------- Фильтры полей (как в SalesDoctor) ----------
  async function renderFieldFilters() {
    const box = $('#dict-filters');
    box.innerHTML = '';
    if (state.type === 'prices') return;
    const filterables = fieldsOf(state.type).filter((f) => f.filterable && !f.hiddenField);
    for (const f of filterables) {
      const sel = el('select', {
        class: 'dict-filter',
        onchange: (e) => {
          state.filters[f.key] = e.target.value;
          state.page = 1;
          loadList();
        },
      });
      sel.appendChild(el('option', { value: '' }, f.label + ': все'));
      if (f.type === 'enum') {
        for (const o of f.options) sel.appendChild(el('option', { value: o }, o));
      } else if (f.type === 'ref') {
        const opts = await refOpts(f.ref, f.refQuery);
        for (const o of opts) sel.appendChild(el('option', { value: o.id }, o.name));
      } else if (f.dynamic) {
        try {
          const d = await api(`/${state.type}/distinct/${f.key}`);
          for (const v of d.values) sel.appendChild(el('option', { value: v }, v));
        } catch (e) { /* нет значений — пустой фильтр */ }
      }
      sel.value = state.filters[f.key] || '';
      box.appendChild(sel);
    }
  }


  function renderBulkBar() {
    const bar = $('#dict-bulkbar');
    if (!bar) return; // страховка от рассинхрона версий файлов
    const n = state.selected.size;
    if (!n) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
    bar.style.display = '';
    bar.innerHTML = '';
    bar.appendChild(el('span', { class: 'bulk-count' }, 'Выбрано: ' + n));
    bar.appendChild(el('button', {
      onclick: async () => {
        try {
          const r = await api(`/${state.type}/bulk`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'archive', ids: [...state.selected] }),
          });
          toast('В архив: ' + r.done);
          state.selected.clear();
          loadList();
        } catch (e) { toast(e.message, true); }
      },
    }, 'В архив'));
    if (window.HUB_USER && window.HUB_USER.isAdmin) {
      bar.appendChild(el('button', {
        class: 'btn-danger-link', style: 'border:1px solid #e8c7bd;border-radius:11px;padding:8px 16px;text-decoration:none',
        onclick: async () => {
          if (!confirm('Полностью удалить выбранные записи (' + n + ' шт.)?\nЭто действие нельзя отменить.')) return;
          try {
            let r = await api(`/${state.type}/bulk`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'delete', ids: [...state.selected] }),
            });
            if (r.blocked > 0) {
              const force = confirm('Удалено: ' + r.deleted + '. Ещё ' + r.blocked + ' записей используются в связанных данных.\nУдалить их принудительно?');
              if (force) {
                r = await api(`/${state.type}/bulk`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'delete', ids: [...state.selected], force: true }),
                });
              }
            }
            toast('Удалено: ' + r.deleted + (r.blocked ? ', пропущено: ' + r.blocked : ''));
            state.selected.clear();
            loadList();
          } catch (e) { toast(e.message, true); }
        },
      }, 'Удалить выбранные'));
    }
    bar.appendChild(el('button', { onclick: () => { state.selected.clear(); renderTable(); } }, 'Снять выбор'));
  }

  // ---------- Карточка ----------
  async function openCard(row) {
    state.editing = row || {};
    const t = state.meta.types[state.type];
    const isNew = !row || !row.id;
    const panel = $('#dict-card');
    panel.classList.add('open');
    const body = $('#dict-card-body');
    $('#dict-card-title').textContent = isNew ? 'Новая запись — ' + t.label : row.name;
    body.innerHTML = '';

    const ro = !!t.readonly;
    const form = el('form', {
      id: 'card-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!ro) await saveCard();
      },
    });
    if (ro) {
      body.appendChild(el('p', { class: 'card-meta', style: 'margin:0 0 12px' },
        'Раздел синхронизируется из SalesDoctor — изменения вносите в CRM.'));
    }
    if (t.autoCode && isNew) {
      body.appendChild(el('p', { class: 'card-meta', style: 'margin:0 0 12px' },
        'Артикул сформируется автоматически: ' + t.autoCode + ' + код категории + порядковый номер (например ' + t.autoCode + '-BL-001). После создания не меняется.'));
    }

    for (const f of fieldsOf(state.type)) {
      if (f.system || f.hiddenField) continue;
      const val = state.editing[f.key];
      let input;
      if (f.type === 'textarea') {
        input = el('textarea', { name: f.key, rows: 3 });
        input.value = val || '';
      } else if (f.type === 'bool') {
        input = el('input', { type: 'checkbox', name: f.key });
        input.checked = !!val;
      } else if (f.type === 'enum') {
        input = el('select', { name: f.key }, [
          el('option', { value: '' }, '—'),
          ...f.options.map((o) => el('option', { value: o }, o)),
        ]);
        input.value = val || '';
      } else if (f.type === 'color') {
        input = el('input', { name: f.key, type: 'color' });
        input.value = val || '#3f8f3f';
      } else if (f.type === 'ref') {
        const opts = await refOpts(f.ref, f.refQuery);
        input = el('select', { name: f.key }, [
          el('option', { value: '' }, '—'),
          ...opts.map((o) => el('option', { value: o.id }, o.name)),
        ]);
        input.value = val || '';
      } else {
        input = el('input', { name: f.key, type: f.type === 'number' ? 'number' : 'text', step: 'any' });
        input.value = val === null || val === undefined ? '' : val;
        if (f.key === 'code' && (t.autoCode || t.autoCodeFixed)) {
          const admin = window.HUB_USER && window.HUB_USER.isAdmin;
          input.disabled = isNew || !admin;
          if (isNew) input.placeholder = 'формируется автоматически: ' + (t.autoCodeFixed || t.autoCode + '-КОД') + '-№';
          else if (!admin) input.title = 'Номенклатурный код меняет только администратор';
          else input.dataset.codeEditable = '1';
        }
      }
      const label = el('label', { class: 'card-field' + (f.type === 'bool' ? ' card-field-bool' : '') }, [
        el('span', {}, f.label + (f.required ? ' *' : '')),
        input,
      ]);
      form.appendChild(label);
    }

    if (ro) {
      for (const inp of form.querySelectorAll('input, select, textarea')) inp.disabled = true;
    } else {
      form.appendChild(el('button', { type: 'submit', class: 'btn-primary' }, isNew ? 'Создать' : 'Сохранить'));
    }
    body.appendChild(form);

    const actions = el('div', { class: 'card-actions' });
    if (!isNew && !t.readonly) {
      if (row.status === 'active') {
        actions.appendChild(
          el(
            'button',
            {
              class: 'btn-danger-link',
              onclick: async () => {
                if (!confirm('Архивировать запись «' + row.name + '»?')) return;
                await api(`/${state.type}/${row.id}/archive`, { method: 'POST' });
                toast('Запись отправлена в архив');
                closeCard();
                loadList();
              },
            },
            'Архивировать'
          )
        );
      } else {
        actions.appendChild(
          el(
            'button',
            {
              onclick: async () => {
                await api(`/${state.type}/${row.id}/restore`, { method: 'POST' });
                toast('Запись восстановлена');
                closeCard();
                loadList();
              },
            },
            'Восстановить из архива'
          )
        );
      }
      const meta = el('p', { class: 'card-meta' },
        `id ${row.id}` + (row.code_1c ? ` · 1С: ${row.code_1c}` : '') + (row.sd_sd_id ? ` · SD: ${row.sd_sd_id}` : '')
      );
      actions.appendChild(meta);
      if (window.HUB_USER && window.HUB_USER.isAdmin) {
        actions.appendChild(el('button', {
          class: 'btn-danger-link',
          onclick: async () => {
            if (!confirm('Вы собираетесь полностью удалить запись из справочника.\nЭто действие нельзя отменить.\nПродолжить?')) return;
            try {
              let res = await fetch(`/api/refs/${state.type}/${row.id}`, { method: 'DELETE' });
              let data = await res.json().catch(() => ({}));
              if (res.status === 409 && data.error === 'used') {
                const choice = confirm('Эта запись используется в связанных данных: ' + data.usedIn.join('; ') +
                  '.\nУдаление может нарушить историю.\n\nОК — удалить принудительно, Отмена — оставить (можно архивировать).');
                if (!choice) return;
                res = await fetch(`/api/refs/${state.type}/${row.id}?force=1`, { method: 'DELETE' });
                data = await res.json().catch(() => ({}));
              }
              if (!res.ok) throw new Error(data.error || 'Ошибка удаления');
              toast('Запись удалена');
              closeCard();
              loadList();
            } catch (e) { toast(e.message, true); }
          },
        }, 'Удалить навсегда'));
      }
    }
    if (!isNew && t.readonly && row.sd_sd_id) {
      actions.appendChild(el('p', { class: 'card-meta' }, `id ${row.id} · SD: ${row.sd_sd_id}`));
    }
    body.appendChild(actions);
  }

  async function saveCard() {
    const t = state.meta.types[state.type];
    const form = $('#card-form');
    const payload = {};
    for (const f of fieldsOf(state.type)) {
      if (f.system) continue;
      const input = form.elements[f.key];
      if (!input) continue;
      payload[f.key] = f.type === 'bool' ? input.checked : input.value;
    }
    const codeInput = form.elements['code'];
    if (codeInput && codeInput.dataset && codeInput.dataset.codeEditable === '1' && state.editing.id) {
      const oldCode = String(state.editing.code || '');
      if (String(codeInput.value).trim().toUpperCase() !== oldCode.toUpperCase()) {
        const ok = confirm('Вы изменяете номенклатурный код позиции.\nЭто может повлиять на связанные документы, отчёты и интеграции.\nПродолжить?');
        if (!ok) return;
      }
    }
    try {
      const isNew = !state.editing.id;
      if (isNew) {
        await api(`/${state.type}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Запись создана');
      } else {
        await api(`/${state.type}/${state.editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Сохранено');
      }
      delete state.refOptions[state.type]; // обновить кэш ссылок
      closeCard();
      loadList();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function closeCard() {
    state.editing = null;
    $('#dict-card').classList.remove('open');
  }

  function exportExcel() {
    const params = new URLSearchParams({ status: state.status });
    if (state.q) params.set('q', state.q);
    for (const [k, v] of Object.entries(state.filters)) {
      if (v !== '' && v !== null && v !== undefined) params.set('f_' + k, v);
    }
    window.location.href = '/api/refs/' + state.type + '/export?' + params.toString();
  }

  // ---------- Импорт ----------
  async function importFile(file) {
    const wizardTypes = ['raw_materials', 'packaging', 'counterparties'];
    if (!wizardTypes.includes(state.type)) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await api(`/${state.type}/import-simple`, { method: 'POST', body: fd });
        toast(`Импорт: добавлено ${r.added}, пропущено ${r.skipped}`);
        loadList();
      } catch (e) {
        toast(e.message, true);
      }
      return;
    }
    // мастер: предпросмотр → подтверждение
    const fd = new FormData();
    fd.append('file', file);
    let preview;
    try {
      preview = await api(`/${state.type}/import/preview`, { method: 'POST', body: fd });
    } catch (e) {
      toast(e.message, true);
      return;
    }
    showImportPreview(preview);
  }

  function showImportPreview(preview) {
    const old = $('#imp-overlay');
    if (old) old.remove();
    const counts = { create: 0, update: 0, skip: 0 };
    for (const r of preview.rows) counts[r.action]++;
    const overlay = el('div', { id: 'imp-overlay', class: 'imp-overlay' });
    const head = el('div', { class: 'imp-head' }, [
      el('h3', {}, 'Предпросмотр импорта — лист «' + preview.sheet + '»'),
      el('span', { class: 'muted' }, `новых: ${counts.create} · обновится: ${counts.update} · пропустится: ${counts.skip}`),
    ]);
    const table = el('table', { class: 'dict-table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, ''), el('th', {}, 'Наименование'), el('th', {}, 'Код'), el('th', {}, 'Примечание'),
      ])),
      el('tbody', {}, preview.rows.map((r) =>
        el('tr', { class: r.error ? 'imp-err' : r.action === 'update' ? 'imp-upd' : '' }, [
          el('td', {}, r.error ? '✖' : r.action === 'update' ? '↻' : '+'),
          el('td', {}, r.values.name || ''),
          el('td', { class: 'tnum' }, r.values.code || ''),
          el('td', { class: 'muted' }, r.error || r.note || ''),
        ])
      )),
    ]);
    const actions = el('div', { class: 'imp-actions' }, [
      el('button', { onclick: () => overlay.remove() }, 'Отмена'),
      el('button', {
        class: 'btn-primary',
        onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Загружаю...';
          try {
            const r = await api(`/${state.type}/import/commit`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rows: preview.rows }),
            });
            toast(`Импорт: создано ${r.created}, обновлено ${r.updated}, пропущено ${r.skipped}`);
            overlay.remove();
            delete state.refOptions[state.type + '|'];
            loadList();
          } catch (err) {
            toast(err.message, true);
            e.target.disabled = false;
            e.target.textContent = 'Загрузить';
          }
        },
      }, `Загрузить ${counts.create + counts.update} строк`),
    ]);
    const panel = el('div', { class: 'imp-panel' }, [head, el('div', { class: 'imp-body' }, table), actions]);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }


  // ---------- Раздел «Отпускные цены» (матрица как «Прайс-лист» в SD) ----------
  async function renderPricesView() {
    $('#dict-title').textContent = '💰 Отпускные цены';
    const box = $('#dict-filters');
    box.innerHTML = '';
    // фильтр по категории
    try {
      const cats = await api('/categories?limit=1000&status=active&f_kind=' + encodeURIComponent('категория'));
      const sel = el('select', {
        class: 'dict-filter',
        onchange: (e) => { state.filters.category_id = e.target.value; loadPrices(); },
      });
      sel.appendChild(el('option', { value: '' }, 'Категория: все'));
      for (const c of cats.items) sel.appendChild(el('option', { value: c.id }, c.name));
      sel.value = state.filters.category_id || '';
      box.appendChild(sel);
    } catch (e) { /* фильтр не критичен */ }
    // фильтр по типу цены (как в SD): показывает один прайс или все
    try {
      const pts = await api('/price_types?limit=1000&status=active&sort=name');
      const sel = el('select', {
        class: 'dict-filter',
        onchange: (e) => { state.filters.price_type = e.target.value; loadPrices(); },
      });
      sel.appendChild(el('option', { value: '' }, 'Тип цены: все'));
      for (const t of pts.items) sel.appendChild(el('option', { value: t.id }, t.name));
      sel.value = state.filters.price_type || '';
      box.appendChild(sel);
    } catch (e) { /* нет прайсов */ }
    await loadPrices();
  }

  async function loadPrices() {
    const wrap = $('#dict-table-wrap');
    $('#dict-pagination').innerHTML = '';
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.filters.category_id) params.set('category_id', state.filters.category_id);
    const res = await fetch('/api/prices/matrix?' + params.toString());
    const data = await res.json();
    let types = data.types || [];
    const items = data.items || [];
    if (state.filters.price_type) {
      types = types.filter((t) => String(t.id) === String(state.filters.price_type));
    }
    $('#dict-count').textContent = items.length + ' поз. · ' + types.length + ' прайс.';
    wrap.innerHTML = '';
    if (!types.length) {
      wrap.appendChild(el('p', { class: 'dict-empty' }, 'Прайс-листов пока нет. Нажмите «Синхр. SD», чтобы загрузить их из SalesDoctor.'));
      return;
    }
    if (!items.length) {
      wrap.appendChild(el('p', { class: 'dict-empty' }, 'Товары не найдены.'));
      return;
    }
    const fmt = new Intl.NumberFormat('ru-RU');
    const head = el('tr', {}, [
      el('th', {}, 'Наименование'),
      el('th', {}, 'Категория'),
      el('th', {}, 'Штрихкод'),
      ...types.map((t) =>
        el('th', { style: 'text-align:right', title: t.payment_type || '' },
          t.name + (t.payment_type ? ' · ' + t.payment_type : ''))
      ),
    ]);
    const rows = items.map((i) =>
      el('tr', {}, [
        el('td', { style: 'font-weight:700' }, i.name),
        el('td', {}, i.category_name || ''),
        el('td', { class: 'tnum' }, i.barcode || ''),
        ...types.map((t) => {
          const v = i.prices[t.id];
          return el('td', { class: 'tnum', style: 'text-align:right' + (v ? ';font-weight:700' : ';color:var(--ink-faint)') },
            v ? fmt.format(v) : '—');
        }),
      ])
    );
    wrap.appendChild(el('table', { class: 'dict-table' }, [el('thead', {}, head), el('tbody', {}, rows)]));
  }

  async function syncPrices() {
    const btn = $('#dict-sync-prices');
    btn.disabled = true;
    btn.textContent = 'Синхронизация...';
    try {
      const res = await fetch('/api/sd/sync/prices', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Ошибка синхронизации');
      toast('SalesDoctor: ' + data.summary);
      renderPricesView();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ Синхр. SD';
    }
  }

  // ---------- Переключение справочника ----------
  function switchType(typeKey) {
    const isPrices = typeKey === 'prices';
    if (!isPrices && !state.meta.types[typeKey]) typeKey = Object.keys(state.meta.types)[0];
    state.type = typeKey;
    state.page = 1;
    state.q = '';
    const navChild = (state.meta.navTree || [])
      .flatMap((b) => b.children)
      .find((c) => c.type === typeKey);
    state.filters = navChild && navChild.preset ? { ...navChild.preset } : {};
    state.extraQuery = navChild && navChild.query ? navChild.query : '';
    state.selected.clear();
    state.sort = 'name';
    state.order = 'asc';
    $('#dict-search').value = '';
    const ro = !isPrices && state.meta.types[typeKey] && state.meta.types[typeKey].readonly;
    $('#dict-sync-sd').style.display = typeKey === 'finished_goods' ? '' : 'none';
    $('#dict-sync-prices').style.display = isPrices ? '' : 'none';
    $('#dict-create').style.display = isPrices || ro ? 'none' : '';
    $('#dict-import').style.display = isPrices || ro ? 'none' : '';
    $('#dict-export').style.display = isPrices ? 'none' : '';
    $('#dict-recode').style.display =
      (typeKey === 'raw_materials' || typeKey === 'packaging') && window.HUB_USER && window.HUB_USER.isAdmin ? '' : 'none';
    $('#dict-status').style.display = isPrices ? 'none' : '';
    renderNav();
    closeCard();
    if (isPrices) {
      renderPricesView();
    } else {
      renderFieldFilters();
      loadList();
    }
  }

  async function syncSD() {
    const btn = $('#dict-sync-sd');
    btn.disabled = true;
    btn.textContent = 'Синхронизация...';
    try {
      const res = await fetch('/api/sd/sync/finished-goods', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Ошибка синхронизации');
      toast('SalesDoctor: ' + data.summary);
      delete state.refOptions['finished_goods'];
      loadList();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ Синхр. SD';
    }
  }

  // ---------- Инициализация ----------
  async function init() {
    state.meta = await api('/_meta');
    window.addEventListener('hashchange', () => switchType(location.hash.slice(1)));

    let searchTimer;
    $('#dict-search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = e.target.value.trim();
        state.page = 1;
        if (state.type === 'prices') loadPrices();
        else loadList();
      }, 300);
    });
    $('#dict-status').addEventListener('change', (e) => {
      state.status = e.target.value;
      state.page = 1;
      loadList();
    });
    $('#dict-create').addEventListener('click', () => openCard(null));
    $('#dict-card-close').addEventListener('click', closeCard);
    $('#dict-import-input').addEventListener('change', (e) => {
      if (e.target.files[0]) importFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#dict-import').addEventListener('click', () => $('#dict-import-input').click());
    $('#dict-sync-sd').addEventListener('click', syncSD);
    $('#dict-sync-prices').addEventListener('click', syncPrices);
    $('#dict-export').addEventListener('click', exportExcel);
    $('#dict-recode').addEventListener('click', async () => {
      if (!confirm('Перекодировать все старые артикулы (nvXX и пустые) в формат RM-XX-000?\n\nПеред запуском рекомендуется нажать «Экспорт» — это ваша резервная копия со старыми кодами.\nПозиции без категории будут пропущены.')) return;
      const btn = $('#dict-recode');
      btn.disabled = true;
      try {
        const r = await api('/' + state.type + '/recode-legacy', { method: 'POST' });
        toast(`Перекодировано: ${r.recoded}, пропущено: ${r.skipped}`);
        loadList();
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });

    switchType(location.hash.slice(1) || 'raw_materials');
  }

  init().catch((e) => {
    document.body.innerHTML = '<p style="padding:40px">Ошибка загрузки модуля: ' + e.message + '</p>';
  });
})();
