// tests/integration/w2-28-default-accounts-get-and-cache.int.test.ts
//
// W2-28 round 1 (breaker item 4): GET ignores a stored mapping that is not a
// plain object — `[]` used to come back as the response's `mappings` and hide
// every held role.
//
// W2-28 round 1 (breaker item 7). systemAccountResolver caches each company's
// role holders for 60s. The Default Accounts save used to clear that cache
// inside the handler — BEFORE withAuth's COMMIT — so a read landing in the gap
// (any other request posting for the company) re-cached the OLD holder from
// committed state, and every posting for the next minute used the account the
// user had just replaced. The clear now runs after COMMIT (runAfterCommit).
//
// The gap is reproduced deterministically: the handler returns the promise of
// its `apiResponse.success` call and withAuth COMMITs only once that settles,
// so a spy on it does a resolver read OUTSIDE the request's connection
// (als.exit → the pool) after the save and before COMMIT — exactly what a
// concurrent request would see.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { apiResponse } from '@/lib/apiResponse';
import { clearSystemAccountCache, getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import defaultAccounts from '../../pages/api/accounting/default-accounts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const A = randomUUID();
const USER = randomUUID();
const OLD_AR = randomUUID();
const NEW_AR = randomUUID();

describeIfDb('W2-28 — GET survives a malformed stored mapping; the cache clears after COMMIT', () => {
  let pool: Pool;
  let token = '';

  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [A, 'W228 cache Co']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `w228c-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    for (const [id, code, subtype, system] of [[OLD_AR, '1120', 'receivable', true], [NEW_AR, '1125', null, false]] as const) {
      await pool.query(
        `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
           normal_balance, is_active, is_system_account) VALUES ($1, $2, $3, $4, 'asset', $5, 'debit', true, $6)`,
        [id, A, code, `W228c ${code}`, subtype, system]);
    }
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  afterAll(async () => {
    clearSystemAccountCache(A);
    vi.restoreAllMocks();
    if (!pool) return;
    try {
      for (const t of ['app_settings', 'gl_accounts', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [A]);
      }
      await pool.query('DELETE FROM companies WHERE id = $1', [A]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally {
      await pool.end();
    }
  });

  it.each(['[]', '["x"]', '"x"', 'null', '5'])('GET ignores a stored non-object mapping (%s) and still shows the held role',
    async (value) => {
      await pool.query(
        `INSERT INTO app_settings (key, value, company_id, updated_at)
         VALUES ('accounting_default_accounts', $1, $2, NOW())`, [value, A]);
      try {
        const req = request({ 'sb-access-token': token, active_company_id: A }, 'GET') as never as { url: string };
        req.url = '/api/accounting/default-accounts';
        const out = response();
        await defaultAccounts(req as never, out.res as never);
        expect(out.state.statusCode).toBe(200);
        expect((out.state.body as { data: { mappings: Record<string, string> } }).data.mappings)
          .toEqual({ accounts_receivable: OLD_AR });
      } finally {
        await pool.query('DELETE FROM app_settings WHERE company_id = $1', [A]);
      }
    });

  it('a resolver read between the save and COMMIT does not leave the old holder cached', async () => {
    clearSystemAccountCache(A);
    let gapRead: string | undefined;
    const realSuccess = apiResponse.success.bind(apiResponse);
    const spy = vi.spyOn(apiResponse, 'success').mockImplementationOnce(((...args: Parameters<typeof realSuccess>) =>
      (async () => {
        gapRead = await als.exit(() => getSystemAccountId('receivable', A));
        return realSuccess(...args);
      })()) as never);
    const req = request({ 'sb-access-token': token, active_company_id: A }, 'POST') as never as
      { body: unknown; url: string };
    req.body = { mappings: { accounts_receivable: NEW_AR }, loaded: { accounts_receivable: OLD_AR } };
    req.url = '/api/accounting/default-accounts';
    const out = response();
    await defaultAccounts(req as never, out.res as never);
    spy.mockRestore();
    expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
    // The premise: the gap read ran, before COMMIT, and saw committed (old) state.
    expect(gapRead).toBe(OLD_AR);
    // After COMMIT, posting must resolve the new account without waiting out the TTL.
    await vi.waitFor(async () => expect(await getSystemAccountId('receivable', A)).toBe(NEW_AR));
  });
});
