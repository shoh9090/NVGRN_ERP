// cash.js — модуль «Касса»: единый журнал транзакций, справочники, отчёты.
// Принцип: деньги вносятся один раз (импорт выписки + ручной ввод), отчёты считаются сами.
// Переводы между кошельками — отдельный тип, вне доходов/расходов (защита от двойного счёта).
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const integrations = require('./integrations');
const pfin = require('./purchase-finance'); // общий расчёт долга поставщикам (read-only в «Обязательствах»)

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

// Объявляем заранее — используются как middleware при регистрации маршрутов ниже.
const J = express.json();
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : parseInt(v, 10));
// Право вести Кассу/Обязательства: администратор ИЛИ роль «Финансы/Бухгалтерия».
const canFin = (req) => !!(req.user && (req.user.isAdmin || req.user.isFinance));
const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// Подбор статьи по ключевым словам для одной строки текста (Наличная касса, ввод в реальном времени) —
// та же семантика фраз, что и в пакетном авто-разборе runRelink(), но синхронно для одного текста.
async function guessCategoryByKeyword(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  const cats = (await db.pool.query(
    "SELECT id, keywords FROM cash_categories WHERE status='active' AND keywords IS NOT NULL AND keywords<>'' ORDER BY sort_order")).rows;
  for (const c of cats) {
    const phrases = String(c.keywords).split(/[,\n;|]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
    for (const ph of phrases) if (lower.includes(ph)) return c.id;
  }
  return null;
}

// Группа статей «Сырьё» — по ней наличный расход по умолчанию считается выдачей снабженцу под отчёт.
const SIRYE_GROUP = '1. Сырьё и переменные затраты';
async function siryeCatIdSet() {
  const rows = (await db.pool.query("SELECT id FROM cash_categories WHERE group_name=$1", [SIRYE_GROUP])).rows;
  return new Set(rows.map((r) => r.id));
}

// ---------- Схема и сидирование (идемпотентно) ----------
let _ready = false;
async function ensureCashSchema() {
  if (_ready) return;
  const q = (sql) => db.pool.query(sql);

  await q(`CREATE TABLE IF NOT EXISTS cash_wallets (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'bank',        -- bank | card | cash | reserve
    account_no TEXT,
    color TEXT DEFAULT '#163a28',
    sort_order INT NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active'      -- active | archived
  )`);

  await q(`CREATE TABLE IF NOT EXISTS cash_categories (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    group_name TEXT,
    flow_type TEXT NOT NULL DEFAULT 'operating', -- operating | investing | financing
    direction_hint TEXT,                          -- in | out | transfer
    only_transfer BOOLEAN NOT NULL DEFAULT false,
    sort_order INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
  )`);

  await q(`CREATE TABLE IF NOT EXISTS cash_counterparties (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    inn TEXT,
    bank_code TEXT,                               -- код контрагента из выписки (ключ автоклассификации)
    default_category_id INT REFERENCES cash_categories(id),
    linked_supplier_id INT,                       -- связь с поставщиком Закупа (ref_counterparties.id)
    comment TEXT,
    status TEXT NOT NULL DEFAULT 'active'
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cash_cp_bankcode ON cash_counterparties (bank_code)`);
  await q(`ALTER TABLE cash_counterparties ADD COLUMN IF NOT EXISTS cp_role TEXT`); // null=поставщик/прочее, 'client'=клиент из SD
  await q(`ALTER TABLE cash_counterparties ADD COLUMN IF NOT EXISTS firm_name TEXT`); // юр.лицо (для клиентов из SD)
  await q(`ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS keywords TEXT`); // ключевые слова/фразы для авто-классификации
  await q(`CREATE INDEX IF NOT EXISTS idx_cash_cp_inn ON cash_counterparties (inn)`);

  await q(`CREATE TABLE IF NOT EXISTS cash_contracts (
    id SERIAL PRIMARY KEY,
    counterparty_id INT REFERENCES cash_counterparties(id),
    number TEXT,
    subject TEXT,
    category_id INT REFERENCES cash_categories(id),
    amount NUMERIC,
    date_start DATE,
    date_end DATE,
    status TEXT NOT NULL DEFAULT 'active'
  )`);

  await q(`CREATE TABLE IF NOT EXISTS cash_import_batches (
    id SERIAL PRIMARY KEY,
    wallet_id INT REFERENCES cash_wallets(id),
    filename TEXT,
    count INT DEFAULT 0,
    created_by INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS cash_transactions (
    id SERIAL PRIMARY KEY,
    tx_date DATE NOT NULL,
    amount NUMERIC NOT NULL,
    tx_type TEXT NOT NULL,                        -- in | out | transfer
    wallet_id INT REFERENCES cash_wallets(id),
    wallet_to_id INT REFERENCES cash_wallets(id), -- только для transfer
    counterparty_id INT REFERENCES cash_counterparties(id),
    contract_id INT REFERENCES cash_contracts(id),
    category_id INT REFERENCES cash_categories(id),
    purpose TEXT,
    bank_doc_no TEXT,
    source TEXT NOT NULL DEFAULT 'manual',        -- import | manual
    import_batch_id INT REFERENCES cash_import_batches(id),
    is_classified BOOLEAN NOT NULL DEFAULT false,
    created_by INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cash_tx_date ON cash_transactions (tx_date)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cash_tx_wallet ON cash_transactions (wallet_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cash_tx_cat ON cash_transactions (category_id)`);
  // Плательщик/получатель из выписки (для столбца «От кого» и сопоставления по ИНН).
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS payer_name TEXT`);
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS payer_inn TEXT`);
  // Валюта операции (вкладка «Наличная касса»): amount всегда хранит сум-эквивалент —
  // на нём как и раньше работают все расчёты баланса/отчётов без изменений.
  // currency/fx_rate/fx_amount — только для отображения истории и прозрачности конверсии.
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'UZS'`);
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS fx_rate NUMERIC`);
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS fx_amount NUMERIC`);
  // Перевод банк→касса, где ещё не подтверждена реальная сумма прихода (обналичивание с комиссией,
  // которая станет известна только когда бухгалтер физически пересчитает наличные).
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS needs_cash_confirm BOOLEAN NOT NULL DEFAULT false`);
  // Ссылка производной строки на родительский перевод-обнал (доллары/конверсия/комиссия при подтверждении).
  // Нужна, чтобы в «Наличной кассе» свернуть обнал в один «факт»-ряд (реестр не меняем).
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS parent_tx_id INT`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cash_tx_parent ON cash_transactions (parent_tx_id)`);
  // Флаг «скрыто из выпадашек отчёта» (только визуально; суммы отчёта и баланс не меняются).
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS report_hidden BOOLEAN NOT NULL DEFAULT false`);
  // Связка двух «ног» перевода банк↔банк (у обоих счетов своя выписка): out в банке-А и in в банке-Б —
  // это один перевод. Обе ноги двигают только свой кошелёк и исключены из прихода/расхода отчёта.
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS transfer_group_id INT`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cash_tx_tgroup ON cash_transactions (transfer_group_id)`);
  // Наличный расход «выдача снабженцу под отчёт» (галочка в Наличной кассе). По умолчанию включается
  // при импорте/вводе для расходов группы «Сырьё». Остаток подотчёта = выдано − оплачено поставщикам налом.
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS is_supply_advance BOOLEAN NOT NULL DEFAULT false`);
  // Платёж по кредиту скрыт из «к разнесению» (уже разнесён/отмечен оплаченным исторически).
  await q(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS obl_dismissed BOOLEAN NOT NULL DEFAULT false`);
  // «К оплате»: наличные долги, которые надо выплатить. Хранятся ОТДЕЛЬНО и не влияют на остаток/ДДС,
  // пока не выплачены. При выплате создаётся обычный расход в Кассе (paid_tx_id), долг закрывается.
  await q(`CREATE TABLE IF NOT EXISTS cash_pending_payments (
    id SERIAL PRIMARY KEY,
    wallet_id INT REFERENCES cash_wallets(id),
    amount NUMERIC NOT NULL,
    category_id INT REFERENCES cash_categories(id),
    purpose TEXT,
    due_date DATE,
    status TEXT NOT NULL DEFAULT 'pending',       -- pending | paid
    paid_tx_id INT, paid_date DATE,
    created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Есть ли у кошелька своя выписка (банки — да, наличная касса — нет). Определяет форму разбора А2:
  // получатель с выпиской → пара ног; получатель без выписки (касса) → одиночный transfer.
  await q(`ALTER TABLE cash_wallets ADD COLUMN IF NOT EXISTS has_statement BOOLEAN NOT NULL DEFAULT true`);
  await q(`UPDATE cash_wallets SET has_statement=false WHERE kind='cash'`);

  await q(`CREATE TABLE IF NOT EXISTS cash_fx_rates (
    rate_date DATE PRIMARY KEY,
    usd_rate NUMERIC NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS cash_groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INT NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active'
  )`);
  await seedGroups();
  await seedCategories();
  await seedWallets();
  // Коды 100/110/111 — перемещения между своими счетами (не доход/расход): межбанк, обнал, пополнение карты.
  await db.pool.query("UPDATE cash_categories SET direction_hint='transfer', only_transfer=true WHERE code IN ('100','110','111')");
  await db.pool.query("UPDATE cash_categories SET direction_hint='in' WHERE code IN ('200','201','202','203') AND (direction_hint IS NULL OR direction_hint='')");
  await seedSupplierCashCats();
  await seedCashCounterparties();
  await seedCategoryKeywords();
  // Разовый бэкфилл: наличные расходы «Сырьё» с даты запуска учёта (17.07.2026) — отметить выдачей
  // снабженцу (is_supply_advance). Один раз (через настройку), чтобы не перетирать ручные снятия галочки.
  try {
    const st = await db.getSettings();
    if (!st.supply_advance_backfill_v1) {
      const siryeIds = [...(await siryeCatIdSet())];
      if (siryeIds.length) {
        await db.pool.query(
          `UPDATE cash_transactions t SET is_supply_advance=true FROM cash_wallets w
             WHERE t.wallet_id=w.id AND w.kind='cash' AND t.tx_type='out'
               AND t.category_id = ANY($1) AND t.tx_date >= '2026-07-17'
               AND COALESCE(t.is_supply_advance,false)=false`, [siryeIds]);
      }
      await db.setSetting('supply_advance_backfill_v1', 'done');
    }
  } catch (e) { /* бэкфилл необязателен */ }
  // Разовая правка: «Пополнение корпоративной пластиковой карты» — это статья 111 (Пополнение карты),
  // а не 100 (Межбанк). Переносим ключевые слова в 111 и переклассифицируем уже загруженные строки.
  try {
    const st2 = await db.getSettings();
    if (!st2.card_topup_kw_v1) {
      await db.pool.query("UPDATE cash_categories SET keywords='перевод между счет, переброска, на основной расчётный счёт, между счетами' WHERE code='100'");
      await db.pool.query("UPDATE cash_categories SET keywords='пополнение корпоративн, корпоративной пластиковой, пополнение пластиков, пополнение карт' WHERE code='111'");
      await db.pool.query(
        `UPDATE cash_transactions t SET category_id = c111.id, is_classified=true
           FROM cash_categories c100, cash_categories c111
          WHERE c100.code='100' AND c111.code='111'
            AND t.category_id = c100.id
            AND (t.purpose ILIKE '%пластиков%' OR t.purpose ILIKE '%пополнение корпоративн%')`);
      await db.setSetting('card_topup_kw_v1', 'done');
    }
  } catch (e) { /* правка необязательна */ }
  _ready = true;
}

// Ключевые слова по умолчанию для авто-классификации по назначению/«от кого».
// Ставим только там, где ещё не заполнено — ручные правки Шоха не трогаем.
async function seedCategoryKeywords() {
  const defs = {
    '100': 'перевод между счет, переброска, на основной расчётный счёт, между счетами',
    '111': 'пополнение корпоративн, корпоративной пластиковой, пополнение пластиков, пополнение карт',
    '62': 'начислен, % банка, комиссия банк, оп.обс',
    '60': 'проценты по кредит, процент за кредит',
    '61': 'погашение кредит, возврат кредит',
    '66': 'ндс, qqs',
    '65': 'налог от зп, инпс, есп',
    '67': 'налог на прибыль',
    '52': 'страхов',
    '23': 'электр',
    '22': 'за воду, водоснаб',
    '42': 'интернет, связь, telekom, телеком',
  };
  for (const [code, kw] of Object.entries(defs)) {
    await db.pool.query("UPDATE cash_categories SET keywords=$1 WHERE code=$2 AND (keywords IS NULL OR keywords='')", [kw, code]).catch(() => {});
  }
}

// Разовая загрузка контрагентов из справочника (поставщики + админ-расходы) в Кассу.
// Если контрагента с таким ИНН ещё нет — создаём карточку с кодом ДДС.
// Если есть, но без статьи — проставляем. Ручные карточки/статьи не трогаем. Идемпотентно.
async function seedCashCounterparties() {
  let map;
  try { map = require('./data/cash_counterparties_seed.json'); } catch (e) { return; }
  const entries = Object.entries(map || {});
  if (!entries.length) return;
  const codeToCat = {};
  (await db.pool.query("SELECT id, code FROM cash_categories WHERE status='active'")).rows.forEach((c) => { codeToCat[String(c.code)] = c.id; });
  for (const [inn, v] of entries) {
    // Банкам НЕ ставим статью по умолчанию: банк как контрагент бывает и у комиссий (62),
    // и у сквозных платежей физлицам — статью решают ключевые слова/ручной выбор.
    const catId = BANK_INNS.includes(String(inn)) ? null : (codeToCat[String(v.code)] || null);
    const ex = await db.pool.query("SELECT id, default_category_id FROM cash_counterparties WHERE inn=$1 AND (cp_role IS DISTINCT FROM 'client') LIMIT 1", [inn]);
    if (ex.rows.length) {
      if (ex.rows[0].default_category_id == null && catId) {
        await db.pool.query('UPDATE cash_counterparties SET default_category_id=$1 WHERE id=$2', [catId, ex.rows[0].id]);
      }
    } else {
      await db.pool.query(
        "INSERT INTO cash_counterparties (name, inn, default_category_id, status) VALUES ($1,$2,$3,'active')",
        [v.name, inn, catId]);
    }
  }
  // Чистим статью по умолчанию у банков (если раньше проставилась 62).
  if (BANK_INNS.length) await db.pool.query('UPDATE cash_counterparties SET default_category_id=NULL WHERE inn = ANY($1)', [BANK_INNS]).catch(() => {});
}
// ИНН собственных обслуживающих банков — их операции не классифицируем по контрагенту.
const BANK_INNS = ['207018693', '310331793']; // Asia Alliance, Hayot

// Переброска между своими счетами: если плательщик/получатель в выписке — собственное юрлицо
// (по ИНН или по названию), либо назначение — «переброска / на основной расчётный счёт / между
// счетами» — это НЕ выручка/расход, а перевод (статья 100 «Межбанк»). Классифицируем на входе,
// чтобы Шоху не приходилось каждый раз вручную помечать переброску и указывать «Куда».
const OWN_INNS = []; // ИНН собственных юрлиц — заполнить при необходимости (усилит распознавание)
const OWN_NAME_RE = /novagreen|новагрин|нова\s*грин/i; // своё юрлицо в выписке
// ВАЖНО: \w в JS не матчит кириллицу — используем явный кириллический класс [а-яё].
const INTERNAL_XFER_RE = /переброск|между\s+сч[её]т|основн[а-яё]*\s+расч[её]т[а-яё]*\s+сч[её]т|\ba2a\b/i;
// Зарплата/аванс/налоги/проценты — это НЕ переброска между своими счетами, даже если плательщик
// в выписке — своё юрлицо. Такие назначения не классифицируем как «Межбанк».
const NOT_XFER_RE = /аванс|зарплат|заработн|\bзп\b|премия|подотч|налог|процент|погашен|кредит|аренд/i;
function isOwnTransfer(purpose, payerName, inn) {
  if (NOT_XFER_RE.test(String(purpose || ''))) return false;
  if (inn && OWN_INNS.includes(String(inn).trim())) return true;
  if (payerName && OWN_NAME_RE.test(payerName)) return true;
  return INTERNAL_XFER_RE.test(String(purpose || ''));
}

// Разовое заполнение статьи ДДС у поставщиков Закупа из справочника ИНН→код
// (только там, где ещё не задано вручную — ручные значения не перетираем).
async function seedSupplierCashCats() {
  let map;
  try { map = require('./data/cash_inn_categories.json'); } catch (e) { return; }
  const entries = Object.entries(map || {});
  if (!entries.length) return;
  const vals = [], params = [];
  entries.forEach(([inn, code], i) => { params.push(inn, code); vals.push(`($${i * 2 + 1}::text,$${i * 2 + 2}::text)`); });
  try {
    await db.pool.query(
      `UPDATE ref_counterparties rc SET cash_category_id = cc.id
       FROM (VALUES ${vals.join(',')}) AS m(inn, code)
       JOIN cash_categories cc ON cc.code = m.code
       WHERE rc.inn = m.inn AND rc.cash_category_id IS NULL`, params);
  } catch (e) { /* таблица Закупа может отсутствовать/отличаться */ }
}

async function seedGroups() {
  const G = ['1. Сырьё и переменные затраты', '2. Производственные затраты', '3. Продажи и маркетинг',
    '4. Административные расходы', '5. Логистика', '6. Финансы', '7. Капекс (инвестиции)', '8. Прочее'];
  await db.pool.query("INSERT INTO cash_groups (name, sort_order) VALUES ('Доходы и поступления', 5) ON CONFLICT (name) DO NOTHING");
  let i = 0;
  for (const name of G) { i += 10; await db.pool.query('INSERT INTO cash_groups (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, i + 10]); }
}

// Классификатор статей ДДС (Приложение А). flow: 1-5,8 operating; 6 financing; 7 investing. * → only_transfer.
async function seedCategories() {
  const G1 = '1. Сырьё и переменные затраты', G2 = '2. Производственные затраты', G3 = '3. Продажи и маркетинг',
        G4 = '4. Административные расходы', G5 = '5. Логистика', G6 = '6. Финансы', G7 = '7. Капекс (инвестиции)', G8 = '8. Прочее',
        GINC = 'Доходы и поступления';
  const CATS = [
    ['200', 'Выручка от продаж', GINC, 'operating', false],
    ['201', 'Взносы учредителей', GINC, 'financing', false],
    ['202', 'Получение кредита', GINC, 'financing', false],
    ['203', 'Финансовый заём', GINC, 'financing', false],
    ['10', 'Сырьё (зелень)', G1, 'operating', false],
    ['11', 'Упаковка', G1, 'operating', false],
    ['12', 'Расходники производства (перчатки и т.д.)', G1, 'operating', false],
    ['20', 'ЗП производство', G2, 'operating', false],
    ['21', 'Ремонт оборудования и наладка, мелкие запчасти', G2, 'operating', false],
    ['22', 'Вода', G2, 'operating', false],
    ['23', 'Электричество', G2, 'operating', false],
    ['24', 'Вывоз мусора', G2, 'operating', false],
    ['30', 'SMM + реклама', G3, 'operating', false],
    ['31', 'POSM материалы (шелфы + воблеры)', G3, 'operating', false],
    ['32', 'Холодильники торговые', G3, 'operating', false],
    ['40', 'Зарплата офиса', G4, 'operating', false],
    ['41', 'Аренда', G4, 'operating', false],
    ['42', 'Интернет / связь', G4, 'operating', false],
    ['43', 'Канцелярия', G4, 'operating', false],
    ['44', 'Мебель (частично, если мелкое)', G4, 'operating', false],
    ['45', 'Расходники (тряпки + чист. ср-ва) + картриджи', G4, 'operating', false],
    ['46', 'Возмещение расходов, обмен ГП, брак, прочие расходы', G4, 'operating', false],
    ['47', 'Эл.док, вакансии, картридж, 1С', G4, 'operating', false],
    ['48', 'Сертификация', G4, 'operating', false],
    ['50', 'Топливо (газ/бензин)', G5, 'operating', false],
    ['51', 'Ремонт авто', G5, 'operating', false],
    ['52', 'Страховка', G5, 'operating', false],
    ['53', 'Доставка и такси', G5, 'operating', false],
    ['60', 'Проценты по кредитам', G6, 'financing', false],
    ['61', 'Возврат кредитов', G6, 'financing', false],
    ['62', '% банка', G6, 'financing', true],
    ['63', 'Возврат долгов', G6, 'financing', false],
    ['64', '% расход наличку', G6, 'financing', false],
    ['65', 'Налоги от ЗП', G6, 'financing', true],
    ['66', 'НДС', G6, 'financing', true],
    ['67', 'Налог на прибыль', G6, 'financing', true],
    ['68', 'Др. налоги', G6, 'financing', true],
    ['69', 'Резервный счёт', G6, 'financing', false],
    ['89', 'Счёт Хаёт банка', G6, 'financing', false],
    ['79', 'Корпоративная карта', G6, 'financing', false],
    ['70', 'Оборудование + офисное оборудование', G7, 'investing', false],
    ['71', 'Стеллажи', G7, 'investing', false],
    ['72', 'Стройка', G7, 'investing', false],
    ['80', 'День рождения', G8, 'operating', false],
    ['81', 'Питание «базар»', G8, 'operating', false],
    ['82', 'Проект уксус', G8, 'operating', false],
    ['100', 'Межбанк (перевод между счетами)', G8, 'operating', true],
    ['110', 'Перевод в наличную кассу', G8, 'operating', true],
    ['111', 'Пополнение карты', G8, 'operating', true],
    ['101', 'Корректировка остатка', G8, 'operating', false],
    ['102', 'Конверсия валюты', G8, 'operating', false],
  ];
  let i = 0;
  for (const [code, name, grp, flow, onlyT] of CATS) {
    i += 10;
    // При обновлении НЕ трогаем name/group_name/sort_order/status — это правки пользователя
    // (переименования, перегруппировки, порядок). Обновляем только служебные поля потока.
    await db.pool.query(
      `INSERT INTO cash_categories (code, name, group_name, flow_type, only_transfer, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET flow_type=EXCLUDED.flow_type, only_transfer=EXCLUDED.only_transfer`,
      [code, name, grp, flow, onlyT, i]
    );
  }
}

// Кошельки — стартовые заглушки (только если справочник пуст; названия уточнит пользователь).
async function seedWallets() {
  const ex = await db.pool.query('SELECT 1 FROM cash_wallets LIMIT 1');
  if (ex.rows.length) return;
  const W = [
    ['Расчётный счёт Хаёт-банк', 'bank', '#163a28', 10],
    ['Расчётный счёт (второй банк)', 'bank', '#0d5aa7', 20],
    ['Резервный счёт', 'reserve', '#6a4fb6', 30],
    ['Пластиковая карта', 'card', '#c77800', 40],
    ['Наличная касса', 'cash', '#2e7d32', 50],
  ];
  for (const [name, kind, color, sort] of W) {
    await db.pool.query('INSERT INTO cash_wallets (name, kind, color, sort_order) VALUES ($1,$2,$3,$4)', [name, kind, color, sort]);
  }
}

router.use(async (req, res, next) => {
  try { await ensureCashSchema(); next(); }
  catch (e) { next(e); }
});

// ---------- Страница ----------
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('cash', { settings, user: req.user });
});

// ---------- Справочники (для SPA) ----------
router.get('/api/dicts', async (req, res) => {
  const wallets = (await db.pool.query("SELECT * FROM cash_wallets WHERE status='active' ORDER BY sort_order, id")).rows;
  // Порядок статей ДДС — всегда по коду (стабильный, стандартный), не зависит от sort_order
  // (который у части статей сбит: у засеянных инкремент, у отредактированных = код).
  const categories = (await db.pool.query(
    "SELECT * FROM cash_categories WHERE status='active' ORDER BY (CASE WHEN code ~ '^[0-9]+$' THEN code::int ELSE 999999 END), code, id")).rows;
  const groups = (await db.pool.query("SELECT * FROM cash_groups WHERE status='active' ORDER BY sort_order, id")).rows;
  const counterparties = (await db.pool.query(
    `SELECT c.*, cat.code AS cat_code, cat.name AS cat_name
     FROM cash_counterparties c LEFT JOIN cash_categories cat ON cat.id = c.default_category_id
     WHERE c.status='active' AND (c.cp_role IS DISTINCT FROM 'client') ORDER BY c.name`)).rows;
  const clientsCount = Number((await db.pool.query("SELECT count(*) n FROM cash_counterparties WHERE cp_role='client' AND status='active'")).rows[0].n);
  const settings = await db.getSettings();
  const clientsSyncedAt = settings.cash_clients_synced_at || null;
  const contracts = (await db.pool.query(
    `SELECT k.*, cp.name AS cp_name, cat.code AS cat_code, cat.name AS cat_name
     FROM cash_contracts k
     LEFT JOIN cash_counterparties cp ON cp.id = k.counterparty_id
     LEFT JOIN cash_categories cat ON cat.id = k.category_id
     ORDER BY k.id DESC`)).rows;
  let suppliers = [];
  try { suppliers = (await db.pool.query('SELECT id, name FROM ref_counterparties ORDER BY name LIMIT 2000')).rows; } catch (e) { /* справочника может не быть */ }
  res.json({ wallets, categories, groups, counterparties, contracts, suppliers, clientsCount, clientsSyncedAt });
});

// Синхронизация клиентов из SalesDoctor (контрагенты-клиенты для привязки приходов).
router.post('/api/sync-clients', async (req, res) => {
  try {
    const r = await integrations.syncCashClients();
    await db.setSetting('cash_clients_synced_at', new Date().toISOString());
    try { await runRelink(); } catch (e) { /* авто-разбор не критичен */ }
    await db.log(req.user.id, 'cash_sync_clients', String(r.total));
    res.json({ ok: true, created: r.created, updated: r.updated, total: r.total });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Список клиентов (по запросу — в общий справочник не лезут).
router.get('/api/clients', async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = []; let w = "cp_role='client' AND status='active'";
  if (q) { params.push('%' + q + '%'); w += ' AND (name ILIKE $1 OR firm_name ILIKE $1 OR inn ILIKE $1)'; }
  const rows = (await db.pool.query(`SELECT id, name, firm_name, inn FROM cash_counterparties WHERE ${w} ORDER BY name LIMIT 500`, params)).rows;
  res.json({ items: rows });
});

// Объединённый список для вкладки «Поставщики и прочие»:
// поставщики берутся из Закупа (единый источник), плюс «прочие» из Кассы (банки/налоги),
// которых нет в Закупе (дедуп по ИНН). Клиенты SD сюда не входят.
router.get('/api/suppliers-view', async (req, res) => {
  let suppliers = [];
  try {
    suppliers = (await db.pool.query(
      `SELECT c.id, COALESCE(NULLIF(c.legal_name,''), c.name) AS name, c.inn, c.phone,
              c.cash_category_id AS cat_id, cc.code AS cat_code, cc.name AS cat_name
       FROM ref_counterparties c
       LEFT JOIN cash_categories cc ON cc.id = c.cash_category_id
       WHERE c.role_supplier = TRUE AND c.status = 'active'
       ORDER BY name`)).rows.map((r) => ({ ...r, source: 'purchase' }));
  } catch (e) { /* Закупа может не быть */ }
  const supInns = new Set(suppliers.map((s) => String(s.inn || '').trim()).filter(Boolean));
  const others = (await db.pool.query(
    `SELECT k.id, k.name, k.inn, k.bank_code, k.comment, k.default_category_id,
            k.default_category_id AS cat_id, cat.code AS cat_code, cat.name AS cat_name
     FROM cash_counterparties k LEFT JOIN cash_categories cat ON cat.id = k.default_category_id
     WHERE k.status = 'active' AND (k.cp_role IS DISTINCT FROM 'client')
     ORDER BY k.name`)).rows
    .filter((r) => !supInns.has(String(r.inn || '').trim()))
    .map((r) => ({ ...r, source: 'cash' }));
  res.json({ suppliers, others });
});

router.post('/api/group', J, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Введите название группы' });
  try {
    if (b.id) await db.pool.query('UPDATE cash_groups SET name=$1, sort_order=$2 WHERE id=$3', [String(b.name).trim(), parseInt(b.sort_order) || 100, b.id]);
    else await db.pool.query('INSERT INTO cash_groups (name, sort_order) VALUES ($1,$2)', [String(b.name).trim(), parseInt(b.sort_order) || 100]);
  } catch (e) { return res.status(400).json({ error: 'Такая группа уже есть или ошибка' }); }
  await db.log(req.user.id, 'cash_group_save', String(b.name));
  res.json({ ok: true });
});
router.post('/api/group/:id(\\d+)/archive', async (req, res) => { await db.pool.query("UPDATE cash_groups SET status='archived' WHERE id=$1", [req.params.id]); res.json({ ok: true }); });

router.post('/api/category/:id(\\d+)/delete', async (req, res) => {
  const id = req.params.id;
  const used = (await db.pool.query(
    'SELECT 1 FROM cash_transactions WHERE category_id=$1 UNION ALL SELECT 1 FROM cash_contracts WHERE category_id=$1 UNION ALL SELECT 1 FROM cash_counterparties WHERE default_category_id=$1 LIMIT 1', [id])).rowCount;
  if (used) return res.status(400).json({ error: 'Статья используется (транзакции/договоры/контрагенты). Можно отправить в архив.' });
  await db.pool.query('DELETE FROM cash_categories WHERE id=$1', [id]);
  await db.log(req.user.id, 'cash_category_delete', '#' + id);
  res.json({ ok: true });
});

// ---------- Управление справочниками ----------

router.post('/api/wallet', J, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Введите название' });
  const kind = ['bank', 'card', 'cash', 'reserve'].includes(b.kind) ? b.kind : 'bank';
  const args = [String(b.name).trim(), kind, b.account_no || null, b.color || '#163a28', parseInt(b.sort_order) || 100];
  if (b.id) await db.pool.query('UPDATE cash_wallets SET name=$1, kind=$2, account_no=$3, color=$4, sort_order=$5 WHERE id=$6', [...args, b.id]);
  else await db.pool.query('INSERT INTO cash_wallets (name, kind, account_no, color, sort_order) VALUES ($1,$2,$3,$4,$5)', args);
  await db.log(req.user.id, 'cash_wallet_save', String(b.name));
  res.json({ ok: true });
});
router.post('/api/wallet/:id(\\d+)/archive', async (req, res) => { await db.pool.query("UPDATE cash_wallets SET status='archived' WHERE id=$1", [req.params.id]); res.json({ ok: true }); });

router.post('/api/category', J, async (req, res) => {
  const b = req.body || {};
  if (!b.code || !String(b.code).trim()) return res.status(400).json({ error: 'Введите код' });
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Введите название' });
  const ft = ['operating', 'investing', 'financing'].includes(b.flow_type) ? b.flow_type : 'operating';
  const args = [String(b.code).trim(), String(b.name).trim(), b.group_name || null, ft, !!b.only_transfer, parseInt(b.sort_order) || 0, (b.keywords != null ? String(b.keywords).trim() : null) || null];
  try {
    if (b.id) await db.pool.query('UPDATE cash_categories SET code=$1, name=$2, group_name=$3, flow_type=$4, only_transfer=$5, sort_order=$6, keywords=$7 WHERE id=$8', [...args, b.id]);
    else await db.pool.query('INSERT INTO cash_categories (code, name, group_name, flow_type, only_transfer, sort_order, keywords) VALUES ($1,$2,$3,$4,$5,$6,$7)', args);
  } catch (e) { return res.status(400).json({ error: 'Такой код уже есть или ошибка: ' + e.message }); }
  await db.log(req.user.id, 'cash_category_save', String(b.code));
  res.json({ ok: true });
});
router.post('/api/category/:id(\\d+)/archive', async (req, res) => { await db.pool.query("UPDATE cash_categories SET status='archived' WHERE id=$1", [req.params.id]); res.json({ ok: true }); });

router.post('/api/counterparty', J, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Введите название' });
  const args = [String(b.name).trim(), b.inn || null, b.bank_code || null, intOrNull(b.default_category_id), intOrNull(b.linked_supplier_id), b.comment || null];
  if (b.id) await db.pool.query('UPDATE cash_counterparties SET name=$1, inn=$2, bank_code=$3, default_category_id=$4, linked_supplier_id=$5, comment=$6 WHERE id=$7', [...args, b.id]);
  else await db.pool.query('INSERT INTO cash_counterparties (name, inn, bank_code, default_category_id, linked_supplier_id, comment) VALUES ($1,$2,$3,$4,$5,$6)', args);
  await db.log(req.user.id, 'cash_counterparty_save', String(b.name));
  res.json({ ok: true });
});
router.post('/api/counterparty/:id(\\d+)/archive', async (req, res) => { await db.pool.query("UPDATE cash_counterparties SET status='archived' WHERE id=$1", [req.params.id]); res.json({ ok: true }); });

