/**
 * Migration AP Service — Supplier Invoice Import
 * PRD: Customer Migration Wizard — Phase 1
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { updateSession, type ImportResult, type MigrationError } from '../core/migrationService';
import { matchContact } from '../core/migrationImportService';
import { computeFingerprint } from '../capture/captureDeduplicationService';
type Row = DbRow;


export interface APInvoiceRow {
  invoiceNumber: string;
  supplierName: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
  reference?: string;
}

// ── AP Invoice Import ────────────────────────────────────────────────────────

export async function importAPInvoices(
  companyId: string,
  sessionId: string,
  invoices: APInvoiceRow[],
  userId: string,
): Promise<ImportResult> {
  const errors: MigrationError[] = [];
  let imported = 0;
  let skipped = 0;

  const apAccountId      = await getSystemAccountId('payable', companyId);
  const expenseAccountId = await getSystemAccountId('default_expense', companyId);
  const vatInputId       = await getSystemAccountId('vat_input', companyId);

  const supRows = (await sql`
    SELECT id, COALESCE(company_name, name) AS name, vat_number FROM suppliers
    WHERE company_id = ${companyId}::UUID
  `) as Row[];

  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i]!;
    try {
      const supplierId = matchContact(inv.supplierName, supRows);
      if (!supplierId) {
        errors.push({ step: 'ap_invoices', row: i, field: 'supplierName', message: `Supplier not found: ${inv.supplierName}` });
        skipped++;
        continue;
      }

      const balance = inv.totalAmount - (inv.amountPaid ?? 0);
      const status  = balance <= 0 ? 'paid' : inv.amountPaid > 0 ? 'partially_paid' : 'approved';

      const matchedSupplier = supRows.find(s => String(s.id) === supplierId);
      const migFingerprint = computeFingerprint(
        matchedSupplier?.vat_number ?? null,
        inv.invoiceNumber,
        inv.totalAmount,
      );

      // Every statement for this row runs inside its own savepoint: a caught
      // per-row failure must not leave the request transaction aborted, or the
      // updateSession below dies with 25P02 and the whole route 500s.
      const rowImported = await withSavepoint('mig_ap_invoice_row', async () => {
        const invRows = (await sql`
          INSERT INTO supplier_invoices (
            company_id, supplier_id, invoice_number, invoice_date, due_date,
            subtotal, tax_amount, total_amount, amount_paid,
            status, reference, created_by,
            duplicate_fingerprint
          ) VALUES (
            ${companyId}::UUID, ${supplierId}::UUID, ${inv.invoiceNumber},
            ${inv.invoiceDate}::DATE, ${inv.dueDate}::DATE,
            ${inv.subtotal}, ${inv.taxAmount}, ${inv.totalAmount},
            ${inv.amountPaid ?? 0}, ${status},
            ${inv.reference ?? null}, ${userId}::UUID,
            ${migFingerprint}
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `) as Row[];

        if (invRows.length === 0) return false;
        const invoiceId = String(invRows[0]!.id);

        // Post GL: DR Expense + VAT Input, CR Payable
        const journalLines = [
          { glAccountId: expenseAccountId, debit: inv.subtotal,   credit: 0,              description: `Expense — ${inv.invoiceNumber}` },
          { glAccountId: apAccountId,      debit: 0,              credit: inv.totalAmount, description: `AP — ${inv.invoiceNumber}` },
        ];
        if (inv.taxAmount > 0) {
          // DR VAT Input (claimable input tax), AP credit already equals totalAmount
          journalLines.push({ glAccountId: vatInputId, debit: inv.taxAmount, credit: 0, description: `VAT Input — ${inv.invoiceNumber}` });
        }

        // No sourceDocumentId: gl_journal_entries.source_document_id has an FK
        // to captured_documents(id) only (migration 409); the invoice's own id
        // would violate it. The invoice <-> journal entry link is instead
        // persisted below via supplier_invoices.gl_journal_entry_id — same
        // column supplierInvoiceWorkflowService/sageMigrationCommitService use
        // for a supplier invoice's own posting entry; safe here because a
        // migrated invoice is inserted pre-approved and never goes through
        // that flow afterward.
        const entry = await createJournalEntry(companyId, {
          entryDate: inv.invoiceDate,
          description: `Migrated AP invoice ${inv.invoiceNumber}`,
          source: 'auto_migration',
          lines: journalLines,
        }, userId);
        await postJournalEntry(companyId, entry.id, userId);
        await sql`
          UPDATE supplier_invoices SET gl_journal_entry_id = ${entry.id}::UUID
          WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
        `;
        return true;
      });
      if (rowImported) imported++; else skipped++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step: 'ap_invoices', row: i, message: msg });
      skipped++;
    }
  }

  await updateSession(sessionId, companyId, { apInvoicesImported: imported, stepsCompleted: { ap_invoices: true }, errors });
  log.info('AP invoices imported', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors };
}
