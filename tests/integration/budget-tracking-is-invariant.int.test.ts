/**
 * Budgets P3 INVARIANT 1 (the phase's acceptance test), on real PostgreSQL:
 * the tracking engine's Actual, for any window and dimension filter, equals
 * the income statement for the same window and filter, per account and per
 * band, to the cent.
 *
 * Windows: every month of a 14-month FY, Q1-Q5 (Q5 = 2 months), YTD, FY and
 * three custom ranges, two of them across a financial-year edge. Filters:
 * none, CC1, CC2, BU, CC1 + BU, CC2 + BU. Oracles: `getIncomeStatement` for
 * none and BU (its BU filter is an explicit level), and
 * `dimensionPnlService.fetchDimensionAccountRows`' member column for the cost
 * centre filters (`groupBy` = that level, `filter.businessUnitId` for + BU):
 * the statement page's own `cost_centre_id` filter is either-level, so it is
 * not the oracle for an explicit-level filter.
 *
 * The seed (helpers/budgetTrackingFixture.ts) carries a draft journal, the
 * year-end close journal and a legacy cross-tag (cc2_id = a CC1 centre).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Runs on the GitHub
 * integration step; it never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, FY2027_MONTHS, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import type { BudgetTrackingReport, TrackingParams } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { fetchDimensionAccountRows } from '@/modules/accounting/services/reports/dimensionPnlService';
import { foldFigures } from '@/modules/accounting/services/reports/dimensionPnlColumns';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
// Inside FY2027's 9th month, so YTD is Mar - Nov 2026 and November is in progress.
const NOW = new Date('2026-11-15T10:00:00+02:00');

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

type Window = [label: string, params: TrackingParams, start: string, end: string];
const monthEnd = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`;
};
const WINDOWS: Window[] = [
  ...FY2027_MONTHS.map((m): Window => [`month ${m}`, { period: 'month', month: m }, `${m}-01`, monthEnd(m)]),
  ['Q1', { period: 'quarter', fiscalYear: 2027, quarter: 1 }, '2026-03-01', '2026-05-31'],
  ['Q2', { period: 'quarter', fiscalYear: 2027, quarter: 2 }, '2026-06-01', '2026-08-31'],
  ['Q3', { period: 'quarter', fiscalYear: 2027, quarter: 3 }, '2026-09-01', '2026-11-30'],
  ['Q4', { period: 'quarter', fiscalYear: 2027, quarter: 4 }, '2026-12-01', '2027-02-28'],
  ['Q5 (2 months)', { period: 'quarter', fiscalYear: 2027, quarter: 5 }, '2027-03-01', '2027-04-30'],
  ['YTD', { period: 'ytd', fiscalYear: 2027 }, '2026-03-01', '2026-11-30'],
  ['FY', { period: 'fy', fiscalYear: 2027 }, '2026-03-01', '2027-04-30'],
  ['custom across FY2026/27', { period: 'custom', from: '2026-01', to: '2026-05' }, '2026-01-01', '2026-05-31'],
  ['custom across FY2027/28', { period: 'custom', from: '2027-03', to: '2027-07' }, '2027-03-01', '2027-07-31'],
  ['custom inside FY2027', { period: 'custom', from: '2026-06', to: '2026-08' }, '2026-06-01', '2026-08-31'],
];

type FilterName = 'none' | 'cc1' | 'cc2' | 'bu' | 'cc1+bu' | 'cc2+bu';
const FILTERS: FilterName[] = ['none', 'cc1', 'cc2', 'bu', 'cc1+bu', 'cc2+bu'];

function paramsOf(name: FilterName): Pick<TrackingParams, 'cc1Id' | 'cc2Id' | 'buId'> {
  return {
    ...(name.startsWith('cc1') ? { cc1Id: f.cc.FT } : {}),
    ...(name.startsWith('cc2') ? { cc2Id: f.cc.P1 } : {}),
    ...(name.endsWith('bu') ? { buId: f.bu.B1 } : {}),
  };
}

interface Oracle { byCode: Map<string, number>; bands: Record<string, number> }

const cents = (n: number) => Math.round(n * 100);

/** What the income statement says for the window and filter. */
async function oracle(name: FilterName, start: string, end: string): Promise<Oracle> {
  if (name === 'none' || name === 'bu') {
    const is = await getIncomeStatement(f.a, start, end, name === 'bu' ? { businessUnitId: f.bu.B1 } : {});
    const byCode = new Map<string, number>();
    for (const item of [...is.revenue, ...is.otherIncome, ...is.costOfSales, ...is.operatingExpenses, ...is.otherExpenses]) {
      byCode.set(item.accountCode, item.amount);
    }
    return {
      byCode,
      bands: {
        turnover: is.totalRevenue, cost_of_sales: is.totalCostOfSales, gross_profit: is.grossProfit,
        other_income: is.totalOtherIncome, operating_expense: is.totalOperatingExpenses,
        operating_profit: is.operatingProfit, other_expense: is.totalOtherExpenses, net_profit: is.netProfit,
      },
    };
  }
  const level = name.startsWith('cc1') ? 'cc1' : 'cc2';
  const member = level === 'cc1' ? f.cc.FT : f.cc.P1;
  const rows = (await fetchDimensionAccountRows(f.a, start, end, level, name.endsWith('bu') ? { businessUnitId: f.bu.B1 } : {}))
    .filter((r) => r.memberId === member);
  const byCode = new Map<string, number>();
  for (const r of rows) byCode.set(r.accountCode, (byCode.get(r.accountCode) ?? 0) + (r.accountType === 'revenue' ? r.credit - r.debit : r.debit - r.credit));
  const fig = foldFigures(rows);
  return {
    byCode,
    bands: {
      turnover: fig.revenue, cost_of_sales: fig.costOfSales, gross_profit: fig.grossProfit, other_income: fig.otherIncome,
      operating_expense: fig.operatingExpenses, operating_profit: fig.operatingProfit, other_expense: fig.otherExpenses, net_profit: fig.netProfit,
    },
  };
}

