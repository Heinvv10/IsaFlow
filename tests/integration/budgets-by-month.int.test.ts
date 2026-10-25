/**
 * Budgets keyed by calendar month (migration 944) on a company whose financial
 * year is a 14-month transition year (Jan 2026 - Feb 2027, label 2026; the
 * next stored year is label 2028, so label 2027 does not exist). Runs the real
 * services inside a request transaction. All data synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import {
  BudgetInputError, copyBudgets, deleteBudget, getBudgets, upsertBudget,
} from '@/modules/accounting/services/core/budgetService';
import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';
import { loadWindowBudgets, resolveBudgetWindow } from '@/modules/accounting/services/reports/budgetWindowService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const user = crypto.randomUUID();
const companyId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
const ids = { bank: crypto.randomUUID(), rent: crypto.randomUUID(), sales: crypto.randomUUID(), otherRent: crypto.randomUUID() };

const MONTHS_2026 = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
  '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
/** Month i (1-based) budgets 100 * i: the 14 amounts are all different, so a month filed under the wrong key shows. */
const amounts = (scale: number) => MONTHS_2026.map((month, i) => ({ month, amount: (i + 1) * scale }));
const TOTAL_100 = 100 * (14 * 15) / 2; // 10500

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId, userId: user, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function post(entryDate: string, expenseId: string, amount: number): Promise<void> {
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status, source)
     VALUES ($1, $2, $3, 'rent', 'draft', 'manual') RETURNING id`, [companyId, entryDate, user])).rows[0];
  await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description)
                    VALUES ($1, $2, $3, $5, 0, 'd'), ($1, $2, $4, 0, $5, 'c')`, [je.id, companyId, expenseId, ids.bank, amount]);
  await pool.query(`UPDATE gl_journal_entries SET status = 'posted', posted_by = $2, posted_at = NOW() WHERE id = $1`, [je.id, user]);
}

