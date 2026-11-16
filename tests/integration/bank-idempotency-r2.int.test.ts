/**
 * Audit WP2 row 7, round 2 — the idempotency claim is tenant-pinned, bounded, replay-exact and self-healing.
 * Faults are injected through the real routes and the real withAuth (bank-idempotency.helpers).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('@/lib/logger', async (orig) => (await import('./bank-idempotency.helpers')).loggerWithFault(await orig()));
vi.mock('@/lib/neon', async (orig) => (await import('./bank-idempotency.helpers')).neonWithFault(await orig()));

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';
import { faults, resetFaults } from './bank-idempotency.helpers';
import { withAuth } from '../../src/lib/auth';
import { withErrorHandler } from '../../src/lib/api-error-handler';
import { ImpersonationForbiddenError } from '../../src/lib/auth/impersonationGuard';
import { withHttpIdempotency, payloadHashOf } from '../../src/lib/idempotency/withHttpIdempotency';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import bankManual from '../../pages/api/accounting/bank-transactions-manual';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
let f: BankCompany;
let g: BankCompany;

// A route whose handler the test steers: ok, a big body, or a throw that withErrorHandler maps below 500.
let mode: 'ok' | 'big' | 'forbidden' = 'ok';
const steered = withAuth(withErrorHandler(withHttpIdempotency('test-steered', async (_req, res) => {
  if (mode === 'forbidden') throw new ImpersonationForbiddenError();
  res.status(200).json({ ok: true, filler: mode === 'big' ? 'x'.repeat(70_000) : '' });
}) as never));

beforeAll(async () => {
  a = await createUser(pool, tokens);
  b = await createUser(pool, tokens);
  f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  g = await bankCompany(pool, [[a, 'admin']], companies);
});
beforeEach(() => { resetFaults(); mode = 'ok'; });
afterAll(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]); // ends the pool; the keys go with their companies (ON DELETE CASCADE)
});

const key = () => crypto.randomUUID();
const hdr = (k: string) => ({ 'idempotency-key': k });
const xferBody = (c: BankCompany, o: Record<string, unknown> = {}) =>
  ({ fromAccountId: c.bank, toAccountId: c.bank2, amount: 100, transferDate: '2026-09-01', reference: 'R2', ...o });
const manualBody = (o: Record<string, unknown> = {}) => ({
  type: 'spend', bankAccountId: f.bank, date: '2026-09-01', amount: 50, allocationType: 'account', contraAccountId: f.expA, reference: 'R2', ...o });
const xfer = (c: BankCompany, body: Record<string, unknown>, k: string, user = a) => callRoute(bankTransfers, tokens[user]!, c.c, 'POST', body,
  '/api/accounting/bank-transfers', {}, hdr(k));
const manual = (body: Record<string, unknown>, k: string) => callRoute(bankManual, tokens[a]!, f.c, 'POST', body,
  '/api/accounting/bank-transactions-manual', {}, hdr(k));
const call = (k: string, user = a) => callRoute(steered as never, tokens[user]!, f.c, 'POST', { n: 1 }, '/api/test', {}, hdr(k));
const journals = async (c: string) => (await pool.query('SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;
const claims = async (c: string, k: string) => (await pool.query(
  'SELECT COUNT(*)::INT AS n FROM http_idempotency_keys WHERE company_id = $1 AND idempotency_key = $2', [c, k])).rows[0].n as number;
const plantOld = (c: string, tag: string, n: number, age = '8 days') => pool.query(
  `INSERT INTO http_idempotency_keys(company_id, route, idempotency_key, payload_hash, status_code, response_body, created_at)
   SELECT $1, 'bank-transfers', $2 || '-' || g::TEXT, 'x', 200, '{}'::jsonb, now() - $3::interval FROM generate_series(1, $4) g`, [c, tag, age, n]);

describe('M1: the table is pinned to the acting company (mig 950), even for a member of both', () => {
  it('as app_user acting in company G, company F\'s key can be neither read, updated nor deleted', async () => {
    const k = key();
    await xfer(f, xferBody(f), k);
    const asApp = async (acting: string, sqlText: string) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_user');
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a, aal: 'aal2' })]);
        await c.query("SELECT set_config('app.current_company_id', $1, true)", [acting]);
        const r = await c.query(sqlText, [f.c, k]);
        await c.query('ROLLBACK');
        return r.rowCount;
      } finally { c.release(); }
    };
    const where = 'WHERE company_id = $1 AND idempotency_key = $2';
    expect(await asApp(g.c, `SELECT 1 FROM http_idempotency_keys ${where}`)).toBe(0);
    expect(await asApp(g.c, `UPDATE http_idempotency_keys SET status_code = 500 ${where}`)).toBe(0);
    expect(await asApp(g.c, `DELETE FROM http_idempotency_keys ${where}`)).toBe(0);
    expect(await asApp(f.c, `SELECT 1 FROM http_idempotency_keys ${where}`)).toBe(1); // control: its own company sees it
  });
});

describe('M2: the claim wait is bounded', () => {
  it('a duplicate arriving while the first request holds its claim gets 503 + Retry-After within the bound', async () => {
    const k = key();
    let release: () => void = () => {};
    faults.gate = new Promise<void>((resolve) => { release = resolve; });
    faults.holdAfterSql = /INSERT INTO http_idempotency_keys/;
    const first = xfer(f, xferBody(f, { reference: 'R2-HOLD' }), k);
    const until = Date.now() + 15_000;
    while (!faults.held && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(faults.held).toBe(true);
    const t0 = Date.now();
    const dup = await xfer(f, xferBody(f, { reference: 'R2-HOLD' }), k);
    const waited = Date.now() - t0;
    release();
    expect(dup.state.statusCode, JSON.stringify(dup.state.body)).toBe(503);
    expect(dup.headers.get('retry-after')).toBeDefined();
    expect(waited).toBeLessThan(8_000);
    expect((await first).state.statusCode).toBe(200);
  }, 30_000);
});

describe('M3: pruning skips rows another claim holds', () => {
  it('a claim does not wait on a prune in flight: it finishes while the other request is still paused', async () => {
    await plantOld(f.c, key().slice(0, 8), 30);
    let release: () => void = () => {};
    faults.gate = new Promise<void>((resolve) => { release = resolve; });
    faults.holdAfterSql = /DELETE FROM http_idempotency_keys WHERE id IN/;
    const deadlocksBefore = Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
    const holder = manual(manualBody({ reference: 'R2-P1' }), key());
    const until = Date.now() + 15_000;
    while (!faults.held && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(faults.held).toBe(true);
    const other = await manual(manualBody({ reference: 'R2-P2' }), key()); // would wait on the holder's deleted rows without SKIP LOCKED
    release();
    expect(other.state.statusCode, JSON.stringify(other.state.body)).toBe(201);
    expect((await holder).state.statusCode).toBe(201);
    const deadlocksAfter = Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
    expect(deadlocksAfter - deadlocksBefore).toBe(0);
  }, 30_000);

  it('a claim in company F leaves company G\'s old rows alone', async () => {
    const tag = key().slice(0, 8);
    await plantOld(g.c, tag, 5);
    await xfer(f, xferBody(f, { reference: 'R2-TENANT' }), key());
    const left = await pool.query('SELECT COUNT(*)::INT AS n FROM http_idempotency_keys WHERE company_id = $1 AND idempotency_key LIKE $2', [g.c, `${tag}-%`]);
    expect(left.rows[0].n).toBe(5);
  });
});

describe('scope, owner and failure handling of a claim', () => {
  it('company G with company F\'s key is its own request, not a replay of F\'s answer', async () => {
    const k = key();
    const first = await xfer(f, xferBody(f, { reference: 'R2-XCO' }), k);
    const gBefore = await journals(g.c);
    const second = await xfer(g, xferBody(g, { reference: 'R2-XCO' }), k);
    expect(second.state.statusCode, JSON.stringify(second.state.body)).toBe(200);
    expect(JSON.stringify(second.state.body)).not.toEqual(JSON.stringify(first.state.body));
    expect((await journals(g.c)) - gBefore).toBe(1);
  });

  it('the same key from a different user of the company is 422 "in use", not a replay', async () => {
    const k = key();
    await xfer(f, xferBody(f, { reference: 'R2-USER' }), k);
    const before = await journals(f.c);
    const other = await xfer(f, xferBody(f, { reference: 'R2-USER' }), k, b);
    expect(other.state.statusCode).toBe(422);
    expect(JSON.stringify(other.state.body)).toMatch(/already in use/);
    expect(await journals(f.c)).toBe(before);
  });

  it('a 5xx after the claim frees the key: nothing is kept, and the same key then posts once', async () => {
    const k = key();
    const before = await journals(f.c);
    faults.afterLog = 'Bank transfer posted';
    const crashed = await xfer(f, xferBody(f, { reference: 'R2-5XX' }), k);
    expect(crashed.state.statusCode).toBe(500);
    expect({ journals: (await journals(f.c)) - before, claims: await claims(f.c, k) }).toEqual({ journals: 0, claims: 0 });
    const again = await xfer(f, xferBody(f, { reference: 'R2-5XX' }), k);
    expect(again.state.statusCode).toBe(200);
    expect((await journals(f.c)) - before).toBe(1);
  });

  it('a handler error mapped BELOW 500 frees the claim (it would otherwise commit with no answer)', async () => {
    const k = key();
    mode = 'forbidden';
    expect((await call(k)).state.statusCode).toBe(403);
    expect(await claims(f.c, k)).toBe(0);
    mode = 'ok';
    expect((await call(k)).state.statusCode).toBe(200);
  });

  it('a committed claim with no answer is reclaimable, not "still being processed"', async () => {
    const k = key();
    await pool.query(
      `INSERT INTO http_idempotency_keys(company_id, route, idempotency_key, payload_hash, created_by) VALUES($1,'test-steered',$2,$3,$4)`,
      [f.c, k, payloadHashOf({ n: 1 }), a]);
    const res = await call(k);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('an answer over 64 KB is not stored: the replay says "already processed, reload" instead of a cut body', async () => {
    const k = key();
    mode = 'big';
    const first = await call(k);
    expect(first.state.statusCode).toBe(200);
    expect(JSON.stringify(first.state.body).length).toBeGreaterThan(70_000);
    const again = await call(k);
    expect(again.state.statusCode).toBe(409);
    expect(JSON.stringify(again.state.body)).toMatch(/already processed/);
  });

  it('a claim that vanishes between the INSERT and the SELECT is claimed once more, not answered 409', async () => {
    const k = key();
    expect((await call(k)).state.statusCode).toBe(200);
    let release: () => void = () => {};
    faults.gate = new Promise<void>((resolve) => { release = resolve; });
    faults.holdAfterSql = /ON CONFLICT \(company_id, route, idempotency_key\) DO NOTHING/;
    const second = call(k);
    const until = Date.now() + 15_000;
    while (!faults.held && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(faults.held).toBe(true);
    await pool.query('DELETE FROM http_idempotency_keys WHERE company_id = $1 AND idempotency_key = $2', [f.c, k]); // its owner freed it
    release();
    expect((await second).state.statusCode).toBe(200);
  }, 30_000);
});

describe('W1: the manual route refuses another company\'s account before it writes', () => {
  it('a contra account of another company is a 400, no bank line and no journal', async () => {
    const lines = async () => (await pool.query('SELECT COUNT(*)::INT AS n FROM bank_transactions WHERE company_id = $1', [f.c])).rows[0].n as number;
    const [jb, lb] = [await journals(f.c), await lines()];
    const res = await manual(manualBody({ contraAccountId: g.expA, reference: 'R2-FOREIGN' }), key());
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect({ journals: await journals(f.c), lines: await lines() }).toEqual({ journals: jb, lines: lb });
  });
});
