/**
 * R-176 — a transaction owner that cannot end its transaction must destroy the connection.
 *
 * withAuth, the Bearer pipeline and withExtensionToken released the client bare in `finally`.
 * pg-pool evicts a dead socket by itself, but not a live connection whose ROLLBACK never
 * reached the server (a client-side query timeout, say). That connection went back to the pool
 * inside its open transaction, and the next request's COMMIT committed the failed request's
 * writes.
 *
 * Each case writes a row, then makes the wrapper's own ROLLBACK and/or COMMIT reject on the
 * request's client without reaching Postgres, so the transaction really stays open. It is
 * decided by outcome: the backend is gone, the next request gets another backend, and the row
 * is not there after that request commits. The healthy paths must still reuse the connection.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { call, type TestResponse } from './r159-auth-wrapper.helpers';
import { arm, backendState, seen, type Seen, type Statement } from './r176-evict.helpers';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { withAuth } from '@/lib/auth/withAuth';
import { withBearerOrCookieAuth } from '@/lib/auth/withBearerOrCookieAuth';
import { withBearerAuth } from '@/lib/auth/withBearerAuth';
import { withExtensionToken } from '@/lib/auth/withExtensionToken';
import { signExtensionToken } from '@/lib/auth/extensionJwt';
import { createPat } from '@/lib/auth/personalAccessTokens';
import { withPublicRouteTransaction } from '@/lib/publicRouteTx';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO = randomUUID();
const USER = randomUUID();
const BANK = randomUUID();
const CONN = randomUUID();
let cookieJwt = '';
let pat = '';
let extToken = '';

type Outcome = 'throw' | 'ok' | 'answer-500';

/** The work inside the owner's transaction: note the backend, write a row, arm the failure. */
async function work(name: string, fail: Statement[], s: Seen): Promise<void> {
  s.pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
  await sql`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
  arm(als.getStore()!.client, fail, s);
}

function handler(name: string, outcome: Outcome, fail: Statement[], s: Seen) {
  return async (_req: unknown, res: TestResponse) => {
    await work(name, fail, s);
    if (outcome === 'ok') return res.status(200).json({ success: true });
    if (outcome === 'answer-500') return res.status(500).json({ success: false }); // as withErrorHandler does
    throw new Error(`R-176 forced failure after the ${name} INSERT`);
  };
}

const customers = async (name: string) =>
  Number((await pool.query('SELECT count(*) AS n FROM customers WHERE company_id = $1 AND name = $2', [CO, name])).rows[0].n);

const cookieReq = () => request({ 'sb-access-token': cookieJwt, active_company_id: CO }, 'POST');
const bearerReq = (token: string) => ({ ...cookieReq(), headers: { authorization: `Bearer ${token}` } });
type Wrapped = (req: never, res: never) => unknown;
type Run = (name: string, outcome: Outcome, fail: Statement[], s: Seen) => Promise<{ status: number; code: unknown }>;

const viaWrapper = (wrap: (h: ReturnType<typeof handler>) => Wrapped, req: () => unknown): Run =>
  async (name, outcome, fail, s) => {
    const r = await call(wrap(handler(name, outcome, fail, s)), req());
    expect(r.threw).toBeNull();
    return { status: r.status, code: r.body?.code };
  };

/** withPublicRouteTransaction answers nothing itself: a throw is rethrown to the route. */
const viaPublicRouteTx: Run = async (name, outcome, fail, s) => {
  try {
    await withPublicRouteTransaction('r176', async () => {
      await work(name, fail, s);
      if (outcome !== 'ok') throw new Error(`R-176 forced failure after the ${name} INSERT`);
    });
    return { status: 200, code: undefined };
  } catch {
    return { status: 500, code: undefined };
  }
};

const owners: Array<[string, Run]> = [
  ['withAuth', viaWrapper((h) => withAuth(h), cookieReq)],
  ['withBearerOrCookieAuth (PAT)', viaWrapper((h) => withBearerOrCookieAuth(h), () => bearerReq(pat))],
  ['withBearerAuth (PAT)', viaWrapper((h) => withBearerAuth(h), () => bearerReq(pat))],
  ['withExtensionToken', viaWrapper((h) => withExtensionToken(h), () => ({ ...bearerReq(extToken), query: {} }))],
  ['withPublicRouteTransaction', viaPublicRouteTx],
];

beforeAll(async () => {
  vi.stubEnv('EXTENSION_SIGNING_KEY', 'r176-disposable-extension-signing-key-0123456789');
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R176 rollback evicts']);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [USER, `r176-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)",
    [CO, USER]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, account_subtype, is_active)
     VALUES ($1, $2, '1110', 'R176 Bank', 'asset', 'debit', 'bank', true)`, [BANK, CO]);
  await pool.query(
    `INSERT INTO bank_feed_connections (id, company_id, bank_account_id, provider, status, is_active, config)
     VALUES ($1, $2, $3, 'extension', 'active', true, '{"bankId":"absa"}')`, [CONN, CO, BANK]);
  cookieJwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  pat = (await createPat({ userId: USER, companyId: CO, name: 'r176', scopes: ['read:invoices'], expiresInDays: 1 })).raw;
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

/**
 * One failing request, then a healthy one on the same owner. Everything is gathered before
 * anything is asserted, so a connection left in its transaction is always used up by the
 * second request and cannot leak into the next case.
 */
async function requestThenNext(run: Run, outcome: Outcome, fail: Statement[], want: 'gone' | 'idle') {
  const name = `r176-${randomUUID()}`;
  const first = seen();
  const logged = vi.spyOn(log, 'error');
  const answer = await run(name, outcome, fail, first);
  const finalizeLog = logged.mock.calls.find((c) => String(c[0]).includes('transaction finalize failed'))?.[1];
  const throwLog = logged.mock.calls.find((c) => String(c[0]).includes('request threw inside its transaction'))?.[1];
  logged.mockRestore();
  first.disarm();
  const state = await backendState(pool, first.pid, want);
  const next = seen();
  const nextAnswer = await run(`${name}-next`, 'ok', [], next);
  next.disarm();
  return {
    answer, refused: first.refused, state, samePid: next.pid === first.pid, nextStatus: nextAnswer.status,
    rows: await customers(name), nextRows: await customers(`${name}-next`), finalizeLog, throwLog,
  };
}

describe.each(owners)('%s', (label, run) => {
  const isWrapper = label !== 'withPublicRouteTransaction';

  it('a throw whose ROLLBACK fails: the connection is destroyed, and the next request cannot commit the write', async () => {
    const r = await requestThenNext(run, 'throw', ['ROLLBACK'], 'gone');
    expect(r.refused.ROLLBACK).toBeGreaterThanOrEqual(1); // the failure fired
    expect(r.answer.status).toBe(500);
    expect(r.nextStatus).toBe(200);
    expect(r.rows).toBe(0); // the next request's COMMIT must not land the failed request's write
    expect(r.nextRows).toBe(1);
    expect(r.samePid).toBe(false);
    expect(r.state).toBeNull(); // not 'idle in transaction' in the pool
    if (isWrapper) expect(r.throwLog).toMatchObject({ rolledBack: false });
  });

  it('a COMMIT that fails, and then its ROLLBACK: the connection is destroyed, the write never lands', async () => {
    const r = await requestThenNext(run, 'ok', ['COMMIT', 'ROLLBACK'], 'gone');
    expect(r.refused).toEqual({ COMMIT: 1, ROLLBACK: 1 });
    expect(r.answer.status).toBe(500);
    if (isWrapper) expect(r.answer.code).toBe('COMMIT_FAILED');
    expect(r.state).toBeNull();
    expect(r.samePid).toBe(false);
    expect(r.rows).toBe(0);
    expect(r.nextRows).toBe(1);
    if (isWrapper) expect(r.finalizeLog).toMatchObject({ handlerFailed: false, connectionDestroyed: true });
  });

  it.runIf(isWrapper)('a 500 answer whose ROLLBACK fails twice: the connection is destroyed', async () => {
    const r = await requestThenNext(run, 'answer-500', ['ROLLBACK'], 'gone');
    expect(r.refused.ROLLBACK).toBe(2); // the finalize ROLLBACK and the secondary one
    expect(r.answer.status).toBe(500);
    expect(r.state).toBeNull();
    expect(r.samePid).toBe(false);
    expect(r.rows).toBe(0);
    expect(r.finalizeLog).toMatchObject({ handlerFailed: true, connectionDestroyed: true });
  });

  it('a throw whose ROLLBACK succeeds: the connection goes back to the pool and is reused', async () => {
    const r = await requestThenNext(run, 'throw', [], 'idle');
    expect(r.refused).toEqual({ COMMIT: 0, ROLLBACK: 0 });
    expect(r.answer.status).toBe(500);
    expect(r.state).toBe('idle');
    expect(r.samePid).toBe(true);
    expect(r.rows).toBe(0);
    expect(r.nextRows).toBe(1);
  });

  it('a COMMIT that fails but whose ROLLBACK succeeds: rolled back, and the connection is reused', async () => {
    const r = await requestThenNext(run, 'ok', ['COMMIT'], 'idle');
    expect(r.refused).toEqual({ COMMIT: 1, ROLLBACK: 0 });
    expect(r.answer.status).toBe(500);
    expect(r.state).toBe('idle');
    expect(r.samePid).toBe(true);
    expect(r.rows).toBe(0);
    if (isWrapper) expect(r.finalizeLog).toMatchObject({ handlerFailed: false, connectionDestroyed: false });
  });

  it('a 200: committed, and the connection is reused', async () => {
    const r = await requestThenNext(run, 'ok', [], 'idle');
    expect(r.answer.status).toBe(200);
    expect(r.state).toBe('idle');
    expect(r.samePid).toBe(true);
    expect(r.rows).toBe(1);
  });
});
