/**
 * AP-01 round 13 (adversarial R4): round 12 bounded the settle, so a row lock or a slow database that outlasts both
 * bounded attempts ended in 500 NOT_RECORDED - and nothing ever wrote the ACCEPTED answer afterwards. Past the send
 * window an operator could free the row and a resend would pay twice. Now, after both attempts fail, a detached
 * in-process settler keeps retrying the same compare-and-set settle (same token, same late-answer branch) with backoff,
 * holding no send slot; resolve refuses 409 ANSWER_PENDING_RECORD while it runs. Judged by outcome: row status and
 * reference, resolve's answer, sends. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hold = vi.hoisted(() => ({ submitEftBatch: vi.fn(), getSubmissionStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/netcashService', () => hold);

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import netcashResolve from '../../pages/api/accounting/netcash/resolve';
import { log } from '@/lib/logger';
import { isAnswerPendingRecord } from '@/modules/accounting/services/ap/netcashLateSettler';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-LATE' };

beforeAll(async () => { admin = await createUser(pool, tokens); });
beforeEach(() => { hold.submitEftBatch.mockReset(); });
afterEach(() => { delete process.env.NETCASH_LATE_SETTLE_TOTAL_MS; vi.restoreAllMocks(); });
afterAll(async () => {
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, [admin]);
});

async function fresh() {
  const { company: c, bank } = await payCompany(pool, [[admin, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  return { c, b: await plantBatch(pool, c, admin, bank) };
}
const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[admin]!, c, 'POST', { batchPaymentId: batchId }, '/api/accounting/netcash/submit');
const resolve = (c: string, id: string, outcome = 'failed') => callRoute(netcashResolve, tokens[admin]!, c, 'POST',
  { submissionId: id, outcome, note: 'portal shows nothing yet' }, '/api/accounting/netcash/resolve');
const row = async (id: string) => (await pool.query('SELECT status, batch_reference, netcash_response FROM netcash_submissions WHERE id = $1', [id])).rows[0] as
  { status: string; batch_reference: string | null; netcash_response: Record<string, unknown> | null };
const reason = (r: Awaited<ReturnType<typeof submit>>) => JSON.stringify(r.state.body).match(/"reason":"([A-Z_]+)"/)?.[1];
/** Wait until `pred` holds or `ms` passes; the last value either way. */
async function until<T>(get: () => Promise<T>, pred: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!pred(v) && Date.now() < end) { await new Promise((r) => setTimeout(r, 200)); v = await get(); }
  return v;
}

/** A send whose row is locked by another transaction when Netcash answers: both bounded settle attempts fail. */
async function answeredWhileLocked() {
  const { c, b } = await fresh();
  let reply!: (r: unknown) => void;
  let entered!: () => void;
  const inSender = new Promise<void>((r) => { entered = r; });
  hold.submitEftBatch.mockImplementationOnce(() => { entered(); return new Promise((r) => { reply = r; }); });
  const first = submit(c, b.id);
  await inSender;
  const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
  // Past the send window already: once the sender ends, only the settler keeps resolve away from this claim.
  await pool.query("UPDATE netcash_submissions SET created_at = NOW() - INTERVAL '3 minutes' WHERE id = $1", [id]);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT 1 FROM netcash_submissions WHERE id = $1 FOR UPDATE', [id]);
  reply(ACCEPTED);
  const res = await first;
  return { c, b, id, res, blocker };
}

describe('a detached settler records an answer both bounded attempts could not (AP-01 round 13)', () => {
  it('REPRO 4: the answer lands once the stall is over; resolve is refused meanwhile; no second send', async () => {
    const { c, b, id, res, blocker } = await answeredWhileLocked();
    // Resolve while the stall lasts. The stall outlasts the settler's first attempt (at ~1 s, given up at its 2 s
    // lock_timeout), so the answer lands on a later one; a resolve that got through would write once it ends.
    const duringP = resolve(c, id);
    await new Promise((r) => setTimeout(r, 3500));
    await blocker.query('ROLLBACK');
    blocker.release();
    const during = await duringP;
    const after = await until(() => row(id), (r) => r.status !== 'pending', 15_000);
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const again = await submit(c, b.id);
    expect({
      first: res.state.statusCode, firstReason: reason(res), during: during?.state.statusCode, duringReason: during ? reason(during) : null,
      status: after.status, reference: after.batch_reference, resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length,
    }).toEqual({
      first: 500, firstReason: 'NETCASH_ANSWER_NOT_RECORDED', during: 409, duringReason: 'ANSWER_PENDING_RECORD',
      status: 'submitted', reference: 'NC-LATE', resend: 409, sends: 1,
    });
  }, 40_000);

  it('the settler gives up after NETCASH_LATE_SETTLE_TOTAL_MS, logs the full answer, and drops its in-process guard (the durable record still guards)', async () => {
    process.env.NETCASH_LATE_SETTLE_TOTAL_MS = '3000';
    const errors = vi.spyOn(log, 'error');
    const { c, id, blocker } = await answeredWhileLocked();
    try {
      const gaveUp = await until(async () => errors.mock.calls.some(([m, d]) => /gave up/i.test(String(m)) && JSON.stringify(d).includes('NC-LATE')), Boolean, 15_000);
      expect(gaveUp).toBe(true);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    // Round 14: the acceptance kept in audit_log still refuses freeing the row (ap01-netcash-durable-answer); recording
    // it as submitted is what the operator does.
    const res = await resolve(c, id, 'submitted');
    expect({ inProcess: isAnswerPendingRecord(id), http: res.state.statusCode, status: (await row(id)).status })
      .toEqual({ inProcess: false, http: 200, status: 'submitted' });
  }, 40_000);

  it('it never overwrites an operator\'s resolution made elsewhere: compare-and-set, the answer kept beside it', async () => {
    const { id, blocker } = await answeredWhileLocked();
    try {
      // Another process's resolve, committed while this one's settler waits: Netcash has it.
      await blocker.query(`UPDATE netcash_submissions SET status = 'submitted',
        netcash_response = COALESCE(netcash_response, '{}'::JSONB) || '{"resolved":{"outcome":"submitted"}}'::JSONB WHERE id = $1`, [id]);
      await blocker.query('COMMIT');
    } finally {
      blocker.release();
    }
    const after = await until(() => row(id), (r) => Boolean(r.netcash_response?.lateSendResult), 15_000);
    expect({ status: after.status, resolved: Boolean(after.netcash_response?.resolved), late: Boolean(after.netcash_response?.lateSendResult),
      settledByIt: Boolean(after.netcash_response?.settleToken) })
      .toEqual({ status: 'submitted', resolved: true, late: true, settledByIt: false });
  }, 40_000);
});
