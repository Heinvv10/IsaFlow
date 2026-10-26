/**
 * Budgets against a REAL database: amounts are stored per calendar month in
 * `budget_month_amounts` (migration 944), `accounting_budgets` is only the
 * per-year header that carries the notes.
 *
 * A test that mocks the `sql` template would assert the shape of a statement
 * Postgres may reject, so every assertion here runs against the live schema
 * inside BEGIN ... ROLLBACK on an ALS-bound client.
 *
 * The storage shape is fixed by the READ path (budgetWindowService sums
 * budget_month_amounts by month). If the write path stores anything else,
 * budget-vs-actual reports R0.00 budget forever. Whole-service behaviour on a
 * 14-month transition year is in tests/integration/budgets-by-month.int.test.ts.
 *
 * DB-gated: skips (never fails) when no DB is reachable.
 */
import { describe, it, expect, vi } from 'vitest';
import { isDbReachable } from '../helpers/dbReachable';
import { FY, inRequestTx, monthsOf, storedMonths } from '../helpers/budgetServiceDbFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  getBudgets,
  upsertBudget,
  deleteBudget,
  copyBudgets,
} from '@/modules/accounting/services/core/budgetService';

describe('budgetService against the real budget_month_amounts table', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('writes month rows Postgres accepts, and leaves the legacy amount columns unwritten', async () => {
    await inRequestTx(async (f) => {
      const keys = await monthsOf(f.companyId, FY);
      const entry = await upsertBudget(
        f.companyId,
        { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 120000, notes: 'even spread' },
        f.userId,
      );

      expect(entry.glAccountId).toBe(f.expenseAccountId);
      expect(entry.fiscalYear).toBe(FY);
      expect(entry.annualAmount).toBe(120000);
      expect(entry.months.map(m => m.month)).toEqual(keys);
      expect(entry.months.every(m => m.amount === 120000 / keys.length)).toBe(true);
      expect(entry.accountCode).not.toBe('');
      expect(entry.notes).toBe('even spread');

      const rows = await storedMonths(f.companyId, f.expenseAccountId);
      expect(rows.map(r => r.month)).toEqual(keys.map(k => `${k}-01`));
      expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBeCloseTo(120000, 2);

      const header = (await sql`
        SELECT budget_name, period_amounts, annual_amount::text AS annual_amount, notes FROM accounting_budgets
        WHERE company_id = ${f.companyId}::uuid AND gl_account_id = ${f.expenseAccountId}::uuid AND fiscal_year = ${FY}
      `) as Array<{ budget_name: string; period_amounts: Record<string, unknown>; annual_amount: string; notes: string }>;
      expect(header).toHaveLength(1);
      expect(header[0]!.notes).toBe('even spread');
      // The header is notes only: the superseded amount columns are never written.
      expect(header[0]!.period_amounts).toEqual({});
      expect(Number(header[0]!.annual_amount)).toBe(0);
    });
  });

  it.skipIf(!reachable)('refuses a budget on a balance-sheet account before any write (D13)', async () => {
    await inRequestTx(async (f) => {
      const [asset] = (await sql`
        SELECT id FROM gl_accounts
        WHERE company_id = ${f.companyId}::uuid AND account_type NOT IN ('revenue', 'expense')
        ORDER BY account_code LIMIT 1
      `) as Array<{ id: string }>;
      expect(asset).toBeDefined();
      await expect(upsertBudget(f.companyId, { glAccountId: asset!.id, fiscalYear: FY, annualAmount: 1200 }, f.userId))
        .rejects.toMatchObject({ name: 'BudgetInputError', message: 'Budgets can only be set on revenue and expense accounts' });
      expect(await storedMonths(f.companyId, asset!.id)).toEqual([]);
      const headers = (await sql`
        SELECT 1 FROM accounting_budgets WHERE company_id = ${f.companyId}::uuid AND gl_account_id = ${asset!.id}::uuid
      `) as unknown[];
      expect(headers).toHaveLength(0);
    });
  });

  it.skipIf(!reachable)('honours an explicit month split rather than spreading evenly', async () => {
    await inRequestTx(async (f) => {
      const keys = await monthsOf(f.companyId, FY);
      const months = keys.map((month, i) => ({ month, amount: i === 0 ? 1000 : i === keys.length - 1 ? 4000 : 0 }));
      const entry = await upsertBudget(
        f.companyId, { glAccountId: f.revenueAccountId, fiscalYear: FY, months }, f.userId,
      );
      expect(entry.months).toEqual(months);
      expect(entry.annualAmount).toBe(5000);
      const rows = await storedMonths(f.companyId, f.revenueAccountId);
      expect(Number(rows[0]!.amount)).toBe(1000);
      expect(Number(rows[1]!.amount)).toBe(0);
      expect(Number(rows[rows.length - 1]!.amount)).toBe(4000);
    });
  });

  it.skipIf(!reachable)('upserts on the second write instead of duplicating the account or its months', async () => {
    await inRequestTx(async (f) => {
      const first = await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 60000 }, f.userId,
      );
      const second = await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 90000, notes: 'revised' }, f.userId,
      );

      expect(second.id).toBe(first.id);
      expect(second.annualAmount).toBe(90000);
      expect(second.notes).toBe('revised');

      const headers = (await sql`
        SELECT COUNT(*)::int AS n FROM accounting_budgets
        WHERE company_id = ${f.companyId}::uuid
          AND gl_account_id = ${f.expenseAccountId}::uuid
          AND fiscal_year = ${FY}
      `) as Array<{ n: number }>;
      expect(headers[0]!.n).toBe(1);
      const rows = await storedMonths(f.companyId, f.expenseAccountId);
      expect(rows).toHaveLength(second.months.length);
      expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBeCloseTo(90000, 2);
    });
  });

  it.skipIf(!reachable)('never returns another company\'s budget', async () => {
    await inRequestTx(async (f) => {
      const keys = await monthsOf(f.companyId, FY);
      await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 1000 }, f.userId,
      );
      // Rows planted directly for the other tenant, on its own account, bypassing the service.
      await sql`
        INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
        VALUES (${f.otherCompanyId}::uuid, (SELECT public.budget_version_original(${f.otherCompanyId}::uuid, fy.fiscal_year, 'test-fixture') FROM public.fiscal_year_for_date(${f.otherCompanyId}::uuid, ${`${keys[0]}-01`}::date) fy), ${f.otherAccountId}::uuid, ${`${keys[0]}-01`}::date, 999999)
      `;
      await sql`
        INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, notes)
        VALUES (${f.otherCompanyId}::uuid, ${'other tenant'}, ${FY}, ${f.otherAccountId}::uuid, ${'other tenant note'})
      `;

      const mine = await getBudgets(f.companyId, FY);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.glAccountId).toBe(f.expenseAccountId);
      expect(mine.some(b => b.annualAmount === 999999 || b.notes === 'other tenant note')).toBe(false);
    });
  });

  // A header planted for another tenant against MY account: the gl_accounts join
  // alone cannot exclude it, only the h.company_id predicate can. (A month row
  // cannot be planted that way: the same-company trigger refuses it, below.)
  it.skipIf(!reachable)('never returns a header planted against my account under another tenant', async () => {
    await inRequestTx(async (f) => {
      await sql`
        INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, notes)
        VALUES (${f.otherCompanyId}::uuid, ${'planted'}, ${FY}, ${f.expenseAccountId}::uuid, ${'planted note'})
      `;

      const mine = await getBudgets(f.companyId, FY);
      expect(mine.some(b => b.notes === 'planted note')).toBe(false);
      expect(mine).toHaveLength(0);
    });
  });

  it.skipIf(!reachable)('the table refuses a month row for an account of another company', async () => {
    await inRequestTx(async (f) => {
      const keys = await monthsOf(f.companyId, FY);
      await sql`SAVEPOINT planted`;
      await expect(sql`
        INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
        VALUES (${f.otherCompanyId}::uuid, (SELECT public.budget_version_original(${f.otherCompanyId}::uuid, fy.fiscal_year, 'test-fixture') FROM public.fiscal_year_for_date(${f.otherCompanyId}::uuid, ${`${keys[0]}-01`}::date) fy), ${f.expenseAccountId}::uuid, ${`${keys[0]}-01`}::date, 777777)
      `).rejects.toThrow(/does not belong to company/);
      await sql`ROLLBACK TO SAVEPOINT planted`;
    });
  });

  // 100000 / 12 does not divide, so the months only sum back to the annual if
  // the last one carries the remainder. 120000 cannot tell a correct spread from
  // one that drops the adjustment entirely.
  it.skipIf(!reachable)('spreads an indivisible annual so the months still sum to it', async () => {
    await inRequestTx(async (f) => {
      const entry = await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 100000 }, f.userId,
      );
      const n = entry.months.length;
      const monthly = Math.round((100000 / n) * 100) / 100;

      expect(entry.months.slice(0, n - 1).every(m => m.amount === monthly)).toBe(true);
      expect(entry.months[n - 1]!.amount).toBe(Math.round((100000 - monthly * (n - 1)) * 100) / 100);
      expect(entry.annualAmount).toBe(100000);
      const rows = await storedMonths(f.companyId, f.expenseAccountId);
      expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBeCloseTo(100000, 2);
    });
  });

  it.skipIf(!reachable)('copies a year forward by month position without duplicating on a re-run, and deletes', async () => {
    await inRequestTx(async (f) => {
      await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 24000, notes: 'carried' }, f.userId,
      );
      const copied = await copyBudgets(f.companyId, FY, FY + 1, f.userId);
      expect(copied).toBe(1);

      const next = await getBudgets(f.companyId, FY + 1);
      expect(next).toHaveLength(1);
      expect(next[0]!.notes).toBe('carried');
      expect(next[0]!.months.map(m => m.amount)).toEqual((await getBudgets(f.companyId, FY))[0]!.months.map(m => m.amount));

      // Re-running the copy must not create a second row for the same account or month.
      expect(await copyBudgets(f.companyId, FY, FY + 1, f.userId)).toBe(0);
      expect(await getBudgets(f.companyId, FY + 1)).toHaveLength(1);

      await deleteBudget(f.companyId, f.expenseAccountId, FY + 1, f.userId);
      expect(await getBudgets(f.companyId, FY + 1)).toHaveLength(0);
      expect(await getBudgets(f.companyId, FY)).toHaveLength(1);
    });
  });
});
