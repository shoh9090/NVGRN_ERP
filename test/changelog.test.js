// Журнал изменений ERP (src/changelog.js).
// Проверяем, как коммит GitHub превращается в запись журнала, и что журнал
// закрыт для всех, кроме администратора.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const router = require('../src/changelog');
const { fromGithub } = router;

test('коммит → запись: заголовок, текст без служебной подписи, автор, дата, ссылка', () => {
  const x = fromGithub({
    sha: 'abc123',
    html_url: 'https://github.com/shoh9090/NVGRN_ERP/commit/abc123',
    commit: {
      message: 'Закуп → Цены: родительская категория\n\nСначала выбирается категория.\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
      author: { name: 'Shoh', date: '2026-09-16T09:12:00Z' },
    },
  });
  assert.equal(x.title, 'Закуп → Цены: родительская категория');
  assert.equal(x.body, 'Сначала выбирается категория.');
  assert.equal(x.author, 'Shoh');
  assert.equal(x.committed_at, '2026-09-16T09:12:00Z');
  assert.match(x.url, /commit\/abc123$/);
});

test('слияние веток в журнал не попадает — это склейка, а не изменение', () => {
  assert.equal(fromGithub({ sha: 'm1', commit: { message: "Merge branch 'main' of github.com:x/y", author: { date: '2026-09-16T00:00:00Z' } } }), null);
  assert.equal(fromGithub({ sha: 'm2', commit: { message: 'Merge pull request #12 from x/feature', author: { date: '2026-09-16T00:00:00Z' } } }), null);
});

test('без текста — только заголовок, пустое тело не хранится', () => {
  const x = fromGithub({ sha: 's', commit: { message: 'Мелкая правка', author: { name: 'A', date: '2026-09-16T00:00:00Z' } } });
  assert.equal(x.body, null);
});

async function call(user, path, method = 'GET') {
  const app = express();
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/', router);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, { method });
    return { status: res.status, body: await res.json() };
  } finally { srv.close(); }
}

test('не админу журнал недоступен — ни статус, ни список, ни отметка', async () => {
  const user = { id: 5, name: 'Кладовщик', isAdmin: false };
  for (const [path, method] of [['/api/changes/status', 'GET'], ['/api/changes', 'GET'], ['/api/changes/seen', 'POST']]) {
    const r = await call(user, path, method);
    assert.equal(r.status, 403, path);
    assert.match(r.body.error, /только администратору/);
  }
});
