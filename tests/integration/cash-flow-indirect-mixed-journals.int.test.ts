// The indirect cash flow statement shows only the cash a journal moved as an investing or financing flow, and the
// current portion of long-term debt as a loan. From the blind review of #1156: a R10 000 asset bought with R2 000 cash
// and an R8 000 loan read as a R10 000 investing outflow and an R8 000 financing inflow; a repayment debited to the
// seeded Current Portion of LT Debt account read as operating.
// Seeds its own company: disposable database only.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';
import { getIndirectCashFlow } from '@/modules/accounting/services/reports/cashFlowIndirectService';

const describeIfDb = isDisposableDb(process.env.DATABASE_URL) ? describe : describe.skip;
const CO = randomUUID();
const A: Record<string, string> = {};
// key, code, system account, type, subtype, normal balance
const SPEC: Array<[string, string, boolean, string, string, string]> = [
  ['bank', 'MJ-BANK', false, 'asset', 'bank', 'debit'],
  ['fa', 'MJ-FA', false, 'asset', 'fixed_asset', 'debit'],
  ['vatIn', 'MJ-VATIN', false, 'asset', 'vat_input', 'debit'],
  ['accDep', 'MJ-ACCDEP', false, 'asset', 'accumulated_depreciation', 'credit'],
  ['loan', 'MJ-LOAN', false, 'liability', 'long_term_liability', 'credit'],
  ['ap', 'MJ-AP', false, 'liability', 'payable', 'credit'],
  ['currentPortion', '2215', true, 'liability', 'current_liability', 'credit'], // as migration 471 seeds it
  ['loanPortion', 'MJ-BOND-CP', false, 'liability', 'current_liability', 'credit'], // named by a loan row below
  ['accrual', 'MJ-ACCRUAL', false, 'liability', 'current_liability', 'credit'], // an ordinary current liability
  ['interest', 'MJ-INT', false, 'expense', 'finance_cost', 'debit'],
  ['gain', 'MJ-GAIN', false, 'revenue', 'other_income', 'credit'],
];
type Leg = [string, number, number];
const JOURNALS: Array<{ n: string; date: string; legs: Leg[] }> = [
  { n: 'OPEN', date: '2025-12-01', legs: [['bank', 100000, 0], ['loan', 0, 100000]] },
  { n: 'ASSET', date: '2026-01-10', legs: [['fa', 10000, 0], ['bank', 0, 2000], ['loan', 0, 8000]] },
  { n: 'VAT', date: '2026-02-10', legs: [['fa', 10000, 0], ['vatIn', 1500, 0], ['bank', 0, 3500], ['loan', 0, 8000]] },
  { n: 'ONACC', date: '2026-03-10', legs: [['fa', 10000, 0], ['bank', 0, 2000], ['ap', 0, 8000]] },
  { n: 'SEEDED', date: '2026-04-10', legs: [['currentPortion', 1000, 0], ['interest', 100, 0], ['bank', 0, 1100]] },
  { n: 'ACCRUAL', date: '2026-05-10', legs: [['accrual', 700, 0], ['bank', 0, 700]] },
  { n: 'RECLASS', date: '2026-06-10', legs: [['loan', 5000, 0], ['currentPortion', 0, 5000]] },
  { n: 'LOANROW', date: '2026-07-10', legs: [['loanPortion', 400, 0], ['bank', 0, 400]] },
  { n: 'DISPOSAL', date: '2026-08-10', legs: [['bank', 6000, 0], ['accDep', 4000, 0], ['fa', 0, 9000], ['gain', 0, 1000]] },
];

type Report = Awaited<ReturnType<typeof getIndirectCashFlow>>;
const section = (r: Report, title: string) => r.sections.find((s) => s.section === title)!;
const line = (r: Report, title: string, label: string) => section(r, title).items.find((i) => i.label === label)?.amount;
const OPERATING = 'Operating Activities';
const INVESTING = 'Investing Activities';
const FINANCING = 'Financing Activities';
const NON_CASH = 'Non-cash Investing and Financing Items';
const OTHER_OPERATING = 'Change in Other Operating Assets and Liabilities';
const LOANS = 'Change in Loans and Borrowings';

async function ties(start: string, end: string): Promise<Report> {
  const r = await getIndirectCashFlow(CO, start, end);
  expect(r.closingCash).toBe((await getCashBalance(CO, end)).total);
  expect(r.openingCash).toBe((await getCashBalance(CO, start, { exclusive: true })).total);
  return r;
}

