/**
 * AP-01 round 10: an operator could release a 'pending' claim by its AGE while the sender was only stalled (a paused
 * process); Netcash then accepted the late send, the row stayed 'failed' with the answer tucked into lateSendResult,
 * and a resend paid the batch twice. Now:
 *   - the sender holds a session advisory lock keyed on the claim id (taken before the claim commits, released after
 *     the settle, gone with its connection), and resolve refuses 409 IN_FLIGHT while it is held, at any age;
 *   - a late answer that finds its row 'failed' puts it back to 'submitted'/'unknown' (the batch closes again), and if
 *     a newer claim already holds the batch it answers 409 naming both submissions.
 * Judged by outcome: the stub sender's call count, the rows, pg_locks. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hold = vi.hoisted(() => ({ submitEftBatch: vi.fn(), getSubmissionStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/netcashService', () => hold);

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import netcashResolve from '../../pages/api/accounting/netcash/resolve';
import { log } from '@/lib/logger';
import { NETCASH_SEND_LOCK_CLASS } from '@/modules/accounting/services/ap/netcashSendLock';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantApprovedBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-LIVE' };
const UNKNOWN = { success: false, outcome: 'unknown', error: 'The operation was aborted' };
const REJECTED = { success: false, outcome: 'rejected', error: 'Invalid account' };

beforeAll(async () => { admin = await createUser(pool, tokens); });
beforeEach(() => { hold.submitEftBatch.mockReset(); vi.restoreAllMocks(); });
afterAll(async () => {
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, [admin]);
});

async function fresh() {
  const { company: c, bank } = await payCompany(pool, [[admin, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  return { c, b: await plantApprovedBatch(pool, c, admin, bank) };
}
const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[admin]!, c, 'POST', { batchPaymentId: batchId }, '/api/accounting/netcash/submit');
const resolve = (c: string, id: string) => callRoute(netcashResolve, tokens[admin]!, c, 'POST',
  { submissionId: id, outcome: 'failed', note: 'portal shows nothing' }, '/api/accounting/netcash/resolve');
const row = async (id: string) => (await pool.query('SELECT status, netcash_response FROM netcash_submissions WHERE id = $1', [id])).rows[0] as
  { status: string; netcash_response: { lateSendResult?: { status: string } } | null };
/** Send locks held now, on any connection (the two-key advisory form: classid, objid, objsubid 2). */
const sendLocks = async (id?: string) => Number((await pool.query(
  `SELECT count(*)::INT AS n FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 AND classid = $1::BIGINT::OID
     AND ($2::UUID IS NULL OR objid = (hashtext($2::UUID::TEXT)::BIGINT & 4294967295)::OID)`, [NETCASH_SEND_LOCK_CLASS, id ?? null])).rows[0].n);
const body = (r: Awaited<ReturnType<typeof submit>>) => r.state.body as { details?: Record<string, unknown>; error?: { details?: Record<string, unknown> } };

/** Submit #1 stalled inside the sender (a paused process): its claim is 'pending'. `answer(x)` lets Netcash reply. */
async function stalled() {
  const { c, b } = await fresh();
  let reply!: (r: unknown) => void;
  let entered!: () => void;
  const inSender = new Promise<void>((r) => { entered = r; });
  hold.submitEftBatch.mockImplementationOnce(() => { entered(); return new Promise((r) => { reply = r; }); });
  const first = submit(c, b.id);
  await inSender;
  const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
  return { c, b, id, first, answer: (r: unknown) => reply(r) };
}

