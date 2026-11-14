/**
 * Shared by the budgets-three-way suites (P6 PR C): budgetGridFixture's companies (March years
 * FY2026-FY2028, owner + viewer with aal2 sessions, a revenue/expense chart and a bank account)
 * plus a receivable, a payable, share capital and a second bank-type account, the
 * `budgets_three_way` flag enabled per company (a `company_feature_overrides` row written as the
 * fixture's superuser connection, as a platform admin would), callers for the four routes, a
 * direct service call inside a request-like ALS transaction (the superuser connection: no RLS, so
 * a missing company_id predicate shows), and a whole-state fingerprint of a version's assumptions
 * (row, token, audit rows). Real PostgreSQL; synthetic rows only.
 */
import type { Pool } from 'pg';
import indexRoute from '../../../pages/api/accounting/budget-three-way/index';
import assumptionsRoute from '../../../pages/api/accounting/budget-three-way/assumptions';
import deriveRoute from '../../../pages/api/accounting/budget-three-way/derive';
import compareRoute from '../../../pages/api/accounting/budget-three-way/compare';
import { als } from '@/lib/als';
import { clearRateLimitCache } from '@/lib/rateLimit';
import { budgetGridFixture, type GridCo, type RouteOut } from './budgetGridFixture';
import type { SetupUser } from './onboardingSetupFixture';

export interface ThreeWayCo extends GridCo {
  ar: string; ap: string; capital: string;
  /** The system retained-earnings account (getBalanceSheet adds derived RE to it). */
  re: string;
  /** A second bank account (subtype 'Bank'): cash to both the bucket map and getCashBalance. */
  bank2: string;
}

export function budgetThreeWayFixture(pool: Pool) {
  const grid = budgetGridFixture(pool);
  const made: ThreeWayCo[] = [];

  async function company(opts: { flag?: boolean } = {}): Promise<ThreeWayCo> {
    const c = await grid.company();
    const acct = async (code: string, name: string, type: string, subtype: string, normal: string, system = false) => String((await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active, is_system_account)
       VALUES ($1, $2, $3, $4, $5, $6, 3, true, $7) RETURNING id`, [c.id, code, name, type, subtype, normal, system])).rows[0].id);
    const co: ThreeWayCo = {
      ...c,
      ar: await acct('1100', 'Debtors', 'asset', 'receivable', 'debit'),
      ap: await acct('2000', 'Creditors', 'liability', 'payable', 'credit'),
      capital: await acct('3000', 'Share capital', 'equity', 'share_capital', 'credit'),
      re: await acct('3100', 'Retained earnings', 'equity', 'retained_earnings', 'credit', true),
      bank2: await acct('1010', 'Savings', 'asset', 'Bank', 'debit'),
    };
    // Not VAT-registered: the parity suites pin figures without VAT; a VAT test sets its own.
    await pool.query(`UPDATE companies SET vat_period = 'none', entity_type = 'pty_ltd' WHERE id = $1`, [c.id]);
    if (opts.flag !== false) await setFlag(co, true);
    made.push(co);
    return co;
  }

  async function setFlag(c: GridCo, enabled: boolean): Promise<void> {
    await pool.query(
      `INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by, reason)
       SELECT $1, id, $2, $3, 'P6 test' FROM feature_flags WHERE code = 'budgets_three_way'
       ON CONFLICT (company_id, feature_id) DO UPDATE SET enabled = EXCLUDED.enabled`, [c.id, enabled, c.user]);
  }

  /** A version row, optionally based on another (written directly; based_on_version_id is immutable after insert). */
  async function version(c: GridCo, opts: { fy?: number; kind?: string; basedOn?: string | null; status?: 'draft' | 'approved' | 'locked'; primary?: boolean; name?: string } = {}): Promise<string> {
    const id = String((await pool.query(
      `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by, based_on_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [c.id, opts.fy ?? 2027, opts.name ?? `TW-${crypto.randomUUID().slice(0, 8)}`, opts.kind ?? 'scenario', opts.primary ?? false, c.user, opts.basedOn ?? null])).rows[0].id);
    if (opts.status === 'approved' || opts.status === 'locked') {
      await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [id, c.user]);
    }
    if (opts.status === 'locked') {
      await pool.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`, [id, c.user]);
    }
    return id;
  }

  const routes = {
    index: (u: SetupUser, query: Record<string, string>) => grid.call(indexRoute, '/api/accounting/budget-three-way', u, 'GET', query),
    getAssumptions: (u: SetupUser, versionId: string) =>
      grid.call(assumptionsRoute, '/api/accounting/budget-three-way/assumptions', u, 'GET', { version_id: versionId }),
    put: (u: SetupUser, body: unknown) => grid.call(assumptionsRoute, '/api/accounting/budget-three-way/assumptions', u, 'PUT', {}, body),
    derive: (u: SetupUser, body: unknown) => grid.call(deriveRoute, '/api/accounting/budget-three-way/derive', u, 'POST', {}, body),
    compare: (u: SetupUser, ids: string) => grid.call(compareRoute, '/api/accounting/budget-three-way/compare', u, 'GET', { version_ids: ids }),
  };

  /** `fn` inside a request-like ALS transaction for `c` on the superuser connection (RLS bypassed), rolled back. */
  async function direct<T>(c: GridCo, fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await als.run({ client, companyId: c.id, userId: c.user, claims: {} } as never, fn);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  /** Everything a save can change for the version: the row (doc, token, stamp) and its audit rows. */
  async function state(versionId: string) {
    const row = (await pool.query(
      `SELECT doc, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS token, updated_by
         FROM budget_three_way_assumptions WHERE version_id = $1`, [versionId])).rows[0] ?? null;
    const audits = (await pool.query(
      `SELECT action, changes FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1 ORDER BY created_at, id`, [versionId])).rows as
      Array<{ action: string; changes: { fields: Array<{ field: string; old: string | null; new: string | null }>; metadata: Record<string, string> } }>;
    const versionToken = String((await pool.query(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t FROM budget_versions WHERE id = $1`, [versionId])).rows[0]?.t ?? '');
    return { row, audits, versionToken };
  }

  async function cleanup(): Promise<void> {
    const ids = made.map((c) => c.id);
    await pool.query('DELETE FROM company_feature_overrides WHERE company_id = ANY($1)', [ids]);
    await pool.query(
      `UPDATE budget_versions SET status = 'approved', unlocked_by = locked_by, unlocked_at = clock_timestamp(), unlock_reason = 'test cleanup'
        WHERE company_id = ANY($1) AND status = 'locked'`, [ids]);
    await pool.query('DELETE FROM budget_three_way_assumptions WHERE company_id = ANY($1)', [ids]);
    const users = made.flatMap((c) => [c.owner.userId, c.viewer.userId]);
    await pool.query(`DELETE FROM rate_limit_counters WHERE key = ANY($1)`,
      [users.flatMap((u) => [`budget-three-way:${u}`, `budget-three-way-save:${u}`])]);
    clearRateLimitCache();
    await grid.cleanup();
  }

  return { ...grid, company, setFlag, version, routes, direct, state, cleanup };
}

export type { RouteOut };
export const code = (r: RouteOut) => (r.body.error as { details?: { code?: string } } | undefined)?.details?.code;
export const details = (r: RouteOut) => ((r.body.error as { details?: Record<string, unknown> } | undefined)?.details ?? {});
export const dataOf = <T>(r: RouteOut) => r.body.data as T;
