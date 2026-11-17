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

  /**
   * Month amounts on the year's PRIMARY version, written directly, with the year's notes header when
   * `notes` is given. The suites' setup, now that the legacy writers are gone. When the year has no
   * primary, public.budget_version_original creates one as migration 947 converted legacy budgets:
   * an APPROVED primary 'Original' (approved_by / created_by the user), not the draft the wizard
   * makes. Amount rows carry `created_by`, as the app's writers set it.
   */
  async function seedPrimary(u: SetupUser, account: string, label: number, months: Array<{ month: string; amount: number }>, notes?: string): Promise<string> {
    const version = String((await pool.query('SELECT public.budget_version_original($1, $2, $3) AS id', [u.homeCompanyId, label, u.userId])).rows[0].id);
    await pool.query(
      `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, created_by)
       SELECT $1, $2, $3, (m || '-01')::DATE, a, $6 FROM unnest($4::TEXT[], $5::NUMERIC[]) AS t(m, a)
       ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell DO UPDATE SET amount = EXCLUDED.amount`,
      [u.homeCompanyId, version, account, months.map((m) => m.month), months.map((m) => m.amount), u.userId]);
    if (notes !== undefined) {
      await pool.query(
        `INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [u.homeCompanyId, `FY${label} Budget`, label, account, notes, u.userId]);
    }
    return version;
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
      await dropJournals(id);
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

  /**
   * The company's journals, BEFORE its periods: deleting the periods sets a posted journal's period to NULL, and that
   * journal then stays in the shared fixture, where the deploy integrity check "Posted JE fiscal period matches entry
   * date" (demo-reseed) fails on it for every suite that runs after (merge queue, PR #1551). Replica role: posted
   * journals and their lines refuse DELETE otherwise, as in budgetBillFixture.dropBillFixture.
   */
  async function dropJournals(companyId: string): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [companyId]);
      await c.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [companyId]);
      await c.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [companyId]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  return { call, owner, cleanup, seedPrimary };
}
