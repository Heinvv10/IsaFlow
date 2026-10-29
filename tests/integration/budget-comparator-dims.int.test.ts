/**
 * Budgets P3 PR-C, on real PostgreSQL: `getBudgetVariance`'s options (the
 * statement comparator's `version_id`, `cost_centre_id` either level, `cc1_id`,
 * `cc2_id`, `bu_id`) give the tracking engine's figures for the same window and
 * filter: per account the budget (absent stays unbudgeted, never 0), the
 * actual, the unallocated budget and the version. Ids are looked up under the
 * company: another company's version or centre is a 404 with none of its
 * figures, and a named version only reads its own year (400 otherwise).
 *
 * Seed: helpers/budgetTrackingFixture.ts. Fixture route: isaflow_schema_fixture
 * (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import type { TrackingParams } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { getBudgetVariance, type BudgetVarianceOptions } from '@/modules/accounting/services/reports/budgetVarianceService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const NOW = new Date('2026-11-15T10:00:00+02:00');

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

/** As the comparator route calls it: the filter, the version, and the engine's partial-window rule. */
const facade = (opts: BudgetVarianceOptions, start = '2026-03-01', end = '2026-08-31') =>
  asRequest(pool, f.a, f.userA, () => getBudgetVariance(f.a, start, end, { ...opts, partialWindow: 'absent' }));
const engine = (opts: Omit<TrackingParams, 'period'>) =>
  asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'custom', from: '2026-03', to: '2026-08', ...opts }, NOW));

describe('the comparator filter = the engine', () => {
  const cases: Array<[string, () => BudgetVarianceOptions]> = [
    ['either level, a CC1 (FT)', () => ({ costCentreId: f.cc.FT })],
    ['either level, a CC2 (P1)', () => ({ costCentreId: f.cc.P1 })],
    ['either level, a chainless CC2 (PN)', () => ({ costCentreId: f.cc.PN })],
    ['explicit CC1 (FT)', () => ({ cc1Id: f.cc.FT })],
    ['explicit CC2 (P1)', () => ({ cc2Id: f.cc.P1 })],
    ['a business unit (B1)', () => ({ buId: f.bu.B1 })],
    ['either level + a business unit', () => ({ costCentreId: f.cc.FT, buId: f.bu.B1 })],
    ['a named non-primary version', () => ({ versionId: f.v.reforecast27 })],
  ];

  it.each(cases)('%s', async (_name, opts) => {
    const got = await facade(opts());
    const want = await engine(opts());
    const byId = new Map(want.lines.map((l) => [l.accountId, l]));
    expect(got.lines.length).toBeGreaterThan(0);
    for (const line of got.lines) {
      const e = byId.get(line.account_id)!;
      expect(e, line.account_code).toBeDefined();
      expect([line.account_code, line.actual_amount, line.budgeted, line.budgeted ? line.budget_amount : null])
        .toEqual([e.accountCode, e.actual, e.budget !== null, e.budget]);
    }
    // Every engine line with a figure is in the facade's lines.
    const printed = want.lines.filter((l) => l.budget !== null || l.actual !== 0).map((l) => l.accountId).sort();
    expect(got.lines.map((l) => l.account_id).sort()).toEqual(printed);
    expect(got.unallocatedBudget).toEqual(want.notices.unallocatedBudget);
    expect(got.version).toEqual(want.version);
    // The years with no budget, and those with one none of which is at this filter (review r2, R8):
    // the one core says the same on the Budget vs Actual page and on the comparator.
    expect([got.budgetAbsentYears, got.budgetOutsideFilterYears]).toEqual([want.notices.noVersionYears, want.notices.noBudgetAtFilterYears]);
  });

  it('either level reads cc1 OR cc2: FT includes the legacy cross-tag (cc2_id = FT) that explicit CC1 leaves out', async () => {
    const either = await facade({ costCentreId: f.cc.FT });
    const explicit = await facade({ cc1Id: f.cc.FT });
    const opex = (r: typeof either) => r.lines.find((l) => l.account_code === 'BT-6000')?.actual_amount ?? 0;
    // Six months of the 33.33 cross-tagged opex line.
    expect(opex(either) - opex(explicit)).toBeCloseTo(6 * 33.33, 2);
  });

  it('either level budgets by cc1 OR cc2: P1 (a CC2) reads its own rows, FT (a CC1) its rows and its CC2s\'', async () => {
    const budget = (r: Awaited<ReturnType<typeof facade>>, code: string) => r.rows.find((l) => l.account_code === code)?.budget_amount;
    const p1 = await facade({ costCentreId: f.cc.P1 });
    expect(budget(p1, 'BT-4000')).toBe(6 * 100);
    const ft = await facade({ costCentreId: f.cc.FT });
    expect([budget(ft, 'BT-4000'), budget(ft, 'BT-5000')]).toEqual([6 * 100, 6 * 40]);
  });

  it('a company-level budget under a filter is unallocated, never in the Budget column', async () => {
    const r = await facade({ costCentreId: f.cc.HT });
    const opex = r.lines.find((l) => l.account_code === 'BT-6000')!;
    expect(opex).toMatchObject({ budgeted: false, budget_amount: 0 });
    expect(r.unbudgeted.map((l) => l.account_code)).not.toContain('BT-6000');
    expect(r.unallocatedBudget?.expense).toBeGreaterThanOrEqual(6 * 200);
  });
});

