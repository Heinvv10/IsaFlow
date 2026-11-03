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
 * Round 1 (adversarial repros, real fiscal_year_for_date / template): a registry gap holding the 1st
 * stays readable; a first STORED year starting mid-month keeps its first month (the 1st is in a
 * template year, so the stored year owns it); the comparator's mode judges the owning year.
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

describe('round 1: template years and gaps (real fiscal_year_for_date)', () => {
  /** FY2026 (no primary in the fixture) starts 15 Mar 2025, the first stored year: 1 Mar 2025 is a template year's. */
  const firstStoredMidMonth = async (c: PoolClient) => {
    await c.query(`UPDATE fiscal_years SET start_date = '2025-03-15' WHERE company_id = $1 AND fiscal_year = 2026`, [f.a]);
    const v = await c.query(`INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
                             VALUES ($1, 2026, 'Original', 'original', true, $2) RETURNING id`, [f.a, f.userA]);
    await c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
                   VALUES ($1, $2, $3, '2025-03-01', 500), ($1, $2, $3, '2025-04-01', 1000)`, [f.a, String(v.rows[0].id), f.acc.opex]);
  };
  const read = (start: string, end: string, before: (c: PoolClient) => Promise<void>) => asRequest(pool, f.a, f.userA, async () => {
    const r = await getBudgetVariance(f.a, start, end);
    return r.lines.find((l) => l.account_id === f.acc.opex)?.budget_amount;
  }, { before });

  it('a first stored year starting mid-month owns its first month from any start day (master: 1000 from the 1st)', async () => {
    expect(await read('2025-03-15', '2025-04-30', firstStoredMidMonth)).toBe(1500);
    expect(await read('2025-03-01', '2025-04-30', firstStoredMidMonth)).toBe(1500);
    expect(await read('2025-03-20', '2025-03-31', firstStoredMidMonth)).toBe(500);
    expect(await read('2025-03-01', '2025-03-10', firstStoredMidMonth)).toBe(500);
  });

  it('a registry gap holding the 1st is not a 400: the window after it reads the year it starts in', async () => {
    const gap = async (c: PoolClient) => {
      await c.query(`UPDATE fiscal_years SET end_date = '2026-02-25' WHERE company_id = $1 AND fiscal_year = 2026`, [f.a]);
      await c.query(`UPDATE fiscal_years SET start_date = '2026-03-05' WHERE company_id = $1 AND fiscal_year = 2027`, [f.a]);
    };
    // FY2027's opex is 200 a month: March and April.
    expect(await read('2026-03-10', '2026-04-30', gap)).toBe(400);
  });

  it("the comparator's mode inside the shared month: the owner's version, no year called absent", async () => {
    const r = await asRequest(pool, f.a, f.userA, () => getBudgetVariance(f.a, '2027-05-20', '2027-05-31', { partialWindow: 'absent' }), { before: midMonth });
    expect([r.fiscalYear, r.years, r.budgetAbsentYears, r.version?.id]).toEqual([2028, [2027], [], f.v.primary27]);
  });
});
