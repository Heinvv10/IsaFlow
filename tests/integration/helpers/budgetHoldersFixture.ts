/**
 * Shared by the budgets P5-6 suites (budget holders, slice reviews, reminders): budgetGridSaveFixture's
 * world (a March company, its owner, accounts, CC1/CC2/BU) plus any route called as a real member
 * through withAuth, holders and slices written directly, and statements run AS app_user with a
 * member's claims (the database rules on their own). Real PostgreSQL; synthetic rows only.
 */
import type { Pool, PoolClient } from 'pg';
import { request, response } from '../mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './budgetGridSaveFixture';
import { withJsonBody } from './budgetGridFixture';
import type { RouteOut } from './budgetsRouteFixture';
import type { SetupUser } from './onboardingSetupFixture';

export type { GridWorld };

export function budgetHoldersFixture(pool: Pool, saveRoute: unknown) {
  const base = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');
  const worlds: GridWorld[] = [];

  async function world(): Promise<GridWorld> {
    const w = await base.world();
    worlds.push(w);
    return w;
  }

  /** Calls `route` as `u`; `query` carries the dynamic segments too. */
  async function call(route: unknown, u: SetupUser, method: string, opts: { body?: unknown; query?: Record<string, string>; url?: string } = {}): Promise<RouteOut> {
    const req = Object.assign(request({ 'sb-access-token': u.token, active_company_id: u.homeCompanyId }, method),
      { url: opts.url ?? '/api/accounting/budgets/fixture', query: opts.query ?? {} });
    const out = response();
    await (route as (a: never, b: never) => Promise<unknown>)(withJsonBody(req, opts.body) as never, out.res as never);
    return { status: out.state.statusCode, body: (out.state.body ?? {}) as RouteOut['body'] };
  }

  /** A holder row and its slice review ('open'), written directly (the route is tested on its own). */
  async function hold(w: GridWorld, versionId: string, userId: string, dims: { cc1?: string; cc2?: string; bu?: string } = {},
    opts: { accounts?: string[]; due?: string } = {}): Promise<string> {
    await pool.query(
      `INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, cc2_id, bu_id, gl_account_ids, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT ON CONSTRAINT budget_holders_one_per_slice DO NOTHING`,
      [w.u.homeCompanyId, versionId, userId, dims.cc1 ?? null, dims.cc2 ?? null, dims.bu ?? null, opts.accounts ?? null, w.u.userId]);
    return String((await pool.query(
      `INSERT INTO budget_slice_reviews (company_id, version_id, cc1_id, cc2_id, bu_id, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ON CONSTRAINT budget_slice_reviews_one_per_slice DO UPDATE SET due_date = EXCLUDED.due_date RETURNING id`,
      [w.u.homeCompanyId, versionId, dims.cc1 ?? null, dims.cc2 ?? null, dims.bu ?? null, opts.due ?? null, w.u.userId])).rows[0].id);
  }

  /** Moves a slice directly, as `actor` (the stamp trigger needs a session user). */
  async function setStatus(sliceId: string, status: string, actor: string, note: string | null = null): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor })]);
      // A submit carries no note (955: a status move changes nothing else; the stamp trigger clears it).
      await c.query(`UPDATE budget_slice_reviews SET status = $2::TEXT,
                            decision_note = CASE WHEN $2::TEXT = 'submitted' THEN decision_note ELSE $3 END WHERE id = $1`, [sliceId, status, note]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally { c.release(); }
  }

  const status = async (sliceId: string): Promise<string> =>
    String((await pool.query('SELECT status FROM budget_slice_reviews WHERE id = $1', [sliceId])).rows[0]?.status);

  /** `fn` in one transaction AS app_user with `u`'s claims in `u`'s company; rolled back unless `commit`. */
  async function asMember<T>(u: SetupUser, fn: (c: PoolClient) => Promise<T>, commit = false): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.userId })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [u.homeCompanyId]);
      const out = await fn(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally { c.release(); }
  }

  const notes = async (companyId: string, userId: string) => (await pool.query(
    `SELECT kind, title, dedupe_key FROM user_notifications WHERE company_id = $1 AND user_id = $2 ORDER BY created_at, dedupe_key`,
    [companyId, userId])).rows as Array<{ kind: string; title: string; dedupe_key: string }>;

  async function cleanup(): Promise<void> {
    for (const w of worlds) {
      const c = w.u.homeCompanyId;
      // Slices first: the amount guard refuses removing a submitted slice's amounts (no reviewer here).
      await pool.query('DELETE FROM budget_slice_reviews WHERE company_id = $1', [c]);
      await pool.query('DELETE FROM budget_holders WHERE company_id = $1', [c]);
      await pool.query('DELETE FROM user_notifications WHERE company_id = $1', [c]);
    }
    await base.cleanup();
  }

  return { ...base, world, call, hold, setStatus, status, asMember, notes, cleanup };
}

export const errCodeOf = (r: RouteOut) => (r.body.error as { details?: { code?: string } } | undefined)?.details?.code;
export const insertAmountSql = `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id, bu_id)
  VALUES ($1, $2, $3, ($4 || '-01')::DATE, $5, $6, $7, $8)`;
