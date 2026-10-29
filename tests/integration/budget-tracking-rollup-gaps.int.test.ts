/**
 * Budgets P3 roll-up regressions from the PR-A review rounds, on real PostgreSQL (moved
 * unchanged out of budget-tracking-rollup.int.test.ts for the 300-line rule): the no-version
 * gap on members and unallocated budget (A1, A2), a grain change between versions (A3), empty
 * versions and the budget-absent rule (R9, E1-E3), a gap window with no lines (R1), the
 * above-filter month flag (R4), member order (R5), registry misses (L3), and the per-line
 * cross-year rule (r5 G1) with the empty-version marker (G2).
 * Seed: helpers/budgetTrackingFixture.ts.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import { budgetBridgeSteps } from '@/modules/accounting/services/budgets/tracking/budgetBridgeSteps';
import { TrackingError, type BudgetTrackingReport, type TrackingParams } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const NOW = new Date('2026-11-15T10:00:00+02:00');
const FY: TrackingParams = { period: 'fy', fiscalYear: 2027 };

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const run = (p: TrackingParams) => asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, p, NOW));
const line = (r: BudgetTrackingReport, acct: string) => r.lines.find((l) => l.accountId === acct)!;

describe('review round 2: the no-version gap and a grain change across years', () => {
  // Jan - Feb 2026 lie in FY2026, which has no version; Mar - Jun in FY2027.
  const GAP: TrackingParams = { period: 'custom', from: '2026-01', to: '2026-06' };

  it('A1: under the gap every member bullet has no budget (no partial-window figure)', async () => {
    const r = await run({ ...GAP, groupBy: 'cc1' });
    expect(r.bands.find((b) => b.key === 'net_profit')!.budget).toBeNull();
    const members = r.members!;
    expect(members.length).toBeGreaterThan(1);
    for (const m of members) expect([m.name, m.budget, m.variance, m.favourable]).toEqual([m.name, null, null, null]);
  });

  it('A2: under the gap unallocated budget is absent too, on lines, bands and the footer', async () => {
    const r = await run({ ...GAP, cc1Id: f.cc.FT });
    const opex = line(r, f.acc.opex);
    expect([opex.budget, opex.unallocatedBudget]).toEqual([null, null]);
    for (const b of r.bands) expect([b.key, b.unallocatedBudget]).toEqual([b.key, null]);
    expect(r.notices.unallocatedBudget).toBeNull();
  });

  it('A3: an account at the included grain in one version and only above the filter in another has no window budget', async () => {
    // FY2028's primary budgets sales at company level: one grain per account per VERSION still holds.
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'custom', from: '2027-03', to: '2027-06', cc2Id: f.cc.P1 }, NOW), {
      before: (c) => c.query(
        `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
         SELECT $1, $2, $3, (m || '-01')::DATE, 300 FROM unnest($4::TEXT[]) AS m`,
        [f.a, f.v.primary28, f.acc.sales, ['2027-05', '2027-06', '2027-07', '2027-08']]),
    });
    const sales = line(r, f.acc.sales);
    expect([sales.budget, sales.variance, sales.variancePct, sales.favourable]).toEqual([null, null, null, null]);
    expect([sales.budgetAboveFilter, sales.unallocatedBudget]).toEqual([true, 600]);
    // The monthly figures keep what each version says.
    expect(sales.monthly.map((m) => [m.month, m.budget])).toEqual([['2027-03', 100], ['2027-04', 100], ['2027-05', null], ['2027-06', null]]);
    // It is not "unbudgeted" either: its budget is set above the filter.
    expect(r.notices.unbudgetedCount).toBe(0);
  });
});

describe('review round 3', () => {
  it('R9: an EMPTY primary version counts as no version: the gap rule holds and the year is named', async () => {
    // What resolvePrimaryVersion({ create: true }) leaves behind: a primary 'Original' with no rows.
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'custom', from: '2026-01', to: '2026-06' }, NOW), {
      before: (c) => c.query(
        `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by) VALUES ($1, 2026, 'Original', 'original', true, $2)`,
        [f.a, f.userA]),
    });
    const sales = line(r, f.acc.sales);
    expect([sales.budget, sales.variance, sales.unallocatedBudget]).toEqual([null, null, null]);
    for (const b of r.bands) expect([b.key, b.budget, b.unallocatedBudget]).toEqual([b.key, null, null]);
    expect([r.notices.noVersionYears, r.notices.unbudgetedCount, r.notices.unallocatedBudget]).toEqual([[2026], 0, null]);
    // Its months keep what each version holds: Jan-Feb nothing, Mar on FY2027's primary.
    expect(sales.monthly.map((m) => m.budget)).toEqual([null, null, 150, 150, 150, 150]);
  });

  it('R9: an empty version as FY* leaves the projection without a budget, as no version does', async () => {
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'fy', fiscalYear: 2026 }, NOW), {
      before: (c) => c.query(
        `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by) VALUES ($1, 2026, 'Original', 'original', true, $2)`,
        [f.a, f.userA]),
    });
    expect([r.notices.noVersion, r.notices.noVersionYears]).toEqual([true, [2026]]);
    for (const l of r.lines) expect([l.accountCode, l.fyBudget, l.projVariance]).toEqual([l.accountCode, null, null]);
    // The empty version is still the one read, and named.
    expect(r.version).toMatchObject({ name: 'Original', status: 'draft', isPrimary: true });
  });

  it('R1: a gap window with no lines at all leaves every band unallocated absent, like the footer', async () => {
    const r = await run({ period: 'custom', from: '2025-03', to: '2025-04' });
    expect([r.lines.length, r.notices.unallocatedBudget]).toEqual([0, null]);
    for (const b of r.bands) expect([b.key, b.budget, b.unallocatedBudget]).toEqual([b.key, null, null]);
  });

  it('R5: members follow the ledger collation (ORDER BY code, id), not a JS comparison', async () => {
    // A lower-case code: Postgres en_US puts 'bt-aa' before 'BT-FT'; a code-unit comparison would put it last.
    const aa = crypto.randomUUID();
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { ...FY, groupBy: 'cc1' }, NOW), {
      before: async (c) => {
        await c.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type) VALUES ($1, $2, 'bt-aa', 'Lower case', 'cc1')`, [aa, f.a]);
        await c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id) VALUES ($1, $2, $3, '2026-06-01', 11, $4)`,
          [f.a, f.v.primary27, f.acc.cos, aa]);
      },
    });
    const { rows } = await pool.query(`SELECT 'bt-aa' AS code UNION ALL SELECT code FROM cost_centres WHERE company_id = $1 AND cc_type = 'cc1' ORDER BY code`, [f.a]);
    const named = r.members!.filter((m) => m.memberId !== null).map((m) => m.code);
    expect(named).toEqual(rows.map((x) => x.code));
    expect(named[0]).toBe('bt-aa');
  });
});

describe('review round 4: budget-absent is what the scoped read returns', () => {
  const GAP: TrackingParams = { period: 'custom', from: '2026-01', to: '2026-06' };
  // An FY2026 primary holding exactly one row: where that row sits decides nothing for the window.
  const v26With = (acct: () => string, month: string) => async (c: import('pg').PoolClient) => {
    const vid = String((await c.query(
      `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by) VALUES ($1, 2026, 'Original', 'original', true, $2) RETURNING id`,
      [f.a, f.userA])).rows[0].id);
    await c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount) VALUES ($1, $2, $3, $4::DATE, 123)`,
      [f.a, vid, acct(), month]);
  };
  const CASES: Array<[string, () => string, string]> = [
    ['E1: its only row is on a balance-sheet account', () => f.acc.bank, '2026-01-01'],
    ['E2: its only row is in a month of the year outside the window', () => f.acc.sales, '2025-05-01'],
    ['E3: its only row is dated in another year\'s month', () => f.acc.sales, '2026-12-01'],
  ];
  for (const [name, acct, month] of CASES) {
    it(`${name}: FY2026 is budget-absent for the window`, async () => {
      const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, GAP, NOW), { before: v26With(acct, month) });
      expect(r.notices.noVersionYears).toEqual([2026]);
      expect([line(r, f.acc.sales).budget, line(r, f.acc.sales).unallocatedBudget]).toEqual([null, null]);
      expect(r.bands.find((b) => b.key === 'net_profit')!.budget).toBeNull();
      // The year's version is read, but never presented as a budget.
      expect(r.versionsByFy?.[2026]).toMatchObject({ name: 'Original', empty: true });
      expect(r.versionsByFy?.[2027]?.empty).toBeUndefined();
    });
  }

  it('a single-year window keeps D5 per line: an account with no row in the window is unbudgeted, the others print', async () => {
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'custom', from: '2026-03', to: '2026-05' }, NOW), {
      before: (c) => c.query(`DELETE FROM budget_month_amounts WHERE version_id = $1 AND gl_account_id = $2 AND month <= '2026-05-01'`, [f.v.primary27, f.acc.cos]),
    });
    expect(r.notices.noVersionYears).toEqual([]);
    expect(line(r, f.acc.sales).budget).toBe(450);
    expect(line(r, f.acc.cos).budget).toBeNull();
    expect(r.notices.unbudgetedCount).toBeGreaterThan(0);
  });

  it('R4 engine: a month budgeted only above the filter says so; a no-version month does not', async () => {
    // CC2 = P1: COS is budgeted at its FNO (CC1 FT) in FY2027; Jan-Feb 2026 lie in FY2026 (no version).
    const r = await run({ period: 'custom', from: '2026-01', to: '2026-04', cc2Id: f.cc.P1 });
    expect(line(r, f.acc.cos).monthly.map((m) => [m.month, m.budget, m.budgetAboveFilter])).toEqual([
      ['2026-01', null, false], ['2026-02', null, false], ['2026-03', null, true], ['2026-04', null, true],
    ]);
  });
});

describe('review round 2: registry failures on the way are a 4xx (L3)', () => {
  // With no usable start month the registry chains 12-month steps from the last stored year and
  // refuses a date more than 500 steps away (P0001 'fiscal_year_template: ... too far').
  const noStartMonth = (c: import('pg').PoolClient) => c.query('UPDATE companies SET financial_year_start = NULL WHERE id = $1', [f.a]);

  it("a 'today' the registry cannot place (year options) is a 400, not a 500", async () => {
    const err = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, FY, new Date('2531-01-15T10:00:00+02:00')), {
      before: noStartMonth,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackingError);
    expect((err as TrackingError).status).toBe(400);
  });

  it("a named version whose year the registry cannot place is a typed 4xx, not a 500", async () => {
    const vid = crypto.randomUUID();
    const err = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { ...FY, versionId: vid }, NOW), {
      before: async (c) => {
        await noStartMonth(c);
        await c.query(
          `INSERT INTO budget_versions (id, company_id, fiscal_year, name, kind, created_by) VALUES ($1, $2, 2700, 'Far', 'scenario', $3)`,
          [vid, f.a, f.userA]);
      },
    }).catch((e: unknown) => e);
    // The registry answers "no such label" here (P1's BudgetVersionError, 409); a raise on that path is
    // mapped too (unit: trackingBudgetReadRegistry.test.ts).
    expect(err instanceof TrackingError || err instanceof BudgetVersionError, String(err)).toBe(true);
    expect([400, 404, 409]).toContain((err as { status: number }).status);
  });
});

describe('review round 5: a cross-year window budgeted in some years only (G1, G2)', () => {
  const W: TrackingParams = { period: 'custom', from: '2027-03', to: '2027-06' }; // FY2027 Mar-Apr, FY2028 May-Jun
  const del = (c: import('pg').PoolClient, vid: string, where = 'TRUE', params: unknown[] = []) =>
    c.query(`DELETE FROM budget_month_amounts WHERE version_id = $1 AND ${where}`, [vid, ...params]);
  const amt = (c: import('pg').PoolClient, vid: string, acct: string, month: string, amount: number, d: { cc2?: string } = {}) =>
    c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc2_id) VALUES ($1, $2, $3, $4::DATE, $5, $6)`,
      [f.a, vid, acct, month, amount, d.cc2 ?? null]);
  const np = (r: BudgetTrackingReport) => r.bands.find((b) => b.key === 'net_profit')!;

  it('A1c: unfiltered, FY2028 budgets only opex: sales has no window budget, NP none, no bridge', async () => {
    const r = await run(W);
    const sales = line(r, f.acc.sales);
    expect([sales.budget, sales.variance, sales.partialBudget]).toEqual([null, null, true]);
    expect(line(r, f.acc.opex).budget).toBe(200 * 2 + 210 * 2);
    expect([np(r).budget, budgetBridgeSteps(r)]).toEqual([null, []]);
    expect([r.notices.noVersionYears, r.notices.unbudgetedCount]).toEqual([[], 0]);
  });

  it('G1: members partition NP: over a partial line every member budget is absent too; a fully budgeted window keeps them', async () => {
    for (const g of ['cc1', 'cc2', 'bu'] as const) {
      const r = await run({ ...W, groupBy: g });
      expect(np(r).budget).toBeNull();
      for (const m of r.members!) expect([g, m.name, m.budget, m.variance, m.favourable]).toEqual([g, m.name, null, null, null]);
      const q5 = await run({ period: 'quarter', fiscalYear: 2027, quarter: 5, groupBy: g });
      const sum = q5.members!.reduce((t, m) => t + Math.round((m.budget ?? 0) * 100), 0);
      expect([g, sum]).toEqual([g, Math.round(np(q5).budget! * 100)]);
    }
  });

  it("A1a: CC2 = P1, FY2028's only rows are P2's (other for P1): FY2028 is budget-absent for P1's view", async () => {
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { ...W, cc2Id: f.cc.P1 }, NOW), {
      before: async (c) => {
        await del(c, f.v.primary28);
        await amt(c, f.v.primary28, f.acc.sales, '2027-05-01', 100, { cc2: f.cc.P2 });
        await amt(c, f.v.primary28, f.acc.sales, '2027-06-01', 100, { cc2: f.cc.P2 });
      },
    });
    expect(r.notices.noVersionYears).toEqual([2028]);
    expect([line(r, f.acc.sales).budget, np(r).budget]).toEqual([null, null]);
    expect(r.versionsByFy?.[2028]?.empty).toBe(true);
  });

  it('A1b: CC2 = P1, FY2028 holds only company-level opex (coarser for P1): the year stays, sales is partial', async () => {
    const r = await run({ ...W, cc2Id: f.cc.P1 });
    expect(r.notices.noVersionYears).toEqual([]);
    const sales = line(r, f.acc.sales);
    expect([sales.budget, sales.partialBudget, sales.budgetAboveFilter]).toEqual([null, true, false]);
    // Opex is above the filter in both years: its unallocated footer is the whole window's.
    expect([line(r, f.acc.opex).budget, line(r, f.acc.opex).unallocatedBudget]).toEqual([null, 200 * 2 + 210 * 2]);
    expect([np(r).budget, budgetBridgeSteps(r)]).toEqual([null, []]);
  });

  const A6: Array<[string, string, string, number[]]> = [
    ['rows at both window edges (Feb in FY2026, Mar in FY2027)', '2026-02-01', '2026-03-01', []],
    ['the FY2026 row a month before the window', '2026-01-01', '2026-03-01', [2026]],
    ['the FY2027 row a month after the window', '2026-02-01', '2026-04-01', [2027]],
  ];
  for (const [name, m26, m27, absent] of A6) {
    it(`A6: 2026-02..03, ${name}`, async () => {
      const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'custom', from: '2026-02', to: '2026-03' }, NOW), {
        before: async (c) => {
          const v = String((await c.query(
            `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by) VALUES ($1, 2026, 'Original', 'original', true, $2) RETURNING id`,
            [f.a, f.userA])).rows[0].id);
          await amt(c, v, f.acc.opex, m26, 11);
          await del(c, f.v.primary27, 'month <> $2::DATE', [m27]);
        },
      });
      expect(r.notices.noVersionYears).toEqual(absent);
      // Opex is budgeted in both years only in the first case; sales (FY2027 only) never has a window budget.
      expect(line(r, f.acc.opex).budget).toBe(absent.length === 0 ? 11 + 200 : null);
      expect(line(r, f.acc.sales).budget).toBeNull();
      expect(line(r, f.acc.sales).partialBudget).toBe(absent.length === 0);
    });
  }

  it("G2: a single-year window whose version holds nothing in it marks the version itself", async () => {
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'quarter', fiscalYear: 2027, quarter: 2 }, NOW), {
      before: (c) => del(c, f.v.primary27, "month BETWEEN '2026-06-01' AND '2026-08-01'"),
    });
    expect(r.notices.noVersionYears).toEqual([2027]);
    expect(r.version).toMatchObject({ id: f.v.primary27, name: 'Original', empty: true });
    // A budgeted window carries no marker.
    expect((await run({ period: 'quarter', fiscalYear: 2027, quarter: 2 })).version?.empty).toBeUndefined();
  });
});
