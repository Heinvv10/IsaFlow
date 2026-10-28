/**
 * Budgets P3 INVARIANT 2, on real PostgreSQL: the company roll-up is the sum of
 * every stored grain, per account and month (one grain per account per
 * version, so nothing double counts). Under a dimension filter a budget set at
 * the filter's level, or below it (a CC2 under the filtered FNO), is in the
 * Budget column; one set above it (company level, another level, a CC2 with no
 * FNO) is reported as unallocated and never apportioned. A non-primary version
 * is read only when its id is passed; a window reaching another year than the
 * named version's is a 400. Seed: helpers/budgetTrackingFixture.ts.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, FY2027_MONTHS, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import { TrackingError, type BudgetTrackingReport, type TrackingParams } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const NOW = new Date('2026-11-15T10:00:00+02:00');
const FY: TrackingParams = { period: 'fy', fiscalYear: 2027 };
const N = FY2027_MONTHS.length;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const run = (p: TrackingParams) => asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, p, NOW));
const line = (r: BudgetTrackingReport, acct: string) => r.lines.find((l) => l.accountId === acct)!;

describe('Invariant 2: company roll-up = Σ grains', () => {
  it('per account and month, the unfiltered budget is the plain sum of every stored row of the primary', async () => {
    const r = await run(FY);
    const { rows } = await pool.query(
      `SELECT gl_account_id::TEXT AS acct, to_char(month, 'YYYY-MM') AS m, SUM(amount)::NUMERIC AS total
         FROM budget_month_amounts WHERE company_id = $1 AND version_id = $2 GROUP BY 1, 2`, [f.a, f.v.primary27]);
    expect(rows.length).toBe(5 * N);
    for (const row of rows) {
      const cell = line(r, row.acct).monthly.find((m) => m.month === row.m);
      expect(cell?.budget, `${row.acct} ${row.m}`).toBe(Number(row.total));
    }
    expect([line(r, f.acc.sales).budget, line(r, f.acc.cos).budget, line(r, f.acc.opex).budget]).toEqual([150 * N, 70 * N, 200 * N]);
    expect(r.notices.unallocatedBudget).toBe(0);
    expect(r.version).toMatchObject({ id: f.v.primary27, name: 'Original', kind: 'original', status: 'approved', isPrimary: true });
  });

  it('the band budget is Σ its lines, the net profit the statement arithmetic', async () => {
    const r = await run(FY);
    const band = (k: string) => r.bands.find((b) => b.key === k)!.budget;
    expect([band('turnover'), band('cost_of_sales'), band('other_income'), band('operating_expense'), band('other_expense')])
      .toEqual([150 * N, 70 * N, 5 * N, 200 * N, 7 * N]);
    expect(band('net_profit')).toBe((150 - 70 + 5 - 200 - 7) * N);
  });
});

describe('under a filter: included, unallocated, excluded', () => {
  it('CC1 = FT takes FT and the CC2 under it; company, BU and the chainless project are unallocated', async () => {
    const r = await run({ ...FY, cc1Id: f.cc.FT });
    expect([line(r, f.acc.sales).budget, line(r, f.acc.sales).unallocatedBudget]).toEqual([100 * N, 0]);
    expect(line(r, f.acc.cos).budget).toBe(40 * N);
    for (const acct of [f.acc.opex, f.acc.interest, f.acc.fin]) {
      expect(line(r, acct).budget, acct).toBeNull();
      expect(line(r, acct).budgetAboveFilter, acct).toBe(true);
    }
    expect([line(r, f.acc.opex).unallocatedBudget, line(r, f.acc.interest).unallocatedBudget, line(r, f.acc.fin).unallocatedBudget])
      .toEqual([200 * N, 5 * N, 7 * N]);
    expect(r.notices.unallocatedBudget).toBe(212 * N);
    expect(r.filter.cc1).toEqual({ id: f.cc.FT, code: 'BT-FT', name: 'Fibertime' });
  });

  it("CC2 = P1 takes P1 only; its FNO's CC1 budget is above it, the other FNO's is not", async () => {
    const r = await run({ ...FY, cc2Id: f.cc.P1 });
    expect(line(r, f.acc.sales).budget).toBe(100 * N);
    expect([line(r, f.acc.cos).budget, line(r, f.acc.cos).unallocatedBudget]).toEqual([null, 40 * N]);
    expect(line(r, f.acc.opex).unallocatedBudget).toBe(200 * N);
  });

  it('BU = B1 takes the BU budget; every other grain is unallocated', async () => {
    const r = await run({ ...FY, buId: f.bu.B1 });
    expect(line(r, f.acc.interest).budget).toBe(5 * N);
    expect([line(r, f.acc.sales).budget, line(r, f.acc.sales).unallocatedBudget]).toEqual([null, 150 * N]);
  });
});

describe('bullets per member (group_by, unfiltered)', () => {
  it('CC1 members plus the untagged / company-level remainder partition the net profit, actual and budget', async () => {
    const r = await run({ ...FY, groupBy: 'cc1' });
    const np = r.bands.find((b) => b.key === 'net_profit')!;
    const members = r.members!;
    const total = (pick: (m: (typeof members)[number]) => number) => Math.round(members.reduce((s, m) => s + pick(m) * 100, 0)) / 100;
    expect(total((m) => m.actual)).toBe(np.actual);
    expect(total((m) => m.budget ?? 0)).toBe(np.budget);
    const ft = members.find((m) => m.memberId === f.cc.FT)!;
    // FT's budget: P1's sales (100) rolled up through its FNO, less FT's COS (40).
    expect([ft.code, ft.budget]).toEqual(['BT-FT', (100 - 40) * N]);
    const untagged = members.find((m) => m.memberId === null)!;
    // Company-level opex, the BU-grain interest and the chainless project's finance cost have no CC1.
    expect(untagged.budget).toBe((5 - 200 - 7) * N);
    expect(members.at(-1)!.memberId).toBeNull();
  });

  it('a filter with group_by is refused: the members would not partition anything', async () => {
    const err = await run({ ...FY, groupBy: 'cc1', buId: f.bu.B1 }).catch((e: unknown) => e);
    expect((err as TrackingError).status).toBe(400);
  });
});

describe('versions', () => {
  it('a non-primary version is read only when its id is passed', async () => {
    const primary = await run(FY);
    expect(line(primary, f.acc.sales).budget).toBe(150 * N);
    const named = await run({ ...FY, versionId: f.v.reforecast27 });
    expect(line(named, f.acc.sales).budget).toBe(999 * N);
    expect(line(named, f.acc.opex).budget).toBeNull();
    expect(named.version).toMatchObject({ id: f.v.reforecast27, name: 'Reforecast 1', kind: 'reforecast', status: 'draft', isPrimary: false });
  });

  it("a cross-FY window takes each year's primary; a named version cannot reach another year", async () => {
    const r = await run({ period: 'custom', from: '2027-03', to: '2027-07' });
    expect(line(r, f.acc.opex).budget).toBe(200 * 2 + 210 * 3);
    expect(r.versionsByFy).toEqual({ 2027: { id: f.v.primary27, name: 'Original' }, 2028: { id: f.v.primary28, name: 'Original' } });
    expect(r.version?.id).toBe(f.v.primary28);
    const err = await run({ period: 'custom', from: '2027-03', to: '2027-07', versionId: f.v.primary27 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackingError);
    expect((err as TrackingError).status).toBe(400);
    expect((err as TrackingError).message).toMatch(/FY2027; the window reaches FY2028/);
  });

  it('a year with no version leaves the Budget column absent, never zero', async () => {
    await pool.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, 2029, '2028-05-01', '2029-04-30', 'normal')`, [f.a]);
    try {
      const r = await run({ period: 'fy', fiscalYear: 2029 });
      expect([r.version, r.notices.noVersion, r.notices.noVersionYears]).toEqual([null, true, [2029]]);
      for (const b of r.bands) expect(b.budget, b.key).toBeNull();
    } finally {
      await pool.query('DELETE FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2029', [f.a]);
    }
  });
});
