// tests/integration/k066-supplier-payment-foreign-bill.int.test.ts
//
// K-066: `createSupplierPayment` read its bills by company and id only. R-068
// (`assertSupplierInCompany`) since refuses a supplier id from ANOTHER company;
// it says nothing about whose bill each allocation names, or whether that bill
// is payable. So a payment to supplier A could name supplier A2's bill in the
// same company, or a draft / cancelled / pending_approval one. Driven through
// supplier-payments POST, asserted by status and by the rows left behind.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { allocationsOn, bill, rowCount, today } from './ap-allocation-guards.helpers';
import supplierPayments from '../../pages/api/accounting/supplier-payments';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('K-066 — a supplier payment may name only its own supplier\'s payable bills', () => {
  let fx: Fixture;
  const pay = async (supplierId: string, invoiceId: string) =>
    fx.call(supplierPayments, 'POST', { supplierId, paymentDate: today, totalAmount: 1000,
      reference: 'K066', allocations: [{ invoiceId, amount: 1000 }] });

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K066');
  });
  afterAll(() => tearDownFixture(fx?.pool));

  it("refuses supplier A2's bill on a payment to supplier A — same company, so R-068 passes it", async () => {
    const invoiceId = await bill(fx.pool, { supplier: ids.SUP_A2, status: 'approved' });
    const before = await rowCount(fx.pool, 'supplier_payments');

    const state = await pay(ids.SUP_A, invoiceId);

    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
    expect(JSON.stringify(state.body)).toContain('belongs to a different supplier than this payment');
    expect(await rowCount(fx.pool, 'supplier_payments')).toBe(before);
    expect(await allocationsOn(fx.pool, [invoiceId])).toBe(0);
  });

  it.each(['draft', 'cancelled', 'pending_approval', 'disputed'])(
    'refuses a %s bill and writes no payment', async (status) => {
      const invoiceId = await bill(fx.pool, { supplier: ids.SUP_A, status });
      const before = await rowCount(fx.pool, 'supplier_payments');

      const state = await pay(ids.SUP_A, invoiceId);

      expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
      expect(JSON.stringify(state.body)).toContain(`is ${status} and cannot receive a payment`);
      expect(await rowCount(fx.pool, 'supplier_payments')).toBe(before);
      expect(await allocationsOn(fx.pool, [invoiceId])).toBe(0);
    });

  it("still refuses company B's bill and writes nothing", async () => {
    const invoiceId = await bill(fx.pool, { company: ids.B, supplier: ids.SUP_B, status: 'approved' });
    const before = await rowCount(fx.pool, 'supplier_payments');

    const state = await pay(ids.SUP_A, invoiceId);

    expect(state.statusCode).toBeGreaterThanOrEqual(400);
    expect(await rowCount(fx.pool, 'supplier_payments')).toBe(before);
  });

  it("creates the payment against supplier A's own approved bill", async () => {
    const invoiceId = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });

    const state = await pay(ids.SUP_A, invoiceId);

    expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
    expect(await allocationsOn(fx.pool, [invoiceId])).toBe(1);
  });
});
