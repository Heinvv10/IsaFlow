/**
 * A new company's fiscal periods follow the financial year start it chose.
 *
 * The real flow: email verification provisions a placeholder tenant
 * (provisionTenant), then the onboarding wizard's complete-setup creates the
 * company the user works in (create_company_with_owner, whose taxonomy seeder
 * writes January–December). Because resolveCompanyPeriodAlignment follows the
 * existing layout, that calendar first year kept every later year on January
 * while the company declared March.
 *
 * Disposable schema fixture only (assertDisposable). The real withAuth runs.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { provisionTenant } from '@/modules/onboarding/services/tenantProvisioningService';
import { ensureFiscalPeriodForDate } from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';
import {
  FiscalPeriodsInUseError, rebuildUnusedFiscalPeriods,
} from '@/modules/accounting/services/gl/fiscalYearStartChange';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';
import { callSetup, dropSetupUsers, setupBody, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users: SetupUser[] = [];

afterAll(async () => {
  try {
    for (const u of users) {
      const owned = (await pool.query('SELECT company_id FROM company_users WHERE user_id = $1', [u.userId])).rows
        .map((r: { company_id: string }) => r.company_id);
      for (const id of owned) {
        for (const t of ['close_runs', 'gl_journal_entries', 'subscriptions']) {
          await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [id]);
        }
      }
    }
    await dropSetupUsers(pool, users);
  } finally { await pool.end(); }
}, 60000);

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = new Date();
const TODAY_ISO = iso(TODAY);
const y = TODAY.getFullYear();

interface PeriodRow { period_number: number; fiscal_year: number; start_date: string; end_date: string }
async function periodsOf(companyId: string): Promise<PeriodRow[]> {
  return (await pool.query(
    `SELECT period_number, fiscal_year, start_date::text AS start_date, end_date::text AS end_date
       FROM fiscal_periods WHERE company_id = $1 ORDER BY start_date`, [companyId])).rows;
}

/** Twelve monthly periods, numbered 1..12, each starting the day after the previous one ends. */
async function expectOneContiguousYear(companyId: string, fiscalYear: number) {
  const gaps = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT start_date, LAG(end_date) OVER (ORDER BY start_date) AS prev_end
         FROM fiscal_periods WHERE company_id = $1 AND fiscal_year = $2) s
      WHERE prev_end IS NOT NULL AND start_date <> prev_end + 1`, [companyId, fiscalYear])).rows[0].n;
  expect(gaps).toBe(0);
  const rows = (await periodsOf(companyId)).filter((p) => p.fiscal_year === fiscalYear);
  expect(rows.map((p) => p.period_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  return rows;
}

/** A signup exactly as verify-email does it: provisionTenant on a BYPASSRLS client, in its own transaction. */
async function provisionedUser(): Promise<SetupUser> {
  const userId = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await provisionTenant(client, {
      ownerUserId: userId, email: `${userId}@test.local`, firstName: 'FY', lastName: 'Start',
      companyName: `FYSTART placeholder ${userId}`, phone: null, annualTurnoverCents: null, signupType: 'direct',
    });
    await client.query('COMMIT');
    const u = { userId, homeCompanyId: out.companyId, token: await signSession(userId, undefined, 'aal2') };
    users.push(u);
    return u;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

async function completeSetup(u: SetupUser, financialYearStart: number): Promise<string> {
  const base = setupBody('other');
  const out = await callSetup(u, { ...base, company: { ...base.company, financialYearStart } });
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return out.body.data!.companyId!;
}

describe('a new company\'s fiscal periods follow its financial year start', () => {
  // The fiscal year containing today, computed here by hand (not by fiscalYearCalendar).
  const marchStartYear = TODAY.getMonth() + 1 >= 3 ? y : y - 1;

  it('FY start 3: provisioning and complete-setup both build 1 March, 12 contiguous periods covering today', async () => {
    const u = await provisionedUser();
    // The placeholder declares the column default, 3, and its periods agree.
    const placeholder = await expectOneContiguousYear(u.homeCompanyId, marchStartYear + 1);
    expect(placeholder[0]!.start_date).toBe(`${marchStartYear}-03-01`);

    const companyId = await completeSetup(u, 3);
    const all = await periodsOf(companyId);
    expect(all).toHaveLength(12); // the seeder's two calendar years are gone, not added to
    const year = await expectOneContiguousYear(companyId, marchStartYear + 1);
    expect(year[0]!.start_date).toBe(`${marchStartYear}-03-01`);
    expect(year[11]!.start_date).toBe(`${marchStartYear + 1}-02-01`);
    expect(year[0]!.start_date <= TODAY_ISO && TODAY_ISO <= year[11]!.end_date).toBe(true);

    // A later year created on demand (a journal dated in the next fiscal year) keeps the March layout.
    const nextYearDate = `${marchStartYear + 1}-04-15`;
    const periodId = await ensureFiscalPeriodForDate(companyId, nextYearDate);
    expect(periodId).toBeTruthy();
    const next = await expectOneContiguousYear(companyId, marchStartYear + 2);
    expect(next[0]!.start_date).toBe(`${marchStartYear + 1}-03-01`);
    expect(next[0]!.start_date).toBe(
      (await pool.query(`SELECT ($1::date + 1)::text AS d`, [year[11]!.end_date])).rows[0].d);
  });

  it('FY start 1: the calendar year containing today', async () => {
    const u = await provisionedUser();
    const companyId = await completeSetup(u, 1);
    expect(await periodsOf(companyId)).toHaveLength(12);
    const year = await expectOneContiguousYear(companyId, y);
    expect(year[0]!.start_date).toBe(`${y}-01-01`);
    expect(year[11]!.end_date).toBe(`${y}-12-31`);
  });
});

describe('rebuildUnusedFiscalPeriods refuses periods already in use', () => {
  /** Runs `fn` as a request would (ALS client in a transaction) and always rolls back. */
  async function inRequest<T>(userId: string, fn: () => Promise<T>): Promise<{ result?: T; error?: unknown }> {
    const client = await pool.connect();
    const out: { result?: T; error?: unknown } = {};
    try {
      await client.query('BEGIN');
      await als.run({ client, userId, claims: { sub: userId } }, async () => {
        try { out.result = await fn(); } catch (err) { out.error = err; }
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    return out;
  }

  it.each([
    ['a draft journal', `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status)
                          VALUES ($1, $2::date, $3, 'fy-start probe', 'draft')`],
    // close_runs CASCADEs from fiscal_periods: only the guard stops the DELETE taking it with it.
    ['a close run', `INSERT INTO close_runs (company_id, fiscal_period_id, period_label, created_by)
                     SELECT $1, id, 'probe', $3 FROM fiscal_periods
                      WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date`],
  ])('refuses with %s, and leaves the periods as they were', async (_label, insert) => {
    const u = await provisionedUser();
    const companyId = await completeSetup(u, 3);
    const before = await periodsOf(companyId);
    await pool.query(insert, [companyId, TODAY_ISO, u.userId]);

    const out = await inRequest(u.userId, () => rebuildUnusedFiscalPeriods(companyId, new Date(y + 1, 6, 1)));
    expect(out.error).toBeInstanceOf(FiscalPeriodsInUseError);
    expect(await periodsOf(companyId)).toEqual(before);
    for (const t of ['close_runs', 'gl_journal_entries']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [companyId]);
  });

  it('rebuilds when nothing refers to the periods', async () => {
    const u = await provisionedUser();
    const companyId = await completeSetup(u, 3);
    await pool.query('UPDATE companies SET financial_year_start = 7 WHERE id = $1', [companyId]);
    const out = await inRequest(u.userId, async () => {
      await rebuildUnusedFiscalPeriods(companyId, new Date(2026, 9, 22));
      const { rows } = await als.getStore()!.client.query(
        `SELECT MIN(start_date)::text AS s, COUNT(*)::int AS n FROM fiscal_periods WHERE company_id = $1`, [companyId]);
      return rows[0] as { s: string; n: number };
    });
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ s: '2026-07-01', n: 12 });
  });

  it('refuses to run outside a request transaction', async () => {
    await expect(rebuildUnusedFiscalPeriods(crypto.randomUUID())).rejects.toThrow(/request transaction/);
  });
});
