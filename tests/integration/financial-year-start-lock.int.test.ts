/**
 * The financial year start is locked once a company has posted a journal, and
 * before that a change rebuilds the periods so they follow it.
 *
 * resolveCompanyPeriodAlignment builds every new year on the layout of the
 * EXISTING periods, so an edit of financial_year_start that left the periods
 * alone silently changed nothing in the books: the declared year and the real
 * one drifted apart. PUT /api/accounting/companies (the one writer of the
 * column after creation) now refuses a change after the first posting with a
 * 409, and before it rebuilds the periods in the same transaction.
 *
 * Disposable schema fixture only (assertDisposable). The real withAuth runs.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import companiesRoute from '../../pages/api/accounting/companies';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import {
  callRoute, callSetup, dropSetupUsers, newSetupUser, setupBody, type SetupUser,
} from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users: SetupUser[] = [];

afterAll(async () => {
  try {
    for (const u of users) {
      const owned = (await pool.query('SELECT company_id FROM company_users WHERE user_id = $1', [u.userId])).rows
        .map((r: { company_id: string }) => r.company_id);
      for (const id of owned) await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [id]);
    }
    await dropSetupUsers(pool, users);
  } finally { await pool.end(); }
}, 60000);

/** A user who has finished onboarding with FY start 3, working in the new company (its active-company cookie). */
async function onboarded(): Promise<{ u: SetupUser; companyId: string }> {
  const home = await newSetupUser(pool);
  users.push(home);
  const out = await callSetup(home, setupBody('other'));
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  const companyId = out.body.data!.companyId!;
  return { u: { ...home, homeCompanyId: companyId }, companyId };
}

const put = (u: SetupUser, body: Record<string, unknown>) =>
  callRoute(companiesRoute, u, body, '/api/accounting/companies', 'PUT');

/** GET ?id= as the settings page loads it. */
async function getCompany(u: SetupUser, id: string) {
  const req = request({ 'sb-access-token': u.token, active_company_id: u.homeCompanyId }, 'GET') as unknown as
    { url: string; query: Record<string, string> };
  req.url = `/api/accounting/companies?id=${id}`;
  req.query = { id };
  const out = response();
  await (companiesRoute as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return { status: out.state.statusCode, body: (out.state.body ?? {}) as { data?: Record<string, unknown> } };
}

const stored = async (companyId: string) => (await pool.query(
  `SELECT c.financial_year_start AS fy, c.trading_name,
          (SELECT EXTRACT(MONTH FROM MIN(start_date))::int FROM fiscal_periods WHERE company_id = c.id) AS first_month,
          (SELECT COUNT(*)::int FROM fiscal_periods WHERE company_id = c.id) AS periods
     FROM companies c WHERE c.id = $1`, [companyId])).rows[0];

const journal = (companyId: string, userId: string, status: 'draft' | 'posted') => pool.query(
  `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status)
   VALUES ($1, CURRENT_DATE, $2, 'fy-lock probe', $3)`, [companyId, userId, status]);

describe('PUT /api/accounting/companies: financialYearStart', () => {
  it('before any posting, a change is saved and the periods are rebuilt on the new month', async () => {
    const { u, companyId } = await onboarded();
    expect((await getCompany(u, companyId)).body.data!.financialYearStartLocked).toBe(false);

    const out = await put(u, { id: companyId, financialYearStart: 6 });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(await stored(companyId)).toMatchObject({ fy: 6, first_month: 6, periods: 12 });
  });

  it('after a posted journal, a change is refused with a 409 and nothing is written', async () => {
    const { u, companyId } = await onboarded();
    await journal(companyId, u.userId, 'posted');
    const before = await stored(companyId);
    expect((await getCompany(u, companyId)).body.data!.financialYearStartLocked).toBe(true);

    const out = await put(u, { id: companyId, financialYearStart: 9, tradingName: 'must not land' });
    expect(out.status, JSON.stringify(out.body)).toBe(409);
    expect(out.body.error?.message).toMatch(/after the first posting.*guided change of year end/);
    expect(await stored(companyId)).toEqual(before);
  });

  it('after a posted journal, re-sending the SAME start month (a normal settings save) still saves', async () => {
    const { u, companyId } = await onboarded();
    await journal(companyId, u.userId, 'posted');
    const out = await put(u, { id: companyId, financialYearStart: 3, tradingName: 'Saved Trading' });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(await stored(companyId)).toMatchObject({ fy: 3, trading_name: 'Saved Trading', first_month: 3 });
  });

  it('with only a draft journal, a change is refused with a 409 (its period is in use) and nothing is written', async () => {
    const { u, companyId } = await onboarded();
    await journal(companyId, u.userId, 'draft');
    const before = await stored(companyId);
    expect((await getCompany(u, companyId)).body.data!.financialYearStartLocked).toBe(false);

    const out = await put(u, { id: companyId, financialYearStart: 9 });
    expect(out.status, JSON.stringify(out.body)).toBe(409);
    expect(out.body.error?.message).toMatch(/draft journals/);
    expect(await stored(companyId)).toEqual(before);
  });

  it('refuses a start month that is not a month', async () => {
    const { u, companyId } = await onboarded();
    const out = await put(u, { id: companyId, financialYearStart: 13 });
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    expect((await stored(companyId)).fy).toBe(3);
  });

  it('refuses a change to a company other than the active one (its periods are written under the active RLS scope)', async () => {
    const { u, companyId } = await onboarded();
    const asHome = { ...u, homeCompanyId: users.find((x) => x.userId === u.userId)!.homeCompanyId };
    const out = await put(asHome, { id: companyId, financialYearStart: 6 });
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    expect(await stored(companyId)).toMatchObject({ fy: 3, first_month: 3 });
  });
});
