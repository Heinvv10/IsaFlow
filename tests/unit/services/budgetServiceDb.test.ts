/**
 * The budget READER against a REAL database: amounts are stored per calendar month in
 * `budget_month_amounts` (migration 944), `accounting_budgets` is only the per-year header that
 * carries the notes. Tenant scope of `getBudgets`, and the table's own same-company refusal.
 * (The legacy writers this file also covered were removed in budgets P2 PR-D; the grid save's
 * writes are budget-grid-save*.int.)
 *
 * Every assertion runs against the live schema inside BEGIN ... ROLLBACK on an ALS-bound client.
 *
 * DB-gated: skips (never fails) when no DB is reachable.
 */
import { describe, it, expect, vi } from 'vitest';
import { isDbReachable } from '../helpers/dbReachable';
import { FY, inRequestTx, monthsOf } from '../helpers/budgetServiceDbFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getBudgets } from '@/modules/accounting/services/core/budgetService';

describe('budgetService against the real budget_month_amounts table', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('never returns another company\'s budget', async () => {
    await inRequestTx(async (f) => {
      const keys = await monthsOf(f.companyId, FY);
      // My budget on my primary, as the grid save stores it. budget_version_original makes the year's
      // primary when it has none: an APPROVED 'Original', as migration 947 converted legacy budgets.
      await sql`
        INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, created_by)
        VALUES (${f.companyId}::uuid, (SELECT public.budget_version_original(${f.companyId}::uuid, ${FY}, ${f.userId})), ${f.expenseAccountId}::uuid, ${`${keys[0]}-01`}::date, 1000, ${f.userId})
      `;
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
});
