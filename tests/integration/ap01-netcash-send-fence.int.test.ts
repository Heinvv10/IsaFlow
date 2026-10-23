/**
 * AP-01 residual 3b ("the one remaining double-pay window"): the sender's connection dies (its send lock goes), its
 * PROCESS pauses for longer than SEND_WINDOW_MS, an operator resolves the pending claim failed, a newer claim sends the
 * batch - and the paused send then goes out: paid twice. The sender now takes a monotonic timestamp before its claim
 * transaction and, immediately before the request, refuses to send when more than SEND_START_DEADLINE_MS have passed:
 * nothing reaches Netcash, the claim settles failed ("Netcash never got it"), the answer is a retryable 503.
 *
 * Real route, real netcashService: only Netcash's HTTP endpoint is stubbed (a spy on fetch). The pause is simulated
 * where it happens - the process held between the committed claim and the request (assertNotImpersonating, the await
 * the service passes first) - with the monotonic clock (performance.now) advanced by the pause, as SIGSTOP does.
 * Judged by outcome: what reached Netcash, the rows. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const gate = vi.hoisted(() => ({ armed: false, entered: null as null | (() => void), release: null as null | (() => void), held: null as null | Promise<void> }));
// The sender's pause point: once armed (by the claim's lock query, after the route's own call) the NEXT call - the
// service's, between the committed claim and the request - waits until the test lets it go.
vi.mock('@/lib/auth/impersonationGuard', () => ({
  assertNotImpersonating: vi.fn(async () => {
    if (!gate.armed) return;
    gate.armed = false;
    gate.entered?.();
    await gate.held;
  }),
}));

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import netcashResolve from '../../pages/api/accounting/netcash/resolve';
import { log } from '@/lib/logger';
import { NETCASH_SEND_LOCK_CLASS } from '@/modules/accounting/services/ap/netcashSendLock';
import { SEND_START_DEADLINE_MS } from '@/modules/accounting/services/ap/netcashTimeouts';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { installQueryFaults, resetFaults, faults } from './ap01-netcash-faults.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantApprovedBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
const realFetch = globalThis.fetch;
const netcashCalls: string[] = [];
const TEN_MINUTES = 600_000;

// The monotonic clock, plus however long the "process" has been stopped.
let stoppedMs = 0;
const realNow = performance.now.bind(performance);
let restorePg = () => {};

beforeAll(async () => {
  admin = await createUser(pool, tokens);
  restorePg = installQueryFaults();
  vi.spyOn(performance, 'now').mockImplementation(() => realNow() + stoppedMs);
});
beforeEach(() => {
  stoppedMs = 0; netcashCalls.length = 0; resetFaults();
  gate.armed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes('api.netcash.co.za')) return realFetch(url, init);
    netcashCalls.push(String(url));
    return new Response(JSON.stringify({ batchReference: `NC-FENCE-${netcashCalls.length}` }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.spyOn(performance, 'now').mockImplementation(() => realNow() + stoppedMs); });
afterAll(async () => {
  vi.restoreAllMocks(); restorePg();
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, [admin]);
});

async function fresh() {
  const { company: c, bank } = await payCompany(pool, [[admin, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  return { c, b: await plantApprovedBatch(pool, c, admin, bank) };
}
const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[admin]!, c, 'POST', { batchPaymentId: batchId }, '/api/accounting/netcash/submit');
const resolve = (c: string, id: string, outcome = 'failed') => callRoute(netcashResolve, tokens[admin]!, c, 'POST',
  { submissionId: id, outcome, note: 'portal shows nothing' }, '/api/accounting/netcash/resolve');
const rows = async (c: string) => (await pool.query(
  'SELECT id, status, netcash_response FROM netcash_submissions WHERE company_id = $1 ORDER BY created_at', [c])).rows as
  { id: string; status: string; netcash_response: { fenced?: boolean } | null }[];
const reason = (r: Awaited<ReturnType<typeof submit>>) => JSON.stringify(r.state.body).match(/"reason":"([A-Z_]+)"/)?.[1];

/**
 * Start a submit that stops (the "paused process") between its committed claim and the request. `stoppedFor` is how
 * long the process stays stopped before it continues. Returns the pending response and the means to continue it.
 */
