// changes.js — журнал изменений ERP в шапке (только администратор).
//
// Иконка светится, если с прошлого просмотра в ERP что-то поменяли; не
// светится — ничего нового. По нажатию — список: что поменялось, когда и
// кто сделал (это сообщения коммитов — разработчики пишут их по-русски, для
// людей). Открыл журнал — иконка гаснет до следующего изменения.
(function () {
  const root = document.getElementById('chg-root');
  if (!root) return;

  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };

  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  // Заголовок дня: «Сегодня», «Вчера» или «14 сентября». Время — ташкентское (его отдаёт сервер).
  function dayTitle(isoDay) {
    const t = new Date(); const pad = (x) => String(x).padStart(2, '0');
    const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const y = new Date(t); y.setDate(t.getDate() - 1);
    if (isoDay === iso(t)) return 'Сегодня';
    if (isoDay === iso(y)) return 'Вчера';
    const [yy, mm, dd] = isoDay.split('-').map(Number);
    return dd + ' ' + MONTHS[mm - 1] + (yy !== t.getFullYear() ? ' ' + yy : '');
  }

  const btn = el('button', { class: 'chg-btn', type: 'button', title: 'Журнал изменений ERP' }, [
    el('span', { class: 'chg-ico' }, '🛠'),
    el('span', { class: 'chg-badge', style: 'display:none' }, ''),
  ]);
  const panel = el('div', { class: 'chg-panel', style: 'display:none' });
  root.appendChild(btn);
  root.appendChild(panel);
  const badge = btn.querySelector('.chg-badge');

  function glow(n) {
    btn.classList.toggle('on', n > 0);
    badge.style.display = n > 0 ? '' : 'none';
    badge.textContent = n > 99 ? '99+' : String(n);
    btn.title = n > 0 ? `Журнал изменений: новых — ${n}` : 'Журнал изменений: нового нет';
  }

  async function status() {
    try {
      const r = await fetch('/api/changes/status');
      if (!r.ok) return;
      glow((await r.json()).unseen || 0);
    } catch (e) { /* сеть моргнула — проверим в следующий раз */ }
  }

  let open = false;
  const outside = (e) => { if (!root.contains(e.target)) toggle(false); };
  function toggle(v) {
    open = v === undefined ? !open : v;
    panel.style.display = open ? '' : 'none';
    if (open) { load(); document.addEventListener('click', outside); } else document.removeEventListener('click', outside);
  }
  btn.onclick = (e) => { e.stopPropagation(); toggle(); };

  async function load() {
    panel.innerHTML = '';
    panel.appendChild(el('div', { class: 'chg-empty' }, 'Загружаю…'));
    let d;
    try { d = await (await fetch('/api/changes')).json(); } catch (e) { panel.innerHTML = ''; panel.appendChild(el('div', { class: 'chg-empty' }, 'Не удалось загрузить журнал.')); return; }
    panel.innerHTML = '';
    panel.appendChild(el('div', { class: 'chg-head' }, [
      el('div', { class: 'chg-h' }, 'Журнал изменений ERP'),
      el('div', { class: 'chg-sub' }, d.running ? 'Сейчас на сервере версия ' + d.running : 'Что поменялось, когда и кто сделал'),
      d.error ? el('div', { class: 'chg-err' }, d.error) : null,
    ]));
    const list = el('div', { class: 'chg-list' });
    if (!(d.items || []).length) list.appendChild(el('div', { class: 'chg-empty' }, 'Записей пока нет — журнал заполнится после первой сверки с GitHub.'));
    let day = '';
    (d.items || []).forEach((x) => {
      const dDay = String(x.at).slice(0, 10);
      if (dDay !== day) { day = dDay; list.appendChild(el('div', { class: 'chg-day' }, dayTitle(dDay))); }
      const body = x.body ? el('div', { class: 'chg-body', style: 'display:none' }, x.body) : null;
      list.appendChild(el('div', { class: 'chg-item' + (x.is_new ? ' new' : '') }, [
        el('div', { class: 'chg-meta' }, [
          String(x.at).slice(11, 16), x.author ? ' · ' + x.author : '',
          x.deployed ? el('span', { class: 'chg-dep', title: 'Когда эта версия запустилась на сервере' }, ' · выложено ' + x.deployed) : null,
        ]),
        el('div', { class: 'chg-title' }, x.title),
        el('div', { class: 'chg-act' }, [
          body ? el('button', { class: 'chg-more', type: 'button', onclick: (e) => { const show = body.style.display === 'none'; body.style.display = show ? '' : 'none'; e.target.textContent = show ? 'скрыть' : 'подробнее'; } }, 'подробнее') : null,
          x.url ? el('a', { class: 'chg-link', href: x.url, target: '_blank', rel: 'noopener' }, 'в GitHub ↗') : null,
        ]),
        body,
      ]));
    });
    panel.appendChild(list);
    // Посмотрел — иконка гаснет. Отметки «новое» в открытом списке остаются до закрытия.
    try { await fetch('/api/changes/seen', { method: 'POST' }); glow(0); } catch (e) { /* не критично */ }
  }

  status();
  setInterval(status, 5 * 60 * 1000);
})();
