/**
 * Void after refund, the bank-first settlement arm (`ap/provisionalSettlementVoid`, R-127): a settlement payment is
 * voided only once wholly unapplied, so voiding it takes its whole total off the supplier's on-account credit. When a
 * refund has already returned that cash the void is refused before any write (Hein's ruling 2026-10-26) — through the
 * payments route (400, withAuth COMMITs nothing because nothing was written) and through MCP void_payment (a coded
 * refusal-coded throw). The main suite is ap-supplier-void-after-refund.int.test.ts. Disposable fixture DB only.
 */
import { describe, expect, it } from 'vitest';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import { voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';
import { als } from '@/lib/als';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { unapplySupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentUnapply';
import { planSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import {
  btState, callRoute, company, inTx, jeState, paymentsFor, pool, seedDoc, seedInvoice, seedProvisional, supplier,
  today, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();

/** A settled provisional, its payment then unapplied (an unapplied credit of `total`), then refunded in full. */
async function settledUnappliedRefunded(total: number) {
  const doc = await seedDoc();
  const { je, bt } = await seedProvisional({ totalAmount: total, evidencedBy: doc });
  const invoiceId = await seedInvoice({ documentId: doc, totalAmount: total });
  await inTx(() => approveSupplierInvoice(company, invoiceId, user));
  const [p] = await paymentsFor(bt, invoiceId);
  await inTx(() => unapplySupplierPayment(company, { paymentId: p!.id }, user));
  await inTx(async () => {
    await planSupplierRefund(company, supplier, total, today);
    const { client } = als.getStore() as unknown as { client: { query: (q: string, v: unknown[]) => Promise<unknown> } };
    await client.query(
      `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,reference,status,created_by)
       VALUES($1,$2,$3::DATE,$4,'refund','VAR settlement refund','processed',$5)`, [company, supplier, today, -total, user]);
  });
  return { je, bt, paymentId: p!.id };
}

const statusOf = async (id: string) =>
  String((await pool.query('SELECT status FROM supplier_payments WHERE id = $1', [id])).rows[0].status);

describe('void of an unapplied bank-first settlement whose cash a refund returned', () => {
  it('the payments route refuses it 400, nothing written', async () => {
    const s = await settledUnappliedRefunded(640.00);
    const res = await callRoute(supplierPaymentsAction, '/api/accounting/supplier-payments-action',
      { action: 'void', paymentId: s.paymentId });
    expect({ code: res.statusCode, status: await statusOf(s.paymentId), provisionalReversed: (await jeState(s.je)).reversed_at,
      line: (await btState(s.bt)).status })
      .toEqual({ code: 400, status: 'processed', provisionalReversed: null, line: expect.not.stringMatching(/^imported$/) });
    expect(JSON.stringify(res.body)).toMatch(/owing the company[\s\S]*Reverse the refund first/);
  });

  it('MCP void_payment raises a coded refusal the registry answers with its message, nothing written', async () => {
    const s = await settledUnappliedRefunded(655.00);
    const ctx = { companyId: company, userId: user, scopes: ['write:invoices', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    // The handler does not catch (a mid-write failure must reach the registry's savepoint); the registry answers a
    // refusal-coded throw with its own message.
    const err = await inTx(() => voidPaymentTool.handler(
      { payment_id: s.paymentId, idempotency_key: crypto.randomUUID() }, ctx as never)).then(() => null, (e: unknown) => e);
    expect({ coded: isRefusalCoded(err), status: await statusOf(s.paymentId), provisionalReversed: (await jeState(s.je)).reversed_at })
      .toEqual({ coded: true, status: 'processed', provisionalReversed: null });
    expect((err as Error).message).toMatch(/owing the company[\s\S]*Reverse the refund first/);
  });
});
