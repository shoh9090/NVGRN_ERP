// seed-obligations.js — РАЗОВАЯ загрузка обязательств (по книге 00_obyazat.xlsx).
// Идемпотентно: если уже засеяно (есть запись с comment 'seed:v1%') — ничего не делает.
// Можно удалить этот файл и вызов из db.js после первичной загрузки.
const addMonths = (iso, m) => { const d = new Date(iso); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };

// Хикматов: 69 траншей (дата выдачи, сумма $). Срок возврата = +15 месяцев.
const HIKMATOV = [["2025-09-15",10000],["2025-09-30",10000],["2025-10-18",10000],["2025-10-23",2341],["2025-10-28",183],["2025-10-28",4991],["2025-11-04",5020],["2025-11-07",10000],["2025-11-14",100],["2025-11-15",750],["2025-11-20",882],["2025-11-21",1330],["2025-11-21",5000],["2025-11-23",513],["2025-11-27",2500],["2025-11-28",30],["2025-11-28",5000],["2025-12-02",350],["2025-12-03",4000],["2025-12-03",370],["2025-12-11",300],["2025-12-11",1078],["2025-12-13",10000],["2025-12-13",1765],["2025-12-16",8550],["2025-12-18",120],["2025-12-21",1192],["2025-12-20",2000],["2025-12-24",3000],["2025-12-24",500],["2025-12-27",2500],["2025-12-27",1975],["2025-12-28",925],["2025-12-29",1800],["2025-12-29",2000],["2026-01-06",100],["2026-01-07",350],["2026-01-08",680],["2026-01-10",130],["2026-01-10",1500],["2026-01-11",700],["2026-01-13",2870],["2026-01-14",475],["2026-01-15",512],["2026-01-15",35000],["2026-01-17",1500],["2026-01-19",821],["2026-01-20",400],["2026-01-20",500],["2026-01-20",132],["2026-01-22",700],["2026-01-26",2661],["2026-01-27",132],["2026-01-29",570],["2026-01-30",750],["2026-02-01",380],["2026-02-02",398],["2026-02-03",1500],["2026-02-09",50],["2026-02-10",30],["2026-02-15",430],["2026-02-24",8978],["2026-02-25",5000],["2026-03-07",266],["2026-03-10",1237],["2026-03-16",5000],["2026-04-10",10000],["2026-04-20",2000],["2026-04-28",2120]];

// Хабибуллаев Ф. %%% — амортизирующий график (тело/проценты/остаток на начало).
const HABIB = [
  { due: '2026-07-25', open: 99550, p: 0, i: 2488.75 },
  { due: '2026-10-25', open: 99550, p: 15000, i: 2488.75 },
  { due: '2027-01-25', open: 84550, p: 14550, i: 2488.75 },
  { due: '2027-04-25', open: 70000, p: 70000, i: 1750 },
];

async function seedObligations(pool) {
  const done = (await pool.query("SELECT 1 FROM finance_obligations WHERE comment LIKE 'seed:v1%' LIMIT 1").catch(() => ({ rows: [] }))).rows.length;
  if (done) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mkLoan = async (type, name, received, rate, scheme, tag) => {
      const r = await client.query(
        `INSERT INTO finance_obligations (obligation_type, creditor_name, currency, principal_limit, principal_received, annual_rate, repayment_scheme, status, comment)
         VALUES ($1,$2,'USD',$3,$3,$4,$5,'active',$6) RETURNING id`,
        [type, name, received, rate, scheme, 'seed:v1 ' + tag]);
      return r.rows[0].id;
    };

    // 1) Хикматов К — заём траншами, общий долг 254 268 (график 198 937, остальное вне графика).
    const hid = await mkLoan('concept_loan', 'Хикматов К', 254268, 0, 'custom', 'hikmatov');
    let no = 0;
    const sched = [];
    for (const [d, a] of HIKMATOV) {
      no += 1;
      const due = addMonths(d, 15);
      await client.query(
        `INSERT INTO finance_obligation_tranches (obligation_id, tranche_no, received_date, amount, currency, due_date)
         VALUES ($1,$2,$3,$4,'USD',$5)`, [hid, no, d, a, due]);
      sched.push({ due, amount: a });
    }
    sched.sort((x, y) => (x.due < y.due ? -1 : 1));
    let inst = 0;
    for (const s of sched) {
      inst += 1;
      await client.query(
        `INSERT INTO finance_obligation_schedule (obligation_id, version_no, installment_no, due_date, opening_principal, principal_due, interest_due, fee_due, total_due, status)
         VALUES ($1,1,$2,$3,0,$4,0,0,$4,'planned')`, [hid, inst, s.due, s.amount]);
    }

    // 2) Хабибуллаев Ф. %%% — амортизирующий кредит 99 550, 10%.
    const habId = await mkLoan('bank_loan', 'Хабибуллаев Ф. %%%', 99550, 10, 'differentiated', 'habib_amort');
    let hi = 0;
    for (const s of HABIB) {
      hi += 1;
      await client.query(
        `INSERT INTO finance_obligation_schedule (obligation_id, version_no, installment_no, due_date, opening_principal, principal_due, interest_due, fee_due, total_due, status)
         VALUES ($1,1,$2,$3,$4,$5,$6,0,$7,'planned')`, [habId, hi, s.due, s.open, s.p, s.i, s.p + s.i]);
    }

    // 3) Простые (фиксированная сумма, без графика).
    await mkLoan('other_loan', 'Хабибуллаев Ф. ОС', 20000, 0, 'custom', 'habib_os');
    await mkLoan('founder_loan', 'мурадов Ш', 10450, 0, 'custom', 'muradov');
    await mkLoan('investment_loan', 'ЛИЗИНГИ на 03.2026', 36800, 0, 'custom', 'leasing');

    await client.query('COMMIT');
    console.log('[seed-obligations] Загружены обязательства (Хикматов + Хабибуллаев + 3 простых).');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('[seed-obligations] Ошибка:', e.message); }
  finally { client.release(); }
}

module.exports = seedObligations;
