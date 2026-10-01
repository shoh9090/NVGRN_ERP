// ai.js — разговор с моделью: один интерфейс, два поставщика (Claude или GPT).
// Выбор — в плитке «Джарвис» (правила ai_provider/ai_model), ключи — в Railway.
//
// ГЛАВНОЕ ПРАВИЛО: считает система, а не модель. Все цифры приходят из
// инструментов (src/ai-tools.js), которые читают нашу базу с правами роли.
// Модель только понимает вопрос и пересказывает ответ словами. Поэтому она
// не может «придумать» выручку: её нет в её распоряжении.

const PROVIDERS = {
  claude: { env: 'ANTHROPIC_API_KEY', label: 'Claude', default_model: 'claude-sonnet-5' },
  openai: { env: 'OPENAI_API_KEY', label: 'GPT (OpenAI)', default_model: '' },
};
const hasKey = (p) => !!process.env[(PROVIDERS[p] || {}).env];
const MAX_STEPS = 6;          // сколько раз подряд модель может попросить инструмент
const MAX_RESULT = 12000;    // сколько текста результата влезает в один ответ модели

// Результат инструмента для модели. Раньше он обрезался посередине
// (JSON.stringify(...).slice(0, 12000)) — модель получала оборванный JSON и
// дочитывала его как придётся. Теперь, если длинно, укорачиваем САМИ ДАННЫЕ:
// длинные списки режем, остальное оставляем целым, и прямо говорим, что
// показана часть и где взять полное (задание J05).
function packResult(out) {
  let text = JSON.stringify(out);
  if (text.length <= MAX_RESULT) return text;
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const copy = { ...out };
    // Режем самые длинные массивы, пока не влезем.
    const arrays = Object.keys(copy).filter((k) => Array.isArray(copy[k]))
      .sort((a, b) => JSON.stringify(copy[b]).length - JSON.stringify(copy[a]).length);
    for (const key of arrays) {
      while (copy[key].length > 1 && JSON.stringify(copy).length > MAX_RESULT - 400) {
        copy[key] = copy[key].slice(0, Math.max(1, Math.floor(copy[key].length / 2)));
      }
      copy[`${key}_показано`] = copy[key].length;
      copy[`${key}_всего`] = (out[key] || []).length;
    }
    copy.часть_данных = 'Список сокращён, чтобы влезть в ответ. Итоги и цифры выше посчитаны по ВСЕМ строкам. '
      + 'Полный список — в файле Excel.';
    text = JSON.stringify(copy);
    if (text.length <= MAX_RESULT) return text;
  }
  // Крайний случай: отдаём честное объяснение вместо обрывка.
  return JSON.stringify({
    статус: 'результат слишком большой',
    пояснение: 'Данные получены, но не помещаются в ответ. Сузьте период или фильтр, либо попросите файл Excel.',
  });
}

const TIMEOUT_MS = 60000;

async function post(url, headers, body) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data.error && (data.error.message || data.error.type)) || ('код ' + r.status);
    throw new Error('Модель не ответила: ' + String(msg).slice(0, 200));
  }
  return data;
}

// Шаги кончились. Молчать про собранное нельзя: человек должен понимать, что
// успели, а что нет, иначе «спросите конкретнее» выглядит отпиской (J05).
function outOfSteps(used) {
  const names = [...new Set(used)].filter((x) => x && x !== 'интернет');
  return 'Собрал не всё: запрос оказался слишком большим для одного захода.'
    + (names.length ? ` Успел поднять: ${names.join(', ')}.` : '')
    + ' Давайте сузим — назовите один период или один разрез, и я досчитаю.';
}

// --- Claude (Messages API) ---
async function askClaude({ model, system, messages, tools, runTool, onStep, web }) {
  const url = 'https://api.anthropic.com/v1/messages';
  // Ключ служебной учётки не привязан к рабочему пространству — Anthropic
  // требует назвать его отдельным заголовком (ANTHROPIC_WORKSPACE_ID в Railway).
  // Ключ, созданный внутри пространства, работает и без него.
  const headers = { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
  if (process.env.ANTHROPIC_WORKSPACE_ID) headers['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID;
  const defs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  // Поиск в интернете — серверный инструмент Anthropic: ходит сам, отдельный
  // ключ не нужен. Это СПРАВКА со ссылкой, а не данные компании (решение Шоха).
  if (web) defs.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
  const msgs = messages.slice();
  const used = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await post(url, headers, { model, max_tokens: 2000, system, messages: msgs, tools: defs });
    // Долгий поиск модель ставит на паузу и просит продолжить — продолжаем.
    if (data.stop_reason === 'pause_turn') {
      msgs.push({ role: 'assistant', content: data.content });
      if (!used.includes('интернет')) used.push('интернет');
      continue;
    }
    if ((data.content || []).some((c) => c.type === 'web_search_tool_result' || c.type === 'server_tool_use')) {
      if (!used.includes('интернет')) used.push('интернет');
    }
    const calls = (data.content || []).filter((c) => c.type === 'tool_use');
    if (!calls.length) {
      const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      return { text, used, usage: data.usage || {} };
    }
    msgs.push({ role: 'assistant', content: data.content });
    const results = [];
    for (const c of calls) {
      used.push(c.name);
      if (onStep) onStep(c.name);
      const out = await runTool(c.name, c.input || {});
      results.push({ type: 'tool_result', tool_use_id: c.id, content: packResult(out) });
    }
    msgs.push({ role: 'user', content: results });
  }
  return { text: outOfSteps(used), used, usage: {} };
}

// --- OpenAI (Chat Completions) ---
async function askOpenAI({ model, system, messages, tools, runTool, onStep }) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const headers = { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY };
  const defs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  // У Claude содержимое блоками, у GPT — строкой: приводим историю к простому виду.
  const msgs = [{ role: 'system', content: system }].concat(messages.map((m) => ({
    role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  })));
  const used = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await post(url, headers, { model, messages: msgs, tools: defs });
    const m = ((data.choices || [])[0] || {}).message || {};
    const calls = m.tool_calls || [];
    if (!calls.length) return { text: String(m.content || '').trim(), used, usage: data.usage || {} };
    msgs.push(m);
    for (const c of calls) {
      const name = c.function && c.function.name;
      used.push(name);
      if (onStep) onStep(name);
      let args = {};
      try { args = JSON.parse((c.function && c.function.arguments) || '{}'); } catch (e) { args = {}; }
      const out = await runTool(name, args);
      msgs.push({ role: 'tool', tool_call_id: c.id, content: packResult(out) });
    }
  }
  return { text: outOfSteps(used), used, usage: {} };
}

// Единый вход. provider: 'claude' | 'openai'.
async function ask(provider, opts) {
  const p = PROVIDERS[provider] ? provider : 'claude';
  if (!hasKey(p)) throw new Error(`В Railway нет ключа ${PROVIDERS[p].env} — ИИ не подключён`);
  const model = String(opts.model || '').trim() || PROVIDERS[p].default_model;
  if (!model) throw new Error('Не задана модель — впишите её в плитке «Джарвис»');
  const args = { ...opts, model };
  return p === 'openai' ? askOpenAI(args) : askClaude(args);
}

module.exports = { ask, hasKey, PROVIDERS };
// Открыто для теста: обрыв JSON посередине — молчаливая порча данных.
module.exports.packResult = packResult;
