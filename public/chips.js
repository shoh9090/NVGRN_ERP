// chips.js — фильтры-таблетки со счётчиками, общие для всего Hub.
//
// Задача одна и та же во всех плитках: показать срезы списка (статусы заявок,
// статусы претензий) вместе с количеством в каждом и дать переключаться одним
// нажатием. Раньше это был выпадающий список «Все статусы»: количества не
// видно, переключение в два действия.
//
// Устройство как в плитке «Распознавание счёт-фактур»: ряд таблеток, в каждой
// подпись и число, выбранная — тёмная.
//
// Применение:
//   const chips = HubChips.create({
//     items: [{ key: '', label: 'Все' }, { key: 'draft', label: 'Черновики' }],
//     value: state.status,
//     onChange: (key) => { state.status = key; reload(); },
//   });
//   …позже, когда с сервера пришли количества:
//   chips.setCounts({ '': 42, draft: 7, ordered: 12 });
//
// Счётчики приходят отдельно от списка намеренно: их считает сервер по всей
// выборке, а список обрезан. До первого setCounts в таблетке стоит «·», а не
// 0 — ноль читался бы как «ничего нет». После — ноль означает именно ноль.
(function () {
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

  function create(o) {
    const items = o.items || [];
    let value = o.value == null ? '' : String(o.value);
    const wrap = el('div', { class: 'hub-chips' + (o.class ? ' ' + o.class : '') });
    const nodes = {};

    items.forEach((it) => {
      const key = it.key == null ? '' : String(it.key);
      const num = el('span', { class: 'hub-chip-n wait' }, '·');
      const chip = el('button', {
        type: 'button',
        class: 'hub-chip' + (key === value ? ' on' : ''),
        title: it.title || null,
        onclick: () => {
          if (key === value) return;          // повторный клик по своей же таблетке ничего не меняет
          value = key;
          Object.entries(nodes).forEach(([k, n]) => n.chip.classList.toggle('on', k === value));
          if (o.onChange) o.onChange(key);
        },
      }, [it.label, num]);
      nodes[key] = { chip, num };
      wrap.appendChild(chip);
    });

    // Проставить количества. Ключ, которого нет в наборе, игнорируем —
    // сервер может вернуть статус, которого в фильтрах нет.
    wrap.setCounts = (counts) => {
      const map = counts || {};
      Object.entries(nodes).forEach(([k, n]) => {
        // Счётчики пришли — значит про каждый срез теперь всё известно.
        // Сервер перечисляет только непустые статусы, поэтому отсутствие
        // ключа означает ноль, а не «ещё не знаем»: иначе на пустом статусе
        // навсегда оставалась бы точка ожидания.
        const v = map[k] == null ? 0 : Number(map[k]);
        n.num.className = 'hub-chip-n' + (v ? '' : ' zero');
        n.num.textContent = v.toLocaleString('ru-RU');
      });
    };
    // Выбрать таблетку снаружи (например, кнопкой «Сбросить»).
    wrap.setValue = (k) => {
      value = k == null ? '' : String(k);
      Object.entries(nodes).forEach(([key, n]) => n.chip.classList.toggle('on', key === value));
    };
    wrap.getValue = () => value;
    return wrap;
  }

  window.HubChips = { create };
})();
