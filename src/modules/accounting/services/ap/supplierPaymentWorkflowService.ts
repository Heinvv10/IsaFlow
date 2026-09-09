/**
 * Supplier Payment Workflow Service
 * Approve and process payment operations — split from supplierPaymentService.ts.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { resolveApControlAccounts } from './apControlAccounts';
import { requireControlTx } from '../controls/context';
import { defaultHumanMeta } from '../gl/journalEntryMeta';
import { getSupplierPaymentById } from './supplierPaymentService';
import type { SupplierPayment } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';
import { runApControlled, type ApApprovalOptions } from './apControlBoundary';
import type { ControlledEffectPermit } from '../controls/approvalExecutionService';
import { registerGeneratedJournal } from '../controls/generatedJournalPermit';
import { applyControlledSupplierSettlement } from './supplierPaymentSettlement';
import { recordPaymentStatusApproval } from './supplierPaymentStatusControl';
type Row = DbRow;

export async function approveSupplierPayment(companyId: string, id: string, userId: string): Promise<SupplierPayment> {
  return recordPaymentStatusApproval(companyId, id, userId, () => approveSupplierPaymentEffect(companyId, id, userId));
}

async function approveSupplierPaymentEffect(
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

/**
 * @param opts.postingAgent Stamp for the DR Accounts Payable / CR Bank journal
 *   this posts. Optional and last-positional so every existing caller keeps its
 *   `human:<userId>` attribution; only non-human callers (the MCP
 *   settle_by_contra tool) pass it. Same reasoning as
 *   approveSupplierInvoice / postSupplierInvoiceToGL.
 */
async function processSupplierPaymentEffect(
  companyId: string,
  id: string,
  userId: string,
  opts: { postingAgent?: string } | undefined,
  permit: ControlledEffectPermit,
): Promise<SupplierPayment> {
  try {
    const payment = await getSupplierPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'approved') throw new Error(`Payment must be approved before processing`);

    const { chosen } = await resolveApControlAccounts(requireControlTx(), { operation: 'supplier_payment.process', entityType: 'supplier_payment', entityId: id });
    const apAccount = chosen.payable!, bankAccount = chosen.bank!;

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
      sourceRecordId: id,
      lines,
    }, userId, opts?.postingAgent ? { postingAgent: opts.postingAgent } : defaultHumanMeta(userId));

    const parentControl = { permit, parent: { operation: 'supplier_payment.process' as const, entityType: 'supplier_payment', entityId: id } };
    await registerGeneratedJournal(requireControlTx(), parentControl, journalEntry.id, 'journal.post');
    await postJournalEntry(companyId, journalEntry.id, userId, { parentControl });

    // Run on the ALS-bound connection so the outer request-scoped tx provides
    // atomicity — withTransaction would deadlock against rows already locked
    // by this same request (e.g. the JE we just inserted/posted above).
    await applyControlledSupplierSettlement(id, permit.accountingDate ?? payment.paymentDate, permit);

    const updatedRows = (await sql`
      UPDATE supplier_payments
      SET status = 'processed', processed_at = NOW(),
          gl_journal_entry_id = ${journalEntry.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId}::UUID
      RETURNING *
    `) as Row[];
    const updated = updatedRows[0] as Row;

    log.info('Processed supplier payment', { id, journalEntryId: journalEntry.id }, 'accounting');
    return mapPaymentRow(updated);
  } catch (err) {
    log.error('Failed to process supplier payment', { id, error: err }, 'accounting');
    throw err;
  }
}

/**
 * Void a PROCESSED supplier payment (P2.1 / audit W4): reverse its GL journal
 * (metadata semantics — contra entry, reversed_at on the original), un-apply
 * its allocations, and set the payment to 'cancelled'. Reconciled payments
 * are anchored to a bank reconciliation and must be un-reconciled first.
 */
export async function processSupplierPayment(companyId: string, id: string, userId: string,
  opts?: { postingAgent?: string } & ApApprovalOptions): Promise<SupplierPayment> {
  return runApControlled(companyId, userId, { operation: 'supplier_payment.process', entityType: 'supplier_payment', entityId: id },
    opts, permit => processSupplierPaymentEffect(companyId, id, userId, opts, permit));
}
export async function voidSupplierPayment(companyId: string, id: string, userId: string,
  opts?: ApApprovalOptions): Promise<SupplierPayment> {
  return runApControlled(companyId, userId, { operation: 'supplier_payment.void', entityType: 'supplier_payment', entityId: id },
    opts, permit => voidSupplierPaymentInner(companyId, id, userId, permit));
}

async function voidSupplierPaymentInner(
  companyId: string,
  id: string,
  userId: string,
  permit: ControlledEffectPermit,
): Promise<SupplierPayment> {
  try {
    const payment = await getSupplierPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status === 'reconciled') {
      throw new Error('Cannot void a reconciled payment — remove it from the bank reconciliation first');
    }
    if (payment.status !== 'processed') {
      throw new Error(`Only processed payments can be voided (status: ${payment.status})`);
    }

    // Reverse the payment journal (skip if already reversed — reversed_at is
    // the marker; the original keeps status='posted' under metadata semantics).
    if (payment.glJournalEntryId) {
      const jeRows = (await sql`
        SELECT status, reversed_at FROM gl_journal_entries
        WHERE id = ${payment.glJournalEntryId}::UUID AND company_id = ${companyId}::UUID
        FOR UPDATE
      `) as Row[];
      if (
        jeRows.length > 0 &&
        String(jeRows[0]!.status) === 'posted' &&
        jeRows[0]!.reversed_at == null
      ) {
        const parentControl = { permit, parent: { operation: 'supplier_payment.void' as const, entityType: 'supplier_payment', entityId: id } };
        await registerGeneratedJournal(requireControlTx(), parentControl, payment.glJournalEntryId, 'journal.reverse');
        await reverseJournalEntry(companyId, payment.glJournalEntryId, userId, { parentControl, reversalDate: permit.accountingDate });
      }
    }

    // Un-apply allocations: roll amount_paid back and recompute status.
    // A voided payment returns the invoice to its pre-payment state
    // ('approved' when nothing else is paid, 'partially_paid' otherwise).
    await applyControlledSupplierSettlement(id, permit.accountingDate ?? payment.paymentDate, permit);

    // Guarded flip: only a still-processed payment can be voided (concurrent
    // void/reconcile loses the race cleanly).
    const rows = (await sql`
      UPDATE supplier_payments
      SET status = 'cancelled'
      WHERE id = ${id} AND company_id = ${companyId}::UUID AND status = 'processed'
      RETURNING *
    `) as Row[];
    if (rows.length !== 1) {
      throw new Error('Payment state changed concurrently — void aborted');
    }

    log.info('Voided supplier payment', { id, journalEntryId: payment.glJournalEntryId }, 'accounting');
    return mapPaymentRow(rows[0]!);
  } catch (err) {
    log.error('Failed to void supplier payment', { id, error: err }, 'accounting');
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
