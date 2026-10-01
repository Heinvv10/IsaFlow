// tests/integration/k063-k066-process-time-gate.int.test.ts
//
// K-063 / K-066 reached by a different ORDERING: create a payment (or a batch)
// against an approved bill of supplier A — every create-time guard passes —
// then the bill is cancelled, disputed, sent back to pending_approval or draft,
// or reassigned to another supplier, and only THEN is the payment processed.
// Processing is where DR Accounts Payable / CR Bank is posted and amount_paid
// moves, so the rule has to hold there too. Driven through the real handlers
// (withAuth COMMITs a 4xx) and asserted by outcome: status, the bill, the
// payment document, and the AP account.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill, billState, today } from './ap-allocation-guards.helpers';
import supplierPayments from '../../pages/api/accounting/supplier-payments';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import batchPayments from '../../pages/api/accounting/batch-payments';
import batchPaymentsAction from '../../pages/api/accounting/batch-payments-action';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

/** What happens to the bill between creation and processing. */
const changes: [string, string][] = [
  ['cancelled', "status = 'cancelled'"],
  ['disputed', "status = 'disputed'"],
  ['pending_approval', "status = 'pending_approval'"],
  ['draft', "status = 'draft'"],
  ['reassigned to supplier A2', `supplier_id = '${ids.SUP_A2}'`],
];

describeIfDb('K-063/K-066 — processing re-checks every bill before money moves', () => {
  let fx: Fixture;
  const q = (text: string, params: unknown[]) => fx.pool.query(text, params);
  const alter = (billId: string, set: string) =>
    q(`UPDATE supplier_invoices SET ${set} WHERE id = $1`, [billId]);
  const apDebits = async () => Number((await q(`SELECT COALESCE(SUM(debit), 0) AS n
    FROM gl_journal_lines WHERE gl_account_id = $1`, [ids.AP_GL])).rows[0].n);
  const payment = async (id: string) => (await q(
    'SELECT status, gl_journal_entry_id FROM supplier_payments WHERE id = $1', [id])).rows[0];

  async function approvedPayment(billId: string): Promise<string> {
    const made = await fx.call(supplierPayments, 'POST', { supplierId: ids.SUP_A, paymentDate: today,
      totalAmount: 1000, reference: 'K063-PROC', allocations: [{ invoiceId: billId, amount: 1000 }] });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const paymentId = String((made.body as { data: { id: string } }).data.id);
    const ok = await fx.call(supplierPaymentsAction, 'POST', { action: 'approve', paymentId });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    return paymentId;
  }

  /** A two-payment batch, approved; returns its id. */
  async function approvedBatch(first: string, last: string): Promise<string> {
    const made = await fx.call(batchPayments, 'POST', { notes: 'K063-PROC', payments: [
      { supplierId: ids.SUP_A, invoiceAllocations: [{ invoiceId: first, amount: 400 }] },
      { supplierId: ids.SUP_A, invoiceAllocations: [{ invoiceId: last, amount: 1000 }] },
    ] });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(200);
    const batchId = String((made.body as { data: { id: string } }).data.id);
    const ok = await fx.call(batchPaymentsAction, 'POST', { action: 'approve', id: batchId });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    return batchId;
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K063 process');
  });
  afterAll(() => tearDownFixture(fx?.pool));

  it.each(changes)('single payment: a bill %s after creation refuses the process with 400, writing nothing',
    async (_label, set) => {
      const billId = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
      const paymentId = await approvedPayment(billId);
      await alter(billId, set);
      const apBefore = await apDebits();
      const billBefore = await billState(fx.pool, billId);

      const state = await fx.call(supplierPaymentsAction, 'POST', { action: 'process', paymentId });

      expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
      expect(await billState(fx.pool, billId)).toEqual(billBefore);
      // The document is left pending — 'approved', no journal — so the user can
      // fix the bill or re-allocate, and a retry is possible.
      expect(await payment(paymentId)).toEqual({ status: 'approved', gl_journal_entry_id: null });
      expect(await apDebits()).toBe(apBefore);
    });

  it('single payment: an untouched bill still processes and settles', async () => {
    const billId = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const paymentId = await approvedPayment(billId);
    const apBefore = await apDebits();

    const state = await fx.call(supplierPaymentsAction, 'POST', { action: 'process', paymentId });

    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await billState(fx.pool, billId)).toEqual({ paid: 1000, status: 'paid' });
    expect((await payment(paymentId)).status).toBe('processed');
    expect(await apDebits()).toBe(apBefore + 1000);
  });

  it.each(changes)('batch: its LAST line\'s bill %s after creation refuses the whole batch, writing nothing',
    async (_label, set) => {
      const first = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
      const last = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
      const batchId = await approvedBatch(first, last);
      // "Last" in the order the gate reads them — ascending bill id — so the
      // good line has already been checked when the bad one is reached.
      const bad = first > last ? first : last;
      const good = bad === first ? last : first;
      await alter(bad, set);
      const apBefore = await apDebits();
      const [goodBefore, badBefore] = [await billState(fx.pool, good), await billState(fx.pool, bad)];

      const state = await fx.call(batchPaymentsAction, 'POST', { action: 'process', id: batchId });

      expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
      expect(await billState(fx.pool, good)).toEqual(goodBefore);
      expect(await billState(fx.pool, bad)).toEqual(badBefore);
      const { rows: [b] } = await q(
        'SELECT status, gl_journal_entry_id FROM supplier_payment_batches WHERE id = $1', [batchId]);
      expect(b).toEqual({ status: 'approved', gl_journal_entry_id: null });
      const { rows: pays } = await q('SELECT DISTINCT status FROM supplier_payments WHERE batch_id = $1', [batchId]);
      expect(pays).toEqual([{ status: 'approved' }]);
      expect(await apDebits()).toBe(apBefore);
    });
});
