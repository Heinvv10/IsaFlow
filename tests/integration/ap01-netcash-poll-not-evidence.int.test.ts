/**
 * AP-01 round 9: a Netcash status poll is NEVER evidence for freeing a batch. The poller reads free text ("Processing
 * - 0 errors" holds "error"), so resolve used to free a submitted/processing row on a poll flagged as a failure - an
 * accepted batch could then be paid twice. Now an owner/admin frees a submitted/processing row by an explicit
 * attestation (required note, audit-logged) whatever the poll said, and the poll's answer is a display hint only:
 * merged into netcash_response (never a whole-object rewrite from a stale read), and an older answer never
 * overwrites a newer one. Judged by outcome: the stub sender's call count and the row. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hold = vi.hoisted(() => ({
  park: null as null | { re: RegExp; entered: () => void; release: Promise<void> },
  submitEftBatch: vi.fn(),
  getSubmissionStatus: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({
  submitEftBatch: hold.submitEftBatch, getSubmissionStatus: hold.getSubmissionStatus,
}));
vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (hold.park && hold.park.re.test(text)) {
      const { entered, release } = hold.park;
      hold.park = null;
      // An UPDATE is parked BEFORE it runs; a SELECT AFTER it has read.
      if (/^\s*UPDATE/i.test(text)) return (async () => { entered(); await release; return original.sql(strings, ...values); })();
      return original.sql(strings, ...values).then(async (rows) => { entered(); await release; return rows; });
    }
    return original.sql(strings, ...values);
  };
  Object.assign(sql, { transaction: original.sql.transaction, unsafe: original.sql.unsafe, query: original.sql.query });
  return { ...original, sql };
});

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import netcashResolve from '../../pages/api/accounting/netcash/resolve';
import netcashStatus from '../../pages/api/accounting/netcash/status';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { admin: '', manager: '', viewer: '' };
const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-HINT' };
const NOTE = 'Checked the Netcash portal: the batch was rejected, nothing paid';
const POLL_UPDATE = /UPDATE netcash_submissions\s+SET status =/;

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens); });
beforeEach(() => { hold.submitEftBatch.mockReset(); hold.getSubmissionStatus.mockReset(); hold.park = null; });
afterAll(async () => {
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, Object.values(u));
});

/** A batch Netcash accepted: its submission is 'submitted' (or set to `status`). */
async function submitted(status: 'submitted' | 'processing' = 'submitted') {
  const { company: c, bank } = await payCompany(pool, [[u.admin, 'admin'], [u.manager, 'manager'], [u.viewer, 'viewer']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  const b = await plantBatch(pool, c, u.admin, bank);
  hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
  expect((await submit(c, b.id)).state.statusCode).toBe(200);
  const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
  if (status !== 'submitted') await pool.query('UPDATE netcash_submissions SET status = $2 WHERE id = $1', [id, status]);
  return { c, b, id };
}
const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[u.admin]!, c, 'POST', { batchPaymentId: batchId }, '/api/accounting/netcash/submit');
const resolve = (user: string, c: string, id: string, outcome = 'failed', note = NOTE) => callRoute(netcashResolve, tokens[user]!, c, 'POST',
  { submissionId: id, outcome, note }, '/api/accounting/netcash/resolve');
const poll = (c: string, id: string) => callRoute(netcashStatus, tokens[u.admin]!, c, 'GET', undefined, '/api/accounting/netcash/status', { submissionId: id });
const answer = (status: string) => hold.getSubmissionStatus.mockResolvedValueOnce({ status, detail: `netcash says ${status}`, answered: true });
type Stored = { status: string; netcash_response: Record<string, { status?: string } | undefined> };
const row = async (id: string) => (await pool.query('SELECT status, netcash_response FROM netcash_submissions WHERE id = $1', [id])).rows[0] as Stored;
const park = (re: RegExp) => {
  let release!: () => void; let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  hold.park = { re, entered, release: new Promise<void>((r) => { release = r; }) };
  return { inside, release: () => release() };
};
const flagged = (r: Awaited<ReturnType<typeof poll>>) => (r.state.body as { data?: { needsAttention?: boolean } }).data?.needsAttention;

describe('a Netcash poll never decides what resolve allows (AP-01 round 9)', () => {
  it.each([
    ['no poll', null], ['Failed', 'Failed'], ['error: rejected by bank', 'error: rejected by bank'], ['Unsuccessful', 'Unsuccessful'],
    ['Processing - 0 errors', 'Processing - 0 errors'], ['Accepted, no rejections', 'Accepted, no rejections'],
    ['Submitted: error count 0', 'Submitted: error count 0'], ['Pending (no failures)', 'Pending (no failures)'],
  ])('after %s: manager/viewer refused, "submitted" refused, owner/admin "failed" with a note frees it and the resend sends once', async (_n, said) => {
    const { c, b, id } = await submitted();
    if (said) { answer(said); expect((await poll(c, id)).state.statusCode).toBe(200); }
    const outcome = {
      manager: (await resolve(u.manager, c, id)).state.statusCode,
      viewer: (await resolve(u.viewer, c, id)).state.statusCode,
      blankNote: (await resolve(u.admin, c, id, 'failed', '  ')).state.statusCode,
      keepOpen: (await resolve(u.admin, c, id, 'submitted')).state.statusCode,
      statusBefore: (await row(id)).status,
      admin: (await resolve(u.admin, c, id)).state.statusCode,
      statusAfter: (await row(id)).status,
    };
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const resend = (await submit(c, b.id)).state.statusCode;
    expect({ ...outcome, resend, sends: hold.submitEftBatch.mock.calls.length }).toEqual({
      manager: 403, viewer: 403, blankNote: 400, keepOpen: 409, statusBefore: expect.stringMatching(/^(submitted|processing)$/), admin: 200, statusAfter: 'failed', resend: 200, sends: 2,
    });
    const audit = (await pool.query("SELECT user_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'netcash_submission' AND entity_id = $2", [c, id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(u.admin);
    expect(JSON.stringify(audit[0].changes)).toContain(NOTE);
  });

  it('a processing row is freed the same way; a completed or failed row never is', async () => {
    const p = await submitted('processing');
    expect((await resolve(u.admin, p.c, p.id)).state.statusCode).toBe(200);
    expect((await row(p.id)).status).toBe('failed');
    expect((await resolve(u.admin, p.c, p.id)).state.statusCode).toBe(409); // already failed
    const done = await submitted();
    answer('Completed');
    await poll(done.c, done.id);
    expect((await row(done.id)).status).toBe('completed');
    expect((await resolve(u.admin, done.c, done.id)).state.statusCode).toBe(409);
    expect((await row(done.id)).status).toBe('completed');
  });

  it('compare-and-set: Netcash completing the batch between resolve\'s read and its write refuses the resolve', async () => {
    const { c, b, id } = await submitted();
    const p = park(/netcash_resolve_read/);
    const resolving = resolve(u.admin, c, id);
    await p.inside; // resolve has read 'submitted'
    answer('Completed');
    expect((await poll(c, id)).state.statusCode).toBe(200);
    p.release();
    const res = await resolving;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(JSON.stringify(res.state.body)).toMatch(/changed from submitted to completed since you opened it/); // round 10
    expect((await row(id)).status).toBe('completed');
    expect((await submit(c, b.id)).state.statusCode).toBe(409);
    expect(hold.submitEftBatch).toHaveBeenCalledTimes(1);
  });

  it('a poll that read the row before an operator freed it does not bring it back', async () => {
    const { c, b, id } = await submitted();
    answer('Processing');
    const p = park(POLL_UPDATE);
    const polling = poll(c, id);
    await p.inside; // the poll read 'submitted' and is about to write
    expect((await resolve(u.admin, c, id)).state.statusCode).toBe(200);
    p.release();
    expect((await polling).state.statusCode).toBe(200);
    const after = await row(id);
    expect(after.status).toBe('failed');
    expect(after.netcash_response.resolved).toBeDefined();
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    expect((await submit(c, b.id)).state.statusCode).toBe(200);
    expect(hold.submitEftBatch).toHaveBeenCalledTimes(2);
  });
});

describe('the poll answer is a hint, written by merge and never older than what is stored (AP-01 round 9)', () => {
  it.each(['Processing - 0 errors', 'Accepted, no rejections', 'Submitted: error count 0', 'Pending (no failures)'])(
    'a clean answer that mentions errors ("%s") is not flagged', async (said) => {
      const { c, id } = await submitted();
      answer(said);
      const r = await poll(c, id);
      const after = await row(id);
      expect({ flagged: flagged(r), status: after.status, pollFailure: after.netcash_response.pollFailure, latest: after.netcash_response.latestPoll?.status })
        .toEqual({ flagged: false, status: expect.stringMatching(/^(submitted|processing)$/), pollFailure: undefined, latest: said });
    });

  it.each(['Unsuccessful', 'UNSUCCESSFUL', 'Failed', 'FAILED', 'Rejected', 'Rejected: invalid account', 'Error'])('"%s" is flagged as a failure and is never completed', async (said) => {
    const { c, id } = await submitted();
    answer(said);
    const r = await poll(c, id);
    const after = await row(id);
    expect({ flagged: flagged(r), status: after.status, pollFailure: after.netcash_response.pollFailure?.status })
      .toEqual({ flagged: true, status: 'submitted', pollFailure: said });
  });

  it.each(['Not successful', 'Completed with errors', 'Success - 2 rejected', 'Batch completed', 'Completed - 2 payments unpaid',
    'Successful (1 returned)', 'Paid with exceptions', 'Success', 'Completed.'])('ambiguous "%s" stays processing (not completed, not flagged)', async (said) => {
    const { c, id } = await submitted();
    answer(said);
    const r = await poll(c, id);
    expect({ flagged: flagged(r), status: (await row(id)).status }).toEqual({ flagged: false, status: 'processing' });
  });

  it.each(['Completed', 'completed', 'Successful', ' COMPLETE '])('"%s" (exactly a completion word) completes the submission', async (said) => {
    const { c, id } = await submitted();
    answer(said);
    await poll(c, id);
    expect((await row(id)).status).toBe('completed');
  });

  it('a poll never moves a row backwards: a processing row answered "Submitted" stays processing (round 10)', async () => {
    const { c, id } = await submitted('processing');
    answer('Submitted');
    expect((await poll(c, id)).state.statusCode).toBe(200);
    const after = await row(id);
    expect({ status: after.status, latest: after.netcash_response.latestPoll?.status }).toEqual({ status: 'processing', latest: 'Submitted' });
  });

  it('no service key: nothing is polled or written (no mock answer stands in for Netcash) (round 10)', async () => {
    const { c, id } = await submitted();
    await pool.query("UPDATE companies SET netcash_service_key = '' WHERE id = $1", [c]);
    const real = await vi.importActual<typeof import('@/modules/accounting/services/ap/netcashService')>('@/modules/accounting/services/ap/netcashService');
    hold.getSubmissionStatus.mockImplementation(real.getSubmissionStatus);
    const res = await poll(c, id);
    const after = await row(id);
    expect({ http: res.state.statusCode, polled: (res.state.body as { data?: { polled?: boolean } }).data?.polled, status: after.status, latest: after.netcash_response.latestPoll })
      .toEqual({ http: 200, polled: false, status: 'submitted', latest: undefined });
  });

  it('a manager may poll but not resolve; a poll that completes the row refuses the owner\'s resolve', async () => {
    const { c, id } = await submitted();
    expect((await resolve(u.manager, c, id)).state.statusCode).toBe(403);
    answer('Successful');
    expect((await callRoute(netcashStatus, tokens[u.manager]!, c, 'GET', undefined, '/api/accounting/netcash/status', { submissionId: id })).state.statusCode).toBe(200);
    expect({ status: (await row(id)).status, resolve: (await resolve(u.admin, c, id)).state.statusCode }).toEqual({ status: 'completed', resolve: 409 });
  });

  it.each([
    ['HTTP 503', 'Status poll failed'], ['a network error', 'fetch failed'], ['an unreadable body', 'Netcash answered but the response could not be read'],
  ])('a poll Netcash did not answer (%s) changes no status and stores no answer, only a pollError hint (round 11)', async (_n, detail) => {
    const { c, id } = await submitted();
    answer('Processing'); // an earlier real answer
    await poll(c, id);
    const before = await row(id);
    hold.getSubmissionStatus.mockResolvedValueOnce({ status: 'unknown', detail, answered: false });
    const res = await poll(c, id);
    const after = await row(id);
    expect({ polled: (res.state.body as { data?: { polled?: boolean } }).data?.polled, status: after.status,
      latest: after.netcash_response.latestPoll, error: (after.netcash_response.pollError as { detail?: string } | undefined)?.detail })
      .toEqual({ polled: false, status: before.status, latest: before.netcash_response.latestPoll, error: detail });
    answer('Processing'); // an answer again: the error hint goes
    await poll(c, id);
    expect((await row(id)).netcash_response.pollError).toBeUndefined();
  });

  it('overlapping polls: an older failure answer written after a newer clean one changes nothing', async () => {
    const { c, id } = await submitted();
    answer('Failed'); // poll A gets Netcash's older answer, then stalls before its write
    const p = park(POLL_UPDATE);
    const older = poll(c, id);
    await p.inside;
    answer('Submitted'); // poll B gets the newer answer and writes first
    expect((await poll(c, id)).state.statusCode).toBe(200);
    p.release();
    const a = await older;
    const after = await row(id);
    expect({ aPolled: (a.state.body as { data?: { polled?: boolean } }).data?.polled, latest: after.netcash_response.latestPoll?.status, pollFailure: after.netcash_response.pollFailure })
      .toEqual({ aPolled: false, latest: 'Submitted', pollFailure: undefined });
  });

  it('the poll merges into netcash_response: a key written after its read survives its write', async () => {
    const { c, id } = await submitted();
    answer('Rejected');
    const p = park(POLL_UPDATE);
    const polling = poll(c, id);
    await p.inside; // the poll has read netcash_response; something else adds a key before the poll writes
    await pool.query(`UPDATE netcash_submissions SET netcash_response = netcash_response || '{"lateSendResult":{"success":true}}'::JSONB WHERE id = $1`, [id]);
    p.release();
    expect((await polling).state.statusCode).toBe(200);
    const after = (await row(id)).netcash_response;
    expect({ late: after.lateSendResult, latest: after.latestPoll?.status, failure: after.pollFailure?.status, ref: JSON.stringify(after).includes('NC-HINT') })
      .toEqual({ late: { success: true }, latest: 'Rejected', failure: 'Rejected', ref: true });
    answer('Processing'); // a clean poll drops only the failure hint
    await poll(c, id);
    const clean = (await row(id)).netcash_response;
    expect({ late: clean.lateSendResult, latest: clean.latestPoll?.status, failure: clean.pollFailure }).toEqual({ late: { success: true }, latest: 'Processing', failure: undefined });
  });
});
