/**
 * AP-01 round 11: the claim's connection. Each send holds the request's connection (auth pool) plus the claim's (main
 * pool, PG_POOL_MAX) for up to the send timeout, so:
 *   M1  a small in-process cap on sends in flight (NETCASH_MAX_CONCURRENT_SENDS, default 3) refuses 503 before the
 *       claim connection is checked out, and that checkout is bounded (CLAIM_CONNECTION_TIMEOUT_MS): nothing claimed,
 *       nothing sent;
 *   L1  the send lock is TRY-locked: a held key (a hashtext collision) rolls the claim back and answers 409;
 *   L2  every path that may leave the lock on the connection destroys it instead of pooling it.
 * Faults are injected by wrapping pg.Client.prototype.query (the app's pool uses the same pg). Judged by outcome:
 * the stub sender's call count, claim rows, pg_locks and whether the claim's backend is gone. Disposable DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hold = vi.hoisted(() => ({ submitEftBatch: vi.fn(), getSubmissionStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/netcashService', () => hold);

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { getPoolForTests } from '@/lib/neon';
import { log } from '@/lib/logger';
import { NETCASH_SEND_LOCK_CLASS } from '@/modules/accounting/services/ap/netcashSendLock';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { faults as hooks, injected, installQueryFaults, resetFaults, type Rule } from './ap01-netcash-faults.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-CONN' };

let restorePg = () => {};
beforeAll(async () => {
  admin = await createUser(pool, tokens);
  restorePg = installQueryFaults();
});
beforeEach(() => { hold.submitEftBatch.mockReset(); resetFaults(); });
afterEach(() => { delete process.env.NETCASH_MAX_CONCURRENT_SENDS; });
afterAll(async () => {
  restorePg();
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, [admin]);
});

async function fresh() {
  const { company: c, bank } = await payCompany(pool, [[admin, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  return { c, b: await plantBatch(pool, c, admin, bank) };
}
const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[admin]!, c, 'POST', { batchPaymentId: batchId }, '/api/accounting/netcash/submit');
const claims = async (c: string) => Number((await pool.query('SELECT count(*)::INT AS n FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].n);
const reason = (r: Awaited<ReturnType<typeof submit>>) => JSON.stringify(r.state.body).match(/"reason":"([A-Z_]+)"/)?.[1];
const sendLocks = async () => Number((await pool.query(
  "SELECT count(*)::INT AS n FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 AND classid = $1::BIGINT::OID", [NETCASH_SEND_LOCK_CLASS])).rows[0].n);
/** Whether the claim's backend still exists, waited for briefly (a destroyed client's backend exits on its own). */
async function claimBackendAlive(): Promise<boolean> {
  const pid = hooks.claim?.pid;
  if (!pid) throw new Error('the claim connection was never seen');
  for (let i = 0; i < 100; i++) {
    if (Number((await pool.query('SELECT count(*)::INT AS n FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0].n) === 0) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

describe('M1: sends in flight are capped, and the claim connection is checked out within a bound', () => {
  it('with 3 sends held (the default cap) a 4th submit is refused 503 before any claim; once they finish it goes', async () => {
    const replies: Array<() => void> = [];
    const firsts = [];
    for (let i = 0; i < 3; i++) {
      const { c, b } = await fresh();
      let entered!: () => void;
      const inSender = new Promise<void>((r) => { entered = r; });
      hold.submitEftBatch.mockImplementationOnce(() => { entered(); return new Promise((r) => { replies.push(() => r(ACCEPTED)); }); });
      firsts.push(submit(c, b.id));
      await inSender;
    }
    hold.submitEftBatch.mockResolvedValue(ACCEPTED); // what a 4th send would get, were it let through
    const fourth = await fresh();
    const refused = await submit(fourth.c, fourth.b.id);
    const outcome = { http: refused.state.statusCode, reason: reason(refused), claims: await claims(fourth.c), sends: hold.submitEftBatch.mock.calls.length };
    replies.forEach((r) => r());
    expect((await Promise.all(firsts)).map((r) => r.state.statusCode)).toEqual([200, 200, 200]);
    expect(outcome).toEqual({ http: 503, reason: 'NETCASH_SENDS_BUSY', claims: 0, sends: 3 });
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    expect((await submit(fourth.c, fourth.b.id)).state.statusCode).toBe(200);
  });

  it('NETCASH_MAX_CONCURRENT_SENDS=1: a second submit while one is held is refused', async () => {
    process.env.NETCASH_MAX_CONCURRENT_SENDS = '1';
    const one = await fresh();
    let reply!: () => void;
    let entered!: () => void;
    const inSender = new Promise<void>((r) => { entered = r; });
    hold.submitEftBatch.mockImplementationOnce(() => { entered(); return new Promise((r) => { reply = () => r(ACCEPTED); }); });
    const first = submit(one.c, one.b.id);
    await inSender;
    hold.submitEftBatch.mockResolvedValue(ACCEPTED);
    const two = await fresh();
    const refused = await submit(two.c, two.b.id);
    reply();
    await first;
    expect({ http: refused.state.statusCode, claims: await claims(two.c), sends: hold.submitEftBatch.mock.calls.length }).toEqual({ http: 503, claims: 0, sends: 1 });
  });

  it('no claim connection within the bound (pool exhausted): 503, nothing claimed or sent, and the late connection is not leaked', async () => {
    const { c, b } = await fresh();
    const app = getPoolForTests();
    // Every connection of the main pool (the claim's; the request's transaction is on the auth pool) is taken.
    const held = await Promise.all(Array.from({ length: Number(app.options.max) }, () => app.connect()));
    hold.submitEftBatch.mockResolvedValue(ACCEPTED);
    let res: Awaited<ReturnType<typeof submit>>;
    try {
      res = await submit(c, b.id);
    } finally {
      held.forEach((h) => h.release());
    }
    expect({ http: res.state.statusCode, reason: reason(res), claims: await claims(c), sends: hold.submitEftBatch.mock.calls.length })
      .toEqual({ http: 503, reason: 'NETCASH_CONNECTION_BUSY', claims: 0, sends: 0 });
    for (let i = 0; i < 50 && app.waitingCount > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(app.waitingCount).toBe(0);
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    expect((await submit(c, b.id)).state.statusCode).toBe(200); // neither a slot nor a connection was kept
  });
});

describe('L1: the send lock is try-locked', () => {
  it('a key already held (a hashtext collision) rolls the claim back: 409, no claim row, nothing sent; the retry goes', async () => {
    const { c, b } = await fresh();
    const blocker = await pool.connect();
    let blocked = '';
    hooks.rules.push({ match: /INSERT INTO netcash_submissions/, claimOnly: false, act: async (run) => {
      const out = await run() as { rows: Array<{ id: string }> };
      blocked = out.rows[0]!.id;
      await blocker.query('SELECT pg_advisory_lock($1::INT4, hashtext($2::UUID::TEXT))', [NETCASH_SEND_LOCK_CLASS, blocked]);
      setTimeout(() => { void blocker.query('SELECT pg_advisory_unlock_all()'); }, 1500); // a blocking lock would then go on and send
      return out;
    } });
    hold.submitEftBatch.mockResolvedValue(ACCEPTED);
    const res = await submit(c, b.id);
    const outcome = { http: res.state.statusCode, reason: reason(res), claims: await claims(c), sends: hold.submitEftBatch.mock.calls.length };
    await new Promise((r) => setTimeout(r, 1600));
    blocker.release();
    expect(blocked).not.toBe('');
    expect(outcome).toEqual({ http: 409, reason: 'NETCASH_SEND_LOCK_BUSY', claims: 0, sends: 0 });
    expect((await submit(c, b.id)).state.statusCode).toBe(200);
  });
});

describe('L2: a connection that may hold the send lock is destroyed, never pooled', () => {
  it.each([
    ['the unlock throws', { match: /pg_advisory_unlock\(\$1::INT4/, claimOnly: true, act: injected('unlock') }],
    ['the unlock finds no lock (returns false)', { match: /pg_advisory_unlock\(\$1::INT4/, claimOnly: true, act: async () => ({ rows: [{ ok: false }], rowCount: 1 }) }],
  ])('%s: the send is recorded, the lock is gone and the claim backend is closed', async (_n, rule) => {
    const { c, b } = await fresh();
    hooks.rules.push(rule as Rule);
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const res = await submit(c, b.id);
    expect({ http: res.state.statusCode, alive: await claimBackendAlive(), locks: await sendLocks(), claims: await claims(c) })
      .toEqual({ http: 200, alive: false, locks: 0, claims: 1 });
  });

  it('the settle fails and its ROLLBACK fails (unusable): the backend is closed, the lock gone, and the retry on a fresh connection records the answer', async () => {
    const { c, b } = await fresh();
    hooks.rules.push({ match: /SET status = \$3, batch_reference = \$4, netcash_response = \$5/, claimOnly: true, act: injected('settle') });
    hooks.rules.push({ match: /^ROLLBACK$/, claimOnly: true, act: injected('rollback') });
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const res = await submit(c, b.id);
    const status = (await pool.query('SELECT status FROM netcash_submissions WHERE company_id = $1', [c])).rows.map((r) => r.status);
    expect({ http: res.state.statusCode, alive: await claimBackendAlive(), locks: await sendLocks(), status })
      .toEqual({ http: 200, alive: false, locks: 0, status: ['submitted'] });
  });

  it('the claim COMMIT fails after the lock was taken: nothing claimed or sent, the lock is gone, the backend closed', async () => {
    const { c, b } = await fresh();
    hooks.rules.push({ match: /^COMMIT$/, claimOnly: true, act: injected('commit') });
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const res = await submit(c, b.id);
    expect({ http: res.state.statusCode, alive: await claimBackendAlive(), locks: await sendLocks(), claims: await claims(c), sends: hold.submitEftBatch.mock.calls.length })
      .toEqual({ http: 500, alive: false, locks: 0, claims: 0, sends: 0 });
  });

  it('control: a clean send returns its connection to the pool (the backend stays) with no lock left', async () => {
    const { c, b } = await fresh();
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    expect((await submit(c, b.id)).state.statusCode).toBe(200);
    expect({ alive: await claimBackendAliveNow(), locks: await sendLocks() }).toEqual({ alive: true, locks: 0 });
  });
});

describe('A (adversarial round 11): a settle that fails on the claim connection is retried once on a fresh one', () => {
  const SETTLE = /SET status = \$3, batch_reference = \$4, netcash_response = \$5/;

  it('the retry fails too: 500 whose body gives Netcash\'s answer (accepted + reference, do not resend), the row stays pending, the full answer logged', async () => {
    const { c, b } = await fresh();
    hooks.rules.push({ match: SETTLE, claimOnly: true, act: injected('settle') });
    hooks.rules.push({ match: /netcash_settle_retry/, claimOnly: false, act: injected('settle retry') });
    const errors = vi.spyOn(log, 'error');
    hold.submitEftBatch.mockResolvedValue(ACCEPTED);
    const res = await submit(c, b.id);
    const text = JSON.stringify(res.state.body);
    const status = (await pool.query('SELECT status FROM netcash_submissions WHERE company_id = $1', [c])).rows.map((r) => r.status);
    const loggedAnswer = errors.mock.calls.some(([, data]) => JSON.stringify(data).includes('NC-CONN') && JSON.stringify(data).includes('accepted'));
    errors.mockRestore();
    expect({ http: res.state.statusCode, reason: reason(res), accepted: /accepted/.test(text), ref: text.includes('NC-CONN'),
      noRetry: /not resend|do not send it again|don't resend/i.test(text), status, loggedAnswer, resend: (await submit(c, b.id)).state.statusCode,
      sends: hold.submitEftBatch.mock.calls.length })
      .toEqual({ http: 500, reason: 'NETCASH_ANSWER_NOT_RECORDED', accepted: true, ref: true, noRetry: true, status: ['pending'], loggedAnswer: true, resend: 409, sends: 1 });
  });

  it('the first settle committed but its reply was lost: the retry sees its own answer on the row and reports success', async () => {
    const { c, b } = await fresh();
    // The claim connection's second COMMIT is the settle's: it lands, then the client reports an error.
    hooks.rules.push({ match: /^COMMIT$/, claimOnly: true, skip: 1, act: async (run) => { await run(); throw new Error('injected: reply lost'); } });
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const res = await submit(c, b.id);
    const status = (await pool.query('SELECT status FROM netcash_submissions WHERE company_id = $1', [c])).rows.map((r) => r.status);
    expect({ http: res.state.statusCode, status, locks: await sendLocks() }).toEqual({ http: 200, status: ['submitted'], locks: 0 });
  });

  it('the retry\'s checkout is bounded: with the main pool exhausted it gives up within CLAIM_CONNECTION_TIMEOUT_MS (not the pool\'s 15 s)', async () => {
    const { c, b } = await fresh();
    const app = getPoolForTests();
    let held: Array<{ release: () => void }> = [];
    hooks.rules.push({ match: SETTLE, claimOnly: true, act: async () => {
      held = await Promise.all(Array.from({ length: Number(app.options.max) - app.totalCount + app.idleCount }, () => app.connect()));
      throw new Error('injected: settle');
    } });
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const started = Date.now();
    const res = await submit(c, b.id);
    const took = Date.now() - started;
    held.forEach((h) => h.release());
    expect({ http: res.state.statusCode, reason: reason(res), fast: took < 8000 }).toEqual({ http: 500, reason: 'NETCASH_ANSWER_NOT_RECORDED', fast: true });
  });
});

async function claimBackendAliveNow(): Promise<boolean> {
  return Number((await pool.query('SELECT count(*)::INT AS n FROM pg_stat_activity WHERE pid = $1', [hooks.claim!.pid])).rows[0].n) === 1;
}
