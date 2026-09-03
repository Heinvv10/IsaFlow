/**
 * budget variance against a REAL ledger.
 *
 * The actual side of a variance is the half that can quietly lie. This test
 * posts a journal and sets a budget inside one transaction, then asserts the
 * variance the service reports — so the SQL, the sign convention and the
 * budget-window mapping are all exercised against the live schema rather than
 * against a mocked `sql` template that would accept a statement Postgres
 * rejects.
 *
 * It also pins the finding that matters more than any number here: an account
 * with real movement and no budget must appear as UNBUDGETED, not as a
 * zero-variance line. A report that silently drops unbudgeted spend reads as
 * "everything is on plan".
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
import { upsertBudget } from '@/modules/accounting/services/core/budgetService';
import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';

type AlsCtx = Parameters<typeof als.run>[0];
function alsCtx(client: unknown, companyId: string, userId: string): AlsCtx {
  return { client, userId, companyId, claims: {} } as unknown as AlsCtx;
}

interface Fixture {
  companyId: string;
  userId: string;
  expenseAccountId: string;
  expenseCode: string;
  otherExpenseId: string;
  otherExpenseCode: string;
  revenueAccountId: string;
  revenueCode: string;
  bankAccountId: string;
}

// FIXTURE INVARIANT — the fixture MUST keep a revenue account alongside the two
// expense accounts. Sign normalisation is this service's core claim, and while
// every test used an expense account, pointing the revenue branch at the expense
// expression changed no assertion: the mutation survived. Revenue must also be
// posted on the CREDIT side (postRevenueJournal), or the branch is never taken.
async function loadFixtureIds(): Promise<Fixture> {
  const rows = (await sql`
    SELECT bank.company_id,
           bank.id AS bank_account_id,
           e1.id AS e1_id, e1.account_code AS e1_code,
           e2.id AS e2_id, e2.account_code AS e2_code,
           r.id AS r_id, r.account_code AS r_code
    FROM gl_accounts bank
    JOIN gl_accounts e1 ON e1.company_id = bank.company_id AND e1.account_type = 'expense'
    JOIN gl_accounts e2 ON e2.company_id = bank.company_id AND e2.account_type = 'expense'
                        AND e2.id <> e1.id
    JOIN gl_accounts r ON r.company_id = bank.company_id AND r.account_type = 'revenue'
    WHERE bank.account_subtype = 'bank'
    ORDER BY bank.company_id, bank.account_code, e1.account_code, e2.account_code, r.account_code
    LIMIT 1
  `) as Array<Record<string, string>>;
  const row = rows[0];
  if (!row) throw new Error('no company in isaflow_dev has a bank account, two expense accounts and a revenue account');

  const users = (await sql`
    SELECT created_by FROM gl_journal_entries
    WHERE company_id = ${row.company_id}::uuid AND created_by IS NOT NULL LIMIT 1
  `) as Array<{ created_by: string }>;
  const userId = users[0]?.created_by;
  if (!userId) throw new Error('no existing journal author to borrow for the fixture');

  return {
    companyId: String(row.company_id),
    userId,
    expenseAccountId: String(row.e1_id),
    expenseCode: String(row.e1_code),
    otherExpenseId: String(row.e2_id),
    otherExpenseCode: String(row.e2_code),
    revenueAccountId: String(row.r_id),
    revenueCode: String(row.r_code),
    bankAccountId: String(row.bank_account_id),
  };
}

/**
 * A balanced posted journal on a given date. Posted directly rather than
 * through a posting service so the test states exactly what the ledger holds.
 */
