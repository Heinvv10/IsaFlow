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

  it('F2: "actuals posted through" is bounded by today; the window posted-through is always returned', async () => {
    // The fixture posts on the 15th AND on the last day of every month through Jul 2027: forward-dated from 15 Nov 2026.
    const year = await run({ period: 'fy', fiscalYear: 2027 });
    expect(year.window.inProgress).toEqual({ month: '2026-11', actualsTo: '2026-11-15' });
    expect(year.window.postedThrough).toBe('2027-04-30');
    const past = await run({ period: 'quarter', fiscalYear: 2027, quarter: 2 });
    expect(past.window.inProgress).toBeNull();
    expect(past.window.postedThrough).toBe('2026-08-31');
  });

  it('A4: "actuals posted through" follows the filter and the P&L; window.postedThrough stays company-wide', async () => {
    const at = new Date('2026-11-20T10:00:00+02:00');
    // A bank-only transfer on 18 Nov: no income-statement line.
    const transfer = async (c: import('pg').PoolClient) => {
      const eid = crypto.randomUUID();
      await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source, created_at)
                     VALUES ($1, $2, 'BT-A4', '2026-11-18', 'posted', $3, 'bank transfer', 'manual', NOW())`, [eid, f.a, f.userA]);
      await c.query(`INSERT INTO gl_journal_lines (id, journal_entry_id, company_id, gl_account_id, debit, credit, description)
                     VALUES ($1, $2, $3, $4, 10, 0, 'x'), ($5, $2, $3, $4, 0, 10, 'x')`, [crypto.randomUUID(), eid, f.a, f.acc.bank, crypto.randomUUID()]);
    };
    const go = (p: TrackingParams) => asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, p, at), { before: transfer });
    // The orphan project has no posting: nothing is posted through, whatever the company posted.
    const orphan = await go({ period: 'month', month: '2026-11', cc2Id: f.cc.PN });
    expect(orphan.window.inProgress).toEqual({ month: '2026-11', actualsTo: null });
    // Unfiltered: the 15th's P&L journal, not the bank-only 18th, nor the forward-dated 30th.
    const all = await go({ period: 'month', month: '2026-11' });
    expect(all.window.inProgress).toEqual({ month: '2026-11', actualsTo: '2026-11-15' });
    // window.postedThrough is P0's figure: any posted entry in the window, so the forward-dated 30th.
    expect([orphan.window.postedThrough, all.window.postedThrough]).toEqual(['2026-11-30', '2026-11-30']);
  });

  it('a window ending in a year that has not started projects budget only', async () => {
    const r = await run({ period: 'custom', from: '2027-03', to: '2027-07' });
    expect([r.projection.fiscalYear, r.projection.cutoff, r.projection.actualMonths]).toEqual([2028, '2027-04-30', []]);
    expect([line(r, f.acc.opex).projected, line(r, f.acc.opex).fyBudget]).toEqual([210 * 12, 210 * 12]);
  });
});
