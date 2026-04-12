/**
 * Supplier Payment Workflow Service
 * Approve and process payment operations — split from supplierPaymentService.ts.
 */

import { sql, withTransaction, fmtDate } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getSystemAccount } from './systemAccountResolver';
import { getSupplierPaymentById } from './supplierPaymentService';
import type { SupplierPayment } from '../types/ap.types';
import type { JournalLineInput } from '../types/gl.types';
type Row = DbRow;

export async function approveSupplierPayment(
  companyId: string,
  id: string,
  userId: string,
): Promise<SupplierPayment> {
  try {
    const payment = await getSupplierPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'draft') throw new Error(`Cannot approve payment with status: ${payment.status}`);

    const rows = (await sql`
      UPDATE supplier_payments
      SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}::UUID
      RETURNING *
    `) as Row[];

    return mapPaymentRow(rows[0]!);
  } catch (err) {
    log.error('Failed to approve supplier payment', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function processSupplierPayment(
  companyId: string,
  id: string,
  userId: string,
): Promise<SupplierPayment> {
  try {
    const payment = await getSupplierPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'approved') throw new Error(`Payment must be approved before processing`);

    const apAccount = await getSystemAccount('payable');
    const bankAccount = payment.bankAccountId
      ? ((await sql`SELECT * FROM gl_accounts WHERE id = ${payment.bankAccountId}`) as Row[])[0]
      : await getSystemAccount('bank');

    if (!bankAccount) throw new Error('Bank account not found');

    const lines: JournalLineInput[] = [
      {
        glAccountId: apAccount.id,
        debit: payment.totalAmount,
        credit: 0,
        description: `Payment ${payment.paymentNumber} to supplier`,
      },
      {
        glAccountId: String(bankAccount.id),
        debit: 0,
        credit: payment.totalAmount,
        description: `Payment ${payment.paymentNumber} to supplier`,
      },
    ];

    const journalEntry = await createJournalEntry(companyId, {
      entryDate: payment.paymentDate,
      description: `Supplier payment ${payment.paymentNumber}`,
      source: 'auto_supplier_payment',
      sourceDocumentId: id,
      lines,
    }, userId);

    await postJournalEntry(companyId, journalEntry.id, userId);

    const updated = await withTransaction(async (tx) => {
      for (const alloc of payment.allocations) {
        await tx`
          UPDATE supplier_invoices
          SET amount_paid = amount_paid + ${alloc.amountAllocated}
          WHERE id = ${alloc.invoiceId}
        `;
        await tx`
          UPDATE supplier_invoices SET status = CASE
            WHEN (total_amount - amount_paid) <= 0.01 THEN 'paid'
            WHEN amount_paid > 0 THEN 'partially_paid'
            ELSE status
          END
          WHERE id = ${alloc.invoiceId}
        `;
      }

      const rows = (await tx`
        UPDATE supplier_payments
        SET status = 'processed', processed_at = NOW(),
            gl_journal_entry_id = ${journalEntry.id}::UUID
        WHERE id = ${id} AND company_id = ${companyId}::UUID
        RETURNING *
      `) as Row[];

      return rows[0] as Row;
    });

    log.info('Processed supplier payment', { id, journalEntryId: journalEntry.id }, 'accounting');
    return mapPaymentRow(updated);
  } catch (err) {
    log.error('Failed to process supplier payment', { id, error: err }, 'accounting');
    throw err;
  }
}

function mapPaymentRow(row: Row): SupplierPayment {
  return {
    id: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    supplierId: String(row.supplier_id),
    paymentDate: fmtDate(row.payment_date),
    totalAmount: Number(row.total_amount),
    paymentMethod: String(row.payment_method) as SupplierPayment['paymentMethod'],
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : undefined,
    reference: row.reference ? String(row.reference) : undefined,
    description: row.description ? String(row.description) : undefined,
    status: String(row.status) as SupplierPayment['status'],
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    batchId: row.batch_id ? String(row.batch_id) : undefined,
    createdBy: String(row.created_by),
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    processedAt: row.processed_at ? String(row.processed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
  };
}
