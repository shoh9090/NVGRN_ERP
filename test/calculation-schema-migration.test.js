// Проверка миграции схемы «Калькуляции» на поддельной базе, которая ведёт
// себя как настоящий PostgreSQL в одном важном месте: помнит набор колонок
// таблицы и отклоняет INSERT с несуществующей колонкой.
//
// Зачем: CREATE TABLE IF NOT EXISTS на УЖЕ существующей таблице молча ничего
// не делает. Если новую колонку дописать только в его текст, в рабочей базе
// она не появится, а все INSERT с ней будут падать. Ровно так лист
// «Рознич. тара» остался пустым. Обычная заглушка «pool.query всегда ok»
// такую ошибку не ловит — эта ловит.
const test = require('node:test');
const assert = require('node:assert');

// Колонки calc_sheet_products в том виде, в каком таблица впервые появилась
// в рабочей базе (коммит e536099). Новые поля должны доезжать через ALTER.
const COLUMNS_AT_FIRST_RELEASE = [
  'id', 'sheet', 'name', 'barcode', 'pack_template_id', 'prod_factor', 'raw_cost',
  'labor_cost', 'defect_pct', 'price', 'price2', 'retro_pct', 'vat_pct',
  'profit_tax_pct', 'sort', 'status', 'comment', 'created_at', 'updated_by', 'updated_at',
];

function makeFakeDb(existingTables) {
  const tables = new Map(Object.entries(existingTables).map(([t, cols]) => [t, new Set(cols)]));
  const failures = [];
  const inserted = [];

  const pool = {
    query: async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();

      // CREATE TABLE IF NOT EXISTS: если таблица есть — НИЧЕГО не делаем
      const create = flat.match(/^CREATE TABLE IF NOT EXISTS (\w+) \((.*)\)$/i);
      if (create) {
        const [, table, body] = create;
        if (!tables.has(table)) {
          const cols = body.split(',').map((part) => {
            const m = part.trim().match(/^(\w+)/);
            return m ? m[1] : null;
          }).filter((c) => c && !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK)$/i.test(c));
          tables.set(table, new Set(cols));
        }
        return { rows: [] };
      }

      const alter = flat.match(/^ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/i);
      if (alter) {
        const [, table, col] = alter;
        if (!tables.has(table)) throw new Error('relation "' + table + '" does not exist');
        tables.get(table).add(col);
        return { rows: [] };
      }

      const insert = flat.match(/^INSERT INTO (\w+) \(([^)]*)\)/i);
      if (insert) {
        const [, table, colList] = insert;
        const cols = colList.split(',').map((c) => c.trim());
        const known = tables.get(table);
        if (known) {
          const missing = cols.filter((c) => !known.has(c));
          if (missing.length) {
            const err = new Error('column "' + missing[0] + '" of relation "' + table + '" does not exist');
            failures.push({ table, missing, sql: flat.slice(0, 80) });
            throw err;
          }
        }
        if (table === 'calc_sheet_products') inserted.push(params && params[0]);
        return { rows: [{ id: inserted.length, n: 0 }] };
      }

      const update = flat.match(/^UPDATE (\w+) SET (.*?) WHERE/i);
      if (update) {
        const [, table, sets] = update;
        const known = tables.get(table);
        if (known) {
          const cols = [...sets.matchAll(/(\w+)\s*=/g)].map((m) => m[1]);
          const missing = cols.filter((c) => !known.has(c));
          if (missing.length) {
            failures.push({ table, missing, sql: flat.slice(0, 80) });
            throw new Error('column "' + missing[0] + '" does not exist');
          }
        }
        return { rows: [] };
      }

      // Ответы на чтения, от которых зависит ход миграции
      if (/FROM calc_pack_templates/.test(flat)) return { rows: [{ id: 7 }] };
      if (/FROM ref_raw_materials/.test(flat)) return { rows: [] };
      if (/SELECT id FROM calc_sheet_products WHERE sheet/.test(flat)) return { rows: [] };
      if (/count\(\*\)::int AS n FROM calc_cost_items/.test(flat)) return { rows: [{ n: 1 }] };
      if (/AS n FROM information_schema/.test(flat)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
  };
  return { pool, failures, inserted, tables };
}

test('лист «Рознич. тара» наполняется на базе, где таблица создана давно', async () => {
  // Модуль помнит, что уже отработал, поэтому берём его свежим
  delete require.cache[require.resolve('../src/calculation-schema')];
  const { ensureCalculationSchema } = require('../src/calculation-schema');

  const db = makeFakeDb({ calc_sheet_products: COLUMNS_AT_FIRST_RELEASE });
  await ensureCalculationSchema(db.pool);

  assert.deepStrictEqual(db.failures, [],
    'запросы упали из-за отсутствующих колонок: ' + JSON.stringify(db.failures));
  assert.strictEqual(db.inserted.length, 8,
    'ожидали восемь товаров розницы, вставлено: ' + db.inserted.length);
  assert.ok(db.inserted.includes('Латук 100г'));
  assert.ok(db.inserted.includes('айсберг 150г'));
});

test('новые колонки товарного листа доезжают до старой таблицы', async () => {
  delete require.cache[require.resolve('../src/calculation-schema')];
  const { ensureCalculationSchema } = require('../src/calculation-schema');

  const db = makeFakeDb({ calc_sheet_products: COLUMNS_AT_FIRST_RELEASE });
  await ensureCalculationSchema(db.pool);

  const cols = db.tables.get('calc_sheet_products');
  for (const col of ['raw_material_id', 'net_weight_g', 'raw_price_per_kg']) {
    assert.ok(cols.has(col), 'колонка ' + col + ' не добавлена в существующую таблицу');
  }
});
