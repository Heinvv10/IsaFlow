/**
 * Fixtures for tests/unit/services/budgetServiceDb.test.ts: two distinct
 * companies borrowed from the connected database, a request-shaped
 * BEGIN ... ROLLBACK, and the readers that show what Postgres stored.
 */
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { requireFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { budgetMonthKeysInWindow } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

type AlsCtx = Parameters<typeof als.run>[0];
function alsCtx(client: unknown, companyId: string, userId: string): AlsCtx {
  return { client, userId, companyId, claims: {} } as unknown as AlsCtx;
}

export interface Fixture {
  companyId: string;
  otherCompanyId: string;
  userId: string;
  expenseAccountId: string;
  revenueAccountId: string;
  otherAccountId: string;
}

/** Two distinct companies, so the tenant scope of every read can be proved. */
async function loadFixtureIds(): Promise<Fixture> {
  const rows = (await sql`
    SELECT expense.company_id,
           expense.id AS expense_account_id,
           revenue.id AS revenue_account_id
    FROM gl_accounts expense
    JOIN gl_accounts revenue
      ON revenue.company_id = expense.company_id AND revenue.account_type = 'revenue'
    WHERE expense.account_type = 'expense'
      -- Budgets go on active leaf accounts only (decision 18): a header or inactive pick is refused.
      AND expense.is_active AND revenue.is_active
      AND NOT EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_account_id = expense.id)
      AND NOT EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_account_id = revenue.id)
    ORDER BY expense.company_id, expense.account_code, revenue.account_code
    LIMIT 1
  `) as Array<{ company_id: string; expense_account_id: string; revenue_account_id: string }>;
  const row = rows[0];
  if (!row) throw new Error('no company in isaflow_dev has both an expense and a revenue account');

  const others = (await sql`
    SELECT company_id, id AS account_id FROM gl_accounts
    WHERE company_id <> ${row.company_id}::uuid AND account_type = 'expense'
    ORDER BY company_id, account_code
    LIMIT 1
  `) as Array<{ company_id: string; account_id: string }>;
  const other = others[0];
  if (!other) throw new Error('need a second company with an expense account');

  const users = (await sql`
    SELECT e.created_by FROM gl_journal_entries e
    JOIN users u ON u.id = e.created_by::text
    WHERE e.company_id = ${row.company_id}::uuid AND e.created_by IS NOT NULL
    LIMIT 1
  `) as Array<{ created_by: string }>;
  const userId = users[0]?.created_by;
  if (!userId) throw new Error('no existing journal author who is a user to borrow for the fixture (budget writes are audited)');

  return {
    companyId: row.company_id,
    otherCompanyId: other.company_id,
    userId,
    expenseAccountId: row.expense_account_id,
    revenueAccountId: row.revenue_account_id,
    otherAccountId: other.account_id,
  };
}

// FIXTURE INVARIANTS — the assertions below can only fail if these hold:
//  · TWO distinct companies, so a header can be planted under `otherCompanyId`
//    while pointing at THIS company's `expenseAccountId`. A fixture with one
//    company, or with the planted row on the other company's own account, is
//    excluded by the gl_accounts join for an unrelated reason and proves nothing.
//  · An annual amount that does NOT divide by the year's month count (100000,
//    not 120000), or a correct even spread is indistinguishable from one that
//    drops the last month's remainder entirely.
/** BEGIN → run → ROLLBACK on an ALS-bound client, exactly as withAuth does. */
export async function inRequestTx(run: (f: Fixture) => Promise<void>): Promise<void> {
  assertNotProductionDb('This test INSERTs into budget_month_amounts.');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(alsCtx(client, 'bootstrap', 'bootstrap'), async () => {
      const f = await loadFixtureIds();
      await als.run(alsCtx(client, f.companyId, f.userId), () => run(f));
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** The stored month rows exactly as Postgres holds them: the shape the read path depends on. */
export async function storedMonths(companyId: string, accountId: string): Promise<Array<{ month: string; amount: string }>> {
  return (await sql`
    SELECT TO_CHAR(month, 'YYYY-MM-DD') AS month, amount::text AS amount FROM budget_month_amounts
    WHERE company_id = ${companyId}::uuid AND gl_account_id = ${accountId}::uuid ORDER BY month
  `) as Array<{ month: string; amount: string }>;
}

/** The year's 'YYYY-MM' months, from the registry. */
export async function monthsOf(companyId: string, label: number): Promise<string[]> {
  const year = await requireFiscalYear(companyId, label);
  return budgetMonthKeysInWindow(year.startDate, year.endDate);
}

export const FY = 2031; // far enough out that no fixture data collides
