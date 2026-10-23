/**
 * Migration 922: an approved supplier payment batch is paid only as it was approved, WHATEVER the payment_batch
 * enforcement switch says. approveBatch stores the batch's `payment_batch` digest (payee, payee bank details, amount
 * per member); eft-generate, netcash/submit and process refuse 409 BATCH_CHANGED_SINCE_APPROVAL an approved (or
 * processed) batch whose current digest differs, and re-approving is the way out. A batch approved before 922 (no
 * stored digest) is allowed, with a warning. Under enforcement the approval gate still answers first (APPROVAL_STALE).
 * The race with a bank-detail edit: ap-batch-approved-digest-race.int.test.ts.
 *
 * Judged by outcome: the file's content and its export record, the Netcash sender's calls and the submissions table,
 * the journals and payment statuses, the members' approver. Enforcement OFF unless a test says otherwise. Netcash is
 * never called: its client is a spy. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import { log } from '@/lib/logger';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, reasonOf } from './r035-approval.helpers';
import batchPaymentsAction from '../../pages/api/accounting/batch-payments-action';
import { dataOf } from './r035-pr2.helpers';
import { batchState, cleanupPr5, digestOf } from './r035-pr5.helpers';
import { CHANGED, NEW_ACCOUNT, OLD_ACCOUNT, digestKit } from './ap-batch-approved-digest.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const {
  r, eft, netcash, fixture, approve, approveWith, changeBank, submissions, exportRecords, storedDigest, approvers, contentOf,
} = digestKit(pool, u, tokens, companies);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  submitEftBatch.mockReset();
  submitEftBatch.mockResolvedValue({ success: true, batchReference: 'DIGEST-SPY', mock: true });
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

describe('a batch whose payee bank details changed after approval (enforcement off)', () => {
  it('approve stores the digest of what was approved', async () => {
    const { c, b } = await fixture();
    expect(await storedDigest(b.id)).toBeNull();
    await approve(c, b.id);
    expect(await storedDigest(b.id)).toBe(await digestOf(pool, c, 'payment_batch', b.id));
  });

  it('gets no EFT file and no export record (409)', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    await changeBank(c, supplierId);
    const res = await eft(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe(CHANGED);
    expect((res.state.body as { error: { details: { batchId: string } } }).error.details.batchId).toBe(b.id);
    expect(JSON.stringify(res.state.body)).not.toContain('"content"');
    expect(await exportRecords(b.id)).toBe(0);
  });

  it('is not sent to Netcash and leaves no submission (409)', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    await changeBank(c, supplierId);
    const res = await netcash(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe(CHANGED);
    expect(submitEftBatch).not.toHaveBeenCalled();
    expect(await submissions(c)).toBe(0);
  });

  it('is not processed: no journal, no payment or bill moves (409)', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    await changeBank(c, supplierId);
    const res = await r.batch(u.a, c, 'process', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe(CHANGED);
    expect(await batchState(pool, b.id)).toEqual({
      status: 'approved', gl_journal_entry_id: null, members: ['approved', 'approved'], journals: 0, paid: 0,
    });
  });

  it('the batch page says so; an unchanged approved batch does not', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    const flag = async () => dataOf<{ changedSinceApproval: boolean }>(await r.getBatch(u.a, c, b.id)).changedSinceApproval;
    expect(await flag()).toBe(false);
    await changeBank(c, supplierId);
    expect(await flag()).toBe(true);
  });
});

describe('re-approve: the way out', () => {
  it('records the new digest and approver; then file, send and process all succeed with the new details', async () => {
    const one = await fixture();
    await approve(one.c, one.b.id, u.a);
    const before = await storedDigest(one.b.id);
    await changeBank(one.c, one.supplierId);
    await approve(one.c, one.b.id, u.b); // re-approved by someone else
    expect(await storedDigest(one.b.id)).toBe(await digestOf(pool, one.c, 'payment_batch', one.b.id));
    expect(await storedDigest(one.b.id)).not.toBe(before);
    expect(await approvers(one.b.id)).toEqual([u.b]);
    const audit = (await pool.query(
      "SELECT action, user_id::TEXT AS by FROM audit_log WHERE entity_type = 'supplier_payment_batch' AND entity_id = $1", [one.b.id])).rows;
    expect(audit).toEqual([{ action: 'approve', by: u.b }]);

    const file = await eft(one.c, one.b.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    expect(contentOf(file)).toContain(NEW_ACCOUNT);
    expect((await r.batch(u.a, one.c, 'process', one.b.id)).state.statusCode).toBe(200);
    expect((await batchState(pool, one.b.id)).status).toBe('processed');

    // AP-01: a batch with a bank file does not also go to Netcash — the send is proven on its own batch.
    const two = await fixture();
    await approve(two.c, two.b.id);
    await changeBank(two.c, two.supplierId);
    await approve(two.c, two.b.id, u.b);
    expect((await netcash(two.c, two.b.id)).state.statusCode).toBe(200);
    expect(submitEftBatch).toHaveBeenCalledTimes(1);
  });

  it('re-approve is bound to what the page showed: content that moved again, or no digest at all, is refused', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id, u.a);
    const approved = await storedDigest(b.id);
    await changeBank(c, supplierId, '62000005555');
    const shown = dataOf<{ contentDigest: string }>(await r.getBatch(u.b, c, b.id)).contentDigest; // what the page read
    expect(shown).toBe(await digestOf(pool, c, 'payment_batch', b.id));
    await changeBank(c, supplierId, NEW_ACCOUNT); // changes again before the click
    for (const expected of [shown, undefined]) {
      const res = await approveWith(c, b.id, u.b, expected);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
      expect(reasonOf(res)).toBe('BATCH_CONTENT_NOT_AS_SHOWN');
    }
    expect(await storedDigest(b.id)).toBe(approved);
    expect(await approvers(b.id)).toEqual([u.a]);
    expect(reasonOf(await eft(c, b.id))).toBe(CHANGED);
  });

  it('a first approve that names a digest is checked too; a malformed id or digest is refused 400', async () => {
    const { c, b, supplierId } = await fixture();
    const shown = (await digestOf(pool, c, 'payment_batch', b.id))!;
    await changeBank(c, supplierId);
    const stale = await approveWith(c, b.id, u.a, shown);
    expect(stale.state.statusCode).toBe(409);
    expect(reasonOf(stale)).toBe('BATCH_CONTENT_NOT_AS_SHOWN');
    expect((await batchState(pool, b.id)).status).toBe('draft');
    expect((await r.batch(u.a, c, 'approve', 'not-a-batch')).state.statusCode).toBe(400);
    const badDigest = await callRoute(batchPaymentsAction, tokens[u.a]!, c, 'POST',
      { action: 'approve', id: b.id, expectedDigest: 42 }, '/api/accounting/batch-payments-action');
    expect(badDigest.state.statusCode).toBe(400);
    expect((await batchState(pool, b.id)).status).toBe('draft');
  });

  it('an unchanged approved batch cannot be re-approved (BATCH_NOT_APPROVABLE), and nothing changes', async () => {
    const { c, b } = await fixture();
    await approve(c, b.id, u.a);
    const digest = await storedDigest(b.id);
    const res = await r.batch(u.b, c, 'approve', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('BATCH_NOT_APPROVABLE');
    expect(await storedDigest(b.id)).toBe(digest);
    expect(await approvers(b.id)).toEqual([u.a]);
  });

  it('a processed batch whose payee changed gets no file until re-approved; re-approval keeps it processed', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    expect((await r.batch(u.a, c, 'process', b.id)).state.statusCode).toBe(200);
    await changeBank(c, supplierId);
    const refused = await eft(c, b.id);
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(409);
    expect(reasonOf(refused)).toBe(CHANGED);
    const reapproved = await approveWith(c, b.id, u.b, (await digestOf(pool, c, 'payment_batch', b.id))!);
    expect(reapproved.state.statusCode, JSON.stringify(reapproved.state.body)).toBe(200);
    expect(dataOf<{ status: string }>(reapproved).status).toBe('processed'); // the answer says what it is
    expect((await batchState(pool, b.id)).status).toBe('processed');
    expect(await approvers(b.id)).toEqual([u.b]);
    const file = await eft(c, b.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    expect(contentOf(file)).toContain(NEW_ACCOUNT);
  });
});

describe('what stays as it was', () => {
  it('a legacy approved batch (no stored digest) is allowed, with a warning naming it', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    await pool.query('UPDATE supplier_payment_batches SET approved_digest = NULL WHERE id = $1', [b.id]);
    await changeBank(c, supplierId);
    const warn = vi.spyOn(log, 'warn');
    try {
      const file = await eft(c, b.id);
      expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
      expect(warn.mock.calls.some((call) => (call[1] as { batchId?: string } | undefined)?.batchId === b.id)).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect((await r.batch(u.a, c, 'process', b.id)).state.statusCode).toBe(200);
  });

  it('an unchanged approved batch: file, send and process work as before', async () => {
    const one = await fixture();
    await approve(one.c, one.b.id);
    const file = await eft(one.c, one.b.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    expect(contentOf(file)).toContain(OLD_ACCOUNT);
    expect(await exportRecords(one.b.id)).toBe(1);
    expect((await r.batch(u.a, one.c, 'process', one.b.id)).state.statusCode).toBe(200);
    const two = await fixture();
    await approve(two.c, two.b.id);
    expect((await netcash(two.c, two.b.id)).state.statusCode).toBe(200);
    expect(submitEftBatch).toHaveBeenCalledTimes(1);
  });

  it('an unchanged processed batch still gets its file: processing does not move the digest', async () => {
    const { c, b } = await fixture();
    await approve(c, b.id);
    const digest = await storedDigest(b.id);
    expect((await r.batch(u.a, c, 'process', b.id)).state.statusCode).toBe(200);
    expect(await digestOf(pool, c, 'payment_batch', b.id)).toBe(digest);
    const file = await eft(c, b.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    expect(contentOf(file)).toContain(OLD_ACCOUNT);
  });

  it('under enforcement the approval gate still answers first: APPROVAL_STALE for file, send and process', async () => {
    const { c, b, supplierId } = await fixture(true);
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    await approve(c, b.id);
    await changeBank(c, supplierId);
    for (const res of [await eft(c, b.id), await netcash(c, b.id), await r.batch(u.a, c, 'process', b.id)]) {
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
      expect(reasonOf(res)).toBe('APPROVAL_STALE');
    }
    // Re-approving under enforcement needs an approval of the new content: refused stale, nothing stored.
    const digest = await storedDigest(b.id);
    const reapprove = await approveWith(c, b.id, u.a, (await digestOf(pool, c, 'payment_batch', b.id))!);
    expect(reapprove.state.statusCode).toBe(409);
    expect(reasonOf(reapprove)).toBe('APPROVAL_STALE');
    expect(await storedDigest(b.id)).toBe(digest);
    // With it: re-approve, then the file carries the new details.
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    await approve(c, b.id);
    const file = await eft(c, b.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    expect(contentOf(file)).toContain(NEW_ACCOUNT);
  });
});
