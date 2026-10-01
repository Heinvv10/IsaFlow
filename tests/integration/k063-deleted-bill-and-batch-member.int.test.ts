// tests/integration/k063-deleted-bill-and-batch-member.int.test.ts
//
// Two more doors to K-063's outcome — AP relieved for money no bill stands
// behind — found by the round-1 blind review.
//
// 1. A SOFT-DELETED bill. The delete reverses the approval journal but leaves
//    `status = 'approved'`, so the status allow-list admitted it: paying it drove
//    AP to a debit balance. Deleted is now part of the one rule, and the bill
//    lock read does not return a deleted bill at all.
// 2. A BATCH MEMBER processed on its own and then again with its batch: AP was
//    debited twice for one payment. Rule: a batch member moves money only
//    through its batch; the batch refuses a member that has already moved.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { allocationsOn, bill, billState, processedPayment } from './ap-allocation-guards.helpers';
import { flow, text } from './ap-payment-flow.helpers';
import softDelete from '../../pages/api/accounting/soft-delete';
import supplierAllocations from '../../pages/api/accounting/supplier-allocations';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('K-063 review r1 — deleted bills and batch members', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const approved = (total = 1000) => bill(fx.pool, { supplier: ids.SUP_A, status: 'approved', total });
  const markDeleted = (id: string) =>
    fx.pool.query('UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = $1', [id]);
  // The delete is held to the cancel plan, which refuses an approved bill with
  // no approval journal to reverse — so the bill carries a posted one.
  async function approvedWithJournal(total = 1000): Promise<string> {
    const id = await approved(total);
    const je = randomUUID();
    await fx.pool.query(
      `INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status,
         posted_at, source, source_record_id, created_by)
       VALUES ($1, $2, $3, CURRENT_DATE - 5, 'K063 bill approval', 'posted', NOW(),
               'auto_supplier_invoice', $4, $5)`,
      [je, ids.A, `K063-JE-${je.slice(0, 8)}`, id, ids.USER]);
    await fx.pool.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
       VALUES ($1, $2, $3, $5, 0, 'dr'), ($1, $2, $4, 0, $5, 'cr')`,
      [ids.A, je, ids.GL, ids.AP_GL, total]);
    await fx.pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = $1 WHERE id = $2', [je, id]);
    return id;
  }
  async function deletedViaRoute(): Promise<string> {
    const id = await approvedWithJournal();
    const del = await fx.call(softDelete, 'POST', { entityType: 'supplier_invoice', entityId: id });
    expect(del.statusCode, text(del)).toBe(200);
    return id;
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K063 r4');
  });
  afterAll(() => tearDownFixture(fx?.pool));

  it('a soft-deleted bill refuses a new payment, naming the delete', async () => {
    const id = await deletedViaRoute();
    const state = await f.createPayment(id, 1000);
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('has been deleted and cannot receive a payment');
    expect(await allocationsOn(fx.pool, [id])).toBe(0);
  });

  it('a soft-deleted bill is not found by a batch', async () => {
    const id = await deletedViaRoute();
    const state = await f.createBatch([{ billId: id, amount: 1000 }]);
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('not found');
    expect(await allocationsOn(fx.pool, [id])).toBe(0);
  });

  it('a soft-deleted bill is not found when a processed payment is applied to it', async () => {
    const id = await deletedViaRoute();
    const paymentId = await processedPayment(fx.pool, ids.SUP_A);
    const state = await fx.call(supplierAllocations, 'POST', { paymentId, allocations: [{ invoiceId: id, amount: 1000 }] });
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('not found');
    expect((await billState(fx.pool, id)).paid).toBe(0);
  });

  it('a bill carrying an approved, unprocessed payment cannot be deleted', async () => {
    const id = await approved();
    await f.approvedPayment(id, 1000);
    const del = await fx.call(softDelete, 'POST', { entityType: 'supplier_invoice', entityId: id });
    expect(del.statusCode, text(del)).toBe(400);
    expect(text(del)).toContain('with payments');
    const { rows } = await fx.pool.query('SELECT deleted_at FROM supplier_invoices WHERE id = $1', [id]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it('a payment whose bill is deleted before processing is refused, AP unchanged', async () => {
    const id = await approved();
    const paymentId = await f.approvedPayment(id, 1000);
    await markDeleted(id); // state that predates the delete guard's fix
    const ap = await f.apDebits();
    const state = await f.paymentAction('process', paymentId);
    expect(state.statusCode, text(state)).toBe(400);
    expect(await f.paymentStatus(paymentId)).toBe('approved');
    expect((await billState(fx.pool, id)).paid).toBe(0);
    expect(await f.apDebits()).toBe(ap);
  });

  it('a batch whose bill is deleted before processing is refused, AP unchanged', async () => {
    const id = await approved();
    const batchId = await f.approvedBatch([{ billId: id, amount: 1000 }]);
    await markDeleted(id);
    const ap = await f.apDebits();
    const state = await f.batchAction('process', batchId);
    expect(state.statusCode, text(state)).toBe(400);
    expect(await f.batchStatus(batchId)).toBe('approved');
    expect(await f.apDebits()).toBe(ap);
  });

  it('member then batch: the member is refused on its own, and the batch moves the money once', async () => {
    const id = await approved();
    const batchId = await f.approvedBatch([{ billId: id, amount: 300 }]);
    const member = await f.memberOf(batchId);
    const ap = await f.apDebits();

    const alone = await f.paymentAction('process', member);
    expect(alone.statusCode, text(alone)).toBe(400);
    expect(text(alone)).toContain(`belongs to batch ${batchId}`);
    const viaBatch = await f.batchAction('process', batchId);
    expect(viaBatch.statusCode, text(viaBatch)).toBe(200);

    expect(await f.apDebits()).toBe(ap + 300);
    expect(await billState(fx.pool, id)).toEqual({ paid: 300, status: 'partially_paid' });
  });

  it('batch then member: the member cannot be processed again', async () => {
    const id = await approved();
    const batchId = await f.approvedBatch([{ billId: id, amount: 300 }]);
    const member = await f.memberOf(batchId);
    const ap = await f.apDebits();

    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const again = await f.paymentAction('process', member);
    expect(again.statusCode, text(again)).toBeGreaterThanOrEqual(400);
    expect(again.statusCode).toBeLessThan(500);

    expect(await f.apDebits()).toBe(ap + 300);
    expect(await billState(fx.pool, id)).toEqual({ paid: 300, status: 'partially_paid' });
  });

  it('processed batch, then void of its member: refused, bill and AP still agree with the batch journal', async () => {
    const id = await approved();
    const batchId = await f.approvedBatch([{ billId: id, amount: 300 }]);
    const member = await f.memberOf(batchId);
    const ap = await f.apDebits();
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);

    const voided = await f.paymentAction('void', member);
    expect(voided.statusCode, text(voided)).toBe(400);
    expect(text(voided)).toContain(`belongs to batch ${batchId}`);
    expect(await f.paymentStatus(member)).toBe('processed');
    expect(await billState(fx.pool, id)).toEqual({ paid: 300, status: 'partially_paid' });
    expect(await f.apDebits()).toBe(ap + 300);
    // The bill still knows about the 300, so it cannot be paid in full again.
    expect((await f.createPayment(id, 1000)).statusCode).toBe(400);
    expect((await f.createPayment(id, 700)).statusCode).toBe(201);
  });

  it('void of an unprocessed member, then the batch: refused, and the batch still pays once', async () => {
    const id = await approved();
    const batchId = await f.approvedBatch([{ billId: id, amount: 300 }]);
    const member = await f.memberOf(batchId);
    const ap = await f.apDebits();

    const voided = await f.paymentAction('void', member);
    expect(voided.statusCode, text(voided)).toBe(400);
    expect(text(voided)).toContain('cancel it through its batch');
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    expect(await billState(fx.pool, id)).toEqual({ paid: 300, status: 'partially_paid' });
    expect(await f.apDebits()).toBe(ap + 300);
  });

  it('a batch holding a member already processed on its own (stored before this rule) is refused', async () => {
    const id = await approved();
    const batchId = await f.approvedBatch([{ billId: id, amount: 300 }]);
    const member = await f.memberOf(batchId);
    await fx.pool.query("UPDATE supplier_payments SET status = 'processed' WHERE id = $1", [member]);
    const ap = await f.apDebits();

    const state = await f.batchAction('process', batchId);
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('is processed, not approved');
    expect(await f.batchStatus(batchId)).toBe('approved');
    expect(await f.apDebits()).toBe(ap);
  });
});
