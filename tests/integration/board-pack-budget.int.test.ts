/**
 * Budgets P3 PR-E, on real PostgreSQL: the board pack's budget is the tracking engine's, and the
 * engine's band actuals are the pack's own actuals on a real ledger, so the Budget column prints
 * (the figure set withholds it on any disagreement). Windows: a quarter, a full 14-month year
 * that holds the posted year-end close, a window that cuts a budget month (no budget), a month
 * in a year with no version (no budget), and a named non-primary version. app_user, forced RLS.
 * Seed: helpers/budgetTrackingFixture.ts.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
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

const build = (from: string, to: string, versionId?: string) => asRequest(pool, f.a, f.userA, async () => {
  const set = await buildPackFigureSet(f.a, 'BT A', from, to, versionId ? { versionId } : {});
  const engine = await buildRangeTracking(f.a, from, to, { wholeMonthsOnly: true, ...(versionId ? { versionId } : {}) });
  return { set, engine };
}, { appUser: true });

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
    expect(set.budget!.bands['is.revenue']).toBe(450);
    expect(set.budget!.version).toEqual({ name: 'Original', status: 'approved' });
  });

  it('the full 14-month year, which holds the posted year-end close', async () => {
    const { set, engine } = await build('2026-03-01', '2027-04-30');
    expectEngineBands(set, engine);
  });

  it('a named non-primary version', async () => {
    const { set, engine } = await build('2026-03-01', '2026-05-31', f.v.reforecast27);
    expectEngineBands(set, engine);
    expect(set.budget!.bands['is.revenue']).toBe(2997);
    expect(set.budget!.version.name).toBe('Reforecast 1');
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
