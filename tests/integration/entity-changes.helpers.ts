/**
 * Fixture for the entity-change-history suites (forensic-controls step 3,
 * migration 888): members with signed tokens, one company per case, raw SQL
 * run the way each channel runs it (withAuth's app_user + claims, the MCP
 * bearer's claims without a session id, Login-as, the platform-admin
 * connection, a script with no claims), and the history read back as the
 * owner sees it.
 */
import type { Pool, PoolClient } from 'pg';
import { createUser, newCompany } from './r035-approval.helpers';

export type Db = Pool | PoolClient;

export interface Change {
  seq: string; company_id: string; entity_type: string; entity_id: string; op: string; changed: string[];
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; actor: string; channel: string;
  impersonator: string | null; session_id: string | null; db_role: string; login_role: string; txid: string;
}

export interface AsOpts {
  /** Claims to set; `null` sets none (a script). Default: a person's own session. */
  claims?: Record<string, unknown> | null;
  /** The role to SET LOCAL (default app_user); `null` keeps the login role. */
  role?: string | null;
  company?: string;
}

/** `fn` in one committed transaction, set up as `opts` says. */
export async function as<T>(pool: Pool, user: string, opts: AsOpts, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const claims = opts.claims === undefined ? { sub: user, session_id: crypto.randomUUID() } : opts.claims;
    if (claims) await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    if (opts.company) await db.query("SELECT set_config('app.current_company_id', $1, true)", [opts.company]);
    const role = opts.role === undefined ? 'app_user' : opts.role;
    if (role) await db.query(`SET LOCAL ROLE ${role}`);
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally { db.release(); }
}

/** A person in their own session, in `company`. */
export const asApp = <T>(pool: Pool, user: string, company: string, fn: (db: PoolClient) => Promise<T>) =>
  as(pool, user, { company }, fn);

export const outcome = (p: Promise<unknown>) =>
  p.then(() => 'ok', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);

/** Every change recorded for an entity, oldest first, read as the table owner. */
export async function changesOf(db: Db, entityId: string): Promise<Change[]> {
  const { rows } = await db.query('SELECT * FROM entity_changes WHERE entity_id = $1 ORDER BY seq', [entityId]);
  return rows as Change[];
}

export async function members(pool: Pool, tokens: Record<string, string>, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await createUser(pool, tokens));
  return out;
}

export { newCompany };

/** Removes the companies (their history goes with them — the purge path) and the users. */
export async function cleanupEntityChanges(pool: Pool, companies: string[], users: string[]): Promise<void> {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_enforcement WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_rules WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM company_user_permissions WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM company_invitations WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM customers WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  } finally {
    await pool.end();
  }
}
