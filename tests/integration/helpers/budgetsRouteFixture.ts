/**
 * Shared by the budgets route integration tests: calls a budgets route as a
 * real owner (real withAuth, request transaction, CSRF) of a fresh March company.
 */
import type { Pool } from 'pg';
import { request, response } from '../mfa-impersonation-postgres.helpers';
import { newSetupUser, type SetupUser } from './onboardingSetupFixture';

export type RouteOut = { status: number; body: { data?: Record<string, unknown>; error?: { message?: string } } };

export function budgetsRouteFixture(pool: Pool, route: unknown, url: string) {
  const made: string[] = [];
  const users: string[] = [];

  async function call(u: SetupUser, method: string, body?: unknown, query: Record<string, string> = {}): Promise<RouteOut> {
    const req = request({ 'sb-access-token': u.token, active_company_id: u.homeCompanyId }, method) as unknown as
      { url: string; query: Record<string, string>; body: unknown };
    req.url = url;
    req.query = query;
    req.body = body;
    const out = response();
    await (route as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    return { status: out.state.statusCode, body: (out.state.body ?? {}) as RouteOut['body'] };
  }

  /** An owner of a fresh March company with an expense account; its current year generated. */
  async function owner(): Promise<{ u: SetupUser; account: string; label: number; months: string[] }> {
    const u = await newSetupUser(pool);
    users.push(u.userId);
    made.push(u.homeCompanyId);
    await pool.query('UPDATE companies SET financial_year_start = 3 WHERE id = $1', [u.homeCompanyId]);
    // Two statements: a row the function inserts is not visible to the statement that called it.
    const yearId = (await pool.query('SELECT public.fiscal_year_ensure($1, CURRENT_DATE) AS id', [u.homeCompanyId])).rows[0].id;
    const year = (await pool.query('SELECT fiscal_year, start_date::text s FROM fiscal_years WHERE id = $1', [yearId])).rows[0];
    const account = (await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, 'BR-5000', 'Rent', 'expense', 'debit', 3, true) RETURNING id`, [u.homeCompanyId])).rows[0].id;
    const start = new Date(`${year.s}T00:00:00Z`);
    const months = Array.from({ length: 12 }, (_, i) =>
      new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
    return { u, account, label: Number(year.fiscal_year), months };
  }

  async function cleanup(): Promise<void> {
    for (const id of made) {
      // Locked versions refuse DELETE (migration 947): unlock first, as QA purges do.
      await pool.query(
        `UPDATE budget_versions SET status = 'approved', unlocked_by = locked_by, unlocked_at = clock_timestamp(), unlock_reason = 'test cleanup'
          WHERE company_id = $1 AND status = 'locked'`, [id]);
      await pool.query('DELETE FROM budget_month_amounts WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM budget_versions WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM accounting_budgets WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
    }
    for (const u of users) await pool.query('DELETE FROM company_users WHERE user_id = $1', [u]);
  }

  return { call, owner, cleanup };
}
