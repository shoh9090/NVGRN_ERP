// Почему прибыль не равна деньгам — вторая половина ДДС (косвенная форма).
// Проверяем, что переход сходится и что необъяснённое не прячется.
const test = require('node:test');
const assert = require('node:assert');

const { profitToCash } = require('../src/cash-accrual');

// Поддельная база: остатки денег и статьи месяца.
function pool(o) {
  const opts = o || {};
  let balCall = 0;
  return {
    query: async (sql, params) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/INTERVAL '1 month'/.test(q)) return { rows: [{ d: '2026-08-31' }] };
      if (/- INTERVAL '1 day'/.test(q)) return { rows: [{ d: '2026-07-31' }] };
      if (/FROM cash_transactions WHERE tx_date <= /.test(q)) {
        balCall++;
        return { rows: [{ b: balCall === 1 ? opts.opening : opts.closing }] };
      }
      if (/JOIN cash_categories c ON c\.id = t\.category_id/.test(q)) return { rows: opts.codes || [] };
      return { rows: [] };
    },
  };
}

const pnlOf = (o = {}) => ({
  period: '2026-08',
  revenue: { total: 1_679_500_000, source: 'shipped', cash_in_sales: 1_234_400_000 },
  cogs_parts: { raw: 534_700_000, raw_paid: 599_700_000, raw_source: 'purchase', packaging: 81_100_000 },
  opex: { total: 779_900_000, groups: [] },
  interest: { total: 2_700_000 },
  profit_tax: { total: 0 },
  net_profit: o.net === undefined ? 281_000_000 : o.net,
  excluded: { capex: { total: o.capex === undefined ? 4_800_000 : o.capex } },
});

test('переход от прибыли к деньгам: шаги названы и арифметика сходится', async () => {
  const r = await profitToCash(pool({
    opening: 100_000_000, closing: 80_500_000,
    codes: [{ code: '203', inc: 229_000_000, exp: 0 }, { code: '61', inc: 0, exp: 21_900_000 }],
  }), '2026-08', pnlOf());

  assert.strictEqual(r.net_profit, 281_000_000);
  // Продали в долг: отгрузка минус деньги за товар, со знаком минус.
  assert.strictEqual(r.steps.find((x) => x.key === 'ar').amount, -(1_679_500_000 - 1_234_400_000));
  // Купили в долг: приняли меньше, чем оплатили — значит гасили старый долг, знак минус.
  assert.strictEqual(r.steps.find((x) => x.key === 'ap').amount, 534_700_000 - 599_700_000);
  assert.strictEqual(r.steps.find((x) => x.key === 'repaid').amount, -21_900_000);
  assert.strictEqual(r.steps.find((x) => x.key === 'borrowed').amount, 229_000_000);
  assert.strictEqual(r.steps.find((x) => x.key === 'capex').amount, -4_800_000);

  // Ожидаемое изменение денег = прибыль + все шаги.
  const sum = r.steps.reduce((t, x) => t + x.amount, 0);
  assert.strictEqual(r.expected, 281_000_000 + sum);
  // Фактическое — из остатков.
  assert.strictEqual(r.actual, 80_500_000 - 100_000_000);
  // Необъяснённое = факт минус ожидание, и оно показано, а не спрятано.
  assert.strictEqual(r.residual, r.actual - r.expected);
  assert.match(r.residual_note, /долг клиентов на начало и конец/);
});

test('нет прибыли — переход не строится и так и говорится', async () => {
  const r = await profitToCash(pool({ opening: 0, closing: 0 }), '2026-08', pnlOf({ net: null }));
  assert.strictEqual(r.expected, null);
  assert.strictEqual(r.residual, null);
  assert.match(r.note, /посчитать не из чего/);
});

test('возврат кредита в прибыли не расход, но деньги уводит', async () => {
  const r = await profitToCash(pool({
    opening: 0, closing: 0, codes: [{ code: '61', inc: 0, exp: 150_000_000 }],
  }), '2026-08', pnlOf({ capex: 0 }));
  const step = r.steps.find((x) => x.key === 'repaid');
  assert.strictEqual(step.amount, -150_000_000);
  assert.match(step.why, /В прибыли этого расхода нет/);
});

test('капекса и займов не было — лишних строк не рисуем', async () => {
  const r = await profitToCash(pool({ opening: 0, closing: 0, codes: [] }), '2026-08', pnlOf({ capex: 0 }));
  assert.ok(!r.steps.some((x) => x.key === 'capex'));
  assert.ok(!r.steps.some((x) => x.key === 'borrowed'));
  assert.ok(!r.steps.some((x) => x.key === 'repaid'));
  // Но главные две строки — про долги клиентов и поставщиков — остаются.
  assert.ok(r.steps.some((x) => x.key === 'ar'));
  assert.ok(r.steps.some((x) => x.key === 'ap'));
});
