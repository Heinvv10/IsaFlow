/**
 * accounting_budgets against a REAL database.
 *
 * The previous budgetService had never executed. It INSERTed twelve month
 * columns (jan..dec) that do not exist on the table, omitted both NOT NULL
 * columns (company_id, budget_name), and its ON CONFLICT named a constraint
 * that was never created. `accounting_budgets` has 0 rows in production.
 *
 * A test that mocks the `sql` template would have asserted the shape of a
 * statement Postgres rejects outright, so every assertion here runs against
 * the live schema inside BEGIN … ROLLBACK on an ALS-bound client.
 *
 * The storage shape is fixed by the READ path
 * (pages/api/accounting/reports-budget-vs-actual.ts): months live in
 * `period_amounts` JSONB keyed 'jan'..'dec'. If the write path stores
 * anything else, budget-vs-actual reports R0.00 budget forever.
 *
 * DB-gated: skips (never fails) when no DB is reachable.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import {
  getBudgets,
  upsertBudget,
  deleteBudget,
  copyBudgets,
} from '@/modules/accounting/services/core/budgetService';

type AlsCtx = Parameters<typeof als.run>[0];
function alsCtx(client: unknown, companyId: string, userId: string): AlsCtx {
  return { client, userId, companyId, claims: {} } as unknown as AlsCtx;
}

interface Fixture {
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
    SELECT created_by FROM gl_journal_entries
    WHERE company_id = ${row.company_id}::uuid AND created_by IS NOT NULL
    LIMIT 1
  `) as Array<{ created_by: string }>;
  const userId = users[0]?.created_by;
  if (!userId) throw new Error('no existing journal author to borrow for the fixture');

  return {
    companyId: row.company_id,
    otherCompanyId: other.company_id,
    userId,
    expenseAccountId: row.expense_account_id,
    revenueAccountId: row.revenue_account_id,
    otherAccountId: other.account_id,
  };
}

/** BEGIN → run → ROLLBACK on an ALS-bound client, exactly as withAuth does. */
async function inRequestTx(run: (f: Fixture) => Promise<void>): Promise<void> {
  assertNotProductionDb('This test INSERTs into accounting_budgets.');
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

/** The row exactly as Postgres holds it — the shape the read path depends on. */
interface StoredBudgetRow {
  company_id: string;
  budget_name: string;
  fiscal_year: number;
  gl_account_id: string;
  period_amounts: Record<string, number>;
  annual_amount: string;
  total_amount: string;
  created_by: string | null;
}

async function storedRow(id: string): Promise<StoredBudgetRow> {
  const rows = (await sql`
    SELECT company_id, budget_name, fiscal_year, gl_account_id, period_amounts,
           annual_amount::text AS annual_amount, total_amount::text AS total_amount, created_by
    FROM accounting_budgets WHERE id = ${id}::uuid
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw new Error(`no accounting_budgets row ${id}`);
  return row as unknown as StoredBudgetRow;
}

const FY = 2031; // far enough out that no fixture data collides

describe('budgetService against the real accounting_budgets table', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('writes a row Postgres accepts, in the shape the read path reads', async () => {
    await inRequestTx(async (f) => {
      const entry = await upsertBudget(
        f.companyId,
        { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 120000, notes: 'even spread' },
        f.userId,
      );

      expect(entry.glAccountId).toBe(f.expenseAccountId);
      expect(entry.fiscalYear).toBe(FY);
      expect(entry.annualAmount).toBe(120000);
      expect(entry.months).toHaveLength(12);
      expect(entry.months.reduce((s, m) => s + m, 0)).toBeCloseTo(120000, 2);
      expect(entry.accountCode).not.toBe('');

      const row = await storedRow(entry.id);
      expect(row.company_id).toBe(f.companyId);
      expect(row.budget_name).toBeTruthy();
      expect(row.fiscal_year).toBe(FY);
      expect(row.annual_amount).toBe('120000.00');
      expect(row.total_amount).toBe('120000.00');
      // The read path sums period_amounts by month NAME. Anything else is R0.00.
      expect(Object.keys(row.period_amounts).sort())
        .toEqual(['apr','aug','dec','feb','jan','jul','jun','mar','may','nov','oct','sep']);
      expect(Number(row.period_amounts.jan)).toBeCloseTo(10000, 2);
      const monthSum = Object.values(row.period_amounts).reduce((s, v) => s + Number(v), 0);
      expect(monthSum).toBeCloseTo(120000, 2);
    });
  });

  it.skipIf(!reachable)('honours an explicit month split rather than spreading evenly', async () => {
    await inRequestTx(async (f) => {
      const months = [1000, 2000, 3000, 0, 0, 0, 0, 0, 0, 0, 0, 4000];
      const entry = await upsertBudget(
        f.companyId,
        { glAccountId: f.revenueAccountId, fiscalYear: FY, annualAmount: 10000, months },
        f.userId,
      );
      expect(entry.months).toEqual(months);
      const row = await storedRow(entry.id);
      expect(Number(row.period_amounts.mar)).toBeCloseTo(3000, 2);
      expect(Number(row.period_amounts.apr)).toBeCloseTo(0, 2);
      expect(Number(row.period_amounts.dec)).toBeCloseTo(4000, 2);
    });
  });

  it.skipIf(!reachable)('upserts on the second write instead of duplicating the account', async () => {
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

      const rows = (await sql`
        SELECT COUNT(*)::int AS n FROM accounting_budgets
        WHERE company_id = ${f.companyId}::uuid
          AND gl_account_id = ${f.expenseAccountId}::uuid
          AND fiscal_year = ${FY}
      `) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);

      const row = await storedRow(second.id);
      expect(row.annual_amount).toBe('90000.00');
      expect(Number(row.period_amounts.jan)).toBeCloseTo(7500, 2);
    });
  });

  it.skipIf(!reachable)('never returns another company\'s budget', async () => {
    await inRequestTx(async (f) => {
      await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 1000 }, f.userId,
      );
      // A row planted directly for the other tenant, bypassing the service.
      await sql`
        INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, annual_amount, total_amount)
        VALUES (${f.otherCompanyId}::uuid, ${'other tenant'}, ${FY}, ${f.otherAccountId}::uuid, 999999, 999999)
      `;

      const mine = await getBudgets(f.companyId, FY);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.glAccountId).toBe(f.expenseAccountId);
      expect(mine.some(b => b.annualAmount === 999999)).toBe(false);
    });
  });

  // A row whose company_id is another tenant's but whose gl_account_id is MINE.
  // The gl_accounts join alone cannot exclude this — only the b.company_id
  // predicate can. Without it the previous test still passed, so it proved
  // nothing about tenant scope on accounting_budgets itself.
  it.skipIf(!reachable)('never returns a row planted against my account under another tenant', async () => {
    await inRequestTx(async (f) => {
      await sql`
        INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, annual_amount, total_amount)
        VALUES (${f.otherCompanyId}::uuid, ${'planted'}, ${FY}, ${f.expenseAccountId}::uuid, 777777, 777777)
      `;

      const mine = await getBudgets(f.companyId, FY);
      expect(mine.some(b => b.annualAmount === 777777)).toBe(false);
      expect(mine).toHaveLength(0);
    });
  });

  // 100000 / 12 does not divide, so the twelve months only sum back to the
  // annual if December carries the remainder. An annual of 120000 cannot tell
  // a correct spread from one that drops the adjustment entirely.
  it.skipIf(!reachable)('spreads an indivisible annual so the twelve months still sum to it', async () => {
    await inRequestTx(async (f) => {
      const entry = await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 100000 }, f.userId,
      );

      expect(entry.months.slice(0, 11)).toEqual(Array<number>(11).fill(8333.33));
      expect(entry.months[11]).toBe(8333.37);
      expect(entry.months.reduce((s, m) => s + m, 0)).toBeCloseTo(100000, 2);

      const row = await storedRow(entry.id);
      const stored = Object.values(row.period_amounts).reduce((s, v) => s + Number(v), 0);
      expect(stored).toBeCloseTo(100000, 2);
      expect(row.total_amount).toBe('100000.00');
    });
  });

  it.skipIf(!reachable)('copies a year forward without duplicating on a re-run, and deletes', async () => {
    await inRequestTx(async (f) => {
      await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 24000 }, f.userId,
      );
      const copied = await copyBudgets(f.companyId, FY, FY + 1, f.userId);
      expect(copied).toBe(1);

      const next = await getBudgets(f.companyId, FY + 1);
      expect(next).toHaveLength(1);
      expect(next[0]!.annualAmount).toBe(24000);
      expect(next[0]!.months.reduce((s, m) => s + m, 0)).toBeCloseTo(24000, 2);

      // Re-running the copy must not create a second row for the same account.
      await copyBudgets(f.companyId, FY, FY + 1, f.userId);
      expect(await getBudgets(f.companyId, FY + 1)).toHaveLength(1);

      await deleteBudget(f.companyId, next[0]!.id);
      expect(await getBudgets(f.companyId, FY + 1)).toHaveLength(0);
    });
  });
});
