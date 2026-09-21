// tests/integration/supplier-ownership-fence-documents.int.test.ts
//
// R-068, the supplier twin of R-067. Every FK to `suppliers` except one is
// tenant-agnostic (`bank_categorisation_rules` alone carries (supplier_id,
// company_id)), and the RLS WITH CHECK on each table tests only the row's own
// company_id — so a supplier id taken from a request body was never checked
// against `suppliers`, and company A could book a bill, a PO, a payment or a
// return against company B's supplier.
//
// Driven through the real handlers — `withAuth`, CSRF, write access — because
// the refusal has to be a 4xx and has to come BEFORE the first write (`withAuth`
// COMMITs a 4xx returned after one). Each case asserts by outcome: B's supplier
// leaves zero rows behind, and A's own supplier still writes one.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  ids, setUpFixture, tearDownFixture, fenceCases, type Fixture, type SupplierCase,
} from './supplier-ownership-fence.helpers';
import supplierInvoices from '../../pages/api/accounting/supplier-invoices';
import purchaseOrders from '../../pages/api/accounting/purchase-orders';
import purchaseOrderDetail from '../../pages/api/accounting/purchase-orders/[id]';
import supplierPurchaseOrders from '../../pages/api/accounting/supplier-purchase-orders';
import supplierPayments from '../../pages/api/accounting/supplier-payments';
import batchPayments from '../../pages/api/accounting/batch-payments';
import supplierReturns from '../../pages/api/accounting/supplier-returns';
import recurringExecute from '../../pages/api/accounting/recurring-transactions-execute';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import bankTransactionsManual from '../../pages/api/accounting/bank-transactions-manual';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const today = new Date().toISOString().slice(0, 10);