const storedMonths = async (account: string) => (await pool.query(
  `SELECT TO_CHAR(month, 'YYYY-MM-DD') AS month, amount::text AS amount FROM budget_month_amounts
    WHERE company_id = $1 AND gl_account_id = $2 ORDER BY month`, [companyId, account])).rows as Array<{ month: string; amount: string }>;

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  for (const [id, name] of [[companyId, 'BUDM co'], [otherCompanyId, 'BUDM other']]) {
    await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, $2, 3)`, [id, name]);
  }
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active) VALUES
       ($1, $5, 'B-1', 'bank', 'asset', 'debit', 3, true), ($2, $5, 'B-5', 'rent', 'expense', 'debit', 3, true),
       ($3, $5, 'B-4', 'sales', 'revenue', 'credit', 3, true), ($4, $6, 'B-5', 'rent', 'expense', 'debit', 3, true)`,
    [ids.bank, ids.rent, ids.sales, ids.otherRent, companyId, otherCompanyId]);
  const years = [[2026, '2026-01-01', '2027-02-28', 'transition'], [2028, '2027-03-01', '2028-02-29', 'normal']] as const;
  for (const [label, start, end, kind] of years) {
    const y = (await pool.query(
      `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [companyId, label, start, end, kind])).rows[0];
    await pool.query('SELECT public.fiscal_periods_generate($1)', [y.id]);
  }
});

afterAll(async () => {
  try {
    for (const id of [companyId, otherCompanyId]) {
      await pool.query('DELETE FROM budget_month_amounts WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM accounting_budgets WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally { await pool.end(); }
}, 60000);

describe('a 14-month transition year', () => {
  it('stores and reads back all 14 calendar months with the right total', async () => {
    const entry = await inTx(() => upsertBudget(companyId,
      { glAccountId: ids.rent, fiscalYear: 2026, months: amounts(100), notes: 'transition' }, user));
    expect(entry.months).toEqual(amounts(100));
    expect(entry.annualAmount).toBe(TOTAL_100);
    expect(entry.notes).toBe('transition');
    const rows = await storedMonths(ids.rent);
    expect(rows).toHaveLength(14);
    expect(rows[0]).toEqual({ month: '2026-01-01', amount: '100.00' });
    expect(rows[13]).toEqual({ month: '2027-02-01', amount: '1400.00' });

    const listed = await inTx(() => getBudgets(companyId, 2026));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.months).toHaveLength(14);
    expect(listed[0]!.annualAmount).toBe(TOTAL_100);
  });

  it('spreads an annual amount over 14 months with the cents on the last', async () => {
    const entry = await inTx(() => upsertBudget(companyId, { glAccountId: ids.sales, fiscalYear: 2026, annualAmount: 100000 }, user));
    expect(entry.months).toHaveLength(14);
    expect(entry.months.slice(0, 13).every(m => m.amount === 7142.86)).toBe(true);
    expect(entry.months[13]).toEqual({ month: '2027-02', amount: 7142.82 });
    expect(entry.annualAmount).toBe(100000);
    await inTx(() => deleteBudget(companyId, ids.sales, 2026));
  });

  it('refuses months that are not exactly the year, and a label no year carries', async () => {
    await expect(inTx(() => upsertBudget(companyId,
      { glAccountId: ids.rent, fiscalYear: 2026, months: amounts(1).slice(0, 12) }, user))).rejects.toThrow(BudgetInputError);
    await expect(inTx(() => upsertBudget(companyId,
      { glAccountId: ids.rent, fiscalYear: 2026, months: [...amounts(1).slice(0, 13), { month: '2027-03', amount: 1 }] }, user)))
      .rejects.toThrow(/not in this year: 2027-03/);
    await expect(inTx(() => getBudgets(companyId, 2027))).rejects.toThrow(/No financial year is labelled 2027/);
    expect(await storedMonths(ids.rent)).toHaveLength(14);
  });

  it('refuses another company\'s account', async () => {
    await expect(inTx(() => upsertBudget(companyId,
      { glAccountId: ids.otherRent, fiscalYear: 2026, annualAmount: 1 }, user))).rejects.toThrow(/does not belong to this company/);
  });

  it('Budget vs Actual over the full year sums all 14 months against the posted actuals', async () => {
    await post('2026-01-15', ids.rent, 70);   // month 1
    await post('2026-10-05', ids.rent, 400);  // month 10
    await post('2027-01-20', ids.rent, 1300); // month 13: a 12-month window drops it
    await post('2027-02-27', ids.rent, 600);  // month 14
    const window = await inTx(() => resolveBudgetWindow(companyId, 'full_year', new Date(2026, 9, 23)));
    expect(window).toMatchObject({ startDate: '2026-01-01', endDate: '2027-02-28' });
    expect(window.fiscalYear.months).toBe(14);

    const result = await inTx(() => getBudgetVariance(companyId, window.startDate, window.endDate));
    expect(result.monthKeys).toEqual(MONTHS_2026);
    expect(result.fiscalYear).toBe(2026);
    const line = result.rows.find(r => r.account_code === 'B-5')!;
    expect(line.budget_amount).toBe(TOTAL_100);
    expect(line.actual_amount).toBe(2370);
    expect(line.variance).toBe(TOTAL_100 - 2370);
  });

  it('a one-month window sums that one month, and a window across the year boundary sums its months', async () => {
    const feb = await inTx(() => getBudgetVariance(companyId, '2027-02-01', '2027-02-28'));
    expect(feb.monthKeys).toEqual(['2027-02']);
    expect(feb.rows.find(r => r.account_code === 'B-5')).toMatchObject({ budget_amount: 1400, actual_amount: 600 });

    const mid = await inTx(() => loadWindowBudgets(companyId, '2026-12-15', '2027-01-10'));
    expect(mid['B-5']).toBe(1200 + 1300);
    expect(mid[ids.rent]).toBe(2500);
  });

  it('ytd and current windows come from the registry year, not the declared start month', async () => {
    const now = new Date(2026, 9, 23);
    expect(await inTx(() => resolveBudgetWindow(companyId, 'ytd', now)))
      .toMatchObject({ startDate: '2026-01-01', endDate: '2026-10-23' });
    expect(await inTx(() => resolveBudgetWindow(companyId, 'current', now)))
      .toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-23' });
  });

  it('copies to the next year by month position: 14 months into 12 drops the last two; a re-run adds nothing', async () => {
    expect(await inTx(() => copyBudgets(companyId, 2026, 2028, user))).toBe(1);
    const next = await storedMonths(ids.rent);
    const copied = next.filter(r => r.month >= '2027-03-01');
    expect(copied.map(r => [r.month, r.amount])).toEqual(
      MONTHS_2026.slice(0, 12).map((_, i) => [`${i < 10 ? '2027-' + String(i + 3).padStart(2, '0') : '2028-' + String(i - 9).padStart(2, '0')}-01`, `${(i + 1) * 100}.00`]));
    const target = await inTx(() => getBudgets(companyId, 2028));
    expect(target[0]!.months).toHaveLength(12);
    expect(target[0]!.annualAmount).toBe(100 * (12 * 13) / 2);
    expect(target[0]!.notes).toBe('transition');
    expect(await inTx(() => copyBudgets(companyId, 2026, 2028, user))).toBe(0);
    await expect(inTx(() => copyBudgets(companyId, 2026, 2026, user))).rejects.toThrow(BudgetInputError);
  });

  it('deleting a year\'s budget leaves the other year\'s months', async () => {
    await inTx(() => deleteBudget(companyId, ids.rent, 2028));
    const left = await storedMonths(ids.rent);
    expect(left).toHaveLength(14);
    expect(left.every(r => r.month < '2027-03-01')).toBe(true);
    expect(await inTx(() => getBudgets(companyId, 2028))).toEqual([]);
    expect(await inTx(() => getBudgets(companyId, 2026))).toHaveLength(1);
  });
});
