// tests/integration/k063-supplier-statement-payment-amount.int.test.ts
//
// The supplier statement lists a payment at the CASH it paid. Its query joined
// the dead `supplier_payment_allocations` table (zero rows), so it always fell
// back to the payment total. Swapping in the live `payment_allocations` would
// have shown a R1,000 payment with R600 applied as R600 — so the join is gone
// and the figure is the total. Before and after this change: FULL 1000,
// PARTIAL 1000.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill } from './ap-allocation-guards.helpers';
import { fetchSupplierStatementData } from '../../src/modules/accounting/services/ap/supplierStatementService';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('supplier statement — a payment is shown at the cash it paid', () => {
  let fx: Fixture;
  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K063 stmt');
  });
  afterAll(() => tearDownFixture(fx?.pool));

  it('shows a fully applied AND a partly applied R1,000 payment as R1,000 each', async () => {
    const q = (s: string, p: unknown[]) => fx.pool.query(s, p);
    const full = await bill(fx.pool, { supplier: ids.SUP_A, status: 'paid', total: 1000, paid: 1000 });
    const part = await bill(fx.pool, { supplier: ids.SUP_A, status: 'partially_paid', total: 1000, paid: 600 });
    for (const [ref, applied, billId] of [['STMT-FULL', 1000, full], ['STMT-PARTIAL', 600, part]] as const) {
      const id = randomUUID();
      await q(`INSERT INTO supplier_payments (id, company_id, supplier_id, payment_number, payment_date, total_amount,
        payment_method, status, created_by) VALUES ($1, $2, $3, $4, CURRENT_DATE, 1000, 'eft', 'processed', $5)`,
      [id, ids.A, ids.SUP_A, ref, ids.USER]);
      await q('INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES ($1, $2, $3)',
        [id, billId, applied]);
    }
    const data = await fetchSupplierStatementData(ids.A, ids.SUP_A, new Date().toISOString().slice(0, 10));
    const debits = Object.fromEntries(data!.transactions
      .filter((t) => t.reference.startsWith('STMT-')).map((t) => [t.reference, t.debit]));
    expect(debits).toEqual({ 'STMT-FULL': 1000, 'STMT-PARTIAL': 1000 });
  });
});
