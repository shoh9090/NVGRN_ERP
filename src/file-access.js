// file-access.js — чистое решение о доступе к /file/:id (без БД), чтобы легко тестировать.
// Правила (P0.1):
//  - логотип/фон (публичные ассеты) — доступны всем (нужны на странице логина до входа);
//  - всё остальное — только авторизованному пользователю;
//  - медиа претензий — только админу или пользователю с доступом к плитке «Претензии»;
//  - во всех отказах наверху возвращаем 404 (не раскрываем существование файла).
function decideFileAccess({ isPublicAsset, hasUser, isComplaintMedia, isAdmin, hasComplaintsTile }) {
  if (isPublicAsset) return 'serve';
  if (!hasUser) return 'deny';
  if (isComplaintMedia && !isAdmin && !hasComplaintsTile) return 'deny';
  return 'serve';
}

module.exports = { decideFileAccess };
