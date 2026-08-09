// bell.js — колокольчик уведомлений (принцип Trello), общий для всех плиток
(function () {
  const root = document.getElementById('bell-root');
  if (!root) return;

  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'html') n.innerHTML = v;
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };
  // Человеческая дата: свежее — «12 минут назад», сегодня/вчера — с временем, старое — с датой.
  const ru = (s) => {
    const d = new Date(s);
    if (isNaN(d.getTime())) return '';
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'только что';
    if (mins < 60) return mins + ' мин. назад';
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const today = day(new Date());
    if (day(d) === today) return 'сегодня, ' + hm;
    if (day(d) === today - 86400000) return 'вчера, ' + hm;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + ', ' + hm;
  };

  const btn = el('button', { class: 'bell-btn', title: 'Уведомления' }, '🔔');
  const badge = el('span', { class: 'bell-badge', style: 'display:none' }, '0');
  btn.appendChild(badge);
  const panel = el('div', { class: 'bell-panel', style: 'display:none' });
  root.appendChild(btn);
  root.appendChild(panel);

  let items = [];
  async function load() {
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) return;
      const data = await res.json();
      items = data.items || [];
      if (data.unread > 0) { badge.textContent = data.unread; badge.style.display = ''; }
      else badge.style.display = 'none';
    } catch (e) { /* тихо */ }
  }
  function render() {
    panel.innerHTML = '';
    const unread = items.filter((n) => !n.is_read).length;
    panel.appendChild(el('div', { class: 'bell-head' }, [
      el('span', {}, unread ? 'Уведомления · ' + unread + ' новых' : 'Уведомления'),
      // Кнопка нужна только когда есть что отмечать.
      unread ? el('button', { class: 'bell-readall', onclick: markAll }, 'Прочитать все') : null,
    ]));
    if (!items.length) { panel.appendChild(el('div', { class: 'bell-empty' }, 'Пока нет уведомлений')); return; }
    const list = el('div', { class: 'bell-list' });
    for (const n of items) {
      const kindIcon = n.kind === 'success' ? '✅' : n.kind === 'warning' ? '⚠️' : 'ℹ️';
      list.appendChild(el('a', {
        class: 'bell-item bell-' + (n.kind || 'info') + (n.is_read ? '' : ' unread'),
        href: n.link || 'javascript:void(0)',
      }, [
        el('div', { class: 'bell-item-title' }, kindIcon + ' ' + n.title),
        n.body ? el('div', { class: 'bell-item-body' }, n.body) : null,
        el('div', { class: 'bell-item-date' }, ru(n.created_at)),
      ]));
    }
    panel.appendChild(list);
  }
  async function markAll() {
    try { await fetch('/api/notifications/read-all', { method: 'POST' }); } catch (e) {}
    items = items.map((n) => ({ ...n, is_read: true }));
    badge.style.display = 'none';
    render();
  }

  btn.addEventListener('click', () => {
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    if (!open) render();
  });
  document.addEventListener('click', (e) => { if (!root.contains(e.target)) panel.style.display = 'none'; });

  load();
  setInterval(load, 60000); // опрос раз в минуту
})();
