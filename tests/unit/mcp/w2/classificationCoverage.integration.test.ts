/**
 * How much of a P&L rests on a classification nobody made. DB-gated, read-only.
 *
 * `getIncomeStatement` and `aggregateFigures` both split expenses on
 * `account_subtype`, which is right — the audit's overstated gross profit came
 * from selecting cost of sales by account NAME. But a figure driven by subtype
 * is exactly as good as the subtypes, and on these books they barely exist:
 *
 *   Velocity Fibre   100% of revenue (R84,053,370.26) and 97.6% of expenses
 *                    (R115,984,525.05 of R118,869,595.15) sit on accounts whose
 *                    subtype is NULL or a `default_*` placeholder.
 *   Brightsphere     91.9% of revenue (R12,410,997.90 of R13,508,486.83).
 *
 * Velocity's classified cost of sales is R2,885,070.10, so its reported gross
 * profit of R29,305,100.49 is revenue less 2.4% of its costs. That figure is
 * not wrong in the sense of a bug — the code did what the chart of accounts
 * told it — and it is not a number any human should act on. Printing it without
 * that sentence beside it is the ten-row aged debtors again: a plausible figure
 * whose completeness cannot be established from the response.
 *
 * So the coverage is MANDATORY on `profit_and_loss`, at every detail level, and
 * nothing is excluded from any total. An unclassified expense is still an
 * expense.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getPoolForTests, sql } from '@/lib/neon';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getClassificationCoverage } from '@/modules/accounting/services/reports/classificationCoverageService';

type AlsCtx = Parameters<typeof als.run>[0];
const START = '2020-01-01';
const END = '2026-12-31';

async function withLedgerCompanies(run: (ids: string[]) => Promise<void>) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(
      { client, userId: 'test', companyId: 'bootstrap', claims: {} } as unknown as AlsCtx,
      async () => {
        const rows = (await sql`
          SELECT jl.company_id AS id, COUNT(*) AS n
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_type IN ('revenue', 'expense')
          GROUP BY jl.company_id
          ORDER BY COUNT(*) DESC
          LIMIT 3
        `) as Array<{ id: string }>;
        if (rows.length === 0) throw new Error('no company with posted P&L lines in isaflow_dev');
        await run(rows.map((r) => r.id));
      },
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('P&L classification coverage — real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('accounts for every rand: classified + unclassified = the total', async () => {
    await withLedgerCompanies(async (companyIds) => {
      for (const companyId of companyIds) {
        const coverage = await getClassificationCoverage(companyId, START, END);
        for (const side of [coverage.revenue, coverage.expense]) {
          expect(side.classifiedAmount + side.unclassifiedAmount).toBeCloseTo(side.totalAmount, 2);
          // The named accounts are a capped sample; the COUNT is complete.
          expect(side.unclassifiedAccountCount).toBeGreaterThanOrEqual(side.accounts.length);
        }
      }
    });
  }, 60000);

  it.skipIf(!reachable)('ties its totals to the income statement it describes', async () => {
    await withLedgerCompanies(async (companyIds) => {
      for (const companyId of companyIds) {
        const statement = await getIncomeStatement(companyId, START, END);
        const coverage = await getClassificationCoverage(companyId, START, END);
        // The coverage must describe THIS statement, not a differently filtered
        // population — otherwise its percentages are about some other report.
        //
        // EVERY band, not just the ones above the operating line: since the B75
        // convergence the statement reports other income and other expenses on
        // their own lines, and coverage still describes all revenue- and
        // expense-typed accounts. Comparing against `totalRevenue` alone made
        // this fail by exactly the other-income total the moment the split
        // landed — which is the test doing its job.
        expect(coverage.revenue.totalAmount).toBeCloseTo(
          statement.totalRevenue + statement.totalOtherIncome,
          2,
        );
        expect(coverage.expense.totalAmount).toBeCloseTo(
          statement.totalCostOfSales + statement.totalOperatingExpenses + statement.totalOtherExpenses,
          2,
        );
      }
    });
  }, 60000);

  it.skipIf(!reachable)('finds substantial unclassified value, and names the accounts', async () => {
    await withLedgerCompanies(async (companyIds) => {
      let sawUnclassified = false;
      for (const companyId of companyIds) {
        const coverage = await getClassificationCoverage(companyId, START, END);
        if (coverage.expense.unclassifiedAmount !== 0 || coverage.revenue.unclassifiedAmount !== 0) {
          sawUnclassified = true;
          for (const a of [...coverage.revenue.accounts, ...coverage.expense.accounts]) {
            expect(a.amount).not.toBe(0);
            expect(a.accountCode).not.toBe('');
            // Named so somebody can go and classify them. A percentage with no
            // accounts behind it is a complaint, not a finding.
            expect(a.accountId).toMatch(/^[0-9a-f-]{36}$/);
          }
        }
      }
      // Without this the case passes on a perfectly classified chart, which is
      // not the state of any production company here.
      expect(sawUnclassified).toBe(true);
    });
  }, 60000);

  it.skipIf(!reachable)('counts a NULL subtype and a default_* placeholder as the same thing', async () => {
    await withLedgerCompanies(async ([companyId]) => {
      const coverage = await getClassificationCoverage(companyId!, START, END);
      const raw = (await sql`
        SELECT COUNT(DISTINCT ga.id) AS n
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.company_id = ${companyId!}::UUID
          AND ga.account_type = 'expense'
          AND je.entry_date >= ${START}::DATE AND je.entry_date <= ${END}::DATE
          AND COALESCE(ga.account_subtype, '') IN ('', 'default_expense')
      `) as Array<{ n: string }>;
      // `default_expense` is a placeholder the importer writes, not a
      // classification. Counting it as classified would report Velocity as
      // better classified than it is.
      expect(coverage.expense.unclassifiedAccountCount).toBe(Number(raw[0]!.n));
    });
  }, 60000);

  it.skipIf(!reachable)('scopes to the company it was given', async () => {
    await withLedgerCompanies(async (companyIds) => {
      const answers = await Promise.all(
        companyIds.map(async (id) => (await getClassificationCoverage(id, START, END)).expense.totalAmount),
      );
      expect(new Set(answers).size).toBeGreaterThan(1);
    });
  }, 60000);
});
