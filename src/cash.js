// cash.js — модуль «Касса»: единый журнал транзакций, справочники, отчёты.
// Принцип: деньги вносятся один раз (импорт выписки + ручной ввод), отчёты считаются сами.
// Переводы между кошельками — отдельный тип, вне доходов/расходов (защита от двойного счёта).
const express = require('express');
const db = require('./db');

const router = express.Router();

// Объявляем заранее — используются как middleware при регистрации маршрутов ниже.
const J = express.json();
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : parseInt(v, 10));
const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

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

  await q(`CREATE TABLE IF NOT EXISTS cash_groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INT NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active'
  )`);
  await seedGroups();
  await seedCategories();
  await seedWallets();
  // Код 100 «ОБН» — это перемещение между кошельками (подсказка для импорта).
  await db.pool.query("UPDATE cash_categories SET direction_hint='transfer' WHERE code='100' AND (direction_hint IS NULL OR direction_hint='')");
  _ready = true;
}

async function seedGroups() {
  const G = ['1. Сырьё и переменные затраты', '2. Производственные затраты', '3. Продажи и маркетинг',
    '4. Административные расходы', '5. Логистика', '6. Финансы', '7. Капекс (инвестиции)', '8. Прочее'];
  let i = 0;
  for (const name of G) { i += 10; await db.pool.query('INSERT INTO cash_groups (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, i]); }
}

// Классификатор статей ДДС (Приложение А). flow: 1-5,8 operating; 6 financing; 7 investing. * → only_transfer.
async function seedCategories() {
  const G1 = '1. Сырьё и переменные затраты', G2 = '2. Производственные затраты', G3 = '3. Продажи и маркетинг',
        G4 = '4. Административные расходы', G5 = '5. Логистика', G6 = '6. Финансы', G7 = '7. Капекс (инвестиции)', G8 = '8. Прочее';
  const CATS = [
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
    ['100', 'ОБН', G8, 'operating', false],
  ];
  let i = 0;
  for (const [code, name, grp, flow, onlyT] of CATS) {
    i += 10;
    // status не трогаем при обновлении — чтобы не «воскрешать» заархивированные пользователем статьи.
    await db.pool.query(
      `INSERT INTO cash_categories (code, name, group_name, flow_type, only_transfer, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, group_name=EXCLUDED.group_name,
         flow_type=EXCLUDED.flow_type, only_transfer=EXCLUDED.only_transfer, sort_order=EXCLUDED.sort_order`,
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
  const categories = (await db.pool.query("SELECT * FROM cash_categories WHERE status='active' ORDER BY sort_order, id")).rows;
  const groups = (await db.pool.query("SELECT * FROM cash_groups WHERE status='active' ORDER BY sort_order, id")).rows;
  const counterparties = (await db.pool.query(
    `SELECT c.*, cat.code AS cat_code, cat.name AS cat_name
     FROM cash_counterparties c LEFT JOIN cash_categories cat ON cat.id = c.default_category_id
     WHERE c.status='active' ORDER BY c.name`)).rows;
  const contracts = (await db.pool.query(
    `SELECT k.*, cp.name AS cp_name, cat.code AS cat_code, cat.name AS cat_name
     FROM cash_contracts k
     LEFT JOIN cash_counterparties cp ON cp.id = k.counterparty_id
     LEFT JOIN cash_categories cat ON cat.id = k.category_id
     ORDER BY k.id DESC`)).rows;
  let suppliers = [];
  try { suppliers = (await db.pool.query('SELECT id, name FROM ref_counterparties ORDER BY name LIMIT 2000')).rows; } catch (e) { /* справочника может не быть */ }
  res.json({ wallets, categories, groups, counterparties, contracts, suppliers });
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
  const args = [String(b.code).trim(), String(b.name).trim(), b.group_name || null, ft, !!b.only_transfer, parseInt(b.sort_order) || 0];
  try {
    if (b.id) await db.pool.query('UPDATE cash_categories SET code=$1, name=$2, group_name=$3, flow_type=$4, only_transfer=$5, sort_order=$6 WHERE id=$7', [...args, b.id]);
    else await db.pool.query('INSERT INTO cash_categories (code, name, group_name, flow_type, only_transfer, sort_order) VALUES ($1,$2,$3,$4,$5,$6)', args);
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
  const r = await db.pool.query(`
    SELECT w.id, w.name, w.kind, w.color, w.account_no, w.sort_order,
      COALESCE(SUM(CASE
        WHEN t.tx_type='in' AND t.wallet_id=w.id THEN t.amount
        WHEN t.tx_type='transfer' AND t.wallet_to_id=w.id THEN t.amount
        WHEN t.tx_type='out' AND t.wallet_id=w.id THEN -t.amount
        WHEN t.tx_type='transfer' AND t.wallet_id=w.id THEN -t.amount
        ELSE 0 END), 0) AS balance
    FROM cash_wallets w
    LEFT JOIN cash_transactions t ON (t.wallet_id = w.id OR t.wallet_to_id = w.id)
    WHERE w.status='active'
    GROUP BY w.id ORDER BY w.sort_order, w.id`);
  return r.rows;
}
router.get('/api/wallets', async (req, res) => { res.json({ wallets: await walletBalances() }); });

// ---------- Журнал транзакций ----------
router.get('/api/transactions', async (req, res) => {
  const { from, to, wallet, counterparty, category, type, q } = req.query;
  const p = [], w = [];
  if (from) { p.push(from); w.push(`t.tx_date >= $${p.length}`); }
  if (to) { p.push(to); w.push(`t.tx_date <= $${p.length}`); }
  if (type && ['in', 'out', 'transfer'].includes(type)) { p.push(type); w.push(`t.tx_type = $${p.length}`); }
  if (wallet) { p.push(parseInt(wallet)); w.push(`(t.wallet_id = $${p.length} OR t.wallet_to_id = $${p.length})`); }
  if (counterparty) { p.push(parseInt(counterparty)); w.push(`t.counterparty_id = $${p.length}`); }
  if (category) { p.push(parseInt(category)); w.push(`t.category_id = $${p.length}`); }
  if (q) { p.push('%' + String(q).trim() + '%'); w.push(`t.purpose ILIKE $${p.length}`); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const rows = (await db.pool.query(
    `SELECT t.*, w.name AS wallet_name, w.color AS wallet_color, w2.name AS wallet_to_name,
            cp.name AS cp_name, cat.code AS cat_code, cat.name AS cat_name
     FROM cash_transactions t
     LEFT JOIN cash_wallets w ON w.id = t.wallet_id
     LEFT JOIN cash_wallets w2 ON w2.id = t.wallet_to_id
     LEFT JOIN cash_counterparties cp ON cp.id = t.counterparty_id
     LEFT JOIN cash_categories cat ON cat.id = t.category_id
     ${where} ORDER BY t.tx_date DESC, t.id DESC LIMIT 1000`, p)).rows;
  // сводка по фильтру
  const tot = { in: 0, out: 0 };
  for (const r of rows) { if (r.tx_type === 'in') tot.in += Number(r.amount); else if (r.tx_type === 'out') tot.out += Number(r.amount); }
  res.json({ items: rows, totals: tot, unclassified: rows.filter((r) => r.tx_type !== 'transfer' && !r.is_classified).length });
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
    await db.pool.query(
      `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, wallet_to_id, purpose, source, is_classified, created_by)
       VALUES ($1,$2,'transfer',$3,$4,$5,'manual',true,$6)`,
      [date, amount, wallet, to, b.purpose || null, req.user.id]);
  } else {
    const cat = intOrNull(b.category_id);
    await db.pool.query(
      `INSERT INTO cash_transactions (tx_date, amount, tx_type, wallet_id, counterparty_id, contract_id, category_id, purpose, source, is_classified, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10)`,
      [date, amount, type, wallet, intOrNull(b.counterparty_id), intOrNull(b.contract_id), cat, b.purpose || null, !!cat, req.user.id]);
  }
  await db.log(req.user.id, 'cash_tx_add', type + ' ' + amount);
  res.json({ ok: true });
});

// Редактирование / классификация транзакции (тип и кошельки не меняем — чтобы остатки оставались целыми).
router.post('/api/tx/:id(\\d+)', J, async (req, res) => {
  const b = req.body || {};
  const cat = intOrNull(b.category_id);
  await db.pool.query(
    `UPDATE cash_transactions SET tx_date=COALESCE($1,tx_date), amount=COALESCE($2,amount),
       counterparty_id=$3, contract_id=$4, category_id=$5, purpose=$6, is_classified=$7 WHERE id=$8`,
    [b.tx_date || null, b.amount ? Number(b.amount) : null, intOrNull(b.counterparty_id), intOrNull(b.contract_id), cat, b.purpose || null, !!cat, req.params.id]);
  await db.log(req.user.id, 'cash_tx_edit', '#' + req.params.id);
  res.json({ ok: true });
});
router.post('/api/tx/:id(\\d+)/delete', async (req, res) => {
  await db.pool.query('DELETE FROM cash_transactions WHERE id=$1', [req.params.id]);
  await db.log(req.user.id, 'cash_tx_delete', '#' + req.params.id);
  res.json({ ok: true });
});

module.exports = router;
