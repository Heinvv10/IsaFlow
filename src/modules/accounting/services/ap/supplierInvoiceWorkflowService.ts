import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { resolveApControlAccounts } from './apControlAccounts';
import { getSupplierInvoiceById } from './supplierInvoiceService';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';
import type { SupplierInvoice } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';
import { actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';

import { buildExpenseLines, mapInvoiceRow } from './supplierInvoiceWorkflowMapping';
import { runApControlled, requireApControl, type ApApprovalOptions } from './apControlBoundary';
import type { ControlledEffectPermit } from '../controls/approvalExecutionService';
import { registerGeneratedJournal } from '../controls/generatedJournalPermit';
export { performThreeWayMatch } from './supplierInvoiceThreeWayMatch';
export type { ThreeWayMatchItemResult } from './supplierInvoiceThreeWayMatch';
export type { SupplierInvoiceItem } from '../../types/ap.types';
export type { VatType } from '../../types/gl.types';
type Row = DbRow;

async function approveSupplierInvoiceEffect(
  companyId: string,
  id: string,
  userId: string,
  opts: PostingActorOpts | undefined,
  permit: ControlledEffectPermit,
): Promise<SupplierInvoice> {
  try {
    if (!(await lockSupplierInvoiceForUpdate(companyId, id))) {
      throw new Error(`Supplier invoice ${id} not found`);
    }
    const invoice = await getSupplierInvoiceById(companyId, id);
    if (!invoice) throw new Error(`Supplier invoice ${id} not found`);
    if (!['draft', 'pending_approval', 'approved'].includes(invoice.status)) {
      throw new Error(`Cannot approve invoice with status: ${invoice.status}`);
    }
    if (invoice.glJournalEntryId) {
      const reused = (await sql`
        UPDATE supplier_invoices
        SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW()
        WHERE id = ${id} AND company_id = ${companyId}::UUID
        RETURNING *
      `) as Row[];
      log.info('Approved supplier invoice that already carried a journal', {
        id, journalEntryId: invoice.glJournalEntryId,
      }, 'accounting');
      return mapInvoiceRow(reused[0]!);
    }
    const { chosen } = await resolveApControlAccounts(requireApControl(companyId, userId),
      { operation: 'supplier_invoice.post', entityType: 'supplier_invoice', entityId: id });
    const apAccount = chosen.payable!, vatAccount = chosen.vat_input!, defaultExpenseAccount = chosen.default_expense!;

    const lines: JournalLineInput[] = buildExpenseLines(invoice, defaultExpenseAccount.id);

    if (invoice.taxAmount > 0) {
      lines.push({
        glAccountId: vatAccount.id,
        debit: invoice.taxAmount,
        credit: 0,
        description: `VAT on ${invoice.invoiceNumber}`,
        vatType: 'standard',
      });
    }

    lines.push({
      glAccountId: apAccount.id,
      debit: 0,
      credit: invoice.totalAmount,
      description: `AP: ${invoice.invoiceNumber}`,
    });
    const journalEntry = await createJournalEntry(companyId, {
      entryDate: invoice.invoiceDate,
      description: `Supplier invoice ${invoice.invoiceNumber}`,
      source: 'auto_supplier_invoice',
      sourceRecordId: id,
      lines,
    }, userId, actorMeta(opts));

    const parentControl = { permit, parent: { operation: 'supplier_invoice.post' as const, entityType: 'supplier_invoice', entityId: id } };
    await registerGeneratedJournal(requireApControl(companyId, userId), parentControl, journalEntry.id, 'journal.post');
    await postJournalEntry(companyId, journalEntry.id, userId, { parentControl });

    const updated = (await sql`
      UPDATE supplier_invoices
      SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW(),
          gl_journal_entry_id = ${journalEntry.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId}::UUID
      RETURNING *
    `) as Row[];

    log.info('Approved supplier invoice', { id, journalEntryId: journalEntry.id }, 'accounting');
    return mapInvoiceRow(updated[0]!);
  } catch (err) {
    log.error('Failed to approve supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function approveSupplierInvoice(companyId: string, id: string, userId: string,
  opts?: PostingActorOpts & ApApprovalOptions): Promise<SupplierInvoice> {
  return runApControlled(companyId, userId, { operation: 'supplier_invoice.post', entityType: 'supplier_invoice', entityId: id },
    opts, permit => approveSupplierInvoiceEffect(companyId, id, userId, opts, permit));
}
export async function postSupplierInvoiceToGL(companyId: string, id: string, userId: string,
  opts?: PostingActorOpts & ApApprovalOptions): Promise<{ journalEntryId: string; alreadyPosted: boolean }> {
  const ctx = requireApControl(companyId, userId);
  const { assertEffectivePermission } = await import('@/lib/auth/effectivePermissions');
  await assertEffectivePermission(ctx, 'write:invoices');
  await assertEffectivePermission(ctx, 'write:post');
  if (!(await lockSupplierInvoiceForUpdate(companyId, id))) throw new Error('Supplier invoice not found');
  const prior = await getSupplierInvoiceById(companyId, id);
  if (!prior) throw new Error('Supplier invoice not found');
  if (prior.status === 'cancelled') throw new Error('Cannot post a cancelled supplier invoice to GL');
  if (prior.glJournalEntryId) return { journalEntryId: prior.glJournalEntryId, alreadyPosted: true };
  const invoice = await approveSupplierInvoice(companyId, id, userId, opts);
  if (!invoice.glJournalEntryId) throw new Error('Supplier invoice journal missing');
  return { journalEntryId: invoice.glJournalEntryId, alreadyPosted: false };
}
export async function cancelSupplierInvoice(companyId: string, id: string, userId: string,
  opts?: ApApprovalOptions): Promise<SupplierInvoice> {
  return runApControlled(companyId, userId, { operation: 'supplier_invoice.cancel', entityType: 'supplier_invoice', entityId: id },
    opts, permit => cancelSupplierInvoiceInner(companyId, id, userId, permit));
}

async function cancelSupplierInvoiceInner(
  companyId: string,
  id: string,
  userId: string,
  permit: ControlledEffectPermit,
): Promise<SupplierInvoice> {
  try {
    const lockRows = (await sql`
      SELECT id, status, gl_journal_entry_id FROM supplier_invoices
      WHERE id = ${id} AND company_id = ${companyId}::UUID
      FOR UPDATE
    `) as Row[];
    if (lockRows.length === 0) throw new Error(`Supplier invoice ${id} not found`);
    const locked = lockRows[0]!;
    const status = String(locked.status);
    if (status === 'paid' || status === 'partially_paid') {
      throw new Error('Cannot cancel invoice with payments');
    }
    if (status === 'cancelled') {
      throw new Error('Supplier invoice is already cancelled');
    }
    if (locked.gl_journal_entry_id) {
      const jeRows = (await sql`
        SELECT status, reversed_at FROM gl_journal_entries
        WHERE id = ${String(locked.gl_journal_entry_id)}::UUID AND company_id = ${companyId}::UUID
        FOR UPDATE
      `) as Row[];
      if (
        jeRows.length > 0 &&
        String(jeRows[0]!.status) === 'posted' &&
        jeRows[0]!.reversed_at == null
      ) {
        const parentControl = { permit, parent: { operation: 'supplier_invoice.cancel' as const, entityType: 'supplier_invoice', entityId: id } };
        await registerGeneratedJournal(requireApControl(companyId, userId), parentControl, String(locked.gl_journal_entry_id), 'journal.reverse');
        await reverseJournalEntry(companyId, String(locked.gl_journal_entry_id), userId, { parentControl, reversalDate: permit.accountingDate });
      }
    }
    const rows = (await sql`
      UPDATE supplier_invoices SET status = 'cancelled'
      WHERE id = ${id} AND company_id = ${companyId}::UUID AND status != 'cancelled'
      RETURNING *
    `) as Row[];
    if (rows.length !== 1) {
      throw new Error('Supplier invoice state changed concurrently — cancel aborted');
    }
    return mapInvoiceRow(rows[0]!);
  } catch (err) {
    log.error('Failed to cancel supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}
