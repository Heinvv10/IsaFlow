/**
 * Customer Payment Allocation Service
 * GL posting for customer invoices and payment confirmation/cancellation logic.
 * Extracted from customerPaymentService.ts for file-size compliance.
 */

import { sql, fmtDate, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from './journalEntryService';
import { getSystemAccount } from './systemAccountResolver';
import { getCustomerPaymentById } from './customerPaymentService';
import type { CustomerPayment } from '../types/ar.types';
import type { JournalLineInput } from '../types/gl.types';

type Row = DbRow;

export async function confirmCustomerPayment(
  companyId: string,
  id: string,
  userId: string,
): Promise<CustomerPayment> {
  try {
    const payment = await getCustomerPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'draft') throw new Error(`Cannot confirm payment with status: ${payment.status}`);

    // Auto-post GL: DR Bank, CR Accounts Receivable
    const arAccount = await getSystemAccount('receivable');
    const bankAccount = payment.bankAccountId
      ? ((await sql`SELECT id FROM gl_accounts WHERE id = ${payment.bankAccountId}`) as Row[])[0]
      : await getSystemAccount('bank');
    if (!bankAccount) throw new Error('Bank account not found');

    const lines: JournalLineInput[] = [
      { glAccountId: String(bankAccount.id), debit: payment.totalAmount, credit: 0,
        description: `Customer payment ${payment.paymentNumber}` },
      { glAccountId: arAccount.id, debit: 0, credit: payment.totalAmount,
        description: `Customer payment ${payment.paymentNumber}` },
    ];

    const je = await createJournalEntry(companyId, {
      entryDate: payment.paymentDate,
      description: `Customer payment ${payment.paymentNumber}`,
      source: 'auto_payment',
      sourceDocumentId: id,
      lines,
    }, userId);
    await postJournalEntry(companyId, je.id, userId);

    // Update invoice balances and mark payment confirmed atomically
    const updated = await withTransaction(async (tx) => {
      for (const alloc of payment.allocations) {
        await tx`
          UPDATE customer_invoices SET amount_paid = amount_paid + ${alloc.amountAllocated}
          WHERE id = ${alloc.invoiceId}::UUID
        `;
        await tx`
          UPDATE customer_invoices SET status = CASE
            WHEN (total_amount - amount_paid) <= 0.01 THEN 'paid'
            WHEN amount_paid > 0 THEN 'partially_paid'
            ELSE status
          END, paid_at = CASE WHEN (total_amount - amount_paid) <= 0.01 THEN NOW() ELSE paid_at END
          WHERE id = ${alloc.invoiceId}::UUID
        `;
      }

      const rows = (await tx`
        UPDATE customer_payments
        SET status = 'confirmed', confirmed_by = ${userId}::UUID, confirmed_at = NOW(),
            gl_journal_entry_id = ${je.id}::UUID
        WHERE id = ${id} RETURNING *
      `) as Row[];

      return rows[0] as Row;
    });

    log.info('Confirmed customer payment', { id, journalEntryId: je.id }, 'accounting');
    return mapPaymentRow(updated);
  } catch (err) {
    log.error('Failed to confirm customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function cancelCustomerPayment(
  companyId: string,
  id: string,
  userId: string,
  reason?: string,
): Promise<CustomerPayment> {
  try {
    const payment = await getCustomerPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'confirmed') {
      throw new Error(`Cannot cancel payment with status: ${payment.status}`);
    }

    // Reverse GL journal entry
    if (payment.glJournalEntryId) {
      await reverseJournalEntry(companyId, payment.glJournalEntryId, userId);
    }

    // Reverse invoice balances + cancel payment atomically
    const updated = await withTransaction(async (tx) => {
      for (const alloc of payment.allocations) {
        await tx`
          UPDATE customer_invoices
          SET amount_paid = GREATEST(0, amount_paid - ${alloc.amountAllocated}),
              status = CASE
                WHEN GREATEST(0, amount_paid - ${alloc.amountAllocated}) <= 0.01 THEN 'approved'
                WHEN GREATEST(0, amount_paid - ${alloc.amountAllocated}) < total_amount THEN 'partially_paid'
                ELSE status
              END,
              paid_at = CASE WHEN GREATEST(0, amount_paid - ${alloc.amountAllocated}) <= 0.01 THEN NULL ELSE paid_at END
          WHERE id = ${alloc.invoiceId}::UUID AND company_id = ${companyId}
        `;
      }

      const cancelNote = reason ? ` [CANCELLED: ${reason}]` : ' [CANCELLED]';
      return (await tx`
        UPDATE customer_payments
        SET status = 'cancelled',
            description = COALESCE(description, '') || ${cancelNote}
        WHERE id = ${id} AND company_id = ${companyId} RETURNING *
      `) as Row[];
    }) as Row[];

    log.info('Cancelled customer payment', { id, reason }, 'accounting');
    return mapPaymentRow(updated[0]!);
  } catch (err) {
    log.error('Failed to cancel customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function postCustomerInvoiceToGL(
  companyId: string,
  invoiceId: string,
  userId: string,
): Promise<string> {
  try {
    const invRows = (await sql`
      SELECT ci.*, c.name AS client_name
      FROM customer_invoices ci LEFT JOIN customers c ON c.id = ci.client_id
      WHERE ci.id = ${invoiceId}::UUID
    `) as Row[];
    if (invRows.length === 0) throw new Error(`Invoice ${invoiceId} not found`);
    const inv = invRows[0]!;

    if (inv.gl_journal_entry_id) return String(inv.gl_journal_entry_id);

    const arAccount = await getSystemAccount('receivable');
    const revenueAccount = await getSystemAccount('default_revenue');
    const vatAccount = await getSystemAccount('vat_output');

    const lines: JournalLineInput[] = [
      { glAccountId: arAccount.id, debit: Number(inv.total_amount), credit: 0,
        description: `AR: ${inv.invoice_number}` },
      { glAccountId: revenueAccount.id, debit: 0, credit: Number(inv.subtotal),
        description: `Revenue: ${inv.invoice_number}` },
    ];

    if (Number(inv.tax_amount) > 0) {
      lines.push({
        glAccountId: vatAccount.id, debit: 0, credit: Number(inv.tax_amount),
        description: `VAT Output: ${inv.invoice_number}`,
      });
    }

    const je = await createJournalEntry(companyId, {
      entryDate: String(inv.invoice_date),
      description: `Customer invoice ${inv.invoice_number}`,
      source: 'auto_invoice',
      sourceDocumentId: invoiceId,
      lines,
    }, userId);
    await postJournalEntry(companyId, je.id, userId);

    await sql`
      UPDATE customer_invoices SET gl_journal_entry_id = ${je.id}::UUID
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    `;

    log.info('Posted customer invoice to GL', { invoiceId, journalEntryId: je.id }, 'accounting');
    return je.id;
  } catch (err) {
    log.error('Failed to post customer invoice to GL', { invoiceId, error: err }, 'accounting');
    throw err;
  }
}

// ── Private mapper ────────────────────────────────────────────────────────────
import type { CustomerPaymentStatus } from '../types/ar.types';

function mapPaymentRow(row: Row): CustomerPayment {
  return {
    id: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    clientId: String(row.client_id),
    paymentDate: fmtDate(row.payment_date),
    totalAmount: Number(row.total_amount),
    paymentMethod: String(row.payment_method) as CustomerPayment['paymentMethod'],
    bankReference: row.bank_reference ? String(row.bank_reference) : undefined,
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : undefined,
    description: row.description ? String(row.description) : undefined,
    status: String(row.status) as CustomerPaymentStatus,
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    createdBy: String(row.created_by),
    confirmedBy: row.confirmed_by ? String(row.confirmed_by) : undefined,
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    clientName: row.client_name ? String(row.client_name) : undefined,
    allocatedAmount: row.allocated_amount !== undefined ? Number(row.allocated_amount) : 0,
  };
}
