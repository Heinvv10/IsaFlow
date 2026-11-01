/**
 * Budgets P3 PR-C, on real PostgreSQL: `getBudgetVariance` is a facade over the
 * tracking engine, and with no options its result is DEEP-EQUAL (strictly: no
 * added field) to the pre-facade (P0 + P1) service for the same ledger, on every
 * window, multi-year and partly budgeted ones included (P0 sums the budgeted
 * months). The oracle below is P0's own SQL, verbatim from the merge-base's
 * `reports/budgetWindowActuals.ts` (`loadWindowActuals`) and
 * `reports/budgetWindowService.ts` (`loadWindowBudgets` with the primary scope),
 * composed exactly as the old `getBudgetVariance` did.
 *
 * `partialWindow: 'absent'` (the statement comparator's opt-in) applies the
 * engine's rule instead, pinned below: a year in the window with no budget in
 * it, or a line budgeted for only part of the window, keeps its actual, carries
 * no budget, and is in neither `rows` nor `unbudgeted`.
 *
 * Seed: helpers/budgetTrackingFixture.ts, plus per-test rows written inside the
 * request's transaction (always rolled back). Fixture route: isaflow_schema_fixture
 * (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { round2 } from '@/modules/accounting/services/core/budgetMonths';
import { primaryVersionScopeAndYears } from '@/modules/accounting/services/budgets/budgetVersionScope';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { fiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { budgetMonthBounds, budgetMonthKeysInWindow } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import { buildBudgetVsActualLines, type RawActualRow } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { buildBudgetVsActualSections } from '@/modules/accounting/services/reports/budgetVsActualSections';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import { getBudgetVariance, type BudgetVarianceResult, type BudgetVarianceTrackedResult } from '@/modules/accounting/services/reports/budgetVarianceService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

// ── The oracle: P0 + P1, verbatim ────────────────────────────────────────────

async function oracleActuals(companyId: string, startDate: string, endDate: string): Promise<RawActualRow[]> {
  return (await sql`
    SELECT ga.id, ga.account_code, ga.account_name, ga.account_type,
           COALESCE(
             CASE WHEN ga.account_type = 'revenue' THEN b.credit_less_debit
                  ELSE b.debit_less_credit END
           , 0)::numeric AS actual_amount
    FROM gl_accounts ga
    LEFT JOIN (
      SELECT jl.gl_account_id,
             SUM(jl.debit - jl.credit) AS debit_less_credit,
             SUM(jl.credit - jl.debit) AS credit_less_debit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.entry_date >= ${startDate}
        AND je.entry_date <= ${endDate}
      GROUP BY jl.gl_account_id
    ) b ON b.gl_account_id = ga.id
    WHERE ga.company_id = ${companyId}::UUID
      AND ga.account_type IN ('expense', 'revenue')
    ORDER BY ga.account_code
  `) as RawActualRow[];
}

async function oracleBudgets(companyId: string, startDate: string, endDate: string): Promise<Record<string, number>> {
  const bounds = budgetMonthBounds(startDate, endDate);
  if (!bounds) return {};
  const scope = (await primaryVersionScopeAndYears(companyId, startDate, endDate)).scope
    .filter((s): s is typeof s & { versionId: string } => s.versionId !== null);
  if (scope.length === 0) return {};
  const rows = (await sql`
    SELECT bm.gl_account_id, SUM(bm.amount)::numeric AS total
    FROM budget_month_amounts bm
    JOIN unnest(${scope.map((s) => s.versionId)}::UUID[], ${scope.map((s) => s.first)}::DATE[], ${scope.map((s) => s.last)}::DATE[])
      AS sc(version_id, first_month, last_month)
      ON bm.version_id = sc.version_id AND bm.month >= sc.first_month AND bm.month <= sc.last_month
    JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE bm.company_id = ${companyId}::UUID
    GROUP BY bm.gl_account_id
  `) as Array<{ gl_account_id: string; total: string | number }>;
  const budgets: Record<string, number> = {};
  for (const row of rows) budgets[String(row.gl_account_id)] = round2(Number(row.total));
  return budgets;
}

async function oracle(companyId: string, periodStart: string, periodEnd: string): Promise<BudgetVarianceResult> {
  const monthKeys = budgetMonthKeysInWindow(periodStart, periodEnd);
  const fiscalYear = (await fiscalYearForDate(companyId, periodStart)).fiscalYear;
  const budgets = await oracleBudgets(companyId, periodStart, periodEnd);
  const actuals = await oracleActuals(companyId, periodStart, periodEnd);
  const postedRows = (await sql`
    SELECT MAX(je.entry_date)::text AS posted_through
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
  `) as Array<{ posted_through: string | null }>;
  const lines = buildBudgetVsActualLines(actuals, budgets);
  const rows = lines.filter((l) => l.budgeted);
  const unbudgeted = lines.filter((l) => !l.budgeted);
  const sections = buildBudgetVsActualSections(lines);
  return {
    fiscalYear, monthKeys, lines, rows, unbudgeted, sections,
    universeTotal: lines.length,
    totals: { budget: sections.net_profit.budget, actual: sections.net_profit.actual, variance: sections.net_profit.variance },
    unbudgetedMovement: round2(unbudgeted.reduce((s, l) => s + Math.abs(l.actual_amount), 0)),
    postedThrough: postedRows[0]?.posted_through ?? null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type Before = (c: PoolClient) => Promise<unknown>;

/** The facade and the oracle on ONE request transaction, after `before` (rolled back with it). */
const both = (start: string, end: string, before?: Before) => asRequest(pool, f.a, f.userA, async () => ({
  facade: await getBudgetVariance(f.a, start, end),
  absent: await getBudgetVariance(f.a, start, end, { partialWindow: 'absent' }),
  oracle: await oracle(f.a, start, end),
}), before ? { before } : {});

