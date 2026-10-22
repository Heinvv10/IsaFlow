/**
 * Shared fixture for the financial-year-start suites: an onboarded company the
 * user works in (FY start 3, 12 March-aligned periods), the companies route
 * called as the settings page calls it, and readers of what is stored.
 * All values are synthetic.
 */
import { expect } from 'vitest';
import type { Pool } from 'pg';
import companiesRoute from '../../../pages/api/accounting/companies';
import { request, response } from '../mfa-impersonation-postgres.helpers';
import { callRoute, callSetup, dropSetupUsers, newSetupUser, setupBody, type SetupUser } from './onboardingSetupFixture';

/** Rows the suites write that dropSetupUsers does not remove. */
const EXTRA_TABLES = ['close_runs', 'gl_journal_entries', 'accounting_budgets', 'afs_documents', 'disclosure_notes_manual'];

export function financialYearFixture(pool: Pool) {
  const users: SetupUser[] = [];

  /** A user who finished onboarding with FY start 3, working in the new company (its active-company cookie). */
  async function onboarded(): Promise<{ u: SetupUser; companyId: string; homeCompanyId: string }> {
    const home = await newSetupUser(pool);
    users.push(home);
    const out = await callSetup(home, setupBody('other'));
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const companyId = out.body.data!.companyId!;
    return { u: { ...home, homeCompanyId: companyId }, companyId, homeCompanyId: home.homeCompanyId };
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

  /** Replace the company's periods with January–December of the current year (the legacy layout). */
  async function makeCalendarPeriods(companyId: string): Promise<void> {
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [companyId]);
    await pool.query(
      `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
       SELECT $1, TO_CHAR(d, 'FMMonth YYYY'), m, EXTRACT(YEAR FROM CURRENT_DATE)::int, d,
              (d + INTERVAL '1 month' - INTERVAL '1 day')::date, 'open'
         FROM generate_series(1, 12) m,
              LATERAL (SELECT MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int, m, 1) AS d) x`, [companyId]);
  }

  async function cleanup(): Promise<void> {
    for (const u of users) {
      const owned = (await pool.query('SELECT company_id FROM company_users WHERE user_id = $1', [u.userId])).rows
        .map((r: { company_id: string }) => r.company_id);
      for (const id of owned) for (const t of EXTRA_TABLES) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [id]);
    }
    await dropSetupUsers(pool, users);
  }

  return { users, onboarded, put, getCompany, stored, journal, makeCalendarPeriods, cleanup };
}
