/**
 * AP-01 round 14 (L2): the late settler's ANSWER_PENDING_RECORD guard lived in the process only - after a restart, or
 * once the settler gave up, an ACCEPTED answer was nowhere the app could see and the pending row was freeable past the
 * send window. When both bounded settle attempts fail the answer is now written durably to audit_log (its own short
 * transaction, entity_type 'netcash_unrecorded_answer', entity_id the submission), and resolve refuses to FREE a
 * pending row whose recorded answer was accepted and is not yet on the row (judged by its settle token), whichever
 * process asks, naming Netcash's outcome and reference. Judged by outcome. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hold = vi.hoisted(() => ({ submitEftBatch: vi.fn(), getSubmissionStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/netcashService', () => hold);

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import netcashResolve from '../../pages/api/accounting/netcash/resolve';
import { dropLateSettlesForTests } from '@/modules/accounting/services/ap/netcashLateSettler';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantApprovedBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-DURABLE' };

beforeAll(async () => { admin = await createUser(pool, tokens); });
beforeEach(() => { hold.submitEftBatch.mockReset(); });
afterEach(() => { delete process.env.NETCASH_LATE_SETTLE_TOTAL_MS; });
afterAll(async () => {
  dropLateSettlesForTests?.();
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
  { submissionId: id, outcome, note: 'portal shows nothing yet' }, '/api/accounting/netcash/resolve');
const status = async (id: string) => (await pool.query('SELECT status FROM netcash_submissions WHERE id = $1', [id])).rows[0].status as string;
const reason = (r: Awaited<ReturnType<typeof submit>>) => JSON.stringify(r.state.body).match(/"reason":"([A-Z_]+)"/)?.[1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Netcash accepts while the row is locked by another transaction: both bounded settles fail; past the send window. */
async function answeredWhileLocked() {
  const { c, b } = await fresh();
  let reply!: (r: unknown) => void;
  let entered!: () => void;
  const inSender = new Promise<void>((r) => { entered = r; });
  hold.submitEftBatch.mockImplementationOnce(() => { entered(); return new Promise((r) => { reply = r; }); });
  const first = submit(c, b.id);
  await inSender;
  const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
  await pool.query("UPDATE netcash_submissions SET created_at = NOW() - INTERVAL '3 minutes' WHERE id = $1", [id]);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT 1 FROM netcash_submissions WHERE id = $1 FOR UPDATE', [id]);
  reply(ACCEPTED);
  const res = await first;
  const unlock = async () => { await blocker.query('ROLLBACK'); blocker.release(); };
  return { c, b, id, res, unlock };
}

describe('an accepted answer the settle could not record survives the process (AP-01 round 14)', () => {
  it('restart (settler gone): resolving the row FAILED is refused 409 naming Netcash\'s answer; recording it SUBMITTED is allowed', async () => {
    const { c, b, id, res, unlock } = await answeredWhileLocked();
    dropLateSettlesForTests(); // a restart: no settler, no in-process guard
    await unlock();
    await sleep(1500);
    const free = await resolve(c, id);
    const freeUpper = await resolve(c, id.toUpperCase()); // the same submission, its id in another case
    const text = JSON.stringify(free.state.body);
    const keep = await resolve(c, id, 'submitted');
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const again = await submit(c, b.id);
    expect({ upper: freeUpper.state.statusCode, first: res.state.statusCode, free: free.state.statusCode, reason: reason(free), outcome: /accepted/.test(text), ref: text.includes('NC-DURABLE'),
      keep: keep.state.statusCode, status: await status(id), resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length })
      .toEqual({ upper: 409, first: 500, free: 409, reason: 'ANSWER_PENDING_RECORD', outcome: true, ref: true, keep: 200, status: 'submitted', resend: 409, sends: 1 });
  }, 30_000);

  it('REPRO 5 (adversarial, round 13): past the send window, no send lock, the settler still failing: resolve is refused 409 in any id case, and the row ends submitted', async () => {
    const { c, id, unlock } = await answeredWhileLocked(); // aged past the window before the lock; the stall continues
    const pendingNow = await status(id);
    const during = await resolve(c, id);
    const duringUpper = await resolve(c, id.toUpperCase());
    // Recording it submitted is what the durable record allows; while the settler writes, the in-process guard refuses
    // even that - whatever the case of the id.
    const keepUpper = await resolve(c, id.toUpperCase(), 'submitted');
    await unlock();
    for (let i = 0; i < 80 && await status(id) === 'pending'; i++) await sleep(250);
    expect({ pendingNow, during: during.state.statusCode, reason: reason(during), upper: duringUpper.state.statusCode, keepUpper: keepUpper.state.statusCode, final: await status(id) })
      .toEqual({ pendingNow: 'pending', during: 409, reason: 'ANSWER_PENDING_RECORD', upper: 409, keepUpper: 409, final: 'submitted' });
  }, 40_000);

  it('once the settler has put the answer on the row, resolve behaves as for any submitted row', async () => {
    const { c, id, unlock } = await answeredWhileLocked();
    await unlock();
    for (let i = 0; i < 75 && await status(id) === 'pending'; i++) await sleep(200);
    expect(await status(id)).toBe('submitted');
    const res = await resolve(c, id); // submitted -> failed: the operator's attestation, as always
    expect({ http: res.state.statusCode, status: await status(id) }).toEqual({ http: 200, status: 'failed' });
  }, 30_000);

  it('after the settler gives up the row is still refused', async () => {
    process.env.NETCASH_LATE_SETTLE_TOTAL_MS = '2500';
    const { c, id, unlock } = await answeredWhileLocked();
    await sleep(6000); // the settler tries and gives up while the row is still held
    await unlock();
    const res = await resolve(c, id);
    expect({ http: res.state.statusCode, reason: reason(res), status: await status(id) }).toEqual({ http: 409, reason: 'ANSWER_PENDING_RECORD', status: 'pending' });
  }, 30_000);

  it('the record is read in the submission\'s own company only', async () => {
    const A = await fresh();
    const B = await fresh();
    const plant = async (c: string) => (await pool.query(
      `INSERT INTO netcash_submissions (company_id, submission_type, batch_reference, total_amount_cents, record_count, status, created_by, created_at)
       VALUES ($1, 'eft_payment', 'BAT-X', 100, 1, 'pending', 'x', NOW() - INTERVAL '3 minutes') RETURNING id`, [c])).rows[0].id as string;
    const record = (c: string, id: string, settled = 'submitted') => pool.query(
      `INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, entity_ref, changes)
       VALUES ($1, $2, 'create', 'netcash_unrecorded_answer', $3, 'NC-OTHER',
         jsonb_build_object('metadata', jsonb_build_object('status', $4::TEXT, 'outcome', 'accepted', 'batchReference', 'NC-OTHER', 'settleToken', gen_random_uuid()::TEXT)))`,
      [c, admin, id, settled]);
    const elsewhere = await plant(A.c);
    await record(B.c, elsewhere); // another tenant's record naming A's submission
    const own = await plant(A.c);
    await record(A.c, own);
    const unknown = await plant(A.c);
    await record(A.c, unknown, 'unknown'); // no definite answer from Netcash: the operator checks and frees as usual
    const a = await resolve(A.c, elsewhere);
    const b = await resolve(A.c, own);
    const u = await resolve(A.c, unknown);
    expect({ elsewhere: a.state.statusCode, own: b.state.statusCode, ownReason: reason(b), unknown: u.state.statusCode })
      .toEqual({ elsewhere: 200, own: 409, ownReason: 'ANSWER_PENDING_RECORD', unknown: 200 });
  });
});
