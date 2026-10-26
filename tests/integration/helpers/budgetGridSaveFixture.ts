/**
 * Shared by budget-grid-save and budget-grid-header-rules: a March company (budgetsRouteFixture's
 * owner, its current registry year generated) with a revenue leaf, an expense header and two
 * sub-accounts, an inactive expense account, an asset, CC1/CC2 centres and a business unit, plus
 * members of any role. Versions and amounts are written directly; the routes are called as real
 * members through withAuth. Real PostgreSQL; synthetic rows only.
 */
import type { Pool } from 'pg';
import { budgetsRouteFixture, type RouteOut } from './budgetsRouteFixture';
import { signSession } from '../r-032-fake-gotrue.helpers';
import type { SetupUser } from './onboardingSetupFixture';

export interface GridWorld {
  u: SetupUser; label: number; months: string[];
  /** BR-5000 Rent (expense leaf, budgetsRouteFixture's). */
  rent: string; sales: string; header: string; child1: string; child2: string; inactive: string; asset: string;
  /** A header whose only sub-account is inactive. */
  header2: string;
  cc1: string; cc2: string; bu: string;
}

/** The token as P1 reads it (getVersion's updatedAt). */
export const TOKEN_SQL = `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function budgetGridSaveFixture(pool: Pool, route: unknown, url: string) {
  const base = budgetsRouteFixture(pool, route, url);
  const companies: string[] = [];
  const members: string[] = [];

  async function world(): Promise<GridWorld> {
    const o = await base.owner();
    const c = o.u.homeCompanyId;
    companies.push(c);
    const acct = async (code: string, name: string, type: string, opts: { parent?: string; active?: boolean } = {}) =>
      String((await pool.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active, parent_account_id)
         VALUES ($1, $2, $3, $4, $5, 3, $6, $7) RETURNING id`,
        [c, code, name, type, type === 'revenue' ? 'credit' : 'debit', opts.active ?? true, opts.parent ?? null])).rows[0].id);
    const sales = await acct('GS-4000', 'Sales', 'revenue');
    const header = await acct('GS-6000', 'Admin costs', 'expense');
    const child1 = await acct('GS-6100', 'Stationery', 'expense', { parent: header });
    const child2 = await acct('GS-6200', 'Postage', 'expense', { parent: header });
    // An inactive child still makes its parent a header (leafAccountOptions' rule).
    const header2 = await acct('GS-7000', 'Travel', 'expense');
    await acct('GS-7100', 'Old travel', 'expense', { parent: header2, active: false });
    const inactive = await acct('GS-6900', 'Old cost', 'expense', { active: false });
    const asset = await acct('GS-1000', 'Bank', 'asset');
    const cc = async (code: string, type: string) => String((await pool.query(
      `INSERT INTO cost_centres (company_id, code, name, cc_type) VALUES ($1, $2, $2, $3) RETURNING id`, [c, code, type])).rows[0].id);
    const cc1 = await cc('GS-C1', 'cc1');
    const cc2 = await cc('GS-C2', 'cc2');
    const bu = String((await pool.query(
      `INSERT INTO business_units (company_id, code, name) VALUES ($1, 'GS-BU', 'Ops') RETURNING id`, [c])).rows[0].id);
    return { u: o.u, label: o.label, months: o.months, rent: o.account, sales, header, child1, child2, header2, inactive, asset, cc1, cc2, bu };
  }

  async function member(companyId: string, role: string): Promise<SetupUser> {
    const userId = crypto.randomUUID();
    await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, true)`,
      [userId, `${userId}@test.local`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)`, [companyId, userId, role]);
    members.push(userId);
    return { userId, homeCompanyId: companyId, token: await signSession(userId, undefined, 'aal2') };
  }

  async function version(w: GridWorld, opts: { status?: 'draft' | 'approved' | 'locked'; primary?: boolean; name?: string } = {}): Promise<string> {
    const id = String((await pool.query(
      `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [w.u.homeCompanyId, w.label, opts.name ?? `GS-${crypto.randomUUID().slice(0, 8)}`, opts.primary ? 'original' : 'scenario',
        opts.primary ?? false, w.u.userId])).rows[0].id);
    if (opts.status === 'approved' || opts.status === 'locked') {
      await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [id, w.u.userId]);
    }
    if (opts.status === 'locked') {
      await pool.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`, [id, w.u.userId]);
    }
    return id;
  }

  const token = async (versionId: string): Promise<string> =>
    String((await pool.query(`SELECT ${TOKEN_SQL} AS t FROM budget_versions WHERE id = $1`, [versionId])).rows[0].t);

  /** One stored amount, written directly (month 'YYYY-MM'). */
  const amount = (w: GridWorld, versionId: string, acct: string, month: string, value: number,
    dims: { cc1?: string; cc2?: string; bu?: string } = {}) => pool.query(
    `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id, bu_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [w.u.homeCompanyId, versionId, acct, `${month}-01`, value, dims.cc1 ?? null, dims.cc2 ?? null, dims.bu ?? null]);

  /** The version's rows as `acct|cc1|cc2|bu|YYYY-MM=amount`, sorted: a whole-state fingerprint. */
  async function cells(versionId: string): Promise<string[]> {
    const rows = (await pool.query(
      `SELECT gl_account_id || '|' || COALESCE(cc1_id::text, '') || '|' || COALESCE(cc2_id::text, '') || '|' || COALESCE(bu_id::text, '')
              || '|' || to_char(month, 'YYYY-MM') || '=' || amount::text AS k
         FROM budget_month_amounts WHERE version_id = $1 ORDER BY 1`, [versionId])).rows;
    return rows.map((r) => String(r.k));
  }

  const audits = async (versionId: string) => (await pool.query(
    `SELECT action, changes FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1 ORDER BY created_at`, [versionId])).rows as
    Array<{ action: string; changes: { metadata?: Record<string, string> } }>;

  async function cleanup(): Promise<void> {
    for (const c of companies) {
      await pool.query(
        `UPDATE budget_versions SET status = 'approved', unlocked_by = locked_by, unlocked_at = clock_timestamp(), unlock_reason = 'test cleanup'
          WHERE company_id = $1 AND status = 'locked'`, [c]);
      await pool.query('DELETE FROM audit_log WHERE company_id = $1', [c]);
      await pool.query('DELETE FROM budget_month_amounts WHERE company_id = $1', [c]);
      await pool.query('DELETE FROM budget_versions WHERE company_id = $1', [c]);
      await pool.query('DELETE FROM accounting_budgets WHERE company_id = $1', [c]);
      await pool.query(`DELETE FROM cost_centres WHERE company_id = $1 AND code LIKE 'GS-%'`, [c]);
      await pool.query(`DELETE FROM business_units WHERE company_id = $1 AND code LIKE 'GS-%'`, [c]);
      await pool.query(`UPDATE gl_accounts SET parent_account_id = NULL WHERE company_id = $1 AND account_code LIKE 'GS-%'`, [c]);
      await pool.query(`DELETE FROM gl_accounts WHERE company_id = $1 AND account_code LIKE 'GS-%'`, [c]);
    }
    await base.cleanup();
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [members]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [members]);
  }

  const call = (u: SetupUser, body: unknown): Promise<RouteOut> => base.call(u, 'POST', body);
  return { world, member, version, token, amount, cells, audits, cleanup, call, callAs: base.call };
}

export const errCode = (r: RouteOut) => (r.body.error as { details?: { code?: string } } | undefined)?.details?.code;
export const errMessage = (r: RouteOut) => String(r.body.error?.message ?? '');