describe('a send that is still live keeps its claim (AP-01 round 10)', () => {
  it('REPRO A: a claim past the send window whose sender is only paused is refused 409 IN_FLIGHT; Netcash accepts late; no second send', async () => {
    const { c, b, id, first, answer } = await stalled();
    await pool.query("UPDATE netcash_submissions SET created_at = NOW() - INTERVAL '10 minutes' WHERE id = $1", [id]);
    const locked = await sendLocks(id);
    const res = await resolve(c, id);
    answer(ACCEPTED);
    const done = await first;
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const again = await submit(c, b.id);
    expect({
      locked, resolve: res.state.statusCode, reason: JSON.stringify(res.state.body).includes('IN_FLIGHT'), first: done.state.statusCode,
      rowStatus: (await row(id)).status, resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length,
    }).toEqual({ locked: 1, resolve: 409, reason: true, first: 200, rowStatus: 'submitted', resend: 409, sends: 1 });
  });

  it.each([['accepted', ACCEPTED], ['unknown', UNKNOWN], ['rejected', REJECTED]])('no send lock outlives a send answered %s', async (_n, answered) => {
    const { c, b } = await fresh();
    hold.submitEftBatch.mockResolvedValue(answered);
    await submit(c, b.id);
    await submit(c, b.id); // refused 409 (claimed), or after a rejection a second claim and send
    expect(await sendLocks()).toBe(0);
  });

  it('a sender whose connection dies loses its lock: the claim is resolvable past the window, and the late acceptance closes the batch again', async () => {
    const { c, b, id, first, answer } = await stalled();
    await killSender(id);
    expect((await resolve(c, id)).state.statusCode).toBe(409); // second guard: younger than the send window, it may still be sending
    await pool.query("UPDATE netcash_submissions SET created_at = NOW() - INTERVAL '3 minutes' WHERE id = $1", [id]);
    expect((await resolve(c, id)).state.statusCode).toBe(200);
    answer(ACCEPTED);
    // Round 11: the settle failed on the dead connection and was retried on a fresh one, which found the row failed
    // and put it back (reopened) - before round 11 the answer was lost (500) and the row stayed failed.
    const res = await first;
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const again = await submit(c, b.id);
    expect({ first: res.state.statusCode, reopened: JSON.stringify(res.state.body).includes('"reopened":true'), status: (await row(id)).status,
      resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length, locks: await sendLocks() })
      .toEqual({ first: 409, reopened: true, status: 'submitted', resend: 409, sends: 1, locks: 0 });
  });

  it('REPRO 1 (adversarial round 11): Netcash accepts promptly but the claim connection was cut: the answer still lands and the batch stays closed', async () => {
    const { c, b, id, first, answer } = await stalled();
    await killSender(id);
    answer(ACCEPTED);
    const res = await first;
    const after = await row(id);
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const again = await submit(c, b.id);
    expect({
      first: res.state.statusCode, status: after.status, answerKept: JSON.stringify(after.netcash_response ?? {}).includes('NC-LIVE'),
      resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length,
    }).toEqual({ first: 200, status: 'submitted', answerKept: true, resend: 409, sends: 1 });
  });
});

/** Terminate the claim's connection (a network blip, a restart): its send lock goes with it. */
async function killSender(id: string) {
  const killed = (await pool.query(`SELECT pg_terminate_backend(pid) AS ok FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2
    AND classid = $1::BIGINT::OID AND objid = (hashtext($2::UUID::TEXT)::BIGINT & 4294967295)::OID`, [NETCASH_SEND_LOCK_CLASS, id])).rows;
  expect(killed).toEqual([{ ok: true }]);
  for (let i = 0; i < 100 && await sendLocks(id) > 0; i++) await new Promise((r) => setTimeout(r, 20));
  expect(await sendLocks(id)).toBe(0);
}

describe('a late answer that finds its row failed (AP-01 round 10, defence in depth)', () => {
  /** The guards bypassed: the row is set 'failed' underneath a live send (as a lost lock plus a resolve could). */
  async function failedUnderneath() {
    const s = await stalled();
    await pool.query("UPDATE netcash_submissions SET status = 'failed' WHERE id = $1", [s.id]);
    return s;
  }

  it.each([['accepted', 'submitted', ACCEPTED], ['unknown', 'unknown', UNKNOWN]])('Netcash answering %s puts the row back to %s and the batch closes again', async (_n, back, answered) => {
    const { c, b, id, first, answer } = await failedUnderneath();
    answer(answered);
    const res = await first;
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const again = await submit(c, b.id);
    const after = await row(id);
    expect({
      first: res.state.statusCode, reason: JSON.stringify(res.state.body).includes('CLAIM_RESOLVED_DURING_SEND'), status: after.status,
      late: after.netcash_response?.lateSendResult?.status, resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length,
    }).toEqual({ first: 409, reason: true, status: back, late: back, resend: 409, sends: 1 });
  });

  it('a rejected late answer leaves the row failed', async () => {
    const { id, first, answer } = await failedUnderneath();
    answer(REJECTED);
    const res = await first;
    const details = body(res).details ?? body(res).error?.details ?? {};
    expect({ http: res.state.statusCode, reopened: details.reopened, status: (await row(id)).status }).toEqual({ http: 409, reopened: false, status: 'failed' });
  });

  it('when a newer claim already holds the batch: 409 naming both submissions, logged, and the newer claim stands', async () => {
    const { c, b, id, first, answer } = await failedUnderneath();
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    expect((await submit(c, b.id)).state.statusCode).toBe(200); // the batch was sent again
    const newer = (await pool.query("SELECT id FROM netcash_submissions WHERE company_id = $1 AND id <> $2", [c, id])).rows[0].id as string;
    const errors = vi.spyOn(log, 'error');
    answer(ACCEPTED);
    const res = await first;
    const details = body(res).details ?? body(res).error?.details ?? {};
    expect({ http: res.state.statusCode, newer: details.newerSubmissionId, status: (await row(id)).status, newerStatus: (await row(newer)).status })
      .toEqual({ http: 409, newer, status: 'failed', newerStatus: 'submitted' });
    expect(JSON.stringify(res.state.body)).toMatch(/paid twice/i);
    expect(errors.mock.calls.some(([, data]) => JSON.stringify(data).includes(id) && JSON.stringify(data).includes(newer))).toBe(true);
  });
});
