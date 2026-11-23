/**
 * Intercompany P4-C: the RECEIVER's allocation routes (`allocations`, `allocations/[id]`, and reject / dismiss), read only: each item carries
 * the receiver's OWN issuer invoice (by the payload's id, under the session company), the definer's liveness answer and a derived mismatch.
 * The invoice inbox and its badge never count an allocation; no route accepts one (D owns that); the guard's direct-UPDATE `accepted` on an
 * allocation is pinned as it stands so D's change to it is deliberate.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, outcome, plantDocument, plantMessage, withoutTrigger } from './intercompany.helpers';
import { co, dataOf, inbox, mirrorCleanup, U, wipeConnections } from './mirror.helpers';
import { allocSetup, clearPayments, loanConnect } from './allocation.helpers';
import { allocationsApi, sentAllocation } from './allocation-live.helpers';
import type { AllocationDetail, AllocationPage } from '../../../src/modules/accounting/services/intercompany/allocationInboxTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => allocSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await loanConnect(pool);
});

const page = async (user = U.a, company = co.A, query: Record<string, string> = {}) => {
  const res = await allocationsApi.list(user, company, query);
  expect(res.state.statusCode).toBe(200);
  return dataOf<AllocationPage>(res);
};
const status = async (id: string) => (await pool.query('SELECT status, reason, target_doc_id FROM intercompany_messages WHERE id = $1', [id])).rows[0];

describe('the receiver lists the payments from its group', () => {
  it('one item with the payload facts, its own invoice, live ok and no mismatch; the invoice inbox and its badge are unchanged', async () => {
    const sent = await sentAllocation(pool, conn);
    const p = await page();
    expect(p).toMatchObject({ total: 1, allocationCount: 1 });
    const inv = (await pool.query('SELECT invoice_number FROM customer_invoices WHERE id = $1', [sent.invoice])).rows[0];
    expect(p.items[0]).toMatchObject({
      id: sent.message, status: 'pending', amount: 1150, currency: 'ZAR', paymentReference: 'IC alloc ref', paymentMethod: 'eft', paymentDate: '2026-09-01',
      cashLegIsLoanAccount: false, live: true, liveReason: 'ok', mismatch: null, blocker: null, senderName: 'IC A customer',
      issuerInvoice: { id: sent.invoice, number: inv.invoice_number, openAmount: 1150, status: 'approved', currency: 'ZAR' },
    });
    expect(dataOf<{ openCount: number }>(await inbox.count(U.a, co.A)).openCount).toBe(0);
    expect(dataOf<{ items: unknown[]; openCount: number }>(await inbox.list(U.a, co.A))).toMatchObject({ items: [], openCount: 0 });
  });

  it('a stale message lists with its reason; a partly paid invoice is amount_exceeds_open; a pre-cut-over invoice says so; a deleted one is invoice_gone', async () => {
    const stale = await sentAllocation(pool, conn);
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [stale.allocation]);
    const short = await sentAllocation(pool, conn);
    await pool.query('UPDATE customer_invoices SET amount_paid = 500 WHERE id = $1', [short.invoice]);
    const early = await sentAllocation(pool, conn);
    await pool.query("UPDATE customer_invoices SET invoice_date = DATE '2025-12-15' WHERE id = $1", [early.invoice]);
    const gone = await sentAllocation(pool, conn);
    await pool.query('UPDATE customer_invoices SET deleted_at = now() WHERE id = $1', [gone.invoice]);
    const by = new Map((await page()).items.map((i) => [i.id, i]));
    expect(by.get(stale.message)).toMatchObject({ live: false, liveReason: 'allocation_gone', mismatch: null });
    expect(by.get(short.message)).toMatchObject({ live: true, mismatch: 'amount_exceeds_open', issuerInvoice: { openAmount: 650 } });
    expect(by.get(early.message)).toMatchObject({ live: true, mismatch: 'pre_cutover_invoice' });
    expect(by.get(gone.message)).toMatchObject({ issuerInvoice: null, mismatch: 'invoice_gone' });
  });

  it('the issuer invoice is looked up under the SESSION company: a payload naming another company\'s invoice shows none, even to a member of both', async () => {
    const sent = await sentAllocation(pool, conn);
    const thirds = await plantDocument(pool, 'customer_invoice', co.C);
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      "UPDATE intercompany_messages SET payload = jsonb_set(payload, '{issuerDocument,id}', to_jsonb($2::text)) WHERE id = $1", [sent.message, thirds]));
    const item = (await page(U.ac, co.A)).items[0]!;                                      // U.ac reads C's invoices too (owner of A and C)
    expect(item).toMatchObject({ id: sent.message, issuerInvoice: null, mismatch: 'invoice_gone', live: false, liveReason: 'link_gone' });
  });

  it('a liveness check that fails (the definer cannot get its lock) shows check_failed and the request still answers', async () => {
    const sent = await sentAllocation(pool, conn);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE payment_allocations IN ACCESS EXCLUSIVE MODE');
      const p = await page();
      expect(p.items[0]).toMatchObject({ id: sent.message, live: false, liveReason: 'check_failed', issuerInvoice: { id: sent.invoice } });
      expect(p.allocationCount).toBe(1);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  }, 30000);

  it('the detail carries the item and the payload facts', async () => {
    const sent = await sentAllocation(pool, conn);
    const res = await allocationsApi.get(U.a, co.A, sent.message);
    expect(res.state.statusCode).toBe(200);
    const d = dataOf<AllocationDetail>(res);
    expect(d.item).toMatchObject({ id: sent.message, live: true, liveReason: 'ok' });
    expect(d).toMatchObject({ allocationId: sent.allocation, linkOrigin: 'manual_pairing', cutoverDate: '2026-01-01' });
  });
});

describe('tenancy', () => {
  it('the payer and a third company list nothing; their detail of the message is a 404; a bad id is a 400', async () => {
    const sent = await sentAllocation(pool, conn);
    expect(await page(U.b, co.B)).toMatchObject({ items: [], total: 0, allocationCount: 0 });
    expect(await page(U.c, co.C)).toMatchObject({ items: [], total: 0, allocationCount: 0 });
    expect((await allocationsApi.get(U.b, co.B, sent.message)).state.statusCode).toBe(404);
    expect((await allocationsApi.get(U.c, co.C, sent.message)).state.statusCode).toBe(404);
    expect((await allocationsApi.get(U.a, co.A, 'not-a-uuid')).state.statusCode).toBe(400);
    expect((await allocationsApi.reject(U.b, co.B, sent.message, { reason: 'no' })).state.statusCode).toBe(404);
    expect((await allocationsApi.dismiss(U.c, co.C, sent.message)).state.statusCode).toBe(404);
    expect(await status(sent.message)).toMatchObject({ status: 'pending' });
  });
});

describe('actions: reject with a reason, dismiss; never accept', () => {
  it('reject needs a reason and stores it; dismiss sets it aside; both list under handled as not_pending; a viewer is refused', async () => {
    const one = await sentAllocation(pool, conn);
    const two = await sentAllocation(pool, conn);
    expect((await allocationsApi.reject(U.a, co.A, one.message, { reason: '  ' })).state.statusCode).toBe(400);
    expect((await allocationsApi.reject(U.va, co.A, one.message, { reason: 'no' })).state.statusCode).toBe(403);
    expect((await allocationsApi.reject(U.a, co.A, one.message, { reason: 'Not our payment' })).state.statusCode).toBe(200);
    expect(await status(one.message)).toMatchObject({ status: 'rejected', reason: 'Not our payment' });
    expect((await allocationsApi.dismiss(U.a, co.A, two.message)).state.statusCode).toBe(200);
    expect(await status(two.message)).toMatchObject({ status: 'dismissed' });
    expect((await allocationsApi.reject(U.a, co.A, one.message, { reason: 'again' })).state.statusCode).toBe(409);
    const handled = await page(U.a, co.A, { filter: 'handled' });
    expect(handled.items.map((i) => [i.id, i.status, i.liveReason]).sort()).toEqual([[one.message, 'rejected', 'not_pending'], [two.message, 'dismissed', 'not_pending']].sort());
    expect(handled.allocationCount).toBe(0);
  });

  it('the allocation routes act on allocations only: an invoice message is a 404 there', async () => {
    const invoice = await plantMessage(pool, conn, co.B, co.A, { kind: 'invoice', user: U.b });
    expect((await allocationsApi.get(U.a, co.A, invoice)).state.statusCode).toBe(404);
    expect((await allocationsApi.dismiss(U.a, co.A, invoice)).state.statusCode).toBe(404);
    expect(await status(invoice)).toMatchObject({ status: 'pending' });
  });

  it('no accept route exists, and the invoice routes (detail, accept, reject, dismiss) do not reach an allocation', async () => {
    const root = path.resolve(__dirname, '../../../pages/api/accounting/intercompany/allocations');
    expect(existsSync(path.join(root, '[id]', 'accept.ts'))).toBe(false);
    expect(existsSync(path.join(root, '[id]', 'index.ts'))).toBe(true);
    const sent = await sentAllocation(pool, conn);
    expect((await inbox.get(U.a, co.A, sent.message)).state.statusCode).toBe(404);
    expect((await inbox.accept(U.a, co.A, sent.message)).state.statusCode).toBe(404);
    expect((await inbox.reject(U.a, co.A, sent.message, { reason: 'x' })).state.statusCode).toBe(404);
    expect((await inbox.dismiss(U.a, co.A, sent.message)).state.statusCode).toBe(404);
    expect(await status(sent.message)).toMatchObject({ status: 'pending', target_doc_id: null });
  });

  it('PINNED (D closes it): the receiver can still set accepted on an allocation by a direct UPDATE, with no target', async () => {
    const sent = await sentAllocation(pool, conn);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [sent.message])).toBe('ok');
    }, true);
    expect(await status(sent.message)).toMatchObject({ status: 'accepted', target_doc_id: null });
  });
});
