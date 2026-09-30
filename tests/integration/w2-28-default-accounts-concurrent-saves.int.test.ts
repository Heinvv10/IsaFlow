// PR #593 breaker — concurrent saves on a company with no role rows (the FOR UPDATE locks nothing).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

// Pause the FIRST coverage read (request B's `before`) until the test releases it.
const gate: { reached?: () => void; release?: Promise<void>; used: boolean } = { used: false };
let reached!: Promise<void>;
let release!: () => void;
reached = new Promise((r) => { gate.reached = r; });
gate.release = new Promise((r) => { release = r; });
vi.mock('@/modules/accounting/services/gl/systemRoleCoverage', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/accounting/services/gl/systemRoleCoverage')>();
  return {
    ...actual,
    getSystemRoleCoverage: async (...args: Parameters<typeof actual.getSystemRoleCoverage>) => {
      const out = await actual.getSystemRoleCoverage(...args);
      if (!gate.used) { gate.used = true; gate.reached!(); await gate.release; }
      return out;
    },
  };
});
import defaultAccounts from '../../pages/api/accounting/default-accounts';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;
const A = randomUUID();
const USER = randomUUID();
const X = randomUUID();

describeIfDb('PR #593 breaker — concurrency', () => {
  let pool: Pool;
  let token = '';
  async function call(method: string, body?: Record<string, unknown>) {
    const req = request({ 'sb-access-token': token, active_company_id: A }, method) as never as
      { body: unknown; url: string };
    req.body = body;
    req.url = '/api/accounting/default-accounts';
    const out = response();
    await (defaultAccounts as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    return out.state as { statusCode: number };
  }
  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [A, 'BRK593 conc']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `brk593c-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    // Chart with NO account carrying any system subtype.
    await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, is_active) VALUES ($1, $2, '1110', 'Cheque', 'asset', 'debit', true)`, [X, A]);
    token = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      for (const t of ['app_settings', 'gl_accounts', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [A]);
      }
      await pool.query('DELETE FROM companies WHERE id = $1', [A]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally { await pool.end(); }
  });

  it('REPRO 6: two concurrent 200s, and the bank role one of them set is left empty', async () => {
    const b = call('POST', { mappings: { accounts_receivable: X } }); // pauses after reading `before`
    await reached;
    const aP = call('POST', { mappings: { primary_bank: X } });  // runs to commit meanwhile unless serialised
    await new Promise((r) => setTimeout(r, 500));
    release();
    const [a, bState] = await Promise.all([aP, b]);
    const rows = (await pool.query(`SELECT account_subtype, is_system_account FROM gl_accounts WHERE id = $1`, [X])).rows;
    const winner = a.statusCode === 200 && bState.statusCode !== 200 ? 'bank'
      : bState.statusCode === 200 && a.statusCode !== 200 ? 'receivable' : 'both-200';
    expect({ winner, x: rows[0]?.account_subtype },
      'both saves reported success; one of the two roles they set has no holder')
      .toEqual({ winner: rows[0]?.account_subtype, x: rows[0]?.account_subtype });
  });
});
