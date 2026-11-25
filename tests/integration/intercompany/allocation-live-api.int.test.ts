/**
 * Intercompany P4-C: the RECEIVER's allocation routes (`allocations`, `allocations/[id]`, and reject / dismiss), read only: each item carries
 * the receiver's OWN issuer invoice (by the payload's id, under the session company), the definer's liveness answer and a derived mismatch.
 * The invoice inbox and its badge never count an allocation; only D's clearing route accepts one, and the guard refuses a direct-UPDATE `accepted`
 * on an allocation (C pinned it open; D's migration 1027 closed it, deliberately: the pin is flipped).
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

  it('an invoice that is not open (draft, awaiting approval, paid) shows no open amount and invoice_not_open', async () => {
    const out: Record<string, string> = {};
    for (const status of ['draft', 'pending_approval', 'paid']) {
      const sent = await sentAllocation(pool, conn);
      await withoutTrigger(pool, 'customer_invoices', 'trg_doc_journal_link_upd', (q) => q.query('UPDATE customer_invoices SET status = $2 WHERE id = $1', [sent.invoice, status]));
      out[sent.message] = status;
    }
    for (const item of (await page()).items) {
      expect([out[item.id], item.issuerInvoice?.openAmount, item.issuerInvoice?.status, item.mismatch]).toEqual([out[item.id], null, out[item.id], 'invoice_not_open']);
    }
  });

  it('a payment dated before the cut-over (the cut-over moved later): the definer says before_cutover and the mismatch pre_cutover_payment', async () => {
    const sent = await sentAllocation(pool, conn);
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET cutover_date = DATE '2026-10-01' WHERE id = $1", [conn]), true);
    expect((await page()).items[0]).toMatchObject({ id: sent.message, live: false, liveReason: 'before_cutover', mismatch: 'pre_cutover_payment' });
  });

  it('the total is right on a page past the end, and the count of open payments with it', async () => {
    await sentAllocation(pool, conn);
    await sentAllocation(pool, conn);
    expect(await page(U.a, co.A, { offset: '5' })).toMatchObject({ items: [], total: 2, allocationCount: 2 });
    expect(await page(U.a, co.A, { limit: '1', offset: '1' })).toMatchObject({ total: 2, allocationCount: 2 });
    expect((await page(U.a, co.A, { limit: '1', offset: '1' })).items).toHaveLength(1);
  });

  it('the issuer invoice is looked up under the SESSION company: a payload naming another company\'s invoice shows none, even to a member of both', async () => {
    const sent = await sentAllocation(pool, conn);
    const thirds = await plantDocument(pool, 'customer_invoice', co.C);
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      "UPDATE intercompany_messages SET payload = jsonb_set(payload, '{issuerDocument,id}', to_jsonb($2::text)) WHERE id = $1", [sent.message, thirds]));
    const item = (await page(U.ac, co.A)).items[0]!;                                      // U.ac reads C's invoices too (owner of A and C)
    expect(item).toMatchObject({ id: sent.message, issuerInvoice: null, mismatch: 'invoice_gone', live: false, liveReason: 'link_gone' });
  });

  it('a liveness check that fails (the service bounds the lock wait for the page) shows check_failed for every open row, and the request still answers', async () => {
    const one = await sentAllocation(pool, conn);
    const two = await sentAllocation(pool, conn);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE payment_allocations IN ACCESS EXCLUSIVE MODE');
      const p = await page();
      const by = new Map(p.items.map((i) => [i.id, i]));
      expect(by.get(one.message)).toMatchObject({ live: false, liveReason: 'check_failed', issuerInvoice: { id: one.invoice } });
      expect(by.get(two.message)).toMatchObject({ live: false, liveReason: 'check_failed', issuerInvoice: { id: two.invoice } });
      expect(p.allocationCount).toBe(2);
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

  it('a reject on a revoked connection is a 409 and changes nothing; a dismiss still works there', async () => {
    const one = await sentAllocation(pool, conn);
    const two = await sentAllocation(pool, conn);
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [conn]), true);
    expect((await allocationsApi.reject(U.a, co.A, one.message, { reason: 'Not ours' })).state.statusCode).toBe(409);
    expect(await status(one.message)).toMatchObject({ status: 'pending', reason: null });
    expect((await allocationsApi.dismiss(U.a, co.A, two.message)).state.statusCode).toBe(200);
    expect((await allocationsApi.restore(U.a, co.A, two.message)).state.statusCode).toBe(409);      // restoring needs a live connection
    expect(await status(two.message)).toMatchObject({ status: 'dismissed' });
  });

  it('restore brings a dismissed payment back to pending (and only a dismissed one); a viewer and another company are refused', async () => {
    const sent = await sentAllocation(pool, conn);
    expect((await allocationsApi.restore(U.a, co.A, sent.message)).state.statusCode).toBe(409);      // pending: nothing to restore
    expect((await allocationsApi.dismiss(U.a, co.A, sent.message)).state.statusCode).toBe(200);
    expect((await allocationsApi.restore(U.va, co.A, sent.message)).state.statusCode).toBe(403);
    expect((await allocationsApi.restore(U.b, co.B, sent.message)).state.statusCode).toBe(404);
    expect((await allocationsApi.restore(U.a, co.A, sent.message)).state.statusCode).toBe(200);
    expect(await status(sent.message)).toMatchObject({ status: 'pending' });
    expect((await page()).items[0]).toMatchObject({ id: sent.message, status: 'pending', live: true, liveReason: 'ok' });
  });

  it('the allocation routes act on allocations only: an invoice message is a 404 there', async () => {
    const invoice = await plantMessage(pool, conn, co.B, co.A, { kind: 'invoice', user: U.b });
    expect((await allocationsApi.get(U.a, co.A, invoice)).state.statusCode).toBe(404);
    expect((await allocationsApi.dismiss(U.a, co.A, invoice)).state.statusCode).toBe(404);
    expect((await allocationsApi.restore(U.a, co.A, invoice)).state.statusCode).toBe(404);
    expect(await status(invoice)).toMatchObject({ status: 'pending' });
  });

  it("the only accept route is D's clearing, and the invoice routes (detail, accept, reject, dismiss) do not reach an allocation", async () => {
    const root = path.resolve(__dirname, '../../../pages/api/accounting/intercompany/allocations');
    expect(existsSync(path.join(root, '[id]', 'accept.ts'))).toBe(true);
    expect(existsSync(path.join(root, '[id]', 'index.ts'))).toBe(true);
    const sent = await sentAllocation(pool, conn);
    expect((await inbox.get(U.a, co.A, sent.message)).state.statusCode).toBe(404);
    expect((await inbox.accept(U.a, co.A, sent.message)).state.statusCode).toBe(404);
    expect((await inbox.reject(U.a, co.A, sent.message, { reason: 'x' })).state.statusCode).toBe(404);
    expect((await inbox.dismiss(U.a, co.A, sent.message)).state.statusCode).toBe(404);
    expect(await status(sent.message)).toMatchObject({ status: 'pending', target_doc_id: null });
  });

  it('FLIPPED by D (1027): the receiver can no longer set accepted on an allocation by a direct UPDATE with no clearing', async () => {
    const sent = await sentAllocation(pool, conn);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [sent.message]))
        .toMatch(/^23514: an allocation message is accepted with the clearing posted for it/);
    }, true);
    expect(await status(sent.message)).toMatchObject({ status: 'pending', target_doc_id: null });
  });
});
