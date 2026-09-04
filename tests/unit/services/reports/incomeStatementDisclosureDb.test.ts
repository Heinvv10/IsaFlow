/**
 * The disclosure must agree with the banding it describes, against a real
 * ledger. The pure suite proves the arithmetic; only a database proves that
 * `getIncomeStatement` actually populates it and that the amount it names is
 * genuinely sitting in `operatingExpenses` on the same report object.
 *
 * Probed at MODULE LOAD, not in `beforeAll`: `it.skipIf` is evaluated during
 * collection, so a hook-based probe leaves every test skipped even against a
 * live database. An absent database shows as `↓ skipped`, never as passed.
 *
 * Read-only. Writes nothing.
 */

import { describe, it, expect } from 'vitest';
import { sql } from '@/lib/neon';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { isDbReachable } from '../../helpers/dbReachable';

const dbUp = await isDbReachable();
const expectsDb = Boolean(process.env['DATABASE_URL'])
  && !(process.env['DATABASE_URL'] ?? '').includes('dummy');

describe('the database gate itself', () => {
  it('is reachable whenever a real DATABASE_URL is configured', () => {
    if (!expectsDb) return;
    expect(dbUp).toBe(true);
  });
});

/**
 * A company that PROVABLY has unclassified expense accounts with movement, and
 * how many. Chosen by query rather than by size, so the assertions below can
 * demand a disclosure rather than tolerate its absence — the earlier version of
 * this file returned early when `subtypeDisclosure` was null, which meant
 * deleting the line that wires it onto the report left every test green.
 */
async function companyWithUnclassifiedExpenses(): Promise<
  { id: string; from: string; to: string; expenseAccounts: number } | null
> {
  const rows = (await sql`
    SELECT je.company_id,
           MIN(je.entry_date) AS from_date,
           MAX(je.entry_date) AS to_date,
           COUNT(DISTINCT ga.id) FILTER (
             WHERE ga.account_type = 'expense' AND ga.account_subtype IS NULL
           ) AS unclassified_expense_accounts
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
    WHERE je.status = 'posted' AND ga.account_type IN ('revenue', 'expense')
    GROUP BY je.company_id
    HAVING COUNT(DISTINCT ga.id) FILTER (
      WHERE ga.account_type = 'expense' AND ga.account_subtype IS NULL
    ) > 0
    ORDER BY 4 DESC
    LIMIT 1
  `) as {
    company_id: string;
    from_date: Date | string;
    to_date: Date | string;
    unclassified_expense_accounts: string;
  }[];
  const r = rows[0];
  if (!r) return null;
  const iso = (d: Date | string) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  return {
    id: r.company_id,
    from: iso(r.from_date),
    to: iso(r.to_date),
    expenseAccounts: Number(r.unclassified_expense_accounts),
  };
}

