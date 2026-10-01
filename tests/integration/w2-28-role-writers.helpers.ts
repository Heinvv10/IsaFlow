// Shared fixture for the W2-28 role-writer suites. Disposable fixture DB only.
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { als, type RequestContext } from '@/lib/als';
import { drainAfterCommit } from '@/lib/afterCommit';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

export type State = { statusCode: number; body: Record<string, unknown> };
type Handler = (req: never, res: never) => Promise<unknown>;

/** One gate on the Default Accounts save: it stops after its locks and first read. */
export interface Gate { reached: () => void; release: Promise<void> }
export function makeGate(): { gate: Gate; reached: Promise<void>; release: () => void } {
  let reached!: () => void; let release!: () => void;
  const reachedP = new Promise<void>((r) => { reached = r; });
  return { gate: { reached, release: new Promise<void>((r) => { release = r; }) }, reached: reachedP, release };
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function roleWriterFixture(tag: string) {
  const CO = randomUUID(); const USER = randomUUID(); const VIEWER = randomUUID();
  let pool: Pool; let token = ''; let viewerToken = '';

  const ins = (id: string, code: string, type: string, sub: string | null, sys: boolean,
    opts: { level?: number; parent?: string | null; createdAt?: string; importedFrom?: string } = {}) => pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
       normal_balance, is_active, is_system_account, level, parent_account_id, created_at, imported_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,COALESCE($11::timestamptz, NOW()),$12)`,
    [id, CO, code, `${tag} ${code}`, type, sub, ['asset', 'expense'].includes(type) ? 'debit' : 'credit', sys,
      opts.level ?? 3, opts.parent ?? null, opts.createdAt ?? null, opts.importedFrom ?? null]);

  /** Call a route as the fixture's admin (or its viewer), through withAuth (its own transaction). */
  async function call(handler: unknown, method: string, url: string, body: Record<string, unknown>, as: 'admin' | 'viewer' = 'admin'): Promise<State> {
    const req = request({ 'sb-access-token': as === 'viewer' ? viewerToken : token, active_company_id: CO }, method) as never as { body: unknown; url: string };
    req.body = body; req.url = url;
    const out = response();
    await (handler as Handler)(req as never, out.res as never);
    return out.state as State;
  }

  /**
   * A request transaction run the way its owner runs it: `run` under ALS on one
   * client, then COMMIT followed by the after-commit work, or ROLLBACK without it.
   */
  async function openTx() {
    const client = await pool.connect();
    await client.query('BEGIN');
    const ctx: RequestContext = { client, userId: USER, companyId: CO, claims: {}, afterCommit: [] };
    let open = true;
    const end = async (verb: 'COMMIT' | 'ROLLBACK') => {
      if (!open) return;
      open = false;
      try { await client.query(verb); } finally { client.release(); }
      if (verb === 'COMMIT') drainAfterCommit(ctx);
    };
    return {
      run: <T>(fn: () => Promise<T>) => als.run(ctx, fn),
      commit: () => end('COMMIT'),
      rollback: () => end('ROLLBACK'),
    };
  }

  const holders = async (sub: string) => (await pool.query(
    `SELECT account_code FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2
       AND is_system_account AND is_active ORDER BY account_code`, [CO, sub])).rows.map((r) => String(r.account_code));

  const wipe = async () => {
    for (const t of ['gl_account_merges', 'gl_journal_lines', 'gl_journal_entries', 'migration_sessions', 'app_settings']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    await pool.query('UPDATE gl_accounts SET parent_account_id = NULL WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [CO]);
  };

  async function setup() {
    assertDisposable();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, tag]);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [USER, `${tag}-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [CO, USER]);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)", [VIEWER, `${tag}-v-${VIEWER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')", [CO, VIEWER]);
    const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    token = await sign(USER); viewerToken = await sign(VIEWER);
  }

  async function teardown() {
    if (!pool) return;
    try {
      await wipe();
      await pool.query('DELETE FROM company_users WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
      await pool.query('DELETE FROM users WHERE id::TEXT = ANY($1::TEXT[])', [[USER, VIEWER]]);
    } finally { await pool.end(); }
  }

  return { CO, USER, ins, call, openTx, holders, wipe, setup, teardown, query: (text: string, values: unknown[]) => pool.query(text, values),
    connect: () => pool.connect() };
}
