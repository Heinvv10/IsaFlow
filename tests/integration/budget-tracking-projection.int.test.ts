/**
 * Budgets P3 §2.3 on real PostgreSQL: Projected FY on the 14-month FY2027 of
 * helpers/budgetTrackingFixture.ts, with "today" in November 2026 (in
 * progress). The cutoff is the last complete month (31 Oct), whatever the
 * window: the whole year, the in-progress month, and a quarter wholly past
 * (its own end). FY budget is all 14 months. A window ending in a year that
 * has not started projects budget only. Actuals are checked against plain SQL
 * over the posted, non-year-end ledger.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import type { BudgetTrackingReport, TrackingParams } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const NOW = new Date('2026-11-15T10:00:00+02:00');

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const run = (p: TrackingParams) => asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, p, NOW));
const line = (r: BudgetTrackingReport, acct: string) => r.lines.find((l) => l.accountId === acct)!;

/** Posted, non-year-end opex (debit − credit) from `from` to `to`, by plain SQL. */
async function opexActual(from: string, to: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::NUMERIC AS v FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = $1 AND jl.gl_account_id = $2 AND je.status = 'posted' AND je.source IS DISTINCT FROM 'year_end'
        AND je.entry_date BETWEEN $3 AND $4`, [f.a, f.acc.opex, from, to]);
  return Number(rows[0].v);
}

describe('Projected FY on a 14-month year, November in progress', () => {
  it('the whole year: actuals Mar - Oct 2026, budget Nov 2026 - Apr 2027', async () => {
    const r = await run({ period: 'fy', fiscalYear: 2027 });
    expect(r.projection.cutoff).toBe('2026-10-31');
    expect(r.projection.actualMonths.length + r.projection.budgetMonths.length).toBe(14);
    expect(r.projection.budgetMonths[0]).toBe('2026-11');
    const toDate = await opexActual('2026-03-01', '2026-10-31');
    const l = line(r, f.acc.opex);
    expect(l.projected).toBe(Math.round((toDate + 200 * 6) * 100) / 100);
    expect(l.fyBudget).toBe(200 * 14);
    expect(l.projVariance).toBe(Math.round((l.projected - 2800) * 100) / 100);
    expect(r.window.inProgress?.month).toBe('2026-11');
  });

  it("the in-progress month uses its budget, not its part-month actual: same projection as the year's", async () => {
    const year = await run({ period: 'fy', fiscalYear: 2027 });
    const month = await run({ period: 'month', month: '2026-11' });
    expect(month.projection.cutoff).toBe('2026-10-31');
    expect(line(month, f.acc.opex).projected).toBe(line(year, f.acc.opex).projected);
    expect(line(month, f.acc.opex).actual).toBe(await opexActual('2026-11-01', '2026-11-30'));
  });

  it('a quarter wholly past cuts at its own end', async () => {
    const r = await run({ period: 'quarter', fiscalYear: 2027, quarter: 2 });
    expect(r.projection.cutoff).toBe('2026-08-31');
    expect(line(r, f.acc.opex).projected).toBe(Math.round((await opexActual('2026-03-01', '2026-08-31') + 200 * 8) * 100) / 100);
  });

  it('band and net profit projections are the sums of their lines', async () => {
    const r = await run({ period: 'fy', fiscalYear: 2027 });
    const sum = (k: string) => Math.round(r.lines.filter((l) => l.band === k).reduce((s, l) => s + l.projected * 100, 0)) / 100;
    const band = (k: string) => r.bands.find((b) => b.key === k)!;
    expect(band('operating_expense').projected).toBe(sum('operating_expense'));
    const np = sum('turnover') - sum('cost_of_sales') + sum('other_income') - sum('operating_expense') - sum('other_expense');
    expect(band('net_profit').projected).toBe(Math.round(np * 100) / 100);
  });

  // R3 (round 3): "actuals posted through" is the latest posting the filtered Actual consumed IN the
  // in-progress month, forward-dated or not: it never names a posting Actual leaves out, nor omits one it holds.
  const journal = async (c: import('pg').PoolClient, date: string, lines: Array<[string, number, number, { cc1?: string; cc2?: string }]>) => {
    const eid = crypto.randomUUID();
    await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source, created_at)
                   VALUES ($1, $2, $3, $4::DATE, 'posted', $5, 'r3', 'manual', NOW())`, [eid, f.a, `BT-R3-${date}`, date, f.userA]);
    for (const [acct, dr, cr, t] of lines) {
      await c.query(`INSERT INTO gl_journal_lines (id, journal_entry_id, company_id, gl_account_id, debit, credit, cc1_id, cc2_id, description)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'x')`, [crypto.randomUUID(), eid, f.a, acct, dr, cr, t.cc1 ?? null, t.cc2 ?? null]);
    }
  };
  const at = new Date('2026-11-20T10:00:00+02:00');

  it('F2/R3: the in-progress month names its own latest posting in Actual; the window posted-through is always returned', async () => {
    // The fixture posts on the 15th AND on the last day of every month: the 30 Nov opex is in November's Actual.
    const year = await run({ period: 'fy', fiscalYear: 2027 });
    expect(year.window.inProgress).toEqual({ month: '2026-11', actualsTo: '2026-11-30' });
    expect(year.window.postedThrough).toBe('2027-04-30');
    const past = await run({ period: 'quarter', fiscalYear: 2027, quarter: 2 });
    expect(past.window.inProgress).toBeNull();
    expect(past.window.postedThrough).toBe('2026-08-31');
  });

  it('A4/R3: actualsTo follows the filter and the P&L; a forward-dated posting in Actual is named; postedThrough stays company-wide', async () => {
    const go = (p: TrackingParams, before: (c: import('pg').PoolClient) => Promise<unknown>) =>
      asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, p, at), { before });
    // A bank-only transfer on 18 Nov: no income-statement line, never "posted through".
    const transfer = (c: import('pg').PoolClient) => journal(c, '2026-11-18', [[f.acc.bank, 10, 0, {}], [f.acc.bank, 0, 10, {}]]);
    const orphan = await go({ period: 'month', month: '2026-11', cc2Id: f.cc.PN }, transfer);
    expect(orphan.window.inProgress).toEqual({ month: '2026-11', actualsTo: null });
    // P1's only November posting is the 15th's: not the bank-only 18th, not the untagged 30th.
    const p1 = await go({ period: 'month', month: '2026-11', cc2Id: f.cc.P1 }, transfer);
    expect(p1.window.inProgress).toEqual({ month: '2026-11', actualsTo: '2026-11-15' });
    // A P1 sale dated 27 Nov (after today, the 20th) is in Actual, so it is what Actual is posted through.
    const sale = (c: import('pg').PoolClient) => journal(c, '2026-11-27', [[f.acc.sales, 0, 5000, { cc1: f.cc.FT, cc2: f.cc.P1 }], [f.acc.bank, 5000, 0, {}]]);
    const fwd = await go({ period: 'month', month: '2026-11', cc2Id: f.cc.P1 }, sale);
    const sales = (r: BudgetTrackingReport) => r.lines.find((l) => l.accountId === f.acc.sales)!.actual;
    expect(Math.round((sales(fwd) - sales(p1)) * 100)).toBe(500000);
    expect(fwd.window.inProgress).toEqual({ month: '2026-11', actualsTo: '2026-11-27' });
    // window.postedThrough is P0's figure: any posted entry in the window, so the forward-dated 30th.
    expect([orphan.window.postedThrough, p1.window.postedThrough]).toEqual(['2026-11-30', '2026-11-30']);
  });

  it('R3: an in-progress month with no posting is null, never an earlier month of the window', async () => {
    // The ledger stops in July 2027; "today" is 20 Aug 2027, inside a May - Aug window with postings May - Jul.
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'custom', from: '2027-05', to: '2027-08' }, new Date('2027-08-20T10:00:00+02:00')));
    expect(r.lines.some((l) => l.actual !== 0)).toBe(true);
    expect(r.window.inProgress).toEqual({ month: '2027-08', actualsTo: null });
    expect(r.window.postedThrough).toBe('2027-07-31');
  });

  it('a window ending in a year that has not started projects budget only', async () => {
    const r = await run({ period: 'custom', from: '2027-03', to: '2027-07' });
    expect([r.projection.fiscalYear, r.projection.cutoff, r.projection.actualMonths]).toEqual([2028, '2027-04-30', []]);
    expect([line(r, f.acc.opex).projected, line(r, f.acc.opex).fyBudget]).toEqual([210 * 12, 210 * 12]);
  });
});