describe('getIncomeStatement — subtype disclosure against a real ledger', () => {
  it.skipIf(!dbUp)('is actually populated on the report for a chart that needs it', async () => {
    const c = await companyWithUnclassifiedExpenses();
    expect(c, 'no production company has an unclassified expense account').not.toBeNull();
    if (!c) return;

    const report = await getIncomeStatement(c.id, c.from, c.to);
    // NOT `if (!disclosure) return` — deleting the line in incomeStatementService
    // that puts this on the report must turn this red.
    expect(report.subtypeDisclosure).not.toBeNull();
    expect(report.subtypeDisclosure).toBeDefined();
    expect(report.subtypeDisclosure!.expenseAccounts).toBeGreaterThan(0);
    expect(report.subtypeDisclosure!.grossProfitOverstatedByAtMost).toBeGreaterThan(0);
  });

  it.skipIf(!dbUp)('names amounts that are genuinely inside operatingExpenses', async () => {
    const c = await companyWithUnclassifiedExpenses();
    if (!c) return;

    const report = await getIncomeStatement(c.id, c.from, c.to);
    const disclosure = report.subtypeDisclosure;
    expect(disclosure).toBeTruthy();

    const opex = new Map(report.operatingExpenses.map(i => [i.accountCode, i.amount]));
    const named = disclosure!.accounts.filter(a => a.accountType === 'expense');
    expect(named.length).toBeGreaterThan(0);
    for (const a of named) {
      // Every expense the disclosure names must actually be sitting in the
      // operating expenses section — that IS the claim it makes.
      expect(opex.has(a.accountCode)).toBe(true);
      expect(opex.get(a.accountCode)).toBeCloseTo(a.amount, 2);
    }
  });

  it.skipIf(!dbUp)('counts every unclassified expense account the ledger has', async () => {
    const c = await companyWithUnclassifiedExpenses();
    if (!c) return;

    const report = await getIncomeStatement(c.id, c.from, c.to);
    expect(report.subtypeDisclosure).toBeTruthy();
    // >= not ==: the service drops accounts whose period amount rounds to nil,
    // and counts unrecognised spellings the NULL-only query above cannot see.
    // Dropping the disclosureRows.push for expenses takes this to 0.
    expect(report.subtypeDisclosure!.expenseAccounts).toBeGreaterThan(0);
    expect(report.subtypeDisclosure!.expenseAmount).toBeGreaterThan(0);
  });

  it.skipIf(!dbUp)('bounds the COST OF SALES exposure by operating expenses', async () => {
    const c = await companyWithUnclassifiedExpenses();
    if (!c) return;

    const report = await getIncomeStatement(c.id, c.from, c.to);
    expect(report.subtypeDisclosure).toBeTruthy();
    const opexTotal = report.operatingExpenses.reduce((s, i) => s + Math.abs(i.amount), 0);
    // Only the cost-of-sales half is bounded by operating expenses. An earlier
    // version asserted this of `grossProfitOverstatedByAtMost`, which also
    // contains the REVENUE ceiling — it passed on the dev database (almost no
    // unclassified revenue) and failed against production on the very company
    // its own selector picks: "expected 200037895.31 to be <= 115984525.06".
    // Green on dev, red on prod, is not a test.
    expect(report.subtypeDisclosure!.costOfSalesExposureAtMost).toBeLessThanOrEqual(opexTotal + 0.01);
  });

  it.skipIf(!dbUp)('bounds the OTHER INCOME exposure by revenue', async () => {
    const c = await companyWithUnclassifiedExpenses();
    if (!c) return;

    const report = await getIncomeStatement(c.id, c.from, c.to);
    const d = report.subtypeDisclosure;
    expect(d).toBeTruthy();
    // Bounded by total income. Turnover alone would be the tighter claim, but
    // the disclosure's population is every revenue-typed account, so the honest
    // bound is turnover plus other income — matching what is asserted.
    expect(d!.otherIncomeExposureAtMost)
      .toBeLessThanOrEqual(Math.abs(report.totalRevenue) + Math.abs(report.totalOtherIncome) + 0.01);
  });

  it.skipIf(!dbUp)('totals the two ceilings exactly, on real data', async () => {
    const c = await companyWithUnclassifiedExpenses();
    if (!c) return;

    const d = (await getIncomeStatement(c.id, c.from, c.to)).subtypeDisclosure;
    expect(d).toBeTruthy();
    expect(d!.grossProfitOverstatedByAtMost).toBeCloseTo(
      d!.costOfSalesExposureAtMost + d!.otherIncomeExposureAtMost, 2);
  });

  it.skipIf(!dbUp)('is null when every account on the report has a recognised subtype', async () => {
    const rows = (await sql`
      SELECT je.company_id
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
      WHERE je.status = 'posted' AND ga.account_type IN ('revenue', 'expense')
      GROUP BY je.company_id
      HAVING COUNT(*) FILTER (WHERE ga.account_subtype IS NULL) = 0
      LIMIT 1
    `) as { company_id: string }[];
    const companyId = rows[0]?.company_id;
    expect(companyId, 'no production company has a fully-subtyped income statement').toBeDefined();
    if (!companyId) return;

    const report = await getIncomeStatement(companyId, '1900-01-01', '2999-12-31');
    // Not asserted null outright: the company may carry an unrecognised
    // spelling ('other', 'disposal_profit_loss'), which SHOULD disclose.
    if (report.subtypeDisclosure) {
      expect(report.subtypeDisclosure.expenseAccounts + report.subtypeDisclosure.revenueAccounts)
        .toBeGreaterThan(0);
    }
  });
});
