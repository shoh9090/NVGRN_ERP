// jarvis.js — экран плитки «Джарвис»: вкладки «Правила» и «Люди и Trello».
(function () {
  const isAdmin = !!(window.HUB_USER && window.HUB_USER.isAdmin);
  const main = document.getElementById('jv-main');

  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) { if (c == null) continue; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return n;
  };
  async function api(path, body) {
    const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch('/jarvis/api' + path, opts);
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
  const money = (v) => Math.round(Number(v) || 0).toLocaleString('ru-RU');

  let TAB = 'rules';
  try { TAB = localStorage.getItem('jv_tab') || 'rules'; } catch (e) { /* без памяти вкладки */ }

  function render() {
    main.innerHTML = '';
    const tabs = el('div', { class: 'hub-tabs' }, [['rules', 'Правила'], ['people', 'Люди и Trello']].map(([k, t]) =>
      el('button', { class: 'hub-tab' + (TAB === k ? ' on' : ''), onclick: () => { TAB = k; try { localStorage.setItem('jv_tab', k); } catch (e) { /* ок */ } render(); } }, t)));
    const box = el('div', {}, el('div', { class: 'jv-muted' }, 'Загрузка…'));
    main.append(tabs, box);
    (TAB === 'rules' ? renderRules : renderPeople)(box).catch((e) => { box.innerHTML = ''; box.appendChild(el('div', { class: 'jv-err' }, e.message)); });
  }

  // ---------- Правила ----------
  async function renderRules(box) {
    const s = await api('/state');
    const r = s.rules;
    box.innerHTML = '';

    const tr = s.trello;
    const trelloCard = el('div', { class: 'jv-conn ' + (tr.ok ? 'ok' : 'bad') }, [
      el('div', { class: 'jv-conn-t' }, 'Trello'),
      el('div', {}, !tr.configured ? 'Не подключён: в Railway нет TRELLO_KEY и TRELLO_TOKEN'
        : tr.ok ? '✓ Подключён, учётка «' + tr.me + '»' : '✗ ' + tr.error),
    ]);
    const b = s.bot;
    const botCard = el('div', { class: 'jv-conn ' + (b.ok ? 'ok' : 'bad') }, [
      el('div', { class: 'jv-conn-t' }, 'Бот для сотрудников'),
      el('div', {}, !b.configured ? 'Не подключён: в Railway нет INTERNAL_BOT_TOKEN'
        : b.ok ? ['✓ ', el('a', { href: 'https://t.me/' + b.username, target: '_blank', rel: 'noopener' }, '@' + b.username), ' · напоминания заработают на следующем шаге'] : '✗ ' + b.error),
    ]);
    box.appendChild(el('div', { class: 'jv-conns' }, [trelloCard, botCard]));

    const dis = !isAdmin;
    const inp = (val, attrs = {}) => el('input', { class: 'jv-inp', value: String(val), disabled: dis, ...attrs });
    const numInp = (val, attrs = {}) => inp(val, { type: 'number', min: '0', step: attrs.step || '1', ...attrs });
    const row = (label, ...ctl) => el('div', { class: 'jv-row' }, [el('div', { class: 'jv-lab' }, label), el('div', { class: 'jv-ctl' }, ctl)]);
    const sec = (title, note, rows) => el('section', { class: 'jv-sec' }, [el('h3', {}, title), note ? el('div', { class: 'jv-muted' }, note) : null, ...rows]);

    // Пространство Trello
    const wsSel = el('select', { class: 'jv-inp', disabled: dis || !tr.ok }, [el('option', { value: '' }, '— выберите пространство —'),
      ...(tr.workspaces || []).map((w) => el('option', { value: w.id, selected: w.id === r.workspace_id }, w.name))]);
    const boards = (tr.boards || []);
    const wsRows = [row('Пространство', wsSel)];
    if (r.workspace_id) {
      wsRows.push(el('div', { class: 'jv-boards' }, boards.length
        ? ['Контролируем все доски (' + boards.length + '): ', ...boards.map((x, i) => [i ? ', ' : '', el('a', { href: x.url, target: '_blank', rel: 'noopener' }, x.name)]).flat()]
        : 'В пространстве нет открытых досок.'));
    }

    // Рабочее время
    const from = numInp(r.work_from, { max: '23' });
    const to = numInp(r.work_to, { max: '24' });
    const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
    const dayBoxes = DAYS.map((d, i) => el('label', { class: 'jv-day' }, [
      el('input', { type: 'checkbox', value: String(i + 1), checked: r.work_days.includes(i + 1), disabled: dis }), ' ' + d]));

    const mRem = numInp(r.mention_remind_h, { step: '0.5' });
    const mVio = numInp(r.mention_violation_h, { step: '0.5' });
    const oVio = numInp(r.overdue_violation_days);
    const stale = numInp(r.stale_days, { min: '1' });
    const fM = numInp(r.fine_mention, { step: '1000' });
    const fO = numInp(r.fine_overdue, { step: '1000' });
    const finesOn = el('input', { type: 'checkbox', checked: r.fines_enabled, disabled: dis });

    box.append(
      sec('Что контролируем', 'Джарвис смотрит только это пространство, другие ваши доски не открывает.', wsRows),
      sec('Рабочее время', 'Вне рабочего времени Джарвис не пишет, а часы до напоминания не идут.', [
        row('Часы', 'с ', from, ' до ', to),
        row('Дни', el('div', { class: 'jv-days' }, dayBoxes)),
      ]),
      sec('Упомянули (@) — и нет ответа в карточке', null, [
        row('Напомнить через', mRem, ' рабочих часов'),
        row('Нарушение через', mVio, ' рабочих часов'),
      ]),
      sec('Срок карточки прошёл, а она не выполнена', 'Напоминание — каждое рабочее утро, в начале рабочего дня.', [
        row('Нарушение через', oVio, ' рабочих дней после срока'),
      ]),
      sec('Карточка без движения', 'Одно напоминание участникам, без штрафа.', [
        row('Напомнить через', stale, ' дней'),
      ]),
      sec('Штрафы', 'Нарушение уходит руководителю отдела: «Провести» или «Отменить». Без ответа за сутки — проводится само и попадает в зарплату. '
        + 'Включать после недели работы одних напоминаний.', [
        row('Не ответил на упоминание', fM, ' сум'),
        row('Просрочил карточку', fO, ' сум'),
        row('Штрафы', el('label', { class: 'jv-day' }, [finesOn, ' включены']),
          el('span', { class: 'jv-muted' }, r.fines_enabled ? '' : ' сейчас выключены — только напоминания')),
      ]),
    );

    if (!isAdmin) { box.appendChild(el('div', { class: 'jv-muted' }, 'Правила меняет администратор.')); return; }
    const save = el('button', { class: 'btn-primary', onclick: async () => {
      const work_days = dayBoxes.map((l) => l.querySelector('input')).filter((x) => x.checked).map((x) => Number(x.value));
      if (finesOn.checked && !r.fines_enabled && !(Number(fM.value) > 0 || Number(fO.value) > 0)) {
        toast('Штрафы включены, но суммы нулевые — впишите суммы', true); return;
      }
      if (finesOn.checked && !r.fines_enabled && !confirm('Включить штрафы? С этого момента нарушения будут уходить руководителям и в зарплату.')) return;
      save.disabled = true;
      try {
        await api('/rules', {
          workspace_id: wsSel.value, work_from: from.value, work_to: to.value, work_days,
          mention_remind_h: mRem.value, mention_violation_h: mVio.value, overdue_violation_days: oVio.value,
          stale_days: stale.value, fine_mention: fM.value, fine_overdue: fO.value, fines_enabled: finesOn.checked,
        });
        toast('Сохранено');
        render();
      } catch (e) { toast(e.message, true); save.disabled = false; }
    } }, 'Сохранить правила');
    box.appendChild(el('div', { class: 'jv-actions' }, save));
  }

  // ---------- Люди и Trello ----------
  async function renderPeople(box) {
    const d = await api('/people');
    box.innerHTML = '';
    if (d.need_workspace) {
      box.appendChild(el('div', { class: 'jv-muted' }, 'Сначала выберите пространство Trello на вкладке «Правила».'));
      return;
    }
    const empName = (e) => [e.full_name, e.department_name].filter(Boolean).join(' · ');
    const link = async (member_id, employee_id) => api('/people/link', { member_id, employee_id });

    const sure = d.members.filter((m) => !m.linked && m.suggestion && m.suggestion.strength === 'full' && m.suggestion.status === 'active');
    const done = d.members.filter((m) => m.linked).length;
    const head = el('div', { class: 'pur-toolbar' }, [
      el('div', { class: 'jv-muted' }, 'В пространстве «' + d.workspace_name + '»: ' + d.members.length + ' чел., сопоставлено ' + done + '.'),
      isAdmin && sure.length ? el('div', { class: 'pur-toolbar-right' }, el('button', { class: 'btn-primary', onclick: async (ev) => {
        ev.target.disabled = true;
        try { for (const m of sure) await link(m.id, m.suggestion.id); toast('Подтверждено: ' + sure.length); render(); }
        catch (e) { toast(e.message, true); render(); }
      } }, 'Подтвердить точные совпадения (' + sure.length + ')')) : null,
    ]);
    box.appendChild(head);

    const active = d.employees.filter((e) => e.status === 'active');
    const empSelect = (preset) => el('select', { class: 'jv-inp' }, [el('option', { value: '' }, '— сотрудник из Персонала —'),
      ...active.map((e) => el('option', { value: String(e.id), selected: preset && preset === e.id }, empName(e)))]);

    const rows = d.members.map((m) => {
      const who = el('td', {}, [el('div', { class: 'jv-b' }, m.fullName), el('div', { class: 'jv-muted' }, '@' + m.username)]);
      let emp, act = el('td', {});
      if (m.linked) {
        const fired = m.linked.status === 'fired';
        emp = el('td', {}, [el('div', { class: 'jv-b' }, '✓ ' + m.linked.full_name),
          el('div', { class: fired ? 'jv-warn' : 'jv-muted' }, fired ? 'уволен(а) — Джарвис не контролирует; уберите из пространства Trello'
            : [m.linked.department_name, m.linked.position, m.linked.in_bot ? 'в боте ✓' : null].filter(Boolean).join(' · '))]);
        if (isAdmin) act.appendChild(el('button', { class: 'btn-danger-link', onclick: async () => {
          if (!confirm('Отвязать ' + m.fullName + ' от «' + m.linked.full_name + '»?')) return;
          try { await api('/people/unlink', { employee_id: m.linked.id }); render(); } catch (e) { toast(e.message, true); }
        } }, 'Отвязать'));
      } else if (m.suggestion && m.suggestion.status === 'fired') {
        emp = el('td', {}, [el('div', {}, m.suggestion.full_name),
          el('div', { class: 'jv-warn' }, 'уволен(а) в Персонале — Джарвис не контролирует; уберите из пространства Trello')]);
      } else {
        // Сами подставляем только полное совпадение: по одному слову легко ошибиться
        // (Muradov ↔ Мурадова) — такое только подсказываем.
        const full = m.suggestion && m.suggestion.strength === 'full';
        const sel = empSelect(full ? m.suggestion.id : null);
        const hint = full ? 'Предлагаем — имя и фамилия совпали'
          : m.suggestion ? 'Возможно: ' + empName(m.suggestion) + ' — совпало одно слово, проверьте'
          : (m.ambiguous ? 'Похожих несколько — выберите сами' : 'Не нашли похожего — выберите сами');
        emp = el('td', {}, [sel, el('div', { class: 'jv-muted' }, hint)]);
        if (!isAdmin) sel.disabled = true;
        else act.appendChild(el('button', { class: 'pur-tbtn', onclick: async (ev) => {
          if (!sel.value) { toast('Выберите сотрудника', true); return; }
          ev.target.disabled = true;
          try { await link(m.id, Number(sel.value)); toast('Сопоставлено'); render(); }
          catch (e) { toast(e.message, true); ev.target.disabled = false; }
        } }, full ? '✓ Верно' : 'Связать'));
      }
      return el('tr', {}, [who, emp, act]);
    });
    box.appendChild(el('div', { class: 'pur-content' }, el('table', { class: 'dict-table jv-table' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, 'Trello'), el('th', {}, 'Сотрудник в Персонале'), el('th', {}, '')])),
      el('tbody', {}, rows),
    ])));

    if (d.lost.length) {
      box.appendChild(el('section', { class: 'jv-sec' }, [el('h3', {}, 'Сопоставлены, но в пространстве Trello их больше нет'),
        el('div', {}, d.lost.map((e) => el('div', {}, e.full_name + ' — @' + (e.trello_username || '?'))))]));
    }
    if (d.without.length) {
      box.appendChild(el('section', { class: 'jv-sec' }, [el('h3', {}, 'Активные сотрудники без Trello (' + d.without.length + ')'),
        el('div', { class: 'jv-muted' }, 'Джарвис напоминает только тем, кто есть в Trello. Если человеку нужны карточки — пригласите его в пространство.'),
        el('div', { class: 'jv-list' }, d.without.map((e) => el('span', {}, empName(e))))]));
    }
  }

  render();
})();