describeIfDb('R-068 — every AP document route refuses a foreign supplier id', () => {
  let fx: Fixture;
  const { A } = ids;
  const n = (text: string, params: unknown[]) => fx.count(text, params);
  const where = (table: string, extra: string, params: unknown[] = []) => (s: string) =>
    n(`SELECT count(*) AS n FROM ${table} WHERE company_id = $1 AND supplier_id = $2 AND ${extra}`,
      [A, s, ...params]);

  const manual = (type: string, allocationType: string, entityId: string, s: string) => ({
    type, allocationType, entityId, bankAccountId: ids.BANK_GL, date: today, amount: 33,
    description: `R068-MANUAL-${allocationType}-${s}` });
  const manualLines = (arm: string) => (s: string) => n(`SELECT count(*) AS n FROM bank_transactions
    WHERE company_id = $1 AND description = $2`, [A, `R068-MANUAL-${arm}-${s}`]);

  const cases = (): SupplierCase[] => [
    { name: 'supplier-invoices POST', handler: supplierInvoices, method: 'POST', refusal: 400,
      body: (s) => ({ supplierId: s, useSequence: true, invoiceDate: today, reference: 'R068-SI',
        items: [{ description: 'Fence bill', quantity: 1, unitPrice: 100, glAccountId: ids.GL }] }),
      carried: where('supplier_invoices', "reference = 'R068-SI'") },
    { name: 'purchase-orders POST', handler: purchaseOrders, method: 'POST', refusal: 400,
      body: (s) => ({ supplierId: s, reference: 'R068-PO',
        items: [{ description: 'Fence PO', quantity: 1, unitPrice: 10 }] }),
      carried: where('purchase_orders', "reference = 'R068-PO'") },
    { name: 'purchase-orders/[id] PUT', handler: purchaseOrderDetail, method: 'PUT', refusal: 400,
      query: () => ({ id: ids.PO }), body: (s) => ({ supplier_id: s }),
      carried: where('purchase_orders', 'id = $3', [ids.PO]) },
    { name: 'supplier-purchase-orders POST', handler: supplierPurchaseOrders, method: 'POST', refusal: 400,
      body: (s) => ({ supplier_id: s, order_date: today, reference: 'R068-SPO',
        items: [{ description: 'Fence SPO', quantity: 1, unit_price: 10, tax_rate: 15 }] }),
      carried: where('supplier_purchase_orders', "reference = 'R068-SPO'") },
    { name: 'supplier-purchase-orders PUT', handler: supplierPurchaseOrders, method: 'PUT', refusal: 400,
      body: (s) => ({ id: ids.SPO, supplier_id: s }),
      carried: where('supplier_purchase_orders', 'id = $3', [ids.SPO]) },
    { name: 'supplier-payments POST', handler: supplierPayments, method: 'POST', refusal: 400,
      body: (s) => ({ supplierId: s, paymentDate: today, totalAmount: 10, reference: 'R068-PAY',
        allocations: [{ invoiceId: ids.BILL_A, amount: 10 }] }),
      carried: where('supplier_payments', "reference = 'R068-PAY'") },
    { name: 'batch-payments POST', handler: batchPayments, method: 'POST', refusal: 400,
      body: (s) => ({ notes: 'R068 batch',
        payments: [{ supplierId: s, invoiceAllocations: [{ invoiceId: ids.BILL_A, amount: 5 }] }] }),
      carried: where('supplier_payments', 'batch_id IS NOT NULL') },
    { name: 'supplier-returns POST', handler: supplierReturns, method: 'POST', refusal: 400,
      body: (s) => ({ supplierId: s, amount: 20, reason: 'R068-RET' }),
      carried: where('credit_notes', "reason = 'R068-RET'") },
    { name: 'recurring-transactions-execute POST (bill template naming the supplier)',
      handler: recurringExecute, method: 'POST', refusal: 400,
      body: (s) => ({ templateId: s === ids.SUP_A ? ids.TEMPLATE_A : ids.TEMPLATE_B }),
      carried: where('supplier_invoices', "reference = 'R068-REC'") },
    { name: 'bank-transactions-action allocate (supplier)', handler: bankTransactionsAction,
      method: 'POST', refusal: 400,
      body: (s) => ({ action: 'allocate', bankTransactionId: ids.BANK_TX_PAY, allocationType: 'supplier',
        entityId: s, description: 'R068 allocation' }),
      carried: where('supplier_payments', 'reference = $3', [ids.BANK_TX_PAY]) },
    // The manual route INSERTs the bank line before allocateTransaction's fence
    // runs, so its refusal must come first: B's entity leaves no bank row at all.
    { name: 'bank-transactions-manual POST (supplier)', handler: bankTransactionsManual, method: 'POST',
      refusal: 400, body: (s) => manual('spend', 'supplier', s, s),
      carried: manualLines('supplier') },
    { name: 'bank-transactions-manual POST (customer)', handler: bankTransactionsManual, method: 'POST',
      refusal: 400, body: (s) => manual('receive', 'customer', s === ids.SUP_A ? ids.CUST_A : ids.CUST_B, s),
      carried: manualLines('customer') },
  ];

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('R068 docs');
  });
  afterAll(() => tearDownFixture(fx?.pool));

  fenceCases(() => fx, cases);

  it('the refused bank allocation posted no journal — only A\'s own allocation did', async () => {
    expect(await n(`SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = $1
      AND description = 'R068 allocation'`, [A])).toBe(1);
  });

  it('a refused bill with useSequence burns no SIV number', async () => {
    const counter = async () => (await fx.pool.query(
      "SELECT next_number FROM company_document_numbers WHERE company_id = $1 AND document_type = 'supplier_invoice'",
      [A])).rows.map((r) => Number(r.next_number));
    const before = await counter();
    const state = await fx.call(supplierInvoices, 'POST', { supplierId: ids.SUP_B, useSequence: true,
      invoiceDate: today, items: [{ description: 'Fence bill', quantity: 1, unitPrice: 1 }] });
    expect(state.statusCode).toBe(400);
    expect(await counter()).toEqual(before);
  });

  it('recurring execute answers 400 for a bill template whose supplierId is not a UUID', async () => {
    const before = await n('SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1', [A]);
    const state = await fx.call(recurringExecute, 'POST', { templateId: ids.TEMPLATE_BAD });
    expect(state.statusCode).toBe(400);
    expect(await n('SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1', [A])).toBe(before);
    expect(await n(`SELECT count(*) AS n FROM recurring_transaction_templates
      WHERE id = $1 AND next_run_date = CURRENT_DATE`, [ids.TEMPLATE_BAD])).toBe(1);
  });
});
