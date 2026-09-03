/**
 * Customer Payment Allocation Service
 * GL posting for customer invoices and payment confirmation/cancellation logic.
 * Extracted from customerPaymentService.ts for file-size compliance.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import { defaultHumanMeta } from '../gl/journalEntryMeta';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { assertNoInactiveAccountLines } from '../gl/journalEntryPostingService';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { getCustomerPaymentById } from './customerPaymentService';
import type { CustomerPayment } from '../../types/ar.types';
import type { JournalLineInput } from '../../types/gl.types';

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
    const arAccount = await getSystemAccount('receivable', companyId);
    const bankAccount = payment.bankAccountId
      ? ((await sql`SELECT id FROM gl_accounts WHERE id = ${payment.bankAccountId} AND company_id = ${companyId}`) as Row[])[0]
      : await getSystemAccount('bank', companyId);
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
      lines,
    }, userId);
    await postJournalEntry(companyId, je.id, userId);

    // Update invoice balances and mark payment confirmed — runs on the ALS-bound
    // connection so the outer withAuth transaction provides atomicity.
    for (const alloc of payment.allocations) {
      const newPaid = alloc.amountAllocated;
      await sql`
        UPDATE customer_invoices
        SET amount_paid = amount_paid + ${newPaid},
            status = CASE
              WHEN (total_amount - (amount_paid + ${newPaid})) <= 0.01 THEN 'paid'
              WHEN (amount_paid + ${newPaid}) > 0 THEN 'partially_paid'
              ELSE status
            END,
            paid_at = CASE
              WHEN (total_amount - (amount_paid + ${newPaid})) <= 0.01 THEN NOW()
              ELSE paid_at
            END
        WHERE id = ${alloc.invoiceId}::UUID AND company_id = ${companyId}::UUID
      `;
    }

    const updatedRows = (await sql`
      UPDATE customer_payments
      SET status = 'confirmed', confirmed_by = ${userId}::UUID, confirmed_at = NOW(),
          gl_journal_entry_id = ${je.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING *
    `) as Row[];
    const updated = updatedRows[0] as Row;

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

    // Reverse invoice balances + cancel payment — runs on the ALS-bound
    // connection so the outer withAuth transaction provides atomicity.
    for (const alloc of payment.allocations) {
      await sql`
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
    const updated = (await sql`
      UPDATE customer_payments
      SET status = 'cancelled',
          description = COALESCE(description, '') || ${cancelNote}
      WHERE id = ${id} AND company_id = ${companyId} RETURNING *
    `) as Row[];

    log.info('Cancelled customer payment', { id, reason }, 'accounting');
    return mapPaymentRow(updated[0]!);
  } catch (err) {
    log.error('Failed to cancel customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

/**
 * @param opts.postingAgent Stamp for the AR journal this posts. Optional and
 *   last-positional so every existing caller keeps its current
 *   `human:<userId>` attribution; only callers that are NOT a human clicking
 *   Approve (the MCP finalize_invoice tool) pass it. Mirrors the
 *   reverseJournalEntry / reverseReconciledTransaction opts pattern.
 */
export async function postCustomerInvoiceToGL(
  companyId: string,
  invoiceId: string,
  userId: string,
  opts?: { postingAgent?: string; historicalImport?: boolean },
): Promise<string> {
  try {
    const invRows = (await sql`
      SELECT ci.*, c.name AS client_name
      FROM customer_invoices ci LEFT JOIN customers c ON c.id = ci.client_id
      WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
    `) as Row[];
    if (invRows.length === 0) throw new Error(`Invoice ${invoiceId} not found`);
    const inv = invRows[0]!;

    // Cancel NULLs gl_journal_entry_id after reversing the journal — without
    // this status guard the backfill would re-post a fresh AR/Revenue/VAT
    // journal for a cancelled document (the inverse of audit C1).
    if (String(inv.status) === 'cancelled') {
      throw new Error('Cannot post a cancelled invoice to GL');
    }

    if (inv.gl_journal_entry_id) return String(inv.gl_journal_entry_id);

    const arAccount = await getSystemAccount('receivable', companyId);
    const revenueAccount = await getSystemAccount('default_revenue', companyId);
    const vatAccount = await getSystemAccount('vat_output', companyId);

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

    // pg returns DATE columns as JS Date objects at LOCAL midnight — on this
    // UTC+2 server toISOString() rolls the date back a day, so every
    // auto_invoice journal was dated one day before its invoice (baseline
    // finding N4). fmtDate uses local getters and handles both shapes.
    const entryDate = fmtDate(inv.invoice_date);

    // Closed-period check runs HERE, before createJournalEntry, not inside
    // postJournalEntry afterwards. pages/api/accounting/customer-invoices-gl.ts
    // catches every error from this function and answers 400, and withAuth only
    // ROLLBACKs on >= 500 -- so a refusal raised after the entry was created
    // would COMMIT an orphan draft journal while reporting failure. Refusing
    // before any write keeps that 400 honest.
    //
    // historicalImport waives it for the Sage migration alone, which exists to
    // land 2022-2024 invoices in their real periods (955 such journals already
    // sit in closed periods in production). Nothing else may pass it.
    if (!opts?.historicalImport) {
      const periodStatus = await getPeriodStatusForDate(companyId, entryDate);
      if (periodStatus === 'closed') {
        throw new Error(
          `Cannot post invoice ${inv.invoice_number} to GL — its fiscal period is closed. ` +
            `Reopen the period, or date the invoice in an open one.`,
        );
      }
    }
    // sourceDocumentId FKs to captured_documents(id) — not customer_invoices.
    // The invoice↔JE link is maintained via customer_invoices.gl_journal_entry_id
    // below.
    const je = await createJournalEntry(companyId, {
      entryDate,
      description: `Customer invoice ${inv.invoice_number}`,
      source: 'auto_invoice',
      lines,
    }, userId, opts?.postingAgent ? { postingAgent: opts.postingAgent } : defaultHumanMeta(userId));

    if (opts?.historicalImport) {
      // Historical import diverges from the canonical path (postJournalEntry)
      // for ONE reason: a migrated invoice belongs in its original period, and
      // postJournalEntry refuses a closed one. Every other guard still applies,
      // so the inactive-account check is made explicitly here.
      await assertNoInactiveAccountLines(companyId, je.id);
      const safeUserId = await resolveUserUuid(userId);
      await sql`
        UPDATE gl_journal_entries
        SET status = 'posted', posted_by = ${safeUserId}::UUID, posted_at = NOW()
        WHERE id = ${je.id}::UUID AND company_id = ${companyId}
      `;
    } else {
      // Canonical path: inherits the balance, period and inactive-account
      // guards rather than restating them here.
      await postJournalEntry(companyId, je.id, userId);
    }

    // Use the ALS-bound connection (plain `sql`) rather than withTransaction.
    // withTransaction gets a fresh pool connection that can't see the invoice
    // INSERT when we're nested inside an outer request transaction (e.g. the
    // admin Sage commit handler), so the link-back UPDATE silently matched
    // 0 rows. Same-connection queries participate in the outer tx and see
    // the invoice row.
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
import type { CustomerPaymentStatus } from '../../types/ar.types';

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