// Шаблон Excel для массовой загрузки контрагентов + лист-подсказка с кодами ДДС.
router.get('/api/counterparties/template.xlsx', async (req, res) => {
  const cats = (await db.pool.query("SELECT code, name, group_name FROM cash_categories WHERE status='active' AND direction_hint IS DISTINCT FROM 'transfer' ORDER BY sort_order, code")).rows;
  const wb = XLSX.utils.book_new();
  const main = XLSX.utils.aoa_to_sheet([
    ['Название', 'ИНН', 'Статья ДДС (код)', 'Комментарий'],
    ['Пример: ООО Ромашка', '301234567', '10', 'сырьё'],
    ['', '', '', ''],
  ]);
  main['!cols'] = [{ wch: 40 }, { wch: 16 }, { wch: 16 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, main, 'Контрагенты');
  const help = XLSX.utils.aoa_to_sheet([['Код', 'Статья ДДС', 'Группа'], ...cats.map((c) => [c.code, c.name, c.group_name || ''])]);
  help['!cols'] = [{ wch: 8 }, { wch: 40 }, { wch: 34 }];
  XLSX.utils.book_append_sheet(wb, help, 'Коды ДДС');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="cash_counterparties_template.xlsx"');
  res.send(buf);
});

// Массовый импорт контрагентов из Excel. Дедуп по ИНН (иначе по названию). Идемпотентно.
router.post('/api/counterparties/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sh = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sh, { header: 1, raw: false, defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'Пустой файл' });
    // Ищем строку заголовков и колонки по названиям.
    let hi = rows.findIndex((r) => r.some((c) => /назв/i.test(String(c))) && r.some((c) => /инн/i.test(String(c))));
    if (hi < 0) hi = 0;
    const head = rows[hi].map((c) => String(c).toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const iName = col(/назв/), iInn = col(/инн/), iCode = col(/ддс|код|стать/), iCmt = col(/коммент/);
    if (iName < 0) return res.status(400).json({ error: 'Не нашёл колонку «Название»' });
    const codeToCat = {};
    (await db.pool.query("SELECT id, code FROM cash_categories WHERE status='active'")).rows.forEach((c) => { codeToCat[String(c.code).trim()] = c.id; });
    let created = 0, updated = 0, skipped = 0;
    const badCodes = new Set();
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i];
      const name = String((r[iName] != null ? r[iName] : '')).trim();
      if (!name || /^пример/i.test(name)) { continue; }
      const inn = iInn >= 0 ? String(r[iInn] || '').trim() : '';
      const codeRaw = iCode >= 0 ? String(r[iCode] || '').trim().split('.')[0] : '';
      const cmt = iCmt >= 0 ? String(r[iCmt] || '').trim() : '';
      let catId = null;
      if (codeRaw) { catId = codeToCat[codeRaw] || null; if (!catId) badCodes.add(codeRaw); }
      // Ищем существующего: по ИНН, иначе по названию (не трогаем клиентов из SD).
      let ex = { rows: [] };
      if (inn) ex = await db.pool.query("SELECT id, default_category_id FROM cash_counterparties WHERE inn=$1 AND (cp_role IS DISTINCT FROM 'client') LIMIT 1", [inn]);
      if (!ex.rows.length) ex = await db.pool.query("SELECT id, default_category_id FROM cash_counterparties WHERE lower(name)=lower($1) AND (cp_role IS DISTINCT FROM 'client') LIMIT 1", [name]);
      if (ex.rows.length) {
        await db.pool.query(
          "UPDATE cash_counterparties SET name=$1, inn=COALESCE(NULLIF($2,''), inn), default_category_id=COALESCE($3, default_category_id), comment=COALESCE(NULLIF($4,''), comment), status='active' WHERE id=$5",
          [name, inn, catId, cmt, ex.rows[0].id]);
        updated++;
      } else {
        await db.pool.query("INSERT INTO cash_counterparties (name, inn, default_category_id, comment, status) VALUES ($1,$2,$3,$4,'active')", [name, inn || null, catId, cmt || null]);
        created++;
      }
    }
    await db.log(req.user.id, 'cash_counterparties_import', `создано ${created}, обновлено ${updated}`);
    res.json({ ok: true, created, updated, skipped, badCodes: [...badCodes] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/contract', J, async (req, res) => {
  const b = req.body || {};
  if (!intOrNull(b.counterparty_id)) return res.status(400).json({ error: 'Выберите контрагента' });
  const status = ['active', 'closed'].includes(b.status) ? b.status : 'active';
  const args = [intOrNull(b.counterparty_id), b.number || null, b.subject || null, intOrNull(b.category_id), numOrNull(b.amount), b.date_start || null, b.date_end || null, status];
  if (b.id) await db.pool.query('UPDATE cash_contracts SET counterparty_id=$1, number=$2, subject=$3, category_id=$4, amount=$5, date_start=$6, date_end=$7, status=$8 WHERE id=$9', [...args, b.id]);
  else await db.pool.query('INSERT INTO cash_contracts (counterparty_id, number, subject, category_id, amount, date_start, date_end, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', args);
  await db.log(req.user.id, 'cash_contract_save', String(b.number || ''));
  res.json({ ok: true });
});

// ---------- Остатки кошельков (считаются из журнала) ----------
async function walletBalances() {
  // Остаток кошелька = сумы + доллары × текущий курс (та же двухвалютная модель, что и вкладка «Касса»).
  // Долларовые строки НЕ считаем по их сумовому `amount` — берём штуки валюты (fx_amount) и переоцениваем по курсу.
  let rate = 0; try { rate = Number(await getCbuUsdRate(new Date().toISOString().slice(0, 10))) || 0; } catch (e) { rate = 0; }
  const r = await db.pool.query(`
    SELECT w.id, w.name, w.kind, w.color, w.account_no, w.sort_order,
      COALESCE(SUM(CASE WHEN t.currency <> 'USD' THEN (CASE
        WHEN t.tx_type='in' AND t.wallet_id=w.id THEN t.amount
        WHEN t.tx_type='transfer' AND t.wallet_to_id=w.id AND NOT t.needs_cash_confirm THEN t.amount
        WHEN t.tx_type='out' AND t.wallet_id=w.id THEN -t.amount
        WHEN t.tx_type='transfer' AND t.wallet_id=w.id THEN -t.amount
        ELSE 0 END) ELSE 0 END), 0) AS uzs,
      COALESCE(SUM(CASE WHEN t.currency = 'USD' THEN (CASE
        WHEN t.tx_type='in' AND t.wallet_id=w.id THEN COALESCE(t.fx_amount,0)
        WHEN t.tx_type='transfer' AND t.wallet_to_id=w.id AND NOT t.needs_cash_confirm THEN COALESCE(t.fx_amount,0)
        WHEN t.tx_type='out' AND t.wallet_id=w.id THEN -COALESCE(t.fx_amount,0)
        WHEN t.tx_type='transfer' AND t.wallet_id=w.id THEN -COALESCE(t.fx_amount,0)
        ELSE 0 END) ELSE 0 END), 0) AS usd
    FROM cash_wallets w
    LEFT JOIN cash_transactions t ON (t.wallet_id = w.id OR t.wallet_to_id = w.id)
    WHERE w.status='active'
    GROUP BY w.id ORDER BY w.sort_order, w.id`);
  return r.rows.map((x) => { const uzs = Number(x.uzs) || 0, usd = Number(x.usd) || 0; return { ...x, uzs, usd, rate, balance: uzs + usd * rate }; });
}
router.get('/api/wallets', async (req, res) => { res.json({ wallets: await walletBalances() }); });

// Экспорт операций кошелька в Excel — с бегущим остатком по строкам (для сверки с выпиской).
router.get('/api/wallet-export', async (req, res) => {
  try {
    const wid = intOrNull(req.query.wallet_id);
    if (!wid) return res.status(400).send('Не указан кошелёк');
    const wname = ((await db.pool.query('SELECT name FROM cash_wallets WHERE id=$1', [wid])).rows[0] || {}).name || ('Кошелёк ' + wid);
    const p = [wid]; let dateW = '';
    if (req.query.from) { p.push(req.query.from); dateW += ` AND t.tx_date >= $${p.length}`; }
    if (req.query.to) { p.push(req.query.to); dateW += ` AND t.tx_date <= $${p.length}`; }
    const eff = `CASE WHEN t.tx_type='in' AND t.wallet_id=$1 THEN t.amount
                      WHEN t.tx_type='out' AND t.wallet_id=$1 THEN -t.amount
                      WHEN t.tx_type='transfer' AND t.wallet_to_id=$1 THEN t.amount
                      WHEN t.tx_type='transfer' AND t.wallet_id=$1 THEN -t.amount ELSE 0 END`;
    const rows = (await db.pool.query(
      `SELECT to_char(t.tx_date,'YYYY-MM-DD') d, t.tx_type, t.currency, t.fx_rate, t.fx_amount,
              t.purpose, t.bank_doc_no, t.payer_name, t.source,
              w.name w_name, w2.name w2_name, cat.code cat_code, cat.name cat_name, (${eff}) AS eff
       FROM cash_transactions t
       LEFT JOIN cash_wallets w ON w.id=t.wallet_id
       LEFT JOIN cash_wallets w2 ON w2.id=t.wallet_to_id
       LEFT JOIN cash_categories cat ON cat.id=t.category_id
       WHERE (t.wallet_id=$1 OR t.wallet_to_id=$1)${dateW}
       ORDER BY t.tx_date, t.id`, p)).rows;
    let running = 0;
    if (req.query.from) {
      const r0 = await db.pool.query(
        `SELECT COALESCE(SUM(${eff}),0) v FROM cash_transactions t WHERE (t.wallet_id=$1 OR t.wallet_to_id=$1) AND t.tx_date < $2`, [wid, req.query.from]);
      running = Number(r0.rows[0].v);
    }
    const typeRu = { in: 'Приход', out: 'Расход', transfer: 'Перевод' };
    const aoa = [['Дата', 'Тип', 'Откуда → Куда', 'Статья', 'Назначение / От кого', 'Валюта', 'Курс', '$', 'Приход (сум)', 'Расход (сум)', 'Остаток', 'Источник', '№ док']];
    for (const r of rows) {
      running += Number(r.eff);
      const dir = r.tx_type === 'transfer' ? ((r.w_name || '?') + ' → ' + (r.w2_name || '?')) : (r.tx_type === 'in' ? ('→ ' + wname) : (wname + ' →'));
      aoa.push([
        r.d, typeRu[r.tx_type] || r.tx_type, dir,
        r.cat_code ? (r.cat_code + ' ' + (r.cat_name || '')) : '',
        r.purpose || r.payer_name || '', r.currency || 'UZS',
        r.fx_rate ? Number(r.fx_rate) : '', r.fx_amount ? Number(r.fx_amount) : '',
        Number(r.eff) > 0 ? Math.round(Number(r.eff)) : '', Number(r.eff) < 0 ? Math.round(-Number(r.eff)) : '',
        Math.round(running), r.source || '', r.bank_doc_no || '',
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 9 }, { wch: 26 }, { wch: 22 }, { wch: 36 }, { wch: 7 }, { wch: 9 }, { wch: 8 }, { wch: 15 }, { wch: 15 }, { wch: 16 }, { wch: 9 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Операции');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const safe = wname.replace(/[^\wа-яёА-ЯЁ]+/gi, '_').slice(0, 30);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="kassa_${safe}.xlsx"`);
    res.send(buf);
    await db.log(req.user.id, 'cash_wallet_export', `${wname} (${rows.length})`);
  } catch (e) { res.status(400).send('Ошибка экспорта: ' + e.message); }
});

// ---------- Сводка: сальдо на начало/конец, приход, расход за период ----------
// Начальные остатки (source='opening') входят в сальдо, но НЕ в «приход периода».
// Для одного кошелька перевод внутрь/наружу — это приход/расход этого кошелька;
// для «всех кошельков» переводы взаимно гасятся (внутренние перемещения).
function summaryExprs(wid) {
  if (wid) {
    return {
      params: [wid],
      // Зачисление перевода в кассу (wallet_to) считаем ТОЛЬКО после подтверждения факт-суммы
      // (needs_cash_confirm=false). Списание с банка (wallet_id) — сразу (деньги реально сняты).
      delta: `CASE WHEN t.tx_type='in' AND t.wallet_id=$1 THEN t.amount
                   WHEN t.tx_type='out' AND t.wallet_id=$1 THEN -t.amount
                   WHEN t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm THEN t.amount
                   WHEN t.tx_type='transfer' AND t.wallet_id=$1 THEN -t.amount
                   ELSE 0 END`,
      inExpr: `CASE WHEN t.tx_type='in' AND t.wallet_id=$1 THEN t.amount
                    WHEN t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm THEN t.amount
                    ELSE 0 END`,
      outExpr: `CASE WHEN t.tx_type='out' AND t.wallet_id=$1 THEN t.amount
                     WHEN t.tx_type='transfer' AND t.wallet_id=$1 THEN t.amount
                     ELSE 0 END`,
      inMember: `CASE WHEN (t.tx_type='in' AND t.wallet_id=$1) OR (t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm) THEN 1 ELSE 0 END`,
      outMember: `CASE WHEN (t.tx_type='out' AND t.wallet_id=$1) OR (t.tx_type='transfer' AND t.wallet_id=$1) THEN 1 ELSE 0 END`,
      sign: `CASE WHEN t.tx_type='in' AND t.wallet_id=$1 THEN 1
                  WHEN t.tx_type='out' AND t.wallet_id=$1 THEN -1
                  WHEN t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm THEN 1
                  WHEN t.tx_type='transfer' AND t.wallet_id=$1 THEN -1
                  ELSE 0 END`,
    };
  }
  return {
    params: [],
    delta: `CASE WHEN t.tx_type='in' THEN t.amount WHEN t.tx_type='out' THEN -t.amount ELSE 0 END`,
    inExpr: `CASE WHEN t.tx_type='in' THEN t.amount ELSE 0 END`,
    outExpr: `CASE WHEN t.tx_type='out' THEN t.amount ELSE 0 END`,
    inMember: `CASE WHEN t.tx_type='in' THEN 1 ELSE 0 END`,
    outMember: `CASE WHEN t.tx_type='out' THEN 1 ELSE 0 END`,
    sign: `CASE WHEN t.tx_type='in' THEN 1 WHEN t.tx_type='out' THEN -1 ELSE 0 END`,
  };
}

router.get('/api/summary', async (req, res) => {
  try {
    const from = req.query.from || null;
    const to = req.query.to || null;
    const wid = intOrNull(req.query.wallet);
    const e = summaryExprs(wid);
    // Фильтры строк (статья/разобрано/поиск) — те же, что в журнале. Применяем ко ВСЕМ числам сводки,
    // иначе карточки не совпадают с отфильтрованной таблицей. Категория — целое (безопасно inline),
    // поиск — параметром (добавляется последним в каждый запрос).
    const catId = intOrNull(req.query.category);
    const classified = req.query.classified === 'yes' ? 'yes' : (req.query.classified === 'no' ? 'no' : null);
    const q = (req.query.q || '').trim();
    const filt = (p) => {
      let s = '';
      if (catId) s += ` AND t.category_id = ${catId}`;
      if (classified === 'no') s += ` AND t.is_classified = false`;
      else if (classified === 'yes') s += ` AND t.is_classified = true`;
      if (q) { p.push('%' + q + '%'); s += ` AND (t.purpose ILIKE $${p.length} OR t.payer_name ILIKE $${p.length})`; }
      return s;
    };
    // Сальдо на начало = обычные движения СТРОГО до начала периода + начальные остатки
    // (source='opening') на дату начала периода ВКЛЮЧИТЕЛЬНО. Раздельно, т.к. остатки обычно
    // датируют первым днём периода ("баланс на входе в этот день") — при единой строгой границе
    // такая запись выпадала бы и из сальдо (не "до"), и из прихода (явно исключён ниже по source).
    let opening = 0;
    {
      // Без указанной даты начала «Сальдо на начало» = начальный остаток (source='opening'),
      // а не 0 — иначе большое число расходилось с разбивкой и «Сальдо на конец» теряло остаток.
      const p = e.params.slice(); let where;
      if (from) { p.push(from); where = `((t.source = 'opening' AND t.tx_date <= $${p.length}) OR (t.source <> 'opening' AND t.tx_date < $${p.length}))`; }
      else { where = `t.source = 'opening'`; }
      const r = await db.pool.query(`SELECT COALESCE(SUM(${e.delta}),0) v FROM cash_transactions t WHERE ${where}${filt(p)}`, p);
      opening = Number(r.rows[0].v);
    }
    // Приход/расход за период — без начальных остатков.
    const p2 = e.params.slice();
    p2.push(from || '1900-01-01', to || '2999-12-31');
    // Сумовые потоки — БЕЗ обмена (конверсия 102 исключена): совпадают с ручным счётом.
    // Долларовые потоки — С обменом (102 включена): доллары наличных/обмена видны в приходе $
    // и сходятся: конец$ = начало$ + приход$ − расход$.
    const notConv = `(t.category_id IS NULL OR t.category_id NOT IN (SELECT id FROM cash_categories WHERE code='102'))`;
    const r2 = await db.pool.query(
      `SELECT COALESCE(SUM(CASE WHEN ${notConv} THEN (${e.inExpr}) ELSE 0 END),0) inflow,
              COALESCE(SUM(CASE WHEN ${notConv} THEN (${e.outExpr}) ELSE 0 END),0) outflow,
              COALESCE(SUM((${e.inMember}) * (CASE WHEN t.currency<>'USD' AND ${notConv} THEN t.amount ELSE 0 END)),0) inflow_uzs,
              COALESCE(SUM((${e.inMember}) * (CASE WHEN t.currency='USD' THEN COALESCE(t.fx_amount,0) ELSE 0 END)),0) inflow_usd,
              COALESCE(SUM((${e.outMember}) * (CASE WHEN t.currency<>'USD' AND ${notConv} THEN t.amount ELSE 0 END)),0) outflow_uzs,
              COALESCE(SUM((${e.outMember}) * (CASE WHEN t.currency='USD' THEN COALESCE(t.fx_amount,0) ELSE 0 END)),0) outflow_usd,
              COALESCE(SUM((${e.sign}) * (CASE WHEN t.currency <> 'USD' AND NOT (${notConv}) THEN t.amount ELSE 0 END)),0) exchange_uzs
       FROM cash_transactions t
       WHERE t.source <> 'opening' AND t.tx_date BETWEEN $${p2.length - 1} AND $${p2.length}${filt(p2)}`, p2);
    const inflow = Number(r2.rows[0].inflow), outflow = Number(r2.rows[0].outflow);
    // Разбивка сальдо на сумы + доллары (штуки валюты) — та же логика дат, что и у opening/closing.
    const uzsVal = `(${e.sign}) * (CASE WHEN t.currency <> 'USD' THEN t.amount ELSE 0 END)`;
    const usdVal = `(${e.sign}) * (CASE WHEN t.currency = 'USD' THEN COALESCE(t.fx_amount,0) ELSE 0 END)`;
    let opening_uzs = 0, opening_usd = 0, closing_uzs = 0, closing_usd = 0;
    { // состав сальдо на начало
      const p = e.params.slice(); let where;
      if (from) { p.push(from); where = `((t.source='opening' AND t.tx_date <= $${p.length}) OR (t.source<>'opening' AND t.tx_date < $${p.length}))`; }
      else { where = `t.source='opening'`; }
      const r = await db.pool.query(`SELECT COALESCE(SUM(${uzsVal}),0) uzs, COALESCE(SUM(${usdVal}),0) usd FROM cash_transactions t WHERE ${where}${filt(p)}`, p);
      opening_uzs = Number(r.rows[0].uzs); opening_usd = Number(r.rows[0].usd);
    }
    { // состав сальдо на конец (всё до даты `to` включительно)
      const p = e.params.slice(); p.push(to || '2999-12-31');
      const r = await db.pool.query(`SELECT COALESCE(SUM(${uzsVal}),0) uzs, COALESCE(SUM(${usdVal}),0) usd FROM cash_transactions t WHERE t.tx_date <= $${p.length}${filt(p)}`, p);
      closing_uzs = Number(r.rows[0].uzs); closing_usd = Number(r.rows[0].usd);
    }
    res.json({
      opening, inflow, outflow, closing: opening + inflow - outflow,
      opening_uzs, opening_usd, closing_uzs, closing_usd,
      inflow_uzs: Number(r2.rows[0].inflow_uzs), inflow_usd: Number(r2.rows[0].inflow_usd),
      outflow_uzs: Number(r2.rows[0].outflow_uzs), outflow_usd: Number(r2.rows[0].outflow_usd),
      // Обмен за период (сумовая нога конверсии, со знаком): минус — сумы ушли в доллары.
      // Замыкает сумовую колонку: конец = начало + приход − расход + обмен.
      exchange_uzs: Number(r2.rows[0].exchange_uzs),
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Баланс одного кошелька на дату (для окна сверки).
async function walletBalanceUpTo(wid, date) {
  const r = await db.pool.query(
    `SELECT COALESCE(SUM(CASE
       WHEN t.tx_type='in' AND t.wallet_id=$1 THEN t.amount
       WHEN t.tx_type='out' AND t.wallet_id=$1 THEN -t.amount
       WHEN t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm THEN t.amount
       WHEN t.tx_type='transfer' AND t.wallet_id=$1 THEN -t.amount
       ELSE 0 END),0) bal
     FROM cash_transactions t WHERE t.tx_date <= $2`, [wid, date]);
  return Number(r.rows[0].bal);
}
router.get('/api/wallet-balance', async (req, res) => {
  const wid = intOrNull(req.query.wallet_id);
  if (!wid) return res.status(400).json({ error: 'Не указан кошелёк' });
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  res.json({ balance: await walletBalanceUpTo(wid, date) });
});

// ---------- Начальные остатки ----------
// Одна запись source='opening' на кошелёк. Меняются целиком: старые удаляем, новые пишем.
// Баланс — производная от движений, поэтому «пересчёт истории» происходит сам собой.
router.get('/api/opening', async (req, res) => {
  const wallets = (await db.pool.query("SELECT id, name, color, sort_order FROM cash_wallets WHERE status='active' ORDER BY sort_order, id")).rows;
  const rows = (await db.pool.query("SELECT wallet_id, amount, tx_type, tx_date FROM cash_transactions WHERE source='opening'")).rows;
  const byWallet = {}; let date = null;
  rows.forEach((r) => { byWallet[r.wallet_id] = (r.tx_type === 'out' ? -Number(r.amount) : Number(r.amount)); if (r.tx_date) date = r.tx_date; });
  res.json({
    date: date ? String(date).slice(0, 10) : null,
    items: wallets.map((w) => ({ wallet_id: w.id, name: w.name, color: w.color, amount: byWallet[w.id] != null ? byWallet[w.id] : null })),
  });
});
router.post('/api/opening', J, async (req, res) => {
  const b = req.body || {};
  const date = b.date || new Date().toISOString().slice(0, 10);
  const balances = b.balances || {};
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM cash_transactions WHERE source='opening'");
    let n = 0;
    for (const [wid, amtRaw] of Object.entries(balances)) {
      const wallet = intOrNull(wid); if (!wallet) continue;
      const amt = Number(amtRaw);
      if (!amt || !isFinite(amt)) continue; // пусто/ноль — записи нет
      const type = amt >= 0 ? 'in' : 'out';
      await client.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, purpose, source, is_classified, created_by)
         VALUES ($1,$2,$3,$4,'Начальный остаток','opening',true,$5)`,
        [date, Math.abs(amt), type, wallet, req.user.id]);
      n++;
    }
    await client.query('COMMIT');
    await db.log(req.user.id, 'cash_opening_set', `дата ${date}, кошельков ${n}`);
    res.json({ ok: true, count: n });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

// Начальные остатки наличной кассы РАЗДЕЛЬНО: сумовая часть + долларовая часть.
// Пишем двумя opening-записями (UZS и USD) на выбранную дату — как обычные движения.
router.get('/api/cash-opening', async (req, res) => {
  const wid = intOrNull(req.query.wallet);
  if (!wid) return res.status(400).json({ error: 'Не указан кошелёк' });
  const rows = (await db.pool.query(
    "SELECT amount, tx_type, currency, fx_amount, tx_date FROM cash_transactions WHERE source='opening' AND wallet_id=$1", [wid])).rows;
  let uzs = null, usd = null, rate = null, date = null;
  for (const r of rows) {
    const sign = r.tx_type === 'out' ? -1 : 1;
    if (r.currency === 'USD') { usd = sign * Number(r.fx_amount || 0); rate = r.amount && r.fx_amount ? Number(r.amount) / Number(r.fx_amount) : null; }
    else uzs = sign * Number(r.amount);
    if (r.tx_date) date = r.tx_date;
  }
  res.json({ date: date ? String(date).slice(0, 10) : null, uzs, usd, rate });
});
router.post('/api/cash-opening', J, async (req, res) => {
  const b = req.body || {};
  const wid = intOrNull(b.wallet_id);
  if (!wid) return res.status(400).json({ error: 'Не указан кошелёк' });
  const date = b.date || new Date().toISOString().slice(0, 10);
  const uzs = numOrNull(b.uzs);
  const usd = numOrNull(b.usd);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Заменяем именно opening-записи ЭТОЙ кассы (другие кошельки не трогаем).
    await client.query("DELETE FROM cash_transactions WHERE source='opening' AND wallet_id=$1", [wid]);
    if (uzs && isFinite(uzs) && uzs !== 0) {
      await client.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, purpose, source, is_classified, currency, created_by)
         VALUES ($1,$2,$3,$4,'Начальный остаток (сум)','opening',true,'UZS',$5)`,
        [date, Math.abs(uzs), uzs >= 0 ? 'in' : 'out', wid, req.user.id]);
    }
    if (usd && isFinite(usd) && usd !== 0) {
      // Для долларовой части нужен курс на дату, чтобы amount (сум-эквивалент) был корректным.
      let rate = numOrNull(b.rate);
      if (!(rate > 0)) { try { rate = await getCbuUsdRate(date); } catch (e) { rate = null; } }
      if (!(rate > 0)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Нет курса ЦБ на дату — укажите курс вручную' }); }
      await client.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, purpose, source, is_classified, currency, fx_rate, fx_amount, created_by)
         VALUES ($1,$2,$3,$4,'Начальный остаток ($)','opening',true,'USD',$5,$6,$7)`,
        [date, Math.abs(usd) * rate, usd >= 0 ? 'in' : 'out', wid, rate, Math.abs(usd), req.user.id]);
    }
    await client.query('COMMIT');
    await db.log(req.user.id, 'cash_opening_fx_set', `касса ${wid}, дата ${date}, сум ${uzs}, $ ${usd}`);
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

// ---------- Импорт «Наличная касса» из Excel ----------
// Шаблон: # | Лист | Тип | Дата | Пояснение | Код ДДС | Сумма (сум) | Валюта $ | Курс
// Правила: приход «обнал» пропускаем; строки «сум+доллар» бьём на 2 (сумовую и долларовую);
// у приходов коды не ставим (пусто), у расходов — код из файла.
const cbDate = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/); if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  const n = Number(s); if (n > 30000 && n < 60000) return new Date(Math.round((n - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  return null;
};
const cbNum = (v) => { const t = String(v == null ? '' : v).replace(/ /g, '').replace(/\s/g, '').replace(',', '.'); const n = parseFloat(t); return isNaN(n) ? 0 : n; };

function parseCashboxWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const shName = wb.SheetNames.find((n) => /превью|импорт|касс/i.test(n)) || wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[shName], { header: 1, raw: false, defval: '' });
  let hi = aoa.findIndex((r) => r.some((c) => /^тип$/i.test(String(c).trim())) && r.some((c) => /сумм/i.test(String(c))));
  if (hi < 0) hi = 0;
  const head = aoa[hi].map((c) => String(c).toLowerCase().trim());
  const col = (re) => head.findIndex((h) => re.test(h));
  const ci = { type: col(/^тип/), date: col(/дата/), purpose: col(/поясн/), code: col(/код/), sum: col(/сумм/), usd: col(/валют|\$|доллар/), rate: col(/курс/) };
  const rows = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i];
    const typeRaw = String(r[ci.type] || '').toLowerCase();
    const tx_type = /приход/.test(typeRaw) ? 'in' : /расход/.test(typeRaw) ? 'out' : null;
    if (!tx_type) continue;
    const date = cbDate(r[ci.date]);
    const sum = cbNum(r[ci.sum]);
    if (!date || !(sum > 0)) continue;
    rows.push({
      tx_type, date,
      purpose: String(r[ci.purpose] || '').trim(),
      code: ci.code >= 0 ? String(r[ci.code] || '').trim().split('.')[0] : '',
      sum, usd: ci.usd >= 0 ? cbNum(r[ci.usd]) : 0, rate: ci.rate >= 0 ? cbNum(r[ci.rate]) : 0,
    });
  }
  // Начальный остаток из листа «Итоги» (самый ранний месяц).
  let opening = null;
  const tsh = wb.Sheets['Итоги'];
  if (tsh) {
    const t = XLSX.utils.sheet_to_json(tsh, { header: 1, raw: false, defval: '' });
    const th = (t[0] || []).map((c) => String(c).toLowerCase());
    let oi = th.findIndex((h) => /ост.*нач|нач.*ост/.test(h)); if (oi < 0) oi = (t[0] || []).length - 1;
    let best = null;
    for (let i = 1; i < t.length; i++) { const v = cbNum(t[i][oi]); if (t[i][0] && v) { best = { row: String(t[i][0]), sum: v }; break; } }
    if (best) opening = best.sum;
  }
  return { rows, opening };
}

// Разбивка на записи: обнал-приходы пропускаем; сум+доллар → две записи.
function buildCashboxEntries(rows) {
  const entries = []; let skippedObnal = 0, konv = 0, splitPairs = 0;
  for (const r of rows) {
    if (r.tx_type === 'in' && /обнал/i.test(r.purpose)) { skippedObnal++; continue; }
    if (/конверси/i.test(r.purpose)) konv++;
    const dollarPart = (r.usd > 0 && r.rate > 0) ? Math.round(r.usd * r.rate) : 0;
    let sumPart = Math.round(r.sum - dollarPart);
    if (sumPart < 0) sumPart = 0;
    const base = { tx_type: r.tx_type, date: r.date, purpose: r.purpose, code: r.tx_type === 'out' ? r.code : '' };
    if (dollarPart > 0 && sumPart > 0) splitPairs++;
    if (dollarPart === 0 || sumPart > 0) entries.push({ ...base, currency: 'UZS', amount: dollarPart === 0 ? Math.round(r.sum) : sumPart, fx_amount: null, fx_rate: null });
    if (dollarPart > 0) entries.push({ ...base, currency: 'USD', amount: dollarPart, fx_amount: r.usd, fx_rate: r.rate });
  }
  return { entries, skippedObnal, konv, splitPairs };
}

router.post('/api/cashbox/import/preview', upload.single('file'), async (req, res) => {
  try {
    const wallet_id = intOrNull(req.body.wallet_id);
    if (!wallet_id) return res.status(400).json({ error: 'Выберите наличную кассу' });
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const { rows, opening } = parseCashboxWorkbook(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: 'Не нашёл строк в файле (проверьте шаблон).' });
    const { entries, skippedObnal, konv, splitPairs } = buildCashboxEntries(rows);
    // неизвестные коды (только у расходов)
    const codeToCat = {};
    (await db.pool.query("SELECT id, code FROM cash_categories WHERE status='active'")).rows.forEach((c) => { codeToCat[String(c.code)] = c.id; });
    const badCodes = new Set();
    for (const e of entries) { if (e.code && !codeToCat[e.code]) badCodes.add(e.code); }
    const inCnt = rows.filter((r) => r.tx_type === 'in' && !/обнал/i.test(r.purpose)).length;
    const outCnt = rows.filter((r) => r.tx_type === 'out').length;
    const minDate = entries.map((e) => e.date).filter(Boolean).sort()[0] || null;
    const openingDate = minDate ? minDate.slice(0, 7) + '-01' : null;
    const payload = Buffer.from(JSON.stringify({ wallet_id, entries, opening, openingDate })).toString('base64');
    res.json({
      summary: { fileRows: rows.length, inCnt, outCnt, skippedObnal, konv, splitPairs, entries: entries.length, badCodes: [...badCodes], opening, openingDate },
      sample: entries.slice(0, 40), payload,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/cashbox/import/commit', J, async (req, res) => {
  const client = await db.pool.connect();
  try {
    const data = JSON.parse(Buffer.from(String(req.body.payload || ''), 'base64').toString('utf8'));
    const wallet_id = intOrNull(data.wallet_id);
    if (!wallet_id) return res.status(400).json({ error: 'Нет кассы' });
    const codeToCat = {};
    (await db.pool.query("SELECT id, code FROM cash_categories WHERE status='active'")).rows.forEach((c) => { codeToCat[String(c.code)] = c.id; });
    const siryeSet = await siryeCatIdSet(); // расход «Сырьё» = по умолчанию выдача снабженцу под отчёт
    await client.query('BEGIN');
    // Начальный остаток (по желанию) — заменяем opening этой кассы.
    if (req.body.setOpening && data.opening && data.openingDate) {
      await client.query("DELETE FROM cash_transactions WHERE source='opening' AND wallet_id=$1", [wallet_id]);
      await client.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, purpose, source, is_classified, currency, created_by)
         VALUES ($1,$2,'in',$3,'Начальный остаток (сум)','opening',true,'UZS',$4)`,
        [data.openingDate, Math.abs(Number(data.opening)), wallet_id, req.user.id]);
    }
    const batch = (await client.query('INSERT INTO cash_import_batches (wallet_id, filename, count, created_by) VALUES ($1,$2,0,$3) RETURNING id', [wallet_id, req.body.filename || 'cashbox.xlsx', req.user.id])).rows[0].id;
    // дедуп по натуральному ключу в пределах кассы
    const existing = new Set();
    (await client.query("SELECT to_char(tx_date,'YYYY-MM-DD') d, amount, tx_type, currency, COALESCE(purpose,'') p FROM cash_transactions WHERE wallet_id=$1 AND source='import'", [wallet_id])).rows
      .forEach((x) => existing.add(x.d + '|' + Number(x.amount) + '|' + x.tx_type + '|' + x.currency + '|' + x.p));
    let ins = 0, skip = 0;
    for (const e of (data.entries || [])) {
      // Дедуп только против уже существовавших строк (защита от повторной загрузки);
      // одинаковые строки внутри одного файла НЕ теряем.
      const key = e.date + '|' + Number(e.amount) + '|' + e.tx_type + '|' + e.currency + '|' + (e.purpose || '');
      if (existing.has(key)) { skip++; continue; }
      const catId = e.code ? (codeToCat[e.code] || null) : null;
      const supplyAdv = e.tx_type === 'out' && catId != null && siryeSet.has(catId);
      await client.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, import_batch_id, is_classified, currency, fx_rate, fx_amount, is_supply_advance, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'import',$7,$8,$9,$10,$11,$12,$13)`,
        [e.date, e.amount, e.tx_type, wallet_id, catId, e.purpose || null, batch, !!catId, e.currency || 'UZS', e.fx_rate, e.fx_amount, supplyAdv, req.user.id]);
      ins++;
    }
    await client.query('UPDATE cash_import_batches SET count=$1 WHERE id=$2', [ins, batch]);
    await client.query('COMMIT');
    await db.log(req.user.id, 'cashbox_import', `касса ${wallet_id}: +${ins}, пропущено ${skip}`);
    res.json({ ok: true, inserted: ins, skipped: skip });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

// ---------- Конверсия валюты внутри наличной кассы ----------
// Обмен $↔сум в одном кошельке: две ноги (сумовая + долларовая) со статьёй «Конверсия» (102).
// Не доход/не расход, в ДДС не входит; сум-эквивалент нейтрален (обе ноги по одному курсу).
router.post('/api/cashbox/convert', J, async (req, res) => {
  const b = req.body || {};
  const wid = intOrNull(b.wallet_id);
  if (!wid) return res.status(400).json({ error: 'Выберите кассу' });
  const dir = b.direction === 'uzs_to_usd' ? 'uzs_to_usd' : 'usd_to_uzs';
  const usd = Number(String(b.usd == null ? '' : b.usd).replace(',', '.'));
  const date = b.date || new Date().toISOString().slice(0, 10);
  if (!(usd > 0)) return res.status(400).json({ error: 'Укажите сумму в долларах' });
  let rate = Number(String(b.rate == null ? '' : b.rate).replace(',', '.'));
  if (!(rate > 0)) { try { rate = await getCbuUsdRate(date); } catch (e) { rate = null; } }
  if (!(rate > 0)) return res.status(400).json({ error: 'Нет курса — укажите вручную' });
  const sumAmt = Math.round(usd * rate);
  const cat = (await db.pool.query("SELECT id FROM cash_categories WHERE code='102' LIMIT 1")).rows[0];
  const catId = cat ? cat.id : null;
  const purpose = dir === 'usd_to_uzs'
    ? `Конверсия $${usd} → ${sumAmt} сум @${rate}`
    : `Конверсия ${sumAmt} сум → $${usd} @${rate}`;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const insUsd = (tx) => client.query(
      `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, is_classified, currency, fx_rate, fx_amount, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'manual',true,'USD',$7,$8,$9)`,
      [date, sumAmt, tx, wid, catId, purpose, rate, usd, req.user.id]);
    const insUzs = (tx) => client.query(
      `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, is_classified, currency, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'manual',true,'UZS',$7)`,
      [date, sumAmt, tx, wid, catId, purpose, req.user.id]);
    if (dir === 'usd_to_uzs') { await insUsd('out'); await insUzs('in'); }
    else { await insUzs('out'); await insUsd('in'); }
    await client.query('COMMIT');
    await db.log(req.user.id, 'cash_convert', purpose);
    res.json({ ok: true, sumAmt, rate });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

// ---------- «К оплате»: наличные долги (не трогают остаток/ДДС, пока не выплачены) ----------
router.get('/api/pending', async (req, res) => {
  try {
    const p = []; let w = "p.status='pending'";
    if (req.query.wallet) { p.push(parseInt(req.query.wallet)); w += ` AND p.wallet_id=$${p.length}`; }
    const rows = (await db.pool.query(
      `SELECT p.*, to_char(p.due_date,'YYYY-MM-DD') AS due, w.name AS wallet_name, c.code AS cat_code, c.name AS cat_name
         FROM cash_pending_payments p
         LEFT JOIN cash_wallets w ON w.id=p.wallet_id
         LEFT JOIN cash_categories c ON c.id=p.category_id
        WHERE ${w} ORDER BY p.due_date NULLS LAST, p.id`, p)).rows;
    const today = new Date().toISOString().slice(0, 10);
    const total = rows.reduce((s, x) => s + Number(x.amount || 0), 0);
    const overdue = rows.filter((x) => x.due && x.due < today).reduce((s, x) => s + Number(x.amount || 0), 0);
    res.json({ items: rows, total, overdue });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/pending', J, async (req, res) => {
  const b = req.body || {};
  const wid = intOrNull(b.wallet_id);
  const amt = numOrNull(b.amount);
  if (!wid) return res.status(400).json({ error: 'Выберите наличную кассу' });
  if (!(amt > 0)) return res.status(400).json({ error: 'Сумма должна быть больше 0' });
  const r = await db.pool.query(
    `INSERT INTO cash_pending_payments (wallet_id, amount, category_id, purpose, due_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [wid, amt, intOrNull(b.category_id), b.purpose || null, b.due_date || null, req.user.id]);
  await db.log(req.user.id, 'cash_pending_add', String(amt));
  res.json({ ok: true, id: r.rows[0].id });
});
router.post('/api/pending/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  await db.pool.query(
    "UPDATE cash_pending_payments SET wallet_id=$1, amount=$2, category_id=$3, purpose=$4, due_date=$5 WHERE id=$6 AND status='pending'",
    [intOrNull(b.wallet_id), numOrNull(b.amount) || 0, intOrNull(b.category_id), b.purpose || null, b.due_date || null, req.params.id]);
  res.json({ ok: true });
});
// Выплатить долг: создаём обычный расход в Кассе и закрываем долг (деньги списываются только сейчас).
router.post('/api/pending/:id(\\d+)/pay', J, async (req, res) => {
  const b = req.body || {};
  const pid = parseInt(req.params.id, 10);
  const p = (await db.pool.query("SELECT * FROM cash_pending_payments WHERE id=$1 AND status='pending'", [pid])).rows[0];
  if (!p) return res.status(404).json({ error: 'Долг не найден или уже выплачен' });
  const payDate = b.pay_date || new Date().toISOString().slice(0, 10);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await client.query(
      `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, is_classified, currency, created_by)
       VALUES ($1,$2,'out',$3,$4,$5,'manual',$6,'UZS',$7) RETURNING id`,
      [payDate, p.amount, p.wallet_id, p.category_id, p.purpose || 'Оплата долга', !!p.category_id, req.user.id]);
    await client.query("UPDATE cash_pending_payments SET status='paid', paid_tx_id=$1, paid_date=$2 WHERE id=$3", [tx.rows[0].id, payDate, pid]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
  finally { client.release(); }
  await db.log(req.user.id, 'cash_pending_pay', '#' + pid);
  res.json({ ok: true });
});
router.post('/api/pending/:id(\\d+)/delete', async (req, res) => {
  await db.pool.query("DELETE FROM cash_pending_payments WHERE id=$1 AND status='pending'", [req.params.id]);
  await db.log(req.user.id, 'cash_pending_delete', '#' + req.params.id);
  res.json({ ok: true });
});

// ---------- Сверка остатка ----------
// Сравнивает фактический остаток кошелька с ERP; при расхождении создаёт корректировку.
router.post('/api/reconcile', J, async (req, res) => {
  try {
    const b = req.body || {};
    const wid = intOrNull(b.wallet_id);
    if (!wid) return res.status(400).json({ error: 'Выберите кошелёк для сверки' });
    const date = b.date || new Date().toISOString().slice(0, 10);
    const fact = Number(b.fact_amount);
    if (!isFinite(fact)) return res.status(400).json({ error: 'Укажите фактический остаток' });
    const erp = await walletBalanceUpTo(wid, date);
    const diff = Math.round((fact - erp) * 100) / 100;
    if (!diff) { await db.log(req.user.id, 'cash_reconcile', `кошелёк ${wid}: совпадает (${erp})`); return res.json({ ok: true, erp, diff: 0, created: false }); }
    const type = diff > 0 ? 'in' : 'out';
    const catRow = (await db.pool.query("SELECT id FROM cash_categories WHERE code='101' LIMIT 1")).rows[0];
    const catId = catRow ? catRow.id : null;
    await db.pool.query(
      `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, is_classified, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'adjust',$7,$8)`,
      [date, Math.abs(diff), type, wid, catId, 'Корректировка остатка' + (b.comment ? ' — ' + b.comment : ''), !!catId, req.user.id]);
    await db.log(req.user.id, 'cash_reconcile', `кошелёк ${wid}: факт ${fact}, ERP ${erp}, разница ${diff}${b.comment ? ' — ' + b.comment : ''}`);
    res.json({ ok: true, erp, diff, created: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Отчёт: агрегация по статьям ДДС за период (для Кэш-флоу и P&L) ----------
router.get('/api/report', async (req, res) => {
  const from = req.query.from || '1900-01-01';
  const to = req.query.to || '2999-12-31';
  const p = [from, to];
  let wClause = '';
  if (req.query.wallet) { p.push(parseInt(req.query.wallet)); wClause = ` AND t.wallet_id = $${p.length}`; }
  // Операционные статьи — приход/расход. Переводы (direction='transfer') исключаем полностью:
  // они не доход/не расход, а перемещения между своими счетами (см. блок «Внутренние перемещения»).
  const rows = (await db.pool.query(
    `SELECT cat.id AS cat_id, cat.code, cat.name, cat.group_name, cat.flow_type,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type='in'),0) AS inc,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type='out'),0) AS exp,
            COUNT(*) AS cnt
     FROM cash_transactions t
     LEFT JOIN cash_categories cat ON cat.id = t.category_id
     WHERE t.tx_date BETWEEN $1 AND $2 AND t.tx_type IN ('in','out') AND t.source <> 'opening'
       AND (cat.direction_hint IS DISTINCT FROM 'transfer') AND (cat.code IS DISTINCT FROM '102')${wClause}
     GROUP BY cat.id, cat.code, cat.name, cat.group_name, cat.flow_type
     ORDER BY cat.code NULLS LAST`, p)).rows
    .map((r) => ({ cat_id: r.cat_id, code: r.code, name: r.name, group_name: r.group_name, flow_type: r.flow_type, inc: Number(r.inc), exp: Number(r.exp), cnt: Number(r.cnt) }));
  // Внутренние перемещения по под-категориям перевода (межбанк / обнал / пополнение карты).
  // Оборот = деньги, ушедшие из счёта-источника: одиночные transfer (списание) + out-ноги банк↔банк.
  // Итог по всем кошелькам по этим строкам = 0 (что ушло, то и пришло), поэтому в операционку не входят.
  const internal = (await db.pool.query(
    `SELECT cat.code, cat.name,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type='transfer'),0)
              + COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type='out'),0) AS moved,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type='in'),0) AS leg_in,
            COUNT(*) AS cnt
     FROM cash_transactions t JOIN cash_categories cat ON cat.id = t.category_id
     WHERE t.tx_date BETWEEN $1 AND $2 AND t.source <> 'opening' AND cat.direction_hint='transfer'${wClause}
     GROUP BY cat.code, cat.name ORDER BY cat.code`, p)).rows
    .map((r) => ({ code: r.code, name: r.name, moved: Number(r.moved), leg_in: Number(r.leg_in), cnt: Number(r.cnt) }));
  // Обнал (детально): получено в кассу (transfer/in по коду 110) + комиссия (расход код 64) = ушло со счёта.
  const ob = (await db.pool.query(
    `SELECT
       COALESCE((SELECT SUM(t.amount) FROM cash_transactions t JOIN cash_categories c ON c.id=t.category_id
                 WHERE c.code='110' AND t.tx_type IN ('transfer','in') AND t.tx_date BETWEEN $1 AND $2 AND t.source<>'opening'${wClause}),0) AS received,
       COALESCE((SELECT SUM(t.amount) FROM cash_transactions t JOIN cash_categories c ON c.id=t.category_id
                 WHERE c.code='64' AND t.tx_type='out' AND t.tx_date BETWEEN $1 AND $2 AND t.source<>'opening'${wClause}),0) AS commission`,
    p)).rows[0];
  const obnal = { received: Number(ob.received), commission: Number(ob.commission), sent: Number(ob.received) + Number(ob.commission) };
  const groups = (await db.pool.query("SELECT name FROM cash_groups WHERE status='active' ORDER BY sort_order, id")).rows.map((g) => g.name);
  const wallets = (await db.pool.query("SELECT id, name FROM cash_wallets WHERE status='active' ORDER BY sort_order, id")).rows;
  // a2a оставлен для обратной совместимости фронта (общий оборот переводов).
  const a2aInc = internal.reduce((s, x) => s + x.leg_in, 0);
  const a2aExp = internal.reduce((s, x) => s + x.moved, 0);
  res.json({ from, to, rows, groups, wallets, internal, obnal, a2a: { inc: a2aInc, exp: a2aExp } });
});

// ---------- Журнал транзакций ----------
router.get('/api/transactions', async (req, res) => {
  const { from, to, wallet, counterparty, category, type, q, classified } = req.query;
  // Начальные остатки (source='opening') — системные записи, в журнал не показываем: только сальдо.
  const p = [], w = ["t.source <> 'opening'"];
  if (from) { p.push(from); w.push(`t.tx_date >= $${p.length}`); }
  if (to) { p.push(to); w.push(`t.tx_date <= $${p.length}`); }
  const wid = intOrNull(wallet);
  if (type && ['in', 'out', 'transfer'].includes(type)) {
    if (type === 'in' && wid) {
      // «Приход» по кошельку = поступления (in) + переводы, зачисляемые В этот кошелёк.
      p.push(wid); const widIdx = p.length;
      w.push(`((t.tx_type='in' AND t.wallet_id = $${widIdx}) OR (t.tx_type='transfer' AND t.wallet_to_id = $${widIdx}))`);
    } else if (type === 'out' && wid) {
      // «Расход» по кошельку = списания (out) + переводы, уходящие ИЗ этого кошелька.
      p.push(wid); const widIdx = p.length;
      w.push(`((t.tx_type='out' AND t.wallet_id = $${widIdx}) OR (t.tx_type='transfer' AND t.wallet_id = $${widIdx}))`);
    } else { p.push(type); w.push(`t.tx_type = $${p.length}`); }
  }
  if (wallet && !(type === 'in' || type === 'out')) { p.push(wid); w.push(`(t.wallet_id = $${p.length} OR t.wallet_to_id = $${p.length})`); }
  if (counterparty) { p.push(parseInt(counterparty)); w.push(`t.counterparty_id = $${p.length}`); }
  if (category) { p.push(parseInt(category)); w.push(`t.category_id = $${p.length}`); }
  if (req.query.catgroup === '__nogroup__') w.push(`EXISTS (SELECT 1 FROM cash_categories cg WHERE cg.id = t.category_id AND cg.group_name IS NULL)`);
  else if (req.query.catgroup) { p.push(req.query.catgroup); w.push(`EXISTS (SELECT 1 FROM cash_categories cg WHERE cg.id = t.category_id AND cg.group_name = $${p.length})`); }
  if (classified === 'no') w.push(`(t.tx_type <> 'transfer' AND t.is_classified = false)`);
  else if (classified === 'yes') w.push(`t.is_classified = true`);
  if (q) { p.push('%' + String(q).trim() + '%'); w.push(`(t.purpose ILIKE $${p.length} OR t.payer_name ILIKE $${p.length})`); }
  // Режим «Наличной кассы»: сворачиваем обнал. Прячем внутренние строки конверсии/доллара (ст. 102 с parent_tx_id)
  // — их сумма попадёт в «факт»-ряд родителя. Комиссия (ст. 64) остаётся видимой в расходах.
  const cashboxView = req.query.cashbox === '1';
  if (cashboxView) {
    w.push(`NOT (t.parent_tx_id IS NOT NULL AND t.category_id IN (SELECT id FROM cash_categories WHERE code='102'))`);
  }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  // Доп. столбцы для «факт»-ряда обнала (только в режиме кассы): доллары, сумовая конверсия, комиссия по детям.
  const obnalCols = cashboxView ? `,
    (SELECT COALESCE(SUM(c.fx_amount),0) FROM cash_transactions c WHERE c.parent_tx_id = t.id AND c.tx_type='in' AND c.currency='USD') AS obnal_usd,
    (SELECT COALESCE(SUM(c.amount),0) FROM cash_transactions c WHERE c.parent_tx_id = t.id AND c.tx_type='out' AND c.category_id IN (SELECT id FROM cash_categories WHERE code='102')) AS obnal_conv_uzs,
    (SELECT COALESCE(SUM(c.amount),0) FROM cash_transactions c WHERE c.parent_tx_id = t.id AND c.category_id IN (SELECT id FROM cash_categories WHERE code='64')) AS obnal_fee` : '';
  // Итоги и общее число — по всей выборке (не по странице).
  const agg = (await db.pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE tx_type='in'),0) AS tin,
            COALESCE(SUM(amount) FILTER (WHERE tx_type='out'),0) AS tout,
            COUNT(*) FILTER (WHERE tx_type <> 'transfer' AND is_classified = false) AS unclass,
            COUNT(*) AS total
     FROM cash_transactions t ${where}`, p)).rows[0];
  const pageSize = [10, 20, 50, 100, 200, 500, 1000].includes(parseInt(req.query.pageSize)) ? parseInt(req.query.pageSize) : 50;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const offset = (page - 1) * pageSize;
  const pageP = p.slice(); pageP.push(pageSize, offset);
  const rows = (await db.pool.query(
    `SELECT t.*, COALESCE(t.report_hidden,false) AS hidden, w.name AS wallet_name, w.color AS wallet_color, w2.name AS wallet_to_name,
            cp.name AS cp_name, cat.code AS cat_code, cat.name AS cat_name, cat.group_name AS cat_group${obnalCols}
     FROM cash_transactions t
     LEFT JOIN cash_wallets w ON w.id = t.wallet_id
     LEFT JOIN cash_wallets w2 ON w2.id = t.wallet_to_id
     LEFT JOIN cash_counterparties cp ON cp.id = t.counterparty_id
     LEFT JOIN cash_categories cat ON cat.id = t.category_id
     ${where} ORDER BY t.tx_date DESC, t.id DESC LIMIT $${pageP.length - 1} OFFSET $${pageP.length}`, pageP)).rows;
  // Живое сопоставление контрагента для непривязанных строк — по ИНН и по юр.названию.
  // Что распознали, то и показываем (и сразу сохраняем), без всяких кнопок.
  const need = rows.filter((r) => !r.counterparty_id && (r.payer_inn || r.payer_name));
  if (need.length) {
    const cps = (await db.pool.query("SELECT id, name, firm_name, inn FROM cash_counterparties WHERE status='active'")).rows;
    const byInn = {}, byNm = {};
    for (const c of cps) {
      if (c.inn) { const k = String(c.inn).trim(); if (k && !(k in byInn)) byInn[k] = c; }
      for (const nm of [c.firm_name, c.name]) { const k = normName(nm); if (k && k.length >= 4 && !(k in byNm)) byNm[k] = c; }
    }
    for (const r of need) {
      const c = (r.payer_inn && byInn[String(r.payer_inn).trim()]) || (r.payer_name && byNm[normName(r.payer_name)]);
      if (c) {
        r.counterparty_id = c.id; r.cp_name = c.name;
        db.pool.query('UPDATE cash_transactions SET counterparty_id=$1 WHERE id=$2 AND counterparty_id IS NULL', [c.id, r.id]).catch(() => {});
      }
    }
  }
  res.json({
    items: rows,
    totals: { in: Number(agg.tin), out: Number(agg.tout) },
    unclassified: Number(agg.unclass),
    total: Number(agg.total),
    page, pageSize,
  });
});

router.post('/api/tx', J, async (req, res) => {
  const b = req.body || {};
  const type = ['in', 'out', 'transfer'].includes(b.tx_type) ? b.tx_type : null;
  if (!type) return res.status(400).json({ error: 'Не указан тип операции' });
  const amount = Number(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма должна быть больше 0' });
  const date = b.tx_date || new Date().toISOString().slice(0, 10);
  const wallet = intOrNull(b.wallet_id);
  if (!wallet) return res.status(400).json({ error: 'Выберите кошелёк' });
  if (type === 'transfer') {
    const to = intOrNull(b.wallet_to_id);
    if (!to) return res.status(400).json({ error: 'Выберите кошелёк-получатель' });
    if (to === wallet) return res.status(400).json({ error: 'Кошельки источника и получателя совпадают' });
    const fee = Number(b.fee_amount);
    // Если получатель — касса, и комиссию/факт. сумму ещё не указали при создании (fee_amount пуст) —
    // помечаем «требует подтверждения»: бухгалтер позже впишет факт. приход, комиссия посчитается сама.
    const toWallet = (await db.pool.query('SELECT kind FROM cash_wallets WHERE id=$1', [to])).rows[0];
    const needsCashConfirm = !!(toWallet && toWallet.kind === 'cash' && !(fee > 0));
    await db.pool.query(
      `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, wallet_to_id, purpose, source, is_classified, needs_cash_confirm, created_by)
       VALUES ($1,$2,'transfer',$3,$4,$5,'manual',true,$6,$7)`,
      [date, amount, wallet, to, b.purpose || null, needsCashConfirm, req.user.id]);
    // Комиссия/% за перевод — отдельным расходом со своей статьёй ДДС (если указана).
    // fee_wallet='from' (по умолчанию) — комиссию берёт банк-отправитель отдельной проводкой (сумма перевода доходит полностью).
    // fee_wallet='to' — используется для обналичивания: банк списывает ровно указанную сумму (как в выписке),
    // а по факту в кассу приходит меньше — недостача списывается расходом с кошелька-получателя (кассы).
    if (fee > 0) {
      const feeCat = intOrNull(b.fee_category_id);
      const feeWallet = b.fee_wallet === 'to' ? to : wallet;
      await db.pool.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, is_classified, created_by)
         VALUES ($1,$2,'out',$3,$4,$5,'manual',$6,$7)`,
        [date, fee, feeWallet, feeCat, 'Комиссия/% за перевод' + (b.purpose ? ' — ' + b.purpose : ''), !!feeCat, req.user.id]);
    }
  } else {
    let cat = intOrNull(b.category_id);
    // Наличная касса: если статья не указана явно — пробуем подобрать по ключевым словам
    // из пояснения, теми же словами, что уже используются в общем авто-разборе.
    if (!cat && b.purpose) cat = await guessCategoryByKeyword(b.purpose);
    const currency = b.currency === 'USD' ? 'USD' : 'UZS';
    // Выдача снабженцу под отчёт: наличный расход (кошелёк kind='cash') со статьёй «Сырьё» — по умолчанию да.
    let supplyAdv = false;
    if (type === 'out') {
      if (b.is_supply_advance !== undefined) supplyAdv = !!b.is_supply_advance;
      else if (cat != null) {
        const wk = (await db.pool.query('SELECT kind FROM cash_wallets WHERE id=$1', [wallet])).rows[0];
        if (wk && wk.kind === 'cash') supplyAdv = (await siryeCatIdSet()).has(cat);
      }
    }
    const ins = await db.pool.query(
      `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, wallet_to_id, counterparty_id, contract_id, category_id, purpose, source, is_classified, payer_name, currency, fx_rate, fx_amount, is_supply_advance, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [date, amount, type, wallet, intOrNull(b.wallet_to_id), intOrNull(b.counterparty_id), intOrNull(b.contract_id), cat, b.purpose || null, !!cat, b.payer_name || null, currency, numOrNull(b.fx_rate), numOrNull(b.fx_amount), supplyAdv, req.user.id]);
    await db.log(req.user.id, 'cash_tx_add', type + ' ' + amount);
    return res.json({ ok: true, id: ins.rows[0].id });
  }
  await db.log(req.user.id, 'cash_tx_add', type + ' ' + amount);
  res.json({ ok: true });
});

// Редактирование / классификация транзакции.
// Тип обычно не меняем (чтобы остатки не задваивались) — ЕДИНСТВЕННОЕ исключение: если ставят
// статью «100 A2A» и указывают «Куда (кошелёк)» на строке, которая была in/out (типичный сценарий —
// разбор импортированной банковской выписки, где обналичивание сначала видно как обычный расход) —
// тогда это на самом деле перевод, и мы честно конвертируем tx_type в 'transfer', иначе кошелёк-
// получатель никогда не будет реально зачислен (wallet_to_id без tx_type='transfer' балансом игнорируется).
// Одна транзакция по id (для перехода из Зарплаты по ссылке «в Кассе →»).
router.get('/api/tx/:id(\\d+)', async (req, res) => {
  try {
    const r = (await db.pool.query(
      `SELECT t.*, COALESCE(t.report_hidden,false) AS hidden, w.name AS wallet_name, w.color AS wallet_color, w2.name AS wallet_to_name,
              cp.name AS cp_name, cat.code AS cat_code, cat.name AS cat_name
       FROM cash_transactions t
       LEFT JOIN cash_wallets w ON w.id = t.wallet_id
       LEFT JOIN cash_wallets w2 ON w2.id = t.wallet_to_id
       LEFT JOIN cash_counterparties cp ON cp.id = t.counterparty_id
       LEFT JOIN cash_categories cat ON cat.id = t.category_id
       WHERE t.id = $1`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Транзакция не найдена' });
    res.json({ item: r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/tx/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  const cat = intOrNull(b.category_id);
  const walletTo = intOrNull(b.wallet_to_id);
  const cur = (await db.pool.query('SELECT tx_type, wallet_id FROM cash_transactions WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Операция не найдена' });
  let newType = null; // null = не менять
  let needsCashConfirm = null; // null = не менять
  if (walletTo && walletTo !== cur.wallet_id && cur.tx_type !== 'transfer' && cat) {
    // Любая под-категория перевода (межбанк/обнал/пополнение карты) с указанным получателем → это перевод.
    const isTransferCat = (await db.pool.query("SELECT 1 FROM cash_categories WHERE id=$1 AND direction_hint='transfer' LIMIT 1", [cat])).rows[0];
    if (isTransferCat) {
      newType = 'transfer';
      const toWallet = (await db.pool.query('SELECT kind, has_statement FROM cash_wallets WHERE id=$1', [walletTo])).rows[0];
      // Подтверждение факт. суммы нужно, когда получатель без выписки (касса) — там всплывает комиссия обнала.
      needsCashConfirm = !!(toWallet && toWallet.has_statement === false);
    }
  }
  const currency = (b.currency === 'USD' || b.currency === 'UZS') ? b.currency : null;
  // Галочка «выдача снабженцу» — меняем только если поле пришло явно (обычная правка ячеек её не трогает).
  const supplyAdv = (b.is_supply_advance === undefined || b.is_supply_advance === null) ? null : !!b.is_supply_advance;
  await db.pool.query(
    `UPDATE cash_transactions SET tx_date=COALESCE($1,tx_date), amount=COALESCE($2,amount),
       counterparty_id=$3, contract_id=$4, category_id=$5, purpose=$6, is_classified=$7,
       payer_name=COALESCE($9,payer_name), wallet_to_id=$10,
       tx_type=COALESCE($11,tx_type), needs_cash_confirm=COALESCE($12,needs_cash_confirm),
       currency=COALESCE($13,currency), fx_rate=COALESCE($14,fx_rate), fx_amount=COALESCE($15,fx_amount),
       is_supply_advance=COALESCE($16,is_supply_advance)
     WHERE id=$8`,
    [b.tx_date || null, b.amount ? Number(b.amount) : null, intOrNull(b.counterparty_id), intOrNull(b.contract_id), cat, b.purpose || null, !!cat, req.params.id, b.payer_name != null ? b.payer_name : null, walletTo, newType, needsCashConfirm, currency, numOrNull(b.fx_rate), numOrNull(b.fx_amount), supplyAdv]);
  // Если строка стала переводом на счёт С выпиской (банк/карта) — на нём обычно уже есть парный приход
  // из его же выписки (часто сидит выручкой). Перевод сам зачисляет деньги, поэтому тот приход — дубль.
  // Убираем ОДИН ближайший парный приход (та же сумма ±0.5, ±1 день, без контрагента). Кассу не трогаем.
  let removedDup = 0;
  if (newType === 'transfer' && needsCashConfirm !== true && walletTo) {
    const me = (await db.pool.query('SELECT amount, tx_date FROM cash_transactions WHERE id=$1', [req.params.id])).rows[0];
    if (me) {
      const dq = await db.pool.query(
        `DELETE FROM cash_transactions WHERE id = (
           SELECT id FROM cash_transactions
            WHERE tx_type='in' AND wallet_id=$1 AND counterparty_id IS NULL AND source<>'opening'
              AND ABS(amount-$2)<0.5 AND ABS(tx_date-$3::date)<=1
            ORDER BY ABS(tx_date-$3::date), id LIMIT 1)`,
        [walletTo, Number(me.amount), me.tx_date]);
      removedDup = dq.rowCount || 0;
    }
  }
  await db.log(req.user.id, 'cash_tx_edit', '#' + req.params.id + (removedDup ? ' (убран дубль-приход)' : ''));
  res.json({ ok: true, removedDup });
});

// Подтверждение факт. суммы прихода по обналичиванию/переводу в кассу — считает и списывает
// комиссию (статья 64) как разницу между тем, что снято с банка, и тем, что реально пришло.
router.post('/api/tx/:id(\\d+)/confirm-cash', J, async (req, res) => {
  const b = req.body || {};
  // Факт получено: сумами + (опционально) долларами по курсу. fact_amount — обратная совместимость.
  const factSum = numOrNull(b.fact_sum != null ? b.fact_sum : b.fact_amount) || 0;
  const factUsd = numOrNull(b.fact_usd) || 0;
  const t = (await db.pool.query(
    "SELECT tx_date, amount, wallet_to_id, purpose FROM cash_transactions WHERE id=$1 AND tx_type='transfer' AND needs_cash_confirm=true", [req.params.id])).rows[0];
  if (!t) return res.status(404).json({ error: 'Операция не найдена или уже подтверждена' });
  let rate = numOrNull(b.rate) || 0;
  if (factUsd > 0 && !(rate > 0)) { try { rate = await getCbuUsdRate(String(t.tx_date).slice(0, 10)); } catch (e) { rate = null; } }
  if (factUsd > 0 && !(rate > 0)) return res.status(400).json({ error: 'Укажите курс для долларовой части' });
  const usdEquiv = factUsd > 0 ? Math.round(factUsd * rate) : 0;
  const totalFact = Math.round(factSum) + usdEquiv;
  if (!(totalFact > 0)) return res.status(400).json({ error: 'Укажите фактический приход' });
  if (totalFact > Number(t.amount) + 0.5) return res.status(400).json({ error: 'Факт. приход не может быть больше снятой суммы' });
  const diff = Number(t.amount) - totalFact;
  const wid = t.wallet_to_id;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Долларовая часть обнала: часть принесённых переводом сумов становится долларами (статья 102).
    if (usdEquiv > 0) {
      const conv = (await client.query("SELECT id FROM cash_categories WHERE code='102' LIMIT 1")).rows[0];
      const cid = conv ? conv.id : null;
      const p = 'Долларовая часть (наличные с банка)' + (t.purpose ? ' — ' + t.purpose : '');
      await client.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, is_classified, currency, parent_tx_id, created_by)
         VALUES ($1,$2,'out',$3,$4,$5,'manual',true,'UZS',$6,$7)`, [t.tx_date, usdEquiv, wid, cid, p, req.params.id, req.user.id]);
      await client.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, is_classified, currency, fx_rate, fx_amount, parent_tx_id, created_by)
         VALUES ($1,$2,'in',$3,$4,$5,'manual',true,'USD',$6,$7,$8,$9)`, [t.tx_date, usdEquiv, wid, cid, p, rate, factUsd, req.params.id, req.user.id]);
    }
    // Комиссия обнала (статья 64) — разница между снятым и фактически полученным.
    if (diff > 0.5) {
      const feeCat = (await client.query("SELECT id FROM cash_categories WHERE code='64' LIMIT 1")).rows[0];
      const pct = (diff / Number(t.amount) * 100).toFixed(2);
      await client.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, is_classified, parent_tx_id, created_by)
         VALUES ($1,$2,'out',$3,$4,$5,'manual',$6,$7,$8)`,
        [t.tx_date, diff, wid, feeCat ? feeCat.id : null, `Комиссия при получении наличных (${pct}%)` + (t.purpose ? ' — ' + t.purpose : ''), !!feeCat, req.params.id, req.user.id]);
    }
    await client.query('UPDATE cash_transactions SET needs_cash_confirm=false WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    await db.log(req.user.id, 'cash_confirm_cash', `#${req.params.id} сум=${factSum} $=${factUsd} комиссия=${diff}`);
    res.json({ ok: true, diff, usdEquiv });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});
router.post('/api/tx/:id(\\d+)/delete', async (req, res) => {
  await db.pool.query('DELETE FROM cash_transactions WHERE id=$1', [req.params.id]);
  await db.log(req.user.id, 'cash_tx_delete', '#' + req.params.id);
  res.json({ ok: true });
});
router.post('/api/tx/bulk-delete', J, async (req, res) => {
  const ids = (req.body && Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Ничего не выбрано' });
  await db.pool.query('DELETE FROM cash_transactions WHERE id = ANY($1)', [ids]);
  await db.log(req.user.id, 'cash_tx_bulk_delete', ids.length + ' шт');
  res.json({ ok: true, deleted: ids.length });
});
// Скрыть/вернуть строки в выпадашках отчёта (вариант А: только визуально, суммы/баланс не меняются).
router.post('/api/tx/hide', J, async (req, res) => {
  const ids = (req.body && Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Ничего не выбрано' });
  const hidden = !!(req.body && req.body.hidden);
  await db.pool.query('UPDATE cash_transactions SET report_hidden=$1 WHERE id = ANY($2)', [hidden, ids]);
  await db.log(req.user.id, hidden ? 'cash_tx_hide' : 'cash_tx_unhide', ids.length + ' шт');
  res.json({ ok: true, count: ids.length, hidden });
});
// Массовое присвоение статьи выбранным строкам (из вкладки «Транзакции»).
router.post('/api/tx/bulk-classify', J, async (req, res) => {
  const ids = (req.body && Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
  const catId = intOrNull(req.body.category_id);
  if (!ids.length) return res.status(400).json({ error: 'Ничего не выбрано' });
  if (!catId) return res.status(400).json({ error: 'Выберите статью' });
  const r = await db.pool.query("UPDATE cash_transactions SET category_id=$1, is_classified=true WHERE id = ANY($2) AND tx_type <> 'transfer'", [catId, ids]);
  await db.log(req.user.id, 'cash_tx_bulk_classify', `${r.rowCount} шт → статья ${catId}`);
  res.json({ ok: true, applied: r.rowCount });
});

// ---------- Умный разбор «Не разобрано» ----------
// Группировка неразобранных не-переводов по контрагенту (иначе по тексту плательщика).
router.get('/api/triage/groups', async (req, res) => {
  const { from, to, wallet } = req.query;
  const p = [], w = ["t.tx_type <> 'transfer'", 't.is_classified = false'];
  if (from) { p.push(from); w.push(`t.tx_date >= $${p.length}`); }
  if (to) { p.push(to); w.push(`t.tx_date <= $${p.length}`); }
  if (wallet) { p.push(parseInt(wallet)); w.push(`t.wallet_id = $${p.length}`); }
  const rows = (await db.pool.query(
    `SELECT t.counterparty_id AS cp_id, cp.name AS cp_name, cp.default_category_id,
            CASE WHEN t.counterparty_id IS NULL THEN COALESCE(t.payer_name,'') END AS payer_raw,
            COUNT(*)::int AS cnt,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type='in'),0) AS sum_in,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type='out'),0) AS sum_out,
            (ARRAY_AGG(t.purpose ORDER BY t.amount DESC) FILTER (WHERE COALESCE(t.purpose,'')<>''))[1] AS sample
     FROM cash_transactions t
     LEFT JOIN cash_counterparties cp ON cp.id = t.counterparty_id
     WHERE ${w.join(' AND ')}
     GROUP BY t.counterparty_id, cp.name, cp.default_category_id, (CASE WHEN t.counterparty_id IS NULL THEN COALESCE(t.payer_name,'') END)
     ORDER BY (COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type='in'),0) + COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type='out'),0)) DESC
     LIMIT 300`, p)).rows;
  const groups = rows.map((r) => ({
    key_type: r.cp_id ? 'cp' : 'payer',
    cp_id: r.cp_id || null,
    payer_name: r.cp_id ? null : (r.payer_raw || ''),
    name: r.cp_id ? (r.cp_name || 'Контрагент #' + r.cp_id) : (r.payer_raw || '(без плательщика)'),
    default_category_id: r.default_category_id || null,
    cnt: r.cnt, sum_in: Number(r.sum_in), sum_out: Number(r.sum_out), sample: r.sample || '',
  }));
  res.json({
    groups,
    totalCnt: groups.reduce((a, g) => a + g.cnt, 0),
    totalSum: groups.reduce((a, g) => a + g.sum_in + g.sum_out, 0),
  });
});
// Разобрать группу: статья всем неразобранным позициям группы + опц. правило для контрагента.
router.post('/api/triage/classify', J, async (req, res) => {
  const b = req.body || {};
  const catId = intOrNull(b.category_id);
  if (!catId) return res.status(400).json({ error: 'Выберите статью' });
  const cpId = intOrNull(b.cp_id);
  const p = [catId], w = ["tx_type <> 'transfer'", 'is_classified = false'];
  if (cpId) { p.push(cpId); w.push(`counterparty_id = $${p.length}`); }
  else { p.push(String(b.payer_name || '')); w.push(`counterparty_id IS NULL AND COALESCE(payer_name,'') = $${p.length}`); }
  if (b.from) { p.push(b.from); w.push(`tx_date >= $${p.length}`); }
  if (b.to) { p.push(b.to); w.push(`tx_date <= $${p.length}`); }
  if (b.wallet) { p.push(parseInt(b.wallet)); w.push(`wallet_id = $${p.length}`); }
  const r = await db.pool.query(`UPDATE cash_transactions SET category_id=$1, is_classified=true WHERE ${w.join(' AND ')}`, p);
  if (b.remember && cpId) await db.pool.query('UPDATE cash_counterparties SET default_category_id=$1 WHERE id=$2', [catId, cpId]);
  await db.log(req.user.id, 'cash_triage_classify', `${r.rowCount} шт → статья ${catId}${b.remember && cpId ? ' (+правило)' : ''}`);
  res.json({ ok: true, applied: r.rowCount });
});

// ---------- Импорт банковской выписки ----------
// Декодер cp1251 (выписка Asia Alliance в windows-1251).
const CP1251_HIGH = {
  0x80: 0x0402, 0x81: 0x0403, 0x82: 0x201A, 0x83: 0x0453, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x20AC, 0x89: 0x2030, 0x8A: 0x0409, 0x8B: 0x2039, 0x8C: 0x040A, 0x8D: 0x040C, 0x8E: 0x040B, 0x8F: 0x040F,
  0x90: 0x0452, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x0098, 0x99: 0x2122, 0x9A: 0x0459, 0x9B: 0x203A, 0x9C: 0x045A, 0x9D: 0x045C, 0x9E: 0x045B, 0x9F: 0x045F,
  0xA0: 0x00A0, 0xA1: 0x040E, 0xA2: 0x045E, 0xA3: 0x0408, 0xA4: 0x00A4, 0xA5: 0x0490, 0xA6: 0x00A6, 0xA7: 0x00A7,
  0xA8: 0x0401, 0xA9: 0x00A9, 0xAA: 0x0404, 0xAB: 0x00AB, 0xAC: 0x00AC, 0xAD: 0x00AD, 0xAE: 0x00AE, 0xAF: 0x0407,
  0xB0: 0x00B0, 0xB1: 0x00B1, 0xB2: 0x0406, 0xB3: 0x0456, 0xB4: 0x0491, 0xB5: 0x00B5, 0xB6: 0x00B6, 0xB7: 0x00B7,
  0xB8: 0x0451, 0xB9: 0x2116, 0xBA: 0x0454, 0xBB: 0x00BB, 0xBC: 0x0458, 0xBD: 0x0405, 0xBE: 0x0455, 0xBF: 0x0457,
};
function decodeCp1251(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b >= 0xC0) s += String.fromCharCode(0x410 + (b - 0xC0));
    else s += String.fromCharCode(CP1251_HIGH[b] || b);
  }
  return s;
}
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
const parseAmount = (s) => { const t = String(s || '').replace(/ /g, '').replace(/\s/g, '').replace(',', '.'); const n = parseFloat(t); return isNaN(n) ? 0 : n; };
const toISO = (dt) => { const m = String(dt || '').match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const extractContract = (p) => { const m = String(p || '').match(/дог(?:овор)?[а-я]?\.?\s*№?\s*([A-Za-zА-Яа-я0-9\-\/]+)/i); return m ? m[1] : null; };

// Парсер выписки Asia Alliance (HTML-as-xls). Колонки: 0 дата · 1 счёт/ИНН/назв · 2 №док · 3 опкод · 4 код к-агента · 5 дебет(расход) · 6 кредит(приход) · 7 назначение.
function parseAsiaAlliance(text) {
  const out = [];
  const trs = text.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const tds = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(stripTags);
    if (tds.length < 8) continue;
    const date = toISO(tds[0]); if (!date) continue; // только строки-данные
    if (/сальдо/i.test(tds[7] || '')) continue; // строки «входящее/исходящее сальдо» — не транзакции
    const credit = parseAmount(tds[6]), debit = parseAmount(tds[5]);
    let type = null, amount = 0;
    if (credit > 0) { type = 'in'; amount = credit; }
    else if (debit > 0) { type = 'out'; amount = debit; }
    else continue;
    const parts = String(tds[1] || '').split('/').map((s) => s.trim());
    // ИНН — 9-значный (или 14 для физлиц) кусок, а не «второй по счёту» вслепую.
    const inn = parts.find((p) => /^\d{9}$/.test(p)) || parts.find((p) => /^\d{14}$/.test(p)) || '';
    const payer = parts.filter((p) => /[A-Za-zА-Яа-я]{3,}/.test(p)).join(' ').trim();
    out.push({
      tx_date: date, amount, tx_type: type, doc_no: tds[2] || '', op: tds[3] || '', cp_code: (tds[4] || '').trim(),
      inn, payer, purpose: tds[7] || '', contract_no: extractContract(tds[7]),
    });
  }
  return out;
}

// Парсер выписки Хаёт (бинарный Excel .xls). Колонки находим по заголовкам.
function parseHayot(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sh = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, raw: false, defval: '' });
  let hdr = -1; const col = {};
  for (let i = 0; i < aoa.length; i++) {
    const row = (aoa[i] || []).map((x) => String(x || '').trim());
    const joined = row.join('|');
    if (joined.includes('Дата документа') && (joined.includes('Обороты по кредиту') || joined.includes('Обороты по дебету'))) {
      hdr = i;
      row.forEach((c, idx) => {
        if (c.includes('Дата документа')) col.date = idx;
        else if (c.includes('док')) col.doc = idx;
        else if (c.includes('Наименование сч')) col.name = idx;
        else if (c.includes('Обороты по дебету')) col.debit = idx;
        else if (c.includes('Обороты по кредиту')) col.credit = idx;
        else if (c.includes('Назначение')) col.purpose = idx;
      });
      break;
    }
  }
  if (hdr < 0 || col.date == null) return [];
  const out = [];
  for (let i = hdr + 1; i < aoa.length; i++) {
    const row = (aoa[i] || []).map((x) => String(x || '').trim());
    const date = toISO(row[col.date]); if (!date) continue;
    if (/сальдо/i.test(row[col.purpose] || '')) continue; // строки сальдо — не транзакции
    const credit = parseAmount(row[col.credit]), debit = parseAmount(row[col.debit]);
    let type = null, amount = 0;
    if (credit > 0) { type = 'in'; amount = credit; }
    else if (debit > 0) { type = 'out'; amount = debit; }
    else continue;
    const nm = row[col.name] || '';
    const innM = nm.match(/(\d{9})\s*$/);
    out.push({
      tx_date: date, amount, tx_type: type, doc_no: row[col.doc] || '', op: '', cp_code: '',
      inn: innM ? innM[1] : '', payer: innM ? nm.slice(0, innM.index).trim() : nm.trim(),
      purpose: row[col.purpose] || '', contract_no: extractContract(row[col.purpose]),
    });
  }
  return out;
}

// Предпросмотр: парсим, классифицируем, помечаем дубли. Ничего не пишем.
router.post('/api/import/preview', upload.single('file'), async (req, res) => {
  try {
    const wallet_id = intOrNull(req.body.wallet_id);
    if (!wallet_id) return res.status(400).json({ error: 'Выберите кошелёк, на который грузим выписку' });
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    let rows, bank;
    const buf = req.file.buffer;
    if (buf[0] === 0xD0 && buf[1] === 0xCF) { rows = parseHayot(buf); bank = 'Хаёт (Excel)'; }
    else { const text = decodeCp1251(buf); if (/<tr/i.test(text)) { rows = parseAsiaAlliance(text); bank = 'Asia Alliance (HTML)'; } else return res.status(400).json({ error: 'Не удалось распознать формат выписки.' }); }
    if (!rows || !rows.length) return res.status(400).json({ error: 'Не нашёл транзакций в файле (проверьте формат).' });
    const cats = (await db.pool.query("SELECT id, code, name FROM cash_categories WHERE status='active'")).rows;
    const catById = {}; cats.forEach((c) => { catById[c.id] = c; });
    const incomeCat = cats.find((c) => c.code === '200') || null;
    const topupCat = cats.find((c) => c.code === '111') || null;
    const xferCat = cats.find((c) => c.code === '100') || null; // переброска между своими счетами
    const walletRow = (await db.pool.query("SELECT kind FROM cash_wallets WHERE id=$1", [wallet_id])).rows[0];
    const isCard = !!walletRow && walletRow.kind === 'card';
    const cpByInn = {};
    (await db.pool.query("SELECT id, inn, default_category_id, name FROM cash_counterparties WHERE status='active' AND inn IS NOT NULL AND inn<>''")).rows.forEach((c) => { cpByInn[String(c.inn).trim()] = c; });
    const refCatByInn = {};
    try { (await db.pool.query("SELECT inn, cash_category_id FROM ref_counterparties WHERE role_supplier=TRUE AND inn IS NOT NULL AND inn<>'' AND cash_category_id IS NOT NULL")).rows.forEach((c) => { refCatByInn[String(c.inn).trim()] = c.cash_category_id; }); } catch (e) { /* колонки ещё нет */ }
    let innMap = {}; try { innMap = require('./data/cash_inn_categories.json') || {}; } catch (e) { /* нет файла */ }
    const innCatId = (inn) => { const code = innMap[String(inn).trim()]; const c = code ? cats.find((x) => String(x.code) === code) : null; return c ? c.id : null; };
    // Дедуп одним запросом: тянем уже загруженные ключи по этому кошельку в Set.
    const existing = new Set();
    (await db.pool.query("SELECT to_char(tx_date,'YYYY-MM-DD') d, amount, COALESCE(bank_doc_no,'') doc FROM cash_transactions WHERE wallet_id=$1 AND source='import'", [wallet_id])).rows
      .forEach((x) => existing.add(x.d + '|' + Number(x.amount) + '|' + x.doc));
    let dup = 0, classified = 0, newcp = 0;
    for (const r of rows) {
      r.dup = existing.has(r.tx_date + '|' + Number(r.amount) + '|' + (r.doc_no || ''));
      if (r.dup) dup++;
      if (isOwnTransfer(r.purpose, r.payer, String(r.inn || '').trim())) {
        // Переброска между своими счетами — статья 100 «Межбанк», без контрагента (см. import/run).
        r.category_id = xferCat ? xferCat.id : null;
        r.cat_label = xferCat ? (xferCat.code + ' ' + xferCat.name) : null;
        r.is_classified = !!xferCat; r.flag = 'transfer'; r.inn = ''; r.payer = '';
      } else if (r.tx_type === 'in') {
        // Приход на карту — пополнение (111), не выручка; контрагента не вешаем (см. import/run).
        const useCat = isCard ? topupCat : incomeCat;
        r.category_id = useCat ? useCat.id : null;
        r.cat_label = useCat ? (useCat.code + ' ' + useCat.name) : null;
        r.is_classified = !!useCat; r.flag = isCard ? 'topup' : 'income';
        if (isCard) { r.inn = ''; r.payer = ''; }
      } else {
        const cp = cpByInn[String(r.inn || '').trim()];
        if (cp) {
          r.counterparty_id = cp.id; r.cp_known = cp.name; r.category_id = cp.default_category_id || null;
          const cat = catById[cp.default_category_id];
          r.cat_label = cat ? (cat.code + ' ' + cat.name) : null;
          r.is_classified = !!cp.default_category_id; r.flag = r.is_classified ? 'ok' : 'cp_no_cat';
        } else if (refCatByInn[String(r.inn || '').trim()] || innCatId(r.inn)) {
          r.category_id = refCatByInn[String(r.inn || '').trim()] || innCatId(r.inn);
          const cat = catById[r.category_id];
          r.cat_label = cat ? (cat.code + ' ' + cat.name) : null;
          r.is_classified = !!r.category_id; r.flag = 'ok'; newcp++;
        } else { r.is_classified = false; r.flag = 'new_cp'; newcp++; }
      }
      if (r.is_classified) classified++;
    }
    const payload = Buffer.from(JSON.stringify({ wallet_id, rows })).toString('base64');
    res.json({ summary: { bank, total: rows.length, dup, classified, newcp, willInsert: rows.length - dup }, rows: rows.slice(0, 300), payload });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Подтверждение: пишем непродублированные строки в журнал с import_batch_id.
router.post('/api/import/commit', J, async (req, res) => {
  try {
    const data = JSON.parse(Buffer.from(String(req.body.payload || ''), 'base64').toString('utf8'));
    const wallet_id = intOrNull(data.wallet_id);
    if (!wallet_id) return res.status(400).json({ error: 'Нет кошелька' });
    const batch = (await db.pool.query('INSERT INTO cash_import_batches (wallet_id, filename, count, created_by) VALUES ($1,$2,0,$3) RETURNING id', [wallet_id, req.body.filename || null, req.user.id])).rows[0].id;
    let ins = 0, skip = 0;
    for (const r of (data.rows || [])) {
      if (r.dup) { skip++; continue; }
      await db.pool.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, counterparty_id, category_id, purpose, bank_doc_no, source, import_batch_id, is_classified, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import',$9,$10,$11)`,
        [r.tx_date, r.amount, r.tx_type, wallet_id, intOrNull(r.counterparty_id), intOrNull(r.category_id), r.purpose || null, r.doc_no || null, batch, !!r.is_classified, req.user.id]);
      ins++;
    }
    await db.pool.query('UPDATE cash_import_batches SET count=$1 WHERE id=$2', [ins, batch]);
    await db.log(req.user.id, 'cash_import', `+${ins}, пропущено ${skip}`);
    res.json({ ok: true, inserted: ins, skipped: skip, batch });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Импорт «в одно действие»: распознать банк → распарсить → классифицировать → записать (дубли пропустить).
router.post('/api/import/run', upload.single('file'), async (req, res) => {
  try {
    const wallet_id = intOrNull(req.body.wallet_id);
    if (!wallet_id) return res.status(400).json({ error: 'Выберите кошелёк' });
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    let rows, bank; const buf = req.file.buffer;
    if (buf[0] === 0xD0 && buf[1] === 0xCF) { rows = parseHayot(buf); bank = 'Хаёт (Excel)'; }
    else { const text = decodeCp1251(buf); if (/<tr/i.test(text)) { rows = parseAsiaAlliance(text); bank = 'Asia Alliance (HTML)'; } else return res.status(400).json({ error: 'Не удалось распознать формат выписки.' }); }
    if (!rows || !rows.length) return res.status(400).json({ error: 'Не нашёл транзакций в файле (проверьте формат).' });
    const cats = (await db.pool.query("SELECT id, code FROM cash_categories WHERE status='active'")).rows;
    const incomeCat = cats.find((c) => c.code === '200') || null;
    const catByCode = {}; cats.forEach((c) => { catByCode[String(c.code)] = c.id; });
    // Кошелёк-карта: приход — это пополнение с расчётного счёта (перевод между своими), не выручка.
    const wkindRow = (await db.pool.query("SELECT kind FROM cash_wallets WHERE id=$1", [wallet_id])).rows[0];
    const isCard = !!wkindRow && wkindRow.kind === 'card';
    const topupCatId = catByCode['111'] || null;
    const cpByInn = {};
    (await db.pool.query("SELECT id, inn, default_category_id FROM cash_counterparties WHERE status='active' AND inn IS NOT NULL AND inn<>''")).rows.forEach((c) => { cpByInn[String(c.inn).trim()] = c; });
    // запасная классификация расходов: статья ДДС поставщика из Закупа (по ИНН)
    const refCatByInn = {};
    try { (await db.pool.query("SELECT inn, cash_category_id FROM ref_counterparties WHERE role_supplier=TRUE AND inn IS NOT NULL AND inn<>'' AND cash_category_id IS NOT NULL")).rows.forEach((c) => { refCatByInn[String(c.inn).trim()] = c.cash_category_id; }); } catch (e) { /* колонки ещё нет */ }
    // справочник ИНН→код (поставщики + админ-расходы), резолвим код в id категории
    let innMap = {}; try { innMap = require('./data/cash_inn_categories.json') || {}; } catch (e) { /* нет файла */ }
    const innCat = (inn) => { const code = innMap[String(inn).trim()]; return code && catByCode[code] ? catByCode[code] : null; };
    const existing = new Set();
    (await db.pool.query("SELECT to_char(tx_date,'YYYY-MM-DD') d, amount, COALESCE(bank_doc_no,'') doc FROM cash_transactions WHERE wallet_id=$1 AND source='import'", [wallet_id])).rows
      .forEach((x) => existing.add(x.d + '|' + Number(x.amount) + '|' + x.doc));
    const batch = (await db.pool.query('INSERT INTO cash_import_batches (wallet_id, filename, count, created_by) VALUES ($1,$2,0,$3) RETURNING id', [wallet_id, req.file.originalname || null, req.user.id])).rows[0].id;
    let ins = 0, skip = 0, newcp = 0;
    for (const r of rows) {
      // Дедуп ТОЛЬКО против ранее загруженных строк (защита от повторной загрузки файла).
      // Внутри одного файла одинаковые строки НЕ пропускаем: два клиента могут заплатить
      // одну сумму в один день — раньше второй платёж молча терялся.
      const key = r.tx_date + '|' + Number(r.amount) + '|' + (r.doc_no || '');
      if (existing.has(key)) { skip++; continue; }
      let category_id = null, counterparty_id = null, is_classified = false;
      const inn = String(r.inn || '').trim();
      if (isOwnTransfer(r.purpose, r.payer, inn)) {
        // Переброска между своими счетами (плательщик/получатель — своё юрлицо, либо «переброска /
        // на основной расчётный счёт»). Статья 100 «Межбанк», без контрагента — не выручка/не расход.
        category_id = catByCode['100'] || null; is_classified = !!category_id; r.payer = null; r.inn = null;
      } else if (r.tx_type === 'in') {
        if (isCard) {
          // Пополнение корпоративной карты с расчётного счёта — перевод между своими, а не выручка.
          // Статья 111, и НЕ привязываем контрагента/ИНН — иначе runRelink повесит контрагента и
          // «Найти переводы» (ищет приходы без контрагента) не сможет склеить пополнение с ногой банка.
          category_id = topupCatId; is_classified = !!topupCatId; r.payer = null; r.inn = null;
        } else {
          category_id = incomeCat ? incomeCat.id : null; is_classified = !!incomeCat;
          const cl = cpByInn[inn]; if (cl) counterparty_id = cl.id;
        }
      } else {
        const cp = cpByInn[inn];
        if (cp) { counterparty_id = cp.id; category_id = cp.default_category_id || null; }
        if (!category_id && refCatByInn[inn]) category_id = refCatByInn[inn]; // статья поставщика из Закупа
        if (!category_id) category_id = innCat(inn);                          // справочник ИНН→код
        is_classified = !!category_id;
        if (!cp) newcp++;
      }
      await db.pool.query(
        `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, counterparty_id, category_id, purpose, bank_doc_no, source, import_batch_id, is_classified, payer_name, payer_inn, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import',$9,$10,$11,$12,$13)`,
        [r.tx_date, r.amount, r.tx_type, wallet_id, counterparty_id, category_id, r.purpose || null, r.doc_no || null, batch, is_classified, r.payer || null, r.inn || null, req.user.id]);
      ins++;
    }
    await db.pool.query('UPDATE cash_import_batches SET count=$1 WHERE id=$2', [ins, batch]);
    try { await runRelink(); } catch (e) { /* авто-разбор не критичен */ }
    await db.log(req.user.id, 'cash_import', `${bank}: +${ins}, пропущено ${skip}`);
    res.json({ ok: true, bank, inserted: ins, skipped: skip, newcp });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Очистка транзакций (админ). Справочники/контрагенты/статьи НЕ трогаем.
router.post('/api/transactions/wipe', J, async (req, res) => {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Только администратор' });
  try {
    const n = (await db.pool.query('SELECT count(*)::int c FROM cash_transactions')).rows[0].c;
    await db.pool.query('DELETE FROM cash_transactions');
    await db.pool.query('DELETE FROM cash_import_batches');
    await db.log(req.user.id, 'cash_wipe_transactions', `удалено ${n}`);
    res.json({ ok: true, deleted: n });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Авто-разбор транзакций: контрагент по ИНН + статья ДДС (дефолт контрагента → Закуп →
// справочник ИНН) + внутренние переводы (свои юрлица) → ОБН. Не перетирает заполненное.
// Запускается сам после импорта и синхронизации клиентов; кнопки для этого не нужно.
function normName(s) {
  return String(s || '').toUpperCase()
    .replace(/["«»'`]/g, ' ')
    .replace(/\b(OOO|ООО|МЧЖ|MCHJ|АЖ|AJ|XK|ХК|ЧП|OJ|MAS.?ULIYATI|CHEKLANGAN|JAMIYAT|XUSUSIY|KORXONA|OILAVIY|QO.?SHMA|XORIJIY|FERMER|XO.?JALIGI|LLC|АО|ATB|AKSIYADORLIK)\b/g, ' ')
    .replace(/[^A-ZА-Я0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
async function runRelink() {
  // 1) Контрагент по ИНН плательщика (где ещё не привязан).
  const link = await db.pool.query(
    `UPDATE cash_transactions t SET counterparty_id = cp.id
     FROM cash_counterparties cp
     WHERE t.counterparty_id IS NULL AND COALESCE(t.payer_inn,'')<>'' AND cp.inn = t.payer_inn AND cp.status='active'`);
  // 1b) Кого не нашли по ИНН — по нормализованному юр.названию (у клиентов SD оно в firm_name).
  let byNameCnt = 0;
  const byName = {};
  (await db.pool.query("SELECT id, name, firm_name FROM cash_counterparties WHERE status='active'")).rows.forEach((c) => {
    for (const nm of [c.firm_name, c.name]) { const k = normName(nm); if (k && k.length >= 4 && !(k in byName)) byName[k] = c.id; }
  });
  const unl = (await db.pool.query("SELECT id, payer_name FROM cash_transactions WHERE counterparty_id IS NULL AND COALESCE(payer_name,'')<>''")).rows;
  for (const t of unl) {
    const cid = byName[normName(t.payer_name)];
    if (cid) { await db.pool.query("UPDATE cash_transactions SET counterparty_id=$1 WHERE id=$2", [cid, t.id]); byNameCnt++; }
  }
  // 2) Статья из дефолтной у привязанного контрагента.
  await db.pool.query(
    `UPDATE cash_transactions t SET category_id = cp.default_category_id, is_classified = true
     FROM cash_counterparties cp
     WHERE t.category_id IS NULL AND t.counterparty_id = cp.id AND cp.default_category_id IS NOT NULL`);
  // 3) Статья из поставщика Закупа по ИНН.
  try {
    await db.pool.query(
      `UPDATE cash_transactions t SET category_id = rc.cash_category_id, is_classified = true
       FROM ref_counterparties rc
       WHERE t.category_id IS NULL AND COALESCE(t.payer_inn,'')<>'' AND rc.inn = t.payer_inn AND rc.cash_category_id IS NOT NULL`);
  } catch (e) { /* нет колонки */ }
  const codeToCat = {};
  (await db.pool.query("SELECT id, code FROM cash_categories WHERE status='active'")).rows.forEach((c) => { codeToCat[String(c.code)] = c.id; });
  // 4) Статья из справочника ИНН→код.
  let innMap = {}; try { innMap = require('./data/cash_inn_categories.json') || {}; } catch (e) { /* нет файла */ }
  let byMap = 0;
  for (const [inn, code] of Object.entries(innMap)) {
    const catId = codeToCat[code]; if (!catId) continue;
    const r = await db.pool.query("UPDATE cash_transactions SET category_id=$1, is_classified=true WHERE category_id IS NULL AND payer_inn=$2", [catId, inn]);
    byMap += r.rowCount || 0;
  }
  // 5) Ключевые слова из классификатора: фраза в назначении или «от кого» → статья.
  // Сначала A2A(100) заполняет только пустые; затем конкретные статьи могут переписать
  // общую A2A на более точную (напр. «начислен» → 62 % банка).
  let byKw = 0;
  const a2aId = codeToCat['100'] || null;
  const kwCats = (await db.pool.query("SELECT id, keywords FROM cash_categories WHERE status='active' AND keywords IS NOT NULL AND keywords<>''")).rows;
  kwCats.sort((a, b) => (a.id === a2aId ? -1 : b.id === a2aId ? 1 : 0)); // A2A первым
  for (const c of kwCats) {
    const phrases = String(c.keywords).split(/[,\n;|]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
    const overrideA2A = a2aId && c.id !== a2aId;
    for (const ph of phrases) {
      const esc = ph.replace(/[\\%_]/g, '\\$&'); // экранируем спецсимволы LIKE
      const cond = overrideA2A ? '(category_id IS NULL OR category_id = $3)' : 'category_id IS NULL';
      const params = overrideA2A ? [c.id, '%' + esc + '%', a2aId] : [c.id, '%' + esc + '%'];
      const r = await db.pool.query(
        `UPDATE cash_transactions SET category_id=$1, is_classified=true WHERE ${cond} AND (purpose ILIKE $2 OR payer_name ILIKE $2)`, params);
      byKw += r.rowCount || 0;
    }
  }
  // 6) Сквозные платежи через банк (ИНН банка), ошибочно попавшие в 62 без признаков
  //    комиссии — сбрасываем в «не разобрано», чтобы поставить верную статью вручную.
  if (codeToCat['62'] && BANK_INNS.length) {
    await db.pool.query(
      `UPDATE cash_transactions SET category_id=NULL, is_classified=false
       WHERE category_id=$1 AND payer_inn = ANY($2)
         AND (COALESCE(purpose,'') || ' ' || COALESCE(payer_name,'')) !~* $3`,
      [codeToCat['62'], BANK_INNS, 'начислен|% банка|комисс|оп\\.обс']).catch(() => {});
  }
  return { linked: (link.rowCount || 0) + byNameCnt, byInn: link.rowCount || 0, byName: byNameCnt, byMap, byKw };
}
router.post('/api/transactions/relink', J, async (req, res) => {
  try { const r = await runRelink(); await db.log(req.user.id, 'cash_relink', `контрагентов ${r.linked} (ИНН ${r.byInn}, назв ${r.byName}), статей по ИНН ${r.byMap}, по словам ${r.byKw}`); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Поиск и склейка переводов между своими счетами (A2A) ----------
// Проблема: перевод между своими кошельками через банк приходит ДВУМЯ независимыми записями —
// «Расход» на кошельке-отправителе и «Приход» на кошельке-получателе (два разных банка, две выписки).
// Это одно и то же движение денег. Верно — одна запись tx_type='transfer' (она сама и списывает,
// и зачисляет). Находим пары out/in на РАЗНЫХ кошельках с одинаковой суммой и близкой датой
// (банк может провести на следующий день), которые ещё не переводы, и предлагаем на подтверждение.
router.get('/api/transactions/match-candidates', async (req, res) => {
  try {
    const days = 1; // допуск по дате между списанием и зачислением (было 3 — давало много ложных пар)
    // Признак реального перевода между своими счетами (защита от совпадения сумм у обычных операций).
    const transferRe = '(перевод|переброск|пополнени|между[[:space:]]+сч[её]т|на[[:space:]]+карт|корпоративн|перечисл|со[[:space:]]+сч[её]т|на[[:space:]]+сч[её]т|основн[[:alpha:]]*[[:space:]]+расч[её]т|novagreen|новагрин|a2a)';
    const rows = (await db.pool.query(
      `SELECT o.id AS out_id, o.tx_date AS out_date, o.wallet_id AS out_wallet, wo.name AS out_wallet_name,
              o.purpose AS out_purpose, o.payer_name AS out_payer,
              i.id AS in_id, i.tx_date AS in_date, i.wallet_id AS in_wallet, wi.name AS in_wallet_name,
              i.purpose AS in_purpose, i.payer_name AS in_payer,
              o.amount AS amount, ABS(i.tx_date - o.tx_date) AS gap_days
       FROM cash_transactions o
       JOIN cash_transactions i
         ON i.tx_type = 'in' AND o.tx_type = 'out'
        AND i.wallet_id <> o.wallet_id
        AND i.amount = o.amount
        AND ABS(i.tx_date - o.tx_date) <= $1
       JOIN cash_wallets wo ON wo.id = o.wallet_id
       JOIN cash_wallets wi ON wi.id = i.wallet_id
       WHERE o.source <> 'opening' AND i.source <> 'opening'
         -- Наличную кассу не склеиваем автоматически (обнал/внесение налички ведём вручную).
         AND wo.kind <> 'cash' AND wi.kind <> 'cash'
         -- У перевода между своими счетами нет внешнего контрагента.
         AND o.counterparty_id IS NULL AND i.counterparty_id IS NULL
         -- Защищаем строки с ОСМЫСЛЕННОЙ статьёй (кредит/зарплата/поставщик и т.п.) — их склейка бы перебила.
         -- Но выручку (200) разрешаем: переброски, ошибочно попавшие в выручку, нужно уметь склеить.
         -- В пары берём: без статьи, переводные (100/110/111) или выручку (200).
         AND (o.category_id IS NULL OR EXISTS (SELECT 1 FROM cash_categories c WHERE c.id=o.category_id AND (c.direction_hint='transfer' OR c.code='200')))
         AND (i.category_id IS NULL OR EXISTS (SELECT 1 FROM cash_categories c WHERE c.id=i.category_id AND (c.direction_hint='transfer' OR c.code='200')))
         -- Хотя бы одна из строк должна выглядеть как перевод (иначе это просто совпадение суммы).
         AND (COALESCE(o.purpose,'') ~* $2 OR COALESCE(i.purpose,'') ~* $2
              OR COALESCE(o.payer_name,'') ~* $2 OR COALESCE(i.payer_name,'') ~* $2)
       ORDER BY gap_days, o.tx_date DESC
       LIMIT 200`, [days, transferRe])).rows;
    // Каждую запись — только в одну пару (жадно, от самой близкой даты).
    const usedOut = new Set(), usedIn = new Set(), pairs = [];
    for (const r of rows) {
      if (usedOut.has(r.out_id) || usedIn.has(r.in_id)) continue;
      usedOut.add(r.out_id); usedIn.add(r.in_id);
      pairs.push({
        out_id: r.out_id, in_id: r.in_id, amount: Number(r.amount),
        out_date: r.out_date, in_date: r.in_date, gap_days: r.gap_days,
        out_wallet: r.out_wallet, out_wallet_name: r.out_wallet_name,
        in_wallet: r.in_wallet, in_wallet_name: r.in_wallet_name,
        out_purpose: r.out_purpose, in_purpose: r.in_purpose,
        out_payer: r.out_payer, in_payer: r.in_payer,
      });
    }
    res.json({ pairs });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/transactions/match-confirm', J, async (req, res) => {
  const pairs = (req.body && req.body.pairs) || [];
  if (!Array.isArray(pairs) || !pairs.length) return res.status(400).json({ error: 'Нет пар для склейки' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const a2a = (await client.query("SELECT id FROM cash_categories WHERE code='100' LIMIT 1")).rows[0];
    let done = 0;
    for (const p of pairs) {
      const outId = intOrNull(p.out_id), inId = intOrNull(p.in_id);
      if (!outId || !inId) continue;
      // «Расход» становится переводом: статья 100, кошелёк-получатель — тот, где была запись «Приход».
      const r = await client.query(
        `UPDATE cash_transactions SET tx_type='transfer', category_id=COALESCE($1, category_id),
           wallet_to_id=(SELECT wallet_id FROM cash_transactions WHERE id=$2), is_classified=true
         WHERE id=$3 AND tx_type='out'`,
        [a2a ? a2a.id : null, inId, outId]);
      if (!r.rowCount) continue; // уже не 'out' — пропускаем, ничего не трогаем
      await client.query(`DELETE FROM cash_transactions WHERE id=$1 AND tx_type='in'`, [inId]);
      done++;
    }
    await client.query('COMMIT');
    await db.log(req.user.id, 'cash_match_transfers', `склеено пар: ${done}`);
    res.json({ ok: true, done });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

// ---------- Курс ЦБ (для вкладки «Наличная касса») ----------
// Кэшируем по дате в своей таблице — не дёргаем cbu.uz на каждый показ строки,
// только на новую дату, которой ещё нет в кэше.
async function getCbuUsdRate(dateStr) {
  const cached = (await db.pool.query('SELECT usd_rate FROM cash_fx_rates WHERE rate_date=$1', [dateStr])).rows[0];
  if (cached) return Number(cached.usd_rate);
  const url = `https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/${dateStr}/`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('ЦБ не ответил (' + resp.status + ')');
  const data = await resp.json();
  const rate = Array.isArray(data) && data[0] && Number(data[0].rate || data[0].Rate);
  if (!rate || !isFinite(rate)) throw new Error('Курс не найден на эту дату');
  await db.pool.query(
    `INSERT INTO cash_fx_rates (rate_date, usd_rate) VALUES ($1,$2)
     ON CONFLICT (rate_date) DO UPDATE SET usd_rate=EXCLUDED.usd_rate, fetched_at=now()`,
    [dateStr, rate]);
  return rate;
}
router.get('/api/fx-rate', async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
  try { res.json({ date, rate: await getCbuUsdRate(date) }); }
  catch (e) { res.status(400).json({ date, rate: null, error: e.message }); }
});

// Валютная сводка кассы: сумовый остаток + долларовый остаток (в штуках) + итог по текущему курсу ЦБ.
// Доллары считаем по fx_amount (штуки валюты), сумы — по amount для UZS-операций.
// Переводы (transfer) считаем в UZS-части (перевод банк→касса приходит в сумах).
router.get('/api/cash-fx-balance', async (req, res) => {
  const wid = intOrNull(req.query.wallet);
  if (!wid) return res.status(400).json({ error: 'Не указан кошелёк' });
  const to = req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
  try {
    const params = [wid];
    let dateCond = '';
    if (to) { params.push(to); dateCond = ` AND t.tx_date <= $${params.length}`; }
    // Сумовая часть: UZS-операции (in/out) + переводы, где касса участвует.
    const uzsRow = (await db.pool.query(
      `SELECT COALESCE(SUM(
         CASE WHEN t.currency='USD' THEN 0
              WHEN t.tx_type='in' AND t.wallet_id=$1 THEN t.amount
              WHEN t.tx_type='out' AND t.wallet_id=$1 THEN -t.amount
              WHEN t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm THEN t.amount
              WHEN t.tx_type='transfer' AND t.wallet_id=$1 THEN -t.amount
              ELSE 0 END),0) v
       FROM cash_transactions t WHERE (t.wallet_id=$1 OR t.wallet_to_id=$1)${dateCond}`, params)).rows[0];
    // Долларовая часть: USD-операции, в штуках валюты (fx_amount).
    const usdRow = (await db.pool.query(
      `SELECT COALESCE(SUM(
         CASE WHEN t.currency<>'USD' THEN 0
              WHEN t.tx_type='in' AND t.wallet_id=$1 THEN t.fx_amount
              WHEN t.tx_type='out' AND t.wallet_id=$1 THEN -t.fx_amount
              WHEN t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm THEN t.fx_amount
              WHEN t.tx_type='transfer' AND t.wallet_id=$1 THEN -t.fx_amount
              ELSE 0 END),0) v
       FROM cash_transactions t WHERE (t.wallet_id=$1 OR t.wallet_to_id=$1)${dateCond}`, params)).rows[0];
    const uzs = Number(uzsRow.v), usd = Number(usdRow.v);
    let rate = null;
    try { rate = await getCbuUsdRate(new Date().toISOString().slice(0, 10)); } catch (e) { rate = null; }
    const totalUzs = uzs + (rate ? usd * rate : 0);
    res.json({ uzs, usd, rate, total_uzs: totalUzs });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Сводка «Наличной кассы» — чистая двухвалютная модель (сумы/доллары раздельно) ----------
// Без «Обмена»: каждая операция считается в своей валюте. Обнал: сумовая часть → сумы,
// долларовая → доллары, комиссия → расход. Конверсия (сумы↔доллары) — в свою валюту.
// Приход по сумам показываем ЧИСТЫМ: сумовую строку конверсии обнала (ст.102 с parent_tx_id)
// НЕ показываем расходом, а вычитаем из прихода (сворачиваем обнал). Баланс не меняется.
router.get('/api/cashbox-summary', async (req, res) => {
  try {
    const wid = intOrNull(req.query.wallet);
    if (!wid) return res.status(400).json({ error: 'Не указан кошелёк' });
    const from = req.query.from || null;
    const to = req.query.to || null;
    // Фильтры списка (статья/разобрано/поиск) — те же, что в журнале, чтобы карточки совпадали с таблицей.
    const catId = intOrNull(req.query.category);
    const classified = req.query.classified === 'yes' ? 'yes' : (req.query.classified === 'no' ? 'no' : null);
    const q = (req.query.q || '').trim();
    const filt = (p) => {
      let s = '';
      if (catId) s += ` AND t.category_id = ${catId}`;
      if (classified === 'no') s += ` AND t.is_classified = false`;
      else if (classified === 'yes') s += ` AND t.is_classified = true`;
      if (q) { p.push('%' + q + '%'); s += ` AND (t.purpose ILIKE $${p.length} OR t.payer_name ILIKE $${p.length})`; }
      return s;
    };
    const IS102 = `t.category_id IN (SELECT id FROM cash_categories WHERE code='102')`;
    // Остаток на дату (простой знаковый суммарный баланс, сумы и доллары раздельно; фолд НЕ нужен — итог не меняется).
    const balSel = `
      COALESCE(SUM(CASE
        WHEN t.currency='UZS' AND t.tx_type='in' AND t.wallet_id=$1 THEN t.amount
        WHEN t.currency='UZS' AND t.tx_type='out' AND t.wallet_id=$1 THEN -t.amount
        WHEN t.currency='UZS' AND t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm THEN t.amount
        WHEN t.currency='UZS' AND t.tx_type='transfer' AND t.wallet_id=$1 THEN -t.amount
        ELSE 0 END),0) AS uzs,
      COALESCE(SUM(CASE
        WHEN t.currency='USD' AND t.tx_type='in' AND t.wallet_id=$1 THEN t.fx_amount
        WHEN t.currency='USD' AND t.tx_type='out' AND t.wallet_id=$1 THEN -t.fx_amount
        ELSE 0 END),0) AS usd,
      COALESCE(SUM(CASE
        WHEN t.tx_type='in' AND t.wallet_id=$1 THEN t.amount
        WHEN t.tx_type='out' AND t.wallet_id=$1 THEN -t.amount
        WHEN t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm THEN t.amount
        WHEN t.tx_type='transfer' AND t.wallet_id=$1 THEN -t.amount
        ELSE 0 END),0) AS total_amt`;
    // Сальдо на начало = движения строго ДО from + начальные остатки (opening) на дату from включительно.
    let opening = { uzs: 0, usd: 0 };
    { const p = [wid]; let where;
      if (from) { p.push(from); where = `((t.source='opening' AND t.tx_date <= $${p.length}) OR (t.source<>'opening' AND t.tx_date < $${p.length}))`; }
      else { where = `t.source='opening'`; }
      const r = (await db.pool.query(`SELECT ${balSel} FROM cash_transactions t WHERE ${where}${filt(p)}`, p)).rows[0];
      opening = { uzs: Number(r.uzs), usd: Number(r.usd) };
    }
    // Сальдо на конец = всё до to включительно.
    let closing = { uzs: 0, usd: 0 };
    { const p = [wid]; p.push(to || '2999-12-31');
      const r = (await db.pool.query(`SELECT ${balSel} FROM cash_transactions t WHERE t.tx_date <= $${p.length}${filt(p)}`, p)).rows[0];
      closing = { uzs: Number(r.uzs), usd: Number(r.usd) };
    }
    // Приход/Расход за период (без начальных остатков). Обнал сворачиваем: сумовую конверсию (ст.102 с parent) вычитаем из прихода.
    const p2 = [wid]; p2.push(from || '1900-01-01', to || '2999-12-31');
    const r2 = (await db.pool.query(
      `SELECT
        COALESCE(SUM(CASE
          WHEN t.currency='UZS' AND t.tx_type='in' AND t.wallet_id=$1 THEN t.amount
          WHEN t.currency='UZS' AND t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm THEN t.amount
          WHEN t.currency='UZS' AND t.tx_type='out' AND t.wallet_id=$1 AND t.parent_tx_id IS NOT NULL AND ${IS102} THEN -t.amount
          ELSE 0 END),0) AS in_uzs,
        COALESCE(SUM(CASE
          WHEN t.currency='UZS' AND t.tx_type='out' AND t.wallet_id=$1 AND NOT (t.parent_tx_id IS NOT NULL AND ${IS102}) THEN t.amount
          WHEN t.currency='UZS' AND t.tx_type='transfer' AND t.wallet_id=$1 THEN t.amount
          ELSE 0 END),0) AS out_uzs,
        COALESCE(SUM(CASE WHEN t.currency='USD' AND t.tx_type='in' AND t.wallet_id=$1 THEN t.fx_amount ELSE 0 END),0) AS in_usd,
        COALESCE(SUM(CASE WHEN t.currency='USD' AND t.tx_type='out' AND t.wallet_id=$1 THEN t.fx_amount ELSE 0 END),0) AS out_usd,
        COALESCE(SUM(CASE
          WHEN t.tx_type='in' AND t.wallet_id=$1 THEN t.amount
          WHEN t.tx_type='transfer' AND t.wallet_to_id=$1 AND NOT t.needs_cash_confirm THEN t.amount
          WHEN t.tx_type='out' AND t.wallet_id=$1 AND t.parent_tx_id IS NOT NULL AND ${IS102} THEN -t.amount
          ELSE 0 END),0) AS in_total,
        COALESCE(SUM(CASE
          WHEN t.tx_type='out' AND t.wallet_id=$1 AND NOT (t.parent_tx_id IS NOT NULL AND ${IS102}) THEN t.amount
          WHEN t.tx_type='transfer' AND t.wallet_id=$1 THEN t.amount
          ELSE 0 END),0) AS out_total
       FROM cash_transactions t
       WHERE t.source <> 'opening' AND t.tx_date BETWEEN $${p2.length - 1} AND $${p2.length}${filt(p2)}`, p2)).rows[0];
    // «Итого» = сум-эквивалент по курсу НА ДАТУ операции (поле amount), а не по текущему курсу.
    const inflow = { uzs: Number(r2.in_uzs), usd: Number(r2.in_usd), total: Number(r2.in_total) };
    const outflow = { uzs: Number(r2.out_uzs), usd: Number(r2.out_usd), total: Number(r2.out_total) };
    let rate = null;
    try { rate = await getCbuUsdRate(to || new Date().toISOString().slice(0, 10)); } catch (e) { rate = null; }
    // Баланс (начало/конец): «Итого» = сумы + доллары×текущий курс. Если долларов $0 — «Итого» = чистые сумы
    // (без накопленной курсовой разницы прошлых операций). Приход/Расход — по курсу дня (in_total/out_total).
    opening.total = opening.uzs + (rate ? opening.usd * rate : 0);
    closing.total = closing.uzs + (rate ? closing.usd * rate : 0);
    res.json({ rate, opening, inflow, outflow, closing });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ============ ОБЯЗАТЕЛЬСТВА (Этап 1: фундамент + поставщики) ============
// Кому, сколько и когда Novagreen должна заплатить. Задолженность поставщикам — read-only
// зеркало Закупа (общий сервис purchase-finance, без дублирования логики и без своих таблиц).
// Дебиторка (кто должен нам) в этот раздел НЕ входит.

// Сводка: карточки + одна агрегированная строка «Задолженность поставщикам».
router.get('/api/obligations/summary', async (req, res) => {
  try {
    // Общий остаток долга поставщикам = сумма положительных сальдо (то же, что Закуп→Взаиморасчёты:
    // стартовый долг + принято − оплачено). Именно так совпадает с цифрой во Взаиморасчётах.
    const balances = await pfin.supplierBalances();
    const totalOwed = balances.reduce((a, s) => a + Math.max(0, s.balance), 0);
    // К оплате в периоде / просрочено / ближайшая дата — по заявкам с известным сроком.
    const orders = await pfin.openSupplierObligations();
    const now = new Date();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    let dueThisMonth = 0, overdue = 0, nearest = null;
    for (const o of orders) {
      if (o.overdue) overdue += o.remainder;
      else if (o.due_date && o.due_date <= monthEnd) dueThisMonth += o.remainder;
      if (o.due_date && o.remainder > 0.01 && (!nearest || o.due_date < nearest.due_date)) {
        const days = Math.round((new Date(o.due_date) - new Date(today)) / 86400000);
        nearest = { due_date: o.due_date, creditor: o.supplier_name, amount: o.remainder, currency: 'UZS', days, status: o.pay_status, order_number: o.number };
      }
    }
    const supNearest = orders.filter((o) => o.due_date && o.remainder > 0.01).map((o) => o.due_date).sort()[0] || null;
    // Курс ЦБ для пересчёта валютных обязательств в UZS (итог) + расшифровка по валютам отдельно.
    let rate = null; try { rate = await getCbuUsdRate(today); } catch (e) { rate = null; }
    const cur1 = (c) => (c === 'USD' ? 'USD' : 'UZS');
    const toUzs = (c, v) => (cur1(c) === 'USD' ? (rate ? v * rate : 0) : v);
    const byCur = { UZS: totalOwed, USD: 0 };
    const rows = [{ kind: 'Задолженность поставщикам', currency: 'UZS', total: totalOwed, due_period: dueThisMonth, overdue, nearest_date: supNearest, source: 'Закуп' }];

    // Кредиты/займы: остаток тела по валютам; просрочка/ближайшая дата из графика.
    const loans = (await db.pool.query(
      `SELECT o.obligation_type, o.currency,
              COALESCE(o.principal_received,0) AS received,
              COALESCE((SELECT SUM(principal_paid) FROM finance_obligation_payment_links l WHERE l.obligation_id=o.id AND l.reversed_at IS NULL),0) AS paid
       FROM finance_obligations o WHERE o.status <> 'cancelled' AND o.status <> 'closed'`)).rows;
    const loanGrp = {}; // 'Банковские кредиты|USD' → balance
    for (const l of loans) {
      const bal = Number(l.received) - Number(l.paid); const c = cur1(l.currency);
      byCur[c] = (byCur[c] || 0) + bal;
      const g = l.obligation_type === 'bank_loan' ? 'Банковские кредиты' : 'Понятийные и инвестиционные займы';
      loanGrp[g + '|' + c] = (loanGrp[g + '|' + c] || 0) + bal;
    }
    const sch = (await db.pool.query(
      `SELECT o.currency, (o.obligation_type = 'bank_loan') AS is_bank,
              COALESCE(SUM(s.total_due) FILTER (WHERE s.due_date < CURRENT_DATE),0) AS ovd,
              COALESCE(SUM(s.total_due) FILTER (WHERE s.due_date >= CURRENT_DATE AND s.due_date <= $1),0) AS duem,
              MIN(s.due_date) FILTER (WHERE s.due_date >= CURRENT_DATE) AS nxt
       FROM finance_obligation_schedule s JOIN finance_obligations o ON o.id=s.obligation_id
       WHERE s.status NOT IN ('paid','cancelled') AND o.status NOT IN ('cancelled','closed') GROUP BY o.currency, is_bank`, [monthEnd])).rows;
    const ovdCur = { UZS: overdue, USD: 0 }, dueCur = { UZS: dueThisMonth, USD: 0 };
    const schByGrp = {}; // просрочка/срок по группе(банк/займ)+валюте
    sch.forEach((r) => {
      const c = cur1(r.currency);
      ovdCur[c] = (ovdCur[c] || 0) + Number(r.ovd || 0); dueCur[c] = (dueCur[c] || 0) + Number(r.duem || 0);
      const g = r.is_bank ? 'Банковские кредиты' : 'Понятийные и инвестиционные займы';
      schByGrp[g + '|' + c] = { ovd: Number(r.ovd || 0), duem: Number(r.duem || 0), nxt: r.nxt };
    });
    for (const [k, v] of Object.entries(loanGrp)) {
      if (v <= 0.01) continue;
      const [g, c] = k.split('|'); const sc = schByGrp[k] || {};
      rows.push({ kind: g + (c === 'USD' ? ' ($)' : ''), currency: c, total: v, due_period: sc.duem || 0, overdue: sc.ovd || 0, nearest_date: sc.nxt || null, source: g.includes('кредит') ? 'Кредиты' : 'Займы' });
    }

    // Возмещение затрат подотчётным лицам (не возмещённые) — по валютам, без графика/просрочки.
    const reimb = (await db.pool.query(
      "SELECT currency, COALESCE(SUM(amount),0) AS s FROM finance_reimbursements WHERE status <> 'reimbursed' GROUP BY currency")).rows;
    for (const rr of reimb) {
      const c = cur1(rr.currency); const v = Number(rr.s) || 0;
      if (v <= 0.01) continue;
      byCur[c] = (byCur[c] || 0) + v;
      rows.push({ kind: 'Возмещение затрат' + (c === 'USD' ? ' ($)' : ''), currency: c, total: v, due_period: 0, overdue: 0, nearest_date: null, source: 'Возмещение' });
    }

    // Ближайший платёж — учитываем и графики кредитов/займов/лизинга, а не только поставщиков
    // (раньше nearest брался лишь из заявок Закупа — платежи по обязательствам не показывались).
    const nl = (await db.pool.query(
      `SELECT s.due_date, s.total_due, o.currency, o.creditor_name
       FROM finance_obligation_schedule s JOIN finance_obligations o ON o.id = s.obligation_id
       WHERE s.status NOT IN ('paid','cancelled') AND o.status NOT IN ('cancelled','closed')
         AND s.due_date >= CURRENT_DATE
         AND s.version_no = (SELECT MAX(version_no) FROM finance_obligation_schedule x WHERE x.obligation_id = s.obligation_id)
       ORDER BY s.due_date ASC, s.id ASC LIMIT 1`)).rows[0];
    if (nl) {
      const nd = String(nl.due_date).slice(0, 10);
      if (!nearest || nd < nearest.due_date) {
        nearest = { due_date: nd, creditor: nl.creditor_name, amount: Number(nl.total_due) || 0, currency: cur1(nl.currency), days: Math.round((new Date(nd) - new Date(today)) / 86400000) };
      }
    }

    const totalUzs = byCur.UZS + toUzs('USD', byCur.USD || 0);
    const overdueUzs = ovdCur.UZS + toUzs('USD', ovdCur.USD);
    const dueUzs = dueCur.UZS + toUzs('USD', dueCur.USD);

    // Каждую строку показываем сразу в двух валютах: $ и сум (по курсу ЦБ).
    const toUsd = (c, v) => (cur1(c) === 'USD' ? v : (rate ? v / rate : 0));
    rows.forEach((r) => {
      r.total_uzs = toUzs(r.currency, r.total);
      r.total_usd = toUsd(r.currency, r.total);
      r.due_uzs = toUzs(r.currency, r.due_period || 0);
      r.overdue_uzs = toUzs(r.currency, r.overdue || 0);
    });
    const totals = rows.reduce((a, r) => ({
      usd: a.usd + r.total_usd, uzs: a.uzs + r.total_uzs,
      due_uzs: a.due_uzs + r.due_uzs, overdue_uzs: a.overdue_uzs + r.overdue_uzs,
    }), { usd: 0, uzs: 0, due_uzs: 0, overdue_uzs: 0 });

    res.json({
      currency: 'UZS', rate, rate_date: today, by_currency: byCur,
      cards: {
        total_obligations: totalUzs,
        due_this_month: dueUzs,
        overdue: overdueUzs,
        nearest_payment: nearest,
      },
      rows, totals,
      note: 'Каждая строка — в двух валютах: в долларах и в сумах по курсу ЦБ. ИТОГО суммирует всё в сумах. Поставщики — из Закупа, кредиты/займы — из «Обязательств».',
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Платёжный календарь: предстоящие выплаты (поставщики со сроком + строки графиков кредитов/займов).
router.get('/api/obligations/calendar', async (req, res) => {
  try {
    const days = [7, 30, 90, 365].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
    const today = new Date(new Date().toISOString().slice(0, 10));
    const end = new Date(today); end.setDate(end.getDate() + days);
    const endISO = end.toISOString().slice(0, 10), todayISO = today.toISOString().slice(0, 10);
    const items = [];
    // Поставщики — принятые заявки с остатком и сроком в окне.
    const sup = await pfin.openSupplierObligations();
    for (const o of sup) {
      if (o.due_date && o.remainder > 0.01 && o.due_date <= endISO) {
        items.push({ date: o.due_date, kind: 'supplier', kind_label: 'Поставщик', creditor: o.supplier_name, amount: o.remainder, ref: o.number, overdue: o.due_date < todayISO });
      }
    }
    // Кредиты/займы — строки текущей версии графика, не оплаченные, со сроком в окне.
    const sch = (await db.pool.query(
      `SELECT s.due_date, s.total_due, o.creditor_name, o.obligation_type, o.currency
       FROM finance_obligation_schedule s
       JOIN finance_obligations o ON o.id = s.obligation_id
       WHERE o.status NOT IN ('cancelled','closed') AND s.status NOT IN ('paid','cancelled')
         AND s.version_no = (SELECT MAX(version_no) FROM finance_obligation_schedule x WHERE x.obligation_id=o.id)
         AND s.due_date <= $1`, [endISO])).rows;
    for (const s of sch) {
      const kind = s.obligation_type === 'bank_loan' ? 'bank_loan' : 'loan';
      items.push({ date: String(s.due_date).slice(0, 10), kind, kind_label: kind === 'bank_loan' ? 'Кредит' : 'Заём', creditor: s.creditor_name, amount: Number(s.total_due) || 0, currency: s.currency, overdue: String(s.due_date).slice(0, 10) < todayISO });
    }
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    res.json({ days, from: todayISO, to: endISO, items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Поставщики — read-only зеркало «Закуп → Взаиморасчёты» (тот же сервис, без изменений данных).
router.get('/api/obligations/suppliers', async (req, res) => {
  try {
    const d = await pfin.settlements(req.query); // общий сервис (q/категория/статус/период)
    res.json({ ...d, readonly: true, source: 'Закуп → Взаиморасчёты' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Кредиты и займы (Этап 2): CRUD + генерация графика ----
const OBL_TYPES = ['bank_loan', 'concept_loan', 'investment_loan', 'founder_loan', 'capex', 'other_loan'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Генерация графика по схеме погашения. opts: {installments, first_payment_date}.
function genSchedule(loan, opts = {}) {
  const P = Number(loan.principal_received) > 0 ? Number(loan.principal_received) : Number(loan.principal_limit) || 0;
  const n = Math.max(1, parseInt(opts.installments, 10) || 12);
  const r = (Number(loan.annual_rate) || 0) / 100 / 12;
  const scheme = loan.repayment_scheme || 'annuity';
  const first = opts.first_payment_date || loan.first_payment_date || loan.date_start;
  if (!first || !P || scheme === 'custom') return [];
  const dateAt = (i) => { const d = new Date(first); d.setMonth(d.getMonth() + i); return d.toISOString().slice(0, 10); };
  const rows = []; let bal = P;
  for (let i = 0; i < n; i++) {
    const opening = bal; let principal = 0, interest = 0;
    if (scheme === 'bullet' || scheme === 'interest_only') { interest = bal * r; principal = (i === n - 1) ? bal : 0; }
    else if (scheme === 'differentiated' || scheme === 'equal_principal') { principal = P / n; interest = bal * r; }
    else { // annuity
      if (r > 0) { const A = P * r / (1 - Math.pow(1 + r, -n)); interest = bal * r; principal = A - interest; }
      else { principal = P / n; interest = 0; }
    }
    if (i === n - 1 && scheme !== 'bullet' && scheme !== 'interest_only') principal = bal; // закрыть остаток
    principal = Math.min(principal, bal);
    rows.push({ installment_no: i + 1, due_date: dateAt(i), opening_principal: round2(opening), principal_due: round2(principal), interest_due: round2(interest), fee_due: 0, total_due: round2(principal + interest) });
    bal = round2(bal - principal);
  }
  return rows;
}

const OBL_FIELDS = ['obligation_type', 'creditor_name', 'agreement_number', 'agreement_date', 'date_start', 'date_end',
  'currency', 'base_fx_rate', 'principal_limit', 'principal_received', 'annual_rate', 'repayment_scheme', 'first_payment_date',
  'payment_day', 'grace_period_months', 'wallet_id', 'status', 'comment', 'counterparty_id'];

router.get('/api/obligations/loans', async (req, res) => {
  try {
    const group = req.query.group === 'bank' ? ['bank_loan'] : req.query.group === 'other' ? ['concept_loan', 'investment_loan', 'founder_loan', 'capex', 'other_loan'] : OBL_TYPES;
    const rows = (await db.pool.query(
      `SELECT o.*, w.name AS wallet_name,
              (SELECT COALESCE(SUM(principal_paid),0) FROM finance_obligation_payment_links l WHERE l.obligation_id=o.id AND l.reversed_at IS NULL) AS principal_paid,
              (SELECT MIN(due_date) FROM finance_obligation_schedule s WHERE s.obligation_id=o.id AND s.status IN ('planned','soon','today','partial','overdue')) AS next_due
       FROM finance_obligations o LEFT JOIN cash_wallets w ON w.id=o.wallet_id
       WHERE o.obligation_type = ANY($1) ORDER BY o.status='closed', o.creditor_name`, [group])).rows;
    // Курс ЦБ нужен фронту, чтобы свести валютные строки к общему итогу.
    let rate = null; try { rate = await getCbuUsdRate(new Date().toISOString().slice(0, 10)); } catch (e) { rate = null; }
    res.json({ rate: Number(rate) || 0, items: rows.map((o) => ({ ...o, principal_balance: (Number(o.principal_received) || 0) - (Number(o.principal_paid) || 0) })) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/obligations/loans', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Создавать кредиты/займы может администратор/финансы' });
  const b = req.body || {};
  const type = OBL_TYPES.includes(b.obligation_type) ? b.obligation_type : 'bank_loan';
  const r = await db.pool.query(
    `INSERT INTO finance_obligations (obligation_type, creditor_name, agreement_number, agreement_date, date_start, date_end,
       currency, base_fx_rate, principal_limit, principal_received, annual_rate, repayment_scheme, first_payment_date, payment_day,
       grace_period_months, wallet_id, status, comment, counterparty_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'draft',$17,$18,$19) RETURNING id`,
    [type, (b.creditor_name || 'Кредитор').trim(), b.agreement_number || '', b.agreement_date || null, b.date_start || null, b.date_end || null,
      b.currency === 'USD' ? 'USD' : 'UZS', b.currency === 'USD' ? numOrNull(b.base_fx_rate) : null, numOrNull(b.principal_limit), numOrNull(b.principal_received), numOrNull(b.annual_rate),
      b.repayment_scheme || 'annuity', b.first_payment_date || null, intOrNull(b.payment_day), intOrNull(b.grace_period_months),
      intOrNull(b.wallet_id), b.comment || '', intOrNull(b.counterparty_id), req.user.id]);
  await db.log(req.user.id, 'obl_loan_create', `${type} ${b.creditor_name || ''}`);
  res.json({ ok: true, id: r.rows[0].id });
});

router.get('/api/obligations/loans/:id(\\d+)', async (req, res) => {
  const o = (await db.pool.query('SELECT o.*, w.name AS wallet_name FROM finance_obligations o LEFT JOIN cash_wallets w ON w.id=o.wallet_id WHERE o.id=$1', [req.params.id])).rows[0];
  if (!o) return res.status(404).json({ error: 'Не найдено' });
  const tranches = (await db.pool.query('SELECT * FROM finance_obligation_tranches WHERE obligation_id=$1 ORDER BY tranche_no, id', [req.params.id])).rows;
  const ver = (await db.pool.query('SELECT COALESCE(MAX(version_no),0) v FROM finance_obligation_schedule WHERE obligation_id=$1', [req.params.id])).rows[0].v;
  const schedule = (await db.pool.query(
    `SELECT s.*, COALESCE((SELECT SUM(principal_paid+interest_paid+fee_paid) FROM finance_obligation_payment_links l WHERE l.schedule_id=s.id AND l.reversed_at IS NULL),0) AS paid
     FROM finance_obligation_schedule s WHERE s.obligation_id=$1 AND s.version_no=$2 ORDER BY s.installment_no`, [req.params.id, ver])).rows;
  // Валютная сводка: сколько оплачено в $ и в сумах, и курсовая разница относительно курса оприходования.
  let fx = null;
  if (o.currency === 'USD') {
    const links = (await db.pool.query(
      'SELECT principal_paid, interest_paid, fee_paid, amount_uzs, fx_rate FROM finance_obligation_payment_links WHERE obligation_id=$1 AND reversed_at IS NULL', [req.params.id])).rows;
    const base = Number(o.base_fx_rate) || 0;
    let paidUsd = 0, paidUzs = 0, diff = 0;
    for (const l of links) {
      const usd = (Number(l.principal_paid) || 0) + (Number(l.interest_paid) || 0) + (Number(l.fee_paid) || 0);
      const uzs = Number(l.amount_uzs) || 0;
      paidUsd += usd; paidUzs += uzs;
      if (base > 0 && Number(l.fx_rate) > 0) diff += usd * (Number(l.fx_rate) - base);
    }
    fx = { base_fx_rate: base || null, paid_usd: paidUsd, paid_uzs: paidUzs, fx_diff: base > 0 ? Math.round(diff) : null };
  }
  res.json({ loan: o, tranches, schedule, version: ver, fx });
});

// Хелпер: id статьи ДДС по коду.
async function catIdByCode(code) { const r = await db.pool.query("SELECT id FROM cash_categories WHERE code=$1 LIMIT 1", [code]); return r.rows[0] ? r.rows[0].id : null; }

// Оплата строки графика: пишет расход(ы) в Кассу (тело/проценты/комиссия по статьям ДДС 61/60/62)
// и привязывает к строке — деньги вводятся ОДИН раз, двойного учёта нет. Всё в транзакции.
router.post('/api/obligations/schedule/:id(\\d+)/pay', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Проводить оплату может администратор/финансы' });
  const b = req.body || {};
  const sid = parseInt(req.params.id, 10);
  const s = (await db.pool.query(
    `SELECT s.*, o.id AS obligation_id, o.creditor_name FROM finance_obligation_schedule s
     JOIN finance_obligations o ON o.id=s.obligation_id WHERE s.id=$1`, [sid])).rows[0];
  if (!s) return res.status(404).json({ error: 'Строка графика не найдена' });
  const noCash = !!b.no_cash; // историческая отметка: закрыть строку без создания расхода в Кассе
  const walletId = intOrNull(b.wallet_id);
  if (!noCash && !walletId) return res.status(400).json({ error: 'Выберите кошелёк списания' });
  const date = b.payment_date || new Date().toISOString().slice(0, 10);
  const pr = Math.max(0, Number(b.principal_paid) || 0);
  const ip = Math.max(0, Number(b.interest_paid) || 0);
  const fe = Math.max(0, Number(b.fee_paid) || 0);
  if (pr + ip + fe <= 0) return res.status(400).json({ error: 'Укажите сумму платежа' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    let linkTx = null;
    if (!noCash) {
      const [cBody, cInt, cFee] = await Promise.all([catIdByCode('61'), catIdByCode('60'), catIdByCode('62')]);
      const mkTx = async (amount, catId, label) => {
        if (amount <= 0) return null;
        const r = await client.query(
          `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, category_id, purpose, source, is_classified, created_by)
           VALUES ($1,$2,'out',$3,$4,$5,'obligation',$6,$7) RETURNING id`,
          [date, amount, walletId, catId, `${label}: ${s.creditor_name} · платёж №${s.installment_no}`, !!catId, req.user.id]);
        return r.rows[0].id;
      };
      const txBody = await mkTx(pr, cBody, 'Возврат тела кредита');
      const txInt = await mkTx(ip, cInt, 'Проценты по кредиту');
      const txFee = await mkTx(fe, cFee, 'Комиссия банка');
      linkTx = txBody || txInt || txFee;
    }
    await client.query(
      `INSERT INTO finance_obligation_payment_links (schedule_id, obligation_id, cash_transaction_id, payment_date, principal_paid, interest_paid, fee_paid, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sid, s.obligation_id, linkTx, date, pr, ip, fe, req.user.id]);
    // Статус строки: полностью/частично оплачено.
    const paid = Number((await client.query('SELECT COALESCE(SUM(principal_paid+interest_paid+fee_paid),0) v FROM finance_obligation_payment_links WHERE schedule_id=$1 AND reversed_at IS NULL', [sid])).rows[0].v);
    const st = paid >= Number(s.total_due) - 0.01 ? 'paid' : 'partial';
    await client.query('UPDATE finance_obligation_schedule SET status=$1 WHERE id=$2', [st, sid]);
    await client.query("UPDATE finance_obligations SET status='active', updated_at=now() WHERE id=$1 AND status='draft'", [s.obligation_id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
  finally { client.release(); }
  await db.log(req.user.id, noCash ? 'obl_schedule_mark_paid' : 'obl_schedule_pay', `строка #${sid} тело=${pr} %=${ip} комис=${fe}${noCash ? ' (без Кассы)' : ''}`);
  res.json({ ok: true });
});

// Платежи по кредитам из выписки (статья 60 «Проценты» / 61 «Погашение кредита»), которые ещё
// не привязаны ни к одному графику — «к разнесению». Их вручную разносят на конкретный кредит.
router.get('/api/obligations/unassigned-payments', async (req, res) => {
  try {
    const rows = (await db.pool.query(
      `SELECT t.id, to_char(t.tx_date,'YYYY-MM-DD') AS tx_date, t.amount, t.purpose,
              c.code AS cat_code, c.name AS cat_name, w.name AS wallet_name, t.payer_name
         FROM cash_transactions t
         JOIN cash_categories c ON c.id = t.category_id AND c.code IN ('60','61')
         LEFT JOIN cash_wallets w ON w.id = t.wallet_id
        WHERE t.tx_type='out' AND COALESCE(t.source,'') <> 'obligation' AND NOT COALESCE(t.obl_dismissed,false)
          AND NOT EXISTS (SELECT 1 FROM finance_obligation_payment_links l
                          WHERE l.cash_transaction_id = t.id AND l.reversed_at IS NULL)
        ORDER BY t.tx_date DESC, t.id DESC`)).rows;
    res.json({ items: rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Скрыть/вернуть платежи из «к разнесению» (уже оплачены/отмечены исторически — не разносим).
router.post('/api/obligations/dismiss-payments', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Нечего скрывать' });
  const dismissed = req.body.dismissed === false ? false : true;
  await db.pool.query('UPDATE cash_transactions SET obl_dismissed=$1 WHERE id = ANY($2)', [dismissed, ids]);
  await db.log(req.user.id, 'obl_dismiss_payments', ids.length + '');
  res.json({ ok: true, count: ids.length });
});

// Ближайший неоплаченный месяц графика кредита — для предложения разбивки тело/проценты при разносе.
router.get('/api/obligations/loans/:id(\\d+)/next-installment', async (req, res) => {
  try {
    const ver = (await db.pool.query('SELECT COALESCE(MAX(version_no),0) v FROM finance_obligation_schedule WHERE obligation_id=$1', [req.params.id])).rows[0].v;
    const s = (await db.pool.query(
      `SELECT s.*,
              COALESCE((SELECT SUM(principal_paid) FROM finance_obligation_payment_links l WHERE l.schedule_id=s.id AND l.reversed_at IS NULL),0) AS pr_paid,
              COALESCE((SELECT SUM(interest_paid)  FROM finance_obligation_payment_links l WHERE l.schedule_id=s.id AND l.reversed_at IS NULL),0) AS ip_paid,
              COALESCE((SELECT SUM(fee_paid)       FROM finance_obligation_payment_links l WHERE l.schedule_id=s.id AND l.reversed_at IS NULL),0) AS fe_paid
         FROM finance_obligation_schedule s
        WHERE s.obligation_id=$1 AND s.version_no=$2 AND s.status NOT IN ('paid','cancelled')
        ORDER BY s.due_date, s.installment_no LIMIT 1`, [req.params.id, ver])).rows[0];
    res.json({ installment: s || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Разнести существующий расход из Кассы на кредит: гасит выбранный (или ближайший) месяц графика.
// Деньги уже в Кассе (из выписки) — новую транзакцию НЕ создаём, только связку (дедуп по cash_transaction_id).
router.post('/api/obligations/assign-payment', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Разносить платежи может администратор/финансы' });
  const b = req.body || {};
  const txId = intOrNull(b.cash_transaction_id);
  const oblId = intOrNull(b.obligation_id);
  if (!txId || !oblId) return res.status(400).json({ error: 'Не указан платёж или кредит' });
  const tx = (await db.pool.query("SELECT id, amount, to_char(tx_date,'YYYY-MM-DD') d FROM cash_transactions WHERE id=$1 AND tx_type='out'", [txId])).rows[0];
  if (!tx) return res.status(404).json({ error: 'Платёж не найден' });
  const dup = (await db.pool.query('SELECT 1 FROM finance_obligation_payment_links WHERE cash_transaction_id=$1 AND reversed_at IS NULL LIMIT 1', [txId])).rows[0];
  if (dup) return res.status(400).json({ error: 'Этот платёж уже разнесён' });
  const pr = Math.max(0, Number(b.principal_paid) || 0);
  const ip = Math.max(0, Number(b.interest_paid) || 0);
  const fe = Math.max(0, Number(b.fee_paid) || 0);
  if (pr + ip + fe <= 0) return res.status(400).json({ error: 'Укажите разбивку платежа (тело/проценты)' });
  let sid = intOrNull(b.schedule_id);
  if (!sid) {
    const ver = (await db.pool.query('SELECT COALESCE(MAX(version_no),0) v FROM finance_obligation_schedule WHERE obligation_id=$1', [oblId])).rows[0].v;
    const s = (await db.pool.query(
      `SELECT id FROM finance_obligation_schedule WHERE obligation_id=$1 AND version_no=$2 AND status NOT IN ('paid','cancelled') ORDER BY due_date, installment_no LIMIT 1`, [oblId, ver])).rows[0];
    sid = s ? s.id : null;
  }
  if (!sid) return res.status(400).json({ error: 'У кредита нет неоплаченного месяца в графике — сначала построй график' });
  // Валюта: для валютного обязательства principal/interest/fee — в валюте ($), а amount_uzs/fx_rate —
  // сколько сум реально ушло из выписки и по какому курсу (для стыковки и курсовой разницы).
  const amountUzs = numOrNull(b.amount_uzs) != null ? Number(b.amount_uzs) : Number(tx.amount);
  const fxRate = numOrNull(b.fx_rate);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO finance_obligation_payment_links (schedule_id, obligation_id, cash_transaction_id, payment_date, principal_paid, interest_paid, fee_paid, amount_uzs, fx_rate, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [sid, oblId, txId, tx.d, pr, ip, fe, amountUzs, fxRate, req.user.id]);
    const s = (await client.query('SELECT total_due FROM finance_obligation_schedule WHERE id=$1', [sid])).rows[0];
    const paid = Number((await client.query('SELECT COALESCE(SUM(principal_paid+interest_paid+fee_paid),0) v FROM finance_obligation_payment_links WHERE schedule_id=$1 AND reversed_at IS NULL', [sid])).rows[0].v);
    const st = paid >= Number(s.total_due) - 0.01 ? 'paid' : 'partial';
    await client.query('UPDATE finance_obligation_schedule SET status=$1 WHERE id=$2', [st, sid]);
    await client.query("UPDATE finance_obligations SET status='active', updated_at=now() WHERE id=$1 AND status='draft'", [oblId]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
  finally { client.release(); }
  await db.log(req.user.id, 'obl_assign_payment', `tx#${txId} → кредит #${oblId}, строка #${sid}`);
  res.json({ ok: true });
});

// Авто-разнос по № договора: платёж (60/61) с номером договора кредита в назначении привязываем сами.
// Сумовые кредиты — автоматически (ближайший месяц). Валютные пропускаем — по ним нужен курс (вручную).
router.post('/api/obligations/auto-assign', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  try {
    const txs = (await db.pool.query(
      `SELECT t.id, t.amount, to_char(t.tx_date,'YYYY-MM-DD') d, t.purpose,
              (SELECT code FROM cash_categories c WHERE c.id=t.category_id) cat_code
         FROM cash_transactions t
        WHERE t.tx_type='out' AND COALESCE(t.source,'')<>'obligation' AND NOT COALESCE(t.obl_dismissed,false)
          AND t.category_id IN (SELECT id FROM cash_categories WHERE code IN ('60','61'))
          AND NOT EXISTS (SELECT 1 FROM finance_obligation_payment_links l WHERE l.cash_transaction_id=t.id AND l.reversed_at IS NULL)`)).rows;
    const loans = (await db.pool.query(
      "SELECT id, agreement_number, currency FROM finance_obligations WHERE COALESCE(agreement_number,'')<>'' AND status NOT IN ('closed','cancelled')")).rows
      .map((o) => ({ id: o.id, currency: o.currency, norm: String(o.agreement_number).toLowerCase().replace(/\s+/g, '') }));
    let linked = 0, needRate = 0;
    for (const t of txs) {
      const p = String(t.purpose || '').toLowerCase().replace(/\s+/g, '');
      const m = loans.filter((o) => o.norm.length >= 2 && p.includes(o.norm));
      if (m.length !== 1) continue;                 // не нашли/неоднозначно — вручную
      const o = m[0];
      if (o.currency === 'USD') { needRate++; continue; } // валюта — нужен курс, вручную
      const ver = (await db.pool.query('SELECT COALESCE(MAX(version_no),0) v FROM finance_obligation_schedule WHERE obligation_id=$1', [o.id])).rows[0].v;
      const s = (await db.pool.query(
        `SELECT s.*, COALESCE((SELECT SUM(interest_paid) FROM finance_obligation_payment_links l WHERE l.schedule_id=s.id AND l.reversed_at IS NULL),0) ip_paid
           FROM finance_obligation_schedule s WHERE s.obligation_id=$1 AND s.version_no=$2 AND s.status NOT IN ('paid','cancelled') ORDER BY due_date, installment_no LIMIT 1`, [o.id, ver])).rows[0];
      if (!s) continue;
      const amt = Number(t.amount) || 0;
      const remInt = Math.max(0, (Number(s.interest_due) || 0) - (Number(s.ip_paid) || 0));
      // По статье: 61 «Погашение кредита» → всё в тело; 60 «Проценты» → всё в проценты.
      const ip = t.cat_code === '61' ? 0 : t.cat_code === '60' ? amt : Math.min(amt, remInt);
      const pr = t.cat_code === '60' ? 0 : amt - ip;
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO finance_obligation_payment_links (schedule_id, obligation_id, cash_transaction_id, payment_date, principal_paid, interest_paid, fee_paid, amount_uzs, created_by) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)`,
          [s.id, o.id, t.id, t.d, pr, ip, amt, req.user.id]);
        const paid = Number((await client.query('SELECT COALESCE(SUM(principal_paid+interest_paid+fee_paid),0) v FROM finance_obligation_payment_links WHERE schedule_id=$1 AND reversed_at IS NULL', [s.id])).rows[0].v);
        await client.query('UPDATE finance_obligation_schedule SET status=$1 WHERE id=$2', [paid >= Number(s.total_due) - 0.01 ? 'paid' : 'partial', s.id]);
        await client.query("UPDATE finance_obligations SET status='active', updated_at=now() WHERE id=$1 AND status='draft'", [o.id]);
        await client.query('COMMIT'); linked++;
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); } finally { client.release(); }
    }
    await db.log(req.user.id, 'obl_auto_assign', `linked=${linked}, needRate=${needRate}`);
    res.json({ ok: true, linked, needRate });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Массовая историческая отметка: все строки графика со сроком ДО указанной даты (включительно)
// помечаются полностью оплаченными БЕЗ движения денег в Кассе (для старых кредитов/аренды с 2024-25).
router.post('/api/obligations/:id(\\d+)/mark-paid-until', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const oid = parseInt(req.params.id, 10);
  const until = req.body && req.body.until_date;
  if (!until) return res.status(400).json({ error: 'Укажите дату' });
  const ver = (await db.pool.query('SELECT COALESCE(MAX(version_no),0) v FROM finance_obligation_schedule WHERE obligation_id=$1', [oid])).rows[0].v;
  const rows = (await db.pool.query(
    `SELECT s.* FROM finance_obligation_schedule s
     WHERE s.obligation_id=$1 AND s.version_no=$2 AND s.due_date <= $3 AND s.status NOT IN ('paid','cancelled')
     ORDER BY s.installment_no`, [oid, ver, until])).rows;
  if (!rows.length) return res.json({ ok: true, marked: 0 });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    let marked = 0;
    for (const s of rows) {
      // Доводим каждую компоненту (тело/проценты/комиссия) до полной суммы строки — с учётом уже уплаченного.
      const pc = (await client.query('SELECT COALESCE(SUM(principal_paid),0) pp, COALESCE(SUM(interest_paid),0) ii, COALESCE(SUM(fee_paid),0) ff FROM finance_obligation_payment_links WHERE schedule_id=$1 AND reversed_at IS NULL', [s.id])).rows[0];
      const payP = Math.max(0, (Number(s.principal_due) || 0) - Number(pc.pp));
      const payI = Math.max(0, (Number(s.interest_due) || 0) - Number(pc.ii));
      const payF = Math.max(0, (Number(s.fee_due) || 0) - Number(pc.ff));
      if (payP + payI + payF > 0.009) {
        await client.query(
          `INSERT INTO finance_obligation_payment_links (schedule_id, obligation_id, cash_transaction_id, payment_date, principal_paid, interest_paid, fee_paid, created_by)
           VALUES ($1,$2,NULL,$3,$4,$5,$6,$7)`,
          [s.id, oid, s.due_date, payP, payI, payF, req.user.id]);
      }
      await client.query("UPDATE finance_obligation_schedule SET status='paid' WHERE id=$1", [s.id]);
      marked += 1;
    }
    await client.query("UPDATE finance_obligations SET status='active', updated_at=now() WHERE id=$1 AND status='draft'", [oid]);
    await client.query('COMMIT');
    await db.log(req.user.id, 'obl_mark_paid_until', `#${oid} до ${until}: строк ${marked}`);
    res.json({ ok: true, marked });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

// Сторно привязки оплаты: денежные операции не удаляем физически — помечаем reversed + удаляем расходы.
router.post('/api/obligations/payment-links/:id(\\d+)/reverse', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const link = (await db.pool.query('SELECT * FROM finance_obligation_payment_links WHERE id=$1 AND reversed_at IS NULL', [req.params.id])).rows[0];
  if (!link) return res.status(404).json({ error: 'Привязка не найдена или уже сторнирована' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (link.cash_transaction_id) await client.query("DELETE FROM cash_transactions WHERE id=$1 AND source='obligation'", [link.cash_transaction_id]);
    await client.query('UPDATE finance_obligation_payment_links SET reversed_at=now(), reversed_by=$1, reversal_reason=$2 WHERE id=$3', [req.user.id, (req.body || {}).reason || '', req.params.id]);
    // Пересчёт статуса строки.
    if (link.schedule_id) {
      const s = (await client.query('SELECT total_due FROM finance_obligation_schedule WHERE id=$1', [link.schedule_id])).rows[0];
      const paid = Number((await client.query('SELECT COALESCE(SUM(principal_paid+interest_paid+fee_paid),0) v FROM finance_obligation_payment_links WHERE schedule_id=$1 AND reversed_at IS NULL', [link.schedule_id])).rows[0].v);
      const st = paid <= 0.01 ? 'planned' : (s && paid >= Number(s.total_due) - 0.01 ? 'paid' : 'partial');
      await client.query('UPDATE finance_obligation_schedule SET status=$1 WHERE id=$2', [st, link.schedule_id]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
  finally { client.release(); }
  res.json({ ok: true });
});

// Правка строки графика вручную (дата/тело/проценты/комиссия) — чтобы внести корректные данные.
router.post('/api/obligations/schedule/:id(\\d+)/update', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const b = req.body || {};
  const s = (await db.pool.query('SELECT * FROM finance_obligation_schedule WHERE id=$1', [req.params.id])).rows[0];
  if (!s) return res.status(404).json({ error: 'Строка графика не найдена' });
  const pd = numOrNull(b.principal_due) != null ? numOrNull(b.principal_due) : Number(s.principal_due);
  const idu = numOrNull(b.interest_due) != null ? numOrNull(b.interest_due) : Number(s.interest_due);
  const fd = numOrNull(b.fee_due) != null ? numOrNull(b.fee_due) : Number(s.fee_due);
  const op = numOrNull(b.opening_principal) != null ? numOrNull(b.opening_principal) : Number(s.opening_principal);
  const total = round2(pd + idu + fd);
  await db.pool.query(
    'UPDATE finance_obligation_schedule SET due_date=$1, opening_principal=$2, principal_due=$3, interest_due=$4, fee_due=$5, total_due=$6 WHERE id=$7',
    [b.due_date || s.due_date, op, pd, idu, fd, total, req.params.id]);
  await db.log(req.user.id, 'obl_schedule_edit', `#${req.params.id}`);
  res.json({ ok: true });
});

// Удаление строки графика (с отменой связанных оплат и их расходов в Кассе).
router.post('/api/obligations/schedule/:id(\\d+)/delete', async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const links = (await client.query('SELECT cash_transaction_id FROM finance_obligation_payment_links WHERE schedule_id=$1 AND reversed_at IS NULL', [req.params.id])).rows;
    for (const l of links) { if (l.cash_transaction_id) await client.query("DELETE FROM cash_transactions WHERE id=$1 AND source='obligation'", [l.cash_transaction_id]); }
    await client.query('DELETE FROM finance_obligation_payment_links WHERE schedule_id=$1', [req.params.id]);
    await client.query('DELETE FROM finance_obligation_schedule WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    await db.log(req.user.id, 'obl_schedule_delete', `#${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

// Отмена оплаты строки (сторно всех непогашенных привязок) — строка возвращается в «Запланировано».
router.post('/api/obligations/schedule/:id(\\d+)/unpay', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const links = (await client.query('SELECT id, cash_transaction_id FROM finance_obligation_payment_links WHERE schedule_id=$1 AND reversed_at IS NULL', [req.params.id])).rows;
    for (const l of links) {
      if (l.cash_transaction_id) await client.query("DELETE FROM cash_transactions WHERE id=$1 AND source='obligation'", [l.cash_transaction_id]);
      await client.query("UPDATE finance_obligation_payment_links SET reversed_at=now(), reversed_by=$1, reversal_reason='отмена оплаты' WHERE id=$2", [req.user.id, l.id]);
    }
    await client.query("UPDATE finance_obligation_schedule SET status='planned' WHERE id=$1", [req.params.id]);
    await client.query('COMMIT');
    await db.log(req.user.id, 'obl_schedule_unpay', `#${req.params.id}: сторно ${links.length}`);
    res.json({ ok: true, reversed: links.length });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

router.post('/api/obligations/loans/:id(\\d+)', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  for (const f of OBL_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (['principal_limit', 'principal_received', 'annual_rate', 'base_fx_rate'].includes(f)) v = numOrNull(v);
    else if (['payment_day', 'grace_period_months', 'wallet_id', 'counterparty_id'].includes(f)) v = intOrNull(v);
    else if (['agreement_date', 'date_start', 'date_end', 'first_payment_date'].includes(f)) v = v || null;
    sets.push(`${f}=$${i++}`); vals.push(v);
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at=now()', `updated_by=$${i++}`); vals.push(req.user.id); vals.push(req.params.id);
  await db.pool.query(`UPDATE finance_obligations SET ${sets.join(',')} WHERE id=$${i}`, vals);
  res.json({ ok: true });
});

// Генерация нового графика (новая версия). Оплаченные строки прошлых версий не трогаем — версии отдельны.
router.post('/api/obligations/loans/:id(\\d+)/generate-schedule', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const loan = (await db.pool.query('SELECT * FROM finance_obligations WHERE id=$1', [req.params.id])).rows[0];
  if (!loan) return res.status(404).json({ error: 'Не найдено' });
  const rows = genSchedule(loan, req.body || {});
  if (!rows.length) return res.status(400).json({ error: 'Не удалось построить график: проверьте сумму, дату первого платежа и число платежей.' });
  const ver = (await db.pool.query('SELECT COALESCE(MAX(version_no),0)+1 v FROM finance_obligation_schedule WHERE obligation_id=$1', [req.params.id])).rows[0].v;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO finance_obligation_schedule (obligation_id, version_no, installment_no, due_date, opening_principal, principal_due, interest_due, fee_due, total_due)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.params.id, ver, r.installment_no, r.due_date, r.opening_principal, r.principal_due, r.interest_due, r.fee_due, r.total_due]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
  finally { client.release(); }
  await db.log(req.user.id, 'obl_schedule_gen', `#${req.params.id} v${ver} (${rows.length} строк)`);
  res.json({ ok: true, version: ver, count: rows.length });
});

router.post('/api/obligations/loans/:id(\\d+)/tranches', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const b = req.body || {};
  const mx = (await db.pool.query('SELECT COALESCE(MAX(tranche_no),0)+1 n FROM finance_obligation_tranches WHERE obligation_id=$1', [req.params.id])).rows[0].n;
  const r = await db.pool.query(
    `INSERT INTO finance_obligation_tranches (obligation_id, tranche_no, received_date, amount, currency, due_date)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.params.id, mx, b.received_date || null, numOrNull(b.amount), b.currency === 'USD' ? 'USD' : 'UZS', b.due_date || null]);
  res.json({ ok: true, id: r.rows[0].id });
});

router.post('/api/obligations/loans/:id(\\d+)/delete', async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор' });
  // Есть ли фактические оплаты — тогда не удаляем физически, а помечаем отменённым.
  const paid = (await db.pool.query('SELECT 1 FROM finance_obligation_payment_links WHERE obligation_id=$1 AND reversed_at IS NULL LIMIT 1', [req.params.id])).rows.length;
  if (paid) { await db.pool.query("UPDATE finance_obligations SET status='cancelled', updated_at=now() WHERE id=$1", [req.params.id]); return res.json({ ok: true, archived: true }); }
  await db.pool.query('DELETE FROM finance_obligations WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Импорт «графика возврата» займа (транши: дата выдачи, сумма, дата возврата) ----
function excelDate(n) {
  if (typeof n === 'number' && n > 1) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000); return d.toISOString().slice(0, 10); }
  const s = String(n || '').trim(); const m = s.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m2 ? m2[0] : null;
}
// Горизонтальный амортизирующий график (даты в столбцах; строки «проценты»/«тело»/«остаток»).
function parseAmortizingSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
  // строка с датами: >=3 ячеек-дат (серийники Excel).
  let dateRow = -1, dateCols = [];
  for (let i = 0; i < rows.length; i++) {
    const cols = []; rows[i].forEach((c, j) => { if (typeof c === 'number' && c > 40000 && c < 60000) cols.push(j); });
    if (cols.length >= 3) { dateRow = i; dateCols = cols; break; }
  }
  if (dateRow < 0) return null;
  // Строки графика — те, у кого есть числа в колонках-датах (чтобы не поймать строки-настройки типа «Проценты: Ежеквартально»).
  const hasData = (r) => dateCols.some((j) => typeof r[j] === 'number');
  const findRow = (re) => rows.findIndex((r) => re.test(String(r[0] || '')) && hasData(r));
  const rP = findRow(/процент/i), rB = findRow(/тел/i), rO = findRow(/остаток/i);
  if (rB < 0) return null;
  const inst = [];
  let prevBal = rO >= 0 ? num(rows[rO][dateCols[0]]) : 0;
  for (const j of dateCols) {
    const principal = num(rows[rB] && rows[rB][j]);
    const interest = rP >= 0 ? num(rows[rP] && rows[rP][j]) : 0;
    const balAfter = rO >= 0 ? num(rows[rO][j]) : null;
    if (principal <= 0 && interest <= 0) { if (balAfter !== null && balAfter <= 0) break; prevBal = (balAfter !== null ? balAfter : prevBal); continue; }
    inst.push({ due_date: excelDate(rows[dateRow][j]), opening_principal: prevBal, principal_due: principal, interest_due: interest, fee_due: 0, total_due: principal + interest });
    if (balAfter !== null) { prevBal = balAfter; if (balAfter <= 0) break; } else prevBal -= principal;
  }
  if (inst.length < 2) return null;
  const principalReceived = rO >= 0 ? num(rows[rO][dateCols[0]]) : inst.reduce((a, x) => a + x.principal_due, 0);
  return { installments: inst, principal_received: principalReceived };
}

function parseReturnScheduleSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  const out = []; let skipped = 0;
  for (const r of rows) {
    const d = excelDate(r[0]); const amt = Number(r[1]); const due = excelDate(r[2]);
    if (!d || !(amt > 0)) { if (Number(r[1]) > 0 && !d) skipped++; continue; } // строки-итоги/без даты — пропускаем
    out.push({ received_date: d, amount: amt, due_date: due, comment: String(r[3] || '').trim() });
  }
  return { rows: out, skipped };
}

// Построчный график платежей (по заголовкам колонок, порядок любой):
// Дата · Тело(погашение/осн.часть) · Проценты(вознаграждение) · Комиссия.
// Подходит для кредита (тело+проценты) и лизинга (осн.часть+вознаграждение+комиссия).
// Даты — текстом (ДД.ММ.ГГГГ / ГГГГ-ММ-ДД) или серийником Excel (excelDate понимает оба).
function parseScheduleRowsSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  const norm = (v) => String(v == null ? '' : v).toLowerCase().trim();
  const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
  // Ищем строку заголовков: есть «дата» И «тело/погаш/осн» в одной строке (чтобы не спутать с траншами/амортизирующим).
  let hi = -1; const col = { date: -1, principal: -1, interest: -1, fee: -1 };
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map(norm);
    const dI = cells.findIndex((c) => /дат/.test(c));
    const pI = cells.findIndex((c) => /тел|погаш|осн/.test(c));
    if (dI >= 0 && pI >= 0) {
      hi = i; col.date = dI; col.principal = pI;
      col.interest = cells.findIndex((c) => /процент|вознагр/.test(c));
      col.fee = cells.findIndex((c) => /комисс/.test(c));
      break;
    }
  }
  if (hi < 0) return null;
  const inst = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const due = excelDate(r[col.date]);
    if (!due) continue; // строки-итоги/без даты — пропускаем
    const principal = num(r[col.principal]);
    const interest = col.interest >= 0 ? num(r[col.interest]) : 0;
    const fee = col.fee >= 0 ? num(r[col.fee]) : 0;
    if (principal <= 0 && interest <= 0 && fee <= 0) continue;
    inst.push({ due_date: due, principal_due: principal, interest_due: interest, fee_due: fee, total_due: principal + interest + fee });
  }
  if (inst.length < 1) return null;
  // Остаток тела на начало каждой строки — убывающий (для наглядности в графике).
  let bal = inst.reduce((a, x) => a + x.principal_due, 0);
  const principalReceived = bal;
  for (const x of inst) { x.opening_principal = Math.round(bal * 100) / 100; bal = Math.round((bal - x.principal_due) * 100) / 100; }
  return { installments: inst, principal_received: principalReceived };
}

router.post('/api/obligations/import-return-schedule/preview', upload.single('file'), async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    // Число распознанных строк в каждом листе (макс из двух форматов) — для выбора листа.
    const sheetInfo = (ws) => { const s = (parseScheduleRowsSheet(ws) || { installments: [] }).installments.length; const t = parseReturnScheduleSheet(ws).rows.length; const a = (parseAmortizingSheet(ws) || { installments: [] }).installments.length; return { tranches: t, amort: a, schedule: s, count: Math.max(s, t, a) }; };
    const sheets = wb.SheetNames.map((nm) => ({ name: nm, ...sheetInfo(wb.Sheets[nm]) }));
    let chosen = req.body && req.body.sheet && wb.SheetNames.includes(req.body.sheet) ? req.body.sheet : null;
    if (!chosen) chosen = (sheets.slice().sort((a, b) => b.count - a.count)[0] || {}).name || wb.SheetNames[0];
    const ws = wb.Sheets[chosen];
    const sched = parseScheduleRowsSheet(ws);
    const amort = parseAmortizingSheet(ws);
    const tran = parseReturnScheduleSheet(ws);
    // Приоритет 1: построчный график с колонками тело/проценты/комиссия (однозначно опознаётся по заголовкам).
    if (sched && sched.installments.length >= 1) {
      const inst = sched.installments;
      const totalPrincipal = inst.reduce((a, r) => a + r.principal_due, 0);
      const totalInterest = inst.reduce((a, r) => a + r.interest_due, 0);
      const totalFee = inst.reduce((a, r) => a + r.fee_due, 0);
      return res.json({
        sheets, sheet: chosen, format: 'schedule',
        installments: inst, full: inst, principal_received: sched.principal_received,
        summary: { count: inst.length, principal: totalPrincipal, interest: totalInterest, fee: totalFee, total: totalPrincipal + totalInterest + totalFee, first_due: inst[0].due_date, last_due: inst[inst.length - 1].due_date },
      });
    }
    // Приоритет 2: амортизирующий график, если строк графика больше, чем траншей.
    if (amort && amort.installments.length >= Math.max(2, tran.rows.length)) {
      const inst = amort.installments;
      const totalPrincipal = inst.reduce((a, r) => a + r.principal_due, 0);
      const totalInterest = inst.reduce((a, r) => a + r.interest_due, 0);
      return res.json({
        sheets, sheet: chosen, format: 'amortizing',
        installments: inst, full: inst, principal_received: amort.principal_received,
        summary: { count: inst.length, principal: totalPrincipal, interest: totalInterest, total: totalPrincipal + totalInterest, first_due: inst[0].due_date, last_due: inst[inst.length - 1].due_date },
      });
    }
    if (!tran.rows.length) return res.status(400).json({ error: 'На листе «' + chosen + '» не распознан ни построчный график (дата·тело·проценты·комиссия), ни список траншей (дата+сумма), ни амортизирующий график. Выберите другой лист.', sheets, sheet: chosen });
    const total = tran.rows.reduce((a, r) => a + r.amount, 0);
    const dues = tran.rows.map((r) => r.due_date).filter(Boolean).sort();
    res.json({
      sheets, sheet: chosen, format: 'tranches',
      rows: tran.rows.slice(0, 200), full: tran.rows,
      summary: { count: tran.rows.length, total, skipped: tran.skipped, first_due: dues[0] || null, last_due: dues[dues.length - 1] || null, no_due: tran.rows.filter((r) => !r.due_date).length },
    });
  } catch (e) { res.status(400).json({ error: 'Не удалось прочитать файл: ' + e.message }); }
});

router.post('/api/obligations/import-return-schedule/confirm', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const b = req.body || {};
  const type = OBL_TYPES.includes(b.obligation_type) ? b.obligation_type : 'concept_loan';
  const cur = b.currency === 'USD' ? 'USD' : 'UZS';

  // Графики с разбивкой по строкам: амортизирующий (тело+проценты) ИЛИ построчный (тело+проценты+комиссия).
  // Оба создают кредит + строки графика finance_obligation_schedule.
  if (b.format === 'amortizing' || b.format === 'schedule') {
    const inst = Array.isArray(b.rows) ? b.rows.filter((r) => r.due_date) : [];
    if (!inst.length) return res.status(400).json({ error: 'Нет строк графика' });
    const scheme = b.format === 'amortizing' ? 'differentiated' : 'custom';
    const principal = numOrNull(b.principal_received) != null ? numOrNull(b.principal_received) : inst.reduce((a, r) => a + (Number(r.principal_due) || 0), 0);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const lo = await client.query(
        `INSERT INTO finance_obligations (obligation_type, creditor_name, currency, principal_limit, principal_received, annual_rate, repayment_scheme, status, comment, created_by)
         VALUES ($1,$2,$3,$4,$4,$5,$6,'active',$7,$8) RETURNING id`,
        [type, (b.creditor_name || 'Кредитор').trim(), cur, principal, numOrNull(b.annual_rate) || 0, scheme,
          b.comment || (b.format === 'amortizing' ? 'Импорт амортизирующего графика' : 'Импорт графика платежей'), req.user.id]);
      const oid = lo.rows[0].id;
      let no = 0;
      for (const r of inst) {
        no += 1;
        await client.query(
          `INSERT INTO finance_obligation_schedule (obligation_id, version_no, installment_no, due_date, opening_principal, principal_due, interest_due, fee_due, total_due, status)
           VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,'planned')`,
          [oid, no, r.due_date, Number(r.opening_principal) || 0, Number(r.principal_due) || 0, Number(r.interest_due) || 0, Number(r.fee_due) || 0, Number(r.total_due) || (Number(r.principal_due) || 0) + (Number(r.interest_due) || 0) + (Number(r.fee_due) || 0)]);
      }
      await client.query('COMMIT');
      await db.log(req.user.id, b.format === 'amortizing' ? 'obl_import_amort' : 'obl_import_schedule', `${b.creditor_name}: график ${inst.length}`);
      return res.json({ ok: true, id: oid, tranches: 0, schedule: inst.length });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); return res.status(400).json({ error: e.message }); }
    finally { client.release(); }
  }

  const rows = Array.isArray(b.rows) ? b.rows.filter((r) => r.received_date && Number(r.amount) > 0) : [];
  if (!rows.length) return res.status(400).json({ error: 'Нет строк для импорта' });
  // Срок возврата: если в файле нет даты возврата — считаем «дата выдачи + N месяцев» (напр. +15).
  const retMonths = parseInt(b.return_months, 10) || 0;
  const addMonths = (iso, m) => { const d = new Date(iso); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };
  if (retMonths > 0) rows.forEach((r) => { if (!r.due_date) r.due_date = addMonths(r.received_date, retMonths); });
  const scheduledSum = rows.reduce((a, r) => a + Number(r.amount), 0);
  const totalPrincipal = numOrNull(b.principal_received);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const lo = await client.query(
      `INSERT INTO finance_obligations (obligation_type, creditor_name, currency, principal_limit, principal_received, annual_rate, repayment_scheme, status, comment, created_by)
       VALUES ($1,$2,$3,$4,$5,0,'custom','active',$6,$7) RETURNING id`,
      [type, (b.creditor_name || 'Кредитор').trim(), b.currency === 'USD' ? 'USD' : 'UZS', scheduledSum,
        totalPrincipal != null ? totalPrincipal : scheduledSum, b.comment || 'Импорт графика возврата', req.user.id]);
    const oid = lo.rows[0].id;
    // Транши + график (одна строка на транш по дате возврата; беспроцентный).
    const withDue = rows.filter((r) => r.due_date).sort((a, b2) => (a.due_date < b2.due_date ? -1 : 1));
    let no = 0;
    for (const r of rows) {
      no += 1;
      await client.query(
        `INSERT INTO finance_obligation_tranches (obligation_id, tranche_no, received_date, amount, currency, due_date)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [oid, no, r.received_date, Number(r.amount), b.currency === 'USD' ? 'USD' : 'UZS', r.due_date || null]);
    }
    let inst = 0;
    for (const r of withDue) {
      inst += 1;
      await client.query(
        `INSERT INTO finance_obligation_schedule (obligation_id, version_no, installment_no, due_date, opening_principal, principal_due, interest_due, fee_due, total_due, status)
         VALUES ($1,1,$2,$3,0,$4,0,0,$4,'planned')`,
        [oid, inst, r.due_date, Number(r.amount)]);
    }
    await client.query('COMMIT');
    await db.log(req.user.id, 'obl_import_return', `${b.creditor_name}: траншей ${rows.length}, график ${withDue.length}`);
    res.json({ ok: true, id: oid, tranches: rows.length, schedule: withDue.length });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

// Шаблон Excel для импорта графика обязательств: листы «Кредит» и «Лизинг» + подсказка.
// Даты — обычным текстом ДД.ММ.ГГГГ (парсер excelDate понимает и текст, и дату Excel).
router.get('/api/obligations/schedule-template.xlsx', async (req, res) => {
  const wb = XLSX.utils.book_new();
  // Лист 1 — Кредит: дата · тело (погашение) · проценты.
  const credit = XLSX.utils.aoa_to_sheet([
    ['Дата платежа', 'Тело (погашение)', 'Проценты'],
    ['05.08.2026', 5000000, 1200000],
    ['05.09.2026', 5000000, 1100000],
    ['05.10.2026', 5000000, 1000000],
  ]);
  credit['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, credit, 'Кредит');
  // Лист 2 — Лизинг ($): дата · осн. часть (тело) · вознаграждение (проценты) · комиссия лизинга.
  const leasing = XLSX.utils.aoa_to_sheet([
    ['Дата платежа', 'Осн. часть (тело)', 'Вознаграждение (проценты)', 'Комиссия лизинга'],
    ['05.08.2026', 800, 100, 50],
    ['05.09.2026', 800, 95, 50],
    ['05.10.2026', 800, 90, 50],
  ]);
  leasing['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 24 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, leasing, 'Лизинг ($)');
  // Лист 3 — подсказка.
  const help = XLSX.utils.aoa_to_sheet([
    ['Как заполнять'],
    [''],
    ['1) Кредит — лист «Кредит»: колонки Дата · Тело (погашение) · Проценты.'],
    ['2) Лизинг — лист «Лизинг ($)»: Дата · Осн. часть · Вознаграждение · Комиссия лизинга. Валюту (USD) выберите в окне импорта.'],
    ['   • «Осн. часть» ложится в «Тело», «Вознаграждение» — в «Проценты», «Комиссия лизинга» — в «Комиссию».'],
    ['3) Даты — в формате ДД.ММ.ГГГГ (например 05.08.2026). Суммы — числом, без пробелов и букв.'],
    ['4) Порядок колонок и их точные названия можно менять — система ищет по словам «дата», «тело/погаш/осн», «процент/вознагр», «комисс».'],
    ['5) Строки без даты (итоги/пустые) пропускаются автоматически.'],
    [''],
    ['Фин. аренда (равные платежи) — НЕ через Excel:'],
    ['   создайте заём (тип «Прочий»), ставку 0, схему «Равными частями (тело)»,'],
    ['   сумму = платёж × число месяцев; затем в карточке «📅 Построить график»:'],
    ['   число платежей (напр. 24) и дату первого платежа (5-е число). Система создаст график сама.'],
  ]);
  help['!cols'] = [{ wch: 100 }];
  XLSX.utils.book_append_sheet(wb, help, 'Как заполнять');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="obligations_schedule_template.xlsx"');
  res.send(buf);
});

// ---------- Возмещение затрат подотчётным лицам (простой список, не займы/кредиты) ----------
// Пересчёт статуса по выплатам: закрыто, когда выплачено >= суммы траты.
async function reimbSync(id) {
  const r = (await db.pool.query(
    `SELECT r.amount, COALESCE(SUM(p.amount),0) AS paid, MAX(p.pay_date) AS last_date
     FROM finance_reimbursements r LEFT JOIN finance_reimbursement_payments p ON p.reimbursement_id = r.id
     WHERE r.id = $1 GROUP BY r.amount`, [id])).rows[0];
  if (!r) return;
  const done = Number(r.paid) >= Number(r.amount || 0) - 0.005 && Number(r.amount || 0) > 0;
  await db.pool.query('UPDATE finance_reimbursements SET status=$1, reimbursed_date=$2, updated_at=now() WHERE id=$3',
    [done ? 'reimbursed' : 'pending', done ? r.last_date : null, id]);
}

router.get('/api/reimbursements', async (req, res) => {
  try {
    const rows = (await db.pool.query(
      `SELECT r.*, COALESCE(p.paid,0) AS paid
       FROM finance_reimbursements r
       LEFT JOIN (SELECT reimbursement_id, SUM(amount) AS paid FROM finance_reimbursement_payments GROUP BY reimbursement_id) p
         ON p.reimbursement_id = r.id
       ORDER BY (r.status='reimbursed'), r.reim_date DESC NULLS LAST, r.id DESC`)).rows;
    const pays = (await db.pool.query(
      `SELECT id, reimbursement_id, to_char(pay_date,'YYYY-MM-DD') AS pay_date, amount, comment
       FROM finance_reimbursement_payments ORDER BY pay_date, id`)).rows;
    const byId = {};
    for (const p of pays) (byId[p.reimbursement_id] = byId[p.reimbursement_id] || []).push(p);
    const items = rows.map((x) => Object.assign({}, x, {
      paid: Number(x.paid) || 0,
      remainder: Math.max(0, Number(x.amount || 0) - (Number(x.paid) || 0)),
      payments: byId[x.id] || [],
    }));
    let rate = null; try { rate = await getCbuUsdRate(new Date().toISOString().slice(0, 10)); } catch (e) { rate = null; }
    res.json({ items, rate });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Возмещение (полное или частичное): добавляет выплату с датой и пересчитывает статус.
router.post('/api/reimbursements/:id(\\d+)/pay', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const amount = numOrNull(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Укажите сумму выплаты больше нуля' });
  const cur = (await db.pool.query(
    `SELECT r.amount, COALESCE(SUM(p.amount),0) AS paid FROM finance_reimbursements r
     LEFT JOIN finance_reimbursement_payments p ON p.reimbursement_id = r.id
     WHERE r.id = $1 GROUP BY r.amount`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Запись не найдена' });
  const rest = Number(cur.amount || 0) - Number(cur.paid);
  if (amount > rest + 0.005) return res.status(400).json({ error: `Сумма больше остатка (${Math.round(rest)}). Уменьшите выплату.` });
  await db.pool.query(
    'INSERT INTO finance_reimbursement_payments (reimbursement_id, pay_date, amount, comment, created_by) VALUES ($1,$2,$3,$4,$5)',
    [id, b.pay_date || new Date().toISOString().slice(0, 10), amount, b.comment || null, req.user.id]);
  await reimbSync(id);
  await db.log(req.user.id, 'reimb_pay', `#${id} сумма=${amount}`);
  res.json({ ok: true });
});

// Удаление ошибочной выплаты (откат частичного возмещения).
router.post('/api/reimbursements/payments/:pid(\\d+)/delete', async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const r = await db.pool.query('DELETE FROM finance_reimbursement_payments WHERE id=$1 RETURNING reimbursement_id', [req.params.pid]);
  if (!r.rows.length) return res.status(404).json({ error: 'Выплата не найдена' });
  await reimbSync(r.rows[0].reimbursement_id);
  await db.log(req.user.id, 'reimb_pay_delete', '#' + req.params.pid);
  res.json({ ok: true });
});
router.post('/api/reimbursements', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const b = req.body || {};
  if (!b.person || !String(b.person).trim()) return res.status(400).json({ error: 'Укажите подотчётное лицо' });
  const cur = b.currency === 'USD' ? 'USD' : 'UZS';
  const status = b.status === 'reimbursed' ? 'reimbursed' : 'pending';
  const r = await db.pool.query(
    `INSERT INTO finance_reimbursements (reim_date, person, amount, currency, fx_rate, purpose, comment, status, reimbursed_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [b.reim_date || null, String(b.person).trim(), numOrNull(b.amount) || 0, cur, cur === 'USD' ? numOrNull(b.fx_rate) : null, b.purpose || null, b.comment || null, status, status === 'reimbursed' ? (b.reimbursed_date || null) : null, req.user.id]);
  await db.log(req.user.id, 'reimb_create', String(b.person));
  res.json({ ok: true, id: r.rows[0].id });
});
router.post('/api/reimbursements/:id(\\d+)', J, async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  const b = req.body || {};
  const cur = b.currency === 'USD' ? 'USD' : 'UZS';
  const status = b.status === 'reimbursed' ? 'reimbursed' : 'pending';
  await db.pool.query(
    `UPDATE finance_reimbursements SET reim_date=$1, person=$2, amount=$3, currency=$4, fx_rate=$5, purpose=$6, comment=$7, status=$8, reimbursed_date=$9, updated_at=now() WHERE id=$10`,
    [b.reim_date || null, String(b.person || '').trim(), numOrNull(b.amount) || 0, cur, cur === 'USD' ? numOrNull(b.fx_rate) : null, b.purpose || null, b.comment || null, status, status === 'reimbursed' ? (b.reimbursed_date || null) : null, req.params.id]);
  // Если по трате уже есть выплаты — статус ведут они (ручной статус из формы не должен их перебивать).
  const hasPays = await db.pool.query('SELECT 1 FROM finance_reimbursement_payments WHERE reimbursement_id=$1 LIMIT 1', [req.params.id]);
  if (hasPays.rows.length) await reimbSync(parseInt(req.params.id, 10));
  await db.log(req.user.id, 'reimb_update', '#' + req.params.id);
  res.json({ ok: true });
});
router.post('/api/reimbursements/:id(\\d+)/delete', async (req, res) => {
  if (!canFin(req)) return res.status(403).json({ error: 'Только администратор/финансы' });
  await db.pool.query('DELETE FROM finance_reimbursements WHERE id=$1', [req.params.id]);
  await db.log(req.user.id, 'reimb_delete', '#' + req.params.id);
  res.json({ ok: true });
});

module.exports = router;
