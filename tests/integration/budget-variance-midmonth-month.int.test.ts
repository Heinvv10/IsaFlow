/**
 * Budgets P3 follow-up, ledger LB-2(b), on real PostgreSQL: in getBudgetVariance's DEFAULT mode
 * (MCP budget_variance, the packs) a calendar month two registry years share reads ONE version,
 * whatever day the window starts. The month belongs to the year holding its 1st (the earlier year),
 * the key a change of year end files a month under (`budgetYearRehome`). Before the fix a window
 * starting on or after the later year's first day read the LATER year's version for that month.
 *
 * Registry (per test, rolled back): FY2027 ends 14 May 2027, FY2028 starts 15 May 2027. Opex is
 * budgeted for May 2027 in both primaries: FY2027 230 (written here), FY2028 210 (the fixture's).
 *
 * Seed: helpers/budgetTrackingFixture.ts. Fixture route: isaflow_schema_fixture (assertDisposable).
 * Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const midMonth = async (c: PoolClient) => {
  // FY2028 shrinks first, so the two years never overlap (fiscal_years_no_overlap).
  await c.query(`UPDATE fiscal_years SET start_date = '2027-05-15' WHERE company_id = $1 AND fiscal_year = 2028`, [f.a]);
  await c.query(`UPDATE fiscal_years SET end_date = '2027-05-14' WHERE company_id = $1 AND fiscal_year = 2027`, [f.a]);
  await c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
                 VALUES ($1, $2, $3, '2027-05-01', 230)`, [f.a, f.v.primary27, f.acc.opex]);
};

const opexBudget = (start: string, end: string) => asRequest(pool, f.a, f.userA, async () => {
  const r = await getBudgetVariance(f.a, start, end);
  return { fiscalYear: r.fiscalYear, budget: r.lines.find((l) => l.account_id === f.acc.opex)?.budget_amount };
}, { before: midMonth });

describe('default mode: a shared month reads the year holding its 1st', () => {
  it('May 2027 is FY2027\'s (230) from the 1st, the 10th and the 15th (FY2028\'s first day); June is FY2028\'s (210)', async () => {
    const fromFirst = await opexBudget('2027-05-01', '2027-06-30');
    const fromTenth = await opexBudget('2027-05-10', '2027-06-30');
    const fromFifteenth = await opexBudget('2027-05-15', '2027-06-30');
    expect([fromFirst.budget, fromTenth.budget, fromFifteenth.budget]).toEqual([440, 440, 440]);
    // P0's fiscalYear is still the year holding the window's first DAY.
    expect([fromFirst.fiscalYear, fromTenth.fiscalYear, fromFifteenth.fiscalYear]).toEqual([2027, 2027, 2028]);
  });

  it('a window inside the shared month alone, starting in FY2028, reads FY2027\'s May', async () => {
    expect(await opexBudget('2027-05-20', '2027-05-31')).toEqual({ fiscalYear: 2028, budget: 230 });
  });
});
