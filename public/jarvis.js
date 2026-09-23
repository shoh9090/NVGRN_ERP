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
    const tabs = el('div', { class: 'hub-tabs' }, [['rules', 'Правила'], ['people', 'Люди и Trello'], ['log', 'Журнал']].map(([k, t]) =>
      el('button', { class: 'hub-tab' + (TAB === k ? ' on' : ''), onclick: () => { TAB = k; try { localStorage.setItem('jv_tab', k); } catch (e) { /* ок */ } render(); } }, t)));
    const box = el('div', {}, el('div', { class: 'jv-muted' }, 'Загрузка…'));
    main.append(tabs, box);
    ({ rules: renderRules, people: renderPeople, log: renderLog }[TAB] || renderRules)(box).catch((e) => { box.innerHTML = ''; box.appendChild(el('div', { class: 'jv-err' }, e.message)); });
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
        : b.ok ? ['✓ ', el('a', { href: 'https://t.me/' + b.username, target: '_blank', rel: 'noopener' }, '@' + b.username),
          ' · сотрудникам: открыть бота и нажать «Поделиться номером»'] : '✗ ' + b.error),
    ]);
    const sy = s.sync || {};
    const syncCard = el('div', { class: 'jv-conn ' + (sy.last_error ? 'bad' : 'ok') }, [
      el('div', { class: 'jv-conn-t' }, 'Чтение Trello'),
      el('div', {}, sy.last_error ? '✗ ' + sy.last_error
        : sy.last_sync ? '✓ ' + new Date(sy.last_sync).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
          + ' · досок ' + sy.boards + ', карточек ' + sy.cards + ' · раз в 5 минут'
          : 'Ещё не читал — первый раз через минуту после запуска'),
    ]);
    // Продажи из SalesDoctor: что уже лежит в нашей базе и как идёт заливка истории.
    const salesCard = el('div', { class: 'jv-conn ok' }, [el('div', { class: 'jv-conn-t' }, 'Продажи из SalesDoctor'), el('div', {}, 'загрузка…')]);
    api('/sd/sales').then((c) => {
      const b = c.backfill || {};
      const body = el('div', {}, c.days
        ? [c.first_day ? 'Есть дни: ' + c.first_day + ' — ' + c.last_day + ' (' + c.days + ' дн., строк ' + c.rows + ')' : 'пока пусто',
          b.next_month && !b.finished ? el('div', { class: 'jv-muted' }, 'Заливка истории: загружено месяцев ' + (b.done || 0) + ', сейчас ' + b.next_month + (b.error ? ' · ошибка: ' + b.error : '')) : null]
        : 'Ещё не выгружали');
      salesCard.replaceChild(body, salesCard.lastChild);
      if (isAdmin && !(b.next_month && !b.finished)) {
        salesCard.appendChild(el('button', { class: 'pur-tbtn', style: 'margin-top:8px', onclick: async (ev) => {
          if (!confirm('Загрузить историю продаж за 24 месяца? Пойдёт фоном по месяцу за раз, примерно два часа.')) return;
          ev.target.disabled = true;
          try { await api('/sd/backfill', { months: 24 }); toast('Заливка запущена — идёт фоном'); }
          catch (e) { toast(e.message, true); ev.target.disabled = false; }
        } }, c.days ? 'Перезалить историю за 24 месяца' : 'Загрузить историю за 24 месяца'));
      }
    }).catch(() => {});
    box.appendChild(el('div', { class: 'jv-conns' }, [trelloCard, botCard, syncCard, salesCard]));

    const dis = !isAdmin;
    const inp = (val, attrs = {}) => el('input', { class: 'jv-inp', value: String(val), disabled: dis, ...attrs });
    const numInp = (val, attrs = {}) => inp(val, { type: 'number', min: '0', step: attrs.step || '1', ...attrs });
    const row = (label, ...ctl) => el('div', { class: 'jv-row' }, [el('div', { class: 'jv-lab' }, label), el('div', { class: 'jv-ctl' }, ctl)]);
    const field = (label, ctl, note) => el('div', { class: 'jv-field' }, [
      el('label', {}, label), ctl, note ? el('div', { class: 'jv-muted' }, note) : null]);
    const sec = (title, note, rows) => el('section', { class: 'jv-sec' }, [el('h3', {}, title), note ? el('div', { class: 'jv-muted' }, note) : null, ...rows]);

    // Пространство Trello
    const doneExtra = inp((r.done_lists || []).join(', '), { placeholder: 'например: на паузе, идеи', style: 'min-width:280px' });
    const wsSel = el('select', { class: 'jv-inp', disabled: dis || !tr.ok }, [el('option', { value: '' }, '— выберите пространство —'),
      ...(tr.workspaces || []).map((w) => el('option', { value: w.id, selected: w.id === r.workspace_id }, w.name))]);
    const boards = (tr.boards || []);
    const wsRows = [row('Пространство', wsSel)];
    if (r.workspace_id) {
      wsRows.push(el('div', { class: 'jv-boards' }, boards.length
        ? ['Контролируем все доски (' + boards.length + '): ', ...boards.map((x, i) => [i ? ', ' : '', el('a', { href: x.url, target: '_blank', rel: 'noopener' }, x.name)]).flat()]
        : 'В пространстве нет открытых досок.'));
      wsRows.push(row('Ещё считать закрытыми', doneExtra));
      wsRows.push(el('div', { class: 'jv-boards' }, (tr.done_lists || []).length
        ? 'Карточка считается закрытой в колонках: ' + tr.done_lists.join(', ')
          + '. В таких карточках Джарвис не ждёт ответа и не считает просрочку.'
        : 'Колонок «Сделано/Готово» не нашёл — назовите колонку так, и карточки в ней будут считаться закрытыми.'));
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
    const dueAsk = numInp(r.due_ask_after_h, { step: '0.5' });
    const cap = numInp(r.daily_cap, { min: '1' });
    const mute = inp((r.mute_clients || []).join(', '), { placeholder: 'например: KorzinkaRS, Morye', style: 'min-width:280px' });
    const dueH = numInp(r.due_required_h, { step: '0.5' });
    const moves = numInp(r.moves_alert, { min: '1' });
    const fM = numInp(r.fine_mention, { step: '1000' });
    const fO = numInp(r.fine_overdue, { step: '1000' });
    const finesOn = el('input', { type: 'checkbox', checked: r.fines_enabled, disabled: dis });
    const remOn = el('input', { type: 'checkbox', checked: r.reminders_enabled, disabled: dis });
    const aiOn = el('input', { type: 'checkbox', checked: r.ai_enabled, disabled: dis });
    const aiProv = el('select', { class: 'jv-inp', disabled: dis }, [
      el('option', { value: 'claude', selected: r.ai_provider !== 'openai' }, 'Claude' + ((s.ai || {}).claude ? ' — ключ есть ✓' : ' — ключа нет')),
      el('option', { value: 'openai', selected: r.ai_provider === 'openai' }, 'GPT (OpenAI)' + ((s.ai || {}).openai ? ' — ключ есть ✓' : ' — ключа нет')),
    ]);
    const aiModel = inp(r.ai_model, { placeholder: 'по умолчанию: claude-sonnet-5', style: 'min-width:260px' });
    const voiceOn = el('input', { type: 'checkbox', checked: r.voice_enabled, disabled: dis });
    const voiceModel = inp(r.voice_model, { placeholder: 'whisper-1', style: 'min-width:200px' });

    // Кто вносит: у дела цепочка ответственных — кто первый и кто подхватывает.
    const ownerChain = {};
    const roleOpt = (val) => el('select', { class: 'jv-inp', disabled: dis }, [el('option', { value: '' }, '— не назначено —'),
      ...(s.roles || []).map((ro) => el('option', { value: String(ro.id), selected: String(val || '') === String(ro.id) },
        ro.name + ' — ' + ro.people + ' чел., в боте ' + ro.in_bot))]);
    const roleWarn = (sel, tile) => {
      const chosen = (s.roles || []).find((ro) => String(ro.id) === String(sel.value || ''));
      if (!chosen) return null;
      if (!chosen.tiles.includes(tile)) return el('div', { class: 'jv-warn' }, 'У роли «' + chosen.name + '» нет доступа к плитке ' + tile + ' — внести не сможет.');
      if (!chosen.in_bot) return el('div', { class: 'jv-warn' }, 'Никто из роли «' + chosen.name + '» не открыл бота — напоминание не дойдёт.');
      return null;
    };
    const ownerRows = (s.todo_kinds || []).map((k) => {
      const steps = ((r.owners || {})[k.key] || []);
      const first = roleOpt(steps[0] && steps[0].role);
      const second = roleOpt(steps[1] && steps[1].role);
      const after = el('input', { class: 'jv-inp', type: 'number', min: '1', step: '1', disabled: dis,
        value: String(steps[1] ? steps[1].after_h : 8), style: 'width:90px' });
      ownerChain[k.key] = { first, second, after };
      const box = el('div', { class: 'jv-chain' }, [
        el('div', { class: 'jv-lab' }, k.title),
        el('div', { class: 'jv-ctl' }, ['Делает: ', first]),
        el('div', { class: 'jv-ctl' }, ['Не сделано через ', after, ' рабочих часов — подключаем: ', second]),
      ]);
      const w1 = roleWarn(first, k.tile), w2 = roleWarn(second, k.tile);
      if (w1) box.appendChild(w1);
      if (w2) box.appendChild(w2);
      return box;
    });

    // Экран собран по одному правилу: сверху — то, чем пользуются каждый день,
    // ниже — то, что настраивают раз в жизни («Тонкие настройки»). Подписи над
    // полями, как в формах остальных плиток.
    const fold = (title, note, rows) => el('details', { class: 'jv-fold' }, [
      el('summary', {}, title),
      el('div', { class: 'jv-fold-b' }, [note ? el('div', { class: 'jv-muted' }, note) : null, ...rows]),
    ]);
    const onoff = (label, input, note) => el('label', { class: 'jv-switch' }, [
      input, el('span', {}, [el('b', {}, label), note ? el('span', { class: 'jv-muted' }, note) : null]),
    ]);

    box.append(
      // 1. Три переключателя — главное, что включают и выключают.
      sec('Что включено', null, [
        el('div', { class: 'jv-switches' }, [
          onoff('Напоминания', remOn, r.reminders_enabled
            ? ' пишет людям про Trello' : ' выключены: только читает и ведёт журнал'),
          onoff('Вопросы словами', aiOn, ' человек спрашивает — Джарвис отвечает по данным ERP'),
          onoff('Голосовые', voiceOn, (s.voice || {}).ready ? ' можно надиктовать вопрос' : ' нужен ключ OPENAI_API_KEY'),
          onoff('Штрафы', finesOn, r.fines_enabled ? ' нарушения идут в зарплату' : ' выключены: только напоминания'),
        ]),
      ]),

      // 2. Что контролируем в Trello.
      sec('Доски Trello', 'Джарвис смотрит только это пространство, другие ваши доски не открывает.', wsRows),

      // 3. Когда можно писать людям.
      sec('Когда пишем людям', 'Вне рабочего времени Джарвис молчит, и часы до напоминания не идут.', [
        el('div', { class: 'jv-grid' }, [
          field('Рабочие часы', el('div', { class: 'jv-ctl' }, ['с ', from, ' до ', to])),
          field('Рабочие дни', el('div', { class: 'jv-days' }, dayBoxes)),
          field('Не больше сообщений в день', el('div', { class: 'jv-ctl' }, [cap, ' на человека']),
            'Нарушения приходят всегда, даже сверх этого.'),
        ]),
      ]),

      // 4. Сроки — четыре числа, которые действительно меняют поведение.
      sec('Сроки', 'По этим числам Джарвис решает, когда напомнить и когда записать нарушение.', [
        el('div', { class: 'jv-grid' }, [
          field('Упомянули и нет ответа', el('div', { class: 'jv-ctl' }, ['напомнить через ', mRem, ' ч']),
            'Рабочие часы, не календарные.'),
          field('…а это уже нарушение', el('div', { class: 'jv-ctl' }, ['через ', mVio, ' ч'])),
          field('Карточка без срока', el('div', { class: 'jv-ctl' }, ['нарушение через ', dueH, ' ч']),
            'Сначала Джарвис сам спросит срок кнопками и поставит дату в Trello.'),
          field('Срок прошёл', el('div', { class: 'jv-ctl' }, ['нарушение через ', oVio, ' раб. дн.'])),
        ]),
      ]),

      // 5. Кто за какое дело ERP отвечает.
      sec('Кто вносит данные', 'Дело приходит ответственной роли, а не всем подряд. Второй подключается, только если работа встала: '
        + 'пока число уменьшается, Джарвис молчит.', ownerRows),

      // 6. Всё редкое — под замок, чтобы не пугало.
      fold('⚙️ Тонкие настройки — меняют редко', null, [
        el('div', { class: 'jv-grid' }, [
          field('Сумма штрафа за неответ', fM, 'сум'),
          field('Сумма штрафа за просрочку', fO, 'сум'),
          field('Новую карточку не трогать', dueAsk, 'рабочих часов — человек ещё сам может поставить срок'),
          field('Сигнал о переносах срока', moves, 'после стольких переносов Джарвис напишет руководителю'),
          field('Карточка без движения', stale, 'дней — потом одно напоминание списком'),
          field('Кто отвечает на вопросы', aiProv, 'ключи лежат в Railway, в ERP их не видно'),
          field('Модель ИИ', aiModel, 'пусто — claude-sonnet-5'),
          field('Чем распознаём речь', voiceModel, 'пусто — whisper-1'),
          field('Не следить за клиентами', mute, 'через запятую: про них не писать «перестал брать» — например, сменился формат работы'),
        ]),
        el('div', { class: 'jv-muted' }, 'Что умеет ИИ: '
          + ((s.ai || {}).tools || []).map((t) => t.name).join(', ')),
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
          reminders_enabled: remOn.checked, due_required_h: dueH.value, moves_alert: moves.value,
          due_ask_after_h: dueAsk.value, daily_cap: cap.value, mute_clients: mute.value,
          ai_enabled: aiOn.checked, ai_provider: aiProv.value, ai_model: aiModel.value,
          voice_enabled: voiceOn.checked, voice_model: voiceModel.value,
          done_lists: doneExtra.value,
          owners: Object.fromEntries(Object.entries(ownerChain).map(([k, c]) => [k,
            [c.first.value ? { role: c.first.value, after_h: 0 } : null,
              c.second.value ? { role: c.second.value, after_h: c.after.value } : null].filter(Boolean)])),
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

  // ---------- Журнал ----------
  const KIND = {
    remind_mention: '🔔 Напоминание: упоминание', violation_mention: '⚠️ Нарушение: нет ответа',
    remind_overdue: '☀️ Утренний список просрочек', violation_overdue: '⚠️ Нарушение: просрочка',
    remind_stale: '💤 Без движения', remind_no_due: '📅 Спросили срок', violation_no_due: '⚠️ Нарушение: нет срока',
    due_set: '📅 Срок поставлен', due_moved: '🔁 Срок перенесён', ai: '🤖 Вопрос Джарвису', voice: '🎧 Голосовое', reply: '✍️ Ответ из Telegram', morning: '☀️ Утренняя сводка',
  };
  const dt = (v) => v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const cardLink = (name, url) => url ? el('a', { href: url, target: '_blank', rel: 'noopener' }, name || 'карточка') : (name || '');
  async function renderLog(box) {
    const d = await api('/log');
    box.innerHTML = '';
    const n = (k) => (d.counts.find((c) => c.kind === k) || {}).n || 0;
    box.appendChild(el('div', { class: 'pur-kpis' }, [
      ['Ждут ответа сейчас', d.waiting.length],
      ['Напоминаний за 30 дней', n('remind_mention') + n('remind_overdue') + n('remind_stale') + n('morning') + n('remind_no_due')],
      ['Нарушений за 30 дней', n('violation_mention') + n('violation_overdue') + n('violation_no_due')],
      ['Ответов из Telegram', n('reply')],
    ].map(([l, v]) => el('div', { class: 'pur-kpi' }, [el('div', { class: 'pur-kpi-label' }, l), el('div', { class: 'pur-kpi-val' }, String(v))]))));

    if (d.waiting.length) {
      box.appendChild(el('section', { class: 'jv-sec' }, [el('h3', {}, 'Упоминания без ответа'),
        el('table', { class: 'dict-table jv-table' }, [
          el('thead', {}, el('tr', {}, ['Кого', 'Карточка', 'Кто упомянул', 'Когда', 'Статус'].map((t) => el('th', {}, t)))),
          el('tbody', {}, d.waiting.map((m) => el('tr', {}, [
            el('td', {}, m.full_name || '—'), el('td', {}, cardLink(m.card_name, m.card_url)), el('td', {}, m.author_name || ''),
            el('td', {}, dt(m.created_at)),
            el('td', {}, m.violation_at ? '⚠️ нарушение' : m.reminded_at ? '🔔 напомнили' : 'ждём'),
          ]))),
        ])]));
    }
    box.appendChild(el('section', { class: 'jv-sec' }, [el('h3', {}, 'Что сделал Джарвис'),
      d.items.length ? el('table', { class: 'dict-table jv-table' }, [
        el('thead', {}, el('tr', {}, ['Когда', 'Что', 'Кому', 'Карточка', 'Подробно', ''].map((t) => el('th', {}, t)))),
        el('tbody', {}, d.items.map((x) => el('tr', {}, [
          el('td', {}, dt(x.created_at)), el('td', {}, KIND[x.kind] || x.kind), el('td', {}, x.full_name || '—'),
          el('td', {}, cardLink(x.card_name, x.card_url)), el('td', { class: 'jv-muted' }, x.text || ''),
          el('td', {}, x.sent ? '✓' : el('span', { class: 'jv-warn', title: 'Человек не открыл бота или напоминания выключены' }, 'не дошло')),
        ]))),
      ]) : el('div', { class: 'jv-muted' }, 'Пока пусто. Напоминания и нарушения появятся здесь.')]));
  }

  render();
})();
