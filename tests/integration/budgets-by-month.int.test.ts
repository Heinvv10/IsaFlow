/**
 * Budgets keyed by calendar month (migration 944) on a company whose financial
 * year is a 14-month transition year (Jan 2026 - Feb 2027, label 2026; the
 * next stored year is label 2028, so label 2027 does not exist). The budget is
 * seeded directly on the year's primary version (the legacy writers were removed
 * in budgets P2 PR-D); the READERS run as real services inside a request
 * transaction. All data synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { getBudgets } from '@/modules/accounting/services/core/budgetService';
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
    // A DRAFT primary 'Original' (what the wizard or a first save makes), so the readers below (getBudgets, the BvA
    // variance and window sums) are proven on draft data, not only on migration 947's APPROVED converted Originals.
    const version = (await pool.query(
      `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
       VALUES ($1, 2026, 'Original', 'original', true, $2) RETURNING id`, [companyId, user])).rows[0].id;
    expect((await pool.query('SELECT status FROM budget_versions WHERE id = $1', [version])).rows[0].status).toBe('draft');
    await pool.query(
      `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, created_by)
       SELECT $1, $2, $3, (m || '-01')::DATE, a, $6 FROM unnest($4::TEXT[], $5::NUMERIC[]) AS t(m, a)`,
      [companyId, version, ids.rent, amounts(100).map((x) => x.month), amounts(100).map((x) => x.amount), user]);
    await pool.query(`INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, notes, created_by) VALUES ($1, 'FY2026 Budget', 2026, $2, 'transition', $3)`,
      [companyId, ids.rent, user]);
    const rows = await storedMonths(ids.rent);
    expect(rows).toHaveLength(14);
    expect(rows[0]).toEqual({ month: '2026-01-01', amount: '100.00' });
    expect(rows[13]).toEqual({ month: '2027-02-01', amount: '1400.00' });

    const listed = await inTx(() => getBudgets(companyId, 2026));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.months).toEqual(amounts(100));
    expect(listed[0]!.annualAmount).toBe(TOTAL_100);
    expect(listed[0]!.notes).toBe('transition');
  });

  it('refuses a label no year carries (2027 was skipped by the change of year end)', async () => {
    await expect(inTx(() => getBudgets(companyId, 2027))).rejects.toThrow(/No financial year is labelled 2027/);
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
    expect(mid[ids.rent]).toBe(1200 + 1300);
    // Keyed by account id only: a code is never a key.
    expect(Object.keys(mid)).toEqual([ids.rent]);
  });

  it('ytd and current windows come from the registry year, not the declared start month', async () => {
    const now = new Date(2026, 9, 23);
    expect(await inTx(() => resolveBudgetWindow(companyId, 'ytd', now)))
      .toMatchObject({ startDate: '2026-01-01', endDate: '2026-10-31' });
    expect(await inTx(() => resolveBudgetWindow(companyId, 'current', now)))
      .toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-31' });
  });
});
