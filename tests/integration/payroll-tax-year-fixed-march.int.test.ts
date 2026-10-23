/**
 * The PAYE tax year is March-February for EVERY company, whatever its
 * financial year end. A company whose books run July-June
 * (financial_year_start = 7) must still number payroll periods from March and
 * decide "locked at tax year end" on the last day of February, 29th in a leap
 * year. Calls the real routes on a disposable Postgres. All data synthetic.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import periodContext from '../../pages/api/payroll/period-context';
import yearEndStatus from '../../pages/api/payroll/year-end/status';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { dropSetupUsers, newSetupUser, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users: SetupUser[] = [];

afterAll(async () => {
  try {
    for (const u of users) await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [u.homeCompanyId]);
    await dropSetupUsers(pool, users);
  } finally { await pool.end(); }
});

/** A GET of a withAuth route as `u` in their home company, with a query string. */
async function get(route: unknown, u: SetupUser, url: string, query: Record<string, string> = {}) {
  const req = request({ 'sb-access-token': u.token, active_company_id: u.homeCompanyId }, 'GET') as unknown as
    { url: string; query: Record<string, string> };
  req.url = url;
  req.query = query;
  const out = response();
  await (route as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return { status: out.state.statusCode, body: out.state.body };
}

/** A user in a company on a June year end (start month 7), with no payroll runs. */
async function juneYearEndCompany(): Promise<SetupUser> {
  const u = await newSetupUser(pool);
  users.push(u);
  await pool.query('UPDATE companies SET financial_year_start = 7 WHERE id = $1', [u.homeCompanyId]);
  return u;
}

async function runIn(u: SetupUser, month: number, year: number): Promise<void> {
  await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [u.homeCompanyId]);
  await pool.query(
    `INSERT INTO payroll_run_headers(id, company_id, period_month, period_year, status) VALUES ($1, $2, $3, $4, 'approved')`,
    [crypto.randomUUID(), u.homeCompanyId, month, year]);
}

async function context(u: SetupUser) {
  const out = await get(periodContext, u, '/api/payroll/period-context');
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return (out.body as unknown as { data: { periodNumber: number; periodsInTaxYear: number; taxYearStartMonth: number } }).data;
}

let u: SetupUser;
beforeEach(async () => { u ??= await juneYearEndCompany(); });

describe('period-context numbers payroll periods from March for a June year end', () => {
  it.each([
    [3, 2026, 1, 'March is period 1'],
    [7, 2026, 5, 'July is period 5 (period 1 only for a July-anchored year)'],
    [2, 2027, 12, 'February is period 12'],
  ])('month %i/%i is tax period %i (%s)', async (month, year, period) => {
    await runIn(u, month, year);
    const ctx = await context(u);
    expect(ctx.periodNumber).toBe(period);
    expect(ctx.taxYearStartMonth).toBe(3);
    expect(ctx.periodsInTaxYear).toBe(12);
  });

  it('with no run yet, numbers the current calendar month from March', async () => {
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [u.homeCompanyId]);
    const month = new Date().getMonth() + 1;
    expect((await context(u)).periodNumber).toBe(((month + 9) % 12) + 1);
  });
});

describe('year-end status decides "locked at tax year end" on the last day of February', () => {
  async function lockedOn(taxYear: number, lockdownDate: string): Promise<boolean> {
    await pool.query(`UPDATE companies SET lockdown_enabled = true, lockdown_date = $2 WHERE id = $1`, [u.homeCompanyId, lockdownDate]);
    const out = await get(yearEndStatus, u, '/api/payroll/year-end/status', { taxYear: String(taxYear) });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    return (out.body as unknown as { data: { periodLock: { locked: boolean } } }).data.periodLock.locked;
  }

  it('28 February closes a common tax year', async () => {
    expect(await lockedOn(2027, '2027-02-28')).toBe(true);
    expect(await lockedOn(2027, '2027-02-27')).toBe(false);
  });

  it('28 February does NOT close a leap tax year; 29 February does', async () => {
    expect(await lockedOn(2028, '2028-02-28')).toBe(false);
    expect(await lockedOn(2028, '2028-02-29')).toBe(true);
  });
});