/** A dormant expense account budgeted at exactly 0 for one FY2027 month: P0 keeps it as a budgeted row. */
const zeroBudget: Before = async (c) => {
  await c.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
                 VALUES ('00000000-0000-4000-8000-00000000b650', $1, 'BT-6500', 'Dormant, budgeted 0', 'expense', 'debit', 3, true)`, [f.a]);
  await c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
                 VALUES ($1, $2, '00000000-0000-4000-8000-00000000b650', '2026-06-01', 0)`, [f.a, f.v.primary27]);
};

/** FY2028 budgets for every FY2027-budgeted account in May 2027, so a window across the two is budgeted in full. */
const fullyBudgeted28: Before = async (c) => {
  for (const [acct, amount] of [[f.acc.sales, 160], [f.acc.cos, 71], [f.acc.interest, 6], [f.acc.fin, 8]] as const) {
    await c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
                   VALUES ($1, $2, $3, '2027-05-01', $4)`, [f.a, f.v.primary28, acct, amount]);
  }
};

// ── Parity ───────────────────────────────────────────────────────────────────

describe('no options: deep-equal to the P0 + P1 oracle', () => {
  it.each([
    ['FY2027 whole (14 months)', '2026-03-01', '2027-04-30'],
    ['day-level edges inside FY2027 (the 15th journal left out)', '2026-03-16', '2026-10-29'],
    ['one day, the inclusive month-end journal', '2026-04-30', '2026-04-30'],
    ['a quarter', '2026-06-01', '2026-08-31'],
    ['FY2028 to date: opex budgeted, the rest unbudgeted', '2027-05-01', '2027-07-31'],
    ['FY2026, no version: every movement unbudgeted', '2026-01-01', '2026-02-28'],
    ['before the ledger: nothing', '2025-06-01', '2025-12-31'],
    ['an inverted range', '2026-10-31', '2026-10-01'],
    ['across FY2026 (no version) and FY2027: the budgeted months summed', '2026-01-01', '2026-06-30'],
    ['across FY2027 and FY2028: lines budgeted in FY2027 only summed', '2027-04-01', '2027-05-31'],
    ['across three years, FY2026 .. FY2028', '2026-02-15', '2027-06-15'],
  ])('%s (%s .. %s)', async (_name, start, end) => {
    const { facade, oracle: want } = await both(start, end);
    expect(facade).toStrictEqual(want);
  });

  it('a budgeted zero with no actuals stays a budgeted row (the P0 keep rule)', async () => {
    const { facade, oracle: want } = await both('2026-06-01', '2026-06-30', zeroBudget);
    const zero = want.rows.find((l) => l.account_code === 'BT-6500');
    expect(zero).toMatchObject({ budgeted: true, budget_amount: 0, actual_amount: 0, variance_pct: null });
    expect(facade).toStrictEqual(want);
  });

  it('a window across FY2027 and FY2028, budgeted in full in both, mid-month at both ends', async () => {
    const { facade, oracle: want } = await both('2027-04-10', '2027-05-20', fullyBudgeted28);
    expect(want.rows.length).toBe(5);
    expect(facade).toStrictEqual(want);
  });

  it('a registry year that starts mid-month is read as P1 scopes it (a shared month counts in the earlier year), not refused', async () => {
    const midMonth: Before = async (c) => {
      // FY2028 shrinks first, so the two years never overlap (fiscal_years_no_overlap).
      await c.query(`UPDATE fiscal_years SET start_date = '2027-05-15' WHERE company_id = $1 AND fiscal_year = 2028`, [f.a]);
      await c.query(`UPDATE fiscal_years SET end_date = '2027-05-14' WHERE company_id = $1 AND fiscal_year = 2027`, [f.a]);
    };
    const { facade, oracle: want } = await both('2027-04-01', '2027-05-31', midMonth);
    expect(want.rows.length).toBeGreaterThan(0);
    expect(facade).toStrictEqual(want);
    // The Budget vs Actual page's own windows still refuse that registry (409): only the range entry reads it.
    const page = asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'custom', from: '2027-04', to: '2027-05' }), { before: midMonth });
    await expect(page).rejects.toMatchObject({ name: 'TrackingError', status: 409 });
  });

  it('adds no field: the result has exactly P0\'s keys, and no line carries budget_partial', async () => {
    const { facade } = await both('2027-04-01', '2027-05-31');
    expect(Object.keys(facade).sort()).toEqual(['fiscalYear', 'lines', 'monthKeys', 'postedThrough', 'rows', 'sections', 'totals',
      'unbudgeted', 'unbudgetedMovement', 'universeTotal']);
    expect(facade.lines.some((l) => 'budget_partial' in l)).toBe(false);
  });
});

// ── Where the engine differs, pinned ─────────────────────────────────────────

/** A tracked line without the engine's two added fields: P0's line. */
const p0Line = (l: BudgetVarianceTrackedResult['lines'][number]) => {
  const { budget_verdict: _v, band: _b, ...rest } = l;
  return rest;
};

describe("partialWindow: 'absent' (the comparator's opt-in): the engine withholds a partial-window budget", () => {
  it("on a whole-month window P0 and the engine agree on, the lines and rows are the default's; it adds the version and no unallocated budget", async () => {
    const { facade, absent } = await both('2026-03-01', '2026-08-31');
    expect(absent.lines.map(p0Line)).toStrictEqual(facade.lines);
    expect(absent.rows.map(p0Line)).toStrictEqual(facade.rows);
    expect([absent.sections, absent.totals, absent.fiscalYear, absent.monthKeys, absent.postedThrough])
      .toStrictEqual([facade.sections, facade.totals, facade.fiscalYear, facade.monthKeys, facade.postedThrough]);
    expect([absent.budgetAbsentYears, absent.splitsMonth, absent.partialBudgetCount]).toEqual([[], false, 0]);
    expect(absent.version).toMatchObject({ id: f.v.primary27, name: 'Original', status: 'approved', isPrimary: true });
    expect(absent.unallocatedBudget).toEqual({ income: 0, expense: 0 });
  });

  it('FY2026 has no budget in Jan 2026 .. Jun 2026: every line absent, none budgeted, none unbudgeted, none partial', async () => {
    const { absent, oracle: want } = await both('2026-01-01', '2026-06-30');
    expect(want.rows.map((l) => l.account_code)).toEqual(['BT-4000', 'BT-4900', 'BT-5000', 'BT-6000', 'BT-7000']);
    expect(absent.budgetAbsentYears).toEqual([2026]);
    expect([absent.rows, absent.unbudgeted, absent.partialBudgetCount]).toEqual([[], [], 0]);
    expect(absent.lines.map((l) => [l.account_code, l.actual_amount, l.budgeted, l.budget_amount, l.budget_verdict, l.budget_partial]))
      .toEqual(want.lines.map((l) => [l.account_code, l.actual_amount, false, 0, 'absent', undefined]));
    expect([absent.unallocatedBudget, absent.sections.net_profit.budget, absent.totals.budget]).toEqual([null, null, null]);
    expect(absent.version).toMatchObject({ id: f.v.primary27 });
  });

  it('Apr .. May 2027: opex (budgeted in both years) is equal; lines budgeted in FY2027 only are withheld as partial', async () => {
    const { absent, oracle: want } = await both('2027-04-01', '2027-05-31');
    const opex = absent.lines.find((l) => l.account_code === 'BT-6000')!;
    expect(p0Line(opex)).toEqual(want.lines.find((l) => l.account_code === 'BT-6000'));
    expect(opex).toMatchObject({ budgeted: true, budget_amount: 410, budget_verdict: 'budgeted' });
    expect(absent.rows.map((l) => l.account_code)).toEqual(['BT-6000']);
    expect(absent.unbudgeted).toEqual([]);
    expect(absent.lines.filter((l) => l.budget_partial).map((l) => l.account_code)).toEqual(['BT-4000', 'BT-4900', 'BT-5000', 'BT-7000']);
    expect([absent.budgetAbsentYears, absent.partialBudgetCount]).toEqual([[], 4]);
    expect(absent.version).toMatchObject({ id: f.v.primary28 });
  });

  it.each([
    ['a start that is not the 1st', '2026-03-16', '2026-08-31'],
    ['an end that is not a month end', '2026-03-01', '2026-08-30'],
  ])('%s splits a budget month: no window budget, and it says so', async (_name, start, end) => {
    const { absent, facade } = await both(start, end);
    expect(absent.splitsMonth).toBe(true);
    expect(absent.rows).toEqual([]);
    expect(new Set(absent.lines.map((l) => l.budget_verdict))).toEqual(new Set(['absent']));
    expect(absent.lines.map((l) => [l.account_code, l.actual_amount])).toEqual(facade.lines.map((l) => [l.account_code, l.actual_amount]));
    // The default keeps P0's whole months (the ruling): MCP and packs are unchanged.
    expect(facade.rows.length).toBeGreaterThan(0);
  });

  it('a mid-month registry year inside the window splits its month in this mode', async () => {
    const midMonth: Before = async (c) => {
      await c.query(`UPDATE fiscal_years SET start_date = '2027-05-15' WHERE company_id = $1 AND fiscal_year = 2028`, [f.a]);
      await c.query(`UPDATE fiscal_years SET end_date = '2027-05-14' WHERE company_id = $1 AND fiscal_year = 2027`, [f.a]);
    };
    const { absent } = await both('2027-04-01', '2027-05-31', midMonth);
    expect(absent.splitsMonth).toBe(true);
    expect(absent.rows).toEqual([]);
    expect(absent.budgetAbsentYears).toContain(2028);
  });

  it('a budgeted zero with no actuals is a budgeted line in this mode too', async () => {
    const { absent } = await both('2026-06-01', '2026-06-30', zeroBudget);
    expect(absent.rows.find((l) => l.account_code === 'BT-6500')).toMatchObject({ budgeted: true, budget_amount: 0, budget_verdict: 'budgeted' });
  });
});

describe("partialWindow: 'absent' = the Budget vs Actual report for the same window (spec §8.2), notices included", () => {
  it.each([
    ['across FY2026 (no version) and FY2027', '2026-01-01', '2026-06-30', '2026-01', '2026-06'],
    ['across FY2027 and FY2028 (lines budgeted in one year only)', '2027-04-01', '2027-05-31', '2027-04', '2027-05'],
    ['inside FY2027', '2026-03-01', '2026-08-31', '2026-03', '2026-08'],
  ])('%s', async (_name, start, end, from, to) => {
    const { absent } = await both(start, end);
    const report = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'custom', from, to }, new Date('2026-11-15T10:00:00+02:00')));
    const engine = new Map(report.lines.map((l) => [l.accountId, l]));
    for (const l of absent.lines) {
      const e = engine.get(l.account_id)!;
      expect([l.account_code, l.budget_verdict, l.budgeted ? l.budget_amount : null, l.actual_amount])
        .toEqual([e.accountCode, e.budgetVerdict, e.budget, e.actual]);
    }
    expect(absent.budgetAbsentYears).toEqual(report.notices.noVersionYears);
    expect(absent.partialBudgetCount).toBe(report.notices.partialBudget?.count ?? 0);
    expect(absent.unallocatedBudget).toEqual(report.notices.unallocatedBudget);
    expect(absent.bands).toEqual(report.bands.map((b) => ({ key: b.key, budget: b.budget })));
  });
});
