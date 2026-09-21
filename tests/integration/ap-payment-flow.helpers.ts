// tests/integration/ap-payment-flow.helpers.ts
//
// Route-level steps for the K-063/K-064/K-066 review-round tests: create,
// approve, process and cancel a single payment or a batch, and read back the
// AP control account. Every step goes through the real handler.

import { expect } from 'vitest';
import { ids, type Fixture } from './supplier-ownership-fence.helpers';
import { today } from './ap-allocation-guards.helpers';
import supplierPayments from '../../pages/api/accounting/supplier-payments';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import batchPayments from '../../pages/api/accounting/batch-payments';
import batchPaymentsAction from '../../pages/api/accounting/batch-payments-action';

export type State = { statusCode: number; body: unknown };
export const text = (s: State) => JSON.stringify(s.body);
const idOf = (s: State) => String((s.body as { data: { id: string } }).data.id);

export function flow(fx: () => Fixture) {
  const call = (...a: Parameters<Fixture['call']>) => fx().call(...a);
  const q = (sql: string, params: unknown[]) => fx().pool.query(sql, params);
  return {
    createPayment: (billId: string, amount: number, supplierId = ids.SUP_A) =>
      call(supplierPayments, 'POST', { supplierId, paymentDate: today, totalAmount: amount,
        reference: 'K06X-FLOW', allocations: [{ invoiceId: billId, amount }] }),
    paymentAction: (action: string, paymentId: string) =>
      call(supplierPaymentsAction, 'POST', { action, paymentId }),
    createBatch: (lines: { billId: string; amount: number; supplierId?: string }[]) =>
      call(batchPayments, 'POST', { notes: 'K06X-FLOW', payments: lines.map((l) => ({
        supplierId: l.supplierId ?? ids.SUP_A, invoiceAllocations: [{ invoiceId: l.billId, amount: l.amount }] })) }),
    batchAction: (action: string, id: string) => call(batchPaymentsAction, 'POST', { action, id }),
    /** Create + approve; returns the payment id. */
    async approvedPayment(billId: string, amount: number): Promise<string> {
      const made = await this.createPayment(billId, amount);
      expect(made.statusCode, text(made)).toBe(201);
      const ok = await this.paymentAction('approve', idOf(made));
      expect(ok.statusCode, text(ok)).toBe(200);
      return idOf(made);
    },
    /** Create + approve; returns the batch id. */
    async approvedBatch(lines: { billId: string; amount: number }[]): Promise<string> {
      const made = await this.createBatch(lines);
      expect(made.statusCode, text(made)).toBe(200);
      const ok = await this.batchAction('approve', idOf(made));
      expect(ok.statusCode, text(ok)).toBe(200);
      return idOf(made);
    },
    idOf,
    apDebits: async () => Number((await q(
      'SELECT COALESCE(SUM(debit), 0) AS n FROM gl_journal_lines WHERE gl_account_id = $1', [ids.AP_GL])).rows[0].n),
    paymentStatus: async (id: string) => String((await q(
      'SELECT status FROM supplier_payments WHERE id = $1', [id])).rows[0].status),
    batchStatus: async (id: string) => String((await q(
      'SELECT status FROM supplier_payment_batches WHERE id = $1', [id])).rows[0].status),
    memberOf: async (batchId: string) => String((await q(
      'SELECT id FROM supplier_payments WHERE batch_id = $1 LIMIT 1', [batchId])).rows[0].id),
  };
}
