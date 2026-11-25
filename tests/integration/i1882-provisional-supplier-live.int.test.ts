/**
 * #1882 L1: approving a bill that a bank-first provisional settles writes a supplier payment. Its supplier is now locked live when the
 * claim is taken, before the bill's journal (provisionalSettlementClaim -> supplierLiveLock), so a supplier soft-deleted since is a
 * typed refusal with its remedy, nothing written, instead of migration 1023's raw 23503 after the journal. Real PostgreSQL
 * (r127 fixture). Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { describe, expect, it } from 'vitest';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import { SUPPLIER_NOT_LIVE_REFUSAL } from '@/modules/accounting/services/core/supplierLiveLock';
import { company, inTx, pool, seedDoc, seedInvoice, seedProvisional, supplier, useR127Fixture, user } from './r127-double-booking.helpers';

useR127Fixture();

describe('a provisional-settled bill approval and a supplier deleted since', () => {
  it('is refused before the journal, typed, naming the supplier; the bill stays unapproved', async () => {
    const doc = await seedDoc();
    await seedProvisional({ totalAmount: 115, evidencedBy: doc });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 115 });
    const before = Number((await pool.query('SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = $1', [company])).rows[0].n);
    await pool.query('UPDATE suppliers SET deleted_at = now() WHERE id = $1', [supplier]);
    try {
      const err = await inTx(() => approveSupplierInvoice(company, invoiceId, user)).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(SupplierPaymentRefusal);
      expect((err as Error).message).toBe(SUPPLIER_NOT_LIVE_REFUSAL);
      expect((await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [invoiceId])).rows[0].status).not.toBe('approved');
      expect(Number((await pool.query('SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = $1', [company])).rows[0].n)).toBe(before);
    } finally { await pool.query('UPDATE suppliers SET deleted_at = NULL WHERE id = $1', [supplier]); }
  });
});
