// brk-593 breaker fixture. Self-contained (no dependency on the PR's own helpers)
// so the same repro file runs unchanged on origin/master. Disposable fixture DB only.
import { Pool } from 'pg';
import { randomUUID, createHash } from 'crypto';
import { SignJWT } from 'jose';
import { als, type RequestContext } from '@/lib/als';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

export type State = { statusCode: number; body: Record<string, unknown> };
type Handler = (req: never, res: never) => Promise<unknown>;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, sleep(ms).then(() => `STILL WAITING after ${ms}ms` as const)]);

export function brkFixture(tag: string) {
  const CO = randomUUID(); const USER = randomUUID();
  let pool: Pool; let token = '';

  const ins = (id: string, code: string, type: string, sub: string | null, sys: boolean,
    opts: { level?: number; parent?: string | null; active?: boolean; importedFrom?: string; co?: string } = {}) => pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
       normal_balance, is_active, is_system_account, level, parent_account_id, imported_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, opts.co ?? CO, code, `${tag} ${code}`, type, sub, ['asset', 'expense'].includes(type) ? 'debit' : 'credit',
      opts.active ?? true, sys, opts.level ?? 3, opts.parent ?? null, opts.importedFrom ?? null]);

  async function call(handler: unknown, method: string, url: string, body: Record<string, unknown>,
    query: Record<string, string> = {}): Promise<State> {
    const req = request({ 'sb-access-token': token, active_company_id: CO }, method) as never as
      { body: unknown; url: string; query: unknown };
    req.body = body; req.url = url; req.query = query;
    const out = response();
    await (handler as Handler)(req as never, out.res as never);
    return out.state as State;
  }

  /** A request transaction the way an owner runs it; afterCommit drained on COMMIT only. */
  async function openTx(drain: (ctx: RequestContext) => void) {
    const client = await pool.connect();
    await client.query('BEGIN');
    const ctx: RequestContext = { client, userId: USER, companyId: CO, claims: {}, afterCommit: [] };
    let open = true;
    const end = async (verb: 'COMMIT' | 'ROLLBACK') => {
      if (!open) return; open = false;
      try { await client.query(verb); } finally { client.release(); }
      if (verb === 'COMMIT') drain(ctx);
    };
    return { run: <T>(fn: () => Promise<T>) => als.run(ctx, fn), commit: () => end('COMMIT'), rollback: () => end('ROLLBACK'), client };
  }

  /** Active system holders of a role, as account codes. */
  const holders = async (sub: string) => (await pool.query(
    `SELECT account_code FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2
       AND is_system_account AND is_active ORDER BY account_code`, [CO, sub])).rows.map((r) => String(r.account_code));

  const rows = async () => (await pool.query(
    `SELECT account_code AS code, account_type AS type, account_subtype AS sub, is_system_account AS sys, is_active AS act,
            (SELECT p.account_code FROM gl_accounts p WHERE p.id = a.parent_account_id) AS parent
       FROM gl_accounts a WHERE company_id = $1 ORDER BY account_code`, [CO])).rows;

  /** Hash of every gl_accounts and app_settings row of the company. */
  const hash = async (co = CO) => {
    const a = await pool.query('SELECT (to_jsonb(g) - \'updated_at\')::TEXT AS j FROM gl_accounts g WHERE company_id = $1 ORDER BY id', [co]);
    const s = await pool.query('SELECT (to_jsonb(s) - \'updated_at\')::TEXT AS j FROM app_settings s WHERE company_id = $1 ORDER BY key', [co]);
    return createHash('sha256').update(JSON.stringify([a.rows, s.rows])).digest('hex');
  };

  const wipe = async () => {
    for (const t of ['mcp_tool_calls', 'mcp_idempotency_keys', 'flow_wallet_transactions', 'gl_reclassification_batches', 'fiscal_periods_tmp']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]).catch(() => undefined);
    }
    for (const t of ['gl_account_merges', 'gl_journal_lines', 'gl_journal_entries', 'migration_sessions', 'app_settings']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [CO]);
    await pool.query('UPDATE gl_accounts SET parent_account_id = NULL WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [CO]);
  };

  async function setup() {
    assertDisposable();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, tag]);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [USER, `${tag}-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [CO, USER]);
    token = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }

  async function teardown() {
    if (!pool) return;
    try {
      await wipe();
      await pool.query('DELETE FROM company_users WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM companies WHERE id = $1', [CO]).catch(() => undefined);   // disposable fixture: leftovers are fine
      await pool.query('DELETE FROM users WHERE id = $1', [USER]).catch(() => undefined);
    } finally { await pool.end(); }
  }

  return { CO, USER, ins, call, openTx, holders, rows, hash, wipe, setup, teardown,
    query: (text: string, values: unknown[] = []) => pool.query(text, values), connect: () => pool.connect() };
}

/** Print evidence so it lands in the saved output even when the assertion fails. */
export const show = (label: string, v: unknown) => process.stdout.write(`\nBRK593 ${label}: ${JSON.stringify(v)}\n`);
