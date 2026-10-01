// tests/integration/w2-28-default-accounts-concurrent-stale.int.test.ts
//
// W2-28 round 3. Two saves move the SAME role to DIFFERENT accounts on a company
// whose chart holds no role yet, so the row locks (role rows + chosen accounts)
// are disjoint. Without the role-write advisory lock the second save read
// `before` while the first was still in flight, saw the role empty (= what its
// page loaded), and both returned 200 — the second silently overwrote the
// first. With the lock the second reads after the first commits, sees the role
// moved, and is refused 409.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

// Pause the FIRST coverage read (save A's `before`) until the test releases it.
const gate: { reached?: () => void; release?: Promise<void>; used: boolean } = { used: false };
let release!: () => void;
const reached = new Promise<void>((r) => { gate.reached = r; });
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
const A = randomUUID(); const USER = randomUUID(); const X = randomUUID(); const Y = randomUUID();

describeIfDb('W2-28 — concurrent saves of one role: the later one is refused, not lost', () => {
  let pool: Pool; let token = '';
  async function call(body: Record<string, unknown>) {
    const req = request({ 'sb-access-token': token, active_company_id: A }, 'POST') as never as { body: unknown; url: string };
    req.body = body;
    req.url = '/api/accounting/default-accounts';
    const out = response();
    await (defaultAccounts as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    return out.state as { statusCode: number };
  }
  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [A, 'W228 stale conc']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [USER, `w228s-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    for (const [id, code] of [[X, '1110'], [Y, '1111']]) {
      await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
        normal_balance, is_active, level) VALUES ($1, $2, $3, $3, 'asset', 'debit', true, 3)`, [id, A, code]);
    }
    token = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      for (const t of ['app_settings', 'gl_accounts', 'company_users']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [A]);
      await pool.query('DELETE FROM companies WHERE id = $1', [A]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally { await pool.end(); }
  });

  it('both pages loaded bank as "Not configured"; A saves X, B saves Y meanwhile → B 409, bank X', async () => {
    const a = call({ mappings: { primary_bank: X }, loaded: { primary_bank: '' } });
    await reached;                                                   // A has read `before`, not yet written
    const b = call({ mappings: { primary_bank: Y }, loaded: { primary_bank: '' } });
    await new Promise((r) => setTimeout(r, 500));
    release();
    const [aState, bState] = await Promise.all([a, b]);
    const bank = (await pool.query(
      'SELECT id::TEXT AS id FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 AND is_system_account', [A, 'bank'])).rows;
    expect({ a: aState.statusCode, b: bState.statusCode, bank: bank.map((r) => r.id) }).toEqual({ a: 200, b: 409, bank: [X] });
  });
});
