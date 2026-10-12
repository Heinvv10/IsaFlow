/**
 * R-159 — a throw inside withAuth, the Bearer pipeline (withBearerOrCookieAuth / withBearerAuth)
 * or withExtensionToken must roll back AND answer the client.
 *
 * Each wrapper swaps res.end for a buffer so the response flushes only after COMMIT/ROLLBACK.
 * On a throw they rolled back and rethrew without putting the real end back, so any 500 sent
 * further out landed in the dead buffer and the client hung until its socket timed out.
 * invitations/revoke/[id].ts has no withErrorHandler at all, so every throw in it hung; its
 * route-level cases are in r159-invitation-revoke-throw-responds.int.test.ts.
 *
 * Each case writes under app_user (RLS on) and then throws. It asserts: the write is rolled
 * back, nothing is rethrown, the status and body are withErrorHandler's, and the response's
 * own end() ran exactly once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { call, type TestResponse } from './r159-auth-wrapper.helpers';

const h = vi.hoisted(() => ({ drained: 0, rateLimitThrows: false, rateLimitThrew: 0 }));
// A throw from the wrapper's own step before the swap (the per-company rate limiter).
vi.mock('@/lib/rateLimit', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rateLimit')>();
  return {
    ...original,
    checkRateLimit: async (...a: Parameters<typeof original.checkRateLimit>) => {
      if (h.rateLimitThrows) { h.rateLimitThrew += 1; throw new Error('R-159 rate limiter unavailable'); }
      return original.checkRateLimit(...a);
    },
  };
});
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withAuth } from '@/lib/auth/withAuth';
import { withBearerOrCookieAuth } from '@/lib/auth/withBearerOrCookieAuth';
import { withBearerAuth } from '@/lib/auth/withBearerAuth';
import { withExtensionToken } from '@/lib/auth/withExtensionToken';
import { signExtensionToken } from '@/lib/auth/extensionJwt';
import { createPat } from '@/lib/auth/personalAccessTokens';
import { DocumentNumberLockTimeoutError } from '@/modules/accounting/services/core/companySettingsService';
import { withErrorHandler } from '@/lib/api-error-handler';
import { runAfterCommit } from '@/lib/afterCommit';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO = randomUUID();
const USER = randomUUID();
const BANK = randomUUID();
const CONN = randomUUID();
let cookieJwt = '';
let pat = '';
let extToken = '';

type Mode = 'throw' | 'respond-then-throw' | 'flush-then-throw' | 'lock-timeout' | 'ok' | 'ok-twice'
  | 'commit-fails' | 'flush-then-commit-fails' | 'end-rejects-body' | 'handled-flush-then-throw' | 'silent';

/** A write under the wrapper's transaction, then the given failure. */
function handler(name: string, mode: Mode): (req: unknown, res: TestResponse) => Promise<unknown> {
  // withErrorHandler inside the wrapper, as on 640 routes, with the headers flushed before the throw.
  if (mode === 'handled-flush-then-throw') return withErrorHandler(handler(name, 'flush-then-throw')) as never;
  return async (_req: unknown, res: TestResponse) => {
    await sql`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
    if (mode === 'silent') return undefined; // never responds: there is nothing to replay
    if (mode === 'end-rejects-body') {
      // Node's end() refuses an object; the wrapper only finds out when it replays after COMMIT.
      runAfterCommit('r159 probe', async () => { h.drained += 1; });
      return res.status(201).end({ id: 1 });
    }
    if (mode === 'commit-fails' || mode === 'flush-then-commit-fails') {
      // A deferred FK that is violated only at COMMIT, so the handler's own answer is a 200.
      await sql`CREATE TEMP TABLE r159_deferred (id int PRIMARY KEY,
        ref int REFERENCES r159_deferred (id) DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP`;
      await sql`INSERT INTO r159_deferred VALUES (1, 2)`;
      if (mode === 'flush-then-commit-fails') { res.writeHead(200); res.write('partial'); return res.end('rest'); }
      return res.status(200).json({ success: true });
    }
    if (mode === 'ok') return res.status(200).json({ success: true, data: name });
    if (mode === 'ok-twice') { res.status(200).json({ success: true, data: name }); return res.json({ second: true }); }
    if (mode === 'respond-then-throw') res.status(200).json({ success: true });
    if (mode === 'flush-then-throw') { res.writeHead(200); res.write('partial'); }
    if (mode === 'lock-timeout') throw new DocumentNumberLockTimeoutError('invoice');
    throw new Error(`R-159 forced failure after the ${name} INSERT`);
  };
}

const customers = async (name: string) =>
  Number((await pool.query('SELECT count(*) AS n FROM customers WHERE company_id = $1 AND name = $2', [CO, name])).rows[0].n);

const cookieReq = () => request({ 'sb-access-token': cookieJwt, active_company_id: CO }, 'POST');
const bearerReq = (token: string) => ({ ...cookieReq(), headers: { authorization: `Bearer ${token}` } });

const wrappers: Array<[string, (m: Mode, n: string) => (req: never, res: never) => unknown, () => unknown]> = [
  ['withAuth', (m, n) => withAuth(handler(n, m)), cookieReq],
  ['withBearerOrCookieAuth (PAT)', (m, n) => withBearerOrCookieAuth(handler(n, m)), () => bearerReq(pat)],
  ['withBearerAuth (PAT)', (m, n) => withBearerAuth(handler(n, m)), () => bearerReq(pat)],
  ['withExtensionToken', (m, n) => withExtensionToken(handler(n, m)), () => ({ ...bearerReq(extToken), query: {} })],
];

beforeAll(async () => {
  vi.stubEnv('EXTENSION_SIGNING_KEY', 'r159-disposable-extension-signing-key-0123456789');
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R159 throw responds']);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [USER, `r159-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)",
    [CO, USER]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, account_subtype, is_active)
     VALUES ($1, $2, '1110', 'R159 Bank', 'asset', 'debit', 'bank', true)`, [BANK, CO]);
  await pool.query(
    `INSERT INTO bank_feed_connections (id, company_id, bank_account_id, provider, status, is_active, config)
     VALUES ($1, $2, $3, 'extension', 'active', true, '{"bankId":"absa"}')`, [CONN, CO, BANK]);
  cookieJwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  pat = (await createPat({ userId: USER, companyId: CO, name: 'r159', scopes: ['read:invoices'], expiresInDays: 1 })).raw;
  extToken = await signExtensionToken({
    userId: USER, companyId: CO, connectionId: CONN, bankId: 'absa', scope: 'bank-feed-ingest',
  });
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM personal_access_tokens WHERE company_id = $1', [CO]);
    for (const t of ['customers', 'bank_feed_connections', 'gl_accounts', 'company_users']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
  } finally {
    await pool.end();
    vi.unstubAllEnvs();
  }
});

describe.each(wrappers)('%s', (label, wrap, req) => {
  it('a throw after a write: rolled back, 500 in withErrorHandler\'s shape, end() once, no rethrow', async () => {
    const name = `throw-${randomUUID()}`;
    const logged = vi.spyOn(log, 'error');
    const r = await call(wrap('throw', name), req());
    const source = label.startsWith('withBearer') ? 'bearerPipeline' : label;
    expect(logged).toHaveBeenCalledWith(`${source}: request threw inside its transaction`,
      expect.objectContaining({
        rolledBack: true,
        companyId: CO, userId: USER, message: `R-159 forced failure after the ${name} INSERT`,
        stack: expect.stringContaining(`R-159 forced failure after the ${name} INSERT`),
        ...(label === 'withExtensionToken' && { connectionId: CONN }),
      }), 'Auth');
    logged.mockRestore();
    expect(await customers(name)).toBe(0);
    expect(r.threw).toBeNull();
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ success: false, data: null, code: 'INTERNAL_SERVER_ERROR' });
    expect(r.ends).toBe(1);
  });

  it('a 200 already buffered, then a throw: the 200 is replaced by the 500, and the write rolled back', async () => {
    const name = `late-${randomUUID()}`;
    const r = await call(wrap('respond-then-throw', name), req());
    expect(await customers(name)).toBe(0);
    expect(r.threw).toBeNull();
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ success: false, code: 'INTERNAL_SERVER_ERROR' });
    expect(r.ends).toBe(1);
  });

  it('headers already flushed, then a throw: rolled back, and the response aborted, not closed as a 200', async () => {
    const name = `flushed-${randomUUID()}`;
    const r = await call(wrap('flush-then-throw', name), req());
    expect(await customers(name)).toBe(0);
    expect(r.threw).toBeNull();
    expect(r.destroyed).toBe(true);
    expect(r.ends).toBe(0);
  });

  it('withErrorHandler inside, headers flushed, then a throw: rolled back (not COMMITted) and aborted', async () => {
    const name = `handled-flushed-${randomUUID()}`;
    const r = await call(wrap('handled-flush-then-throw', name), req());
    expect(await customers(name)).toBe(0);
    expect(r.threw).toBeNull();
    expect(r.destroyed).toBe(true);
    expect(r.ends).toBe(0);
  });

  it('a replay that fails after COMMIT: the write stays, no rollback is claimed, after-commit work runs', async () => {
    const name = `replay-${randomUUID()}`;
    const drained = h.drained;
    const logged = vi.spyOn(log, 'error');
    const r = await call(wrap('end-rejects-body', name), req());
    const messages = logged.mock.calls.map((c) => String(c[0]));
    const replayLog = logged.mock.calls.find((c) => String(c[0]).includes('response replay failed'));
    logged.mockRestore();
    expect(replayLog?.[1]).toMatchObject({
      companyId: CO, userId: USER, message: 'ERR_INVALID_ARG_TYPE',
      ...(label === 'withExtensionToken' && { connectionId: CONN }),
    });
    await new Promise((done) => setTimeout(done, 20));
    expect(await customers(name)).toBe(1);
    expect(r.threw).toBeNull();
    expect(r.status).toBe(201);
    expect(r.destroyed).toBe(true);
    expect(messages.some((m) => m.includes('request threw inside its transaction'))).toBe(false);
    expect(messages.some((m) => m.includes('response replay failed after the transaction was finalised'))).toBe(true);
    expect(h.drained).toBe(drained + 1);
  });

  it('a lock timeout is answered 503, as withErrorHandler answers it', async () => {
    const name = `lock-${randomUUID()}`;
    const r = await call(wrap('lock-timeout', name), req());
    expect(await customers(name)).toBe(0);
    expect(r.threw).toBeNull();
    expect(r.status).toBe(503);
    expect(r.ends).toBe(1);
  });

  it('positive path unchanged: 200 commits the write and ends once', async () => {
    const name = `ok-${randomUUID()}`;
    const r = await call(wrap('ok', name), req());
    expect(await customers(name)).toBe(1);
    expect(r.threw).toBeNull();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, data: name });
    expect(r.ends).toBe(1);
  });

  it('a failed COMMIT still replaces the buffered 200 with 500 COMMIT_FAILED (unchanged)', async () => {
    const name = `commit-${randomUUID()}`;
    const r = await call(wrap('commit-fails', name), req());
    expect(await customers(name)).toBe(0);
    expect(r.threw).toBeNull();
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ success: false, code: 'COMMIT_FAILED' });
    expect(r.ends).toBe(1);
  });

  it('a failed COMMIT after the headers were flushed aborts the response instead of completing it', async () => {
    const name = `commit-flushed-${randomUUID()}`;
    const r = await call(wrap('flush-then-commit-fails', name), req());
    expect(await customers(name)).toBe(0);
    expect(r.threw).toBeNull();
    expect(r.destroyed).toBe(true);
    expect(r.ends).toBe(0);
  });

  // ci-integration-skip: withExtensionToken runs no rate limiter before the swap, so the pre-swap rate-limiter throw has nothing to exercise there.
  it.skipIf(label === 'withExtensionToken')(
    'a throw from the wrapper itself before the swap (rate limiter): answered 500 once, no rethrow', async () => {
      const name = `pre-swap-${randomUUID()}`;
      const threwBefore = h.rateLimitThrew;
      h.rateLimitThrows = true;
      try {
        const r = await call(wrap('ok', name), { ...(req() as object), url: '/api/accounting/reports-r159' });
        expect(h.rateLimitThrew).toBe(threwBefore + 1); // the wrapper's own step threw, before the swap
        expect(r.threw).toBeNull();
        expect(r.status).toBe(500);
        expect(r.body).toMatchObject({ success: false, data: null, code: 'INTERNAL_SERVER_ERROR' });
        expect(r.ends).toBe(1);
      } finally {
        h.rateLimitThrows = false;
      }
    });

  it('a handler that never responds: the write commits and nothing is replayed (unchanged)', async () => {
    const name = `silent-${randomUUID()}`;
    const r = await call(wrap('silent', name), req());
    expect(await customers(name)).toBe(1);
    expect(r.threw).toBeNull();
    expect(r.ends).toBe(0);
    expect(r.destroyed).toBe(false);
  });

  it('positive path unchanged: a second end() is dropped, the first is what the client gets', async () => {
    const name = `twice-${randomUUID()}`;
    const r = await call(wrap('ok-twice', name), req());
    expect(await customers(name)).toBe(1);
    expect(r.body).toEqual({ success: true, data: name });
    expect(r.ends).toBe(1);
  });
});
