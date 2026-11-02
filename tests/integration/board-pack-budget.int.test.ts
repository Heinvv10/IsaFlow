/**
 * Budgets P3 PR-E, on real PostgreSQL: the board pack's budget is the tracking engine's, and the
 * engine's band actuals are the pack's own actuals on a real ledger, so the Budget column prints
 * (the figure set withholds it on any disagreement). Windows: a quarter (each row's budget checked
 * against the seeded amounts), a window over two financial years, a full 14-month year that holds
 * the posted year-end close, a window that cuts a budget month (no budget), a month in a year with
 * no version (no budget), a named non-primary version, and a line left with no budget at all (its
 * account is that line's n/m, not "counted as nil"). app_user, forced RLS.
 * Seed: helpers/budgetTrackingFixture.ts.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildPackFigureSet, type PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { PACK_BUDGET_BAND } from '@/modules/accounting/services/packs/figures/packBudgetBands';
import { buildRangeTracking } from '@/modules/accounting/services/budgets/tracking/trackingRange';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const build = (from: string, to: string, versionId?: string, before?: (c: PoolClient) => Promise<unknown>) =>
  asRequest(pool, f.a, f.userA, async () => {
    const set = await buildPackFigureSet(f.a, 'BT A', from, to, versionId ? { versionId } : {});
    const engine = await buildRangeTracking(f.a, from, to, { wholeMonthsOnly: true, ...(versionId ? { versionId } : {}) });
    return { set, engine };
  }, { appUser: true, before });

function expectEngineBands(set: PackFigureSet, engine: Awaited<ReturnType<typeof buildRangeTracking>>): void {
  expect(set.budget).not.toBeNull();
  const byKey = new Map(engine.bands.map((b) => [b.key, b]));
  for (const [row, band] of Object.entries(PACK_BUDGET_BAND)) {
    expect(set.budget!.bands[row as keyof typeof PACK_BUDGET_BAND], row).toBe(byKey.get(band)!.budget);
  }
  // The pack prints the engine's budget beside its OWN actual: the same ledger read, to the cent.
  const own = { turnover: set.current.revenue, cost_of_sales: set.current.costOfSales, other_income: set.current.otherIncome ?? 0,
    operating_expense: set.current.operatingExpenses, other_expense: set.current.otherExpenses ?? 0, net_profit: set.current.netProfit };
  for (const [band, actual] of Object.entries(own)) expect(byKey.get(band as never)!.actual, band).toBeCloseTo(actual, 2);
}

describe('the board pack budget on a real ledger', () => {
  it('a quarter: every row is the engine\'s band, beside the same actuals', async () => {
    const { set, engine } = await build('2026-03-01', '2026-05-31');
    expectEngineBands(set, engine);
    // From the fixture's seeded rows, month by month (not from the band map, so a row read off the wrong
    // band fails): sales 100 + 50, cost of sales 40 + 30, opex 200, interest 5 (other income), finance cost 7.
    expect(set.budget!.bands).toEqual({
      'is.revenue': 450, 'is.costOfSales': 210, 'is.grossProfit': 240, 'is.operatingExpenses': 600,
      'is.otherIncome': 15, 'is.operating': -345, 'is.otherExpenses': 21, 'is.netProfit': -366,
    });
    expect(set.budget!.version).toEqual({ kind: 'original', status: 'approved' });
    expect(set.budget!.unbudgetedCount).toBe(0);
  });

  it('a window over two financial years names no single version (each year\'s primary is read)', async () => {
    const { set, engine } = await build('2027-03-01', '2027-06-30');
    expectEngineBands(set, engine);
    expect(set.budget!.version).toBeNull();
  });

  it('an unbudgeted account in a line with no budget is that line\'s n/m, not counted as nil', async () => {
    // Finance cost loses its budget (rolled back with the request): other expenses has lines and none budgeted.
    const { set } = await build('2026-03-01', '2026-05-31', undefined,
      (c) => c.query('DELETE FROM budget_month_amounts WHERE company_id = $1 AND gl_account_id = $2', [f.a, f.acc.fin]));
    expect(set.budget!.bands['is.otherExpenses']).toBeNull();
    expect(set.budget!.bands['is.netProfit']).toBeNull();
    expect(set.budget!.unbudgetedCount).toBe(0);
  });

  it('the full 14-month year, which holds the posted year-end close', async () => {
    const { set, engine } = await build('2026-03-01', '2027-04-30');
    expectEngineBands(set, engine);
  });

  it('a named non-primary version', async () => {
    const { set, engine } = await build('2026-03-01', '2026-05-31', f.v.reforecast27);
    expectEngineBands(set, engine);
    expect(set.budget!.bands['is.revenue']).toBe(2997);
    expect(set.budget!.version).toEqual({ kind: 'reforecast', status: 'draft' });
  });

  it('a window that cuts a budget month carries no budget', async () => {
    const { set } = await build('2026-03-01', '2026-05-15');
    expect(set.budget).toBeNull();
  });

  it('a month in a year with no version carries no budget', async () => {
    const { set } = await build('2026-01-01', '2026-01-31');
    expect(set.budget).toBeNull();
  });
});
