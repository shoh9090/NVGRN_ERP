// check.js — быстрая проверка «не сломано ли» перед пушем.
// Запуск: npm run check
// 1) синтаксис всех .js (кроме node_modules), 2) компиляция всех EJS-шаблонов,
// 3) охранные правила (инварианты, которые нельзя нарушать).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.github']);
// Осиротевшие файлы в корне (загружены через веб-GitHub, никем не используются).
// Настоящие модули лежат в src/. По договорённости корневой мусор не трогаем — просто не проверяем.
const SKIP_FILES = new Set(['refs.js']);
const errors = [];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const files = walk(ROOT).filter((p) => !SKIP_FILES.has(rel(p)));
// Убираем комментарии, чтобы охранные правила не срабатывали на пояснениях в коде.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* ... */
  .replace(/^\s*\/\/.*$/gm, ' ')        // // ...
  .replace(/^\s*--.*$/gm, ' ');         // -- ... (SQL)

// ---- 1. Синтаксис JS ----
let jsCount = 0;
for (const f of files.filter((f) => f.endsWith('.js'))) {
  jsCount++;
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { errors.push('Синтаксис JS: ' + rel(f) + '\n' + String(e.stderr || e.message).trim()); }
}

// ---- 2. Компиляция EJS ----
let ejsCount = 0;
for (const f of files.filter((f) => f.endsWith('.ejs'))) {
  ejsCount++;
  try { ejs.compile(fs.readFileSync(f, 'utf8'), { filename: f }); }
  catch (e) { errors.push('Шаблон EJS: ' + rel(f) + '\n' + e.message); }
}

// ---- 3. Охранные правила (инварианты системы) ----
// Правила отражают договорённости из CLAUDE.md. Ломать их нельзя без решения владельца.
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : '');

// (а) Миграции при старте не должны удалять данные: никаких DROP TABLE / TRUNCATE.
// Проверяем db.js, схему бота и все модульные схемы src/*-schema.js.
const schemaFiles = ['src/db.js', 'tg-bot/schema.sql']
  .concat(files.filter((f) => /-schema\.js$/.test(rel(f))).map(rel));
for (const p of schemaFiles) {
  const src = stripComments(read(p));
  if (!src.trim()) continue;
  const bad = src.match(/\b(DROP\s+TABLE|TRUNCATE|DROP\s+SCHEMA)\b/i);
  if (bad) errors.push('Опасная миграция в ' + p + ': найдено «' + bad[0] + '». Стартовые миграции не должны удалять данные (только CREATE IF NOT EXISTS / ALTER ADD COLUMN IF NOT EXISTS).');
}

// (б) Секрет JWT не должен быть зашит в код.
const srv = read('server.js');
if (/JWT_SECRET\s*=\s*['"][^'"]{8,}['"]/.test(srv)) {
  errors.push('server.js: секрет JWT зашит в код. Он должен браться только из переменной окружения.');
}

// (в) Отдача файлов /file/:id обязана проверять доступ (защита персональных данных и фото претензий).
if (srv.includes("'/file/:id'") || srv.includes('"/file/:id"')) {
  const idx = Math.max(srv.indexOf("'/file/:id'"), srv.indexOf('"/file/:id"'));
  const chunk = srv.slice(idx, idx + 1600);
  if (!/req\.user|canSeeFile|requireAuth|verify/.test(chunk)) {
    errors.push('server.js: маршрут /file/:id отдаёт файлы без проверки доступа. Проверка обязательна (см. тест file-access.test.js).');
  }
}

// ---- Итог ----
console.log(`Проверено: ${jsCount} JS-файлов, ${ejsCount} EJS-шаблонов.`);
if (errors.length) {
  console.error('\n❌ Найдены проблемы (' + errors.length + '):\n');
  errors.forEach((e, i) => console.error(i + 1 + ') ' + e + '\n'));
  process.exit(1);
}
console.log('✅ Синтаксис, шаблоны и охранные правила — в порядке.');
