/**
 * D12 census row 6, the provisional-settlement arm (`ap/provisionalSettlementVoid`): voiding the supplier payment that
 * settled a bank-first provisional, when the provisional's statement line is IN a completed reconciliation, is the
 * shared 409 ("is completed — reopen it first"), writing nothing. On ddc4dd355: 400 (SupplierPaymentRefusal), the
 * same answer as a Sage-reconciled line, which keeps its 400 (r127-settlement-undo).
 *
 * The line's stamp is written by hand: a provisional's line joins a session by being claimed while 'imported',
 * provisional-posted, then evidenced — the one fixture step this file does not take through the product.
 */
import { afterAll, describe, expect, it } from 'vitest';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { unapplySupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentUnapply';
import {
  completeReconciliation, startReconciliation,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import {
  bankGl, callRoute, company, companySnapshot, inTx, paymentsFor, pool, seedDoc, seedInvoice, seedProvisional, today,
  useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = $1', [company]);
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = $1', [company]);
});

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12: a settled provisional whose line a completed reconciliation holds', () => {
  it('void of the settling payment -> 409, nothing written', async () => {
    const doc = await seedDoc();
    const { bt } = await seedProvisional({ totalAmount: 907.15, evidencedBy: doc });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 907.15 });
    await inTx(() => approveSupplierInvoice(company, invoiceId, user));
    const [p] = await paymentsFor(bt, invoiceId);
    await inTx(() => unapplySupplierPayment(company, { paymentId: p!.id }, user));
    const gl = Number((await pool.query(`SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS b FROM gl_journal_lines l
      JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE l.gl_account_id = $1 AND e.status = 'posted' AND e.entry_date <= $2`, [bankGl, today])).rows[0].b);
    const rec = await inTx(() => startReconciliation(company, bankGl, today, gl, user));
    await pool.query('UPDATE bank_transactions SET reconciliation_id = $1 WHERE id = $2', [rec.id, bt]);
    await inTx(() => completeReconciliation(company, rec.id, user));
    expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [bt])).rows[0].status).toBe('reconciled');

    const before = await companySnapshot(invoiceId);
    const res = await callRoute(supplierPaymentsAction as never, '/api/accounting/supplier-payments-action',
      { action: 'void', paymentId: p!.id });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/is completed — reopen it first/);
    expect(await companySnapshot(invoiceId)).toEqual(before);
    expect((await pool.query('SELECT status, reconciliation_id::TEXT AS rec FROM bank_transactions WHERE id = $1', [bt])).rows[0])
      .toEqual({ status: 'reconciled', rec: rec.id });
  }, 60000);
});
