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
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';

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
    expect(r.notices.unallocatedBudget).toEqual({ income: 0, expense: 0 });
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

describe('line order (review Q5)', () => {
  it("lines come in the ledger's ORDER BY account_code, Postgres' collation", async () => {
    const r = await run(FY);
    const { rows } = await pool.query(
      `SELECT account_code FROM gl_accounts WHERE company_id = $1 AND id = ANY($2::UUID[]) ORDER BY account_code, id`,
      [f.a, r.lines.map((l) => l.accountId)]);
    expect(r.lines.map((l) => l.accountCode)).toEqual(rows.map((x) => x.account_code));
    expect(r.lines.length).toBe(5);
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
    // Per polarity (D1): interest is income, opex and finance cost are expense.
    expect(r.notices.unallocatedBudget).toEqual({ income: 5 * N, expense: 207 * N });
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

  it('F1: a window reaching a year with no version has no window budget, though another year is budgeted', async () => {
    // FY2028 loses its primary for this request only; FY2027's March and April stay budgeted.
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'custom', from: '2027-03', to: '2027-07' }, NOW), {
      before: (c) => c.query('UPDATE budget_versions SET is_primary = false WHERE id = $1', [f.v.primary28]),
    });
    const opex = line(r, f.acc.opex);
    expect([opex.budget, opex.variance, opex.variancePct, opex.favourable]).toEqual([null, null, null, null]);
    expect(opex.monthly.map((m) => [m.month, m.budget])).toEqual([
      ['2027-03', 200], ['2027-04', 200], ['2027-05', null], ['2027-06', null], ['2027-07', null],
    ]);
    for (const b of r.bands) expect([b.key, b.budget, b.variance]).toEqual([b.key, null, null]);
    expect([r.notices.noVersionYears, r.notices.unbudgetedCount]).toEqual([[2028], 0]);
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
