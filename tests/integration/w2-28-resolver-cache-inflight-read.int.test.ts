// PR #593 breaker round 2 — a resolver read in flight across the save's COMMIT re-caches the old holder
// AFTER the after-commit clear, and posting uses it for the cache TTL. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

let hook: { reached: () => void; release: Promise<void>; fired: boolean } | null = null;
vi.mock('@/lib/neon', async (orig) => {
  const original = await orig<typeof import('../../src/lib/neon')>();
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    const p = original.sql(strings, ...values);
    // The resolver's cache-fill SELECT: pause AFTER it read the rows, before ensureCache stores them.
    if (hook && !hook.fired && /is_system_account = true/.test(text) && /account_subtype IS NOT NULL/.test(text)) {
      const h = hook; h.fired = true;
      return Promise.resolve(p).then(async (rows) => { h.reached(); await h.release; return rows; });
    }
    return p;
  }, original.sql);
  return { ...original, sql };
});
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import { getSystemAccount, clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;
const A = randomUUID(); const USER = randomUUID(); const OLD = randomUUID(); const NEW = randomUUID();

describeIfDb('PR #593 breaker round 2 — stale resolver cache', () => {
  let pool: Pool; let token = '';
  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [A, 'BRK593b cache']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [USER, `brk593bc-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    for (const [id, code, sub, sys] of [[OLD, '1110', 'bank', true], [NEW, '1111', null, false]] as const) {
      await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, is_system_account, level) VALUES ($1,$2,$3,$3,'asset',$4,'debit',true,$5,3)`, [id, A, code, sub, sys]);
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

  it('REPRO 4: after a 200 that moved bank, the resolver keeps handing out the old bank', async () => {
    clearSystemAccountCache(A);
    let reached!: () => void; let release!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    hook = { reached, release: new Promise<void>((r) => { release = r; }), fired: false };
    const inflight = getSystemAccount('bank', A);   // a concurrent posting request's resolver read
    await reachedP;                                   // it has read OLD, not yet cached it

    const req = request({ 'sb-access-token': token, active_company_id: A }, 'POST') as never as { body: unknown; url: string };
    req.body = { mappings: { primary_bank: NEW }, loaded: { primary_bank: OLD } };
    req.url = '/api/accounting/default-accounts';
    const out = response();
    await (defaultAccounts as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    expect(out.state.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));     // let the after-commit clear run
    expect(hook.fired).toBe(true);

    release();
    await inflight;                                   // stores OLD in the cache after the clear
    const next = await getSystemAccount('bank', A);  // the next posting, within the 60 s TTL
    const db = (await pool.query('SELECT id FROM gl_accounts WHERE company_id = $1 AND is_system_account AND account_subtype = $2', [A, 'bank'])).rows;
    expect({ resolver: next.accountCode, dbHolder: db.map((r) => r.id) },
      'posting resolves the bank role to an account that no longer holds it').toEqual({ resolver: '1111', dbHolder: [NEW] });
  });
});
