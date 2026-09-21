// tests/integration/k063-supplier-allocation-status-gate.int.test.ts
//
// K-063: `planSupplierAllocationLines` refused 'cancelled' and 'draft' only, so
// a 'pending_approval' or 'disputed' bill — neither of which has credited AP —
// took a payment. Driven through supplier-allocations POST (withAuth, CSRF,
// write access) and asserted by outcome: the HTTP status, and whether the
// bill's amount_paid and the allocation rows moved.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { allocationsOn, bill, billState, processedPayment } from './ap-allocation-guards.helpers';
import supplierAllocations from '../../pages/api/accounting/supplier-allocations';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('K-063 — a supplier payment settles only a bill that credited AP', () => {
  let fx: Fixture;
  const allocate = async (paymentId: string, invoiceId: string) =>
    fx.call(supplierAllocations, 'POST', { paymentId, allocations: [{ invoiceId, amount: 1000 }] });

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K063');
  });
  afterAll(() => tearDownFixture(fx?.pool));

  it.each(['pending_approval', 'disputed', 'draft', 'cancelled'])(
    'refuses a %s bill with a 400 and moves nothing', async (status) => {
      const invoiceId = await bill(fx.pool, { supplier: ids.SUP_A, status });
      const paymentId = await processedPayment(fx.pool, ids.SUP_A);

      const state = await allocate(paymentId, invoiceId);

      expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
      expect(JSON.stringify(state.body)).toContain(`is ${status} and cannot receive a payment`);
      expect(await billState(fx.pool, invoiceId)).toEqual({ paid: 0, status });
      expect(await allocationsOn(fx.pool, [invoiceId])).toBe(0);
    });

  it('still settles an approved bill in full', async () => {
    const invoiceId = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const paymentId = await processedPayment(fx.pool, ids.SUP_A);

    const state = await allocate(paymentId, invoiceId);

    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await billState(fx.pool, invoiceId)).toEqual({ paid: 1000, status: 'paid' });
    expect(await allocationsOn(fx.pool, [invoiceId])).toBe(1);
  });
});
