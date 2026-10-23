/**
 * The PAYE tax year is March-February for EVERY company, whatever its
 * financial year end. A company whose books run July-June
 * (financial_year_start = 7) must still number payroll periods from March and
 * decide "locked at tax year end" on the last day of February, 29th in a leap
 * year. Calls the real routes on a disposable Postgres. All data synthetic.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** A user in a company with the given financial_year_start (7 = a June year end; null = never declared), with no payroll runs. */
async function companyStarting(month: number | null): Promise<SetupUser> {
  const u = await newSetupUser(pool);
  users.push(u);
  await pool.query('UPDATE companies SET financial_year_start = $2 WHERE id = $1', [u.homeCompanyId, month]);
  return u;
}
const juneYearEndCompany = () => companyStarting(7);

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

  it('February 2028 (a leap February) is period 12 of the 2028 tax year', async () => {
    await runIn(u, 2, 2028);
    const ctx = await context(u) as { periodNumber: number; periodYear: number };
    expect(ctx.periodNumber).toBe(12);
    expect(ctx.periodYear).toBe(2028);
  });

  it('a company that never declared a financial year start is numbered from March too', async () => {
    const undeclared = await companyStarting(null);
    for (const [month, year, period] of [[3, 2026, 1], [9, 2026, 7], [2, 2027, 12]] as const) {
      await runIn(undeclared, month, year);
      expect((await context(undeclared)).periodNumber, `${month}/${year}`).toBe(period);
    }
  });

  it.each([
    ['2026-03-01T10:00:00', 1],
    ['2026-09-15T10:00:00', 7],
    ['2026-02-28T10:00:00', 12],
  ])('with no run yet, %s is tax period %i', async (now, period) => {
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [u.homeCompanyId]);
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
    try {
      expect((await context(u)).periodNumber).toBe(period);
    } finally { vi.useRealTimers(); }
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

  it('the same holds for a company that never declared a financial year start', async () => {
    const undeclared = await companyStarting(null);
    const prior = u;
    u = undeclared;
    try {
      expect(await lockedOn(2027, '2027-02-28')).toBe(true);
      expect(await lockedOn(2028, '2028-02-28')).toBe(false);
      expect(await lockedOn(2028, '2028-02-29')).toBe(true);
    } finally { u = prior; }
  });
});