function compare(label: string, report: BudgetTrackingReport, o: Oracle): string[] {
  const out: string[] = [];
  const codes = new Set([...o.byCode.keys(), ...report.lines.map((l) => l.accountCode)]);
  for (const code of codes) {
    const engine = report.lines.find((l) => l.accountCode === code)?.actual ?? 0;
    const want = o.byCode.get(code) ?? 0;
    if (cents(engine) !== cents(want)) out.push(`${label} account ${code}: engine ${engine}, statement ${want}`);
  }
  for (const [key, want] of Object.entries(o.bands)) {
    const engine = report.bands.find((b) => b.key === key)?.actual;
    if (engine === undefined || cents(engine) !== cents(want)) out.push(`${label} band ${key}: engine ${String(engine)}, statement ${want}`);
  }
  return out;
}

describe('Invariant 1: BvA actual = income statement, per account and band, to the cent', () => {
  it('the fixture is not vacuous: the oddities are inside the windows and the filters select real lines', async () => {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE je.status = 'draft') AS drafts, count(*) FILTER (WHERE je.source = 'year_end') AS closes,
              count(*) FILTER (WHERE jl.cc2_id = $2 AND jl.cc1_id IS NULL) AS cross_tags
         FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id WHERE je.company_id = $1`, [f.a, f.cc.FT]);
    expect(rows[0]).toEqual({ drafts: '2', closes: '3', cross_tags: String(19) });
    for (const name of FILTERS) {
      const o = await oracle(name, '2026-03-01', '2027-04-30');
      expect(cents(o.bands.net_profit!), `${name} selects nothing`).not.toBe(0);
    }
  });

  /** Windows in which a filter's net profit is non-zero on BOTH sides: no filter cell is vacuous (review T1). */
  const live = new Map<FilterName, string[]>(FILTERS.map((n) => [n, []]));

  for (const [label, params, start, end] of WINDOWS) {
    it(`${label}: every filter`, async () => {
      const mismatches: string[] = [];
      for (const name of FILTERS) {
        const report = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { ...params, ...paramsOf(name) }, NOW));
        expect([report.window.startDate, report.window.endDate], `${label} window`).toEqual([start, end]);
        const o = await oracle(name, start, end);
        mismatches.push(...compare(`${label} / ${name}`, report, o));
        const np = report.bands.find((b) => b.key === 'net_profit')!.actual;
        if (cents(o.bands.net_profit!) !== 0 && cents(np) !== 0) live.get(name)!.push(label);
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('every filter compared a non-zero net profit in every window (no vacuous cell)', () => {
    for (const name of FILTERS) expect(live.get(name), name).toEqual(WINDOWS.map(([label]) => label));
  });
});
