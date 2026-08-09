// Интерфейс плитки «Калькуляция себестоимости».
// Денежные формулы выполняются только сервером. Браузер собирает ввод и
// показывает готовый результат.
(function () {
  const $ = (selector, root) => (root || document).querySelector(selector);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'html') node.innerHTML = value;
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  };

  const money = (value, decimals = 2) => (value === null || value === undefined || Number.isNaN(Number(value)))
    ? '—'
    : Number(value).toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const qty = (value) => (value === null || value === undefined)
    ? '—' : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 6 });
  const pct = (value) => (value === null || value === undefined)
    ? '—' : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + '%';
  const ruDate = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('ru-RU');
  };
  const api = async (path, opts) => {
    const response = await fetch('/calculation/api' + path, opts);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Ошибка сервера');
    return data;
  };
  const post = (path, body, method = 'POST') => api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  let toastTimer = null;
  function toast(message, bad) {
    const old = $('.calc-toast');
    if (old) old.remove();
    const item = el('div', { class: 'calc-toast' + (bad ? ' bad' : '') }, message);
    document.body.appendChild(item);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => item.remove(), 3400);
  }

  let BOOT = null;
  let ALL_GROUPS = [];
  let tab = 'products';
  let PANEL = null;
  let pickerOpen = null;

  const canEdit = () => !!(BOOT && BOOT.rights && BOOT.rights.can_edit);
  const activeGroups = () => (BOOT && BOOT.groups ? BOOT.groups : []).filter((group) => group.status === 'active');
  const groupById = (id) => activeGroups().find((group) => Number(group.id) === Number(id)) || null;

  const TABS = [
    ['matrix', 'Калькуляция'],
    ['products', 'Изделия'],
    ['groups', 'Группы и упаковка'],
    ['models', 'Модели'],
    ['actual', 'Фактическая'],
    ['history', 'История'],
  ];

  async function boot() {
    const main = $('#calc-main');
    main.appendChild(el('div', { class: 'calc-loading' }, [
      el('div', { class: 'calc-skel', style: 'width:260px;margin:0 auto' }),
      el('div', { class: 'calc-skel', style: 'width:420px;margin:8px auto' }),
    ]));
    try {
      BOOT = await api('/bootstrap');
      ALL_GROUPS = BOOT.groups || [];
    } catch (error) {
      main.innerHTML = '';
      main.appendChild(el('div', { class: 'calc-empty' }, 'Не удалось загрузить: ' + error.message));
      return;
    }
    const badge = $('#calc-mode-badge');
    if (badge) {
      const version = BOOT.active_version;
      badge.textContent = version
        ? 'действующая версия №' + version.revision_no + ' · ' + version.period
        : 'утверждённой версии пока нет';
    }
    render();
  }

  async function refreshGroups(includeArchived) {
    const data = await api('/groups' + (includeArchived ? '?status=all' : ''));
    ALL_GROUPS = data.items || [];
    BOOT.groups = ALL_GROUPS.filter((group) => group.status === 'active');
    return ALL_GROUPS;
  }

  function render() {
    const main = $('#calc-main');
    main.innerHTML = '';
    main.appendChild(el('div', { class: 'calc-tabs' }, TABS.map(([id, label]) =>
      el('button', {
        class: 'calc-tab' + (tab === id ? ' on' : ''),
        onclick: () => { tab = id; render(); },
      }, label))));
    const box = el('div', { id: 'calc-content' });
    main.appendChild(box);
    if (tab === 'products') return viewProducts(box);
    if (tab === 'groups') return viewGroups(box);
    return viewSoon(box, tab);
  }

  function viewSoon(box, which) {
    const texts = {
      matrix: ['Матрица себестоимости', 'Здесь каждая группа станет отдельной рабочей вкладкой, а изделия — колонками, как в исходном Excel.', 'Перейти к изделиям'],
      models: ['Модели «что будет, если»', 'Изменения цен и состава будут выполняться здесь, не затрагивая утверждённую калькуляцию.', 'Перейти к изделиям'],
      actual: ['Фактическая калькуляция', 'Расчёт месяца по фактическим ценам Закупа, ФОТ, Кассе и выпуску.', 'Перейти к изделиям'],
      history: ['История версий', 'Утверждённые и фактические снимки с расшифровкой источников.', 'Перейти к изделиям'],
    };
    const [title, text, action] = texts[which] || ['Раздел', '', ''];
    if (which === 'matrix' && activeGroups().length) {
      box.appendChild(groupTabs('', () => {}));
    }
    box.appendChild(el('div', { class: 'calc-empty' }, [
      el('div', { class: 'calc-empty-h' }, title),
      el('div', { class: 'calc-empty-t' }, text),
      el('button', { class: 'calc-btn', onclick: () => { tab = 'products'; render(); } }, action),
    ]));
  }

  function groupTabs(selected, onSelect, showAll = true) {
    const buttons = [];
    if (showAll) buttons.push(el('button', {
      class: 'calc-group-tab' + (selected === '' ? ' on' : ''),
      onclick: () => onSelect(''),
    }, 'Все'));
    activeGroups().forEach((group) => buttons.push(el('button', {
      class: 'calc-group-tab' + (String(selected) === String(group.id) ? ' on' : ''),
      onclick: () => onSelect(String(group.id)),
    }, [group.name, el('span', { class: 'calc-group-count' }, String(group.product_count || 0))])));
    if (showAll) buttons.push(el('button', {
      class: 'calc-group-tab' + (selected === 'none' ? ' on warn' : ''),
      onclick: () => onSelect('none'),
    }, 'Без группы'));
    return el('div', { class: 'calc-group-tabs' }, buttons);
  }

  function groupRuleText(group) {
    if (!group) return '';
    const pack = (group.packaging || []).map((item) => item.name).filter(Boolean).join(', ') || 'упаковка не задана';
    return (group.price_includes_vat === false ? 'цена без НДС, ставка ' : 'цена с НДС, ставка ') + pct(group.vat_rate)
      + ' · ретро ' + pct(group.retro_rate)
      + ' · налог на прибыль ' + pct(group.profit_tax_rate)
      + ' · резерв брака ' + pct(group.waste_reserve_rate)
      + ' · ' + pack;
  }

  // -----------------------------------------------------------------------
  // Изделия
  // -----------------------------------------------------------------------
  const productFilter = { q: '', group: '', status: 'active' };
  let PRODUCTS = [];

  function startProduct() {
    if (!activeGroups().length) {
      tab = 'groups';
      render();
      toast('Сначала создайте группу калькуляции', true);
      return;
    }
    openProduct(null);
  }

  async function viewProducts(box) {
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Изделия'),
        el('div', { class: 'calc-sub' }, 'Выберите рабочую группу как лист Excel. Общие налоги, ретро и упаковка в карточках товаров не повторяются.'),
      ]),
      canEdit() ? el('button', { class: 'calc-btn primary', onclick: startProduct }, '+ Изделие') : null,
    ]));

    box.appendChild(groupTabs(productFilter.group, (value) => {
      productFilter.group = value;
      loadProducts();
      drawSelectedGroupInfo();
    }));
    const groupInfo = el('div', { id: 'calc-selected-group' });
    box.appendChild(groupInfo);

    const search = el('input', {
      type: 'search', placeholder: 'Название или штрих-код…', value: productFilter.q,
      oninput: (event) => {
        productFilter.q = event.target.value;
        clearTimeout(window.__calcSearchTimer);
        window.__calcSearchTimer = setTimeout(loadProducts, 300);
      },
    });
    const status = el('select', { onchange: (event) => { productFilter.status = event.target.value; loadProducts(); } }, [
      el('option', { value: 'active', selected: productFilter.status === 'active' || null }, 'Активные'),
      el('option', { value: 'archived', selected: productFilter.status === 'archived' || null }, 'Архив'),
    ]);
    box.appendChild(el('div', { class: 'calc-filters' }, [search, status]));
    box.appendChild(el('div', { id: 'calc-prod-list' }));
    drawSelectedGroupInfo();
    await loadProducts();
  }

  function drawSelectedGroupInfo() {
    const host = $('#calc-selected-group');
    if (!host) return;
    host.innerHTML = '';
    const group = groupById(productFilter.group);
    if (!group) return;
    host.appendChild(el('div', { class: 'calc-group-info' }, [
      el('div', {}, [
        el('div', { class: 'calc-strong' }, group.name),
        el('div', { class: 'calc-src' }, groupRuleText(group)),
      ]),
      canEdit() ? el('button', { class: 'calc-btn tiny', onclick: () => openGroup(group.id) }, 'Настроить группу') : null,
    ]));
  }

  async function loadProducts() {
    const list = $('#calc-prod-list');
    if (!list) return;
    list.innerHTML = '';
    list.appendChild(el('div', {}, [el('div', { class: 'calc-skel' }), el('div', { class: 'calc-skel' })]));
    const params = new URLSearchParams({ status: productFilter.status });
    if (productFilter.q) params.set('q', productFilter.q);
    if (productFilter.group) params.set('group_id', productFilter.group);
    let data;
    try { data = await api('/products?' + params.toString()); }
    catch (error) {
      list.innerHTML = '';
      list.appendChild(el('div', { class: 'calc-empty' }, 'Ошибка: ' + error.message));
      return;
    }
    PRODUCTS = data.items || [];
    list.innerHTML = '';
    if (!PRODUCTS.length) {
      list.appendChild(el('div', { class: 'calc-empty' }, [
        el('div', { class: 'calc-empty-h' }, 'В этой вкладке изделий пока нет'),
        el('div', { class: 'calc-empty-t' }, productFilter.group === 'none'
          ? 'Откройте изделие и назначьте ему рабочую группу.'
          : 'Создайте изделие: группа сразу подставит упаковку и общие коммерческие условия.'),
        canEdit() && productFilter.status === 'active' ? el('button', { class: 'calc-btn primary', onclick: startProduct }, '+ Изделие') : null,
      ]));
      return;
    }

    const headers = ['Изделие', 'Группа', 'Граммаж', 'Сырьё', 'Упаковка', 'Материалы всего', 'Состояние'];
    const tableHead = el('thead', {}, el('tr', {}, headers.map((header, index) =>
      el('th', { style: index >= 3 && index <= 5 ? 'text-align:right' : '' }, header))));
    const body = el('tbody', {}, PRODUCTS.map((product) => el('tr', {
      class: 'clickable', onclick: () => openProduct(product.id),
    }, [
      el('td', {}, [
        el('div', { class: 'calc-strong' }, product.name),
        el('div', { class: 'calc-src' }, product.barcode || 'без штрих-кода'),
      ]),
      el('td', {}, product.group_name || el('span', { class: 'calc-pill warn' }, 'Без группы')),
      el('td', {}, product.net_weight ? qty(product.net_weight) + ' г' : '—'),
      el('td', { class: 'calc-num' }, product.raw_components ? money(product.raw_cost) : '—'),
      el('td', { class: 'calc-num' }, product.packaging_components ? money(product.packaging_cost) : '—'),
      el('td', { class: 'calc-num calc-strong' }, product.components ? money(product.material_cost) : '—'),
      el('td', {}, productState(product)),
    ])));
    list.appendChild(el('div', { class: 'calc-table-wrap' }, el('table', { class: 'calc-table' }, [tableHead, body])));
    list.appendChild(el('div', { class: 'calc-sub', style: 'margin-top:8px' },
      'Сырьё хранится в изделии. Упаковка наследуется из группы; индивидуальная упаковка показывается как исключение.'));
  }

  function productState(product) {
    if (product.status === 'archived') return el('span', { class: 'calc-pill plain' }, 'Архив');
    if (!product.group_id) return el('span', { class: 'calc-pill warn' }, 'Назначьте группу');
    if (!product.raw_components) return el('span', { class: 'calc-pill warn' }, 'Нет состава сырья');
    if (product.missing_prices) return el('span', { class: 'calc-pill bad' }, 'Нет цены: ' + product.missing_prices);
    return el('span', { class: 'calc-pill ok' }, 'Готово');
  }

  // -----------------------------------------------------------------------
  // Группы и общая упаковка
  // -----------------------------------------------------------------------
  async function viewGroups(box) {
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'calc-head' }, [
      el('div', {}, [
        el('div', { class: 'calc-h2' }, 'Группы и упаковка'),
        el('div', { class: 'calc-sub' }, 'Одна группа — одна рабочая вкладка калькуляции. НДС, ретро, налог, резерв брака и комплект упаковки задаются здесь один раз.'),
      ]),
      canEdit() ? el('button', { class: 'calc-btn primary', onclick: () => openGroup(null) }, '+ Группа') : null,
    ]));
    const list = el('div');
    box.appendChild(list);
    list.appendChild(el('div', {}, [el('div', { class: 'calc-skel' }), el('div', { class: 'calc-skel' })]));
    try { await refreshGroups(true); }
    catch (error) { list.innerHTML = ''; list.appendChild(el('div', { class: 'calc-empty' }, error.message)); return; }
    list.innerHTML = '';
    if (!ALL_GROUPS.length) {
      list.appendChild(el('div', { class: 'calc-empty' }, [
        el('div', { class: 'calc-empty-h' }, 'Групп пока нет'),
        canEdit() ? el('button', { class: 'calc-btn primary', onclick: () => openGroup(null) }, '+ Создать группу') : null,
      ]));
      return;
    }
    const headers = ['Рабочая вкладка', 'Общие условия', 'Упаковка', 'Стоимость упаковки', 'Изделий'];
    const head = el('thead', {}, el('tr', {}, headers.map((header, index) =>
      el('th', { style: index === 3 || index === 4 ? 'text-align:right' : '' }, header))));
    const body = el('tbody', {}, ALL_GROUPS.map((group) => el('tr', {
      class: 'clickable', onclick: () => openGroup(group.id),
    }, [
      el('td', {}, [
        el('div', { class: 'calc-strong' }, group.name),
        group.status === 'archived' ? el('span', { class: 'calc-pill plain' }, 'Архив') : null,
      ]),
      el('td', {}, [
        el('div', {}, (group.price_includes_vat === false ? 'Цена без НДС' : 'Цена с НДС') + ' · ставка ' + pct(group.vat_rate)),
        el('div', { class: 'calc-src' }, 'налог ' + pct(group.profit_tax_rate) + ' · резерв ' + pct(group.waste_reserve_rate)),
      ]),
      el('td', {}, (group.packaging || []).length
        ? (group.packaging || []).map((item) => item.name + ' × ' + qty(item.qty)).join(', ')
        : el('span', { class: 'calc-pill warn' }, 'Не задана')),
      el('td', { class: 'calc-num' }, group.packaging_missing_prices
        ? el('span', { class: 'calc-pill bad' }, 'Нет цены')
        : money(group.packaging_cost)),
      el('td', { class: 'calc-num calc-strong' }, String(group.product_count || 0)),
    ])));
    list.appendChild(el('div', { class: 'calc-table-wrap' }, el('table', { class: 'calc-table' }, [head, body])));
  }

  async function openGroup(id) {
    let group = null;
    if (id) {
      try {
        const groups = await refreshGroups(true);
        group = groups.find((item) => Number(item.id) === Number(id)) || null;
      } catch (error) { return toast(error.message, true); }
    }
    const isNew = !group;
    const readOnly = !canEdit();
    const packaging = (group && group.packaging ? group.packaging : []).map((item) => ({ ...item, qty: Number(item.qty) }));

    const fName = input(group ? group.name : '', { placeholder: 'Например: Розница', disabled: readOnly || null });
    const fIncludes = select([
      { v: 'yes', t: 'Да — цена уже с НДС' },
      { v: 'no', t: 'Нет — НДС сверху' },
    ], group && group.price_includes_vat === false ? 'no' : 'yes', { disabled: readOnly || null });
    const fVat = input(group ? group.vat_rate : 12, { type: 'number', step: '0.01', disabled: readOnly || null });
    const fRetro = input(group ? group.retro_rate : 0, { type: 'number', step: '0.01', disabled: readOnly || null });
    const fTax = input(group ? group.profit_tax_rate : 15, { type: 'number', step: '0.01', disabled: readOnly || null });
    const fWaste = input(group ? group.waste_reserve_rate : 0, { type: 'number', step: '0.01', disabled: readOnly || null });
    const fComment = el('textarea', { rows: 2, placeholder: 'Необязательный комментарий', disabled: readOnly || null }, group ? group.comment || '' : '');

    const passport = el('div', { class: 'calc-block' }, [
      el('div', { class: 'calc-block-h' }, 'Общие условия группы'),
      el('div', { class: 'calc-block-b' }, [
        el('div', { class: 'calc-grid' }, [
          field('Название вкладки *', fName),
          field('Цена включает НДС', fIncludes),
          field('Ставка НДС, %', fVat),
          field('Ретро / бонус, %', fRetro),
          field('Налог на прибыль, %', fTax),
          field('Резерв брака, %', fWaste, 'Один раз для всей группы'),
        ]),
        el('div', { style: 'margin-top:12px' }, field('Комментарий', fComment)),
      ]),
    ]);

    const packHost = el('div');
    const packBlock = el('div', { class: 'calc-block' }, [
      el('div', { class: 'calc-block-h' }, [
        el('span', {}, 'Комплект упаковки на одно изделие'),
        readOnly ? null : el('button', { class: 'calc-btn tiny', onclick: () => addPackaging() }, '+ Добавить'),
      ]),
      el('div', { class: 'calc-block-b' }, [
        el('div', { class: 'calc-recipe-note' }, 'Упаковка собирается из существующей номенклатуры Закупа и автоматически применяется ко всем изделиям этой вкладки.'),
        packHost,
      ]),
    ]);

    function drawPackaging() {
      packHost.innerHTML = '';
      if (!packaging.length) {
        packHost.appendChild(el('div', { class: 'calc-empty compact' }, 'Упаковка группы пока не задана.'));
        return;
      }
      packHost.appendChild(el('div', { class: 'calc-pack-row head' }, [
        el('span', {}, 'Позиция'), el('span', {}, 'Количество'), el('span', {}, 'Последняя цена'), el('span'),
      ]));
      packaging.forEach((item, index) => {
        const amount = input(item.qty, {
          type: 'number', step: 'any', min: '0', disabled: readOnly || null,
          oninput: (event) => { item.qty = Number(event.target.value) || 0; },
        });
        packHost.appendChild(el('div', { class: 'calc-pack-row' }, [
          el('div', {}, [
            el('div', { class: 'calc-rowname' }, item.name || '(позиция удалена)'),
            el('div', { class: 'calc-rowcode' }, [item.code, item.unit].filter(Boolean).join(' · ')),
          ]),
          amount,
          el('div', {}, item.price === null || item.price === undefined
            ? el('span', { class: 'calc-pill bad' }, 'Нет цены')
            : [el('div', { class: 'calc-strong' }, money(item.price) + (item.unit ? ' / ' + item.unit : '')),
              el('div', { class: 'calc-src' }, ruDate(item.price_date))]),
          readOnly ? el('span') : el('button', {
            class: 'calc-rrow-del', title: 'Убрать', onclick: () => { packaging.splice(index, 1); drawPackaging(); },
          }, '🗑'),
        ]));
      });
      if (group && group.packaging_cost !== null && group.packaging_cost !== undefined) {
        packHost.appendChild(el('div', { class: 'calc-group-total' }, [
          el('span', {}, 'Текущая стоимость комплекта'),
          el('strong', {}, group.packaging_missing_prices ? 'Есть позиции без цены' : money(group.packaging_cost) + ' сум'),
        ]));
      }
    }

    function addPackaging() {
      pickNomenclature('packaging', (item) => {
        if (packaging.some((row) => Number(row.item_id) === Number(item.id))) return toast('Эта упаковка уже добавлена', true);
        packaging.push({
          item_id: item.id, name: item.name, code: item.code, unit: item.unit,
          qty: 1, price: item.price, price_date: item.price_date,
        });
        drawPackaging();
      });
    }

    const errorBox = el('div');
    const buttons = [];
    if (!readOnly) buttons.push(el('button', { class: 'calc-btn primary', onclick: async () => {
      errorBox.innerHTML = '';
      if (!fName.value.trim()) return errorBox.appendChild(el('div', { class: 'calc-msg err' }, 'Укажите название группы'));
      const payload = {
        name: fName.value.trim(),
        price_includes_vat: fIncludes.value === 'yes',
        vat_rate: Number(fVat.value) || 0,
        retro_rate: Number(fRetro.value) || 0,
        profit_tax_rate: Number(fTax.value) || 0,
        waste_reserve_rate: Number(fWaste.value) || 0,
        comment: fComment.value,
        packaging: packaging.map((item) => ({ item_id: item.item_id, qty: Number(item.qty), comment: item.comment || '' })),
      };
      try {
        if (isNew) await post('/groups', payload);
        else await post('/groups/' + group.id, payload, 'PATCH');
        await refreshGroups(false).catch(() => {});
        toast('Группа сохранена');
        closePanel(true);
      } catch (error) { errorBox.appendChild(el('div', { class: 'calc-msg err' }, error.message)); }
    } }, isNew ? 'Создать группу' : 'Сохранить'));
    if (group && !readOnly) buttons.unshift(el('button', {
      class: 'calc-btn' + (group.status === 'archived' ? '' : ' danger'),
      onclick: async () => {
        try {
          await post('/groups/' + group.id, { status: group.status === 'archived' ? 'active' : 'archived' }, 'PATCH');
          await refreshGroups(false).catch(() => {});
          toast(group.status === 'archived' ? 'Группа восстановлена' : 'Группа перенесена в архив');
          closePanel(true);
        } catch (error) { toast(error.message, true); }
      },
    }, group.status === 'archived' ? '↩ Вернуть из архива' : '🗄 В архив'));

    openPanel(isNew ? 'Новая группа' : group.name, [errorBox, passport, packBlock], buttons);
    drawPackaging();
  }

  // -----------------------------------------------------------------------
  // Карточка изделия
  // -----------------------------------------------------------------------
  const field = (label, control, hint) => el('div', { class: 'calc-field' }, [
    el('label', {}, [label, control]),
    hint ? el('div', { class: 'calc-hint' }, hint) : null,
  ]);
  const input = (value, attrs = {}) => el('input', Object.assign({
    value: value === null || value === undefined ? '' : String(value),
  }, attrs));
  const select = (options, value, attrs = {}) => el('select', attrs, options.map((option) =>
    el('option', { value: option.v, selected: String(option.v) === String(value) || null }, option.t)));

  function closePanel(reload) {
    if (PANEL) { PANEL.remove(); PANEL = null; }
    document.body.style.overflow = '';
    if (reload) render();
  }

  function openPanel(title, body, footer) {
    closePanel(false);
    const panel = el('div', { class: 'calc-panel' }, [
      el('div', { class: 'calc-panel-head' }, [
        el('div', { class: 'calc-panel-title' }, title),
        el('button', { class: 'calc-x', title: 'Закрыть', onclick: () => closePanel(true) }, '×'),
      ]),
      el('div', { class: 'calc-panel-body' }, body),
      el('div', { class: 'calc-panel-foot' }, footer || []),
    ]);
    const overlay = el('div', {
      class: 'calc-ov', onclick: (event) => { if (event.target === overlay) closePanel(true); },
    }, panel);
    $('#calc-modal-root').appendChild(overlay);
    document.body.style.overflow = 'hidden';
    PANEL = overlay;
  }

  async function openProduct(id) {
    let data = { product: {}, recipe: null, items: [], groups: activeGroups() };
    if (id) {
      try { data = await api('/products/' + id); }
      catch (error) { return toast(error.message, true); }
    }
    const product = data.product || {};
    const recipe = data.recipe || null;
    const isNew = !id;
    const readOnly = !canEdit();
    const recipeBatch = recipe ? Number(recipe.batch_output_qty) || 1 : 1;
    const rawRows = (data.items || []).filter((item) => item.item_kind !== 'packaging').map(normalizeRecipeRow);
    let ownPackaging = (data.items || []).filter((item) => item.item_kind === 'packaging').map(normalizeRecipeRow);

    const fName = input(product.name, { placeholder: 'Например: Латук 100 г', disabled: readOnly || null });
    const fGroup = select(
      [{ v: '', t: '— выберите рабочую группу —' }].concat(activeGroups().map((group) => ({ v: group.id, t: group.name }))),
      product.group_id || '', { disabled: readOnly || null });
    const fBarcode = input(product.barcode, { placeholder: 'необязательно', disabled: readOnly || null });
    const fWeight = input(product.net_weight, { type: 'number', step: '1', min: '0', placeholder: 'например, 100', disabled: readOnly || null });
    const fPrice = input(product.price, { type: 'number', step: '1', min: '0', placeholder: 'сум', disabled: readOnly || null });
    const fComment = el('textarea', { rows: 2, placeholder: 'Необязательный комментарий', disabled: readOnly || null }, product.comment || '');
    const inherited = el('div');

    const passport = el('div', { class: 'calc-block' }, [
      el('div', { class: 'calc-block-h' }, 'Изделие'),
      el('div', { class: 'calc-block-b' }, [
        el('div', { class: 'calc-grid simple' }, [
          field('Название *', fName),
          field('Группа калькуляции *', fGroup),
          field('Штрих-код', fBarcode),
          field('Граммаж, г', fWeight, '100, 250, 500 и т. п.; для пучка или горшка можно не заполнять'),
          field('Цена продажи', fPrice),
        ]),
        inherited,
        el('div', { style: 'margin-top:12px' }, field('Комментарий', fComment)),
      ]),
    ]);

    const rawHost = el('div');
    const packagingHost = el('div');
    const calcHost = el('div');
    const recipeBlock = el('div', { class: 'calc-block' }, [
      el('div', { class: 'calc-block-h' }, [
        el('span', {}, 'Состав продукта'),
        readOnly ? null : el('button', { class: 'calc-btn tiny', onclick: () => addRaw() }, '+ Добавить сырьё'),
      ]),
      el('div', { class: 'calc-block-b' }, [
        recipeBatch !== 1 ? el('div', { class: 'calc-recipe-note' },
          'Эта старая рецептура введена на ' + qty(recipeBatch) + ' единиц. Пересчёт сохранён; новые изделия создаются сразу на одну единицу.') : null,
        rawHost,
        el('div', { class: 'calc-block-h calc-inner-head' }, 'Упаковка группы'),
        packagingHost,
      ]),
    ]);
    const calcBlock = el('div', { class: 'calc-block' }, [
      el('div', { class: 'calc-block-h' }, 'Предварительный расчёт'),
      el('div', { class: 'calc-block-b' }, calcHost),
    ]);

    fGroup.addEventListener('change', () => { drawInherited(); drawPackaging(); scheduleCalc(); });

    function normalizeRecipeRow(item) {
      return {
        item_kind: item.item_kind, item_id: item.item_id, name: item.name, code: item.code, unit: item.unit,
        qty_net: Number(item.qty_net), loss_rate: Number(item.loss_rate), comment: item.comment || '',
        price: item.price, price_date: item.price_date, price_source: item.price_source,
        supplier_name: item.supplier_name, nomenclature_missing: item.nomenclature_missing,
      };
    }

    function selectedGroup() { return groupById(fGroup.value); }

    function drawInherited() {
      inherited.innerHTML = '';
      const group = selectedGroup();
      if (!group) {
        inherited.appendChild(el('div', { class: 'calc-group-inherit warn' }, 'Выберите группу — она подставит НДС, ретро, налог, резерв брака и упаковку.'));
        return;
      }
      inherited.appendChild(el('div', { class: 'calc-group-inherit' }, [
        el('div', { class: 'calc-strong' }, 'Наследуется из «' + group.name + '»'),
        el('div', { class: 'calc-src' }, groupRuleText(group)),
        canEdit() ? el('button', { class: 'calc-btn tiny', onclick: () => openGroup(group.id) }, 'Изменить группу') : null,
      ]));
    }

    function drawRaw() {
      rawHost.innerHTML = '';
      if (!rawRows.length) {
        rawHost.appendChild(el('div', { class: 'calc-empty compact' }, 'Сырьё ещё не добавлено.'));
        scheduleCalc();
        return;
      }
      rawHost.appendChild(el('div', { class: 'calc-rrow head' },
        ['Позиция', 'Количество', 'Потери, %', 'С потерями', 'Цена и источник', 'Стоимость', ''].map((text) => el('span', {}, text))));
      rawRows.forEach((row, index) => rawHost.appendChild(rawRow(row, index)));
      scheduleCalc();
    }

    function rawRow(row, index) {
      const baseUnit = String(row.unit || '').toLowerCase();
      const smallUnit = baseUnit === 'кг' ? 'г' : baseUnit === 'л' ? 'мл' : null;
      const showUnit = row._show_unit || (smallUnit || baseUnit);
      const factor = () => (smallUnit && (row._show_unit || smallUnit) === smallUnit ? 1000 : 1);
      const amount = input(row.qty_net * factor(), {
        type: 'number', step: 'any', class: 'calc-num-in', disabled: readOnly || null,
        oninput: (event) => { row.qty_net = (Number(event.target.value) || 0) / factor(); scheduleCalc(); },
      });
      const unit = smallUnit ? select([
        { v: smallUnit, t: smallUnit }, { v: baseUnit, t: baseUnit },
      ], showUnit, {
        disabled: readOnly || null,
        onchange: (event) => { row._show_unit = event.target.value; drawRaw(); },
      }) : el('span', { class: 'calc-src calc-unit-label' }, row.unit || '—');
      const loss = input(row.loss_rate, {
        type: 'number', step: '0.01', class: 'calc-num-in', disabled: readOnly || null,
        oninput: (event) => { row.loss_rate = Number(event.target.value) || 0; scheduleCalc(); },
      });
      return el('div', { class: 'calc-rrow', 'data-raw-index': String(index) }, [
        el('div', {}, [
          el('div', { class: 'calc-rowname' }, row.name || '(не выбрано)'),
          el('div', { class: 'calc-rowcode' }, [row.code, row.unit].filter(Boolean).join(' · ')),
          row.nomenclature_missing ? el('div', { class: 'calc-err-inline' }, 'Позиции нет в справочнике') : null,
        ]),
        el('div', { class: 'calc-qty-control' }, [amount, unit]),
        loss,
        el('div', { class: 'calc-num calc-cell-qty calc-unit-label' }, '…'),
        el('div', {}, row.price === null || row.price === undefined
          ? el('span', { class: 'calc-pill bad' }, 'Нет закупочной цены')
          : [
              el('div', { class: 'calc-strong' }, money(row.price) + (row.unit ? ' / ' + row.unit : '')),
              el('div', { class: 'calc-src' }, ['Закуп', ruDate(row.price_date), row.supplier_name].filter(Boolean).join(' · ')),
            ]),
        el('div', { class: 'calc-num calc-strong calc-cell-cost calc-unit-label' }, '…'),
        readOnly ? el('span') : el('button', {
          class: 'calc-rrow-del', title: 'Убрать', onclick: () => { rawRows.splice(index, 1); drawRaw(); },
        }, '🗑'),
      ]);
    }

    function addRaw() {
      pickNomenclature('raw', (item) => {
        if (rawRows.some((row) => Number(row.item_id) === Number(item.id))) return toast('Это сырьё уже добавлено', true);
        rawRows.push({
          item_kind: 'raw', item_id: item.id, name: item.name, code: item.code, unit: item.unit,
          qty_net: 0, loss_rate: 0, comment: '', price: item.price,
          price_date: item.price_date, price_source: item.price_source,
        });
        drawRaw();
      });
    }

    function drawPackaging() {
      packagingHost.innerHTML = '';
      if (ownPackaging.length) {
        packagingHost.appendChild(el('div', { class: 'calc-msg warn' },
          'У изделия сохранена индивидуальная упаковка из прежней версии. Она используется вместо упаковки группы.'));
        ownPackaging.forEach((item) => packagingHost.appendChild(el('div', { class: 'calc-pack-read' }, [
          el('span', {}, item.name + ' × ' + qty(item.qty_net / recipeBatch) + (item.unit ? ' ' + item.unit : '')),
          item.price === null || item.price === undefined ? el('span', { class: 'calc-pill bad' }, 'Нет цены') : el('strong', {}, money(item.price)),
        ])));
        if (!readOnly) packagingHost.appendChild(el('button', {
          class: 'calc-btn tiny', onclick: () => { ownPackaging = []; drawPackaging(); scheduleCalc(); },
        }, 'Использовать упаковку группы'));
        return;
      }
      const group = selectedGroup();
      if (!group) return packagingHost.appendChild(el('div', { class: 'calc-empty compact' }, 'Сначала выберите группу.'));
      if (!(group.packaging || []).length) {
        packagingHost.appendChild(el('div', { class: 'calc-empty compact' }, [
          'У группы не задан комплект упаковки.',
          canEdit() ? el('button', { class: 'calc-btn tiny', onclick: () => openGroup(group.id) }, 'Настроить') : null,
        ]));
        return;
      }
      (group.packaging || []).forEach((item) => packagingHost.appendChild(el('div', { class: 'calc-pack-read' }, [
        el('span', {}, item.name + ' × ' + qty(item.qty) + (item.unit ? ' ' + item.unit : '')),
        item.price === null || item.price === undefined
          ? el('span', { class: 'calc-pill bad' }, 'Нет цены')
          : el('strong', {}, money(item.line_cost) + ' сум'),
      ])));
      packagingHost.appendChild(el('div', { class: 'calc-src', style: 'margin-top:7px' }, 'Источник: группа «' + group.name + '»'));
    }

    let calcTimer = null;
    function scheduleCalc() {
      clearTimeout(calcTimer);
      calcTimer = setTimeout(runCalc, 350);
    }

    async function runCalc() {
      const usable = rawRows.filter((row) => row.item_id && Number(row.qty_net) > 0);
      if (!fGroup.value || !usable.length) {
        calcHost.innerHTML = '';
        calcHost.appendChild(el('div', { class: 'calc-sub', style: 'margin:0' },
          !fGroup.value ? 'Выберите группу калькуляции.' : 'Добавьте сырьё и укажите количество.'));
        return;
      }
      calcHost.innerHTML = '';
      calcHost.appendChild(el('div', { class: 'calc-skel', style: 'width:65%' }));
      try {
        const result = await post('/calculate', {
          period: BOOT.period ? BOOT.period.period : undefined,
          group_id: Number(fGroup.value),
          batch_output_qty: recipeBatch,
          use_group_packaging: !ownPackaging.length,
          items: usable.concat(ownPackaging).map((row) => ({
            item_kind: row.item_kind, item_id: row.item_id, qty_net: row.qty_net, loss_rate: row.loss_rate,
          })),
          commercial: { price: Number(fPrice.value) || 0 },
        });
        fillRawResults(result.result.rows || []);
        drawCalculation(result);
      } catch (error) {
        calcHost.innerHTML = '';
        calcHost.appendChild(el('div', { class: 'calc-msg err' }, error.message));
      }
    }

    function fillRawResults(serverRows) {
      const rows = serverRows.filter((row) => row.item_kind === 'raw');
      rawRows.filter((row) => row.item_id && Number(row.qty_net) > 0).forEach((row, index) => {
        const result = rows[index];
        const host = rawHost.querySelector('[data-raw-index="' + rawRows.indexOf(row) + '"]');
        if (!result || !host) return;
        const amount = $('.calc-cell-qty', host);
        const cost = $('.calc-cell-cost', host);
        if (amount) amount.textContent = qty(result.qty_with_loss);
        if (cost) cost.textContent = result.cost === null || result.cost === undefined ? '—' : money(result.cost);
      });
    }

    function drawCalculation(data) {
      const result = data.result;
      const layers = result.layers;
      const commercial = result.commercial;
      calcHost.innerHTML = '';
      const messages = el('div', { class: 'calc-msgs' });
      (result.errors || []).forEach((item) => messages.appendChild(el('div', { class: 'calc-msg err' }, '⛔ ' + item.message)));
      (result.warnings || []).forEach((item) => messages.appendChild(el('div', { class: 'calc-msg warn' }, '⚠️ ' + item.message)));
      ((data.sources && data.sources.warnings) || []).forEach((item) => messages.appendChild(el('div', { class: 'calc-msg warn' }, '⚠️ ' + item.message)));
      if (messages.children.length) calcHost.appendChild(messages);
      const card = (label, value, cls, source) => el('div', { class: 'calc-sum-card' + (cls ? ' ' + cls : '') }, [
        el('div', { class: 'calc-sum-lbl' }, label),
        el('div', { class: 'calc-sum-val' }, value),
        source ? el('div', { class: 'calc-src' }, source) : null,
      ]);
      calcHost.appendChild(el('div', { class: 'calc-sum' }, [
        card('Сырьё', money(layers.raw)),
        card('Упаковка', money(layers.packaging), null, data.group ? data.group.name : null),
        card('ФОТ с налогами', layers.fot_per_unit ? money(layers.fot_per_unit) : '—', null, 'Персонал · ' + data.period),
        card('Производственные', money(layers.production_per_unit), null, 'Касса · ' + data.period),
        card('Полная себестоимость', money(layers.full_cost), 'accent', 'резерв брака ' + pct(layers.waste_reserve_rate)),
      ]));
      calcHost.appendChild(el('div', { class: 'calc-sum', style: 'margin-top:10px' }, [
        card('Цена', money(commercial.price)),
        card('Ретро', money(commercial.retro), null, data.group ? pct(data.group.retro_rate) : null),
        card('НДС', money(commercial.vat), null, data.group ? pct(data.group.vat_rate) : null),
        card('Прибыль до налога', money(commercial.profit_before_tax), commercial.profit_before_tax < 0 ? 'bad' : null),
        card('Налог на прибыль', money(commercial.profit_tax), null, data.group ? pct(data.group.profit_tax_rate) : null),
        card('Чистая прибыль', money(commercial.net_profit), commercial.net_profit < 0 ? 'bad' : null),
        card('Чистая маржа', commercial.net_margin === null ? '—' : pct(commercial.net_margin), commercial.net_margin !== null && commercial.net_margin < 0 ? 'bad' : null),
      ]));
      const output = data.sources && data.sources.output;
      calcHost.appendChild(el('div', { class: 'calc-sub', style: 'margin-top:10px' },
        output && output.total
          ? 'ФОТ и общие расходы распределены на ' + qty(output.total) + ' произведённых единиц.'
          : 'Для добавления ФОТ и общих расходов заполните выпуск периода.'));
    }

    const errorBox = el('div');
    const buttons = [];
    if (!readOnly) buttons.push(el('button', { class: 'calc-btn primary', onclick: async () => {
      errorBox.innerHTML = '';
      if (!fName.value.trim()) return errorBox.appendChild(el('div', { class: 'calc-msg err' }, 'Укажите название изделия'));
      if (!fGroup.value) return errorBox.appendChild(el('div', { class: 'calc-msg err' }, 'Выберите группу калькуляции'));
      const payload = {
        name: fName.value.trim(), group_id: Number(fGroup.value), barcode: fBarcode.value.trim(),
        net_weight: fWeight.value === '' ? null : Number(fWeight.value),
        price: fPrice.value === '' ? null : Number(fPrice.value), comment: fComment.value,
      };
      try {
        let productId = id;
        if (isNew) {
          const created = await post('/products', { ...payload, batch_output_qty: 1 });
          productId = created.id;
        } else await post('/products/' + id, payload, 'PATCH');
        let recipeId = recipe ? recipe.id : null;
        if (!recipeId) recipeId = (await post('/recipes', { product_id: productId })).id;
        await post('/recipes/' + recipeId, {
          batch_output_qty: recipeBatch,
          items: rawRows.concat(ownPackaging).filter((row) => row.item_id).map((row) => ({
            item_kind: row.item_kind, item_id: row.item_id, qty_net: row.qty_net,
            loss_rate: row.loss_rate, comment: row.comment || '',
          })),
        }, 'PATCH');
        await refreshGroups(false).catch(() => {});
        toast('Изделие сохранено');
        closePanel(true);
      } catch (error) { errorBox.appendChild(el('div', { class: 'calc-msg err' }, error.message)); }
    } }, isNew ? 'Создать изделие' : 'Сохранить'));

    if (!isNew && !readOnly) {
      buttons.unshift(el('button', { class: 'calc-btn', onclick: async () => {
        try {
          const copy = await post('/products/' + id + '/copy', {});
          await refreshGroups(false).catch(() => {});
          toast('Изделие скопировано');
          closePanel(false);
          openProduct(copy.id);
        } catch (error) { toast(error.message, true); }
      } }, '⧉ Копировать'));
      buttons.unshift(el('button', {
        class: 'calc-btn' + (product.status === 'archived' ? '' : ' danger'),
        onclick: async () => {
          try {
            const archived = product.status !== 'archived';
            await post('/products/' + id, { status: archived ? 'archived' : 'active' }, 'PATCH');
            await refreshGroups(false).catch(() => {});
            toast(archived ? 'Изделие в архиве' : 'Изделие восстановлено');
            closePanel(true);
          } catch (error) { toast(error.message, true); }
        },
      }, product.status === 'archived' ? '↩ Вернуть из архива' : '🗄 В архив'));
    }

    openPanel(isNew ? 'Новое изделие' : product.name, [errorBox, passport, recipeBlock, calcBlock], buttons);
    drawInherited();
    drawRaw();
    drawPackaging();
  }

  // -----------------------------------------------------------------------
  // Выбор существующей номенклатуры
  // -----------------------------------------------------------------------
  function pickNomenclature(kind, onPick) {
    const search = input('', {
      type: 'search',
      placeholder: kind === 'raw' ? 'Название или код сырья…' : 'Название или код упаковки…',
      autofocus: 'autofocus',
    });
    const list = el('div', { style: 'margin-top:10px;min-height:120px' });
    let timer = null;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 280); });
    async function run() {
      const query = search.value.trim();
      list.innerHTML = '';
      if (query.length < 2) return list.appendChild(el('div', { class: 'calc-sub' }, 'Введите минимум 2 символа.'));
      list.appendChild(el('div', { class: 'calc-skel' }));
      let data;
      try { data = await api('/nomenclature?kind=' + kind + '&q=' + encodeURIComponent(query)); }
      catch (error) { list.innerHTML = ''; list.appendChild(el('div', { class: 'calc-msg err' }, error.message)); return; }
      list.innerHTML = '';
      if (!data.items.length) return list.appendChild(el('div', { class: 'calc-empty compact' }, 'Ничего не найдено. Позиция создаётся в номенклатуре ERP.'));
      list.appendChild(el('div', { class: 'calc-pick-list static' }, data.items.map((item) => el('div', {
        class: 'calc-pick-item', onclick: () => { onPick(item); close(); },
      }, [
        el('div', { class: 'calc-pick-nm' }, item.name),
        el('div', { class: 'calc-pick-meta' }, [item.code, item.unit, item.category,
          item.price === null ? '⛔ нет цены' : money(item.price) + ' / ' + item.unit + ' · ' + ruDate(item.price_date)].filter(Boolean).join(' · ')),
      ]))));
    }
    const close = () => { overlay.remove(); pickerOpen = null; };
    const panel = el('div', { class: 'calc-panel', style: 'max-width:560px' }, [
      el('div', { class: 'calc-panel-head' }, [
        el('div', { class: 'calc-panel-title' }, kind === 'raw' ? 'Выбор сырья' : 'Выбор упаковки'),
        el('button', { class: 'calc-x', title: 'Закрыть', onclick: close }, '×'),
      ]),
      el('div', { class: 'calc-panel-body' }, [search, list]),
    ]);
    const overlay = el('div', {
      class: 'calc-ov', style: 'z-index:80', onclick: (event) => { if (event.target === overlay) close(); },
    }, panel);
    $('#calc-modal-root').appendChild(overlay);
    pickerOpen = close;
    setTimeout(() => search.focus(), 50);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (pickerOpen) return pickerOpen();
    if (PANEL) closePanel(true);
  });

  boot();
})();
