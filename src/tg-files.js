// tg-files.js — видео претензий хранятся в Telegram, а не в базе.
//
// Раньше бот скачивал каждое видео клиента и клал байты в public.files. За три
// месяца 52 ролика заняли 233 МБ из 291 МБ базы, и диск Railway заполнился на 90%.
// Решение Шоха (сентябрь 2026, без платного хранилища): видео держит сам Telegram,
// в базе остаётся строка files с пустыми байтами (для проверки прав /file/:id) и
// номер файла в Telegram (tgbot.complaint_files.tg_file_id). ERP подгружает ролик
// из Telegram в момент просмотра. Фото остаются в базе — они лёгкие.
//
// Токен — тот же, что у бота: переменная TELEGRAM_BOT_TOKEN в сервисе ERP.

const API = 'https://api.telegram.org';
const token = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const hasToken = () => !!token();

// Путь к файлу у Telegram живёт около часа — держим его в памяти, чтобы не
// спрашивать на каждый просмотр.
const pathCache = new Map();   // file_id → { path, size, at }
const TTL = 50 * 60 * 1000;

async function fileInfo(fileId) {
  if (!hasToken()) throw new Error('В ERP не задан TELEGRAM_BOT_TOKEN — видео из Telegram недоступны');
  const c = pathCache.get(fileId);
  if (c && Date.now() - c.at < TTL) return c;
  const r = await fetch(`${API}/bot${token()}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const d = await r.json().catch(() => ({}));
  if (!d.ok || !d.result || !d.result.file_path) {
    throw new Error('Telegram не отдал файл: ' + ((d && d.description) || ('HTTP ' + r.status)));
  }
  const info = { path: d.result.file_path, size: Number(d.result.file_size) || null, at: Date.now() };
  pathCache.set(fileId, info);
  return info;
}

async function download(fileId) {
  const info = await fileInfo(fileId);
  const r = await fetch(`${API}/file/bot${token()}/${info.path}`);
  if (!r.ok) { pathCache.delete(fileId); throw new Error('Telegram: HTTP ' + r.status); }
  return Buffer.from(await r.arrayBuffer());
}

// Можно ли безопасно освободить место в базе: Telegram отдаёт файл, и его
// размер совпадает с тем, что лежит у нас. Не совпал или не отдал — не трогаем.
function safeToOffload(storedBytes, info) {
  return !!(info && info.size && storedBytes > 0 && Number(info.size) === Number(storedBytes));
}

module.exports = { hasToken, fileInfo, download, safeToOffload };