async function postJournal(
  f: Fixture,
  entryDate: string,
  debitAccountId: string,
  amount: number,
): Promise<void> {
  const je = (await sql`
    INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
    VALUES (${f.companyId}::uuid, ${entryDate}::date, ${'budget variance fixture'}, ${'manual'}, ${'posted'}, ${f.userId})
    RETURNING id
  `) as Array<{ id: string }>;
  const id = String(je[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
    VALUES (${f.companyId}::uuid, ${id}::uuid, ${debitAccountId}::uuid, ${amount}, 0),
           (${f.companyId}::uuid, ${id}::uuid, ${f.bankAccountId}::uuid, 0, ${amount})
  `;
}

/** Revenue is earned on the CREDIT side: DR bank, CR the revenue account. */
async function postRevenueJournal(
  f: Fixture,
  entryDate: string,
  revenueAccountId: string,
  amount: number,
): Promise<void> {
  const je = (await sql`
    INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
    VALUES (${f.companyId}::uuid, ${entryDate}::date, ${'budget variance revenue fixture'}, ${'manual'}, ${'posted'}, ${f.userId})
    RETURNING id
  `) as Array<{ id: string }>;
  const id = String(je[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
    VALUES (${f.companyId}::uuid, ${id}::uuid, ${f.bankAccountId}::uuid, ${amount}, 0),
           (${f.companyId}::uuid, ${id}::uuid, ${revenueAccountId}::uuid, 0, ${amount})
  `;
}

async function inRequestTx(run: (f: Fixture) => Promise<void>): Promise<void> {
  assertNotProductionDb('This test posts journals and INSERTs budgets.');
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

const FY = 2031;
const START = '2031-03-01';
const END = '2032-02-29';

describe('getBudgetVariance against a real ledger', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('reports the real posted movement against the budgeted months', async () => {
    await inRequestTx(async (f) => {
      // R120,000 a year, evenly spread — R10,000 a month over twelve months.
      await upsertBudget(
        f.companyId,
        { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 120000 },
        f.userId,
      );
      await postJournal(f, '2031-04-15', f.expenseAccountId, 25000);
      await postJournal(f, '2032-01-10', f.expenseAccountId, 5000); // across the year boundary

      const result = await getBudgetVariance(f.companyId, START, END);
      const line = result.rows.find(r => r.account_code === f.expenseCode);
      expect(line).toBeDefined();
      expect(result.monthKeys).toHaveLength(12);
      expect(line!.budget_amount).toBeCloseTo(120000, 2);
      // Both journals fall inside the window; the January one is the one a
      // calendar-year month window would have dropped.
      expect(line!.actual_amount).toBeCloseTo(30000, 2);
      // Expense variance is positive when under budget.
      expect(line!.variance).toBeCloseTo(90000, 2);
      expect(line!.account_id).toBe(f.expenseAccountId);
      expect(result.postedThrough).toBe('2032-01-10');
    });
  });

  // The whole point of the sign normalisation is that "more is more" on both
  // sides: revenue is credit-less-debit, expenses debit-less-credit. Every
  // other test here uses an expense account, so swapping revenue to the expense
  // expression changed nothing and the mutation survived.
  it.skipIf(!reachable)('reports credited revenue as a positive actual, not a negative one', async () => {
    await inRequestTx(async (f) => {
      await upsertBudget(
        f.companyId, { glAccountId: f.revenueAccountId, fiscalYear: FY, annualAmount: 120000 }, f.userId,
      );
      await postRevenueJournal(f, '2031-04-15', f.revenueAccountId, 30000);

      const result = await getBudgetVariance(f.companyId, START, END);
      const line = result.rows.find(r => r.account_code === f.revenueCode);
      expect(line).toBeDefined();
      expect(line!.actual_amount).toBeCloseTo(30000, 2);
      expect(line!.actual_amount).toBeGreaterThan(0);
    });
  });

  // A debit to a revenue account is a reversal, and must reduce the actual —
  // proving the revenue branch really is credit-less-debit and not an absolute.
  it.skipIf(!reachable)('nets a debit against credited revenue', async () => {
    await inRequestTx(async (f) => {
      await upsertBudget(
        f.companyId, { glAccountId: f.revenueAccountId, fiscalYear: FY, annualAmount: 120000 }, f.userId,
      );
      await postRevenueJournal(f, '2031-04-15', f.revenueAccountId, 30000);
      await postJournal(f, '2031-05-20', f.revenueAccountId, 5000); // DR revenue = a reversal

      const result = await getBudgetVariance(f.companyId, START, END);
      const line = result.rows.find(r => r.account_code === f.revenueCode);
      expect(line!.actual_amount).toBeCloseTo(25000, 2);
    });
  });

  it.skipIf(!reachable)('excludes movement dated outside the window', async () => {
    await inRequestTx(async (f) => {
      await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 12000 }, f.userId,
      );
      await postJournal(f, '2032-03-01', f.expenseAccountId, 999999); // the day after END

      const result = await getBudgetVariance(f.companyId, START, END);
      const line = result.rows.find(r => r.account_code === f.expenseCode);
      expect(line!.actual_amount).toBe(0);
    });
  });

  it.skipIf(!reachable)('surfaces spend on an unbudgeted account instead of dropping it', async () => {
    await inRequestTx(async (f) => {
      await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 12000 }, f.userId,
      );
      await postJournal(f, '2031-06-01', f.otherExpenseId, 44000);

      const result = await getBudgetVariance(f.companyId, START, END);
      expect(result.rows.map(r => r.account_code)).toContain(f.expenseCode);
      expect(result.rows.map(r => r.account_code)).not.toContain(f.otherExpenseCode);

      const orphan = result.unbudgeted.find(r => r.account_code === f.otherExpenseCode);
      expect(orphan).toBeDefined();
      expect(orphan!.actual_amount).toBeCloseTo(44000, 2);
      expect(result.unbudgetedMovement).toBeGreaterThanOrEqual(44000);
      // The completeness identity the envelope will check.
      expect(result.universeTotal).toBe(result.rows.length + result.unbudgeted.length);
    });
  });

  it.skipIf(!reachable)('ignores a draft journal', async () => {
    await inRequestTx(async (f) => {
      await upsertBudget(
        f.companyId, { glAccountId: f.expenseAccountId, fiscalYear: FY, annualAmount: 12000 }, f.userId,
      );
      const je = (await sql`
        INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
        VALUES (${f.companyId}::uuid, ${'2031-05-01'}::date, ${'draft'}, ${'manual'}, ${'draft'}, ${f.userId})
        RETURNING id
      `) as Array<{ id: string }>;
      await sql`
        INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
        VALUES (${f.companyId}::uuid, ${String(je[0]!.id)}::uuid, ${f.expenseAccountId}::uuid, 7777, 0)
      `;

      const result = await getBudgetVariance(f.companyId, START, END);
      const line = result.rows.find(r => r.account_code === f.expenseCode);
      expect(line!.actual_amount).toBe(0);
    });
  });
});