async function pausedSubmit(c: string, batchId: string) {
  gate.held = new Promise<void>((r) => { gate.release = r; });
  const inGap = new Promise<void>((r) => { gate.entered = r; });
  // After the claim's send lock is taken (inside the claim transaction, before COMMIT) the next guard call is the pause.
  faults.rules.push({ match: /pg_try_advisory_lock\(\$1::INT4/, claimOnly: false, act: async (run) => { const out = await run(); gate.armed = true; return out; } });
  const first = submit(c, batchId);
  await inGap;
  const [claim] = await rows(c);
  return { first, claimId: claim!.id, resume: (stoppedFor: number) => { stoppedMs += stoppedFor; gate.release!(); } };
}

describe('the sender-side fence (AP-01 residual 3b)', () => {
  it('a send paused past the deadline between its claim and the request: NOTHING reaches Netcash, the claim settles failed, the batch can be sent again', async () => {
    const { c, b } = await fresh();
    const warns = vi.spyOn(log, 'warn');
    const { first, claimId, resume } = await pausedSubmit(c, b.id);
    resume(TEN_MINUTES);
    const res = await first;
    const afterFence = await rows(c);
    const sentByFenced = netcashCalls.length; // before anything is sent again
    const again = await submit(c, b.id);
    expect({
      http: res.state.statusCode, reason: reason(res), sentByFenced,
      status: afterFence.map((r) => r.status), fenced: afterFence[0]!.netcash_response?.fenced,
      warned: warns.mock.calls.some(([m, d]) => /fence|too late/i.test(String(m)) && JSON.stringify(d).includes(claimId)),
    }).toEqual({ http: 503, reason: 'NETCASH_SEND_FENCED', sentByFenced: 0, status: ['failed'], fenced: true, warned: true });
    expect({ resend: again.state.statusCode, calls: netcashCalls.length, statuses: (await rows(c)).map((r) => r.status) })
      .toEqual({ resend: 200, calls: 1, statuses: ['failed', 'submitted'] });
  }, 30_000);

  it('the double-pay scenario: lock gone, process paused, operator resolves, a newer claim sends, the paused sender wakes - it sends nothing', async () => {
    const { c, b } = await fresh();
    const { first, claimId, resume } = await pausedSubmit(c, b.id);
    // The sender's connection dies: its send lock goes with it. The claim is still 'pending'; the window passes.
    const killed = (await pool.query(`SELECT pg_terminate_backend(pid) AS ok FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2
      AND classid = $1::BIGINT::OID AND objid = (hashtext($2::UUID::TEXT)::BIGINT & 4294967295)::OID`, [NETCASH_SEND_LOCK_CLASS, claimId])).rows;
    expect(killed).toEqual([{ ok: true }]);
    await new Promise((r) => setTimeout(r, 300));
    await pool.query("UPDATE netcash_submissions SET created_at = NOW() - INTERVAL '10 minutes' WHERE id = $1", [claimId]);
    stoppedMs += TEN_MINUTES; // the process has been stopped all along
    const freed = await resolve(c, claimId);
    const newer = await submit(c, b.id); // the gate is spent: this one runs straight through
    resume(0); // the paused sender continues
    const woke = await first;
    expect({
      freed: freed.state.statusCode, newer: newer.state.statusCode, woke: woke.state.statusCode, wokeReason: reason(woke),
      netcashCalls: netcashCalls.length, statuses: (await rows(c)).map((r) => r.status),
    }).toEqual({ freed: 200, newer: 200, woke: 503, wokeReason: 'NETCASH_SEND_FENCED', netcashCalls: 1, statuses: ['failed', 'submitted'] });
    // Never sent, so no "answer after release" note (lateSendResult drives the page's red "may be held twice" text).
    const [fencedRow] = await rows(c);
    expect(fencedRow!.netcash_response).not.toHaveProperty('lateSendResult');
    expect(fencedRow!.netcash_response).toHaveProperty('resolved');
  }, 30_000);

  it('an operator who recorded the claim as SUBMITTED during the pause keeps that: the fenced sender leaves the row alone, no late-answer note, and says so', async () => {
    const { c, b } = await fresh();
    const { first, claimId, resume } = await pausedSubmit(c, b.id);
    await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2
      AND classid = $1::BIGINT::OID AND objid = (hashtext($2::UUID::TEXT)::BIGINT & 4294967295)::OID`, [NETCASH_SEND_LOCK_CLASS, claimId]);
    await new Promise((r) => setTimeout(r, 300));
    await pool.query("UPDATE netcash_submissions SET created_at = NOW() - INTERVAL '10 minutes' WHERE id = $1", [claimId]);
    stoppedMs += TEN_MINUTES;
    expect((await resolve(c, claimId, 'submitted')).state.statusCode).toBe(200);
    resume(0);
    const woke = await first;
    const [row] = await rows(c);
    expect({ http: woke.state.statusCode, reason: reason(woke), calls: netcashCalls.length, status: row!.status, late: 'lateSendResult' in (row!.netcash_response ?? {}),
      says: /resolved this submission \(now submitted\)/.test(JSON.stringify(woke.state.body)) })
      .toEqual({ http: 503, reason: 'NETCASH_SEND_FENCED', calls: 0, status: 'submitted', late: false, says: true });
  }, 30_000);

  it('the fence starts BEFORE the claim transaction: a pause inside it (claim row written, not yet committed) is counted too', async () => {
    const { c, b } = await fresh();
    // The process stops after the claim's INSERT and send lock, before COMMIT; the claim then commits with an old origin.
    faults.rules.push({ match: /pg_try_advisory_lock\(\$1::INT4/, claimOnly: false, act: async (run) => { const out = await run(); stoppedMs += TEN_MINUTES; return out; } });
    const res = await submit(c, b.id);
    expect({ http: res.state.statusCode, reason: reason(res), calls: netcashCalls.length, statuses: (await rows(c)).map((r) => r.status) })
      .toEqual({ http: 503, reason: 'NETCASH_SEND_FENCED', calls: 0, statuses: ['failed'] });
  }, 30_000);

  it('a send that is only slow (paused less than the deadline) still goes, and a fast send is untouched', async () => {
    const slow = await fresh();
    const p = await pausedSubmit(slow.c, slow.b.id);
    p.resume(SEND_START_DEADLINE_MS - 10_000);
    const res = await p.first;
    expect({ http: res.state.statusCode, calls: netcashCalls.length, statuses: (await rows(slow.c)).map((r) => r.status) })
      .toEqual({ http: 200, calls: 1, statuses: ['submitted'] });

    const fast = await fresh();
    const quick = await submit(fast.c, fast.b.id);
    expect({ http: quick.state.statusCode, calls: netcashCalls.length, statuses: (await rows(fast.c)).map((r) => r.status) })
      .toEqual({ http: 200, calls: 2, statuses: ['submitted'] });
  }, 30_000);
});
