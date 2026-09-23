// stt.js — распознавание речи: голосовое в Telegram → текст.
//
// Зачем отдельный поставщик: Claude звук не слушает. Берём распознавание
// OpenAI (ключ OPENAI_API_KEY в Railway) — оно дешёвое (около 0,6 цента за
// минуту) и хорошо понимает русский. Узбекский понимает хуже, поэтому в боте
// мы ВСЕГДА показываем расшифровку: человек видит, что его услышали неверно,
// и может поправить, а не получает ответ на выдуманный вопрос.

const MAX_SECONDS = 180;              // длиннее — это не вопрос, а разговор
const MAX_BYTES = 20 * 1024 * 1024;   // ограничение Telegram на скачивание файла

const configured = () => !!process.env.OPENAI_API_KEY;

// Скачиваем голосовое у Telegram: сначала путь к файлу, потом сам файл.
async function downloadVoice(botToken, fileId) {
  const r = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok || !d.result || !d.result.file_path) throw new Error('Telegram не отдал файл');
  if (Number(d.result.file_size) > MAX_BYTES) throw new Error('Слишком большой файл');
  const f = await fetch(`https://api.telegram.org/file/bot${botToken}/${d.result.file_path}`,
    { signal: AbortSignal.timeout(60000) });
  if (!f.ok) throw new Error('Не удалось скачать запись');
  return { buf: Buffer.from(await f.arrayBuffer()), name: d.result.file_path.split('/').pop() || 'voice.ogg' };
}

// Расшифровка. language не задаём: человек может говорить и по-русски,
// и по-узбекски, и вперемешку — пусть распознаватель решает сам.
async function transcribe(buf, name, model) {
  if (!configured()) throw new Error('В Railway нет OPENAI_API_KEY — голос не распознать');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/ogg' }), name);
  form.append('model', String(model || 'whisper-1'));
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: form,
    signal: AbortSignal.timeout(90000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (d.error && d.error.message) || ('код ' + r.status);
    throw new Error('Не удалось распознать: ' + String(msg).slice(0, 150));
  }
  return String(d.text || '').trim();
}

// Всё вместе: из сообщения Telegram получаем текст.
async function voiceToText(botToken, voice, model) {
  if (Number(voice.duration) > MAX_SECONDS) {
    throw new Error(`Запись длиннее ${Math.round(MAX_SECONDS / 60)} минут — скажите короче`);
  }
  const { buf, name } = await downloadVoice(botToken, voice.file_id);
  return transcribe(buf, name, model);
}

module.exports = { configured, voiceToText, transcribe, MAX_SECONDS };