describeIfDb('indirect cash flow: mixed journals and the current portion of debt', () => {
  let pool: Pool;
  beforeAll(async () => {
    assertDisposableDb('This test inserts and deletes a company, accounts and journals.');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await pool.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`, [CO, `CF mixed ${CO.slice(0, 6)}`]);
    for (const [key, code, system, type, sub, normal] of SPEC) {
      A[key] = randomUUID();
      await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_system_account, is_active)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`, [A[key], CO, code, `MJ ${key}`, type, sub, normal, system]);
    }
    await pool.query(`INSERT INTO loans (company_id, reference, principal, start_date, term_months, rate_mode, fixed_rate, current_portion_account_id, status)
                      VALUES ($1,'MJ-BOND',100000,'2025-12-01',12,'FIXED',12,$2,'active')`, [CO, A.loanPortion]);
    for (const j of JOURNALS) {
      const e = await pool.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
                                  VALUES ($1,$2,$3,'cf mixed fixture','draft','manual',$1) RETURNING id`, [CO, `MJ-${j.n}`, j.date]);
      for (const [key, debit, credit] of j.legs) {
        await pool.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,$4,$5)`, [CO, e.rows[0].id, A[key], debit, credit]);
      }
      await pool.query(`UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1`, [e.rows[0].id]);
    }
  }, 90000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM loans WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    } finally { await pool.end(); }
  });

  it('a R10 000 asset on R2 000 cash and an R8 000 loan is a R2 000 investing outflow and nothing else', async () => {
    const r = await ties('2026-01-01', '2026-01-31');
    expect(section(r, INVESTING).total).toBe(-2000);
    expect(section(r, FINANCING).total).toBe(0);
    expect(line(r, FINANCING, LOANS)).toBeUndefined();
    expect(section(r, OPERATING).total).toBe(0);
    expect(line(r, OPERATING, NON_CASH)).toBeUndefined(); // -8 000 and +8 000 net to nothing
    expect(r.netChange).toBe(-2000);
  });

  it('with input VAT paid in cash: VAT stays operating, investing is the rest of the cash', async () => {
    const r = await ties('2026-02-01', '2026-02-28');
    expect(line(r, OPERATING, 'Change in VAT Control')).toBe(-1500);
    expect(section(r, INVESTING).total).toBe(-2000);
    expect(section(r, FINANCING).total).toBe(0);
    expect(r.netChange).toBe(-3500);
  });

  it('the rest on account stays in payables, offset by the non-cash line', async () => {
    const r = await ties('2026-03-01', '2026-03-31');
    expect(section(r, INVESTING).total).toBe(-2000);
    expect(line(r, OPERATING, 'Change in Accounts Payable')).toBe(8000);
    expect(line(r, OPERATING, NON_CASH)).toBe(-8000);
    expect(section(r, OPERATING).total).toBe(0);
    expect(r.netChange).toBe(-2000);
  });

  it('a repayment on the seeded Current Portion of LT Debt is financing; its interest is net income', async () => {
    const r = await ties('2026-04-01', '2026-04-30');
    expect(line(r, FINANCING, LOANS)).toBe(-1000);
    expect(section(r, FINANCING).total).toBe(-1000);
    expect(line(r, OPERATING, OTHER_OPERATING)).toBeUndefined();
    expect(section(r, OPERATING).total).toBe(-100);
    expect(r.netChange).toBe(-1100);
  });

  it('an ordinary current liability of the same subtype stays operating', async () => {
    const r = await ties('2026-05-01', '2026-05-31');
    expect(line(r, OPERATING, OTHER_OPERATING)).toBe(-700);
    expect(section(r, FINANCING).total).toBe(0);
    expect(r.netChange).toBe(-700);
  });

  it('the period-close reclass from long-term to current portion moves nothing, anywhere', async () => {
    const r = await ties('2026-06-01', '2026-06-30');
    for (const s of r.sections) expect(s.total, s.section).toBe(0);
    expect(line(r, OPERATING, OTHER_OPERATING)).toBeUndefined();
    expect(line(r, OPERATING, NON_CASH)).toBeUndefined();
  });

  it('a current-portion account a loan names is financing whatever its code', async () => {
    const r = await ties('2026-07-01', '2026-07-31');
    expect(line(r, FINANCING, LOANS)).toBe(-400);
    expect(line(r, OPERATING, OTHER_OPERATING)).toBeUndefined();
  });

  it('another chart\'s own 2215, not a system account, stays operating', async () => {
    const other = randomUUID();
    const bank = randomUUID();
    const accrual2215 = randomUUID();
    await pool.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`, [other, `CF mixed ${other.slice(0, 6)}`]);
    try {
      await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_system_account, is_active) VALUES
        ($1,$3,'2215','Accrued leave','liability','current_liability','credit',false,true), ($2,$3,'OB','Bank','asset','bank','debit',false,true)`, [accrual2215, bank, other]);
      const e = await pool.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
                                  VALUES ($1,'MJ-OTHER','2026-05-10','cf mixed fixture','draft','manual',$1) RETURNING id`, [other]);
      await pool.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,300,0), ($1,$2,$4,0,300)`, [other, e.rows[0].id, accrual2215, bank]);
      await pool.query(`UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1`, [e.rows[0].id]);
      const r = await getIndirectCashFlow(other, '2026-05-01', '2026-05-31');
      expect(line(r, OPERATING, OTHER_OPERATING)).toBe(-300);
      expect(section(r, FINANCING).total).toBe(0);
    } finally {
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [other]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [other]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [other]);
      await pool.query('DELETE FROM companies WHERE id = $1', [other]);
    }
  });

  it('a disposal is investing for the proceeds alone, and operating nets to nothing', async () => {
    const r = await ties('2026-08-01', '2026-08-31');
    expect(section(r, INVESTING).total).toBe(6000);
    expect(section(r, OPERATING).total).toBe(0);
    expect(r.netChange).toBe(6000);
  });

  it('the whole year ties to the ledger, every section footing', async () => {
    const r = await ties('2025-12-01', '2026-12-31');
    expect(r.closingCash).toBe(100000 - 2000 - 3500 - 2000 - 1100 - 700 - 400 + 6000);
    expect(r.netChange).toBe((await getCashFlowDirect(CO, '2025-12-01', '2026-12-31')).netChange);
    for (const s of r.sections) expect(s.items.reduce((t, i) => t + Math.round(i.amount * 100), 0), s.section).toBe(Math.round(s.total * 100));
  });
});