describe('the income statement and Budget vs Actual agree on every band and profit total (review r3, final R9)', () => {
  // [from, to, last day]: a single year, a window across FY2027 / FY2028 (partial lines: accounts budgeted in one year), and a
  // window reaching FY2026, which has no version.
  const WINDOWS: Array<[string, string, string]> = [['2026-03', '2026-08', '2026-08-31'], ['2027-03', '2027-06', '2027-06-30'], ['2026-01', '2026-06', '2026-06-30']];
  const FILTERS: Array<[string, () => BudgetVarianceOptions]> = [
    ['no filter', () => ({})], ['either level, a CC1', () => ({ costCentreId: f.cc.FT })], ['explicit CC2', () => ({ cc2Id: f.cc.P1 })],
  ];
  const cases = WINDOWS.flatMap((w) => FILTERS.map((x) => [...w, ...x] as [string, string, string, string, () => BudgetVarianceOptions]));

  it.each(cases)('%s to %s (%s), %s: the same band budget on both pages, null on both or the same figure', async (from, to, last, _name, opts) => {
    const got = await facade(opts(), `${from}-01`, last);
    const want = await engine({ ...opts(), from, to });
    expect(got.bands.map((b) => [b.key, b.budget])).toEqual(want.bands.map((b) => [b.key, b.budget]));
  });
});

describe('ids under the company', () => {
  it.each([
    ["another company's version", () => ({ versionId: f.v.b27 })],
    ["another company's cost centre", () => ({ costCentreId: f.cc.BX })],
    ["another company's business unit", () => ({ buId: f.bu.BBX })],
  ] as Array<[string, () => BudgetVarianceOptions]>)('%s is a 404 carrying none of its figures', async (_name, opts) => {
    const err = await facade(opts()).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ name: expect.stringMatching(/TrackingError|BudgetVersionError/) });
    expect(JSON.stringify(err)).not.toMatch(/SECRET|12345/);
    expect(String((err as { status?: number }).status ?? (err as { code?: string }).code)).toMatch(/^(404|BUDGET_VERSION_NOT_FOUND)$/);
  });

  it('a named version only reads its own year: a window reaching FY2028 is a 400', async () => {
    await expect(facade({ versionId: f.v.reforecast27 }, '2027-04-01', '2027-05-31')).rejects.toMatchObject({ name: 'TrackingError', status: 400 });
  });
});
